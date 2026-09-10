// ============ 2026-09-10 三个 P1 修复的端到端自检 ============
// 为什么不往 tests/regression.js 里加：那个文件是全量回归（spawn 子进程 + 上百个用例），
// 在受限环境里不一定跑得起来。这个脚本只盯本次修的三个点，同进程 require app.js，跑得快。
//
// 覆盖：
//   P1-1 调拨单表单不再把商品 cost_price 内联给前端
//   P1-2 销售单反审核：同仓库/同商品的已审核退货会造成库存虚增 -> 拦住；
//        商品不重叠、日期更早的历史退货 -> 不能误伤（放过）
//   P1-3 默认超管 superadmin/super123 首次登录强制改密，改完才放行后台
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const Module = require('module');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-p1-'));
process.env.JXC_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';

// 受限环境里 dotenv 去读 .env 会被拦（进程直接挂掉），此处把 dotenv 换成空实现。
// 环境变量在上面已经手工注入，产品代码一行都不用改。
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'dotenv') return { config: () => ({}) };
  return origLoad.apply(this, arguments);
};

const TENANT = 'p1verify';
const TENANT_ADMIN_PW = 'admin123456';
const SUPER_OLD_PW = 'super123';
const SUPER_NEW_PW = 'SuperNewPass_2026';

let BASE = '';
let PASS = 0;
let FAIL = 0;
function ok(cond, msg) {
  if (cond) { PASS++; console.log('  PASS  ' + msg); } else { FAIL++; console.log('  FAIL  ' + msg); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

const enc = encodeURIComponent;
const form = (o) => Object.entries(o).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(err => (err ? reject(err) : resolve(p)));
    });
  });
}

class Client {
  constructor() { this.cookie = ''; this.csrfToken = ''; }

  async ensureCsrf() {
    if (this.csrfToken) return;
    const headers = this.cookie ? { Cookie: this.cookie } : {};
    const r = await fetch(BASE + '/api/csrf-token', { headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    this.csrfToken = (await r.json()).token;
  }

  async raw(p, { body = null, method = null } = {}) {
    const m = method || (body === null ? 'GET' : 'POST');
    if (m !== 'GET') await this.ensureCsrf();
    const headers = { Origin: BASE };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    if (body !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(BASE + p, { method: m, headers, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    // 登录会 session.regenerate()，旧 token 随之失效，必须重新取一个
    if (r.status === 302 && (p === '/login' || p === '/platform-admin/login')) this.csrfToken = '';
    const ct = r.headers.get('content-type') || '';
    const text = ct.includes('text') || ct.includes('json') ? await r.text() : '';
    return { status: r.status, loc: r.headers.get('location'), text };
  }

  get(p) { return this.raw(p); }
  post(p, o = {}) { return this.raw(p, { body: form(o) }); }
}

async function startServer() {
  const port = await freePort();
  process.env.PORT = String(port);
  BASE = `http://127.0.0.1:${port}`;
  require('../app.js');
  // 冷启动较慢（部分 SDK 的 require 就要十几秒），给足 60 秒
  for (let i = 0; i < 1200; i++) {
    try {
      const r = await fetch(BASE + '/api/csrf-token');
      if (r.ok) return;
    } catch (e) { /* 还没开始监听 */ }
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('本地测试服务启动超时');
}

async function main() {
  const { createTenant, getPlatformAdminByUsername, platformDb } = require('../lib/platformDb');
  const { openTenantDbByPath, getTenantDb } = require('../lib/tenantManager');
  const { bootstrapTenant } = require('../lib/schema');
  const { todayLocalDate } = require('../utils/dates');
  const today = todayLocalDate();

  section('准备');
  const superRow = getPlatformAdminByUsername('superadmin');
  ok(!!superRow, '首次启动自动创建了 superadmin');
  ok(!!superRow && superRow.must_change_password === 1, '自动创建的超管带 must_change_password=1');

  const tenant = createTenant(TENANT, 'P1自检租户');
  const seedDb = openTenantDbByPath(tenant.db_path);
  bootstrapTenant(seedDb, {
    adminUsername: 'admin', adminPassword: TENANT_ADMIN_PW, adminName: '管理员', warehouseName: '总仓'
  });
  const WID = seedDb.prepare('SELECT id FROM warehouses ORDER BY id').get().id;
  seedDb.close();
  ok(!!WID, `自检租户与默认仓库就绪（仓库 id=${WID}）`);

  await startServer();

  const T = new Client();
  let r = await T.post('/login', { tenant_code: TENANT, username: 'admin', password: TENANT_ADMIN_PW });
  ok(r.loc === '/', `租户管理员登录成功（loc=${r.loc}）`);
  const tdb = getTenantDb(TENANT).db;

  // ---------------- P1-1 ----------------
  section('P1-1 调拨单表单不泄露成本价');
  await T.post('/products/new', {
    sku: 'P1A', name: '自检商品A', spec: '500ml', unit: '瓶', pack_unit: '箱', pack_size: '12',
    cost_price: '88', sale_price: '100', low_stock_threshold: '0'
  });
  await T.post('/products/new', {
    sku: 'P1B', name: '自检商品B', spec: '500ml', unit: '瓶', pack_size: '1',
    cost_price: '77', sale_price: '90', low_stock_threshold: '0'
  });
  const pA = tdb.prepare("SELECT id FROM products WHERE sku = 'P1A'").get();
  const pB = tdb.prepare("SELECT id FROM products WHERE sku = 'P1B'").get();
  ok(!!pA && !!pB, `商品建档成功 A=${pA && pA.id} B=${pB && pB.id}`);

  r = await T.get('/transfers/new');
  ok(r.status === 200, '调拨开单页可正常打开');
  ok(!r.text.includes('cost_price'), '页面全文不含 cost_price 字段（参数名也不泄露）');
  ok(r.text.includes('自检商品A'), '商品下拉数据仍在（PRODUCTS 正常内联）');
  ok(r.text.includes('sale_price'), '表单需要的销售价字段仍在');

  // ---------------- P1-2 ----------------
  section('P1-2 销售单反审核不再造成库存虚增');
  const mkSale = async (pid, qty) => {
    await T.post('/sales/new', {
      warehouse_id: WID, order_date: today, save_draft: '1',
      items_json: JSON.stringify([{ id: pid, quantity: qty, price: 100, unit_choice: 'base' }])
    });
    return tdb.prepare('SELECT id FROM sales_orders ORDER BY id DESC').get().id;
  };
  const mkReturn = async (pid, qty, extra = {}) => {
    await T.post('/returns/new', Object.assign({
      warehouse_id: WID, order_date: today, save_draft: '1',
      items_json: JSON.stringify([{ id: pid, quantity: qty, price: 100, unit_choice: 'base' }])
    }, extra));
    return tdb.prepare('SELECT id FROM return_orders ORDER BY id DESC').get().id;
  };
  const approveSale = (id) => tdb.prepare("UPDATE sales_orders SET status = 'approved' WHERE id = ?").run(id);
  const approveReturn = (id) => tdb.prepare("UPDATE return_orders SET status = 'approved' WHERE id = ?").run(id);

  // 场景 1：同仓库、同商品的自由退货已审核 -> 反审核必须被拦
  const s1 = await mkSale(pA.id, 5);
  approveSale(s1);
  const freeRet = await mkReturn(pA.id, 1);
  approveReturn(freeRet);

  r = await T.post(`/sales/unapprove/${s1}`);
  ok(r.status === 400, `S1（同商品自由退货已审核）反审核被拦（HTTP ${r.status}）`);
  ok(r.text.includes('重复加回') || r.text.includes('库存虚增'), '拒绝原因说清了"会重复加回/库存虚增"');
  ok(r.text.includes('#' + freeRet), `拒绝信息点出了冲突的退货单号 #${freeRet}`);
  ok(tdb.prepare('SELECT status FROM sales_orders WHERE id = ?').get(s1).status === 'approved', '被拦后销售单状态未被改动');

  // 场景 2（反向对照）：同仓库但商品不重叠 -> 不能误伤
  const s2 = await mkSale(pB.id, 2);
  approveSale(s2);
  r = await T.post(`/sales/unapprove/${s2}`);
  ok(r.status === 302, `S2（商品不重叠）反审核放行（HTTP ${r.status}）—— 没有一刀切误伤`);
  ok(tdb.prepare('SELECT status FROM sales_orders WHERE id = ?').get(s2).status === 'submitted', 'S2 已回到待审核状态');

  // 场景 3（反向对照）：同商品，但退货日期早于本销售单 -> 属于无关历史单，放过
  tdb.prepare('DELETE FROM return_order_items WHERE return_order_id = ?').run(freeRet);
  tdb.prepare('DELETE FROM return_orders WHERE id = ?').run(freeRet);
  const s3 = await mkSale(pA.id, 3);
  approveSale(s3);
  const oldRet = await mkReturn(pA.id, 1, { order_date: '2020-01-01' });
  approveReturn(oldRet);
  r = await T.post(`/sales/unapprove/${s3}`);
  ok(r.status === 302, `S3（仅存在更早日期的同商品退货）反审核放行（HTTP ${r.status}）—— 日期过滤生效`);

  // 场景 4（回归对照）：直接关联本单的已审核退货 -> 原有拦截能力不能退化
  const s4 = await mkSale(pA.id, 4);
  approveSale(s4);
  const linkedRet = await mkReturn(pA.id, 1, { related_sales_order_id: String(s4) });
  approveReturn(linkedRet);
  r = await T.post(`/sales/unapprove/${s4}`);
  ok(r.status === 400, `S4（有关联退货）反审核仍被拦（HTTP ${r.status}）`);

  // ---------------- P1-3 ----------------
  section('P1-3 默认超管强制改密');
  const P = new Client();
  r = await P.post('/platform-admin/login', { username: 'superadmin', password: SUPER_OLD_PW });
  ok(r.status === 302 && r.loc === '/platform-admin/change-password',
    `默认口令登录后直接送去改密页（loc=${r.loc}）`);

  r = await P.get('/platform-admin');
  ok(r.status === 302 && r.loc === '/platform-admin/change-password', '未改密时后台首页不可达（弹回改密页）');
  r = await P.get('/platform-admin/api-keys');
  ok(r.status === 302 && r.loc === '/platform-admin/change-password', '未改密时 API Key 管理页同样不可达');
  r = await P.post('/platform-admin/tenants/new', { tenant_code: 'hack1', tenant_name: 'x', admin_username: 'a', admin_password: '123456' });
  ok(r.status === 302 && r.loc === '/platform-admin/change-password', '未改密时无法创建租户（POST 也被拦）');

  r = await P.get('/platform-admin/change-password');
  ok(r.status === 200 && r.text.includes('必须修改'), '改密页展示了强制改密提示');

  r = await P.post('/platform-admin/change-password', { old_password: SUPER_OLD_PW, new_password: SUPER_OLD_PW });
  ok(r.status === 200 && r.text.includes('不能与原密码相同'), '新密码填回原密码被拒');
  ok(getPlatformAdminByUsername('superadmin').must_change_password === 1, '改密失败后标记仍为 1');

  r = await P.post('/platform-admin/change-password', { old_password: 'wrong-pass', new_password: SUPER_NEW_PW });
  ok(r.text.includes('原密码不正确'), '原密码错误被拒');
  r = await P.post('/platform-admin/change-password', { old_password: SUPER_OLD_PW, new_password: '12345' });
  ok(r.text.includes('至少6位'), '新密码过短被拒');
  ok(getPlatformAdminByUsername('superadmin').must_change_password === 1, '多次失败后标记仍为 1');

  r = await P.post('/platform-admin/change-password', { old_password: SUPER_OLD_PW, new_password: SUPER_NEW_PW });
  ok(r.status === 200 && r.text.includes('密码修改成功'), '改密成功');
  ok(getPlatformAdminByUsername('superadmin').must_change_password === 0, '数据库里的标记已清 0');

  r = await P.get('/platform-admin');
  ok(r.status === 200, '同一会话改完密码立刻能进后台');

  const P2 = new Client();
  r = await P2.post('/platform-admin/login', { username: 'superadmin', password: SUPER_NEW_PW });
  ok(r.status === 302 && r.loc === '/platform-admin', `新会话用新密码登录直接进后台（loc=${r.loc}）`);
  r = await P2.post('/platform-admin/login', { username: 'superadmin', password: SUPER_OLD_PW });
  ok(r.status === 200 && r.text.includes('用户名或密码错误'), '旧默认口令已失效');

  console.log(`\n===== 自检结果：PASS ${PASS} / FAIL ${FAIL} =====`);
  return FAIL;
}

let exitCode = 1;
main()
  .then(fails => { exitCode = fails === 0 ? 0 : 1; })
  .catch(err => { console.error('\n自检脚本异常终止：', err); exitCode = 1; })
  .finally(() => {
    try {
      const { platformDb } = require('../lib/platformDb');
      if (platformDb.open) platformDb.close();
    } catch (e) { /* 忽略 */ }
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(exitCode);
  });
