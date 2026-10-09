// 负责人独立于录入人；兼容旧客户端时，未提交负责人沿用订单负责人或当前录入人。
function responsibleUsers(db, currentId = null) {
  return db.prepare('SELECT id, name, username, active FROM users WHERE active = 1 OR id = ? ORDER BY active DESC, name, id')
    .all(currentId || -1);
}

function resolveResponsible(db, value, fallbackId) {
  const id = value === undefined || value === null || value === '' ? fallbackId : Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) return { error: '请选择有效的负责人' };
  const person = db.prepare('SELECT id, name, active FROM users WHERE id = ?').get(id);
  if (!person || (!person.active && id !== fallbackId)) return { error: '所选负责人不存在或已停用，请选择启用的账号' };
  return { id: person.id, name: person.name };
}

module.exports = { responsibleUsers, resolveResponsible };
