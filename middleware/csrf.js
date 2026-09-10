const crypto = require('crypto');

function issueCsrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function tokensMatch(expected, supplied) {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function csrfProtection(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const supplied = req.body && req.body._csrf || req.headers['x-csrf-token'];
  if (tokensMatch(req.session.csrfToken, supplied)) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(403).json({ ok: false, message: '请求已过期，请刷新页面后重试' });
  }
  return res.status(403).send('请求已过期或来源无效，请刷新页面后重试');
}

module.exports = { issueCsrfToken, csrfProtection, tokensMatch };
