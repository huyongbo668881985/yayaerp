const Database = require('better-sqlite3');
const { initSchema } = require('./schema');
const { getTenantByCode, isTenantExpired } = require('./platformDb');

// 简单的连接缓存：tenant_code -> better-sqlite3 实例
// better-sqlite3 是同步的，这里不需要连接池，缓存住句柄避免重复开关文件即可。
const dbCache = new Map();
const MAX_CACHED = 200; // 常驻内存的租户连接数上限，超过后淘汰最久未用的一个

function touchCache(tenantCode, db) {
  // 用 Map 的插入顺序模拟简单 LRU：命中时删除再重新插入，让它排到最后
  if (dbCache.has(tenantCode)) dbCache.delete(tenantCode);
  dbCache.set(tenantCode, db);
  if (dbCache.size > MAX_CACHED) {
    const oldestKey = dbCache.keys().next().value;
    const oldestDb = dbCache.get(oldestKey);
    dbCache.delete(oldestKey);
    try { oldestDb.close(); } catch (e) { /* 忽略关闭失败 */ }
  }
}

// 统一做一遍"是否允许访问"的检查：不存在 / 被暂停 / 已到期
function checkTenantAccess(tenant) {
  if (!tenant) return { error: 'not_found' };
  if (tenant.status !== 'active') return { error: 'suspended', tenant };
  if (isTenantExpired(tenant)) return { error: 'expired', tenant };
  return null;
}

/**
 * 根据租户代码拿到对应的 db 连接。
 * 返回 { db, tenant } 或者 { error: 'not_found' | 'suspended' | 'expired', tenant? }。
 */
function getTenantDb(tenantCode) {
  const tenant = getTenantByCode(tenantCode);
  const accessError = checkTenantAccess(tenant);
  if (accessError) return accessError;

  if (dbCache.has(tenantCode)) {
    const db = dbCache.get(tenantCode);
    touchCache(tenantCode, db);
    return { db, tenant };
  }

  const db = new Database(tenant.db_path);
  initSchema(db); // 幂等，顺便兼容老库升级字段
  touchCache(tenantCode, db);
  return { db, tenant };
}

/**
 * 新开通租户后，第一次打开它的 db（此时文件还不存在，better-sqlite3 会自动创建）。
 */
function openTenantDbByPath(dbPath) {
  const db = new Database(dbPath);
  initSchema(db);
  return db;
}

/**
 * 平台后台展示用：临时打开一下某个租户的 db 文件数一下账号数，用完即关，
 * 不占用上面的常驻连接缓存（避免平台管理员随便点几下列表页就把缓存塞满）。
 */
function getTenantUserCount(dbPath) {
  try {
    const tmpDb = new Database(dbPath, { readonly: true });
    const count = tmpDb.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    tmpDb.close();
    return count;
  } catch (e) {
    return null; // 文件不存在或读取失败，前端按"未知"处理
  }
}

module.exports = { getTenantDb, openTenantDbByPath, getTenantUserCount };
