/**
 * 通用滑动窗口频率限制器，内存实现，单进程够用。
 * 跟 middleware/rateLimit.js（登录防爆破专用）是两回事，这个更通用，
 * 按任意 key（手机号、IP等）+ 时间窗口 + 次数上限来限制。
 */
class RateLimiter {
  constructor() {
    this.hits = new Map();
  }

  /** 返回 true = 本次没超限，false = 超限。key 例如 `phone:138xxxx` 或 `ip:1.2.3.4` */
  hit(key, windowMs, max) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter(t => now - t < windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length <= max;
  }
}

module.exports = new RateLimiter();
