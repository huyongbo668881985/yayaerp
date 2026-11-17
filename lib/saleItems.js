const { costSnapshotPerBaseUnit } = require('./priceCalc');
const { isValidNonNegativeAmount, roundToCents } = require('./validators');
const { DEFAULT_GIFT_LABEL, getGiftLabelOptions } = require('./giftLabels');

function buildItemsFromRequest(db, body, options = {}) {
  const { items_json } = body;
  let product_id, quantity, unit_price, unit_choice, is_gift, gift_label;
  if (items_json) {
    // 前端把明细序列化成 JSON 提交；解析失败（极端情况下字段被篡改/截断）时按"没有明细"处理，
    // 让上层走"至少填写一行有效明细"的正常报错，而不是抛 SyntaxError 变成 500 兑底页。
    let parsed;
    try {
      parsed = JSON.parse(items_json);
    } catch (e) {
      parsed = [];
    }
    if (!Array.isArray(parsed)) parsed = [];
    product_id = parsed.map(i => i.id);
    quantity = parsed.map(i => i.quantity);
    unit_price = parsed.map(i => i.price);
    unit_choice = parsed.map(i => i.unit_choice || 'base');
    is_gift = parsed.map(i => (i.is_gift ? '1' : '0'));
    gift_label = parsed.map(i => (typeof i.gift_label === 'string' ? i.gift_label : ''));
  } else {
    product_id = body.product_id;
    quantity = body.quantity;
    unit_price = body.unit_price;
    unit_choice = body.unit_choice;
    is_gift = body.is_gift;
    gift_label = body.gift_label;
  }
  if (!Array.isArray(product_id)) product_id = [product_id];
  if (!Array.isArray(quantity)) quantity = [quantity];
  if (!Array.isArray(unit_price)) unit_price = [unit_price];
  if (!Array.isArray(unit_choice)) unit_choice = [unit_choice];
  if (!Array.isArray(is_gift)) is_gift = [is_gift];
  if (!Array.isArray(gift_label)) gift_label = [gift_label];

  const allowedGiftLabels = new Set(getGiftLabelOptions(db));
  if (options.extraGiftLabels) {
    for (const label of options.extraGiftLabels) {
      if (label) allowedGiftLabels.add(label);
    }
  }

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const items = [];
  let invalidDetailCount = 0;
  let invalidGiftLabelCount = 0;
  for (let i = 0; i < product_id.length; i++) {
    const pid = Number(product_id[i]);
    const qty = Number(quantity[i]);
    let price = Number(unit_price[i]);
    const gift = is_gift[i] === '1' || is_gift[i] === true;
    const rawGiftLabel = typeof gift_label[i] === 'string' ? gift_label[i].trim() : '';
    const giftLabel = gift ? (rawGiftLabel || DEFAULT_GIFT_LABEL) : '';
    // 数量必须是正整数：瓶/箱都不存在"半瓶"的录入场景，小数会让库存和金额统计出碎片（四处单据同规则）
    if (!pid || !(qty > 0) || !Number.isInteger(qty)) { invalidDetailCount++; continue; }
    const product = getProduct.get(pid);
    if (!product) { invalidDetailCount++; continue; }
    if (gift && !allowedGiftLabels.has(giftLabel)) { invalidGiftLabelCount++; continue; }
    const invalidPrice = !gift && !isValidNonNegativeAmount(unit_price[i]);
    if (gift) price = 0;
    else if (Number.isFinite(price)) price = roundToCents(price);
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    // 成本快照：记下开单那一刻的成本价，之后改商品成本价不影响这张单的历史毛利。
    // 按箱录入且配了箱成本价时用 箱成本价÷箱规（共用 lib/priceCalc.js，与 returns.js 同一份实现），
    // 否则按箱开单会踩回"瓶价由箱价反算"的舍入误差，毛利系统性偏低。
    const costSnapshot = costSnapshotPerBaseUnit(product, unit_choice[i]);
    items.push({ pid, qty, price, invalidPrice, unitLabel, baseQty, costSnapshot, productName: product.name, gift, giftLabel, saleVisible: product.sale_visible !== 0 });
  }
  items.invalidDetailCount = invalidDetailCount;
  items.invalidGiftLabelCount = invalidGiftLabelCount;
  return items;
}

module.exports = { buildItemsFromRequest };
