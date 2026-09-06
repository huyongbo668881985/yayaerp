const express = require('express');
const { requireLogin } = require('../middleware/auth');
const router = express.Router();

// 状态机与销售单一致：draft -> submitted -> approved/rejected，submitted<->draft 撤回，approved/rejected -> submitted 反审核
// 库存调拨也是在"审核通过"时才真正执行扣减/加回，草稿和待审核阶段不动库存。

function canEditOrWithdraw(order, sessionUser) {
  return sessionUser.role === 'admin' || order.user_id === sessionUser.id;
}

function buildItemsFromRequest(db, body) {
  let { product_id, quantity, unit_choice } = body;
  if (!Array.isArray(product_id)) product_id = [product_id];
  if (!Array.isArray(quantity)) quantity = [quantity];
  if (!Array.isArray(unit_choice)) unit_choice = [unit_choice];

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const items = [];
  for (let i = 0; i < product_id.length; i++) {
    const pid = Number(product_id[i]);
    const qty = Number(quantity[i]);
    if (!pid || !(qty > 0)) continue;
    const product = getProduct.get(pid);
    if (!product) continue;
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    items.push({ pid, qty, unitLabel, baseQty, productName: product.name });
  }
  return items;
}

router.get('/transfers', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const user = req.session.user;
  let sql = `
    SELECT t.*, wf.name AS from_name, wt.name AS to_name, u.name AS user_name
    FROM transfer_orders t
    JOIN warehouses wf ON wf.id = t.from_warehouse_id
    JOIN warehouses wt ON wt.id = t.to_warehouse_id
    LEFT JOIN users u ON u.id = t.user_id
  `;
  const params = [];
  if (user.role !== 'admin') {
    sql += ' WHERE t.user_id = ?';
    params.push(user.id);
  }
  sql += ' ORDER BY t.id DESC';
  const orders = db.prepare(sql).all(...params);
  res.render('transfers', { orders, user });
});

router.get('/transfers/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  res.render('transfer_form', { warehouses, products, error: null, order: null, existingItems: [] });
});

router.post('/transfers/new', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const { from_warehouse_id, to_warehouse_id, order_date, note } = req.body;

  const renderError = (msg) => {
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT * FROM products ORDER BY name').all();
    return res.render('transfer_form', { warehouses, products, error: msg, order: null, existingItems: [] });
  };

  if (!from_warehouse_id || !to_warehouse_id) return renderError('请选择调出仓库和调入仓库');
  if (from_warehouse_id === to_warehouse_id) return renderError('调出仓库和调入仓库不能是同一个');

  const items = buildItemsFromRequest(db, req.body);
  if (items.length === 0) return renderError('请至少填写一行有效商品明细');

  // 草稿/待审核阶段不动库存
  // 点"存草稿"按钮会带 save_draft=1 → 存为 draft，之后在详情页继续编辑/提交审核
  const status = (req.body.save_draft === '1' || req.body.save_draft === 'on') ? 'draft' : 'submitted';
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO transfer_orders (from_warehouse_id, to_warehouse_id, user_id, order_date, note, status)
       VALUES (?,?,?,?,?,?)`
    ).run(from_warehouse_id, to_warehouse_id, req.session.user.id, order_date || new Date().toISOString().slice(0,10), note || '', status);
    const toId = info.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO transfer_order_items (transfer_order_id, product_id, quantity, unit_label, base_quantity) VALUES (?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(toId, it.pid, it.qty, it.unitLabel, it.baseQty);
    }
  });
  tx();

  res.redirect('/transfers');
});

// 编辑草稿单
router.get('/transfers/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM transfer_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的调拨单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的调拨单');

  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  const existingItems = db.prepare('SELECT * FROM transfer_order_items WHERE transfer_order_id = ?').all(order.id);
  res.render('transfer_form', { warehouses, products, error: null, order, existingItems });
});

router.post('/transfers/:id/edit', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM transfer_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态的调拨单可以编辑，请先撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限编辑他人的调拨单');

  const { from_warehouse_id, to_warehouse_id, order_date, note } = req.body;

  const renderError = (msg) => {
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT * FROM products ORDER BY name').all();
    const existingItems = db.prepare('SELECT * FROM transfer_order_items WHERE transfer_order_id = ?').all(order.id);
    return res.render('transfer_form', { warehouses, products, error: msg, order, existingItems });
  };

  if (!from_warehouse_id || !to_warehouse_id) return renderError('请选择调出仓库和调入仓库');
  if (from_warehouse_id === to_warehouse_id) return renderError('调出仓库和调入仓库不能是同一个');

  const items = buildItemsFromRequest(db, req.body);
  if (items.length === 0) return renderError('请至少填写一行有效商品明细');

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE transfer_orders SET from_warehouse_id=?, to_warehouse_id=?, order_date=?, note=? WHERE id=?`
    ).run(from_warehouse_id, to_warehouse_id, order_date || order.order_date, note || '', order.id);
    db.prepare('DELETE FROM transfer_order_items WHERE transfer_order_id = ?').run(order.id);
    const insertItem = db.prepare('INSERT INTO transfer_order_items (transfer_order_id, product_id, quantity, unit_label, base_quantity) VALUES (?,?,?,?,?)');
    for (const it of items) {
      insertItem.run(order.id, it.pid, it.qty, it.unitLabel, it.baseQty);
    }
  });
  tx();

  res.redirect('/transfers/' + order.id);
});

// 提交审核：draft -> submitted
router.post('/transfers/submit/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM transfer_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'draft') return res.status(400).send('只有草稿状态可以提交审核');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限');
  db.prepare("UPDATE transfer_orders SET status = 'submitted' WHERE id = ?").run(order.id);
  res.redirect('/transfers/' + order.id);
});

// 撤回：submitted -> draft
router.post('/transfers/withdraw/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM transfer_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以撤回');
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限撤回他人的调拨单');
  db.prepare("UPDATE transfer_orders SET status = 'draft' WHERE id = ?").run(order.id);
  res.redirect('/transfers/' + order.id);
});

// 审核通过：submitted -> approved（这里才真正执行库存调拨，先重新校验调出仓库库存是否充足）
router.post('/transfers/approve/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM transfer_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以审核通过');

  const items = db.prepare('SELECT * FROM transfer_order_items WHERE transfer_order_id = ?').all(order.id);
  const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
  for (const it of items) {
    const inv = getInv.get(it.product_id, order.from_warehouse_id);
    const have = inv ? inv.quantity : 0;
    if (have < it.base_quantity) {
      const p = db.prepare('SELECT name FROM products WHERE id=?').get(it.product_id);
      return res.status(400).send(`审核失败：${p ? p.name : '商品'} 调出仓库当前库存 ${have}，不足以调出 ${it.base_quantity}`);
    }
  }

  const tx = db.transaction(() => {
    const decInv = db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id=? AND warehouse_id=?');
    const upsertInv = db.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
      ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `);
    const insertTxnOut = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'transfer_out','transfer_order',?,?)
    `);
    const insertTxnIn = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'transfer_in','transfer_order',?,?)
    `);
    for (const it of items) {
      decInv.run(it.base_quantity, it.product_id, order.from_warehouse_id);
      upsertInv.run(it.product_id, order.to_warehouse_id, it.base_quantity);
      insertTxnOut.run(it.product_id, order.from_warehouse_id, -it.base_quantity, order.id, req.session.user.id);
      insertTxnIn.run(it.product_id, order.to_warehouse_id, it.base_quantity, order.id, req.session.user.id);
    }
    db.prepare("UPDATE transfer_orders SET status = 'approved' WHERE id = ?").run(order.id);
  });
  tx();

  res.redirect('/transfers/' + order.id);
});

// 审核拒绝：submitted -> rejected
router.post('/transfers/reject/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM transfer_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'submitted') return res.status(400).send('只有待审核状态可以拒绝');
  db.prepare("UPDATE transfer_orders SET status = 'rejected' WHERE id = ?").run(order.id);
  res.redirect('/transfers/' + order.id);
});

// 反审核：approved/rejected -> submitted（approved 需要把调拨的库存退回去）
router.post('/transfers/unapprove/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  if (req.session.user.role !== 'admin') return res.status(403).send('无权限');
  const order = db.prepare('SELECT * FROM transfer_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  if (order.status !== 'approved' && order.status !== 'rejected') {
    return res.status(400).send('只有已审核或已拒绝状态可以反审核');
  }

  // 已审核的单子要把库存退回去；退之前先确认调入仓库还有没有这么多货
  // （如果这批货已经在调入仓库被卖掉/再调走了一部分，硬退会把库存拉成负数）
  const items = order.status === 'approved'
    ? db.prepare('SELECT * FROM transfer_order_items WHERE transfer_order_id = ?').all(order.id)
    : [];
  if (order.status === 'approved') {
    const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
    for (const it of items) {
      const inv = getInv.get(it.product_id, order.to_warehouse_id);
      const have = inv ? inv.quantity : 0;
      if (have < it.base_quantity) {
        const p = db.prepare('SELECT name FROM products WHERE id=?').get(it.product_id);
        return res.status(400).send(
          `反审核失败：${p ? p.name : '商品'} 在调入仓库当前库存 ${have}，不足以退回 ${it.base_quantity}` +
          `（说明这批货已经被销售或再次调走了一部分），请先处理相关的销售/调拨单再反审核这张调拨单。`
        );
      }
    }
  }

  const tx = db.transaction(() => {
    if (order.status === 'approved') {
      const upsertInv = db.prepare(`
        INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
        ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = quantity + excluded.quantity
      `);
      const decInv = db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id=? AND warehouse_id=?');
      const insertTxnOut = db.prepare(`
        INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
        VALUES (?,?,?,'transfer_out','transfer_order_unapprove',?,?)
      `);
      const insertTxnIn = db.prepare(`
        INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
        VALUES (?,?,?,'transfer_in','transfer_order_unapprove',?,?)
      `);
      for (const it of items) {
        // 把之前"调出仓库减、调入仓库加"的动作原样反过来
        upsertInv.run(it.product_id, order.from_warehouse_id, it.base_quantity);
        decInv.run(it.base_quantity, it.product_id, order.to_warehouse_id);
        insertTxnIn.run(it.product_id, order.from_warehouse_id, it.base_quantity, order.id, req.session.user.id);
        insertTxnOut.run(it.product_id, order.to_warehouse_id, -it.base_quantity, order.id, req.session.user.id);
      }
    }
    db.prepare("UPDATE transfer_orders SET status = 'submitted' WHERE id = ?").run(order.id);
  });
  tx();

  res.redirect('/transfers/' + order.id);
});

router.get('/transfers/:id', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare(`
    SELECT t.*, wf.name AS from_name, wt.name AS to_name, u.name AS user_name
    FROM transfer_orders t
    JOIN warehouses wf ON wf.id = t.from_warehouse_id
    JOIN warehouses wt ON wt.id = t.to_warehouse_id
    LEFT JOIN users u ON u.id = t.user_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  // 与列表页口径保持一致：操作员只能看自己录入的调拨单（列表里有 t.user_id = ? 过滤）
  if (!canEditOrWithdraw(order, req.session.user)) return res.status(403).send('无权限查看他人的调拨单');
  const items = db.prepare(`
    SELECT ti.*, p.name AS product_name
    FROM transfer_order_items ti
    JOIN products p ON p.id = ti.product_id
    WHERE ti.transfer_order_id = ?
  `).all(req.params.id);
  res.render('transfer_detail', { order, items, canManage: canEditOrWithdraw(order, req.session.user) });
});

module.exports = router;
