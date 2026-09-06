/**
 * 通用滑动窗口频率限制器，内存实现，单进程够用。
 * 跟 middleware/rateLimit.js（登录防爆破专用）是两回事，这个更通用，
 * 按任意 key（手机号、IP等）+ 时间窗口 + 次数上限来限制。
 *
 * 每个 key 记录自己的时间窗口，定时任务会清掉窗口内没有请求的 key，
 * 避免 Map 随着手机号/IP 的增多无限膨胀。
 */
class RateLimiter {
  constructor() {
    this.hits = new Map(); // key -> { times: number[], windowMs }
    // 每 5 分钟清理一次过期记录；unref 保证不阻止进程退出
    this._cleanupTimer = setInterval(() => this._cleanup(), 5 * 60 * 1000);
    this._cleanupTimer.unref?.();
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      entry.times = entry.times.filter(t => now - t < entry.windowMs);
      if (entry.times.length === 0) this.hits.delete(key);
    }
  }

  /** 返回 true = 本次没超限，false = 超限。key 例如 `phone:138xxxx` 或 `ip:1.2.3.4` */
  hit(key, windowMs, max) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry) {
      entry = { times: [], windowMs };
      this.hits.set(key, entry);
    }
    entry.times = entry.times.filter(t => now - t < windowMs);
    entry.times.push(now);
    return entry.times.length <= max;
  }
}

module.exports = new RateLimiter();
