#!/usr/bin/env node
/**
 * 备份任务入口：手动执行或宿主机 crontab 定时调用。
 *
 * 用法：
 *   node scripts/backup-run.js
 *
 * 流程：全量快照（gzip + 加密 + 回读校验）-> 本地 7 天滚动清理 -> rclone 同步 R2
 *      -> 任一环节失败时发告警邮件（BACKUP_ALERT_EMAIL）。
 *
 * 退出码：0 = 快照与同步全部成功；1 = 有库快照失败、同步失败或任务整体异常。
 * 运行环境变量见 .env.example 备份段与 docs/BACKUP.md。
 */
require('dotenv').config();
const { runBackup } = require('../lib/backupManager');
const { sendBackupAlertEmail } = require('../lib/mailer');
const { collectFailures, buildAlertText } = require('../lib/backupAlert');

function shanghaiNow() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

async function main() {
  let report;
  try {
    report = await runBackup();
  } catch (err) {
    // 任务整体异常（如缺加密密钥）：连快照都没生成，直接告警退出
    console.error(`[backup] 任务异常退出：${err.message}`);
    try {
      await sendBackupAlertEmail({
        subject: '备份任务整体失败',
        text: [
          `备份任务未能执行（连快照都未生成）。`,
          `失败时间：${shanghaiNow()}`,
          `错误信息：${err.message}`,
        ].join('\n'),
      });
    } catch (mailErr) {
      console.error(`[backup] 告警邮件发送失败（不影响任务结果）：${mailErr.message}`);
    }
    process.exit(1);
  }

  const failures = collectFailures(report);
  if (failures.length === 0) {
    console.log('[backup] 全部环节成功，无需告警');
    return;
  }

  // 告警发送失败也不能把备份任务拖崩：try/catch 包住，记日志即可
  try {
    const text = buildAlertText(report, failures, shanghaiNow());
    const sent = await sendBackupAlertEmail({ subject: `备份失败（${report.date}，${failures.length} 项）`, text });
    if (sent) console.log('[backup] 已发送告警邮件');
  } catch (mailErr) {
    console.error(`[backup] 告警邮件发送失败（不影响任务结果）：${mailErr.message}`);
  }

  process.exit(1); // 有失败就非0退出，cron 层面也能感知
}

main().catch(err => {
  console.error(`[backup] 任务异常退出：${err.stack || err.message}`);
  process.exit(1);
});
