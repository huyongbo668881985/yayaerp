const router = require('express').Router();
const { requireLogin } = require('../middleware/auth');
const { PRODUCT_FIELDS } = require('../lib/catalog');
const { isWarehouseInScope } = require('../lib/warehouseAccess');
router.use('/order-options', requireLogin, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/order-options/products', (req, res) => {
  const db = req.tenantDb, user = req.session.user;
  const keyword = String(req.query.q || '').trim().slice(0, 100);
  const ids = String(req.query.ids || '').split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0).slice(0, 200);
  const products = ids.length
    ? db.prepare(`SELECT ${PRODUCT_FIELDS} FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : req.query.recent === '1'
      ? db.prepare(`SELECT ${PRODUCT_FIELDS.split(', ').map(field => 'p.' + field).join(', ')} FROM products p JOIN sales_order_items i ON i.product_id=p.id
          JOIN sales_orders o ON o.id=i.sales_order_id ${user.role === 'admin' ? '' : 'WHERE o.user_id=?'} GROUP BY p.id ORDER BY MAX(o.id) DESC, p.id LIMIT 6`).all(...(user.role === 'admin' ? [] : [user.id]))
      : db.prepare(`SELECT ${PRODUCT_FIELDS} FROM products WHERE name LIKE ? OR sku LIKE ? OR spec LIKE ? ORDER BY name, id LIMIT 20`).all(...Array(3).fill('%' + keyword + '%'));
  res.json({ products });
});
router.get('/order-options/customers', (req, res) => {
  const db = req.tenantDb, user = req.session.user;
  const keyword = String(req.query.q || '').trim().slice(0, 100);
  const order = req.query.order_id ? db.prepare('SELECT user_id,customer_id FROM sales_orders WHERE id=?').get(req.query.order_id) : null;
  const currentCustomer = order && (user.role === 'admin' || order.user_id === user.id) ? order.customer_id : -1;
  const scope = user.role === 'admin' ? '' : ' AND (operator_id=? OR id=?)';
  const customers = db.prepare(`SELECT id,name,contact,phone,address FROM customers WHERE (name LIKE ? OR contact LIKE ? OR phone LIKE ? OR address LIKE ?)${scope} ORDER BY id DESC LIMIT 20`)
    .all(...Array(4).fill('%' + keyword + '%'), ...(user.role === 'admin' ? [] : [user.id, currentCustomer]));
  res.json({ customers });
});
router.get('/order-options/stock', (req, res) => {
  const db = req.tenantDb;
  if (!isWarehouseInScope(db, req.session.user, req.query.warehouse_id)) return res.status(403).json({ error: '无权查看该仓库库存' });
  const product = db.prepare('SELECT id,unit,pack_unit,pack_size FROM products WHERE id=?').get(req.query.product_id);
  if (!product) return res.status(404).json({ error: '商品不存在' });
  const row = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id, req.query.warehouse_id);
  res.json({ ...product, quantity: row ? row.quantity : 0 });
});
module.exports = router;
