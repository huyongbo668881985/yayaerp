const { platformDb } = require('./platformDb');

// 试用申请记录存在 platform.db 里，跟 tenants 表同一个库，不需要单独建库文件。
// （历史的 verification_codes 表已废弃：短信验证码改由阿里云"短信认证服务"生成和校验，
// 见 lib/smsGateway.js。老库里已存在的该表不影响运行，只是不再读写。）
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
`);

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

module.exports = {
  isPhoneAlreadyTrialed,
  recordTrialRequest
};
