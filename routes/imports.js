const express=require('express');
const multer=require('multer');
const { randomUUID,createHash }=require('node:crypto');
const { requireAdmin }=require('../middleware/auth');
const { sendCsv }=require('../utils/csv');
const { definitions,parseFile,validateRows,applyRows,template }=require('../lib/importData');
const router=express.Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:1024*1024,files:1,fields:3,fieldSize:200,parts:4}}).single('file');
router.use('/imports',requireAdmin,(req,res,next)=>{res.set('Cache-Control','no-store');next();});
router.get('/imports',(req,res)=>res.render('imports',{definitions,batches:req.tenantDb.prepare('SELECT id,kind,filename,status,created_at FROM import_batches WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20').all(req.session.user.id)}));
router.get('/imports/:kind/template',async(req,res,next)=>{
  const definition=Object.hasOwn(definitions,req.params.kind)?definitions[req.params.kind]:null;if(!definition)return res.status(404).send('导入类型不存在');
  if(req.query.format==='csv')return sendCsv(res,definition.name+'导入模板.csv',definition.headers,[]);
  try {
    const buffer=await template(req.params.kind);res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition',`attachment; filename="template.xlsx"; filename*=UTF-8''${encodeURIComponent(definition.name+'导入模板.xlsx')}`);res.send(Buffer.from(buffer));
  }catch(error){next(error);}
});
router.post('/imports/:kind/preview',(req,res,next)=>{
  if(!Object.hasOwn(definitions,req.params.kind))return res.status(404).json({error:'导入类型不存在'});
  upload(req,res,async(error)=>{
    if(error)return res.status(400).json({error:'上传失败：文件最多 1 MB，仅上传一个 .xlsx 或 .csv 文件。'});
    if(!req.file)return res.status(400).json({error:'请先选择文件'});
    try {
      const rows=await parseFile(req.file.buffer,req.file.originalname,req.params.kind),db=req.tenantDb;
      const hash=createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      const id=db.transaction(()=>{
        // 同一天、同账号、同内容的重复上传返回原批次；翌日盘点可重新使用相同文件。
        const existing=db.prepare(`SELECT id FROM import_batches WHERE user_id=? AND kind=? AND content_hash=? AND date(created_at,'+8 hours')=date('now','+8 hours') ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(req.session.user.id,req.params.kind,hash);
        if(existing)return existing.id;
        const id=randomUUID(),preview=validateRows(db,req.params.kind,rows);
        db.prepare('INSERT INTO import_batches(id,user_id,kind,content_hash,filename,rows_json,preview_json) VALUES (?,?,?,?,?,?,?)').run(id,req.session.user.id,req.params.kind,hash,req.file.originalname.slice(0,200),JSON.stringify(rows),JSON.stringify(preview));return id;
      }).immediate();
      res.json({redirect:'/imports/batches/'+id});
    }catch(error){res.status(400).json({error:error.message.includes('Excel')||error.message.includes('第 ')||error.message.includes('CSV')||error.message.includes('列')||error.message.includes('模板')||error.message.includes('数据')||error.message.includes('文件')?error.message:'文件无法读取，请检查格式或重新另存。'});}
  });
});
function batchFor(req,res) {
  const batch=req.tenantDb.prepare('SELECT * FROM import_batches WHERE id=? AND user_id=?').get(req.params.id,req.session.user.id);
  if(!batch){res.status(404).send('导入批次不存在');return null;}return batch;
}
function renderBatch(req,res,batch,error=null) {
  res.render('import_preview',{batch,definition:definitions[batch.kind],preview:JSON.parse(batch.preview_json),result:batch.result_json?JSON.parse(batch.result_json):null,error});
}
router.get('/imports/batches/:id',(req,res)=>{const batch=batchFor(req,res);if(batch)renderBatch(req,res,batch);});
router.post('/imports/batches/:id/restart',(req,res,next)=>{
  try {
    const id=req.tenantDb.transaction(()=>{
      const batch=batchFor(req,res);if(!batch)return null;
      if(batch.kind!=='inventory'||batch.status!=='committed')return batch.id;
      // 再次盘点是明确的新操作；重复点击复用待确认批次，不直接修改库存。
      const pending=req.tenantDb.prepare("SELECT id FROM import_batches WHERE user_id=? AND kind='inventory' AND content_hash=? AND status='pending' AND created_at>=datetime('now','-24 hours') ORDER BY created_at DESC,rowid DESC LIMIT 1").get(req.session.user.id,batch.content_hash);
      if(pending)return pending.id;
      const id=randomUUID(),rows=JSON.parse(batch.rows_json),preview=validateRows(req.tenantDb,batch.kind,rows);
      req.tenantDb.prepare('INSERT INTO import_batches(id,user_id,kind,content_hash,filename,rows_json,preview_json) VALUES (?,?,?,?,?,?,?)').run(id,batch.user_id,batch.kind,batch.content_hash,batch.filename,batch.rows_json,JSON.stringify(preview));return id;
    }).immediate();
    if(id)res.redirect('/imports/batches/'+id);
  }catch(error){next(error);}
});
router.post('/imports/batches/:id/recheck',(req,res)=>{
  const batch=batchFor(req,res);if(!batch)return;
  if(batch.status==='pending')req.tenantDb.transaction(()=>req.tenantDb.prepare('UPDATE import_batches SET preview_json=? WHERE id=?').run(JSON.stringify(validateRows(req.tenantDb,batch.kind,JSON.parse(batch.rows_json))),batch.id)).immediate();
  res.redirect('/imports/batches/'+batch.id);
});
router.post('/imports/batches/:id/confirm',(req,res,next)=>{
  try {
    const outcome=req.tenantDb.transaction(()=>{
      const batch=batchFor(req,res);if(!batch)return null;
      if(batch.status==='committed')return {batch};
      if(Date.now()-new Date(batch.created_at.replace(' ','T')+'Z').getTime()>86400000)return {batch,error:'预览已超过 24 小时，请重新上传文件。'};
      const preview=validateRows(req.tenantDb,batch.kind,JSON.parse(batch.rows_json));
      if(preview.some(row=>row.errors.length))return {batch,error:'存在错误行，请修正文件后重新上传；本批次未写入。'};
      if(JSON.stringify(preview)!==batch.preview_json)return {batch,error:'档案或库存已变化，请点击“重新校验”并核对最新预览后再确认。'};
      const result=applyRows(req.tenantDb,batch.kind,preview,batch.id,req.session.user);
      req.tenantDb.prepare("UPDATE import_batches SET status='committed',result_json=?,committed_at=datetime('now') WHERE id=?").run(JSON.stringify(result),batch.id);return {batch};
    }).immediate();
    if(!outcome)return;
    if(outcome.error)return renderBatch(req,res.status(409),outcome.batch,outcome.error);
    res.redirect('/imports/batches/'+outcome.batch.id);
  }catch(error){next(error);}
});
module.exports=router;
