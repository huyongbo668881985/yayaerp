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

/**
 * 在给定的 better-sqlite3 db 实例上建表（如果不存在）。
 * 每个租户各自一个 db 文件，都要跑一遍这个函数。
 * 幂等：可以在已有数据的库上重复执行，不会破坏数据。
 */
function initSchema(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
  quantity INTEGER NOT NULL DEFAULT 0,
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

  migrateStockTransactionsType(db);
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
