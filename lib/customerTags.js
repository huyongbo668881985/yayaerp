const TAG_COLORS = [
  { value: 'blue', name: '蓝色' },
  { value: 'green', name: '绿色' },
  { value: 'orange', name: '橙色' },
  { value: 'red', name: '红色' },
  { value: 'purple', name: '紫色' },
  { value: 'cyan', name: '青色' },
  { value: 'pink', name: '粉色' },
  { value: 'gray', name: '灰色' }
];
const MAX_TAGS = 50;

function parseTagId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function getCustomerTags(db) {
  return db.prepare('SELECT id, name, color FROM customer_tags ORDER BY id').all();
}

function validateTag(db, rawName, color, excludeId = null) {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name) return { error: '标签名称不能为空' };
  if (Array.from(name).length > 20) return { error: '标签名称不能超过 20 字' };
  if (/[,，、]/u.test(name)) return { error: '标签名称不能包含逗号或顿号' };
  if (!TAG_COLORS.some(option => option.value === color)) return { error: '请选择预设的标签颜色' };
  // SQLite NOCASE 保证常用大小写唯一；这里也覆盖非 ASCII 字符的大小写。
  if (getCustomerTags(db).some(tag => tag.id !== excludeId && tag.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return { error: '标签名称已存在，不能重复使用' };
  }
  return { name, color };
}

function validTagIds(db, rawIds) {
  const supplied = Array.isArray(rawIds) ? rawIds : [rawIds];
  const requested = new Set(supplied.map(parseTagId).filter(id => id !== null));
  return getCustomerTags(db).filter(tag => requested.has(tag.id)).map(tag => tag.id);
}

// 调用方将客户资料更新与标签整体替换放在同一个事务中。
function replaceCustomerTags(db, customerId, rawIds) {
  const ids = validTagIds(db, rawIds);
  db.prepare('DELETE FROM customer_tag_links WHERE customer_id = ?').run(customerId);
  const insert = db.prepare('INSERT INTO customer_tag_links (customer_id, tag_id) VALUES (?, ?)');
  for (const id of ids) insert.run(customerId, id);
}

function attachCustomerTags(db, customers) {
  const byId = new Map(customers.map(customer => [customer.id, customer]));
  for (const customer of customers) customer.tags = [];
  if (!customers.length) return customers;
  // 一次批量查询、在内存映射；不按客户逐个查库，也不增加客户列表行数。
  const links = db.prepare(`SELECT l.customer_id, t.id, t.name, t.color
    FROM customer_tag_links l JOIN customer_tags t ON t.id = l.tag_id
    WHERE l.customer_id IN (SELECT value FROM json_each(?)) ORDER BY t.id`)
    .all(JSON.stringify(customers.map(customer => customer.id)));
  for (const link of links) {
    const customer = byId.get(link.customer_id);
    if (customer) customer.tags.push({ id: link.id, name: link.name, color: link.color });
  }
  return customers;
}

module.exports = { TAG_COLORS, MAX_TAGS, parseTagId, getCustomerTags, validateTag, replaceCustomerTags, validTagIds, attachCustomerTags };
