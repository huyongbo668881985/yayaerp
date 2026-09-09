# 数据备份与异地容灾手册

本地 7 天滚动快照（加密）+ Cloudflare R2 异地备份（7 天生命周期自动过期）+ 失败邮件告警。

## 1. 架构与流程

```
node scripts/backup-run.js（手动 / 宿主机 crontab 每日触发）
   │
   ├─ ① 全量快照     better-sqlite3 .backup()（在线一致性备份，不阻塞业务写入）
   ├─ ② gzip 压缩    标准 gzip，gunzip 可解
   ├─ ③ 加密         openssl enc -aes-256-cbc -pbkdf2 -iter 262144
   │                 密钥 = 环境变量 BACKUP_ENCRYPTION_KEY
   ├─ ④ 回读校验     解密 → 解压 → 校验 SQLite 文件头（保证当天快照 100% 可还原）
   ├─ ⑤ 本地清理     删除文件日期早于 今天-7天 的快照（逐条记日志）
   └─ ⑥ rclone copy  整个备份目录同步到 Cloudflare R2（未配置 R2_* 则跳过）
                     R2 端过期删除由 bucket Lifecycle Rule 负责，应用层不删远端
   │
   └─ 任一环节失败 → 告警邮件（BACKUP_ALERT_EMAIL），退出码 1
```

- 备份范围：`data/platform.db`（平台库）+ 全部租户库（含已暂停租户）；`sessions.db` 是临时会话不备份。
- 产物命名：`{label}_{YYYY-MM-DD}.db.gz.enc`，label 为 `platform` 或租户代码，如 `demo_2026-09-09.db.gz.enc`。
- 每次都是**全量快照**，无增量；库都在 KB~MB 级，全量最简单可靠。
- 备份目录：`data/backups/`（Docker volume 内，随 data 一起持久化）。

## 2. 环境变量总表（.env）

| 变量 | 必填 | 说明 |
|---|---|---|
| `BACKUP_ENCRYPTION_KEY` | ✅（跑备份时） | 快照加密密钥，`openssl rand -hex 32` 生成。**丢失=备份永久不可解密** |
| `BACKUP_DIR` | | 备份输出目录，默认 `data/backups` |
| `BACKUP_RETENTION_DAYS` | | 本地保留天数，默认 7（保留 今天-7天 ~ 今天 共 8 个自然日） |
| `R2_ACCOUNT_ID` | R2 四项 | Cloudflare 账户 ID（R2 概览页） |
| `R2_ACCESS_KEY_ID` | | R2 API Token 的 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | | R2 API Token 的 Secret Access Key |
| `R2_BUCKET` | | 目标 bucket 名，如 `jxc-backups` |
| `R2_PREFIX` | | bucket 内前缀，如 `backups`，留空存根目录 |
| `RCLONE_PATH` | | rclone 可执行文件路径，默认用 PATH 里的 `rclone` |
| `R2_SYNC_TIMEOUT_MS` | | 同步超时（毫秒），默认 15 分钟，超时终止并告警 |
| `BACKUP_ALERT_EMAIL` | | 告警收件邮箱；SMTP 发信复用 `SMTP_HOST/PORT/USER/PASS/FROM` |
| `JXC_DATA_DIR` | | 数据目录重定向，**仅测试用**，正常部署不要配 |

四项 `R2_*` 全配才启用异地同步；缺任何一项只做本地备份并在日志中说明（不算失败、不发告警）。

## 3. 密钥管理（务必读）

1. 生成：`openssl rand -hex 32`
2. 使用：写入服务器 `.env` 的 `BACKUP_ENCRYPTION_KEY`（`.env` 不进 git，`docker-compose` 通过 `env_file` 注入容器）
3. **另行保管一份**：密码管理器或离线介质。`.env` 丢了、服务器挂了、备份还想解密——全靠这第二份。
4. 解密工具要求：OpenSSL ≥ 1.1.1（支持 `-pbkdf2 -iter`）。本机 macOS（OpenSSL 3.x）与容器内 Debian bookworm（OpenSSL 3.0）均可用。
5. **加密参数是恢复契约的一部分**：`-aes-256-cbc -pbkdf2 -iter 262144 -salt`。未来更换解密环境时按第 6 节的命令原样执行即可。

## 4. 手动执行与 cron 定时

手动跑一次：

```bash
# 宿主机直接跑（需要 node + openssl + rclone）
node scripts/backup-run.js

# Docker 部署在服务器上跑（推荐，环境变量随容器注入）
docker compose exec jxc node scripts/backup-run.js
```

crontab（**宿主机 cron 调容器**，每天凌晨 02:30）：

```cron
30 2 * * * cd /opt/jxc-app && /usr/bin/docker compose exec -T jxc node scripts/backup-run.js >> /opt/jxc-app/data/backups/backup-cron.log 2>&1
```

非 Docker 部署（直接 node 跑）：

```cron
30 2 * * * cd /opt/jxc-app && /usr/bin/node scripts/backup-run.js >> /opt/jxc-app/data/backups/backup-cron.log 2>&1
```

- 日志追加到 `data/backups/backup-cron.log`，清理/同步/告警行为都在里面可查。
- 同一天重复执行安全：本地同名文件覆盖；rclone copy 幂等（跳过远端相同文件）。

## 5. Cloudflare R2 配置步骤（控制台操作）

1. **创建 bucket**：R2 → Create bucket，名字如 `jxc-backups`，区域随便（建议 APAC）。
2. **创建 API Token**：R2 → Manage R2 API Tokens → Create API Token → 权限 **Object Read & Write**，范围限定到该 bucket。记下 Access Key ID / Secret Access Key，账户 ID 在 R2 概览页。
3. **配置 .env**：填上第 2 节的四项 `R2_*`，`docker compose up -d` 重建容器生效。
4. **配置 Lifecycle Rule（R2 端 7 天自动过期）**：
   - bucket → Settings → Lifecycle rules → Add rule
   - 条件：**Apply to objects with prefix** = `backups/`（即 `.env` 里 `R2_PREFIX` 对应的前缀；若 R2_PREFIX 留空则规则作用于整个 bucket）
   - 动作：**Delete objects**，条件 **Object age > 7 days**（自上传时间起算）
   - 保存。R2 不支持直接"试跑"，验收方式：记录规则保存时的状态为 Enabled / 作用于正确前缀；本地与 R2 保留窗口略有出入（本地 8 个自然日、R2 严格 7×24h）属正常，双保险口径。
5. **连通性验证**：容器内跑一次 `docker compose exec jxc node scripts/backup-run.js`，然后到 bucket 的 Objects 页确认出现 `backups/{label}_{日期}.db.gz.enc`。
6. 顺手下载一个对象，用第 6 节命令解密成功 → 全链路闭环。

## 6. 恢复方法（解密）

推荐用恢复脚本（自动解密 + 解压 + 完整性检查）：

```bash
# 容器内
docker compose exec jxc node scripts/backup-restore.js data/backups/demo_2026-09-09.db.gz.enc /tmp/restored

# 宿主机
node scripts/backup-restore.js data/backups/demo_2026-09-09.db.gz.enc ./restored
```

不依赖本脚本的手工恢复（解密参数必须与加密完全一致）：

```bash
BACKUP_ENCRYPTION_KEY='你的密钥' openssl enc -aes-256-cbc -pbkdf2 -iter 262144 -d \
  -in demo_2026-09-09.db.gz.enc -out demo.db.gz -pass env:BACKUP_ENCRYPTION_KEY
gunzip -c demo.db.gz > demo.db
# 验证
sqlite3 demo.db "PRAGMA integrity_check;"
```

恢复上线：把还原出的 `.db` 放回 `data/tenants/<租户代码>.db`（平台库为 `data/platform.db`），重启服务。

## 7. 失败告警

- 触发条件：任一库快照失败、rclone 同步非 0 退出/超时/启动失败。
- 邮件包含：备份日期、失败时间、失败项（租户/环节）、错误信息（rclone stderr 截尾保留 800 字）、本地清理情况。
- 收件人 `BACKUP_ALERT_EMAIL`，发信走现有 SMTP 配置。
- 告警发送本身失败只记日志，不会让备份任务崩溃；任务退出码：全部成功 0，任一失败 1。

## 8. 验证清单（部署后逐项打勾）

- [ ] `docker compose exec jxc node scripts/backup-run.js` 成功，`data/backups/` 出现当天 `.db.gz.enc`，无明文 `.db.gz`/`.tmp` 残留
- [ ] `node scripts/backup-restore.js <某个 .enc>` 还原出库且 `integrity_check: ok`
- [ ] R2 bucket 中出现对应加密对象
- [ ] 故意改错 `R2_SECRET_ACCESS_KEY` 跑一次 → 收到告警邮件，内容可定位问题（退出码 + stderr）
- [ ] 构造 8 天前文件名的历史快照跑一次 → 被删除，`backup-cron.log` 有 `[cleanup] 已删除过期快照` 记录
- [ ] R2 Lifecycle Rule 状态 Enabled、前缀正确（R2 控制台 bucket → Settings 核对）

## 9. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `缺少 BACKUP_ENCRYPTION_KEY` | .env 没配或容器没重建（`docker compose up -d` 重新注入） |
| `openssl 退出码 1：bad decrypt` | 密钥不对或文件不完整；确认用的是加密时同一把密钥 |
| `rclone 启动失败` | 容器内需镜像含 rclone（本仓库 Dockerfile 已装）；宿主机自行安装 |
| 同步报 `AccessDenied` | R2 API Token 权限不足或失效，重新签发 Object Read & Write token |
| 同步超时（15 分钟被终止） | 检查服务器到 R2 的网络；或调大 `R2_SYNC_TIMEOUT_MS` |
| 邮件收不到 | 检查 `SMTP_HOST` 与 `BACKUP_ALERT_EMAIL` 是否配置（未配置只跳过不报错） |
