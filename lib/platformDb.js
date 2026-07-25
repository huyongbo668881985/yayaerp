const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
`);

// 兼容老库升级：补齐配额相关字段（已存在则忽略报错）
function safeAddColumn(table, columnDef) {
  try { platformDb.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); } catch (e) { /* 已存在，忽略 */ }
}
safeAddColumn('tenants', "expires_at TEXT"); // 到期日期 YYYY-MM-DD，NULL = 不限
safeAddColumn('tenants', "max_users INTEGER"); // 账号数上限，NULL = 不限

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

// 到期日按"当天结束"算，比如 expires_at = 2026-07-22，那么 7月22日当天仍可用，7月23日起过期
function isTenantExpired(tenant) {
  if (!tenant || !tenant.expires_at) return false;
  const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return todayStr > tenant.expires_at;
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

module.exports = {
  platformDb,
  TENANTS_DIR,
  isValidTenantCode,
  isTenantExpired,
  getTenantByCode,
  getTenantById,
  listTenants,
  createTenant,
  setTenantStatus,
  updateTenantLimits,
  getPlatformAdminByUsername,
  updatePlatformAdminPassword
};
