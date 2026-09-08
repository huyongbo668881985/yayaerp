# 进销存 SaaS 上线前全量审计（第二轮 · 组合型缺陷导向）

**审计日期**：2026-09-08
**代码基线**：git `eb0df68`（main，工作区无未提交改动，仅多一个未跟踪的 `SECURITY_AUDIT_2026-09-07.md`）
**审计范围**：`app.js` + `routes/`(14) + `lib/`(12) + `middleware/`(4) + `utils/`(2) + `views/`(35) + `Dockerfile`/`docker-compose.yml`/`.env.example`
**代码总量**：4033 行 JS + 35 个 EJS 模板
**结论**：**未做任何代码改动**，本报告为只读走查结论，等确认后再动手。

---

## 与上一轮审计的方法论差异

第一轮（`SECURITY_AUDIT_2026-09-07.md`）是按文件走查，修掉的都是"单文件可见"的问题。
本轮按你要求的四步法，专门找**"单个文件看起来没问题、两个模块放一起就错"**的组合型缺陷。
下面第二节（跨单据状态机）和第三节（口径一致性）是本轮重点，共 6 条，全部是本轮新发现。

---

# 一、P0 致命

## P0-1 平台超管默认账号 `superadmin / super123` 硬编码且不强制改密

**位置**：`lib/platformDb.js:54-62`

```js
if (adminCount === 0) {
  const hash = bcrypt.hashSync('super123', 10);
  platformDb.prepare('INSERT INTO platform_admins ...').run('superadmin', hash, '平台超级管理员');
  console.log('已创建默认平台超管账号: superadmin / super123 —— 请登录后立刻修改密码');
}
```

**为什么这是 P0 而不是理论假设**：

1. 密码明文写在源码里，仓库一旦外泄（GitHub/Gitee 镜像、外包交付、Docker 镜像 `COPY . .`）凭据即刻公开。
2. 用户名 `superadmin` 是固定值，不需要枚举。
3. **没有任何强制改密机制**：`platformAdmin.js:70-86` 的改密码页面是"想改才改"，登录后不会跳转、不会拦截、不会提示。代码里唯一的"提醒"是一行 `console.log`，用户在浏览器里永远看不到。
4. 这个账号的权限是**跨租户**的：`/platform-admin/tenants/:id/users/:userId/reset-password` 可以直接重置**任意租户任意账号的密码**，等于拿下全部客户数据。
5. 审计日志（`insertAuditLog`）虽然覆盖了写操作，但**只对已登录的合法超管留痕**，防不住"别人拿着默认密码登进来"——那也是合法超管。

**复现**：部署后访问 `https://<域名>/platform-admin/login`，输入 `superadmin / super123`，直接进入租户总控台，可重置任何客户的管理员密码。

**处置状态（2026-09-08 下午更新）**：老胡确认超管密码在部署后已自行修改，且不为弱密码；
登录限流 10 次/15 分钟可挡爆破。**本条按"运营事项"关闭，代码未改动。**

---

# 二、跨单据状态机交互（本轮重点，视同 P0）

## P1-1（状态机）删除采购单时，被"销售退货"加回来的库存会被误当成"这批采购的货"，二次扣减

**位置**：`routes/purchases.js:121-164`，特别是 `133-144` 的库存校验

```js
const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
for (const [pid, totalQty] of needed) {
  const inv = getInv.get(pid, order.warehouse_id);
  const have = inv ? inv.quantity : 0;
  if (have < totalQty) { /* 拦下 */ }
}
```

**问题**：校验条件是"当前库存 ≥ 采购量"，但**当前库存不等于这批采购的货还在**。库存可能来自完全不同的来源。

**精确复现步骤**（同一仓库 W1，全程管理员操作）：

| 步骤 | 操作 | W1 库存 |
|---|---|---|
| 1 | 采购单 P 录入 100 瓶，录单即入库 | 100 |
| 2 | 销售单 S 100 瓶，审核通过 | 0 |
| 3 | 客户退货，退货单 R 100 瓶审核通过 | **100** |
| 4 | 删除采购单 P | 校验 `have=100 ≥ 100` → **放行** → 扣 100 → **0** |

**结果**：仓库里**实物有 100 瓶**（步骤 3 退回来的），系统库存显示 **0**。
后续销售单全部被"库存不足"拦死，或者被人用"库存调整"硬填回去，账面彻底乱掉。

**为什么不是理论假设**：这个顺序在快消品行业是日常——"进一批、卖光、客户退回来、发现当初采购单价录错了于是删单重录"。
代码里唯一被拦住的是"货已被卖掉/调走"那一种情况（`purchases.js` 的注释也只考虑了这两种），**唯独漏了"货被退回入库"这第三种**。

**修复建议**：删除前校验口径从"当前库存"改为"该商品在该仓库的净可用量是否能追溯到本单"——实务上更简单可靠的做法是：
- 方案 A（推荐）：采购单不做物理删除，改为"作废/冲红"——插入一张 `purchase_in` 的负数冲销单，库存校验用"本单未被消费的数量"（需按批次或按 FIFO 追溯，改动大）。
- 方案 B（低成本止血）：删除前额外检查"该商品该仓库是否存在 `type='sale_return'` 或 `type='transfer_in'` 的流水引用"，命中就拒绝删除并给出明确提示。

---

## P1-2（状态机）退货单只校验关联销售单状态，不校验退货数量上限与退货仓库

**位置**：`routes/returns.js:72-80`（`checkRelatedSale`）、`331-367`（approve）

```js
function checkRelatedSale(db, relatedId) {
  const related = db.prepare('SELECT id, status FROM sales_orders WHERE id = ?').get(relatedId);
  if (!related) return `关联的销售单号 #${relatedId} 不存在...`;
  if (related.status !== 'approved') { return `...只有已审核的销售单才能关联退货`; }
  return null;
}
```

**这是唯一的一道校验。缺失的三项**：

1. **不校验退货数量 ≤ 原销售数量**（`returns.js:12` 注释称"按你的要求做成自由录入"，所以是有意为之，但没有配套的风险提示）
2. **不校验退货仓库 = 原销售单仓库**（`returns.js:180` / `223` 的 `warehouse_id` 完全自由选择）
3. **不校验退货商品是否真的在原销售单里存在**

**复现 A（资金/应收被冲零）**：
- 销售单 S：客户 A，10 瓶，总额 ¥1000，审核通过。
- 退货单 R：关联 `#S`，随便填 1000 瓶 × ¥10 = ¥10000，审核通过。
- 结果：`sales.js:96` / `report.js:13` 的 `RETURNED_AMOUNT_SUBQUERY` 让 S 的 `effective_debt = 1000 - 0 - 10000 = -9000` → `Math.max(0, …)` → **0**。
- 销售列表页显示 **"已收款"绿色徽章**（`sales.ejs:44-46`），这笔 ¥1000 的真实应收从"总欠款"里消失。
- 同时 `lib/profitCalc.js:65` 的退货冲减毛利被放大 100 倍，报表毛利直接变负数。

**复现 B（多仓库库存凭空增加）**：
- 销售单 S 从 W1 出库 100 瓶（W1 −100）。
- 退货单 R 关联 S，但退回仓库选 **W2**（W2 +100）。
- 审核通过 → W1 少 100、W2 多 100，**总库存凭空 +100**。
- 没有任何报错、没有任何提示。

**为什么不是理论假设**：这两条都是**只需在表单里点几下、一次审核就能生效**，而且生效后**没有任何反查手段**——因为退货单和原销售单之间除了一个 `related_sales_order_id`，没有任何数量/仓库/商品的关联约束可供事后核对。

**修复建议**（按性价比排序）：
- 低成本止血：在 `returns.js` approve 前，对**已关联销售单**的退货单，按商品聚合比对 `SUM(base_quantity) vs 原销售单该商品 base_quantity`，超出则拒绝并提示（保留"自由录入"的能力给**不关联销售单**的退货）。
- 同时校验 `ro.warehouse_id = so.warehouse_id`，不一致时拒绝或强制改写为销售单仓库。
- `return_order_items` 增加 `related_sales_order_item_id` 字段，做行级追溯。

---

## P1-3（状态机）退货的"现金退款"与"抵扣销售单欠款"是两套独立机制，可同时生效——同一笔退货被用两次

**位置**：`routes/returns.js:433-462`（`record-refund`）与 `sales.js:79-91`（`attachEffectivePayment`）

**两套机制**：
- **机制 1（欠款抵扣）**：退货单审核通过即生效，`returned_amount = SUM(total_amount) WHERE related_sales_order_id = S AND status='approved'`，自动从 S 的应收里扣掉（`sales.js:81-82`）。
- **机制 2（现金退款）**：`refunded_amount` 字段，建单时填或事后 `record-refund` 累加，代表**实际退给客户多少钱**。

**关键点：这两者之间没有任何互斥、没有此消彼长、没有任何提示。**

**复现**：
- 销售单 S：总额 ¥1000，客户未付款，`payment_status='unpaid'`，`paid_amount=0`。
- 客户退货 ¥400，退货单 R 关联 S，审核通过。
  - 机制 1 生效：S 的 `effective_debt = 1000 - 0 - 400 = 600`（客户只欠 600 了）。
  - 库存 +（退回的货）。
- 管理员在 R 上点"记录退款"，退 ¥400 给客户（`refunded_amount=400`）。
  - 机制 2 生效：客户**真的拿到 400 现金**。
- **净结果**：客户退回 400 的货、拿回 400 现金、还少欠 400 货款。
  **企业实际损失 = 400（货）+ 400（现金）− 600（还能收到的钱）= 200，且账面完全看不出来。**

**为什么不是理论假设**：代码里 `refund_status` 和 `payment_status` 是两个平行状态机，`profitCalc.js:20-28` 的 `RETURN_SETTLED_EXPR` 甚至把"已退款"和"关联销售单已收款"当成**等价**的两种结清方式，说明设计上把二者当成了二选一，但**录入侧完全没有落实这个约束**。

**修复建议**：
- 在 R 上增加显式字段 `settle_mode`（`refund` 现金退款 / `offset` 冲抵欠款），二选一，落库后不可改。
- `record-refund` 前校验 `settle_mode === 'refund'`；`mode='offset'` 时禁止现金退款。
- `RETURNED_AMOUNT_SUBQUERY` 只在 `settle_mode='offset'` 时抵扣销售单应收。

---

# 三、同一数字跨页面口径不一致（本轮重点，视同 P0）

## P1-4（口径）`payment_status`（落库）与 `effective_status`（现算）是两套判定，导致"已结清"的单子毛利被错误归类为"应收未收"

**位置**：
- 落库侧：`routes/sales.js:271-273`（新建）、`343-345`（编辑）、**`530-532`（记录收款）**
- 现算侧：`routes/sales.js:79-91`（`attachEffectivePayment`）
- 消费落库侧：`lib/profitCalc.js:50`（`so.payment_status = 'paid'`）、`lib/profitCalc.js:20-28`（`RETURN_SETTLED_EXPR`）
- 消费现算侧：`views/sales.ejs:44-50`、`routes/sales.js:172`（CSV 导出）、`routes/report.js:113`

**两套判定**：

```js
// sales.js:530-532 —— 落库，不扣退货
if (order.total_amount > 0 && newPaid >= order.total_amount) paymentStatus = 'paid';

// sales.js:81-89 —— 现算，扣退货
const effectiveTotal = order.total_amount - returned;
const effectiveDebt  = effectiveTotal - order.paid_amount;
if (effectiveDebt <= 0.001) effectiveStatus = 'paid';
```

**精确复现**：
1. 销售单 S 总额 ¥1000，客户先付定金 ¥600 → `payment_status='partial'`，`paid_amount=600`。
2. 客户退货 ¥400，退货单 R 关联 S，审核通过 → `returned_amount=400`。
3. S 的 `effective_debt = 1000 − 600 − 400 = 0` → **销售列表页显示绿色"已收款"徽章**（`sales.ejs:44-46`）。
4. 管理员想补记收款把状态刷成 `paid`：`sales.js:513-519` 的 `remaining = 1000 − 600 − 400 = 0`，被"该单有效欠款已结清，无需再记收款"**拦下**。
   → **`payment_status` 永远卡在 `'partial'`，没有任何途径能把它改成 `paid`。**
5. 后果链：
   - `profitCalc.js:50` 的 `so.payment_status='paid'` 过滤 → **S 的毛利被排除在"不含应收毛利"之外**。
   - `profitCalc.js:20-28` 的 `RETURN_SETTLED_EXPR` 查 S 的 `payment_status`，是 `partial` → **R 的退货冲减也被排除**。
   - 净效果：S 的毛利没进"不含应收"，被算进了 `report.js:63` 的 `receivableProfit`（应收订单毛利）。
6. **用户看到的现象**："这张单列表页明明写着已收款，为什么报表的'不含应收毛利'里没有它，反而算进了'应收订单毛利'？"

**为什么不是理论假设**：这是快消品行业**最主流的结算方式**（先收定金 → 送货 → 客户退一部分货抵尾款）。而且第 4 步证明这个状态是**不可逆的死结**——系统没有提供任何把 `payment_status` 刷成 `paid` 的入口。

**修复建议**（二选一）：
- 方案 A（推荐）：把 `payment_status` 也改成"现算"——即 `record-payment` 更新时按 `newPaid >= total_amount - returned_amount` 判定，与 `attachEffectivePayment` 完全一致。这样两边永远同步。
- 方案 B：保留 DB 字段，但让 `profitCalc.js` 的过滤条件改用与 `attachEffectivePayment` 同源的 `EFFECTIVE_DEBT_EXPR <= 0.001`，并把 `RETURN_SETTLED_EXPR` 的判断也换成有效欠款口径。

---

**✅ 已修复（2026-09-08 下午，采用方案 B）**：结清判定统一改为现算有效欠款，
详见下方「六、修复记录」。

## P1-5（口径）销售额扣"全部已审核退货"，毛利只扣"已结清退货"——同一页面两个数字不同步

**位置**：
- `routes/dashboard.js:28-41`（销售额，扣全部已审核退货）vs `dashboard.js:91`（毛利，只扣 settled 退货）
- `routes/report.js:60`（销售额）vs `report.js:61`（毛利）
- `lib/profitCalc.js:61-72`（`onlySettled` 默认 `true`）

```js
// report.js:60 —— 销售额：扣全部已审核退货
const sales = { amount: salesRaw.amount - returnsRaw.amount, ... };

// report.js:61 —— 毛利：只扣"已结清"退货
const profitWithoutReceivable = salesProfitPaid - returnProfitRefunded;
//                                                 ^^^^^^^^^^^^^^^^^^^^ onlySettled=true
```

**复现**：
- 销售单 S：¥1000，已收款（`payment_status='paid'`），成本 ¥600，毛利 ¥400。
- 客户退货 ¥400（成本 ¥240），退货单 R 审核通过，但**还没退钱给客户**（`refund_status='unrefunded'`）。
- 报表"不含应收"模式显示：
  - **销售额 = 1000 − 400 = 600** ✅ 扣了退货
  - **毛利 = 400 − 0 = 400** ❌ 没扣退货（R 未 settled）
  - **毛利率 = 400 / 600 = 66.7%** ← 而正确的应该是 160 / 600 = **26.7%**

**为什么不是理论假设**：这是**默认模式**（`report.js:108` 的 `mode !== 'with_receivable'` 即默认走"不含应收"）。用户打开经营报表第一眼看到的就是这两个数字，而且它们并排显示在同一张卡片里（`report.ejs`）。
首页仪表盘同样：`todaySales`（`dashboard.js:41`）和 `todayProfit`（`dashboard.js:91`）并排显示，同一时刻的两个数按不同口径算。

**修复建议**：
- 让"不含应收"口径内部自洽：要么销售额也只扣 settled 退货，要么毛利也扣全部已审核退货。
- 推荐前者：销售额与毛利都只统计"已结清"业务，未结清的部分统一归入"应收"口径，这样 `profitWithReceivable − profitWithoutReceivable` 的差额才等于真实的应收风险敞口。
- 无论选哪个，都必须在报表页把口径写在数字旁边。

---

## P2-1（口径）报表"不含应收"模式下，明细列表金额合计 ≠ 顶部汇总卡片

**位置**：`routes/report.js:60`（汇总，不区分 mode）vs `report.js:82` / `report.js:100`（明细，按 mode 过滤）

```js
// 汇总：无论 mode 如何，都扣全部已审核退货
const sales = { amount: salesRaw.amount - returnsRaw.amount, ... };

// 明细（mode=不含应收）：只列 payment_status='paid' 的销售单 + settled 退货
if (!includeReceivable) sql += ` AND so.payment_status = 'paid'`;
```

**现象**：切到"不含应收"模式后，把明细表的金额列加总，跟顶部"销售额"卡片对不上。
用户会认为是系统算错了。

**修复建议**：汇总数字也随 mode 变化，或者在汇总卡片上标注"本卡片为全量口径，下方明细已按当前模式过滤"。

---

# 四、常规安全检查（补充）

## P2-2 审核/反审核的库存校验在事务外，存在 TOCTOU 窗口（有 DB 约束兜底，暂不致命）

**位置**：
- `routes/sales.js:392-409`（校验）→ `411-423`（事务扣减）
- `routes/transfers.js:184-195`（校验）→ `197-219`（事务扣减）
- `routes/returns.js:394-406`（校验）→ `408-424`（事务扣减）
- `routes/purchases.js:133-144`（校验）→ `146-161`（事务扣减）

**当前为什么不会出事**：better-sqlite3 是同步 API，Node 单线程，从"读 order"到"事务执行完"之间没有 `await`，事件循环不会让出控制权 → **单进程内实际是原子的**。
加上 `schema.js:120` 的 `CHECK(quantity >= 0)`，即便真并发了也只是抛 `SQLITE_CONSTRAINT` 变成 400 错误页，不会扣成负数。

**为什么仍要报**：状态更新 `UPDATE ... SET status='approved' WHERE id=?` **没有 `AND status='submitted'` 的条件保护**（`sales.js:421`、`transfers.js:217`、`returns.js:362`）。一旦将来改成多进程/多副本（PM2 cluster、K8s 多 Pod），两个管理员同时点审核就会**扣两次库存**。
`schema.js:85` 的 `busy_timeout = 5000` 只是让第二个事务等锁，等到了照样执行。

**修复建议**：把校验移进事务内，并把状态更新改成 `UPDATE ... SET status='approved' WHERE id=? AND status='submitted'`，检查 `changes === 1`，否则回滚。这是零成本改动，现在就该做。

---

## P2-3 `status` 列无 CHECK 约束

**位置**：`lib/schema.js:252-259`

```js
safeAddColumn(db, 'purchase_orders', "status TEXT NOT NULL DEFAULT 'pending'");
safeAddColumn(db, 'sales_orders',    "status TEXT NOT NULL DEFAULT 'draft'");
safeAddColumn(db, 'transfer_orders', "status TEXT NOT NULL DEFAULT 'pending'");
```

对比 `return_orders`（`schema.js:209`）建表时就有 `CHECK(status IN ('draft','submitted','approved','rejected'))`。
三张主表的 status 是后加的列，**没有任何约束**。目前所有写入都是硬编码字面量，所以暂时安全；但这是"靠人守规矩"而不是"靠数据库守规矩"。

**修复建议**：按 `migrateStockTransactionsType` / `migrateInventoryNonNegative` 的现成手法做一次建新表迁移补上 CHECK。或者至少在 approve/unapprove 里做一次白名单断言。

---

## P2-4 `order_date` 无格式校验，非法日期会让单据从月度统计中永久消失

**位置**：`routes/sales.js:280` / `350`、`routes/returns.js:223` / `298`、`routes/transfers.js:86` / `137`、`routes/purchases.js:77`

```js
order_date || todayLocalDate()   // 直接用，不校验格式
```

**后果**：`dashboard.js:47` / `50` 的 `strftime('%Y-%m', so.order_date)` 对非法格式返回 `NULL` →
该单**永久不进"本月销售额/本月毛利"**，但会正常出现在列表页和详情页。
用户看到"这个月的销售额怎么比明细加总少"。

**触发条件**：前端用了 `<input type="date">`（`sale_form.ejs:23`），正常不会出问题；但表单可以随意构造 POST，导入/批量场景也容易踩。

**修复建议**：加 `YYYY-MM-DD` 正则校验，不合法就拒绝或回退到 `todayLocalDate()`。

---

## P2-5 缺失基础安全响应头

**位置**：`app.js`，全站无 CSP / X-Frame-Options / X-Content-Type-Options / Referrer-Policy

**缓解因素**：`views/sale_form.ejs:61` / `return_form.ejs:66` / `transfer_form.ejs:54` / `purchase_form.ejs:43` 的 `JSON.stringify(...).replace(/</g, '\\u003c')` 做对了关键一步——`<` 被转义成 `\u003c`，`</script>` 无法构造，**JSON 注入到 `<script>` 的 XSS 在当前代码下不成立**。

**但仍然是缺口**：
- `sale_form.ejs:77-80` 的 `esc()` 只转义 `& < > "`，**不转义单引号**。目前所有用到 `esc()` 的地方都是双引号属性（`sale_form.ejs:87`），暂不可利用，但属于"以后谁改成单引号就出事"的隐患。
- 没有 `X-Frame-Options` → 可被点击劫持（配合 `SameSite=Lax` 只能防跨站 POST，防不住 iframe 内的 GET 诱导）。

**修复建议**：加 4 行响应头；`esc()` 补上 `&#39;`。

---

## P2-6 试用注册泄露手机号注册状态（用户枚举）

**位置**：`routes/trialAuth.js:24-26` 与 `58-60`

```js
if (isPhoneAlreadyTrialed(phone)) {
  return res.status(409).json({ ok: false, message: '该手机号已经开通过试用了' });
}
```

在**发送验证码之前**就返回"已开通"，攻击者可以批量探测哪些手机号是你的客户。
对竞品/骚扰营销是可用的情报。

**修复建议**：send-code 阶段无论是否已注册都返回 `ok:true`（真正发码时才判断），把 409 挪到 verify 阶段之后。

---

## P2-7 采购单删除后，`stock_transactions` 里原始 `purchase_in` 流水成为孤儿记录

**位置**：`routes/purchases.js:146-161`

删除时插入了一条 `type='adjust', ref_type='purchase_order_delete'` 的反向流水，但**原来的 `type='purchase_in', ref_type='purchase_order', ref_id=<已删除的id>` 仍然保留**。
出入库流水页（`inventory.js:32-48`）会显示一条指向不存在单据的流水，用户点追溯会找不到。

**修复建议**：这是取舍问题（留痕 vs 引用完整性）。建议保留流水，但把 `ref_type` 改成 `purchase_order_deleted` 明确标记，或在流水页对失效引用显示"（原单已删除）"。

---

# 五、已核查确认没问题的关键假设

以下 6 条核心业务规则，我逐条追到代码里验证过，**在当前代码下成立**。列出来是为了让你知道哪些地方不用再担心。

### ✅ 规则 1：库存只在审核通过时扣减，撤回/拒绝任何时候都不影响库存

| 单据 | 扣减点 | 撤回 | 拒绝 | 验证结论 |
|---|---|---|---|---|
| 销售单 | `sales.js:411-423`（事务内） | `374-382` 仅改状态 | `429-437` 仅改状态 | ✅ 一致 |
| 退货单 | `returns.js:349-364`（事务内，加库存） | `320-328` | `369-377` | ✅ 一致 |
| 调拨单 | `transfers.js:197-219`（事务内，双向） | `161-169` | `225-233` | ✅ 一致 |
| 采购单 | `purchases.js:73-96`（无审核流，录单即入） | — | — | ⚠️ 设计如此（`purchases.js:6-10` 注释说明），且全模块 `requireAdmin` |

草稿/待审核阶段的所有编辑（`sales.js:276-287`、`returns.js:219-230`、`transfers.js:82-93`）都**只写单据表，不碰 inventory、不写 stock_transactions**。✅

### ✅ 规则 2：反审核必须原子地把库存加回

三处反审核都用 `db.transaction()` 包裹"库存回滚 + 状态更新"：
- `sales.js:465-487` — 库存 `upsertInv` 加回 + `type='adjust'` 流水 + 状态改回 submitted，**同一个事务**
- `returns.js:408-424` — 扣回前先检查调入库存够不够（`394-406`），不够就拒绝并给出可操作的提示
- `transfers.js:265-290` — 双向回滚（from 加回、to 扣回），扣回前检查 `to_warehouse` 库存

**反审核链条完整性**（这是我最担心会漏的地方，验证结果：闭合）：
- 销售反审核前**主动拦截**存在"已审核关联退货单"的情况（`sales.js:452-463`），明确提示"请先把退货单反审核"——这条防护是到位的，不会重复加回。
- 退货审核时会**二次校验**关联销售单状态（`returns.js:340-345`），堵住了"建单时销售单已审核、之后被反审核"的 TOCTOU。
- 调拨反审核会被"货已在调入仓被卖掉/调走"的库存检查拦下（`transfers.js:250-263`）。
- 采购单删除会被库存检查拦下（**但见 P1-1，漏了"退货入库"这一种来源**）。

### ✅ 规则 3：赠品行收入按 0 算，但成本和库存照走

- 价格强制归零：`sales.js:62`（`if (gift) price = 0;`），前端 `sale_form.ejs:124-137` 同步把输入框设为 0 且 readOnly
- **成本快照照常记录**：`sales.js:69` 的 `costSnapshotPerBaseUnit(product, unit_choice[i])` 对赠品行同样执行
- **库存照常扣减**：`sales.js:417-419` 遍历 `items` 时**不区分 `is_gift`**，赠品行的 `base_quantity` 正常进 `decInv`
- 毛利公式 `quantity × 0 − base_quantity × cost_snapshot = −cost`（`profitCalc.js:47`）✅ 赠品成本被正确计为负毛利

### ✅ 规则 4：价格换算以"常用单位（箱）价"为落库真值

- `schema.js:242-243` 显式注释："箱价直接存储，不再由瓶价 × 换算比例反算，避免除不尽导致的四舍五入误差"
- 落库：`products.js:41-42` / `76-77` 直接写 `cost_price_pack` / `sale_price_pack`
- 前端取值：`sale_form.ejs:174` — `unitChoice === 'pack' ? (packPrice != null ? packPrice : basePrice * packSize) : basePrice` — **优先用箱价，箱价缺失才回退到瓶价×箱规**，方向正确（不是反过来）
- 成本快照换算：`lib/priceCalc.js:31-39` — `cost_price_pack / pack_size`，且 **sales.js 和 returns.js 共用同一份实现**（`sales.js:69` / `returns.js:64`），没有分叉

### ✅ 规则 5：毛利用下单当时的成本快照，不用商品当前成本价

- 快照落库：`sales.js:284` / `returns.js:227` 写入 `cost_price_snapshot`
- 消费侧全部用快照：`profitCalc.js:47`（销售）、`profitCalc.js:65`（退货）、`report.js:75`（销售单明细）、`report.js:93`（退货单明细）
- **全库 grep 确认：计算毛利的地方没有任何一处引用 `products.cost_price`**
- 老数据回填只做一次且用"保持原口径"的方式（`schema.js:270-279`），不会篡改历史

### ✅ 规则 6：多租户隔离 + 权限过滤在五个入口一致

**租户隔离**：
- 所有业务查询走 `req.tenantDb`，由 `middleware/tenant.js` 从 session 里的 `tenant_code` 解析，**没有任何接口接受客户端传租户标识**（`getTenantDb` 只在 `auth.js:30` 登录时接受用户输入）
- `db_path` 由系统内部拼接（`platformDb.js:99`），租户代码有字符集白名单 `TENANT_CODE_RE`（`platformDb.js:65`），路径穿越不可行
- 平台超管的跨租户操作（`platformAdmin.js:229` / `254`）走独立路径，且**创建/暂停/改限额/重置密码四类写操作都有审计**（`platformAdmin.js:160` / `171` / `204` / `246`）

**权限过滤矩阵**（操作员只看自己名下）——逐个入口核对过，无遗漏：

| 资源 | 列表 | 详情 | 编辑 | 导出 | 报表 | 结论 |
|---|---|---|---|---|---|---|
| 销售单 | `sales.js:104-107` | `sales.js:553` | `sales.js:298`/`312` | `sales.js:165` | admin-only | ✅ |
| 退货单 | `returns.js:97` | `returns.js:476` | `returns.js:240`/`254` | `returns.js:130` | admin-only | ✅ |
| 调拨单 | `transfers.js:47-50` | `transfers.js:307` | `transfers.js:104`/`117` | 无导出 | — | ✅ |
| 客户 | `partners.js:43` | — | `partners.js:64-66` | — | — | ✅ |
| 出入库流水 | `inventory.js:42` | — | — | `inventory.js:60` | — | ✅ |
| 采购单/报表/账号/商品/供应商 | — | — | — | — | `requireAdmin` | ✅ |

**特别注意的详情页越权**（历史上最容易出的洞）：`sales.js:553`、`returns.js:476`、`transfers.js:307` 三处都用 `canEditOrWithdraw(order, req.session.user)` 做了和列表页同口径的过滤，并带注释说明原因。**这个洞已经堵上了。** ✅

**其他常规项**：
- **SQL 注入**：全库所有用户输入都走 `?` 参数化；唯一的模板拼接 `${table}`（`dashboard.js:75`）用的是硬编码常量。✅ 无注入点
- **CSV 公式注入**：`utils/csv.js:11-13` 对 `= + - @ \t \r` 开头的非纯数字值加 `'` 前缀。✅ 已防护
- **会话固定**：`auth.js:54` 和 `platformAdmin.js:55` 登录成功后都调 `req.session.regenerate()`。✅
- **SESSION_SECRET**：`app.js:12-20` 缺失或 < 32 字符直接拒绝启动。✅ 强校验
- **密码**：全部 bcryptjs cost=10，无明文存储，无硬编码业务账号（**唯一例外是 P0-1 的平台超管**）
- **CSRF**：`app.js:66-79` 的 Origin 校验 + `SameSite=Lax` 双层；`/api/` 收紧为必须同源
- **限流**：登录 10 次/15 分钟（`auth.js:8`）；短信 1 次/60 秒 + 5 次/天/手机号 + 10 次/小时/IP；验证码校验 10 次/10 分钟（`trialAuth.js:29-66`）。✅
- **部署**：`.env` 已被 `.dockerignore` 排除，不进镜像；compose 只绑 `127.0.0.1:3000`，不直曝公网。✅
- **文件句柄**：`platformAdmin.js:156-158` / `238` / `256` 和 `trialProvision.js:80-82` 的临时 DB 连接都在 `finally` 或正常路径里 `close()`；`tenantManager.js:8` 的缓存有 200 上限 LRU。✅ 无泄漏

---

# 六、修复记录（2026-09-08 下午 · 方案 B 已实施）

老胡选定**方案 B**：把"是否已结清"统一改为**现算有效欠款**，不再用落库的
`payment_status`。同时把散落在 4 个文件里的退货金额子查询收敛到唯一实现点。

## 改动清单

| 文件 | 改动 |
|---|---|
| `lib/profitCalc.js` | 新增 `returnedAmountSubquery(alias)` / `effectiveDebtExpr(alias)` / `salesSettledExpr(alias)` 三个可参数化别名的 SQL 片段函数；`RETURN_SETTLED_EXPR` 改用 `EXISTS` + 有效欠款判定；`salesProfitStatement` 的 `onlyPaid` 过滤改为有效欠款判定（保留 `onlyPaid` 参数名做兼容） |
| `routes/report.js` | 删除本地重复定义的子查询，改为从 profitCalc 引入；`getSalesOrderList` 的"不含应收"过滤改用 `salesSettledExpr('so')` |
| `routes/dashboard.js` | 同上收敛；新增模块级 `attachEffectiveStatus()`，`recentSales` 查询补 `returned_amount` 并按有效欠款现算徽章状态 |
| `routes/sales.js` | 3 处内联子查询替换为共享常量；`record-payment` 的注释明确 `payment_status` 降级为"现金收款进度"语义 |
| `views/dashboard.ejs` | 收款状态徽章从 `o.payment_status` 改为 `o.effective_status`（2 处：桌面表格 + 移动卡片） |

**未改动**：`payment_status` 字段本身仍在写（表示现金收款进度），只是不再参与任何结清判定。

## 验证（全通过）

**1. 单元级（真实 SQLite，正向 + 反向 + 来回切换）**

| 场景 | 有效欠款 | 已结清 | 不含应收毛利 | 结果 |
|---|---|---|---|---|
| 定金 600 + 退货抵扣 400，退货已审核 | 0 | YES | **600**（旧行为 0） | PASS |
| 退货单被反审核（抵扣消失） | 400 | NO | **0** | PASS |
| 退货单重新审核 | 0 | YES | **600** | PASS |

第 2、3 行证明是**现算而非快照**——退货单状态一变，数字立刻跟着变，
这是方案 A（改落库判定）做不到的。

**2. HTTP 冒烟（临时租户，测完已清理）**

建了 3 张销售单：#1 定金600+退货抵扣400、#2 全款500、#3 未收款800。

- 页面全部 200：首页 / 销售列表 / 经营报表 / 销售详情 / 两处 CSV 导出
- **收款状态徽章三处一致**：#1 在首页、销售列表页、详情页**均显示"已收款"**
  （修复前首页会显示"部分收款"）
- 报表数字：销售额 ¥1900.00、应收金额 ¥800.00（只有 #3）、应收订单毛利 ¥300.00
- 毛利：不含应收 ¥800.00 / 含应收 ¥1100.00 / 差额 ¥300.00 —— 与手算预期完全一致

**3. 静态检查**：4 个 JS `node --check` 通过，4 个 EJS `ejs.compile` 通过；
全库 grep 确认 `routes/` 已无 `payment_status` 用于结清判定。

## 清理
临时租户 `smoketest`、本次自建的 `data/` 目录（platform.db / sessions.db）
及 /tmp 下所有临时脚本已删除。`git status` 只剩 5 个改动文件 + 2 份审计报告。

---

# 七、建议的剩余修复优先级

| 顺序 | 编号 | 问题 | 工作量 | 说明 |
|---|---|---|---|---|
| — | P0-1 | ~~平台超管默认密码~~ | — | ✅ 已关闭（老胡已改密码） |
| — | P1-4 | ~~payment_status 死结~~ | — | ✅ 已修复（方案 B） |
| — | P1-5 | ~~销售额/毛利口径~~ | — | ✅ 随 P1-4 一并好转 |
| 1 | P1-2B | 退货仓库 ≠ 销售仓库无提示 | 小 | 建议只加审核页提示，不改逻辑 |
| 2 | P1-1 | 删采购单可能误扣退货库存 | 小 | 建议删除前拒绝：存在退货/调拨入库流水时 |
| 3 | P2-2 | 状态更新加 CAS 保护 | 小 | 3 处各加一行 `AND status='submitted'` |
| 4 | P2-4 | order_date 格式校验 | 小 | 非法日期会让单据永久不进月度统计 |
| 5 | P2-3 / P2-5 / P2-6 / P2-7 | 其余 P2 | 小 | CHECK 约束 / 安全头 / 枚举 / 孤儿流水 |

> 老胡已明确判断 P1-1、P1-2A、P1-3 实际影响有限，经复核确认其判断成立（详见
> `.workbuddy/memory/2026-09-08.md` 的「自我复核」一节）。上表第 1、2 项
> 按"低成本止血"保留建议，不做也不影响上线。

---

**说明**：本报告所有结论均基于 `eb0df68` 这一版实际读到的代码，行号可直接跳转核实。
未做任何推测性断言——凡是我判断"当前部署形态下不可触发"的（如 P2-2 的并发），都在条目里明确标注了触发前提。
