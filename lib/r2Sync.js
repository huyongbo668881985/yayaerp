/**
 * 备份异地同步：rclone copy -> Cloudflare R2（S3 兼容）。
 *
 * 配置全部走环境变量（不需要 rclone.conf）：
 *   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 * rclone 侧通过 RCLONE_CONFIG_R2_* 环境变量动态定义名为 "r2" 的 remote，
 * 避免把凭据落进容器内的配置文件。
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

/** R2 四项必配是否齐全。任一缺失视为"未启用异地同步"。 */
function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

/** 缺了哪些必配项（给日志/报错用） */
function missingR2Config() {
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  return need.filter(k => !process.env[k]);
}

/** 组装 rclone 的环境变量：名为 r2 的 S3 remote 指向 Cloudflare R2 */
function buildRcloneEnv() {
  const accountId = process.env.R2_ACCOUNT_ID.trim();
  return {
    ...process.env,
    // 动态 remote 定义：r2 = S3 兼容存储，endpoint 指向 R2
    RCLONE_CONFIG_R2_TYPE: 's3',
    RCLONE_CONFIG_R2_PROVIDER: 'Cloudflare',
    RCLONE_CONFIG_R2_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com`,
    RCLONE_CONFIG_R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID.trim(),
    RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY.trim(),
    RCLONE_CONFIG_R2_ACL: 'private',
  };
}

/**
 * 同步备份目录到 R2。
 * 返回 { ok, skipped?, reason?, exitCode?, stderrTail?, stdoutTail?, remote, durationMs, error? }
 * 任何异常（rclone 不存在、超时、非0退出）都收敛为 ok:false + 错误信息，不抛出。
 */
function syncBackupsToR2(backupDir) {
  if (!isR2Configured()) {
    const missing = missingR2Config().join(', ');
    console.log(`[r2sync] 未配置 R2 环境变量（缺 ${missing}），跳过异地同步（仅本地保留）`);
    return Promise.resolve({ ok: true, skipped: true, reason: `未配置 ${missing}` });
  }
  if (!fs.existsSync(backupDir)) {
    return Promise.resolve({ ok: false, error: `备份目录不存在：${backupDir}` });
  }

  const bucket = process.env.R2_BUCKET.trim();
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

module.exports = { syncBackupsToR2, isR2Configured, missingR2Config, buildRcloneEnv };
