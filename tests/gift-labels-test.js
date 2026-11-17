const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function runGiftLabelTests(ok) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-gift-labels-'));
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
      ('admin', 'unused', '管理员', 'admin'),
      ('op1', 'unused', '操作员一', 'operator'),
      ('op2', 'unused', '操作员二', 'operator')`).run();
    db.prepare("INSERT INTO warehouses (name, operator_id) VALUES ('总仓', NULL), ('一车', 2), ('二车', 3)").run();
    db.prepare(`INSERT INTO products (sku, name, spec, unit, pack_unit, pack_size, cost_price, sale_price, sale_visible) VALUES
      ('P1', '主推大酒', '500ml', '瓶', '箱', 6, 30, 50, 1),
      ('P2', '活动小酒', '100ml', '瓶', '盒', 10, 5, 12, 1)`).run();
    db.prepare("INSERT INTO customers (name, operator_id) VALUES ('兴旺烟酒', 2), ('大众餐饮', 3)").run();
    for (const wid of [1, 2, 3]) {
      db.prepare('INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (1, ?, 100), (2, ?, 200)').run(wid, wid);
    }

    // 模拟历史存在“已入账退货锁定原销售明细”的租户库，验证 v20 迁移不会触发 finalized_sale_items_no_update 报错
    await check('v20 迁移兼容含已入账退货与历史赠品的旧库，且重复初始化安全', () => {
      const legacySaleId = Number(db.prepare(`INSERT INTO sales_orders
        (customer_id, warehouse_id, user_id, responsible_id, order_date, total_amount, paid_amount, status)
        VALUES (1, 2, 2, 2, '2026-10-01', 50, 50, 'approved')`).run().lastInsertRowid);
      const itemId = Number(db.prepare(`INSERT INTO sales_order_items
        (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, is_gift, cost_price_snapshot)
        VALUES (?, 1, 1, '瓶', 1, 50, 0, 30)`).run(legacySaleId).lastInsertRowid);
      db.prepare(`INSERT INTO sales_order_items
        (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, is_gift, cost_price_snapshot)
        VALUES (?, 2, 2, '瓶', 2, 0, 1, 5)`).run(legacySaleId);
      const retId = Number(db.prepare(`INSERT INTO return_orders
        (customer_id, warehouse_id, user_id, related_sales_order_id, order_date, total_amount, status)
        VALUES (1, 2, 2, ?, '2026-10-02', 50, 'approved')`).run(legacySaleId).lastInsertRowid);
      db.prepare(`INSERT INTO return_order_items
        (return_order_id, product_id, quantity, unit_label, base_quantity, unit_price, cost_price_snapshot, original_sales_item_id)
        VALUES (?, 1, 1, '瓶', 1, 50, 30, ?)`).run(retId, itemId);
      db.prepare("UPDATE return_orders SET finalized_at = datetime('now') WHERE id = ?").run(retId);

      db.exec('DROP TABLE gift_labels; DELETE FROM schema_migrations WHERE version = 20');
      db.close();
      db = openTenantDbByPath(path.join(dir, 'tenant.db'));
      initSchema(db);
      const legacyGift = db.prepare('SELECT is_gift, gift_label FROM sales_order_items WHERE sales_order_id = ? AND is_gift = 1').get(legacySaleId);
      assert.equal(legacyGift.is_gift, 1);
      assert.equal(legacyGift.gift_label, '');
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
      Object.assign(res.locals, { csrfToken: 'test', currentTenant: { name: '测试商贸' }, currentPath: req.path, formatDateTime, newRequestKey: () => 'req-' + Math.random() });
      if (req.headers['x-test-json']) res.render = (view, locals) => res.json({ view, ...locals });
      next();
    });
    app.use(require('../routes/sales'), require('../routes/printing'));
    app.use((err, req, res, next) => res.status(500).send(err.message));
    server = await new Promise(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (url, { body, user = 1, json = false } = {}) => {
      const response = await fetch(base + url, {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        headers: {
          'x-test-user': String(user),
          ...(json ? { 'x-test-json': '1' } : {}),
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body: body ? new URLSearchParams(body) : undefined
      });
      const text = await response.text();
      const location = response.headers.get('location');
      return {
        status: response.status,
        location,
        error: location ? new URL(location, base).searchParams.get('gift_label_error') : null,
        success: location ? new URL(location, base).searchParams.get('gift_label_success') : null,
        text,
        data: json ? JSON.parse(text) : null
      };
    };

    await check('未配置自定义标签时，开单页保持默认赠品配置', async () => {
      const html = (await request('/sales/new')).text;
      assert.ok(html.includes('const GIFT_LABELS = ["赠品"]'));
      assert.ok(html.includes('class="gift-checkbox"'));
    });

    await check('操作员无权新增或删除0元标签，且销售单列表不展示设置面板', async () => {
      const addRes = await request('/gift-labels/new', { user: 2, body: { name: '瓶盖兑酒' } });
      assert.equal(addRes.status, 403);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM gift_labels').get().c, 0);
      const salesHtml = (await request('/sales', { user: 2 })).text;
      assert.ok(!salesHtml.includes('id="giftLabelManagement"'));
    });

    let capLabelId;
    await check('管理员新增「瓶盖兑酒」并校拦截重复、保留词、非法字符和超长名称', async () => {
      const okRes = await request('/gift-labels/new', { body: { name: '  瓶盖兑酒  ' } });
      assert.equal(okRes.status, 302);
      assert.ok(okRes.success);
      const rows = db.prepare('SELECT * FROM gift_labels ORDER BY id').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, '瓶盖兑酒');
      capLabelId = rows[0].id;
      assert.equal(db.prepare('SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1').get().action, '新增0元标签');

      for (const [badName, msg] of [
        ['', '不能为空'],
        ['   ', '不能为空'],
        ['赠品', '默认标签'],
        ['瓶盖兑酒', '已存在'],
        ['瓶盖,兑酒', '逗号或顿号'],
        ['瓶盖、兑酒', '逗号或顿号'],
        ['字'.repeat(21), '不能超过 20 字']
      ]) {
        const res = await request('/gift-labels/new', { body: { name: badName } });
        assert.equal(res.status, 302);
        assert.ok(res.error && res.error.includes(msg), `expected ${msg} for ${badName}, got ${res.error}`);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM gift_labels').get().c, 1);
    });

    await check('配置「瓶盖兑酒」后，开单页注入自定义标签列表与交互选择器代码', async () => {
      const html = (await request('/sales/new')).text;
      assert.ok(html.includes('const GIFT_LABELS = ["赠品","瓶盖兑酒"]'));
      assert.ok(html.includes('sale-gift-picker'));
      assert.ok(html.includes('toggleGiftMenu'));
      assert.ok(html.includes('selectGiftLabel'));
    });

    const { randomUUID } = require('crypto');
    let op1OrderId, op2OrderId;
    await check('开单支持同一单混录正常销售、默认赠品与瓶盖兑酒，总额与库存口径正确', async () => {
      const res1 = await request('/sales/new', {
        user: 2,
        body: {
          _request_key: randomUUID(),
          customer_id: '1',
          customer_search: '兴旺烟酒',
          warehouse_id: '2',
          responsible_id: '2',
          order_date: '2026-10-15',
          paid_amount: '100',
          items_json: JSON.stringify([
            { id: 1, quantity: 2, price: 50, unit_choice: 'base', is_gift: false, gift_label: '' },
            { id: 2, quantity: 3, price: 12, unit_choice: 'base', is_gift: true, gift_label: '' },
            { id: 2, quantity: 1, price: 99, unit_choice: 'pack', is_gift: true, gift_label: '瓶盖兑酒' }
          ])
        }
      });
      assert.equal(res1.status, 302);
      op1OrderId = Number(res1.location.match(/\/sales\/(\d+)/)[1]);
      const order1 = db.prepare('SELECT total_amount FROM sales_orders WHERE id = ?').get(op1OrderId);
      assert.equal(order1.total_amount, 100);
      const items1 = db.prepare('SELECT product_id, quantity, base_quantity, unit_price, is_gift, gift_label, cost_price_snapshot FROM sales_order_items WHERE sales_order_id = ? ORDER BY id').all(op1OrderId);
      assert.equal(items1.length, 3);
      assert.deepEqual(items1.map(i => [i.is_gift, i.gift_label, i.unit_price, i.base_quantity]), [
        [0, '', 50, 2],
        [1, '赠品', 0, 3],
        [1, '瓶盖兑酒', 0, 10]
      ]);
      // 成本快照按标准记录（用于管理员核算毛利）
      assert.equal(items1[2].cost_price_snapshot, 5);
      await request(`/sales/approve/${op1OrderId}`, { user: 1, body: { _: '1' } });

      // 操作员二也录一单含 4 瓶「瓶盖兑酒」
      const res2 = await request('/sales/new', {
        user: 3,
        body: {
          _request_key: randomUUID(),
          customer_id: '2',
          customer_search: '大众餐饮',
          warehouse_id: '3',
          responsible_id: '3',
          order_date: '2026-10-16',
          paid_amount: '0',
          items_json: JSON.stringify([
            { id: 2, quantity: 4, price: 0, unit_choice: 'base', is_gift: true, gift_label: '瓶盖兑酒' }
          ])
        }
      });
      op2OrderId = Number(res2.location.match(/\/sales\/(\d+)/)[1]);
      await request(`/sales/approve/${op2OrderId}`, { user: 1, body: { _: '1' } });
    });

    await check('非法或未配置的0元标签在服务端被拦截拒绝（400）', async () => {
      const badRes = await request('/sales/new', {
        user: 2,
        body: {
          _request_key: randomUUID(),
          warehouse_id: '2',
          responsible_id: '2',
          order_date: '2026-10-16',
          paid_amount: '0',
          items_json: JSON.stringify([
            { id: 2, quantity: 1, price: 0, unit_choice: 'base', is_gift: true, gift_label: '未配置活动' }
          ])
        }
      });
      assert.equal(badRes.status, 400);
      assert.ok(badRes.text.includes('0 元/赠品标签不存在或已停用'));
    });

    await check('详情页、打印单、列表筛选、CSV导出与汇总页准确展示与统计「瓶盖兑酒」，且操作员不泄露成本', async () => {
      const detailHtml = (await request(`/sales/${op1OrderId}`, { user: 2 })).text;
      assert.ok(detailHtml.includes('瓶盖兑酒'));
      assert.ok(!detailHtml.includes('cost_price'));

      const printHtml = (await request(`/sales/${op1OrderId}/print`, { user: 2 })).text;
      assert.ok(printHtml.includes('活动小酒（瓶盖兑酒）'));
      assert.ok(printHtml.includes('活动小酒（赠品）'));

      // 列表筛选
      const adminList = (await request('/sales?gift_label=' + encodeURIComponent('瓶盖兑酒'), { json: true })).data.orders;
      assert.deepEqual(adminList.map(o => o.id), [op2OrderId, op1OrderId]);
      const op1List = (await request('/sales?gift_label=' + encodeURIComponent('瓶盖兑酒'), { user: 2, json: true })).data.orders;
      assert.deepEqual(op1List.map(o => o.id), [op1OrderId]);

      // CSV 导出按标签筛选时，仅导出匹配该标签的明细行（不含同单主推大酒和普通赠品）
      const csvLines = (await request('/sales/export?gift_label=' + encodeURIComponent('瓶盖兑酒'))).text.trim().split('\r\n');
      assert.equal(csvLines.length, 3); // 表头 + op2(4瓶) + op1(1盒=10瓶)
      assert.ok(csvLines[0].includes('赠品/0元标签'));
      assert.ok(csvLines.slice(1).every(line => line.includes(',瓶盖兑酒,') && !line.includes('主推大酒')));

      // 销售汇总页：管理员看全公司合计 14 瓶（1盒10瓶+4瓶），操作员一只看自己的 10 瓶，且无任何成本字段
      const adminSummary = (await request('/sales/summary?gift_label=' + encodeURIComponent('瓶盖兑酒'), { json: true })).data;
      assert.equal(adminSummary.giftProductSummaries.length, 1);
      assert.equal(adminSummary.giftProductSummaries[0].total_base_qty, 14);
      assert.equal(adminSummary.giftProductSummaries[0].order_count, 2);
      assert.equal(adminSummary.giftProductSummaries[0].customer_count, 2);

      const op1SummaryHtml = (await request('/sales/summary?gift_label=' + encodeURIComponent('瓶盖兑酒'), { user: 2 })).text;
      assert.ok(op1SummaryHtml.includes('1盒（共 10 瓶）'));
      assert.ok(!op1SummaryHtml.includes('cost_price'));
      assert.ok(!op1SummaryHtml.includes('毛利'));
    });

    await check('草稿编辑与删除自定义标签后历史数据及在途草稿保持完整', async () => {
      const draftRes = await request('/sales/new', {
        user: 2,
        body: {
          _request_key: randomUUID(),
          warehouse_id: '2',
          responsible_id: '2',
          order_date: '2026-10-17',
          paid_amount: '0',
          save_draft: '1',
          items_json: JSON.stringify([
            { id: 2, quantity: 2, price: 0, unit_choice: 'base', is_gift: true, gift_label: '瓶盖兑酒' }
          ])
        }
      });
      const draftId = Number(draftRes.location.match(/\/sales\/(\d+)/)[1]);
      // 管理员删除「瓶盖兑酒」标签
      const delRes = await request(`/gift-labels/${capLabelId}/delete`, { body: { _: '1' } });
      assert.equal(delRes.status, 302);
      assert.ok(delRes.success);
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM gift_labels').get().c, 0);
      assert.equal(db.prepare('SELECT action FROM audit_logs ORDER BY id DESC LIMIT 1').get().action, '删除0元标签');

      // 已审核历史订单明细与筛选仍保留「瓶盖兑酒」
      const detailAfterDelete = (await request(`/sales/${op1OrderId}`)).text;
      assert.ok(detailAfterDelete.includes('瓶盖兑酒'));
      const filterAfterDelete = (await request('/sales?gift_label=' + encodeURIComponent('瓶盖兑酒'), { json: true })).data.orders;
      assert.equal(filterAfterDelete.length, 3); // op1, op2, draft

      // 编辑已包含已删除标签的草稿仍能正常打开并保存保留该标签
      const editPage = (await request(`/sales/${draftId}/edit`, { user: 2 })).text;
      assert.ok(editPage.includes('瓶盖兑酒'));
      const editPost = await request(`/sales/${draftId}/edit`, {
        user: 2,
        body: {
          _request_key: randomUUID(),
          draft_revision: '0',
          warehouse_id: '2',
          responsible_id: '2',
          order_date: '2026-10-17',
          paid_amount: '0',
          items_json: JSON.stringify([
            { id: 2, quantity: 5, price: 0, unit_choice: 'base', is_gift: true, gift_label: '瓶盖兑酒' }
          ])
        }
      });
      assert.equal(editPost.status, 302);
      assert.equal(db.prepare('SELECT gift_label, quantity FROM sales_order_items WHERE sales_order_id = ?').get(draftId).quantity, 5);
    });

    await check('自定义标签上限 20 个，超限不落库', async () => {
      for (let i = 1; i <= 20; i++) {
        await request('/gift-labels/new', { body: { name: `活动${i}` } });
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM gift_labels').get().c, 20);
      const over = await request('/gift-labels/new', { body: { name: '活动21' } });
      assert.ok(over.error && over.error.includes('最多可创建 20 个'));
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM gift_labels').get().c, 20);
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runGiftLabelTests };
if (require.main === module) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-gift-platform-'));
  process.env.JXC_DATA_DIR = dir;
  let failures = 0;
  runGiftLabelTests((passed, label) => {
    if (!passed) failures++;
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
  }).catch(err => { console.error(err); failures++; }).finally(() => {
    require('../lib/platformDb').platformDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = failures ? 1 : 0;
  });
}
