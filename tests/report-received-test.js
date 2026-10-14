// 经营报表「实收金额」口径：已审核销售单已收款 − 关联退货已退现金，按销售单日期归属区间。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openTenantDbByPath } = require('../lib/tenantManager');
const { getSummary } = require('../routes/report');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-report-received-'));
const db = openTenantDbByPath(path.join(dir, 'tenant.db'));
let failed = 0;
const check = (label, fn) => {
  try { fn(); console.log('  ✓ ' + label); }
  catch (err) { failed++; console.error('  ✗ ' + label + ': ' + err.message); }
};

db.prepare("INSERT INTO users (username, password_hash, name, role) VALUES ('admin', 'unused', '测试管理员', 'admin')").run();
db.prepare("INSERT INTO warehouses (name) VALUES ('测试仓库')").run();

const sale = (date, total, paid, status = 'approved') => Number(db.prepare(`INSERT INTO sales_orders
  (warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status)
  VALUES (1, 1, ?, ?, ?, 'partial', ?)`).run(date, total, paid, status).lastInsertRowid);
const ret = (date, total, refunded, related) => db.prepare(`INSERT INTO return_orders
  (warehouse_id, user_id, order_date, total_amount, refunded_amount, refund_status, status, related_sales_order_id, exception_reason)
  VALUES (1, 1, ?, ?, ?, 'partial', 'approved', ?, '测试')`).run(date, total, refunded, related);

console.log('经营报表 实收金额');
const a = sale('2026-10-01', 100, 100);          // 全款
const b = sale('2026-10-02', 200, 50);           // 部分收款，欠 150
const c = sale('2026-10-03', 300, 300);          // 全款后退货 100 并退现金 100
ret('2026-10-04', 100, 100, c);
sale('2026-10-05', 500, 500, 'draft');           // 草稿不计入
sale('2026-09-01', 999, 999);                    // 区间外不计入

const s = getSummary(db, '2026-10-01', '2026-10-31');
check('实收 = 100 + 50 + (300-100) = 350', () => assert.equal(s.received, 350));
check('应收 = 150（与实收口径不冲突）', () => assert.equal(s.receivable.amount, 150));
check('销售额（已扣退货）= 600 − 100 = 500', () => assert.equal(s.sales.amount, 500));
check('销售额 − 应收 = 实收（无跨区间/多收时恒等）', () => assert.equal(s.sales.amount - s.receivable.amount, s.received));
check('日期过滤：仅 9 月 → 实收 999', () => assert.equal(getSummary(db, '2026-09-01', '2026-09-30').received, 999));
check('无数据区间 → 实收 0', () => assert.equal(getSummary(db, '2030-01-01', '2030-01-31').received, 0));

// 退货仅抵扣欠款、未退现金：实收不变
const d = sale('2026-11-01', 100, 40);
ret('2026-11-02', 60, 0, d);
check('退货抵扣未退现金 → 实收 40，应收 0', () => {
  const t = getSummary(db, '2026-11-01', '2026-11-30');
  assert.equal(t.received, 40);
  assert.equal(t.receivable.amount, 0);
});

db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
