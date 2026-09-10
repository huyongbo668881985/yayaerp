#!/usr/bin/env node
/**
 * 欠款快照任务入口：手动执行或宿主机 crontab 定时调用（结构仿 scripts/backup-run.js）。
 *
 * 用法：
 *   node scripts/debt-snapshot-run.js                 # 快照北京时间"今天"
 *   node scripts/debt-snapshot-run.js --date=2026-09-09   # 补算指定日期（测试/补数用）
 *
 * 流程：遍历 platform.db 全部租户（含暂停）写 debt_snapshots
 *      -> 任一租户失败时发告警邮件（BACKUP_ALERT_EMAIL，与备份告警同一收件人/SMTP）。
 *
 * 退出码：0 = 全部租户快照成功；1 = 有租户失败或任务整体异常。
 * cron 排期见 docs/DEBT_SNAPSHOT.md（每日 02:25，与 02:30 备份任务错开抢 SQLite 锁）。
 */
require('dotenv').config();
const { runDebtSnapshot, parseSnapshotDate, collectFailures, buildAlertText } = require('../lib/debtSnapshot');
const { sendBackupAlertEmail } = require('../lib/mailer');

function shanghaiNow() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

/** 解析 --date=YYYY-MM-DD 参数（仅测试/补数用），给了非法值直接报错退出，不静默落到"今天" */
function dateFromArgv() {
  const arg = process.argv.find(a => a.startsWith('--date='));
  if (!arg) return undefined;
  const value = parseSnapshotDate(arg.slice('--date='.length));
  if (!value) {
    console.error(`[debt-snapshot] --date 参数格式错误（应为 YYYY-MM-DD）：${arg}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  let report;
  try {
    report = runDebtSnapshot({ date: dateFromArgv() });
  } catch (err) {
    // 任务整体异常（如 platform.db 读不了）：一条快照都没写，直接告警退出
    console.error(`[debt-snapshot] 任务异常退出：${err.message}`);
    try {
      await sendBackupAlertEmail({
        subject: '欠款快照任务整体失败',
        text: [
          '欠款快照任务未能执行（连一条快照都没写）。',
          `失败时间：${shanghaiNow()}`,
          `错误信息：${err.message}`,
        ].join('\n'),
      });
    } catch (mailErr) {
      console.error(`[debt-snapshot] 告警邮件发送失败（不影响任务结果）：${mailErr.message}`);
    }
    process.exit(1);
  }

  const failures = collectFailures(report);
  if (failures.length === 0) {
    console.log('[debt-snapshot] 全部租户快照成功，无需告警');
    return;
  }

  // 告警发送失败也不能把任务拖崩：try/catch 包住，记日志即可
  try {
    const text = buildAlertText(report, failures, shanghaiNow());
    const sent = await sendBackupAlertEmail({
      subject: `欠款快照失败（${report.date}，${failures.length} 个租户）`,
      text
    });
    if (sent) console.log('[debt-snapshot] 已发送告警邮件');
  } catch (mailErr) {
    console.error(`[debt-snapshot] 告警邮件发送失败（不影响任务结果）：${mailErr.message}`);
  }

  process.exit(1); // 有失败就非 0 退出，cron 层面也能感知
}

main().catch(err => {
  console.error(`[debt-snapshot] 任务异常退出：${err.stack || err.message}`);
  process.exit(1);
});
