/**
 * 阿里云「短信认证服务」封装（dypnsapi）
 *
 * 注意产品线：本项目用的是「短信认证服务」，不是传统「短信服务(dysmsapi)」。
 * 签名和模板不需要自己申请（不用走审核），但也不是完全不传——
 * 阿里云会赠送系统签名和模板，需要在控制台两个页面选用后把名称/Code 传进来：
 *   - 赠送签名配置：https://dypns.console.aliyun.com/smsCertParamsConfig/sign
 *   - 赠送模板配置：https://dypns.console.aliyun.com/smsCertParamsConfig/template
 * （官方文档：暂不支持自定义签名，必须用赠送签名；赠送签名必须搭配赠送模板）
 *
 * 验证码的生成、有效期、防刷都由阿里云处理：
 *   - 发送：SendSmsVerifyCode，TemplateParam 用 "##code##" 占位符，系统生成真实验证码
 *   - 校验：CheckSmsVerifyCode，返回 PASS / UNKNOWN，我们不需要存验证码
 *
 * 端点：dypnsapi.aliyuncs.com；SDK：@alicloud/dypnsapi20170525（请求类是命名导出）
 * 计费：仅收短信发送费，按运营商回执计费；核验免费。
 */

const DypnsapiPackage = require('@alicloud/dypnsapi20170525');
const Dypnsapi = DypnsapiPackage.default; // 客户端类
const { SendSmsVerifyCodeRequest, CheckSmsVerifyCodeRequest } = DypnsapiPackage;
const OpenApi = require('@alicloud/openapi-client');
const Util = require('@alicloud/tea-util');

// 与官网注册页保持一致：6 位纯数字验证码、5 分钟有效、60 秒重发间隔
const CODE_LENGTH = 6;
const VALID_SECONDS = 300;
const RESEND_INTERVAL = 60;
// 模板变量占位符：##code## 由系统生成真实验证码后替换。
// 注意：min 的值要与 VALID_SECONDS 对应（300 秒 = 5 分钟）。
// 如果选用的赠送模板内容里没有 ${min} 变量，在 .env 里把
// ALIYUN_SMS_TEMPLATE_PARAM 设为 {"code":"##code##"} 即可。
const DEFAULT_TEMPLATE_PARAM = '{"code":"##code##","min":"5"}';

function createClient() {
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET
  });
  config.endpoint = 'dypnsapi.aliyuncs.com';
  return new Dypnsapi(config);
}

/** 配置缺失时给出能看懂的报错 */
function assertSmsAuthConfigured() {
  const required = [
    'ALIYUN_ACCESS_KEY_ID',
    'ALIYUN_ACCESS_KEY_SECRET',
    'ALIYUN_SMS_SIGN_NAME',
    'ALIYUN_SMS_TEMPLATE_CODE'
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `短信认证服务未配置：缺少环境变量 ${missing.join('、')}。` +
      `请在 .env 里补齐（签名和模板用控制台"赠送签名/赠送模板配置"页面里的值），并重启服务。`
    );
  }
}

/**
 * 发送短信验证码（验证码由阿里云生成和下发，我们拿不到也不需要拿到）
 * 返回 { bizId }；失败抛错
 */
async function sendVerifyCode(phone) {
  assertSmsAuthConfigured();
  const client = createClient();
  const request = new SendSmsVerifyCodeRequest({
    phoneNumber: phone,
    signName: process.env.ALIYUN_SMS_SIGN_NAME,          // 控制台"赠送签名配置"里选的签名
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE,  // 控制台"赠送模板配置"里选的模板
    templateParam: process.env.ALIYUN_SMS_TEMPLATE_PARAM || DEFAULT_TEMPLATE_PARAM,
    codeLength: CODE_LENGTH,
    codeType: 1,          // 纯数字
    validTime: VALID_SECONDS,
    interval: RESEND_INTERVAL
  });
  const result = await client.sendSmsVerifyCodeWithOptions(request, new Util.RuntimeOptions({}));
  if (result.body.code !== 'OK' || !result.body.success) {
    throw new Error(`验证码发送失败: ${result.body.code} ${result.body.message}`);
  }
  return { bizId: (result.body.model && result.body.model.bizId) || null };
}

/**
 * 校验用户输入的验证码，返回 { pass: true/false }
 * 注意：验证码错误/过期时阿里云不是返回 UNKNOWN，而是抛 isv.ValidateFail(400)，
 * 这里要把它转成 pass:false，让上层走"验证码不正确"的正常业务提示而不是 500。
 */
async function checkVerifyCode(phone, inputCode) {
  assertSmsAuthConfigured();
  const client = createClient();
  const request = new CheckSmsVerifyCodeRequest({
    phoneNumber: phone,
    verifyCode: inputCode
  });
  let result;
  try {
    result = await client.checkSmsVerifyCodeWithOptions(request, new Util.RuntimeOptions({}));
  } catch (e) {
    if (e && (e.code === 'isv.ValidateFail' || e.code === 'ValidateFail')) {
      return { pass: false };
    }
    throw e; // 其他异常（网络/鉴权等）继续往上抛
  }
  if (result.body.code !== 'OK') {
    throw new Error(`验证码校验失败: ${result.body.code} ${result.body.message}`);
  }
  return { pass: !!(result.body.model && result.body.model.verifyResult === 'PASS') };
}

module.exports = { sendVerifyCode, checkVerifyCode };
