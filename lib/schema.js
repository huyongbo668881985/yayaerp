const bcrypt = require('bcryptjs');
const { addColumnIfMissing, applyMigration } = require('./migrations');

// 兼容旧数据库：所有升级均通过显式版本记录执行；失败会中止启动并保留错误上下文。
// stock_transactions 表建表时 type 字段的 CHECK 约束里没有 'sale_return'（退货入库）这个值，
// SQLite 不支持直接 ALTER TABLE 修改 CHECK 约束，只能用官方推荐的"建新表→搬数据→删旧表→改名"这套标准手法。
// 用 sqlite_master 里存的建表语句文本做幂等判断，迁移过一次之后不会重复执行。
function migrateStockTransactionsType(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_transactions'`).get();
  if (!row || row.sql.includes('sale_return')) return; // 表不存在，或者已经迁移过了

  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
      CREATE TABLE stock_transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        change_qty INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('purchase_in','sale_out','adjust','transfer_in','transfer_out','sale_return')),
        ref_type TEXT,
        ref_id INTEGER,
        user_id INTEGER REFERENCES users(id),
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
      db.exec(`INSERT INTO stock_transactions_new SELECT * FROM stock_transactions;`);
      db.exec(`DROP TABLE stock_transactions;`);
      db.exec(`ALTER TABLE stock_transactions_new RENAME TO stock_transactions;`);
    });
    tx();
  } finally {
    if (wasForeignKeysOn) db.pragma('foreign_keys = ON');
  }
}

// 给 inventory 表加 CHECK(quantity >= 0) 防线：就算将来出现并发/多进程等
// "先查后扣"竞态，数据库层面也不允许库存扣成负数。
// SQLite 不支持直接修改表约束，和 migrateStockTransactionsType 一样走
// "建新表→搬数据→删旧表→改名"的标准迁移手法，用建表语句文本做幂等判断。
// 万一历史数据里真有负数（正常不该有），搬数据时归零，不让迁移卡死。
function migrateInventoryNonNegative(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='inventory'`).get();
  if (!row || row.sql.includes('CHECK')) return; // 表不存在，或已经迁移过了

  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      const negatives = db.prepare(`SELECT COUNT(*) AS c FROM inventory WHERE quantity < 0`).get().c;
      if (negatives > 0) {
        console.warn(`[schema] inventory 发现 ${negatives} 行负库存，迁移时已归零`);
      }
      db.exec(`
      CREATE TABLE inventory_new (
        product_id INTEGER NOT NULL REFERENCES products(id),
        warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
        quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
        PRIMARY KEY (product_id, warehouse_id)
      );
      INSERT INTO inventory_new SELECT product_id, warehouse_id, MAX(quantity, 0) FROM inventory;
      DROP TABLE inventory;
      ALTER TABLE inventory_new RENAME TO inventory;
      `);
    });
    tx();
  } finally {
    if (wasForeignKeysOn) db.pragma('foreign_keys = ON');
  }
}

/**
 * 在给定的 better-sqlite3 db 实例上建表（如果不存在）。
 * 每个租户各自一个 db 文件，都要跑一遍这个函数。
 * 幂等：可以在已有数据的库上重复执行，不会破坏数据。
 */
function initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // 多进程共享同一租户库时的低成本保险：写锁冲突等 5 秒而不是立刻抛 SQLITE_BUSY。
  // 单容器部署用不到，但加了不影响任何现有行为。
  db.pragma('busy_timeout = 5000');

  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','operator')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  spec TEXT,
  unit TEXT NOT NULL DEFAULT '件',
  pack_unit TEXT,
  pack_size INTEGER NOT NULL DEFAULT 1,
  cost_price REAL NOT NULL DEFAULT 0,
  sale_price REAL NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory (
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity INTEGER NOT NULL DEFAULT 0 CHECK(quantity >= 0),
  PRIMARY KEY (product_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  phone TEXT
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER REFERENCES suppliers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_date TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_label TEXT NOT NULL DEFAULT '',
  base_quantity INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_date TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_label TEXT NOT NULL DEFAULT '',
  base_quantity INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS transfer_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transfer_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_order_id INTEGER NOT NULL REFERENCES transfer_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_label TEXT NOT NULL DEFAULT '',
  base_quantity INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS return_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  related_sales_order_id INTEGER REFERENCES sales_orders(id),
  order_date TEXT NOT NULL,
  total_amount REAL NOT NULL DEFAULT 0,
  refunded_amount REAL NOT NULL DEFAULT 0,
  refund_status TEXT NOT NULL DEFAULT 'unrefunded' CHECK(refund_status IN ('unrefunded','partial','refunded')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('draft','submitted','approved','rejected')),
  note TEXT,
  remarks TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS return_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_order_id INTEGER NOT NULL REFERENCES return_orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_label TEXT NOT NULL DEFAULT '',
  base_quantity INTEGER NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  change_qty INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('purchase_in','sale_out','adjust','transfer_in','transfer_out','sale_return')),
  ref_type TEXT,
  ref_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- 欠款每日快照（lib/debtSnapshot.js 每天写入一次，供趋势/环比查询）：
--   每天每个租户库落 1 条全公司汇总行（user_id = NULL）+ 每个操作员 1 行（无欠款记 0），
--   保证"全公司行 = Σ 操作员行"可对账，且操作员欠款清零后趋势线不断。
--   口径复用 lib/profitCalc.js 的 effectiveDebtExpr（有效欠款唯一实现点），
--   只累计"已审核 且 有效欠款 > 0.001"的销售单（与报表页"应收账款"口径一致）。
--   snapshot_date 为北京时间日期（utils/dates.js），与备份模块日期口径一致。
CREATE TABLE IF NOT EXISTS debt_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  total_debt REAL NOT NULL,
  debtor_customer_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
-- 唯一索引保证"同一天同一维度只有一行"：手动重跑脚本不会堆出脏数据。
-- 注意 SQLite 特性：UNIQUE 索引里 NULL 互不冲突，所以 user_id=NULL 的全公司行
-- 靠这条索引拦不住重复——写入侧（debtSnapshot.js）用事务内"先删当天再插"兜底。
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_snapshots_date_user
ON debt_snapshots(snapshot_date, user_id);
`);

  applyMigration(db, 1, 'pack units and item quantities', () => {
    const tx = db.transaction(() => {
      addColumnIfMissing(db, 'products', 'pack_unit TEXT');
      addColumnIfMissing(db, 'products', 'pack_size INTEGER NOT NULL DEFAULT 1');
      // 箱价本身是精确来源，不从瓶价反算。
      addColumnIfMissing(db, 'products', 'cost_price_pack REAL');
      addColumnIfMissing(db, 'products', 'sale_price_pack REAL');
      addColumnIfMissing(db, 'purchase_order_items', "unit_label TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'purchase_order_items', 'base_quantity INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'sales_order_items', "unit_label TEXT NOT NULL DEFAULT ''");
      addColumnIfMissing(db, 'sales_order_items', 'base_quantity INTEGER NOT NULL DEFAULT 0');
    });
    tx();
  });

  applyMigration(db, 2, 'workflow finance and ownership', () => {
    const tx = db.transaction(() => {
      addColumnIfMissing(db, 'customers', 'address TEXT');
      addColumnIfMissing(db, 'customers', 'operator_id INTEGER REFERENCES users(id)');
      addColumnIfMissing(db, 'purchase_orders', "status TEXT NOT NULL DEFAULT 'pending'");
      addColumnIfMissing(db, 'purchase_orders', 'remarks TEXT');
      addColumnIfMissing(db, 'sales_orders', 'paid_amount REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'sales_orders', "payment_status TEXT NOT NULL DEFAULT 'unpaid'");
      addColumnIfMissing(db, 'sales_orders', "status TEXT NOT NULL DEFAULT 'draft'");
      addColumnIfMissing(db, 'sales_orders', 'remarks TEXT');
      addColumnIfMissing(db, 'transfer_orders', "status TEXT NOT NULL DEFAULT 'pending'");
      addColumnIfMissing(db, 'transfer_orders', 'remarks TEXT');
      addColumnIfMissing(db, 'sales_order_items', 'is_gift INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'users', 'active INTEGER NOT NULL DEFAULT 1');
      addColumnIfMissing(db, 'return_orders', 'related_sales_order_id INTEGER REFERENCES sales_orders(id)');
    });
    tx();
  });

  applyMigration(db, 3, 'cost snapshots', () => {
    const tx = db.transaction(() => {
      addColumnIfMissing(db, 'sales_order_items', 'cost_price_snapshot REAL NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'return_order_items', 'cost_price_snapshot REAL NOT NULL DEFAULT 0');
      db.exec(`
      UPDATE sales_order_items SET cost_price_snapshot =
      (SELECT p.cost_price FROM products p WHERE p.id = sales_order_items.product_id)
    WHERE cost_price_snapshot = 0
      AND EXISTS (SELECT 1 FROM products p2 WHERE p2.id = sales_order_items.product_id);
    UPDATE return_order_items SET cost_price_snapshot =
      (SELECT p.cost_price FROM products p WHERE p.id = return_order_items.product_id)
    WHERE cost_price_snapshot = 0
      AND EXISTS (SELECT 1 FROM products p2 WHERE p2.id = return_order_items.product_id);
      `);
    });
    tx();
  });

  applyMigration(db, 4, 'sale return stock transaction type', () => migrateStockTransactionsType(db));
  applyMigration(db, 5, 'non-negative inventory constraint', () => migrateInventoryNonNegative(db));
}

/**
 * 新租户开通时调用：建表 + 插入第一个管理员账号 + 默认仓库。
 * 幂等保护：如果 users 表已经有数据了（比如重复调用），不会重复插入。
 */
function bootstrapTenant(db, { adminUsername, adminPassword, adminName, warehouseName }) {
  initSchema(db);
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync(adminPassword, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)'
    ).run(adminUsername, hash, adminName || '管理员', 'admin');
    db.prepare(
      'INSERT INTO warehouses (name, address) VALUES (?,?)'
    ).run(warehouseName || '总仓', '默认仓库，可在"仓库管理"中修改或新增');
  }
}

module.exports = { initSchema, bootstrapTenant, safeAddColumn: addColumnIfMissing };
