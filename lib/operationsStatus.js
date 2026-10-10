const fs = require('fs');
const path = require('path');
const filename = path.join(process.env.JXC_DATA_DIR || path.join(__dirname, '..', 'data'), '.operations-status.json');
function readStatus() {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch (_) { return {}; }
}
function recordStatus(patch) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tmp = filename + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ ...readStatus(), ...patch }), { mode: 0o600 });
  fs.renameSync(tmp, filename);
}
function displayStatus() {
  const status = readStatus();
  const overdue = !status.lastBackupSuccess || Date.now() - Date.parse(status.lastBackupSuccess) > 36 * 3600000;
  return { ...status, backupLabel: status.backupResult === 'failed' ? '最近备份失败' : overdue ? '未备份或超过 36 小时' : '备份正常', overdue };
}
module.exports = { readStatus, recordStatus, displayStatus };
