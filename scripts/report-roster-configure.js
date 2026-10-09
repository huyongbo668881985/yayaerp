#!/usr/bin/env node
// 仅运维配置名单；HTTP API 保持只读。业务员岗位不能由 operator 角色推断。
require('dotenv').config();
const fs = require('fs');
const { isValidDateString } = require('../lib/validators');
const { getTenantDb } = require('../lib/tenantManager');
function configure(db, entries, { hideEmpty = false } = {}) {
  if (!Array.isArray(entries)) throw new Error('配置必须是名单数组');
  for (const e of entries) {
    if (!Number.isSafeInteger(e.user_id) || e.user_id < 1 || !isValidDateString(e.start_date)
      || (e.end_date != null && (!isValidDateString(e.end_date) || e.end_date < e.start_date))) throw new Error('名单 ID 或任职日期无效');
    const user=db.prepare('SELECT role FROM users WHERE id=?').get(e.user_id);
    if (!user || user.role !== 'operator') throw new Error('名单只能包含经过人工确认的 operator，不能包含管理员');
    if (entries.some(x=>x!==e && x.user_id===e.user_id && x.start_date<=(e.end_date||'9999-12-31') && e.start_date<=(x.end_date||'9999-12-31'))) throw new Error('同一业务员任职区间不可重叠');
  }
  db.transaction(()=>{
    db.prepare('DELETE FROM report_salespeople').run();
    const insert=db.prepare('INSERT INTO report_salespeople(user_id,start_date,end_date) VALUES(?,?,?)');
    entries.forEach(e=>insert.run(e.user_id,e.start_date,e.end_date??null));
    db.prepare("INSERT OR REPLACE INTO report_metadata VALUES('roster_confirmed','true')").run();
    db.prepare("INSERT OR REPLACE INTO report_metadata VALUES('hide_empty_salespeople',?)").run(String(hideEmpty));
  }).immediate();
}
if(require.main===module) {
  try {
    const [code,file,flag]=process.argv.slice(2);
    if (flag && flag!=='--hide-empty') throw new Error('仅支持 --hide-empty 展示选项');
    if (!code||!file) throw new Error('用法：node scripts/report-roster-configure.js 租户代码 名单.json');
    const entries=JSON.parse(fs.readFileSync(file,'utf8'));
    const access=getTenantDb(code);
    if(access.error) throw new Error('租户不可用：'+access.error);
    configure(access.db,entries,{hideEmpty:flag==='--hide-empty'});
    access.db.close();
    console.log('日报业务员名单已确认，共 '+entries.length+' 个任职区间');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
module.exports={configure};
