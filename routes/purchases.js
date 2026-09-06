const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const router = express.Router();

// 设计说明（2026-09-06 定版）：采购入库没有审核流，录单即加库存。
// 原因：整个采购模块本来就只有管理员能进（下面所有路由都挂 requireAdmin），
// "管理员录单→管理员审核"是自己审自己，纯增摩擦没有防错价值。
// 操作员的误操作风险已被角色权限挡住（操作员根本进不了采购）。
// purchase_orders.status 字段保留但暂不启用，将来若开放操作员录采购再启用审核流。

router.get('/purchases', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const orders = db.prepare(`
    SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, u.name AS user_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN warehouses w ON w.id = po.warehouse_id
    LEFT JOIN users u ON u.id = po.user_id
    ORDER BY po.id DESC
  `).all();
  res.render('purchases', { orders });
});

router.get('/purchases/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  res.render('purchase_form', { suppliers, warehouses, products, error: null });
});

router.post('/purchases/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { supplier_id, warehouse_id, order_date, note } = req.body;
  let { product_id, quantity, unit_price, unit_choice } = req.body;
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
    // unit_choice: 'pack' 表示按大单位（箱）录入，否则按基本单位（瓶）
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    items.push({ pid, qty, price: price || 0, unitLabel, baseQty });
  }
  if (!warehouse_id || items.length === 0) {
    const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT * FROM products ORDER BY name').all();
    return res.render('purchase_form', { suppliers, warehouses, products, error: '请选择仓库并至少填写一行有效商品明细' });
  }

  const total = items.reduce((s, it) => s + it.qty * it.price, 0);

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO purchase_orders (supplier_id, warehouse_id, user_id, order_date, total_amount, note, remarks)
       VALUES (?,?,?,?,?,?,?)`
    ).run(supplier_id || null, warehouse_id, req.session.user.id, order_date || new Date().toISOString().slice(0,10), total, note || '', req.body.remarks || '');
    const poId = info.lastInsertRowid;

    const insertItem = db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_label, base_quantity, unit_price) VALUES (?,?,?,?,?,?)');
    const upsertInv = db.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
      ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `);
    const insertTxn = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'purchase_in','purchase_order',?,?)
    `);

    for (const it of items) {
      insertItem.run(poId, it.pid, it.qty, it.unitLabel, it.baseQty, it.price);
      upsertInv.run(it.pid, warehouse_id, it.baseQty);
      insertTxn.run(it.pid, warehouse_id, it.baseQty, poId, req.session.user.id);
    }
  });
  tx();

  res.redirect('/purchases');
});

router.get('/purchases/:id', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare(`
    SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, u.name AS user_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN warehouses w ON w.id = po.warehouse_id
    LEFT JOIN users u ON u.id = po.user_id
    WHERE po.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  const items = db.prepare(`
    SELECT poi.*, p.name AS product_name
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = ?
  `).all(req.params.id);
  res.render('purchase_detail', { order, items });
});

router.post('/purchases/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(order.id);

  // 删除采购单要把当初入库加的库存扣回去；如果这批货已经被卖出/调走一部分，扣回去会变成负库存，先拦下来
  const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
  for (const it of items) {
    const inv = getInv.get(it.product_id, order.warehouse_id);
    const have = inv ? inv.quantity : 0;
    if (have < it.base_quantity) {
      const p = db.prepare('SELECT name FROM products WHERE id=?').get(it.product_id);
      return res.status(400).send(
        `无法删除：${p ? p.name : '商品'} 当前库存 ${have}，少于这张采购单入库的 ${it.base_quantity}` +
        `（说明这批货已经被销售或调拨掉了一部分），删除会导致库存变成负数。请先处理相关的销售/调拨单再删除这张采购单。`
      );
    }
  }

  const tx = db.transaction(() => {
    const decInv = db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id=? AND warehouse_id=?');
    // type 用 adjust 而不是沿用 purchase_in：这笔流水 change_qty 是负数（把入库的扣回去），
    // 还标"采购入库"会出现"采购入库 -50"的矛盾记录；ref_type 仍可追溯到被删的采购单。
    const insertTxn = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'adjust','purchase_order_delete',?,?)
    `);
    for (const it of items) {
      decInv.run(it.base_quantity, it.product_id, order.warehouse_id);
      insertTxn.run(it.product_id, order.warehouse_id, -it.base_quantity, order.id, req.session.user.id);
    }
    db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').run(order.id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(order.id);
  });
  tx();

  res.redirect('/purchases');
});

module.exports = router;
