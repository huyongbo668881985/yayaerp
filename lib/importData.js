const ExcelJS = require('exceljs');
const yauzl = require('yauzl');
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { roundToCents } = require('./validators');
const { writeAuditLog } = require('./auditLog');

const definitions = {
  products: { name:'商品', headers:['SKU','名称','规格','基本单位','大单位','换算比例','基本成本价','基本售价','箱成本价','箱售价','库存预警值'], keys:['sku','name','spec','unit','pack_unit','pack_size','cost_price','sale_price','cost_price_pack','sale_price_pack','low_stock_threshold'], required:['SKU','名称','基本单位'], help:'SKU 必填；已有 SKU 跳过，不覆盖价格或箱规。金额使用数字，箱价可留空；换算比例为正整数。' },
  customers: { name:'客户', headers:['名称','联系人','电话','地址','归属账号'], keys:['name','contact','phone','address','username'], required:['名称'], help:'客户名称不能含空白，已有名称跳过。归属账号填写登录用户名，留空为不指定。电话请设为文本。' },
  suppliers: { name:'供应商', headers:['名称','联系人','电话'], keys:['name','contact','phone'], required:['名称'], help:'已有同名供应商跳过，不覆盖联系方式。电话请设为文本。' },
  inventory: { name:'库存盘点', headers:['SKU','仓库','实盘数量','调整原因'], keys:['sku','warehouse','quantity','reason'], required:['SKU','仓库','实盘数量','调整原因'], help:'实盘数量以基本单位计数，表示盘点后的库存总数；不是本次入库数量。按 SKU 和仓库名称定位，原因必填。' }
};

function csvRows(text) {
  const rows = [], row = []; let cell='', quoted=false, closed=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) { if(ch==='"') { if(text[i+1]==='"'){cell+='"';i++;} else {quoted=false;closed=true;} } else cell+=ch; }
    else if(ch===',' || ch==='\n' || ch==='\r') {
      row.push(cell);cell='';closed=false;
      if(ch!==',') {rows.push(row.splice(0));if(ch==='\r' && text[i+1]==='\n')i++;}
    } else if(ch==='"' && !cell && !closed) quoted=true;
    else { if(closed || ch==='"') throw new Error('CSV 引号格式错误，请使用模板并重新另存为 CSV。');cell+=ch; }
    if(rows.length>1001 || row.length>20 || cell.length>2000) throw new Error('文件超出限制：最多 1000 条数据、20 列，单元格最多 2000 字。');
  }
  if(quoted)throw new Error('CSV 引号未闭合');
  if(cell || row.length) {row.push(cell);rows.push(row);}
  return rows;
}

async function checkZip(buffer) {
  await new Promise((resolve,reject)=>yauzl.fromBuffer(buffer,{lazyEntries:true},(error,zip)=>{
    if(error)return reject(new Error('Excel 文件损坏，请重新另存为 .xlsx。'));
    let size=0,actualSize=0,count=0,done=false;
    const fail=()=>{if(done)return;done=true;zip.close();reject(new Error('Excel 内容超出限制或包含宏，请使用精简的 .xlsx 模板。'));};
    zip.on('error',fail);zip.on('entry',entry=>{
      size+=entry.uncompressedSize;count++;
      if(size>8*1024*1024 || count>100 || /vbaProject|externalLinks/i.test(entry.fileName))return fail();
      zip.openReadStream(entry,(error,stream)=>{
        if(error)return fail();
        stream.on('error',fail);
        stream.on('data',chunk=>{actualSize+=chunk.length;if(actualSize>8*1024*1024){stream.destroy();fail();}});
        stream.on('end',()=>{if(!done)zip.readEntry();});
      });
    });
    zip.on('end',()=>{if(!done){done=true;resolve();}});zip.readEntry();
  }));
}

async function parseFile(buffer,filename,kind) {
  const definition=Object.hasOwn(definitions,kind)?definitions[kind]:null;if(!definition)throw new Error('导入类型无效');
  let rows;
  if(/\.xlsx$/i.test(filename)) {
    await checkZip(buffer);
    rows=await new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'readWorkbook.js'),{workerData:buffer,resourceLimits:{maxOldGenerationSizeMb:128}});
      let settled=false;
      const finish=(error,data)=>{if(settled)return;settled=true;clearTimeout(timer);worker.terminate();error?reject(error):resolve(data);};
      const timer=setTimeout(()=>finish(new Error('Excel 解析超时，请缩小文件并重新上传。')),5000);
      worker.once('message',message=>finish(message.error?new Error(message.error):null,message.rows));
      worker.once('error',()=>finish(new Error('Excel 内容超出限制或无法读取，请使用模板。')));
      worker.once('exit',()=>{if(!settled)finish(new Error('Excel 解析未完成，请重新另存。'));});
    });
  } else if(/\.csv$/i.test(filename)) {
    let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch(_){text=new TextDecoder('gb18030',{fatal:true}).decode(buffer);}
    rows=csvRows(text.replace(/^\uFEFF/,''));
  } else throw new Error('请上传 .xlsx 或 .csv 文件；旧 .xls 请另存为 .xlsx。');
  if(!rows.length)throw new Error('文件没有表头或数据');
  const headers=rows.shift().map(value=>value.trim());
  // 只忽略最右侧空列；未知表头不能静默丢弃。
  while(headers.at(-1)==='')headers.pop();
  if(!headers.length || new Set(headers).size!==headers.length || headers.some(h=>!definition.headers.includes(h)))throw new Error('表头重复或与模板不一致，请下载对应模板。');
  for(const name of definition.required)if(!headers.includes(name))throw new Error('缺少必填列：'+name);
  const data=[];
  rows.forEach((row,index)=>{
    if(row.every(value=>!String(value).trim()))return;
    if(row.slice(headers.length).some(value=>String(value).trim()))throw new Error(`第 ${index+2} 行有未命名列中的数据`);
    const values={};
    headers.forEach((header,i)=>{
      const value=String(row[i]??'');if(value.length>2000 || /\u0000/.test(value))throw new Error(`第 ${index+2} 行单元格过长或含无效字符`);
      values[definition.keys[definition.headers.indexOf(header)]]=value;
    });
    data.push({line:index+2,values});
  });
  if(!data.length || data.length>1000)throw new Error('请填写 1–1000 条数据后上传。');
  return data;
}

function validateRows(db,kind,rows) {
  const seen=new Set();
  return rows.map(({line,values})=>{
    const v=Object.fromEntries(Object.entries(values).map(([key,value])=>[key,String(value).trim()]));
    const errors=[], normalized={...v};let action='新增',target=null,stock=null;
    const text=(key,label,required=false,max=200)=>{if(required&&!v[key])errors.push(label+'必填');if((v[key]||'').length>max)errors.push(label+'过长');};
    const number=(key,label,defaultValue=0,integer=false,nullable=false)=>{
      if(!v[key]){normalized[key]=nullable?null:defaultValue;return;}
      const n=Number(v[key]);
      if(!/^\d+(\.\d+)?$/.test(v[key]) || !Number.isFinite(n) || n<0 || n>1e9 || (integer&&!Number.isInteger(n)))errors.push(label+'必须为有效非负'+(integer?'整数':'数字'));
      normalized[key]=integer?n:roundToCents(n);
    };
    if(kind==='products') {
      text('sku','SKU',true,100);text('name','名称',true,100);text('unit','基本单位',true,20);text('spec','规格');text('pack_unit','大单位',false,20);
      number('pack_size','换算比例',1,true);if(normalized.pack_size<1)errors.push('换算比例必须大于 0');
      if(v.pack_unit && v.pack_unit===v.unit)errors.push('大单位不能与基本单位相同');
      for(const key of ['cost_price','sale_price','cost_price_pack','sale_price_pack'])number(key,key.includes('cost')?'成本价':'售价',0,false,key.endsWith('_pack'));
      number('low_stock_threshold','库存预警值',0,true);
      target=db.prepare('SELECT id FROM products WHERE sku=?').get(v.sku||'');
    } else if(kind==='customers' || kind==='suppliers') {
      text('name','名称',true,100);text('contact','联系人');text('phone','电话',false,50);
      if(kind==='customers') {
        text('address','地址',false,500);text('username','归属账号',false,100);
        if(/\s/u.test(values.name||''))errors.push('客户名称不能含空白');
        const user=v.username?db.prepare('SELECT id FROM users WHERE username=? AND active=1').get(v.username):null;
        if(v.username&&!user)errors.push('归属账号不存在或已禁用');normalized.operator_id=user?.id||null;
      }
      target=db.prepare(`SELECT id FROM ${kind} WHERE name=? ORDER BY id LIMIT 1`).get(v.name||'');
    } else {
      action='调整';text('sku','SKU',true,100);text('warehouse','仓库',true,100);text('reason','调整原因',true,500);
      if(!v.quantity)errors.push('实盘数量必填');number('quantity','实盘数量',0,true);
      const product=db.prepare('SELECT id,name,unit FROM products WHERE sku=?').get(v.sku||'');
      const warehouses=db.prepare('SELECT id FROM warehouses WHERE name=? AND active=1').all(v.warehouse||'');
      if(!product)errors.push('SKU 不存在');if(warehouses.length!==1)errors.push('仓库不存在、已停用或名称不唯一');
      if(product && warehouses.length===1) {
        normalized.product_id=product.id;normalized.product_name=product.name;normalized.unit=product.unit;normalized.warehouse_id=warehouses[0].id;
        stock=db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?').get(product.id,warehouses[0].id)?.quantity||0;
        normalized.before=stock;normalized.change=normalized.quantity-stock;if(!normalized.change)action='无变化';
      }
    }
    const identity=kind==='inventory'?v.sku+'\0'+v.warehouse:kind==='products'?v.sku:v.name;
    if(seen.has(identity))errors.push('文件中重复出现同一'+(kind==='inventory'?'商品与仓库':'识别键'));seen.add(identity);
    if(target)action='跳过已有';
    return {line,values,normalized,action,errors,targetId:target?.id||null,stock};
  });
}

function applyRows(db,kind,preview,batch,user) {
  const inserted=[],adjustments=[];let skipped=0;
  for(const row of preview) {
    const v=row.normalized;
    if(row.action==='跳过已有' || row.action==='无变化'){skipped++;continue;}
    if(kind==='products') {
      const id=db.prepare(`INSERT INTO products(sku,name,spec,unit,pack_unit,pack_size,cost_price,sale_price,cost_price_pack,sale_price_pack,low_stock_threshold)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(v.sku,v.name,v.spec||'',v.unit,v.pack_unit||null,v.pack_size,v.cost_price,v.sale_price,v.cost_price_pack,v.sale_price_pack,v.low_stock_threshold).lastInsertRowid;
      db.prepare('INSERT INTO inventory(product_id,warehouse_id,quantity) SELECT ?,id,0 FROM warehouses').run(id);inserted.push({id,...v});
    } else if(kind==='customers') {
      const id=db.prepare('INSERT INTO customers(name,contact,phone,address,operator_id) VALUES (?,?,?,?,?)').run(v.name,v.contact||'',v.phone||'',v.address||'',v.operator_id).lastInsertRowid;inserted.push({id,...v});
    } else if(kind==='suppliers') {
      const id=db.prepare('INSERT INTO suppliers(name,contact,phone) VALUES (?,?,?)').run(v.name,v.contact||'',v.phone||'').lastInsertRowid;inserted.push({id,...v});
    } else {
      db.prepare(`INSERT INTO inventory(product_id,warehouse_id,quantity) VALUES (?,?,?) ON CONFLICT(product_id,warehouse_id) DO UPDATE SET quantity=excluded.quantity`).run(v.product_id,v.warehouse_id,v.quantity);
      db.prepare(`INSERT INTO stock_transactions(product_id,warehouse_id,change_qty,type,ref_type,ref_id,user_id) VALUES (?,?,?,'adjust','import',NULL,?)`).run(v.product_id,v.warehouse_id,v.change,user.id);
      adjustments.push(v);
    }
  }
  const result={written:inserted.length+adjustments.length,skipped};
  writeAuditLog(db,user,'导入'+definitions[kind].name,'导入批次',null,`${result.written} 条写入，${skipped} 条跳过；批次 ${batch}`,{batch,kind,inserted,adjustments});
  return result;
}

async function template(kind) {
  const book=new ExcelJS.Workbook(),sheet=book.addWorksheet('导入');
  sheet.addRow(definitions[kind].headers);sheet.views=[{state:'frozen',ySplit:1}];
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2563EB'}};
  sheet.columns.forEach(column=>{column.width=20;column.numFmt='@';});
  return book.xlsx.writeBuffer();
}
module.exports={definitions,parseFile,validateRows,applyRows,template,csvRows};
