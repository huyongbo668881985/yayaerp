const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const Database = require('better-sqlite3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jxc-sales-filters-'));
process.env.JXC_DATA_DIR = dir;
const { initSchema } = require('../lib/schema');
const { formatDateTime } = require('../utils/dates');

function seed(db) {
  db.exec(`INSERT INTO users(username,password_hash,name,role,active) VALUES
    ('admin','unused','管理员','admin',1),('zhang','unused','张三','operator',1),
    ('li','unused','李四','operator',1),('former','unused','离职人员','operator',0);
    INSERT INTO warehouses(name,operator_id) VALUES ('车辆仓',2);
    INSERT INTO products(name,unit,sale_price) VALUES ('测试商品','瓶',100);
    INSERT INTO customers(name,operator_id) VALUES ('客户甲',2);
    INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES (1,1,1000);`);
}

let passed = 0;
async function check(label, work) { await work(); passed++; console.log('  PASS  ' + label); }

(async () => {
  let server;
  const dbs = [new Database(path.join(dir, 'a.db')), new Database(path.join(dir, 'b.db'))];
  try {
    await check('旧库升级负责人默认录入人，重复迁移保留已调整归属', () => {
      require('./fixtures/schema-v12').initSchema(dbs[0]); seed(dbs[0]);
      dbs[0].exec(`INSERT INTO sales_orders(warehouse_id,user_id,order_date,total_amount,status)
        VALUES (1,2,'2026-10-01',100,'approved')`);
      initSchema(dbs[0]);
      assert.equal(dbs[0].prepare('SELECT responsible_id FROM sales_orders').get().responsible_id, 2);
      dbs[0].exec('UPDATE sales_orders SET responsible_id=3'); initSchema(dbs[0]);
      assert.equal(dbs[0].prepare('SELECT responsible_id FROM sales_orders').get().responsible_id, 3);
      initSchema(dbs[1]); seed(dbs[1]);
    });
    const db = dbs[0];
    const sale = (total, paid, status = 'approved', userId = 1, responsible = 2) => {
      const id = Number(db.prepare(`INSERT INTO sales_orders(customer_id,warehouse_id,user_id,responsible_id,order_date,total_amount,paid_amount,status)
        VALUES (1,1,?,?,'2026-10-02',?,?,?)`).run(userId, responsible, total, paid, status).lastInsertRowid);
      db.prepare('INSERT INTO sales_order_items(sales_order_id,product_id,quantity,unit_label,base_quantity,unit_price) VALUES (?,1,1,\'瓶\',1,?)').run(id,total);
      return id;
    };
    const full = sale(100,100), offset = sale(100,60), debt = sale(100,20), refund = sale(100,100);
    const draft = sale(100,100,'draft'); sale(100,100,'submitted'); sale(100,100,'rejected');
    const own = sale(100,100,'approved',2,3), other = sale(100,100,'approved',3,2);
    const inactive = sale(100,100,'approved',1,4);
    for (const [id,amount] of [[offset,40],[refund,20]]) db.prepare(`INSERT INTO return_orders(warehouse_id,user_id,order_date,total_amount,status,related_sales_order_id)
      VALUES (1,1,'2026-10-02',?,'approved',?)`).run(amount,id);
    const app = express(); app.set('view engine','ejs'); app.set('views',path.join(__dirname,'..','views'));
    app.use(express.urlencoded({extended:true}));
    app.use((req,res,next) => {
      req.tenantDb = dbs[Number(req.get('x-test-tenant')) || 0];
      req.session = { user: { id: Number(req.get('x-test-user')) || 1 } };
      Object.assign(res.locals, { csrfToken: 'test', currentTenant: { name: '测试租户' }, currentPath: req.path, formatDateTime, newRequestKey: randomUUID });
      if (req.get('x-test-json')) res.render = (view, locals) => res.json({view,...locals});
      next();
    });
    app.use(require('../routes/sales'),require('../routes/printing'),require('../routes/users'));
    app.use((err,req,res,next)=>res.status(500).send(err.message));
    server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const request = async (url,{body,user=1,tenant=0,json=false}={}) => {
      const response = await fetch(base+url,{method:body?'POST':'GET',redirect:'manual',headers:{
        'x-test-user':String(user),'x-test-tenant':String(tenant),...(json?{'x-test-json':'1'}:{}),...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})
      },...(body?{body:new URLSearchParams(body)}:{})});
      const text = await response.text(); return {status:response.status,text,data:json?JSON.parse(text):null,location:response.headers.get('location')};
    };
    const list = async (query='',opts={}) => (await request('/sales'+query,{json:true,...opts})).data;
    await check('已结清包含全款与退货抵扣，排除草稿、待审核、拒绝和待退款', async () => {
      const rows = (await list('?settlement=settled')).orders.map(row=>row.id);
      assert.ok(rows.includes(full)); assert.ok(rows.includes(offset));
      for (const id of [draft,debt,refund]) assert.ok(!rows.includes(id));
      assert.ok((await list('?settlement=settled')).orders.every(row=>row.status==='approved'));
    });
    await check('未结清包含欠款和待退款，兼容旧链接且全部选项覆盖旧条件', async () => {
      assert.deepEqual((await list('?settlement=outstanding')).orders.map(row=>row.id).sort(),[1,debt,refund].sort());
      assert.deepEqual((await list('?unpaid=1')).orders.map(row=>row.id),(await list('?settlement=outstanding')).orders.map(row=>row.id));
      assert.equal((await list('?settlement=all&unpaid=1')).totalOrders,(await list()).totalOrders);
    });
    await check('负责人筛选独立于录入人，已停用历史负责人仍可筛选', async () => {
      assert.deepEqual((await list('?responsible_id=3&settlement=settled')).orders.map(row=>row.id),[own]);
      const result = await list('?responsible_id=4'); assert.deepEqual(result.orders.map(row=>row.id),[inactive]);
      assert.ok(result.responsibleOptions.some(person=>person.id===4 && !person.active));
      assert.equal((await list('?responsible_id=1.5')).responsibleId,null);
    });
    await check('负责人查询不扩大操作员权限，租户独立，空结果为零', async () => {
      assert.deepEqual((await list('?responsible_id=3',{user:2})).orders.map(row=>row.id),[own,1]);
      assert.ok(!(await list('?responsible_id=2',{user:2})).orders.some(row=>row.id===other));
      assert.equal((await list('?responsible_id=3',{tenant:1})).totalOrders,0);
      assert.equal((await list('?responsible_id=999')).totalOrders,0);
    });
    await check('CSV遵循结清和负责人条件，显示负责人及原始录入人', async () => {
      const result = await request('/sales/export?responsible_id=3&settlement=settled');
      assert.equal(result.status,200); const lines=result.text.trim().split('\r\n');
      assert.equal(lines.length,2); assert.ok(lines[0].includes('负责人,录入人')); assert.ok(lines[1].startsWith(own+','));
      assert.ok(lines[1].includes('李四,张三'));
    });
    await check('分页和排序保留负责人、结清及其他条件，清除标签仅清除对应项', async () => {
      const inserted=[]; for(let i=0;i<51;i++) inserted.push(sale(100,100,'approved',1,3));
      try {
        const result = await request('/sales?settlement=settled&responsible_id=3&start=2026-10-02');
        assert.equal(result.status,200);
        const hrefs=[...result.text.matchAll(/href="([^\"]+)"/g)].map(m=>m[1].replace(/&amp;/g,'&'));
        assert.ok(hrefs.some(url=>url.includes('page=2') && url.includes('responsible_id=3') && url.includes('settlement=settled')));
        assert.ok(hrefs.some(url=>url.includes('sort=amount') && url.includes('responsible_id=3')));
        assert.ok(result.text.includes('aria-label="清除负责人：李四筛选"'));
      } finally { for(const id of inserted){db.prepare('DELETE FROM sales_order_items WHERE sales_order_id=?').run(id);db.prepare('DELETE FROM sales_orders WHERE id=?').run(id);} }
    });
    const body = extra=>({_request_key:randomUUID(),warehouse_id:'1',items_json:JSON.stringify([{id:1,quantity:1,price:100}]),save_draft:'1',...extra});
    let newId;
    await check('新建负责人默认为录入人，可选其他账号且错误提交不落库', async () => {
      const created = await request('/sales/new',{body:body()}); assert.equal(created.status,302);
      newId=Number(created.location.match(/\/(\d+)/)[1]);
      assert.equal(db.prepare('SELECT responsible_id FROM sales_orders WHERE id=?').get(newId).responsible_id,1);
      const invalid=await request('/sales/new',{body:body({responsible_id:'999'})}); assert.equal(invalid.status,400); assert.ok(invalid.text.includes('所选负责人不存在'));
      assert.equal((await request('/sales/new',{body:body({responsible_id:'4'})})).status,400);
    });
    await check('草稿编辑调整负责人，录入人保留；并发旧版本不能覆盖', async () => {
      const edited=await request(`/sales/${newId}/edit`,{body:body({responsible_id:'3',draft_revision:'0'})}); assert.equal(edited.status,302);
      const order=db.prepare('SELECT * FROM sales_orders WHERE id=?').get(newId);assert.equal(order.user_id,1);assert.equal(order.responsible_id,3);
      assert.equal((await request(`/sales/${newId}/edit`,{body:body({responsible_id:'2',draft_revision:'0'})})).status,409);
    });
    await check('已审核单调整负责人有前后审计与版本保护，不改变财务、库存，重试不重复', async () => {
      const before=db.prepare('SELECT * FROM sales_orders WHERE id=?').get(full);
      const finance=db.prepare('SELECT COUNT(*) n FROM customer_ledger').get().n;
      const stock=db.prepare('SELECT * FROM inventory').all();
      const payload={_request_key:randomUUID(),responsible_id:'3',responsible_revision:String(before.revision)};
      const result=await request(`/sales/${full}/responsible`,{body:payload});assert.equal(result.status,302);
      assert.equal((await request(`/sales/${full}/responsible`,{body:payload})).location,result.location);
      const after=db.prepare('SELECT * FROM sales_orders WHERE id=?').get(full);
      assert.deepEqual(after,{...before,responsible_id:3,revision:before.revision+1});
      assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_ledger').get().n,finance);assert.deepEqual(db.prepare('SELECT * FROM inventory').all(),stock);
      const audit=db.prepare("SELECT * FROM audit_logs WHERE entity_id=? AND action='调整销售单负责人'").all(full);assert.equal(audit.length,1);
      const details=JSON.parse(audit[0].details_json);assert.ok(details.before.fields.负责人.includes('张三'));assert.ok(details.after.fields.负责人.includes('李四'));
      const logCount=db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n;
      const stale=await request(`/sales/${full}/responsible`,{body:{...payload,_request_key:randomUUID(),responsible_id:'2'}});assert.ok(stale.location.includes('conflict'));
      assert.deepEqual(db.prepare('SELECT * FROM sales_orders WHERE id=?').get(full),after);
      const invalid=await request(`/sales/${full}/responsible`,{body:{...payload,_request_key:randomUUID(),responsible_revision:String(after.revision),responsible_id:'999'}});assert.ok(invalid.location.includes('invalid'));
      assert.deepEqual(db.prepare('SELECT * FROM sales_orders WHERE id=?').get(full),after);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n,logCount);
      assert.equal((await request(`/sales/${full}/responsible`,{user:2,body:{...payload,_request_key:randomUUID()}})).status,403);
    });
    await check('详情和打印同时显示负责人和录入人，负责人引用阻止删除账号', async () => {
      const detail=await request('/sales/'+own);assert.equal(detail.status,200);assert.ok(detail.text.includes('负责人'));assert.ok(detail.text.includes('录入人'));
      const print=await request('/sales/'+own+'/print');assert.equal(print.status,200,print.text);assert.ok(print.text.includes('负责人：李四'));assert.ok(print.text.includes('录入人：张三'));
      db.exec("INSERT INTO users(username,password_hash,name,role) VALUES ('onlyresponsible','unused','仅负责人','operator')");
      db.prepare('UPDATE sales_orders SET responsible_id=5 WHERE id=?').run(full);
      assert.equal((await request('/users/5/delete',{body:{}})).status,400);
    });
    await check('负责人变更的审计失败时归属、版本和提交凭证一起回滚', async () => {
      const before=db.prepare('SELECT * FROM sales_orders WHERE id=?').get(full);
      const key=randomUUID();
      db.exec("CREATE TRIGGER reject_responsible_audit BEFORE INSERT ON audit_logs WHEN NEW.action='调整销售单负责人' BEGIN SELECT RAISE(ABORT,'测试审计失败'); END");
      try {
        assert.equal((await request(`/sales/${full}/responsible`,{body:{_request_key:key,responsible_id:'2',responsible_revision:String(before.revision)}})).status,500);
        assert.deepEqual(db.prepare('SELECT * FROM sales_orders WHERE id=?').get(full),before);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM mutation_requests WHERE request_key=?').get(key).n,0);
      } finally { db.exec('DROP TRIGGER reject_responsible_audit'); }
    });
    console.log(`销售订单筛选与负责人测试通过：${passed} 项`);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    for(const db of dbs)db.close();fs.rmSync(dir,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
