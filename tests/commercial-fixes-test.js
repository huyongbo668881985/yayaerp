// 商用缺陷回归：真实路由 + 临时租户，覆盖结算、历史成本及业务幂等。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-commercial-fixes-'));
process.env.JXC_DATA_DIR = dir;
const { openTenantDbByPath } = require('../lib/tenantManager');
const db = openTenantDbByPath(path.join(dir, 'tenant.db'));
const { getSalePayment, profitOfPeriod, salesSettledExpr } = require('../lib/profitCalc');
const { getSummary } = require('../routes/report');
const { snapshotTenantDb } = require('../lib/debtSnapshot');
let server, base, passes = 0;
async function check(label, work) { await work(); passes++; console.log('  PASS  ' + label); }
function apiGet(route) {
  let body;
  const layer = require('../routes/apiV1').stack.find(layer => layer.route?.path === route);
  layer.route.stack.at(-1).handle({ tenantDb: db, query: {} }, { json(value) { body = value; } });
  return body;
}
const newKey = () => crypto.randomUUID();
async function post(route, body, key = newKey()) {
  if (/^\/returns\/approve\//.test(route)) body = { goods_received: '1', ...body };
  if (route.endsWith('/record-refund')) body = { refund_reference: '测试实际退款凭据', ...body };
  const response = await fetch(base + route, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...body, ...(key === null ? {} : { _request_key: key }) })
  });
  return { status: response.status, text: await response.text(), location: response.headers.get('location') };
}
const saleBody = { warehouse_id: '1', items_json: JSON.stringify([{ id: 1, quantity: 20, price: 5 }]), paid_amount: '60' };
const returnBody = saleId => ({ warehouse_id: '1', related_sales_order_id: String(saleId), items_json: JSON.stringify([{ id: 1, quantity: 8, price: 5 }]) });
const idOf = response => Number(response.location.match(/\/(\d+)/)[1]);
(async () => {
  db.exec(`INSERT INTO users (username, password_hash, name, role) VALUES ('admin','unused','测试管理员','admin');
    INSERT INTO warehouses (name) VALUES ('总仓'), ('分仓');
    INSERT INTO products (sku,name,unit,pack_unit,pack_size,cost_price,sale_price) VALUES ('test','商品','瓶','箱',10,3,5);
    INSERT INTO inventory (product_id,warehouse_id,quantity) VALUES (1,1,1000);
    INSERT INTO customers (name) VALUES ('客户甲');`);
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.tenantDb = db; req.session = { user: { id: 1 } };
    res.render = (view, locals) => res.send(JSON.stringify({ view, error: locals.error }));
    next();
  });
  for (const route of ['sales', 'returns', 'purchases', 'transfers']) app.use(require('../routes/' + route));
  app.use((error, req, res, next) => res.status(500).send(error.message));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  let saleId, returnId;
  await check('同凭证并发开销售单只落一单、一次审计；内容变更返回 409', async () => {
    const key = newKey();
    const results = await Promise.all([post('/sales/new', saleBody, key), post('/sales/new', saleBody, key)]);
    assert.equal(results[0].status, 302); assert.deepEqual(results[0], results[1]);
    saleId = idOf(results[0]);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, 1);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='新建销售单'").get().c, 1);
    assert.equal((await post('/sales/new', { ...saleBody, paid_amount: '50' }, key)).status, 409);
  });
  await check('没有提交凭证不能开单或记收款；客户搜索未选定不会落成散客单', async () => {
    assert.equal((await post('/sales/new', saleBody, null)).status, 400);
    assert.equal((await post(`/sales/${saleId}/record-payment`, { amount: '1' }, null)).status, 400);
    const before = db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c;
    const result = await post('/sales/new', { ...saleBody, customer_search: '客户乙' });
    assert.equal(result.status, 400); assert.ok(result.text.includes('选择客户'));
    const mismatch = await post('/sales/new', { ...saleBody, customer_id: '1', customer_search: '客户乙' });
    assert.equal(mismatch.status, 400); assert.ok(mismatch.text.includes('不一致'));
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, before);
    assert.equal((await post('/sales/approve/' + saleId, {})).status, 302);
  });
  await check('商品改成本后关联退货仍用原销售成本，重试只创建一笔退货', async () => {
    db.prepare('UPDATE products SET cost_price=6 WHERE id=1').run();
    const key = newKey();
    const a = await post('/returns/new', returnBody(saleId), key);
    assert.equal(a.status, 302); assert.deepEqual(await post('/returns/new', returnBody(saleId), key), a);
    returnId = idOf(a);
    assert.equal(db.prepare('SELECT cost_price_snapshot c FROM return_order_items WHERE return_order_id=?').get(returnId).c, 3);
    assert.equal((await post('/returns/approve/' + returnId, {})).status, 302);
    assert.equal(getSalePayment(db, saleId).balance, 0);
    assert.equal(profitOfPeriod(db).profit, 24);
    assert.equal((await post(`/returns/${returnId}/record-refund`, { amount: '1' })).status, 400);
  });
  await check('已入账关联退货成本不能改写，毛利保持原销售快照', () => {
    assert.throws(() => db.prepare('UPDATE return_order_items SET cost_price_snapshot=6 WHERE return_order_id=?').run(returnId), /不可改写/);
    assert.equal(getSummary(db).profitWithReceivable, 24);
    assert.equal(apiGet('/reports/direct-dashboard').settled.gross_profit, 24);
    assert.equal(db.prepare('SELECT cost_price_snapshot c FROM return_order_items WHERE return_order_id=?').get(returnId).c, 3);
  });
  await check('已有现金退款会增加原单应收，报表、SQL 结算、欠款快照一致', async () => {
    // 模拟升级前已经记下的错误退款；不改原始现金记录，只修计算口径。
    db.prepare("UPDATE return_orders SET refunded_amount=40, refund_status='refunded' WHERE id=?").run(returnId);
    assert.equal(getSalePayment(db, saleId).effective_debt, 40);
    assert.equal(getSummary(db).receivable.amount, 40);
    const apiSale = apiGet('/sales').items.find(item => item.id === saleId);
    assert.equal(apiSale.effective_debt, 40); assert.equal(apiSale.cash_refunded_amount, 40);
    assert.equal(apiSale.net_received, 20); assert.equal(apiSale.pending_refund, 0);
    assert.equal(apiGet('/reports/direct-dashboard').outstanding.receivable_amount, 40);
    assert.equal(snapshotTenantDb(db, '2026-10-01').company_debt, 40);
    assert.equal(db.prepare(`SELECT (${salesSettledExpr()}) settled FROM sales_orders so WHERE id=?`).get(saleId).settled, 0);
    assert.equal((await post(`/sales/${saleId}/record-payment`, { amount: '41' })).status, 400);
    const key = newKey();
    const a = await post(`/sales/${saleId}/record-payment`, { amount: '40' }, key);
    assert.equal(a.status, 302); assert.deepEqual(await post(`/sales/${saleId}/record-payment`, { amount: '40' }, key), a);
    assert.equal(db.prepare('SELECT paid_amount p FROM sales_orders WHERE id=?').get(saleId).p, 100);
    assert.equal(getSalePayment(db, saleId).effective_status, 'paid');
    assert.equal(profitOfPeriod(db).profit, 24);
    assert.equal((await post('/returns/unapprove/' + returnId, {})).status, 400);
  });
  await check('全款后退货显示待退款；部分/全额退款上限及重试正确', async () => {
    const nextSale = idOf(await post('/sales/new', { ...saleBody, paid_amount: '100' }));
    await post('/sales/approve/' + nextSale, {});
    const nextReturn = idOf(await post('/returns/new', returnBody(nextSale)));
    await post('/returns/approve/' + nextReturn, {});
    assert.equal(getSalePayment(db, nextSale).pending_refund, 40);
    assert.equal(getSalePayment(db, nextSale).effective_status, 'refund_pending');
    const key = newKey();
    const a = await post(`/returns/${nextReturn}/record-refund`, { amount: '20' }, key);
    assert.equal(a.status, 302); assert.deepEqual(await post(`/returns/${nextReturn}/record-refund`, { amount: '20' }, key), a);
    assert.equal(getSalePayment(db, nextSale).pending_refund, 20);
    assert.equal((await post(`/returns/${nextReturn}/record-refund`, { amount: '21' })).status, 400);
    assert.equal((await post(`/returns/${nextReturn}/record-refund`, { amount: '20' })).status, 302);
    assert.equal(getSalePayment(db, nextSale).effective_status, 'paid');
  });
  await check('原单箱规 10 改为 12 后，关联箱退货仍按原箱规、单位及加权成本', async () => {
    const packedSale = idOf(await post('/sales/new', { warehouse_id: '1', items_json: JSON.stringify([{ id: 1, quantity: 2, price: 50, unit_choice: 'pack' }]) }));
    await post('/sales/approve/' + packedSale, {});
    db.prepare("UPDATE products SET pack_size=12, pack_unit='大箱', cost_price=9 WHERE id=1").run();
    const packedReturn = idOf(await post('/returns/new', { warehouse_id: '1', related_sales_order_id: packedSale, items_json: JSON.stringify([{ id: 1, quantity: 1, price: 50, unit_choice: 'pack' }]) }));
    const item = db.prepare('SELECT * FROM return_order_items WHERE return_order_id=?').get(packedReturn);
    assert.equal(item.base_quantity, 10); assert.equal(item.unit_label, '箱'); assert.equal(item.cost_price_snapshot, 6);
  });
  await check('采购重试不重复入库，调拨重试不重复建单，不同凭证允许真实独立业务', async () => {
    for (const [route, table, body] of [
      ['/purchases/new', 'purchase_orders', { warehouse_id: '1', product_id: '1', quantity: '10', unit_price: '3', unit_choice: 'base' }],
      ['/transfers/new', 'transfer_orders', { from_warehouse_id: '1', to_warehouse_id: '2', product_id: '1', quantity: '10', unit_choice: 'base' }]
    ]) {
      const key = newKey(), before = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c;
      const inventory = db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity;
      const a = await post(route, body, key); assert.equal(a.status, 302);
      assert.deepEqual(await post(route, body, key), a);
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, before + 1);
      assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity, inventory + (table === 'purchase_orders' ? 10 : 0));
      assert.equal((await post(route, body)).status, 302);
      assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, before + 2);
    }
  });
  await check('审计失败时业务单和去重记录一起回滚，同凭证可安全重试', async () => {
    const key = newKey(), before = db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c;
    db.exec("CREATE TRIGGER fail_new_sale_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit failed'); END;");
    assert.equal((await post('/sales/new', saleBody, key)).status, 500);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sales_orders').get().c, before);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mutation_requests WHERE request_key=?').get(key).c, 0);
    db.exec('DROP TRIGGER fail_new_sale_audit');
    assert.equal((await post('/sales/new', saleBody, key)).status, 302);
  });
  console.log(`商用缺陷回归：${passes} PASS / 0 FAIL`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); require('../lib/platformDb').platformDb.close(); fs.rmSync(dir, { recursive: true, force: true });
});
