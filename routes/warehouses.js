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
  db.prepare('DELETE FROM inventory WHERE warehouse_id = ?').run(req.params.id);
  db.prepare('DELETE FROM warehouses WHERE id = ?').run(req.params.id);
  res.redirect('/warehouses');
});

module.exports = router;
