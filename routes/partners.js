const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const router = express.Router();

// 客户名称是业务识别键：同一租户内不允许重名，也不接受任何空白字符。
// 必须由服务端校验，不能只依赖页面的 required/pattern，否则接口调用能绕过限制。
function validateCustomerName(db, rawName, excludeCustomerId = null) {
  const suppliedName = typeof rawName === 'string' ? rawName : '';
  const name = suppliedName.trim();
  if (!name) return { error: '客户名称必填' };
  if (/\s/u.test(suppliedName)) return { error: '客户名称不能包含空格' };

  const duplicate = excludeCustomerId === null
    ? db.prepare('SELECT id FROM customers WHERE name = ?').get(name)
    : db.prepare('SELECT id FROM customers WHERE name = ? AND id != ?').get(name, excludeCustomerId);
  if (duplicate) return { error: '客户名称已存在，不能重复使用' };
  return { name };
}

// 供应商 - 仅管理员可管理（对应采购权限）
router.get('/suppliers', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY id DESC').all();
  res.render('suppliers', { suppliers });
});

router.post('/suppliers/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { name, contact, phone } = req.body;
  if (!name) return res.redirect('/suppliers');
  db.prepare('INSERT INTO suppliers (name, contact, phone) VALUES (?,?,?)').run(name, contact || '', phone || '');
  res.redirect('/suppliers');
});

router.post('/suppliers/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const refCount = db.prepare('SELECT COUNT(*) c FROM purchase_orders WHERE supplier_id = ?').get(req.params.id).c;
  if (refCount > 0) {
    return res.status(400).send(`无法删除：该供应商名下还有 ${refCount} 张采购单记录，请先处理相关单据`);
  }
  db.prepare('DELETE FROM suppliers WHERE id = ?').run(req.params.id);
  res.redirect('/suppliers');
});

// 客户 - 列表按角色过滤：管理员看全部客户，操作员只看自己名下的（operator_id = 自己）。
// 无归属人（operator_id 为 NULL）的客户是管理员维护的，操作员也看不到。
// 操作员新增的客户自动归到自己名下，录入销售单时从这个范围里选。
router.get('/customers', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const baseSql = `
    SELECT c.*, u.name AS operator_name
    FROM customers c
    LEFT JOIN users u ON u.id = c.operator_id
  `;
  const scopeClause = user.role === 'admin' ? '' : ' WHERE c.operator_id = ?';
  const scopeParams = user.role === 'admin' ? [] : [user.id];
  const searchClause = query
    ? `${scopeClause ? ' AND' : ' WHERE'} (c.name LIKE ? OR c.contact LIKE ? OR c.phone LIKE ? OR c.address LIKE ?)`
    : '';
  const searchParams = query ? Array(4).fill(`%${query}%`) : [];
  const customers = db.prepare(baseSql + scopeClause + searchClause + ' ORDER BY c.id DESC')
    .all(...scopeParams, ...searchParams);
  const totalCustomerCount = db.prepare(`SELECT COUNT(*) AS count FROM customers c${scopeClause}`)
    .get(...scopeParams).count;
  const users = db.prepare('SELECT id, name, role FROM users ORDER BY name').all();
  res.render('customers', {
    customers, users, isAdmin: user.role === 'admin', query,
    totalCustomerCount, displayedCustomerCount: customers.length,
    error: typeof req.query.error === 'string' ? req.query.error : null
  });
});

router.post('/customers/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { contact, phone, address } = req.body;
  const nameCheck = validateCustomerName(db, req.body.name);
  if (nameCheck.error) return res.redirect('/customers?error=' + encodeURIComponent(nameCheck.error));
  // 管理员可以指定归属业务员；操作员新增的客户默认归到自己名下
  const operatorId = req.session.user.role === 'admin'
    ? (req.body.operator_id || null)
    : req.session.user.id;
  db.prepare('INSERT INTO customers (name, contact, phone, address, operator_id) VALUES (?,?,?,?,?)')
    .run(nameCheck.name, contact || '', phone || '', address || '', operatorId);
  res.redirect('/customers');
});

// 操作员只能编辑自己名下的客户（operator_id = 自己）；
// 无归属人（operator_id 为 NULL，一般是管理员建的老客户）也归管理员管。
// 之前操作员能改任意客户，存在误改/串改他人客户资料的风险。
function canEditCustomer(customer, sessionUser) {
  return sessionUser.role === 'admin' || customer.operator_id === sessionUser.id;
}

router.get('/customers/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).send('客户不存在');
  if (!canEditCustomer(customer, req.session.user)) {
    return res.status(403).send('只能编辑自己名下的客户，如需修改请联系管理员');
  }
  const users = db.prepare('SELECT id, name, role FROM users ORDER BY name').all();
  res.render('customer_form', { customer, users, error: null, isAdmin: req.session.user.role === 'admin' });
});

router.post('/customers/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).send('客户不存在');
  if (!canEditCustomer(customer, req.session.user)) {
    return res.status(403).send('只能编辑自己名下的客户，如需修改请联系管理员');
  }
  const { contact, phone, address } = req.body;
  const nameCheck = validateCustomerName(db, req.body.name, customer.id);
  if (nameCheck.error) {
    const users = db.prepare('SELECT id, name, role FROM users ORDER BY name').all();
    return res.render('customer_form', { customer, users, error: nameCheck.error, isAdmin: req.session.user.role === 'admin' });
  }
  if (req.session.user.role === 'admin') {
    // 管理员可以改归属业务员
    db.prepare('UPDATE customers SET name=?, contact=?, phone=?, address=?, operator_id=? WHERE id=?')
      .run(nameCheck.name, contact || '', phone || '', address || '', req.body.operator_id || null, req.params.id);
  } else {
    // 操作员编辑不改归属人，避免误操作把客户转给别人
    db.prepare('UPDATE customers SET name=?, contact=?, phone=?, address=? WHERE id=?')
      .run(nameCheck.name, contact || '', phone || '', address || '', req.params.id);
  }
  res.redirect('/customers');
});

// 批量转移客户归属（人员变动时用，比如某业务员离职，把他名下客户一次性转给接手的人）
router.post('/customers/reassign', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { from_user_id, to_user_id } = req.body;
  if (!from_user_id || !to_user_id) return res.redirect('/customers');
  if (from_user_id === to_user_id) return res.redirect('/customers');
  db.prepare('UPDATE customers SET operator_id = ? WHERE operator_id = ?').run(to_user_id, from_user_id);
  res.redirect('/customers');
});

router.post('/customers/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  // 引用检查要同时覆盖销售单和退货单（return_orders.customer_id 也有外键），
  // 只查销售单的话，有退货记录的客户会走到外键约束报错，用户看到的是难懂的 500 页
  const salesCount = db.prepare('SELECT COUNT(*) c FROM sales_orders WHERE customer_id = ?').get(req.params.id).c;
  const returnCount = db.prepare('SELECT COUNT(*) c FROM return_orders WHERE customer_id = ?').get(req.params.id).c;
  const refCount = salesCount + returnCount;
  if (refCount > 0) {
    const detail = [
      salesCount > 0 ? `${salesCount} 张销售单` : '',
      returnCount > 0 ? `${returnCount} 张退货单` : ''
    ].filter(Boolean).join('、');
    return res.status(400).send(`无法删除：该客户名下还有 ${detail} 记录，请先处理相关单据（或者不删，改个名字标记为停用）`);
  }
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  res.redirect('/customers');
});

module.exports = router;
