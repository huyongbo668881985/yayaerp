const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const { formatDateTime } = require('../utils/dates');
const router = express.Router();

// 当前库存快照（商品 × 仓库）：库存页面和 API v1 共用这一份查询
function queryInventorySnapshot(db, warehouseId) {
  let sql = `
    SELECT p.id AS product_id, p.sku, p.name, p.spec, p.unit, p.pack_unit, p.pack_size, p.low_stock_threshold,
           w.id AS warehouse_id, w.name AS warehouse_name, inv.quantity
    FROM inventory inv
    JOIN products p ON p.id = inv.product_id
    JOIN warehouses w ON w.id = inv.warehouse_id
  `;
  const params = [];
  if (warehouseId) {
    sql += ' WHERE w.id = ?';
    params.push(warehouseId);
  }
  sql += ' ORDER BY p.name, w.name';
  return db.prepare(sql).all(...params);
}

router.get('/inventory', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const warehouseId = req.query.warehouse_id || '';
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const rows = queryInventorySnapshot(db, warehouseId || null);
  res.render('inventory', { rows, warehouses, warehouseId, isAdmin: req.session.user.role === 'admin' });
});

// 出入库流水：管理员看全部；操作员只能看自己操作产生的流水（user_id=自己），
// 与销售/退货/调拨列表页的"操作员只看自己名下单据"边界保持一致——
// 否则操作员能从流水页反推出同事的销售/采购量。
function queryStockLogs(db, user, start, end, limit) {
  let sql = `
    SELECT st.*, p.name AS product_name, p.unit, w.name AS warehouse_name, u.name AS user_name
    FROM stock_transactions st
    JOIN products p ON p.id = st.product_id
    JOIN warehouses w ON w.id = st.warehouse_id
    LEFT JOIN users u ON u.id = st.user_id
    WHERE 1=1
  `;
  const params = [];
  if (user && user.role !== 'admin') { sql += ' AND st.user_id = ?'; params.push(user.id); }
  if (start) { sql += " AND date(st.created_at, '+8 hours') >= ?"; params.push(start); }
  if (end) { sql += " AND date(st.created_at, '+8 hours') <= ?"; params.push(end); }
  sql += ' ORDER BY st.id DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  return db.prepare(sql).all(...params);
}

router.get('/stock-log', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { start, end } = req.query;
  const logs = queryStockLogs(db, req.session.user, start, end, 200);
  res.render('stock_log', { logs, start: start || '', end: end || '' });
});

router.get('/stock-log/export', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { start, end } = req.query;
  const logs = queryStockLogs(db, req.session.user, start, end, null);

  const typeLabels = { purchase_in: '采购入库', sale_out: '销售出库', transfer_out: '调拨调出', transfer_in: '调拨调入', adjust: '库存调整', sale_return: '销售退货入库' };
  // 数量列输出纯数字（正负自明），单位独立成列——以前手工拼成 "+5 瓶"，以 + 开头
  // 会被 CSV 公式注入防护加 ' 前缀（纯数字才放行），Excel 里复制出来会带着引号。
  const headers = ['时间', '商品', '仓库', '类型', '数量变化', '单位', '操作人'];
  const rows = logs.map(l => [
    formatDateTime(l.created_at),
    l.product_name,
    l.warehouse_name,
    typeLabels[l.type] || l.type,
    l.change_qty,
    l.unit,
    l.user_name || '-'
  ]);

  const rangeLabel = (start || end) ? `_${start || '起'}_${end || '止'}` : '';
  sendCsv(res, `出入库流水${rangeLabel}.csv`, headers, rows);
});

// ===== 库存调整（盘点修正）=====
// 背景（2026-09-08 新增）：这是全站唯一的"把账面库存改成实际数量"的入口。
// 没有它的话，一旦账实不符（盘点差异、误扣、历史遗留），用户没有任何自助修正手段，
// 只能求平台改数据库。录入方式按"盘点直觉"设计：直接填实际清点数量，
// 系统自己算差额（可正可负），写一条 adjust 流水留痕，不允许静默改数。
router.get('/inventory/adjust', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const warehouses = db.prepare('SELECT id, name FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT id, name, unit, pack_unit, pack_size FROM products ORDER BY name').all();
  // 商品 × 仓库的当前库存映射，给表单 JS 做"当前库存"联动显示
  const invRows = db.prepare('SELECT product_id, warehouse_id, quantity FROM inventory').all();
  const invMap = {};
  for (const r of invRows) invMap[`${r.product_id}_${r.warehouse_id}`] = r.quantity;
  res.render('inventory_adjust', {
    warehouses, products,
    invMapJson: JSON.stringify(invMap).replace(/</g, '\\u003c'),
    error: null
  });
});

router.post('/inventory/adjust', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const productId = Number(req.body.product_id);
  const warehouseId = Number(req.body.warehouse_id);
  // 数量必须是 >= 0 的整数：库存按瓶计数不存在小数，负数更是业务上不存在的状态
  const newQty = Number(req.body.new_quantity);
  const reason = String(req.body.reason || '').trim();

  const renderError = (msg) => {
    const warehouses = db.prepare('SELECT id, name FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT id, name, unit, pack_unit, pack_size FROM products ORDER BY name').all();
    const invRows = db.prepare('SELECT product_id, warehouse_id, quantity FROM inventory').all();
    const invMap = {};
    for (const r of invRows) invMap[`${r.product_id}_${r.warehouse_id}`] = r.quantity;
    return res.render('inventory_adjust', {
      warehouses, products,
      invMapJson: JSON.stringify(invMap).replace(/</g, '\\u003c'),
      error: msg
    });
  };

  const product = db.prepare('SELECT id, name, unit FROM products WHERE id = ?').get(productId);
  const warehouse = db.prepare('SELECT id, name FROM warehouses WHERE id = ?').get(warehouseId);
  if (!product || !warehouse) return renderError('请选择商品和仓库');
  if (!Number.isInteger(newQty) || newQty < 0) return renderError('调整后数量必须是大于等于 0 的整数');
  // 原因必填：调整是对账目的强干预，流水里必须能回答"当时为什么改"
  if (!reason) return renderError('请填写调整原因（例如：月度盘点、破损清理），该原因会记入出入库流水');

  let delta = 0;
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT quantity FROM inventory WHERE product_id = ? AND warehouse_id = ?')
      .get(productId, warehouseId);
    const curQty = row ? row.quantity : 0;
    delta = newQty - curQty;
    if (delta === 0) return; // 数量没变，不写流水

    // upsert：极老数据可能没有这行库存（正常建商品/建仓库时都会补行，这里是兜底）
    db.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
      ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = excluded.quantity
    `).run(productId, warehouseId, newQty);
    // 流水的 change_qty 记差额（正=盘盈入库，负=盘亏出库），ref_type 标明是人工盘点修正，
    // 与系统内部的冲销 adjust（purchase_order_delete 等）区分开
    db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'adjust','manual_adjust',NULL,?)
    `).run(productId, warehouseId, delta, req.session.user.id);
  });
  tx();

  if (delta === 0) {
    return renderError(`数量没有变化（当前库存就是 ${newQty}），无需调整`);
  }
  res.redirect('/stock-log');
});

module.exports = router;

// 供 API v1（routes/apiV1.js）复用：库存快照查询与页面同一份 SQL
module.exports.queryInventorySnapshot = queryInventorySnapshot;
