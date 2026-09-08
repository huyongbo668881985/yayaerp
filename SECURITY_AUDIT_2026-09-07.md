# 上线前全量安全与业务逻辑走查报告（只读，未改任何代码）

- 审查对象：jxc-app（多租户进销存 SaaS，Node/Express/EJS + better-sqlite3）
- 审查基准：工作区 HEAD `46c286b`（`客户可见范围按角色隔离…`），`git status` 干净，代码与提交一致
- 审查时间：2026-09-07
- 声明：仓库内 `data/` 目录（各租户 db、platform.db、sessions.db）不纳入评审；下述全部结论基于源码，均可按文件:行号直接跳转核实。

---

## 总览（按严重级别）

| 级别 | 编号 | 一句话摘要 | 类别 |
|---|---|---|---|
| 视同 P0（口径） | M1 | 首页「毛利」与经营报表「不含应收毛利」的退货处理不一致，注释称已统一但代码未统一 | ③ 跨页面数字口径 |
| P1 | A1 | 操作员在销售/退货单里可提交任意 `customer_id`，服务端未做归属校验（越权引用+枚举他人客户） | ① 资源-操作矩阵 |
| P1 | A2 | 出入库流水页/导出对操作员无过滤，可反推他人销售/采购/调拨量，与「只看自己单据」的边界不一致 | ① 资源-操作矩阵 |
| P2 | A3 | 收款封顶口径与页面展示口径不一致（record-payment 不扣已审核退货） | ③ 口径 |
| P2 | A4 | 待审核单据数只统计销售单，漏掉退货/调拨待审 | ③ 口径 |
| P1* | B1 | 审核/反审核/采购删除「先查后写」不在同一事务、状态更新无条件、无 busy_timeout——多进程部署可重复扣减 | ② 状态机竞态 |
| P2 | C1 | 单据表单默认日期用 UTC（北京 0–8 点新建单默认落到昨天） | ④ 常规 |
| P2 | C2 | 平台默认超管账号 superadmin/super123 未强制改密；超管操作无审计留痕 | ④ 常规 |
| P2 | C3 | 数量未校验为正整数（可录小数库存）；箱/瓶价格双列自由录入，无一致性校验 | ④ 常规/核心规则5 |
| P1* | D1 | docker-compose `"3000:3000"` 绑定所有网卡，与注释“只绑定本机”不符；root 运行 | ④ 部署 |
| P2 | D2 | 反代后未开 TRUST_PROXY 时，IP 维度限流全部退化为全局（他人可打满） | ④ 常规 |

*注：B1、D1 标注 P1，但在当前“单容器、防火墙内网”部署形态下暂不可触发/不暴露；一旦横向扩容或暴露 3000 端口即升级为 P0 级风险。

---

## ① 资源—操作矩阵（逐入口核对）

### A1（P1）销售单/退货单 POST 未校验 customer_id 归属，可越权引用并枚举他人客户

- 位置：
  - `routes/sales.js:222-268`（POST /sales/new）`customer_id` 取自 body（224 行）后直接落库（258 行），无归属/存在性校验
  - `routes/sales.js:285-333`（POST /sales/:id/edit）同理
  - `routes/returns.js:161-213`（POST /returns/new）与 `routes/returns.js:229-284`（POST /returns/:id/edit）同理
- 对照：列表页下拉只给操作员自己名下的客户（`customersForForm`：sales.js:206-212、returns.js:145-151）；客户编辑/删除路由有 `canEditCustomer`（partners.js:64-66）。但销售/退货的 POST 是另一条“写客户关系”的入口，没有套用同一归属规则。
- 复现：操作员 A 直接 POST `/sales/new`，`customer_id=10`（管理员/操作员 B 名下的客户），`warehouse_id`、明细合法即可成功。之后 A 的销售列表/详情（`LEFT JOIN customers`，sales.js:90-95、507-515）会显示客户 10 的名称；遍历 customer_id 可枚举全部客户名单。退货单同理。
- 为什么是真实问题：客户归属隔离是最近一次提交（46c286b）明确定下的产品规则，但它只拦了客户页面的增删改查入口，**漏了通过单据间接引用客户的两个模块入口**——正是“列表页做了过滤、别的入口没做”的典型洞。当前泄露面为客户名+把他人客户卷进自己单据（管理员看到后需人工纠错）。
- 修复建议：单据 POST 落库前对 customer_id 执行与 customersForForm 等价的校验（admin 放行；operator 必须 `operator_id = 自己`，无归属或他人客户的 id 一律 400）；related_sales_order_id 同理建议限定在“自己可见的销售单”（或明确由管理员兜底）。返回渲染表单时错误信息与现状一致。

### A2（P1）出入库流水页/导出无操作员过滤，可反推他人业务量

- 位置：`routes/inventory.js:29-44`（queryStockLogs 无 user 过滤）、`routes/inventory.js:46-56`（/stock-log 仅 requireLogin）、`routes/inventory.js:53-74`（/stock-log/export 仅 requireLogin）
- 对照：销售/退货/调拨的列表、详情、导出全部按“管理员全量 / 操作员只看自己”（sales.js:99-101、160；returns.js:93、126；transfers.js:46-49）过滤。stock-log 是唯一能看到**全体用户**销售出库（含 ref_id、商品、数量、仓库、操作人、时间）的只读口；purchase_in 也暴露管理员采购行为。
- 复现：操作员登录后访问 `/stock-log`，按 `user_name`/`ref_type=sale_out` 汇总即可还原其他同事的销售节奏与单品量（金额无，但有数量×单品），绕过“操作员只看自己单据”的隔离承诺。
- 为什么是真实问题：若产品对外承诺操作员数据隔离，这里就是一个“单独看完全正常（流水本来就该共享？）”但与单据权限模型冲突的洞；是否接受取决于产品定位。3–15 人团队内或许可接受，请产品决策。
- 修复建议：决定口径二选一——(a) stock-log 也按 user 过滤（与单据一致，但会看不到库存整体变动）；(b) 明确“库存与流水对所有操作员共享”并在 README/权限文档写明，属产品决策非缺陷。若选 (a)，导出接口同步加过滤。

其余矩阵核对结果（一致，无洞）：
- 销售单：列表/详情/编辑/撤回/提交/导出 全部按 user_id 或 canEditOrWithdraw 过滤 ✓（sales.js:99-101, 276, 290, 341, 352, 519；export 160）
- 退货单：同上 ✓（returns.js:93, 126, 220, 234, 291, 301, 452）
- 调拨单：列表/详情/编辑一致 ✓（transfers.js:46-49, 103, 116, 154, 165, 306）
- 采购单/供应商/报表/账号：全路由 requireAdmin ✓
- 平台超管：requireSuperAdmin ✓；平台后台打开租户库用 openTenantDbByPath 不受租户状态限制（有意的，见注释 platformAdmin.js:153-155）
- 详情页 IDOR：/sales/:id、/returns/:id、/transfers/:id 均已加与列表同口径校验 ✓（此前 16f07f2 已修）

---

## ② 跨单据状态机（重点推演）

### B1（P1，多进程下可升级 P0）库存“先查后写”不在同一事务、状态更新无 WHERE 条件、无 busy_timeout

- 位置：
  - 销售审核：库存预检在事务外 `routes/sales.js:365-382`，事务内无条件扣减并直接置状态 `sales.js:384-396`（`UPDATE ... SET status='approved' WHERE id=?` 不带 `AND status='submitted'`）
  - 调拨审核：`routes/transfers.js:182-194`（预检）→ `196-218`（事务）
  - 退货反审核：预检 `routes/returns.js:369-382` → 事务 `384-400`
  - 采购删除：预检 `routes/purchases.js:128-143` → 事务 `145-160`
  - `lib/tenantManager.js:45`（new Database 未设 busy_timeout）
- 复现（需 ≥2 个 app 进程共享同一租户库，如横向扩容/多实例）：两名管理员并发审核同一张 submitted 销售单，两者都通过第 363 行状态检查和库存预检；若库存足够（如库存 200、单行扣 5），两个事务都会成功扣 5、各写一条 sale_out、各自把状态置为 approved——**库存与流水重复扣减，账实不符，且无任何报错**。库存不足时虽会被 CHECK(quantity>=0) 兜底回滚，但报错是不可读的 500，且“恰好够两次”的区间内会静默双扣。
- 为什么是真实问题：当前 docker-compose 是单实例、better-sqlite3 同步执行，单进程内请求不会交错，因此“现在不炸”。但这是商业化 SaaS，只要未来起第二个副本就会踩中；同类逻辑还影响 record-payment 等所有“先读后写”。
- 修复建议：① 把库存预检移进 db.transaction 内再执行（better-sqlite3 事务本身同步，能保证同进程内原子）；② 状态迁移语句全部改成 `UPDATE ... SET status=? WHERE id=? AND status=<期望前置态>` 并检查 `changes === 1`，不满足即 409，天然幂等防重复提交；③ `getTenantDb`/所有打开处 `db.pragma('busy_timeout = 5000')`；④ 若未来多实例，务必为每租户引入单写者（如仅单实例写 SQLite）。

### 其余状态机推演结果（均通过）

- **A(销售)已审核 + 关联 B(退货)已审核 → 反审核 A**：被 425-436 行守卫拦截，提示先反审核 B，避免重复加库存 ✓
- **A(退货)已审核、B(销售)被反审核**：returns.js:316-321 在退货审核时对关联销售单状态二次校验 ✓（防止“销售已反审核但退货仍通过”导致凭空加库存）
- **A(销售)反审核→submitted→撤回→draft→改明细→再提交→再审核**：整条链库存加回/扣减恰好一次 ✓（unapprove 用 upsert 原样加回 sales.js:442-456；流水以 adjust 记账避免“销售出库 +N”自相矛盾）
- **调拨反审核**：调出仓加回、调入仓扣回（transfers.js:264-289），扣前查调入仓库存足够 ✓
- **退货反审核**：扣回加库存的量，扣前查库存 ✓（returns.js:366-382）
- **与金额的联动缺口（非库存）**：销售单/退货单反审核不重置 paid_amount / refunded_amount / 对应状态——属“钱已进出、货退回”的真实场景，需要线下退款处理，系统内表现为该单状态变化而金额不动。建议在详情页反审核时给出“该单已收款 ¥x / 已退款 ¥y，反审核不自动冲销，请线下处理”的明确提示（当前 confirm 文案未含金额提示，sale_detail.ejs:89、return_detail.ejs:83）。低风险，产品提示优化。

---

## ③ 同一数字在不同页面的口径（重点核对）

### M1（视同 P0）首页「毛利」与经营报表「不含应收毛利」退货口径不一致

- 首页：`routes/dashboard.js:80-87` 毛利 = 已审核且 `payment_status='paid'` 的销售明细 `Σ(qty×unit_price − base_qty×cost_snapshot)`，**完全不含退货冲减**。
- 报表：`routes/report.js:70-90`，「不含应收」毛利 = 同口径销售毛利 − 已退款/关联已收款销售单的退货毛利（`returnProfitRefunded`，86 行）。
- 代码注释两处声称口径已与仪表盘统一（report.js:6-7、19-24），但实现没有统一。项目记录（.workbuddy/memory/2026-09-07）显示 2026-09-07 曾定版「报表/仪表盘毛利只看 payment_status、不做退货抵扣」，即当时的决策口径里**两边都不扣退货**——按此决策，当前 report.js:85-89 的退货扣减本身就偏离了定版；按当前实现，首页又没跟上。无论以哪个版本为准，两个页面现在的数字都不相等。
- 复现（同一个月内）：
  1. 销售单 S：1000 元已收全款，成本 700 → 首页本月毛利 +300；
  2. 同月对 S 全额退货并退款：报表「不含应收」= 300 − 退货毛利 300 ≈ 0；**首页本月毛利仍显示 +300**。
  两处数字一个是 +300、一个是 0，标题都叫“毛利”。
- 为什么是真实问题：管理员用首页核对月度盈利、用报表做月结时会对不上账；且这是历史明确出过事的“口径不一致”类别（报告注释显示 9-07 曾为统一口径专门改过一版，但仍漏了首页侧没有同步减退货）。
- 修复建议：在 dashboard 的毛利 SQL 上叠加与 report 相同的退货冲减（同区间已审核退货中 refunded 或关联销售单已收款的部分，按其明细毛利扣减；退货按退货单日期归属，与 report 一致），或明确把首页指标改名为“已收款订单毛利（未扣退货）”并在 UI 上写明口径，二选一并让两处代码共用同一 SQL 片段（如抽到 lib）。

### M2（P2 状态口径）同一张单“收款状态”在不同页面取值源不同

- 首页最近销售单徽标取 `so.payment_status`（dashboard.ejs:84-90、120-126），销售列表/详情/导出取 `effective_status`（=金额−已收−已审核退货后的结算态，sales.js:74-86、sales.ejs:44-50）。
- 复现：一张已收全款、之后发生已审核退货的销售单——销售列表显示“部分收款/已收款（已扣退货）”，首页同一单显示“已收款”（只看实收现金）。两处文案一致但含义不同，容易误读。
- 修复建议：统一展示口径，至少把列表页的徽标文案与首页区分开（如“已结清”vs“已收款”），或在两处都附明细口径说明。

### A3（P2）记录收款：服务端封顶与页面“欠款”展示不一致，输入框无 max 上限

- `routes/sales.js:482` `remaining = total_amount − paid_amount`（不扣已审核退货）——该封顶口径是 9-07 定版“只看实收现金 vs 单据金额，不做退货抵扣”的有意选择（sales.js:494 注释，与 payment_status 模型一致），本身可接受。
- 但 `sale_detail.ejs:94` 的记录收款按钮却以 `effective_debt > 0.001`（**已扣**退货）为门槛、且输入框无 max 约束。
- 复现：销售 1000 未收款、关联退货 200 已审核 → 页面展示“欠款 ¥800”并出现收款框，但服务端允许一次收满 1000；管理员按页面提示收 800 没问题，若键入 1000 也被接受，与页面自述的欠款不符。
- 影响：钱多收的部分由退货 record-refund（returns.js:409-438）日后冲回时账能平；但“页面说 800、服务端收 1000”对录入员是真实误导源。建议：页面门槛与输入 max 都改为与 record-payment 同一口径（total−paid），或收款规则也切换到有效欠款模型，二选一并对齐 returns.js record-refund 的同类展示。
- returns.js:421-428 的 record-refund 同样不扣关联销售单已收情况——纯退货单（无关联销售）全额退款上限 = 退货总额，但若关联销售单从未收款，系统允许“先退钱”，请产品确认是否需要限制。

### A4（P2）首页“待审核单据”只统计销售单

- `routes/dashboard.js:70-72`：`SELECT COUNT(*) FROM sales_orders WHERE status='submitted'`，未包含待审核退货单（returns）与调拨单（transfers）。
- 复现：一张退货单/调拨单提交待审，首页“待审核单据”仍显示 0 → 管理员以为没有待办。
- 修复建议：三张单的 submitted 计数相加；操作员口径仍只计自己的（含自己提交的退货/调拨）。

其余口径核对（一致）：
- 销售额（已扣退货）：dashboard.js:27-57 与 report.js:49-57 同一口径（各自按单据日期归属、只算已审核）✓
- 总欠款/应收：dashboard.js:60-67 与 report.js:60-64 表达式同一（EFFECTIVE_DEBT_EXPR）✓
- 成本快照：dashboard.js:81、report.js:71、销售/退货明细行全部用 `cost_price_snapshot` ✓（改商品成本价不回溯历史毛利——规则 4 通过）
- 导出 CSV 与页面列表过滤条件逐字一致 ✓

---

## ④ 常规安全检查

- SQL 注入：未发现。全部查询参数化；字符串拼接仅限常量片段（EFFECTIVE_DEBT_EXPR、RETURNED_AMOUNT_SUBQUERY、USER_FIELDS、日期别名），无一处把 req.body/query/params 拼进 SQL。`inventory.js:8` warehouse_id 走绑定参数 ✓
- XSS：
  - EJS 正文全部使用 `<%=` 转义 ✓
  - 4 处 `<script>` 内嵌 JSON 均对 `<` 做了 `\u003c` 替换（sale_form.ejs:61/73、return_form.ejs:66/76、transfer_form.ejs:54-55、purchase_form.ejs:43），`</script>` 无法注入 ✓；商品名/单位拼 innerHTML 前经 esc() 转义 ✓
  - 残余注意点：转义只覆盖 `<`，对 `U+2028/U+2029` 未处理（现代浏览器无影响，属纵深防御项，P2）
- CSV 公式注入：utils/csv.js:7-17 对 `= + - @` 开头非纯数字值加 `'` 前缀；stock-log 导出把“数量变化”独立成列避免 ± 前缀误伤 ✓
- 会话：登录成功均 `session.regenerate` 防固定（auth.js:54、platformAdmin.js:53）✓；cookie httpOnly（默认）+ SameSite=Lax ✓；SESSION_SECRET 缺失或 <32 字符直接拒启（app.js:12-20）✓；CSRF：SameSite+Lax 与 Origin 双防线（app.js:66-79）✓
- 默认/弱凭据：见 C2
- 资源：租户连接 LRU 上限 200（tenantManager.js:8-20）✓；临时打开用完即关（getTenantUserCount、platformAdmin 的 openTenantDbByPath 均有 close）✓；session 表每小时清理 ✓
- TOCTOU：见 B1
- 错误处理：SQLITE_CONSTRAINT 前缀统一转 400 业务文案（app.js:117-122），不泄露堆栈 ✓

### C1（P2）表单默认日期用 UTC，北京 0:00–8:00 新建单默认日期=昨天

- 位置：sale_form.ejs:23、return_form.ejs:23、transfer_form.ejs:24、purchase_form.ejs:22 均 `new Date().toISOString().slice(0,10)`
- 复现：北京 03:00 打开新建销售单，日期输入框默认是“昨天”，若录入员未手动改日期直接提交，订单 order_date=昨天 → 首页“今日销售额”、日报均不统计它。这与全站刚修完的“统一北京时区”方向（utils/dates.js、dashboard.js:21-23 注释）自相矛盾。
- 修复：默认值改为 `todayLocalDate()` 注入（或后端 render 时算好传模板变量），四个表单同步修。

### C2（P2）平台默认超管凭据 + 无审计留痕

- `lib/platformDb.js:42-49`：首启自动建 superadmin/super123，仅在控制台打印一行提示，无“首次登录强制改密”。platform.db 是平台总控，被拿下即可重置任意租户任意账号密码（platformAdmin.js:181-214）。建议：改随机初始密码并以文件/环境变量下发；加 must_change 标记强制首登改密；对 create/suspend/limits/reset-password 等超管动作落 audit 表（含操作人、时间、对象、前后值）。
- 租户侧登录口令复杂度下限 6 位（users.js:22、auth.js:83、platformAdmin.js:78/192），对 SaaS 建议提到 8 位以上。

### C3（P2）数量非整数可入库；箱/瓶价格双列无一致性约束（规则 5 缺口）

- 数量：sales.js:53-57、returns.js:50-56、purchases.js:44-55、transfers.js:21-30 均只要求 `qty > 0`，未要求整数。构造 `quantity=1.5` 可产生小数库存行；建议服务端 `Number.isInteger`。
- 价格换算（规则 5 相关）：products.js:27-53/62-85 对 `cost_price/cost_price_pack`、`sale_price/sale_price_pack` 双列自由录入，无“瓶价≈箱价÷pack_size”一致性校验；当箱价未填时表单与商品页反向用瓶价推导箱价（sale_form.ejs:174 `packPrice!=null?packPrice:basePrice*packSize`、products.ejs:34-36），方向与“箱价为真值、瓶价由箱价反推”的规则相反，且会复现 schema.js:237-240 注释里自己否定的“380÷24 四舍五入再乘回”误差。另：毛利成本快照只取 `products.cost_price`（瓶成本，sales.js:65），若管理员只维护箱成本而瓶成本留 0，历史毛利会被系统性高估且无提示。
- 建议：编辑/新建商品时做交叉校验（pack 价与 base 价缺一即提示换算关系），或明确“箱价真值 + 瓶价展示用推导”的单向模型并全链路落地；成本快照取当前录入单位对应成本并校验非零。

### D1（P1*，部署）docker-compose 端口绑定与注释矛盾 + root 运行

- `docker-compose.yml` `"3000:3000"` = 绑定 0.0.0.0，注释却写“只绑定到本机”。若服务器防火墙未封 3000，Node 将绕过 Nginx 直接暴露于公网：COOKIE_SECURE 默认 false（app.js:53），HTTP 明文会话 cookie 可被嗅探/重放。
- 建议：改为 `"127.0.0.1:3000:3000"`；COOKIE_SECURE=true 与 TRUST_PROXY=1 在反代部署下必须同时开（README 已说明，需在部署清单核对）。
- Dockerfile 以 root 运行（注释说明为 bind mount 属主），属可接受的折衷，但建议宿主机 `./data` 的属主收敛到容器 UID 后再 `USER node` 降权。

### D2（P2）反代后未开 TRUST_PROXY 时 IP 限流全局化

- trialAuth.js:35 `code:ip:${ip}` 与 middleware/rateLimit.js:27 key=req.ip；不设 TRUST_PROXY 时 req.ip 恒为反代地址 → “每 IP 每小时 10 次发送验证码/每 15 分钟 10 次登录失败”退化为平台级总量，陌生人可刷爆全局注册/登录限流（自我 DoS），也会让同出口公司互相误伤。
- 建议：.env.example 已含 TRUST_PROXY，部署时必须=1；或将 IP 限流改为按 tenant_code 维度。

---

## 已核查确认没问题的关键假设（6 条核心规则）

1. **库存只在审核通过那一刻变动**：销售（sales.js:384-396）、调拨（transfers.js:196-218）、退货入库（returns.js:325-340）均在 approved 事务内改库存；创建/编辑草稿、提交、撤回、拒绝只改状态不动库存（sales.js:254-265/320-330/336-355/402-410 等）✓；采购“录单即加库存”是管理员专属路由的既定设计（purchases.js:6-10 注释）✓
2. **反审核原样加回且原子**：销售反审核用 upsert 原样回加并记录 adjust 流水（sales.js:438-460）；退货反审核事务内扣回（returns.js:384-400）；调拨反审核事务内两端反向（transfers.js:264-289）；均在同一 db.transaction 内完成 ✓；且销售反审核对已审核退货做了防重复加库存拦截（sales.js:425-436）✓
3. **赠品行**：is_gift 强制单价 0 不计收入（sales.js:60/243），但 base_quantity 照常进入库存校验与扣减（sales.js:370-393），成本快照照记 → 赠品实打实占库存、计成本 ✓（毛利里体现为 0 收入 − 成本）
4. **成本快照**：销售/退货明细在开单时写入 cost_price_snapshot（sales.js:65/262、returns.js:61/207，schema.js:265-276 含老数据回填），报表/首页毛利均用快照现算；改商品成本价不影响历史 ✓
5. **单位换算**：所有库存/成本计算以 base_quantity（qty×pack_size）为准；箱/瓶单价分开存储、录入按所选单位各自计价，明细保留 unit_label 供展示还原 ✓（商品价格双列一致性约束缺失见 C3，属规则 5 的落地缺口而非换算本身错误）
6. **多租户隔离**：每租户独立 db 文件（platformDb.js:86），会话只存 tenant_code（auth.js:60-61），resolveTenant 对不存在/暂停/过期租户销毁会话（tenant.js:12-21）；全部业务查询走 req.tenantDb；代码内未发现任何跨租户 JOIN/库；平台超管仅经 requireSuperAdmin 且操作对象为显式租户 id；租户码有正则白名单防路径穿越（platformDb.js:52-55）✓

**其他常规项确认通过**：所有 EJS 输出默认转义且 4 处 JSON 内嵌均转义 `<`；CSV 公式注入防护齐全；登录会话 regenerate + SameSite=Lax + Origin 校验双层 CSRF；SESSION_SECRET 强度启动强校验；SQL 全参数化；删除类操作（商品/客户/仓库/用户/供应商）均有完整引用预检避免裸外键错误。

---

## 遗留观察（不阻塞上线，供决策）

- 被拒绝/被反审核的销售单可保留 paid_amount 而无“销售退款”记录载体——退款只能线下走账，系统金额与实际现金流可能出现无法对平的窗口；若商业上需要，建议加销售退款或红冲单。
- 退货单“自由录入、不做超原销售数量校验”（returns.js:11 注释）意味着关联销售单的退货可大于原售数量——当前靠管理员审核兜底，属已知产品取舍。
- 单个租户若出现“退货入 A 仓后被售出→无法反审核退货→销售单永久无法反审核”的死锁路径（无强制解绑/强制模式开关），建议提供“强制反审核（需二次确认并记为 adjust 差额）”逃生口。
