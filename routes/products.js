const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const router = express.Router();

router.get('/products', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
  res.render('products', { products, isAdmin: req.session.user.role === 'admin' });
});

router.get('/products/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  res.render('product_form', { product: null, error: null });
});

router.post('/products/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { sku, name, spec, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack, low_stock_threshold } = req.body;
  if (!name) return res.render('product_form', { product: req.body, error: '商品名称必填' });
  try {
    const info = db.prepare(
      `INSERT INTO products (sku, name, spec, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack, low_stock_threshold)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      sku || null, name, spec || '', unit || '瓶',
      pack_unit || null, Number(pack_size) || 1,
      Number(cost_price) || 0, Number(sale_price) || 0,
      cost_price_pack !== undefined && cost_price_pack !== '' ? Number(cost_price_pack) : null,
      sale_price_pack !== undefined && sale_price_pack !== '' ? Number(sale_price_pack) : null,
      Number(low_stock_threshold) || 0
    );
    // 为所有已存在的仓库建立库存行（初始为0）
    const warehouses = db.prepare('SELECT id FROM warehouses').all();
    const insertInv = db.prepare('INSERT OR IGNORE INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,0)');
    for (const w of warehouses) insertInv.run(info.lastInsertRowid, w.id);
    res.redirect('/products');
  } catch (e) {
    res.render('product_form', { product: req.body, error: 'SKU 已存在或数据有误：' + e.message });
  }
});

router.get('/products/:id/edit', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).send('商品不存在');
  res.render('product_form', { product, error: null });
});

router.post('/products/:id/edit', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { sku, name, spec, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack, low_stock_threshold } = req.body;
  // 与"新建商品"保持一致：SKU 撞车等约束错误渲染表单提示，而不是抛到全局 500 错误页
  try {
    db.prepare(
      `UPDATE products SET sku=?, name=?, spec=?, unit=?, pack_unit=?, pack_size=?, cost_price=?, sale_price=?, cost_price_pack=?, sale_price_pack=?, low_stock_threshold=? WHERE id=?`
    ).run(
      sku || null, name, spec || '', unit || '瓶',
      pack_unit || null, Number(pack_size) || 1,
      Number(cost_price) || 0, Number(sale_price) || 0,
      cost_price_pack !== undefined && cost_price_pack !== '' ? Number(cost_price_pack) : null,
      sale_price_pack !== undefined && sale_price_pack !== '' ? Number(sale_price_pack) : null,
      Number(low_stock_threshold) || 0,
      req.params.id
    );
    res.redirect('/products');
  } catch (e) {
    res.render('product_form', { product: req.body, error: 'SKU 已存在或数据有误：' + e.message });
  }
});

router.post('/products/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  // 引用检查要覆盖所有带外键的表：销售/采购/调拨明细、退货明细、出入库流水。
  // 少查一张表的话，提示语会说"可以删"，实际却被数据库外键约束拦下来，用户看到的是另一个报错。
  const refCount =
    db.prepare('SELECT COUNT(*) c FROM sales_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM purchase_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM transfer_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM return_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM stock_transactions WHERE product_id = ?').get(req.params.id).c;
  if (refCount > 0) {
    return res.status(400).send('无法删除：该商品已有出入库流水或被销售单/采购单/调拨单/退货单引用，删除会破坏历史记录。如果不再销售，可以把名称改成"（停用）xxx"标记一下即可。');
  }
  db.prepare('DELETE FROM inventory WHERE product_id = ?').run(req.params.id);
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.redirect('/products');
});

module.exports = router;
