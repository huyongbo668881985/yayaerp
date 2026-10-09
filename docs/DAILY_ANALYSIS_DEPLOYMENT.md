# 每日经营日报生产部署记录

2026-10-09（北京时间）完成。生产代码版本 `6bc34b9`，GitHub main 已推送。服务入口：https://erp.yayaagent.com 。生产服务器采用已有 myai 的 Docker Compose 部署，保留此前仓库停用功能及部署配置的本地差异；日报提交没有包含那项功能的界面改动。

## 执行与验证

- 部署前使用 SQLite 在线备份保存平台库及三个租户库，共四个数据库，逐库 integrity_check 通过；另保留原部署代码、差异补丁和旧镜像标签。备份没有提交到 Git。
- 新镜像构建成功，三个租户均迁移至 v16，服务容器重建后 healthy；永丰数据库 integrity_check 与 foreign_key_check 通过。
- 所有四个 operator 纳入永丰报表名单，报表参与范围从已有流水起点 2026-10-02 开始。这是用户确认的报表范围，不是历史入职证明；元信息已明确披露。
- 按用户后续要求启用 hide_empty_salespeople：仅所有金额、客户和欠款指标都为零时隐藏。null 表示未知，保留人员并说明原因。
- 使用临时只读 Key 完成服务器内及公网 HTTPS 实测。每轮验证后立即吊销 Key，共四把；未输出或保存明文凭据，没有更改既有调用 Key。
- 三个新接口 HTTP 200、无 Key 401、无效日期 400、POST 404、双租户隔离、公司金额与分组对账通过。公网登录页 200。
- 本地独立日报发布版本完整 npm test 通过；最新人员展示配置的针对性测试通过。原工作区及生产服务器的既有仓库停用改动均保留。

## 永丰历史可用起点

| 指标 | 起点与限制 |
|---|---|
| 分单日末余额 / 销售流水 | 2026-10-02；仍须检查期间完整性与旧退货账户是否核实 |
| 整日现金流水 | 2026-10-03；开单预收款日期未知时仍返回 null |
| 客户日末历史 | 2026-10-10；迁移前创建日期仍为 null，不能回填昨日客户数量 |
| 新毛利快照采集完整整日 | 2026-10-10；涉及旧流水时历史毛利仍可能为 null |

统计日 2026-10-08 的实测：当日销售/现金及日末欠款完整性通过；客户历史不足；本月累计开始于 10 月 1 日，早于旧流水起点，所以相关累计值返回 null，不以零替代。四个人员均因存在未知客户/累计指标保留，不能把未知认定为无数据。

## 剩余事项

每日北京时间 05:00 的报表端调用/发送任务未创建。本次发布的是数据 API；报表消费者应使用现有安全凭据库中的 Key 调用，不在 URL 或日志中放凭据。应显示接口返回的完整性、未分配及 null 原因；月回款目标由报表端配置。

## 公网验证结果（不含真实经营金额或凭据）

```json
{
  "status": "PASS",
  "date": "2026-10-08",
  "tenant_code": "yongfeng",
  "schema": 16,
  "configured_operators": 4,
  "returned_people": 4,
  "hide_empty": true,
  "ledger_available_from": "2026-10-02",
  "cash_available_from": "2026-10-03",
  "customer_history_available_from": "2026-10-10",
  "profit_snapshot_available_from": "2026-10-10",
  "integrity": "ok",
  "http": [
    "daily-analysis 200",
    "customers 200",
    "transactions 200",
    "missing key 401",
    "invalid date 400",
    "POST 404",
    "tenant isolation PASS",
    "company reconciliation PASS"
  ],
  "completeness": {
    "daily": {
      "sales": true,
      "profit": true,
      "cash": true
    },
    "month": {
      "sales": false,
      "profit": false,
      "cash": false
    },
    "customer": false,
    "debt": true
  },
  "limitations": {
    "daily": {
      "sales": null,
      "profit": null,
      "cash": null
    },
    "month": {
      "sales": "期间早于账务流水升级结转起始日期",
      "profit": "期间或入账成本快照不足，旧流水不能恢复历史毛利",
      "cash": "期间早于流水起点，或存在现金发生日期未知的开单/审核预收款"
    },
    "customer": "统计日早于客户历史基线完整日；旧创建/删除/归属历史不可恢复",
    "debt": null
  },
  "historical_attribution_complete": false
}
```
