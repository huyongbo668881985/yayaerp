const { addColumnIfMissing } = require('./migrations');
const { returnCostExpr } = require('./profitCalc');

// 旧客户创建时间保持 NULL；迁移时点只是存量基线，绝非创建日期。
function migrateDailyAnalysis(db) {
  addColumnIfMissing(db, 'customers', 'created_at TEXT');
  db.exec(`CREATE TABLE report_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO report_metadata VALUES('history_started_at',datetime('now'));
    CREATE TABLE report_salespeople(user_id INTEGER NOT NULL REFERENCES users(id), start_date TEXT NOT NULL,
      end_date TEXT, PRIMARY KEY(user_id,start_date), CHECK(end_date IS NULL OR end_date>=start_date));
    CREATE TABLE report_customer_history(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL,name TEXT NOT NULL,
      operator_id INTEGER,created_at TEXT,recorded_at TEXT NOT NULL DEFAULT (datetime('now')),deleted INTEGER NOT NULL DEFAULT 0);
    INSERT INTO report_customer_history(customer_id,name,operator_id,created_at)
      SELECT id,name,operator_id,created_at FROM customers;
    CREATE INDEX report_customer_history_cutoff ON report_customer_history(recorded_at,customer_id,id);
    CREATE TRIGGER report_customer_insert AFTER INSERT ON customers BEGIN
      UPDATE customers SET created_at=datetime('now') WHERE id=NEW.id AND created_at IS NULL;
      INSERT INTO report_customer_history(customer_id,name,operator_id,created_at)
        SELECT id,name,operator_id,created_at FROM customers WHERE id=NEW.id;
    END;
    CREATE TRIGGER report_customer_update AFTER UPDATE OF name,operator_id ON customers BEGIN
      INSERT INTO report_customer_history(customer_id,name,operator_id,created_at) VALUES(NEW.id,NEW.name,NEW.operator_id,NEW.created_at);
    END;
    CREATE TRIGGER report_customer_delete AFTER DELETE ON customers BEGIN
      INSERT INTO report_customer_history(customer_id,name,operator_id,created_at,deleted)
        VALUES(OLD.id,OLD.name,OLD.operator_id,OLD.created_at,1);
    END;
    CREATE TRIGGER report_customer_created_immutable BEFORE UPDATE OF created_at ON customers
      WHEN OLD.created_at IS NOT NULL AND NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT,'客户创建时间不可改写'); END;
    CREATE TABLE report_ledger_facts(ledger_id INTEGER PRIMARY KEY REFERENCES customer_ledger(id),profit_cents INTEGER);
    CREATE TRIGGER report_ledger_fact_insert AFTER INSERT ON customer_ledger BEGIN
      INSERT INTO report_ledger_facts VALUES(NEW.id,
        CASE WHEN NEW.event_kind='升级结转' THEN NULL
          WHEN NEW.sales_cents!=0 THEN CAST(ROUND((SELECT SUM(quantity*unit_price-base_quantity*cost_price_snapshot)
            FROM sales_order_items WHERE sales_order_id=NEW.document_id)*100) AS INTEGER)*CASE WHEN NEW.sales_cents>0 THEN 1 ELSE -1 END
          WHEN NEW.returned_cents!=0 THEN -CAST(ROUND((SELECT SUM(roi.quantity*roi.unit_price-roi.base_quantity*${returnCostExpr()})
            FROM return_order_items roi JOIN return_orders ro ON ro.id=roi.return_order_id WHERE ro.id=NEW.document_id)*100) AS INTEGER)*CASE WHEN NEW.returned_cents>0 THEN 1 ELSE -1 END
          ELSE 0 END);
    END;`);
  for (const table of ['report_customer_history', 'report_ledger_facts']) {
    for (const op of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER ${table}_no_${op.toLowerCase()} BEFORE ${op} ON ${table}
      BEGIN SELECT RAISE(ABORT,'日报历史只允许追加'); END;`);
  }
}
module.exports = { migrateDailyAnalysis };
