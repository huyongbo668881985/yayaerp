const express = require('express');
const { requireLogin } = require('../middleware/auth');
const { sendCsv } = require('../utils/csv');
const router = express.Router();

router.get('/inventory', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const warehouseId = req.query.warehouse_id || '';
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();

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
  const rows = db.prepare(sql).all(...params);

  res.render('inventory', { rows, warehouses, warehouseId });
});

function queryStockLogs(db, start, end, limit) {
  let sql = `
    SELECT st.*, p.name AS product_name, p.unit, w.name AS warehouse_name, u.name AS user_name
    FROM stock_transactions st
    JOIN products p ON p.id = st.product_id
    JOIN warehouses w ON w.id = st.warehouse_id
    LEFT JOIN users u ON u.id = st.user_id
    WHERE 1=1
  `;
  const params = [];
  if (start) { sql += ' AND date(st.created_at) >= ?'; params.push(start); }
  if (end) { sql += ' AND date(st.created_at) <= ?'; params.push(end); }
  sql += ' ORDER BY st.id DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(limit); }
  return db.prepare(sql).all(...params);
}

router.get('/stock-log', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { start, end } = req.query;
  const logs = queryStockLogs(db, start, end, 200);
  res.render('stock_log', { logs, start: start || '', end: end || '' });
});

router.get('/stock-log/export', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { start, end } = req.query;
  const logs = queryStockLogs(db, start, end, null);

  const typeLabels = { purchase_in: '采购入库', sale_out: '销售出库', transfer_out: '调拨调出', transfer_in: '调拨调入', adjust: '库存调整', sale_return: '销售退货入库' };
  // 数量列输出纯数字（正负自明），单位独立成列——以前手工拼成 "+5 瓶"，以 + 开头
  // 会被 CSV 公式注入防护加 ' 前缀（纯数字才放行），Excel 里复制出来会带着引号。
  const headers = ['时间', '商品', '仓库', '类型', '数量变化', '单位', '操作人'];
  const rows = logs.map(l => [
    l.created_at,
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

module.exports = router;
