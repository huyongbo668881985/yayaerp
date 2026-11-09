/**
 * 业务员业绩汇总（仅供管理员路由使用，含毛利，严禁暴露给 operator）。
 *
 * 口径：
 *  - 归属：销售单按负责人 COALESCE(responsible_id, user_id)；
 *    退货按关联原销售单的负责人冲减，无关联原单的退货计入"未归属退货"。
 *  - 日期：销售按 so.order_date、退货按 ro.order_date 各自归属区间（不追溯）。
 *  - 实现毛利（不含应收）：与 profitCalc.js 一致，只算已审核且已结清的销售，减已结清的退货；
 *    所有行相加 == 经营报表顶部"不含应收"毛利。
 *  - 毛利率 = 实现毛利 / 净销售额（已审核销售额 − 已审核退货额）。
 */
const {
  buildDateClause, returnCostExpr, effectiveDebtExpr, salesSettledExpr, RETURN_SETTLED_EXPR
} = require('./profitCalc');

const OWNER_EXPR = 'COALESCE(so.responsible_id, so.user_id)';
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

function getSalespersonPerformance(db, start, end) {
  const saleFilter = buildDateClause('so', start, end);
  const returnFilter = buildDateClause('ro', start, end);
  const debt = effectiveDebtExpr('so');

  const saleRows = db.prepare(`
    SELECT ${OWNER_EXPR} AS owner_id,
           COUNT(*) AS order_count,
           COALESCE(SUM(so.total_amount), 0) AS sales_amount,
           COUNT(DISTINCT so.customer_id) AS customer_count,
           COALESCE(SUM(CASE WHEN ${debt} > 0.001 THEN ${debt} ELSE 0 END), 0) AS receivable
    FROM sales_orders so
    WHERE so.status = 'approved'${saleFilter.clause}
    GROUP BY owner_id
  `).all(...saleFilter.params);

  const saleProfitRows = db.prepare(`
    SELECT ${OWNER_EXPR} AS owner_id,
           COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * soi.cost_price_snapshot), 0) AS profit
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    WHERE so.status = 'approved' AND ${salesSettledExpr('so')}${saleFilter.clause}
    GROUP BY owner_id
  `).all(...saleFilter.params);

  const RET_OWNER = `(SELECT COALESCE(so.responsible_id, so.user_id) FROM sales_orders so WHERE so.id = ro.related_sales_order_id)`;
  const returnRows = db.prepare(`
    SELECT ${RET_OWNER} AS owner_id,
           COUNT(*) AS return_count,
           COALESCE(SUM(ro.total_amount), 0) AS return_amount
    FROM return_orders ro
    WHERE ro.status = 'approved'${returnFilter.clause}
    GROUP BY owner_id
  `).all(...returnFilter.params);

  const returnProfitRows = db.prepare(`
    SELECT ${RET_OWNER} AS owner_id,
           COALESCE(SUM(roi.quantity * roi.unit_price - roi.base_quantity * ${returnCostExpr()}), 0) AS profit
    FROM return_order_items roi
    JOIN return_orders ro ON ro.id = roi.return_order_id
    WHERE ro.status = 'approved' AND ${RETURN_SETTLED_EXPR}${returnFilter.clause}
    GROUP BY owner_id
  `).all(...returnFilter.params);

  const map = new Map();
  const get = id => {
    const key = id == null ? 'none' : id;
    if (!map.has(key)) {
      map.set(key, {
        user_id: id == null ? null : id, name: '', active: 1, unassigned: id == null,
        order_count: 0, sales_amount: 0, return_count: 0, return_amount: 0,
        customer_count: 0, receivable: 0, realized_profit: 0
      });
    }
    return map.get(key);
  };
  saleRows.forEach(r => Object.assign(get(r.owner_id), {
    order_count: r.order_count, sales_amount: r.sales_amount,
    customer_count: r.customer_count, receivable: r.receivable
  }));
  saleProfitRows.forEach(r => { get(r.owner_id).realized_profit += r.profit; });
  returnRows.forEach(r => Object.assign(get(r.owner_id), { return_count: r.return_count, return_amount: r.return_amount }));
  returnProfitRows.forEach(r => { get(r.owner_id).realized_profit -= r.profit; });

  const users = new Map(db.prepare('SELECT id, name, active FROM users').all().map(u => [u.id, u]));
  const rows = [...map.values()].map(r => {
    if (r.unassigned) r.name = '未归属退货';
    else {
      const u = users.get(r.user_id);
      r.name = u ? u.name : `用户#${r.user_id}`;
      r.active = u ? u.active : 0;
      if (!r.active) r.name += '（已停用）';
    }
    r.sales_amount = round2(r.sales_amount);
    r.return_amount = round2(r.return_amount);
    r.net_sales = round2(r.sales_amount - r.return_amount);
    r.receivable = round2(r.receivable);
    r.realized_profit = round2(r.realized_profit);
    r.margin_rate = r.net_sales > 0.001 ? (r.realized_profit / r.net_sales) * 100 : null;
    return r;
  });
  rows.sort((a, b) => (a.unassigned - b.unassigned) || (b.realized_profit - a.realized_profit) || (b.net_sales - a.net_sales));

  const total = rows.reduce((t, r) => {
    t.order_count += r.order_count; t.sales_amount += r.sales_amount; t.return_count += r.return_count;
    t.return_amount += r.return_amount; t.receivable += r.receivable; t.realized_profit += r.realized_profit;
    return t;
  }, { order_count: 0, sales_amount: 0, return_count: 0, return_amount: 0, receivable: 0, realized_profit: 0 });
  total.sales_amount = round2(total.sales_amount);
  total.return_amount = round2(total.return_amount);
  total.net_sales = round2(total.sales_amount - total.return_amount);
  total.receivable = round2(total.receivable);
  total.realized_profit = round2(total.realized_profit);
  total.margin_rate = total.net_sales > 0.001 ? (total.realized_profit / total.net_sales) * 100 : null;

  return { rows, total };
}

module.exports = { getSalespersonPerformance };
