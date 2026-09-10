# 鸭鸭进销存

面向快消品小团队的多租户进销存 SaaS：多仓库、仓库间调拨（车销小库房场景）、箱/瓶双单位换算、采购/销售/退货全流程审核、实时库存与预警、经营报表。

- 后端：Node.js + Express + better-sqlite3（同步、单文件库，无需额外数据库服务）
- 前端：服务端渲染（EJS）+ 原生 JS，无需构建
- 多租户：每个租户一个独立 SQLite 文件（`data/tenants/<租户代码>.db`），平台信息在 `data/platform.db`
- 部署：Docker Compose，配 Nginx 反代即可对外服务

---

## 一、两种登录入口

| 入口 | 地址 | 说明 |
|---|---|---|
| 租户后台 | `/login` | 租户代码 + 用户名 + 密码，给客户团队日常使用 |
| 平台管理 | `/platform-admin/login` | 平台超管：开租户、停租户、改配额、重置租户账号密码 |

- 首次启动自动创建平台超管：`superadmin / super123`，**登录后立刻改密码**
- 租户账号由平台超管创建，或由客户在官网自助注册（见下）

## 二、官网试用自助注册

`/welcome` 是产品介绍页，客户填手机号获取验证码即可自助开通 **7 天试用**（最多 5 个账号），验证码由阿里云「短信认证服务」下发和校验（`.env` 里配好 AK 即可，签名模板用阿里云赠送的，无需自己申请）。

开通后页面直接展示租户代码和管理员账号密码，客户即可登录使用。

## 三、本地开发

```bash
npm install
cp .env.example .env
# .env 里至少设置 SESSION_SECRET（openssl rand -hex 32 生成），缺失或太短服务会拒绝启动
node app.js
```

## 四、Docker 部署

```bash
cd /opt/jxc-app
cp .env.example .env
vim .env    # SESSION_SECRET 必填；HTTPS 配好后 COOKIE_SECURE=true、TRUST_PROXY=1
docker compose up -d --build
```

- 容器只监听本机 `3000` 端口，交给 Nginx Proxy Manager 反代并签 SSL
- `.env` 通过 `env_file` 整体注入容器；`.dockerignore` 保证它不会被打进镜像

## 五、核心功能

- **审核流**：销售/退货/调拨单走 `草稿 → 待审核 → 已审核/已拒绝` 状态机，审核通过才动库存，反审核自动回滚库存（先校验库存够不够，防止拉成负数）
- **存草稿**：新建销售/退货/调拨单时可以"存草稿"，之后在详情页继续编辑或提交审核
- **箱/瓶双单位**：商品可设大单位 + 换算比例，单据按箱或瓶录入，库存统一按基本单位
- **成本快照**：开单瞬间锁定成本价，事后改商品成本价不影响历史毛利
- **财务管理**：销售单分批收款、退货冲抵、"有效欠款"口径（销售列表/看板/经营报表三处一致）
- **权限**：管理员（全部）/ 操作员（无采购、无成本价、只看自己单据）；账号可禁用（立即生效）不可乱删（保历史单据归属）
- **配额**：租户可设到期日、账号数上限，超期/超限自动拦截

## 六、数据备份

内置备份系统：**本地 7 天滚动快照（gzip + AES-256 加密）+ rclone 同步 Cloudflare R2（7 天生命周期过期）+ 失败邮件告警**。

```bash
# 手动执行一次（Docker 部署）
docker compose exec jxc node scripts/backup-run.js

# 恢复某个快照
docker compose exec jxc node scripts/backup-restore.js data/backups/demo_2026-09-09.db.gz.enc ./restored
```

环境变量（`BACKUP_ENCRYPTION_KEY` 与 R2 四项 `R2_ACCOUNT_ID`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME` 均为**跑备份的硬性前提**，缺任一项任务启动即报错退出；`BACKUP_ALERT_EMAIL` 告警收件；真实密钥值只在服务器 `.env` 手动填写，不进 git）与 crontab 定时配置、Cloudflare 令牌创建步骤、R2 Lifecycle Rule、完整恢复命令，见 **[docs/BACKUP.md](docs/BACKUP.md)**。

兜底冷备（可选）：停机窗口内整体拷贝 `data/` 目录仍完全有效（platform.db + 各租户 db；sessions.db 是临时会话，可不拷）。

## 七、API v1（超管专属，供 n8n / Codex 等自动化工具对接）

独立于 Web 登录体系的 REST API，用 API Key 认证（`Authorization: Bearer <key>` 或 `X-API-Key` 请求头），目前**只在平台超管后台使用，不对租户开放**（租户设置页无任何入口）。

- **Key 管理**：登录 `/platform-admin` → 「API Key」页面：选租户 + 选档位生成。明文只在生成那一刻展示一次，之后列表里只有前缀（`jxc_xxxx…`），丢失只能吊销重发。生成/吊销/改档位全部记入审计日志。
- **权限三档**：`read_only`（只读）/ `read_write`（读+写）/ `full`（最大权限）。**当前只开放只读档位对应的端点**，后两档为未来写接口预留（选了也暂无对应端点）。
- **限流**：按 Key 维度每分钟限流（n8n/Codex 来源 IP 固定，按 IP 限流会互相误伤），阈值用环境变量 `API_RATE_LIMIT_PER_MIN` 配置，默认 60，超限返回 429。
- **租户隔离**：每个 Key 绑定一个租户，所有查询只返回该租户自己的数据；请求参数里传任何租户标识都会被忽略。

当前只读端点（金额保留 2 位小数）：

| 端点 | 说明 |
|---|---|
| `GET /api/v1/reports/summary?date=YYYY-MM-DD` | 当日汇总：销售额、退货额、应收、毛利（含/不含应收两种口径）。`date` 不传默认今天 |
| `GET /api/v1/reports/leaderboard?date=YYYY-MM-DD` | 团队业绩排行：按录单人统计当日已审核销售额−退货额，净额降序 |
| `GET /api/v1/sales?start=&end=&status=&page=&pageSize=` | 销售单列表，SQL 层分页（pageSize 默认 50、上限 200，status 可选 draft/submitted/approved/rejected） |
| `GET /api/v1/inventory?warehouse_id=` | 当前库存快照（商品 × 仓库），可按仓库过滤 |

错误响应统一为 `{ "error": { "code", "message" } }`：`400` 参数非法（附原因）、`401` Key 缺失/无效/已吊销或租户不可用、`403` 权限档位不足、`404` 端点不存在、`429` 触发限流。

本地/测试环境跑租户隔离与限流回归（会创建 `apitest_` 前缀的临时租户并在结束时自动清理）：

```bash
SESSION_SECRET=$(openssl rand -hex 32) node tests/api-isolation-test.js
```

## 八、后续可扩展方向（现在没做，等真的需要再加）

- 客户/供应商往来账款、应收应付账龄
- Excel 导入导出
- 更多报表维度（商品排行等；业务员业绩排行已随 API v1 leaderboard 端点交付）
- 条码扫码录入
- API v1 的 read_write / full 档位写接口（权限框架已就位，按需开放）
