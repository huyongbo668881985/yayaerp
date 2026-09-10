// 统一的业务日期工具：全站"今天/默认单据日期/到期日"都按中国标准时间（UTC+8）计算。
// 之前散落各处的 new Date().toISOString().slice(0,10) 是 UTC 日期——
// 北京时间 0:00~8:00 之间会把"今天"算成前一天，单据日期和仪表盘"今日销售额"都会错位。
// 中国没有夏令时，固定 +8 小时偏移是精确的，不需要引完整的时区库。
const CST_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 当前北京时间的日期，格式 YYYY-MM-DD */
function todayLocalDate() {
  return new Date(Date.now() + CST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 将 SQLite datetime('now') 产生的 UTC 时间显示为北京时间。 */
function formatDateTime(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const parsed = new Date(/Z$|[+-]\d\d:?\d\d$/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed.getTime())) return raw;
  return new Date(parsed.getTime() + CST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { todayLocalDate, formatDateTime, CST_OFFSET_MS };
