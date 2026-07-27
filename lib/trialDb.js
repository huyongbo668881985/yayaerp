const crypto = require('crypto');
const { platformDb } = require('./platformDb');

// 试用申请记录 + 短信验证码，都存在 platform.db 里，跟 tenants 表同一个库，
// 不需要单独建库文件。
platformDb.exec(`
CREATE TABLE IF NOT EXISTS trial_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  contact TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  wechat TEXT,
  team_size INTEGER NOT NULL,
  tenant_code TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'trial_register',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verification_codes_phone ON verification_codes(phone);
`);

const CODE_TTL_MS = 5 * 60 * 1000; // 验证码 5 分钟有效
const MAX_ATTEMPTS = 5;             // 最多允许错 5 次，超过则该验证码作废

function isPhoneAlreadyTrialed(phone) {
  const row = platformDb.prepare('SELECT id FROM trial_requests WHERE phone = ?').get(phone);
  return !!row;
}

function recordTrialRequest({ company, contact, phone, wechat, teamsize, tenantCode }) {
  platformDb.prepare(`
    INSERT INTO trial_requests (company, contact, phone, wechat, team_size, tenant_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(company, contact, phone, wechat || null, teamsize, tenantCode);
}

function createVerificationCode(phone, purpose = 'trial_register') {
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();
  platformDb.prepare(`
    INSERT INTO verification_codes (phone, code, purpose, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(phone, code, purpose, expiresAt);
  return code;
}

/** 返回 { ok: true } 或 { ok: false, reason } */
function verifyCode(phone, inputCode, purpose = 'trial_register') {
  const row = platformDb.prepare(`
    SELECT * FROM verification_codes
    WHERE phone = ? AND purpose = ? AND consumed_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(phone, purpose);

  if (!row) return { ok: false, reason: 'not_found' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  if (row.code !== inputCode) {
    platformDb.prepare(`UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
    return { ok: false, reason: 'mismatch' };
  }

  platformDb.prepare(`UPDATE verification_codes SET consumed_at = datetime('now') WHERE id = ?`).run(row.id);
  return { ok: true };
}

module.exports = {
  isPhoneAlreadyTrialed,
  recordTrialRequest,
  createVerificationCode,
  verifyCode
};
