const express = require('express');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// 恢复前确认提交结果；只读取当前租户、当前账号自己的提交凭证。
router.get('/drafts/result', requireLogin, (req, res) => {
  const key = String(req.query.key || ''), route = String(req.query.route || '');
  res.set('Cache-Control', 'no-store');
  if (!/^[a-zA-Z0-9_-]{20,100}$/.test(key) || !/^\/(sales|returns|transfers|purchases)\/(new|\d+\/edit)$/.test(route)) return res.status(400).json({ error: '无效草稿凭证' });
  const row = req.tenantDb.prepare('SELECT result_json FROM mutation_requests WHERE user_id=? AND route=? AND request_key=?')
    .get(req.session.user.id, route, key);
  res.json(row ? { completed: true, redirect: JSON.parse(row.result_json).redirect } : { completed: false });
});
module.exports = router;
