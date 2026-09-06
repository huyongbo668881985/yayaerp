/**
 * 阿里云短信服务封装
 *
 * 需要先：
 *   npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client @alicloud/tea-util
 *
 * 使用前需要在阿里云控制台完成（有审核周期）：
 *   1. 开通"短信服务"
 *   2. 申请"签名"（比如"鸭鸭进销存"）
 *   3. 申请"验证码"模板（内容需含 ${code} 和 ${min} 两个变量，${min} 是有效期分钟数）
 *   4. AK 所属账号必须被授予短信发送权限（RAM 子账号需添加 AliyunDysmsFullAccess，
 *      否则调 SendSms 会报 NoPermission 403——查询模板/签名列表也需要对应查询权限）
 *
 * 注意 SDK 的导出结构：客户端类在 default 上，SendSmsRequest 等请求类是
 * 命名导出（Dysmsapi.SendSmsRequest），不要写成 Dysmsapi.default.SendSmsRequest——
 * 那个是 undefined，运行时会报 "is not a constructor"。
 *
 * 如果接口调用参数有出入，以阿里云控制台"OpenAPI 门户"里 SendSms 接口
 * 自动生成的调用示例为准，那个示例永远是当前最准的。
 */

const DysmsapiPackage = require('@alicloud/dysmsapi20170525');
const Dysmsapi20170525 = DysmsapiPackage.default; // 客户端类
const { SendSmsRequest } = DysmsapiPackage;       // 请求类是命名导出
const OpenApi = require('@alicloud/openapi-client');
const Util = require('@alicloud/tea-util');

// 实际过审的模板（SMS_337380326）内容只有 ${code} 一个变量：
// "您的验证码为：${code}，请勿泄露于他人！"
// 如果以后换成带 ${min} 的模板（"以上验证码${min}分钟内有效"），
// 要把 min: CODE_TTL_MINUTES 加回 templateParam，否则阿里云会因缺变量拒发。
const CODE_TTL_MINUTES = 5;

function createClient() {
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET
  });
  config.endpoint = 'dysmsapi.aliyuncs.com';
  return new Dysmsapi20170525(config);
}

/** 配置缺失时给出能看懂的报错，而不是让阿里云 SDK 抛一堆无从下手的认证错误 */
function assertSmsConfigured() {
  const required = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_SMS_SIGN_NAME', 'ALIYUN_SMS_TEMPLATE_CODE'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`短信服务未配置：缺少环境变量 ${missing.join('、')}。请在 .env 里补齐后重启服务。`);
  }
}

async function sendVerificationCode(phone, code) {
  assertSmsConfigured();
  const client = createClient();
  const request = new SendSmsRequest({
    phoneNumbers: phone,
    signName: process.env.ALIYUN_SMS_SIGN_NAME,
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE,
    templateParam: JSON.stringify({ code })
  });
  const runtime = new Util.RuntimeOptions({});

  const result = await client.sendSmsWithOptions(request, runtime);
  if (result.body.code !== 'OK') {
    throw new Error(`短信发送失败: ${result.body.code} ${result.body.message}`);
  }
  return result.body;
}

module.exports = { sendVerificationCode };
