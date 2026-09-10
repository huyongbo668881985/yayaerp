/**
 * API v1 租户隔离 / 认证 / 权限 / 限流 回归测试（真实 HTTP，端到端）
 *
 * 测什么（对应 SECURITY 要求"必须实测，不能只说已实现"）：
 *   1. 双租户互相试探：A 的 Key 拿不到 B 的任何数据；请求参数里塞租户标识会被忽略
 *   2. 认证：无 Key / 错 Key / 已吊销 Key / 租户被暂停 → 全部 401，吊销立即生效
 *   3. 权限档位：read_only Key 打写操作占位 → 403；read_write Key → 501（档位放行、端点未实现）
 *   4. 限流：同一 Key 连续请求超阈值 → 429，且其他 Key 不受影响（按 Key 分桶）
 *
 * 运行方式（建议把限流阈值调低，测得快）：
 *   SESSION_SECRET=$(openssl rand -hex 32) API_RATE_LIMIT_PER_MIN=15 node tests/api-isolation-test.js
 *
 * 本脚本会创建 apitest_ 前缀的临时租户并向其中写入测试数据，结束时自动清理
 * （删 api_keys / tenants 行 + 删租户 db 文件），不留残留。
 */

process.chdir(__dirname + '/..');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// app.js 要求 SESSION_SECRET 存在才肯启动；测试不关心具体值，缺了就现场生成
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
}
const RATE_LIMIT = Math.max(1, Number(process.env.API_RATE_LIMIT_PER_MIN) || 60);

const PORT = 3179;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE_A = 'apitest_a';
const CODE_B = 'apitest_b';

let PASSES = 0, FAILS = 0;
function ok(cond, label, extra = '') {
  if (cond) { PASSES++; console.log(`  PASS  ${label}${extra ? '  [' + extra + ']' : ''}`); }
  else { FAILS++; console.log(`  FAIL  ${label}${extra ? '  [' + extra + ']' : ''}`); }
}
function section(t) { console.log(`\n=== ${t} ===`); }

const MARK_A = 'ATestA';   // 租户 A 数据标记（商品名/客户名前缀）
const MARK_B = 'BTestB';   // 租户 B 数据标记

function purgeTenant(code, platformDb, getTenantByCode) {
  const t = getTenantByCode(code);
  if (t) {
    platformDb.prepare('DELETE FROM api_keys WHERE tenant_id = ?').run(t.id);
    platformDb.prepare('DELETE FROM tenants WHERE id = ?').run(t.id);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'tenants', `${code}.db${suffix}`)); } catch (e) { /* 不存在 */ }
  }
}

(async () => {
  // ============ 0. 准备：临时租户 + 数据 + Key ============
  section('0. 准备临时租户与数据');
  const { platformDb, getTenantByCode, createTenant, setTenantStatus } = require('./../lib/platformDb');
  const apiKeys = require('./../lib/apiKeys');
  const { openTenantDbByPath } = require('./../lib/tenantManager');
  const { bootstrapTenant } = require('./../lib/schema');
  const { todayLocalDate } = require('./../utils/dates');

  // 先清掉上次运行可能留下的残留（幂等，可重复跑）
  purgeTenant(CODE_A, platformDb, getTenantByCode);
  purgeTenant(CODE_B, platformDb, getTenantByCode);

  const today = todayLocalDate();
  let tenantA, tenantB;
  let keyA_read, keyA_write, keyB_read, keyB_burst, keyB_regen;

  const seed = (code, name, mark, orderTotal, itemQty, itemPrice, itemCost, paid, invQty) => {
    const tenant = createTenant(code, name);
    const db = openTenantDbByPath(tenant.db_path);
    bootstrapTenant(db, { adminUsername: 'admin', adminPassword: 'pass12345', adminName: '管理员', warehouseName: '总仓' });
    db.prepare("INSERT INTO products (sku, name, spec, unit, cost_price, sale_price, low_stock_threshold) VALUES (?, ?, '', '瓶', ?, ?, 5)")
      .run('SKU-' + mark, mark + '商品', itemCost, itemPrice);
    db.prepare('INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (1, 1, ?)').run(invQty);
    db.prepare('INSERT INTO customers (name) VALUES (?)').run(mark + '客户');
    db.prepare(`INSERT INTO sales_orders (customer_id, warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status, note, remarks)
                VALUES (1, 1, 1, ?, ?, ?, 'partial', 'approved', '', '')`).run(today, orderTotal, paid);
    db.prepare(`INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, is_gift, cost_price_snapshot)
                VALUES (1, 1, ?, '瓶', ?, ?, 0, ?)`).run(itemQty, itemQty, itemPrice, itemCost);
    db.close();
    return tenant;
  };

  // 租户 A：销售额 1000（已收 600，有效欠款 400），另有一张 200 的草稿单
  tenantA = seed(CODE_A, '隔离测试租户A', MARK_A, 1000, 100, 10, 6, 600, 100);
  {
    const db = openTenantDbByPath(tenantA.db_path);
    db.prepare(`INSERT INTO sales_orders (customer_id, warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status, note, remarks)
                VALUES (1, 1, 1, ?, 200, 0, 'unpaid', 'draft', '', '')`).run(today);
    db.prepare(`INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, is_gift, cost_price_snapshot)
                VALUES (2, 1, 20, '瓶', 20, 10, 0, 6)`).run();
    db.close();
  }
  // 租户 B：销售额 999（全款结清），与 A 的所有数字/名称都不同
  tenantB = seed(CODE_B, '隔离测试租户B', MARK_B, 999, 333, 3, 1, 999, 77);

  keyA_read = apiKeys.generateApiKey({ tenantId: tenantA.id, permissionLevel: 'read_only', adminId: 1, adminUsername: 'superadmin' });
  keyA_write = apiKeys.generateApiKey({ tenantId: tenantA.id, permissionLevel: 'read_write', adminId: 1, adminUsername: 'superadmin' });
  keyB_read = apiKeys.generateApiKey({ tenantId: tenantB.id, permissionLevel: 'read_only', adminId: 1, adminUsername: 'superadmin' });
  keyB_burst = apiKeys.generateApiKey({ tenantId: tenantB.id, permissionLevel: 'read_only', adminId: 1, adminUsername: 'superadmin' });
  ok(!!tenantA && !!tenantB, '创建两个临时租户并写入互不相同的测试数据');
  ok(keyA_read.plaintext.startsWith('jxc_') && keyA_read.plaintext.length === 52, '生成 4 个 API Key（A只读/A读写/B只读/B限流专用）');

  // ============ 启动被测服务（同进程 require，app.js 顶层即监听）============
  process.env.PORT = String(PORT);
  require('./../app.js'); // 打印"进销存系统已启动"即监听成功
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try { await fetch(BASE + '/platform-admin/login'); up = true; } catch (e) { await new Promise(r => setTimeout(r, 200)); }
  }
  ok(up, `服务已启动并探活 (port ${PORT})`);

  const get = (p, key, useXApiKey) => fetch(BASE + p, {
    headers: key ? (useXApiKey ? { 'X-API-Key': key } : { Authorization: 'Bearer ' + key }) : {}
  });
  const post = (p, key) => fetch(BASE + p, { method: 'POST', headers: key ? { Authorization: 'Bearer ' + key } : {} });

  // ============ 1. 认证 ============
  section('1. 认证（401 / X-API-Key）');
  let r = await get('/api/v1/inventory');
  ok(r.status === 401 && (await r.json()).error.code === 'missing_key', '无 Key 请求 → 401 missing_key', `status=${r.status}`);

  r = await get('/api/v1/inventory', 'jxc_' + '0'.repeat(48));
  ok(r.status === 401 && (await r.json()).error.code === 'invalid_key', '伪造 Key 请求 → 401 invalid_key', `status=${r.status}`);

  r = await get('/api/v1/inventory', keyA_read.plaintext, true);
  const xkeyOk = r.status === 200;
  if (xkeyOk) await r.text();
  ok(xkeyOk, 'X-API-Key 请求头与 Bearer 等价', `status=${r.status}`);

  // ============ 2. 租户 A 只读端点（数据正确性） ============
  section('2. 租户 A 只读端点（数据正确性）');
  r = await get('/api/v1/reports/summary', keyA_read.plaintext);
  let j = await r.json();
  ok(r.status === 200 && j.sales.amount === 1000 && j.sales.count === 1, 'summary: 销售额 1000 / 1 张已审核单', JSON.stringify(j.sales));
  ok(j.receivable.amount === 400 && j.profit.with_receivable === 400 && j.profit.without_receivable === 0,
    'summary: 有效欠款 400、毛利口径与报表页一致（未结清→全在应收口径）', `receivable=${j.receivable.amount}`);
  ok(!JSON.stringify(j).includes(MARK_B), 'summary: 响应不含租户 B 的任何数据');

  r = await get('/api/v1/reports/leaderboard', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.rows.length === 1 && j.rows[0].net_amount === 1000 && j.rows[0].rank === 1,
    'leaderboard: 仅租户 A 自己的录单人，净额 1000 排第 1', JSON.stringify(j.rows[0] || {}));

  r = await get('/api/v1/sales', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.total === 2, 'sales: 租户 A 共 2 张单（含 1 张草稿）', `total=${j.total}`);
  ok(j.items.every(i => i.customer_name.includes(MARK_A)), 'sales: 全部是租户 A 自己的单');

  r = await get('/api/v1/sales?status=approved', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.total === 1 && j.items[0].total_amount === 1000, 'sales?status=approved: 只剩已审核那张', `total=${j.total}`);
  r = await get('/api/v1/sales?status=draft', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.total === 1 && j.items[0].status === 'draft', 'sales?status=draft: 只剩草稿单', `total=${j.total}`);

  r = await get('/api/v1/sales?page=2&pageSize=1', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.total === 2 && j.items.length === 1, 'sales 分页: pageSize=1&page=2 返回第 2 页 1 条', `total=${j.total}, items=${j.items.length}`);

  r = await get('/api/v1/inventory', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.count === 1 && j.items[0].name === MARK_A + '商品' && j.items[0].quantity === 100,
    'inventory: 只有租户 A 的商品，库存 100', JSON.stringify(j.items[0] || {}));
  r = await get('/api/v1/inventory?warehouse_id=999', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.count === 0, 'inventory?warehouse_id=999: 不存在的仓库返回空列表', `count=${j.count}`);

  // ============ 3. 租户 B 的视角（双 Key 互相试探） ============
  section('3. 租户 B 视角（双 Key 互相试探隔离）');
  r = await get('/api/v1/sales', keyB_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.total === 1 && j.items[0].total_amount === 999 && j.items[0].customer_name === MARK_B + '客户',
    'B 的 Key 只看到 B 自己的 1 张 999 元销售单', `total=${j.total}`);
  ok(!JSON.stringify(j).includes(MARK_A), "B 的响应里完全没有租户 A 的数据（拿 A 的单号/客户名试探无果）");

  // 用 A 的 Key 在参数里硬塞租户标识，试图越权看 B —— 应被完全忽略
  r = await get('/api/v1/sales?tenant_code=' + CODE_B + '&tenant_id=' + tenantB.id + '&customer_id=999', keyA_read.plaintext);
  j = await r.json();
  ok(r.status === 200 && j.total === 2 && !JSON.stringify(j).includes(MARK_B),
    'A 的 Key 传 tenant_code/tenant_id=B 的标识 → 参数被忽略，仍只返回 A 自己的数据', `total=${j.total}`);

  // ============ 4. 吊销与租户暂停立即生效 ============
  section('4. 吊销 / 暂停立即生效');
  apiKeys.revokeApiKey(keyB_read.id); // 超管后台吊销动作的 lib 等价调用
  r = await get('/api/v1/inventory', keyB_read.plaintext);
  ok(r.status === 401, '吊销 keyB_read 后立刻调用 → 401（吊销即时生效）', `status=${r.status}`);

  keyB_regen = apiKeys.generateApiKey({ tenantId: tenantB.id, permissionLevel: 'read_only', adminId: 1, adminUsername: 'superadmin' });
  setTenantStatus(tenantB.id, 'suspended'); // 超管暂停租户 B
  r = await get('/api/v1/inventory', keyB_regen.plaintext);
  j = await r.json().catch(() => ({}));
  ok(r.status === 401 && j.error && j.error.code === 'tenant_suspended', '租户 B 被暂停后，其新 Key 也立即 401', `status=${r.status}`);
  setTenantStatus(tenantB.id, 'active');
  r = await get('/api/v1/inventory', keyB_regen.plaintext);
  ok(r.status === 200, '恢复租户 B 后同一 Key 立即可用', `status=${r.status}`);

  // ============ 5. 权限档位（写占位端点） ============
  section('5. 权限档位拦截');
  r = await post('/api/v1/sales', keyA_read.plaintext);
  j = await r.json().catch(() => ({}));
  ok(r.status === 403 && j.error && j.error.code === 'forbidden', 'read_only Key 调写占位端点 → 403 forbidden', `status=${r.status}`);
  r = await post('/api/v1/sales', keyA_write.plaintext);
  j = await r.json().catch(() => ({}));
  ok(r.status === 501 && j.error && j.error.code === 'not_implemented', 'read_write Key 调写占位端点 → 501（档位放行，端点未实现）', `status=${r.status}`);

  // ============ 6. 限流（按 Key 分桶） ============
  section(`6. 限流（阈值 ${RATE_LIMIT} 次/分钟，按 Key 分桶）`);
  const burst = RATE_LIMIT + 3;
  let saw429 = false, lastStatus = 0;
  for (let i = 0; i < burst; i++) {
    const rr = await get('/api/v1/reports/summary', keyB_burst.plaintext);
    lastStatus = rr.status;
    if (rr.status === 429) {
      saw429 = true;
      const body = await rr.json().catch(() => ({}));
      if (i === burst - 1) {
        ok(body.error && body.error.code === 'rate_limited', `连续 ${burst} 次请求：第 ${i + 1} 次起 429，响应体 code=rate_limited`, `last=${lastStatus}`);
      }
      continue;
    }
    await rr.text();
  }
  ok(saw429 && lastStatus === 429, `B 的限流专用 Key 触发 429（连发 ${burst} 次，末次状态 ${lastStatus}）`);
  r = await get('/api/v1/reports/summary', keyA_write.plaintext);
  ok(r.status === 200, '限流是按 Key 分桶的：A 的 Key 不受 B 突发流量影响，仍正常 200', `status=${r.status}`);

  // ============ 7. last_used_at 刷新 ============
  section('7. 使用痕迹');
  const usedRow = apiKeys.getApiKeyById(keyA_read.id);
  ok(!!usedRow.last_used_at, 'keyA_read 的 last_used_at 已刷新（超管后台可见最近使用时间）', usedRow.last_used_at);

  // ============ 8. 清理 ============
  section('8. 清理临时数据');
  for (const code of [CODE_A, CODE_B]) purgeTenant(code, platformDb, getTenantByCode);
  const left = platformDb.prepare("SELECT COUNT(*) AS c FROM tenants WHERE tenant_code LIKE 'apitest_%'").get().c;
  ok(left === 0, '临时租户与 Key 已全部清理', `残留=${left}`);

  console.log(`\n========== 结果: ${PASSES} PASS / ${FAILS} FAIL ==========`);
  process.exit(FAILS === 0 ? 0 : 1);
})().catch(e => {
  console.error('测试脚本异常中断:', e);
  process.exit(1);
});
