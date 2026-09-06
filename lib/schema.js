const bcrypt = require('bcryptjs');

// 兼容旧数据库：如果是从更早版本升级上来的，补齐新增字段（已存在则忽略报错）
// stock_transactions 表建表时 type 字段的 CHECK 约束里没有 'sale_return'（退货入库）这个值，
// SQLite 不支持直接 ALTER TABLE 修改 CHECK 约束，只能用官方推荐的"建新表→搬数据→删旧表→改名"这套标准手法。
// 用 sqlite_master 里存的建表语句文本做幂等判断，迁移过一次之后不会重复执行。
function migrateStockTransactionsType(db) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='stock_transactions'`).get();
  if (!row || row.sql.includes('sale_return')) return; // 表不存在，或者已经迁移过了

  const wasForeignKeysOn = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
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
  if (wasForeignKeysOn) db.pragma('foreign_keys = ON');
}

function safeAddColumn(db, table, columnDef) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (e) {
    // 字段已存在时会报错，忽略即可
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
  if (wasForeignKeysOn) db.pragma('foreign_keys = ON');
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
`);

  safeAddColumn(db, 'products', "pack_unit TEXT");
  safeAddColumn(db, 'products', "pack_size INTEGER NOT NULL DEFAULT 1");
  // 箱价（大单位价格）直接存储，不再由瓶价 * 换算比例 反算，避免除不尽导致的四舍五入误差
  // 例如 380 元/箱，24瓶一箱，380/24=15.8333...，四舍五入成瓶价再乘回24会变成380.04，是明显的bug
  safeAddColumn(db, 'products', "cost_price_pack REAL");
  safeAddColumn(db, 'products', "sale_price_pack REAL");
  safeAddColumn(db, 'purchase_order_items', "unit_label TEXT NOT NULL DEFAULT ''");
  safeAddColumn(db, 'purchase_order_items', "base_quantity INTEGER NOT NULL DEFAULT 0");
  safeAddColumn(db, 'sales_order_items', "unit_label TEXT NOT NULL DEFAULT ''");
  safeAddColumn(db, 'sales_order_items', "base_quantity INTEGER NOT NULL DEFAULT 0");

  // ===== 新增字段：审核流、财务、客户详情 =====
  safeAddColumn(db, 'customers', "address TEXT");
  safeAddColumn(db, 'customers', "operator_id INTEGER REFERENCES users(id)");
  safeAddColumn(db, 'purchase_orders', "status TEXT NOT NULL DEFAULT 'pending'");
  safeAddColumn(db, 'purchase_orders', "remarks TEXT");
  safeAddColumn(db, 'sales_orders', "paid_amount REAL NOT NULL DEFAULT 0");
  safeAddColumn(db, 'sales_orders', "payment_status TEXT NOT NULL DEFAULT 'unpaid'");
  safeAddColumn(db, 'sales_orders', "status TEXT NOT NULL DEFAULT 'draft'");
  safeAddColumn(db, 'sales_orders', "remarks TEXT");
  safeAddColumn(db, 'transfer_orders', "status TEXT NOT NULL DEFAULT 'pending'");
  safeAddColumn(db, 'transfer_orders', "remarks TEXT");
  safeAddColumn(db, 'sales_order_items', "is_gift INTEGER NOT NULL DEFAULT 0");
  safeAddColumn(db, 'users', "active INTEGER NOT NULL DEFAULT 1");
  safeAddColumn(db, 'return_orders', "related_sales_order_id INTEGER REFERENCES sales_orders(id)");

  // ===== 成本快照：下单那一刻把商品成本价存进明细行 =====
  // 之前毛利是查询时用 products.cost_price 现算的，管理员改一次成本价，
  // 历史所有单据的毛利都会跟着变。改成快照后，"当时卖了多少、赚了多少"就此固定。
  // 老数据回填：快照为 0 的行用商品当前成本价补上（等于保持原来的现算结果，不改变历史口径起点）。
  safeAddColumn(db, 'sales_order_items', "cost_price_snapshot REAL NOT NULL DEFAULT 0");
  safeAddColumn(db, 'return_order_items', "cost_price_snapshot REAL NOT NULL DEFAULT 0");
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

  migrateStockTransactionsType(db);
  migrateInventoryNonNegative(db);
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

module.exports = { initSchema, bootstrapTenant, safeAddColumn };
