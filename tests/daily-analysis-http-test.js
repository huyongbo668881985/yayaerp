const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jxc-daily-api-'));
process.env.JXC_DATA_DIR=dir;process.env.API_RATE_LIMIT_PER_MIN='12';
const express=require('express');
const {createTenant,platformDb}=require('../lib/platformDb');
const {generateApiKey,revokeApiKey}=require('../lib/apiKeys');
const {getTenantDb}=require('../lib/tenantManager');
const {shiftDate}=require('../lib/dailyAnalysis');
const {todayLocalDate}=require('../utils/dates');
let server;const opened=[];
(async()=>{
 const date=shiftDate(todayLocalDate(),-1), keys=[];
 for(const [code,amount] of [['daily_a',100],['daily_b',777]]) {
  const tenant=createTenant(code,code);const {db}=getTenantDb(code);opened.push(db);
  db.exec("INSERT INTO users(username,password_hash,name,role) VALUES('test','test','测试管理员','admin');INSERT INTO warehouses(name) VALUES('测试仓');INSERT INTO products(name) VALUES('测试品');");
  db.prepare('INSERT INTO customers(name) VALUES(?)').run(code+'客户');
  db.prepare("UPDATE ledger_metadata SET value=? WHERE key='opening_date'").run(shiftDate(date,-40));
  db.prepare("UPDATE report_metadata SET value=? WHERE key='history_started_at'").run(shiftDate(date,-40)+' 00:00:00');
  db.prepare("INSERT INTO sales_orders(warehouse_id,user_id,customer_id,order_date,total_amount,status) VALUES(1,1,1,?,?,'approved')").run(date,amount);
  db.prepare('INSERT INTO sales_order_items(sales_order_id,product_id,quantity,base_quantity,unit_price,cost_price_snapshot) VALUES(1,1,1,1,?,0)').run(amount);
  db.prepare("INSERT INTO customer_ledger(customer_id,document_type,document_id,document_date,event_date,event_kind,sales_cents) VALUES(1,'sales',1,?,?,'审核入账',?)").run(date,date,amount*100);
  keys.push(generateApiKey({tenantId:tenant.id,permissionLevel:'read_only',adminId:1,adminUsername:'测试'}));
 }
 const app=express();app.use('/api/v1',require('../routes/apiV1'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const get=(url,key=keys[0].plaintext,method='GET')=>fetch(base+'/api/v1'+url,{method,headers:key?{Authorization:'Bearer '+key}:{}});
 const before=opened[0].prepare('SELECT total_changes() n').get().n;
 for(const endpoint of ['/reports/daily-analysis?date='+date]) {
  const a=await get(endpoint+'&tenant_code=daily_b&tenant_id=2'); // 对无 query 的路径改用下方明确调用
  if(endpoint.includes('?')) { assert.equal(a.status,200);const j=await a.json();assert.equal(j.tenant_code,'daily_a');assert.equal(j.company.daily.net_sales_amount,100); }
 }
 for(const endpoint of ['/customers','/finance/transactions']) {
  const a=await get(endpoint+'?tenant_code=daily_b&tenant_id=2'), b=await get(endpoint,keys[1].plaintext);
  assert.equal(a.status,200);assert.equal(b.status,200);
  const aj=await a.json(),bj=await b.json();
  assert.equal(aj.total,1);assert.equal(bj.total,1);
  if(endpoint==='/customers') {assert.equal(aj.items[0].name,'daily_a客户');assert.equal(bj.items[0].name,'daily_b客户');}
  else {assert.equal(aj.items[0].accounting.sales,100);assert.equal(bj.items[0].accounting.sales,777);}
 }
 const defaultDate=await get('/reports/daily-analysis');assert.equal((await defaultDate.json()).date,date);
 assert.equal(opened[0].prepare('SELECT total_changes() n').get().n,before,'GET 不写租户业务数据库');
 const validationKey=generateApiKey({tenantId:1,permissionLevel:'read_only',adminId:1,adminUsername:'测试'}).plaintext;
 for(const endpoint of ['/reports/daily-analysis?date=2026-02-30','/customers?created_start=2026-02-30','/customers?pageSize=201','/customers?operator_id=0','/finance/transactions?start=2026-10-02&end=2026-10-01','/finance/transactions?responsible_id=1.1']) {
  const r=await get(endpoint,validationKey);assert.equal(r.status,400);assert.equal((await r.json()).error.code,'invalid_param');
 }
 for(const endpoint of ['/reports/daily-analysis','/customers','/finance/transactions']) {
  assert.equal((await get(endpoint,null)).status,401);
  assert.equal((await get(endpoint,validationKey,'POST')).status,404);
 }
 revokeApiKey(keys[1].id);assert.equal((await get('/customers',keys[1].plaintext)).status,401);
 const burst=generateApiKey({tenantId:1,permissionLevel:'read_only',adminId:1,adminUsername:'测试'}).plaintext;
 for(let i=0;i<12;i++) assert.equal((await get('/customers',burst)).status,200);
 const limited=await get('/customers',burst);assert.equal(limited.status,429);assert.equal((await limited.json()).error.code,'rate_limited');
 console.log('PASS 日报 HTTP：三个端点、双租户、默认昨天、只读、真实日期、分页、ID、401、吊销、GET-only、429');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
 if(server)server.close();opened.forEach(db=>db.close());platformDb.close();fs.rmSync(dir,{recursive:true,force:true});
});
