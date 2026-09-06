/**
 * 毛利计算公共模块（口径唯一实现点）
 *
 * 首页仪表盘（dashboard.js）与经营报表（report.js）的"毛利"必须在同一处实现，
 * 否则任何一边改口径、另一边漏改，就会像 2026-09-07 那样出现
 * "首页本月毛利 = 300、报表不含应收毛利 = 0"的分叉。
 *
 * 统一口径（2026-09-07 定版）：
 *   毛利 = 已审核且已收全款（payment_status='paid'）销售单的
 *          Σ(quantity×unit_price − base_quantity×cost_price_snapshot)
 *        − 同区间内"已结清"退货单的 Σ(quantity×unit_price − base_quantity×cost_price_snapshot)
 *
 * "已结清"退货（RETURN_SETTLED_EXPR）：要么自己已现金退款（refund_status='refunded'），
 * 要么它关联的销售单收款状态已经是 paid（RETURN_SETTLED_EXPR 用 ro. 前缀，
 * 因此退货语句里 return_orders 必须别名成 ro）。
 *
 * 退货按"退货单日期"归属区间（与销售额的按各自单据日期归属一致）。
 * 成本一律用明细行落库时的 cost_price_snapshot，改商品成本价不影响历史毛利。
 */
const RETURN_SETTLED_EXPR = `(
  ro.refund_status = 'refunded'
  OR (
    ro.related_sales_order_id IS NOT NULL
    AND COALESCE((
      SELECT so2.payment_status FROM sales_orders so2 WHERE so2.id = ro.related_sales_order_id
    ), 'unpaid') = 'paid'
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
 * 销售单毛利查询语句。onlyPaid=true 时只统计已收全款的单子（"不含应收"现金口径）。
 * filter 是 buildDateClause 的产物，作用在销售单别名 so 上。
 */
function salesProfitStatement({ onlyPaid = true, filter = null } = {}) {
  const dateClause = filter ? filter.clause : '';
  return {
    sql: `
      SELECT COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * soi.cost_price_snapshot), 0) AS profit
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
      WHERE so.status = 'approved'${onlyPaid ? ` AND so.payment_status = 'paid'` : ''}${dateClause}
    `,
    params: filter ? filter.params : []
  };
}

/**
 * 退货冲减毛利查询语句。onlySettled=true 时只统计"已结清"的退货
 * （refunded 或关联销售单已收款），与"不含应收"口径配套。
 * filter 作用在退货单别名 ro 上。
 */
function returnProfitStatement({ onlySettled = true, filter = null } = {}) {
  const dateClause = filter ? filter.clause : '';
  return {
    sql: `
      SELECT COALESCE(SUM(roi.quantity * roi.unit_price - roi.base_quantity * roi.cost_price_snapshot), 0) AS profit
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
 * 默认即"不含应收"口径（只算已收款销售 − 已结清退货）；
 * onlyPaid/onlySettled 置 false 可得"含应收"口径。
 */
function profitOfPeriod(db, { start, end, onlyPaid = true, onlySettled = true } = {}) {
  const saleFilter = buildDateClause('so', start, end);
  const returnFilter = buildDateClause('ro', start, end);
  const sProfit = salesProfit(db, { onlyPaid, filter: saleFilter });
  const rProfit = returnProfit(db, { onlySettled, filter: returnFilter });
  return { salesProfit: sProfit, returnProfit: rProfit, profit: sProfit - rProfit };
}

module.exports = {
  RETURN_SETTLED_EXPR,
  buildDateClause,
  salesProfitStatement,
  returnProfitStatement,
  salesProfit,
  returnProfit,
  profitOfPeriod
};
