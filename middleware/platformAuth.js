// 强制改密期间唯一放行的两个地址：改密页本身、退出登录。
// 其余所有走 requireSuperAdmin 的后台路由，一律重定向回改密页，
// 保证"默认口令登录后没改密码"这个状态进不去任何业务页面。
const FORCED_CHANGE_ALLOWED_PATHS = new Set([
  '/platform-admin/change-password',
  '/platform-admin/logout'
]);

function requireSuperAdmin(req, res, next) {
  if (!req.session.platformAdmin) return res.redirect('/platform-admin/login');
  if (req.session.platformAdmin.mustChangePassword && !FORCED_CHANGE_ALLOWED_PATHS.has(req.path)) {
    return res.redirect('/platform-admin/change-password');
  }
  res.locals.currentPlatformAdmin = req.session.platformAdmin;
  next();
}

module.exports = { requireSuperAdmin };
