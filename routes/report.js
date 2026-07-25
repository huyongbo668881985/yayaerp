const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const router = express.Router();

// 统计口径统一：只算"已审核"的单据（草稿/待审核/已拒绝不算真实发生的业务），
// 跟现有仪表盘毛利的口径保持一致。退货会冲减销售额和毛利——处理方式是"反着的销售"：
// 退货审核通过就代表这笔生意实际上没做成/少做了，不管钱退没退给客户。

function buildDateFilter(alias, start, end) {
  let clause = '';
  const params = [];
  if (start) { clause += ` AND ${alias}.order_date >= ?`; params.push(start); }
  if (end) { clause += ` AND ${alias}.order_date <= ?`; params.push(end); }
  return { clause, params };
}

// 汇总数字：销售额（已扣退货）、应收（未收完款的部分）、毛利（含/不含应收账款两种口径，已扣退货）、应收订单毛利
function getSummary(db, start, end) {
  const saleFilter = buildDateFilter('so', start, end);
  const returnFilter = buildDateFilter('ro', start, end);

  const salesRaw = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) amount, COUNT(*) count
    FROM sales_orders so WHERE so.status = 'approved' ${saleFilter.clause}
  `).get(...saleFilter.params);

  const returnsRaw = db.prepare(`
    SELECT COALESCE(SUM(total_amount),0) amount, COUNT(*) count
    FROM return_orders ro WHERE ro.status = 'approved' ${returnFilter.clause}
  `).get(...returnFilter.params);

  const receivable = db.prepare(`
    SELECT COALESCE(SUM(total_amount - paid_amount),0) amount, COUNT(*) count
    FROM sales_orders so
    WHERE so.status = 'approved' AND so.payment_status != 'paid' ${saleFilter.clause}
  `).get(...saleFilter.params);

  const salesProfitSql = (onlyPaid) => `
    SELECT COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * p.cost_price), 0) AS profit
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    JOIN products p ON p.id = soi.product_id
    WHERE so.status = 'approved' ${onlyPaid ? "AND so.payment_status = 'paid'" : ''} ${saleFilter.clause}
  `;
  const returnProfitSql = (onlyRefunded) => `
    SELECT COALESCE(SUM(roi.quantity * roi.unit_price - roi.base_quantity * p.cost_price), 0) AS profit
    FROM return_order_items roi
    JOIN return_orders ro ON ro.id = roi.return_order_id
    JOIN products p ON p.id = roi.product_id
    WHERE ro.status = 'approved' ${onlyRefunded ? "AND ro.refund_status = 'refunded'" : ''} ${returnFilter.clause}
  `;

  const salesProfitPaid = db.prepare(salesProfitSql(true)).get(...saleFilter.params).profit;
  const salesProfitAll = db.prepare(salesProfitSql(false)).get(...saleFilter.params).profit;
  const returnProfitRefunded = db.prepare(returnProfitSql(true)).get(...returnFilter.params).profit;
  const returnProfitAll = db.prepare(returnProfitSql(false)).get(...returnFilter.params).profit;

  const sales = { amount: salesRaw.amount - returnsRaw.amount, count: salesRaw.count, returnCount: returnsRaw.count };
  const profitWithoutReceivable = salesProfitPaid - returnProfitRefunded;
  const profitWithReceivable = salesProfitAll - returnProfitAll;
  const receivableProfit = profitWithReceivable - profitWithoutReceivable;

  return { sales, returnsAmount: returnsRaw.amount, receivable, profitWithoutReceivable, profitWithReceivable, receivableProfit };
}

// 销售单明细：includeReceivable=false 时只列已收完款的单子（对应"不含应收"口径），
// true 时列区间内全部已审核单子（不管收没收到钱）
function getSalesOrderList(db, start, end, includeReceivable) {
  const { clause, params } = buildDateFilter('so', start, end);
  let sql = `
    SELECT so.id, so.order_date, c.name AS customer_name, w.name AS warehouse_name,
           so.total_amount, so.paid_amount, so.payment_status,
           COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * p.cost_price), 0) AS order_profit
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    JOIN products p ON p.id = soi.product_id
    WHERE so.status = 'approved' ${clause}
  `;
  if (!includeReceivable) sql += " AND so.payment_status = 'paid'";
  sql += ' GROUP BY so.id ORDER BY so.order_date DESC, so.id DESC';
  return db.prepare(sql).all(...params);
}

// 退货单明细：includeReceivable=false 时只列已退完款的单子，true 时列全部已审核退货单
function getReturnOrderList(db, start, end, includeReceivable) {
  const { clause, params } = buildDateFilter('ro', start, end);
  let sql = `
    SELECT ro.id, ro.order_date, c.name AS customer_name, w.name AS warehouse_name,
           ro.total_amount, ro.refunded_amount, ro.refund_status,
           COALESCE(SUM(roi.quantity * roi.unit_price - roi.base_quantity * p.cost_price), 0) AS order_profit
    FROM return_orders ro
    LEFT JOIN customers c ON c.id = ro.customer_id
    LEFT JOIN warehouses w ON w.id = ro.warehouse_id
    JOIN return_order_items roi ON roi.return_order_id = ro.id
    JOIN products p ON p.id = roi.product_id
    WHERE ro.status = 'approved' ${clause}
  `;
  if (!includeReceivable) sql += " AND ro.refund_status = 'refunded'";
  sql += ' GROUP BY ro.id ORDER BY ro.order_date DESC, ro.id DESC';
  return db.prepare(sql).all(...params);
}

router.get('/reports', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { start, end } = req.query;
  const includeReceivable = req.query.mode === 'with_receivable';

  const summary = getSummary(db, start, end);
  const orders = getSalesOrderList(db, start, end, includeReceivable);
  const returnOrders = getReturnOrderList(db, start, end, includeReceivable);

  res.render('report', { start: start || '', end: end || '', includeReceivable, summary, orders, returnOrders });
});

router.get('/reports/export', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { start, end } = req.query;
  const includeReceivable = req.query.mode === 'with_receivable';
  const orders = getSalesOrderList(db, start, end, includeReceivable);
  const returnOrders = getReturnOrderList(db, start, end, includeReceivable);

  const paymentText = { paid: '已收款', partial: '部分收款', unpaid: '未收款' };
  const refundText = { refunded: '已退款', partial: '部分退款', unrefunded: '未退款' };
  const headers = ['类型', '单号', '日期', '客户', '仓库', '金额', '已收/已退', '状态', '该单毛利'];
  const rows = [
    ...orders.map(o => [
      '销售', o.id, o.order_date, o.customer_name || '散客', o.warehouse_name,
      o.total_amount.toFixed(2), o.paid_amount.toFixed(2),
      paymentText[o.payment_status] || o.payment_status, o.order_profit.toFixed(2)
    ]),
    ...returnOrders.map(o => [
      '退货', o.id, o.order_date, o.customer_name || '散客', o.warehouse_name,
      '-' + o.total_amount.toFixed(2), o.refunded_amount.toFixed(2),
      refundText[o.refund_status] || o.refund_status, '-' + o.order_profit.toFixed(2)
    ])
  ];

  const rangeLabel = (start || end) ? `_${start || '起'}_${end || '止'}` : '';
  const modeLabel = includeReceivable ? '_含应收' : '';
  sendCsv(res, `经营报表${rangeLabel}${modeLabel}.csv`, headers, rows);
});

module.exports = router;
