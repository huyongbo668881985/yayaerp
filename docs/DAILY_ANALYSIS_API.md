# 每日经营日报只读 API

本地实现与验证完成；**尚未部署，未验证线上接口**。本地没有 yongfeng 租户库，不能给出其真实历史起始日期。示例来自临时数据库，与真实客户、员工和凭据无关。

## 请求与权限

使用现有 `Authorization: Bearer <API Key>` 或 `X-API-Key`。Key 自动选择独立租户 SQLite 库，tenant_code/tenant_id 参数不能切换租户。三个接口仅 GET，最低权限 read_only；沿用每 Key 限流、JSON 错误 `{ "error": { "code": "invalid_param", "message": "…" } }`。认证照常刷新平台库 last_used_at，不写业务记录。迁移在已有 initSchema 打开租户库流程执行，部署时应先完成迁移。

金额 CNY 数值、最多两位小数（JSON 数值 100 与 100.00 等价），内部整数分累计；超出精确范围返回 400。所有日期为真实 YYYY-MM-DD。北京时间固定 UTC+8；时间戳明确携带 Z 或 +08:00。数组日期、非法 ID、起止颠倒返回 400。列表 page 默认 1，pageSize 默认 50、范围 1–200；超页返回空数组，total_pages 最少 1。日报只接受早于北京时间今天的日期。

## 1. GET /api/v1/reports/daily-analysis?date=YYYY-MM-DD

不传 date 为北京时间昨天；month_start 为统计日期所在月份 1 日。每天北京时间 05:00 调用即可，不需要在服务内启动定时器。整个取数在一个 SQLite 读事务中完成。

顶层字段：tenant_code、tenant_name、date、month_start、timezone、fetched_at（实际取数 UTC 时间）、cutoff_exclusive（次日北京时间零点）、company、salespeople、unassigned、meta。

company、每位 salespeople、unassigned 都有同构指标；人员另有 user_id、user_name、rank（本月净销售额降序，金额未知则 null，同额按 ID 排序）。未分配不排名。

| 对象/字段 | 中文口径 |
|---|---|
| daily / month_to_date | 当日 / 月初至统计日期闭区间 |
| net_sales_amount | 期间单据日期的销售入账金额减退货入账金额，截止统计日流水重建审核状态 |
| returns_amount | 期间退货入账额，反审核/撤销冲回；不是现金退款 |
| gross_profit_with_receivable | 含应收毛利：入账时销售明细收入减成本，再减退货毛利；成本沿用 profitCalc 原销售加权成本/原明细成本口径 |
| gross_margin | 含应收毛利 / 净销售额，比例值（0.4=40%）；净销售额为 0 或毛利未知返回 null |
| actual_receipts | 明确现金发生日的实际收款，含本月收回以前月份欠款 |
| cash_refunds | 明确现金发生日的实际退款，正数 |
| net_cash_received | 实际收款减现金退款 |
| known_receipts / known_cash_refunds | 即使现金完整性不足，仍返回已明确记录的现金部分，不能当作全部完成额 |
| completeness / reasons | 销售、毛利、现金是否完整及 null 原因 |
| customers.new_daily | 统计日创建客户数，含当日创建后删除客户，按截止日最后已知归属 |
| customers.new_month_to_date | 月初至统计日新增客户数，历史不足则 null，month_reason 说明原因 |
| customers.total_at_end | 截止日仍存在客户数量，按客户历史重建，旧客户无需知道创建日期即可包含在基线以后总数中 |
| customers.complete / reason | 日末客户数量历史完整性与原因 |
| debt.receivable_at_end | 截止日每个账户的正余额之和 |
| debt.pending_refund_at_end | 截止日每个账户的负余额绝对值之和，不与其他账户应收抵销 |
| debt.debtor_customer_count | 有正余额账户的客户 ID 去重，散客合为一个客户分组 |
| debt.month_new_orders_remaining | 本月单据日期的销售账户截至统计日的正余额之和 |
| debt.month_new_receivable | 本月事件日期累计正向销售入账额，含重审核再次发生的应收；不扣回款、退货和反审核，不含升级结转，不等于本月订单剩余欠款 |
| debt.receivable_change_since_month_start | 统计日末累计应收减上月最后一日日末累计应收；待退单独列示 |
| debt.complete / reason / month_reason | 日末或月初历史不足、旧退货账户归属无法核实的原因 |

### 人员归属与名单

- 订单、关联退货、收退款及欠款统一按**取数时原销售单 responsible_id**，为空时回退 user_id。财务操作者不享有业绩归属。历史负责人调整会改变重跑归属；接口明确 `historical_attribution_complete=false`，没有声称保存了历史负责人快照。
- 关联退货按 customer_ledger_accounts 保存的销售账户归属，避免使用后来修改的退货关联；独立退货为独立负账户，进入未分配。旧 `legacy_unverified` 关联无法核实，相关流水归未分配，日末应收/待退/欠款客户数返回 null。
- 客户按截止时点 report_customer_history 中最后一条记录的 operator_id；迁移前的归属、删除历史无法恢复。客户属于非名单人员或未分配时进入未分配。
- 原角色只有 admin/operator，operator 同时可能负责仓库、财务等岗位。因此新建明确的 report_salespeople 任职区间名单，必须人工确认；查询列出任职区间与统计月份 1 日至统计日重叠的人员（即使禁用账号或没有交易），不自动推断业务员。名单不含管理员。名单外订单业绩仍保留在未分配，不丢公司金额。
- `meta.roster_complete` 表示运维是否确认完整名单；未配置时 salespeople=[]，数据都归未分配。确认空名单和未确认名单不同，消费者必须检查该标记。
- 金额公司合计等于个人加未分配；欠款客户数公司跨人员再次去重，同客户在两个业务员的订单欠款不应把客户数直接相加。客户档案总数与新增数按唯一客户归属分组。

### 数据时间口径与不可恢复部分

`meta` 返回 ledger_available_from、cash_available_from、customer_history_started_at、customer_history_available_from、profit_snapshot_available_from、sales_available_from、各指标口径、币种时区、名单完整性。

1. 流水起点是租户已有 ledger_metadata.opening_date。升级结转记录存量账务，不代表当天现金。起点之前的销售及日末欠款返回 null；起点以后按流水重建分单余额，不读取当前 paid_amount 拼成过去的余额。原 debt_snapshots 实际是执行时余额，即使把 snapshot_date 传成昨天也不是昨日末；本接口完全不用它。
2. 现金的最早**完整整日**是 opening_date 次日。已有“收款”“退款”正向事件可以确定发生日和记账时间；“审核入账”中带入的 paid_amount 无法证明实际现金日期。若未知预收款从建单至审核的可能日期与查询期间重叠，现金三个完成额返回 null；未入账但已填 paid_amount 的订单也保守标为不完整。即使后来审核发生在统计日之后，也会披露其可能影响。反审核不撤销真实现金；退货抵扣不是现金；升级结转不计现金。需要精确覆盖所有开单预收款时，另行增加真实现金凭证/日期采集流程，本次不会凭订单日或审核日编造现金日。
3. 原客户没有创建时间，迁移给存量客户保留 NULL。迁移只记录当时存在的客户基线；之后创建、归属调整、改名、删除通过数据库触发器留痕，包含导入路径。客户日末数量完整起点是迁移北京时间次日，以免把迁移当天此前的删除/新增漏记当作完整。旧创建日期永远未知，不能用首单代替。月份包含起点前日期时，本月新增客户返回 null。
4. 新 report_ledger_facts 在入账时追加不可变毛利快照，不改旧流水。旧流水和升级结转没有历史成本快照，若期间涉及这些销售/退货，毛利为 null；不能承诺所有租户在某日后毛利一定完整，因为之后可能仍退回旧单。profit_snapshot_available_from 仅表示新采集的完整整日起点。
5. 单据可补审核；按截止 event_date 重建状态，销售按 document_date 归期。反审核按原单日期冲回。负责人采用当前规则，重跑历史报告可能随当前归属改变；如果未来需要冻结每日报告，应由报表端留存整份响应及 fetched_at。不同于凭当前订单审核状态统计过去。
6. 日末重建依赖所有业务写入走现有事务和 customer_ledger。离线直接修改业务表而不记流水不受支持。遇到未知不返回 0；零表示对应完整范围内确实没有事件。现金/毛利/客户/欠款各自独立标记，不能把某个 complete 当成全局完整。

## 2. GET /api/v1/customers

参数：operator_id（可选正整数，当前客户归属）、created_start、created_end（可选北京时间创建日期闭区间）、page、pageSize。

返回 page、page_size、total、total_pages、items、meta。items 包含 id、name、operator_id、operator_name、created_at（UTC ISO 时间或 null）、creation_time_complete、creation_time_reason。仅当前未删除档案；**不是历史日末客户列表**，日末数量须使用 daily-analysis。创建时间过滤排除旧未知时间客户；meta.unknown_creation_count 给出全租户当前未知创建时间的客户数，creation_history_complete=false 披露旧历史缺失，避免把筛选结果当完整历史。

脱敏节选：
```json
{"page":1,"page_size":50,"total":1,"total_pages":1,"items":[{"id":12,"name":"示例客户","operator_id":2,"operator_name":"示例销售","created_at":null,"creation_time_complete":false,"creation_time_reason":"迁移前未保存客户创建时间"}]}
```

## 3. GET /api/v1/finance/transactions

参数：start、end（可选事件日闭区间）、responsible_id、customer_id（可选正整数）、page、pageSize。负责人筛选按当前原销售单负责人，不按现金操作者。SQL 层过滤与分页。

返回分页及 items、meta；每项字段：id、event_date、recorded_at、occurred_at、event_kind、is_cash_event、cash_date_complete、customer_id、document_type、document_id、document_date、account_id、account_source、account_attribution_complete、responsible_id、responsible_name、operator_id、operator_name、receipt_amount、refund_amount、accounting、reason。

accounting 保留 sales/received/returned/refunded 四种带正负号的账务变动，冲销为负；它们不是当日现金。仅明确现金事件的 receipt_amount/refund_amount 有数值；非现金/未知事件为 null，occurred_at 为 null；recorded_at 始终表示记录写入时间。发生时间在现有同步收款/退款工作流中即记账时间，外部延迟补录不能用该接口证明真实银行到账时间。

脱敏节选：
```json
{"id":101,"event_date":"2026-10-01","recorded_at":"2026-10-01T02:00:00Z","occurred_at":"2026-10-01T02:00:00Z","event_kind":"收款","is_cash_event":true,"cash_date_complete":true,"customer_id":12,"document_type":"sales","document_id":81,"document_date":"2026-09-15","account_id":81,"responsible_id":2,"responsible_name":"示例销售","operator_id":4,"operator_name":"示例财务","receipt_amount":200,"refund_amount":0,"accounting":{"sales":0,"received":200,"returned":0,"refunded":0},"reason":null}
```

## 示例与验证

完整合成响应见 [examples/daily-analysis.json](examples/daily-analysis.json)。统计 2026-10-01：销售 500、关联退货 100、独立退货 50，净销售 350、含应收毛利 140；跨月收款 300 加当日收款 500，现金退款 50，净回款 750；日末应收 800、待退 100，翌日收款不影响昨日末。销售甲净销售 400、零交易销售 0、未分配 -50。

本地运行：
```sh
npm run test:daily-analysis
npm test
```

结果：新增日报场景测试及真实 HTTP 三接口测试通过；现有完整 npm test 回归通过。包含跨月/分批收款、现金退款、关联退货抵扣、独立退货、反审核、结转、负责人不同于录单人和财务、历史负责人变更的当前口径、客户午夜归属变化/删除、无交易人员、UTC 午夜边界、历史不足、金额对账、分页/真实日期/ID 校验、401/吊销/GET-only/429、双租户查询参数攻击、迁移幂等和历史只追加。升级测试使用固定旧版 schema，验证旧客户 created_at 仍为 null。此改动只涉及后端和运维脚本，没有前端改动。

## 部署步骤（尚未执行）

1. 按现有备份流程备份平台及各租户 SQLite 库；上线以上代码并重启服务。现有 initSchema 在租户打开时自动执行 v16 事务迁移。可先在部署环境逐租户打开库验证迁移，再放行自动报表请求。无需重算旧快照，无需日报专用定时快照。
2. 迁移新增 customers.created_at（旧值 NULL）、report_metadata、report_customer_history、report_ledger_facts、report_salespeople 及追加/保护触发器；它们在同一事务中生效。迁移保留原始金额与账务流水。确认 schema_migrations 有 version=16。
3. 获取用户 ID 并人工确认哪些 operator 是业务员，填写本地运维名单 JSON（不可把管理员或财务混入）：
   ```json
   [{"user_id":2,"start_date":"2026-10-01","end_date":null},{"user_id":3,"start_date":"2026-10-01","end_date":null}]
   ```
   执行 `node scripts/report-roster-configure.js yongfeng /安全路径/业务员名单.json`。脚本事务替换完整名单，校验角色/日期/重叠并设置 roster_confirmed；更换名单时保留旧任职区间，否则历史重跑名单会变化。任职开始日须来自真实记录，不能随意倒填。名单文件不含凭据。
4. 使用既有只读 API Key，通过安全凭据库注入请求头；禁止写进 Git、文档、URL 或日志。先调用三个接口确认 tenant_code=yongfeng、租户名称正确，查看所有 meta 起点、完整性、未分配及 null 原因；核对至少一笔跨月收款与分单日末余额。以线上租户实际返回的日期记录可用起点，不能沿用示例日期。
5. 在报表端（如 n8n）配置 Asia/Shanghai，每日 05:00 执行 GET /api/v1/reports/daily-analysis（省略 date 默认昨天，或显式计算北京时间昨天）。生成管理日报与 salespeople 排名，展示未分配、null 原因和名单状态；月回款目标 10,000 元由报表端配置，只有 actual_receipts 完整时才能称为准确收款完成额，net_cash_received 单独展示。401 停止重试并告警，429 退避，500 重试并告警；相同租户/日期重复执行在报表端幂等存储。
6. 本次没有创建线上任务、修改线上凭据、执行线上迁移或部署。也没有改动旧快照任务；若保留原 debt-trend，应把它标注为执行时余额趋势，不作为日末余额。需要冻结负责人历史/银行真实到账时刻或补齐旧客户创建时间时，需另行采集可靠凭证，不能自动回填。
