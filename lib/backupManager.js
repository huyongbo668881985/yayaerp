/** 多租户在线快照：私有临时目录 → 加密 → 完整性/外键检查 → 原子发布。
 * 每次运行独立命名；整批快照和异地上传都成功后才清理旧文件。
 * sessions.db 是临时会话，不纳入备份。恢复步骤见 docs/BACKUP.md。
 */
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const { todayLocalDate } = require('../utils/dates');
const { syncBackupsToR2, requireR2Config } = require('./r2Sync');

// 数据目录。JXC_DATA_DIR 仅测试/特殊部署场景用来重定向，正常部署不用配。
const DATA_DIR = process.env.JXC_DATA_DIR || path.join(__dirname, '..', 'data');
// 备份目录，默认 data/backups（生产环境该目录在 Docker volume 内，随 data 一起持久化）
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
// 本地保留天数：保留 [今天-N天, 今天] 的快照，文件日期早于 今天-N天 的删除。
// 默认 7，即实际保留 8 个自然日（今天 + 前 7 天），略宽松于"最近 7 天"，安全侧偏移。
function readNonNegativeIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是大于等于 0 的整数，当前值无效：${raw}`);
  }
  return value;
}
const RETENTION_DAYS = readNonNegativeIntegerEnv('BACKUP_RETENTION_DAYS', 7);

// 清理兼容日期格式及每轮独立命名的快照。
const SNAPSHOT_FILENAME_RE = /^(.+)_(\d{4}-\d{2}-\d{2})(?:_\d{9}Z-[a-f0-9]{8})?\.db\.gz(\.enc)?$/;

// 加密参数说明：
// - aes-256-cbc + pbkdf2 + 262144 次迭代：从口令安全派生密钥，抗暴力破解
// - -salt：随机盐，同一文件每次加密结果不同
// - openssl 需 >= 1.1.1（支持 -pbkdf2）；容器内 debian bookworm 自带 3.0，本机已验证 3.6
// - 解密命令（同样参数加 -d）已写入 docs/BACKUP.md，密钥丢失数据不可恢复，务必备份好密钥
const OPENSSL_CIPHER_ARGS = ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '262144', '-salt'];

/** 日期字符串减 n 天。YYYY-MM-DD 是无时区歧义的纯日期，按 UTC 零点解析后做纯算术。 */
function subtractDays(dateStr, n) {
  const t = Date.parse(dateStr + 'T00:00:00Z') - n * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 流式 gzip 压缩，保留原压缩方式不变（标准 gzip，可用 gunzip/gzip -d 解开） */
async function gzipFile(srcPath, destPath) {
  await pipeline(
    fs.createReadStream(srcPath),
    zlib.createGzip(),
    fs.createWriteStream(destPath)
  );
}

/**
 * 取加密密钥：必须由环境变量 BACKUP_ENCRYPTION_KEY 注入，禁止硬编码。
 * 建议用 `openssl rand -hex 32` 生成。缺失/过短直接抛错——宁可备份失败，
 * 也不能静默产出未加密或弱密钥的快照。
 */
function getEncryptionKey() {
  const key = process.env.BACKUP_ENCRYPTION_KEY;
  if (!key || !key.trim()) {
    throw new Error('缺少 BACKUP_ENCRYPTION_KEY 环境变量，无法加密备份。请用 `openssl rand -hex 32` 生成并写入 .env（不要提交到仓库）');
  }
  if (key.trim().length < 16) {
    throw new Error('BACKUP_ENCRYPTION_KEY 太短（至少 16 字符），建议 `openssl rand -hex 32` 生成的 64 位十六进制串');
  }
  return key.trim();
}

/**
 * 执行 openssl 子进程（加密/解密共用）。
 * 密钥通过环境变量传给子进程（-pass env:VAR），不出现在命令行参数里，
 * 避免被 ps/进程列表窥视。
 */
function runOpenssl(args, key) {
  return new Promise((resolve, reject) => {
    const child = spawn('openssl', args, {
      env: { ...process.env, BACKUP_ENCRYPTION_KEY: key },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject); // 进程启动失败（如 openssl 不存在）
    child.on('close', code => {
      if (code === 0) return resolve();
      reject(new Error(`openssl 退出码 ${code}：${stderr.trim().slice(0, 300)}`));
    });
  });
}

/** 加密：openssl enc -aes-256-cbc -pbkdf2 -iter 262144 -salt */
function encryptFile(srcPath, destPath, key) {
  return runOpenssl([...OPENSSL_CIPHER_ARGS, '-in', srcPath, '-out', destPath, '-pass', 'env:BACKUP_ENCRYPTION_KEY'], key);
}

/** 解密：与加密相同参数加 -d。恢复备份时用，scripts/backup-restore.js 也走这里。 */
function decryptFile(srcPath, destPath, key) {
  return runOpenssl([...OPENSSL_CIPHER_ARGS, '-d', '-in', srcPath, '-out', destPath, '-pass', 'env:BACKUP_ENCRYPTION_KEY'], key);
}

/** 检查真实 SQLite 结构和外键，而非仅检查文件头。只读，不运行 schema 迁移。 */
function verifyDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check');
    if (!integrity.length || integrity.some(row => row.integrity_check !== 'ok')) {
      throw new Error('SQLite 完整性检查失败');
    }
    if (db.pragma('foreign_key_check').length) throw new Error('SQLite 外键检查失败');
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
  } finally { db.close(); }
}

async function verifyEncryptedSnapshot(encPath, key) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-backup-verify-'));
  try {
    const decGz = path.join(tmpDir, 'verify.db.gz');
    const restored = path.join(tmpDir, 'verify.db');
    await decryptFile(encPath, decGz, key);
    await pipeline(fs.createReadStream(decGz), zlib.createGunzip(), fs.createWriteStream(restored, { mode: 0o600 }));
    return verifyDatabase(restored);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

/**
 * 列出所有需要备份的库：平台库 + 全部租户库。
 * 租户清单从 platform.db 的 tenants 表读取（tenant_code 已被平台层校验为
 * [a-zA-Z0-9_-]{3,32}，拼进文件名不会路径穿越）。
 */
function listBackupTargets() {
  const platformDbPath = path.join(DATA_DIR, 'platform.db');
  const targets = [{ label: 'platform', dbPath: platformDbPath }];

  if (!fs.existsSync(platformDbPath)) throw new Error('平台库不存在，无法确认完整备份范围');
  if (fs.existsSync(platformDbPath)) {
    let platformDb = null;
    try {
      // 只读临时打开，读完即关；不碰 app 运行时的连接缓存
      platformDb = new Database(platformDbPath, { readonly: true });
      const rows = platformDb.prepare('SELECT tenant_code, db_path FROM tenants').all();
      for (const row of rows) {
        if (!/^[a-zA-Z0-9_-]{3,32}$/.test(row.tenant_code) || !row.db_path) throw new Error('租户清单包含无效代码或数据库路径');
        const label = 'tenant-' + row.tenant_code;
        if (targets.some(target => target.label === label)) throw new Error('备份文件标签重复：' + row.tenant_code);
        targets.push({ label, tenantCode: row.tenant_code, dbPath: row.db_path });
      }
    } catch (e) {
      throw new Error(`读取租户清单失败，备份范围无法确认：${e.message}`);
    } finally {
      if (platformDb) { try { platformDb.close(); } catch (e) { /* 忽略 */ } }
    }
  }
  return targets;
}

/**
 * 单库全量快照：better-sqlite3 .backup() 一致性副本 -> gzip -> 加密 -> 回读校验。
 * 中间产物使用私有临时目录，任务完成后清理；只有校验通过的密文会发布到备份目录。
 */
function newRunId() {
  return new Date().toISOString().slice(11).replace(/[:.]/g, '') + '-' + crypto.randomBytes(4).toString('hex');
}

async function snapshotDatabase({ label, dbPath, backupDir, dateStr, encryptionKey, runId = newRunId() }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('无效备份标签');
  const encTarget = path.join(backupDir, `${label}_${dateStr}_${runId}.db.gz.enc`);
  const tmpDir = fs.mkdtempSync(path.join(backupDir, '.pending-'));
  const tmpCopy = path.join(tmpDir, 'snapshot.db');
  const gzPath = path.join(tmpDir, 'snapshot.gz');
  const encPath = path.join(tmpDir, 'snapshot.enc');
  try {
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try { await src.backup(tmpCopy); } finally { src.close(); }
    await gzipFile(tmpCopy, gzPath);
    await encryptFile(gzPath, encPath, encryptionKey);
    await verifyEncryptedSnapshot(encPath, encryptionKey);
    fs.chmodSync(encPath, 0o600);
    // 同目录硬链接发布：完整文件瞬间可见，且即便命名碰撞也不会覆盖旧快照。
    fs.linkSync(encPath, encTarget);
    return encTarget;
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}

/**
 * 本地滚动清理：扫描备份目录，删除文件名日期早于（今天 - RETENTION_DAYS）的快照。
 * - 日期以文件名里的日期为准（不用文件 mtime——mtime 会被同步/复制等操作改写）
 * - 文件名不符合快照命名规则的文件一律不动（保守策略，避免误删别的东西），只记日志
 */
function cleanupOldSnapshots(backupDir) {
  const today = todayLocalDate();
  const cutoff = subtractDays(today, RETENTION_DAYS);
  const removed = [];
  const unrecognized = [];
  const errors = [];

  if (!fs.existsSync(backupDir)) return { cutoff, removed, unrecognized, errors };

  for (const name of fs.readdirSync(backupDir)) {
    const full = path.join(backupDir, name);
    let stat = null;
    try { stat = fs.statSync(full); } catch (e) { continue; }
    if (!stat.isFile()) continue;

    const m = SNAPSHOT_FILENAME_RE.exec(name);
    if (!m) { unrecognized.push(name); continue; }

    const fileDate = m[2];
    // YYYY-MM-DD 格式的字符串比较等价于日期比较
    if (fileDate < cutoff) {
      try {
        fs.unlinkSync(full);
        removed.push(name);
        console.log(`[cleanup] 已删除过期快照: ${name}（日期 ${fileDate}，早于保留线 ${cutoff}）`);
      } catch (e) {
        errors.push({ file: name, error: e.message });
        console.error(`[cleanup] 删除失败: ${name}: ${e.message}`);
      }
    }
  }

  if (removed.length) {
    console.log(`[cleanup] 清理完成：删除 ${removed.length} 个过期快照（保留线 ${cutoff}）`);
  } else {
    console.log(`[cleanup] 无过期快照需要删除（保留线 ${cutoff}）`);
  }
  if (unrecognized.length) {
    console.warn(`[cleanup] 跳过 ${unrecognized.length} 个不符合快照命名的文件（不删除）：${unrecognized.join(', ')}`);
  }
  return { cutoff, removed, unrecognized, errors };
}

/** 同一数据目录只允许运行一个备份任务。进程崩溃留下锁时需核实后手工移除。 */
async function performBackup(options = {}) {
  requireR2Config();
  const encryptionKey = getEncryptionKey();
  const backupDir = options.backupDir || BACKUP_DIR;
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const lockPath = path.join(DATA_DIR, '.backup.lock');
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('备份任务锁已存在，拒绝并发执行；若前次异常退出，请先确认没有备份进程再移除 .backup.lock');
    throw error;
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const dateStr = todayLocalDate();
    const runId = newRunId();
    const targets = listBackupTargets(); // 无法列举租户必须失败，不能只备平台库冒充成功
    const results = [];
    for (const target of targets) {
      const entry = { ...target, ok: false, file: null };
      results.push(entry);
      try {
        const file = await snapshotDatabase({ ...target, backupDir, dateStr, encryptionKey, runId });
        Object.assign(entry, { ok: true, file, size: fs.statSync(file).size });
        console.log(`[backup] ${target.label}: ${path.basename(file)}（已加密、完整性及外键检查通过）`);
      } catch (error) {
        entry.error = error.message;
        console.error(`[backup] ${target.label}: 失败 — ${error.message}`);
      }
    }
    let sync;
    try { sync = await syncBackupsToR2(backupDir); }
    catch (error) { sync = { ok: false, error: error.message }; }
    const cleanup = results.every(entry => entry.ok) && sync.ok
      ? cleanupOldSnapshots(backupDir)
      : { removed: [], errors: [], skipped: true, reason: '本轮快照或异地同步失败，保留全部历史备份' };
    console.log(`[backup] 本轮成功 ${results.filter(entry => entry.ok).length}/${results.length}，异地同步 ${sync.ok ? '成功' : '失败'}，清理 ${cleanup.skipped ? '跳过' : cleanup.removed.length + ' 个'}`);
    return { date: dateStr, runId, backupDir, results, cleanup, sync };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

async function runBackup(options = {}) {
  const { recordStatus } = require('./operationsStatus');
  const at = new Date().toISOString();
  try {
    const result = await performBackup(options);
    const ok = result.results.every(entry => entry.ok) && result.sync.ok && !result.cleanup.errors.length;
    recordStatus({ lastBackupAttempt: at, backupResult: ok ? 'success' : 'failed', ...(ok ? { lastBackupSuccess: new Date().toISOString(), lastSnapshotVerification: new Date().toISOString() } : {}) });
    return result;
  } catch (error) { recordStatus({ lastBackupAttempt: at, backupResult: 'failed' }); throw error; }
}

module.exports = {
  runBackup,
  cleanupOldSnapshots,
  snapshotDatabase,
  listBackupTargets,
  subtractDays,
  getEncryptionKey,
  encryptFile,
  decryptFile,
  verifyEncryptedSnapshot,
  verifyDatabase,
  OPENSSL_CIPHER_ARGS,
  BACKUP_DIR,
  RETENTION_DAYS,
};
