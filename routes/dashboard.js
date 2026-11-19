const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { todayLocalDate } = require('../utils/dates');
const {
  profitOfPeriod, returnedAmountSubquery, refundedAmountSubquery, attachEffectivePayment, effectiveDebtExpr
} = require('../lib/profitCalc');
const { salesVisibility } = require('../lib/salesResponsibility');
const {
  DASHBOARD_COLORS, getRoleDashboardConfig, saveRoleDashboardConfig, resetDashboardConfig
} = require('../lib/dashboardConfig');
const { getSalespersonPerformance } = require('../lib/salespersonPerformance');
const { writeAuditLog } = require('../lib/auditLog');
const router = express.Router();

// 统计口径说明（与经营报表 /reports 保持一致）：
//   销售额 = 已审核销售单（按销售单日期）− 已审核退货单（按退货单日期）
//   本月回款额 = 当月实际收到的客户回款（含当月订单收款与收回往月欠款）− 当月现金退款
//   累计总欠款 = Σ max(0, 销售单金额 − 已收款 − 该单关联的已审核退货金额 + 已退现金)
//   本月净增欠款 = 本月新欠 − 清收旧欠 = 当前累计总欠款 − 上月末累计总欠款
//   毛利（仅管理员，服务端硬拦截）= 明细行成本快照计算，只算已审核 + 有效欠款已结清的订单
// 操作员登录时统计自己录入或负责的销售数据，且绝不计算或下发任何毛利/成本数据。

const RETURNED_AMOUNT_SUBQUERY = returnedAmountSubquery('so');
const EFFECTIVE_DEBT_EXPR = effectiveDebtExpr('so');

function calcMonthlyDebtMetrics(db, monthStart, saleScope) {
  const hasLedgerTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_ledger_accounts'").get()
  );
  const rawBalanceExpr = `(so.total_amount - so.paid_amount - ${RETURNED_AMOUNT_SUBQUERY} + ${refundedAmountSubquery('so')})`;
  let rows;
  if (hasLedgerTable) {
    const sql = `
      SELECT
        so.id,
        so.status,
        so.order_date,
        CASE WHEN so.status = 'approved' THEN ${rawBalanceExpr} ELSE 0 END AS current_balance,
        EXISTS(SELECT 1 FROM customer_ledger_accounts a WHERE a.account_id = so.id) AS has_ledger,
        COALESCE((
          SELECT SUM(l.sales_cents - l.received_cents - l.returned_cents + l.refunded_cents) / 100.0
          FROM customer_ledger l
          JOIN customer_ledger_accounts a ON a.ledger_id = l.id
          WHERE a.account_id = so.id
            AND (
              (l.event_kind != '升级结转' AND l.event_date >= ?)
              OR (l.event_kind = '升级结转' AND l.document_date >= ?)
            )
        ), 0) AS month_delta
      FROM sales_orders so
      WHERE 1=1${saleScope.sql}
    `;
    rows = db.prepare(sql).all(monthStart, monthStart, ...saleScope.params);
  } else {
    const sql = `
      SELECT
        so.id,
        so.status,
        so.order_date,
        CASE WHEN so.status = 'approved' THEN ${rawBalanceExpr} ELSE 0 END AS current_balance,
        0 AS has_ledger,
        0 AS month_delta
      FROM sales_orders so
      WHERE 1=1${saleScope.sql}
    `;
    rows = db.prepare(sql).all(...saleScope.params);
  }

  let newDebtCents = 0;
  let clearedOldDebtCents = 0;
  for (const r of rows) {
    const curBal = Number(r.current_balance || 0);
    const dNow = r.status === 'approved' && curBal > 0.001 ? Math.round(curBal * 100) : 0;
    const prevBal = r.has_ledger
      ? curBal - Number(r.month_delta || 0)
      : (r.order_date >= monthStart ? 0 : curBal);
    const dPrev = prevBal > 0.001 ? Math.round(prevBal * 100) : 0;
    const diff = dNow - dPrev;
    if (diff > 0) newDebtCents += diff;
    else if (diff < 0) clearedOldDebtCents += (-diff);
  }

  return {
    monthlyNewDebt: newDebtCents / 100,
    monthlyClearedOldDebt: clearedOldDebtCents / 100,
    monthlyNetDebt: (newDebtCents - clearedOldDebtCents) / 100
  };
}

function calcMonthlyCollectionMetrics(db, monthStart, monthEnd, user, saleScope) {
  const operatorFilter = user.role !== 'admin';
  const hasLedgerTable = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='customer_ledger'").get()
  );

  let currentOrderCents = 0;
  let priorOrderCents = 0;
  let cashRefundedCents = 0;

  if (hasLedgerTable) {
    const receiptRow = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN l.document_date >= ? THEN l.received_cents ELSE 0 END), 0) AS current_cents,
        COALESCE(SUM(CASE WHEN l.document_date < ? THEN l.received_cents ELSE 0 END), 0) AS prior_cents
      FROM customer_ledger l
      JOIN sales_orders so ON so.id = l.document_id
      WHERE l.document_type = 'sales'
        AND (
          (l.event_kind != '升级结转' AND l.event_date >= ? AND l.event_date <= ?)
          OR (l.event_kind = '升级结转' AND l.document_date >= ? AND l.document_date <= ?)
        )
        ${saleScope.sql}
    `).get(monthStart, monthStart, monthStart, monthEnd, monthStart, monthEnd, ...saleScope.params);

    currentOrderCents += Number(receiptRow.current_cents || 0);
    priorOrderCents += Number(receiptRow.prior_cents || 0);

    // 兜底：若存在未写入对账流水的本月已审核销售单（如旧夹具直接写表）
    const fallbackReceiptRow = db.prepare(`
      SELECT COALESCE(SUM(CAST(ROUND(so.paid_amount * 100) AS INTEGER)), 0) AS cents
      FROM sales_orders so
      WHERE so.status = 'approved'
        AND so.order_date >= ? AND so.order_date <= ?
        ${saleScope.sql}
        AND NOT EXISTS (
          SELECT 1 FROM customer_ledger l
          WHERE l.document_type = 'sales' AND l.document_id = so.id
        )
    `).get(monthStart, monthEnd, ...saleScope.params);
    currentOrderCents += Number(fallbackReceiptRow.cents || 0);

    const refundParams = [monthStart, monthEnd, monthStart, monthEnd];
    if (operatorFilter) refundParams.push(user.id);
    const refundRow = db.prepare(`
      SELECT COALESCE(SUM(l.refunded_cents), 0) AS refund_cents
      FROM customer_ledger l
      JOIN return_orders ro ON ro.id = l.document_id
      WHERE l.document_type = 'returns'
        AND (
          (l.event_kind != '升级结转' AND l.event_date >= ? AND l.event_date <= ?)
          OR (l.event_kind = '升级结转' AND l.document_date >= ? AND l.document_date <= ?)
        )
        ${operatorFilter ? 'AND ro.user_id = ?' : ''}
    `).get(...refundParams);
    cashRefundedCents += Number(refundRow.refund_cents || 0);

    const fallbackRefundParams = [monthStart, monthEnd];
    if (operatorFilter) fallbackRefundParams.push(user.id);
    const fallbackRefundRow = db.prepare(`
      SELECT COALESCE(SUM(CAST(ROUND(ro.refunded_amount * 100) AS INTEGER)), 0) AS cents
      FROM return_orders ro
      WHERE ro.status = 'approved'
        AND ro.order_date >= ? AND ro.order_date <= ?
        ${operatorFilter ? 'AND ro.user_id = ?' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM customer_ledger l
          WHERE l.document_type = 'returns' AND l.document_id = ro.id
        )
    `).get(...fallbackRefundParams);
    cashRefundedCents += Number(fallbackRefundRow.cents || 0);
  } else {
    const salesFallback = db.prepare(`
      SELECT COALESCE(SUM(CAST(ROUND(so.paid_amount * 100) AS INTEGER)), 0) AS cents
      FROM sales_orders so
      WHERE so.status = 'approved'
        AND so.order_date >= ? AND so.order_date <= ?
        ${saleScope.sql}
    `).get(monthStart, monthEnd, ...saleScope.params);
    currentOrderCents = Number(salesFallback.cents || 0);

    const refundFallbackParams = [monthStart, monthEnd];
    if (operatorFilter) refundFallbackParams.push(user.id);
    const refundFallback = db.prepare(`
      SELECT COALESCE(SUM(CAST(ROUND(ro.refunded_amount * 100) AS INTEGER)), 0) AS cents
      FROM return_orders ro
      WHERE ro.status = 'approved'
        AND ro.order_date >= ? AND ro.order_date <= ?
        ${operatorFilter ? 'AND ro.user_id = ?' : ''}
    `).get(...refundFallbackParams);
    cashRefundedCents = Number(refundFallback.cents || 0);
  }

  const netCents = currentOrderCents + priorOrderCents - cashRefundedCents;
  return {
    monthlyCollection: netCents / 100,
    monthlyCurrentSalesCollected: currentOrderCents / 100,
    monthlyOldDebtCollected: priorOrderCents / 100,
    monthlyCashRefunded: cashRefundedCents / 100
  };
}

router.get('/', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const isAdmin = user.role === 'admin';
  const today = todayLocalDate(); // 北京时间 YYYY-MM-DD
  const month = today.slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEndDay = String(
    new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate()
  ).padStart(2, '0');
  const monthEnd = `${month}-${monthEndDay}`;
  const year = today.slice(0, 4);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const LOCAL_NOW_MONTH = "strftime('%Y-%m', 'now', '+8 hours')";
  const operatorFilter = !isAdmin;
  const saleScope = salesVisibility('so', user);

  // ---- 今日销售额（销售按销售单日期，退货按退货单日期，两边都只算已审核） ----
  const todaySalesSql = `
    SELECT
      COALESCE((SELECT SUM(total_amount) FROM sales_orders so
                WHERE so.order_date = ? AND so.status = 'approved'${saleScope.sql}), 0)
      -
      COALESCE((SELECT SUM(total_amount) FROM return_orders ro
                WHERE ro.order_date = ? AND ro.status = 'approved' ${operatorFilter ? 'AND ro.user_id = ?' : ''}), 0)
      AS t
  `;
  const todayParams = [today, ...saleScope.params, today];
  if (operatorFilter) todayParams.push(user.id);
  const todaySales = db.prepare(todaySalesSql).get(...todayParams).t;

  // ---- 本月销售额（同上口径） ----
  const monthlySalesSql = `
    SELECT
      COALESCE((SELECT SUM(total_amount) FROM sales_orders so
                WHERE strftime('%Y-%m', so.order_date) = ${LOCAL_NOW_MONTH} AND so.status = 'approved'${saleScope.sql}), 0)
      -
      COALESCE((SELECT SUM(total_amount) FROM return_orders ro
                WHERE strftime('%Y-%m', ro.order_date) = ${LOCAL_NOW_MONTH} AND ro.status = 'approved' ${operatorFilter ? 'AND ro.user_id = ?' : ''}), 0)
      AS t
  `;
  const monthlyParams = [...saleScope.params];
  if (operatorFilter) monthlyParams.push(user.id);
  const monthlySales = db.prepare(monthlySalesSql).get(...monthlyParams).t;

  // ---- 本年度销售额（当年 1 月 1 日至今已审核销售单 − 同年已审核退货单） ----
  const yearlySalesSql = `
    SELECT
      COALESCE((SELECT SUM(total_amount) FROM sales_orders so
                WHERE so.order_date >= ? AND so.order_date <= ? AND so.status = 'approved'${saleScope.sql}), 0)
      -
      COALESCE((SELECT SUM(total_amount) FROM return_orders ro
                WHERE ro.order_date >= ? AND ro.order_date <= ? AND ro.status = 'approved' ${operatorFilter ? 'AND ro.user_id = ?' : ''}), 0)
      AS t
  `;
  const yearlyParams = [yearStart, yearEnd, ...saleScope.params, yearStart, yearEnd];
  if (operatorFilter) yearlyParams.push(user.id);
  const yearlySales = db.prepare(yearlySalesSql).get(...yearlyParams).t;

  // ---- 累计总欠款：只累计"有效欠款 > 0"的销售单，退货抵扣部分不算欠 ----
  const debtSql = `
    SELECT COALESCE(SUM(CASE WHEN ${EFFECTIVE_DEBT_EXPR} > 0.001 THEN ${EFFECTIVE_DEBT_EXPR} ELSE 0 END), 0) AS d
    FROM sales_orders so
    WHERE so.status = 'approved'${saleScope.sql}
  `;
  const totalDebt = db.prepare(debtSql).get(...saleScope.params).d;

  // ---- 本月净增欠款（本月新欠 − 清收旧欠） ----
  const { monthlyNewDebt, monthlyClearedOldDebt, monthlyNetDebt } = calcMonthlyDebtMetrics(db, monthStart, saleScope);

  // ---- 本月回款额（当月实际收款 − 当月现金退款） ----
  const {
    monthlyCollection,
    monthlyCurrentSalesCollected,
    monthlyOldDebtCollected,
    monthlyCashRefunded
  } = calcMonthlyCollectionMetrics(db, monthStart, monthEnd, user, saleScope);

  // ---- 待审核单据数：销售单 + 退货单 + 调拨单 三类合计 ----
  const pendingParams = operatorFilter ? [user.id] : [];
  const pendingCount = (table) =>
    db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE status = 'submitted' ${operatorFilter ? 'AND user_id = ?' : ''}`)
      .get(...pendingParams).c;
  const pendingSales = db.prepare(`SELECT COUNT(*) c FROM sales_orders so WHERE so.status = 'submitted'${saleScope.sql}`)
    .get(...saleScope.params).c;
  const pendingReturns = pendingCount('return_orders');
  const pendingTransfers = pendingCount('transfer_orders');
  const pendingOrders = pendingSales + pendingReturns + pendingTransfers;

  // ---- 毛利：仅管理员可见（服务端硬拦截，操作员绝不计算、绝不返回毛利数据） ----
  let todayProfit = null;
  let monthlyProfit = null;
  if (isAdmin) {
    todayProfit = profitOfPeriod(db, { start: today, end: today }).profit;
    monthlyProfit = profitOfPeriod(db, { start: monthStart, end: monthEnd }).profit;
  }

  // 业务员业绩排行：仅管理员（服务端硬拦截，含毛利），默认本月、默认仅操作员（可通过 sp_admin=1 切换含管理员）
  let spRange = null;
  let spPerf = null;
  if (isAdmin) {
    const key = ['today', 'month', 'year'].includes(req.query.sp) ? req.query.sp : 'month';
    const includeAdmin = req.query.sp_admin === '1';
    const bounds = key === 'today' ? { start: today, end: today }
      : key === 'year' ? { start: yearStart, end: yearEnd } : { start: monthStart, end: monthEnd };
    spRange = { key, includeAdmin, ...bounds };
    spPerf = getSalespersonPerformance(db, bounds.start, bounds.end, { excludeAdmin: !includeAdmin });
  }

  // 读取当前角色配置的卡片列表，并在服务端二次硬过滤 adminOnly 卡片
  const roleCards = getRoleDashboardConfig(db, user.role)
    .filter(c => c.enabled && (isAdmin || !c.adminOnly));

  const lowStock = db.prepare(`
    SELECT p.name, w.name AS warehouse_name, inv.quantity, p.low_stock_threshold, p.unit
    FROM inventory inv
    JOIN products p ON p.id = inv.product_id
    JOIN warehouses w ON w.id = inv.warehouse_id
    WHERE w.active = 1 AND p.low_stock_threshold > 0 AND inv.quantity <= p.low_stock_threshold
      AND (p.sale_visible = 1 OR inv.quantity > 0)
      ${operatorFilter ? 'AND w.operator_id = ?' : ''}
    ORDER BY inv.quantity ASC
    LIMIT 20
  `).all(...(operatorFilter ? [user.id] : []));

  // 最近销售单（操作员看自己录入或负责的——与列表页/详情页保持同一口径）
  const recentSales = db.prepare(`
    SELECT so.id, so.order_date, so.total_amount, so.paid_amount, so.status,
           ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount, ${refundedAmountSubquery()} AS cash_refunded_amount,
           c.name AS customer_name, w.name AS warehouse_name
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    WHERE 1=1${saleScope.sql}
    ORDER BY so.id DESC LIMIT 5
  `).all(...saleScope.params).map(attachEffectivePayment);

  res.render('dashboard', {
    todaySales,
    monthlySales,
    monthlyCollection,
    monthlyCurrentSalesCollected,
    monthlyOldDebtCollected,
    monthlyCashRefunded,
    yearlySales,
    totalDebt,
    monthlyNetDebt,
    monthlyNewDebt,
    monthlyClearedOldDebt,
    pendingOrders,
    todayProfit: isAdmin ? todayProfit : null,
    monthlyProfit: isAdmin ? monthlyProfit : null,
    roleCards,
    lowStock,
    recentSales,
    spRange,
    spPerf: isAdmin ? spPerf : null,
    user,
    today,
    yearStart,
    pendingSales,
    pendingReturns,
    pendingTransfers
  });
});

// ---- 首页看板自定义设置页（仅管理员可访问） ----
router.get('/settings/dashboard', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const adminCards = getRoleDashboardConfig(db, 'admin');
  const operatorCards = getRoleDashboardConfig(db, 'operator');
  res.render('dashboard_settings', {
    adminCards,
    operatorCards,
    colors: DASHBOARD_COLORS
  });
});

function parseRoleCardsFromBody(body, role) {
  const jsonKey = `${role}_cards_json`;
  if (typeof body[jsonKey] === 'string' && body[jsonKey].trim() !== '') {
    try {
      const parsed = JSON.parse(body[jsonKey]);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) { /* 回退到表单字段解析 */ }
  }
  const toList = (raw) => {
    if (Array.isArray(raw)) return raw.flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  };
  const ids = toList(body[`${role}_order`]);
  const enabledSet = new Set(toList(body[`${role}_enabled`]));
  return ids.map(id => ({
    id: String(id),
    enabled: enabledSet.has(String(id)),
    color: body[`${role}_color_${id}`] || ''
  }));
}

router.post('/settings/dashboard', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;

  if (req.body.action === 'reset') {
    db.transaction(() => {
      resetDashboardConfig(db);
      writeAuditLog(db, user, '重置看板配置', '首页看板', null, '恢复管理员与操作员首页看板默认卡片配置');
    }).immediate();
    req.session.flashSuccess = '已恢复首页看板默认配置';
    return res.redirect('/settings/dashboard');
  }

  const adminInput = parseRoleCardsFromBody(req.body, 'admin');
  const operatorInput = parseRoleCardsFromBody(req.body, 'operator');

  db.transaction(() => {
    const savedAdmin = saveRoleDashboardConfig(db, 'admin', adminInput);
    const savedOperator = saveRoleDashboardConfig(db, 'operator', operatorInput);
    const adminVisible = savedAdmin.filter(c => c.enabled).map(c => c.label).join('、') || '无';
    const operatorVisible = savedOperator.filter(c => c.enabled).map(c => c.label).join('、') || '无';
    writeAuditLog(
      db,
      user,
      '修改看板配置',
      '首页看板',
      null,
      `管理员显示：${adminVisible}；操作员显示：${operatorVisible}`,
      { admin: savedAdmin.map(c => ({ id: c.id, enabled: c.enabled, color: c.color })), operator: savedOperator.map(c => ({ id: c.id, enabled: c.enabled, color: c.color })) }
    );
  }).immediate();

  req.session.flashSuccess = '首页看板设置已保存';
  if (req.body.redirect_to === 'home') return res.redirect('/');
  res.redirect('/settings/dashboard');
});

module.exports = router;
