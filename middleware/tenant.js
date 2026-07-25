const { getTenantDb } = require('../lib/tenantManager');

/**
 * 挂在 session 中间件之后、所有业务路由之前。
 * 如果 session 里已经有 tenant_code（登录过），就把对应的 db 连接挂到 req.tenantDb 上。
 * 如果租户被平台管理员暂停了，或者租户代码已经不存在了，直接清掉 session 强制重新登录。
 */
function resolveTenant(req, res, next) {
  const tenantCode = req.session.tenantCode;
  if (!tenantCode) return next(); // 还没登录，交给 requireLogin 去挡

  const result = getTenantDb(tenantCode);
  if (result.error === 'not_found') {
    return req.session.destroy(() => res.redirect('/login?error=tenant_not_found'));
  }
  if (result.error === 'suspended') {
    return req.session.destroy(() => res.redirect('/login?error=tenant_suspended'));
  }
  if (result.error === 'expired') {
    return req.session.destroy(() => res.redirect('/login?error=tenant_expired'));
  }

  req.tenantDb = result.db;
  req.tenant = result.tenant;
  next();
}

module.exports = { resolveTenant };
