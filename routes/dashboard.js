const express = require('express');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;

  const today = new Date().toISOString().slice(0, 10);

  // 今日销售额（已审核的）
  let todaySalesSql = `SELECT COALESCE(SUM(total_amount),0) t FROM sales_orders WHERE order_date = ? AND status = 'approved'`;
  const todaySalesParams = [today];
  if (user.role !== 'admin') {
    todaySalesSql += ` AND user_id = ?`;
    todaySalesParams.push(user.id);
  }
  const todaySales = db.prepare(todaySalesSql).get(...todaySalesParams).t;

  // 本月销售额（已审核的）
  let monthlySalesSql = `SELECT COALESCE(SUM(total_amount),0) t FROM sales_orders WHERE strftime('%Y-%m', order_date) = strftime('%Y-%m', 'now') AND status = 'approved'`;
  const monthlySalesParams = [];
  if (user.role !== 'admin') {
    monthlySalesSql += ` AND user_id = ?`;
    monthlySalesParams.push(user.id);
  }
  const monthlySales = db.prepare(monthlySalesSql).get(...monthlySalesParams).t;

  // 总欠款（已审核的销售单未收金额）
  let debtSql = `SELECT COALESCE(SUM(total_amount - paid_amount),0) d FROM sales_orders WHERE status = 'approved'`;
  const debtParams = [];
  if (user.role !== 'admin') {
    debtSql += ` AND user_id = ?`;
    debtParams.push(user.id);
  }
  const totalDebt = db.prepare(debtSql).get(...debtParams).d;

  // 待审核单据数
  const pendingOrders = db.prepare(`SELECT COUNT(*) c FROM sales_orders WHERE status = 'submitted'`).get().c;

  // 毛利：仅管理员可见。口径 = 已审核 + 已收款(全款) 的订单，每行"销售额-成本"求和（赠品收入为0但成本照算，
  // 因为赠品实打实占用了库存和成本，不算成本会虚增毛利）。只统计公司整体，不按人拆分。
  let todayProfit = null;
  let monthlyProfit = null;
  if (user.role === 'admin') {
    const profitSqlBase = `
      SELECT COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * p.cost_price), 0) AS profit
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
      JOIN products p ON p.id = soi.product_id
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
