// 退货流程与历史数据完整性：真实路由、固定 v12 旧库及故障注入，全部使用临时数据。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express'), Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-return-workflow-'));
process.env.JXC_DATA_DIR = dir;
const { initSchema } = require('../lib/schema');
const { initSchema: initV12 } = require('./fixtures/schema-v12');
const { statement } = require('../lib/customerLedger');
const { getSalePayment, profitOfPeriod } = require('../lib/profitCalc');
const { todayLocalDate, formatDateTime } = require('../utils/dates');
const today = todayLocalDate();
let server, base, passes = 0;
const db = new Database(path.join(dir, 'test.db')); initSchema(db);
const check = async (label, work) => { await work(); passes++; console.log('  PASS  ' + label); };
const count = table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const financialTables = ['inventory','stock_transactions','sales_orders','sales_order_items','return_orders','return_order_items','customer_ledger','customer_ledger_accounts','audit_logs','return_refund_records','mutation_requests'];
const snapshot = () => Object.fromEntries(financialTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
async function request(route, body, user = 1) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', redirect:'manual',
    headers: { 'X-Test-User':String(user), ...(body ? {'Content-Type':'application/x-www-form-urlencoded'} : {}) },
    ...(body ? {body:new URLSearchParams(body)} : {}) });
  return { status:response.status, location:response.headers.get('location'), text:await response.text() };
}
const post = (route, body = {}, user = 1) => request(route, { _request_key:randomUUID(), ...body }, user);
const idOf = response => { assert.equal(response.status,302,response.text); return Number(response.location.match(/\/(\d+)/)[1]); };
async function sale(paid, items = [{id:1,quantity:10,price:100}]) {
  const id = idOf(await post('/sales/new',{warehouse_id:'1',customer_id:'1',customer_search:'客户甲',paid_amount:String(paid),items_json:JSON.stringify(items)}));
  assert.equal((await post('/sales/approve/'+id)).status,302); return id;
}
function returnBody(saleId, quantity = 4, extra = {}) {
  const original = db.prepare('SELECT * FROM sales_order_items WHERE sales_order_id=? ORDER BY id').get(saleId);
  return { warehouse_id:'1', customer_id:'1', related_sales_order_id:String(saleId),
    items_json:JSON.stringify([{id:original.product_id,quantity,price:original.unit_price,original_sales_item_id:original.id,unit_choice:original.base_quantity>original.quantity?'pack':'base'}]), ...extra };
}
const approveReturn = id => post('/returns/approve/'+id,{goods_received:'1'});
(async () => {
  db.exec(`INSERT INTO users(username,password_hash,name,role,audit_log_owner) VALUES ('admin','x','管理员','admin',1),('operator','x','业务员','operator',0),('other','x','其他业务员','operator',0);
    INSERT INTO warehouses(name,operator_id) VALUES ('总仓',NULL),('车辆仓',2);
    INSERT INTO customers(name,operator_id) VALUES ('客户甲',2);
    INSERT INTO products(name,sku,unit,pack_unit,pack_size,cost_price,sale_price) VALUES ('测试饮品','RETURN','瓶','箱',10,3,100);
    INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES (1,1,1000),(1,2,1000);`);
  const app = express(); app.set('view engine','ejs'); app.set('views',path.join(__dirname,'../views')); app.use(express.urlencoded({extended:true}));
  app.use((req,res,next) => { req.tenantDb=db; req.session={user:{id:Number(req.get('X-Test-User'))||1}}; req.requestId=randomUUID(); req.tenant={name:'退货测试',tenant_code:'test'};
    res.locals={currentUser:db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id),currentTenant:req.tenant,currentPath:req.path,newRequestKey:randomUUID,csrfToken:'test',formatDateTime}; next(); });
  for (const route of ['sales','returns','reconciliation','printing']) app.use(require('../routes/'+route));
  app.use((error,req,res,next) => res.status(500).send(error.message));
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); base='http://127.0.0.1:'+server.address().port;
  await check('v12 原库迁移保留所有金额、明细、库存与流水；恢复当时原单归属，不重写旧账', () => {
    const old = new Database(path.join(dir,'old.db')); initV12(old);
    old.exec(`INSERT INTO users(username,password_hash,name,role) VALUES ('old','x','旧管理员','admin');
      INSERT INTO warehouses(name) VALUES ('旧仓'); INSERT INTO customers(name) VALUES ('旧客户');
      INSERT INTO products(name,unit,cost_price,sale_price) VALUES ('旧商品','瓶',2,10);
      INSERT INTO inventory VALUES (1,1,83);
      INSERT INTO sales_orders(customer_id,warehouse_id,user_id,order_date,total_amount,paid_amount,status) VALUES (1,1,1,'2026-09-30',100,100,'approved'),(1,1,1,'2026-09-30',100,0,'approved');
      INSERT INTO sales_order_items(sales_order_id,product_id,quantity,unit_label,base_quantity,unit_price,cost_price_snapshot) VALUES (1,1,10,'瓶',10,10,2),(2,1,10,'瓶',10,10,2);
      INSERT INTO return_orders(customer_id,warehouse_id,user_id,related_sales_order_id,order_date,total_amount,status) VALUES (1,1,1,2,'2026-09-30',30,'approved');
      INSERT INTO return_order_items(return_order_id,product_id,quantity,unit_label,base_quantity,unit_price,cost_price_snapshot) VALUES (1,1,3,'瓶',3,10,9);
      INSERT INTO stock_transactions(product_id,warehouse_id,change_qty,type,ref_type,ref_id,user_id) VALUES (1,1,3,'sale_return','return_order',1,1);
      UPDATE ledger_metadata SET value='2026-09-30' WHERE key='opening_date';`);
    const ledger=old.prepare("INSERT INTO customer_ledger(customer_id,document_type,document_id,document_date,event_date,event_kind,sales_cents,received_cents,returned_cents,request_id) VALUES (1,?,?, '2026-09-30',?,?,?,?,?,?)");
    ledger.run('sales',1,'2026-09-30','审核入账',10000,10000,0,'s1'); ledger.run('sales',2,'2026-09-30','审核入账',10000,0,0,'s2');
    ledger.run('returns',1,'2026-09-30','审核入账',0,0,3000,'first'); ledger.run('returns',1,today,'反审核冲销',0,0,-3000,'reverse'); ledger.run('returns',1,today,'审核入账',0,0,3000,'second');
    const audit=old.prepare("INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,details_json,request_id) VALUES (1,'旧管理员','测试','退货单',1,?,?)");
    for (const [requestId,before,after] of [['first',null,1],['reverse',1,1],['second',2,2]]) audit.run(JSON.stringify({before:{fields:{关联销售单:before}},after:{fields:{关联销售单:after}}}),requestId);
    const tables=['sales_orders','sales_order_items','return_orders','return_order_items','inventory','stock_transactions','customer_ledger','audit_logs','products','customers'];
    const before=Object.fromEntries(tables.map(table=>[table,old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    initSchema(old);
    for (const table of tables) {
      const after=old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      assert.deepEqual(after.map(row=>Object.fromEntries(Object.keys(before[table][0]||{}).map(key=>[key,row[key]]))),before[table],table);
    }
    assert.equal(require('../routes/report').getSummary(old).profitWithReceivable,136);
    assert.equal(old.prepare('SELECT cost_price_snapshot FROM return_order_items').get().cost_price_snapshot,9);
    let data=statement(old,1,'2026-09-30','2026-09-30'); assert.equal(data.receivable,10000); assert.equal(data.refundPending,3000); assert.equal(data.ending,7000);
    data=statement(old,1,today,today); assert.equal(data.receivable,7000); assert.equal(data.refundPending,0);
    assert.equal(old.prepare("SELECT account_id FROM customer_ledger_accounts WHERE ledger_id=3").get().account_id,1);
    const accounts=old.prepare('SELECT * FROM customer_ledger_accounts').all(); initSchema(old); assert.deepEqual(old.prepare('SELECT * FROM customer_ledger_accounts').all(),accounts);
    assert.equal(old.pragma('integrity_check',{simple:true}),'ok'); assert.deepEqual(old.pragma('foreign_key_check'),[]);
    assert.throws(()=>old.prepare('UPDATE customer_ledger_accounts SET account_id=2 WHERE ledger_id=3').run(),/只允许追加/);
    old.close();
  });
  await check('失败的升级全部回滚，保留 v12 旧库及所有钱货数据', () => {
    const old=new Database(path.join(dir,'migration-fail.db'));initV12(old);
    old.exec("INSERT INTO customer_ledger(document_type,document_id,document_date,event_date,event_kind,returned_cents,request_id) VALUES ('returns',1,'2026-09-30','2026-09-30','审核入账',100,'bad'); INSERT INTO audit_logs(user_name,action,entity_type,entity_id,details_json,request_id) VALUES ('旧管理员','审核','退货单',1,'损坏的 JSON','bad');");
    const before=old.prepare('SELECT * FROM customer_ledger').all();assert.throws(()=>initSchema(old),/迁移失败 v13/);
    assert.equal(old.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,12);
    assert.deepEqual(old.prepare('SELECT * FROM customer_ledger').all(),before);assert.equal(old.prepare("SELECT COUNT(*) n FROM pragma_table_info('return_orders') WHERE name='finalized_at'").get().n,0);old.close();
  });
  await check('缺少审计的旧退货保留金额并标记待核对，仅提示受影响客户',()=>{
    const old=new Database(path.join(dir,'unverified.db'));initV12(old);
    old.exec(`INSERT INTO users(username,password_hash,name,role) VALUES ('old','x','旧管理员','admin');
      INSERT INTO warehouses(name) VALUES ('旧仓'); INSERT INTO customers(name) VALUES ('旧客户'),('其他客户');
      INSERT INTO return_orders(customer_id,warehouse_id,user_id,order_date,total_amount,status) VALUES (1,1,1,'2026-09-30',30,'approved');`);
    old.prepare("INSERT INTO customer_ledger(customer_id,document_type,document_id,document_date,event_date,event_kind,returned_cents,request_id) VALUES (1,'returns',1,'2026-09-30',?,'审核入账',3000,'missing-audit')").run(today);
    const before=old.prepare('SELECT * FROM customer_ledger').all();initSchema(old);
    assert.deepEqual(old.prepare('SELECT * FROM customer_ledger').all(),before);
    const result=statement(old,1,today,today);assert.equal(result.ending,-3000);assert.equal(result.refundPending,3000);assert.equal(result.unverifiedReturnAccounts,1);
    assert.equal(statement(old,2,today,today).unverifiedReturnAccounts,0);
    assert.deepEqual(old.prepare('SELECT account_id,source FROM customer_ledger_accounts').get(),{account_id:-1,source:'legacy_unverified'});old.close();
  });
  await check('普通退货必须找原单；无原单只允许管理员留核实依据；不能在开单时退款',async()=>{
    const body={warehouse_id:'2',items_json:JSON.stringify([{id:1,quantity:1,price:100}])};
    const before=count('return_orders');assert.equal((await post('/returns/new',body,2)).status,400);assert.equal((await post('/returns/new',{...body,exception_reason:'凭证已核对'},2)).status,400);
    assert.equal((await post('/returns/new',body)).status,400);assert.equal(count('return_orders'),before);
    const s=await sale(1000);assert.equal((await post('/returns/new',returnBody(s,1,{refunded_amount:'1'}))).status,400);
    const id=idOf(await post('/returns/new',{...body,exception_reason:'纸质原凭证、数量和价格已由客户确认'}));
    assert.match((await request('/returns/'+id)).text, /当前可退现金<\/span><strong[^>]*>¥0\.00<\/strong>/);
    assert.equal((await approveReturn(id)).status,302);
  });
  await check('收到实物前不变库存不入账；部分收款先抵原单欠款，显示已结清',async()=>{
    const s=await sale(600),id=idOf(await post('/returns/new',returnBody(s)));
    const before=snapshot();assert.equal((await post('/returns/approve/'+id)).status,400);assert.deepEqual(snapshot(),before);
    assert.equal((await approveReturn(id)).status,302);const pay=getSalePayment(db,s);assert.equal(pay.effective_debt,0);assert.equal(pay.pending_refund,0);
    assert.ok((await request('/returns/'+id)).text.includes('已结清'));assert.equal((await post(`/returns/${id}/record-refund`,{amount:'1',refund_reference:'付款凭据'})).status,400);
  });
  await check('混合抵欠款及退款：只退多收金额，需凭据，重试不会重复退款或入账',async()=>{
    const s=await sale(800),id=idOf(await post('/returns/new',returnBody(s)));await approveReturn(id);assert.equal(getSalePayment(db,s).pending_refund,200);
    let before=snapshot();assert.equal((await post(`/returns/${id}/record-refund`,{amount:'201',refund_reference:'付款凭据'})).status,400);assert.deepEqual(snapshot(),before);
    assert.equal((await post(`/returns/${id}/record-refund`,{amount:'200'})).status,400);assert.deepEqual(snapshot(),before);
    const body={amount:'200',refund_reference:'银行转账流水 TEST-200',_request_key:randomUUID()};const first=await request(`/returns/${id}/record-refund`,body);assert.equal(first.status,302);
    const after=snapshot();assert.deepEqual(await request(`/returns/${id}/record-refund`,body),first);assert.deepEqual(snapshot(),after);
    assert.equal(getSalePayment(db,s).pending_refund,0);assert.equal(db.prepare('SELECT amount_cents FROM return_refund_records WHERE return_order_id=?').get(id).amount_cents,20000);
    before=snapshot();assert.equal((await post(`/returns/${id}/cancel`,{cancel_reason:'录错',goods_reversal_confirmed:'1'})).status,400);assert.deepEqual(snapshot(),before);
  });
  await check('原商品价格/箱规/成本改动不改变退货快照，拒绝改价和猜测重复商品来源',async()=>{
    const s=await sale(0,[{id:1,quantity:2,price:500,unit_choice:'pack'}]);
    db.prepare("UPDATE products SET cost_price=9,pack_size=12,pack_unit='大箱',sale_price=999 WHERE id=1").run();
    const id=idOf(await post('/returns/new',returnBody(s,1)));const item=db.prepare('SELECT * FROM return_order_items WHERE return_order_id=?').get(id);
    assert.equal(item.base_quantity,10);assert.equal(item.unit_label,'箱');assert.equal(item.cost_price_snapshot,3);assert.equal(item.unit_price,500);
    assert.equal((await approveReturn(id)).status,302);assert.equal((await post('/returns/new',returnBody(s,1,{items_json:JSON.stringify([{id:1,quantity:1,price:501,original_sales_item_id:item.original_sales_item_id}])}))).status,400);
    db.prepare("UPDATE products SET cost_price=3,pack_size=10,pack_unit='箱',sale_price=100 WHERE id=1").run();
    const duplicate=await sale(0,[{id:1,quantity:1,price:100},{id:1,quantity:1,price:0,is_gift:true}]);
    assert.equal((await post('/returns/new',{warehouse_id:'1',customer_id:'1',related_sales_order_id:String(duplicate),items_json:JSON.stringify([{id:1,quantity:1,price:100}])})).status,400);
    assert.equal((await post('/returns/new',returnBody(duplicate,1))).status,302);
  });
  await check('已入账退货及原销售不可反审核或改写；数据库也保护原金额与明细',async()=>{
    const s=await sale(1000),id=idOf(await post('/returns/new',returnBody(s)));await approveReturn(id);const before=snapshot(),profit=profitOfPeriod(db).profit;
    assert.equal((await post('/returns/unapprove/'+id)).status,400);assert.equal((await post(`/returns/${id}/edit`,{draft_revision:'1',...returnBody(s)})).status,400);
    assert.equal((await post('/sales/unapprove/'+s)).status,400);assert.deepEqual(snapshot(),before);assert.equal(profitOfPeriod(db).profit,profit);
    assert.throws(()=>db.prepare('UPDATE return_orders SET related_sales_order_id=NULL WHERE id=?').run(id),/不可改写/);
    assert.throws(()=>db.prepare('DELETE FROM return_order_items WHERE return_order_id=?').run(id),/不可改写/);
    assert.throws(()=>db.prepare('UPDATE sales_order_items SET cost_price_snapshot=0 WHERE sales_order_id=?').run(s),/不可改写/);
    assert.throws(()=>db.prepare('UPDATE sales_orders SET total_amount=0 WHERE id=?').run(s),/不可改写/);
    assert.throws(()=>db.prepare("UPDATE return_orders SET received_at='2000-01-01' WHERE id=?").run(id),/不可改写/);
    const draft=idOf(await post('/returns/new',returnBody(s,1,{save_draft:'1'})));
    const otherSale=await sale(0);
    const protectedSnapshot=snapshot();
    assert.throws(()=>db.prepare('UPDATE return_order_items SET return_order_id=? WHERE return_order_id=?').run(id,draft),/不可改写/);
    assert.throws(()=>db.prepare('UPDATE sales_order_items SET sales_order_id=? WHERE sales_order_id=?').run(s,otherSale),/不可改写/);
    assert.deepEqual(snapshot(),protectedSnapshot);
  });
  await check('撤销保留原记录、生成反向库存与对账；重复请求只冲销一次，不能重新编辑',async()=>{
    const s=await sale(0),id=idOf(await post('/returns/new',returnBody(s)));await approveReturn(id);
    const original=db.prepare('SELECT * FROM return_orders WHERE id=?').get(id),items=db.prepare('SELECT * FROM return_order_items WHERE return_order_id=?').all(id);
    const quantity=db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity;
    const before=snapshot();assert.equal((await post(`/returns/${id}/cancel`,{cancel_reason:'录错'})).status,400);assert.deepEqual(snapshot(),before);
    const body={cancel_reason:'原收货记录有误，核实后重开',goods_reversal_confirmed:'1',_request_key:randomUUID()};const first=await request(`/returns/${id}/cancel`,body);assert.equal(first.status,302);
    const after=snapshot();assert.deepEqual(await request(`/returns/${id}/cancel`,body),first);assert.deepEqual(snapshot(),after);
    const order=db.prepare('SELECT * FROM return_orders WHERE id=?').get(id);for(const field of ['related_sales_order_id','customer_id','total_amount','refunded_amount','finalized_at'])assert.equal(order[field],original[field]);
    assert.deepEqual(db.prepare('SELECT * FROM return_order_items WHERE return_order_id=?').all(id),items);
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity,quantity-4);
    assert.equal(db.prepare("SELECT SUM(returned_cents) n FROM customer_ledger WHERE document_type='returns' AND document_id=?").get(id).n,0);
    assert.equal(getSalePayment(db,s).effective_debt,1000);assert.equal((await post('/returns/unapprove/'+id)).status,400);assert.equal((await post('/sales/unapprove/'+s)).status,400);
    assert.ok((await request('/returns/'+id)).text.includes('已撤销'));assert.ok((await request('/returns/'+id+'/print')).text.includes('不得作为有效退货凭据'));
    assert.equal((await post('/returns/new',returnBody(s))).status,302);
  });
  await check('并行待审核退货只批准额度内一单；超额失败无库存、账务、审计变化',async()=>{
    const s=await sale(0),first=idOf(await post('/returns/new',returnBody(s,6))),second=idOf(await post('/returns/new',returnBody(s,6)));
    assert.equal((await approveReturn(first)).status,302);const before=snapshot();assert.equal((await approveReturn(second)).status,400);assert.deepEqual(snapshot(),before);
  });
  await check('按商品合计保护库存，拒绝溢出或负库存；业务员不能撤销或退款',async()=>{
    const s=await sale(1000),body=returnBody(s,3),line=JSON.parse(body.items_json)[0];
    const id=idOf(await post('/returns/new',{...body,items_json:JSON.stringify([line,line])}));
    const previousQty=db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity;
    db.prepare('UPDATE inventory SET quantity=? WHERE product_id=1 AND warehouse_id=1').run(Number.MAX_SAFE_INTEGER);
    const overflowSnapshot=snapshot();assert.equal((await approveReturn(id)).status,400);assert.deepEqual(snapshot(),overflowSnapshot);
    db.prepare('UPDATE inventory SET quantity=? WHERE product_id=1 AND warehouse_id=1').run(previousQty);await approveReturn(id);
    const qty=db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity;
    db.prepare('UPDATE inventory SET quantity=5 WHERE product_id=1 AND warehouse_id=1').run();
    const before=snapshot();
    assert.equal((await post(`/returns/${id}/cancel`,{cancel_reason:'数量错误',goods_reversal_confirmed:'1'})).status,400);
    assert.deepEqual(snapshot(),before);
    assert.equal((await post(`/returns/${id}/cancel`,{cancel_reason:'数量错误',goods_reversal_confirmed:'1'},2)).status,403);
    assert.equal((await post(`/returns/${id}/record-refund`,{amount:'1',refund_reference:'凭据'},2)).status,403);
    assert.deepEqual(snapshot(),before);
    db.prepare('UPDATE inventory SET quantity=? WHERE product_id=1 AND warehouse_id=1').run(qty);
  });
  await check('对账归属或审计写入失败时，审核、库存、退款凭据及撤销全部回滚',async()=>{
    const s=await sale(1000),id=idOf(await post('/returns/new',returnBody(s)));
    db.exec("CREATE TRIGGER fail_account BEFORE INSERT ON customer_ledger_accounts BEGIN SELECT RAISE(ABORT,'归属写入失败'); END;");
    let before=snapshot();assert.equal((await approveReturn(id)).status,500);assert.deepEqual(snapshot(),before);db.exec('DROP TRIGGER fail_account');await approveReturn(id);
    db.exec("CREATE TRIGGER fail_return_audit BEFORE INSERT ON audit_logs WHEN NEW.entity_type='退货单' BEGIN SELECT RAISE(ABORT,'审计失败'); END;");
    before=snapshot();assert.equal((await post(`/returns/${id}/record-refund`,{amount:'50',refund_reference:'转账凭据'})).status,500);assert.deepEqual(snapshot(),before);
    assert.equal((await post(`/returns/${id}/cancel`,{cancel_reason:'录错',goods_reversal_confirmed:'1'})).status,500);assert.deepEqual(snapshot(),before);db.exec('DROP TRIGGER fail_return_audit');
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  });
  console.log(`退货流程与完整性回归：${passes} PASS / 0 FAIL`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(server)await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(dir,{recursive:true,force:true});});
