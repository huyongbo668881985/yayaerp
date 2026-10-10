const { returnedAmountSubquery, refundedAmountSubquery, attachEffectivePayment } = require('./profitCalc');
const RETURNED_AMOUNT_SUBQUERY = returnedAmountSubquery('so');

function queryOrders(db, user, start, end, customerId, guestOnly, settlement, pendingOnly, tagId = null, orderStatus = '', responsibleId = null, paging = null) {
  let sql = `
    SELECT so.*, c.name AS customer_name, w.name AS warehouse_name, u.name AS user_name, ru.name AS responsible_name,
           ${RETURNED_AMOUNT_SUBQUERY} AS returned_amount, ${refundedAmountSubquery()} AS cash_refunded_amount
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN warehouses w ON w.id = so.warehouse_id
    LEFT JOIN users u ON u.id = so.user_id
    LEFT JOIN users ru ON ru.id = COALESCE(so.responsible_id, so.user_id)
    WHERE 1=1
  `;
  const params = [];
  if (user.role !== 'admin') {
    sql += ' AND so.user_id = ?';
    params.push(user.id);
  }
  if (start) { sql += ' AND so.order_date >= ?'; params.push(start); }
  if (end) { sql += ' AND so.order_date <= ?'; params.push(end); }
  if (customerId) { sql += ' AND so.customer_id = ?'; params.push(customerId); }
  if (responsibleId) { sql += ' AND COALESCE(so.responsible_id, so.user_id) = ?'; params.push(responsibleId); }
  if (tagId) { sql += ' AND so.customer_id IN (SELECT customer_id FROM customer_tag_links WHERE tag_id = ?)'; params.push(tagId); }
  if (guestOnly) sql += ' AND so.customer_id IS NULL';
  if (pendingOnly) sql += " AND so.status = 'submitted'";
  if (orderStatus) { sql += ' AND so.status = ?'; params.push(orderStatus); }
  const balance = 'ROUND(total_amount - paid_amount - returned_amount + cash_refunded_amount, 2)';
  sql = `SELECT * FROM (${sql}) filtered`;
  if (settlement) sql += ` WHERE status = 'approved' AND ABS(${balance}) ${settlement === 'settled' ? '<=' : '>'} 0.001`;
  if (!paging) return db.prepare(sql + ' ORDER BY id DESC').all(...params).map(attachEffectivePayment);
  const totalOrders = db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(...params).n;
  const totalPages = Math.max(1, Math.ceil(totalOrders / paging.size));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(Number(paging.page)) || 1));
  const sortColumn = { date: 'order_date', amount: 'total_amount', debt: `CASE WHEN status='approved' THEN MAX(0, ${balance}) ELSE 0 END` }[paging.sort] || 'order_date';
  const direction = paging.order === 'asc' ? 'ASC' : 'DESC';
  const orders = db.prepare(sql + ` ORDER BY ${sortColumn} ${direction}, id ${direction === 'ASC' ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?`)
    .all(...params, paging.size, (page - 1) * paging.size).map(attachEffectivePayment);
  return { orders, totalOrders, totalPages, page };
}

module.exports = { queryOrders };
