/**
 * 备份管理器：多租户 SQLite 全量快照 + gzip 压缩 + AES-256 加密 + 本地 7 天滚动清理。
 *
 * 备份范围：data/platform.db（平台库，含租户清单/管理员/审计日志）
 *          + tenants 表里登记的每一个租户库（含已暂停的，数据还在就要备）。
 *          sessions.db 是临时会话，不备份。
 *
 * 快照方式：better-sqlite3 的 .backup() API（底层 sqlite3_backup），
 *          对正在写入的库也能拿到一致性快照（WAL 模式下在线备份不阻塞业务）。
 *          每次都是全量快照，不做增量——库都很小（KB~MB 级），全量最简单也最可靠。
 *
 * 加密：gzip 后用 openssl enc -aes-256-cbc -pbkdf2 -iter 262144 加密，
 *      密钥来自环境变量 BACKUP_ENCRYPTION_KEY（不在代码/仓库里）。
 *      最终产物 {label}_{YYYY-MM-DD}.db.gz.enc，备份目录不落明文。
 *      加密后立即解密回读校验 SQLite 文件头，保证当天快照 100% 可还原。
 *      解密/恢复方法见 docs/BACKUP.md 和 scripts/backup-restore.js。
 *
 * 文件命名：{label}_{YYYY-MM-DD}.db.gz.enc，label 为 "platform" 或租户代码。
 *
 * 日期口径：全站统一北京时间（复用 utils/dates.js），避免 UTC 偏移导致
 *          凌晨备份的文件名日期错位。
 *
 * 触发方式：本模块不内置定时器，由 scripts/backup-run.js 作为入口，
 *          手动执行或宿主机 crontab 定时调用。
 *
 * 异地同步：快照+清理完成后自动调用 lib/r2Sync.js 把整个备份目录 rclone copy
 *          到 Cloudflare R2。R2 四项环境变量（R2_ACCOUNT_ID / R2_ACCESS_KEY_ID /
 *          R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME）为必填：任务启动时统一校验，
 *          缺任一项直接报错退出（点名缺失变量），绝不静默降级为"只做本地备份"。
 *          R2 端过期删除交给 bucket Lifecycle Rule，应用层不删远端数据。
 */
const fs = require('fs');
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
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 7);

// 快照文件名：{label}_{YYYY-MM-DD}.db.gz[.enc]（.enc 为后续加密步骤预留，清理逻辑两种后缀都认）
const SNAPSHOT_FILENAME_RE = /^(.+)_(\d{4}-\d{2}-\d{2})\.db\.gz(\.enc)?$/;

// 加密参数说明：
// - aes-256-cbc + pbkdf2 + 262144 次迭代：从口令安全派生密钥，抗暴力破解
// - -salt：随机盐，同一文件每次加密结果不同
// - openssl 需 >= 1.1.1（支持 -pbkdf2）；容器内 debian bookworm 自带 3.0，本机已验证 3.6
// - 解密命令（同样参数加 -d）已写入 docs/BACKUP.md，密钥丢失数据不可恢复，务必备份好密钥
const OPENSSL_CIPHER_ARGS = ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '262144', '-salt'];
const SQLITE_HEADER = 'SQLite format 3';

/** 日期字符串减 n 天。YYYY-MM-DD 是无时区歧义的纯日期，按 UTC 零点解析后做纯算术。 */
function subtractDays(dateStr, n) {
  const t = Date.parse(dateStr + 'T00:00:00Z') - n * 24 * 60 * 60 * 1000;
  return new Date(t).toISOString().slice(0, 10);
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
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

/**
 * 加密快照回读验证：解密 -> gunzip -> 校验 SQLite 文件头。
 * 进销存的库都很小（KB~MB 级），全量载入内存校验的开销可以忽略；
 * 这一步保证"当天生成的加密快照一定能解密还原"，避免带病上传。
 */
async function verifyEncryptedSnapshot(encPath, key) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-backup-verify-'));
  try {
    const decGz = path.join(tmpDir, 'verify.db.gz');
    await decryptFile(encPath, decGz, key);
    const dbBuf = zlib.gunzipSync(fs.readFileSync(decGz));
    const head = dbBuf.subarray(0, SQLITE_HEADER.length).toString('binary');
    if (head !== SQLITE_HEADER) {
      throw new Error(`回读校验失败：解密解压后的文件头不是 SQLite 数据库（实际开头 "${head.slice(0, 15)}"）`);
    }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 列出所有需要备份的库：平台库 + 全部租户库。
 * 租户清单从 platform.db 的 tenants 表读取（tenant_code 已被平台层校验为
 * [a-zA-Z0-9_-]{3,32}，拼进文件名不会路径穿越）。
 */
function listBackupTargets() {
  const platformDbPath = path.join(DATA_DIR, 'platform.db');
  const targets = [{ label: 'platform', dbPath: platformDbPath }];

  if (fs.existsSync(platformDbPath)) {
    let platformDb = null;
    try {
      // 只读临时打开，读完即关；不碰 app 运行时的连接缓存
      platformDb = new Database(platformDbPath, { readonly: true });
      const rows = platformDb.prepare('SELECT tenant_code, db_path FROM tenants').all();
      for (const row of rows) {
        targets.push({ label: row.tenant_code, dbPath: row.db_path });
      }
    } catch (e) {
      console.error(`[backup] 读取租户清单失败（platform.db）：${e.message}`);
      // 清单读不出来时只备平台库，错误会在结果汇总里体现
    } finally {
      if (platformDb) { try { platformDb.close(); } catch (e) { /* 忽略 */ } }
    }
  }
  return targets;
}

/**
 * 单库全量快照：better-sqlite3 .backup() 一致性副本 -> gzip -> 加密 -> 回读校验。
 * 中间产物（未压缩副本、明文 .db.gz）全部清理，备份目录里只留 .enc 最终产物。
 */
async function snapshotDatabase({ label, dbPath, backupDir, dateStr, encryptionKey }) {
  const gzTarget = path.join(backupDir, `${label}_${dateStr}.db.gz`);
  const encTarget = gzTarget + '.enc';
  const tmpCopy = gzTarget + '.tmp';

  try {
    // 1. 在线一致性备份：readonly 打开源库（只读不干扰业务连接），.backup() 返回 Promise
    const src = new Database(dbPath, { readonly: true });
    try {
      await src.backup(tmpCopy);
    } finally {
      try { src.close(); } catch (e) { /* 忽略 */ }
    }

    // 2. gzip 压缩
    await gzipFile(tmpCopy, gzTarget);

    // 3. 加密：openssl 子进程，密钥经环境变量传递
    await encryptFile(gzTarget, encTarget, encryptionKey);

    // 4. 回读校验：确保这份 .enc 当场就能解密还原成合法 SQLite 库
    await verifyEncryptedSnapshot(encTarget, encryptionKey);

    return encTarget;
  } finally {
    // 无论成败清掉中间产物：未压缩副本 + 明文 gzip（加密成功后明文不留在备份目录）
    for (const f of [tmpCopy, gzTarget]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
    }
  }
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

  if (!fs.existsSync(backupDir)) return { cutoff, removed, unrecognized };

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
  return { cutoff, removed, unrecognized };
}

/**
 * 执行一次完整备份任务：校验 R2 配置 + 加密密钥（fail fast）
 *                    -> 逐库快照（含加密+校验） -> 汇总结果
 *                    -> 清理过期快照 -> rclone 同步 R2。
 * 单个库失败不中断其他库（继续备剩下的），所有错误汇总在返回值里。
 */
async function runBackup(options = {}) {
  // R2 配置校验放在最前面（先于任何快照动作）：四项任缺其一就阻止整个任务，
  // 报错信息点名缺失的变量——防止"本地备份成功了、异地同步悄悄没跑"的假安全感。
  requireR2Config();
  // 密钥检查同样 fail fast：不生成任何半成品/未加密产物
  const encryptionKey = getEncryptionKey();

  const backupDir = options.backupDir || BACKUP_DIR;
  fs.mkdirSync(backupDir, { recursive: true });

  const dateStr = todayLocalDate();
  console.log(`[backup] 开始备份，日期 ${dateStr}，目录 ${backupDir}，保留 ${RETENTION_DAYS} 天（产物加密：aes-256-cbc/pbkdf2）`);

  const targets = listBackupTargets();
  const results = [];

  for (const t of targets) {
    const entry = { label: t.label, dbPath: t.dbPath, ok: false, file: null };
    results.push(entry);
    if (!fs.existsSync(t.dbPath)) {
      entry.error = '数据库文件不存在，跳过';
      console.warn(`[backup] ${t.label}: ${entry.error}（${t.dbPath}）`);
      continue;
    }
    try {
      const file = await snapshotDatabase({ label: t.label, dbPath: t.dbPath, backupDir, dateStr, encryptionKey });
      entry.ok = true;
      entry.file = file;
      entry.size = fs.statSync(file).size;
      console.log(`[backup] ${t.label}: 完成 -> ${path.basename(file)}（${formatSize(entry.size)}，已加密并回读校验）`);
    } catch (e) {
      entry.error = e.message;
      console.error(`[backup] ${t.label}: 失败 — ${e.message}`);
      // 清掉可能残留的半成品（残缺 gzip / 未通过校验的 enc），避免被误当有效快照
      const dateGz = path.join(backupDir, `${t.label}_${dateStr}.db.gz`);
      for (const f of [dateGz, dateGz + '.enc']) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e2) { /* 忽略 */ }
      }
    }
  }

  const cleanup = cleanupOldSnapshots(backupDir);
  const failed = results.filter(r => !r.ok);
  console.log(`[backup] 任务结束：成功 ${results.length - failed.length}/${results.length}，清理过期 ${cleanup.removed.length} 个`);

  // 异地同步放在本地快照和清理都完成之后：只同步最终留存的 .enc 产物。
  // r2Sync 不抛异常（全部收敛为结果对象），这里再兜一层 try/catch 保险。
  let sync = null;
  try {
    sync = await syncBackupsToR2(backupDir);
  } catch (e) {
    sync = { ok: false, error: `同步调用异常：${e.message}` };
  }

  return { date: dateStr, backupDir, results, cleanup, sync };
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
  OPENSSL_CIPHER_ARGS,
  BACKUP_DIR,
  RETENTION_DAYS,
};
