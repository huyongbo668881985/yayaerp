const express = require('express');
const bcrypt = require('bcryptjs');
const { getTenantDb } = require('../lib/tenantManager');
const { createLoginLimiter } = require('../middleware/rateLimit');
const router = express.Router();

const loginLimiter = createLoginLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

const LOGIN_ERRORS = {
  tenant_not_found: '租户代码不存在，请确认后重试',
  tenant_suspended: '该租户已被暂停，请联系平台管理员',
  tenant_expired: '该租户的服务期限已到期，请联系平台管理员续期'
};

router.get('/login', (req, res) => {
  if (req.session.user && req.tenantDb) return res.redirect('/');
  const queryError = LOGIN_ERRORS[req.query.error] || null;
  res.render('login', { error: queryError, tenantCode: '' });
});

router.post('/login', loginLimiter, (req, res) => {
  const { tenant_code, username, password } = req.body;

  if (!tenant_code) {
    return res.render('login', { error: '请输入租户代码', tenantCode: '' });
  }

  const result = getTenantDb(tenant_code.trim());
  if (result.error === 'not_found') {
    return res.render('login', { error: '租户代码不存在', tenantCode: tenant_code });
  }
  if (result.error === 'suspended') {
    return res.render('login', { error: '该租户已被暂停，请联系平台管理员', tenantCode: tenant_code });
  }
  if (result.error === 'expired') {
    return res.render('login', { error: '该租户的服务期限已到期，请联系平台管理员续期', tenantCode: tenant_code });
  }

  const { db, tenant } = result;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.render('login', { error: '用户名或密码错误', tenantCode: tenant_code });
  }
  if (!user.active) {
    return res.render('login', { error: '该账号已被禁用，请联系管理员', tenantCode: tenant_code });
  }

  // 登录成功后重新生成 session，防止会话固定攻击（攻击者预先塞给受害者一个session id，
  // 受害者登录后如果沿用同一个id，攻击者就能拿着那个id直接冒充已登录状态）
  req.session.regenerate((err) => {
    if (err) {
      console.error(err);
      return res.render('login', { error: '登录失败，请重试', tenantCode: tenant_code });
    }
    req.session.tenantCode = tenant.tenant_code;
    req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role };
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/change-password', (req, res) => {
  if (!req.session.user || !req.tenantDb) return res.redirect('/login');
  res.render('change_password', { error: null, currentUser: req.session.user });
});

router.post('/change-password', (req, res) => {
  if (!req.session.user || !req.tenantDb) return res.redirect('/login');
  const db = req.tenantDb;
  const { old_password, new_password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(old_password || '', user.password_hash)) {
    return res.render('change_password', { error: '原密码不正确', currentUser: req.session.user });
  }
  if (!new_password || new_password.length < 6) {
    return res.render('change_password', { error: '新密码至少6位', currentUser: req.session.user });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
  res.render('change_password', { error: null, currentUser: req.session.user, success: true });
});

module.exports = router;
