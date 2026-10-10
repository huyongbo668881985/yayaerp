const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-review-fixes-'));
process.env.JXC_DATA_DIR = dir;
process.env.SESSION_SECRET = randomUUID() + randomUUID();
process.env.PLATFORM_ADMIN_INITIAL_PASSWORD = 'InitialAdmin_2026';
process.env.NODE_ENV = 'test';
const Module = require('node:module'), originalLoad = Module._load;
Module._load = function(request) { return request === 'dotenv' ? {config: () => ({})} : originalLoad.apply(this, arguments); };
let base, passed = 0;
const { createTenant, platformDb } = require('../lib/platformDb');
const { openTenantDbByPath } = require('../lib/tenantManager');
const { bootstrapTenant } = require('../lib/schema');
const tenant = createTenant('review', '整改回归租户');
const db = openTenantDbByPath(tenant.db_path);
bootstrapTenant(db, {adminUsername:'owner',adminPassword:'OwnerPass_2026',adminName:'日志所有者',warehouseName:'总仓'});
db.prepare('INSERT INTO users(username,password_hash,name,role) VALUES (?,?,?,?)').run('admin',bcrypt.hashSync('AdminPass_2026',10),'普通管理员','admin');
db.prepare('INSERT INTO users(username,password_hash,name,role) VALUES (?,?,?,?)').run('worker',bcrypt.hashSync('WorkerPass_2026',10),'操作员','operator');
db.exec("INSERT INTO warehouses(name,operator_id) VALUES ('车辆仓',3),('其他车辆',2)");
for (let i=1;i<=75;i++) {
  db.prepare("INSERT INTO products(sku,name,unit,pack_unit,pack_size,sale_price) VALUES (?,?,'瓶','箱',12,10)").run('SKU'+i,'商品'+String(i).padStart(3,'0'));
  db.prepare('INSERT INTO customers(name,operator_id) VALUES (?,?)').run('客户'+String(i).padStart(3,'0'),i === 75 ? 2 : 3);
  db.prepare('INSERT INTO sales_orders(warehouse_id,user_id,order_date,total_amount,paid_amount,status) VALUES (1,1,?,?,?,?)').run('2026-10-10',i*10,0,i>72 ? ['draft','rejected','submitted'][i-73] : 'approved');
  db.prepare("INSERT INTO sales_order_items(sales_order_id,product_id,quantity,unit_label,base_quantity,unit_price) VALUES (?, ?, 1,'瓶',1,?)").run(i,i,i*10);
}
db.exec("INSERT INTO transfer_orders(from_warehouse_id,to_warehouse_id,user_id,order_date,status) VALUES (1,2,1,'2026-10-10','submitted'),(1,2,1,'2026-10-10','draft'); INSERT INTO return_orders(warehouse_id,user_id,order_date,status,total_amount) VALUES (1,1,'2026-10-10','submitted',0),(1,1,'2026-10-10','draft',0)");
db.exec('INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES (75,2,5)');
class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async request(url, body) {
    if (body && !this.csrf) this.csrf = (await this.request('/api/csrf-token')).data.token;
    const response = await fetch(base+url,{redirect:'manual',method:body?'POST':'GET',headers:{Cookie:this.cookie,Origin:base,...(body?{'Content-Type':'application/x-www-form-urlencoded','X-CSRF-Token':this.csrf}:{})},...(body?{body:new URLSearchParams({_request_key:randomUUID(),...body})}:{})});
    const cookies=response.headers.getSetCookie(); if(cookies.length) this.cookie=cookies.map(cookie=>cookie.split(';')[0]).join('; ');
    if (response.status===302 && ['/login','/platform-admin/login'].includes(url)) this.csrf='';
    const text=await response.text(); return {status:response.status,location:response.headers.get('location'),text,data:response.headers.get('content-type')?.includes('json')?JSON.parse(text):null,headers:response.headers};
  }
  login(username,password) { return this.request('/login',{tenant_code:'review',username,password}); }
}
async function check(label, work) { await work(); passed++; console.log('  PASS '+label); }
(async () => {
  const port = await new Promise(resolve=>{const probe=net.createServer();probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});});
  process.env.PORT=String(port);base='http://127.0.0.1:'+port;require('../app');
  const owner=new Client(),admin=new Client(),worker=new Client(),secondOwner=new Client();
  await owner.login('owner','OwnerPass_2026');await secondOwner.login('owner','OwnerPass_2026');await admin.login('admin','AdminPass_2026');await worker.login('worker','WorkerPass_2026');
  await check('随机初始凭证仅写私有文件，公开默认口令升级时自动撤销',async()=>{
    const bootstrapDir=path.join(dir,'bootstrap');const env={...process.env,JXC_DATA_DIR:bootstrapDir,PLATFORM_ADMIN_INITIAL_PASSWORD:''};
    const {execFileSync}=require('node:child_process');
    const output=execFileSync(process.execPath,['-e',"require('./lib/platformDb').platformDb.close()"],{cwd:path.join(__dirname,'..'),env,encoding:'utf8'});
    const secretPath=path.join(bootstrapDir,'platform-bootstrap-secret'),secret=fs.readFileSync(secretPath,'utf8').trim();
    assert.equal(fs.statSync(secretPath).mode & 0o777,0o600);assert.ok(secret.length>=32);assert.ok(!output.includes(secret));
    const Database=require('better-sqlite3'),legacy=new Database(path.join(bootstrapDir,'platform.db'));
    legacy.prepare('UPDATE platform_admins SET password_hash=?,must_change_password=0').run(bcrypt.hashSync('super123',10));legacy.close();
    execFileSync(process.execPath,['-e',"require('./lib/platformDb').platformDb.close()"],{cwd:path.join(__dirname,'..'),env});
    const upgraded=new Database(path.join(bootstrapDir,'platform.db'));const admin=upgraded.prepare('SELECT * FROM platform_admins').get();
    assert.equal(admin.auth_version,1);assert.equal(admin.must_change_password,1);assert.ok(!bcrypt.compareSync('super123',admin.password_hash));assert.ok(bcrypt.compareSync(secret,admin.password_hash));upgraded.close();
  });
  await check('健康探针不创建会话，错误携带请求编号及返回入口',async()=>{
    const health=await new Client().request('/healthz');assert.equal(health.data.status,'ok');assert.equal(health.headers.get('set-cookie'),null);
    await owner.request('/products');const error=await owner.request('/products/999/delete',{});assert.ok(error.headers.get('x-request-id'));assert.equal(error.status,302);
    const missing=await owner.request('/missing');assert.equal(missing.status,404);assert.ok(missing.text.includes('操作未能完成'));assert.ok(missing.text.includes('href="/products?saved=1"') || missing.text.includes('href="/products"'));
  });
  await check('首页待审核销售入口正确，草稿与拒绝状态不冒充待审核',async()=>{
    const result=await owner.request('/');assert.equal(result.status,200);assert.ok(result.text.includes('href="/sales?pending=1"'));assert.ok(result.text.includes('已拒绝'));assert.ok(result.text.includes('草稿'));assert.ok(result.text.includes('审核后生效'));
    const approved=await owner.request('/sales?status=approved'); assert.equal(approved.status,200); assert.ok(!approved.text.includes('href="/sales/74"')); assert.ok(approved.text.includes('已审核'));
    const pending=await owner.request('/sales?pending=1');assert.equal(pending.status,200);assert.ok(pending.text.includes('#75'));assert.ok(!pending.text.includes('href="/sales/74"'));
    assert.ok(!(await worker.request('/')).text.includes('pending-orders-link'));
    for (const kind of ['returns','transfers']) { const filtered = await owner.request('/'+kind+'?pending=1'); assert.equal(filtered.status,200); assert.ok(filtered.text.includes('/'+kind+'/1')); assert.ok(!filtered.text.includes('/'+kind+'/2')); }
  });
  await check('编辑商品失败仍使用原商品 ID，重试不会新增商品',async()=>{
    const response=await owner.request('/products/75/edit',{name:'商品075',pack_size:'-1'});assert.equal(response.status,200);assert.ok(response.text.includes('action="/products/75/edit"'));
    await owner.request('/products/75/edit',{sku:'SKU75',name:'修正后商品',pack_size:'12',pack_unit:'箱',unit:'瓶',sale_price:'10'});assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n,75);
  });
  await check('销售查询执行分页，未结清筛选与排序一致，搜索支持首页以外商品',async()=>{
    const {queryOrders}=require('../lib/salesQuery');const page=queryOrders(db,{role:'admin',id:1},null,null,null,false,'outstanding',false,null,'',null,{page:2,size:50,sort:'amount',order:'desc'});
    assert.equal(page.totalOrders,72);assert.equal(page.orders.length,22);assert.equal(page.orders[0].total_amount,220);
    const product=await worker.request('/order-options/products?q=SKU75');assert.equal(product.data.products[0].id,75);assert.ok(!product.text.includes('cost_price'));
    assert.ok(!(await worker.request('/sales?customer_id=75')).text.includes('data-customer-id="75"'));
    const customers=await worker.request('/order-options/customers?q=客户075');assert.equal(customers.data.customers.length,0);
    assert.equal((await worker.request('/order-options/stock?warehouse_id=3&product_id=75')).status,403);
    assert.equal((await worker.request('/order-options/stock?warehouse_id=2&product_id=75')).data.quantity,5);
    assert.ok((await owner.request('/products?page=2')).text.includes('修正后商品')===false);
    assert.ok((await owner.request('/customers?page=2')).text.includes('第 2 / 2 页'));
  });
  await check('普通管理员无法重置日志所有者，重置操作员密码使旧会话失效',async()=>{
    const before=db.prepare('SELECT password_hash,auth_version FROM users WHERE id=1').get();assert.equal((await admin.request('/users/1/reset-password',{new_password:'AttackerPass'})).status,403);assert.deepEqual(db.prepare('SELECT password_hash,auth_version FROM users WHERE id=1').get(),before);
    assert.equal((await owner.request('/users/3/reset-password',{new_password:'ChangedWorker_2026'})).status,302);assert.equal((await worker.request('/inventory')).location,'/login');
    const next=new Client();assert.equal((await next.login('worker','ChangedWorker_2026')).status,302);assert.equal((await next.request('/inventory')).status,200);
  });
  await check('本人改密保留当前登录，同时撤销其它登录；审计失败重置回滚',async()=>{
    assert.equal((await owner.request('/change-password',{old_password:'OwnerPass_2026',new_password:'ChangedOwner_2026'})).status,200);assert.equal((await owner.request('/')).status,200);assert.equal((await secondOwner.request('/')).location,'/login');
    const before=db.prepare('SELECT password_hash,auth_version FROM users WHERE id=3').get();db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'audit_failure'); END");
    assert.equal((await admin.request('/users/3/reset-password',{new_password:'RollbackWorker'})).status,400);assert.deepEqual(db.prepare('SELECT password_hash,auth_version FROM users WHERE id=3').get(),before);db.exec('DROP TRIGGER reject_audit');
  });
  await check('公开旧默认密码不可登录，平台改密撤销第二个旧会话',async()=>{
    const first=new Client(),second=new Client();assert.equal((await first.request('/platform-admin/login',{username:'superadmin',password:'super123'})).status,200);
    assert.equal((await first.request('/platform-admin/login',{username:'superadmin',password:'InitialAdmin_2026'})).location,'/platform-admin/change-password');await second.request('/platform-admin/login',{username:'superadmin',password:'InitialAdmin_2026'});
    await first.request('/platform-admin/change-password',{old_password:'InitialAdmin_2026',new_password:'ChangedPlatform_2026'});
    assert.equal((await first.request('/platform-admin')).status,200);assert.equal((await second.request('/platform-admin')).location,'/platform-admin/login');
  });
  console.log(`整改回归测试通过：${passed} 项`);db.close();platformDb.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);
})().catch(error=>{console.error(error);fs.rmSync(dir,{recursive:true,force:true});process.exit(1);});
