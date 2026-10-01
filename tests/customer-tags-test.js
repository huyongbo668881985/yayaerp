const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runCustomerTagTests(ok) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-customer-tags-'));
  const { openTenantDbByPath } = require('../lib/tenantManager');
  const { initSchema } = require('../lib/schema');
  let db = openTenantDbByPath(path.join(dir, 'tenant.db'));
  let server;
  const check = async (label, fn) => {
    try { await fn(); ok(true, label); }
    catch (err) { ok(false, `${label}: ${err.message}`); }
  };
  try {
    db.prepare(`INSERT INTO users (username, password_hash, name, role) VALUES
      ('admin', 'unused', '管理员', 'admin'), ('op1', 'unused', '操作员一', 'operator'), ('op2', 'unused', '操作员二', 'operator')`).run();
    db.prepare("INSERT INTO warehouses (name) VALUES ('测试仓库')").run();
    db.prepare("INSERT INTO products (name, unit) VALUES ('测试商品', '瓶')").run();
    db.prepare("INSERT INTO customers (name, operator_id) VALUES ('自有客户', 2), ('他人客户', 3), ('未挂标签客户', NULL)").run();
    for (const [customerId, userId] of [[1, 1], [1, 2], [2, 3], [null, 1], [3, 1]]) {
      const id = Number(db.prepare(`INSERT INTO sales_orders (customer_id, warehouse_id, user_id, order_date, total_amount, status)
        VALUES (?, 1, ?, '2026-10-01', 100, 'approved')`).run(customerId, userId).lastInsertRowid);
      for (let i = 0; i < 2; i++) db.prepare(`INSERT INTO sales_order_items
        (sales_order_id, product_id, quantity, base_quantity, unit_label, unit_price) VALUES (?, 1, 1, 1, '瓶', 50)`).run(id);
    }
    await check('旧租户再次打开会自动建立标签表、索引，重复初始化保留数据', () => {
      db.exec('DROP TABLE customer_tag_links; DROP TABLE customer_tags; DELETE FROM schema_migrations WHERE version = 9');
      db.close();
      db = openTenantDbByPath(path.join(dir, 'tenant.db'));
      initSchema(db);
      assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customers').get().count, 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales_orders').get().count, 5);
      assert.deepEqual(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name')
        .all('index', 'idx_customer_tag_links_%').map(row => row.name), ['idx_customer_tag_links_customer_id', 'idx_customer_tag_links_tag_id']);
    });
    const express = require('express');
    const { formatDateTime } = require('../utils/dates');
    const app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '..', 'views'));
    app.use(express.urlencoded({ extended: true }));
    app.use((req, res, next) => {
      req.tenantDb = db;
      req.session = { user: { id: Number(req.headers['x-test-user']) || 1 } };
      Object.assign(res.locals, { csrfToken: 'test', currentTenant: null, currentPath: req.path, formatDateTime });
      if (req.headers['x-test-json']) res.render = (view, locals) => res.json({ view, ...locals });
      next();
    });
    app.use(require('../routes/partners'), require('../routes/sales'));
    app.use((err, req, res, next) => res.status(500).send(err.message));
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, { body, user = 1, json = false } = {}) => {
      const response = await fetch(base + url, {
        method: body ? 'POST' : 'GET', redirect: 'manual',
        headers: { 'x-test-user': String(user), ...(json ? { 'x-test-json': '1' } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: body ? new URLSearchParams(body) : undefined
      });
      const text = await response.text();
      const location = response.headers.get('location');
      return { status: response.status, location, error: location ? new URL(location, base).searchParams.get('tag_error') : null, text, data: json ? JSON.parse(text) : null };
    };
    const form = (name, tagIds = []) => [['name', name], ...tagIds.map(id => ['tag_ids', String(id)])];
    const tags = () => db.prepare('SELECT * FROM customer_tags ORDER BY id').all();
    const links = id => db.prepare('SELECT tag_id FROM customer_tag_links WHERE customer_id = ? ORDER BY tag_id').all(id).map(link => link.tag_id);
    const auditCount = () => db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    const originalOrders = (await request('/sales', { json: true })).data.orders;
    const originalExport = (await request('/sales/export')).text;
    let flowId, priorityId;
    await check('管理员创建标签：去首尾空白、预设颜色并记录审计', async () => {
      const result = await request('/customer-tags/new', { body: { name: '  流通  ', color: 'blue' } });
      assert.equal(result.status, 302);
      flowId = tags()[0].id;
      assert.equal(tags()[0].name, '流通');
      assert.equal(tags()[0].color, 'blue');
      assert.equal(auditCount(), 1);
      assert.equal(db.prepare('SELECT action FROM audit_logs').get().action, '新增客户标签');
      initSchema(db);
      assert.equal(tags().length, 1);
      await request('/customer-tags/new', { body: { name: '重要', color: 'red' } });
      priorityId = tags()[1].id;
    });
    await request('/customer-tags/new', { body: { name: 'VIP', color: 'purple' } });
    for (const [name, color, message] of [
      ['流通', 'blue', '标签名称已存在'], ['vip', 'green', '标签名称已存在'],
      ['', 'blue', '标签名称不能为空'], ['  ', 'blue', '标签名称不能为空'],
      ['流通,餐饮', 'blue', '标签名称不能包含'], ['流通，餐饮', 'blue', '标签名称不能包含'], ['流通、餐饮', 'blue', '标签名称不能包含'],
      ['标'.repeat(21), 'blue', '标签名称不能超过 20 字'], ['批发', '#123456', '请选择预设的标签颜色']
    ]) {
      await check(`标签校验拒绝 ${JSON.stringify(name)} / ${color}，不写标签或审计`, async () => {
        const before = tags(); const beforeLogs = auditCount();
        const result = await request('/customer-tags/new', { body: { name, color } });
        assert.equal(result.status, 302);
        assert.ok(result.error.includes(message));
        assert.equal(new URL(result.location, base).searchParams.get('tag_name'), name);
        assert.deepEqual(tags(), before); assert.equal(auditCount(), beforeLogs);
      });
    }
    await check('数据库也约束标签名称大小写唯一', () => {
      assert.throws(() => db.prepare('INSERT INTO customer_tags (name, color) VALUES (?, ?)').run('vIp', 'blue'), /UNIQUE/);
    });
    await check('操作员不能新增、修改或删除标签，管理区不可见', async () => {
      const before = tags(); const beforeLogs = auditCount();
      for (const url of ['/customer-tags/new', `/customer-tags/${flowId}/edit`, `/customer-tags/${flowId}/delete`]) {
        assert.equal((await request(url, { user: 2, body: { name: '越权', color: 'green' } })).status, 403);
      }
      assert.deepEqual(tags(), before); assert.equal(auditCount(), beforeLogs);
      assert.ok(!(await request('/customers', { user: 2 })).text.includes('id="customerTagManagement"'));
    });
    await check('操作员挂已有标签，忽略无效/不存在/重复值，不改变归属', async () => {
      assert.equal((await request('/customers/1/edit', { user: 2, body: form('自有客户', [flowId, priorityId, flowId, 'abc', 999999, '1.5', '1e0']) })).status, 302);
      assert.deepEqual(links(1), [flowId, priorityId]);
      assert.equal(db.prepare('SELECT operator_id FROM customers WHERE id = 1').get().operator_id, 2);
      assert.equal((await request('/customers/2/edit', { user: 2, body: form('越权客户', [flowId]) })).status, 403);
      assert.equal((await request('/customers/2/edit', { user: 2 })).status, 403);
      assert.equal(db.prepare('SELECT name FROM customers WHERE id = 2').get().name, '他人客户');
      assert.deepEqual(links(2), []);
    });
    await check('新增客户支持多选，编辑整体替换，空选择清空', async () => {
      await request('/customers/new', { user: 2, body: form('新增标签客户', [flowId, priorityId]) });
      const id = db.prepare('SELECT id FROM customers WHERE name = ?').get('新增标签客户').id;
      assert.deepEqual(links(id), [flowId, priorityId]);
      await request(`/customers/${id}/edit`, { user: 2, body: form('新增标签客户', [priorityId]) });
      assert.deepEqual(links(id), [priorityId]);
      const edit = await request(`/customers/${id}/edit`, { user: 2, json: true });
      assert.deepEqual(edit.data.selectedTagIds, [priorityId]);
      await request(`/customers/${id}/edit`, { user: 2, body: form('新增标签客户') });
      assert.deepEqual(links(id), []);
    });
    await check('客户更新和标签替换出错时一起回滚', async () => {
      db.exec("CREATE TRIGGER reject_tag_link BEFORE INSERT ON customer_tag_links BEGIN SELECT RAISE(ABORT, '测试关联失败'); END");
      try {
        assert.equal((await request('/customers/1/edit', { user: 2, body: form('回滚测试', [priorityId]) })).status, 500);
        assert.equal(db.prepare('SELECT name FROM customers WHERE id = 1').get().name, '自有客户');
        assert.deepEqual(links(1), [flowId, priorityId]);
      } finally { db.exec('DROP TRIGGER reject_tag_link'); }
    });
    await request('/customers/2/edit', { body: [...form('他人客户', [flowId]), ['operator_id', '3']] });
    await check('标签管理的审计失败时新增、改名和删除关联均回滚', async () => {
      db.exec("CREATE TRIGGER reject_tag_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type = '客户标签' BEGIN SELECT RAISE(ABORT, '测试审计失败'); END");
      try {
        const beforeTags = tags(); const beforeLinks = links(1); const beforeLogs = auditCount();
        for (const [url, body] of [
          ['/customer-tags/new', { name: '回滚标签', color: 'blue' }],
          [`/customer-tags/${flowId}/edit`, { name: '回滚名称', color: 'green' }],
          [`/customer-tags/${flowId}/delete`, { _: '1' }]
        ]) {
          assert.equal((await request(url, { body })).status, 500);
          assert.deepEqual(tags(), beforeTags); assert.deepEqual(links(1), beforeLinks); assert.equal(auditCount(), beforeLogs);
        }
      } finally { db.exec('DROP TRIGGER reject_tag_audit'); }
    });
    await check('客户列表标签与关键字叠加，保留操作员范围并批量映射标签', async () => {
      const result = (await request(`/customers?tag=${flowId}&q=客户`, { json: true })).data;
      assert.deepEqual(result.customers.map(c => c.id), [2, 1]);
      assert.deepEqual(result.customers.find(c => c.id === 1).tags.map(t => t.id), [flowId, priorityId]);
      assert.deepEqual((await request(`/customers?tag=${flowId}`, { user: 2, json: true })).data.customers.map(c => c.id), [1]);
      assert.equal((await request(`/customers?tag=${flowId}&q=他人`, { user: 2, json: true })).data.customers.length, 0);
    });
    await check('标签筛选订单不重复、散客被排除且操作员只看自己的订单', async () => {
      const orders = (await request(`/sales?tag_id=${flowId}`, { json: true })).data.orders;
      assert.deepEqual(orders.map(order => order.id), [1, 2, 3]);
      assert.equal(new Set(orders.map(order => order.id)).size, 3);
      assert.deepEqual((await request(`/sales?tag_id=${priorityId}`, { json: true })).data.orders.map(order => order.id), [1, 2]);
      assert.deepEqual((await request(`/sales?tag_id=${flowId}`, { user: 2, json: true })).data.orders.map(order => order.id), [2]);
      assert.equal((await request(`/sales?tag_id=${flowId}&guest=1`, { json: true })).data.orders.length, 0);
      assert.equal((await request('/sales?tag_id=999999', { json: true })).data.orders.length, 0);
      assert.deepEqual((await request('/sales', { json: true })).data.orders, originalOrders);
    });
    await check('CSV 标签列紧跟客户，多标签用顿号连接，不放大明细、散客及未挂标签列为空', async () => {
      const csv = (await request(`/sales/export?tag_id=${flowId}`)).text.split('\r\n');
      assert.ok(csv[0].includes('客户,客户标签,仓库'));
      assert.equal(csv.length, 7);
      assert.equal(csv.filter(row => row.includes('自有客户,流通、重要')).length, 4);
      assert.equal((await request(`/sales/export?tag_id=${flowId}`, { user: 2 })).text.split('\r\n').length, 3);
      const all = (await request('/sales/export')).text;
      assert.ok(all.includes('散客,,测试仓库'));
      assert.ok(all.includes('未挂标签客户,,测试仓库'));
      assert.deepEqual(all.split('\r\n').map(row => { const cells = row.split(','); cells.splice(3, 1); return cells.join(','); }),
        originalExport.split('\r\n').map(row => { const cells = row.split(','); cells.splice(3, 1); return cells.join(','); }));
    });
    await check('分页、排序、未审核切换及导出链接保留标签和其它条件', async () => {
      db.transaction(() => {
        for (let i = 0; i < 51; i++) db.prepare(`INSERT INTO sales_orders
          (customer_id, warehouse_id, user_id, order_date, total_amount, status) VALUES (1, 1, 1, '2026-10-01', 100, 'approved')`).run();
      })();
      try {
        const result = await request(`/sales?tag_id=${flowId}&start=2026-10-01&customer_id=1&unpaid=1&sort=amount&order=asc`);
        assert.equal(result.status, 200);
        const hrefs = [...result.text.matchAll(/href="(\/sales(?:\?|\/export\?)[^"]*)"[^>]*>([^<]*)/g)]
          .filter(match => match[2] !== '清除标签筛选').map(match => match[1].replace(/&amp;/g, '&'));
        assert.ok(hrefs.some(href => href.includes('page=2')));
        for (const href of hrefs.filter(href => !href.includes('清除') && !href.includes('/sales/new'))) {
          const url = new URL(href, base);
          assert.equal(url.searchParams.get('tag_id'), String(flowId));
          assert.equal(url.searchParams.get('start'), '2026-10-01');
          assert.equal(url.searchParams.get('customer_id'), '1');
          assert.equal(url.searchParams.get('unpaid'), '1');
        }
        assert.ok(hrefs.some(href => href.startsWith('/sales/export?') && new URL(href, base).searchParams.get('tag_id') === String(flowId)));
        assert.ok(hrefs.some(href => new URL(href, base).searchParams.get('page') === '2' && new URL(href, base).searchParams.get('tag_id') === String(flowId)));
      } finally { db.prepare('DELETE FROM sales_orders WHERE id > 5').run(); }
    });
    await check('标签改名/颜色校验、成功日志以及标签导出公式注入防护', async () => {
      assert.ok((await request(`/customer-tags/${priorityId}/edit`, { body: { name: '流通', color: 'red' } })).error.includes('标签名称已存在'));
      assert.ok((await request(`/customer-tags/${priorityId}/edit`, { body: { name: '重要', color: 'invalid' } })).error.includes('请选择预设'));
      for (const name of ['=1+1', '+SUM(A1)', '-SUM(A1)', '@SUM(A1)']) {
        await request(`/customer-tags/${flowId}/edit`, { body: { name, color: 'cyan' } });
        assert.ok((await request(`/sales/export?tag_id=${flowId}`)).text.includes(`'${name}、重要`));
      }
      assert.equal(db.prepare('SELECT color FROM customer_tags WHERE id = ?').get(flowId).color, 'cyan');
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = '修改客户标签'").get().count, 4);
    });
    await check('标签最多 50 个，超限不落库；仍允许修改已有标签', async () => {
      while (tags().length < 50) await request('/customer-tags/new', { body: { name: `标签${tags().length}`, color: 'gray' } });
      const beforeLogs = auditCount();
      const result = await request('/customer-tags/new', { body: { name: '超限', color: 'blue' } });
      assert.ok(result.error.includes('最多可创建 50 个'));
      assert.equal(tags().length, 50); assert.equal(auditCount(), beforeLogs);
      await request(`/customer-tags/${priorityId}/edit`, { body: { name: '重要客户', color: 'pink' } });
      assert.equal(db.prepare('SELECT name FROM customer_tags WHERE id = ?').get(priorityId).name, '重要客户');
    });
    await check('删除标签先解除关联，外键开启/关闭时客户和订单均保留，并写日志', async () => {
      for (const [id, foreignKeys] of [[flowId, 1], [priorityId, 0]]) {
        db.pragma(`foreign_keys = ${foreignKeys}`);
        const customers = db.prepare('SELECT * FROM customers ORDER BY id').all();
        const orders = db.prepare('SELECT * FROM sales_orders ORDER BY id').all();
        await request(`/customer-tags/${id}/delete`, { body: { _: '1' } });
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_tag_links WHERE tag_id = ?').get(id).count, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM customer_tags WHERE id = ?').get(id).count, 0);
        assert.deepEqual(db.prepare('SELECT * FROM customers ORDER BY id').all(), customers);
        assert.deepEqual(db.prepare('SELECT * FROM sales_orders ORDER BY id').all(), orders);
        assert.equal(db.prepare('SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1').get().action, '删除客户标签');
      }
      db.pragma('foreign_keys = ON');
    });
    await check('删除无历史订单的客户会清理标签关联', async () => {
      const id = db.prepare('SELECT id FROM customers WHERE name = ?').get('新增标签客户').id;
      await request(`/customers/${id}/edit`, { user: 2, body: form('新增标签客户', [tags()[0].id]) });
      assert.equal(links(id).length, 1);
      assert.equal((await request(`/customers/${id}/delete`, { body: { _: '1' } })).status, 302);
      assert.deepEqual(links(id), []);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runCustomerTagTests };
if (require.main === module) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-tags-platform-'));
  process.env.JXC_DATA_DIR = dir;
  let failures = 0;
  runCustomerTagTests((passed, label) => {
    if (!passed) failures++;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
  }).catch(err => { console.error(err); failures++; }).finally(() => {
    require('../lib/platformDb').platformDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = failures ? 1 : 0;
  });
}
