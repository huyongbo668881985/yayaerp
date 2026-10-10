const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { warehousesForUser } = require('../lib/warehouseAccess');
const { writeAuditLog } = require('../lib/auditLog');
const router = express.Router();

router.get('/warehouses', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const isAdmin = req.session.user.role === 'admin';
  const warehouses = (isAdmin
    ? db.prepare(`SELECT w.*, u.name AS operator_name
                  FROM warehouses w LEFT JOIN users u ON u.id = w.operator_id
                  ORDER BY w.id`).all()
    : warehousesForUser(db, req.session.user));
  const operators = isAdmin
    ? db.prepare("SELECT id, name FROM users WHERE role = 'operator' AND active = 1 ORDER BY name").all()
    : [];
  const notice = req.session.warehouseNotice || null;
  delete req.session.warehouseNotice;
  res.render('warehouses', { warehouses, operators, isAdmin, notice });
});

router.post('/warehouses/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { name, address, operator_id } = req.body;
  if (!name) return res.redirect('/warehouses');
  const operatorId = operator_id ? Number(operator_id) : null;
  if (operatorId && !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'operator' AND active = 1").get(operatorId)) {
    return res.status(400).send('所选操作员不存在或已禁用');
  }
  const info = db.prepare('INSERT INTO warehouses (name, address, operator_id) VALUES (?,?,?)').run(name, address || '', operatorId);
  // 为所有已存在的商品建立此仓库的库存行
  const products = db.prepare('SELECT id FROM products').all();
  const insertInv = db.prepare('INSERT OR IGNORE INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,0)');
  for (const p of products) insertInv.run(p.id, info.lastInsertRowid);
  res.redirect('/warehouses');
});

// 仓库/车辆归属只由管理员维护。未分配 = 仅管理员可见。
router.post('/warehouses/:id/operator', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const warehouseId = Number(req.params.id);
  const operatorId = req.body.operator_id ? Number(req.body.operator_id) : null;
  if (!Number.isInteger(warehouseId) || !db.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(warehouseId)) {
    return res.status(404).send('仓库不存在');
  }
  if (operatorId && (!Number.isInteger(operatorId) || !db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'operator' AND active = 1").get(operatorId))) {
    return res.status(400).send('所选操作员不存在或已禁用');
  }
  db.prepare('UPDATE warehouses SET operator_id = ? WHERE id = ?').run(operatorId, warehouseId);
  res.redirect('/warehouses');
});

// 事务内检查库存并切换状态；重复提交不会反转状态，也不会重复记日志。
router.post('/warehouses/:id/status', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const warehouseId = Number(req.params.id);
  const active = req.body.active;
  if (!Number.isInteger(warehouseId) || !['0', '1'].includes(active)) {
    return res.status(400).render('error', { message: '仓库或启用状态无效' });
  }
  const result = db.transaction(() => {
    const warehouse = db.prepare('SELECT * FROM warehouses WHERE id = ?').get(warehouseId);
    if (!warehouse) return { status: 404, message: '仓库不存在' };
    const nextActive = Number(active);
    if (warehouse.active === nextActive) return { message: `${warehouse.name}已${nextActive ? '启用' : '停用'}` };
    if (!nextActive && db.prepare('SELECT 1 FROM inventory WHERE warehouse_id = ? AND quantity != 0 LIMIT 1').get(warehouseId)) {
      return { status: 400, message: '该仓库仍有库存，不能停用，请先将库存调出或盘点清零后再停用' };
    }
    db.prepare('UPDATE warehouses SET active = ? WHERE id = ?').run(nextActive, warehouseId);
    writeAuditLog(db, req.session.user, nextActive ? '启用仓库' : '停用仓库', '仓库', warehouseId,
      `${warehouse.name}：${nextActive ? '恢复启用' : '停用，保留历史单据，不再参与开单和低库存提醒'}`);
    return { message: `${warehouse.name}已${nextActive ? '恢复启用' : '停用，不再参与开单和低库存提醒'}` };
  }).immediate();
  if (result.status) return res.status(result.status).render('error', { message: result.message });
  req.session.warehouseNotice = result.message;
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
    return res.status(400).send(`无法删除：该仓库被以下记录引用着（${detail}），删除会破坏历史单据。如果不再使用，请在仓库管理中点击“停用”，保留历史记录。`);
  }
  db.prepare('DELETE FROM inventory WHERE warehouse_id = ?').run(req.params.id);
  db.prepare('DELETE FROM warehouses WHERE id = ?').run(req.params.id);
  res.redirect('/warehouses');
});

module.exports = router;
