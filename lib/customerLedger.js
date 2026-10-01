const { todayLocalDate } = require('../utils/dates');

function cents(value) {
  const result = Math.round(Number(value || 0) * 100);
  if (!Number.isSafeInteger(result)) throw Object.assign(new Error('金额超出可精确记账范围，请核对单据。'), { code: 'LEDGER_AMOUNT_INVALID' });
  return result;
}

function amounts(kind, order) {
  if (!order || order.status !== 'approved') return [0, 0, 0, 0];
  return kind === 'sales' ? [cents(order.total_amount), cents(order.paid_amount), 0, 0]
    : [0, 0, cents(order.total_amount), cents(order.refunded_amount)];
}

// 已审核业务的变化与业务、审计一起提交；全部以整数分记录，反审核写反向流水。
function recordDocumentFinance(db, doc, before, after, user, requestId) {
  if (!['sales', 'returns'].includes(doc.kind)) return;
  const previous = amounts(doc.kind, before), current = amounts(doc.kind, after);
  const delta = current.map((value, i) => value - previous[i]);
  if (delta.every(value => value === 0)) return;
  const order = after || before;
  const labels = { approve: '审核入账', unapprove: '反审核冲销', 'record-payment': '收款', 'record-refund': '退款' };
  db.prepare(`INSERT INTO customer_ledger (customer_id, document_type, document_id, document_date,
    event_date, event_kind, sales_cents, received_cents, returned_cents, refunded_cents, user_id, user_name, request_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(order.customer_id || null, doc.kind, order.id, order.order_date,
    todayLocalDate(), labels[doc.operation] || '账务变动', ...delta, user.id, user.name, requestId);
}

function statement(db, customerId, start, end) {
  const openingDate = db.prepare("SELECT value FROM ledger_metadata WHERE key='opening_date'").get().value;
  if (start < openingDate) throw Object.assign(new Error(`逐笔对账从 ${openingDate} 开始，旧账在该日以“升级结转”记录。请选择该日或之后的日期。`), { status: 400 });
  const customerClause = customerId === null ? 'customer_id IS NULL' : 'customer_id=?';
  const params = customerId === null ? [] : [customerId];
  const balance = row => row.sales_cents - row.received_cents - row.returned_cents + row.refunded_cents;
  const opening = db.prepare(`SELECT COALESCE(SUM(sales_cents-received_cents-returned_cents+refunded_cents),0) n
    FROM customer_ledger WHERE ${customerClause} AND event_date<?`).get(...params, start).n;
  const count = db.prepare(`SELECT COUNT(*) n FROM customer_ledger WHERE ${customerClause} AND event_date BETWEEN ? AND ?`).get(...params,start,end).n;
  if (count > 10000) throw Object.assign(new Error('本次对账超过 10000 条，请缩小日期范围。'), { status: 400 });
  const rows = db.prepare(`SELECT * FROM customer_ledger WHERE ${customerClause} AND event_date BETWEEN ? AND ? ORDER BY event_date,id`).all(...params,start,end);
  let running = opening;
  const totals = { sales: 0, received: 0, returned: 0, refunded: 0 };
  for (const row of rows) {
    running += balance(row); row.balance_cents = running;
    for (const key of Object.keys(totals)) totals[key] += row[key + '_cents'];
  }
  if (![opening,running,...Object.values(totals)].every(Number.isSafeInteger)) throw Object.assign(new Error('汇总金额超出精确范围，请缩小对账区间。'), { status: 400 });
  // 分单应收、待退分别列出，净余额不意味着跨单据自动冲抵。
  const positions = db.prepare(`SELECT SUM(sales_cents-received_cents-returned_cents+refunded_cents) n FROM (
    SELECT CASE WHEN document_type='returns' THEN COALESCE((SELECT related_sales_order_id FROM return_orders WHERE id=customer_ledger.document_id), -document_id) ELSE document_id END account_id,
      sales_cents,received_cents,returned_cents,refunded_cents FROM customer_ledger WHERE ${customerClause} AND event_date<=?
    ) GROUP BY account_id`).all(...params,end);
  const receivable = positions.reduce((sum,row)=>sum+Math.max(0,row.n),0);
  const refundPending = positions.reduce((sum,row)=>sum+Math.max(0,-row.n),0);
  if (![receivable,refundPending].every(Number.isSafeInteger)) throw Object.assign(new Error('分单汇总金额超出精确范围，请核对单据。'), { status: 400 });
  return { openingDate, opening, ending: running, rows, totals,
    receivable, refundPending };
}

module.exports = { cents, recordDocumentFinance, statement };
