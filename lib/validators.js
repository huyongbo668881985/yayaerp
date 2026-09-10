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
  isValidDateString
};
