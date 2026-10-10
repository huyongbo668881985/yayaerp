// 强制改密期间唯一放行的两个地址：改密页本身、退出登录。
// 其余所有走 requireSuperAdmin 的后台路由，一律重定向回改密页，
// 保证"默认口令登录后没改密码"这个状态进不去任何业务页面。
const FORCED_CHANGE_ALLOWED_PATHS = new Set([
  '/platform-admin/change-password',
  '/platform-admin/logout'
]);
const { platformDb } = require('../lib/platformDb');

function requireSuperAdmin(req, res, next) {
  if (!req.session.platformAdmin) return res.redirect('/platform-admin/login');
  const live = platformDb.prepare('SELECT id, username, name, must_change_password, auth_version FROM platform_admins WHERE id=?').get(req.session.platformAdmin.id);
  if (!live || (req.session.platformAdmin.authVersion ?? 0) !== live.auth_version) {
    return req.session.destroy(() => res.redirect('/platform-admin/login'));
  }
  req.session.platformAdmin = { id: live.id, username: live.username, name: live.name, mustChangePassword: !!live.must_change_password, authVersion: live.auth_version };
  if (req.session.platformAdmin.mustChangePassword && !FORCED_CHANGE_ALLOWED_PATHS.has(req.path)) {
    return res.redirect('/platform-admin/change-password');
  }
  res.locals.currentPlatformAdmin = req.session.platformAdmin;
  next();
}

module.exports = { requireSuperAdmin };
