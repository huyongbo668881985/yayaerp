const { isValidDateString } = require('./validators');
const money = n => {
  if (n === null) return null;
  if (!Number.isSafeInteger(n)) invalid('汇总金额超出精确范围，请缩小统计区间');
  return n / 100;
};
const shiftDate = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0,10);
const utcBoundary = date => new Date(date + 'T00:00:00+08:00').toISOString().slice(0,19).replace('T',' ');
const localDate = utc => new Date(Date.parse(utc.replace(' ','T') + 'Z') + 28800000).toISOString().slice(0,10);
function invalid(message) { throw Object.assign(new Error(message), { status: 400 }); }
function dateParam(value) {
  if (value === undefined || value === '') return '';
  if (!isValidDateString(value)) invalid('日期必须为真实的 YYYY-MM-DD 日期');
  return value;
}
function idParam(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalid('人员或客户 ID 必须为正整数');
  return Number(value);
}
function pagination(query) {
  const page = query.page === undefined || query.page === '' ? 1 : Number(query.page);
  const size = query.pageSize === undefined || query.pageSize === '' ? 50 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || size > 200 || !Number.isSafeInteger((page-1)*size)) invalid('page 必须为正整数，pageSize 必须为 1 ~ 200');
  return { page, size };
}
function range(start, end) { if (start && end && start > end) invalid('结束日期不能早于开始日期'); }
function metadata(db) {
  const opening = db.prepare("SELECT value FROM ledger_metadata WHERE key='opening_date'").get().value;
  const started = db.prepare("SELECT value FROM report_metadata WHERE key='history_started_at'").get().value;
  return {
    timezone: 'Asia/Shanghai', utc_offset: '+08:00', currency: 'CNY', ledger_available_from: opening,
    cash_available_from: shiftDate(opening, 1),
    customer_history_started_at: started.replace(' ','T') + 'Z',
    customer_history_available_from: shiftDate(localDate(started), 1),
    profit_snapshot_available_from: shiftDate(localDate(started), 1),
    customer_creation: '旧客户创建时间未知；仅迁移后新客户记录真实创建时间',
    attribution: '销售、退货、现金、欠款按取数时原销售单 responsible_id，空值回退 user_id；这是当前归属，不是历史归属。独立退货归未分配。客户按截止时点归属历史。',
    roster: '仅 report_salespeople 中与统计月份至统计日重叠的明确名单；不根据订单或 operator 角色推断。未配置/非名单负责人归未分配。',
    sales_basis: '单据日期归期；累计至截止日的审核/反审核流水重建入账金额；含应收毛利取入账时明细成本快照。后续补审核会改变重跑结果。',
    cash_basis: '仅收款/退款正向流水为已知现金；审核入账和反审核不是现金，升级结转不是现金。开单预收现金日期未知，可能影响期间时金额为 null，另提供已知现金金额。',
    debt_basis: '按 event_date 截止日逐账户累计销售-收款-退货+退款；正余额应收、负余额待退，绝不跨订单抵销。旧执行时快照不参与。',
    debtor_count_basis: '每组按客户 ID 去重，散客合为一组；公司跨组再次去重，个人客户数不能直接求和。',
    repayment_target: '月回款目标由报表端配置，接口不保存目标'
  };
}
function ledgerRows(db, end) {
  return db.prepare(`SELECT l.*,a.account_id,a.source,f.profit_cents,
    CASE WHEN a.source='legacy_unverified' THEN NULL ELSE COALESCE(s.responsible_id,s.user_id) END responsible_id,
    CASE WHEN a.source='legacy_unverified' THEN NULL ELSE u.name END responsible_name,s.created_at order_created_at
    FROM customer_ledger l LEFT JOIN customer_ledger_accounts a ON a.ledger_id=l.id
    LEFT JOIN report_ledger_facts f ON f.ledger_id=l.id
    LEFT JOIN sales_orders s ON s.id=a.account_id
    LEFT JOIN users u ON u.id=COALESCE(s.responsible_id,s.user_id)
    WHERE l.event_date<=? ORDER BY l.event_date,l.id`).all(end);
}
function cash(row) {
  return { receipt: row.event_kind === '收款' && row.received_cents > 0 ? row.received_cents : 0,
    refund: row.event_kind === '退款' && row.refunded_cents > 0 ? row.refunded_cents : 0 };
}
function uncertainCash(row, start, end) {
  if (row.event_kind === '升级结转' || row.event_kind === '反审核冲销' || row.event_kind === '退货撤销冲销') return false;
  if (row.event_kind === '收款' || row.event_kind === '退款') return false;
  if (row.received_cents <= 0 && row.refunded_cents <= 0) return false;
  const earliest = row.order_created_at ? localDate(row.order_created_at) : '0001-01-01';
  return row.event_date >= start && earliest <= end;
}
function customersAt(db, end) {
  return db.prepare(`SELECT h.*,u.name operator_name FROM report_customer_history h
    LEFT JOIN users u ON u.id=h.operator_id
    WHERE h.id=(SELECT h2.id FROM report_customer_history h2 WHERE h2.customer_id=h.customer_id
      AND h2.recorded_at<? ORDER BY h2.recorded_at DESC,h2.id DESC LIMIT 1) AND h.deleted=0 ORDER BY h.customer_id`)
    .all(utcBoundary(shiftDate(end,1)));
}
function customers(db, query) {
  const start = dateParam(query.created_start), end = dateParam(query.created_end); range(start,end);
  const operator = idParam(query.operator_id), { page,size } = pagination(query);
  const meta = metadata(db);
  const clauses = [], params = [];
  if (operator !== null) { clauses.push('c.operator_id=?'); params.push(operator); }
  if (start) { clauses.push('c.created_at>=?'); params.push(utcBoundary(start)); }
  if (end) { clauses.push('c.created_at<?'); params.push(utcBoundary(shiftDate(end,1))); }
  const where = clauses.length ? ' WHERE '+clauses.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) n FROM customers c'+where).get(...params).n;
  const items = db.prepare(`SELECT c.id,c.name,c.operator_id,u.name operator_name,c.created_at FROM customers c
    LEFT JOIN users u ON u.id=c.operator_id${where} ORDER BY c.id LIMIT ? OFFSET ?`).all(...params,size,(page-1)*size)
    .map(r => ({ ...r, created_at: r.created_at ? r.created_at.replace(' ','T')+'Z' : null,
      creation_time_complete: r.created_at !== null, creation_time_reason: r.created_at === null ? '迁移前未保存客户创建时间' : null }));
  return { page,page_size:size,total,total_pages:Math.max(1,Math.ceil(total/size)),items,
    meta: { ...meta, scope:'当前未删除客户，当前归属；创建日期过滤排除创建时间未知客户',
      unknown_creation_count:db.prepare('SELECT COUNT(*) n FROM customers WHERE created_at IS NULL').get().n,
      creation_history_complete:false } };
}
function transactions(db, query) {
  const start = dateParam(query.start), end = dateParam(query.end); range(start,end);
  const responsible = idParam(query.responsible_id), customer = idParam(query.customer_id), {page,size}=pagination(query);
  const clauses=[],params=[];
  if(start) {clauses.push('l.event_date>=?');params.push(start);}
  if(end) {clauses.push('l.event_date<=?');params.push(end);}
  if(responsible!==null) {clauses.push("a.source!='legacy_unverified' AND COALESCE(s.responsible_id,s.user_id)=?");params.push(responsible);}
  if(customer!==null) {clauses.push('l.customer_id=?');params.push(customer);}
  const joins=` FROM customer_ledger l LEFT JOIN customer_ledger_accounts a ON a.ledger_id=l.id
    LEFT JOIN sales_orders s ON s.id=a.account_id LEFT JOIN users u ON u.id=COALESCE(s.responsible_id,s.user_id)`;
  const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
  const total=db.prepare('SELECT COUNT(*) n'+joins+where).get(...params).n;
  const rows=db.prepare(`SELECT l.*,a.account_id,a.source,CASE WHEN a.source='legacy_unverified' THEN NULL ELSE COALESCE(s.responsible_id,s.user_id) END responsible_id,
    CASE WHEN a.source='legacy_unverified' THEN NULL ELSE u.name END responsible_name
    ${joins}${where} ORDER BY l.event_date,l.id LIMIT ? OFFSET ?`).all(...params,size,(page-1)*size);
  const items=rows.map(r => {
    const c=cash(r), known=['收款','退款'].includes(r.event_kind);
    return { id:r.id,event_date:r.event_date,recorded_at:r.created_at.replace(' ','T')+'Z',
      occurred_at:known ? r.created_at.replace(' ','T')+'Z' : null,event_kind:r.event_kind,
      is_cash_event:known, cash_date_complete:known, customer_id:r.customer_id,
      document_type:r.document_type,document_id:r.document_id,document_date:r.document_date,
      account_id:r.account_id,account_source:r.source,account_attribution_complete:r.source!==null&&r.source!=='legacy_unverified',responsible_id:r.responsible_id??null,responsible_name:r.responsible_name??null,
      operator_id:r.user_id,operator_name:r.user_name,
      receipt_amount:known?money(c.receipt):null,refund_amount:known?money(c.refund):null,
      accounting:{sales:money(r.sales_cents),received:money(r.received_cents),returned:money(r.returned_cents),refunded:money(r.refunded_cents)},
      reason:known?null:'非明确现金事件；审核入账可能含日期未知预收款，冲销/结转不代表现金' };
  });
  return {page,page_size:size,total,total_pages:Math.max(1,Math.ceil(total/size)),items,meta:metadata(db)};
}
function dailyAnalysis(db, date, tenant, now = Date.now()) {
  const today = new Date(now+28800000).toISOString().slice(0,10);
  date=dateParam(date)||shiftDate(today,-1);
  if (date>=today) invalid('日报统计日期必须早于北京时间今天');
  const month=date.slice(0,7)+'-01', previous=shiftDate(month,-1), meta=metadata(db);
  const roster=db.prepare(`SELECT DISTINCT u.id,u.name FROM report_salespeople r JOIN users u ON u.id=r.user_id
    WHERE u.role='operator' AND r.start_date<=? AND (r.end_date IS NULL OR r.end_date>=?) ORDER BY u.id`).all(date,month);
  const rosterIds=new Set(roster.map(r=>r.id));
  const rosterConfirmed=db.prepare("SELECT value FROM report_metadata WHERE key='roster_confirmed'").get()?.value==='true';
  const owner = id => rosterIds.has(id) ? id : null;
  const fullRows=ledgerRows(db,'9999-12-31');
  const rows=fullRows.filter(r=>r.event_date<=date);
  // 尚未审核但已填 paid_amount 的订单也可能已经现金收款，不能遗漏不确定性。
  const pending=db.prepare(`SELECT s.created_at,s.paid_amount,COALESCE(s.responsible_id,s.user_id) responsible_id
    FROM sales_orders s WHERE s.paid_amount>0 AND NOT EXISTS(SELECT 1 FROM customer_ledger l
      WHERE l.document_type='sales' AND l.document_id=s.id AND l.received_cents>0)`)
    .all().filter(r=>localDate(r.created_at)<=date);
  const groups=new Map([...roster.map(r=>[r.id,{user_id:r.id,user_name:r.name}]),[null,{user_id:null,user_name:'未分配'}]]);
  const company={};
  function periods(target, groupId, all=false) {
    const selected=all?rows:rows.filter(r=>owner(r.responsible_id)===groupId);
    const pendingSelected=all?pending:pending.filter(r=>owner(r.responsible_id)===groupId);
    for (const [key,start] of [['daily',date],['month_to_date',month]]) {
      const sales=selected.filter(r=>r.document_date>=start&&r.document_date<=date);
      const amount=sales.reduce((s,r)=>s+r.sales_cents-r.returned_cents,0);
      const ret=sales.reduce((s,r)=>s+r.returned_cents,0);
      const complete=start>=meta.ledger_available_from;
      const profitComplete=complete&&sales.every(r=>(!r.sales_cents&&!r.returned_cents)||r.profit_cents!=null);
      const cashRows=selected.filter(r=>r.event_date>=start);
      const received=cashRows.reduce((s,r)=>s+cash(r).receipt,0), refunded=cashRows.reduce((s,r)=>s+cash(r).refund,0);
      const cashComplete=start>=meta.cash_available_from&&!fullRows.filter(r=>all||owner(r.responsible_id)===groupId).some(r=>uncertainCash(r,start,date))&&!pendingSelected.length;
      const profit=profitComplete?sales.reduce((s,r)=>s+(r.profit_cents||0),0):null;
      target[key]={net_sales_amount:complete?money(amount):null,returns_amount:complete?money(ret):null,
        gross_profit_with_receivable:money(profit),gross_margin:profit!==null&&amount!==0?Math.round(profit/amount*1000000)/1000000:null,
        actual_receipts:cashComplete?money(received):null,cash_refunds:cashComplete?money(refunded):null,
        net_cash_received:cashComplete?money(received-refunded):null,known_receipts:money(received),known_cash_refunds:money(refunded),
        completeness:{sales:complete,profit:profitComplete,cash:cashComplete},
        reasons:{sales:complete?null:'期间早于账务流水升级结转起始日期',profit:profitComplete?null:'期间或入账成本快照不足，旧流水不能恢复历史毛利',
          cash:cashComplete?null:'期间早于流水起点，或存在现金发生日期未知的开单/审核预收款'}};
    }
  }
  periods(company,null,true);
  for(const [id,g] of groups) periods(g,id);
  const customerComplete=date>=meta.customer_history_available_from;
  const allCustomers=customerComplete?customersAt(db,date):[];
  function customerMetrics(target,id,all=false) {
    const selected=all?allCustomers:allCustomers.filter(r=>owner(r.operator_id)===id);
    target.customers={new_daily:customerComplete?selected.filter(r=>r.created_at&&localDate(r.created_at)===date).length:null,
      new_month_to_date:customerComplete&&month>=meta.customer_history_available_from?selected.filter(r=>r.created_at&&localDate(r.created_at)>=month).length:null,
      total_at_end:customerComplete?selected.length:null,complete:customerComplete,
      reason:customerComplete?null:'统计日早于客户历史基线完整日；旧创建/删除/归属历史不可恢复',
      month_reason:month>=meta.customer_history_available_from?null:'本月包含客户历史记录前的日期，新增数量不可恢复'};
    // 新增包含当天创建后删除的客户，按删除前最后归属计入，避免低估新增。
    if(customerComplete) {
      const created=db.prepare(`SELECT h.* FROM report_customer_history h WHERE h.created_at>=? AND h.created_at<?
        AND h.id=(SELECT h2.id FROM report_customer_history h2 WHERE h2.customer_id=h.customer_id AND h2.recorded_at<? ORDER BY h2.recorded_at DESC,h2.id DESC LIMIT 1)`)
        .all(utcBoundary(month),utcBoundary(shiftDate(date,1)),utcBoundary(shiftDate(date,1)))
        .filter(r=>all||owner(r.operator_id)===id);
      target.customers.new_daily=created.filter(r=>localDate(r.created_at)===date).length;
      if(month>=meta.customer_history_available_from) target.customers.new_month_to_date=created.length;
    }
  }
  customerMetrics(company,null,true);for(const [id,g] of groups) customerMetrics(g,id);
  function positions(cutoff) {
    const accounts=new Map();let reliable=cutoff>=meta.ledger_available_from;
    for(const r of rows.filter(r=>r.event_date<=cutoff)) {
      if(r.account_id==null||r.source==='legacy_unverified') reliable=false;
      const a=accounts.get(r.account_id)||{balance:0,customer:r.customer_id,owner:owner(r.responsible_id),date:null};
      a.balance+=r.sales_cents-r.received_cents-r.returned_cents+r.refunded_cents;
      if(r.document_type==='sales') { a.date=r.document_date; a.customer=r.customer_id; }
      accounts.set(r.account_id,a);
    }
    return {accounts:[...accounts.values()],reliable};
  }
  const end=positions(date), beginning=positions(previous);
  function debt(target,id,all=false) {
    const accounts=end.accounts.filter(a=>all||a.owner===id), opening=beginning.accounts.filter(a=>all||a.owner===id);
    const debtSum=accounts.reduce((s,a)=>s+Math.max(0,a.balance),0);
    const newReceivable=rows.filter(r=>(all||owner(r.responsible_id)===id)&&r.event_date>=month&&r.event_kind!=='升级结转')
      .reduce((s,r)=>s+Math.max(0,r.sales_cents),0);
    target.debt={receivable_at_end:end.reliable?money(debtSum):null,
      pending_refund_at_end:end.reliable?money(accounts.reduce((s,a)=>s+Math.max(0,-a.balance),0)):null,
      debtor_customer_count:end.reliable?new Set(accounts.filter(a=>a.balance>0).map(a=>a.customer??-1)).size:null,
      month_new_orders_remaining:end.reliable&&month>=meta.ledger_available_from?money(accounts.filter(a=>a.date>=month&&a.date<=date).reduce((s,a)=>s+Math.max(0,a.balance),0)):null,
      month_new_receivable:month>=meta.ledger_available_from?money(newReceivable):null,
      receivable_change_since_month_start:end.reliable&&beginning.reliable?money(debtSum-opening.reduce((s,a)=>s+Math.max(0,a.balance),0)):null,
      complete:end.reliable,reason:end.reliable?null:'早于账务起点，或存在无法核实的退货账户归属',
      month_reason:month>=meta.ledger_available_from&&beginning.reliable?null:'月初余额/本月流水历史不足'};
  }
  debt(company,null,true);for(const [id,g] of groups) debt(g,id);
  const people=[...groups.values()].filter(g=>g.user_id!==null).sort((a,b)=>(b.month_to_date.net_sales_amount??0)-(a.month_to_date.net_sales_amount??0)||a.user_id-b.user_id);
  people.forEach((g,i)=>g.rank= g.month_to_date.net_sales_amount===null?null:i+1);
  return {tenant_code:tenant.code,tenant_name:tenant.name,date,month_start:month,timezone:'Asia/Shanghai',
    fetched_at:new Date(now).toISOString(),cutoff_exclusive:shiftDate(date,1)+'T00:00:00+08:00',company,
    salespeople:people,unassigned:groups.get(null),meta:{...meta,roster_configured:roster.length>0,
      roster_complete:rosterConfirmed,
      roster_reason:rosterConfirmed?null:'业务员名单未配置，所有金额进入未分配；请部署时确认名单',
      historical_attribution_complete:false, sales_available_from:meta.ledger_available_from}};
}
module.exports={dailyAnalysis,customers,transactions,dateParam,metadata,shiftDate,utcBoundary};
