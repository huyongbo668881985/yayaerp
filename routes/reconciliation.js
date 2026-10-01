const express=require('express');
const { requireAdmin }=require('../middleware/auth');
const { statement,cents }=require('../lib/customerLedger');
const { todayLocalDate }=require('../utils/dates');
const { isValidDateString }=require('../lib/validators');
const { sendCsv }=require('../utils/csv');
const router=express.Router();
const money=value=>(value/100).toFixed(2);
function dates(req) {
  const start=typeof req.query.start==='string'?req.query.start:todayLocalDate().slice(0,8)+'01';
  const end=typeof req.query.end==='string'?req.query.end:todayLocalDate();
  if(!isValidDateString(start)||!isValidDateString(end)||start>end||end>todayLocalDate())throw Object.assign(new Error('请选择有效日期：开始不晚于结束，结束不晚于今天。'),{status:400});
  return {start,end};
}
router.use('/reconciliation',requireAdmin,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.get('/reconciliation',(req,res)=>{
  const openingDate=req.tenantDb.prepare("SELECT value FROM ledger_metadata WHERE key='opening_date'").get().value;
  res.render('reconciliation',{customers:req.tenantDb.prepare('SELECT id,name FROM customers ORDER BY name').all(),suppliers:req.tenantDb.prepare('SELECT id,name FROM suppliers ORDER BY name').all(),start:[openingDate,todayLocalDate().slice(0,8)+'01'].sort().at(-1),end:todayLocalDate(),openingDate});
});
router.get('/reconciliation/customers/:id',(req,res,next)=>{
  try {
    if(!/^(0|[1-9]\d*)$/.test(req.params.id))return res.status(404).send('客户不存在');
    const id=Number(req.params.id),customer=id?req.tenantDb.prepare('SELECT id,name,contact,phone,address FROM customers WHERE id=?').get(id):{id:0,name:'散客'};
    if(!customer)return res.status(404).send('客户不存在');
    const {start,end}=dates(req),data=statement(req.tenantDb,id||null,start,end);
    if(req.query.format==='csv') {
      const rows=[['期初余额','','','','','','',money(data.opening)]];
      for(const row of data.rows)rows.push([row.event_date,row.event_kind,(row.document_type==='sales'?'销售单':'退货单')+' #'+row.document_id,money(row.sales_cents),money(row.received_cents),money(row.returned_cents),money(row.refunded_cents),money(row.balance_cents)]);
      rows.push(['本期合计','','',money(data.totals.sales),money(data.totals.received),money(data.totals.returned),money(data.totals.refunded),money(data.ending)]);
      return sendCsv(res,customer.name+'对账单.csv',['入账日期','业务','单号','销售','收款','退货','退款','余额'],rows);
    }
    res.render('customer_statement',{customer,start,end,data,money,printedAt:new Date().toISOString(),print:req.query.print==='1'});
  }catch(error){if(error.status)return res.status(error.status).render('global_error',{message:error.message,returnTo:'/reconciliation',returnLabel:'返回对账'});next(error);}
});
router.get('/reconciliation/suppliers/:id',(req,res,next)=>{
  try {
    if(!/^[1-9]\d*$/.test(req.params.id))return res.status(404).send('供应商不存在');
    const supplier=req.tenantDb.prepare('SELECT * FROM suppliers WHERE id=?').get(req.params.id);if(!supplier)return res.status(404).send('供应商不存在');
    const {start,end}=dates(req);
    const count=req.tenantDb.prepare('SELECT COUNT(*) n FROM purchase_orders WHERE supplier_id=? AND order_date BETWEEN ? AND ?').get(supplier.id,start,end).n;
    if(count>10000)return res.status(400).render('global_error',{message:'本次对账超过 10000 条，请缩小日期范围。'});
    const orders=req.tenantDb.prepare(`SELECT po.*,w.name warehouse_name FROM purchase_orders po LEFT JOIN warehouses w ON w.id=po.warehouse_id WHERE supplier_id=? AND order_date BETWEEN ? AND ? ORDER BY order_date,po.id`).all(supplier.id,start,end);
    const totalCents=orders.reduce((sum,o)=>sum+cents(o.total_amount),0);
    if(!Number.isSafeInteger(totalCents))throw Object.assign(new Error('汇总金额超出精确范围，请缩小对账区间。'),{status:400});
    const total=totalCents/100;
    if(req.query.format==='csv')return sendCsv(res,supplier.name+'采购对账.csv',['单号','采购日期','仓库','采购金额','备注'],[...orders.map(o=>[o.id,o.order_date,o.warehouse_name,o.total_amount.toFixed(2),o.note||'']),['合计','','',total.toFixed(2),'']]);
    res.render('supplier_statement',{supplier,orders,total,start,end,print:req.query.print==='1',printedAt:new Date().toISOString()});
  }catch(error){if(error.status)return res.status(error.status).render('global_error',{message:error.message});next(error);}
});
module.exports=router;
