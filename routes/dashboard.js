const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { todayLocalDate } = require('../utils/dates');
const {
  profitOfPeriod, returnedAmountSubquery, effectiveDebtExpr, SETTLE_EPSILON
} = require('../lib/profitCalc');
const router = express.Router();

// 统计口径说明（与经营报表 /reports 保持一致）：
//   销售额 = 已审核销售单（按销售单日期）− 已审核退货单（按退货单日期）
//   总欠款 = Σ max(0, 销售单金额 − 已收款 − 该单关联的已审核退货金额)
//   毛利（仅管理员）= 明细行成本快照计算，只算已审核 + 有效欠款已结清的订单
// 操作员登录时只统计自己名下的数据。

// 关联到某张销售单、且已审核的退货金额。
// 与"有效欠款"表达式一起收敛在 lib/profitCalc.js（口径唯一实现点），
// 这里只是按本地 SQL 别名（销售单一律用 so）取一份，不再自己写第二遍定义。
const RETURNED_AMOUNT_SUBQUERY = returnedAmountSubquery('so');

// 有效欠款表达式：金额 − 已收款 − 关联退货，负数（多收/超抵）不算欠款
const EFFECTIVE_DEBT_EXPR = effectiveDebtExpr('so');

// 给一行销售单补上"有效欠款 / 有效收款状态"（与 sales.js 的 attachEffectivePayment 同一套算法）。
// 首页的收款状态徽章必须走这里，不能直接读 so.payment_status——
// 那个是落库快照、不扣退货，和销售列表页/详情页显示的结果对不上。
function attachEffectiveStatus(o) {
  const effectiveDebt = o.total_amount - (o.paid_amount || 0) - (o.returned_amount || 0);
  o.effective_status = effectiveDebt <= SETTLE_EPSILON
    ? 'paid'
    : ((o.paid_amount > 0 || o.returned_amount > 0) ? 'partial' : 'unpaid');
  o.effective_debt = Math.max(0, effectiveDebt);
  return o;
}

router.get('/', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const today = todayLocalDate(); // 北京时间，不用 UTC（toISOString 会把北京 0~8 点算成前一天）
  // SQLite 的 'now' 是 UTC，加 '+8 hours' 修正到北京时间（中国无夏令时，固定偏移精确）
  const LOCAL_NOW_MONTH = "strftime('%Y-%m', 'now', '+8 hours')";
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
                WHERE strftime('%Y-%m', so.order_date) = ${LOCAL_NOW_MONTH} AND so.status = 'approved' ${operatorFilter ? 'AND so.user_id = ?' : ''}), 0)
      -
      COALESCE((SELECT SUM(total_amount) FROM return_orders ro
                WHERE strftime('%Y-%m', ro.order_date) = ${LOCAL_NOW_MONTH} AND ro.status = 'approved' ${operatorFilter ? 'AND ro.user_id = ?' : ''}), 0)
      AS t
  `;
  const monthlyParams = [];
  // 操作员口径下 SQL 里有两个 user_id = ? 占位符（销售子查询 + 退货子查询），
  // 两个都要传——以前只传了一个，操作员一进首页这里就抛
  // "Too few parameter values were provided"，整个首页 500（潜伏 bug，这次补上）。
  if (operatorFilter) monthlyParams.push(user.id, user.id);
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

  // 待审核单据数：销售单 + 退货单 + 调拨单 三类合计（以前只算了销售单，退货/调拨卡在
  // 待审核时首页显示 0，操作员/管理员都会漏审）。
  // 操作员只统计自己名下的，与文件头的口径说明保持一致（三张表的归属字段都是各自的 user_id）。
  const pendingParams = operatorFilter ? [user.id] : [];
  const pendingCount = (table) =>
    db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE status = 'submitted' ${operatorFilter ? 'AND user_id = ?' : ''}`)
      .get(...pendingParams).c;
  const pendingOrders = pendingCount('sales_orders') + pendingCount('return_orders') + pendingCount('transfer_orders');

  // 毛利：仅管理员可见。口径与经营报表"不含应收"完全一致（SQL 唯一实现在 lib/profitCalc.js，
  // 避免仪表盘/报表再次分叉）：
  //   已审核 + 有效欠款已结清（金额 − 已收现金 − 关联已审核退货 ≤ 0.001）的销售毛利
  //   − 同区间"已结清"退货冲减毛利（退货按退货单日期归属；"已结清" = 已现金退款，
  //     或所关联销售单的有效欠款已结清，即退货抵掉了尾款）。
  // 结清判定一律现算、不读 payment_status（那是落库快照，追不上退货单的审核/反审核），
  // 详见 lib/profitCalc.js 顶部说明。成本用明细行落库时的成本快照，赠品收入为0但成本照算。
  let todayProfit = null;
  let monthlyProfit = null;
  if (user.role === 'admin') {
    const month = today.slice(0, 7);
    const monthEndDay = String(
      new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate()
    ).padStart(2, '0');
    todayProfit = profitOfPeriod(db, { start: today, end: today }).profit;
    monthlyProfit = profitOfPeriod(db, { start: `${month}-01`, end: `${month}-${monthEndDay}` }).profit;
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

  // 最近销售单（操作员只看自己录入的——列表页/详情页都是这个口径，
  // 首页不能反而把别人的单号递到眼前）
  // 收款状态徽章按"有效欠款"现算（见 attachEffectiveStatus），
  // 以前这里直接读 so.payment_status（落库快照，不扣退货），
  // 定金 + 退货抵扣结清的单子在首页显示"部分收款"、点进销售列表却显示"已收款"，
  // 一登录就能撞见两个不一样的结果（2026-09-08 修）。
  const recentSales = db.prepare(`
    SELECT so.id, so.order_date, so.total_amount, so.paid_amount, so.status,
           ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount,
           c.name AS customer_name, w.name AS warehouse_name
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    ${operatorFilter ? 'WHERE so.user_id = ?' : ''}
    ORDER BY so.id DESC LIMIT 5
  `).all(...(operatorFilter ? [user.id] : [])).map(attachEffectiveStatus);

  res.render('dashboard', {
    todaySales, monthlySales, totalDebt, pendingOrders, todayProfit, monthlyProfit,
    lowStock, recentSales, user
  });
});

module.exports = router;
