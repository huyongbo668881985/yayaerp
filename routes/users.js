const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();

const USER_FIELDS = 'id, username, name, role, active, created_at';

router.get('/users', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const users = db.prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY id`).all();
  res.render('users', { users, error: null, maxUsers: req.tenant.max_users || null });
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
    db.prepare('INSERT INTO users (username, password_hash, name, role) VALUES (?,?,?,?)').run(username, hash, name, role);
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
  const target = db.prepare('SELECT active FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).send('账号不存在');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(target.active ? 0 : 1, targetId);
  res.redirect('/users');
});

router.post('/users/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const targetId = Number(req.params.id);
  if (targetId === req.session.user.id) {
    return res.status(400).send('不能删除自己当前登录的账号');
  }
  const refCount =
    db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM transfer_orders WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM return_orders WHERE user_id = ?').get(targetId).c +
    db.prepare('SELECT COUNT(*) c FROM stock_transactions WHERE user_id = ?').get(targetId).c;
  // return_orders 也要查（与 products.js 的同类检查对齐）：漏查的话有退货记录的账号
  // 会走到外键约束报错，用户看到的是难懂的全局兑底提示
  if (refCount > 0) {
    return res.status(400).send('无法删除：该账号名下有历史单据记录，删除会破坏单据的录入人信息。建议改用"禁用"，既能立刻收回权限，又能保留历史记录。');
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.redirect('/users');
});

router.post('/users/:id/reset-password', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).send('新密码至少6位');
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.status(404).send('账号不存在');
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, target.id);
  res.redirect('/users');
});

module.exports = router;
