const { submittedItemsFromBody } = require('./formDraft');
const PRODUCT_FIELDS = 'id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack';

function productsForForm(db, source = []) {
  const items = Array.isArray(source) ? source : submittedItemsFromBody(source);
  const ids = [...new Set(items.map(item => Number(item.id || item.product_id)).filter(id => Number.isSafeInteger(id) && id > 0))];
  const initial = db.prepare(`SELECT ${PRODUCT_FIELDS} FROM products ORDER BY name, id LIMIT 50`).all();
  const get = db.prepare(`SELECT ${PRODUCT_FIELDS} FROM products WHERE id=?`);
  for (const id of ids) if (!initial.some(product => product.id === id)) {
    const product = get.get(id); if (product) initial.push(product);
  }
  return initial;
}

function pagination(count, rawPage, size = 50) {
  const totalPages = Math.max(1, Math.ceil(count / size));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(Number(rawPage)) || 1));
  return { page, totalPages, count, size, offset: (page - 1) * size };
}
module.exports = { PRODUCT_FIELDS, productsForForm, pagination };
