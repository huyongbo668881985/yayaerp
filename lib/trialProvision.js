const { createTenant } = require('./platformDb');
const { openTenantDbByPath } = require('./tenantManager');
const { bootstrapTenant } = require('./schema');
const { recordTrialRequest } = require('./trialDb');

const TRIAL_DAYS = 7;
const TRIAL_MAX_USERS = 5;

function generateTenantCode() {
  // 只用字母数字，满足 platformDb.js 里 TENANT_CODE_RE 的校验
  const rand = Math.random().toString(36).slice(2, 6);
  return `trial${Date.now().toString(36)}${rand}`;
}

function generateTempPassword() {
  // 8位随机字符 + 1位数字，试用账号够用；用户可登录后自行修改
  return Math.random().toString(36).slice(-8) + Math.floor(Math.random() * 10);
}

/**
 * 短信验证通过后，立即开通试用租户：
 *   1. 在 platform.db 里建租户记录（7天到期、最多5个账号）
 *   2. 打开对应的租户 db 文件，跑 schema 初始化 + 建第一个管理员账号
 *   3. 记一条 trial_requests，方便你后续在平台后台看开通历史
 */
async function registerTrialAccount({ company, contact, phone, wechat, teamsize }) {
  const expiresAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD，跟 platformAdmin.js 里 parseQuotaFields 用的格式一致

  let tenant = null;
  let tenantCode = null;

  // 租户代码理论上不会撞车（时间戳+随机数），但保险起见重试几次
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

  const adminUsername = 'admin';
  const adminPassword = generateTempPassword();

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

  recordTrialRequest({ company, contact, phone, wechat, teamsize, tenantCode });

  return {
    tenantCode,
    adminUsername,
    adminPassword,
    expiresAt: tenant.expires_at
  };
}

module.exports = { registerTrialAccount };
