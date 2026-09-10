/**
 * API Key 管理模块（口径/实现唯一入口）
 *
 * 用途：给 n8n、Codex 等自动化工具发独立 REST API 凭据（AI 日报、销售龙虎榜等场景）。
 * 管理入口只有平台超管后台 /platform-admin/api-keys，租户自己的设置页面不暴露任何入口。
 *
 * 安全设计：
 *   - 明文 Key 只在生成那一刻返回一次，库里只存 SHA-256 哈希（key_hash UNIQUE）；
 *     认证时对请求带来的明文做同样的哈希再查表，数据库泄露也拿不到可用 Key。
 *   - 不用 bcrypt 存 Key：bcrypt 是给"人类弱密码"设计的慢哈希，API Key 本身是
 *     192 位随机数，不存在暴力枚举空间，用 bcrypt 反而让每个 API 请求慢上百毫秒。
 *   - 列表只展示 key_prefix（明文前 12 位，含 jxc_ 前缀），足够辨识、不足以复原。
 *   - 吊销不物理删除（revoked_at 留痕），方便审计。
 *
 * Key 格式：jxc_ + 48 个十六进制字符（crypto.randomBytes(24)），总长 52。
 */

const crypto = require('crypto');
const { platformDb } = require('./platformDb');

// 三档权限：rank 用来做"请求的档位是否够用"的比较（路由声明最低档，Key 档位 >= 最低档即放行）
const PERMISSION_LEVELS = ['read_only', 'read_write', 'full'];
const LEVEL_RANK = { read_only: 0, read_write: 1, full: 2 };
const LEVEL_LABELS = { read_only: '只读', read_write: '读+写', full: '最大权限' };

function isValidLevel(level) {
  return PERMISSION_LEVELS.includes(level);
}

function hashApiKey(plaintext) {
  return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * 生成新 Key。返回 { id, keyPrefix, plaintext, permissionLevel }，
 * plaintext 只此一次，调用方（超管后台）负责展示并提示"关闭后无法再次查看"。
 */
function generateApiKey({ tenantId, permissionLevel, adminId, adminUsername }) {
  if (!isValidLevel(permissionLevel)) throw new Error('非法的权限档位');
  const tenant = platformDb.prepare('SELECT id FROM tenants WHERE id = ?').get(tenantId);
  if (!tenant) throw new Error('租户不存在');

  const plaintext = 'jxc_' + crypto.randomBytes(24).toString('hex');
  const keyPrefix = plaintext.slice(0, 12);
  const info = platformDb.prepare(
    `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, permission_level, created_by, created_by_username)
     VALUES (?,?,?,?,?,?)`
  ).run(tenantId, hashApiKey(plaintext), keyPrefix, permissionLevel, adminId, adminUsername);

  return { id: info.lastInsertRowid, keyPrefix, plaintext, permissionLevel };
}

/** 列出 Key（含已吊销）。tenantId 为空时列全部租户的。 */
function listApiKeys(tenantId = null) {
  let sql = `
    SELECT k.*, t.tenant_code, t.name AS tenant_name
    FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
  `;
  const params = [];
  if (tenantId) { sql += ' WHERE k.tenant_id = ?'; params.push(tenantId); }
  sql += ' ORDER BY k.id DESC';
  return platformDb.prepare(sql).all(...params);
}

function getApiKeyById(id) {
  return platformDb.prepare(
    `SELECT k.*, t.tenant_code, t.name AS tenant_name
     FROM api_keys k JOIN tenants t ON t.id = k.tenant_id WHERE k.id = ?`
  ).get(id);
}

/** 吊销：只对未吊销的生效，返回是否真的改了（重复吊销返回 false，幂等） */
function revokeApiKey(id) {
  const info = platformDb.prepare(
    `UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`
  ).run(id);
  return info.changes === 1;
}

/** 改权限档位（超管后台的二次确认弹窗负责防误触，这里只做合法性校验） */
function updateApiKeyTier(id, permissionLevel) {
  if (!isValidLevel(permissionLevel)) throw new Error('非法的权限档位');
  const info = platformDb.prepare(
    'UPDATE api_keys SET permission_level = ? WHERE id = ?'
  ).run(permissionLevel, id);
  return info.changes === 1;
}

/**
 * 认证用：按哈希找"还活着"的 Key（存在且未吊销）。
 * 连租户信息一起带出来，中间件还要校验租户本身是否可用（active / 未到期）。
 */
function findActiveApiKeyByHash(keyHash) {
  return platformDb.prepare(
    `SELECT k.id, k.tenant_id, k.key_prefix, k.permission_level, k.last_used_at,
            t.tenant_code, t.name AS tenant_name
     FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = ? AND k.revoked_at IS NULL`
  ).get(keyHash);
}

/** 每次成功认证都刷新最近使用时间，方便超管判断哪些 Key 还在用 */
function touchLastUsed(id) {
  platformDb.prepare(`UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?`).run(id);
}

module.exports = {
  PERMISSION_LEVELS,
  LEVEL_RANK,
  LEVEL_LABELS,
  isValidLevel,
  hashApiKey,
  generateApiKey,
  listApiKeys,
  getApiKeyById,
  revokeApiKey,
  updateApiKeyTier,
  findActiveApiKeyByHash,
  touchLastUsed
};
