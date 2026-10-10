// 真实路由与临时数据库：仓库停用不改历史钱货记录，所有新库存业务均被拦截。
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express'), session = require('express-session'), Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-warehouse-status-'));
process.env.JXC_DATA_DIR = dir;
const { initSchema } = require('../lib/schema');
const { formatDateTime } = require('../utils/dates');
const { issueCsrfToken, csrfProtection } = require('../middleware/csrf');
const db = new Database(path.join(dir, 'test.db')); initSchema(db);
db.exec(`INSERT INTO users(username,password_hash,name,role) VALUES ('admin','x','管理员','admin'),('operator','x','操作员','operator');
  INSERT INTO warehouses(name,operator_id) VALUES ('总仓',NULL),('操作员车',2);
  INSERT INTO products(name,sku,unit,low_stock_threshold,cost_price,sale_price) VALUES ('测试商品','TEST','瓶',10,1,2);
  INSERT INTO inventory VALUES (1,1,5),(1,2,0);
  INSERT INTO transfer_orders(from_warehouse_id,to_warehouse_id,user_id,order_date,status) VALUES (1,2,1,'2026-10-05','approved'),(1,2,1,'2026-10-05','draft'),(1,2,1,'2026-10-05','submitted');
  INSERT INTO transfer_order_items(transfer_order_id,product_id,quantity,base_quantity,unit_label) VALUES (1,1,1,1,'瓶'),(2,1,1,1,'瓶'),(3,1,1,1,'瓶');
  INSERT INTO stock_transactions(product_id,warehouse_id,change_qty,type,ref_type,ref_id,user_id) VALUES (1,2,1,'transfer_in','transfer_order',1,1),(1,2,-1,'transfer_out','transfer_order_unapprove',1,1);
  INSERT INTO sales_orders(warehouse_id,user_id,order_date,status) VALUES (2,1,'2026-10-05','submitted');
  INSERT INTO return_orders(warehouse_id,user_id,order_date,status) VALUES (2,1,'2026-10-05','submitted');`);
const app = express(); app.set('view engine','ejs'); app.set('views',path.join(__dirname,'../views'));
app.use(express.urlencoded({extended:true})); app.use(express.static(path.join(__dirname,'../public')));
app.use(session({secret:'warehouse-status-test-secret-at-least-32',resave:false,saveUninitialized:false}));
app.use(issueCsrfToken);
app.use((req,res,next) => {
  req.tenantDb=db; req.session.user={id:Number(req.get('X-Test-User'))||1}; req.requestId=randomUUID();
  req.tenant={name:'停用功能测试',tenant_code:'test'};
  Object.assign(res.locals,{currentUser:db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id),currentTenant:req.tenant,currentPath:req.path,newRequestKey:randomUUID,formatDateTime}); next();
});
app.use(csrfProtection);
for (const route of ['warehouses','dashboard','inventory','sales','returns','transfers','purchases']) app.use(require('../routes/'+route));
app.use((error,req,res,next) => {console.error(error);res.status(500).send(error.message);});
const server = app.listen(process.argv.includes('--serve') ? 3218 : 0,'127.0.0.1',async () => {
  const base='http://127.0.0.1:'+server.address().port;
  if (process.argv.includes('--serve')) {console.log('Browser fixture: '+base+'/warehouses');return;}
  let cookie, csrf;
  async function request(route,body,user=1) {
    const response=await fetch(base+route,{method:body?'POST':'GET',redirect:'manual',headers:{'X-Test-User':String(user),...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(body?{body:new URLSearchParams({_csrf:csrf,_request_key:randomUUID(),...body})}:{})});
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    const text=await response.text();csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;
    return {status:response.status,text};
  }
  const tables=['inventory','stock_transactions','transfer_orders','transfer_order_items','sales_orders','return_orders'];
  const snapshot=()=>Object.fromEntries(tables.map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));
  try {
    await request('/warehouses');
    assert.equal(require('../lib/warehouseAccess').isWarehouseActive(db, undefined), false);
    const emptyPurchase = await request('/purchases/new', {});
    assert.equal(emptyPurchase.status, 400);
    assert.match(emptyPurchase.text, /仓库/);
    const before=snapshot();
    assert.equal((await request('/warehouses/1/status',{active:'0'})).status,400);
    assert.equal((await request('/warehouses/2/status',{active:'0'},2)).status,403);
    assert.equal((await request('/warehouses/2/status',{active:'other'})).status,400);
    assert.equal((await request('/warehouses/999/status',{active:'0'})).status,404);
    assert.equal((await request('/warehouses/2/status',{active:'0',_csrf:'invalid'})).status,403);
    assert.equal((await request('/warehouses/2/status',{active:'0'})).status,302);
    assert.deepEqual(snapshot(),before);
    const imported = require('../lib/importData').validateRows(db, 'inventory', [{line:2,values:{sku:'TEST',warehouse:'操作员车',quantity:'3',reason:'盘点'}}]);
    assert.ok(imported[0].errors.some(error => error.includes('停用')));
    const auditCount=db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n;
    assert.equal((await request('/warehouses/2/status',{active:'0'})).status,302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,auditCount);
    assert.match((await request('/warehouses')).text,/已停用/);
    assert.doesNotMatch((await request('/')).text.split('<h2>最近销售单</h2>')[0],/操作员车/);
    assert.match((await request('/')).text,/总仓/);
    assert.doesNotMatch((await request('/inventory?low=1')).text,/操作员车（已停用）<\/td>/);
    const inventory=require('../routes/inventory').queryInventorySnapshot;
    assert.equal(inventory(db,null,null,'',true).length,1);
    assert.equal(inventory(db,2,null,'',true).length,0);
    assert.equal(inventory(db,2).length,1);
    for(const route of ['/sales/new','/returns/new','/transfers/new','/purchases/new','/inventory/adjust']){
      const result=await request(route);assert.equal(result.status,200,result.text);assert.doesNotMatch(result.text,/<option value="2"[^>]*>操作员车/);
    }
    for(const route of ['/sales/approve/1','/returns/approve/1','/transfers/approve/3','/transfers/submit/2','/transfers/unapprove/1']){
      const result=await request(route,{});assert.equal(result.status,400,result.text);assert.match(result.text,/停用/);
    }
    const items=JSON.stringify([{id:1,quantity:1,price:2}]);
    for(const [route,body] of [
      ['/sales/new',{warehouse_id:'2',items_json:items}],
      ['/returns/new',{warehouse_id:'2',items_json:items}],
      ['/transfers/new',{from_warehouse_id:'1',to_warehouse_id:'2',items_json:items}],
      ['/purchases/new',{warehouse_id:'2',product_id:'1',quantity:'1',unit_price:'1'}],
      ['/inventory/adjust',{warehouse_id:'2',product_id:'1',new_quantity:'5',reason:'test'}]]){
      const result=await request(route,body);assert.match(result.text,/停用|启用的仓库/);assert.notEqual(result.status,500);
    }
    assert.deepEqual(snapshot(),before);
    for(const route of ['/transfers/1','/sales/1','/returns/1','/stock-log'])assert.equal((await request(route)).status,200);
    const history=db.prepare('SELECT * FROM warehouses WHERE id=2').get();initSchema(db);assert.deepEqual(db.prepare('SELECT * FROM warehouses WHERE id=2').get(),history);
    assert.equal((await request('/warehouses/2/status',{active:'1'})).status,302);
    assert.equal(inventory(db,null,null,'',true).length,2);
    assert.match((await request('/sales/new')).text,/<option value="2"[^>]*>操作员车/);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
    console.log('PASS 仓库停用/恢复、空库存限制、角色及 CSRF、重复请求、低库存与 API 共用查询、新开单及旧草稿拦截、历史与迁移完整性');
  } catch(error){console.error(error);process.exitCode=1;}
  finally {server.close();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
