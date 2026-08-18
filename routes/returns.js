const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const router = express.Router();

// 状态机跟销售单一致：submitted --审核通过--> approved（这一步才真正把库存加回去）
//                      submitted --审核拒绝--> rejected
//                      approved/rejected --反审核--> submitted（approved 需要把加回去的库存再扣回来，
//                      扣之前要检查库存够不够——如果这批货已经又被卖出去了，硬扣会拉成负库存）
// 退货不要求关联具体的原始销售单（按你的要求做成自由录入），所以数量上系统不做"不能超过原销售数量"的校验。

function canEditOrWithdraw(order, sessionUser) {
  return sessionUser.role === 'admin' || order.user_id === sessionUser.id;
}

function buildItemsFromRequest(db, body) {
  const { items_json } = body;
  let product_id, quantity, unit_price, unit_choice;
  if (items_json) {
    const parsed = JSON.parse(items_json);
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
    if (!pid || !(qty > 0)) continue;
    const product = getProduct.get(pid);
    if (!product) continue;
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    items.push({ pid, qty, price: price || 0, unitLabel, baseQty, productName: product.name });
  }
  return items;
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

router.get('/returns/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  res.render('return_form', { customers, warehouses, products, error: null, order: null, existingItems: [] });
});

router.post('/returns/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { customer_id, warehouse_id, order_date, note, refunded_amount, remarks, related_sales_order_id } = req.body;

  const renderError = (msg) => {
    const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    return res.render('return_form', { customers, warehouses, products, error: msg, order: null, existingItems: [] });
  };

  let relatedId = null;
  if (related_sales_order_id && related_sales_order_id.trim()) {
    const related = db.prepare('SELECT id FROM sales_orders WHERE id = ?').get(related_sales_order_id.trim());
    if (!related) return renderError(`关联的销售单号 #${related_sales_order_id} 不存在，请检查单号是否正确`);
    relatedId = related.id;
  }

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择退回的仓库并至少填写一行有效商品明细');
  }

  const total = items.reduce((s, it) => s + it.qty * it.price, 0);
  const refunded = parseFloat(refunded_amount) || 0;
  let refundStatus = 'unrefunded';
  if (refunded >= total && total > 0) refundStatus = 'refunded';
  else if (refunded > 0) refundStatus = 'partial';

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO return_orders (customer_id, warehouse_id, user_id, related_sales_order_id, order_date, total_amount, refunded_amount, refund_status, status, note, remarks)
       VALUES (?,?,?,?,?,?,?,?,'submitted',?,?)`
    ).run(customer_id || null, warehouse_id, req.session.user.id, relatedId, order_date || new Date().toISOString().slice(0,10), total, refunded, refundStatus, note || '', remarks || '');
    const roId = info.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO return_order_items (return_order_id, product_id, quantity, unit_label, base_quantity, unit_price) VALUES (?,?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(roId, it.pid, it.qty, it.unitLabel, it.baseQty, it.price);
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

  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
  const existingItems = db.prepare('SELECT * FROM return_order_items WHERE return_order_id = ?').all(order.id);
  res.render('return_form', { customers, warehouses, products, error: null, order, existingItems });
});

router.post('/returns/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM return_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的退货单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的退货单');

  const { customer_id, warehouse_id, order_date, note, refunded_amount, remarks, related_sales_order_id } = req.body;

  const renderError = (msg) => {
    const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack FROM products ORDER BY name').all();
    const existingItems = db.prepare('SELECT * FROM return_order_items WHERE return_order_id = ?').all(order.id);
    return res.render('return_form', { customers, warehouses, products, error: msg, order, existingItems });
  };

  let relatedId = null;
  if (related_sales_order_id && related_sales_order_id.trim()) {
    const related = db.prepare('SELECT id FROM sales_orders WHERE id = ?').get(related_sales_order_id.trim());
    if (!related) return renderError(`关联的销售单号 #${related_sales_order_id} 不存在，请检查单号是否正确`);
    relatedId = related.id;
  }

  const items = buildItemsFromRequest(db, req.body);
  if (!warehouse_id || items.length === 0) {
    return renderError('请选择退回的仓库并至少填写一行有效商品明细');
  }

  const total = items.reduce((s, it) => s + it.qty * it.price, 0);
  const refunded = parseFloat(refunded_amount) || 0;
  let refundStatus = 'unrefunded';
  if (refunded >= total && total > 0) refundStatus = 'refunded';
  else if (refunded > 0) refundStatus = 'partial';

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE return_orders SET customer_id=?, warehouse_id=?, related_sales_order_id=?, order_date=?, total_amount=?, refunded_amount=?, refund_status=?, note=?, remarks=? WHERE id=?`
    ).run(customer_id || null, warehouse_id, relatedId, order_date || order.order_date, total, refunded, refundStatus, note || '', remarks || '', order.id);
    db.prepare('DELETE FROM return_order_items WHERE return_order_id = ?').run(order.id);
    const insertItem = db.prepare('INSERT INTO return_order_items (return_order_id, product_id, quantity, unit_label, base_quantity, unit_price) VALUES (?,?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(order.id, it.pid, it.qty, it.unitLabel, it.baseQty, it.price);
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

  const items = db.prepare('SELECT * FROM return_order_items WHERE return_order_id = ?').all(order.id);

  const tx = db.transaction(() => {
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
      const insertTxn = db.prepare(`
        INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
        VALUES (?,?,?,'sale_return','return_order_unapprove',?,?)
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
  const items = db.prepare(`
    SELECT roi.*, p.name AS product_name
    FROM return_order_items roi
    JOIN products p ON p.id = roi.product_id
    WHERE roi.return_order_id = ?
  `).all(req.params.id);
  res.render('return_detail', { order, items, canManage: canEditOrWithdraw(order, req.session.user) });
});

module.exports = router;
