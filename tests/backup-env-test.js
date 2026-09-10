/**
 * 备份 R2 环境变量结构与 fail-fast 校验回归测试。
 *
 * 防回归的目标（对应"缺失关键环境变量必须明确报错并阻止执行"的要求）：
 *   1. 四项 R2_* 全缺 / 部分缺失时，requireR2Config 点名缺失的变量并抛错
 *   2. runBackup 在生成任何快照之前就被 R2 配置校验拦下（备份目录都不创建）
 *   3. 旧变量名 R2_BUCKET 兼容读取（提示改用 R2_BUCKET_NAME）
 *   4. R2_ENDPOINT 显式覆盖优先；默认由 R2_ACCOUNT_ID 推导
 *   5. rclone 凭据只经环境变量传递：命令行参数里绝不出现 Secret（用假 rclone 可执行文件捕获 argv/env 验证）
 *
 * 运行：node tests/backup-env-test.js
 * 本测试全程使用占位凭据（your_access_key_id_here 之类），不含任何真实密钥。
 */

process.chdir(__dirname + '/..');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let PASSES = 0, FAILS = 0;
function ok(cond, label, extra = '') {
  if (cond) { PASSES++; console.log(`  PASS  ${label}${extra ? '  [' + extra + ']' : ''}`); }
  else { FAILS++; console.log(`  FAIL  ${label}${extra ? '  [' + extra + ']' : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

// ---- 占位凭据（明显假值，绝非真实格式）----
const PH_ACCOUNT = 'your_account_id_here';
const PH_KEY_ID = 'your_access_key_id_here';
const PH_SECRET = 'your_secret_access_key_here';

// ---- 环境变量保存/恢复：测试结束时还原，不污染外层 shell ----
const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_BUCKET', 'R2_ENDPOINT', 'R2_PREFIX', 'RCLONE_PATH', 'BACKUP_ENCRYPTION_KEY', 'JXC_DATA_DIR', 'BACKUP_DIR', 'CAPTURE_FILE'];
const savedEnv = {};
for (const k of R2_KEYS) savedEnv[k] = process.env[k];
function clearR2Env() {
  for (const k of R2_KEYS) delete process.env[k];
}
process.on('exit', () => {
  for (const k of R2_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// JXC_DATA_DIR 指向临时目录（backupManager 在 require 时读取，必须先设再 require）
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-backup-envtest-'));
process.env.JXC_DATA_DIR = tmpData;
const BACKUP_DIR = path.join(tmpData, 'backups');

const r2Sync = require('./../lib/r2Sync');
const { runBackup, BACKUP_DIR: RESOLVED_BACKUP_DIR } = require('./../lib/backupManager');

(async () => {
// ============ 1. 全缺 / 部分缺失：点名缺失变量 ============
section('1. requireR2Config 缺失校验（点名变量）');
clearR2Env();
try {
  r2Sync.requireR2Config();
  ok(false, '四项全缺时应抛错', '未抛错');
} catch (e) {
  const msg = e.message;
  ok(msg.includes('R2_ACCOUNT_ID') && msg.includes('R2_ACCESS_KEY_ID') && msg.includes('R2_SECRET_ACCESS_KEY') && msg.includes('R2_BUCKET_NAME'),
    '四项全缺：报错逐个点名 4 个变量名', msg.slice(0, 80) + '…');
}

process.env.R2_ACCOUNT_ID = PH_ACCOUNT;
try {
  r2Sync.requireR2Config();
  ok(false, '只配 1 项时应抛错', '未抛错');
} catch (e) {
  const msg = e.message;
  ok(!msg.includes(PH_ACCOUNT) && msg.includes('R2_ACCESS_KEY_ID') && msg.includes('R2_SECRET_ACCESS_KEY') && msg.includes('R2_BUCKET_NAME'),
    '只配 ACCOUNT_ID：只点名剩下 3 个缺失变量');
}

// ============ 2. runBackup 启动即拦截（先于任何快照动作） ============
section('2. runBackup 启动阶段拦截');
clearR2Env();
process.env.BACKUP_ENCRYPTION_KEY = 'x'.repeat(32); // 密钥齐、R2 缺 → 也必须拦
let rejected = null;
try { await runBackup(); } catch (e) { rejected = e; }
ok(!!rejected && rejected.message.includes('R2_ACCOUNT_ID'), 'R2 未配置时 runBackup 直接抛错（不进入快照流程）', rejected ? rejected.message.slice(0, 60) + '…' : '未抛错');
ok(!fs.existsSync(BACKUP_DIR), '拦截发生在任何备份动作之前（备份目录未创建）');
ok(RESOLVED_BACKUP_DIR === BACKUP_DIR, 'JXC_DATA_DIR 重定向生效（测试不碰真实 data/）');

// ============ 3. 旧变量名 R2_BUCKET 兼容 ============
section('3. 旧变量名兼容');
clearR2Env();
process.env.R2_BUCKET = 'legacy_bucket_name';
ok(r2Sync.getR2Bucket() === 'legacy_bucket_name', '未配 R2_BUCKET_NAME 时回退读 R2_BUCKET', r2Sync.getR2Bucket());
process.env.R2_BUCKET_NAME = 'new_bucket_name';
ok(r2Sync.getR2Bucket() === 'new_bucket_name', 'R2_BUCKET_NAME 优先于旧名', r2Sync.getR2Bucket());

// ============ 4. R2_ENDPOINT：显式覆盖 / 默认推导 ============
section('4. R2_ENDPOINT 解析');
clearR2Env();
process.env.R2_ACCOUNT_ID = PH_ACCOUNT;
process.env.R2_ACCESS_KEY_ID = PH_KEY_ID;
process.env.R2_SECRET_ACCESS_KEY = PH_SECRET;
process.env.R2_BUCKET_NAME = 'jxcdata';
ok(r2Sync.getR2Endpoint() === `https://${PH_ACCOUNT}.r2.cloudflarestorage.com`, '未配 R2_ENDPOINT：由 ACCOUNT_ID 推导', r2Sync.getR2Endpoint());
process.env.R2_ENDPOINT = 'https://explicit-endpoint.example.r2.cloudflarestorage.com/';
ok(r2Sync.getR2Endpoint() === 'https://explicit-endpoint.example.r2.cloudflarestorage.com', '显式 R2_ENDPOINT 优先且去掉尾部斜杠', r2Sync.getR2Endpoint());
delete process.env.R2_ENDPOINT;

// ============ 5. rclone 凭据只走环境变量（假 rclone 捕获 argv/env） ============
section('5. rclone 凭据传递方式（假 rclone 验证）');
const captureFile = path.join(tmpData, 'rclone-capture.txt');
const fakeRclone = path.join(tmpData, 'fake-rclone.sh');
fs.writeFileSync(fakeRclone, [
  '#!/bin/sh',
  `printf 'ARGV\\n' > "$CAPTURE_FILE"`,
  `for a in "$@"; do printf '%s\\n' "$a" >> "$CAPTURE_FILE"; done`,
  `printf 'ENV\\n' >> "$CAPTURE_FILE"`,
  `env | grep -E '^RCLONE_CONFIG_R2_' | LC_ALL=C sort >> "$CAPTURE_FILE"`,
  'exit 0',
  ''
].join('\n'));
fs.chmodSync(fakeRclone, 0o755);
process.env.RCLONE_PATH = fakeRclone;
process.env.CAPTURE_FILE = captureFile;
process.env.R2_ENDPOINT = ''; // 走推导

fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.writeFileSync(path.join(BACKUP_DIR, 'platform_2026-09-10.db.gz.enc'), 'dummy');

const result = await r2Sync.syncBackupsToR2(BACKUP_DIR);
ok(result.ok === true, '假 rclone 同步成功（exit 0）', `remote=${result.remote}`);
const captured = fs.readFileSync(captureFile, 'utf8');
const argLines = captured.split('ENV\n')[0].split('\n').slice(1).filter(Boolean);
const envLines = captured.split('ENV\n')[1] || '';
const joinedArgs = argLines.join(' ');
ok(argLines.some(a => a === 'r2:jxcdata'), '同步目标 = r2:<R2_BUCKET_NAME>', joinedArgs.slice(0, 60));
ok(!joinedArgs.includes(PH_SECRET) && !joinedArgs.includes(PH_KEY_ID) && !joinedArgs.includes(PH_ACCOUNT),
  '命令行参数中不含任何凭据（密钥不进 argv，防 ps 窥视）');
ok(envLines.includes(`RCLONE_CONFIG_R2_ACCESS_KEY_ID=${PH_KEY_ID}`) && envLines.includes(`RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=${PH_SECRET}`),
  '凭据经 RCLONE_CONFIG_R2_* 环境变量传递（不落 rclone.conf）');
ok(envLines.includes(`RCLONE_CONFIG_R2_ENDPOINT=https://${PH_ACCOUNT}.r2.cloudflarestorage.com`),
  'rclone 收到推导后的 R2 端点');

// ============ 清理 ============
section('清理');
fs.rmSync(tmpData, { recursive: true, force: true });
ok(!fs.existsSync(tmpData), '临时目录已清理');

console.log(`\n========== 结果: ${PASSES} PASS / ${FAILS} FAIL ==========`);
process.exit(FAILS === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试脚本异常中断:', e);
  process.exit(1);
});
