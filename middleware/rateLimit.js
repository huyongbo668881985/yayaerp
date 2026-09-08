/**
 * 极简的登录防爆破限流：内存实现，重启会清空——防的是"短时间内狂刷密码"，不是长期黑名单。
 *
 * 双维度计数（2026-09-08 重构，修复"全平台共用一个限流桶"的互锁问题）：
 *   1. 账号桶  acct:{租户}:{用户名}:{path}  —— 防针对某个具体账号的爆破
 *   2. IP 桶   ip:{req.ip}:{path}          —— 防单 IP 大规模爆破/用户名枚举
 * 任一桶超限就拦。这样：
 *   - 某客户输错密码 10 次，只锁"他自己的账号"，不会把全平台所有人锁死
 *     （旧实现只有 IP 桶，Docker 反代下所有请求的 req.ip 相同，等于全平台一个桶）；
 *   - 攻击者换用户名枚举也逃不过 IP 桶（阈值放宽到 ipMax，兼顾办公室/家庭
 *     NAT 出口多人共用一个 IP 的正常登录）。
 *
 * 计数口径：只有"登录失败"才计入，成功登录会清零该账号桶 + 该 IP 桶，
 * 团队共用出口 IP 时正常上班登录不会被误拦。
 *
 * 用法（who 由 extractWho 从请求里取，通常是表单里的租户/用户名字段）：
 *   const loginLimiter = createLoginLimiter({
 *     windowMs, max,
 *     extractWho: req => ({ tenantCode: req.body.tenant_code, username: req.body.username })
 *   });
 *   router.post('/login', loginLimiter, handler);
 *   // 凭据校验失败时：loginLimiter.fail(req)
 *   // 登录成功时：    loginLimiter.reset(req)
 */
function createLoginLimiter({ windowMs = 15 * 60 * 1000, max = 10, ipMax = 30, extractWho = null } = {}) {
  const attempts = new Map(); // key -> { count, resetAt }

  // 定期清理过期记录，避免 Map 无限增长
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of attempts) {
      if (rec.resetAt < now) attempts.delete(key);
    }
  }, windowMs);
  cleanupTimer.unref?.();

  function keyOf(req) {
    return `ip:${req.ip}:${req.path}`;
  }

  // 租户/用户名要进 key，但值来自用户输入，先收窄字符集：
  // 防止拼接出"别人的桶"，也防止超长字符串把 Map 撑大。
  function sanitize(v) {
    return String(v || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  }

  function acctKeyOf(req) {
    const who = (extractWho && extractWho(req)) || {};
    return `acct:${sanitize(who.tenantCode)}:${sanitize(who.username)}:${req.path}`;
  }

  function hasWho(req) {
    const who = (extractWho && extractWho(req)) || {};
    return !!(who.tenantCode || who.username);
  }

  function overLimit(req, key, limit) {
    const rec = attempts.get(key);
    return !!(rec && rec.count >= limit && rec.resetAt > Date.now());
  }

  function loginLimiter(req, res, next) {
    if (overLimit(req, keyOf(req), ipMax) || overLimit(req, acctKeyOf(req), max)) {
      const rec = attempts.get(acctKeyOf(req)) || attempts.get(keyOf(req));
      const waitMinutes = Math.ceil((rec.resetAt - Date.now()) / 60000);
      return res.status(429).send(`登录尝试过于频繁，请 ${waitMinutes} 分钟后再试`);
    }
    next();
  }

  /** 记录一次失败：IP 桶 +1；能取到租户/用户名时账号桶也 +1 */
  loginLimiter.fail = function (req) {
    const now = Date.now();
    const keys = [keyOf(req)];
    if (hasWho(req)) keys.push(acctKeyOf(req));
    for (const key of keys) {
      let rec = attempts.get(key);
      if (!rec || rec.resetAt < now) {
        rec = { count: 0, resetAt: now + windowMs };
        attempts.set(key, rec);
      }
      rec.count += 1;
    }
  };

  /** 登录成功时调用：清掉该账号桶与该 IP 桶的失败计数 */
  loginLimiter.reset = function (req) {
    attempts.delete(keyOf(req));
    if (hasWho(req)) attempts.delete(acctKeyOf(req));
  };

  return loginLimiter;
}

module.exports = { createLoginLimiter };
