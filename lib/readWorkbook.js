// 不可信工作簿在有时间、堆内存上限的工作线程中解析，避免阻塞 Web 进程。
const { parentPort,workerData }=require('node:worker_threads');
const ExcelJS=require('exceljs');
(async()=>{
  const book=new ExcelJS.Workbook();await book.xlsx.load(Buffer.from(workerData));
  if(book.worksheets.length!==1)throw new Error('请只保留一个数据工作表，避免漏导其他工作表。');
  const sheet=book.worksheets[0];
  if(sheet.rowCount>1001 || sheet.columnCount>20)throw new Error('Excel 最多 1000 条数据、20 列。');
  const rows=[];
  sheet.eachRow({includeEmpty:true},row=>{
    const values=[];
    for(let i=1;i<=sheet.columnCount;i++) {
      const value=row.getCell(i).value;
      if(value && typeof value==='object') {
        if(value.richText)values.push(value.richText.map(part=>part.text).join(''));
        else throw new Error(`第 ${row.number} 行含公式、日期或链接，请改为文本或普通数字。`);
      } else values.push(value==null?'':String(value));
    }
    rows.push(values);
  });
  parentPort.postMessage({rows});
})().catch(error=>parentPort.postMessage({error:error.message}));
