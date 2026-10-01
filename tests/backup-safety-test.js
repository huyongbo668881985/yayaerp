// 全程临时 SQLite、占位凭据及假 rclone，无真实云端访问。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-backup-safety-'));
Object.assign(process.env, {
  JXC_DATA_DIR: dir, BACKUP_DIR: path.join(dir, 'backups'), BACKUP_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  R2_ACCOUNT_ID: 'test-account', R2_ACCESS_KEY_ID: 'test-key', R2_SECRET_ACCESS_KEY: 'test-secret', R2_BUCKET_NAME: 'test-bucket'
});
const fakeRclone = path.join(dir, 'fake-rclone.sh');
fs.writeFileSync(fakeRclone, '#!/bin/sh\nprintf "%s\\n" "$@" > "$JXC_DATA_DIR/argv.txt"\nexit "${TEST_SYNC_EXIT:-0}"\n', { mode: 0o700 });
process.env.RCLONE_PATH = fakeRclone;
const { runBackup, listBackupTargets, verifyEncryptedSnapshot, encryptFile, snapshotDatabase, BACKUP_DIR } = require('../lib/backupManager');
const { collectFailures } = require('../lib/backupAlert');
const { todayLocalDate } = require('../utils/dates');
let passes = 0;
async function check(label, work) { await work(); passes++; console.log('  PASS  ' + label); }
const platformPath = path.join(dir, 'platform.db'), tenantPath = path.join(dir, 'tenant.db');
const platform = new Database(platformPath);
platform.exec('CREATE TABLE tenants (tenant_code TEXT, db_path TEXT);');
platform.prepare('INSERT INTO tenants VALUES (?,?)').run('demo', tenantPath);
const tenant = new Database(tenantPath);
tenant.pragma('journal_mode = WAL');
tenant.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, amount REAL); INSERT INTO orders VALUES (1,100);');
(async () => {
  let first;
  await check('在线 WAL 快照完整回读，通过结构及外键检查；只允许同步加密文件', async () => {
    first = await runBackup();
    assert.equal(collectFailures(first).length, 0); assert.equal(first.results.length, 2);
    const argv = fs.readFileSync(path.join(dir, 'argv.txt'), 'utf8');
    assert.ok(argv.includes('--include\n*.db.gz.enc\n--exclude\n*'));
    assert.ok(!fs.readdirSync(BACKUP_DIR).some(name => name.startsWith('.pending-') || name.endsWith('.db.gz')));
    for (const entry of first.results) await verifyEncryptedSnapshot(entry.file, process.env.BACKUP_ENCRYPTION_KEY);
  });
  await check('同日重跑保留两轮快照，不覆盖旧文件，平台与租户共用轮次', async () => {
    const before = fs.readFileSync(first.results[0].file);
    const second = await runBackup();
    assert.equal(collectFailures(second).length, 0); assert.notEqual(second.runId, first.runId);
    assert.deepEqual(fs.readFileSync(first.results[0].file), before);
    assert.equal(fs.readdirSync(BACKUP_DIR).filter(name => name.endsWith('.enc')).length, 4);
    assert.ok(second.results.every(entry => entry.file.includes(second.runId)));
  });
  await check('合法租户代码 platform 与平台库使用不同标签，不会相互覆盖', async () => {
    platform.prepare('INSERT INTO tenants VALUES (?,?)').run('platform', tenantPath);
    const report = await runBackup();
    assert.equal(report.results.length, 3); assert.equal(collectFailures(report).length, 0);
    assert.deepEqual(report.results.map(entry => entry.label).sort(), ['platform','tenant-demo','tenant-platform']);
    assert.equal(new Set(report.results.map(entry => entry.file)).size, 3);
    platform.prepare("DELETE FROM tenants WHERE tenant_code='platform'").run();
  });
  await check('并发备份锁阻止重入，完成后释放锁', async () => {
    const running = runBackup();
    await assert.rejects(runBackup(), /任务锁已存在/);
    await running; assert.ok(!fs.existsSync(path.join(dir, '.backup.lock')));
  });
  const oldFile = path.join(BACKUP_DIR, 'demo_2000-01-01.db.gz.enc');
  await check('租户库缺失及异地同步失败均告警，保留旧备份和已有成功快照', async () => {
    fs.writeFileSync(oldFile, 'old');
    platform.prepare('INSERT INTO tenants VALUES (?,?)').run('missing', path.join(dir, 'missing.db'));
    const failed = await runBackup();
    assert.ok(collectFailures(failed).some(entry => entry.label === 'tenant-missing'));
    assert.equal(failed.cleanup.skipped, true); assert.ok(fs.existsSync(oldFile));
    assert.ok(first.results.every(entry => fs.existsSync(entry.file)));
    platform.prepare("DELETE FROM tenants WHERE tenant_code='missing'").run();
    process.env.TEST_SYNC_EXIT = '1';
    const syncFailed = await runBackup();
    assert.ok(collectFailures(syncFailed).some(entry => entry.kind === 'R2 同步失败'));
    assert.equal(syncFailed.cleanup.skipped, true); assert.ok(fs.existsSync(oldFile));
    delete process.env.TEST_SYNC_EXIT;
  });
  await check('无法读取租户清单直接失败，不能只备平台库返回成功，旧备份保留', async () => {
    platform.exec('ALTER TABLE tenants RENAME TO temporarily_missing_tenants');
    await assert.rejects(runBackup(), /租户清单失败/);
    assert.ok(fs.existsSync(oldFile)); assert.ok(!fs.existsSync(path.join(dir, '.backup.lock')));
    platform.exec('ALTER TABLE temporarily_missing_tenants RENAME TO tenants');
    assert.equal(listBackupTargets().length, 2);
  });
  await check('数据库外键损坏无法发布快照，旧文件及密文保留', async () => {
    const brokenPath = path.join(dir, 'broken.db'), broken = new Database(brokenPath);
    broken.pragma('foreign_keys = OFF');
    broken.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES(999);');
    broken.close();
    await assert.rejects(snapshotDatabase({ label: 'broken', dbPath: brokenPath, backupDir: BACKUP_DIR, dateStr: todayLocalDate(), encryptionKey: process.env.BACKUP_ENCRYPTION_KEY }), /外键检查失败/);
    assert.ok(!fs.readdirSync(BACKUP_DIR).some(name => name.startsWith('broken_') || name.startsWith('.pending-')));
    assert.ok(first.results.every(entry => fs.existsSync(entry.file)));
  });
  await check('只有 SQLite 文件头的伪库无法通过加密回读，错误密钥失败', async () => {
    const gz = path.join(dir, 'invalid.gz'), enc = path.join(dir, 'invalid.db.gz.enc');
    fs.writeFileSync(gz, require('zlib').gzipSync(Buffer.from('SQLite format 3\0' + 'broken'.repeat(100))));
    await encryptFile(gz, enc, process.env.BACKUP_ENCRYPTION_KEY);
    await assert.rejects(verifyEncryptedSnapshot(enc, process.env.BACKUP_ENCRYPTION_KEY));
    await assert.rejects(verifyEncryptedSnapshot(first.results[0].file, 'incorrect-key-123456789'));
  });
  await check('恢复脚本实际恢复 WAL 数据，拒绝覆盖；损坏快照不留下输出/临时文件', () => {
    const outDir = path.join(dir, 'restored');
    const source = first.results.find(entry => entry.label === 'tenant-demo').file;
    execFileSync(process.execPath, ['scripts/backup-restore.js', source, outDir], { cwd: path.join(__dirname, '..'), env: process.env });
    const outFile = path.join(outDir, fs.readdirSync(outDir).find(name => name.endsWith('.restore.db')));
    const restored = new Database(outFile, { readonly: true });
    assert.equal(restored.prepare('SELECT amount FROM orders WHERE id=1').get().amount, 100); restored.close();
    const before = fs.readFileSync(outFile);
    assert.throws(() => execFileSync(process.execPath, ['scripts/backup-restore.js', source, outDir], { env: process.env, stdio: 'pipe' }));
    assert.deepEqual(fs.readFileSync(outFile), before);
    const badDir = path.join(dir, 'bad-restore');
    assert.throws(() => execFileSync(process.execPath, ['scripts/backup-restore.js', path.join(dir, 'invalid.db.gz.enc'), badDir], { env: process.env, stdio: 'pipe' }));
    assert.deepEqual(fs.readdirSync(badDir), []);
  });
  await check('清理失败进入告警；整轮成功才清理过期的新旧格式文件，日志不删除', async () => {
    const unlink = fs.unlinkSync;
    fs.unlinkSync = file => { if (file === oldFile) throw new Error('test cleanup failure'); return unlink(file); };
    try {
      const report = await runBackup();
      assert.ok(collectFailures(report).some(entry => entry.kind === '清理失败'));
      assert.ok(fs.existsSync(oldFile));
    } finally { fs.unlinkSync = unlink; }
    const oldNewFormat = path.join(BACKUP_DIR, 'demo_2000-01-01_000000000Z-01234567.db.gz.enc');
    fs.writeFileSync(oldNewFormat, 'old'); fs.writeFileSync(path.join(BACKUP_DIR, 'backup-cron.log'), 'log');
    const report = await runBackup();
    assert.equal(collectFailures(report).length, 0);
    assert.ok(!fs.existsSync(oldFile)); assert.ok(!fs.existsSync(oldNewFormat));
    assert.ok(fs.existsSync(path.join(BACKUP_DIR, 'backup-cron.log')));
  });
  console.log(`备份安全回归：${passes} PASS / 0 FAIL`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  tenant.close(); platform.close(); fs.rmSync(dir, { recursive: true, force: true });
});
