#!/usr/bin/env node
/**
 * 备份恢复脚本：把加密快照还原成可用的 SQLite 库文件。
 *
 * 用法：
 *   node scripts/backup-restore.js <快照.db.gz.enc> [输出目录]
 *   例如：node scripts/backup-restore.js data/backups/demo_2026-09-09.db.gz.enc ./restored
 *
 * 步骤：openssl 解密（参数与加密完全一致）-> gunzip -> PRAGMA integrity_check。
 * 密钥来自环境变量 BACKUP_ENCRYPTION_KEY（.env 里配的那把）。
 * 密钥丢失数据不可恢复——务必把密钥另行妥善保管（密码管理器/离线介质）。
 *
 * 也可以不依赖本脚本手工恢复（需要 OpenSSL >= 1.1.1，参数必须与加密时一致）：
 *   BACKUP_ENCRYPTION_KEY='你的密钥' openssl enc -aes-256-cbc -pbkdf2 -iter 262144 -d \
 *     -in demo_2026-09-09.db.gz.enc -out demo.db.gz -pass env:BACKUP_ENCRYPTION_KEY
 *   gunzip -c demo.db.gz > demo.db
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('better-sqlite3');
const { decryptFile, getEncryptionKey } = require('../lib/backupManager');

async function main() {
  const [srcArg, outDirArg] = process.argv.slice(2);
  if (!srcArg) {
    console.error('用法：node scripts/backup-restore.js <快照.db.gz.enc> [输出目录]');
    process.exit(1);
  }

  const src = path.resolve(srcArg);
  if (!fs.existsSync(src)) {
    console.error(`找不到文件：${src}`);
    process.exit(1);
  }

  const key = getEncryptionKey(); // 缺失/过短会直接抛错
  const outDir = path.resolve(outDirArg || process.cwd());
  fs.mkdirSync(outDir, { recursive: true });

  // demo_2026-09-09.db.gz.enc -> demo_2026-09-09.db
  const baseName = path.basename(src).replace(/\.db\.gz(\.enc)?$/i, '');
  const decGz = path.join(outDir, `${baseName}.restore.db.gz`);
  const outDb = path.join(outDir, `${baseName}.restore.db`);

  console.log(`[restore] 解密 ${path.basename(src)} ...`);
  await decryptFile(src, decGz, key);

  console.log('[restore] 解压 gzip ...');
  const dbBuf = zlib.gunzipSync(fs.readFileSync(decGz));
  fs.writeFileSync(outDb, dbBuf);
  fs.unlinkSync(decGz);

  console.log('[restore] 校验 SQLite 完整性 ...');
  const db = new Database(outDb, { readonly: true });
  const integrity = db.pragma('integrity_check', { simple: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
  db.close();

  console.log(`[restore] integrity_check: ${integrity}`);
  console.log(`[restore] 包含数据表：${tables.join(', ')}`);
  if (integrity !== 'ok') {
    console.error('[restore] 完整性检查未通过！请检查快照文件是否完整、密钥是否正确');
    process.exit(1);
  }
  console.log(`[restore] 完成，已还原到：${outDb}`);
}

main().catch(err => {
  console.error(`[restore] 失败：${err.message}`);
  console.error('常见原因：BACKUP_ENCRYPTION_KEY 不对、快照文件不完整、openssl 版本过旧（需 >= 1.1.1）');
  process.exit(1);
});
