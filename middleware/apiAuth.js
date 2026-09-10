/**
 * API v1 认证与权限中间件（供 n8n / Codex 等自动化工具调用的独立 REST API）
 *
 * 与 Web 登录体系完全分开：不看 session、不碰 Cookie，凭 API Key 走 Authorization 头。
 * 挂载位置在 app.js 的 session 中间件之前，API 请求不创建任何会话。
 *
 * 认证流程：
 *   1. 从 Authorization: Bearer <key>（优先）或 X-API-Key 请求头取明文 Key（二选一，
 *      n8n 的 HTTP Request 节点和多数 HTTP 客户端对这两种都好配）
 *   2. SHA-256 哈希后到 platform.db 的 api_keys 表精确匹配（哈希查表 = 库里没有明文也能认证）
 *   3. 校验 Key 存在且未吊销、所属租户存在且未暂停未过期
 *   4. 通过后刷新 last_used_at，把租户 db 连接（req.tenantDb，复用 tenantManager 的连接缓存）
 *      和 Key 信息挂到 req 上，供后续业务路由使用
 *
 * 数据隔离铁律：业务逻辑一律用 req.apiKey.tenantId 对应的 req.tenantDb 查数，
 * 请求参数里传任何租户标识都直接忽略——多租户下每个租户一个独立 SQLite 文件，
 * 用错库就等于数据泄露。
 *
 * 错误码约定（统一 JSON：{ error: { code, message } }）：
 *   401  missing_key / invalid_key / revoked_key / tenant_not_found / tenant_suspended / tenant_expired
 *        —— 认证上下文失效（Key 缺失/错误/吊销，或租户不可用），客户端该停止重试或换 Key
 *   403  forbidden —— Key 有效但档位不够（requireApiTier 判定）
 *   每次认证失败都打一行结构化 warn 日志（含来源 IP 与原因），供后续接监控排查盗用/爆破。
 */

const {
  hashApiKey, findActiveApiKeyByHash, touchLastUsed, LEVEL_RANK, LEVEL_LABELS
} = require('../lib/apiKeys');
const { getTenantDb } = require('../lib/tenantManager');

function apiError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function extractBearerKey(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const key = auth.slice(7).trim();
    if (key) return key;
  }
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  return null;
}

function logAuthFailure(req, reason) {
  // 单行结构化日志：方便 grep / 日志系统聚合，观察是否有同一 Key 反复失败的盗用尝试
  console.warn(`[api-auth] 认证失败 ip=${req.ip} method=${req.method} path=${req.originalUrl} reason=${reason}`);
}

function apiAuth(req, res, next) {
  const plaintext = extractBearerKey(req);
  if (!plaintext) {
    logAuthFailure(req, 'missing_key');
    return apiError(res, 401, 'missing_key', '缺少 API Key：请在 Authorization: Bearer <key> 或 X-API-Key 请求头中提供');
  }

  // 哈希查表。查不到时分不清"格式错/不存在"，统一按 invalid_key 处理（避免向试探者透露多余信息）
  const record = findActiveApiKeyByHash(hashApiKey(plaintext));
  if (!record) {
    logAuthFailure(req, 'invalid_key');
    return apiError(res, 401, 'invalid_key', 'API Key 无效或已吊销');
  }

  // Key 本身有效，但所属租户必须当前可用（暂停/到期/被删了都拒绝，与 Web 登录的 resolveTenant 同一套判定）
  const access = getTenantDb(record.tenant_code);
  if (access.error === 'not_found') {
    logAuthFailure(req, 'tenant_not_found');
    return apiError(res, 401, 'tenant_not_found', '该 Key 所属租户不存在');
  }
  if (access.error === 'suspended') {
    logAuthFailure(req, 'tenant_suspended');
    return apiError(res, 401, 'tenant_suspended', '该 Key 所属租户已被暂停');
  }
  if (access.error === 'expired') {
    logAuthFailure(req, 'tenant_expired');
    return apiError(res, 401, 'tenant_expired', '该 Key 所属租户已到期');
  }

  touchLastUsed(record.id);

  // 后续业务路由只允许用这两个东西取数，禁止相信请求参数里的任何租户标识
  req.apiKey = {
    id: record.id,
    tenantId: record.tenant_id,
    tenantCode: record.tenant_code,
    permissionLevel: record.permission_level,
    keyPrefix: record.key_prefix
  };
  req.tenantDb = access.db;
  next();
}

/**
 * 路由级权限闸门：声明访问该端点所需的最低档位。
 * 三档有序：read_only(0) < read_write(1) < full(2)，Key 档位 >= 所需档位才放行。
 *   用法：router.get('/xxx', requireApiTier('read_only'), handler)
 *   未来开放写接口时声明 requireApiTier('read_write') 即可，read_only 的 Key 会被这里拦成 403。
 */
function requireApiTier(minLevel) {
  const requiredRank = LEVEL_RANK[minLevel];
  if (requiredRank === undefined) throw new Error(`未定义的权限档位: ${minLevel}`);
  return (req, res, next) => {
    const keyRank = LEVEL_RANK[req.apiKey.permissionLevel];
    if (keyRank >= requiredRank) return next();
    console.warn(`[api-auth] 权限不足 ip=${req.ip} path=${req.originalUrl} key_prefix=${req.apiKey.keyPrefix} 档位=${req.apiKey.permissionLevel} 需要=${minLevel}`);
    return apiError(res, 403, 'forbidden',
      `当前 Key 的权限档位（${LEVEL_LABELS[req.apiKey.permissionLevel]}）不足以访问此接口（需要${LEVEL_LABELS[minLevel]}档）`);
  };
}

module.exports = { apiAuth, requireApiTier };
