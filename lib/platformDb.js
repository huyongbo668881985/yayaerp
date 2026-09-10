const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { todayLocalDate } = require('../utils/dates');
const { addColumnIfMissing, applyMigration } = require('./migrations');

const DATA_DIR = process.env.JXC_DATA_DIR || path.join(__dirname, '..', 'data');
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
if (!fs.existsSync(TENANTS_DIR)) fs.mkdirSync(TENANTS_DIR, { recursive: true });

const platformDb = new Database(path.join(DATA_DIR, 'platform.db'));
platformDb.pragma('journal_mode = WAL');
platformDb.pragma('foreign_keys = ON');

platformDb.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  db_path TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 平台超管高权限操作审计：创建/暂停/启用租户、改限额、重置租户账号密码都要留痕，
-- 出问题时能回答"谁在什么时候动了哪个租户"。
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_username TEXT NOT NULL,
  action TEXT NOT NULL,
  target_tenant_id INTEGER,
  target_tenant_code TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- API Key 表（平台超管专属管理，放在 platform.db 而不是各租户库——
-- Key 本质是"平台发给某个租户"的凭据，生成/吊销/改档位都只发生在 /platform-admin 后台，
-- 租户自己的设置页面不暴露任何入口）。
--   key_hash  只存 SHA-256 哈希，不存明文；明文只在生成那一刻展示一次
--   key_prefix 明文前几位（含 jxc_ 前缀），列表里辨识用，不泄露完整 Key
--   permission_level 三档权限：read_only / read_write / full（当前只实现 read_only 对应端点，
--              后两档先建好框架，未来开放写接口时直接用）
--   revoked_at 不做物理删除，吊销留痕方便审计
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  permission_level TEXT NOT NULL CHECK(permission_level IN ('read_only','read_write','full')),
  created_at TEXT DEFAULT (datetime('now')),
  created_by INTEGER NOT NULL REFERENCES platform_admins(id),
  created_by_username TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
`);

applyMigration(platformDb, 1, 'tenant quotas', () => {
  const tx = platformDb.transaction(() => {
    addColumnIfMissing(platformDb, 'tenants', 'expires_at TEXT');
    addColumnIfMissing(platformDb, 'tenants', 'max_users INTEGER');
  });
  tx();
});

// 首次启动生成默认平台超管账号
const adminCount = platformDb.prepare('SELECT COUNT(*) AS c FROM platform_admins').get().c;
if (adminCount === 0) {
  const hash = bcrypt.hashSync('super123', 10);
  platformDb.prepare(
    'INSERT INTO platform_admins (username, password_hash, name) VALUES (?,?,?)'
  ).run('superadmin', hash, '平台超级管理员');
  console.log('已创建默认平台超管账号: superadmin / super123 —— 请登录后立刻修改密码');
}

// ---- 租户代码校验：只允许字母数字下划线短横线，防止被拼进文件路径时做路径穿越 ----
const TENANT_CODE_RE = /^[a-zA-Z0-9_-]{3,32}$/;
function isValidTenantCode(code) {
  return typeof code === 'string' && TENANT_CODE_RE.test(code);
}

// 到期日按"当天结束"算，比如 expires_at = 2026-07-22，那么 7月22日当天仍可用，7月23日起过期。
// "今天"按北京时间算，不能按 UTC——否则北京 0:00~8:00 之间到期判断会晚一天。
// 试用开通的 expiresAt（trialProvision.js）也用同一套本地日期口径，两边必须一致。
function isTenantExpired(tenant) {
  if (!tenant || !tenant.expires_at) return false;
  return todayLocalDate() > tenant.expires_at;
}

function getTenantByCode(tenantCode) {
  if (!isValidTenantCode(tenantCode)) return null;
  return platformDb.prepare('SELECT * FROM tenants WHERE tenant_code = ?').get(tenantCode);
}

function getTenantById(id) {
  return platformDb.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
}

function listTenants() {
  return platformDb.prepare('SELECT * FROM tenants ORDER BY id DESC').all();
}

function createTenant(tenantCode, name, options = {}) {
  if (!isValidTenantCode(tenantCode)) {
    throw new Error('租户代码只能包含字母、数字、下划线、短横线，长度3-32位');
  }
  const existing = getTenantByCode(tenantCode);
  if (existing) throw new Error('租户代码已存在');
  const { expiresAt = null, maxUsers = null } = options;
  // db_path 由系统内部拼接生成，不直接使用用户输入拼接路径以外的用途
  const dbPath = path.join(TENANTS_DIR, `${tenantCode}.db`);
  platformDb.prepare(
    'INSERT INTO tenants (tenant_code, name, status, db_path, expires_at, max_users) VALUES (?,?,?,?,?,?)'
  ).run(tenantCode, name, 'active', dbPath, expiresAt, maxUsers);
  return getTenantByCode(tenantCode);
}

function deleteTenantRecord(id) {
  const tx = platformDb.transaction(() => {
    platformDb.prepare('DELETE FROM api_keys WHERE tenant_id = ?').run(id);
    platformDb.prepare('DELETE FROM tenants WHERE id = ?').run(id);
  });
  tx();
}

function setTenantStatus(id, status) {
  if (!['active', 'suspended'].includes(status)) throw new Error('非法状态');
  platformDb.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, id);
}

function updateTenantLimits(id, { name, expiresAt, maxUsers }) {
  platformDb.prepare(
    'UPDATE tenants SET name = ?, expires_at = ?, max_users = ? WHERE id = ?'
  ).run(name, expiresAt || null, maxUsers || null, id);
  return getTenantById(id);
}

function getPlatformAdminByUsername(username) {
  return platformDb.prepare('SELECT * FROM platform_admins WHERE username = ?').get(username);
}

function updatePlatformAdminPassword(id, newPasswordHash) {
  platformDb.prepare('UPDATE platform_admins SET password_hash = ? WHERE id = ?').run(newPasswordHash, id);
}

// ---- 平台操作审计 ----
function insertAuditLog({ adminId, adminUsername, action, targetTenantId = null, targetTenantCode = null, detail = null }) {
  platformDb.prepare(
    `INSERT INTO platform_audit_log (admin_id, admin_username, action, target_tenant_id, target_tenant_code, detail)
     VALUES (?,?,?,?,?,?)`
  ).run(adminId, adminUsername, action, targetTenantId, targetTenantCode, detail);
}

// 审计日志只读查询：按时间倒序取最近 N 条（简单页面用，不做筛选/分页）
function listAuditLogs(limit = 500) {
  return platformDb.prepare('SELECT * FROM platform_audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  platformDb,
  TENANTS_DIR,
  isValidTenantCode,
  isTenantExpired,
  getTenantByCode,
  getTenantById,
  listTenants,
  createTenant,
  deleteTenantRecord,
  setTenantStatus,
  updateTenantLimits,
  getPlatformAdminByUsername,
  updatePlatformAdminPassword,
  insertAuditLog,
  listAuditLogs
};
