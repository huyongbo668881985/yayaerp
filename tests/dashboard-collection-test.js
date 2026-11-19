const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-dashboard-collection-'));
process.env.JXC_DATA_DIR = dir;
process.env.SESSION_SECRET = randomUUID() + randomUUID();
process.env.PLATFORM_ADMIN_INITIAL_PASSWORD = 'InitialAdmin_2026';
process.env.NODE_ENV = 'test';

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request) {
  return request === 'dotenv' ? { config: () => ({}) } : originalLoad.apply(this, arguments);
};

let base;
let passed = 0;
const { createTenant } = require('../lib/platformDb');
const { openTenantDbByPath } = require('../lib/tenantManager');
const { bootstrapTenant } = require('../lib/schema');
const { todayLocalDate } = require('../utils/dates');

const tenant = createTenant('collection', '回款看板测试租户');
const db = openTenantDbByPath(tenant.db_path);
bootstrapTenant(db, { adminUsername: 'owner', adminPassword: 'OwnerPass_2026', adminName: '超级管理员', warehouseName: '总仓' });

const adminId = Number(db.prepare('INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?,?)').run('admin', bcrypt.hashSync('AdminPass_2026', 10), '分店管理员', 'admin').lastInsertRowid);
const worker1Id = Number(db.prepare('INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?,?)').run('worker1', bcrypt.hashSync('WorkerPass_2026', 10), '业务员甲', 'operator').lastInsertRowid);
const worker2Id = Number(db.prepare('INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?,?)').run('worker2', bcrypt.hashSync('WorkerPass_2026', 10), '业务员乙', 'operator').lastInsertRowid);

const productId = Number(db.prepare("INSERT INTO products (sku, name, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack) VALUES ('W001', '测试白酒', '瓶', '箱', 6, 50, 100, 300, 600)").run().lastInsertRowid);
const customer1Id = Number(db.prepare("INSERT INTO customers (name, contact, phone, operator_id) VALUES ('客户一', '张三', '13800000001', ?)").run(worker1Id).lastInsertRowid);
const customer2Id = Number(db.prepare("INSERT INTO customers (name, contact, phone, operator_id) VALUES ('客户二', '李四', '13800000002', ?)").run(worker2Id).lastInsertRowid);
const warehouse1Id = Number(db.prepare("INSERT INTO warehouses (name, address, operator_id) VALUES ('一号仓', '地址1', ?)").run(worker1Id).lastInsertRowid);
const warehouse2Id = Number(db.prepare("INSERT INTO warehouses (name, address, operator_id) VALUES ('二号仓', '地址2', ?)").run(worker2Id).lastInsertRowid);
db.prepare('INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?, ?, 1000), (?, ?, 1000)').run(productId, warehouse1Id, productId, warehouse2Id);

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async request(url, body) {
    if (body && !this.csrf) this.csrf = (await this.request('/api/csrf-token')).data.token;
    const response = await fetch(base + url, {
      redirect: 'manual',
      method: body ? 'POST' : 'GET',
      headers: {
        Cookie: this.cookie,
        Origin: base,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': this.csrf } : {})
      },
      ...(body ? { body: new URLSearchParams({ _request_key: randomUUID(), ...body }) } : {})
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) this.cookie = cookies.map(c => c.split(';')[0]).join('; ');
    if (response.status === 302 && ['/login', '/platform-admin/login'].includes(url)) this.csrf = '';
    const text = await response.text();
    return {
      status: response.status,
      location: response.headers.get('location'),
      text,
      data: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null
    };
  }
  login(username, password) { return this.request('/login', { tenant_code: 'collection', username, password }); }
}

function extractCollectionCard(html) {
  const match = html.match(/data-card-id="monthly_collection">([\s\S]*?)<\/div>\s*(?=<div class="stat-card|<\/div>)/);
  assert.ok(match, '首页应包含 monthly_collection 卡片');
  return match[1];
}

async function check(label, work) {
  await work();
  passed++;
  console.log('  PASS ' + label);
}

(async () => {
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });
  process.env.PORT = String(port);
  base = 'http://127.0.0.1:' + port;
  require('../app');

  const admin = new Client();
  const worker1 = new Client();
  const worker2 = new Client();
  await admin.login('admin', 'AdminPass_2026');
  await worker1.login('worker1', 'WorkerPass_2026');
  await worker2.login('worker2', 'WorkerPass_2026');

  const today = todayLocalDate();
  const prevMonthDate = '2026-01-15';

  // 1. 初始状态应为 0
  await check('初始状态：本月回款额及拆解均为 ¥0.0', async () => {
    const home = await admin.request('/');
    assert.equal(home.status, 200);
    const card = extractCollectionCard(home.text);
    assert.ok(card.includes('¥0.0'), '主数字应为 ¥0.0');
    assert.ok(card.includes('当月订单 ¥0.0'), '当月订单副标题为 ¥0.0');
    assert.ok(card.includes('收回旧欠 ¥0.0'), '收回旧欠副标题为 ¥0.0');
  });

  // 2. 本月销售单开单预收 + 审核 + 事后补收尾款
  let worker1OrderId;
  await check('本月新单预收 + 事后收款均计入“本月回款额 -> 当月订单”', async () => {
    const createRes = await worker1.request('/sales/new', {
      warehouse_id: String(warehouse1Id),
      customer_id: String(customer1Id),
      responsible_id: String(worker1Id),
      order_date: today,
      paid_amount: '300',
      product_id: String(productId),
      quantity: '10',
      sale_unit: 'base',
      unit_price: '100'
    });
    assert.equal(createRes.status, 302);
    worker1OrderId = db.prepare('SELECT MAX(id) AS id FROM sales_orders').get().id;

    // 未审核前不应计入本月回款额
    let home = await admin.request('/');
    assert.ok(extractCollectionCard(home.text).includes('¥0.0'), '待审核单据预收不应计入回款额');

    // 审核通过后计入 ¥300.0
    const approveRes = await admin.request(`/sales/approve/${worker1OrderId}`, {});
    assert.equal(approveRes.status, 302);
    home = await admin.request('/');
    let card = extractCollectionCard(home.text);
    assert.ok(card.includes('>¥300.0<'), '审核后主数字应为 ¥300.0');
    assert.ok(card.includes('当月订单 ¥300.0'), '当月订单收款应为 ¥300.0');

    // 事后记录收款 ¥200.0
    const payRes = await admin.request(`/sales/${worker1OrderId}/record-payment`, { amount: '200' });
    assert.equal(payRes.status, 302);
    home = await admin.request('/');
    card = extractCollectionCard(home.text);
    assert.ok(card.includes('>¥500.0<'), '补收后主数字应为 ¥500.0');
    assert.ok(card.includes('当月订单 ¥500.0'), '当月订单收款应累计为 ¥500.0');
  });

  // 3. 往月欠款单（含升级结转的历史已收）在本月收款：仅本月新增收款计入“收回旧欠”
  await check('往月欠款本月收回计入“收回旧欠”，升级结转历史已收不虚增本月回款', async () => {
    // 模拟一张往月已审核订单：总额 1000，升级结转时已收 200（历史收款），剩余欠款 800
    const oldOrderId = Number(db.prepare(`
      INSERT INTO sales_orders (customer_id, warehouse_id, user_id, responsible_id, order_date, total_amount, paid_amount, payment_status, status)
      VALUES (?, ?, ?, ?, ?, 1000, 200, 'partial', 'approved')
    `).run(customer2Id, warehouse2Id, worker2Id, worker2Id, prevMonthDate).lastInsertRowid);
    db.prepare(`
      INSERT INTO customer_ledger (customer_id, document_type, document_id, document_date, event_date, event_kind, sales_cents, received_cents, returned_cents, refunded_cents)
      VALUES (?, 'sales', ?, ?, ?, '升级结转', 100000, 20000, 0, 0)
    `).run(customer2Id, oldOrderId, prevMonthDate, today);

    // 结转历史 200 不得计入本月回款
    let home = await admin.request('/');
    let card = extractCollectionCard(home.text);
    assert.ok(card.includes('>¥500.0<'), '往月订单的升级结转历史已收 200 不应计入本月回款');

    // 本月收回该往月旧欠 400
    const payOldRes = await admin.request(`/sales/${oldOrderId}/record-payment`, { amount: '400' });
    assert.equal(payOldRes.status, 302);

    home = await admin.request('/');
    card = extractCollectionCard(home.text);
    assert.ok(card.includes('>¥900.0<'), '本月回款额应为 500 + 400 = ¥900.0');
    assert.ok(card.includes('当月订单 ¥500.0'), '当月订单仍为 ¥500.0');
    assert.ok(card.includes('收回旧欠 ¥400.0'), '收回旧欠应为 ¥400.0');

    // 操作员隔离校验：worker1 只能看自己订单的 500，worker2 只能看自己订单的 400
    const w1Card = extractCollectionCard((await worker1.request('/')).text);
    assert.ok(w1Card.includes('>¥500.0<'), '操作员甲仅看到本人负责订单的回款 ¥500.0');
    assert.ok(w1Card.includes('收回旧欠 ¥0.0'), '操作员甲不含他人收回旧欠');

    const w2Card = extractCollectionCard((await worker2.request('/')).text);
    assert.ok(w2Card.includes('>¥400.0<'), '操作员乙仅看到本人负责订单的回款 ¥400.0');
    assert.ok(w2Card.includes('收回旧欠 ¥400.0'), '操作员乙收回旧欠 ¥400.0');
  });

  // 4. 反审核冲销：本月新单反审核后应扣回对应收款
  await check('反审核冲销：本月订单反审核后不应继续虚增本月回款', async () => {
    const createRes = await worker1.request('/sales/new', {
      warehouse_id: String(warehouse1Id),
      customer_id: String(customer1Id),
      responsible_id: String(worker1Id),
      order_date: today,
      paid_amount: '150',
      product_id: String(productId),
      quantity: '2',
      sale_unit: 'base',
      unit_price: '100'
    });
    assert.equal(createRes.status, 302);
    const tempOrderId = db.prepare('SELECT MAX(id) AS id FROM sales_orders').get().id;
    await admin.request(`/sales/approve/${tempOrderId}`, {});

    let card = extractCollectionCard((await admin.request('/')).text);
    assert.ok(card.includes('>¥1050.0<'), '审核后本月回款增至 ¥1050.0');

    const unapproveRes = await admin.request(`/sales/unapprove/${tempOrderId}`, {});
    assert.equal(unapproveRes.status, 302);
    card = extractCollectionCard((await admin.request('/')).text);
    assert.ok(card.includes('>¥900.0<'), '反审核冲销后回落至 ¥900.0');
  });

  // 5. 退货现金退款扣减净回款，且显示“退现”明细
  await check('退货实际现金退款从本月回款额中扣减并显示退现明细', async () => {
    const saleItem = db.prepare('SELECT id FROM sales_order_items WHERE sales_order_id = ? LIMIT 1').get(worker1OrderId);
    const createRet = await admin.request('/returns/new', {
      warehouse_id: String(warehouse1Id),
      customer_id: String(customer1Id),
      related_sales_order_id: String(worker1OrderId),
      order_date: today,
      refunded_amount: '0',
      product_id: String(productId),
      quantity: '6',
      sale_unit: 'base',
      unit_price: '100',
      original_sales_item_id: String(saleItem.id)
    });
    assert.equal(createRet.status, 302);
    const retId = db.prepare('SELECT MAX(id) AS id FROM return_orders').get().id;
    const approveRet = await admin.request(`/returns/approve/${retId}`, { goods_received: '1' });
    assert.equal(approveRet.status, 302);

    const refundRes = await admin.request(`/returns/${retId}/record-refund`, {
      amount: '100',
      refund_reference: '现金退回测试凭证'
    });
    assert.equal(refundRes.status, 302);

    const card = extractCollectionCard((await admin.request('/')).text);
    assert.ok(card.includes('>¥800.0<'), '现金退款 100 后净回款应为 ¥800.0');
    assert.ok(card.includes('退现 ¥100.0'), '卡片副标题应展示退现 ¥100.0');
  });

  console.log(`首页本月回款额测试通过：${passed} 项`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch(err => {
  console.error('测试异常:', err);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(1);
});
