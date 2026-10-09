const assert=require('assert/strict');
const Database=require('better-sqlite3');
const {initSchema}=require('../lib/schema');
const {dailyAnalysis,customers,transactions,dateParam}=require('../lib/dailyAnalysis');
const {configure}=require('../scripts/report-roster-configure');
const db=new Database(':memory:');initSchema(db);
const tenant={code:'yongfeng',name:'示例永丰'};
db.prepare("UPDATE ledger_metadata SET value='2026-09-01' WHERE key='opening_date'").run();
db.prepare("UPDATE report_metadata SET value='2026-08-31 16:00:00' WHERE key='history_started_at'").run();
for(const [id,name,role] of [[1,'管理员','admin'],[2,'销售甲','operator'],[3,'无交易销售','operator'],[4,'财务','operator']])
  db.prepare('INSERT INTO users(id,username,password_hash,name,role) VALUES(?,?,?,?,?)').run(id,'test'+id,'test',name,role);
db.prepare("INSERT INTO warehouses(id,name) VALUES(1,'测试仓')").run();
db.prepare("INSERT INTO products(id,name) VALUES(1,'测试品')").run();
configure(db,[{user_id:2,start_date:'2026-09-01'},{user_id:3,start_date:'2026-09-01'}]);
assert.throws(()=>configure(db,[{user_id:1,start_date:'2026-09-01'}]),/管理员/);
for(const [id,name,operator] of [[1,'旧客户',2],[2,'午夜新客户',2],[3,'未分配客户',null]])
  db.prepare('INSERT INTO customers(id,name,operator_id) VALUES(?,?,?)').run(id,name,operator);
// 追加测试历史，真实数据库由触发器写入；UTC 16:00 是次日北京时间 00:00。
for(const [id,operator,created,recorded,deleted] of [
  [1,2,null,'2026-08-31 16:00:00',0],[2,2,'2026-09-30 16:00:00','2026-09-30 16:00:00',0],
  [3,null,'2026-10-01 15:59:59','2026-10-01 15:59:59',0],
  [1,3,null,'2026-10-01 16:00:00',0], // 次日调整，昨天归属不受影响
  [3,null,'2026-10-01 15:59:59','2026-10-02 00:00:00',1]])
  db.prepare('INSERT INTO report_customer_history(customer_id,name,operator_id,created_at,recorded_at,deleted) VALUES(?,?,?,?,?,?)').run(id,'测试客户',operator,created,recorded,deleted);
function sale(id,date,total,cost,responsible=2,customer=1) {
 db.prepare(`INSERT INTO sales_orders(id,customer_id,warehouse_id,user_id,responsible_id,order_date,total_amount,status,created_at)
 VALUES(?,?,1,4,?,?,?,'approved',?)`).run(id,customer,responsible,date,total,date+' 00:00:00');
 db.prepare('INSERT INTO sales_order_items(sales_order_id,product_id,quantity,base_quantity,unit_price,cost_price_snapshot) VALUES(?,1,1,1,?,?)').run(id,total,cost);
}
function ret(id,saleId,date,total,cost) {
 db.prepare(`INSERT INTO return_orders(id,customer_id,warehouse_id,user_id,related_sales_order_id,order_date,total_amount,status)
 VALUES(?,1,1,4,?,?,?,'approved')`).run(id,saleId,date,total);
 db.prepare('INSERT INTO return_order_items(return_order_id,product_id,quantity,base_quantity,unit_price,cost_price_snapshot,original_sales_item_id) VALUES(?,1,1,1,?,?,?)').run(id,total,cost,saleId?1:null);
}
function event(type,id,date,kind,sales=0,received=0,returned=0,refunded=0,created=date+' 00:00:00') {
 const doc=db.prepare('SELECT * FROM '+(type==='sales'?'sales_orders':'return_orders')+' WHERE id=?').get(id);
 db.prepare(`INSERT INTO customer_ledger(customer_id,document_type,document_id,document_date,event_date,event_kind,sales_cents,received_cents,returned_cents,refunded_cents,user_id,user_name,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,4,'财务',?)`).run(doc.customer_id,type,id,doc.order_date,date,kind,sales,received,returned,refunded,created);
}
sale(1,'2026-09-15',1000,600);event('sales',1,'2026-09-15','审核入账',100000);
event('sales',1,'2026-10-01','收款',0,20000);event('sales',1,'2026-10-01','收款',0,10000);
event('sales',1,'2026-10-02','收款',0,20000); // cutoff 排除
sale(2,'2026-10-01',500,300);event('sales',2,'2026-10-01','审核入账',50000);
ret(1,2,'2026-10-01',100,60);event('returns',1,'2026-10-01','审核入账',0,0,10000);
event('sales',2,'2026-10-01','收款',0,50000);event('returns',1,'2026-10-01','退款',0,0,0,5000);
ret(2,null,'2026-10-01',50,30);event('returns',2,'2026-10-01','审核入账',0,0,5000);
sale(3,'2026-10-01',100,60,4);event('sales',3,'2026-10-01','审核入账',10000);
event('sales',3,'2026-10-01','反审核冲销',-10000);
sale(4,'2026-08-01',200,120);event('sales',4,'2026-09-01','升级结转',20000,10000);
const report=dailyAnalysis(db,'2026-10-01',tenant,Date.parse('2026-10-02T05:00:00+08:00'));
if (process.env.REPORT_WRITE_EXAMPLE === '1') {
 const fs=require('fs'),path=require('path');
 fs.mkdirSync(path.join(__dirname,'../docs/examples'),{recursive:true});
 fs.writeFileSync(path.join(__dirname,'../docs/examples/daily-analysis.json'),JSON.stringify(report,null,2)+'\n');
}
assert.equal(report.company.daily.net_sales_amount,350);assert.equal(report.company.daily.gross_profit_with_receivable,140);
assert.equal(report.company.daily.actual_receipts,800);assert.equal(report.company.daily.cash_refunds,50);
assert.equal(report.company.daily.net_cash_received,750);
assert.equal(report.company.debt.receivable_at_end,800);assert.equal(report.company.debt.pending_refund_at_end,100);
assert.equal(report.company.debt.month_new_orders_remaining,0);assert.equal(report.company.debt.month_new_receivable,600);
assert.equal(report.company.debt.receivable_change_since_month_start,-300);
assert.equal(report.company.debt.debtor_customer_count,1);
assert.equal(report.company.customers.total_at_end,3);assert.equal(report.company.customers.new_daily,2);
assert.deepEqual(report.salespeople.map(p=>p.user_id),[2,3]);assert.equal(report.salespeople[1].daily.net_sales_amount,0);
assert.equal(report.salespeople[0].daily.actual_receipts,800);assert.equal(report.salespeople[1].customers.total_at_end,0);
assert.equal(report.unassigned.daily.net_sales_amount,-50);assert.equal(report.unassigned.customers.total_at_end,1);
for(const key of ['net_sales_amount','returns_amount','gross_profit_with_receivable','actual_receipts','cash_refunds','net_cash_received'])
 assert.equal(report.company.daily[key],report.salespeople.reduce((s,p)=>s+p.daily[key],report.unassigned.daily[key]));
const later=dailyAnalysis(db,'2026-10-02',tenant,Date.parse('2026-10-03T05:00:00+08:00'));
assert.equal(later.salespeople[1].customers.total_at_end,1);assert.equal(later.company.customers.total_at_end,2);
assert.equal(later.company.debt.receivable_at_end,600);
assert.equal(dailyAnalysis(db,undefined,tenant,Date.parse('2026-10-01T16:00:00Z')).date,'2026-10-01');
assert.throws(()=>dateParam('2026-02-30'));assert.throws(()=>dateParam('2026-13-01'));assert.throws(()=>dateParam(['2026-10-01']));
assert.throws(()=>dailyAnalysis(db,'2026-10-03',tenant,Date.parse('2026-10-03T05:00:00+08:00')));
assert.throws(()=>transactions(db,{start:'2026-10-02',end:'2026-10-01'}));
assert.throws(()=>customers(db,{operator_id:'0'}));assert.throws(()=>customers(db,{pageSize:'201'}));
const tx=transactions(db,{start:'2026-10-01',end:'2026-10-01',responsible_id:'2',pageSize:'1'});
assert.equal(tx.total,6);assert.equal(tx.items[0].responsible_id,2);assert.equal(tx.items[0].operator_id,4);
assert.equal(tx.items[0].receipt_amount,200);assert.equal(tx.items[0].is_cash_event,true);
const reverse=transactions(db,{start:'2026-10-01',responsible_id:'4'}).items.find(r=>r.event_kind==='反审核冲销');
assert.equal(reverse.is_cash_event,false);assert.equal(reverse.receipt_amount,null);
const history=dailyAnalysis(db,'2026-08-01',tenant,Date.parse('2026-10-03T05:00:00+08:00'));
assert.equal(history.company.daily.actual_receipts,null);assert.equal(history.company.debt.receivable_at_end,null);
assert.equal(history.company.customers.total_at_end,null);
// 初始 paid_amount 无现金日期，审核不是现金；反审核不抹去已知现金。
sale(5,'2026-10-01',100,60);event('sales',5,'2026-10-01','审核入账',10000,2000);
const unknown=dailyAnalysis(db,'2026-10-01',tenant,Date.parse('2026-10-02T05:00:00+08:00'));
assert.equal(unknown.company.daily.actual_receipts,null);assert.equal(unknown.company.daily.known_receipts,800);
event('sales',5,'2026-10-02','反审核冲销',-10000,-2000);
assert.equal(dailyAnalysis(db,'2026-10-02',tenant,Date.parse('2026-10-03T05:00:00+08:00')).company.daily.actual_receipts,200);
// 当前订单负责人变更，明确披露重归属规则；不是按财务操作人。
db.prepare('UPDATE sales_orders SET responsible_id=3 WHERE id=1').run();
const reassigned=dailyAnalysis(db,'2026-10-01',tenant,Date.parse('2026-10-02T05:00:00+08:00'));
assert.equal(reassigned.salespeople.find(p=>p.user_id===3).daily.known_receipts,300);
assert.equal(reassigned.meta.historical_attribution_complete,false);
// 老订单无负责人回退录单人；同客户跨分组欠款公司再次去重。
sale(6,'2026-10-01',100,60,null);
db.prepare('UPDATE sales_orders SET user_id=2 WHERE id=6').run();
event('sales',6,'2026-10-01','审核入账',10000);
const fallback=dailyAnalysis(db,'2026-10-01',tenant,Date.parse('2026-10-02T05:00:00+08:00'));
assert.equal(transactions(db,{responsible_id:'2'}).items.find(r=>r.document_id===6).responsible_id,2);
assert.equal(fallback.company.debt.debtor_customer_count,1);
assert.equal(fallback.salespeople.reduce((n,g)=>n+g.debt.debtor_customer_count,0),2);
// 遗留流水缺失毛利事实，不可用当前单据成本伪造。
const factTrigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='report_ledger_fact_insert'").get().sql;
db.exec('DROP TRIGGER report_ledger_fact_insert');
sale(7,'2026-10-01',100,60);event('sales',7,'2026-10-01','审核入账',10000);
db.exec(factTrigger);
assert.equal(dailyAnalysis(db,'2026-10-01',tenant,Date.parse('2026-10-02T05:00:00+08:00')).company.daily.gross_profit_with_receivable,null);
// 未来审核带入预收款，可能在昨日现金发生，不能因审核日较晚就隐藏不确定性。
sale(8,'2026-10-01',100,60);event('sales',8,'2026-10-03','审核入账',10000,5000);
assert.equal(dailyAnalysis(db,'2026-10-02',tenant,Date.parse('2026-10-03T05:00:00+08:00')).company.daily.actual_receipts,null);
// 结转当天此前的现金无法恢复，不称作完整现金日。
assert.equal(dailyAnalysis(db,'2026-09-01',tenant,Date.parse('2026-10-02T05:00:00+08:00')).company.daily.actual_receipts,null);
// 历史退货账户未核实则日末余额为空。
db.prepare('DROP TRIGGER customer_ledger_accounts_no_update').run();
db.prepare("UPDATE customer_ledger_accounts SET source='legacy_unverified' WHERE ledger_id=(SELECT id FROM customer_ledger WHERE document_type='returns' LIMIT 1)").run();
assert.equal(dailyAnalysis(db,'2026-10-01',tenant,Date.parse('2026-10-02T05:00:00+08:00')).company.debt.receivable_at_end,null);
// 迁移幂等与只追加保护。
assert.throws(()=>db.prepare('DELETE FROM report_customer_history').run(),/只允许追加/);
assert.throws(()=>db.prepare('UPDATE report_ledger_facts SET profit_cents=0').run(),/只允许追加/);
initSchema(db);db.close();
console.log('PASS 日报：跨月、分批、退款、抵扣、冲销、结转、归属、客户历史、零交易、边界、完整性、校验、对账');
