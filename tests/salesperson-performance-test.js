// 业务员业绩：按负责人归属，合计必须与经营报表"不含应收"毛利一致。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openTenantDbByPath } = require('../lib/tenantManager');
const { getSummary } = require('../routes/report');
const { getSalespersonPerformance } = require('../lib/salespersonPerformance');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-sp-perf-'));
const db = openTenantDbByPath(path.join(dir, 'tenant.db'));
let failed = 0;
const check = async (label, fn) => {
  try { await fn(); console.log('  ✓ ' + label); }
  catch (err) { failed++; console.error('  ✗ ' + label + ': ' + err.message); }
};

const user = (u, name, role, active = 1) => Number(db.prepare(
  "INSERT INTO users (username, password_hash, name, role, active) VALUES (?, 'x', ?, ?, ?)").run(u, name, role, active).lastInsertRowid);
const admin = user('admin', '管理员', 'admin');
const alice = user('alice', '小王', 'operator');
const bob = user('bob', '小李', 'operator', 0);
db.prepare("INSERT INTO warehouses (name) VALUES ('仓')").run();
db.prepare("INSERT INTO products (name, cost_price) VALUES ('酒', 6)").run();

const sale = (date, total, paid, qty, owner, entry = admin, status = 'approved') => {
  const id = Number(db.prepare(`INSERT INTO sales_orders
    (warehouse_id, user_id, responsible_id, order_date, total_amount, paid_amount, payment_status, status)
    VALUES (1, ?, ?, ?, ?, ?, 'partial', ?)`).run(entry, owner, date, total, paid, status).lastInsertRowid);
  db.prepare(`INSERT INTO sales_order_items (sales_order_id, product_id, quantity, base_quantity, unit_price, cost_price_snapshot)
    VALUES (?, 1, ?, ?, ?, 6)`).run(id, qty, qty, total / qty);
  return id;
};
const ret = (date, total, qty, related) => {
  const id = Number(db.prepare(`INSERT INTO return_orders
    (warehouse_id, user_id, order_date, total_amount, refunded_amount, refund_status, status, related_sales_order_id)
    VALUES (1, ?, ?, ?, ?, 'refunded', 'approved', ?)`).run(admin, date, total, total, related).lastInsertRowid);
  db.prepare(`INSERT INTO return_order_items (return_order_id, product_id, quantity, base_quantity, unit_price, cost_price_snapshot)
    VALUES (?, 1, ?, ?, ?, 6)`).run(id, qty, qty, total / qty);
};

console.log('业务员业绩');
const a1 = sale('2026-10-01', 100, 100, 10, alice);       // 结清，毛利 40
sale('2026-10-02', 200, 50, 20, alice);                   // 未结清，不计实现毛利，应收 150
const b1 = sale('2026-10-03', 300, 300, 30, bob);         // 结清，毛利 120；录入人是管理员，归 bob
sale('2026-10-04', 500, 500, 50, alice, admin, 'draft');  // 草稿不计
sale('2026-09-01', 999, 999, 9, alice);                   // 区间外
ret('2026-10-05', 60, 6, b1);                             // bob 的退货，冲减毛利 24
ret('2026-10-06', 20, 2, null);                           // 未归属退货：冲减 20-12=8
void a1;

const perf = getSalespersonPerformance(db, '2026-10-01', '2026-10-31');
const by = n => perf.rows.find(r => r.name.startsWith(n));
check('小王：2 单 / 销售 300 / 不含应收销售 100 / 实现毛利 40 / 毛利率 40% / 应收 150', () => {
  const r = by('小王');
  assert.equal(r.order_count, 2); assert.equal(r.sales_amount, 300);
  assert.equal(r.net_sales, 300); assert.equal(r.settled_net_sales, 100);
  assert.equal(r.realized_profit, 40); assert.equal(r.receivable, 150);
  assert.equal(r.margin_rate, (40 / 100) * 100);
});
check('小李按负责人归属（非录入人），退货按原单冲减，已停用标注', () => {
  const r = by('小李');
  assert.equal(r.name, '小李（已停用）');
  assert.equal(r.return_amount, 60); assert.equal(r.net_sales, 240);
  assert.equal(r.settled_net_sales, 240);
  assert.equal(r.realized_profit, 120 - 24);
  assert.equal(r.margin_rate, (96 / 240) * 100);
});
check('无关联原单的退货计入"未归属退货"，排在最后', () => {
  const r = perf.rows[perf.rows.length - 1];
  assert.equal(r.name, '未归属退货'); assert.equal(r.realized_profit, -8); assert.equal(r.return_amount, 20);
  assert.equal(r.settled_net_sales, -20);
});
check('管理员本人没有业绩行（录入人≠负责人）', () => assert.equal(by('管理员'), undefined));
check('合计毛利与不含应收销售额 == 经营报表"不含应收"口径', () => {
  const s = getSummary(db, '2026-10-01', '2026-10-31');
  assert.ok(Math.abs(perf.total.realized_profit - s.profitWithoutReceivable) < 0.005);
  assert.ok(Math.abs(perf.total.net_sales - s.sales.amount) < 0.005);
  assert.ok(Math.abs(perf.total.settled_net_sales - s.settledNetSales) < 0.005);
  assert.equal(perf.total.settled_net_sales, 320);
  assert.ok(Math.abs(perf.total.margin_rate - (perf.total.realized_profit / perf.total.settled_net_sales) * 100) < 0.005);
});
check('无数据区间为空', () => assert.equal(getSalespersonPerformance(db, '2030-01-01', '2030-01-31').rows.length, 0));

// 补充：9 月再加一笔未结清销售单，验证上月对比（buildComparison）在"仅已结清"口径下不被上月未结清订单拉低毛利率
sale('2026-09-15', 500, 0, 50, alice); // 9月未结清 500，9月已结清净销售额仍为 999，已结清毛利 = 999 - 9*6 = 945

(async () => {
  const express = require('express');
  const { randomUUID } = require('crypto');
  const { formatDateTime } = require('../utils/dates');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use((req, res, next) => {
    const uid = Number(req.headers['x-test-user']) || admin;
    const u = db.prepare('SELECT id, username, name, role, active, auth_version FROM users WHERE id = ?').get(uid);
    req.tenantDb = db;
    req.session = {
      user: { id: u.id, username: u.username, name: u.name, role: u.role, authVersion: u.auth_version },
      destroy: cb => cb && cb()
    };
    Object.assign(res.locals, {
      csrfToken: 'test',
      currentTenant: { name: '测试租户' },
      currentPath: req.path,
      formatDateTime,
      newRequestKey: randomUUID
    });
    next();
  });
  app.use(require('../routes/dashboard'));
  app.use(require('../routes/report'));

  const req = (url, { uid = admin, json = false } = {}) => new Promise((resolve, reject) => {
    const headers = { 'x-test-user': String(uid), ...(json ? { 'x-test-json': '1' } : {}) };
    const fakeReq = Object.assign(new (require('stream').Readable)({ read() {} }), {
      method: 'GET',
      url,
      headers,
      connection: {},
      socket: {}
    });
    let statusCode = 200;
    const resHeaders = {};
    const chunks = [];
    const fakeRes = Object.assign(new (require('stream').Writable)({
      write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); }
    }), {
      statusCode: 200,
      setHeader(k, v) { resHeaders[k.toLowerCase()] = v; },
      getHeader(k) { return resHeaders[k.toLowerCase()]; },
      removeHeader(k) { delete resHeaders[k.toLowerCase()]; },
      writeHead(code, hdrs) {
        statusCode = code;
        this.statusCode = code;
        if (hdrs) Object.entries(hdrs).forEach(([k, v]) => this.setHeader(k, v));
      },
      status(code) { statusCode = code; this.statusCode = code; return this; },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: statusCode, text, data: json && statusCode === 200 ? JSON.parse(text) : null });
      }
    });
    if (json) {
      fakeRes.render = (view, locals) => {
        fakeRes.setHeader('content-type', 'application/json');
        fakeRes.end(JSON.stringify({ view, ...locals }));
      };
    }
    app.handle(fakeReq, fakeRes, reject);
  });

  try {
    await check('经营报表页（仅已结清）：顶部毛利率与业务员合计毛利率一致，且上月环比按上月已结清销售额计算', async () => {
      const { status, data } = await req('/reports?start=2026-10-01&end=2026-10-31&mode=without_receivable', { uid: admin, json: true });
      assert.equal(status, 200);
      assert.ok(Math.abs(data.marginRate - data.salespersonPerf.total.margin_rate) < 0.005);
      // 10月已结清毛利率 = 128 / 320 = 40%，9月已结清毛利率 = 945 / 999 ≈ 94.5946%
      const expectedPrevMargin = (945 / 999) * 100;
      const expectedDiffPt = 40 - expectedPrevMargin;
      assert.ok(Math.abs(data.comparison.marginDiffPt - expectedDiffPt) < 0.005);
    });

    await check('经营报表与导出：包含"不含应收销售额"列及正确数值', async () => {
      const htmlRes = await req('/reports?start=2026-10-01&end=2026-10-31', { uid: admin });
      assert.equal(htmlRes.status, 200);
      assert.ok(htmlRes.text.includes('不含应收销售额'));
      const csvRes = await req('/reports/salesperson-export?start=2026-10-01&end=2026-10-31', { uid: admin });
      assert.equal(csvRes.status, 200);
      assert.ok(csvRes.text.includes('不含应收销售额'));
      assert.ok(csvRes.text.includes('小王,2,300.00,0.00,300.00,100.00,40.00,40.0%'));
    });

    await check('权限红线：操作员访问报表与导出返回 403，访问首页不返回且不渲染任何业务员业绩或毛利', async () => {
      const r1 = await req('/reports', { uid: alice });
      assert.equal(r1.status, 403);
      const r2 = await req('/reports/salesperson-export', { uid: alice });
      assert.equal(r2.status, 403);
      const dashJson = await req('/?sp=month', { uid: alice, json: true });
      assert.equal(dashJson.status, 200);
      assert.equal(dashJson.data.spPerf, null);
      assert.equal(dashJson.data.todayProfit, null);
      assert.equal(dashJson.data.monthlyProfit, null);
      const dashHtml = await req('/?sp=month', { uid: alice });
      assert.equal(dashHtml.status, 200);
      assert.ok(!dashHtml.text.includes('业务员业绩排行'));
      assert.ok(!dashHtml.text.includes('实现毛利'));
      assert.ok(!dashHtml.text.includes('不含应收销售额'));
    });
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
  console.log('\n全部通过');
})();
