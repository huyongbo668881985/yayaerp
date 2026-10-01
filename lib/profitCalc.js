/**
 * 统一结算口径：余额 = 销售额 - 已收现金 - 已审核关联退货 + 已退款现金。
 * 正余额为应收，负余额为待退现金，零余额才是钱货两清。
 * payment_status 仅保留原始现金收款进度；关联退货成本按原单每基本单位加权成本冲回。
 */
/** 浮点容差：金额差小于这个值就算已结清（与 sales.js 的 0.001 口径一致） */
const SETTLE_EPSILON = 0.001;

/**
 * 关联到某张销售单、且已审核的退货金额合计。
 * @param {string} salesAlias 销售单在当前 SQL 里的别名（如 'so'、'so2'）
 * @returns {string} SQL 片段
 */
function returnedAmountSubquery(salesAlias = 'so') {
  // 子查询里的退货表别名跟着销售单别名走（ro_of_so / ro_of_so2），
  // 避免在嵌套场景下和外层的 ro 撞名，导致 SUM 的范围算错。
  const roAlias = `ro_of_${salesAlias}`;
  return `COALESCE((SELECT SUM(${roAlias}.total_amount) FROM return_orders ${roAlias}` +
         ` WHERE ${roAlias}.related_sales_order_id = ${salesAlias}.id` +
         ` AND ${roAlias}.status = 'approved'), 0)`;
}

/** 只计已审核退货的实际退款；退货抵扣与现金退款不能同时抵掉同一笔欠款。 */
function refundedAmountSubquery(salesAlias = 'so') {
  const alias = `refund_of_${salesAlias}`;
  return `COALESCE((SELECT SUM(${alias}.refunded_amount) FROM return_orders ${alias}` +
    ` WHERE ${alias}.related_sales_order_id = ${salesAlias}.id AND ${alias}.status = 'approved'), 0)`;
}

function effectiveDebtExpr(salesAlias = 'so') {
  return `(${salesAlias}.total_amount - ${salesAlias}.paid_amount - ${returnedAmountSubquery(salesAlias)} + ${refundedAmountSubquery(salesAlias)})`;
}

function salesSettledExpr(salesAlias = 'so') {
  return `ABS(${effectiveDebtExpr(salesAlias)}) <= ${SETTLE_EPSILON}`;
}

function attachEffectivePayment(order) {
  const returned = Number(order.returned_amount || 0);
  const refunded = Number(order.cash_refunded_amount || 0);
  const paid = Number(order.paid_amount || 0);
  const balance = Math.round((order.total_amount - returned - paid + refunded) * 100) / 100;
  Object.assign(order, {
    returned_amount: returned, cash_refunded_amount: refunded,
    effective_total: order.total_amount - returned,
    net_received: paid - refunded,
    balance, effective_debt: Math.max(0, balance), pending_refund: Math.max(0, -balance),
    effective_status: Math.abs(balance) <= SETTLE_EPSILON ? 'paid'
      : balance < 0 ? 'refund_pending' : paid > 0 || returned > 0 ? 'partial' : 'unpaid'
  });
  return order;
}

function getSalePayment(db, id) {
  const order = db.prepare(`SELECT so.*, ${returnedAmountSubquery()} AS returned_amount,
    ${refundedAmountSubquery()} AS cash_refunded_amount FROM sales_orders so WHERE so.id = ?`).get(id);
  return order ? attachEffectivePayment(order) : null;
}

// 兼容已有的关联退货：即使旧快照取了退货时的商品成本，报告也按原销售成本冲回。
// 同一商品多行按基本数量加权；无法找到原明细的独立/历史退货保留其自身成本快照。
function returnCostExpr(returnAlias = 'ro', itemAlias = 'roi') {
  return `COALESCE((SELECT SUM(original.base_quantity * original.cost_price_snapshot) / NULLIF(SUM(original.base_quantity), 0)
    FROM sales_order_items original WHERE original.sales_order_id = ${returnAlias}.related_sales_order_id
      AND original.product_id = ${itemAlias}.product_id), ${itemAlias}.cost_price_snapshot)`;
}

/**
 * 一笔退货算不算"财务上已落定"：
 *   要么自己已经现金退款（refund_status='refunded'），
 *   要么它关联的销售单有效欠款已结清（钱货两清，退货已经抵掉了尾款）。
 *
 * 用 EXISTS 而不是 COALESCE(子查询, 默认值)：关联销售单不存在时 EXISTS 直接为假，
 * 语义就是"未结清"，不需要靠一个魔法默认值去表达。
 *
 * 注意：本表达式用 ro. 前缀，因此退货语句里 return_orders 必须别名成 ro。
 */
const RETURN_SETTLED_EXPR = `(
  ro.refund_status = 'refunded'
  OR EXISTS (
    SELECT 1 FROM sales_orders so2
    WHERE so2.id = ro.related_sales_order_id
      AND ${salesSettledExpr('so2')}
  )
)`;

/** 生成某个单据别名上的日期过滤片段（YYYY-MM-DD 文本比较，闭区间），返回 { clause, params } */
function buildDateClause(alias, start, end) {
  let clause = '';
  const params = [];
  if (start) { clause += ` AND ${alias}.order_date >= ?`; params.push(start); }
  if (end) { clause += ` AND ${alias}.order_date <= ?`; params.push(end); }
  return { clause, params };
}

/**
 * 销售单毛利查询语句。只统计"有效欠款已结清"的单子（"不含应收"口径）。
 * filter 是 buildDateClause 的产物，作用在销售单别名 so 上。
 *
 * 参数兼容：历史上叫 onlyPaid（当时判定是 payment_status='paid'），
 * 现在判定改成有效欠款了，两个名字都收，传哪个都是一个意思。
 */
function salesProfitStatement({ onlySettled = true, onlyPaid = null, filter = null } = {}) {
  const settledOnly = onlyPaid === null ? onlySettled : onlyPaid;
  const dateClause = filter ? filter.clause : '';
  return {
    sql: `
      SELECT COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * soi.cost_price_snapshot), 0) AS profit
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
      WHERE so.status = 'approved'${settledOnly ? ` AND ${salesSettledExpr('so')}` : ''}${dateClause}
    `,
    params: filter ? filter.params : []
  };
}

/**
 * 退货冲减毛利查询语句。onlySettled=true 时只统计"已结清"的退货
 * （已现金退款，或关联销售单有效欠款已结清），与"不含应收"口径配套。
 * filter 作用在退货单别名 ro 上。
 */
function returnProfitStatement({ onlySettled = true, filter = null } = {}) {
  const dateClause = filter ? filter.clause : '';
  return {
    sql: `
      SELECT COALESCE(SUM(roi.quantity * roi.unit_price - roi.base_quantity * ${returnCostExpr()}), 0) AS profit
      FROM return_order_items roi
      JOIN return_orders ro ON ro.id = roi.return_order_id
      WHERE ro.status = 'approved'${onlySettled ? ` AND ${RETURN_SETTLED_EXPR}` : ''}${dateClause}
    `,
    params: filter ? filter.params : []
  };
}

/** 执行销售毛利查询，返回数值 */
function salesProfit(db, options = {}) {
  const st = salesProfitStatement(options);
  return db.prepare(st.sql).get(...st.params).profit;
}

/** 执行退货冲减毛利查询，返回数值 */
function returnProfit(db, options = {}) {
  const st = returnProfitStatement(options);
  return db.prepare(st.sql).get(...st.params).profit;
}

/**
 * 一个时间段内的净毛利（仪表盘"今日/本月"直接用这个）。
 * 销售按 so.order_date、退货按 ro.order_date 各自归属区间。
 * 默认即"不含应收"口径（只算已结清销售 − 已结清退货）；
 * 开关置 false 可得"含应收"口径。
 */
function profitOfPeriod(db, { start, end, onlySettled = true, onlyPaid = null } = {}) {
  const saleFilter = buildDateClause('so', start, end);
  const returnFilter = buildDateClause('ro', start, end);
  const settledOnly = onlyPaid === null ? onlySettled : onlyPaid;
  const sProfit = salesProfit(db, { onlySettled: settledOnly, filter: saleFilter });
  const rProfit = returnProfit(db, { onlySettled: settledOnly, filter: returnFilter });
  return { salesProfit: sProfit, returnProfit: rProfit, profit: sProfit - rProfit };
}

module.exports = {
  SETTLE_EPSILON,
  RETURN_SETTLED_EXPR,
  returnedAmountSubquery,
  refundedAmountSubquery,
  attachEffectivePayment,
  getSalePayment,
  returnCostExpr,
  effectiveDebtExpr,
  salesSettledExpr,
  buildDateClause,
  salesProfitStatement,
  returnProfitStatement,
  salesProfit,
  returnProfit,
  profitOfPeriod
};
