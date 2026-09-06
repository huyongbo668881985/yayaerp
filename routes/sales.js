const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const router = express.Router();

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
    const parsed = JSON.parse(items_json);
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
    if (!pid || !(qty > 0)) continue;
    const product = getProduct.get(pid);
    if (!product) continue;
    if (gift) price = 0;
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    // 成本快照：记下开单那一刻的成本价，之后改商品成本价不影响这张单的历史毛利
    items.push({ pid, qty, price: price || 0, unitLabel, baseQty, costSnapshot: product.cost_price || 0, productName: product.name, gift });
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
           COALESCE((SELECT SUM(total_amount) FROM return_orders WHERE related_sales_order_id = so.id AND status = 'approved'), 0) AS returned_amount
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
           COALESCE((SELECT SUM(total_amount) FROM return_orders WHERE related_sales_order_id = so.id AND status = 'approved'), 0) AS returned_amount,
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

router.get('/sales/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  res.render('sale_form', { customers, warehouses, products, error: null, order: null, existingItems: [] });
});

router.post('/sales/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { customer_id, warehouse_id, order_date, note, paid_amount, remarks } = req.body;

  const renderError = (msg) => {
    const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    return res.render('sale_form', { customers, warehouses, products, error: msg, order: null, existingItems: [] });
  };

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择仓库并至少填写一行有效商品明细');
  }

  // 草稿/待审核阶段不动库存，这里只做数据落库，不检查库存、不生成出入库流水
  // 点"存草稿"按钮会带 save_draft=1 → 存为 draft，之后在详情页继续编辑/提交审核
  const total = items.reduce((s, it) => s + it.qty * it.price, 0);
  const paid = parseFloat(paid_amount) || 0;
  let paymentStatus = 'unpaid';
  if (paid >= total && total > 0) paymentStatus = 'paid';
  else if (paid > 0) paymentStatus = 'partial';
  const status = (req.body.save_draft === '1' || req.body.save_draft === 'on') ? 'draft' : 'submitted';

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO sales_orders (customer_id, warehouse_id, user_id, order_date, total_amount, paid_amount, payment_status, status, note, remarks)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(customer_id || null, warehouse_id, req.session.user.id, order_date || new Date().toISOString().slice(0,10), total, paid, paymentStatus, status, note || '', remarks || '');
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

  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  const existingItems = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ?').all(order.id);
  res.render('sale_form', { customers, warehouses, products, error: null, order, existingItems });
});

router.post('/sales/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的订单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的订单');

  const { customer_id, warehouse_id, order_date, note, paid_amount, remarks } = req.body;

  const renderError = (msg) => {
    const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    const existingItems = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ?').all(order.id);
    return res.render('sale_form', { customers, warehouses, products, error: msg, order, existingItems });
  };

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择仓库并至少填写一行有效商品明细');
  }

  const total = items.reduce((s, it) => s + it.qty * it.price, 0);
  const paid = parseFloat(paid_amount) || 0;
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
  const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
  for (const it of items) {
    const inv = getInv.get(it.product_id, order.warehouse_id);
    const have = inv ? inv.quantity : 0;
    if (have < it.base_quantity) {
      const p = db.prepare('SELECT name FROM products WHERE id=?').get(it.product_id);
      return res.status(400).send(`审核失败：${p ? p.name : '商品'} 当前库存 ${have}，不足以扣减 ${it.base_quantity}，请联系提交人调整数量或先补货`);
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

  const tx = db.transaction(() => {
    if (order.status === 'approved') {
      // 把审核通过时扣掉的库存加回来
      const items = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id = ?').all(order.id);
      const upsertInv = db.prepare(`
        INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = quantity + excluded.quantity
      `);
      const insertTxn = db.prepare(`
        INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
        VALUES (?,?,?,'sale_out','sales_order_unapprove',?,?)
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
router.post('/sales/:id/record-payment', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限，只有管理员能记录收款');
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');

  const amount = parseFloat(req.body.amount);
  if (!(amount > 0)) return res.status(400).send('收款金额必须大于0');

  db.prepare('UPDATE sales_orders SET paid_amount = paid_amount + ? WHERE id = ?').run(amount, order.id);
  res.redirect('/sales/' + order.id);
});

router.get('/sales/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare(`
    SELECT so.*, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name,
           COALESCE((SELECT SUM(total_amount) FROM return_orders WHERE related_sales_order_id = so.id AND status = 'approved'), 0) AS returned_amount
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    LEFT JOIN users u ON u.id = so.user_id
    WHERE so.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
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
