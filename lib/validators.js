function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function isValidNonNegativeAmount(value) {
  if (isBlank(value)) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0;
}

function parseOptionalNonNegativeAmount(value, fallback = 0) {
  if (isBlank(value)) return { value: fallback };
  if (!isValidNonNegativeAmount(value)) return { error: true };
  return { value: Number(value) };
}

function roundToCents(amount) {
  return Math.round(Number(amount) * 100) / 100;
}

function roundToTenths(amount) {
  return Math.round(Number(amount) * 10) / 10;
}

/**
 * 退货单总额与明细合计是否一致。
 * 口径：整单按角取整（roundToTenths）；兼容改动前按分保存的旧单（roundToCents）；
 * 创建时被原单可退额上限截断的，允许总额等于 cap 且比明细合计少不到 0.1 元。
 */
function returnTotalMatchesItems(itemsSum, total, cap = null) {
  const totalCents = Math.round(Number(total) * 100);
  const sum = Number(itemsSum);
  if (!Number.isFinite(sum) || !Number.isFinite(totalCents)) return false;
  if (totalCents === Math.round(sum * 100)) return true;
  if (totalCents === Math.round(roundToTenths(sum) * 100)) return true;
  if (cap !== null && totalCents === Math.round(Number(cap) * 100)
    && totalCents < Math.round(sum * 100) && Math.round(sum * 100) - totalCents < 10) return true;
  return false;
}

function isValidDateString(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

module.exports = {
  isBlank,
  isValidNonNegativeAmount,
  parseOptionalNonNegativeAmount,
  roundToCents,
  roundToTenths,
  returnTotalMatchesItems,
  isValidDateString
};
