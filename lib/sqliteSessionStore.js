const session = require('express-session');
const Database = require('better-sqlite3');

/**
 * 一个极简的 express-session Store 实现，用 better-sqlite3 持久化 session。
 * 之所以不用 connect-sqlite3：它依赖另一套 sqlite3 原生驱动，跟当前 Node 版本
 * 装不上（会报 this.db.exec is not a function），而项目本来就用 better-sqlite3，
 * 自己写这几十行更省心也更可控。
 */
class SqliteSessionStore extends session.Store {
  constructor(dbPath) {
    super();
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      )
    `);
    // 定期清理过期 session，避免文件无限增长
    this._cleanupTimer = setInterval(() => this._cleanupExpired(), 60 * 60 * 1000);
    this._cleanupTimer.unref?.();
  }

  _cleanupExpired() {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    } catch (e) { /* 忽略清理失败，不影响主流程 */ }
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) {
        this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (e) {
      cb(e);
    }
  }

  set(sid, sessionData, cb) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 7 * 24 * 60 * 60 * 1000;
      const expires = Date.now() + maxAge;
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
      `).run(sid, JSON.stringify(sessionData), expires);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb(null);
    } catch (e) {
      cb && cb(e);
    }
  }

  touch(sid, sessionData, cb) {
    this.set(sid, sessionData, cb);
  }
}

module.exports = SqliteSessionStore;
