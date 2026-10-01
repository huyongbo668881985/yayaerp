// 真实路由 + 隔离租户：恢复凭证、草稿版本、事务审计、权限和时间边界。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-drafts-audit-'));
process.env.JXC_DATA_DIR = dir;
const { openTenantDbByPath } = require('../lib/tenantManager');
const { initSchema } = require('../lib/schema');
const databases = ['a','b'].map(code => {
  const db = openTenantDbByPath(path.join(dir, code + '.db'));
  db.exec(`INSERT INTO users(username,password_hash,name,role,audit_log_owner) VALUES
    ('owner','unused','所有者','admin',1), ('admin','unused','另一管理员','admin',0), ('operator','unused','操作员','operator',0);
    INSERT INTO warehouses(name) VALUES ('总仓'), ('分仓');
    INSERT INTO products(name,sku,unit,pack_unit,pack_size,cost_price,sale_price) VALUES ('测试商品','draft-sku','瓶','箱',10,3,5);
    INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES (1,1,1000);
    INSERT INTO customers(name) VALUES ('客户甲');`);
  return db;
});
let server, base, passes = 0;
const check = async (label, work) => { await work(); passes++; console.log('  PASS  ' + label); };
async function request(route, {body, user=1, tenant=0}={}) {
  const response = await fetch(base + route, { redirect:'manual', method:body ? 'POST':'GET',
    headers: { 'X-Test-User':String(user), 'X-Test-Tenant':String(tenant), ...(body ? {'Content-Type':'application/x-www-form-urlencoded'}:{}) },
    ...(body ? {body:new URLSearchParams(body)}:{}) });
  const text = await response.text(); let json; try { json = JSON.parse(text); } catch (_) { /* CSV / message */ }
  return { status:response.status, location:response.headers.get('location'), text, json };
}
const saleBody = extra => ({warehouse_id:'1',customer_id:'1',customer_search:'客户甲',items_json:JSON.stringify([{id:1,quantity:3,price:5}]),paid_amount:'0',save_draft:'1',_request_key:randomUUID(), ...extra});
const idOf = result => Number(result.location.match(/\/(\d+)/)[1]);
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const lastAudit = (db,type,id) => { const row = db.prepare('SELECT * FROM audit_logs WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 1').get(type,id); return {...row,details:JSON.parse(row.details_json)}; };
(async () => {
  const app = express(); app.use(express.urlencoded({extended:true}));
  app.use((req,res,next) => { req.tenantDb=databases[Number(req.get('X-Test-Tenant'))||0]; req.session={user:{id:Number(req.get('X-Test-User'))||1}};
    req.tenant={max_users:null}; res.render=(view,locals)=>res.json({view,...locals}); next(); });
  for (const name of ['sales','returns','purchases','transfers','drafts','users','inventory']) app.use(require('../routes/'+name));
  app.use((error,req,res,next)=>res.status(500).send(error.message));
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); base='http://127.0.0.1:'+server.address().port;
  const db=databases[0]; let saleId, key;
  await check('提交完成查询只返回当前租户、当前账号的结果，不接受其他路由', async () => {
    const body=saleBody(); key=body._request_key; const result=await request('/sales/new',{body}); saleId=idOf(result);
    const url='/drafts/result?'+new URLSearchParams({key,route:'/sales/new'});
    assert.equal((await request(url)).json.completed,true);
    assert.equal((await request(url,{user:2})).json.completed,false);
    assert.equal((await request(url,{tenant:1})).json.completed,false);
    assert.equal((await request('/drafts/result?'+new URLSearchParams({key,route:'/users/new'}))).status,400);
    assert.equal((await request('/sales/new',{body})).location,result.location);
    assert.equal(count(db,'sales_orders'),1); assert.equal(count(db,'audit_logs'),1);
  });
  await check('新建审计保存完整商品及现金快照，不记录请求中的凭据', () => {
    const audit=lastAudit(db,'销售单',saleId);
    assert.equal(audit.details.before,null); assert.equal(audit.details.after.fields.单据金额,15);
    assert.equal(audit.details.after.items[0].基本数量,3); assert.equal(audit.details.after.items[0].基本单位成本,3);
    assert.ok(audit.request_id); assert.ok(!audit.details_json.includes(key)); assert.deepEqual(audit.details.stock,[]);
  });
  await check('草稿箱和导出只包含草稿，并保持操作员的单据隔离', async () => {
    const result = await request('/sales?status=draft');
    assert.equal(result.json.orderStatus, 'draft'); assert.equal(result.json.draftCount,1);
    assert.ok(result.json.orders.every(order => order.status === 'draft'));
    assert.equal((await request('/sales?status=draft',{user:3})).json.orders.length,0);
    const exported = await request('/sales/export?status=draft');
    assert.equal(exported.status,200); assert.ok(exported.text.includes('草稿')); assert.ok(!exported.text.includes('已审核'));
  });
  await check('两个编辑页面使用同一版本，只允许一份修改提交；成功重试不重复审计', async () => {
    assert.equal((await request(`/sales/${saleId}/edit`,{body:saleBody()})).status,400);
    const body=saleBody({draft_revision:'0',remarks:'先提交内容',paid_amount:'5'});
    const results=await Promise.all([request(`/sales/${saleId}/edit`,{body}),request(`/sales/${saleId}/edit`,{body:{...body,_request_key:randomUUID(),remarks:'后提交内容'}})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[302,409]);
    const successful=results[0].status===302 ? body : {...body,remarks:'后提交内容'};
    assert.equal(db.prepare('SELECT revision FROM sales_orders WHERE id=?').get(saleId).revision,1);
    const audit=lastAudit(db,'销售单',saleId); assert.equal(audit.details.before.fields.已收现金,0); assert.equal(audit.details.after.fields.已收现金,5);
    if (results[0].status===302) { const n=count(db,'audit_logs'); assert.equal((await request(`/sales/${saleId}/edit`,{body:successful})).status,302); assert.equal(count(db,'audit_logs'),n); }
  });
  await check('撤回、审批、收款均保留状态与库存差额，已提交草稿不能被旧编辑覆盖', async () => {
    assert.equal((await request('/sales/submit/'+saleId,{body:{}})).status,302);
    const n=count(db,'audit_logs'); assert.equal((await request(`/sales/${saleId}/edit`,{body:saleBody({draft_revision:'1'})})).status,400); assert.equal(count(db,'audit_logs'),n);
    assert.equal((await request('/sales/approve/'+saleId,{body:{}})).status,302);
    let audit=lastAudit(db,'销售单',saleId); assert.equal(audit.details.before.fields.审核状态,'待审核'); assert.equal(audit.details.after.fields.审核状态,'已审核'); assert.equal(audit.details.stock[0].change_qty,-3);
    const body={amount:'10',_request_key:randomUUID()}; assert.equal((await request(`/sales/${saleId}/record-payment`,{body})).status,302);
    audit=lastAudit(db,'销售单',saleId); assert.equal(audit.details.before.fields.已收现金,5); assert.equal(audit.details.after.fields.已收现金,15);
  });
  await check('关联退货的新建、编辑、审核与退款都有审计；失败不会产生成功日志', async () => {
    const body={warehouse_id:'1',customer_id:'1',related_sales_order_id:String(saleId),items_json:JSON.stringify([{id:1,quantity:1,price:5}]),save_draft:'1',_request_key:randomUUID()};
    const id=idOf(await request('/returns/new',{body})); let audit=lastAudit(db,'退货单',id); assert.equal(audit.details.after.fields.单据金额,5);
    assert.equal((await request(`/returns/${id}/edit`,{body:{...body,_request_key:randomUUID(),draft_revision:'0',remarks:'退货说明'}})).status,302);
    assert.equal(lastAudit(db,'退货单',id).details.after.fields.备注,'退货说明');
    await request('/returns/submit/'+id,{body:{}}); await request('/returns/approve/'+id,{body:{}});
    audit=lastAudit(db,'退货单',id); assert.equal(audit.details.stock[0].change_qty,1);
    const n=count(db,'audit_logs'); assert.equal((await request(`/returns/${id}/record-refund`,{body:{amount:'6',_request_key:randomUUID()}})).status,400); assert.equal(count(db,'audit_logs'),n);
    await request(`/returns/${id}/record-refund`,{body:{amount:'5',_request_key:randomUUID()}});
    audit=lastAudit(db,'退货单',id); assert.equal(audit.details.before.fields.已退现金,0); assert.equal(audit.details.after.fields.已退现金,5);
  });
  await check('调拨全流程保留两个仓库的库存差额，采购入库及删除保留快照', async () => {
    const body={from_warehouse_id:'1',to_warehouse_id:'2',product_id:'1',quantity:'2',save_draft:'1',_request_key:randomUUID()};
    const id=idOf(await request('/transfers/new',{body}));
    await request(`/transfers/${id}/edit`,{body:{...body,draft_revision:'0',_request_key:randomUUID(),quantity:'3'}});
    await request('/transfers/submit/'+id,{body:{}}); await request('/transfers/approve/'+id,{body:{}});
    assert.deepEqual(lastAudit(db,'调拨单',id).details.stock.map(row=>row.change_qty),[-3,3]);
    await request('/transfers/unapprove/'+id,{body:{}}); assert.deepEqual(lastAudit(db,'调拨单',id).details.stock.map(row=>row.change_qty),[3,-3]);
    // 用分仓中新商品验证采购删除，避免触发既有来源保护。
    db.exec("INSERT INTO products(name,unit,cost_price,sale_price) VALUES ('采购商品','件',2,3)");
    const purchase={warehouse_id:'2',product_id:'2',quantity:'4',unit_price:'2',note:'采购备注',_request_key:randomUUID()}; await request('/purchases/new',{body:purchase});
    const pid=db.prepare('SELECT MAX(id) id FROM purchase_orders').get().id;
    assert.equal(lastAudit(db,'采购单',pid).details.stock[0].change_qty,4);
    assert.equal(lastAudit(db,'采购单',pid).details.after.fields.备注,'采购备注');
    assert.equal((await request(`/purchases/${pid}/delete`,{body:{}})).status,302);
    const audit=lastAudit(db,'采购单',pid); assert.equal(audit.details.after,null); assert.equal(audit.details.before.items[0].数量,4); assert.equal(audit.details.stock[0].change_qty,-4);
  });
  await check('采购校验失败完整保留各行、备注、仓库和原提交凭证', async () => {
    const body={warehouse_id:'2',product_id:'1',quantity:'3',unit_price:'-1',unit_choice:'pack',note:'保留采购备注',_request_key:randomUUID()};
    const response=await request('/purchases/new',{body}); assert.equal(response.status,400); assert.equal(response.json.formValues.note,body.note); assert.equal(response.json.formValues._request_key,body._request_key); assert.equal(response.json.draftItems[0].unit_choice,'pack'); assert.equal(response.json.draftItems[0].price,'-1');
  });
  await check('审计写入失败，单据修改、版本、库存和去重凭证一起回滚', async () => {
    const body=saleBody({note:'审计失败回归'}), previous=count(db,'sales_orders'), stock=count(db,'stock_transactions');
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'审计失败'); END");
    assert.equal((await request('/sales/new',{body})).status,500); assert.equal(count(db,'sales_orders'),previous); assert.equal(count(db,'stock_transactions'),stock);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM mutation_requests WHERE request_key=?').get(body._request_key).n,0);
    db.exec('DROP TRIGGER fail_audit'); assert.equal((await request('/sales/new',{body})).status,302);
    const draft=idOf(await request('/sales/new',{body:saleBody()}));
    const before=db.prepare('SELECT * FROM sales_orders WHERE id=?').get(draft);
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'审计失败'); END");
    assert.equal((await request(`/sales/${draft}/edit`,{body:saleBody({draft_revision:'0',remarks:'不应落库'})})).status,500);
    assert.deepEqual(db.prepare('SELECT * FROM sales_orders WHERE id=?').get(draft),before);
    db.exec('DROP TRIGGER fail_audit');
  });
  await check('人工库存调整保留数量与原因；日志在数据库中只允许追加', async () => {
    const result=await request('/inventory/adjust',{body:{warehouse_id:'1',product_id:'1',new_quantity:'900',reason:'盘点原因'}}); assert.equal(result.status,302);
    const audit=lastAudit(db,'库存',1); assert.equal(audit.details.after.fields.数量,900); assert.equal(audit.details.after.fields.调整原因,'盘点原因');
    assert.throws(()=>db.prepare('UPDATE audit_logs SET summary=? WHERE id=?').run('篡改',audit.id),/只允许追加/);
    assert.throws(()=>db.prepare('DELETE FROM audit_logs WHERE id=?').run(audit.id),/只允许追加/);
    initSchema(db); assert.equal(lastAudit(db,'库存',1).summary,audit.summary);
  });
  await check('日志查看与导出仅限审计所有者，筛选动作覆盖所有单据', async () => {
    for (const user of [2,3]) { assert.equal((await request('/users/audit-logs',{user})).status,403); assert.equal((await request('/users/audit-logs/export',{user})).status,403); }
    const result=await request('/users/audit-logs?entity_type='+encodeURIComponent('销售单')+'&entity_id='+saleId);
    assert.ok(result.json.logs.every(log=>log.entity_id===saleId&&log.entity_type==='销售单'));
    assert.ok(result.json.actions.includes('记录退货退款')); assert.ok(result.json.actions.includes('新建采购单')); assert.ok(result.json.actions.includes('审核通过调拨单'));
    assert.equal((await request('/users/audit-logs?start=2026-02-30')).status,400);
  });
  await check('北京时间日期筛选包含午夜边界，翻页与导出保持筛选范围', async () => {
    const insert=db.prepare('INSERT INTO audit_logs(user_id,user_name,action,entity_type,entity_id,summary,created_at) VALUES (1,?,?,?,?,?,?)');
    for (const time of ['2026-09-30 15:59:59','2026-09-30 16:00:00','2026-10-01 15:59:59','2026-10-01 16:00:00']) insert.run('所有者','时间边界','库存',1,'=1+1',time);
    const q=new URLSearchParams({start:'2026-10-01',end:'2026-10-01',action:'时间边界'});
    const result=await request('/users/audit-logs?'+q); assert.equal(result.json.total,2);
    const exported=await request('/users/audit-logs/export?'+q); assert.equal(exported.status,200); assert.ok(exported.text.includes("'=1+1")); assert.ok(exported.text.includes('2026-10-01 00:00:00')); assert.ok(exported.text.includes('2026-10-01 23:59:59'));
    for(let i=0;i<121;i++) insert.run('所有者','翻页回归','库存',1,'翻页'+i,'2026-10-01 01:00:00');
    const page=await request('/users/audit-logs?'+new URLSearchParams({action:'翻页回归',page:'2'})); assert.equal(page.json.total,121); assert.equal(page.json.logs.length,50); assert.equal(page.json.pageCount,3); assert.equal(page.json.page,2);
    assert.ok(page.json.queryString.includes(encodeURIComponent('翻页回归')));
  });
  console.log(`草稿与审计回归：${passes} PASS / 0 FAIL`);
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(server) await new Promise(resolve=>server.close(resolve)); for(const db of databases) db.close(); fs.rmSync(dir,{recursive:true,force:true});
});
