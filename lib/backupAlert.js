/**
 * 备份告警组装：把 runBackup 的结果报告转成告警邮件的标题和正文。
 * 独立成模块是为了可直接单测（scripts/backup-run.js 顶层就执行任务，不适合 require 测试）。
 *
 * 邮件正文必须包含（排障所需的最小信息集）：
 *   - 失败的租户/环节与文件名（label）
 *   - 失败时间、涉及的备份日期
 *   - 错误信息（rclone stderr 摘要，截尾保留）
 */

function truncate(str, max = 800) {
  if (!str) return '(无输出)';
  return str.length > max ? str.slice(-max) + '\n...（已截断，仅保留末尾）' : str;
}

/** 汇总所有需要告警的失败项：快照失败 + 同步失败 */
function collectFailures(report) {
  const failures = [];
  for (const r of report.results) {
    if (!r.ok) failures.push({ kind: '快照失败', label: r.label, detail: r.error });
  }
  if (report.sync && report.sync.ok === false) {
    failures.push({
      kind: 'R2 同步失败',
      label: report.sync.remote || 'r2',
      detail: [
        report.sync.error || '未知错误',
        report.sync.exitCode !== undefined ? `退出码: ${report.sync.exitCode}` : '',
        report.sync.stderrTail ? `stderr:\n${truncate(report.sync.stderrTail)}` : '',
      ].filter(Boolean).join('\n'),
    });
  }
  return failures;
}

/** 组装告警正文 */
function buildAlertText(report, failures, failedTime) {
  return [
    `备份任务出现 ${failures.length} 项失败，请检查。`,
    ``,
    `备份日期：${report.date}`,
    `失败时间：${failedTime}`,
    `备份目录：${report.backupDir}`,
    ``,
    `----- 失败明细 -----`,
    ...failures.map((f, i) => `[${i + 1}] ${f.kind}：${f.label}\n${f.detail}`),
    ``,
    `本地快照成功的部分不受影响；本地清理已执行（本轮删除 ${report.cleanup.removed.length} 个过期快照）。`,
  ].join('\n');
}

module.exports = { collectFailures, buildAlertText, truncate };
