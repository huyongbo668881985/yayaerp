/**
 * 欠款每日快照：每天把每个租户的"当前欠款水位"落一行到本租户库的 debt_snapshots 表，
 * 积累出按天的时间序列，供后续趋势 / 环比查询（API v1: GET /api/v1/reports/debt-trend）。
 *
 * 快照范围：platform.db tenants 表登记的每一个租户库（含已暂停的）——
 *          欠款是资产安全指标，租户被暂停不代表债收回来了，趋势不该断；
 *          与备份范围（backupManager.listBackupTargets）同口径，但不含 platform 库
 *          （平台库没有业务欠款数据）。
 *
 * 口径：复用 lib/profitCalc.js 的 effectiveDebtExpr（有效欠款唯一实现点），
 *      只累计"已审核 且 有效欠款 > 0.001"的销售单，与报表页"应收账款"完全一致：
 *        全公司行（user_id = NULL）：全部欠款单的 Σ有效欠款 + 欠款客户数（散客算一组）
 *        操作员行：users 表每人一行（无欠款记 0，保证全公司行 = Σ 操作员行、趋势不断线）
 *
 * 幂等：同一天重复执行 = 整体重算当天快照（事务内先 DELETE 当天再 INSERT）。
 *      不用 INSERT OR REPLACE 的原因：SQLite UNIQUE 索引里 NULL互不冲突，
 *      user_id=NULL 的全公司行靠 (snapshot_date, user_id) 唯一索引拦不住重复。
 *
 * 日期口径：snapshot_date 用北京时间（utils/dates.js 的 todayLocalDate），
 *          与备份模块保持一致；凌晨任务跨 UTC 日界也不会错一天。
 *
 * 触发方式：本模块不内置定时器，由 scripts/debt-snapshot-run.js 作为入口，
 *          手动执行或宿主机 crontab 定时调用（02:25，与 02:30 的备份任务错开 5 分钟）。
 *
 * 结构仿 lib/backupManager.js：单库失败不中断其他库，所有结果汇总在执行报告里，
 * 供入口脚本决定是否发告警邮件。
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { todayLocalDate } = require('../utils/dates');
const { effectiveDebtExpr, SETTLE_EPSILON } = require('./profitCalc');

// 数据目录。JXC_DATA_DIR 仅测试/特殊部署场景用来重定向，正常部署不用配（与备份模块一致）。
const DATA_DIR = process.env.JXC_DATA_DIR || path.join(__dirname, '..', 'data');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 金额统一保留 2 位小数再入库，避免浮点尾巴污染快照序列（与 API v1 的 r2 同一手法） */
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/** 校验 YYYY-MM-DD（脚本 --date 参数用），非法返回 null */
function parseSnapshotDate(value) {
  const v = String(value == null ? '' : value).trim();
  return DATE_RE.test(v) ? v : null;
}

/**
 * 确保快照表存在（幂等）。正常情况下 lib/schema.js 的 initSchema 已在建库/打开库时建好；
 * 这里再兜一层，保证脚本独立于 Web 服务跑老租户库时也不会因缺表而失败。
 */
function ensureSnapshotTable(db) {
  db.pragma('busy_timeout = 5000'); // 服务进程可能同时握着写锁，等 5 秒而不是立刻 SQLITE_BUSY
  db.exec(`
    CREATE TABLE IF NOT EXISTS debt_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      total_debt REAL NOT NULL,
      debtor_customer_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_snapshots_date_user
    ON debt_snapshots(snapshot_date, user_id);
  `);
}

/**
 * 对单个租户库执行一次快照写入，返回 { rows, company_debt, company_debtors, user_rows }。
 *
 * SQL 说明：
 *  - 全公司行与报表页 getSummary 的 receivable 同构（去掉日期过滤 = 历史总欠款水位）；
 *  - 散客（customer_id NULL）在"欠款客户数"里用哨兵 -1 计为一组（真实 id 从 1 开始不会撞）；
 *  - 操作员行以 users 表为基准 LEFT JOIN 欠款单：无欠款的操作员落 0 行，
 *    使 Σ 操作员行恒等于全公司行，趋势查询里欠款清零表现为归零而不是断线。
 */
function snapshotTenantDb(db, dateStr) {
  ensureSnapshotTable(db);
  const DEBT = effectiveDebtExpr('so');

  const company = db.prepare(`
    SELECT COALESCE(SUM(${DEBT}), 0) AS total_debt,
           COUNT(DISTINCT COALESCE(so.customer_id, -1)) AS debtor_customer_count
    FROM sales_orders so
    WHERE so.status = 'approved' AND ${DEBT} > ${SETTLE_EPSILON}
  `).get();

  const userRows = db.prepare(`
    SELECT u.id AS user_id,
           COALESCE(SUM(d.debt), 0) AS total_debt,
           COUNT(DISTINCT CASE WHEN d.debt IS NOT NULL THEN COALESCE(d.customer_id, -1) END) AS debtor_customer_count
    FROM users u
    LEFT JOIN (
      SELECT so.user_id, so.customer_id, ${DEBT} AS debt
      FROM sales_orders so
      WHERE so.status = 'approved' AND ${DEBT} > ${SETTLE_EPSILON}
    ) d ON d.user_id = u.id
    GROUP BY u.id
    ORDER BY u.id
  `).all();

  // 事务内"先删当天再插"：幂等的实现点。重跑 = 重新计算当天全量快照，绝不残留半份。
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM debt_snapshots WHERE snapshot_date = ?').run(dateStr);
    const ins = db.prepare(
      'INSERT INTO debt_snapshots (snapshot_date, user_id, total_debt, debtor_customer_count) VALUES (?,?,?,?)'
    );
    ins.run(dateStr, null, r2(company.total_debt), company.debtor_customer_count);
    for (const u of userRows) {
      ins.run(dateStr, u.user_id, r2(u.total_debt), u.debtor_customer_count);
    }
  });
  tx();

  return {
    rows: 1 + userRows.length,
    company_debt: r2(company.total_debt),
    company_debtors: company.debtor_customer_count,
    user_rows: userRows.length
  };
}

/**
 * 列出所有需要快照的租户：platform.db tenants 表登记的全部租户（含暂停的）。
 * 仿 backupManager.listBackupTargets：readonly 临时打开平台库读清单，读完即关，
 * 不碰 app 运行时的连接缓存。清单读不出来时返回空列表（错误在调用方汇总体现）。
 */
function listTenantTargets() {
  const platformDbPath = path.join(DATA_DIR, 'platform.db');
  const targets = [];
  if (!fs.existsSync(platformDbPath)) return targets;

  let platformDb = null;
  try {
    platformDb = new Database(platformDbPath, { readonly: true });
    const rows = platformDb.prepare('SELECT tenant_code, db_path FROM tenants ORDER BY id').all();
    for (const row of rows) {
      targets.push({ tenant_code: row.tenant_code, dbPath: row.db_path });
    }
  } catch (e) {
    console.error(`[debt-snapshot] 读取租户清单失败（platform.db）：${e.message}`);
  } finally {
    if (platformDb) { try { platformDb.close(); } catch (e) { /* 忽略 */ } }
  }
  return targets;
}

/**
 * 执行一次完整快照任务：遍历全部租户库逐个落快照。
 * 单个租户失败不中断其他租户（继续快照剩下的），所有错误汇总在返回值里。
 *
 * @param {object} options
 * @param {string} [options.date]  覆盖快照日期（YYYY-MM-DD），仅测试/补数用；默认北京时间今天
 * @returns {{ date, results: Array, summary: { ok, failed } }}
 */
function runDebtSnapshot(options = {}) {
  const dateStr = options.date ? parseSnapshotDate(options.date) : todayLocalDate();
  if (!dateStr) {
    throw new Error(`快照日期格式错误：${options.date}，应为 YYYY-MM-DD`);
  }

  console.log(`[debt-snapshot] 开始快照，日期 ${dateStr}`);
  const targets = listTenantTargets();
  const results = [];

  for (const t of targets) {
    const entry = { tenant_code: t.tenant_code, db_path: t.dbPath, ok: false };
    results.push(entry);
    if (!fs.existsSync(t.dbPath)) {
      entry.error = '租户库文件不存在，跳过';
      console.warn(`[debt-snapshot] ${t.tenant_code}: ${entry.error}（${t.dbPath}）`);
      continue;
    }
    let db = null;
    try {
      db = new Database(t.dbPath);
      const stat = snapshotTenantDb(db, dateStr);
      entry.ok = true;
      Object.assign(entry, stat);
      console.log(`[debt-snapshot] ${t.tenant_code}: 完成 — 欠款合计 ${stat.company_debt}，欠款客户 ${stat.company_debtors}，共 ${stat.rows} 行（含 ${stat.user_rows} 名操作员）`);
    } catch (e) {
      entry.error = e.message;
      console.error(`[debt-snapshot] ${t.tenant_code}: 失败 — ${e.message}`);
    } finally {
      if (db) { try { db.close(); } catch (e) { /* 忽略 */ } }
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log(`[debt-snapshot] 任务结束：成功 ${results.length - failed.length}/${results.length} 个租户`);

  return {
    date: dateStr,
    results,
    summary: { ok: results.length - failed.length, failed: failed.length }
  };
}

/**
 * 告警组装（模式仿 lib/backupAlert.js，独立出来方便单测）：
 * 把 runDebtSnapshot 的报告转成"是否需要告警 + 邮件标题/正文"。
 */
function collectFailures(report) {
  const failures = [];
  for (const r of report.results) {
    if (!r.ok) failures.push({ label: r.tenant_code, detail: r.error || '未知错误' });
  }
  if (report.results.length === 0) {
    failures.push({ label: '(无租户)', detail: '未从 platform.db 读到任何租户，快照一条都没写' });
  }
  return failures;
}

function buildAlertText(report, failures, failedTime) {
  return [
    `欠款快照任务出现 ${failures.length} 项失败，请检查。`,
    ``,
    `快照日期：${report.date}`,
    `失败时间：${failedTime}`,
    `租户总数：${report.results.length}（成功 ${report.summary.ok} / 失败 ${report.summary.failed}）`,
    ``,
    `----- 失败明细 -----`,
    ...failures.map((f, i) => `[${i + 1}] ${f.label}\n${f.detail}`),
    ``,
    `成功的租户快照不受影响；失败租户当天的快照缺失，趋势查询会出现空档。`,
  ].join('\n');
}

module.exports = {
  runDebtSnapshot,
  snapshotTenantDb,
  ensureSnapshotTable,
  listTenantTargets,
  parseSnapshotDate,
  collectFailures,
  buildAlertText,
  DATA_DIR,
};
