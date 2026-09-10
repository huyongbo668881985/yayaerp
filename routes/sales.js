const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const { todayLocalDate } = require('../utils/dates');
const { costSnapshotPerBaseUnit } = require('../lib/priceCalc');
const { returnedAmountSubquery } = require('../lib/profitCalc');
const { isBlank, isValidDateString, isValidNonNegativeAmount, roundToCents } = require('../lib/validators');
const router = express.Router();

// 关联到某张销售单、且已审核的退货金额。
// 口径定义收敛在 lib/profitCalc.js（唯一实现点），这里按本地 SQL 别名（销售单一律用 so）取一份，
// 不再自己写第二遍——之前同一个子查询在 sales / report / dashboard / profitCalc 四处各写一份，
// 这本身就是"同一数字在不同页面对不上"的分叉根因（2026-09-08 收敛）。
const RETURNED_AMOUNT_SUBQUERY = returnedAmountSubquery('so');

// 状态机说明：
//   draft(草稿) --提交--> submitted(待审核) --审核通过--> approved(已审核)
//                submitted <--撤回-- (仅创建人/管理员，草稿态可继续编辑)
//                submitted --审核拒绝--> rejected(已拒绝)
//                approved/rejected --反审核--> submitted（仅管理员）
// 库存只在"审核通过"这一步才真正扣减；反审核会把已扣的库存加回来。
// 这样"撤回"和"拒绝"都不会污染库存，草稿/待审核阶段库存完全不受影响。

function canEditOrWithdraw(order, sessionUser) {
  return sessionUser.role === 'admin' || order.user_id === sessionUser.id;
}

function buildItemsFromRequest(db, body) {
  const { items_json } = body;
  let product_id, quantity, unit_price, unit_choice, is_gift;
  if (items_json) {
    // 前端把明细序列化成 JSON 提交；解析失败（极端情况下字段被篡改/截断）时按"没有明细"处理，
    // 让上层走"至少填写一行有效明细"的正常报错，而不是抛 SyntaxError 变成 500 兑底页。
    let parsed;
    try {
      parsed = JSON.parse(items_json);
    } catch (e) {
      parsed = [];
    }
    if (!Array.isArray(parsed)) parsed = [];
    product_id = parsed.map(i => i.id);
    quantity = parsed.map(i => i.quantity);
    unit_price = parsed.map(i => i.price);
    unit_choice = parsed.map(i => i.unit_choice || 'base');
    is_gift = parsed.map(i => (i.is_gift ? '1' : '0'));
  } else {
    product_id = body.product_id;
    quantity = body.quantity;
    unit_price = body.unit_price;
    unit_choice = body.unit_choice;
    is_gift = body.is_gift;
  }
  if (!Array.isArray(product_id)) product_id = [product_id];
  if (!Array.isArray(quantity)) quantity = [quantity];
  if (!Array.isArray(unit_price)) unit_price = [unit_price];
  if (!Array.isArray(unit_choice)) unit_choice = [unit_choice];
  if (!Array.isArray(is_gift)) is_gift = [is_gift];

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const items = [];
  for (let i = 0; i < product_id.length; i++) {
    const pid = Number(product_id[i]);
    const qty = Number(quantity[i]);
    let price = Number(unit_price[i]);
    const gift = is_gift[i] === '1' || is_gift[i] === true;
    // 数量必须是正整数：瓶/箱都不存在"半瓶"的录入场景，小数会让库存和金额统计出碎片（四处单据同规则）
    if (!pid || !(qty > 0) || !Number.isInteger(qty)) continue;
    const product = getProduct.get(pid);
    if (!product) continue;
    const invalidPrice = !gift && !isValidNonNegativeAmount(unit_price[i]);
    if (gift) price = 0;
    else if (Number.isFinite(price)) price = roundToCents(price);
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    // 成本快照：记下开单那一刻的成本价，之后改商品成本价不影响这张单的历史毛利。
    // 按箱录入且配了箱成本价时用 箱成本价÷箱规（共用 lib/priceCalc.js，与 returns.js 同一份实现），
    // 否则按箱开单会踩回"瓶价由箱价反算"的舍入误差，毛利系统性偏低。
    const costSnapshot = costSnapshotPerBaseUnit(product, unit_choice[i]);
    items.push({ pid, qty, price, invalidPrice, unitLabel, baseQty, costSnapshot, productName: product.name, gift });
  }
  return items;
}

// 按当前用户权限范围 + 可选日期范围，查询销售单列表（列表页和导出共用）
// 计算"有效"欠款和收款状态：原始金额、原始已收款字段完全不动（保留真实历史记录），
// 只是在读取展示的时候，把关联到这张单、已审核的退货金额顺带减掉。
// 这样退货金额=0也不影响没有关联退货的普通订单，是老逻辑的自然扩展，不是另一套逻辑。
function attachEffectivePayment(order) {
  const returned = order.returned_amount || 0;
  const effectiveTotal = order.total_amount - returned;
  const effectiveDebt = effectiveTotal - order.paid_amount;
  let effectiveStatus = 'unpaid';
  if (effectiveDebt <= 0.001) effectiveStatus = 'paid';
  else if (order.paid_amount > 0 || returned > 0) effectiveStatus = 'partial';
  order.returned_amount = returned;
  order.effective_total = effectiveTotal;
  order.effective_debt = Math.max(0, effectiveDebt);
  order.effective_status = effectiveStatus;
  return order;
}

function queryOrders(db, user, start, end, unpaidOnly) {
  let sql = `
    SELECT so.*, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name,
           ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    LEFT JOIN users u ON u.id = so.user_id
    WHERE 1=1
  `;
  const params = [];
  if (user.role !== 'admin') {
    sql += ' AND so.user_id = ?';
    params.push(user.id);
  }
  if (start) { sql += ' AND so.order_date >= ?'; params.push(start); }
  if (end) { sql += ' AND so.order_date <= ?'; params.push(end); }
  sql += ' ORDER BY so.id DESC';
  let orders = db.prepare(sql).all(...params).map(attachEffectivePayment);
  if (unpaidOnly) orders = orders.filter(o => o.effective_status !== 'paid');
  return orders;
}

// 销售单列表 - 管理员看全部，操作员看自己的；支持 ?start=&end= 按日期范围筛选，?unpaid=1 只看未结清
// 分页：每页 50 条。"只看未结清"是查询后按有效欠款在内存里过滤的，
// 所以先全量查询+过滤，再内存切片分页，保证筛选和分页的组合结果正确。
// （SQLite 本地查询几千行很快，真正的开销是渲染 HTML，只渲染当页即可。）
const SALES_PAGE_SIZE = 50;

router.get('/sales', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const { start, end } = req.query;
  const unpaidOnly = req.query.unpaid === '1';

  const allOrders = queryOrders(db, user, start, end, unpaidOnly);
  const totalOrders = allOrders.length;
  const totalPages = Math.max(1, Math.ceil(totalOrders / SALES_PAGE_SIZE));

  let page = parseInt(req.query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  if (page > totalPages) page = totalPages;

  const orders = allOrders.slice((page - 1) * SALES_PAGE_SIZE, page * SALES_PAGE_SIZE);
  res.render('sales', {
    orders, user, start: start || '', end: end || '', unpaidOnly,
    page, totalPages, totalOrders
  });
});

// 导出当前筛选范围内的销售单为 CSV
router.get('/sales/export', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const { start, end } = req.query;
  const unpaidOnly = req.query.unpaid === '1';

  let sql = `
    SELECT so.id AS order_id, so.order_date, so.warehouse_id, so.status,
           so.total_amount, so.paid_amount,
           ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount,
           so.remarks, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name,
           soi.quantity, soi.unit_label, soi.unit_price, soi.is_gift, p.name AS product_name
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    LEFT JOIN users u ON u.id = so.user_id
    JOIN sales_order_items soi ON soi.sales_order_id = so.id
    JOIN products p ON p.id = soi.product_id
    WHERE 1=1
  `;
  const params = [];
  if (user.role !== 'admin') { sql += ' AND so.user_id = ?'; params.push(user.id); }
  if (start) { sql += ' AND so.order_date >= ?'; params.push(start); }
  if (end) { sql += ' AND so.order_date <= ?'; params.push(end); }
  sql += ' ORDER BY so.id DESC';
  let rows_raw = db.prepare(sql).all(...params).map(r => {
    const effectiveTotal = r.total_amount - r.returned_amount;
    const effectiveDebt = effectiveTotal - r.paid_amount;
    r.effective_status = effectiveDebt <= 0.001 ? 'paid' : ((r.paid_amount > 0 || r.returned_amount > 0) ? 'partial' : 'unpaid');
    return r;
  });
  if (unpaidOnly) rows_raw = rows_raw.filter(r => r.effective_status !== 'paid');

  const statusText = { draft: '草稿', submitted: '待审核', approved: '已审核', rejected: '已拒绝' };
  const paymentText = { paid: '已收款', partial: '部分收款', unpaid: '未收款' };

  const headers = ['单号', '日期', '客户', '仓库', '商品', '数量', '单位', '单价', '小计', '是否赠品', '收款状态', '审核状态', '录入人', '备注'];
  const rows = rows_raw.map(r => [
    r.order_id,
    r.order_date,
    r.customer_name || '散客',
    r.warehouse_name,
    r.product_name,
    r.quantity,
    r.unit_label,
    r.unit_price.toFixed(2),
    (r.quantity * r.unit_price).toFixed(2),
    r.is_gift ? '赠品' : '',
    paymentText[r.effective_status] || r.effective_status,
    statusText[r.status] || r.status,
    r.user_name,
    r.remarks || ''
  ]);

  const rangeLabel = (start || end) ? `_${start || '起'}_${end || '止'}` : '';
  sendCsv(res, `销售单明细${rangeLabel}.csv`, headers, rows);
});

// 明细里是否有人工填入的负单价：数量、单价都没有下限校验的话，
// 可以录出总额为负的销售单，欠款/收款状态判定也会跟着异常。赠品价格固定为 0，不受影响。
function hasInvalidPrice(items) {
  return items.some(it => it.invalidPrice || !Number.isFinite(it.price) || it.price < 0);
}

// 销售单表单里客户下拉的数据范围：管理员看全部客户；操作员只看自己名下的。
// 编辑草稿单时额外带上这张单当前关联的客户——万一它后来被管理员转给了别人，
// 不然下拉里找不到它，表单提交时会被误清空。
function customersForForm(db, user, currentCustomerId) {
  if (user.role === 'admin') {
    return db.prepare('SELECT * FROM customers ORDER BY name').all();
  }
  return db.prepare('SELECT * FROM customers WHERE operator_id = ? OR id = ? ORDER BY name')
    .all(user.id, currentCustomerId || -1);
}

// 落库前服务端复检 customer_id 是否在当前用户可见范围内（与表单下拉 customersForForm 同一口径）：
// 管理员不受限；操作员只能用"自己名下"的客户；编辑草稿单时额外放行单据当前已关联的客户
// （防止管理员把客户转归属后，创建人编辑自己草稿单时反而被拦）。空值=散客，直接放行。
// 返回 true=允许；false=越权（调用方走 renderError，不要 500）。
function isCustomerInScope(db, sessionUser, customerId, currentCustomerId) {
  if (customerId === undefined || customerId === null || String(customerId).trim() === '') return true;
  if (sessionUser.role === 'admin') return true;
  const cid = Number(customerId);
  if (!Number.isInteger(cid) || cid <= 0) return false;
  const hit = db.prepare('SELECT id FROM customers WHERE id = ? AND (operator_id = ? OR id = ?)')
    .get(cid, sessionUser.id, currentCustomerId || -1);
  return !!hit;
}

router.get('/sales/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const customers = customersForForm(db, req.session.user, null);
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  res.render('sale_form', { customers, warehouses, products, error: null, order: null, existingItems: [], today: todayLocalDate() });
});

router.post('/sales/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { customer_id, warehouse_id, order_date, note, paid_amount, remarks } = req.body;

  const renderError = (msg) => {
    const customers = customersForForm(db, req.session.user, null);
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    return res.render('sale_form', { customers, warehouses, products, error: msg, order: null, existingItems: [], today: todayLocalDate() });
  };

  if (!isBlank(order_date) && !isValidDateString(order_date)) {
    res.status(400);
    return renderError('单据日期无效，请使用 YYYY-MM-DD 格式的真实日期');
  }

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择仓库并至少填写一行有效商品明细');
  }
  if (hasInvalidPrice(items)) {
    res.status(400);
    return renderError('销售单价必须是大于等于 0 的有效数字');
  }
  if (!isCustomerInScope(db, req.session.user, customer_id, null)) {
    return renderError('所选客户不在你的名下，无权使用：请选择自己负责的客户，或联系管理员处理');
  }

  // 草稿/待审核阶段不动库存，这里只做数据落库，不检查库存、不生成出入库流水
  // 点"存草稿"按钮会带 save_draft=1 → 存为 draft，之后在详情页继续编辑/提交审核
  const total = roundToCents(items.reduce((s, it) => s + it.qty * it.price, 0));
  if (!Number.isFinite(total) || total < 0) {
    res.status(400);
    return renderError('销售总额计算结果不合法，请检查商品数量和单价');
  }
  const paidRaw = isBlank(paid_amount) ? 0 : Number(paid_amount);
  if (!isValidNonNegativeAmount(paidRaw)) {
    res.status(400);
    return renderError('已收款金额必须是大于等于 0 的有效数字');
  }
  const paid = roundToCents(paidRaw);
  // 收款不能超过单据总额：多收的钱没有业务意义，还会把应收/欠款统计搞乱
  if (paid > total + 0.001) {
    res.status(400);
    return renderError(`收款金额（¥${paid.toFixed(2)}）不能超过单据总额（¥${total.toFixed(2)}）`);
  }
  let paymentStatus = 'unpaid';
  if (paid >= total && total > 0) paymentStatus = 'paid';
  else if (paid > 0) paymentStatus = 'partial';
  const status = (req.body.save_draft === '1' || req.body.save_draft === 'on') ? 'draft' : 'submitted';

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO sales_orders (customer_id, warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status, note, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(customer_id || null, warehouse_id, req.session.user.id, order_date || todayLocalDate(), total, paid, paymentStatus, status, note || '', remarks || '');
    const soId = info.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, is_gift, cost_price_snapshot) VALUES (?,?,?,?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(soId, it.pid, it.qty, it.unitLabel, it.baseQty, it.price, it.gift ? 1 : 0, it.costSnapshot);
    }
  });
  tx();

  res.redirect('/sales');
});

// 编辑草稿单（仅创建人或管理员，仅 draft 状态）
router.get('/sales/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的订单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的订单');

  const customers = customersForForm(db, req.session.user, order.customer_id);
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  const existingItems = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ?').all(order.id);
  res.render('sale_form', { customers, warehouses, products, error: null, order, existingItems, today: todayLocalDate() });
});

router.post('/sales/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的订单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的订单');

  const { customer_id, warehouse_id, order_date, note, paid_amount, remarks } = req.body;

  const renderError = (msg) => {
    const customers = customersForForm(db, req.session.user, order.customer_id);
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    const existingItems = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ?').all(order.id);
    return res.render('sale_form', { customers, warehouses, products, error: msg, order, existingItems, today: todayLocalDate() });
  };

  if (!isBlank(order_date) && !isValidDateString(order_date)) {
    res.status(400);
    return renderError('单据日期无效，请使用 YYYY-MM-DD 格式的真实日期');
  }

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择仓库并至少填写一行有效商品明细');
  }
  if (hasInvalidPrice(items)) {
    res.status(400);
    return renderError('销售单价必须是大于等于 0 的有效数字');
  }
  // 编辑时额外放行"单据当前已关联的客户"：管理员可能已把客户转给别人，
  // 但创建人编辑自己草稿单时不应因此被拦（与下拉框 customersForForm 的 OR id=? 同口径）。
  if (!isCustomerInScope(db, req.session.user, customer_id, order.customer_id)) {
    return renderError('所选客户不在你的名下，无权使用：请选择自己负责的客户，或联系管理员处理');
  }

  const total = roundToCents(items.reduce((s, it) => s + it.qty * it.price, 0));
  if (!Number.isFinite(total) || total < 0) {
    res.status(400);
    return renderError('销售总额计算结果不合法，请检查商品数量和单价');
  }
  const paidRaw = isBlank(paid_amount) ? 0 : Number(paid_amount);
  if (!isValidNonNegativeAmount(paidRaw)) {
    res.status(400);
    return renderError('已收款金额必须是大于等于 0 的有效数字');
  }
  const paid = roundToCents(paidRaw);
  // 与新建单一致：收款不能超过单据总额
  if (paid > total + 0.001) {
    res.status(400);
    return renderError(`收款金额（¥${paid.toFixed(2)}）不能超过单据总额（¥${total.toFixed(2)}）`);
  }
  let paymentStatus = 'unpaid';
  if (paid >= total && total > 0) paymentStatus = 'paid';
  else if (paid > 0) paymentStatus = 'partial';

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE sales_orders SET customer_id=?, warehouse_id=?, order_date=?, total_amount=?, paid_amount=?, payment_status=?, note=?, remarks=? WHERE id=?`
    ).run(customer_id || null, warehouse_id, order_date || order.order_date, total, paid, paymentStatus, note || '', remarks || '', order.id);
    db.prepare('DELETE FROM sales_order_items WHERE sales_order_id = ?').run(order.id);
    const insertItem = db.prepare('INSERT INTO sales_order_items (sales_order_id, product_id, quantity, unit_label, base_quantity, unit_price, is_gift, cost_price_snapshot) VALUES (?,?,?,?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(order.id, it.pid, it.qty, it.unitLabel, it.baseQty, it.price, it.gift ? 1 : 0, it.costSnapshot);
    }
  });
  tx();

  res.redirect('/sales/' + order.id);
});

// 提交审核：draft -> submitted
router.post('/sales/submit/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态可以提交审核');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限');
  db.prepare("UPDATE sales_orders SET status = 'submitted' WHERE id = ?").run(order.id);
  res.redirect('/sales/' + order.id);
});

// 撤回：submitted -> draft（撤回后可以编辑修改，库存此前未扣减，无需处理）
router.post('/sales/withdraw/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限撤回他人的订单');
  db.prepare("UPDATE sales_orders SET status = 'draft' WHERE id = ?").run(order.id);
  res.redirect('/sales/' + order.id);
});

// 审核通过：submitted -> approved（这里才真正扣库存，扣减前重新校验库存是否充足）
router.post('/sales/approve/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以审核通过');

  const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ?').all(order.id);

  // 库存校验必须按商品汇总后再比：同一商品拆成多行明细时（比如库存 15、两行各 10），
  // 逐行检查每一行都能通过（检查时库存还没扣），事务里第二行才扣成负数，
  // 被 inventory 的 CHECK(quantity>=0) 拦下后用户只能看到全局兑底的泛化报错。先汇总就能给出准确提示。
  const needed = new Map(); // product_id -> 应扣总数量（基础单位）
  for (const it of items) {
    needed.set(it.product_id, (needed.get(it.product_id) || 0) + it.base_quantity);
  }
  const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
  for (const [pid, totalQty] of needed) {
    const inv = getInv.get(pid, order.warehouse_id);
    const have = inv ? inv.quantity : 0;
    if (have < totalQty) {
      const p = db.prepare('SELECT name FROM products WHERE id=?').get(pid);
      return res.status(400).send(`审核失败：${p ? p.name : '商品'} 当前库存 ${have}，不足以扣减合计 ${totalQty}，请联系提交人调整数量或先补货`);
    }
  }

  const tx = db.transaction(() => {
    const decInv = db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id=? AND warehouse_id=?');
    const insertTxn = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'sale_out','sales_order',?,?)
    `);
    for (const it of items) {
      decInv.run(it.base_quantity, it.product_id, order.warehouse_id);
      insertTxn.run(it.product_id, order.warehouse_id, -it.base_quantity, order.id, req.session.user.id);
    }
    db.prepare("UPDATE sales_orders SET status = 'approved' WHERE id = ?").run(order.id);
  });
  tx();

  res.redirect('/sales/' + order.id);
});

// 审核拒绝：submitted -> rejected（库存此前未扣减，无需处理）
router.post('/sales/reject/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以拒绝');
  db.prepare("UPDATE sales_orders SET status = 'rejected' WHERE id = ?").run(order.id);
  res.redirect('/sales/' + order.id);
});

// 反审核：approved/rejected -> submitted（如果原本是 approved，要把已经扣掉的库存加回来）
router.post('/sales/unapprove/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'approved' && order.status !== 'rejected') {
    return res.status(400).send('只有已审核或已拒绝状态可以反审核');
  }

  // 反审核前先挡一道：逆向加回库存这件事，不能和任何"已经把货加回库存"的退货单叠加。
  // 退货审核通过时会把退回的货加进它自己的仓库（见 returns.js 的 approve），
  // 这里如果再把整单的库存加回去，同一批货就被加了两次，库存凭空多出来。
  //   1) 直接关联本单的已审核退货 —— 必然是同一批货，无条件拦；
  //   2) 同一仓库、未关联销售单的"自由退货"，且与本单商品有交集、日期不早于本单
  //      —— 这类退货很可能就是本单退回来的货（当时没填关联单号），同样会重复加回。
  //      加"商品有交集 + 日期 >= 本单日期"这两个条件，是为了不误伤更早的、明显无关的历史退货单，
  //      否则一个仓库里只要有过任何一张自由退货，该仓库所有销售单就永远无法反审核了。
  if (order.status === 'approved') {
    const linkedReturns = db.prepare(
      `SELECT id FROM return_orders WHERE related_sales_order_id = ? AND status = 'approved' ORDER BY id`
    ).all(order.id);
    // order_date 建单时有 todayLocalDate() 兜底，理论上有值；万一为空则传 ''，
    // 字符串比较下所有非空日期都 >= ''，等于退化成"不按日期过滤"——宁可多拦，不可漏拦。
    const conflictingFreeReturns = db.prepare(`
      SELECT DISTINCT ro.id
      FROM return_orders ro
      JOIN return_order_items roi ON roi.return_order_id = ro.id
      WHERE ro.status = 'approved'
        AND ro.related_sales_order_id IS NULL
        AND ro.warehouse_id = ?
        AND ro.order_date >= ?
        AND roi.product_id IN (SELECT product_id FROM sales_order_items WHERE sales_order_id = ?)
      ORDER BY ro.id
    `).all(order.warehouse_id, order.order_date || '', order.id);

    const conflicts = linkedReturns.concat(conflictingFreeReturns);
    if (conflicts.length > 0) {
      const ids = conflicts.map(r => '#' + r.id).join('、');
      return res.status(400).send(
        `反审核失败：本仓库（或直接关联本单）的已审核退货单 ${ids} 与这张销售单存在商品重叠。` +
        `这些退货审核通过时已经把退回的货加回了库存，直接反审核本单会把同一批货重复加回、导致库存虚增。` +
        `请先反审核这些退货单，再来反审核本销售单。`
      );
    }
  }

  const tx = db.transaction(() => {
    if (order.status === 'approved') {
      // 把审核通过时扣掉的库存加回来
      const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ?').all(order.id);
      const upsertInv = db.prepare(`
        INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = quantity + excluded.quantity
      `);
      // type 用 adjust 而不是沿用 sale_out：这笔流水的 change_qty 是正数（把扣掉的加回来），
      // 还标"销售出库"的话，流水页会出现"销售出库 +10"这种自相矛盾的记录，按类型汇总也会算错。
      // ref_type 保留 sales_order_unapprove，能追溯到是哪张单的反审核。
      const insertTxn = db.prepare(`
        INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
        VALUES (?,?,?,'adjust','sales_order_unapprove',?,?)
      `);
      for (const it of items) {
        upsertInv.run(it.product_id, order.warehouse_id, it.base_quantity);
        insertTxn.run(it.product_id, order.warehouse_id, it.base_quantity, order.id, req.session.user.id);
      }
    }
    db.prepare("UPDATE sales_orders SET status = 'submitted' WHERE id = ?").run(order.id);
  });
  tx();

  res.redirect('/sales/' + order.id);
});

// 记录收款：客户分批还钱、或者退货冲抵之后补齐尾款，都用这个。
// 只加 paid_amount，不碰审核状态、不碰库存、不碰商品明细——跟"审核"是完全独立的两件事。
// 只允许对已审核的单子收款：草稿还没定稿、被拒绝的单子不该发生真实收款。
router.post('/sales/:id/record-payment', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限，只有管理员能记录收款');
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'approved') {
    return res.status(400).send('只有已审核的销售单可以记录收款');
  }

  const amountRaw = Number(req.body.amount);
  if (!Number.isFinite(amountRaw) || !(amountRaw > 0)) return res.status(400).send('收款金额必须是大于 0 的有效数字');
  const amount = roundToCents(amountRaw);
  if (!(amount > 0)) return res.status(400).send('收款金额四舍五入到分后必须大于 0');

  // 收款累计不能超过"有效欠款"：总额 − 已收 − 关联已审核退货（允许 0.001 浮点误差）。
  // 必须与详情页展示的欠款（attachEffectivePayment 的 effective_debt）同一套算法：
  // 页面欠款扣了退货、服务端封顶不扣的话，退货抵扣过的那部分钱还能再现金收一遍（双重收取）。
  const returnedAmount = db.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS t FROM return_orders WHERE related_sales_order_id = ? AND status = 'approved'`
  ).get(order.id).t;
  const remaining = order.total_amount - (order.paid_amount || 0) - returnedAmount;
  if (remaining <= 0.001) {
    return res.status(400).send(
      `该单有效欠款已结清（总额 ¥${order.total_amount.toFixed(2)}，已收 ¥${(order.paid_amount || 0).toFixed(2)}` +
      `，已扣关联退货 ¥${returnedAmount.toFixed(2)}），无需再记收款`
    );
  }
  if (amount > remaining + 0.001) {
    return res.status(400).send(`收款金额（¥${amount.toFixed(2)}）超过该单剩余未收金额（¥${remaining.toFixed(2)}），最多还能收 ¥${remaining.toFixed(2)}`);
  }

  // payment_status 必须跟着 paid_amount 一起更新，不能只加金额不改状态
  // （以前漏了这行，导致"建单时只收定金、后来补完全款"的单子状态永远停在 partial）。
  //
  // 注意它的语义（2026-09-08 明确）：这里只记**现金收款进度**——实收现金相对单据金额收了多少，
  // 不做退货抵扣。真正的"是否已结清"一律由「有效欠款 = 金额 − 已收 − 关联已审核退货」现算，
  // 见 lib/profitCalc.js 的 salesSettledExpr，列表页/详情页/首页/报表全部走那一套。
  // 以前让 payment_status 兼职"结清判定"，落库快照追不上退货单的审核/反审核，
  // 定金 + 退货抵扣结清的单子会永远停在 partial，两边对不上账。
  const newPaid = roundToCents((order.paid_amount || 0) + amount);
  let paymentStatus = 'unpaid';
  if (order.total_amount > 0 && newPaid >= order.total_amount) paymentStatus = 'paid';
  else if (newPaid > 0) paymentStatus = 'partial';

  db.prepare('UPDATE sales_orders SET paid_amount = ?, payment_status = ? WHERE id = ?')
    .run(newPaid, paymentStatus, order.id);
  res.redirect('/sales/' + order.id);
});

router.get('/sales/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare(`
    SELECT so.*, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name,
           ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    LEFT JOIN users u ON u.id = so.user_id
    WHERE so.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  // 列表页按"管理员看全部、操作员只看自己的"过滤，详情页必须跟上同样的口径，
  // 否则操作员手输 /sales/123 就能看到别人单据的客户、金额和商品明细。
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限查看他人的销售单');
  attachEffectivePayment(order);
  const items = db.prepare(`
    SELECT soi.*, p.name AS product_name
    FROM sales_order_items soi
    JOIN products p ON p.id = soi.product_id
    WHERE soi.sales_order_id = ?
  `).all(req.params.id);
  const relatedReturns = db.prepare(`
    SELECT id, order_date, total_amount, refund_status, status
    FROM return_orders WHERE related_sales_order_id = ? ORDER BY id DESC
  `).all(req.params.id);
  res.render('sale_detail', { order, items, relatedReturns, canManage: canEditOrWithdraw(order, req.session.user) });
});

module.exports = router;

// 供 API v1（routes/apiV1.js）复用：有效欠款/收款状态算法与 Web 列表页保持同一份实现
module.exports.attachEffectivePayment = attachEffectivePayment;
