const express = require('express');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// 统计口径说明（与经营报表 /reports 保持一致）：
//   销售额 = 已审核销售单（按销售单日期）− 已审核退货单（按退货单日期）
//   总欠款 = Σ max(0, 销售单金额 − 已收款 − 该单关联的已审核退货金额)
//   毛利（仅管理员）= 明细行成本快照计算，只算已审核 + 已收款的订单
// 操作员登录时只统计自己名下的数据。

// 关联到某张销售单、且已审核的退货金额（与 sales.js / report.js 同一口径）
const RETURNED_AMOUNT_SUBQUERY = `COALESCE((SELECT SUM(ro.total_amount) FROM return_orders ro WHERE ro.related_sales_order_id = so.id AND ro.status = 'approved'), 0)`;

// 有效欠款表达式：金额 − 已收款 − 关联退货，负数（多收/超抵）不算欠款
const EFFECTIVE_DEBT_EXPR = `(so.total_amount - so.paid_amount - ${RETURNED_AMOUNT_SUBQUERY})`;

router.get('/', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const today = new Date().toISOString().slice(0, 10);
  const operatorFilter = user.role !== 'admin';

  // ---- 今日销售额（销售按销售单日期，退货按退货单日期，两边都只算已审核） ----
  const todaySalesSql = `
    SELECT
      COALESCE((SELECT SUM(total_amount) FROM sales_orders so
                WHERE so.order_date = ? AND so.status = 'approved' ${operatorFilter ? 'AND so.user_id = ?' : ''}), 0)
      -
      COALESCE((SELECT SUM(total_amount) FROM return_orders ro
                WHERE ro.order_date = ? AND ro.status = 'approved' ${operatorFilter ? 'AND ro.user_id = ?' : ''}), 0)
      AS t
  `;
  const todayParams = [today];
  if (operatorFilter) todayParams.push(user.id);
  todayParams.push(today);
  if (operatorFilter) todayParams.push(user.id);
  const todaySales = db.prepare(todaySalesSql).get(...todayParams).t;

  // ---- 本月销售额（同上口径） ----
  const monthlySalesSql = `
    SELECT
      COALESCE((SELECT SUM(total_amount) FROM sales_orders so
                WHERE strftime('%Y-%m', so.order_date) = strftime('%Y-%m', 'now') AND so.status = 'approved' ${operatorFilter ? 'AND so.user_id = ?' : ''}), 0)
      -
      COALESCE((SELECT SUM(total_amount) FROM return_orders ro
                WHERE strftime('%Y-%m', ro.order_date) = strftime('%Y-%m', 'now') AND ro.status = 'approved' ${operatorFilter ? 'AND ro.user_id = ?' : ''}), 0)
      AS t
  `;
  const monthlyParams = [];
  if (operatorFilter) monthlyParams.push(user.id);
  const monthlySales = db.prepare(monthlySalesSql).get(...monthlyParams).t;

  // ---- 总欠款：只累计"有效欠款 > 0"的销售单，退货抵扣部分不算欠 ----
  let debtSql = `
    SELECT COALESCE(SUM(CASE WHEN ${EFFECTIVE_DEBT_EXPR} > 0.001 THEN ${EFFECTIVE_DEBT_EXPR} ELSE 0 END), 0) AS d
    FROM sales_orders so
    WHERE so.status = 'approved' ${operatorFilter ? 'AND so.user_id = ?' : ''}
  `;
  const debtParams = [];
  if (operatorFilter) debtParams.push(user.id);
  const totalDebt = db.prepare(debtSql).get(...debtParams).d;

  // 待审核单据数
  const pendingOrders = db.prepare(`SELECT COUNT(*) c FROM sales_orders WHERE status = 'submitted'`).get().c;

  // 毛利：仅管理员可见。口径 = 已审核 + 已收款(全款) 的订单，每行"销售额-成本"求和。
  // 成本用明细行上的成本快照（开单那一刻的成本价），改商品成本价不影响历史毛利。
  // 赠品收入为0但成本照算（赠品实打实占用了库存和成本）。只统计公司整体，不按人拆分。
  let todayProfit = null;
  let monthlyProfit = null;
  if (user.role === 'admin') {
    const profitSqlBase = `
      SELECT COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * soi.cost_price_snapshot), 0) AS profit
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
      WHERE so.status = 'approved' AND so.payment_status = 'paid'
    `;
    todayProfit = db.prepare(profitSqlBase + ` AND so.order_date = ?`).get(today).profit;
    monthlyProfit = db.prepare(profitSqlBase + ` AND strftime('%Y-%m', so.order_date) = strftime('%Y-%m', 'now')`).get().profit;
  }

  const lowStock = db.prepare(`
    SELECT p.name, w.name AS warehouse_name, inv.quantity, p.low_stock_threshold, p.unit
    FROM inventory inv
    JOIN products p ON p.id = inv.product_id
    JOIN warehouses w ON w.id = inv.warehouse_id
    WHERE p.low_stock_threshold > 0 AND inv.quantity <= p.low_stock_threshold
    ORDER BY inv.quantity ASC
    LIMIT 20
  `).all();

  const recentSales = db.prepare(`
    SELECT so.id, so.order_date, so.total_amount, so.paid_amount, so.payment_status, so.status,
           c.name AS customer_name, w.name AS warehouse_name
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    ORDER BY so.id DESC LIMIT 5
  `).all();

  res.render('dashboard', {
    todaySales, monthlySales, totalDebt, pendingOrders, todayProfit, monthlyProfit,
    lowStock, recentSales, user
  });
});

module.exports = router;
