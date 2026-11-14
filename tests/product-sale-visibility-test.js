// 真实路由与临时数据库：商品销售可见性控制（仅销售开单隐藏，库存为0隐藏，操作员商品页只读可见）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-product-vis-'));
process.env.JXC_DATA_DIR = dir;

const { initSchema } = require('../lib/schema');
const { formatDateTime } = require('../utils/dates');
const { issueCsrfToken, csrfProtection } = require('../middleware/csrf');

const db = new Database(path.join(dir, 'test.db'));
initSchema(db);

db.exec(`
  INSERT INTO users(username,password_hash,name,role) VALUES
    ('admin','x','管理员','admin'),
    ('operator','x','操作员','operator');
  INSERT INTO warehouses(name,operator_id) VALUES
    ('总仓',NULL),
    ('操作员车',2);
  INSERT INTO customers(name,operator_id) VALUES
    ('测试客户',2);
  INSERT INTO products(sku,name,spec,unit,cost_price,sale_price,low_stock_threshold,sale_visible) VALUES
    ('SKU-A','常销饮料','500ml','瓶',2.0,5.0,10,1),
    ('SKU-B','一次性赠品物料','1个','个',1.0,3.0,10,1),
    ('SKU-C','历史停售品','500ml','瓶',4.0,8.0,10,0);
  INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES
    (1,1,20),(1,2,20),
    (2,1,0),(2,2,0),
    (3,1,5),(3,2,0);
  INSERT INTO sales_orders(customer_id,warehouse_id,user_id,responsible_id,order_date,total_amount,status) VALUES
    (1,2,2,2,'2026-11-10',8.0,'draft'),
    (1,2,2,2,'2026-11-09',5.0,'approved');
  INSERT INTO sales_order_items(sales_order_id,product_id,quantity,unit_label,base_quantity,unit_price,is_gift,cost_price_snapshot) VALUES
    (1,3,1,'瓶',1,8.0,0,4.0),
    (2,2,1,'个',1,3.0,0,1.0);
`);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));
app.use(session({ secret: 'product-vis-test-secret-at-least-32-chars', resave: false, saveUninitialized: false }));
app.use(issueCsrfToken);
app.use((req, res, next) => {
  const uid = Number(req.get('X-Test-User')) || Number(req.query._u) || 1;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  req.tenantDb = db;
  req.session.user = { id: user.id, username: user.username, name: user.name, role: user.role };
  req.requestId = randomUUID();
  req.tenant = { name: '商品可见性测试', tenant_code: 'test' };
  Object.assign(res.locals, {
    currentUser: user,
    currentTenant: req.tenant,
    currentPath: req.path,
    newRequestKey: randomUUID,
    formatDateTime
  });
  next();
});
app.use(csrfProtection);
for (const route of ['products', 'orderOptions', 'sales', 'purchases', 'returns', 'transfers', 'inventory', 'dashboard']) {
  app.use(require('../routes/' + route));
}
app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).send(error.message);
});

const server = app.listen(process.argv.includes('--serve') ? 3219 : 0, '127.0.0.1', async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  if (process.argv.includes('--serve')) {
    console.log('Browser fixture: ' + base + '/products');
    return;
  }

  let cookie;
  let csrf;
  async function request(route, body = null, user = 1) {
    const response = await fetch(base + route, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        'X-Test-User': String(user),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
      },
      ...(body ? { body: new URLSearchParams({ _csrf: csrf, _request_key: randomUUID(), ...body }) } : {})
    });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const text = await response.text();
    csrf = text.match(/name="csrf-token" content="([^"]+)"/)?.[1] || csrf;
    return { status: response.status, text, location: response.headers.get('location') };
  }

  try {
    // 1. 管理员访问商品列表，获取 CSRF 并验证可见性筛选
    const adminList = await request('/products', null, 1);
    assert.equal(adminList.status, 200);
    assert.match(adminList.text, /常销饮料/);
    assert.match(adminList.text, /历史停售品/);

    const hiddenOnly = await request('/products?visibility=hidden', null, 1);
    assert.equal(hiddenOnly.status, 200);
    assert.match(hiddenOnly.text, /历史停售品/);
    assert.doesNotMatch(hiddenOnly.text, /常销饮料/);

    // 2. 操作员访问商品列表：可以看到已隐藏商品，但看不到成本价且无权操作
    const opList = await request('/products', null, 2);
    assert.equal(opList.status, 200);
    assert.match(opList.text, /历史停售品/);
    assert.match(opList.text, /销售隐藏/);
    assert.doesNotMatch(opList.text, /箱成本价|瓶成本价/);
    assert.equal((await request('/products/2/toggle-visibility', {}, 2)).status, 403);
    assert.equal((await request('/products/batch-visibility', { ids: '2', sale_visible: '0' }, 2)).status, 403);

    // 3. 管理员将 SKU-B（一次性赠品物料，库存 0）设为隐藏
    const toggleRes = await request('/products/2/toggle-visibility', { visibility: 'all' }, 1);
    assert.equal(toggleRes.status, 302);
    assert.equal(db.prepare('SELECT sale_visible FROM products WHERE id=2').get().sale_visible, 0);

    // 4. 销售开单选品接口：搜索和最近使用不再返回隐藏商品 SKU-B / SKU-C
    const searchRes = await request('/order-options/products?q=', null, 2);
    assert.equal(searchRes.status, 200);
    const searchJson = JSON.parse(searchRes.text);
    assert.deepEqual(searchJson.products.map(p => p.id), [1]);

    const recentRes = await request('/order-options/products?recent=1', null, 2);
    assert.equal(recentRes.status, 200);
    const recentJson = JSON.parse(recentRes.text);
    assert.ok(!recentJson.products.some(p => p.id === 2 || p.id === 3));

    // 但 ids=... 回显接口仍能返回（用于旧单据编辑回显）
    const idsRes = await request('/order-options/products?ids=3', null, 2);
    assert.equal(idsRes.status, 200);
    assert.equal(JSON.parse(idsRes.text).products[0].id, 3);

    // 5. 新建销售单包含隐藏商品时被后端拦截
    const blockedNewSale = await request('/sales/new', {
      customer_id: '1',
      warehouse_id: '2',
      order_date: '2026-11-14',
      items_json: JSON.stringify([{ id: 2, quantity: 1, unit_choice: 'base', price: 3 }])
    }, 2);
    assert.equal(blockedNewSale.status, 400);
    assert.match(blockedNewSale.text, /销售隐藏/);

    // 6. 编辑旧草稿单：原本就包含的隐藏商品 SKU-C(id=3) 放行，但新添隐藏商品 SKU-B(id=2) 被拦截
    const editPage = await request('/sales/1/edit', null, 2);
    assert.equal(editPage.status, 200);
    assert.match(editPage.text, /历史停售品/);
    const draftVersion = editPage.text.match(/name="draft_revision"\s+value="(\d+)"/)?.[1] || '1';

    const allowedEdit = await request('/sales/1/edit', {
      customer_id: '1',
      warehouse_id: '2',
      order_date: '2026-11-10',
      draft_revision: draftVersion,
      items_json: JSON.stringify([{ id: 3, quantity: 2, unit_choice: 'base', price: 8 }])
    }, 2);
    assert.equal(allowedEdit.status, 302);

    const nextVersion = String(Number(draftVersion) + 1);
    const blockedEditAdd = await request('/sales/1/edit', {
      customer_id: '1',
      warehouse_id: '2',
      order_date: '2026-11-10',
      draft_revision: nextVersion,
      items_json: JSON.stringify([
        { id: 3, quantity: 2, unit_choice: 'base', price: 8 },
        { id: 2, quantity: 1, unit_choice: 'base', price: 3 }
      ])
    }, 2);
    assert.equal(blockedEditAdd.status, 400);
    assert.match(blockedEditAdd.text, /一次性赠品物料/);

    // 7. 仅销售开单隐藏：采购/退货/调拨表单仍包含隐藏商品
    for (const p of ['/purchases/new', '/returns/new', '/transfers/new']) {
      const res = await request(p, null, 1);
      assert.equal(res.status, 200, `${p} should return 200`);
      assert.match(res.text, /一次性赠品物料/);
    }

    // 8. 库存查询与低库存预警：库存为0的隐藏商品(SKU-B)自动不显示；有剩余库存的隐藏商品(SKU-C在总仓有5)仍显示
    const invRes = await request('/inventory', null, 1);
    assert.equal(invRes.status, 200);
    assert.doesNotMatch(invRes.text, /一次性赠品物料/);
    assert.match(invRes.text, /历史停售品/);

    const dashRes = await request('/', null, 1);
    assert.equal(dashRes.status, 200);
    assert.doesNotMatch(dashRes.text, /一次性赠品物料/);
    assert.match(dashRes.text, /历史停售品/);

    // 9. 批量恢复显示
    const batchRestore = await request('/products/batch-visibility', { ids: '2,3', sale_visible: '1' }, 1);
    assert.equal(batchRestore.status, 302);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM products WHERE sale_visible=1').get().c, 3);

    console.log('product-sale-visibility-test passed');
    server.close();
  } catch (err) {
    console.error(err);
    server.close();
    process.exit(1);
  }
});
