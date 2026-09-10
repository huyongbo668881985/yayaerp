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

module.exports = {
  isBlank,
  isValidNonNegativeAmount,
  parseOptionalNonNegativeAmount
};
