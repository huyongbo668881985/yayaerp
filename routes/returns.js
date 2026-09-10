const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const { todayLocalDate } = require('../utils/dates');
const { costSnapshotPerBaseUnit } = require('../lib/priceCalc');
const { isBlank, isValidDateString, isValidNonNegativeAmount, roundToCents } = require('../lib/validators');
const router = express.Router();

// 状态机跟销售单一致：submitted --审核通过--> approved（这一步才真正把库存加回去）
//                      submitted --审核拒绝--> rejected
//                      approved/rejected --反审核--> submitted（approved 需要把加回去的库存再扣回来，
//                      扣之前要检查库存够不够——如果这批货已经又被卖出去了，硬扣会拉成负库存）
// 退货不要求关联具体的原始销售单（按你的要求做成自由录入），所以数量上系统不做"不能超过原销售数量"的校验。
// 但关联了销售单的退货，必须在销售单"已审核"（approved）的前提下才能审核通过：
// 库存是销售审核时才扣的，货还没出库就退货入库，库存会凭空多出来。

const SALE_STATUS_TEXT = { draft: '草稿', submitted: '待审核', approved: '已审核', rejected: '已拒绝' };

function canEditOrWithdraw(order, sessionUser) {
  return sessionUser.role === 'admin' || order.user_id === sessionUser.id;
}

function buildItemsFromRequest(db, body) {
  const { items_json } = body;
  let product_id, quantity, unit_price, unit_choice;
  if (items_json) {
    // 解析失败按"没有明细"处理，走上层正常报错，而不是抛 SyntaxError 变成 500 兑底页
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
  } else {
    product_id = body.product_id;
    quantity = body.quantity;
    unit_price = body.unit_price;
    unit_choice = body.unit_choice;
  }
  if (!Array.isArray(product_id)) product_id = [product_id];
  if (!Array.isArray(quantity)) quantity = [quantity];
  if (!Array.isArray(unit_price)) unit_price = [unit_price];
  if (!Array.isArray(unit_choice)) unit_choice = [unit_choice];

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const items = [];
  for (let i = 0; i < product_id.length; i++) {
    const pid = Number(product_id[i]);
    const qty = Number(quantity[i]);
    const price = Number(unit_price[i]);
    // 数量必须是正整数（与 sales.js 同规则）
    if (!pid || !(qty > 0) || !Number.isInteger(qty)) continue;
    const product = getProduct.get(pid);
    if (!product) continue;
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    // 成本快照：与销售单一致（共用 lib/priceCalc.js），按箱录入且配了箱成本价时用 箱成本价÷箱规，
    // 退货毛利也按开单那一刻、不踩舍入误差的成本价计算
    const costSnapshot = costSnapshotPerBaseUnit(product, unit_choice[i]);
    items.push({
      pid, qty, price: Number.isFinite(price) ? roundToCents(price) : price,
      invalidPrice: !isValidNonNegativeAmount(unit_price[i]),
      unitLabel, baseQty, costSnapshot, productName: product.name
    });
  }
  return items;
}

/**
 * 关联退货的完整业务校验。自由退货不会调用这里。
 * 创建/编辑时校验一次，审核前再校验一次，防止两张待审核退货同时占用同一可退额度。
 */
function validateLinkedReturn(db, {
  relatedSaleId, customerId, items, sessionUser, excludeReturnId = null
}) {
  const sale = db.prepare('SELECT id, status, customer_id, user_id FROM sales_orders WHERE id = ?')
    .get(relatedSaleId);
  if (!sale) return `关联的销售单号 #${relatedSaleId} 不存在，请检查单号是否正确`;
  if (sale.status !== 'approved') {
    const statusLabel = SALE_STATUS_TEXT[sale.status] || sale.status;
    return `关联的销售单 #${relatedSaleId} 当前状态为"${statusLabel}"，只有已审核（库存已扣减）的销售单才能关联退货`;
  }
  if (!canEditOrWithdraw(sale, sessionUser)) {
    return `无权关联销售单 #${relatedSaleId}：操作员只能为自己录入的销售单办理关联退货`;
  }

  const normalizedCustomerId = isBlank(customerId) ? null : Number(customerId);
  if (normalizedCustomerId !== sale.customer_id) {
    return `退货客户必须与关联销售单 #${relatedSaleId} 的客户一致`;
  }

  const soldRows = db.prepare(`
    SELECT soi.product_id, p.name AS product_name,
           SUM(soi.base_quantity) AS sold_quantity,
           SUM(soi.quantity * soi.unit_price) AS sold_amount
    FROM sales_order_items soi
    JOIN products p ON p.id = soi.product_id
    WHERE soi.sales_order_id = ?
    GROUP BY soi.product_id, p.name
  `).all(sale.id);
  const soldByProduct = new Map(soldRows.map(row => [row.product_id, row]));

  const previousRows = db.prepare(`
    SELECT roi.product_id,
           SUM(roi.base_quantity) AS returned_quantity,
           SUM(roi.quantity * roi.unit_price) AS returned_amount
    FROM return_order_items roi
    JOIN return_orders ro ON ro.id = roi.return_order_id
    WHERE ro.related_sales_order_id = ? AND ro.status = 'approved' AND ro.id <> ?
    GROUP BY roi.product_id
  `).all(sale.id, excludeReturnId || -1);
  const previousByProduct = new Map(previousRows.map(row => [row.product_id, row]));

  const currentByProduct = new Map();
  for (const item of items) {
    const productId = Number(item.pid ?? item.product_id);
    const quantity = Number(item.baseQty ?? item.base_quantity);
    const amount = Number(item.qty ?? item.quantity) * Number(item.price ?? item.unit_price);
    const current = currentByProduct.get(productId) || { quantity: 0, amount: 0 };
    current.quantity += quantity;
    current.amount += amount;
    currentByProduct.set(productId, current);
  }

  for (const [productId, current] of currentByProduct) {
    const sold = soldByProduct.get(productId);
    if (!sold) {
      const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
      return `退货商品“${product ? product.name : productId}”不在关联销售单 #${sale.id} 中`;
    }
    const previous = previousByProduct.get(productId) || { returned_quantity: 0, returned_amount: 0 };
    const cumulativeQuantity = Number(previous.returned_quantity || 0) + current.quantity;
    if (cumulativeQuantity > Number(sold.sold_quantity)) {
      const remaining = Math.max(0, Number(sold.sold_quantity) - Number(previous.returned_quantity || 0));
      return `商品“${sold.product_name}”退货数量超过可退数量：本次 ${current.quantity}，最多还可退 ${remaining}`;
    }
    const cumulativeAmount = Number(previous.returned_amount || 0) + current.amount;
    if (cumulativeAmount > Number(sold.sold_amount) + 0.001) {
      const remaining = Math.max(0, Number(sold.sold_amount) - Number(previous.returned_amount || 0));
      return `商品“${sold.product_name}”退货金额超过可退金额：本次 ¥${current.amount.toFixed(2)}，最多还可退 ¥${remaining.toFixed(2)}`;
    }
  }
  return null;
}

// 明细里的人工负单价校验（与 sales.js 同口径）：负价退货会算出负的退款额和毛利
function hasInvalidPrice(items) {
  return items.some(it => it.invalidPrice || !Number.isFinite(it.price) || it.price < 0);
}

function queryOrders(db, user, start, end) {
  let sql = `
    SELECT ro.*, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name
    FROM return_orders ro
    LEFT JOIN customers c ON c.id = ro.customer_id
    LEFT JOIN warehouses w ON w.id = ro.warehouse_id
    LEFT JOIN users u ON u.id = ro.user_id
    WHERE 1=1
  `;
  const params = [];
  if (user.role !== 'admin') { sql += ' AND ro.user_id = ?'; params.push(user.id); }
  if (start) { sql += ' AND ro.order_date >= ?'; params.push(start); }
  if (end) { sql += ' AND ro.order_date <= ?'; params.push(end); }
  sql += ' ORDER BY ro.id DESC';
  return db.prepare(sql).all(...params);
}

router.get('/returns', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const { start, end } = req.query;
  const orders = queryOrders(db, user, start, end);
  res.render('returns', { orders, user, start: start || '', end: end || '' });
});

router.get('/returns/export', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const { start, end } = req.query;

  let sql = `
    SELECT ro.id AS order_id, ro.order_date, ro.refund_status, ro.status,
           ro.remarks, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name,
           roi.quantity, roi.unit_label, roi.unit_price, p.name AS product_name
    FROM return_orders ro
    LEFT JOIN customers c ON c.id = ro.customer_id
    LEFT JOIN warehouses w ON w.id = ro.warehouse_id
    LEFT JOIN users u ON u.id = ro.user_id
    JOIN return_order_items roi ON roi.return_order_id = ro.id
    JOIN products p ON p.id = roi.product_id
    WHERE 1=1
  `;
  const params = [];
  if (user.role !== 'admin') { sql += ' AND ro.user_id = ?'; params.push(user.id); }
  if (start) { sql += ' AND ro.order_date >= ?'; params.push(start); }
  if (end) { sql += ' AND ro.order_date <= ?'; params.push(end); }
  sql += ' ORDER BY ro.id DESC';
  const rows = db.prepare(sql).all(...params);

  const statusText = { draft: '草稿', submitted: '待审核', approved: '已审核', rejected: '已拒绝' };
  const refundText = { unrefunded: '未退款', partial: '部分退款', refunded: '已退款' };
  const headers = ['单号', '日期', '客户', '仓库', '商品', '数量', '单位', '单价', '小计', '退款状态', '审核状态', '录入人', '备注'];
  const csvRows = rows.map(r => [
    r.order_id, r.order_date, r.customer_name || '散客', r.warehouse_name, r.product_name,
    r.quantity, r.unit_label, r.unit_price.toFixed(2), (r.quantity * r.unit_price).toFixed(2),
    refundText[r.refund_status] || r.refund_status, statusText[r.status] || r.status, r.user_name, r.remarks || ''
  ]);
  sendCsv(res, `退货单_${start || '起'}_${end || '止'}.csv`, headers, csvRows);
});

// 退货单表单里客户下拉的数据范围：与 sales.js 的 customersForForm 同口径——
// 管理员看全部；操作员只看自己名下的（编辑草稿时额外带上单据当前关联的客户，防误清空）
function customersForForm(db, user, currentCustomerId) {
  if (user.role === 'admin') {
    return db.prepare('SELECT * FROM customers ORDER BY name').all();
  }
  return db.prepare('SELECT * FROM customers WHERE operator_id = ? OR id = ? ORDER BY name')
    .all(user.id, currentCustomerId || -1);
}

// 落库前服务端复检 customer_id 是否在当前用户可见范围内（与表单下拉 customersForForm 同一口径）：
// 管理员不受限；操作员只能用"自己名下"的客户；编辑草稿单时额外放行单据当前已关联的客户。
// 空值=散客，直接放行。返回 true=允许；false=越权（调用方走 renderError，不要 500）。
function isCustomerInScope(db, sessionUser, customerId, currentCustomerId) {
  if (customerId === undefined || customerId === null || String(customerId).trim() === '') return true;
  if (sessionUser.role === 'admin') return true;
  const cid = Number(customerId);
  if (!Number.isInteger(cid) || cid <= 0) return false;
  const hit = db.prepare('SELECT id FROM customers WHERE id = ? AND (operator_id = ? OR id = ?)')
    .get(cid, sessionUser.id, currentCustomerId || -1);
  return !!hit;
}

router.get('/returns/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const customers = customersForForm(db, req.session.user, null);
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  res.render('return_form', { customers, warehouses, products, error: null, order: null, existingItems: [], today: todayLocalDate() });
});

router.post('/returns/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { customer_id, warehouse_id, order_date, note, refunded_amount, remarks, related_sales_order_id } = req.body;

  const renderError = (msg) => {
    const customers = customersForForm(db, req.session.user, null);
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    return res.render('return_form', { customers, warehouses, products, error: msg, order: null, existingItems: [], today: todayLocalDate() });
  };

  if (!isBlank(order_date) && !isValidDateString(order_date)) {
    res.status(400);
    return renderError('单据日期无效，请使用 YYYY-MM-DD 格式的真实日期');
  }

  const relatedId = related_sales_order_id && related_sales_order_id.trim()
    ? related_sales_order_id.trim() : null;

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择退回的仓库并至少填写一行有效商品明细');
  }
  if (hasInvalidPrice(items)) {
    res.status(400);
    return renderError('退货单价必须是大于等于 0 的有效数字');
  }
  if (!isCustomerInScope(db, req.session.user, customer_id, null)) {
    return renderError('所选客户不在你的名下，无权使用：请选择自己负责的客户，或联系管理员处理');
  }
  if (relatedId) {
    const relatedError = validateLinkedReturn(db, {
      relatedSaleId: relatedId,
      customerId: customer_id,
      items,
      sessionUser: req.session.user
    });
    if (relatedError) {
      res.status(400);
      return renderError(relatedError);
    }
  }

  const total = roundToCents(items.reduce((s, it) => s + it.qty * it.price, 0));
  if (!Number.isFinite(total) || total < 0) {
    res.status(400);
    return renderError('退货总额计算结果不合法，请检查商品数量和单价');
  }
  const refundedRaw = isBlank(refunded_amount) ? 0 : Number(refunded_amount);
  if (!isValidNonNegativeAmount(refundedRaw)) {
    res.status(400);
    return renderError('已退款金额必须是大于等于 0 的有效数字');
  }
  const refunded = roundToCents(refundedRaw);
  // 退款不能超过退货总额：多退的钱没有业务意义，还会把退款状态/报表搞乱
  if (refunded > total + 0.001) {
    res.status(400);
    return renderError(`退款金额（¥${refunded.toFixed(2)}）不能超过退货总额（¥${total.toFixed(2)}）`);
  }
  let refundStatus = 'unrefunded';
  if (refunded >= total && total > 0) refundStatus = 'refunded';
  else if (refunded > 0) refundStatus = 'partial';
  // 点"存草稿"按钮会带 save_draft=1 → 存为 draft，之后在详情页继续编辑/提交审核
  const status = (req.body.save_draft === '1' || req.body.save_draft === 'on') ? 'draft' : 'submitted';

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO return_orders (customer_id, warehouse_id, user_id, related_sales_order_id, order_date, total_amount, refunded_amount, refund_status, status, note, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(customer_id || null, warehouse_id, req.session.user.id, relatedId, order_date || todayLocalDate(), total, refunded, refundStatus, status, note || '', remarks || '');
    const roId = info.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO return_order_items (return_order_id, product_id, quantity, unit_label, base_quantity, unit_price, cost_price_snapshot) VALUES (?,?,?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(roId, it.pid, it.qty, it.unitLabel, it.baseQty, it.price, it.costSnapshot);
    }
  });
  tx();

  res.redirect('/returns');
});

router.get('/returns/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的退货单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的退货单');

  const customers = customersForForm(db, req.session.user, order.customer_id);
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  const existingItems = db.prepare('SELECT * FROM return_order_items WHERE return_order_id = ?').all(order.id);
  res.render('return_form', { customers, warehouses, products, error: null, order, existingItems, today: todayLocalDate() });
});

router.post('/returns/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的退货单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的退货单');

  const { customer_id, warehouse_id, order_date, note, refunded_amount, remarks, related_sales_order_id } = req.body;

  const renderError = (msg) => {
    const customers = customersForForm(db, req.session.user, order.customer_id);
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    const existingItems = db.prepare('SELECT * FROM return_order_items WHERE return_order_id = ?').all(order.id);
    return res.render('return_form', { customers, warehouses, products, error: msg, order, existingItems, today: todayLocalDate() });
  };

  if (!isBlank(order_date) && !isValidDateString(order_date)) {
    res.status(400);
    return renderError('单据日期无效，请使用 YYYY-MM-DD 格式的真实日期');
  }

  const relatedId = related_sales_order_id && related_sales_order_id.trim()
    ? related_sales_order_id.trim() : null;

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择退回的仓库并至少填写一行有效商品明细');
  }
  if (hasInvalidPrice(items)) {
    res.status(400);
    return renderError('退货单价必须是大于等于 0 的有效数字');
  }
  // 编辑时额外放行"单据当前已关联的客户"（与下拉框 customersForForm 的 OR id=? 同口径）
  if (!isCustomerInScope(db, req.session.user, customer_id, order.customer_id)) {
    return renderError('所选客户不在你的名下，无权使用：请选择自己负责的客户，或联系管理员处理');
  }
  if (relatedId) {
    const relatedError = validateLinkedReturn(db, {
      relatedSaleId: relatedId,
      customerId: customer_id,
      items,
      sessionUser: req.session.user,
      excludeReturnId: order.id
    });
    if (relatedError) {
      res.status(400);
      return renderError(relatedError);
    }
  }

  const total = roundToCents(items.reduce((s, it) => s + it.qty * it.price, 0));
  if (!Number.isFinite(total) || total < 0) {
    res.status(400);
    return renderError('退货总额计算结果不合法，请检查商品数量和单价');
  }
  const refundedRaw = isBlank(refunded_amount) ? 0 : Number(refunded_amount);
  if (!isValidNonNegativeAmount(refundedRaw)) {
    res.status(400);
    return renderError('已退款金额必须是大于等于 0 的有效数字');
  }
  const refunded = roundToCents(refundedRaw);
  // 与新建单一致：退款不能超过退货总额
  if (refunded > total + 0.001) {
    res.status(400);
    return renderError(`退款金额（¥${refunded.toFixed(2)}）不能超过退货总额（¥${total.toFixed(2)}）`);
  }
  let refundStatus = 'unrefunded';
  if (refunded >= total && total > 0) refundStatus = 'refunded';
  else if (refunded > 0) refundStatus = 'partial';

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE return_orders SET customer_id=?, warehouse_id=?, related_sales_order_id=?, order_date=?, total_amount=?, refunded_amount=?, refund_status=?, note=?, remarks=? WHERE id=?`
    ).run(customer_id || null, warehouse_id, relatedId, order_date || order.order_date, total, refunded, refundStatus, note || '', remarks || '', order.id);
    db.prepare('DELETE FROM return_order_items WHERE return_order_id = ?').run(order.id);
    const insertItem = db.prepare('INSERT INTO return_order_items (return_order_id, product_id, quantity, unit_label, base_quantity, unit_price, cost_price_snapshot) VALUES (?,?,?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(order.id, it.pid, it.qty, it.unitLabel, it.baseQty, it.price, it.costSnapshot);
    }
  });
  tx();

  res.redirect('/returns/' + order.id);
});

router.post('/returns/submit/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态可以提交审核');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限');
  db.prepare("UPDATE return_orders SET status = 'submitted' WHERE id = ?").run(order.id);
  res.redirect('/returns/' + order.id);
});

router.post('/returns/withdraw/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限撤回他人的退货单');
  db.prepare("UPDATE return_orders SET status = 'draft' WHERE id = ?").run(order.id);
  res.redirect('/returns/' + order.id);
});

// 审核通过：submitted -> approved，这一步把退回来的货真正加进库存
router.post('/returns/approve/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以审核通过');

  let approvalError = null;
  const tx = db.transaction(() => {
    const items = db.prepare('SELECT * FROM return_order_items WHERE return_order_id = ?').all(order.id);
    // 校验与写库存放在同一事务里，避免两张待审核退货同时读取到相同的剩余额度后都通过。
    if (order.related_sales_order_id) {
      approvalError = validateLinkedReturn(db, {
        relatedSaleId: order.related_sales_order_id,
        customerId: order.customer_id,
        items,
        sessionUser: req.session.user,
        excludeReturnId: order.id
      });
      if (approvalError) return;
    }
    const upsertInv = db.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
      ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `);
    const insertTxn = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'sale_return','return_order',?,?)
    `);
    for (const it of items) {
      upsertInv.run(it.product_id, order.warehouse_id, it.base_quantity);
      insertTxn.run(it.product_id, order.warehouse_id, it.base_quantity, order.id, req.session.user.id);
    }
    db.prepare("UPDATE return_orders SET status = 'approved' WHERE id = ?").run(order.id);
  });
  tx();
  if (approvalError) return res.status(400).send(`审核失败：${approvalError}`);

  res.redirect('/returns/' + order.id);
});

router.post('/returns/reject/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以拒绝');
  db.prepare("UPDATE return_orders SET status = 'rejected' WHERE id = ?").run(order.id);
  res.redirect('/returns/' + order.id);
});

// 反审核：approved/rejected -> submitted。如果原本是 approved，要把加回去的库存再扣回来——
// 扣之前先确认库存够不够，万一这批退回来的货已经又被卖出去了，硬扣会拉成负库存。
router.post('/returns/unapprove/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'approved' && order.status !== 'rejected') {
    return res.status(400).send('只有已审核或已拒绝状态可以反审核');
  }

  const items = order.status === 'approved'
    ? db.prepare('SELECT * FROM return_order_items WHERE return_order_id = ?').all(order.id)
    : [];
  if (order.status === 'approved') {
    const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
    for (const it of items) {
      const inv = getInv.get(it.product_id, order.warehouse_id);
      const have = inv ? inv.quantity : 0;
      if (have < it.base_quantity) {
        const p = db.prepare('SELECT name FROM products WHERE id=?').get(it.product_id);
        return res.status(400).send(
          `反审核失败：${p ? p.name : '商品'} 当前库存 ${have}，不足以扣回 ${it.base_quantity}` +
          `（说明这批退货已经又被卖出去了），请先处理相关销售单再反审核这张退货单。`
        );
      }
    }
  }

  const tx = db.transaction(() => {
    if (order.status === 'approved') {
      const decInv = db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id=? AND warehouse_id=?');
      // type 用 adjust 而不是沿用 sale_return：这笔流水 change_qty 是负数（把加回的扣回去），
      // 还标"销售退货入库"会出现"退货入库 -4"的矛盾记录；ref_type 仍可追溯到被反审核的退货单。
      const insertTxn = db.prepare(`
        INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
        VALUES (?,?,?,'adjust','return_order_unapprove',?,?)
      `);
      for (const it of items) {
        decInv.run(it.base_quantity, it.product_id, order.warehouse_id);
        insertTxn.run(it.product_id, order.warehouse_id, -it.base_quantity, order.id, req.session.user.id);
      }
    }
    db.prepare("UPDATE return_orders SET status = 'submitted' WHERE id = ?").run(order.id);
  });
  tx();

  res.redirect('/returns/' + order.id);
});

// 记录退款：与销售单的 record-payment 对称。之前 refunded_amount 只能在建单/编辑草稿时填，
// 已审核的退货单之后再退钱就没地方记了，报表的"已退款"口径也永远停在旧值。
// 只更新 refunded_amount / refund_status，不碰审核状态、不碰库存。
// 只允许对已审核的退货单操作：钱对应的是已经确认入库的那批货。
router.post('/returns/:id/record-refund', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限，只有管理员能记录退款');
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'approved') {
    return res.status(400).send('只有已审核的退货单可以记录退款');
  }

  const amountRaw = Number(req.body.amount);
  if (!Number.isFinite(amountRaw) || !(amountRaw > 0)) return res.status(400).send('退款金额必须是大于 0 的有效数字');
  const amount = roundToCents(amountRaw);
  if (!(amount > 0)) return res.status(400).send('退款金额四舍五入到分后必须大于 0');

  // 退款累计不能超过退货总额（与 record-payment 的封顶逻辑对称，允许 0.001 浮点误差）
  const remaining = order.total_amount - (order.refunded_amount || 0);
  if (remaining <= 0.001) {
    return res.status(400).send(`该单已退满（已退 ¥${(order.refunded_amount || 0).toFixed(2)} / 总额 ¥${order.total_amount.toFixed(2)}），无需再记退款`);
  }
  if (amount > remaining + 0.001) {
    return res.status(400).send(`退款金额（¥${amount.toFixed(2)}）超过该单剩余未退金额（¥${remaining.toFixed(2)}），最多还能退 ¥${remaining.toFixed(2)}`);
  }

  const newRefunded = roundToCents((order.refunded_amount || 0) + amount);
  let refundStatus = 'unrefunded';
  if (order.total_amount > 0 && newRefunded >= order.total_amount) refundStatus = 'refunded';
  else if (newRefunded > 0) refundStatus = 'partial';

  db.prepare('UPDATE return_orders SET refunded_amount = ?, refund_status = ? WHERE id = ?')
    .run(newRefunded, refundStatus, order.id);
  res.redirect('/returns/' + order.id);
});

router.get('/returns/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare(`
    SELECT ro.*, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name
    FROM return_orders ro
    LEFT JOIN customers c ON c.id = ro.customer_id
    LEFT JOIN warehouses w ON w.id = ro.warehouse_id
    LEFT JOIN users u ON u.id = ro.user_id
    WHERE ro.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  // 与列表页口径保持一致：操作员只能看自己录入的退货单（列表里有 ro.user_id = ? 过滤）
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限查看他人的退货单');
  const items = db.prepare(`
    SELECT roi.*, p.name AS product_name
    FROM return_order_items roi
    JOIN products p ON p.id = roi.product_id
    WHERE roi.return_order_id = ?
  `).all(req.params.id);
  res.render('return_detail', { order, items, canManage: canEditOrWithdraw(order, req.session.user) });
});

module.exports = router;
module.exports.validateLinkedReturn = validateLinkedReturn;
