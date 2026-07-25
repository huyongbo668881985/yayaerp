// 每次请求都拿 session 里的 user.id 回数据库确认一遍：账号还在、没被禁用、角色没变。
// 不能只信 session 里缓存的那份"登录时快照"——不然账号被删/禁用之后，
// 已经登录的人手里那个 session 还能一直用到过期为止（7天），相当于"锁了门但人还在屋里"。
function getLiveSessionUser(req) {
  if (!req.session.user || !req.tenantDb) return null;
  const row = req.tenantDb.prepare('SELECT id, username, name, role, active FROM users WHERE id = ?').get(req.session.user.id);
  if (!row || !row.active) return null;
  // 顺便刷新一下 session 缓存（比如角色被管理员改过，也能马上生效，不用等重新登录）
  req.session.user = { id: row.id, username: row.username, name: row.name, role: row.role };
  return req.session.user;
}

function requireLogin(req, res, next) {
  const user = getLiveSessionUser(req);
  if (!user) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  res.locals.currentUser = user;
  next();
}

function requireAdmin(req, res, next) {
  const user = getLiveSessionUser(req);
  if (!user) {
    return req.session.destroy(() => res.redirect('/login'));
  }
  if (user.role !== 'admin') {
    return res.status(403).render('error', {
      message: '权限不足：此操作仅管理员可执行',
      currentUser: user
    });
  }
  res.locals.currentUser = user;
  next();
}

module.exports = { requireLogin, requireAdmin };
