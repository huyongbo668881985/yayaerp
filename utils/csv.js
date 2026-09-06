// 极简 CSV 导出工具：转义逗号/引号/换行，并加 UTF-8 BOM 让 Excel 打开中文不乱码
function toCsv(headers, rows) {
  // CSV 公式注入防护：Excel/WPS 会把以 = + - @ 等开头的单元格当公式执行，
  // 而客户名、备注这类用户可控文本是能进导出文件的。对这些值加 ' 前缀强制按文本处理。
  // 纯数字（含负数金额、小数）放行不加前缀，否则金额列会全部变成文本。
  // 误伤说明：+86 开头的电话号码会被加前缀，Excel 里显示正常（' 仅编辑时可见）。
  const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
  const escape = (val) => {
    if (val === null || val === undefined) val = '';
    val = String(val);
    if (!NUMERIC_RE.test(val) && /^[=+\-@\t\r]/.test(val)) {
      val = "'" + val;
    }
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
