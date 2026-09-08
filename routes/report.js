const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const {
  RETURN_SETTLED_EXPR, salesProfit, returnProfit,
  returnedAmountSubquery, effectiveDebtExpr, salesSettledExpr
} = require('../lib/profitCalc');
const router = express.Router();

// 统计口径统一：只算"已审核"的单据（草稿/待审核/已拒绝不算真实发生的业务），
// 跟现有仪表盘毛利的口径保持一致。

// 所有金额口径的 SQL 片段统一从 lib/profitCalc.js 引入（口径唯一实现点），
// 这里只是按本地 SQL 别名（销售单一律用 so）取一份，不再自己写第二遍定义。
// 注意：不改 sales_orders 表本身的 total_amount/paid_amount，欠款和收款状态永远是"查询时现算"，
// 这样原始单据数据永远保持真实历史记录，不会被退货悄悄覆盖掉。
const RETURNED_AMOUNT_SUBQUERY = returnedAmountSubquery('so');
// "有效欠款"：总金额 − 已收款 − 关联退货金额。<= 0.001 就算结清了（不管是收现金收的还是退货抵的）
const EFFECTIVE_DEBT_EXPR = effectiveDebtExpr('so');

function buildDateFilter(alias, start, end) {
  let clause = '';
  const params = [];
  if (start) { clause += ` AND ${alias}.order_date >= ?`; params.push(start); }
  if (end) { clause += ` AND ${alias}.order_date <= ?`; params.push(end); }
  return { clause, params };
}

// 汇总数字：销售额（已扣退货）、应收（已扣关联退货后仍未结清的部分）、
// 毛利（含/不含应收账款两种口径，已扣退货）、应收订单毛利
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

  // 应收金额：已经扣掉了关联退货，只统计"扣完之后仍然 > 0"的部分
  const receivable = db.prepare(`
    SELECT COALESCE(SUM(${EFFECTIVE_DEBT_EXPR}), 0) amount, COUNT(*) count
    FROM sales_orders so
    WHERE so.status = 'approved' AND ${EFFECTIVE_DEBT_EXPR} > 0.001 ${saleFilter.clause}
  `).get(...saleFilter.params);

  // 毛利计算统一走 lib/profitCalc.js（成本快照、只算已审核、含/不含应收判定都在那实现），
  // 与首页仪表盘共用同一套 SQL，杜绝两边口径再次分叉。
  const salesProfitPaid = salesProfit(db, { onlyPaid: true, filter: saleFilter });
  const salesProfitAll = salesProfit(db, { onlyPaid: false, filter: saleFilter });
  const returnProfitRefunded = returnProfit(db, { onlySettled: true, filter: returnFilter });
  const returnProfitAll = returnProfit(db, { onlySettled: false, filter: returnFilter });

  const sales = { amount: salesRaw.amount - returnsRaw.amount, count: salesRaw.count, returnCount: returnsRaw.count };
  const profitWithoutReceivable = salesProfitPaid - returnProfitRefunded;
  const profitWithReceivable = salesProfitAll - returnProfitAll;
  const receivableProfit = profitWithReceivable - profitWithoutReceivable;

  return { sales, returnsAmount: returnsRaw.amount, receivable, profitWithoutReceivable, profitWithReceivable, receivableProfit };
}

// 销售单明细：includeReceivable=false 时只列"有效欠款已结清"的单子（对应"不含应收"口径），
// true 时列区间内全部已审核单子（不管有没有结清）
function getSalesOrderList(db, start, end, includeReceivable) {
  const { clause, params } = buildDateFilter('so', start, end);
  let sql = `
    SELECT so.id, so.order_date, c.name AS customer_name, w.name AS warehouse_name,
           so.total_amount, so.paid_amount, ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount,
           COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * soi.cost_price_snapshot), 0) AS order_profit
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    WHERE so.status = 'approved' ${clause}
  `;
  // 这里必须用"有效欠款已结清"而不是 payment_status='paid'：
  // 后者是落库快照，定金 + 退货抵扣结清的单子会永远停在 'partial'
  // （补记收款会被"无需再记收款"拦下），两边口径就分叉了。
  if (!includeReceivable) sql += ` AND ${salesSettledExpr('so')}`;
  sql += ' GROUP BY so.id ORDER BY so.order_date DESC, so.id DESC';
  return db.prepare(sql).all(...params);
}

// 退货单明细：includeReceivable=false 时只列已退完款的单子，true 时列全部已审核退货单
function getReturnOrderList(db, start, end, includeReceivable) {
  const { clause, params } = buildDateFilter('ro', start, end);
  let sql = `
    SELECT ro.id, ro.order_date, c.name AS customer_name, w.name AS warehouse_name,
           ro.total_amount, ro.refunded_amount, ro.refund_status, ro.related_sales_order_id,
           COALESCE(SUM(roi.quantity * roi.unit_price - roi.base_quantity * roi.cost_price_snapshot), 0) AS order_profit
    FROM return_orders ro
    LEFT JOIN customers c ON c.id = ro.customer_id
    LEFT JOIN warehouses w ON w.id = ro.warehouse_id
    JOIN return_order_items roi ON roi.return_order_id = ro.id
    WHERE ro.status = 'approved' ${clause}
  `;
  if (!includeReceivable) sql += ` AND ${RETURN_SETTLED_EXPR}`;
  sql += ' GROUP BY ro.id ORDER BY ro.order_date DESC, ro.id DESC';
  return db.prepare(sql).all(...params);
}

router.get('/reports', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { start, end } = req.query;
  const includeReceivable = req.query.mode === 'with_receivable';

  const summary = getSummary(db, start, end);
  const orders = getSalesOrderList(db, start, end, includeReceivable).map(o => {
    const debt = o.total_amount - o.paid_amount - o.returned_amount;
    o.effective_status = debt <= 0.001 ? 'paid' : ((o.paid_amount > 0 || o.returned_amount > 0) ? 'partial' : 'unpaid');
    return o;
  });
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
      (o.total_amount - o.paid_amount - o.returned_amount) <= 0.001 ? '已收款' : (o.paid_amount > 0 || o.returned_amount > 0 ? '部分收款' : '未收款'),
      o.order_profit.toFixed(2)
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
