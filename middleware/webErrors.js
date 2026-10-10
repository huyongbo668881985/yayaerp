// 浏览器业务错误保留安全的返回入口；JSON/API 响应保持原格式。
module.exports = function webErrors(req, res, next) {
  res.locals.returnTo = req.session?.lastPage || '/';
  const send = res.send;
  res.send = function(body) {
    if (res.statusCode >= 400 && typeof body === 'string' && !body.trim().startsWith('<') && !req.path.startsWith('/api/') && !res.get('Content-Type')?.includes('json')) {
      return res.render('global_error', { message: body, returnTo: req.session?.lastPage || '/', requestId: req.requestId });
    }
    return send.call(this, body);
  };
  next();
};
