const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-batch2-fixes-'));
process.env.JXC_DATA_DIR = dir;
process.env.SESSION_SECRET = randomUUID() + randomUUID();
process.env.PLATFORM_ADMIN_INITIAL_PASSWORD = 'InitialAdmin_2026';
process.env.NODE_ENV = 'test';

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request) {
  return request === 'dotenv' ? { config: () => ({}) } : originalLoad.apply(this, arguments);
};

let base, passed = 0;
const { createTenant } = require('../lib/platformDb');
const { openTenantDbByPath } = require('../lib/tenantManager');
const { bootstrapTenant } = require('../lib/schema');

const tenant = createTenant('batch2', '第二批整改测试租户');
const db = openTenantDbByPath(tenant.db_path);
bootstrapTenant(db, { adminUsername: 'owner', adminPassword: 'OwnerPass_2026', adminName: '超级管理员', warehouseName: '总仓' });

db.prepare('INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?,?)').run('admin', bcrypt.hashSync('AdminPass_2026', 10), '分店管理员', 'admin');
db.prepare('INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?,?)').run('worker', bcrypt.hashSync('WorkerPass_2026', 10), '销售员甲', 'operator');
db.prepare('INSERT INTO users(username, password_hash, name, role) VALUES (?,?,?,?)').run('worker2', bcrypt.hashSync('WorkerPass_2026', 10), '销售员乙', 'operator');

// 初始化测试商品、客户、仓库
db.prepare("INSERT INTO products (sku, name, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack, low_stock_threshold) VALUES ('P001', '测试红酒', '瓶', '箱', 6, 50, 100, 300, 550, 10)").run();
db.prepare("INSERT INTO customers (name, contact, phone, operator_id) VALUES ('客户甲', '张三', '13800000001', 3)").run();
db.prepare("INSERT INTO customers (name, contact, phone, operator_id) VALUES ('客户乙', '李四', '13800000002', 3)").run();
db.prepare("INSERT INTO warehouses (name, address, operator_id) VALUES ('车销车辆A', '粤A00001', 3)").run();
db.prepare("INSERT INTO warehouses (name, address, operator_id) VALUES ('车销车辆B', '粤A00002', 4)").run();

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
      data: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null,
      headers: response.headers
    };
  }
  login(username, password) { return this.request('/login', { tenant_code: 'batch2', username, password }); }
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

  const admin = new Client(), worker = new Client(), worker2 = new Client();
  await admin.login('admin', 'AdminPass_2026');
  await worker.login('worker', 'WorkerPass_2026');
  await worker2.login('worker2', 'WorkerPass_2026');

  // 1. 商品档案列表查询窄化（防御纵深）与小数精度规则（瓶单价2位、箱价1位）
  await check('商品档案列表页：操作员查询绝不包含成本价字段，管理员展示瓶单价2位、箱价1位', async () => {
    const workerRes = await worker.request('/products');
    assert.equal(workerRes.status, 200);
    assert.ok(!workerRes.text.includes('¥50.00'), '操作员页面绝不应出现瓶成本 ¥50.00');
    assert.ok(!workerRes.text.includes('¥300.0'), '操作员页面绝不应出现箱成本 ¥300.0');
    assert.ok(!workerRes.text.includes('成本'), '操作员页面表头不应出现成本列');
    assert.ok(workerRes.text.includes('¥100.00'), '操作员页面瓶售价保持 2 位小数 ¥100.00');
    assert.ok(workerRes.text.includes('¥550.0'), '操作员页面箱售价为 1 位小数 ¥550.0');

    const adminRes = await admin.request('/products');
    assert.equal(adminRes.status, 200);
    assert.ok(adminRes.text.includes('¥50.00'), '管理员应能看到 2 位小数的瓶成本价 ¥50.00');
    assert.ok(adminRes.text.includes('¥300.0'), '管理员应能看到 1 位小数的箱成本价 ¥300.0');
  });

  // 2. 基础数据变更审计日志
  await check('基础数据变更审计日志：商品新建、改价编辑与删除记录留痕', async () => {
    const beforeCount = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE entity_type='商品'").get().c;
    // 新建商品
    await admin.request('/products/new', {
      sku: 'P002', name: '测试白酒', unit: '瓶', pack_unit: '箱', pack_size: '6',
      cost_price: '80', sale_price: '150', cost_price_pack: '480', sale_price_pack: '880', low_stock_threshold: '5'
    });
    const p2 = db.prepare("SELECT id FROM products WHERE sku='P002'").get();
    assert.ok(p2);
    let log = db.prepare("SELECT * FROM audit_logs WHERE entity_type='商品' AND entity_id=? ORDER BY id DESC LIMIT 1").get(p2.id);
    assert.equal(log.action, '新增商品');
    assert.ok(log.summary.includes('测试白酒'));

    // 编辑商品改价
    await admin.request('/products/' + p2.id + '/edit', {
      sku: 'P002', name: '测试白酒', unit: '瓶', pack_unit: '箱', pack_size: '6',
      cost_price: '90', sale_price: '180', cost_price_pack: '540', sale_price_pack: '990', low_stock_threshold: '5'
    });
    log = db.prepare("SELECT * FROM audit_logs WHERE entity_type='商品' AND entity_id=? ORDER BY id DESC LIMIT 1").get(p2.id);
    assert.equal(log.action, '修改商品');
    assert.ok(log.summary.includes('售价: ¥150.00 → ¥180.00'));
    assert.ok(log.summary.includes('成本价: ¥80.00 → ¥90.00'));

    // 删除商品
    await admin.request('/products/' + p2.id + '/delete', {});
    log = db.prepare("SELECT * FROM audit_logs WHERE entity_type='商品' AND entity_id=? ORDER BY id DESC LIMIT 1").get(p2.id);
    assert.equal(log.action, '删除商品');
    assert.ok(log.summary.includes('测试白酒'));
  });

  await check('基础数据变更审计日志：客户批量转移与信息修改留痕', async () => {
    // 批量转移客户
    await admin.request('/customers/reassign', { from_user_id: '3', to_user_id: '4' });
    const log = db.prepare("SELECT * FROM audit_logs WHERE action='批量转移客户' ORDER BY id DESC LIMIT 1").get();
    assert.ok(log);
    assert.ok(log.summary.includes('销售员甲'));
    assert.ok(log.summary.includes('销售员乙'));
    const details = JSON.parse(log.details_json);
    assert.equal(details.count, 2);

    // 转移后客户归属已变更给销售员乙 (id 4)
    const c1 = db.prepare("SELECT operator_id FROM customers WHERE name='客户甲'").get();
    assert.equal(c1.operator_id, 4);
  });

  await check('基础数据变更审计日志：仓库/车辆责任操作员变更留痕', async () => {
    const w = db.prepare("SELECT id FROM warehouses WHERE name='车销车辆A'").get();
    await admin.request('/warehouses/' + w.id + '/operator', { operator_id: '4' });
    const log = db.prepare("SELECT * FROM audit_logs WHERE action='变更仓库归属' AND entity_id=? ORDER BY id DESC LIMIT 1").get(w.id);
    assert.ok(log);
    assert.ok(log.summary.includes('销售员甲 → 销售员乙'));
    const updated = db.prepare("SELECT operator_id FROM warehouses WHERE id=?").get(w.id);
    assert.equal(updated.operator_id, 4);

    // 重新把车辆仓交回给销售员甲 (id 3)，用于后续单据测试
    await admin.request('/warehouses/' + w.id + '/operator', { operator_id: '3' });
  });

  // 3. 退货单与调拨单草稿删除支持
  await check('退货单草稿删除：仅草稿可删，跨用户越权被拦截，删除后明细与单据清除且记录审计', async () => {
    // admin 创建退货单草稿（无原单例外退货存草稿）
    const createRes = await admin.request('/returns/new', {
      warehouse_id: '1', order_date: '2026-10-16', note: '测试草稿', exception_reason: '核实无原单允许例外退货', save_draft: '1',
      items_json: JSON.stringify([{ id: 1, quantity: 2, price: 100, unit_choice: 'base' }])
    });
    const retOrder = db.prepare("SELECT id, status FROM return_orders WHERE note='测试草稿'").get();
    assert.ok(retOrder);
    assert.equal(retOrder.status, 'draft');

    // worker2 (id 4) 试图删除 admin 的草稿，应被拒绝 403
    const forbiddenRes = await worker2.request('/returns/' + retOrder.id + '/delete', {});
    assert.equal(forbiddenRes.status, 403);
    assert.ok(db.prepare("SELECT id FROM return_orders WHERE id=?").get(retOrder.id));

    // admin 删除自己的草稿，应成功重定向到 /returns
    const deleteRes = await admin.request('/returns/' + retOrder.id + '/delete', {});
    assert.equal(deleteRes.status, 302);
    assert.equal(deleteRes.location, '/returns');
    assert.equal(db.prepare("SELECT id FROM return_orders WHERE id=?").get(retOrder.id), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM return_order_items WHERE return_order_id=?").get(retOrder.id).c, 0);

    const log = db.prepare("SELECT * FROM audit_logs WHERE entity_type='退货单' AND entity_id=? AND action='删除退货单'").get(retOrder.id);
    assert.ok(log);
    assert.ok(log.summary.includes('删除草稿'));
  });

  await check('调拨单草稿删除：仅草稿可删，跨用户越权被拦截，删除后单据清除且记录审计', async () => {
    // admin 创建调拨单草稿
    const createRes = await admin.request('/transfers/new', {
      from_warehouse_id: '2', to_warehouse_id: '1', order_date: '2026-10-16', note: '调拨草稿', save_draft: '1',
      product_id: '1', quantity: '5', unit_choice: 'base'
    });
    const trOrder = db.prepare("SELECT id, status FROM transfer_orders WHERE note='调拨草稿'").get();
    assert.ok(trOrder);
    assert.equal(trOrder.status, 'draft');

    // worker2 (id 4) 没有调拨单权限，删除应被拒绝 403
    const forbiddenRes = await worker2.request('/transfers/' + trOrder.id + '/delete', {});
    assert.equal(forbiddenRes.status, 403);

    // 提交后不能删除草稿 (400)
    await admin.request('/transfers/submit/' + trOrder.id, {});
    const failRes = await admin.request('/transfers/' + trOrder.id + '/delete', {});
    assert.equal(failRes.status, 400);

    // 撤回为草稿后可以删除
    await admin.request('/transfers/withdraw/' + trOrder.id, {});
    const delRes = await admin.request('/transfers/' + trOrder.id + '/delete', {});
    assert.equal(delRes.status, 302);
    assert.equal(delRes.location, '/transfers');
    assert.equal(db.prepare("SELECT id FROM transfer_orders WHERE id=?").get(trOrder.id), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM transfer_order_items WHERE transfer_order_id=?").get(trOrder.id).c, 0);

    const log = db.prepare("SELECT * FROM audit_logs WHERE entity_type='调拨单' AND entity_id=? AND action='删除调拨单'").get(trOrder.id);
    assert.ok(log);
    assert.ok(log.summary.includes('删除草稿调拨单'));
  });

  // 4. 销售开单与详情页收款快捷交互
  await check('销售开单与详情页快捷收款：包含全额收齐与清零快捷按钮及交互支持', async () => {
    const formRes = await worker.request('/sales/new');
    assert.equal(formRes.status, 200);
    assert.ok(formRes.text.includes('id="fillFullPaidBtn"'), '开单页应包含全额收齐按钮');
    assert.ok(formRes.text.includes('id="clearPaidBtn"'), '开单页应包含清零按钮');
    assert.ok(formRes.text.includes('id="paidAmountInput"'), '开单页应绑定 paidAmountInput 输入框');

    // 创建一张已审核且有欠款的销售单
    db.prepare("INSERT INTO sales_orders (warehouse_id, user_id, responsible_id, customer_id, order_date, total_amount, paid_amount, status) VALUES (1, 1, 3, 1, '2026-10-16', 500, 200, 'approved')").run();
    const saleId = db.prepare("SELECT MAX(id) AS id FROM sales_orders").get().id;
    const detailRes = await admin.request('/sales/' + saleId);
    assert.equal(detailRes.status, 200);
    assert.ok(detailRes.text.includes('全额收齐'), '欠款单详情页应包含全额收齐快捷按钮');
    assert.ok(detailRes.text.includes('id="recordPaymentInput"'), '欠款单详情页应有收款输入框');
  });

  // 5. 首页自定义看板、本月净增欠款口径与操作员毛利绝对隔离
  await check('首页自定义看板：默认6卡、本月净增欠款拆解、双视角配置与操作员毛利硬拦截', async () => {
    const adminHome = await admin.request('/');
    assert.equal(adminHome.status, 200);
    assert.ok(adminHome.text.includes('本月销售额（已审核）'), '管理员默认展示本月销售额');
    assert.ok(adminHome.text.includes('本年度销售额（已审核）'), '管理员默认展示本年度销售额');
    assert.ok(adminHome.text.includes('本月净增欠款'), '管理员默认展示本月净增欠款');
    assert.ok(adminHome.text.includes('本月新欠'), '本月净增欠款包含新欠副标题');
    assert.ok(adminHome.text.includes('清收旧欠'), '本月净增欠款包含清收旧欠副标题');
    assert.ok(adminHome.text.includes('累计总欠款'), '管理员默认展示累计总欠款');
    assert.ok(adminHome.text.includes('本月毛利（已结清）'), '管理员默认展示本月毛利');
    assert.ok(adminHome.text.includes('待审核单据'), '管理员默认展示待审核单据');
    assert.ok(!adminHome.text.includes('今日销售额（已审核）'), '默认不启用今日销售额');

    // 操作员访问首页：绝不能出现任何毛利字样，且访问 /settings/dashboard 必须 403
    const workerHome = await worker.request('/');
    assert.equal(workerHome.status, 200);
    assert.ok(!workerHome.text.includes('毛利'), '操作员首页绝不能包含任何毛利数据');
    const workerSettings = await worker.request('/settings/dashboard');
    assert.equal(workerSettings.status, 403, '操作员访问看板配置页必须被拒绝');

    // 管理员尝试恶意为 operator 视角注入 monthly_profit 和 today_profit，后端必须硬过滤拦截
    const saveRes = await admin.request('/settings/dashboard', {
      admin_order: ['total_debt', 'monthly_sales', 'yearly_sales', 'monthly_net_debt', 'monthly_profit', 'pending_orders', 'today_sales', 'today_profit'],
      admin_enabled: ['total_debt', 'today_sales'],
      admin_color_total_debt: 'purple',
      admin_color_today_sales: 'pink',
      operator_order: ['monthly_profit', 'today_profit', 'monthly_sales', 'yearly_sales', 'monthly_net_debt', 'total_debt', 'pending_orders', 'today_sales'],
      operator_enabled: ['monthly_profit', 'today_profit', 'monthly_sales']
    });
    assert.equal(saveRes.status, 302);

    const adminHomeAfter = await admin.request('/');
    assert.ok(adminHomeAfter.text.includes('stat-theme-purple'), '管理员自定义紫粉卡片色生效');
    assert.ok(adminHomeAfter.text.includes('今日销售额（已审核）'), '管理员开启今日销售额生效');
    assert.ok(!adminHomeAfter.text.includes('本年度销售额（已审核）'), '管理员关闭本年度销售额生效');

    const workerHomeAfter = await worker.request('/');
    assert.ok(!workerHomeAfter.text.includes('毛利'), '即使伪造请求，操作员首页依然绝不出现毛利');
    assert.ok(workerHomeAfter.text.includes('本月销售额（已审核）'), '操作员视角配置生效');
  });

  console.log(`第二批整改测试通过：${passed} 项`);
  process.exit(0);
})().catch(err => {
  console.error('测试异常:', err);
  process.exit(1);
});
