// 校验失败时把用户刚录入的明细带回表单。这里仅用于回显，业务校验仍由各路由负责。
function submittedItemsFromBody(body) {
  if (body.items_json) {
    try {
      const items = JSON.parse(body.items_json);
      if (Array.isArray(items)) return items;
    } catch (_) { /* 由路由给出明细错误提示 */ }
    return [];
  }

  const fields = ['product_id', 'quantity', 'unit_price', 'unit_choice'];
  const values = Object.fromEntries(fields.map(key => [key, Array.isArray(body[key]) ? body[key] : [body[key]]]));
  return values.product_id.map((id, index) => ({
    id,
    quantity: values.quantity[index] ?? '',
    price: values.unit_price[index] ?? '',
    unit_choice: values.unit_choice[index] || 'base'
  }));
}

module.exports = { submittedItemsFromBody };
