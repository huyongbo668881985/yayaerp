/**
 * 阿里云短信服务封装
 *
 * 需要先：
 *   npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client @alicloud/tea-util
 *
 * 使用前需要在阿里云控制台完成（有审核周期）：
 *   1. 开通"短信服务"
 *   2. 申请"签名"（比如"鸭鸭进销存"）
 *   3. 申请"验证码"模板，内容类似：您的验证码是${code}，5分钟内有效，请勿泄露。
 *   4. 建议用子账号 + 仅授予短信发送权限的 AccessKey，不要用主账号 AK
 *
 * 如果接口调用参数有出入，以阿里云控制台"OpenAPI 门户"里 SendSms 接口
 * 自动生成的调用示例为准，那个示例永远是当前最准的。
 */

const Dysmsapi20170525 = require('@alicloud/dysmsapi20170525').default;
const OpenApi = require('@alicloud/openapi-client');
const Util = require('@alicloud/tea-util');

function createClient() {
  const config = new OpenApi.Config({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET
  });
  config.endpoint = 'dysmsapi.aliyuncs.com';
  return new Dysmsapi20170525(config);
}

async function sendVerificationCode(phone, code) {
  const client = createClient();
  const request = new Dysmsapi20170525.SendSmsRequest({
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
