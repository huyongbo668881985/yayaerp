# 欠款每日快照手册

每个租户库每天落一份"当前欠款水位"快照（`debt_snapshots` 表），积累按天时间序列，
供 API v1 趋势 / 环比查询。快照口径、日期口径、cron 编排均与备份任务（docs/BACKUP.md）对齐。

## 1. 它记什么

- **快照对象**：每个租户库每天 1 条**全公司汇总行**（`user_id = NULL`）+ **每个操作员 1 行**
  （`users` 表全量，无欠款记 0）——保证 `全公司行 = Σ 操作员行` 可对账，
  操作员欠款清零后趋势线表现为归零而不是断线。
- **欠款口径**：复用 `lib/profitCalc.js` 的 `effectiveDebtExpr`（口径唯一实现点），
  只累计"已审核 且 有效欠款 > 0.001"的销售单，与报表页"应收账款"完全一致：
  有效欠款 = 单据金额 − 已收现金 − 关联已审核退货金额。多付/退货抵扣产生的负欠款不对冲总额。
- **欠款客户数**（`debtor_customer_count`）：有效欠款 > 0.001 的销售单按客户去重计数，
  散客（无档案客户）算一组。
- **日期口径**：`snapshot_date` 为北京时间日期（`utils/dates.js`），与备份模块一致。

## 2. 表结构（各租户库，lib/schema.js 自动建表迁移）

```sql
CREATE TABLE debt_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,           -- YYYY-MM-DD，北京时间口径
  user_id INTEGER,                       -- NULL = 全公司汇总行
  total_debt REAL NOT NULL,
  debtor_customer_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE UNIQUE INDEX idx_debt_snapshots_date_user ON debt_snapshots(snapshot_date, user_id);
```

幂等说明：SQLite 的 UNIQUE 索引里 `NULL` 互不冲突，`user_id=NULL` 的全公司行靠索引拦不住
重复，所以写入侧用**事务内"先删当天再插"**实现幂等——手动重跑脚本 = 重算当天快照，
不会堆出脏数据（比 INSERT OR REPLACE 语义更强，后者对 NULL 行不生效）。

## 3. 手动执行

```bash
# Docker 部署（推荐）
docker compose exec jxc node scripts/debt-snapshot-run.js

# 宿主机直接跑
node scripts/debt-snapshot-run.js

# 补算指定日期（测试/补数用）
node scripts/debt-snapshot-run.js --date=2026-09-09
```

## 4. cron 定时（宿主机 cron 调容器，每天凌晨 02:25）

```cron
25 2 * * * cd /opt/jxc-app && /usr/bin/docker compose exec -T jxc node scripts/debt-snapshot-run.js >> /opt/jxc-app/data/debt-snapshot-cron.log 2>&1
```

- 与 02:30 的备份任务**错开 5 分钟**，避免两个任务同时写各租户库抢 SQLite 锁
  （脚本侧另有 `busy_timeout = 5000` 兜底，撞上了也是等 5 秒而不是报错）。
- 非 Docker 部署把中间一段换成 `/usr/bin/node scripts/debt-snapshot-run.js` 即可。
- 日志追加到 `data/debt-snapshot-cron.log`。

## 5. 查询（API v1，超管 Key，read_only 档位即可）

```
GET /api/v1/reports/debt-trend?start=YYYY-MM-DD&end=YYYY-MM-DD
```

- `start` / `end` 均可省略 = 查全部历史；返回按日期升序，同一天内全公司行在最前（user_id=NULL 排序在前）。
- 返回体：

```json
{ "items": [
  { "date": "2026-09-10", "user_id": null, "user_name": "全公司", "total_debt": 1500, "debtor_customer_count": 1 },
  { "date": "2026-09-10", "user_id": 1, "user_name": "管理员", "total_debt": 1500, "debtor_customer_count": 1 }
] }
```

- 环比/趋势在调用方（n8n）里算：取连续两个"全公司"行做差即可。

## 6. 失败告警

- 触发条件：任一租户快照失败，或任务整体异常（如 platform.db 读不了）。
- 邮件复用备份告警通道：收件人 `BACKUP_ALERT_EMAIL`，SMTP 配置同 docs/BACKUP.md 第 2 节，
  主题带"欠款快照"字样与失败租户数。
- 未配置 SMTP / 收件人时只跳过邮件不报错；退出码：全部成功 0，任一失败 1。

## 7. 验证清单（部署后逐项打勾）

- [ ] `docker compose exec jxc node scripts/debt-snapshot-run.js` 成功，退出码 0
- [ ] 任一租户库 `SELECT * FROM debt_snapshots` 有当天数据（全公司 1 条 + 每操作员 1 条）
- [ ] 立刻再跑一次 → 行数不变（幂等重算，无重复）
- [ ] `GET /api/v1/reports/debt-trend` 返回与库里一致；带 start/end 过滤正常；非法日期 400
- [ ] crontab 生效：次日 `data/debt-snapshot-cron.log` 有成功记录，且未与备份任务撞点

## 8. 故障排查

| 现象 | 原因与处理 |
|---|---|
| `租户库文件不存在，跳过` | tenants 表登记了但库文件被手工挪走；核对 `data/tenants/` |
| `SQLITE_BUSY` | 与其他写库任务撞锁；确认 cron 已与备份错开 5 分钟 |
| debt-trend 某天空档 | 当天任务失败或没跑；用 `--date=当天` 补算即可 |
| 邮件收不到 | 检查 `SMTP_HOST` 与 `BACKUP_ALERT_EMAIL`（未配置只跳过不报错） |
