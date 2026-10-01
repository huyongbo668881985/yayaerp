const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { recordDocumentFinance } = require('./customerLedger');
const context = new AsyncLocalStorage();
const documents = {
  sales: { table: 'sales_orders', items: 'sales_order_items', parent: 'sales_order_id', type: '销售单' },
  returns: { table: 'return_orders', items: 'return_order_items', parent: 'return_order_id', type: '退货单' },
  transfers: { table: 'transfer_orders', items: 'transfer_order_items', parent: 'transfer_order_id', type: '调拨单' },
  purchases: { table: 'purchase_orders', items: 'purchase_order_items', parent: 'purchase_order_id', type: '采购单' }
};
const states = { draft: '草稿', submitted: '待审核', approved: '已审核', rejected: '已拒绝' };

function documentOperation(path) {
  let match = path.match(/^\/(sales|returns|transfers|purchases)\/(new)$/);
  if (match) return { ...documents[match[1]], kind: match[1], operation: 'new', id: null };
  match = path.match(/^\/(sales|returns|transfers|purchases)\/(\d+)\/(edit|delete|record-payment|record-refund)$/)
    || path.match(/^\/(sales|returns|transfers)\/(submit|withdraw|approve|reject|unapprove)\/(\d+)$/);
  if (!match) return null;
  const numberedFirst = /^\d+$/.test(match[2]);
  return { ...documents[match[1]], kind: match[1], id: Number(numberedFirst ? match[2] : match[3]), operation: numberedFirst ? match[3] : match[2] };
}

// 只读取业务字段，不记录请求正文、密码、Cookie、CSRF 或其他凭据。
function documentSnapshot(db, doc, id) {
  if (!id) return null;
  const order = db.prepare(`SELECT * FROM ${doc.table} WHERE id=?`).get(id);
  if (!order) return null;
  const name = (table, value) => value ? (db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(value)?.name || '已删除') + ` #${value}` : '无';
  const fields = { 日期: order.order_date };
  if ('customer_id' in order) fields.客户 = order.customer_id ? name('customers', order.customer_id) : '散客';
  if ('supplier_id' in order) fields.供应商 = name('suppliers', order.supplier_id);
  if ('warehouse_id' in order) fields.仓库 = name('warehouses', order.warehouse_id);
  if ('from_warehouse_id' in order) { fields.调出仓库 = name('warehouses', order.from_warehouse_id); fields.调入仓库 = name('warehouses', order.to_warehouse_id); }
  if ('total_amount' in order) fields.单据金额 = order.total_amount;
  if ('paid_amount' in order) fields.已收现金 = order.paid_amount;
  if ('refunded_amount' in order) fields.已退现金 = order.refunded_amount;
  if (doc.kind !== 'purchases') fields.审核状态 = states[order.status] || order.status;
  if ('related_sales_order_id' in order) fields.关联销售单 = order.related_sales_order_id || '无';
  fields.备注 = doc.kind === 'purchases' ? order.note || '' : order.remarks || '';
  if (doc.kind !== 'purchases') fields.内部备注 = order.note || '';
  const items = db.prepare(`SELECT i.*, p.name AS product_name FROM ${doc.items} i
    LEFT JOIN products p ON p.id=i.product_id WHERE i.${doc.parent}=? ORDER BY i.id`).all(id).map(item => {
    const row = { 商品: `${item.product_name || '已删除'} #${item.product_id}`, 数量: item.quantity, 单位: item.unit_label, 基本数量: item.base_quantity };
    if ('unit_price' in item) row.单价 = item.unit_price;
    if ('cost_price_snapshot' in item) row.基本单位成本 = item.cost_price_snapshot;
    if ('is_gift' in item) row.赠品 = item.is_gift ? '是' : '否';
    return row;
  });
  return { fields, items };
}

function writeAuditLog(db, user, action, entityType, entityId, summary, details = {}) {
  const scope = context.getStore();
  if (scope && scope.db === db && scope.doc.type === entityType) {
    details = { before: scope.before, after: documentSnapshot(db, scope.doc, entityId), path: scope.path,
      stock: db.prepare(`SELECT st.product_id, st.warehouse_id, st.change_qty, st.type, p.name AS product_name, w.name AS warehouse_name
        FROM stock_transactions st LEFT JOIN products p ON p.id=st.product_id LEFT JOIN warehouses w ON w.id=st.warehouse_id
        WHERE st.id>? ORDER BY st.id`).all(scope.stockId) };
    scope.recorded = true;
  }
  db.prepare(`INSERT INTO audit_logs (user_id, user_name, action, entity_type, entity_id, summary, details_json, request_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(user.id, user.name, action, entityType, entityId || null, summary || '', JSON.stringify(details), scope?.requestId || randomUUID());
}

// 调用方已持有 SQLite 写锁，业务、版本号和审计一起提交或回滚。
function runWithDocumentAudit(req, work) {
  const doc = documentOperation(req.path);
  if (!doc) return work();
  const db = req.tenantDb;
  const before = documentSnapshot(db, doc, doc.id);
  const beforeOrder = doc.id ? db.prepare(`SELECT * FROM ${doc.table} WHERE id=?`).get(doc.id) : null;
  if (doc.operation === 'edit') {
    const order = db.prepare(`SELECT status, revision FROM ${doc.table} WHERE id=?`).get(doc.id);
    if (!order) return { status: 404, error: '单据不存在' };
    if (order.status !== 'draft') return { status: 409, error: '这张单据已提交或审核，请返回详情页确认当前状态后再操作。' };
    if (!/^\d+$/.test(String(req.body.draft_revision ?? '')) || !Number.isSafeInteger(Number(req.body.draft_revision))) return { status: 400, error: '草稿版本缺失或无效，请重新打开编辑页面后重试。' };
    if (Number(req.body.draft_revision) !== order.revision) return { status: 409, error: '这份草稿已被其他页面修改。你的填写内容仍保留在本机，请重新打开单据核对后再修改。' };
  }
  const scope = { db, doc, before, path: req.path, requestId: req.requestId || randomUUID(), recorded: false,
    stockId: db.prepare('SELECT COALESCE(MAX(id),0) id FROM stock_transactions').get().id };
  return context.run(scope, () => {
    const result = work();
    if (result.error) return result;
    const id = doc.id || db.prepare(`SELECT MAX(id) id FROM ${doc.table}`).get().id;
    const afterOrder = db.prepare(`SELECT * FROM ${doc.table} WHERE id=?`).get(id);
    recordDocumentFinance(db, doc, beforeOrder, afterOrder, req.session.user, scope.requestId);
    if (doc.id && doc.kind !== 'purchases' && doc.operation !== 'delete') db.prepare(`UPDATE ${doc.table} SET revision=revision+1 WHERE id=?`).run(id);
    if (!scope.recorded) {
      const prefix = { new: '新建', edit: '编辑', delete: '删除', submit: '提交', withdraw: '撤回', approve: '审核通过', reject: '审核拒绝', unapprove: '反审核' }[doc.operation];
      writeAuditLog(db, req.session.user, prefix + doc.type + (doc.operation === 'submit' ? '审核' : ''), doc.type, id,
        doc.kind === 'purchases' && doc.operation === 'new' ? '采购入库' : '单据操作');
    }
    return result;
  });
}

module.exports = { writeAuditLog, runWithDocumentAudit, documentOperation, documentSnapshot };
