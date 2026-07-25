/**
 * 极简的登录限流：按 IP + 路径 记录失败次数，超过阈值就先拦一阵子。
 * 内存实现，重启会清空——对于登录防爆破这个场景足够了，不需要为此引入额外依赖
 * 或持久化存储（防的是"短时间内狂刷密码"，不是长期黑名单）。
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

  return function loginLimiter(req, res, next) {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let rec = attempts.get(key);

    if (!rec || rec.resetAt < now) {
      rec = { count: 0, resetAt: now + windowMs };
      attempts.set(key, rec);
    }

    if (rec.count >= max) {
      const waitMinutes = Math.ceil((rec.resetAt - now) / 60000);
      return res.status(429).send(`登录尝试过于频繁，请 ${waitMinutes} 分钟后再试`);
    }

    rec.count += 1;
    next();
  };
}

module.exports = { createLoginLimiter };
