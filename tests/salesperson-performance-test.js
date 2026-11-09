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
const check = (label, fn) => {
  try { fn(); console.log('  ✓ ' + label); }
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
check('小王：2 单 / 销售 300 / 实现毛利 40 / 应收 150', () => {
  const r = by('小王');
  assert.equal(r.order_count, 2); assert.equal(r.sales_amount, 300);
  assert.equal(r.realized_profit, 40); assert.equal(r.receivable, 150);
  assert.equal(r.margin_rate, (40 / 300) * 100);
});
check('小李按负责人归属（非录入人），退货按原单冲减，已停用标注', () => {
  const r = by('小李');
  assert.equal(r.name, '小李（已停用）');
  assert.equal(r.return_amount, 60); assert.equal(r.net_sales, 240);
  assert.equal(r.realized_profit, 120 - 24);
});
check('无关联原单的退货计入"未归属退货"，排在最后', () => {
  const r = perf.rows[perf.rows.length - 1];
  assert.equal(r.name, '未归属退货'); assert.equal(r.realized_profit, -8); assert.equal(r.return_amount, 20);
});
check('管理员本人没有业绩行（录入人≠负责人）', () => assert.equal(by('管理员'), undefined));
check('合计毛利 == 经营报表"不含应收"毛利', () => {
  const s = getSummary(db, '2026-10-01', '2026-10-31');
  assert.ok(Math.abs(perf.total.realized_profit - s.profitWithoutReceivable) < 0.005);
  assert.ok(Math.abs(perf.total.net_sales - s.sales.amount) < 0.005);
});
check('无数据区间为空', () => assert.equal(getSalespersonPerformance(db, '2030-01-01', '2030-01-31').rows.length, 0));

db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
