/**
 * 极简的登录防爆破限流：按 IP + 路径 记录"失败"次数，失败超过阈值就先拦一阵子。
 * 内存实现，重启会清空——防的是"短时间内狂刷密码"，不是长期黑名单。
 *
 * 注意计数口径（2026-09-06 调整）：只有"登录失败"才计入次数，成功登录会把计数清零。
 * 之前把成功请求也算进去，5 人团队共用一个出口 IP 时正常上班登录也会被误拦。
 *
 * 用法：
 *   const loginLimiter = createLoginLimiter({ windowMs, max });
 *   router.post('/login', loginLimiter, handler);
 *   // 凭据校验失败时：loginLimiter.fail(req)
 *   // 登录成功时：    loginLimiter.reset(req)
 */
function createLoginLimiter({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const attempts = new Map(); // key: "ip:path" -> { count, resetAt }

  // 定期清理过期记录，避免 Map 无限增长
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of attempts) {
      if (rec.resetAt < now) attempts.delete(key);
    }
  }, windowMs);
  cleanupTimer.unref?.();

  function keyOf(req) {
    return `${req.ip}:${req.path}`;
  }

  function loginLimiter(req, res, next) {
    const rec = attempts.get(keyOf(req));
    const now = Date.now();

    if (rec && rec.count >= max && rec.resetAt > now) {
      const waitMinutes = Math.ceil((rec.resetAt - now) / 60000);
      return res.status(429).send(`登录尝试过于频繁，请 ${waitMinutes} 分钟后再试`);
    }
    next();
  }

  /** 登录失败时调用：失败计数 +1（首次失败会开启一个新的惩罚窗口） */
  loginLimiter.fail = function (req) {
    const key = keyOf(req);
    const now = Date.now();
    let rec = attempts.get(key);
    if (!rec || rec.resetAt < now) {
      rec = { count: 0, resetAt: now + windowMs };
      attempts.set(key, rec);
    }
    rec.count += 1;
  };

  /** 登录成功时调用：清零该 IP 的失败计数 */
  loginLimiter.reset = function (req) {
    attempts.delete(keyOf(req));
  };

  return loginLimiter;
}

module.exports = { createLoginLimiter };
