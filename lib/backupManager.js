/**
 * 备份管理器：多租户 SQLite 全量快照 + gzip 压缩 + 本地 7 天滚动清理。
 *
 * 备份范围：data/platform.db（平台库，含租户清单/管理员/审计日志）
 *          + tenants 表里登记的每一个租户库（含已暂停的，数据还在就要备）。
 *          sessions.db 是临时会话，不备份。
 *
 * 快照方式：better-sqlite3 的 .backup() API（底层 sqlite3_backup），
 *          对正在写入的库也能拿到一致性快照（WAL 模式下在线备份不阻塞业务）。
 *          每次都是全量快照，不做增量——库都很小（KB~MB 级），全量最简单也最可靠。
 *
 * 文件命名：{label}_{YYYY-MM-DD}.db.gz，label 为 "platform" 或租户代码。
 *
 * 日期口径：全站统一北京时间（复用 utils/dates.js），避免 UTC 偏移导致
 *          凌晨备份的文件名日期错位。
 *
 * 触发方式：本模块不内置定时器，由 scripts/backup-run.js 作为入口，
 *          手动执行或宿主机 crontab 定时调用。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const { todayLocalDate } = require('../utils/dates');

// 数据目录。JXC_DATA_DIR 仅测试/特殊部署场景用来重定向，正常部署不用配。
const DATA_DIR = process.env.JXC_DATA_DIR || path.join(__dirname, '..', 'data');
// 备份目录，默认 data/backups（生产环境该目录在 Docker volume 内，随 data 一起持久化）
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups');
// 本地保留天数：保留 [今天-N天, 今天] 的快照，文件日期早于 今天-N天 的删除。
// 默认 7，即实际保留 8 个自然日（今天 + 前 7 天），略宽松于"最近 7 天"，安全侧偏移。
const RETENTION_DAYS = Number(process.env.BACKUP_RETENTION_DAYS || 7);

// 快照文件名：{label}_{YYYY-MM-DD}.db.gz[.enc]（.enc 为后续加密步骤预留，清理逻辑两种后缀都认）
const SNAPSHOT_FILENAME_RE = /^(.+)_(\d{4}-\d{2}-\d{2})\.db\.gz(\.enc)?$/;

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
 * 单库全量快照：better-sqlite3 .backup() 生成一致性副本 -> gzip 压缩。
 * 中间产物（未压缩的 .tmp 副本）完成即删，备份目录里只留最终文件。
 */
async function snapshotDatabase({ label, dbPath, backupDir, dateStr }) {
  const target = path.join(backupDir, `${label}_${dateStr}.db.gz`);
  const tmpCopy = target + '.tmp';

  try {
    // 在线一致性备份：readonly 打开源库（只读不干扰业务连接），.backup() 返回 Promise
    const src = new Database(dbPath, { readonly: true });
    try {
      await src.backup(tmpCopy);
    } finally {
      try { src.close(); } catch (e) { /* 忽略 */ }
    }

    await gzipFile(tmpCopy, target);
    return target;
  } finally {
    // 无论成功失败都清掉未压缩的中间副本，不留明文残片
    try { if (fs.existsSync(tmpCopy)) fs.unlinkSync(tmpCopy); } catch (e) { /* 忽略 */ }
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
 * 执行一次完整备份任务：逐库快照 -> 汇总结果 -> 清理过期快照。
 * 单个库失败不中断其他库（继续备剩下的），所有错误汇总在返回值里。
 */
async function runBackup(options = {}) {
  const backupDir = options.backupDir || BACKUP_DIR;
  fs.mkdirSync(backupDir, { recursive: true });

  const dateStr = todayLocalDate();
  console.log(`[backup] 开始备份，日期 ${dateStr}，目录 ${backupDir}，保留 ${RETENTION_DAYS} 天`);

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
      const file = await snapshotDatabase({ label: t.label, dbPath: t.dbPath, backupDir, dateStr });
      entry.ok = true;
      entry.file = file;
      entry.size = fs.statSync(file).size;
      console.log(`[backup] ${t.label}: 完成 -> ${path.basename(file)}（${formatSize(entry.size)}）`);
    } catch (e) {
      entry.error = e.message;
      console.error(`[backup] ${t.label}: 失败 — ${e.message}`);
      // 清掉可能残留的半成品 gzip，避免残缺文件被误当有效快照同步/保留
      const broken = path.join(backupDir, `${t.label}_${dateStr}.db.gz`);
      try { if (fs.existsSync(broken)) fs.unlinkSync(broken); } catch (e2) { /* 忽略 */ }
    }
  }

  const cleanup = cleanupOldSnapshots(backupDir);
  const failed = results.filter(r => !r.ok);
  console.log(`[backup] 任务结束：成功 ${results.length - failed.length}/${results.length}，清理过期 ${cleanup.removed.length} 个`);

  return { date: dateStr, backupDir, results, cleanup };
}

module.exports = {
  runBackup,
  cleanupOldSnapshots,
  snapshotDatabase,
  listBackupTargets,
  subtractDays,
  BACKUP_DIR,
  RETENTION_DAYS,
};
