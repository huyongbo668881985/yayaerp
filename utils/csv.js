// 极简 CSV 导出工具：转义逗号/引号/换行，并加 UTF-8 BOM 让 Excel 打开中文不乱码
function toCsv(headers, rows) {
  const escape = (val) => {
    if (val === null || val === undefined) val = '';
    val = String(val);
    if (/[",\n]/.test(val)) {
      val = '"' + val.replace(/"/g, '""') + '"';
    }
    return val;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(row.map(escape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

function sendCsv(res, filename, headers, rows) {
  const csv = toCsv(headers, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // RFC 6266：filename= 兜底 + filename*=UTF-8'' 声明编码。
  // 只写 filename= 的话，中文文件名在部分浏览器会显示成百分号乱码
  res.setHeader('Content-Disposition',
    `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(csv);
}

module.exports = { toCsv, sendCsv };
