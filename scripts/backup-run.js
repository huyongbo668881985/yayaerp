#!/usr/bin/env node
/**
 * 备份任务入口：手动执行或宿主机 crontab 定时调用。
 *
 * 用法：
 *   node scripts/backup-run.js
 *
 * 退出码：0 = 全部成功；1 = 有库快照失败或任务整体异常。
 * 运行环境变量见 .env.example 备份段与 docs/BACKUP.md。
 */
require('dotenv').config();
const { runBackup } = require('../lib/backupManager');

runBackup()
  .then(report => {
    const failed = report.results.filter(r => !r.ok);
    if (failed.length) {
      console.error(`[backup] 以下库备份失败：${failed.map(f => `${f.label}（${f.error}）`).join('；')}`);
    }
    process.exit(failed.length ? 1 : 0);
  })
  .catch(err => {
    console.error(`[backup] 任务异常退出：${err.stack || err.message}`);
    process.exit(1);
  });
