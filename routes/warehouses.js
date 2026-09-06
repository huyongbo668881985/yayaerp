const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const router = express.Router();

router.get('/warehouses', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY id').all();
  res.render('warehouses', { warehouses, isAdmin: req.session.user.role === 'admin' });
});

router.post('/warehouses/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { name, address } = req.body;
  if (!name) return res.redirect('/warehouses');
  const info = db.prepare('INSERT INTO warehouses (name, address) VALUES (?,?)').run(name, address || '');
  // 为所有已存在的商品建立此仓库的库存行
  const products = db.prepare('SELECT id FROM products').all();
  const insertInv = db.prepare('INSERT OR IGNORE INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,0)');
  for (const p of products) insertInv.run(p.id, info.lastInsertRowid);
  res.redirect('/warehouses');
});

router.post('/warehouses/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const count = db.prepare('SELECT COUNT(*) c FROM inventory WHERE warehouse_id=? AND quantity>0').get(req.params.id).c;
  if (count > 0) {
    return res.status(400).send('该仓库仍有库存，无法删除，请先清空库存');
  }
  // 库存清零也可能删不掉：销售/采购/退货单、调拨单两端、出入库流水都引用着仓库。
  // 不查的话会被数据库外键约束拦下，用户看到的是难懂的 500 页而不是能懂的错误提示。
  const salesCount = db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE warehouse_id = ?').get(req.params.id).c;
  const purchaseCount = db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE warehouse_id = ?').get(req.params.id).c;
  const transferCount =
    db.prepare('SELECT COUNT(*) c FROM transfer_orders WHERE from_warehouse_id = ? OR to_warehouse_id = ?').get(req.params.id, req.params.id).c;
  const returnCount = db.prepare('SELECT COUNT(*) c FROM return_orders WHERE warehouse_id = ?').get(req.params.id).c;
  const txnCount = db.prepare('SELECT COUNT(*) c FROM stock_transactions WHERE warehouse_id = ?').get(req.params.id).c;
  const refCount = salesCount + purchaseCount + transferCount + returnCount + txnCount;
  if (refCount > 0) {
    const detail = [
      salesCount > 0 ? `销售单 ${salesCount}` : '',
      purchaseCount > 0 ? `采购单 ${purchaseCount}` : '',
      transferCount > 0 ? `调拨单 ${transferCount}` : '',
      returnCount > 0 ? `退货单 ${returnCount}` : '',
      txnCount > 0 ? `出入库流水 ${txnCount}` : ''
    ].filter(Boolean).join('、');
    return res.status(400).send(`无法删除：该仓库被以下记录引用着（${detail}），删除会破坏历史单据。如果不再使用，可以把名称改成"（停用）xxx"标记一下。`);
  }
  db.prepare('DELETE FROM inventory WHERE warehouse_id = ?').run(req.params.id);
  db.prepare('DELETE FROM warehouses WHERE id = ?').run(req.params.id);
  res.redirect('/warehouses');
});

module.exports = router;
