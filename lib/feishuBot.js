/**
 * 飞书群自定义机器人消息发送（知会通知用，不需要按钮交互）
 * 群设置 -> 群机器人 -> 添加机器人 -> 自定义机器人，复制 Webhook 地址填进 .env。
 * 需要 Node 18+（用的是全局 fetch，Dockerfile 里用的是 node:20-slim，满足）。
 */
const WEBHOOK_URL = process.env.FEISHU_WEBHOOK_URL;

async function sendTextMessage(text) {
  if (!WEBHOOK_URL) {
    console.warn('[feishuBot] 未配置 FEISHU_WEBHOOK_URL，跳过通知');
    return null;
  }
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } })
  });
  const data = await res.json();
  // 飞书自定义机器人有两种成功返回结构：新版 {code:0,msg:"success"}、
  // 旧版 {StatusCode:0,StatusMessage:"success"}。只判 data.code !== 0 的话，
  // 旧版结构里 code 是 undefined，成功也会被当成失败打错误日志。
  const ok = data && (data.code === 0 || data.StatusCode === 0);
  if (!ok) {
    console.error('[feishuBot] 消息发送失败:', data);
  }
  return data;
}

module.exports = { sendTextMessage };
