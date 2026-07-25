const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

const {
  listTenants,
  getTenantById,
  createTenant,
  setTenantStatus,
  updateTenantLimits,
  getPlatformAdminByUsername,
  updatePlatformAdminPassword
} = require('../lib/platformDb');
const { openTenantDbByPath, getTenantUserCount } = require('../lib/tenantManager');
const { bootstrapTenant } = require('../lib/schema');
const { isTenantExpired } = require('../lib/platformDb');
const { requireSuperAdmin } = require('../middleware/platformAuth');
const { createLoginLimiter } = require('../middleware/rateLimit');

const platformLoginLimiter = createLoginLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 校验并规整"到期日期"和"账号数上限"这两个可选配额字段
// 返回 { error } 或 { expiresAt, maxUsers }
function parseQuotaFields(body) {
  let expiresAt = null;
  if (body.expires_at && body.expires_at.trim()) {
    if (!DATE_RE.test(body.expires_at.trim())) return { error: '到期日期格式不对，应为 YYYY-MM-DD' };
    expiresAt = body.expires_at.trim();
  }
  let maxUsers = null;
  if (body.max_users && body.max_users.trim()) {
    const n = Number(body.max_users);
    if (!Number.isInteger(n) || n < 1) return { error: '账号数上限必须是大于0的整数' };
    maxUsers = n;
  }
  return { expiresAt, maxUsers };
}

router.get('/platform-admin/login', (req, res) => {
  if (req.session.platformAdmin) return res.redirect('/platform-admin');
  res.render('platform_login', { error: null });
});

router.post('/platform-admin/login', platformLoginLimiter, (req, res) => {
  const { username, password } = req.body;
  const admin = getPlatformAdminByUsername(username);
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    return res.render('platform_login', { error: '用户名或密码错误' });
  }
  req.session.regenerate((err) => {
    if (err) {
      console.error(err);
      return res.render('platform_login', { error: '登录失败，请重试' });
    }
    req.session.platformAdmin = { id: admin.id, username: admin.username, name: admin.name };
    res.redirect('/platform-admin');
  });
});

router.post('/platform-admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/platform-admin/login'));
});

router.get('/platform-admin/change-password', requireSuperAdmin, (req, res) => {
  res.render('platform_change_password', { error: null, success: false });
});

router.post('/platform-admin/change-password', requireSuperAdmin, (req, res) => {
  const { old_password, new_password } = req.body;
  const admin = getPlatformAdminByUsername(req.session.platformAdmin.username);
  if (!bcrypt.compareSync(old_password || '', admin.password_hash)) {
    return res.render('platform_change_password', { error: '原密码不正确', success: false });
  }
  if (!new_password || new_password.length < 6) {
    return res.render('platform_change_password', { error: '新密码至少6位', success: false });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  updatePlatformAdminPassword(admin.id, hash);
  res.render('platform_change_password', { error: null, success: true });
});

router.get('/platform-admin', requireSuperAdmin, (req, res) => {
  const tenants = listTenants().map(t => ({
    ...t,
    isExpired: isTenantExpired(t),
    userCount: getTenantUserCount(t.db_path)
  }));
  res.render('platform_dashboard', { tenants, error: null });
});

router.get('/platform-admin/tenants/new', requireSuperAdmin, (req, res) => {
  res.render('platform_tenant_form', { error: null, form: {} });
});

router.post('/platform-admin/tenants/new', requireSuperAdmin, (req, res) => {
  const { tenant_code, tenant_name, admin_username, admin_password, admin_name, warehouse_name } = req.body;

  if (!tenant_code || !tenant_name || !admin_username || !admin_password) {
    return res.render('platform_tenant_form', {
      error: '租户代码、租户名称、管理员用户名、管理员密码均为必填',
      form: req.body
    });
  }
  if (admin_password.length < 6) {
    return res.render('platform_tenant_form', { error: '管理员密码至少6位', form: req.body });
  }

  const quota = parseQuotaFields(req.body);
  if (quota.error) {
    return res.render('platform_tenant_form', { error: quota.error, form: req.body });
  }

  let tenant;
  try {
    tenant = createTenant(tenant_code.trim(), tenant_name.trim(), quota);
  } catch (e) {
    return res.render('platform_tenant_form', { error: e.message, form: req.body });
  }

  // 新建租户 db 文件并跑初始化 + 建第一个管理员账号
  const db = openTenantDbByPath(tenant.db_path);
  bootstrapTenant(db, {
    adminUsername: admin_username.trim(),
    adminPassword: admin_password,
    adminName: admin_name || '管理员',
    warehouseName: warehouse_name || '总仓'
  });

  res.redirect('/platform-admin');
});

router.post('/platform-admin/tenants/:id/toggle', requireSuperAdmin, (req, res) => {
  const tenant = getTenantById(Number(req.params.id));
  if (tenant) {
    setTenantStatus(tenant.id, tenant.status === 'active' ? 'suspended' : 'active');
  }
  res.redirect('/platform-admin');
});

router.get('/platform-admin/tenants/:id/edit', requireSuperAdmin, (req, res) => {
  const tenant = getTenantById(Number(req.params.id));
  if (!tenant) return res.status(404).send('租户不存在');
  res.render('platform_tenant_edit', { error: null, tenant });
});

router.post('/platform-admin/tenants/:id/edit', requireSuperAdmin, (req, res) => {
  const tenant = getTenantById(Number(req.params.id));
  if (!tenant) return res.status(404).send('租户不存在');

  const { tenant_name } = req.body;
  if (!tenant_name || !tenant_name.trim()) {
    return res.render('platform_tenant_edit', { error: '租户名称不能为空', tenant: { ...tenant, ...req.body } });
  }
  const quota = parseQuotaFields(req.body);
  if (quota.error) {
    return res.render('platform_tenant_edit', { error: quota.error, tenant: { ...tenant, ...req.body } });
  }

  updateTenantLimits(tenant.id, { name: tenant_name.trim(), expiresAt: quota.expiresAt, maxUsers: quota.maxUsers });
  res.redirect('/platform-admin');
});

module.exports = router;
