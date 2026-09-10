const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const { todayLocalDate } = require('../utils/dates');
const { isValidNonNegativeAmount } = require('../lib/validators');
const router = express.Router();

// 设计说明（2026-09-06 定版）：采购入库没有审核流，录单即加库存。
// 原因：整个采购模块本来就只有管理员能进（下面所有路由都挂 requireAdmin），
// "管理员录单→管理员审核"是自己审自己，纯增摩擦没有防错价值。
// 操作员的误操作风险已被角色权限挡住（操作员根本进不了采购）。
// purchase_orders.status 字段保留但暂不启用，将来若开放操作员录采购再启用审核流。

router.get('/purchases', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const orders = db.prepare(`
    SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, u.name AS user_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN warehouses w ON w.id = po.warehouse_id
    LEFT JOIN users u ON u.id = po.user_id
    ORDER BY po.id DESC
  `).all();
  res.render('purchases', { orders });
});

router.get('/purchases/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
  const products = db.prepare('SELECT * FROM products ORDER BY name').all();
  res.render('purchase_form', { suppliers, warehouses, products, error: null, today: todayLocalDate() });
});

router.post('/purchases/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { supplier_id, warehouse_id, order_date, note } = req.body;
  let { product_id, quantity, unit_price, unit_choice } = req.body;
  if (!Array.isArray(product_id)) product_id = [product_id];
  if (!Array.isArray(quantity)) quantity = [quantity];
  if (!Array.isArray(unit_price)) unit_price = [unit_price];
  if (!Array.isArray(unit_choice)) unit_choice = [unit_choice];

  const getProduct = db.prepare('SELECT * FROM products WHERE id = ?');
  const items = [];
  for (let i = 0; i < product_id.length; i++) {
    const pid = Number(product_id[i]);
    const qty = Number(quantity[i]);
    const price = Number(unit_price[i]);
    // 数量必须是正整数（与 sales.js 同规则）
    if (!pid || !(qty > 0) || !Number.isInteger(qty)) continue;
    const product = getProduct.get(pid);
    if (!product) continue;
    // unit_choice: 'pack' 表示按大单位（箱）录入，否则按基本单位（瓶）
    const usePack = unit_choice[i] === 'pack' && product.pack_unit;
    const unitLabel = usePack ? product.pack_unit : product.unit;
    const baseQty = usePack ? qty * product.pack_size : qty;
    items.push({
      pid, qty, price,
      invalidPrice: !isValidNonNegativeAmount(unit_price[i]),
      unitLabel, baseQty
    });
  }
  if (!warehouse_id || items.length === 0) {
    const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT * FROM products ORDER BY name').all();
    return res.render('purchase_form', { suppliers, warehouses, products, error: '请选择仓库并至少填写一行有效商品明细', today: todayLocalDate() });
  }
  if (items.some(it => it.invalidPrice || !Number.isFinite(it.price) || it.price < 0)) {
    const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT * FROM products ORDER BY name').all();
    return res.status(400).render('purchase_form', { suppliers, warehouses, products, error: '采购单价必须是大于等于 0 的有效数字', today: todayLocalDate() });
  }

  const total = items.reduce((s, it) => s + it.qty * it.price, 0);
  if (!Number.isFinite(total) || total < 0) {
    const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY name').all();
    const warehouses = db.prepare('SELECT * FROM warehouses ORDER BY name').all();
    const products = db.prepare('SELECT * FROM products ORDER BY name').all();
    return res.status(400).render('purchase_form', { suppliers, warehouses, products, error: '采购总额计算结果不合法，请检查商品数量和单价', today: todayLocalDate() });
  }

  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO purchase_orders (supplier_id, warehouse_id, user_id, order_date, total_amount, note, remarks)
       VALUES (?,?,?,?,?,?,?)`
    ).run(supplier_id || null, warehouse_id, req.session.user.id, order_date || todayLocalDate(), total, note || '', req.body.remarks || '');
    const poId = info.lastInsertRowid;

    const insertItem = db.prepare('INSERT INTO purchase_order_items (purchase_order_id, product_id, quantity, unit_label, base_quantity, unit_price) VALUES (?,?,?,?,?,?)');
    const upsertInv = db.prepare(`
      INSERT INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,?)
      ON CONFLICT(product_id, warehouse_id) DO UPDATE SET quantity = quantity + excluded.quantity
    `);
    const insertTxn = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'purchase_in','purchase_order',?,?)
    `);

    for (const it of items) {
      insertItem.run(poId, it.pid, it.qty, it.unitLabel, it.baseQty, it.price);
      upsertInv.run(it.pid, warehouse_id, it.baseQty);
      insertTxn.run(it.pid, warehouse_id, it.baseQty, poId, req.session.user.id);
    }
  });
  tx();

  res.redirect('/purchases');
});

router.get('/purchases/:id', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare(`
    SELECT po.*, s.name AS supplier_name, w.name AS warehouse_name, u.name AS user_name
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id
    LEFT JOIN warehouses w ON w.id = po.warehouse_id
    LEFT JOIN users u ON u.id = po.user_id
    WHERE po.id = ?
  `).get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  const items = db.prepare(`
    SELECT poi.*, p.name AS product_name
    FROM purchase_order_items poi
    JOIN products p ON p.id = poi.product_id
    WHERE poi.purchase_order_id = ?
  `).all(req.params.id);
  res.render('purchase_detail', { order, items });
});

router.post('/purchases/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const order = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('单据不存在');
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE purchase_order_id = ?').all(order.id);

  // 删除采购单要把当初入库加的库存扣回去；如果这批货已经被卖出/调走一部分，扣回去会变成负库存，先拦下来。
  // 校验按商品汇总后再比：同一商品拆多行时逐行检查都会通过（检查时还没扣），事务里才扣成负数。
  const needed = new Map(); // product_id -> 应扣总数量（基础单位）
  for (const it of items) {
    needed.set(it.product_id, (needed.get(it.product_id) || 0) + it.base_quantity);
  }

  // 来源检查（2026-09-08 补，修复"误扣退货库存"）：库存校验"当前库存 ≥ 采购量"有一个盲区——
  // 当前库存不等于这批采购的货还在，它可能来自完全不同的来源。实测复现的翻车链路：
  //   采购 100 → 卖光（库存 0）→ 客户退货 100（库存 100，但这批货是退回来的）→ 删采购单
  //   → "库存 100 ≥ 100"放行 → 扣 100 → 库存 0，而仓库里实物躺着 100 瓶。
  // 只要该商品在该仓库发生过"退货入库"或"调拨入库"，系统就无法区分当前库存里哪些属于这张
  // 采购单，删除必然有误扣风险，直接拒绝。删单本来就是高危低频操作，宁可保守。
  const hasReturnOrTransferIn = db.prepare(
    `SELECT st.product_id FROM stock_transactions st
     JOIN purchase_order_items poi ON poi.product_id = st.product_id
     WHERE poi.purchase_order_id = ? AND st.warehouse_id = ?
       AND st.type IN ('sale_return','transfer_in')
     LIMIT 1`
  ).get(order.id, order.warehouse_id);
  if (hasReturnOrTransferIn) {
    return res.status(400).send(
      '无法删除：这张采购单的商品在该仓库发生过"退货入库"或"调拨入库"，当前库存里混着这些来源的货，' +
      '删除会把退回来的货误当成这批采购扣掉，导致账面库存凭空减少（实物却在仓库里）。' +
      '如果采购单信息录错了，建议保留单据、在备注里说明，或先用"库存调整"把账面修正到与实物一致。'
    );
  }

  const getInv = db.prepare('SELECT quantity FROM inventory WHERE product_id=? AND warehouse_id=?');
  for (const [pid, totalQty] of needed) {
    const inv = getInv.get(pid, order.warehouse_id);
    const have = inv ? inv.quantity : 0;
    if (have < totalQty) {
      const p = db.prepare('SELECT name FROM products WHERE id=?').get(pid);
      return res.status(400).send(
        `无法删除：${p ? p.name : '商品'} 当前库存 ${have}，少于这张采购单入库的合计 ${totalQty}` +
        `（说明这批货已经被销售或调拨掉了一部分），删除会导致库存变成负数。请先处理相关的销售/调拨单再删除这张采购单。`
      );
    }
  }

  const tx = db.transaction(() => {
    const decInv = db.prepare('UPDATE inventory SET quantity = quantity - ? WHERE product_id=? AND warehouse_id=?');
    // type 用 adjust 而不是沿用 purchase_in：这笔流水 change_qty 是负数（把入库的扣回去），
    // 还标"采购入库"会出现"采购入库 -50"的矛盾记录；ref_type 仍可追溯到被删的采购单。
    const insertTxn = db.prepare(`
      INSERT INTO stock_transactions (product_id, warehouse_id, change_qty, type, ref_type, ref_id, user_id)
      VALUES (?,?,?,'adjust','purchase_order_delete',?,?)
    `);
    for (const it of items) {
      decInv.run(it.base_quantity, it.product_id, order.warehouse_id);
      insertTxn.run(it.product_id, order.warehouse_id, -it.base_quantity, order.id, req.session.user.id);
    }
    db.prepare('DELETE FROM purchase_order_items WHERE purchase_order_id = ?').run(order.id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(order.id);
  });
  tx();

  res.redirect('/purchases');
});

module.exports = router;
