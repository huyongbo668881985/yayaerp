const express = require('express');
const router = express.Router();

const { isPhoneAlreadyTrialed } = require('../lib/trialDb');
const { sendVerifyCode, checkVerifyCode } = require('../lib/smsGateway');
const { registerTrialAccount } = require('../lib/trialProvision');
const { sendTextMessage } = require('../lib/feishuBot');
const { sendTrialNotificationEmail } = require('../lib/mailer');
const rateLimiter = require('../lib/rateLimiter');

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

// 第一步：发送验证码
router.post('/api/trial/send-code', express.json(), async (req, res) => {
  const { phone, hp } = req.body || {};

  // 蜜罐字段：正常用户看不到、也不会填这个字段；填了说明大概率是脚本。
  // 假装成功返回，不告诉对方被识别了。
  if (hp) return res.json({ ok: true });

  if (!PHONE_PATTERN.test(phone || '')) {
    return res.status(400).json({ ok: false, message: '手机号格式不正确' });
  }
  if (isPhoneAlreadyTrialed(phone)) {
    return res.status(409).json({ ok: false, message: '该手机号已经开通过试用了' });
  }

  const ip = req.ip;
  if (!rateLimiter.hit(`code:phone:${phone}`, 60 * 1000, 1)) {
    return res.status(429).json({ ok: false, message: '发送太频繁，请 60 秒后再试' });
  }
  if (!rateLimiter.hit(`code:phone:${phone}:daily`, 24 * 60 * 60 * 1000, 5)) {
    return res.status(429).json({ ok: false, message: '今天获取验证码次数太多了' });
  }
  if (!rateLimiter.hit(`code:ip:${ip}`, 60 * 60 * 1000, 10)) {
    return res.status(429).json({ ok: false, message: '请求过多，请稍后再试' });
  }

  try {
    // 短信认证服务：验证码由阿里云生成和下发，我们不经手验证码本身
    await sendVerifyCode(phone);
    res.json({ ok: true });
  } catch (err) {
    console.error('[trialAuth] 发送验证码失败:', err);
    res.status(500).json({ ok: false, message: '验证码发送失败，请稍后重试' });
  }
});

// 第二步：校验验证码，通过后立即自动开通
router.post('/api/trial/verify-and-register', express.json(), async (req, res) => {
  const { phone, code, company, contact, wechat, teamsize, hp } = req.body || {};

  if (hp) return res.status(400).json({ ok: false, message: '提交失败' });

  if (!PHONE_PATTERN.test(phone || '') || !code || !company || !contact || !teamsize) {
    return res.status(400).json({ ok: false, message: '请填写完整信息' });
  }
  if (isPhoneAlreadyTrialed(phone)) {
    return res.status(409).json({ ok: false, message: '该手机号已经开通过试用了' });
  }

  // 校验次数限流：防止拿这个接口暴力猜验证码（6 位数字 + 阿里云 5 分钟有效期，
  // 每个手机号 10 分钟内最多试 10 次，远不够猜中）
  if (!rateLimiter.hit(`check:phone:${phone}`, 10 * 60 * 1000, 10)) {
    return res.status(429).json({ ok: false, message: '尝试次数太多，请 10 分钟后再试' });
  }

  try {
    // 短信认证服务：把用户输入交给阿里云核对，返回 PASS / UNKNOWN
    const check = await checkVerifyCode(phone, String(code).trim());
    if (!check.pass) {
      return res.status(400).json({ ok: false, message: '验证码不正确或已过期，请重新输入' });
    }
  } catch (err) {
    console.error('[trialAuth] 验证码校验失败:', err);
    return res.status(500).json({ ok: false, message: '验证失败，请稍后重试' });
  }

  try {
    const account = await registerTrialAccount({ company, contact, phone, wechat, teamsize });

    // 异步通知你自己，纯粹是让你知道有新用户，不影响用户已经能直接登录
    Promise.allSettled([
      sendTextMessage(
        `🎉 新试用账号自助开通\n公司：${company}\n联系人：${contact}（${phone}）\n租户代码：${account.tenantCode}\n到期时间：${account.expiresAt}`
      ),
      sendTrialNotificationEmail({ company, contact, phone, wechat, teamsize, tenantCode: account.tenantCode })
    ]).then(results => {
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(`[trialAuth] 通知发送失败(${i}):`, r.reason);
      });
    });

    res.json({
      ok: true,
      tenantCode: account.tenantCode,
      username: account.adminUsername,
      password: account.adminPassword,
      loginUrl: `/login?tenant_code=${encodeURIComponent(account.tenantCode)}`,
      expiresAt: account.expiresAt
    });
  } catch (err) {
    console.error('[trialAuth] 创建试用账号失败:', err);
    // 同一手机号并发重复提交时，trial_requests.phone 的 UNIQUE 约束会兜底拦住
    // （trialProvision 里建租户和记录在同一事务），这里按"已开通"返回，而不是 500。
    if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ ok: false, message: '该手机号已经开通过试用了' });
    }
    res.status(500).json({ ok: false, message: '开通失败，请稍后重试或联系客服' });
  }
});

module.exports = router;
