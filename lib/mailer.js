/**
 * 邮件知会通知
 * 需要先: npm install nodemailer
 * SMTP 用你自己邮箱的发信服务即可（QQ邮箱/163邮箱开启SMTP拿授权码，或企业邮箱）。
 */
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  return transporter;
}

async function sendTrialNotificationEmail({ company, contact, phone, wechat, teamsize, tenantCode }) {
  if (!process.env.SMTP_HOST || !process.env.NOTIFY_EMAIL) {
    console.warn('[mailer] 未配置 SMTP 或 NOTIFY_EMAIL，跳过邮件通知');
    return null;
  }
  return getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `【鸭鸭进销存】新试用账号自助开通 - ${company}`,
    text: [
      `公司/团队：${company}`,
      `联系人：${contact}`,
      `手机号：${phone}`,
      `微信号：${wechat || '未填写'}`,
      `团队人数：${teamsize}`,
      `租户代码：${tenantCode || '(见系统)'}`,
      '',
      '此账号已自动开通，无需处理，仅作知会。'
    ].join('\n')
  });
}

/**
 * 备份任务告警邮件（rclone 同步失败/快照失败时调用）。
 * - 收件人走 BACKUP_ALERT_EMAIL 环境变量，不硬编码
 * - 未配置 SMTP 或收件人时只记日志返回 null，不影响备份任务本身
 * - 调用方仍需自行 try/catch：邮件服务本身也可能挂
 */
async function sendBackupAlertEmail({ subject, text }) {
  if (!process.env.SMTP_HOST || !process.env.BACKUP_ALERT_EMAIL) {
    console.warn('[mailer] 未配置 SMTP_HOST 或 BACKUP_ALERT_EMAIL，跳过备份告警邮件');
    return null;
  }
  return getTransporter().sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.BACKUP_ALERT_EMAIL,
    subject: `【鸭鸭进销存】${subject}`,
    text
  });
}

module.exports = { sendTrialNotificationEmail, sendBackupAlertEmail };
