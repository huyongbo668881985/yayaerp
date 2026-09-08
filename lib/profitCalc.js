/**
 * 毛利 / 欠款 / 结清判定 公共模块（口径唯一实现点）
 *
 * 首页仪表盘（dashboard.js）、经营报表（report.js）、销售单列表与详情（sales.js）
 * 的同一类数字全部在这里定义，任何一处改口径都不会再分叉。
 *
 * ===== 统一口径（2026-09-08 修订）=====
 *   有效欠款 = 销售单金额 − 已收现金 − 该单关联的「已审核」退货金额
 *   "已结清"  = 有效欠款 ≤ 0.001（不管是收现金收齐的，还是退货抵扣抵掉的）
 *
 *   毛利 = 已审核且有效欠款已结清的销售单
 *          Σ(quantity × unit_price − base_quantity × cost_price_snapshot)
 *        − 同区间"已结清"退货单的 Σ(quantity × unit_price − base_quantity × cost_price_snapshot)
 *
 * ===== 为什么不再用 sales_orders.payment_status 做结清判定（2026-09-08 修订）=====
 *   payment_status 是一个"落库快照"，只在建单 / 改单 / 记录收款这三个瞬间写入；
 *   而有效欠款是实时计算的，关联退货单一旦被审核或反审核，快照必然和实时值失步：
 *
 *     - 旧行为（快照不扣退货）：定金 600 + 退货抵扣 400 → 实际已结清，
 *       但 payment_status 永远停在 'partial'——想补记收款会被
 *       "该单有效欠款已结清，无需再记收款"拦下，没有任何入口能刷成 'paid'，
 *       该单毛利被永久排除在"不含应收毛利"之外。
 *     - 若改成落库时扣退货（另一个方向）：退货单被反审核后 returned 归零、
 *       实际又欠钱了，但 payment_status 已经写成 'paid' 且不会回退，
 *       于是报表毛利反向多算。
 *
 *   结论：这个判定只能现算，不能落库。
 *   payment_status 字段保留，但语义降级为纯粹的"现金收款进度"
 *   （paid_amount 相对 total_amount 收了多少），不再参与任何结清判定。
 *
 * ===== 其他 =====
 *   - 退货按"退货单日期"归属区间（与销售额按各自单据日期归属一致）
 *   - 成本一律用明细行落库时的 cost_price_snapshot，改商品成本价不影响历史毛利
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

/** 销售单"有效欠款"表达式 = 金额 − 已收现金 − 关联已审核退货 */
function effectiveDebtExpr(salesAlias = 'so') {
  return `(${salesAlias}.total_amount - ${salesAlias}.paid_amount - ${returnedAmountSubquery(salesAlias)})`;
}

/** 销售单是否已结清（有效欠款 ≤ 容差） */
function salesSettledExpr(salesAlias = 'so') {
  return `${effectiveDebtExpr(salesAlias)} <= ${SETTLE_EPSILON}`;
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
  effectiveDebtExpr,
  salesSettledExpr,
  buildDateClause,
  salesProfitStatement,
  returnProfitStatement,
  salesProfit,
  returnProfit,
  profitOfPeriod
};
