const DEFAULT_GIFT_LABEL = '赠品';
const ALL_GIFTS_FILTER = '__all_gifts__';
const MAX_GIFT_LABELS = 20;

function getCustomGiftLabels(db) {
  return db.prepare('SELECT id, name, created_at FROM gift_labels ORDER BY id ASC').all();
}

function getGiftLabelOptions(db) {
  return [DEFAULT_GIFT_LABEL, ...getCustomGiftLabels(db).map(label => label.name)];
}

/**
 * 筛选下拉可用的标签列表：默认「赠品」+ 当前启用的自定义标签 + 历史单据出现过但后来删除的标签。
 */
function getFilterableGiftLabels(db) {
  const seen = new Set([DEFAULT_GIFT_LABEL]);
  const result = [DEFAULT_GIFT_LABEL];
  for (const label of getCustomGiftLabels(db)) {
    if (!seen.has(label.name)) {
      seen.add(label.name);
      result.push(label.name);
    }
  }
  const historical = db.prepare(`
    SELECT DISTINCT gift_label AS name
    FROM sales_order_items
    WHERE is_gift = 1 AND gift_label <> ''
    ORDER BY name ASC
  `).all();
  for (const row of historical) {
    if (row.name && !seen.has(row.name)) {
      seen.add(row.name);
      result.push(row.name);
    }
  }
  return result;
}

function validateGiftLabel(db, rawName) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return { error: '标签名称不能为空' };
  if (Array.from(name).length > 20) return { error: '标签名称不能超过 20 字' };
  if (/[,，、]/u.test(name)) return { error: '标签名称不能包含逗号或顿号' };
  if (name === DEFAULT_GIFT_LABEL) return { error: '「赠品」为系统默认标签，无需重复添加' };
  if (name === ALL_GIFTS_FILTER) return { error: '标签名称无效，请更换其他名称' };
  if (getCustomGiftLabels(db).some(label => label.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return { error: '该标签已存在，不能重复添加' };
  }
  return { name };
}

function itemGiftLabel(item) {
  if (!item || !item.is_gift) return '';
  return item.gift_label || DEFAULT_GIFT_LABEL;
}

function parseGiftFilter(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

module.exports = {
  DEFAULT_GIFT_LABEL,
  ALL_GIFTS_FILTER,
  MAX_GIFT_LABELS,
  getCustomGiftLabels,
  getGiftLabelOptions,
  getFilterableGiftLabels,
  validateGiftLabel,
  itemGiftLabel,
  parseGiftFilter
};
