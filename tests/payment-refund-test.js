// 真实路由 + 两个独立 SQLite 连接：在第一次读订单后暂停，稳定覆盖跨实例的旧值覆盖风险。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

if (!isMainThread) {
  const Database = require('better-sqlite3');
  const express = require('express');
  const db = new Database(workerData.dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const gate = new Int32Array(workerData.gate);
  const prepare = db.prepare.bind(db);
  let pauseRead = false;
  db.prepare = sql => {
    const statement = prepare(sql);
    if (/^SELECT \* FROM (sales_orders|return_orders|transfer_orders|purchase_orders) WHERE id = \?$/.test(sql)) {
      const get = statement.get.bind(statement);
      statement.get = (...params) => {
        const order = get(...params);
        if (pauseRead) {
          pauseRead = false;
          parentPort.postMessage({ read: true });
          if (Atomics.wait(gate, 0, 0, 5000) === 'timed-out') throw new Error('等待测试释放订单读取超时');
        }
        return order;
      };
    }
    return statement;
  };
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.tenantDb = db;
    req.session = { user: { id: req.headers['x-test-role'] === 'operator' ? 2 : 1 } };
    pauseRead = req.headers['x-test-pause-read'] === '1';
    next();
  });
  app.use(require('../routes/sales'), require('../routes/returns'), require('../routes/transfers'), require('../routes/purchases'));
  app.use((err, req, res, next) => res.status(500).send(err.message));
  const server = app.listen(0, '127.0.0.1', () => {
    parentPort.postMessage({ base: `http://127.0.0.1:${server.address().port}` });
  });
  parentPort.on('message', message => {
    if (message === 'close') server.close(() => { db.close(); parentPort.close(); });
  });
} else {
  async function runPaymentRefundTests(ok) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-payment-refund-'));
    const { openTenantDbByPath } = require('../lib/tenantManager');
    const db = openTenantDbByPath(path.join(dir, 'tenant.db'));
    const gateBuffer = new SharedArrayBuffer(4);
    const gate = new Int32Array(gateBuffer);
    const workers = [];
    const check = async (label, fn) => {
      try { await fn(); ok(true, label); }
      catch (err) { ok(false, `${label}: ${err.message}`); }
    };
    const sale = (total = 100, paid = 0, status = 'approved') => Number(db.prepare(`INSERT INTO sales_orders
      (warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status)
      VALUES (1, 1, '2026-10-01', ?, ?, ?, ?)`).run(total, paid, paid ? 'partial' : 'unpaid', status).lastInsertRowid);
    const refund = (total = 100, refunded = 0, status = 'approved', related = null) => Number(db.prepare(`INSERT INTO return_orders
      (warehouse_id, user_id, order_date, total_amount, refunded_amount, refund_status, status, related_sales_order_id)
      VALUES (1, 1, '2026-10-01', ?, ?, ?, ?, ?)`).run(total, refunded, refunded ? 'partial' : 'unrefunded', status, related).lastInsertRowid);
    const snapshot = (kind, id) => ({
      order: db.prepare(`SELECT * FROM ${kind === 'sales' ? 'sales_orders' : 'return_orders'} WHERE id = ?`).get(id),
      logs: db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
    });
    try {
      db.prepare("INSERT INTO users (username, password_hash, name, role) VALUES ('admin', 'unused', '测试管理员', 'admin'), ('operator', 'unused', '测试操作员', 'operator')").run();
      db.prepare("INSERT INTO warehouses (name) VALUES ('测试仓库')").run();
      for (let i = 0; i < 2; i++) {
        const worker = new Worker(__filename, { workerData: { dbPath: db.name, gate: gateBuffer } });
        workers.push(worker);
        const [message] = await once(worker, 'message');
        worker.base = message.base;
      }
      const post = async (kind, id, amount, instance = 0, headers = {}) => {
        const response = await fetch(`${workers[instance].base}/${kind}/${id}/record-${kind === 'sales' ? 'payment' : 'refund'}`, {
          method: 'POST', redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
          body: new URLSearchParams({ amount, _request_key: headers['x-request-key'] || require('crypto').randomUUID() })
        });
        return { status: response.status, text: await response.text(), location: response.headers.get('location') };
      };
      await check('租户连接已配置 busy_timeout = 5000', () => assert.equal(db.pragma('busy_timeout', { simple: true }), 5000));
      for (const kind of ['sales', 'returns']) {
        const isSale = kind === 'sales';
        const name = isSale ? '收款' : '退款';
        const column = isSale ? 'paid_amount' : 'refunded_amount';
        const statusColumn = isSale ? 'payment_status' : 'refund_status';
        const action = isSale ? '记录销售收款' : '记录退货退款';
        const entityType = isSale ? '销售单' : '退货单';
        const create = isSale ? sale : refund;
        const id = create();
        await check(`${name}分两次收满，累计金额、状态和审计日志正确`, async () => {
          for (const [amount, total, status] of [[40, 40, 'partial'], [60, 100, isSale ? 'paid' : 'refunded']]) {
            const result = await post(kind, id, amount);
            assert.equal(result.status, 302);
            assert.equal(result.location, `/${kind}/${id}`);
            const state = snapshot(kind, id);
            assert.equal(state.order[column], total);
            assert.equal(state.order[statusColumn], status);
            const log = state.logs.at(-1);
            assert.equal(log.action, action);
            assert.equal(log.entity_type, entityType);
            assert.equal(log.entity_id, id);
            assert.equal(log.user_id, 1);
            assert.equal(log.user_name, '测试管理员');
            assert.equal(log.summary, `本次${name} ¥${amount.toFixed(2)}，累计 ¥${total.toFixed(2)}`);
          }
        });
        const partialId = create(100, 40);
        const cases = [
          [partialId, '61', `${name}金额（¥61.00）超过该单剩余未${isSale ? '收' : '退'}金额（¥60.00），最多还能${isSale ? '收' : '退'} ¥60.00`],
          [id, '1', isSale ? '该单有效欠款已结清（总额 ¥100.00，已收 ¥100.00，已扣关联退货 ¥0.00），无需再记收款' : '该单已退满（已退 ¥100.00 / 总额 ¥100.00），无需再记退款'],
          ...['0', '-1', 'Infinity', 'NaN', '', 'abc'].map(amount => [partialId, amount, `${name}金额必须是大于 0 的有效数字`]),
          [partialId, '0.004', `${name}金额四舍五入到分后必须大于 0`],
          [create(100, 0, 'draft'), 'abc', `只有已审核的${isSale ? '销售' : '退货'}单可以记录${name}`]
        ];
        for (const [orderId, amount, message] of cases) {
          await check(`${name}拒绝 ${JSON.stringify(amount)}，状态码/文案不变且无写入`, async () => {
            const before = snapshot(kind, orderId);
            const result = await post(kind, orderId, amount);
            assert.equal(result.status, 400);
            assert.equal(result.text, message);
            assert.deepEqual(snapshot(kind, orderId), before);
          });
        }
        await check(`${name}权限及不存在单据响应不变`, async () => {
          const before = snapshot(kind, partialId);
          assert.deepEqual(await post(kind, partialId, 1, 0, { 'x-test-role': 'operator' }), {
            status: 403, text: `无权限，只有管理员能记录${name}`, location: null
          });
          assert.deepEqual(await post(kind, 999999, 'abc'), { status: 404, text: '单据不存在', location: null });
          assert.deepEqual(snapshot(kind, partialId), before);
        });
        await check(`${name}审计写入失败时金额和日志一起回滚`, async () => {
          const before = snapshot(kind, partialId);
          db.exec(`CREATE TRIGGER reject_test_audit BEFORE INSERT ON audit_logs WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, '测试审计失败'); END`);
          try {
            assert.equal((await post(kind, partialId, 1)).status, 500);
            assert.deepEqual(snapshot(kind, partialId), before);
          } finally { db.exec('DROP TRIGGER reject_test_audit'); }
        });
        for (const secondAmount of [60, 70]) {
          await check(`${name}跨实例并发 40 + ${secondAmount}：重新读取累计值并校验上限`, async () => {
            const concurrentId = create();
            Atomics.store(gate, 0, 0);
            const read = once(workers[0], 'message');
            const first = post(kind, concurrentId, 40, 0, { 'x-test-pause-read': '1' });
            let second;
            let releaseTimer;
            try {
              await read;
              second = post(kind, concurrentId, secondAmount, 1);
              // 旧代码第二笔会先完成；事务版第二笔等写锁，定时释放第一笔让其提交。
              const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
              releaseTimer = setTimeout(release, 200);
              second.then(release, release);
              const [a, b] = await Promise.all([first, second]);
              assert.equal(a.status, 302);
              assert.equal(b.status, secondAmount === 60 ? 302 : 400);
              assert.equal(snapshot(kind, concurrentId).order[column], secondAmount === 60 ? 100 : 40);
              const logs = db.prepare('SELECT * FROM audit_logs WHERE action = ? AND entity_id = ? ORDER BY id').all(action, concurrentId);
              assert.equal(logs.length, secondAmount === 60 ? 2 : 1);
              assert.equal(logs[0].summary, `本次${name} ¥40.00，累计 ¥40.00`);
              if (secondAmount === 60) assert.equal(logs[1].summary, `本次${name} ¥60.00，累计 ¥100.00`);
            } finally {
              clearTimeout(releaseTimer);
              Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
              await Promise.allSettled([first, second]);
            }
          });
        }
      }
      db.exec(`INSERT INTO warehouses (name) VALUES ('测试分仓');
        INSERT INTO products (sku,name,unit,cost_price,sale_price) VALUES ('stock-test','并发商品','瓶',3,5);
        INSERT INTO inventory (product_id,warehouse_id,quantity) VALUES (1,1,200),(1,2,200);`);
      for (const kind of ['sales', 'returns', 'transfers']) {
        for (const action of ['approve', 'unapprove']) {
          await check(`${kind}跨实例重复${action}只改变一次库存与单据状态`, async () => {
            const status = action === 'approve' ? 'submitted' : 'approved';
            const id = kind === 'sales' ? sale(50, 0, status) : kind === 'returns' ? refund(50, 0, status)
              : Number(db.prepare(`INSERT INTO transfer_orders (from_warehouse_id,to_warehouse_id,user_id,order_date,status)
                  VALUES (1,2,1,'2026-10-01',?)`).run(status).lastInsertRowid);
            const table = kind === 'sales' ? 'sales' : kind === 'returns' ? 'return' : 'transfer';
            if (kind === 'transfers') db.prepare('INSERT INTO transfer_order_items (transfer_order_id,product_id,quantity,unit_label,base_quantity) VALUES (?,1,10,?,10)').run(id, '瓶');
            else db.prepare(`INSERT INTO ${table}_order_items (${table}_order_id,product_id,quantity,unit_label,base_quantity,unit_price,cost_price_snapshot) VALUES (?,1,10,?,10,5,3)`).run(id, '瓶');
            const before = db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity;
            const request = (instance, pause) => fetch(`${workers[instance].base}/${kind}/${action}/${id}`, {
              method: 'POST', redirect: 'manual', headers: pause ? { 'x-test-pause-read': '1' } : {}
            });
            Atomics.store(gate, 0, 0);
            const read = once(workers[0], 'message');
            const first = request(0, true);
            let second, releaseTimer;
            try {
              await read;
              second = request(1, false);
              const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
              releaseTimer = setTimeout(release, 200);
              second.then(release, release);
              const results = await Promise.all([first, second]);
              assert.equal(results[0].status, 302); assert.equal(results[1].status, 400);
              const sign = (kind === 'returns' ? 1 : -1) * (action === 'approve' ? 1 : -1);
              assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity, before + sign * 10);
              const ref = kind === 'sales' ? 'sales_order' : kind === 'returns' ? 'return_order' : 'transfer_order';
              assert.equal(db.prepare('SELECT COUNT(*) c FROM stock_transactions WHERE ref_type=? AND ref_id=?').get(ref + (action === 'unapprove' ? '_unapprove' : ''), id).c, kind === 'transfers' ? 2 : 1);
            } finally {
              clearTimeout(releaseTimer); Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
              await Promise.allSettled([first, second]);
            }
          });
        }
      }
      await check('采购跨实例重复删除只扣一次库存，第二笔返回不存在', async () => {
        const product = Number(db.prepare("INSERT INTO products(sku,name,unit,cost_price,sale_price) VALUES ('delete-test','删除商品','瓶',3,5)").run().lastInsertRowid);
        db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES (?,1,100)').run(product);
        const id = Number(db.prepare("INSERT INTO purchase_orders(warehouse_id,user_id,order_date,total_amount) VALUES (1,1,'2026-10-01',30)").run().lastInsertRowid);
        db.prepare('INSERT INTO purchase_order_items(purchase_order_id,product_id,quantity,unit_label,base_quantity,unit_price) VALUES (?,?,10,?,10,3)').run(id, product, '瓶');
        const request = (instance, pause) => fetch(`${workers[instance].base}/purchases/${id}/delete`, {
          method: 'POST', redirect: 'manual', headers: pause ? { 'x-test-pause-read': '1' } : {}
        });
        Atomics.store(gate, 0, 0);
        const read = once(workers[0], 'message'), first = request(0, true);
        let second, releaseTimer;
        try {
          await read; second = request(1, false);
          const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
          releaseTimer = setTimeout(release, 200); second.then(release, release);
          const results = await Promise.all([first, second]);
          assert.equal(results[0].status, 302); assert.equal(results[1].status, 404);
          assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=1').get(product).quantity, 90);
          assert.equal(db.prepare("SELECT COUNT(*) c FROM stock_transactions WHERE ref_type='purchase_order_delete' AND ref_id=?").get(id).c, 1);
        } finally {
          clearTimeout(releaseTimer); Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
          await Promise.allSettled([first, second]);
        }
      });
      for (const kind of ['sales', 'returns']) {
        await check(`${kind}跨实例同凭证并发重试只执行一次，重开连接仍能返回原结果`, async () => {
          const id = kind === 'sales' ? sale() : refund();
          const key = require('crypto').randomUUID();
          const results = await Promise.all([0, 1].map(instance => post(kind, id, 20, instance, { 'x-request-key': key })));
          assert.equal(results[0].status, 302);
          assert.deepEqual(results[0], results[1]);
          assert.equal(snapshot(kind, id).order[kind === 'sales' ? 'paid_amount' : 'refunded_amount'], 20);
          const record = db.prepare('SELECT * FROM mutation_requests WHERE request_key=?').get(key);
          assert.ok(record);
          assert.equal((await post(kind, id, 21, 1, { 'x-request-key': key })).status, 409);
        });
      }
      await check('收款上限与详情页一致：只扣关联已审核退货，现金状态保持原口径', async () => {
        const id = sale(100, 20);
        refund(30, 0, 'approved', id);
        refund(40, 0, 'draft', id);
        refund(50, 0, 'submitted', id);
        refund(60, 0, 'rejected', id);
        refund(70);
        const before = snapshot('sales', id);
        assert.equal((await post('sales', id, 51)).text, '收款金额（¥51.00）超过该单剩余未收金额（¥50.00），最多还能收 ¥50.00');
        assert.deepEqual(snapshot('sales', id), before);
        assert.equal((await post('sales', id, 50)).status, 302);
        const order = snapshot('sales', id).order;
        assert.equal(order.paid_amount, 70);
        assert.equal(order.payment_status, 'partial');
        const { attachEffectivePayment } = require('../routes/sales');
        assert.equal(attachEffectivePayment({ ...order, returned_amount: 30 }).effective_debt, 0);
        const settled = snapshot('sales', id);
        assert.equal((await post('sales', id, 1)).text, '该单有效欠款已结清（总额 ¥100.00，已收 ¥70.00，已扣关联退货 ¥30.00），无需再记收款');
        assert.deepEqual(snapshot('sales', id), settled);
      });
    } finally {
      Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
      await Promise.all(workers.map(worker => worker.terminate()));
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  module.exports = { runPaymentRefundTests };
  if (require.main === module) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-payment-platform-'));
    process.env.JXC_DATA_DIR = dir;
    let failures = 0;
    runPaymentRefundTests((passed, label) => {
      if (!passed) failures++;
      console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${label}`);
    }).catch(err => { console.error(err); failures++; }).finally(() => {
      require('../lib/platformDb').platformDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
      process.exitCode = failures ? 1 : 0;
    });
  }
}
