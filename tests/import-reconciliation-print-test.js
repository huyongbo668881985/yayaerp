const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const express=require('express'),ExcelJS=require('exceljs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jxc-import-reconcile-'));process.env.JXC_DATA_DIR=dir;
const {openTenantDbByPath}=require('../lib/tenantManager');
const {initSchema}=require('../lib/schema');
const {todayLocalDate,formatDateTime}=require('../utils/dates');
const {parseFile,template,validateRows}=require('../lib/importData');
const {statement}=require('../lib/customerLedger');
const {toCsv}=require('../utils/csv');
const databases=['a','b'].map(code=>{
  const db=openTenantDbByPath(path.join(dir,code+'.db'));
  db.exec(`INSERT INTO users(username,password_hash,name,role,audit_log_owner) VALUES ('owner','unused','所有者','admin',1),('operator','unused','业务员','operator',0),('other','unused','其他业务员','operator',0);
    INSERT INTO warehouses(name,operator_id) VALUES ('总仓',NULL),('车辆仓',2),('另一车辆',3);
    INSERT INTO products(sku,name,unit,pack_unit,pack_size,cost_price,sale_price) VALUES ('OLD','原商品','瓶','箱',10,2,5);
    INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES (1,1,1000),(1,2,1000);
    INSERT INTO customers(name,operator_id) VALUES ('客户甲',2);
    INSERT INTO suppliers(name) VALUES ('供应商甲');`);return db;
});
let server,base,passes=0;
const check=async(label,work)=>{await work();passes++;console.log('  PASS  '+label);};
async function request(route,{body,user=1,tenant=0,multipart}={}){
  if(body && /^\/returns\/approve\//.test(route))body={goods_received:'1',...body};
  if(body && route.endsWith('/record-refund'))body={refund_reference:'测试实际退款凭据',...body};
  const response=await fetch(base+route,{method:body||multipart?'POST':'GET',redirect:'manual',headers:{'X-Test-User':String(user),'X-Test-Tenant':String(tenant),...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(body?{body:new URLSearchParams(body)}:multipart?{body:multipart}:{})});
  const text=await response.text();let json;try{json=JSON.parse(text);}catch(_){}
  return {status:response.status,location:response.headers.get('location'),text,json,headers:response.headers};
}
async function preview(kind,text,options={},filename='test.csv'){
  const data=new FormData();data.append('file',new Blob([text]),filename);return request('/imports/'+kind+'/preview',{multipart:data,...options});
}
const batchId=response=>response.json.redirect.split('/').at(-1);
const idOf=response=>Number(response.location.match(/\/(\d+)/)[1]);
const saleBody=extra=>({warehouse_id:'1',customer_id:'1',customer_search:'客户甲',items_json:JSON.stringify([{id:1,quantity:4,price:5}]),paid_amount:'0',_request_key:randomUUID(),...extra});
const ledgerCount=db=>db.prepare('SELECT COUNT(*) n FROM customer_ledger').get().n;
(async()=>{
  const app=express();app.set('view engine','ejs');app.set('views',path.join(__dirname,'../views'));app.use(express.urlencoded({extended:true}));
  app.use((req,res,next)=>{req.tenantDb=databases[Number(req.get('X-Test-Tenant'))||0];req.session={user:{id:Number(req.get('X-Test-User'))||1}};req.tenant={name:'测试租户',tenant_code:'test',max_users:null};req.requestId=randomUUID();res.locals={currentTenant:req.tenant,currentUser:req.tenantDb.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id),currentPath:req.path,csrfToken:'test',newRequestKey:randomUUID,formatDateTime};next();});
  for(const route of ['imports','reconciliation','printing','sales','returns','purchases','transfers'])app.use(require('../routes/'+route));
  app.use((error,req,res,next)=>res.status(500).send(error.message));server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  const db=databases[0],today=todayLocalDate();let batch,saleId,returnId,purchaseId,transferId;
  await check('CSV 引号、逗号、换行、中文 BOM 与前导零被保留',async()=>{
    const rows=await parseFile(Buffer.from('\uFEFF名称,联系人,电话\r\n供应商测试,"张,三",00123\r\n第二家,"甲\n乙",01234'),'x.csv','suppliers');assert.equal(rows[0].values.contact,'张,三');assert.equal(rows[0].values.phone,'00123');assert.equal(rows[1].values.contact,'甲\n乙');
    await assert.rejects(()=>parseFile(Buffer.from('名称\n"未闭合'),'x.csv','suppliers'));
    assert.equal((await parseFile(Buffer.from('c3fbb3c60ab9a9d3a6c9cc','hex'),'gbk.csv','suppliers'))[0].values.name,'供应商');
  });
  await check('Excel 模板可回读，普通数字/文本可导入；公式、多表、损坏文件被拒',async()=>{
    const book=new ExcelJS.Workbook();await book.xlsx.load(await template('products'));book.worksheets[0].addRow(['001','测试商品','','瓶','箱',12,2,3,24,36,5]);const rows=await parseFile(Buffer.from(await book.xlsx.writeBuffer()),'t.xlsx','products');assert.equal(rows[0].values.sku,'001');assert.equal(rows[0].values.pack_size,'12');
    book.worksheets[0].getCell('B2').value={formula:'1+1',result:2};await assert.rejects(()=>book.xlsx.writeBuffer().then(b=>parseFile(Buffer.from(b),'t.xlsx','products')),/含公式/);
    book.worksheets[0].getCell('B2').value='恢复';book.addWorksheet('第二表');await assert.rejects(()=>book.xlsx.writeBuffer().then(b=>parseFile(Buffer.from(b),'t.xlsx','products')),/一个数据/);
    await assert.rejects(()=>parseFile(Buffer.from('not a zip'),'t.xlsx','products'));await assert.rejects(()=>parseFile(Buffer.from('x'),'t.xls','products'));
  });
  await check('表头缺失、未知列、重复列、空文件与超过 1000 行被拒',async()=>{
    for(const text of ['错误列\nx','名称,名称\nx,y','联系人\nx','名称\n', '名称\n'+Array.from({length:1001},(_,i)=>'测试'+i).join('\n')])await assert.rejects(()=>parseFile(Buffer.from(text),'t.csv','suppliers'));
  });
  await check('小体积压缩的巨大工作簿在解析前被拒，避免解压占满内存',async()=>{
    const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('导入');sheet.addRow(['名称']);sheet.addRow(['大'.repeat(3*1024*1024)]);
    const buffer=Buffer.from(await book.xlsx.writeBuffer());assert.ok(buffer.length<1024*1024);await assert.rejects(()=>parseFile(buffer,'large.xlsx','suppliers'),/Excel 内容超出限制/);
  });
  await check('归属、重复行、负金额、箱规、盘点单位和原因服务端校验',()=>{
    const errors=validateRows(db,'products',[{line:2,values:{sku:'X',name:'测试',unit:'瓶',pack_size:'-1',sale_price:'NaN'}}]);assert.ok(errors[0].errors.length>=2);
    assert.ok(validateRows(db,'customers',[{line:2,values:{name:'含 空格',username:'不存在'}}])[0].errors.length>=2);
    assert.ok(validateRows(db,'inventory',[{line:2,values:{sku:'OLD',warehouse:'总仓',quantity:'-1',reason:''}}])[0].errors.length>=2);
    assert.ok(validateRows(db,'suppliers',[{line:2,values:{name:'重复'}},{line:3,values:{name:'重复'}}])[1].errors.length);
  });
  await check('预览不落业务库，错误行整批拒绝',async()=>{
    batch=batchId(await preview('products','SKU,名称,基本单位,基本售价\nBAD,错误价格,瓶,-1\nGOOD,正常商品,瓶,5'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n,1);const result=await request('/imports/batches/'+batch+'/confirm',{body:{}});assert.equal(result.status,409);assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n,1);
  });
  await check('商品导入创建所有仓库库存行，已有 SKU 不覆盖，确认及上传重试只执行一次',async()=>{
    const csv='SKU,名称,基本单位,大单位,换算比例,基本成本价,基本售价\nNEW,新商品,瓶,箱,24,2,5\nOLD,不应覆盖,瓶,,,999,999';
    batch=batchId(await preview('products',csv));assert.equal((await request('/imports/batches/'+batch+'/confirm',{body:{}})).status,302);assert.equal((await request('/imports/batches/'+batch+'/confirm',{body:{}})).status,302);
    assert.equal(db.prepare("SELECT name FROM products WHERE sku='OLD'").get().name,'原商品');assert.equal(db.prepare("SELECT COUNT(*) n FROM inventory WHERE product_id=(SELECT id FROM products WHERE sku='NEW')").get().n,3);
    assert.equal(batchId(await preview('products',csv)),batch);assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='导入商品'").get().n,1);
  });
  await check('客户归属和供应商导入，电话号码前导零不丢失',async()=>{
    const customerBatch=batchId(await preview('customers','名称,联系人,电话,地址,归属账号\n新客户,张三,00123,演示街,operator'));await request('/imports/batches/'+customerBatch+'/confirm',{body:{}});
    const customer=db.prepare("SELECT * FROM customers WHERE name='新客户'").get();assert.equal(customer.operator_id,2);assert.equal(customer.phone,'00123');
    const supplierBatch=batchId(await preview('suppliers','名称,联系人,电话\n新供应商,李四,01234'));await request('/imports/batches/'+supplierBatch+'/confirm',{body:{}});assert.equal(db.prepare("SELECT phone FROM suppliers WHERE name='新供应商'").get().phone,'01234');
  });
  await check('库存盘点设置总数并留调整差额、原因与审计，不重复累加',async()=>{
    batch=batchId(await preview('inventory','SKU,仓库,实盘数量,调整原因\nOLD,总仓,900,盘点核对'));await request('/imports/batches/'+batch+'/confirm',{body:{}});await request('/imports/batches/'+batch+'/confirm',{body:{}});
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity,900);
    const stock=db.prepare("SELECT * FROM stock_transactions WHERE ref_type='import'").all();assert.equal(stock.length,1);assert.equal(stock[0].change_qty,-100);
    const details=JSON.parse(db.prepare("SELECT details_json FROM audit_logs WHERE action='导入库存盘点'").get().details_json);assert.equal(details.adjustments[0].reason,'盘点核对');
  });
  await check('预览后库存变化拦截确认，重新校验后按新差额入账',async()=>{
    batch=batchId(await preview('inventory','SKU,仓库,实盘数量,调整原因\nOLD,总仓,850,变化检查'));db.prepare('UPDATE inventory SET quantity=880 WHERE product_id=1 AND warehouse_id=1').run();
    assert.equal((await request('/imports/batches/'+batch+'/confirm',{body:{}})).status,409);assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity,880);
    await request('/imports/batches/'+batch+'/recheck',{body:{}});await request('/imports/batches/'+batch+'/confirm',{body:{}});assert.equal(db.prepare("SELECT change_qty FROM stock_transactions WHERE ref_type='import' ORDER BY id DESC").get().change_qty,-30);
  });
  await check('同一文件可明确重新盘点，重复发起仅生成一份待确认预览',async()=>{
    const original=batch,stockBefore=db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity;
    db.prepare('UPDATE inventory SET quantity=? WHERE product_id=1 AND warehouse_id=1').run(stockBefore+5);
    const restarted=await request('/imports/batches/'+original+'/restart',{body:{}}),again=await request('/imports/batches/'+original+'/restart',{body:{}});
    assert.equal(restarted.location,again.location);assert.notEqual(restarted.location,'/imports/batches/'+original);
    const id=restarted.location.split('/').at(-1);assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity,stockBefore+5);
    assert.ok((await request('/imports')).text.includes(id));await request('/imports/batches/'+id+'/confirm',{body:{}});
    assert.equal(db.prepare('SELECT quantity FROM inventory WHERE product_id=1 AND warehouse_id=1').get().quantity,stockBefore);
    assert.equal(db.prepare("SELECT change_qty FROM stock_transactions WHERE ref_type='import' ORDER BY id DESC").get().change_qty,-5);
  });
  await check('导入审计失败全部回滚，批次仍可重试',async()=>{
    batch=batchId(await preview('products','SKU,名称,基本单位\nROLLBACK,回滚商品,瓶'));db.exec("CREATE TRIGGER reject_import_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'审计失败'); END");
    assert.equal((await request('/imports/batches/'+batch+'/confirm',{body:{}})).status,500);assert.equal(db.prepare("SELECT id FROM products WHERE sku='ROLLBACK'").get(),undefined);assert.equal(db.prepare('SELECT status FROM import_batches WHERE id=?').get(batch).status,'pending');db.exec('DROP TRIGGER reject_import_audit');
    assert.equal((await request('/imports/batches/'+batch+'/confirm',{body:{}})).status,302);
  });
  await check('导入鉴权、批次账号/租户隔离、无效类型和文件大小限制',async()=>{
    assert.equal((await request('/imports',{user:2})).status,403);assert.equal((await request('/imports/batches/'+batch,{user:2})).status,403);assert.equal((await request('/imports/batches/'+batch,{tenant:1})).status,404);
    assert.equal((await preview('constructor','a')).status,404);assert.equal((await preview('products',Buffer.alloc(1024*1024+1,'x'))).status,400);
  });
  await check('草稿不入账；审核入账、分次收款及幂等重试按分精确记录',async()=>{
    const body=saleBody({save_draft:'1'});saleId=idOf(await request('/sales/new',{body}));assert.equal(ledgerCount(db),0);await request('/sales/submit/'+saleId,{body:{}});await request('/sales/approve/'+saleId,{body:{}});assert.equal(ledgerCount(db),1);
    const payment={amount:'3.25',_request_key:randomUUID()};await request(`/sales/${saleId}/record-payment`,{body:payment});await request(`/sales/${saleId}/record-payment`,{body:payment});assert.equal(ledgerCount(db),2);assert.equal(db.prepare('SELECT received_cents FROM customer_ledger ORDER BY id DESC').get().received_cents,325);
    assert.equal(statement(db,1,today,today).ending,1675);
  });
  await check('退货抵扣与现金退款分开记录，对账不重复抵扣',async()=>{
    await request(`/sales/${saleId}/record-payment`,{body:{amount:'16.75',_request_key:randomUUID()}});
    returnId=idOf(await request('/returns/new',{body:{warehouse_id:'1',customer_id:'1',related_sales_order_id:String(saleId),items_json:JSON.stringify([{id:1,quantity:1,price:5}]),_request_key:randomUUID()}}));await request('/returns/approve/'+returnId,{body:{}});
    let data=statement(db,1,today,today);assert.equal(data.ending,-500);assert.equal(data.refundPending,500);assert.equal(data.receivable,0);
    const refund={amount:'2',_request_key:randomUUID()};await request(`/returns/${returnId}/record-refund`,{body:refund});await request(`/returns/${returnId}/record-refund`,{body:refund});data=statement(db,1,today,today);assert.equal(data.ending,-300);assert.equal(data.totals.returned,500);assert.equal(data.totals.refunded,200);
  });
  await check('反审核记录反向流水；流水失败业务与审计一起回滚',async()=>{
    const id=idOf(await request('/sales/new',{body:saleBody()}));await request('/sales/approve/'+id,{body:{}});const before=statement(db,1,today,today).ending;await request('/sales/unapprove/'+id,{body:{}});assert.equal(statement(db,1,today,today).ending,before-2000);assert.equal(db.prepare('SELECT sales_cents FROM customer_ledger ORDER BY id DESC').get().sales_cents,-2000);
    const count=ledgerCount(db);db.exec("CREATE TRIGGER reject_ledger BEFORE INSERT ON customer_ledger BEGIN SELECT RAISE(ABORT,'流水失败'); END");
    assert.equal((await request(`/sales/${saleId}/record-payment`,{body:{amount:'1',_request_key:randomUUID()}})).status,400); // 已收满，先在业务校验拒绝。
    await request('/sales/withdraw/'+id,{body:{}});await request('/sales/submit/'+id,{body:{}});const state=db.prepare('SELECT status FROM sales_orders WHERE id=?').get(id).status;
    const audits=db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n;
    assert.equal((await request('/sales/approve/'+id,{body:{}})).status,500);assert.equal(db.prepare('SELECT status FROM sales_orders WHERE id=?').get(id).status,state);assert.equal(ledgerCount(db),count);assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,audits);db.exec('DROP TRIGGER reject_ledger');
  });
  await check('客户对账仅管理员，日期/编号合法性、租户隔离和导出一致',async()=>{
    assert.equal((await request('/reconciliation',{user:2})).status,403);const query='?start='+today+'&end='+today;
    const page=await request('/reconciliation/customers/1'+query);assert.equal(page.status,200);assert.ok(page.text.includes('期末净余额'));assert.equal((await request('/reconciliation/customers/1'+query,{user:2})).status,403);
    const csv=await request('/reconciliation/customers/1'+query+'&format=csv');assert.equal(csv.status,200);assert.ok(csv.text.includes('-3.00'));assert.equal((await request('/reconciliation/customers/1'+query,{tenant:1})).status,200);assert.equal(statement(databases[1],1,today,today).ending,0);assert.equal(ledgerCount(databases[1]),0);
    assert.equal((await request('/reconciliation/customers/1?start=2026-02-30&end='+today)).status,400);assert.equal((await request('/reconciliation/customers/999'+query)).status,404);assert.equal((await request('/reconciliation/customers/1?start=2000-01-01&end='+today)).status,400);
  });
  await check('供应商采购对账汇总与打印，不误报未付账款',async()=>{
    await request('/purchases/new',{body:{supplier_id:'1',warehouse_id:'1',product_id:'1',quantity:'2',unit_price:'2.5',note:'采购说明',_request_key:randomUUID()}});purchaseId=db.prepare('SELECT MAX(id) id FROM purchase_orders').get().id;
    const page=await request('/reconciliation/suppliers/1?start='+today+'&end='+today);assert.equal(page.status,200);assert.ok(page.text.includes('采购金额不代表未付账款'));assert.ok(page.text.includes('5.00'));assert.equal((await request('/reconciliation/suppliers/1?start='+today+'&end='+today+'&print=1')).status,200);
  });
  await check('四类单据可打印，草稿标记、箱单位、赠品和结算口径正确且内部备注不外泄',async()=>{
    transferId=idOf(await request('/transfers/new',{body:{from_warehouse_id:'1',to_warehouse_id:'2',product_id:'1',quantity:'1',save_draft:'1',note:'秘密调拨备注',_request_key:randomUUID()}}));
    const gift=idOf(await request('/sales/new',{body:saleBody({save_draft:'1',note:'秘密成本说明',remarks:'公开送货说明',items_json:JSON.stringify([{id:1,quantity:2,price:50,unit_choice:'pack',is_gift:true}])})}));
    const page=await request(`/sales/${gift}/print`);assert.equal(page.status,200);assert.ok(page.text.includes('预览单 · 草稿'));assert.ok(page.text.includes('赠品'));assert.ok(page.text.includes('2箱'));assert.ok(page.text.includes('公开送货说明'));assert.ok(!page.text.includes('秘密成本说明'));assert.ok(!page.text.includes('cost_price'));
    for(const [kind,id]of[['sales',saleId],['returns',returnId],['purchases',purchaseId],['transfers',transferId]])assert.equal((await request(`/${kind}/${id}/print`)).status,200);
    assert.ok(!(await request(`/transfers/${transferId}/print`)).text.includes('秘密调拨备注'));
    assert.ok((await request(`/sales/${saleId}/print`)).text.includes('待退款：¥3.00'));
  });
  await check('打印权限与详情一致，不泄漏他人单据和其他车辆',async()=>{
    assert.equal((await request(`/purchases/${purchaseId}/print`,{user:2})).status,403);assert.equal((await request(`/sales/${saleId}/print`,{user:2})).status,403);
    const own=idOf(await request('/sales/new',{user:2,body:saleBody({warehouse_id:'2',save_draft:'1'})}));assert.equal((await request(`/sales/${own}/print`,{user:2})).status,200);assert.equal((await request(`/sales/${own}/print`,{user:3})).status,403);assert.equal((await request(`/sales/${own}/print`,{tenant:1})).status,404);
  });
  await check('打印与导出转义用户文本，日志与对账流水禁止修改删除',async()=>{
    const id=idOf(await request('/sales/new',{body:saleBody({save_draft:'1',remarks:'<script>alert(1)</script>'})}));assert.ok((await request(`/sales/${id}/print`)).text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(toCsv(['名称'],[['=1+1']]).includes("'=1+1"));assert.throws(()=>db.exec('UPDATE customer_ledger SET sales_cents=1'));assert.throws(()=>db.exec('DELETE FROM customer_ledger'));const count=ledgerCount(db);initSchema(db);assert.equal(ledgerCount(db),count);
  });
  await check('期初与本期收退款按操作日期汇总，不自动跨单抵销应收和待退',()=>{
    const previous=new Date(today+'T00:00:00Z');previous.setUTCDate(previous.getUTCDate()-1);const yesterday=previous.toISOString().slice(0,10);
    const customerId=db.prepare("INSERT INTO customers(name) VALUES ('期初核对客户')").run().lastInsertRowid;
    db.prepare("UPDATE ledger_metadata SET value=? WHERE key='opening_date'").run(yesterday);
    const insert=db.prepare("INSERT INTO customer_ledger(customer_id,document_type,document_id,document_date,event_date,event_kind,sales_cents,received_cents,returned_cents,refunded_cents) VALUES (?,?,?,?,?,'测试流水',?,?,?,?)");
    insert.run(customerId,'sales',90001,yesterday,yesterday,10000,0,0,0);
    insert.run(customerId,'sales',90001,yesterday,today,0,2500,0,0);
    insert.run(customerId,'sales',90002,today,today,2000,0,0,0);
    insert.run(customerId,'returns',90003,today,today,0,0,1000,200);
    const data=statement(db,customerId,today,today);assert.equal(data.opening,10000);assert.equal(data.ending,8700);assert.equal(data.receivable,9500);assert.equal(data.refundPending,800);assert.equal(data.rows.length,3);assert.equal(data.totals.received,2500);assert.equal(data.rows.at(-1).balance_cents,8700);
  });
  await check('旧库升级仅结转已审核旧账，重复迁移不重复入账，不伪造历史日期',()=>{
    const old=openTenantDbByPath(path.join(dir,'legacy.db'));old.exec("DELETE FROM schema_migrations WHERE version>=12;DROP TABLE customer_ledger_accounts;DROP TABLE customer_ledger;DROP TABLE ledger_metadata;DROP TABLE import_batches;INSERT INTO users(username,password_hash,name,role) VALUES ('old','x','旧管理员','admin');INSERT INTO warehouses(name) VALUES ('旧仓');INSERT INTO customers(name) VALUES ('旧客户');INSERT INTO sales_orders(customer_id,warehouse_id,user_id,order_date,total_amount,paid_amount,status) VALUES (1,1,1,'2020-01-01',100,30,'approved'),(1,1,1,'2020-01-02',999,1,'draft');");initSchema(old);let rows=old.prepare('SELECT * FROM customer_ledger').all();assert.equal(rows.length,1);assert.equal(rows[0].event_date,today);assert.equal(rows[0].document_date,'2020-01-01');assert.equal(rows[0].event_kind,'升级结转');assert.equal(statement(old,1,today,today).ending,7000);
    old.exec('DELETE FROM schema_migrations WHERE version=12');initSchema(old);assert.equal(ledgerCount(old),1);old.close();
  });
  console.log(`导入、对账与打印回归：${passes} PASS / 0 FAIL`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{if(server)server.close();for(const db of databases)db.close();fs.rmSync(dir,{recursive:true,force:true});});
