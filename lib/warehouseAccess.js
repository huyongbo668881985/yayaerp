// 仓库（车辆）权限的唯一口径：管理员看全部；操作员只看被分配给自己的仓库。
// 不把“未分配”默认开放给操作员，避免启用隔离后旧总仓仍被所有人看见。
function warehousesForUser(db, user) {
  if (user.role === 'admin') {
    return db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  }
  return db.prepare('SELECT * FROM warehouses WHERE operator_id = ? ORDER BY name').all(user.id);
}

function isWarehouseInScope(db, user, warehouseId) {
  const id = Number(warehouseId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (user.role === 'admin') {
    return !!db.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(id);
  }
  return !!db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND operator_id = ?').get(id, user.id);
}

function areWarehousesInScope(db, user, warehouseIds) {
  return warehouseIds.every(id => isWarehouseInScope(db, user, id));
}

// 调拨是唯一的例外：操作员可以向“未分配的总库”申请调货，
// 但仍绝不能选择归属其他操作员的车辆。总库库存也不会因此出现在库存查询页。
function warehousesForTransfer(db, user) {
  if (user.role === 'admin') return warehousesForUser(db, user);
  return db.prepare('SELECT * FROM warehouses WHERE operator_id = ? OR operator_id IS NULL ORDER BY name').all(user.id);
}

function isWarehouseTransferable(db, user, warehouseId) {
  const id = Number(warehouseId);
  if (!Number.isInteger(id) || id <= 0) return false;
  if (user.role === 'admin') return !!db.prepare('SELECT 1 FROM warehouses WHERE id = ?').get(id);
  return !!db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND (operator_id = ? OR operator_id IS NULL)').get(id, user.id);
}

function areWarehousesTransferable(db, user, warehouseIds) {
  return warehouseIds.every(id => isWarehouseTransferable(db, user, id));
}

module.exports = {
  warehousesForUser, isWarehouseInScope, areWarehousesInScope,
  warehousesForTransfer, isWarehouseTransferable, areWarehousesTransferable
};
