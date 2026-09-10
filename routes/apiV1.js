/**
 * API v1 —— 超管专属 REST API（供 n8n / Codex 等自动化工具调用）
 *
 * 与 Web 登录体系完全分开：API Key 认证（middleware/apiAuth.js），无 session。
 * 当前只开放"只读"档位端点；读+写、最大权限的端点未来按需添加，
 * 权限框架（requireApiTier）已就位，新增端点声明所需最低档位即可。
 *
 * 数据隔离：每个租户一个独立 SQLite 文件，req.tenantDb 由 apiAuth 根据 Key 归属挂载，
 * 所有查询只走它——请求参数里传任何租户标识都会被直接忽略。
 *
 * 统一响应约定：
 *   成功：直接返回业务 JSON 对象（金额一律保留 2 位小数）
 *   失败：{ error: { code, message } }，配合对应 HTTP 状态码
 *   400 invalid_param / 401 认证失败 / 403 forbidden / 404 not_found / 429 rate_limited / 500 internal
 */

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { apiAuth, requireApiTier } = require('../middleware/apiAuth');
const { todayLocalDate } = require('../utils/dates');
const { returnedAmountSubquery } = require('../lib/profitCalc');
const reportRoutes = require('./report');
const salesRoutes = require('./sales');
const inventoryRoutes = require('./inventory');

const router = express.Router();

// 限流阈值走环境变量不写死：API_RATE_LIMIT_PER_MIN，默认每分钟 60 次（宽松起步值，
// 后续按 n8n/Codex 实际用量调整，改 .env 即可，不用动代码）
const API_RATE_LIMIT_PER_MIN = Math.max(1, Number(process.env.API_RATE_LIMIT_PER_MIN) || 60);

// 按 api_key 维度限流（不按 IP）：n8n/Codex 的调用来源可能都是同一台服务器的固定 IP，
// 按 IP 限流会把所有自动化任务锁进同一个桶互相误伤。
// 本中间件挂在 apiAuth 之后，走到这里必然已有 req.apiKey（未认证的请求在 401 就被拦了）。
const apiKeyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: API_RATE_LIMIT_PER_MIN,
  standardHeaders: 'draft-6', // 响应带 RateLimit-* 头，方便调用方自我节流
  legacyHeaders: false,
  keyGenerator: (req) => `apikey:${req.apiKey.id}`,
  handler: (req, res) => {
    console.warn(`[api-v1] 触发限流 key_prefix=${req.apiKey.keyPrefix} path=${req.originalUrl} ip=${req.ip}`);
    res.status(429).json({
      error: { code: 'rate_limited', message: `请求过于频繁（该 Key 每分钟最多 ${API_RATE_LIMIT_PER_MIN} 次），请稍后重试` }
    });
  }
});

// 口径唯一实现点：退货金额子查询与 Web 端共用 lib/profitCalc.js 的同一份定义
const RETURNED_AMOUNT_SUBQUERY = returnedAmountSubquery('so');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SALES_STATUSES = ['draft', 'submitted', 'approved', 'rejected'];
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

// ---- 所有 /api/v1 请求先过 API Key 认证，再按 Key 维度限流 ----
router.use(apiAuth);
router.use(apiKeyLimiter);

// ---- 参数校验/响应工具 ----

function badRequest(res, message) {
  return res.status(400).json({ error: { code: 'invalid_param', message } });
}

/** 金额统一保留 2 位小数，避免浮点尾巴流到调用方（n8n 表达式里比较金额时才不会踩 0.30000000000000004） */
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/** 校验可选的 YYYY-MM-DD 日期参数；合法返回规整值，非法返回 null */
function parseDateParam(value) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const v = String(value).trim();
  return DATE_RE.test(v) ? v : null;
}

// ---- 报表：当日汇总 ----
// 复用经营报表页（routes/report.js）的 getSummary，销售额/应收/毛利口径与页面完全一致
router.get('/reports/summary', requireApiTier('read_only'), (req, res) => {
  const date = parseDateParam(req.query.date);
  if (date === null) return badRequest(res, 'date 参数格式错误，应为 YYYY-MM-DD（或不传，默认今天）');
  const d = date || todayLocalDate();

  const s = reportRoutes.getSummary(req.tenantDb, d, d);
  res.json({
    date: d,
    sales: { amount: r2(s.sales.amount), count: s.sales.count, return_count: s.sales.returnCount },
    returns_amount: r2(s.returnsAmount),
    receivable: { amount: r2(s.receivable.amount), count: s.receivable.count },
    profit: {
      without_receivable: r2(s.profitWithoutReceivable),
      with_receivable: r2(s.profitWithReceivable),
      receivable_profit: r2(s.receivableProfit)
    }
  });
});

// ---- 报表：团队业绩排行（销售龙虎榜数据源）----
// 口径：按录单人（sales_orders.user_id）统计当日已审核销售单，减去同一口径的已审核退货单。
// 排名按净销售额（销售额 − 退货额）降序，并列时按销售额高者在前。
router.get('/reports/leaderboard', requireApiTier('read_only'), (req, res) => {
  const date = parseDateParam(req.query.date);
  if (date === null) return badRequest(res, 'date 参数格式错误，应为 YYYY-MM-DD（或不传，默认今天）');
  const d = date || todayLocalDate();

  const salesRows = req.tenantDb.prepare(`
    SELECT u.id AS user_id, u.name AS user_name, COUNT(so.id) AS order_count,
           COALESCE(SUM(so.total_amount), 0) AS sales_amount
    FROM sales_orders so
    JOIN users u ON u.id = so.user_id
    WHERE so.order_date = ? AND so.status = 'approved'
    GROUP BY u.id, u.name
  `).all(d);

  const returnRows = req.tenantDb.prepare(`
    SELECT u.id AS user_id, COUNT(ro.id) AS return_count,
           COALESCE(SUM(ro.total_amount), 0) AS returns_amount
    FROM return_orders ro
    JOIN users u ON u.id = ro.user_id
    WHERE ro.order_date = ? AND ro.status = 'approved'
    GROUP BY u.id
  `).all(d);

  const byUser = new Map();
  for (const row of salesRows) {
    byUser.set(row.user_id, {
      user_id: row.user_id, user_name: row.user_name,
      order_count: row.order_count, sales_amount: row.sales_amount,
      return_count: 0, returns_amount: 0
    });
  }
  for (const row of returnRows) {
    const rec = byUser.get(row.user_id);
    if (rec) { rec.return_count = row.return_count; rec.returns_amount = row.returns_amount; }
  }

  const rows = [...byUser.values()]
    .map(r => ({
      user_id: r.user_id, user_name: r.user_name,
      order_count: r.order_count, return_count: r.return_count,
      sales_amount: r2(r.sales_amount), returns_amount: r2(r.returns_amount),
      net_amount: r2(r.sales_amount - r.returns_amount)
    }))
    .sort((a, b) => b.net_amount - a.net_amount || b.sales_amount - a.sales_amount || a.user_id - b.user_id)
    .map((r, i) => ({ rank: i + 1, ...r }));

  res.json({ date: d, rows });
});

// ---- 欠款趋势：按日期范围查每日快照，含全公司汇总 + 分操作员 ----
// 数据来源：lib/debtSnapshot.js 每天写入的 debt_snapshots 表（口径与报表页"应收账款"一致）。
// 快照是"当天营业结束时的欠款水位"，一天一行；date 端点没跑到当天就没有当天数据（空档，
// 不补算），调用方按返回的 date 序列画趋势即可。user_id=NULL 的行是全公司汇总，
// 排序上 NULL 在前，天然排在每个日期的第一条。
router.get('/reports/debt-trend', requireApiTier('read_only'), (req, res) => {
  const start = parseDateParam(req.query.start);
  const end = parseDateParam(req.query.end);
  if (start === null) return badRequest(res, 'start 参数格式错误，应为 YYYY-MM-DD');
  if (end === null) return badRequest(res, 'end 参数格式错误，应为 YYYY-MM-DD');

  // start/end 都可省略 = 查全部历史。'0000-00-00' / '9999-99-99' 是 YYYY-MM-DD 文本比较
  // 的安全哨兵值（快照日期恒为合法日期，字符串比较语义等价于日期比较）
  const rows = req.tenantDb.prepare(`
    SELECT ds.snapshot_date, ds.user_id, u.name AS user_name,
           ds.total_debt, ds.debtor_customer_count
    FROM debt_snapshots ds
    LEFT JOIN users u ON u.id = ds.user_id
    WHERE ds.snapshot_date >= ? AND ds.snapshot_date <= ?
    ORDER BY ds.snapshot_date ASC, ds.user_id ASC
  `).all(start || '0000-00-00', end || '9999-99-99');

  res.json({
    items: rows.map(r => ({
      date: r.snapshot_date,
      user_id: r.user_id,
      user_name: r.user_name || '全公司',
      total_debt: r2(r.total_debt),
      debtor_customer_count: r.debtor_customer_count
    }))
  });
});

// ---- 销售单列表（分页）----
// 收款/欠款状态复用销售列表页的 attachEffectivePayment（有效欠款口径），不重写第二份算法。
// 分页在 SQL 层做（LIMIT/OFFSET），page 超出范围时返回空 items（调用方以 total/total_pages 为准）。
router.get('/sales', requireApiTier('read_only'), (req, res) => {
  const start = parseDateParam(req.query.start);
  const end = parseDateParam(req.query.end);
  if (start === null) return badRequest(res, 'start 参数格式错误，应为 YYYY-MM-DD');
  if (end === null) return badRequest(res, 'end 参数格式错误，应为 YYYY-MM-DD');

  const status = req.query.status;
  if (status !== undefined && String(status).trim() !== '' && !SALES_STATUSES.includes(status)) {
    return badRequest(res, `status 参数不合法，可选值：${SALES_STATUSES.join(' / ')}`);
  }

  const page = req.query.page === undefined || String(req.query.page).trim() === ''
    ? 1 : Number(req.query.page);
  if (!Number.isInteger(page) || page < 1) return badRequest(res, 'page 参数不合法，应为大于等于 1 的整数');

  const pageSize = req.query.pageSize === undefined || String(req.query.pageSize).trim() === ''
    ? PAGE_SIZE_DEFAULT : Number(req.query.pageSize);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) {
    return badRequest(res, `pageSize 参数不合法，应为 1 ~ ${PAGE_SIZE_MAX} 的整数`);
  }

  let where = ' WHERE 1=1';
  const params = [];
  if (status && String(status).trim() !== '') { where += ' AND so.status = ?'; params.push(status); }
  if (start) { where += ' AND so.order_date >= ?'; params.push(start); }
  if (end) { where += ' AND so.order_date <= ?'; params.push(end); }

  const total = req.tenantDb.prepare(`SELECT COUNT(*) AS c FROM sales_orders so${where}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const rows = req.tenantDb.prepare(`
    SELECT so.id, so.order_date, so.status, so.total_amount, so.paid_amount, so.created_at,
           c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name,
           ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    LEFT JOIN users u ON u.id = so.user_id
    ${where}
    ORDER BY so.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  // 按需裁剪字段：不输出 customer_id / warehouse_id / user_id / note / remarks 等内部字段
  const items = rows.map(o => {
    salesRoutes.attachEffectivePayment(o);
    return {
      id: o.id,
      order_date: o.order_date,
      status: o.status,
      customer_name: o.customer_name || '散客',
      warehouse_name: o.warehouse_name,
      user_name: o.user_name,
      total_amount: r2(o.total_amount),
      paid_amount: r2(o.paid_amount),
      returned_amount: r2(o.returned_amount),
      effective_debt: r2(o.effective_debt),
      effective_status: o.effective_status,
      created_at: o.created_at
    };
  });

  res.json({
    page, page_size: pageSize, total, total_pages: totalPages,
    filters: { start: start || null, end: end || null, status: status || null },
    items
  });
});

// ---- 库存快照 ----
// 与库存页面共用 queryInventorySnapshot 同一份 SQL；可选 warehouse_id 过滤
router.get('/inventory', requireApiTier('read_only'), (req, res) => {
  let warehouseId = null;
  if (req.query.warehouse_id !== undefined && String(req.query.warehouse_id).trim() !== '') {
    warehouseId = Number(req.query.warehouse_id);
    if (!Number.isInteger(warehouseId) || warehouseId < 1) {
      return badRequest(res, 'warehouse_id 参数不合法，应为正整数');
    }
  }

  const rows = inventoryRoutes.queryInventorySnapshot(req.tenantDb, warehouseId);
  const items = rows.map(r => ({
    product_id: r.product_id,
    sku: r.sku,
    name: r.name,
    spec: r.spec,
    unit: r.unit,
    pack_unit: r.pack_unit,
    pack_size: r.pack_size,
    low_stock_threshold: r.low_stock_threshold,
    warehouse_id: r.warehouse_id,
    warehouse_name: r.warehouse_name,
    quantity: r.quantity
  }));
  res.json({ count: items.length, items });
});

// ---- 写操作占位（未实现，专用于验证权限拦截层）----
// 本次只交付只读端点；此占位声明需要 read_write 档位：
//   - read_only 的 Key 打过来会被 requireApiTier 拦成 403（权限框架工作的直接证据）
//   - 更高档位的 Key 会拿到 501（说明档位放行正常，只是端点还没实现）
// 未来真正实现写接口时，删掉这个占位、按业务写实现即可。
router.post('/sales', requireApiTier('read_write'), (req, res) => {
  res.status(501).json({
    error: { code: 'not_implemented', message: '写接口尚未实现：当前版本仅开放只读查询端点' }
  });
});

// ---- 未匹配的 API 路径：返回 JSON 404，不要落进全站 HTML 404 页 ----
router.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `API 端点不存在: ${req.method} ${req.path}` } });
});

// ---- 本路由内的异常统一转 JSON，避免走全站的 HTML 错误页 ----
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  console.error('[api-v1] 未处理异常:', err);
  res.status(500).json({ error: { code: 'internal', message: '服务器内部错误，请稍后重试' } });
});

module.exports = router;
