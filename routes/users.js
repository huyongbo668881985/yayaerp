const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth');
const { writeAuditLog } = require('../lib/auditLog');
const { isValidDateString } = require('../lib/validators');
const { sendCsv } = require('../utils/csv');
const { formatDateTime } = require('../utils/dates');
const { updateUserPassword } = require('../lib/accountSecurity');
const router = express.Router();

const USER_FIELDS = 'id, username, name, role, active, audit_log_owner, created_at';

function requireAuditLogViewer(req, res, next) {
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const user = req.tenantDb.prepare('SELECT audit_log_owner FROM users WHERE id=?').get(req.session.user.id);
  if (!user || !user.audit_log_owner) return res.status(403).send('无权限查看操作日志');
  next();
}

router.get('/users', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY id`).all();
  res.render('users', { users, error: null, maxUsers: req.tenant.max_users || null });
});

function auditFilters(query) {
  const start = String(query.start || ''), end = String(query.end || '');
  if ((start && !isValidDateString(start)) || (end && !isValidDateString(end)) || (start && end && start > end)) throw new Error('请填写有效日期，结束日期不能早于开始日期');
  const filters = { start, end, user_id: String(query.user_id || ''), action: String(query.action || '').slice(0, 100), entity_type: String(query.entity_type || ''), entity_id: String(query.entity_id || '') };
  for (const key of ['user_id', 'entity_id']) if (filters[key] && !/^[1-9]\d{0,14}$/.test(filters[key])) throw new Error('操作人或单号无效');
  const clauses = [], params = [];
  if (start) { clauses.push('created_at >= ?'); params.push(new Date(start + 'T00:00:00+08:00').toISOString().slice(0,19).replace('T',' ')); }
  if (end) { clauses.push('created_at < ?'); params.push(new Date(new Date(end + 'T00:00:00+08:00').getTime() + 86400000).toISOString().slice(0,19).replace('T',' ')); }
  for (const key of ['user_id', 'action', 'entity_type', 'entity_id']) if (filters[key]) { clauses.push(key + '=?'); params.push(filters[key]); }
  return { filters, where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

function auditChanges(log) {
  let details; try { details = JSON.parse(log.details_json || '{}'); } catch (_) { details = {}; }
  const before = details.before?.fields || {}, after = details.after?.fields || {};
  const display = value => value === '' ? '（空）' : value ?? '—';
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => before[key] !== after[key] && !(before[key] == null && after[key] === ''))
    .map(key => ({ label: key, before: display(before[key]), after: display(after[key]) }));
  return { ...log, changes, beforeItems: details.before?.items || [], afterItems: details.after?.items || [], stock: details.stock || [],
    itemChanges: JSON.stringify(details.before?.items || []) !== JSON.stringify(details.after?.items || []) };
}

router.get('/users/audit-logs', requireAdmin, requireAuditLogViewer, (req, res) => {
  let query; try { query = auditFilters(req.query); } catch (error) { return res.status(400).render('global_error', { message: error.message }); }
  const db = req.tenantDb, total = db.prepare('SELECT COUNT(*) n FROM audit_logs' + query.where).get(...query.params).n;
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const page = Math.min(pageCount, Math.max(1, Number(req.query.page) || 1));
  const logs = db.prepare('SELECT * FROM audit_logs' + query.where + ' ORDER BY id DESC LIMIT 50 OFFSET ?').all(...query.params, (Math.floor(page)-1)*50).map(auditChanges);
  const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY id`).all();
  const actions = db.prepare('SELECT DISTINCT action FROM audit_logs ORDER BY action').all().map(row => row.action);
  const entityTypes = db.prepare('SELECT DISTINCT entity_type FROM audit_logs ORDER BY entity_type').all().map(row => row.entity_type);
  const queryString = new URLSearchParams(Object.entries(query.filters).filter(([,value]) => value)).toString();
  res.render('audit_logs', { logs, users, actions, entityTypes, filters: query.filters, page: Math.floor(page), pageCount, total, queryString });
});

router.get('/users/audit-logs/export', requireAdmin, requireAuditLogViewer, (req, res) => {
  let query; try { query = auditFilters(req.query); } catch (error) { return res.status(400).render('global_error', { message: error.message }); }
  const count = req.tenantDb.prepare('SELECT COUNT(*) n FROM audit_logs' + query.where).get(...query.params).n;
  if (count > 10000) return res.status(400).render('global_error', { message: '一次最多导出 10000 条日志，请缩小日期或筛选范围。' });
  const logs = req.tenantDb.prepare('SELECT * FROM audit_logs' + query.where + ' ORDER BY id DESC').all(...query.params).map(auditChanges);
  const rows = logs.map(log => [log.id, formatDateTime(log.created_at), log.user_name, log.action, log.entity_type, log.entity_id,
    log.summary, log.changes.map(change => `${change.label}：${change.before} → ${change.after}`).join('；'),
    JSON.stringify(log.beforeItems), JSON.stringify(log.afterItems), JSON.stringify(log.stock), log.request_id]);
  sendCsv(res, '操作日志.csv', ['日志编号','时间（北京时间）','操作人','动作','对象','单号','说明','字段变化','原商品明细','新商品明细','库存变化','请求编号'], rows);
});

router.post('/users/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { username, password, name, role } = req.body;
  if (!username || !password || !name || !['admin','operator'].includes(role)) {
    const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY id`).all();
    return res.render('users', { users, error: '请完整填写信息，密码不能为空', maxUsers: req.tenant.max_users || null });
  }
  // 与"重置密码"保持同一强度：新账号密码也至少 6 位
  if (password.length < 6) {
    const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY id`).all();
    return res.render('users', { users, error: '密码至少6位', maxUsers: req.tenant.max_users || null });
  }
  if (req.tenant.max_users) {
    const currentCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    if (currentCount >= req.tenant.max_users) {
      const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY id`).all();
      return res.render('users', { users, error: `账号数已达上限（${req.tenant.max_users}个），如需更多请联系平台管理员`, maxUsers: req.tenant.max_users || null });
    }
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)').run(username, hash, name, role);
    writeAuditLog(db, req.session.user, '新增账号', '账号', info.lastInsertRowid, `新增${role === 'admin' ? '管理员' : '操作员'}：${name}`);
    res.redirect('/users');
  } catch (e) {
    const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY id`).all();
    res.render('users', { users, error: '用户名已存在', maxUsers: req.tenant.max_users || null });
  }
});

// 禁用/启用账号：员工离职、闹矛盾这类场景优先用这个，而不是直接删除
// —— 一是禁用立刻生效（下一次请求就会被踢出去，见 middleware/auth.js），
//    二是不会破坏这个账号名下历史单据的"录入人"归属。
router.post('/users/:id/toggle-active', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const targetId = Number(req.params.id);
  if (targetId === req.session.user.id) {
    return res.status(400).send('不能禁用自己当前登录的账号');
  }
  const target = db.prepare('SELECT active, audit_log_owner FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('账号不存在');
  if (target.audit_log_owner) return res.status(400).send('不能禁用操作日志所有者账号');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(target.active ? 0 : 1, targetId);
  writeAuditLog(db, req.session.user, target.active ? '禁用账号' : '启用账号', '账号', targetId, '账号状态变更');
  res.redirect('/users');
});

router.post('/users/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const targetId = Number(req.params.id);
  if (targetId === req.session.user.id) {
    return res.status(400).send('不能删除自己当前登录的账号');
  }
  const owner = db.prepare('SELECT audit_log_owner FROM users WHERE id=?').get(targetId);
  if (owner && owner.audit_log_owner) return res.status(400).send('不能删除操作日志所有者账号');
  const refCount =
    db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE user_id = ? OR responsible_id = ?').get(targetId, targetId).c +
    db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM transfer_orders WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM return_orders WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM stock_transactions WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM warehouses WHERE operator_id = ?').get(targetId).c;
  // return_orders 也要查（与 products.js 的同类检查对齐）：漏查的话有退货记录的账号
  // 会走到外键约束报错，用户看到的是难懂的全局兑底提示
  if (refCount > 0) {
    return res.status(400).send('无法删除：该账号名下有历史单据或归属仓库，删除会破坏历史记录或导致车辆失去负责人。请先转移仓库归属；如只是离职，建议改用“禁用”。');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  writeAuditLog(db, req.session.user, '删除账号', '账号', targetId, '删除无历史记录账号');
  res.redirect('/users');
});

router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).send('新密码至少6位');
  const target = db.prepare('SELECT id, audit_log_owner FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).send('账号不存在');
  if (target.audit_log_owner && target.id !== req.session.user.id) {
    return res.status(403).render('global_error', { message: '日志所有者的密码只能由本人修改，忘记密码请联系平台管理员。', returnTo: '/users' });
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.transaction(() => {
    updateUserPassword(db, target.id, hash);
    writeAuditLog(db, req.session.user, '重置密码', '账号', target.id, '重置账号密码并撤销旧登录');
  }).immediate();
  if (target.id === req.session.user.id) req.session.user.authVersion += 1;
  res.redirect('/users');
});

module.exports = router;
