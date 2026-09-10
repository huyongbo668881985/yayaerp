/**
 * 备份异地同步：rclone copy -> Cloudflare R2（S3 兼容）。
 *
 * 配置全部走环境变量（不需要 rclone.conf）：
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME
 *   R2_ENDPOINT 可选覆盖访问端点（默认由 R2_ACCOUNT_ID 推导为
 *   https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com）
 * rclone 侧通过 RCLONE_CONFIG_R2_* 环境变量动态定义名为 "r2" 的 remote，
 * 凭据只经进程环境传递，绝不落进 rclone 配置文件（配置文件可能被意外提交或残留在服务器上）。
 *
 * 旧变量名 R2_BUCKET 仍然兼容（读不到 R2_BUCKET_NAME 时回退并打警告），但文档与
 * .env.example 一律以 R2_BUCKET_NAME 为准，建议尽快改名。
 *
 * 配置校验是"必填"语义：四项任缺其一，requireR2Config() 会抛错点名缺失的变量，
 * 备份任务在启动阶段就被阻止——宁可失败也绝不静默降级成"只做本地备份"，
 * 否则异地容灾形同虚设而没人发现。
 *
 * 同步方式刻意用 copy 而不是 sync：
 *   copy 只上传新增/变化的文件，本地异常时也不会反向删除 R2 端历史数据；
 *   R2 端的过期删除交给 bucket 的 Lifecycle Rule（7 天自动过期），应用层不写删除逻辑。
 *
 * 幂等性：rclone copy 按"大小+修改时间"跳过远端已存在的相同文件，
 * 同一天重复执行备份不会造成重复对象。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// rclone 单次同步的兜底超时：网络卡死时 kill 掉，避免 cron 任务永久挂住
const SYNC_TIMEOUT_MS = Number(process.env.R2_SYNC_TIMEOUT_MS || 15 * 60 * 1000);

/** 解析目标 bucket：R2_BUCKET_NAME 为准，兼容旧名 R2_BUCKET */
function getR2Bucket() {
  const primary = (process.env.R2_BUCKET_NAME || '').trim();
  if (primary) return primary;
  const legacy = (process.env.R2_BUCKET || '').trim();
  if (legacy) {
    console.warn('[r2sync] 检测到旧变量名 R2_BUCKET，仍兼容但建议改用 R2_BUCKET_NAME（见 .env.example）');
    return legacy;
  }
  return '';
}

/** 解析 S3 端点：R2_ENDPOINT 显式覆盖优先，否则由 R2_ACCOUNT_ID 推导 */
function getR2Endpoint() {
  const explicit = (process.env.R2_ENDPOINT || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  return `https://${process.env.R2_ACCOUNT_ID.trim()}.r2.cloudflarestorage.com`;
}

/** 缺了哪些必配项（给日志/报错用，报错信息里直接点名变量名） */
function missingR2Config() {
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']
    .filter(k => !(process.env[k] || '').trim());
  if (!getR2Bucket()) missing.push('R2_BUCKET_NAME');
  return missing;
}

/**
 * 必填校验：缺失就抛错并逐个点名缺哪些变量。
 * 备份任务入口（runBackup）在最开始调用，阻止任何"半配置"状态跑出假成功。
 */
function requireR2Config() {
  const missing = missingR2Config();
  if (missing.length > 0) {
    throw new Error(
      `R2 备份同步配置缺失：${missing.join(', ')}。` +
      `请在服务器 .env 中补齐这 ${missing.length} 个变量（真实值获取方式见 docs/BACKUP.md 第 5 节），` +
      `Docker 部署改完执行 docker compose up -d 重建容器生效。` +
      `缺失时备份任务拒绝执行（不静默降级为仅本地备份）`
    );
  }
}

/** 四项必配是否齐全（仅供展示/探测；任务执行一律用 requireR2Config 阻断） */
function isR2Configured() {
  return missingR2Config().length === 0;
}

/** 组装 rclone 的环境变量：名为 r2 的 S3 remote 指向 Cloudflare R2 */
function buildRcloneEnv() {
  return {
    ...process.env,
    // 动态 remote 定义：r2 = S3 兼容存储，endpoint 指向 R2
    RCLONE_CONFIG_R2_TYPE: 's3',
    RCLONE_CONFIG_R2_PROVIDER: 'Cloudflare',
    RCLONE_CONFIG_R2_ENDPOINT: getR2Endpoint(),
    RCLONE_CONFIG_R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID.trim(),
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY.trim(),
    RCLONE_CONFIG_R2_ACL: 'private',
  };
}

/**
 * 同步备份目录到 R2。
 * 返回 { ok, exitCode?, stderrTail?, stdoutTail?, remote, durationMs, error? }
 * 未配置 R2 环境变量时抛错（requireR2Config）——调用方 backupManager 会把它
 * 计入任务失败并发告警，绝不静默跳过。
 */
function syncBackupsToR2(backupDir) {
  requireR2Config(); // 未配置直接抛错，绝不带着空配置往下跑
  if (!fs.existsSync(backupDir)) {
    return Promise.resolve({ ok: false, error: `备份目录不存在：${backupDir}` });
  }

  const bucket = getR2Bucket();
  const prefix = (process.env.R2_PREFIX || '').trim().replace(/^\/+/, '');
  const remote = `r2:${bucket}${prefix ? '/' + prefix : ''}`;
  // rclone 命令名可用 RCLONE_PATH 覆盖（默认 PATH 里的 rclone）
  const rcloneBin = process.env.RCLONE_PATH || 'rclone';
  const args = ['copy', path.resolve(backupDir), remote, '--transfers', '4', '--checkers', '8'];

  return new Promise(resolve => {
    const startedAt = Date.now();
    console.log(`[r2sync] 开始同步 ${backupDir} -> ${remote}（rclone copy）`);
    const child = spawn(rcloneBin, args, {
      env: buildRcloneEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SYNC_TIMEOUT_MS);

    child.on('error', err => {
      clearTimeout(timer);
      resolve({
        ok: false,
        error: `rclone 启动失败（${err.message}）。容器内请确认已安装 rclone；宿主机请先安装（brew install rclone / apt install rclone）`,
        remote,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        resolve({
          ok: false,
          error: `rclone 同步超时（>${Math.round(SYNC_TIMEOUT_MS / 60000)} 分钟），已终止`,
          remote, durationMs,
          stderrTail: stderr.slice(-800),
        });
        return;
      }
      if (code === 0) {
        console.log(`[r2sync] 同步完成（${(durationMs / 1000).toFixed(1)}s）`);
        resolve({ ok: true, exitCode: 0, remote, durationMs });
        return;
      }
      console.error(`[r2sync] 同步失败：退出码 ${code}${signal ? `（信号 ${signal}）` : ''}`);
      resolve({
        ok: false,
        exitCode: code,
        signal: signal || undefined,
        error: `rclone 退出码 ${code}`,
        remote,
        durationMs,
        // 只保留 stderr 尾部：错误信息通常在末尾，也避免邮件里塞进几千行日志
        stderrTail: stderr.trim().slice(-800),
        stdoutTail: stdout.trim().slice(-300),
      });
    });
  });
}

module.exports = {
  syncBackupsToR2,
  isR2Configured,
  missingR2Config,
  requireR2Config,
  getR2Bucket,
  getR2Endpoint,
  buildRcloneEnv
};
