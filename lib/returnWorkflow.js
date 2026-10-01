const { addColumnIfMissing } = require('./migrations');
const { roundToCents } = require('./validators');

// 只增加归属快照和流程字段，不重算、覆盖历史钱款或库存。
function migrateReturnWorkflow(db) {
  for (const definition of [
    'workflow_version INTEGER NOT NULL DEFAULT 0', 'finalized_at TEXT',
    'received_at TEXT', 'cancelled_at TEXT', 'cancel_reason TEXT',
    'cancelled_by INTEGER REFERENCES users(id)', "exception_reason TEXT NOT NULL DEFAULT ''"
  ]) addColumnIfMissing(db, 'return_orders', definition);
  // 草稿来源允许失效，审核时重新校验；已入账来源由下面的触发器锁定。
  addColumnIfMissing(db, 'return_order_items', 'original_sales_item_id INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS customer_ledger_accounts (
    ledger_id INTEGER PRIMARY KEY REFERENCES customer_ledger(id),
    account_id INTEGER NOT NULL CHECK(account_id != 0),
    source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS return_refund_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_order_id INTEGER NOT NULL REFERENCES return_orders(id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    reference TEXT NOT NULL CHECK(length(trim(reference)) > 0),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);

  const insert = db.prepare('INSERT INTO customer_ledger_accounts(ledger_id,account_id,source) VALUES (?,?,?)');
  const audit = db.prepare("SELECT details_json FROM audit_logs WHERE request_id=? AND entity_type='退货单' AND entity_id=? ORDER BY id");
  const laterAudit = db.prepare("SELECT details_json FROM audit_logs WHERE entity_type='退货单' AND entity_id=? AND created_at>=? ORDER BY id");
  const returnOrder = db.prepare('SELECT related_sales_order_id FROM return_orders WHERE id=?');
  let unverified = 0;
  for (const row of db.prepare('SELECT * FROM customer_ledger WHERE id NOT IN (SELECT ledger_id FROM customer_ledger_accounts) ORDER BY id').all()) {
    if (row.document_type === 'sales') { insert.run(row.id, row.document_id, 'document'); continue; }
    let relation, source;
    const snapshots = row.request_id ? audit.all(row.request_id, row.document_id) : [];
    for (const snapshot of snapshots) {
      const details = JSON.parse(snapshot.details_json);
      const fields = (row.event_kind === '反审核冲销' ? details.before : details.after)?.fields;
      if (fields && Object.hasOwn(fields, '关联销售单')) {
        relation = fields.关联销售单; source = 'audit'; break;
      }
    }
    // 结转后的首次变更，其 before 就是升级时的归属；不使用后来改过的关联。
    if (relation === undefined && row.event_kind === '升级结转') {
      for (const snapshot of laterAudit.all(row.document_id, row.created_at)) {
        const fields = JSON.parse(snapshot.details_json).before?.fields;
        if (fields && Object.hasOwn(fields, '关联销售单')) { relation = fields.关联销售单; source = 'opening'; break; }
      }
    }
    if (relation === undefined) {
      relation = returnOrder.get(row.document_id)?.related_sales_order_id;
      source = row.event_kind === '升级结转' ? 'opening' : 'legacy_unverified';
      if (source === 'legacy_unverified') unverified++;
    }
    const id = Number(relation);
    insert.run(row.id, Number.isSafeInteger(id) && id > 0 ? id : -row.document_id, source);
  }
  db.prepare("INSERT OR REPLACE INTO ledger_metadata(key,value) VALUES ('unverified_return_accounts',?)").run(String(unverified));
  db.exec(`UPDATE return_orders SET finalized_at=COALESCE(finalized_at,created_at)
    WHERE status='approved' OR id IN (SELECT document_id FROM customer_ledger WHERE document_type='returns');
    CREATE TRIGGER IF NOT EXISTS customer_ledger_account_insert AFTER INSERT ON customer_ledger BEGIN
      INSERT INTO customer_ledger_accounts(ledger_id,account_id,source) VALUES (
        NEW.id, CASE WHEN NEW.document_type='sales' THEN NEW.document_id
          ELSE COALESCE((SELECT related_sales_order_id FROM return_orders WHERE id=NEW.document_id),-NEW.document_id) END,'recorded');
    END;
    CREATE TRIGGER IF NOT EXISTS customer_ledger_accounts_no_update BEFORE UPDATE ON customer_ledger_accounts BEGIN SELECT RAISE(ABORT,'对账归属只允许追加'); END;
    CREATE TRIGGER IF NOT EXISTS customer_ledger_accounts_no_delete BEFORE DELETE ON customer_ledger_accounts BEGIN SELECT RAISE(ABORT,'对账归属只允许追加'); END;
    CREATE TRIGGER IF NOT EXISTS return_refunds_no_update BEFORE UPDATE ON return_refund_records BEGIN SELECT RAISE(ABORT,'退款凭据只允许追加'); END;
    CREATE TRIGGER IF NOT EXISTS return_refunds_no_delete BEFORE DELETE ON return_refund_records BEGIN SELECT RAISE(ABORT,'退款凭据只允许追加'); END;
    CREATE TRIGGER IF NOT EXISTS finalized_return_no_edit BEFORE UPDATE ON return_orders
    WHEN OLD.finalized_at IS NOT NULL AND (NEW.customer_id IS NOT OLD.customer_id OR NEW.warehouse_id IS NOT OLD.warehouse_id
      OR NEW.related_sales_order_id IS NOT OLD.related_sales_order_id OR NEW.order_date IS NOT OLD.order_date
      OR NEW.total_amount IS NOT OLD.total_amount OR NEW.note IS NOT OLD.note OR NEW.remarks IS NOT OLD.remarks
      OR NEW.user_id IS NOT OLD.user_id OR NEW.created_at IS NOT OLD.created_at OR NEW.received_at IS NOT OLD.received_at
      OR NEW.exception_reason IS NOT OLD.exception_reason OR NEW.workflow_version IS NOT OLD.workflow_version
      OR NEW.finalized_at IS NOT OLD.finalized_at OR NEW.refunded_amount < OLD.refunded_amount
      OR (NEW.status IS NOT OLD.status AND NOT (OLD.status='approved' AND NEW.status='rejected'
        AND OLD.refunded_amount=0 AND NEW.cancelled_at IS NOT NULL AND length(trim(NEW.cancel_reason))>0))
      OR (OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at IS NOT OLD.cancelled_at OR NEW.cancel_reason IS NOT OLD.cancel_reason
        OR NEW.cancelled_by IS NOT OLD.cancelled_by OR NEW.refunded_amount IS NOT OLD.refunded_amount)))
    BEGIN SELECT RAISE(ABORT,'已入账退货不可改写，请留痕撤销后重新开单'); END;
    CREATE TRIGGER IF NOT EXISTS finalized_return_no_delete BEFORE DELETE ON return_orders WHEN OLD.finalized_at IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'已入账退货不可删除'); END;
    CREATE TRIGGER IF NOT EXISTS finalized_sale_return_no_unapprove BEFORE UPDATE OF status ON sales_orders
      WHEN NEW.status IS NOT OLD.status AND EXISTS(SELECT 1 FROM return_orders WHERE related_sales_order_id=OLD.id AND finalized_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'有退货入账历史的原销售单不可反审核'); END;
    CREATE TRIGGER IF NOT EXISTS finalized_sale_return_no_edit BEFORE UPDATE ON sales_orders
      WHEN EXISTS(SELECT 1 FROM return_orders WHERE related_sales_order_id=OLD.id AND finalized_at IS NOT NULL)
      AND (NEW.customer_id IS NOT OLD.customer_id OR NEW.warehouse_id IS NOT OLD.warehouse_id
        OR NEW.total_amount IS NOT OLD.total_amount OR NEW.order_date IS NOT OLD.order_date)
      BEGIN SELECT RAISE(ABORT,'有退货入账历史的原销售单不可改写'); END;`);
  for (const [operation, row] of [['UPDATE','OLD'],['DELETE','OLD'],['INSERT','NEW']]) {
    const returnParents = operation === 'UPDATE' ? 'OLD.return_order_id,NEW.return_order_id' : `${row}.return_order_id`;
    const saleParents = operation === 'UPDATE' ? 'OLD.sales_order_id,NEW.sales_order_id' : `${row}.sales_order_id`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS finalized_return_items_no_${operation.toLowerCase()} BEFORE ${operation} ON return_order_items
      WHEN EXISTS(SELECT 1 FROM return_orders WHERE id IN (${returnParents}) AND finalized_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'已入账退货明细不可改写'); END;
      CREATE TRIGGER IF NOT EXISTS finalized_sale_items_no_${operation.toLowerCase()} BEFORE ${operation} ON sales_order_items
      WHEN EXISTS(SELECT 1 FROM return_orders WHERE related_sales_order_id IN (${saleParents}) AND finalized_at IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'有退货入账历史的原销售明细不可改写'); END;`);
  }
}

function saleItems(db, saleId, excludeReturnId = -1) {
  return db.prepare(`SELECT si.*,p.name AS product_name,p.sku,
    COALESCE((SELECT SUM(ri.quantity) FROM return_order_items ri JOIN return_orders ro ON ro.id=ri.return_order_id
      WHERE ri.original_sales_item_id=si.id AND ro.status='approved' AND ro.id<>?),0) AS returned_quantity
    FROM sales_order_items si JOIN products p ON p.id=si.product_id WHERE si.sales_order_id=? ORDER BY si.id`).all(excludeReturnId, saleId);
}

// 新普通退货使用原明细的单位、箱规、价格和成本；客户端只能决定数量。
function prepareOriginalItems(db, saleId, items, excludeReturnId = -1) {
  const originals = saleItems(db, saleId, excludeReturnId);
  const used = new Map();
  for (const item of items) {
    const choices = originals.filter(original => item.originalSalesItemId
      ? original.id === item.originalSalesItemId
      : original.product_id === item.pid && (item.unitChoice === 'pack' ? original.base_quantity > original.quantity : original.base_quantity === original.quantity));
    if (!choices.length && !originals.some(original => original.product_id === item.pid)) return '退货商品不在关联销售单中';
    if (choices.length !== 1) return '请选择原销售明细；同商品多行或单位不一致时，不能由系统猜测退货来源';
    const original = choices[0];
    if (item.pid !== original.product_id) return '退货商品与所选原销售明细不一致';
    if (Math.abs(item.price - original.unit_price) > 0.001) return '退货单价必须沿用原销售明细，不能修改；请核对原单后重新办理';
    const quantity = (used.get(original.id) || 0) + item.qty;
    if (quantity + original.returned_quantity > original.quantity) return `商品“${original.product_name}”退货数量超过可退数量（原销售明细）`;
    used.set(original.id, quantity);
    item.originalSalesItemId = original.id;
    item.price = original.unit_price;
    item.unitLabel = original.unit_label;
    item.baseQty = item.qty * original.base_quantity / original.quantity;
    item.costSnapshot = original.cost_price_snapshot;
    if (!Number.isSafeInteger(item.baseQty) || item.baseQty <= 0) return '退货基本数量无效，请管理员核对原销售明细';
  }
  return null;
}

function refundState(db, order) {
  if (order.cancelled_at) return '已撤销';
  if (order.status !== 'approved') return '未入账';
  if (order.related_sales_order_id) {
    const { getSalePayment } = require('./profitCalc');
    const sale = getSalePayment(db, order.related_sales_order_id);
    if (sale && sale.pending_refund <= 0.001) return sale.effective_debt > 0.001 ? '已抵扣欠款' : '已结清';
  }
  if (roundToCents(order.total_amount - order.refunded_amount) <= 0) return '已结清';
  return order.refunded_amount > 0 ? '部分退款' : '待退款';
}

module.exports = { migrateReturnWorkflow, saleItems, prepareOriginalItems, refundState };
