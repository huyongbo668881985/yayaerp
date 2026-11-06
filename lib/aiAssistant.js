'use strict';

const { todayLocalDate } = require('../utils/dates');
const {
  effectiveDebtExpr,
  returnedAmountSubquery,
  refundedAmountSubquery,
  returnCostExpr
} = require('./profitCalc');
const { getSummary } = require('../routes/report');

const EFFECTIVE_DEBT_EXPR = effectiveDebtExpr('so');
const RETURNED_AMOUNT_EXPR = returnedAmountSubquery('so');
const REFUNDED_AMOUNT_EXPR = refundedAmountSubquery('so');
const RETURN_COST_EXPR = returnCostExpr('ro', 'roi');

function shiftDateStr(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function clampDays(rawDays, fallback = 90) {
  const n = parseInt(rawDays, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(7, n));
}

function round2(n) {
  if (n == null || !Number.isFinite(Number(n))) return 0;
  return Math.round(Number(n) * 100) / 100;
}

function round1(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return Math.round(Number(n) * 10) / 10;
}

function shelfguardConfig() {
  const baseUrl = String(process.env.SHELFGUARD_BASE_URL || 'http://127.0.0.1:3100/shelfguard').replace(/\/+$/, '');
  const apiKey = String(process.env.SHELFGUARD_INTERNAL_KEY || process.env.INTERNAL_API_KEY || '').trim();
  return { baseUrl, apiKey, configured: Boolean(baseUrl && apiKey.length >= 16) };
}

function llmConfig() {
  const apiKey = String(process.env.DASHSCOPE_API_KEY || process.env.AI_API_KEY || '').trim();
  const baseUrl = String(process.env.AI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const model = String(process.env.AI_MODEL || 'qwen-plus').trim();
  return { apiKey, baseUrl, model, configured: Boolean(apiKey) };
}

async function fetchShelfGuardJson(pathname, queryParams = {}) {
  const { baseUrl, apiKey, configured } = shelfguardConfig();
  if (!configured) {
    return {
      ok: false,
      error: '尚未在 .env 中配置 SHELFGUARD_INTERNAL_KEY（至少16位，需与 ShelfGuard 的 INTERNAL_API_KEY 一致）'
    };
  }
  const qs = new URLSearchParams();
  Object.entries(queryParams).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  const url = `${baseUrl}${pathname}${qs.toString() ? '?' + qs.toString() : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return {
        ok: false,
        error: (data && data.error) || `ShelfGuard 响应 HTTP ${res.status}`
      };
    }
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: `无法连接 ShelfGuard 巡检服务 (${err.name === 'AbortError' ? '请求超时' : err.message})`
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量加载当前租户所有客户标签及客户-标签映射
 */
function loadCustomerTagMap(db) {
  let definedTags = [];
  const tagsByCustomerId = new Map();
  try {
    definedTags = db.prepare('SELECT id, name, color FROM customer_tags ORDER BY id ASC').all();
    const links = db.prepare(`
      SELECT l.customer_id, t.name
      FROM customer_tag_links l
      JOIN customer_tags t ON t.id = l.tag_id
      ORDER BY t.id ASC
    `).all();
    for (const link of links) {
      let arr = tagsByCustomerId.get(link.customer_id);
      if (!arr) {
        arr = [];
        tagsByCustomerId.set(link.customer_id, arr);
      }
      arr.push(link.name);
    }
  } catch (_) {}

  function getTagsForCustomer(customerId) {
    return tagsByCustomerId.get(customerId) || [];
  }

  return { definedTags, tagsByCustomerId, getTagsForCustomer };
}

/**
 * 汇总一组客户按标签（含“无标签”）的数量、净销售额与应收欠款
 */
function summarizeStoresByTag(stores, definedTags = []) {
  const tagStatsMap = new Map();
  for (const t of definedTags) {
    tagStatsMap.set(t.name, {
      tag_name: t.name,
      customer_count: 0,
      net_sales_amount: 0,
      order_receivable: 0
    });
  }
  tagStatsMap.set('无标签', {
    tag_name: '无标签',
    customer_count: 0,
    net_sales_amount: 0,
    order_receivable: 0
  });

  for (const s of stores) {
    const tags = Array.isArray(s.tags) && s.tags.length > 0 ? s.tags : ['无标签'];
    const netSales = Number(s.net_sales_amount ?? s.current_net_sales ?? 0);
    const debt = Number(s.order_receivable ?? s.total_receivable ?? 0);
    for (const tName of tags) {
      let bucket = tagStatsMap.get(tName);
      if (!bucket) {
        bucket = { tag_name: tName, customer_count: 0, net_sales_amount: 0, order_receivable: 0 };
        tagStatsMap.set(tName, bucket);
      }
      bucket.customer_count += 1;
      bucket.net_sales_amount = round2(bucket.net_sales_amount + netSales);
      bucket.order_receivable = round2(bucket.order_receivable + debt);
    }
  }

  return Array.from(tagStatsMap.values()).filter(b => b.customer_count > 0 || definedTags.some(t => t.name === b.tag_name));
}

/**
 * 工具 1：搜索或按业务员/客户标签统计列出客户（门店）
 */
function querySearchCustomers(db, { keyword = '', operatorName = '', tagName = '', days = 90, limit = 20 } = {}) {
  const safeDays = clampDays(days, 90);
  const end = todayLocalDate();
  const start = shiftDateStr(end, -(safeDays - 1));
  const safeLimit = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
  const kw = String(keyword || '').trim().slice(0, 50);
  const opKw = String(operatorName || '').trim().slice(0, 50);
  const rawTagKw = String(tagName || '').trim().slice(0, 50).replace(/客户$/u, '');

  const { definedTags, getTagsForCustomer } = loadCustomerTagMap(db);

  const conditions = [];
  const params = [];

  if (kw) {
    conditions.push('(c.name LIKE ? OR c.contact LIKE ? OR c.phone LIKE ? OR c.address LIKE ? OR u.name LIKE ?)');
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
  }

  if (opKw) {
    if (opKw === '未分配' || opKw === '无归属' || opKw === '无负责人') {
      conditions.push('c.operator_id IS NULL');
    } else {
      conditions.push('u.name LIKE ?');
      params.push(`%${opKw}%`);
    }
  }

  if (rawTagKw) {
    if (rawTagKw === '无标签' || rawTagKw === '未打标签' || rawTagKw === '未分类' || rawTagKw.toLowerCase() === 'untagged') {
      conditions.push('NOT EXISTS (SELECT 1 FROM customer_tag_links l WHERE l.customer_id = c.id)');
    } else {
      conditions.push(`EXISTS (
        SELECT 1 FROM customer_tag_links l
        JOIN customer_tags t ON t.id = l.tag_id
        WHERE l.customer_id = c.id AND (t.name = ? OR t.name LIKE ?)
      )`);
      params.push(rawTagKw, `%${rawTagKw}%`);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const allMatchedRows = db.prepare(`
    SELECT
      c.id,
      c.name,
      c.contact,
      c.phone,
      c.address,
      u.name AS operator_name,
      COALESCE((
        SELECT SUM(so.total_amount)
        FROM sales_orders so
        WHERE so.customer_id = c.id AND so.status = 'approved' AND so.order_date BETWEEN ? AND ?
      ), 0) AS period_sales,
      COALESCE((
        SELECT SUM(ro.total_amount)
        FROM return_orders ro
        WHERE ro.customer_id = c.id AND ro.status = 'approved' AND ro.order_date BETWEEN ? AND ?
      ), 0) AS period_returns,
      COALESCE((
        SELECT SUM(${EFFECTIVE_DEBT_EXPR})
        FROM sales_orders so
        WHERE so.customer_id = c.id AND so.status = 'approved' AND ${EFFECTIVE_DEBT_EXPR} > 0.001
      ), 0) AS order_receivable
    FROM customers c
    LEFT JOIN users u ON u.id = c.operator_id
    ${whereClause}
    ORDER BY period_sales DESC, c.id ASC
  `).all(start, end, start, end, ...params);

  const allEnriched = allMatchedRows.map(r => {
    const tags = getTagsForCustomer(r.id);
    return {
      customer_id: r.id,
      name: r.name,
      operator_name: r.operator_name || '未分配',
      tags: tags.length > 0 ? tags : ['无标签'],
      phone: r.phone || '',
      address: r.address || '',
      net_sales_amount: round2(r.period_sales - r.period_returns),
      order_receivable: round2(r.order_receivable),
      total_receivable: round2(r.order_receivable)
    };
  });

  return {
    period: { start, end, days: safeDays },
    filters_applied: {
      keyword: kw || null,
      operator_name: opKw || null,
      tag_name: rawTagKw || null
    },
    available_customer_tags: definedTags.map(t => t.name),
    total_matched_customers: allEnriched.length,
    matched_tag_breakdown: summarizeStoresByTag(allEnriched, definedTags),
    customers: allEnriched.slice(0, safeLimit)
  };
}

/**
 * 工具 2：单店进销存深度诊断
 */
function queryCustomerJxcDiagnosis(db, { customerId, customerName = '', days = 90 } = {}) {
  const safeDays = clampDays(days, 90);
  const end = todayLocalDate();
  const start = shiftDateStr(end, -(safeDays - 1));
  const prevEnd = shiftDateStr(start, -1);
  const prevStart = shiftDateStr(prevEnd, -(safeDays - 1));

  let customer = null;
  if (customerId && Number.isInteger(Number(customerId)) && Number(customerId) > 0) {
    customer = db.prepare(`
      SELECT c.*, u.name AS operator_name
      FROM customers c
      LEFT JOIN users u ON u.id = c.operator_id
      WHERE c.id = ?
    `).get(Number(customerId));
  }
  if (!customer && customerName && String(customerName).trim()) {
    const cleanName = String(customerName).trim();
    customer = db.prepare(`
      SELECT c.*, u.name AS operator_name
      FROM customers c
      LEFT JOIN users u ON u.id = c.operator_id
      WHERE c.name = ? OR c.name LIKE ?
      ORDER BY CASE WHEN c.name = ? THEN 0 ELSE 1 END, c.id ASC
      LIMIT 1
    `).get(cleanName, `%${cleanName}%`, cleanName);
  }

  if (!customer) {
    return { found: false, error: '未找到匹配的客户门店，请先通过 search_customers 确认客户名称或 ID' };
  }

  const cid = customer.id;

  function periodMetrics(pStart, pEnd) {
    const saleRow = db.prepare(`
      SELECT
        COALESCE(SUM(so.total_amount), 0) AS sales_amount,
        COUNT(*) AS order_count,
        COALESCE(SUM(so.paid_amount - ${REFUNDED_AMOUNT_EXPR}), 0) AS net_received
      FROM sales_orders so
      WHERE so.customer_id = ? AND so.status = 'approved' AND so.order_date BETWEEN ? AND ?
    `).get(cid, pStart, pEnd);

    const retRow = db.prepare(`
      SELECT
        COALESCE(SUM(ro.total_amount), 0) AS return_amount,
        COUNT(*) AS return_count
      FROM return_orders ro
      WHERE ro.customer_id = ? AND ro.status = 'approved' AND ro.order_date BETWEEN ? AND ?
    `).get(cid, pStart, pEnd);

    const saleProfitRow = db.prepare(`
      SELECT COALESCE(SUM(soi.quantity * soi.unit_price - soi.base_quantity * soi.cost_price_snapshot), 0) AS profit
      FROM sales_order_items soi
      JOIN sales_orders so ON so.id = soi.sales_order_id
      WHERE so.customer_id = ? AND so.status = 'approved' AND so.order_date BETWEEN ? AND ?
    `).get(cid, pStart, pEnd);

    const retProfitRow = db.prepare(`
      SELECT COALESCE(SUM(roi.quantity * roi.unit_price - roi.base_quantity * (${RETURN_COST_EXPR})), 0) AS profit
      FROM return_order_items roi
      JOIN return_orders ro ON ro.id = roi.return_order_id
      WHERE ro.customer_id = ? AND ro.status = 'approved' AND ro.order_date BETWEEN ? AND ?
    `).get(cid, pStart, pEnd);

    const netSales = round2(saleRow.sales_amount - retRow.return_amount);
    const grossProfit = round2(saleProfitRow.profit - retProfitRow.profit);
    const marginRate = netSales > 0.001 ? round1((grossProfit / netSales) * 100) : null;

    return {
      sales_amount: round2(saleRow.sales_amount),
      return_amount: round2(retRow.return_amount),
      net_sales_amount: netSales,
      order_count: saleRow.order_count,
      return_count: retRow.return_count,
      net_received: round2(saleRow.net_received),
      gross_profit_with_receivable: grossProfit,
      margin_rate_pct: marginRate
    };
  }

  const current = periodMetrics(start, end);
  const previous = periodMetrics(prevStart, prevEnd);

  const salesDiffPct = previous.net_sales_amount > 0.001
    ? round1(((current.net_sales_amount - previous.net_sales_amount) / previous.net_sales_amount) * 100)
    : null;

  const debtRow = db.prepare(`
    SELECT
      COALESCE(SUM(${EFFECTIVE_DEBT_EXPR}), 0) AS order_receivable,
      COUNT(*) AS unpaid_order_count
    FROM sales_orders so
    WHERE so.customer_id = ? AND so.status = 'approved' AND ${EFFECTIVE_DEBT_EXPR} > 0.001
  `).get(cid);

  const openingBalance = round2((customer.opening_balance_cents || 0) / 100);
  const orderReceivable = round2(debtRow.order_receivable);
  const totalReceivable = round2(orderReceivable + Math.max(0, openingBalance));

  const lastOrderRow = db.prepare(`
    SELECT MAX(order_date) AS last_order_date
    FROM sales_orders
    WHERE customer_id = ? AND status = 'approved'
  `).get(cid);

  // 常拿商品 Top 8（对比本期与上期拿货量，方便发现断货或停拿的品种）
  const topProducts = db.prepare(`
    SELECT
      p.id AS product_id,
      p.name AS product_name,
      p.spec,
      p.unit AS base_unit,
      SUM(CASE WHEN so.order_date BETWEEN ? AND ? THEN soi.base_quantity ELSE 0 END) AS cur_base_qty,
      SUM(CASE WHEN so.order_date BETWEEN ? AND ? THEN soi.quantity * soi.unit_price ELSE 0 END) AS cur_amount,
      COUNT(DISTINCT CASE WHEN so.order_date BETWEEN ? AND ? THEN so.id END) AS cur_order_count,
      SUM(CASE WHEN so.order_date BETWEEN ? AND ? THEN soi.base_quantity ELSE 0 END) AS prev_base_qty
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    JOIN products p ON p.id = soi.product_id
    WHERE so.customer_id = ? AND so.status = 'approved' AND so.order_date BETWEEN ? AND ?
    GROUP BY p.id
    ORDER BY cur_amount DESC, prev_base_qty DESC
    LIMIT 10
  `).all(start, end, start, end, start, end, prevStart, prevEnd, cid, prevStart, end);

  const recentOrders = db.prepare(`
    SELECT
      so.id,
      so.order_date,
      so.total_amount,
      so.paid_amount,
      ${RETURNED_AMOUNT_EXPR} AS returned_amount,
      ${EFFECTIVE_DEBT_EXPR} AS effective_debt
    FROM sales_orders so
    WHERE so.customer_id = ? AND so.status = 'approved'
    ORDER BY so.order_date DESC, so.id DESC
    LIMIT 5
  `).all(cid);

  const { getTagsForCustomer } = loadCustomerTagMap(db);
  const customerTags = getTagsForCustomer(cid);

  return {
    found: true,
    customer: {
      id: customer.id,
      name: customer.name,
      contact: customer.contact || '',
      phone: customer.phone || '',
      address: customer.address || '',
      operator_name: customer.operator_name || '未分配',
      tags: customerTags.length > 0 ? customerTags : ['无标签']
    },
    period: {
      days: safeDays,
      current_start: start,
      current_end: end,
      previous_start: prevStart,
      previous_end: prevEnd
    },
    current_period: current,
    previous_period: previous,
    sales_diff_pct: salesDiffPct,
    debt: {
      order_receivable: orderReceivable,
      opening_balance: openingBalance,
      total_receivable: totalReceivable,
      unpaid_order_count: debtRow.unpaid_order_count,
      last_order_date: lastOrderRow ? lastOrderRow.last_order_date : null
    },
    product_breakdown: topProducts.map(p => ({
      product_id: p.product_id,
      product_name: p.product_name,
      spec: p.spec || '',
      base_unit: p.base_unit || '瓶',
      current_base_qty: p.cur_base_qty || 0,
      previous_base_qty: p.prev_base_qty || 0,
      current_amount: round2(p.cur_amount),
      current_order_count: p.cur_order_count || 0,
      stopped_taking: (p.prev_base_qty > 0 && (p.cur_base_qty || 0) === 0)
    })),
    recent_orders: recentOrders.map(o => ({
      order_id: o.id,
      order_date: o.order_date,
      total_amount: round2(o.total_amount),
      returned_amount: round2(o.returned_amount),
      effective_debt: round2(Math.max(0, o.effective_debt))
    }))
  };
}

/**
 * 工具 3：单店 ShelfGuard 巡检记录与货架陈列分析
 */
async function queryCustomerShelfGuardInspections(db, { customerId, customerName = '', days = 90 } = {}) {
  const safeDays = clampDays(days, 90);
  let targetId = customerId ? Number(customerId) : null;
  let targetName = String(customerName || '').trim();

  if (targetId && !targetName) {
    const row = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(targetId);
    if (row) targetName = row.name;
  } else if (!targetId && targetName) {
    const row = db.prepare('SELECT id, name FROM customers WHERE name = ? OR name LIKE ? LIMIT 1').get(targetName, `%${targetName}%`);
    if (row) {
      targetId = row.id;
      targetName = row.name;
    }
  }

  const res = await fetchShelfGuardJson('/api/internal/customer-summary', {
    jxcCustomerId: targetId || '',
    storeName: targetName || '',
    days: safeDays
  });

  if (!res.ok) {
    return {
      connected: false,
      error: res.error,
      customer_id: targetId,
      customer_name: targetName
    };
  }

  return {
    connected: true,
    customer_id: targetId,
    customer_name: targetName,
    days: res.data.days,
    matched_shelfguard_customer: res.data.matchedCustomer,
    inspection_summary: res.data.summary,
    recent_inspections: res.data.recentInspections || []
  };
}

/**
 * 工具 4：全局经营概览、异常门店排行（销量下滑、高欠款低拜访）与业务员对比
 */
async function queryTenantOverviewAndAnomalies(db, { days = 30, includeShelfGuard = false } = {}) {
  const safeDays = clampDays(days, 30);
  const end = todayLocalDate();
  const start = shiftDateStr(end, -(safeDays - 1));
  const prevEnd = shiftDateStr(start, -1);
  const prevStart = shiftDateStr(prevEnd, -(safeDays - 1));

  const curSummary = getSummary(db, start, end);
  const prevSummary = getSummary(db, prevStart, prevEnd);
  const salesDiffPct = prevSummary.sales.amount > 0.001
    ? round1(((curSummary.sales.amount - prevSummary.sales.amount) / prevSummary.sales.amount) * 100)
    : null;

  const { definedTags, getTagsForCustomer } = loadCustomerTagMap(db);

  // 各门店本期、上期净销售额及当前应收欠款
  const storeRows = db.prepare(`
    SELECT
      c.id AS customer_id,
      c.name AS customer_name,
      c.operator_id AS operator_id,
      u.name AS operator_name,
      COALESCE((
        SELECT SUM(so.total_amount) FROM sales_orders so
        WHERE so.customer_id = c.id AND so.status = 'approved' AND so.order_date BETWEEN ? AND ?
      ), 0) - COALESCE((
        SELECT SUM(ro.total_amount) FROM return_orders ro
        WHERE ro.customer_id = c.id AND ro.status = 'approved' AND ro.order_date BETWEEN ? AND ?
      ), 0) AS cur_net_sales,
      COALESCE((
        SELECT SUM(so.total_amount) FROM sales_orders so
        WHERE so.customer_id = c.id AND so.status = 'approved' AND so.order_date BETWEEN ? AND ?
      ), 0) - COALESCE((
        SELECT SUM(ro.total_amount) FROM return_orders ro
        WHERE ro.customer_id = c.id AND ro.status = 'approved' AND ro.order_date BETWEEN ? AND ?
      ), 0) AS prev_net_sales,
      COALESCE((
        SELECT SUM(${EFFECTIVE_DEBT_EXPR}) FROM sales_orders so
        WHERE so.customer_id = c.id AND so.status = 'approved' AND ${EFFECTIVE_DEBT_EXPR} > 0.001
      ), 0) AS order_receivable
    FROM customers c
    LEFT JOIN users u ON u.id = c.operator_id
  `).all(start, end, start, end, prevStart, prevEnd, prevStart, prevEnd);

  let sgOverview = null;
  const sgByJxcId = new Map();
  const sgByName = new Map();

  if (includeShelfGuard) {
    const sgRes = await fetchShelfGuardJson('/api/internal/overview', { days: safeDays });
    if (sgRes.ok && sgRes.data) {
      sgOverview = sgRes.data;
      (sgOverview.storeStats || []).forEach(s => {
        if (s.jxcCustomerId != null) sgByJxcId.set(Number(s.jxcCustomerId), s);
        if (s.storeName) sgByName.set(s.storeName, s);
      });
    }
  }

  const enrichedStores = storeRows.map(r => {
    const curNet = round2(r.cur_net_sales);
    const prevNet = round2(r.prev_net_sales);
    const diffAmount = round2(curNet - prevNet);
    const diffPct = prevNet > 0.001 ? round1(((curNet - prevNet) / prevNet) * 100) : null;
    const totalDebt = round2(r.order_receivable);
    const sg = sgByJxcId.get(r.customer_id) || sgByName.get(r.customer_name) || null;
    const tags = getTagsForCustomer(r.customer_id);
    return {
      customer_id: r.customer_id,
      customer_name: r.customer_name,
      operator_id: r.operator_id || null,
      operator_name: r.operator_name || '未分配',
      tags: tags.length > 0 ? tags : ['无标签'],
      current_net_sales: curNet,
      previous_net_sales: prevNet,
      sales_diff_amount: diffAmount,
      sales_diff_pct: diffPct,
      total_receivable: totalDebt,
      visit_count: sg ? sg.visitCount : null,
      avg_shelf_score: sg ? sg.avgScore : null,
      avg_share_percent: sg ? sg.avgSharePercent : null
    };
  });

  const customerTagBreakdown = summarizeStoresByTag(enrichedStores, definedTags);

  const biggestSalesDrops = enrichedStores
    .filter(s => s.previous_net_sales > 0 && s.sales_diff_amount < 0)
    .sort((a, b) => a.sales_diff_amount - b.sales_diff_amount)
    .slice(0, 8);

  const highestDebtStores = enrichedStores
    .filter(s => s.total_receivable > 0.01)
    .sort((a, b) => b.total_receivable - a.total_receivable)
    .slice(0, 8);

  const topSalesStores = enrichedStores
    .filter(s => s.current_net_sales > 0)
    .sort((a, b) => b.current_net_sales - a.current_net_sales)
    .slice(0, 8);

  // 业务员对比（按客户归属或开单员汇总，同时统计每位业务员名下各标签客户数）
  const spRows = db.prepare(`
    SELECT
      u.id AS user_id,
      u.name AS user_name,
      (SELECT COUNT(*) FROM customers c WHERE c.operator_id = u.id) AS assigned_customer_count,
      COALESCE((
        SELECT SUM(so.total_amount) FROM sales_orders so
        LEFT JOIN customers c ON c.id = so.customer_id
        WHERE so.status = 'approved' AND so.order_date BETWEEN ? AND ?
          AND COALESCE(c.operator_id, so.user_id) = u.id
      ), 0) - COALESCE((
        SELECT SUM(ro.total_amount) FROM return_orders ro
        LEFT JOIN customers c ON c.id = ro.customer_id
        WHERE ro.status = 'approved' AND ro.order_date BETWEEN ? AND ?
          AND COALESCE(c.operator_id, ro.user_id) = u.id
      ), 0) AS net_sales,
      COALESCE((
        SELECT SUM(${EFFECTIVE_DEBT_EXPR}) FROM sales_orders so
        LEFT JOIN customers c ON c.id = so.customer_id
        WHERE so.status = 'approved' AND ${EFFECTIVE_DEBT_EXPR} > 0.001
          AND COALESCE(c.operator_id, so.user_id) = u.id
      ), 0) AS order_receivable
    FROM users u
    WHERE u.active = 1
    ORDER BY net_sales DESC
  `).all(start, end, start, end);

  const sgSpMap = new Map();
  if (sgOverview && Array.isArray(sgOverview.salespersonStats)) {
    sgOverview.salespersonStats.forEach(sp => {
      sgSpMap.set(sp.userName, sp);
    });
  }

  const salespersonComparison = spRows.map(sp => {
    const sgSp = sgSpMap.get(sp.user_name) || null;
    const spStores = enrichedStores.filter(s => s.operator_id === sp.user_id);
    const spTagStats = summarizeStoresByTag(spStores, definedTags);
    const customerCountByTag = {};
    const netSalesByTag = {};
    for (const item of spTagStats) {
      customerCountByTag[item.tag_name] = item.customer_count;
      netSalesByTag[item.tag_name] = item.net_sales_amount;
    }
    return {
      user_id: sp.user_id,
      user_name: sp.user_name,
      assigned_customer_count: sp.assigned_customer_count,
      customer_count_by_tag: customerCountByTag,
      net_sales_by_tag: netSalesByTag,
      net_sales_amount: round2(sp.net_sales),
      order_receivable: round2(sp.order_receivable),
      visit_count: sgSp ? sgSp.visitCount : null,
      avg_shelf_score: sgSp ? sgSp.avgScore : null
    };
  });

  // 如果存在未分配业务员的客户，也一并列出其各标签统计
  const unassignedStores = enrichedStores.filter(s => s.operator_id == null);
  if (unassignedStores.length > 0) {
    const uaTagStats = summarizeStoresByTag(unassignedStores, definedTags);
    const uaCountByTag = {};
    const uaSalesByTag = {};
    for (const item of uaTagStats) {
      uaCountByTag[item.tag_name] = item.customer_count;
      uaSalesByTag[item.tag_name] = item.net_sales_amount;
    }
    salespersonComparison.push({
      user_id: null,
      user_name: '未分配',
      assigned_customer_count: unassignedStores.length,
      customer_count_by_tag: uaCountByTag,
      net_sales_by_tag: uaSalesByTag,
      net_sales_amount: round2(unassignedStores.reduce((s, r) => s + r.current_net_sales, 0)),
      order_receivable: round2(unassignedStores.reduce((s, r) => s + r.total_receivable, 0)),
      visit_count: null,
      avg_shelf_score: null
    });
  }

  return {
    period: { days: safeDays, start, end, previous_start: prevStart, previous_end: prevEnd },
    company_jxc: {
      total_customer_count: enrichedStores.length,
      current_net_sales: round2(curSummary.sales.amount),
      previous_net_sales: round2(prevSummary.sales.amount),
      sales_diff_pct: salesDiffPct,
      current_order_count: curSummary.sales.count,
      current_return_amount: round2(curSummary.returnsAmount),
      gross_profit_with_receivable: round2(curSummary.profitWithReceivable),
      gross_profit_without_receivable: round2(curSummary.profitWithoutReceivable),
      period_receivable: round2(curSummary.receivable.amount)
    },
    customer_tag_breakdown: customerTagBreakdown,
    shelfguard_overview: sgOverview ? {
      connected: true,
      totals: sgOverview.totals,
      low_visit_threshold: sgOverview.lowVisitThreshold,
      lowest_score_stores: (sgOverview.lowestScoreStores || []).slice(0, 6)
    } : { connected: false },
    biggest_sales_drops: biggestSalesDrops,
    highest_debt_stores: highestDebtStores,
    top_sales_stores: topSalesStores,
    salesperson_comparison: salespersonComparison
  };
}

/**
 * 将工具返回结果提炼为前端结构化证据卡片
 */
function buildEvidenceCard(toolName, result) {
  if (!result) return null;
  if (toolName === 'get_customer_jxc_diagnosis' && result.found) {
    const tagStr = Array.isArray(result.customer.tags) && result.customer.tags.length > 0
      ? ` [${result.customer.tags.join('/')}]`
      : '';
    return {
      type: 'jxc_customer',
      title: `${result.customer.name}${tagStr} · 进销存账务摘要（近 ${result.period.days} 天）`,
      customerId: result.customer.id,
      customerName: result.customer.name,
      operatorName: result.customer.operator_name,
      tags: result.customer.tags || [],
      metrics: [
        {
          label: '本期净销售额',
          value: `¥${result.current_period.net_sales_amount.toFixed(2)}`,
          sub: result.sales_diff_pct != null
            ? `环比上期 ${result.sales_diff_pct >= 0 ? '+' : ''}${result.sales_diff_pct}%`
            : `上期 ¥${result.previous_period.net_sales_amount.toFixed(2)}`
        },
        {
          label: '本期毛利(含应收)',
          value: `¥${result.current_period.gross_profit_with_receivable.toFixed(2)}`,
          sub: result.current_period.margin_rate_pct != null ? `毛利率 ${result.current_period.margin_rate_pct}%` : '无有效销售额'
        },
        {
          label: '当前总应收欠款',
          value: `¥${result.debt.total_receivable.toFixed(2)}`,
          sub: `未结清 ${result.debt.unpaid_order_count} 单`
        },
        {
          label: '单据与退货',
          value: `${result.current_period.order_count} 笔销售`,
          sub: result.current_period.return_count > 0
            ? `退货 ${result.current_period.return_count} 笔 (¥${result.current_period.return_amount.toFixed(2)})`
            : '本期无退货'
        }
      ],
      links: [
        { label: '查看销售单', href: `/sales?customer_id=${result.customer.id}` },
        { label: '查看客户对账单', href: `/reconciliation/customers/${result.customer.id}` }
      ],
      stoppedProducts: (result.product_breakdown || []).filter(p => p.stopped_taking).map(p => p.product_name)
    };
  }

  if (toolName === 'get_customer_shelfguard_inspections' && result.connected) {
    const s = result.inspection_summary || {};
    return {
      type: 'shelfguard_customer',
      title: `${result.customer_name || '门店'} · ShelfGuard 巡检摘要（近 ${result.days} 天）`,
      customerId: result.customer_id || null,
      customerName: result.customer_name || '',
      metrics: [
        {
          label: '期间拜访次数',
          value: `${s.visitCount || 0} 次`,
          sub: s.lastVisitAt ? `最近：${String(s.lastVisitAt).slice(0, 10)}` : '近期无拜访记录'
        },
        {
          label: '平均陈列评分',
          value: s.avgScore != null ? `${s.avgScore} 分` : '暂无评分',
          sub: `已分析 ${s.scoredCount || 0} 次`
        },
        {
          label: '平均我方排面占比',
          value: s.avgSharePercent != null ? `${s.avgSharePercent}%` : '暂无数据',
          sub: (s.topIssues && s.topIssues[0]) ? `高频问题：${s.topIssues[0].issue}` : '无明显陈列问题'
        }
      ],
      photos: (result.recent_inspections || [])
        .filter(i => i.thumbnailURL)
        .slice(0, 4)
        .map(i => ({
          url: i.thumbnailURL,
          date: String(i.createdAt || '').slice(0, 10),
          score: i.score,
          userName: i.userName,
          summary: i.summary
        }))
    };
  }

  if (toolName === 'get_tenant_overview_and_anomalies' && result.company_jxc) {
    const c = result.company_jxc;
    const sg = result.shelfguard_overview;
    const metrics = [
      {
        label: '全店净销售额',
        value: `¥${c.current_net_sales.toFixed(2)}`,
        sub: c.sales_diff_pct != null ? `环比 ${c.sales_diff_pct >= 0 ? '+' : ''}${c.sales_diff_pct}%` : `共 ${c.current_order_count} 笔销售`
      },
      {
        label: '本期毛利(含应收)',
        value: `¥${c.gross_profit_with_receivable.toFixed(2)}`,
        sub: `已结清毛利 ¥${c.gross_profit_without_receivable.toFixed(2)}`
      },
      {
        label: '期间新增未结清应收',
        value: `¥${c.period_receivable.toFixed(2)}`,
        sub: `退货 ¥${c.current_return_amount.toFixed(2)}`
      }
    ];
    if (sg && sg.connected && sg.totals) {
      metrics.push({
        label: '终端巡检覆盖',
        value: `${sg.totals.visitedStoreCount} / ${sg.totals.activeCustomerCount} 家店`,
        sub: `共巡检 ${sg.totals.inspectionCount} 次 · 拜访不足 ${sg.totals.lowVisitStoreCount} 家`
      });
    }
    return {
      type: 'tenant_overview',
      title: `全局经营与巡检概览（${result.period.start} 至 ${result.period.end}）`,
      metrics,
      links: [
        { label: '打开经营报表', href: `/reports?start=${result.period.start}&end=${result.period.end}` },
        { label: '打开客户对账', href: '/reconciliation' }
      ]
    };
  }

  return null;
}

/**
 * 构建工具定义列表（根据租户是否开启 ShelfGuard 联动动态决定工具集）
 */
function buildToolDefinitions(enableShelfGuard) {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'search_customers',
        description: '按名称/联系人/地址、归属业务员（operatorName，如“周瑞娟”或“未分配”）、客户标签/类型（tagName，如“流通”、“餐饮”或“无标签”）搜索或统计门店客户。返回匹配客户总数（total_matched_customers）、按各客户标签分类的数量与销售额统计（matched_tag_breakdown）以及客户列表（含客户标签 tags、归属业务员、净销售额、应收欠款）。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '门店名称、联系人、电话或地址关键字（可选）' },
            operatorName: { type: 'string', description: '负责业务员姓名（如“周瑞娟”或“未分配”，可选）' },
            tagName: { type: 'string', description: '客户标签/类型名称（如“流通”、“餐饮”或“无标签”，可选）' },
            days: { type: 'integer', description: '统计天数，默认90天' },
            limit: { type: 'integer', description: '返回明细条数上限，默认20，最大50' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_customer_jxc_diagnosis',
        description: '查询指定门店（客户）的进销存详细经营数据，包括客户标签（如流通/餐饮）、归属业务员、本期与上期净销售额环比、毛利与毛利率、退货、当前总应收欠款、常拿商品明细（含是否停拿某品种）及最近订单。',
        parameters: {
          type: 'object',
          properties: {
            customerId: { type: 'integer', description: '客户ID（优先使用）' },
            customerName: { type: 'string', description: '客户名称（未知ID时可传名称）' },
            days: { type: 'integer', description: '统计天数，默认90天' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_tenant_overview_and_anomalies',
        description: '查询全公司经营概览、全公司按客户标签（如流通、餐饮、无标签）的客户数与销售额汇总（customer_tag_breakdown）、销量下滑最严重的门店排行、欠款最高的门店排行、销量最高的门店排行以及各业务员的业绩与名下各标签客户数量明细（salesperson_comparison[].customer_count_by_tag）。当管理员询问全局问题、各业务员有多少流通/餐饮客户、排行、业务员对比或异常门店时调用。',
        parameters: {
          type: 'object',
          properties: {
            days: { type: 'integer', description: '统计天数，默认30天' }
          }
        }
      }
    }
  ];

  if (enableShelfGuard) {
    tools.push({
      type: 'function',
      function: {
        name: 'get_customer_shelfguard_inspections',
        description: '查询指定门店在 ShelfGuard 巡检系统中的终端拜访次数、AI平均陈列评分、我方排面占比、高频陈列问题、货架识别到的商品以及最近巡检照片。诊断单店为何销量好或差时，应与 get_customer_jxc_diagnosis 配合调用。',
        parameters: {
          type: 'object',
          properties: {
            customerId: { type: 'integer', description: '进销存客户ID' },
            customerName: { type: 'string', description: '客户门店名称' },
            days: { type: 'integer', description: '查询天数，默认90天' }
          }
        }
      }
    });
  }

  return tools;
}

/**
 * 当未配置大模型 API Key 时，基于真实查询出的工具数据生成结构化保底诊断报告
 */
function buildRuleBasedFallbackAnswer({ cards, toolResults, enableShelfGuard }) {
  const lines = [];
  lines.push('> 💡 **提示**：当前尚未在服务器 `.env` 中配置 `DASHSCOPE_API_KEY`，以下为您自动提取的**真实业务数据规则诊断**（配置 Key 后即可启用通义千问深度自然语言归因）：');
  lines.push('');

  for (const item of toolResults) {
    if (item.name === 'get_customer_jxc_diagnosis' && item.result && item.result.found) {
      const r = item.result;
      lines.push(`### 📊 门店进销存诊断：${r.customer.name}（负责业务员：${r.customer.operator_name}）`);
      const diffText = r.sales_diff_pct != null ? `（环比上期 **${r.sales_diff_pct >= 0 ? '+' : ''}${r.sales_diff_pct}%**）` : '';
      lines.push(`- **销售表现（近 ${r.period.days} 天）**：本期净销售额 **¥${r.current_period.net_sales_amount.toFixed(2)}**${diffText}，共开单 **${r.current_period.order_count}** 笔；上期净销售额为 ¥${r.previous_period.net_sales_amount.toFixed(2)}。`);
      lines.push(`- **毛利水平**：本期含应收毛利 **¥${r.current_period.gross_profit_with_receivable.toFixed(2)}**${r.current_period.margin_rate_pct != null ? `（毛利率 **${r.current_period.margin_rate_pct}%**）` : ''}。`);
      lines.push(`- **回款与欠款风险**：当前累计未结清应收 **¥${r.debt.total_receivable.toFixed(2)}**（其中未结清订单 ${r.debt.unpaid_order_count} 笔，期初余额 ¥${r.debt.opening_balance.toFixed(2)}），最近一次拿货日期为 **${r.debt.last_order_date || '无记录'}**。`);
      const stopped = (r.product_breakdown || []).filter(p => p.stopped_taking);
      if (stopped.length > 0) {
        lines.push(`- **⚠️ 断拿/停拿商品预警**：该店上期曾拿货、但本期拿货量为 0 的品种有：**${stopped.map(p => p.product_name).join('、')}**，建议核实是否被竞品替代或终端断货。`);
      } else if ((r.product_breakdown || []).length > 0) {
        const topNames = r.product_breakdown.slice(0, 4).map(p => `${p.product_name}(${p.current_base_qty}${p.base_unit})`).join('、');
        lines.push(`- **主力拿货品种**：${topNames}。`);
      }
      lines.push('');
    }

    if (item.name === 'get_customer_shelfguard_inspections' && item.result) {
      const sg = item.result;
      if (!sg.connected) {
        lines.push(`### 📸 终端巡检情况`);
        lines.push(`- 暂未获取到巡检数据：${sg.error}`);
      } else {
        const s = sg.inspection_summary || {};
        lines.push(`### 📸 终端巡检与陈列诊断（近 ${sg.days} 天）`);
        lines.push(`- **拜访频次**：共巡检拜访 **${s.visitCount || 0}** 次（最后拜访：${s.lastVisitAt ? String(s.lastVisitAt).slice(0, 10) : '无'}）。`);
        lines.push(`- **陈列质量**：AI 平均陈列评分 **${s.avgScore != null ? s.avgScore + ' 分' : '暂无'}**，我方排面占比 **${s.avgSharePercent != null ? s.avgSharePercent + '%' : '暂无'}**。`);
        if (s.topIssues && s.topIssues.length > 0) {
          lines.push(`- **主要陈列问题**：${s.topIssues.map(i => `${i.issue}(${i.count}次)`).join('；')}。`);
        }
      }
      lines.push('');
    }

    if (item.name === 'get_tenant_overview_and_anomalies' && item.result && item.result.company_jxc) {
      const ov = item.result;
      const c = ov.company_jxc;
      lines.push(`### 🏢 全局经营概览（${ov.period.start} 至 ${ov.period.end}）`);
      lines.push(`- **公司净销售额**：**¥${c.current_net_sales.toFixed(2)}**${c.sales_diff_pct != null ? `（环比 **${c.sales_diff_pct >= 0 ? '+' : ''}${c.sales_diff_pct}%**）` : ''}，含应收毛利 **¥${c.gross_profit_with_receivable.toFixed(2)}**。`);
      if (ov.biggest_sales_drops && ov.biggest_sales_drops.length > 0) {
        lines.push(`- **📉 销量下滑最明显的门店**：`);
        ov.biggest_sales_drops.slice(0, 5).forEach(s => {
          const sgInfo = s.visit_count != null ? ` | 巡检 ${s.visit_count} 次 / 陈列分 ${s.avg_shelf_score ?? '无'}` : '';
          lines.push(`  1. **${s.customer_name}**（${s.operator_name}）：本期 ¥${s.current_net_sales.toFixed(2)} vs 上期 ¥${s.previous_net_sales.toFixed(2)}（**${s.sales_diff_pct}%**），欠款 ¥${s.total_receivable.toFixed(2)}${sgInfo}`);
        });
      }
      if (ov.highest_debt_stores && ov.highest_debt_stores.length > 0) {
        lines.push(`- **⚠️ 当前应收欠款最高的门店**：`);
        ov.highest_debt_stores.slice(0, 5).forEach(s => {
          const sgInfo = s.visit_count != null ? ` | 近 ${ov.period.days} 天拜访 ${s.visit_count} 次` : '';
          lines.push(`  1. **${s.customer_name}**（${s.operator_name}）：总欠款 **¥${s.total_receivable.toFixed(2)}**，本期净销 ¥${s.current_net_sales.toFixed(2)}${sgInfo}`);
        });
      }
      if (ov.customer_tag_breakdown && ov.customer_tag_breakdown.length > 0) {
        const tagSummaryText = ov.customer_tag_breakdown
          .map(t => `${t.tag_name} **${t.customer_count}** 家（净销 ¥${t.net_sales_amount.toFixed(2)}）`)
          .join('；');
        lines.push(`- **🏷️ 客户标签分布**：${tagSummaryText}。`);
      }
      if (ov.salesperson_comparison && ov.salesperson_comparison.length > 0) {
        lines.push(`- **👤 业务员业绩对比**：`);
        ov.salesperson_comparison.slice(0, 8).forEach(sp => {
          const sgInfo = sp.visit_count != null ? ` | 巡检 ${sp.visit_count} 次（均分 ${sp.avg_shelf_score ?? '无'}）` : '';
          const tagBreakdownText = sp.customer_count_by_tag
            ? Object.entries(sp.customer_count_by_tag)
                .filter(([, cnt]) => cnt > 0)
                .map(([k, cnt]) => `${k}${cnt}家`)
                .join('、')
            : '';
          const tagSuffix = tagBreakdownText ? `（${tagBreakdownText}）` : '';
          lines.push(`  - **${sp.user_name}**：负责 ${sp.assigned_customer_count} 店${tagSuffix}，本期净销 **¥${sp.net_sales_amount.toFixed(2)}**，名下未结清应收 ¥${sp.order_receivable.toFixed(2)}${sgInfo}`);
        });
      }
    }
  }

  return lines.join('\n');
}

/**
 * 执行一次完整的经营诊断对话（支持回调 onStatus 实时推送进度）
 */
async function runDiagnosticChat({
  db,
  tenant,
  userMessage,
  history = [],
  selectedCustomerId = null,
  days = 90,
  onStatus = () => {}
}) {
  const enableShelfGuard = Boolean(tenant && tenant.ai_enabled && tenant.ai_shelfguard_enabled);
  const safeDays = clampDays(days, 90);
  const evidenceCards = [];
  const toolResults = [];

  function pushUniqueCard(card) {
    if (!card) return;
    const key = `${card.type}:${card.customerId || card.title || ''}`;
    const existingIdx = evidenceCards.findIndex(c => `${c.type}:${c.customerId || c.title || ''}` === key);
    if (existingIdx >= 0) {
      evidenceCards[existingIdx] = card;
    } else {
      evidenceCards.push(card);
    }
  }

  async function executeTool(name, args = {}) {
    const mergedDays = args.days ? clampDays(args.days, safeDays) : safeDays;
    if (name === 'search_customers') {
      onStatus('正在检索进销存客户档案与标签分类…');
      return querySearchCustomers(db, {
        keyword: args.keyword,
        operatorName: args.operatorName,
        tagName: args.tagName,
        days: mergedDays,
        limit: args.limit
      });
    }
    if (name === 'get_customer_jxc_diagnosis') {
      onStatus('正在查询门店进销存销售、毛利与应收账务…');
      const res = queryCustomerJxcDiagnosis(db, {
        customerId: args.customerId || selectedCustomerId,
        customerName: args.customerName,
        days: mergedDays
      });
      pushUniqueCard(buildEvidenceCard(name, res));
      return res;
    }
    if (name === 'get_customer_shelfguard_inspections') {
      if (!enableShelfGuard) {
        return { connected: false, error: '当前租户未开启 ShelfGuard 巡检数据关联' };
      }
      onStatus('正在拉取 ShelfGuard 终端巡检记录与货架评分…');
      const res = await queryCustomerShelfGuardInspections(db, {
        customerId: args.customerId || selectedCustomerId,
        customerName: args.customerName,
        days: mergedDays
      });
      pushUniqueCard(buildEvidenceCard(name, res));
      return res;
    }
    if (name === 'get_tenant_overview_and_anomalies') {
      onStatus(enableShelfGuard ? '正在联合扫描全盘进销存账务与 ShelfGuard 巡检数据…' : '正在扫描全盘进销存经营与异常门店数据…');
      const res = await queryTenantOverviewAndAnomalies(db, {
        days: mergedDays,
        includeShelfGuard: enableShelfGuard
      });
      pushUniqueCard(buildEvidenceCard(name, res));
      return res;
    }
    return { error: `未知工具: ${name}` };
  }

  const llm = llmConfig();

  // 如果管理员在界面上选中了某家门店，或者未配置大模型 Key，预先把最核心的数据查出来，
  // 既减少一次大模型往返等待，也确保证据卡片 100% 稳定展示。
  if (selectedCustomerId && Number(selectedCustomerId) > 0) {
    const jxcDiag = await executeTool('get_customer_jxc_diagnosis', { customerId: Number(selectedCustomerId), days: safeDays });
    toolResults.push({ name: 'get_customer_jxc_diagnosis', result: jxcDiag });
    if (enableShelfGuard && jxcDiag && jxcDiag.found) {
      const sgDiag = await executeTool('get_customer_shelfguard_inspections', {
        customerId: jxcDiag.customer.id,
        customerName: jxcDiag.customer.name,
        days: safeDays
      });
      toolResults.push({ name: 'get_customer_shelfguard_inspections', result: sgDiag });
    }
  } else if (!llm.configured) {
    const ov = await executeTool('get_tenant_overview_and_anomalies', { days: safeDays });
    toolResults.push({ name: 'get_tenant_overview_and_anomalies', result: ov });
  }

  if (!llm.configured) {
    const answer = buildRuleBasedFallbackAnswer({
      cards: evidenceCards,
      toolResults,
      enableShelfGuard
    });
    return { answer, cards: evidenceCards };
  }

  const systemPrompt = [
    `你是「鸭鸭进销存」与「ShelfGuard 终端巡检」联合经营诊断专家助手，仅面向租户管理员（${tenant.name}）提供深度分析。`,
    `今天日期是 ${todayLocalDate()}，当前管理员默认选定的分析时间跨度为近 ${safeDays} 天。`,
    '系统已内置完整的客户标签体系（如“流通”、“餐饮”以及未打标签的“无标签”客户），以及客户归属业务员关系。当管理员询问某业务员名下或全公司有多少流通客户、餐饮客户或按标签分类统计时，请直接调用 search_customers（传入 operatorName / tagName）或 get_tenant_overview_and_anomalies 获取精确的标签分类统计。',
    enableShelfGuard
      ? '当前租户已开启【进销存 + ShelfGuard 终端巡检】双数据源联动。分析门店为何销量好或差时，请同时结合进销存（销售额环比、毛利、停拿品种、应收欠款）与巡检（拜访频次、AI陈列评分、我方排面占比、具体陈列问题）给出有理有据的归因。'
      : '当前租户仅开启【进销存】数据源。请围绕销售额环比、毛利、商品动销结构与应收回款进行诊断。',
    '核心铁律：',
    '1. 严禁编造任何数字！所有金额、比例、单数、拜访次数、陈列评分必须 100% 来自工具返回的结果。',
    '2. 当字段值为 null 时，代表该项数据未采集或无基数（如上期销售额为0导致环比null，或近期无巡检评分），必须如实说明“暂无数据/无历史基数”，绝不能当成 0。',
    '3. 相关不等于绝对因果：请将结论表述为“数据体现出的核心现象 -> 高度疑似原因 -> 建议安排业务员核实的具体动作”。',
    '4. 排版清晰：使用简明的小标题、加粗关键指标和要点列表，方便管理员在手机或电脑上快速阅读并转发给业务员。'
  ].join('\n');

  const messages = [{ role: 'system', content: systemPrompt }];

  // 注入最近 6 条历史对话上下文
  const safeHistory = Array.isArray(history) ? history.slice(-6) : [];
  safeHistory.forEach(h => {
    if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
      messages.push({ role: h.role, content: h.content.slice(0, 3000) });
    }
  });

  let userContent = String(userMessage || '').trim();
  if (toolResults.length > 0) {
    const preloadedContext = toolResults.map(t => `【系统已预加载 ${t.name} 数据】：\n${JSON.stringify(t.result)}`).join('\n\n');
    userContent = `${userContent}\n\n${preloadedContext}`;
  }
  messages.push({ role: 'user', content: userContent });

  const tools = buildToolDefinitions(enableShelfGuard);

  for (let round = 0; round < 4; round++) {
    onStatus(round === 0 ? '正在思考并分析经营数据…' : '正在结合工具数据生成诊断报告…');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let respJson;
    try {
      const resp = await fetch(`${llm.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${llm.apiKey}`
        },
        body: JSON.stringify({
          model: llm.model,
          messages,
          tools,
          tool_choice: 'auto',
          temperature: 0.2
        }),
        signal: controller.signal
      });
      respJson = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const errMsg = (respJson && respJson.error && respJson.error.message) || `大模型接口返回 HTTP ${resp.status}`;
        throw new Error(errMsg);
      }
    } catch (err) {
      clearTimeout(timer);
      if (toolResults.length === 0) {
        const ov = await executeTool('get_tenant_overview_and_anomalies', { days: safeDays });
        toolResults.push({ name: 'get_tenant_overview_and_anomalies', result: ov });
      }
      const fallback = buildRuleBasedFallbackAnswer({ cards: evidenceCards, toolResults, enableShelfGuard });
      return {
        answer: `> ⚠️ 调用大模型接口遇到问题（${err.message}），已为您切换为本地规则诊断：\n\n${fallback}`,
        cards: evidenceCards
      };
    } finally {
      clearTimeout(timer);
    }

    const choice = respJson.choices && respJson.choices[0];
    const msg = choice && choice.message;
    if (!msg) {
      break;
    }

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        const fnName = tc.function && tc.function.name;
        let fnArgs = {};
        try {
          fnArgs = JSON.parse((tc.function && tc.function.arguments) || '{}');
        } catch (_) {}
        const result = await executeTool(fnName, fnArgs);
        toolResults.push({ name: fnName, result });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(result)
        });
      }
      continue;
    }

    return {
      answer: String(msg.content || '').trim() || '已完成分析，请查看上方数据卡片。',
      cards: evidenceCards
    };
  }

  return {
    answer: buildRuleBasedFallbackAnswer({ cards: evidenceCards, toolResults, enableShelfGuard }),
    cards: evidenceCards
  };
}

const CHAT_RETENTION_DAYS = 30;
const MAX_SESSIONS_PER_USER = 100;

/**
 * 自动清理超过 30 天未更新的历史对话（外键 ON DELETE CASCADE 自动级联删除消息）
 */
function cleanupExpiredChatSessions(db) {
  try {
    db.prepare(`DELETE FROM ai_chat_sessions WHERE updated_at < datetime('now', '-${CHAT_RETENTION_DAYS} days')`).run();
  } catch (_) {}
}

function buildSessionTitle(db, customerId, userMessage) {
  const cleanMsg = String(userMessage || '')
    .replace(/^[🔍📦💰📸📉⚠️🏆📊✨\s]+/u, '')
    .trim();
  const shortMsg = Array.from(cleanMsg).slice(0, 26).join('') + (Array.from(cleanMsg).length > 26 ? '…' : '');
  if (customerId && Number(customerId) > 0) {
    try {
      const row = db.prepare('SELECT name FROM customers WHERE id = ?').get(Number(customerId));
      if (row && row.name && !shortMsg.includes(row.name)) {
        return `${row.name} · ${shortMsg || '门店诊断'}`;
      }
    } catch (_) {}
  }
  return shortMsg || '经营诊断对话';
}

/**
 * 列出指定管理员（user_id）在 30 天有效期内的历史对话列表
 */
function listUserChatSessions(db, userId, { limit = 50 } = {}) {
  if (!userId) return [];
  cleanupExpiredChatSessions(db);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const rows = db.prepare(`
    SELECT
      s.id,
      s.user_id,
      s.title,
      s.customer_id,
      c.name AS customer_name,
      s.days,
      s.created_at,
      s.updated_at,
      (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count
    FROM ai_chat_sessions s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.user_id = ?
      AND s.updated_at >= datetime('now', '-${CHAT_RETENTION_DAYS} days')
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT ?
  `).all(Number(userId), safeLimit);

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    customerId: r.customer_id || null,
    customerName: r.customer_name || null,
    days: r.days || 90,
    messageCount: r.message_count || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

/**
 * 获取指定管理员的单条会话及完整消息列表（跨账号访问严格返回 null）
 */
function getUserChatSessionWithMessages(db, userId, sessionId) {
  if (!userId || !sessionId) return null;
  cleanupExpiredChatSessions(db);
  const s = db.prepare(`
    SELECT
      s.id,
      s.user_id,
      s.title,
      s.customer_id,
      c.name AS customer_name,
      s.days,
      s.created_at,
      s.updated_at
    FROM ai_chat_sessions s
    LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.id = ?
      AND s.user_id = ?
      AND s.updated_at >= datetime('now', '-${CHAT_RETENTION_DAYS} days')
  `).get(Number(sessionId), Number(userId));

  if (!s) return null;

  const msgRows = db.prepare(`
    SELECT id, role, content, cards_json, created_at
    FROM ai_chat_messages
    WHERE session_id = ?
    ORDER BY id ASC
  `).all(s.id);

  const messages = msgRows.map(m => {
    let cards = [];
    if (m.cards_json) {
      try {
        const parsed = JSON.parse(m.cards_json);
        if (Array.isArray(parsed)) cards = parsed;
      } catch (_) {}
    }
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      cards,
      createdAt: m.created_at
    };
  });

  return {
    id: s.id,
    title: s.title,
    customerId: s.customer_id || null,
    customerName: s.customer_name || null,
    days: s.days || 90,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    messages
  };
}

/**
 * 保存一轮问答到当前管理员的会话中（若无有效 sessionId 则自动新建会话）
 */
function saveDiagnosticTurn(db, {
  userId,
  sessionId = null,
  customerId = null,
  days = 90,
  userMessage,
  assistantAnswer,
  cards = []
}) {
  if (!userId) return { sessionId: null, session: null };
  cleanupExpiredChatSessions(db);

  const safeDays = clampDays(days, 90);
  const cleanCustId = customerId && Number.isInteger(Number(customerId)) && Number(customerId) > 0
    ? Number(customerId)
    : null;
  const cardsJson = JSON.stringify(Array.isArray(cards) ? cards : []);

  const tx = db.transaction(() => {
    let targetSessionId = null;
    if (sessionId && Number.isInteger(Number(sessionId)) && Number(sessionId) > 0) {
      const existing = db.prepare(`
        SELECT id FROM ai_chat_sessions
        WHERE id = ? AND user_id = ?
      `).get(Number(sessionId), Number(userId));
      if (existing) targetSessionId = existing.id;
    }

    if (!targetSessionId) {
      const title = buildSessionTitle(db, cleanCustId, userMessage);
      const info = db.prepare(`
        INSERT INTO ai_chat_sessions (user_id, title, customer_id, days, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(Number(userId), title, cleanCustId, safeDays);
      targetSessionId = Number(info.lastInsertRowid);

      // 单账号最多保留最近 MAX_SESSIONS_PER_USER 条会话
      db.prepare(`
        DELETE FROM ai_chat_sessions
        WHERE user_id = ?
          AND id NOT IN (
            SELECT id FROM ai_chat_sessions
            WHERE user_id = ?
            ORDER BY updated_at DESC, id DESC
            LIMIT ?
          )
      `).run(Number(userId), Number(userId), MAX_SESSIONS_PER_USER);
    } else {
      db.prepare(`
        UPDATE ai_chat_sessions
        SET updated_at = datetime('now'),
            customer_id = COALESCE(?, customer_id),
            days = ?
        WHERE id = ? AND user_id = ?
      `).run(cleanCustId, safeDays, targetSessionId, Number(userId));
    }

    const insertMsg = db.prepare(`
      INSERT INTO ai_chat_messages (session_id, role, content, cards_json, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `);
    insertMsg.run(targetSessionId, 'user', String(userMessage || ''), '[]');
    insertMsg.run(targetSessionId, 'assistant', String(assistantAnswer || ''), cardsJson);

    return targetSessionId;
  });

  const finalId = tx();
  return {
    sessionId: finalId,
    session: getUserChatSessionWithMessages(db, userId, finalId)
  };
}

/**
 * 删除当前管理员名下的单条历史会话
 */
function deleteUserChatSession(db, userId, sessionId) {
  if (!userId || !sessionId) return false;
  cleanupExpiredChatSessions(db);
  const info = db.prepare('DELETE FROM ai_chat_sessions WHERE id = ? AND user_id = ?')
    .run(Number(sessionId), Number(userId));
  return info.changes > 0;
}

/**
 * 清空当前管理员名下的全部历史会话
 */
function clearUserChatSessions(db, userId) {
  if (!userId) return 0;
  const info = db.prepare('DELETE FROM ai_chat_sessions WHERE user_id = ?').run(Number(userId));
  return info.changes;
}

module.exports = {
  runDiagnosticChat,
  querySearchCustomers,
  queryCustomerJxcDiagnosis,
  queryCustomerShelfGuardInspections,
  queryTenantOverviewAndAnomalies,
  cleanupExpiredChatSessions,
  listUserChatSessions,
  getUserChatSessionWithMessages,
  saveDiagnosticTurn,
  deleteUserChatSession,
  clearUserChatSessions,
  CHAT_RETENTION_DAYS,
  shelfguardConfig,
  llmConfig
};
