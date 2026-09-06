const crypto = require('crypto');
const fs = require('fs');
const { platformDb, createTenant } = require('./platformDb');
const { openTenantDbByPath } = require('./tenantManager');
const { bootstrapTenant } = require('./schema');
const { recordTrialRequest } = require('./trialDb');
const { todayLocalDate } = require('../utils/dates');

const TRIAL_DAYS = 7;
const TRIAL_MAX_USERS = 5;

function generateTenantCode() {
  // 用 crypto 随机而不是 Math.random：后者可预测，租户码能被枚举出来，
  // 等于把别人的"登录入口"（租户代码）送给人猜。hex 输出天然满足
  // platformDb.js 里 TENANT_CODE_RE 的字符集要求。
  const rand = crypto.randomBytes(4).toString('hex');
  return `trial${Date.now().toString(36)}${rand}`;
}

function generateTempPassword() {
  // 10 位 crypto 随机（约 59 bit 熵）。原 Math.random().toString(36).slice(-8)
  // 有两个问题：可预测；且随机值短时实际产出的密码不足 8 位（如 0.5 -> "0.i"）。
  return crypto.randomBytes(9).toString('base64url').slice(0, 10);
}

/**
 * 短信验证通过后，立即开通试用租户：
 *   1. 在 platform.db 里建租户记录（7天到期、最多5个账号）+ 记一条 trial_requests
 *   2. 打开对应的租户 db 文件，跑 schema 初始化 + 建第一个管理员账号
 *
 * 并发安全：第 1 步整体放在一个 platform.db 事务里，trial_requests.phone 的
 * UNIQUE 约束天然挡住同一手机号的并发重复开通——两个并发请求只有一个能插进去，
 * 另一个在插入时撞 UNIQUE、整个事务回滚（刚建的租户记录也一起消失），
 * 不再出现"检查时没有、提交时建了两个租户"的 TOCTOU 空窗。
 */
/** YYYY-MM-DD 加 n 天（纯日期运算，按 UTC 日历日处理即可，因为输入已经是本地日期字符串） */
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function registerTrialAccount({ company, contact, phone, wechat, teamsize }) {
  // 到期日按北京时间算，与 isTenantExpired（platformDb.js）的判定口径一致：
  // 都用 todayLocalDate() 的同源日期。之前用 UTC，北京 0:00~8:00 开通的试用会少算一天。
  const expiresAt = addDays(todayLocalDate(), TRIAL_DAYS);

  let tenant = null;
  let tenantCode = null;

  // 租户代码理论上不会撞车（时间戳+crypto随机），保险起见重试几次
  const claimTx = platformDb.transaction(() => {
    for (let attempt = 0; attempt < 5; attempt++) {
      tenantCode = generateTenantCode();
      try {
        tenant = createTenant(tenantCode, company, { expiresAt, maxUsers: TRIAL_MAX_USERS });
        break;
      } catch (e) {
        if (e.message === '租户代码已存在' && attempt < 4) continue;
        throw e;
      }
    }
    recordTrialRequest({ company, contact, phone, wechat, teamsize, tenantCode });
  });
  claimTx(); // phone 撞 UNIQUE 时这里抛 SQLITE_CONSTRAINT 错误，建租户的动作一并回滚

  // 初始化租户库（独立 db 文件）。这一步若失败，把第 1 步占的坑补偿删掉——
  // 不留"平台库有租户记录、租户库里却没有管理员账号"的僵尸租户，用户可以直接重试。
  const adminUsername = 'admin';
  const adminPassword = generateTempPassword();
  try {
    const db = openTenantDbByPath(tenant.db_path);
    try {
      bootstrapTenant(db, {
        adminUsername,
        adminPassword,
        adminName: contact || '管理员',
        warehouseName: '总仓'
      });
    } finally {
      db.close(); // 这里只是初始化，用完即关；用户登录时会走 getTenantDb 重新打开并缓存
    }
  } catch (e) {
    try {
      platformDb.prepare('DELETE FROM trial_requests WHERE tenant_code = ?').run(tenantCode);
      platformDb.prepare('DELETE FROM tenants WHERE id = ?').run(tenant.id);
    } catch (_) { /* 补偿失败就留着记录人工清理，不掩盖原始错误 */ }
    try { fs.unlinkSync(tenant.db_path); } catch (_) { /* 文件残留无害 */ }
    throw e;
  }

  return {
    tenantCode,
    adminUsername,
    adminPassword,
    expiresAt: tenant.expires_at
  };
}

module.exports = { registerTrialAccount };
