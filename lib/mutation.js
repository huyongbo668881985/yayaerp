const crypto = require('crypto');
const { runWithDocumentAudit } = require('./auditLog');

function rememberCompletedDraft(req) {
  if (!/^\/(sales|returns|transfers|purchases)\/(new|\d+\/edit)$/.test(req.path)) return;
  req.session.completedDraftKeys = [...(req.session.completedDraftKeys || []), req.body._request_key].slice(-20);
}

function payloadHash(body) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const { _csrf, _request_key, ...payload } = body;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

function existingResult(req) {
  const row = req.tenantDb.prepare(`SELECT payload_hash, result_json FROM mutation_requests
    WHERE user_id = ? AND route = ? AND request_key = ?`)
    .get(req.session.user.id, req.path, req.body._request_key);
  if (!row) return null;
  if (row.payload_hash !== payloadHash(req.body)) {
    const error = new Error('这次提交已处理，但内容发生了变化。请刷新页面后重新填写，避免重复记账。');
    error.status = 409;
    throw error;
  }
  return JSON.parse(row.result_json);
}

// 重试先返回原结果；业务操作与去重记录在同一个写事务中提交，跨进程也只执行一次。
function requireMutationKey(req, res, next) {
  const key = req.body._request_key;
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{20,100}$/.test(key)) {
    return res.status(400).send('提交凭证缺失或无效，请刷新页面后重试。');
  }
  try {
    const result = existingResult(req);
    if (result) { rememberCompletedDraft(req); return res.redirect(result.redirect); }
    next();
  } catch (error) {
    if (error.status) return res.status(error.status).send(error.message);
    next(error);
  }
}

function completeMutation(req, res, work) {
  try {
    const result = req.tenantDb.transaction(() => {
      const existing = existingResult(req);
      if (existing) return existing;
      const result = runWithDocumentAudit(req, work);
      if (!result.error) {
        req.tenantDb.prepare(`INSERT INTO mutation_requests
          (user_id, route, request_key, payload_hash, result_json) VALUES (?,?,?,?,?)`)
          .run(req.session.user.id, req.path, req.body._request_key, payloadHash(req.body), JSON.stringify(result));
      }
      return result;
    }).immediate();
    if (result.error) {
      if (result.errorRedirect) return res.redirect(result.errorRedirect);
      if (result.status === 409 && req.path.endsWith('/edit')) return res.status(409).render('global_error', { message: result.error, returnTo: req.path, returnLabel: '重新打开单据核对' });
      return res.status(result.status).send(result.error);
    }
    rememberCompletedDraft(req);
    req.session.flashSuccess = '单据已保存，请核对当前审核状态。';
    return res.redirect(result.redirect);
  } catch (error) {
    if (error.status) return res.status(error.status).send(error.message);
    throw error;
  }
}

// 库存状态流转：状态检查、明细读取、库存与审计必须在同一个写事务中。
function completeTransaction(req, res, work) {
  const result = req.tenantDb.transaction(() => runWithDocumentAudit(req, work)).immediate();
  if (result.error) return res.status(result.status).send(result.error);
  req.session.flashSuccess = '操作已完成，单据状态已更新。';
  return res.redirect(result.redirect);
}

module.exports = { requireMutationKey, completeMutation, completeTransaction };
