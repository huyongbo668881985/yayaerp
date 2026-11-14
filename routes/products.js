const express = require('express');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { isBlank, isValidNonNegativeAmount, roundToCents } = require('../lib/validators');
const { pagination } = require('../lib/catalog');
const { writeAuditLog } = require('../lib/auditLog');
const router = express.Router();

const OPERATOR_PRODUCT_FIELDS = 'id, sku, name, spec, unit, pack_unit, pack_size, sale_price, sale_price_pack, low_stock_threshold, sale_visible';

function buildProductsRedirect({ q = '', visibility = 'all', page = '' } = {}) {
  const params = new URLSearchParams({ saved: '1' });
  if (q) params.set('q', q);
  if (visibility && visibility !== 'all') params.set('visibility', visibility);
  if (page && Number(page) > 1) params.set('page', String(page));
  return '/products?' + params.toString();
}

function parseSaleVisible(body, defaultValue = 1) {
  const raw = body.sale_visible;
  if (Array.isArray(raw)) return raw.includes('1') ? 1 : 0;
  if (raw === '0' || raw === 0 || raw === false) return 0;
  if (raw === '1' || raw === 1 || raw === true) return 1;
  if (body.sale_visible_present === '1') return 0;
  return defaultValue;
}

router.get('/products', requireLogin, (req, res) => {
  const db = req.tenantDb;
  const isAdmin = req.session.user.role === 'admin';
  const query = String(req.query.q || '').trim().slice(0, 100);
  const visibility = ['all', 'visible', 'hidden'].includes(req.query.visibility) ? req.query.visibility : 'all';
  const conditions = [];
  const params = [];
  if (query) {
    conditions.push('(name LIKE ? OR sku LIKE ? OR spec LIKE ?)');
    params.push(...Array(3).fill('%' + query + '%'));
  }
  if (visibility === 'visible') conditions.push('sale_visible = 1');
  else if (visibility === 'hidden') conditions.push('sale_visible = 0');
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const paging = pagination(db.prepare('SELECT COUNT(*) n FROM products' + where).get(...params).n, req.query.page);
  const fields = isAdmin ? '*' : OPERATOR_PRODUCT_FIELDS;
  const products = db.prepare(`SELECT ${fields} FROM products${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, paging.size, paging.offset);
  res.render('products', {
    products,
    query,
    visibility,
    paging,
    pageLink: page => '/products?' + new URLSearchParams({ q: query, visibility, page }),
    success: req.query.saved === '1',
    isAdmin
  });
});

router.get('/products/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  res.render('product_form', { product: null, error: null });
});

// 换算比例（pack_size）必须是正整数：负数会让 base_quantity 变负（采购"入库"实际减库存、
// 销售出库实际加库存），小数会算出小数库存。留空默认 1（没有大单位）。
function parsePackSize(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { value: 1 };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { error: '换算比例（1个大单位 = 几个基本单位）必须是大于 0 的整数' };
  }
  return { value: n };
}

function parseProductNumbers(body) {
  const fields = [
    ['cost_price', '成本价', false],
    ['sale_price', '销售价', false],
    ['cost_price_pack', '箱成本价', true],
    ['sale_price_pack', '箱销售价', true],
    ['low_stock_threshold', '库存预警值', false]
  ];
  const values = {};
  for (const [key, label, nullable] of fields) {
    const raw = body[key];
    if (isBlank(raw)) {
      values[key] = nullable ? null : 0;
      continue;
    }
    if (!isValidNonNegativeAmount(raw)) {
      return { error: `${label}必须是大于等于 0 的有效数字` };
    }
    values[key] = key === 'low_stock_threshold' ? Number(raw) : roundToCents(raw);
  }
  if (!Number.isInteger(values.low_stock_threshold)) {
    return { error: '库存预警值必须是大于等于 0 的整数' };
  }
  return { values };
}

router.post('/products/new', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const { sku, name, spec, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack, low_stock_threshold } = req.body;
  const saleVisible = parseSaleVisible(req.body, 1);
  const formProduct = { ...req.body, sale_visible: saleVisible };
  if (!name) return res.render('product_form', { product: formProduct, error: '商品名称必填' });
  const pack = parsePackSize(pack_size);
  if (pack.error) return res.render('product_form', { product: formProduct, error: pack.error });
  const numbers = parseProductNumbers(req.body);
  if (numbers.error) return res.status(400).render('product_form', { product: formProduct, error: numbers.error });
  try {
    db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO products (sku, name, spec, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack, low_stock_threshold, sale_visible)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        sku || null, name, spec || '', unit || '瓶',
        pack_unit || null, pack.value,
        numbers.values.cost_price, numbers.values.sale_price,
        numbers.values.cost_price_pack, numbers.values.sale_price_pack,
        numbers.values.low_stock_threshold,
        saleVisible
      );
      // 为所有已存在的仓库建立库存行（初始为0）
      const warehouses = db.prepare('SELECT id FROM warehouses').all();
      const insertInv = db.prepare('INSERT OR IGNORE INTO inventory (product_id, warehouse_id, quantity) VALUES (?,?,0)');
      for (const w of warehouses) insertInv.run(info.lastInsertRowid, w.id);
      writeAuditLog(db, req.session.user, '新增商品', '商品', info.lastInsertRowid,
        `新增商品【${name}】，售价 ¥${numbers.values.sale_price.toFixed(2)}，成本价 ¥${numbers.values.cost_price.toFixed(2)}`, {
          sku: sku || null, name, spec: spec || '', unit: unit || '瓶',
          pack_unit: pack_unit || null, pack_size: pack.value,
          sale_visible: saleVisible,
          ...numbers.values
        }
      );
    }).immediate();
    res.redirect('/products?saved=1');
  } catch (e) {
    res.render('product_form', { product: formProduct, error: 'SKU 已存在或数据有误，请核对后重试。' });
  }
});

router.get('/products/:id/edit', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).send('商品不存在');
  res.render('product_form', { product, error: null });
});

router.post('/products/:id/edit', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).render('global_error', { message: '商品不存在', returnTo: '/products' });
  const saleVisible = parseSaleVisible(req.body, existing.sale_visible !== 0 ? 1 : 0);
  const formProduct = { ...req.body, id: existing.id, sale_visible: saleVisible };
  const { sku, name, spec, unit, pack_unit, pack_size, cost_price, sale_price, cost_price_pack, sale_price_pack, low_stock_threshold } = req.body;
  // 与"新建商品"保持一致：名称必填、换算比例正整数、SKU 撞车等约束错误渲染表单提示，而不是抛到全局 500 错误页
  if (!name) return res.render('product_form', { product: formProduct, error: '商品名称必填' });
  const pack = parsePackSize(pack_size);
  if (pack.error) return res.render('product_form', { product: formProduct, error: pack.error });
  const numbers = parseProductNumbers(req.body);
  if (numbers.error) return res.status(400).render('product_form', { product: formProduct, error: numbers.error });
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE products SET sku=?, name=?, spec=?, unit=?, pack_unit=?, pack_size=?, cost_price=?, sale_price=?, cost_price_pack=?, sale_price_pack=?, low_stock_threshold=?, sale_visible=? WHERE id=?`
      ).run(
        sku || null, name, spec || '', unit || '瓶',
        pack_unit || null, pack.value,
        numbers.values.cost_price, numbers.values.sale_price,
        numbers.values.cost_price_pack, numbers.values.sale_price_pack,
        numbers.values.low_stock_threshold,
        saleVisible,
        req.params.id
      );

      const changes = [];
      if (existing.name !== name) changes.push(`名称: ${existing.name} → ${name}`);
      if (existing.sale_price !== numbers.values.sale_price) changes.push(`售价: ¥${existing.sale_price.toFixed(2)} → ¥${numbers.values.sale_price.toFixed(2)}`);
      if (existing.cost_price !== numbers.values.cost_price) changes.push(`成本价: ¥${existing.cost_price.toFixed(2)} → ¥${numbers.values.cost_price.toFixed(2)}`);
      if (existing.sale_price_pack !== numbers.values.sale_price_pack) {
        changes.push(`箱售价: ${existing.sale_price_pack != null ? '¥' + existing.sale_price_pack.toFixed(2) : '无'} → ${numbers.values.sale_price_pack != null ? '¥' + numbers.values.sale_price_pack.toFixed(2) : '无'}`);
      }
      if (existing.cost_price_pack !== numbers.values.cost_price_pack) {
        changes.push(`箱成本价: ${existing.cost_price_pack != null ? '¥' + existing.cost_price_pack.toFixed(2) : '无'} → ${numbers.values.cost_price_pack != null ? '¥' + numbers.values.cost_price_pack.toFixed(2) : '无'}`);
      }
      if (existing.pack_size !== pack.value || (existing.pack_unit || '') !== (pack_unit || '')) {
        changes.push(`换算规格: 1${existing.pack_unit || '箱'}=${existing.pack_size}${existing.unit} → 1${pack_unit || '箱'}=${pack.value}${unit || '瓶'}`);
      }
      if ((existing.sale_visible !== 0 ? 1 : 0) !== saleVisible) {
        changes.push(`销售开单显示: ${existing.sale_visible !== 0 ? '显示' : '隐藏'} → ${saleVisible ? '显示' : '隐藏'}`);
      }
      const summary = changes.length > 0 ? `修改商品【${name}】：${changes.join('，')}` : `修改商品【${name}】基础资料`;

      writeAuditLog(db, req.session.user, '修改商品', '商品', existing.id, summary, {
        before: existing,
        after: {
          sku: sku || null, name, spec: spec || '', unit: unit || '瓶',
          pack_unit: pack_unit || null, pack_size: pack.value,
          sale_visible: saleVisible,
          ...numbers.values
        }
      });
    }).immediate();
    res.redirect('/products?saved=1');
  } catch (e) {
    res.status(400).render('product_form', { product: formProduct, error: 'SKU 已存在或数据有误，请核对后重试。' });
  }
});

router.post('/products/:id/toggle-visibility', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const product = db.prepare('SELECT id, name, sale_visible FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).send('商品不存在');
  const nextVisible = product.sale_visible === 0 ? 1 : 0;
  db.transaction(() => {
    db.prepare('UPDATE products SET sale_visible = ? WHERE id = ?').run(nextVisible, product.id);
    writeAuditLog(db, req.session.user, '修改商品', '商品', product.id,
      `修改商品【${product.name}】销售开单显示：${nextVisible ? '设为显示' : '设为隐藏'}`,
      { before: { sale_visible: product.sale_visible }, after: { sale_visible: nextVisible } }
    );
  }).immediate();
  res.redirect(buildProductsRedirect({ q: req.body.q, visibility: req.body.visibility, page: req.body.page }));
});

router.post('/products/batch-visibility', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  if (req.body.sale_visible !== '0' && req.body.sale_visible !== '1') {
    return res.status(400).send('无效的状态参数');
  }
  const rawIds = Array.isArray(req.body.ids)
    ? req.body.ids
    : String(req.body.ids || '').split(',');
  const ids = [...new Set(rawIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 200);
  const targetVisible = req.body.sale_visible === '0' ? 0 : 1;
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.transaction(() => {
      db.prepare(`UPDATE products SET sale_visible = ? WHERE id IN (${placeholders})`).run(targetVisible, ...ids);
      writeAuditLog(db, req.session.user, '批量修改商品', '商品', null,
        `批量将 ${ids.length} 个商品设为销售${targetVisible ? '显示' : '隐藏'}`,
        { ids, sale_visible: targetVisible }
      );
    }).immediate();
  }
  res.redirect(buildProductsRedirect({ q: req.body.q, visibility: req.body.visibility, page: req.body.page }));
});

router.post('/products/:id/delete', requireAdmin, (req, res) => {
  const db = req.tenantDb;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.redirect('/products?saved=1');
  // 引用检查要覆盖所有带外键的表：销售/采购/调拨明细、退货明细、出入库流水。
  // 少查一张表的话，提示语会说"可以删"，实际却被数据库外键约束拦下来，用户看到的是另一个报错。
  const refCount =
    db.prepare('SELECT COUNT(*) c FROM sales_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM purchase_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM transfer_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM return_order_items WHERE product_id = ?').get(req.params.id).c +
    db.prepare('SELECT COUNT(*) c FROM stock_transactions WHERE product_id = ?').get(req.params.id).c;
  if (refCount > 0) {
    return res.status(400).send('无法删除：该商品已有出入库流水或被销售单/采购单/调拨单/退货单引用，删除会破坏历史记录。如果不再销售，可在商品档案中将其“设为隐藏”即可。');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM inventory WHERE product_id = ?').run(req.params.id);
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    writeAuditLog(db, req.session.user, '删除商品', '商品', req.params.id, `删除商品【${product.name}】（SKU: ${product.sku || '无'}）`, { product });
  }).immediate();
  res.redirect('/products?saved=1');
});

module.exports = router;
