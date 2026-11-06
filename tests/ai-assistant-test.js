'use strict';

// ============ AI 经营诊断助手端到端自检 ============
// 覆盖：
//   1. 平台管理后台租户双开关（ai_enabled / ai_shelfguard_enabled）保存与审计
//   2. 未开启开关时：租户管理员访问 /ai-assistant 及 POST /ai-assistant/chat 均返回 403，导航栏不显示入口
//   3. 开启开关后：操作员（operator）访问 /ai-assistant 及 POST /ai-assistant/chat 均被 requireAdmin 拦截返回 403（守住成本与毛利保密红线）
//   4. 开启开关后：管理员访问 /ai-assistant 返回 200，导航栏与客户列表显示「✨ 经营诊断 / ✨ 诊断」
//   5. 联调 ShelfGuard 内部只读接口：管理员发起单店诊断与全局诊断，返回真实进销存数据卡片、停拿品种预警及 ShelfGuard 巡检照片卡片

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const Module = require('module');
const bcrypt = require('bcryptjs');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-ai-test-'));
process.env.JXC_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
process.env.SHELFGUARD_INTERNAL_KEY = 'sg-internal-test-secret-key-2026';
process.env.DASHSCOPE_API_KEY = '';
process.env.AI_API_KEY = '';

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'dotenv') return { config: () => ({}) };
  return origLoad.apply(this, arguments);
};

const TENANT = 'aitenant';
const TENANT_ADMIN_PW = 'admin123456';
const TENANT_OP_PW = 'operator123';
const SUPER_INIT_PW = 'InitialSuper_2026';
const SUPER_NEW_PW = 'SuperNewPass_2026';
process.env.PLATFORM_ADMIN_INITIAL_PASSWORD = SUPER_INIT_PW;

let BASE = '';
let SG_SERVER = null;
let PASS = 0;
let FAIL = 0;

function ok(cond, msg) {
  if (cond) {
    PASS++;
    console.log('  PASS  ' + msg);
  } else {
    FAIL++;
    console.log('  FAIL  ' + msg);
  }
}

function section(t) {
  console.log('\n=== ' + t + ' ===');
}

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
  constructor() {
    this.cookie = '';
    this.csrfToken = '';
  }

  async ensureCsrf() {
    if (this.csrfToken) return;
    const headers = this.cookie ? { Cookie: this.cookie } : {};
    const r = await fetch(BASE + '/api/csrf-token', { headers, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    this.csrfToken = (await r.json()).token;
  }

  async raw(p, { body = null, method = null, json = false } = {}) {
    const m = method || (body === null ? 'GET' : 'POST');
    if (m !== 'GET') await this.ensureCsrf();
    const headers = { Origin: BASE };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    if (body !== null) {
      headers['Content-Type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
      if (json) headers['Accept'] = 'application/json';
    }
    const r = await fetch(BASE + p, { method: m, headers, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    if (r.status === 302 && (p === '/login' || p === '/platform-admin/login')) this.csrfToken = '';
    const ct = r.headers.get('content-type') || '';
    const text = ct.includes('text') || ct.includes('json') ? await r.text() : '';
    return { status: r.status, loc: r.headers.get('location'), text };
  }

  get(p) { return this.raw(p); }
  post(p, o = {}) { return this.raw(p, { body: form({ _request_key: crypto.randomUUID(), ...o }) }); }
  postJson(p, o = {}) { return this.raw(p, { body: JSON.stringify(o), method: 'POST', json: true }); }
}

async function startMockShelfGuardServer() {
  const port = await freePort();
  process.env.SHELFGUARD_BASE_URL = `http://127.0.0.1:${port}/shelfguard`;

  SG_SERVER = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${process.env.SHELFGUARD_INTERNAL_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: '内部接口密钥无效' }));
      return;
    }
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    if (u.pathname === '/shelfguard/api/internal/customer-summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        days: 90,
        matchedCustomer: {
          id: 'sg_cust_1',
          storeName: '东门烟酒店',
          jxcCustomerId: Number(u.searchParams.get('jxcCustomerId') || 1),
          hasLocation: true
        },
        summary: {
          visitCount: 3,
          scoredCount: 3,
          avgScore: 64.5,
          avgSharePercent: 28.0,
          lastVisitAt: '2026-11-01T10:00:00.000Z',
          topIssues: [{ issue: '主推品排面被竞品遮挡', count: 2 }],
          detectedProducts: [{ name: '特8经典', count: 3 }]
        },
        recentInspections: [
          {
            id: 'ins_01',
            createdAt: '2026-11-01T10:00:00.000Z',
            userName: '张三',
            score: 62,
            sharePercent: 25,
            summary: '黄金层排面不足',
            issues: ['主推品排面被竞品遮挡'],
            thumbnailURL: `http://127.0.0.1:${port}/shelfguard/files/inspections/u1/demo.jpg?exp=9999999999&sig=abc`
          }
        ]
      }));
      return;
    }
    if (u.pathname === '/shelfguard/api/internal/overview') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        days: 90,
        lowVisitThreshold: 2,
        totals: {
          activeCustomerCount: 10,
          inspectionCount: 18,
          visitedStoreCount: 7,
          lowVisitStoreCount: 3
        },
        lowestScoreStores: [{ storeName: '东门烟酒店', avgScore: 64.5, visitCount: 3 }],
        salespersonStats: [{ userName: '张三', visitCount: 12, coveredStoreCount: 6, avgScore: 76.0 }],
        storeStats: [
          { customerId: 'sg_cust_1', jxcCustomerId: 1, storeName: '东门烟酒店', visitCount: 3, avgScore: 64.5, avgSharePercent: 28.0 }
        ]
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => SG_SERVER.listen(port, '127.0.0.1', resolve));
}

async function startJxcServer() {
  const port = await freePort();
  process.env.PORT = String(port);
  BASE = `http://127.0.0.1:${port}`;
  require('../app.js');
  for (let i = 0; i < 1200; i++) {
    try {
      const r = await fetch(BASE + '/api/csrf-token');
      if (r.ok) return;
    } catch (_) {}
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('jxc 测试服务启动超时');
}

async function main() {
  const { createTenant, getTenantByCode } = require('../lib/platformDb');
  const { openTenantDbByPath, getTenantDb } = require('../lib/tenantManager');
  const { bootstrapTenant } = require('../lib/schema');
  const { todayLocalDate } = require('../utils/dates');

  await startMockShelfGuardServer();

  section('1. 初始化租户与业务数据');
  const tenant = createTenant(TENANT, 'AI诊断测试商贸');
  ok(tenant.ai_enabled === 0 && tenant.ai_shelfguard_enabled === 0, '新租户默认关闭 AI 诊断与巡检联动');

  const seedDb = openTenantDbByPath(tenant.db_path);
  bootstrapTenant(seedDb, {
    adminUsername: 'admin',
    adminPassword: TENANT_ADMIN_PW,
    adminName: '王总',
    warehouseName: '总仓'
  });
  // 创建一个操作员账号
  seedDb.prepare(
    'INSERT INTO users (username, password_hash, name, role, active) VALUES (?,?,?,?,1)'
  ).run('op1', bcrypt.hashSync(TENANT_OP_PW, 10), '张三', 'operator');
  const opUser = seedDb.prepare("SELECT id FROM users WHERE username='op1'").get();

  // 创建门店与客户标签（流通 / 餐饮）、商品、销售单
  seedDb.prepare(
    'INSERT INTO customers (name, contact, phone, address, operator_id) VALUES (?,?,?,?,?)'
  ).run('东门烟酒店', '李老板', '13800000001', '东大街18号', opUser.id);
  seedDb.prepare(
    'INSERT INTO customers (name, contact, phone, address, operator_id) VALUES (?,?,?,?,?)'
  ).run('西街大排档', '陈老板', '13800000002', '西街9号', opUser.id);
  const cust = seedDb.prepare("SELECT id FROM customers WHERE name='东门烟酒店'").get();
  const cust2 = seedDb.prepare("SELECT id FROM customers WHERE name='西街大排档'").get();

  const tagLiutong = seedDb.prepare("INSERT INTO customer_tags (name, color) VALUES ('流通', 'blue')"). run().lastInsertRowid;
  const tagCanyin = seedDb.prepare("INSERT INTO customer_tags (name, color) VALUES ('餐饮', 'orange')").run().lastInsertRowid;
  seedDb.prepare('INSERT INTO customer_tag_links (customer_id, tag_id) VALUES (?,?)').run(cust.id, tagLiutong);
  seedDb.prepare('INSERT INTO customer_tag_links (customer_id, tag_id) VALUES (?,?)').run(cust2.id, tagCanyin);

  seedDb.prepare(
    'INSERT INTO products (sku, name, spec, unit, pack_size, cost_price, sale_price) VALUES (?,?,?,?,?,?,?)'
  ).run('SKU1', '特8经典', '500ml', '瓶', 1, 60, 100);
  seedDb.prepare(
    'INSERT INTO products (sku, name, spec, unit, pack_size, cost_price, sale_price) VALUES (?,?,?,?,?,?,?)'
  ).run('SKU2', '老窖头曲', '500ml', '瓶', 1, 40, 70);
  const prod1 = seedDb.prepare("SELECT id FROM products WHERE sku='SKU1'").get();
  const prod2 = seedDb.prepare("SELECT id FROM products WHERE sku='SKU2'").get();

  const today = todayLocalDate();
  // 插入一笔本期已审核销售单（总额 1000，已收 400，欠款 600）
  const so1 = seedDb.prepare(
    "INSERT INTO sales_orders (customer_id, warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status) VALUES (?,1,?,?,1000,400,'partial','approved')"
  ).run(cust.id, opUser.id, today).lastInsertRowid;
  seedDb.prepare(
    'INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, cost_price_snapshot) VALUES (?,?,10,?,10,100,60)'
  ).run(so1, prod1.id, '瓶');

  // 插入一笔 45 天前的已审核销售单（含商品2，用于测试近30天停拿品种识别）
  const [y, m, d] = today.split('-').map(Number);
  const dt45 = new Date(y, m - 1, d - 45);
  const date45 = `${dt45.getFullYear()}-${String(dt45.getMonth() + 1).padStart(2, '0')}-${String(dt45.getDate()).padStart(2, '0')}`;
  const so2 = seedDb.prepare(
    "INSERT INTO sales_orders (customer_id, warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status) VALUES (?,1,?,?,1700,1700,'paid','approved')"
  ).run(cust.id, opUser.id, date45).lastInsertRowid;
  seedDb.prepare(
    'INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, cost_price_snapshot) VALUES (?,?,10,?,10,100,60)'
  ).run(so2, prod1.id, '瓶');
  seedDb.prepare(
    'INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, cost_price_snapshot) VALUES (?,?,10,?,10,70,40)'
  ).run(so2, prod2.id, '瓶');

  seedDb.close();

  await startJxcServer();

  section('2. 未开启开关时：管理员访问被拒且不显示入口');
  const adminClient = new Client();
  let r = await adminClient.post('/login', { tenant_code: TENANT, username: 'admin', password: TENANT_ADMIN_PW });
  ok(r.loc === '/', '租户管理员登录成功');

  r = await adminClient.get('/');
  ok(!r.text.includes('✨ 经营诊断'), '未开启开关时顶部导航栏不显示「✨ 经营诊断」');

  r = await adminClient.get('/ai-assistant');
  ok(r.status === 403 && r.text.includes('尚未开通 AI 经营诊断'), '未开启开关时管理员直连 /ai-assistant 返回 403');

  r = await adminClient.postJson('/ai-assistant/chat', { message: '你好' });
  ok(r.status === 403, '未开启开关时 POST /ai-assistant/chat 返回 403');

  section('3. 平台管理后台开启双开关');
  const superClient = new Client();
  await superClient.post('/platform-admin/login', { username: 'superadmin', password: SUPER_INIT_PW });
  await superClient.post('/platform-admin/change-password', { old_password: SUPER_INIT_PW, new_password: SUPER_NEW_PW });

  r = await superClient.get(`/platform-admin/tenants/${tenant.id}/edit`);
  ok(r.status === 200 && r.text.includes('开启 AI 经营诊断'), '平台后台租户编辑页展示 AI 经营诊断开关');

  r = await superClient.post(`/platform-admin/tenants/${tenant.id}/edit`, {
    tenant_name: 'AI诊断测试商贸',
    expires_at: '',
    max_users: '',
    ai_enabled: '1',
    ai_shelfguard_enabled: '1'
  });
  ok(r.status === 302 && r.loc === '/platform-admin', '平台后台保存租户 AI 开关成功');

  const updatedTenant = getTenantByCode(TENANT);
  ok(updatedTenant.ai_enabled === 1 && updatedTenant.ai_shelfguard_enabled === 1, '数据库已记录 ai_enabled=1 且 ai_shelfguard_enabled=1');

  section('4. 开启开关后：操作员仍被硬拦截（守住成本与毛利红线）');
  const opClient = new Client();
  r = await opClient.post('/login', { tenant_code: TENANT, username: 'op1', password: TENANT_OP_PW });
  ok(r.loc === '/', '操作员登录成功');

  r = await opClient.get('/');
  ok(!r.text.includes('✨ 经营诊断'), '操作员导航栏绝不显示「✨ 经营诊断」');

  r = await opClient.get('/ai-assistant');
  ok(r.status === 403 && r.text.includes('仅管理员可执行'), '操作员访问 /ai-assistant 被 requireAdmin 硬拦截 (403)');

  r = await opClient.postJson('/ai-assistant/chat', { message: '东门烟酒店毛利多少' });
  ok(r.status === 403, '操作员调用 POST /ai-assistant/chat 被硬拦截 (403)');

  section('5. 开启开关后：管理员正常使用单店与全局联合诊断');
  r = await adminClient.get('/');
  ok(r.text.includes('✨ 经营诊断'), '开启开关后管理员导航栏立即显示「✨ 经营诊断」');

  r = await adminClient.get('/customers');
  ok(r.text.includes(`/ai-assistant?customer_id=${cust.id}`), '客户列表页对管理员显示「✨ 诊断」快捷按钮');

  r = await adminClient.get(`/ai-assistant?customer_id=${cust.id}`);
  ok(r.status === 200 && r.text.includes('东门烟酒店') && r.text.includes('ShelfGuard 巡检已联动'), '诊断页正常渲染门店选择器与 ShelfGuard 联动状态');

  // 单店联合诊断（近30天：应识别出老窖头曲停拿、应收欠款 600 元、毛利 400 元，以及 ShelfGuard 巡检 64.5 分和签名缩略图）
  r = await adminClient.postJson('/ai-assistant/chat', {
    message: '综合诊断东门烟酒店最近的销售与陈列情况',
    customerId: cust.id,
    days: 30,
    stream: false
  });
  ok(r.status === 200, '单店诊断接口返回 HTTP 200');
  const chatBody = JSON.parse(r.text);
  ok(chatBody.ok === true && Array.isArray(chatBody.cards) && chatBody.cards.length === 2, '单店诊断同时返回进销存卡片与 ShelfGuard 巡检卡片');
  const jxcCard = chatBody.cards.find(c => c.type === 'jxc_customer');
  const sgCard = chatBody.cards.find(c => c.type === 'shelfguard_customer');
  ok(jxcCard && jxcCard.stoppedProducts.includes('老窖头曲'), '进销存卡片准确识别出上期曾拿货但本期停拿的品种「老窖头曲」');
  ok(sgCard && sgCard.photos.length === 1 && sgCard.photos[0].url.includes('/shelfguard/files/'), '巡检卡片包含 ShelfGuard 签名缩略图链接');
  ok(chatBody.answer.includes('东门烟酒店') && chatBody.answer.includes('老窖头曲') && chatBody.answer.includes('64.5'), '诊断报告正文涵盖销量、毛利、停拿品种及陈列评分');

  // 全局诊断
  r = await adminClient.postJson('/ai-assistant/chat', {
    message: '汇总近期全局经营情况与下滑门店',
    days: 30,
    stream: false
  });
  const globalBody = JSON.parse(r.text);
  ok(globalBody.ok === true && globalBody.cards.some(c => c.type === 'tenant_overview'), '全局诊断返回全公司经营与巡检概览卡片');
  ok(globalBody.answer.includes('流通1家') && globalBody.answer.includes('餐饮1家'), '全局诊断准确统计业务员名下各客户标签（流通/餐饮）数量');

  const { querySearchCustomers } = require('../lib/aiAssistant');
  const tagCheckDb = openTenantDbByPath(updatedTenant.db_path);
  const searchRes = querySearchCustomers(tagCheckDb, { operatorName: '张三', tagName: '流通客户' });
  tagCheckDb.close();
  ok(searchRes.total_matched_customers === 1 && searchRes.customers[0].name === '东门烟酒店' && searchRes.customers[0].tags.includes('流通'), 'search_customers 支持按业务员姓名+客户标签（自动兼容“流通客户”后缀）精准筛选');

  console.log(`\n===== AI 经营诊断自检结果：PASS ${PASS} / FAIL ${FAIL} =====`);
  return FAIL;
}

let exitCode = 1;
main()
  .then(fails => { exitCode = fails === 0 ? 0 : 1; })
  .catch(err => { console.error('\n自检脚本异常终止：', err); exitCode = 1; })
  .finally(() => {
    try {
      if (SG_SERVER) SG_SERVER.close();
      const { platformDb } = require('../lib/platformDb');
      if (platformDb.open) platformDb.close();
    } catch (_) {}
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    process.exit(exitCode);
  });
