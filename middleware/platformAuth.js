function requireSuperAdmin(req, res, next) {
  if (!req.session.platformAdmin) return res.redirect('/platform-admin/login');
  res.locals.currentPlatformAdmin = req.session.platformAdmin;
  next();
}

module.exports = { requireSuperAdmin };
