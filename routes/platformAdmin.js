const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const router = express.Router();

const {
  listTenants,
  getTenantById,
  createTenant,
  deleteTenantRecord,
  setTenantStatus,
  updateTenantLimits,
  getPlatformAdminByUsername,
  updatePlatformAdminPassword,
  insertAuditLog,
  listAuditLogs
} = require('../lib/platformDb');
const apiKeys = require('../lib/apiKeys');
const { openTenantDbByPath, getTenantUserCount } = require('../lib/tenantManager');
const { bootstrapTenant } = require('../lib/schema');
const { isTenantExpired } = require('../lib/platformDb');
const { requireSuperAdmin } = require('../middleware/platformAuth');
const { createLoginLimiter } = require('../middleware/rateLimit');

// 平台超管登录限流：账号桶按"用户名"计（平台超管无租户概念），IP 桶兜底。
const platformLoginLimiter = createLoginLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  extractWho: req => ({ username: req.body.username })
});

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
  // 已登录但还没改默认密码的会话，直接送去改密页，别让它先跳到后台再被守卫弹回来
  if (req.session.platformAdmin) {
    return res.redirect(
      req.session.platformAdmin.mustChangePassword ? '/platform-admin/change-password' : '/platform-admin'
    );
  }
  res.render('platform_login', { error: null });
});

router.post('/platform-admin/login', platformLoginLimiter, (req, res) => {
  const { username, password } = req.body;
  const admin = getPlatformAdminByUsername(username);
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    platformLoginLimiter.fail(req); // 只统计失败次数
    return res.render('platform_login', { error: '用户名或密码错误' });
  }
  req.session.regenerate((err) => {
    if (err) {
      console.error(err);
      return res.render('platform_login', { error: '登录失败，请重试' });
    }
    platformLoginLimiter.reset(req);
    const mustChangePassword = !!admin.must_change_password;
    req.session.platformAdmin = {
      id: admin.id, username: admin.username, name: admin.name, mustChangePassword
    };
    // 默认口令（superadmin/super123）登录：不放行后台，先强制改密
    res.redirect(mustChangePassword ? '/platform-admin/change-password' : '/platform-admin');
  });
});

router.post('/platform-admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/platform-admin/login'));
});

router.get('/platform-admin/change-password', requireSuperAdmin, (req, res) => {
  res.render('platform_change_password', {
    error: null, success: false, forced: !!req.session.platformAdmin.mustChangePassword
  });
});

router.post('/platform-admin/change-password', requireSuperAdmin, (req, res) => {
  const { old_password, new_password } = req.body;
  // 会话里还有超管身份、但账号已被删除（或平台库被重置）时，清会话回登录页，
  // 否则下面读 admin.password_hash 会抛 TypeError 变成 500
  const admin = getPlatformAdminByUsername(req.session.platformAdmin.username);
  if (!admin) {
    return req.session.destroy(() => res.redirect('/platform-admin/login'));
  }
  const forced = !!req.session.platformAdmin.mustChangePassword;
  const renderError = (msg) => res.render('platform_change_password', { error: msg, success: false, forced });

  if (!bcrypt.compareSync(old_password || '', admin.password_hash)) {
    return renderError('原密码不正确');
  }
  if (!new_password || new_password.length < 6) {
    return renderError('新密码至少6位');
  }
  // 否则强制改密可以直接把新密码填回原值（比如 super123），等于没改
  if (new_password === old_password) {
    return renderError('新密码不能与原密码相同');
  }
  const hash = bcrypt.hashSync(new_password, 10);
  updatePlatformAdminPassword(admin.id, hash);
  // 数据库里的标记由 updatePlatformAdminPassword 一起清掉，这里同步清会话里的副本，
  // 否则本次会话还要被守卫拦到重新登录为止
  req.session.platformAdmin.mustChangePassword = false;
  res.render('platform_change_password', { error: null, success: true, forced });
});

// 高权限操作统一留痕：谁（admin_id/admin_username）在什么时候对哪个租户做了什么（action/detail）。
// 只在"成功生效"的分支里写，失败/校验拦截不记，避免日志里全是噪音。
function audit(req, action, tenant, detail) {
  const admin = req.session.platformAdmin;
  insertAuditLog({
    adminId: admin.id,
    adminUsername: admin.username,
    action,
    targetTenantId: tenant ? tenant.id : null,
    targetTenantCode: tenant ? tenant.tenant_code : null,
    detail: detail || null
  });
}

router.get('/platform-admin', requireSuperAdmin, (req, res) => {
  const tenants = listTenants().map(t => ({
    ...t,
    isExpired: isTenantExpired(t),
    userCount: getTenantUserCount(t.db_path)
  }));
  res.render('platform_dashboard', { tenants, error: null });
});

// 审计日志只读页：按时间倒序列出最近 500 条，不做筛选/分页
router.get('/platform-admin/audit-log', requireSuperAdmin, (req, res) => {
  const logs = listAuditLogs(500);
  res.render('platform_audit_log', { logs });
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
  // 用完必须关闭：这里不走 getTenantDb 的连接缓存，不关的话句柄会一直泄漏
  let db;
  try {
    db = openTenantDbByPath(tenant.db_path);
    bootstrapTenant(db, {
      adminUsername: admin_username.trim(),
      adminPassword: admin_password,
      adminName: admin_name || '管理员',
      warehouseName: warehouse_name || '总仓'
    });
  } catch (e) {
    console.error(`创建租户 ${tenant.tenant_code} 的数据库失败，正在回滚:`, e);
    audit(req, 'create_tenant_failed', tenant, `初始化失败：${e.message}`);
    try {
      if (db) db.close();
    } catch (closeError) {
      console.error(`关闭失败租户 ${tenant.tenant_code} 的数据库连接时出错:`, closeError);
    }
    try {
      deleteTenantRecord(tenant.id);
      for (const suffix of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(tenant.db_path + suffix); } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
      }
    } catch (cleanupError) {
      console.error(`回滚失败租户 ${tenant.tenant_code} 时出错，需要人工处理:`, cleanupError);
      return res.status(500).render('platform_tenant_form', {
        error: '租户初始化失败且自动清理未完成，请查看服务日志并人工处理', form: req.body
      });
    }
    return res.status(500).render('platform_tenant_form', {
      error: '租户初始化失败，已自动回滚，请检查配置后重试', form: req.body
    });
  } finally {
    if (db && db.open) db.close();
  }

  audit(req, 'create_tenant', tenant,
    `租户名称=${tenant.name}；管理员账号=${admin_username.trim()}；到期=${quota.expiresAt || '不限'}；账号上限=${quota.maxUsers == null ? '不限' : quota.maxUsers}`);

  res.redirect('/platform-admin');
});

router.post('/platform-admin/tenants/:id/toggle', requireSuperAdmin, (req, res) => {
  const tenant = getTenantById(Number(req.params.id));
  if (tenant) {
    const newStatus = tenant.status === 'active' ? 'suspended' : 'active';
    setTenantStatus(tenant.id, newStatus);
    audit(req, 'toggle_status', tenant, `状态：${tenant.status} → ${newStatus}`);
  }
  res.redirect('/platform-admin');
});

router.get('/platform-admin/tenants/:id/edit', requireSuperAdmin, (req, res) => {
  const tenant = getTenantById(Number(req.params.id));
  if (!tenant) return res.status(404).send('租户不存在');

  // 特意不走 getTenantDb（那个会因为租户被暂停/过期而拒绝打开），
  // 超管应该无论租户是什么状态都能重置密码，这也是这次要修的问题本身。
  res.render('platform_tenant_edit', { error: null, tenant, tenantUsers: getTenantUsersSafe(tenant), pwError: null });
});

router.post('/platform-admin/tenants/:id/edit', requireSuperAdmin, (req, res) => {
  const tenant = getTenantById(Number(req.params.id));
  if (!tenant) return res.status(404).send('租户不存在');

  const { tenant_name } = req.body;
  if (!tenant_name || !tenant_name.trim()) {
    return res.render('platform_tenant_edit', {
      error: '租户名称不能为空', tenant: { ...tenant, ...req.body }, tenantUsers: getTenantUsersSafe(tenant), pwError: null
    });
  }
  const quota = parseQuotaFields(req.body);
  if (quota.error) {
    return res.render('platform_tenant_edit', {
      error: quota.error, tenant: { ...tenant, ...req.body }, tenantUsers: getTenantUsersSafe(tenant), pwError: null
    });
  }

  const before = { name: tenant.name, expires_at: tenant.expires_at, max_users: tenant.max_users };
  updateTenantLimits(tenant.id, { name: tenant_name.trim(), expiresAt: quota.expiresAt, maxUsers: quota.maxUsers });
  audit(req, 'update_limits', tenant,
    `名称：${before.name} → ${tenant_name.trim()}；到期：${before.expires_at || '不限'} → ${quota.expiresAt || '不限'}；账号上限：${before.max_users == null ? '不限' : before.max_users} → ${quota.maxUsers == null ? '不限' : quota.maxUsers}`);
  res.redirect('/platform-admin');
});

// 超管重置某个租户下指定账号的密码（不需要先登录进那个租户，也不管租户当前是否被暂停/已到期，
// 这就是专门用来解决"租户管理员忘了密码、又没有别的管理员账号能帮他重置"这种死锁场景的）
router.post('/platform-admin/tenants/:id/users/:userId/reset-password', requireSuperAdmin, (req, res) => {
  const tenant = getTenantById(Number(req.params.id));
  if (!tenant) return res.status(404).send('租户不存在');

  const { new_password } = req.body;
  const renderWithError = (error) => {
    res.render('platform_tenant_edit', {
      error: null, tenant, tenantUsers: getTenantUsersSafe(tenant), pwError: error
    });
  };

  if (!new_password || new_password.length < 6) {
    return renderWithError('新密码至少6位');
  }

  let resetUser = null;
  let db;
  try {
    db = openTenantDbByPath(tenant.db_path);
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(req.params.userId));
    if (!user) {
      db.close();
      return renderWithError('账号不存在');
    }
    resetUser = user;
    const hash = bcrypt.hashSync(new_password, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
    db.close();
  } catch (e) {
    console.error('超管重置租户账号密码失败:', e);
    if (db) { try { db.close(); } catch (_) { /* 忽略 */ } }
    return renderWithError('重置失败，请稍后重试');
  }

  // 只记"谁重置了哪个租户的哪个账号"，绝不记新密码本身
  audit(req, 'reset_user_password', tenant, `重置账号=${resetUser.username}（用户ID ${resetUser.id}）`);

  res.redirect(`/platform-admin/tenants/${tenant.id}/edit`);
});

// 供上面几个 render 分支复用：读取某租户的账号列表，读取失败就返回空数组，不让页面崩掉
function getTenantUsersSafe(tenant) {
  try {
    const db = openTenantDbByPath(tenant.db_path);
    const users = db.prepare('SELECT id, username, name, role, active FROM users ORDER BY id').all();
    db.close();
    return users;
  } catch (e) {
    console.error('读取租户账号列表失败:', e);
    return [];
  }
}

// ===== API Key 管理（超管专属）=====
// 供 n8n / Codex 等自动化工具调用的独立 REST API（/api/v1）在这里发 Key。
// 租户自己的设置页面不暴露任何入口，生成/吊销/改档位只在平台超管后台完成。

// 列表页 + 生成表单（?tenant_id= 可选过滤某个租户的 Key）
router.get('/platform-admin/api-keys', requireSuperAdmin, (req, res) => {
  const tenantId = req.query.tenant_id ? Number(req.query.tenant_id) : null;
  const tenants = listTenants();
  renderApiKeysPage(res, {
    tenants,
    filterTenantId: tenantId && tenants.some(t => t.id === tenantId) ? tenantId : null,
    keys: apiKeys.listApiKeys(tenantId && tenants.some(t => t.id === tenantId) ? tenantId : null),
    error: null,
    newKey: null
  });
});

// 生成新 Key：明文只在本次响应里展示一次（页面横幅提示"立即复制，关闭后无法再次查看"），
// 库里只存哈希，之后任何页面都查不回来。
router.post('/platform-admin/api-keys/generate', requireSuperAdmin, (req, res) => {
  const tenants = listTenants();
  const tenant = getTenantById(Number(req.body.tenant_id));
  const permissionLevel = req.body.permission_level;
  const renderPage = (page) => renderApiKeysPage(res, page);

  if (!tenant) {
    return renderPage({ tenants, filterTenantId: null, keys: apiKeys.listApiKeys(null), error: '请选择租户', newKey: null });
  }
  if (!apiKeys.isValidLevel(permissionLevel)) {
    return renderPage({ tenants, filterTenantId: tenant.id, keys: apiKeys.listApiKeys(tenant.id), error: '请选择权限档位', newKey: null });
  }

  const admin = req.session.platformAdmin;
  let created;
  try {
    created = apiKeys.generateApiKey({
      tenantId: tenant.id,
      permissionLevel,
      adminId: admin.id,
      adminUsername: admin.username
    });
  } catch (e) {
    return renderPage({ tenants, filterTenantId: tenant.id, keys: apiKeys.listApiKeys(tenant.id), error: e.message, newKey: null });
  }

  // 审计只记前缀和档位，绝不记明文
  audit(req, 'create_api_key', tenant,
    `Key前缀=${created.keyPrefix}…；档位=${apiKeys.LEVEL_LABELS[created.permissionLevel]}`);

  renderPage({
    tenants,
    filterTenantId: tenant.id,
    keys: apiKeys.listApiKeys(tenant.id),
    error: null,
    newKey: { ...created, tenantName: tenant.name }
  });
});

// 吊销：吊销后该 Key 立即无法调用任何 API 端点（下次请求哈希查不到未吊销记录，401）
router.post('/platform-admin/api-keys/:id/revoke', requireSuperAdmin, (req, res) => {
  const key = apiKeys.getApiKeyById(Number(req.params.id));
  if (key && apiKeys.revokeApiKey(key.id)) {
    const tenant = getTenantById(key.tenant_id);
    audit(req, 'revoke_api_key', tenant, `Key前缀=${key.key_prefix}…；档位=${apiKeys.LEVEL_LABELS[key.permission_level]}`);
  }
  res.redirect('/platform-admin/api-keys');
});

// 改权限档位：操作者已是登录态超管，简单二次确认即可（前端 confirm 弹窗）
router.post('/platform-admin/api-keys/:id/tier', requireSuperAdmin, (req, res) => {
  const key = apiKeys.getApiKeyById(Number(req.params.id));
  const newLevel = req.body.permission_level;
  if (!key) return res.status(404).send('API Key 不存在');
  if (!apiKeys.isValidLevel(newLevel)) return res.status(400).send('非法的权限档位');

  if (newLevel !== key.permission_level && apiKeys.updateApiKeyTier(key.id, newLevel)) {
    const tenant = getTenantById(key.tenant_id);
    audit(req, 'change_api_tier', tenant,
      `Key前缀=${key.key_prefix}…；档位：${apiKeys.LEVEL_LABELS[key.permission_level]} → ${apiKeys.LEVEL_LABELS[newLevel]}`);
  }
  res.redirect('/platform-admin/api-keys');
});

// Key 管理页统一渲染入口：列表始终带全租户名，表格按当前过滤条件展示
function renderApiKeysPage(res, { tenants, filterTenantId, keys, error, newKey }) {
  res.render('platform_api_keys', {
    tenants,
    filterTenantId,
    keys,
    error,
    newKey,
    levelLabels: apiKeys.LEVEL_LABELS,
    levelRanks: apiKeys.LEVEL_RANK
  });
}

module.exports = router;
