// ============ jxc-app 全量上线前回归测试 v2 ============
const BASE = 'http://127.0.0.1:3115';
let FAILS = 0, PASSES = 0;
function ok(c, m) { if (c) { PASSES++; console.log('  PASS  ' + m); } else { FAILS++; console.log('  FAIL  ' + m); } }
function section(t) { console.log('\n=== ' + t + ' ==='); }
const enc = encodeURIComponent;
const f = (o) => Object.entries(o).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');

class Client {
  constructor() { this.cookie = ''; }
  async raw(path, { body = null, method = null, origin = BASE } = {}) {
    const headers = { Origin: origin };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(BASE + path, { method: method || (body === null ? 'GET' : 'POST'), headers, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    const ct = r.headers.get('content-type') || '';
    let text = '';
    if (ct.includes('text') || ct.includes('json') || ct.includes('csv')) text = await r.text();
    return { status: r.status, loc: r.headers.get('location'), text, ct };
  }
  async login(tenant, username, password) { return this.raw('/login', { body: f({ tenant_code: tenant, username, password }) }); }
  async loginPlatform(u, p) { return this.raw('/platform-admin/login', { body: f({ username: u, password: p }) }); }
}

function invOf(html, name) {
  // 同一商品在多个仓库各有一行，取最大数量（测试场景里总仓数量最大且是断言目标）
  let best = -2;
  for (const row of html.split('<tr>')) {
    if (!row.includes(name)) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    if (cells.length >= 4) { const m = cells[3].match(/^(\d+)/); if (m) best = Math.max(best, Number(m[1])); }
  }
  return best;
}
// 找到某名称所在表格行的详情链接 id（edit/详情 href 与名称同行）
function rowIdOf(html, name, pattern) {
  for (const row of html.split('<tr>')) {
    if (!row.includes(name)) continue;
    const m = row.match(pattern);
    if (m) return Number(m[1]);
  }
  return null;
}

(async () => {
  section('0. 准备');
  const plat = new Client();
  await plat.loginPlatform('superadmin', 'super123');
  for (const [code, name] of [['rega', '回归租户A'], ['regb', '回归租户B'], ['regc', '回归租户C']]) {
    const r = await plat.raw('/platform-admin/tenants/new', { body: f({ tenant_code: code, tenant_name: name, admin_username: 'admin', admin_password: 'pass12345', admin_name: '管理员' }) });
    ok(r.status === 302, `建租户 ${code}`);
  }
  let r = await plat.raw('/platform-admin');
  const regcId = rowIdOf(r.text, 'regc', /tenants\/(\d+)\/toggle/);
  if (regcId) await plat.raw(`/platform-admin/tenants/${regcId}/toggle`, { body: f({ _: '1' }) });
  ok(!!regcId, 'regc 已停用');

  section('A. 管理员页面可达性');
  const A = new Client();
  r = await A.login('rega', 'admin', 'pass12345');
  ok(r.loc === '/', '管理员登录');
  const pages = [
    ['/', '首页'], ['/sales', '销售列表'], ['/sales/new', '销售开单'], ['/returns', '退货列表'],
    ['/returns/new', '退货开单'], ['/transfers', '调拨列表'], ['/transfers/new', '调拨开单'],
    ['/inventory', '库存'], ['/inventory/adjust', '库存调整'], ['/stock-log', '流水'],
    ['/products', '商品'], ['/products/new', '商品新建'], ['/customers', '客户'],
    ['/suppliers', '供应商'], ['/warehouses', '仓库'], ['/reports', '报表'],
    ['/users', '账号'], ['/change-password', '改密'], ['/welcome/', '官网'],
    ['/does-not-exist', '404页']
  ];
  for (const [p, label] of pages) {
    const rr = await A.raw(p);
    const want = p === '/does-not-exist' ? rr.status === 404 : rr.status === 200;
    ok(want, `${label} ${p} -> ${rr.status}`);
  }

  section('B. 基础资料');
  await A.raw('/products/new', { body: f({ sku: 'SKUA1', name: '啤酒A', spec: '500ml', unit: '瓶', pack_unit: '箱', pack_size: '24', cost_price: '50', sale_price: '60', cost_price_pack: '1200', sale_price_pack: '1440', low_stock_threshold: '10' }) });
  await A.raw('/products/new', { body: f({ sku: 'SKUB', name: '白酒B', unit: '瓶', pack_size: '1', cost_price: '100', sale_price: '150', low_stock_threshold: '0' }) });
  await A.raw('/products/new', { body: f({ sku: 'SKUC', name: '赠品C', unit: '瓶', pack_size: '1', cost_price: '30', sale_price: '0' }) });
  r = await A.raw('/products');
  const pA = rowIdOf(r.text, '啤酒A', /products\/(\d+)\/edit/);
  const pB = rowIdOf(r.text, '白酒B', /products\/(\d+)\/edit/);
  const pC = rowIdOf(r.text, '赠品C', /products\/(\d+)\/edit/);
  ok(pA && pB && pC, `商品创建 id=${pA}/${pB}/${pC}`);

  await A.raw('/warehouses/new', { body: f({ name: '总仓', address: '' }) });
  await A.raw('/warehouses/new', { body: f({ name: '分仓', address: '' }) });
  r = await A.raw('/warehouses');
  const w1 = rowIdOf(r.text, '总仓', /warehouses\/(\d+)/);
  const w2 = rowIdOf(r.text, '分仓', /warehouses\/(\d+)/);
  ok(w1 && w2, `仓库创建 id=${w1}/${w2}`);

  await A.raw('/customers/new', { body: f({ name: '客户甲', contact: '王', phone: '13800000001' }) });
  await A.raw('/customers/new', { body: f({ name: '客户乙', contact: '李', phone: '13800000002' }) });
  await A.raw('/customers/new', { body: f({ name: '=公式注入探针', contact: 'X' }) });
  r = await A.raw('/customers');
  const custJia = rowIdOf(r.text, '客户甲', /customers\/(\d+)\/edit/);
  const custYi = rowIdOf(r.text, '客户乙', /customers\/(\d+)\/edit/);
  ok(custJia && custYi, `客户创建 id=${custJia}/${custYi}`);
  await A.raw('/suppliers/new', { body: f({ name: '供应商一' }) });
  await A.raw('/suppliers/new', { body: f({ name: '供应商二' }) });
  r = await A.raw('/suppliers');
  const sup1 = rowIdOf(r.text, '供应商一', /suppliers\/(\d+)/);
  ok(!!sup1, '供应商创建');

  section('C. 业务链路与状态机');
  const gi = async () => (await A.raw('/inventory')).text;
  await A.raw('/purchases/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', product_id: String(pA), quantity: '240', unit_price: '50', unit_choice: 'base', note: '期初' }) });
  await A.raw('/purchases/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', product_id: String(pB), quantity: '100', unit_price: '100', unit_choice: 'base' }) });
  await A.raw('/purchases/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', product_id: String(pC), quantity: '50', unit_price: '30', unit_choice: 'base' }) });
  let invh = await gi();
  ok(invOf(invh, '啤酒A') === 240 && invOf(invh, '白酒B') === 100 && invOf(invh, '赠品C') === 50, '采购入库后 240/100/50');

  // 销售1：啤酒A 40 + 赠品C 5(赠品)，收 1000
  await A.raw('/sales/new', { body: f({ customer_id: String(custJia), warehouse_id: String(w1), order_date: '2026-09-08', paid_amount: '1000', items_json: JSON.stringify([{ id: pA, quantity: 40, price: 60, unit_choice: 'base' }, { id: pC, quantity: 5, price: 0, unit_choice: 'base', is_gift: true }]) }) });
  r = await A.raw('/sales');
  const so1 = rowIdOf(r.text, '客户甲', /\/sales\/(\d+)"/);
  await A.raw(`/sales/submit/${so1}`, { body: f({ _: '1' }) });
  r = await A.raw(`/sales/approve/${so1}`, { body: f({ _: '1' }) });
  ok(r.status === 302, `销售单1(${so1}) 审核通过`);
  invh = await gi();
  ok(invOf(invh, '啤酒A') === 200 && invOf(invh, '赠品C') === 45, '审核后 啤酒A 200 / 赠品C 45');
  r = await A.raw('/sales/' + so1);
  ok(r.text.includes('2400'), '销售单1 总额 2400');
  ok(r.text.includes('部分收款'), '销售单1 部分收款');
  ok(r.text.includes('赠品'), '销售单1 含赠品行');

  r = await A.raw(`/sales/unapprove/${so1}`, { body: f({ _: '1' }) });
  ok(r.status === 302, '无退货时反审核成功');
  invh = await gi();
  ok(invOf(invh, '啤酒A') === 240, '反审核后库存回 240');
  await A.raw(`/sales/approve/${so1}`, { body: f({ _: '1' }) });

  r = await A.raw(`/sales/${so1}/record-payment`, { body: f({ amount: '1400' }) });
  ok(r.status === 302, '补收款 1400');
  r = await A.raw('/sales/' + so1);
  ok(r.text.includes('已收款'), '销售单1 结清');
  r = await A.raw(`/sales/${so1}/record-payment`, { body: f({ amount: '1' }) });
  ok(r.status === 400, '结清后再收款被拒');

  await A.raw('/sales/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', items_json: JSON.stringify([{ id: pB, quantity: 10, price: 150, unit_choice: 'base' }]) }) });
  r = await A.raw('/sales');
  const so2 = Number(r.text.match(/\/sales\/(\d+)"/)[1]);
  await A.raw(`/sales/submit/${so2}`, { body: f({ _: '1' }) });
  await A.raw(`/sales/approve/${so2}`, { body: f({ _: '1' }) });
  r = await A.raw(`/sales/${so2}/record-payment`, { body: f({ amount: '99999' }) });
  ok(r.status === 400, '收款超欠款被拒');

  await A.raw('/transfers/new', { body: f({ from_warehouse_id: String(w1), to_warehouse_id: String(w2), order_date: '2026-09-08', product_id: String(pB), quantity: '30', unit_choice: 'base' }) });
  r = await A.raw('/transfers');
  const tf1 = Number(r.text.match(/\/transfers\/(\d+)"/)[1]);
  await A.raw(`/transfers/submit/${tf1}`, { body: f({ _: '1' }) });
  r = await A.raw(`/transfers/approve/${tf1}`, { body: f({ _: '1' }) });
  ok(r.status === 302, '调拨审核通过');
  invh = await gi();
  ok(invOf(invh, '白酒B') === 60, '白酒B 库存 = 100-10-30 = 60');

  // 关联退货：客户甲 退 啤酒A 10 关联销售单1
  await A.raw('/returns/new', { body: f({ customer_id: String(custJia), warehouse_id: String(w1), order_date: '2026-09-08', related_sales_order_id: String(so1), refunded_amount: '0', items_json: JSON.stringify([{ id: pA, quantity: 10, price: 60, unit_choice: 'base' }]) }) });
  r = await A.raw('/returns');
  const ro1 = Number(r.text.match(/\/returns\/(\d+)"/)[1]);
  await A.raw(`/returns/submit/${ro1}`, { body: f({ _: '1' }) });
  r = await A.raw(`/returns/approve/${ro1}`, { body: f({ _: '1' }) });
  ok(r.status === 302, '关联退货审核通过');
  invh = await gi();
  ok(invOf(invh, '啤酒A') === 210, '退货后啤酒A = 240-40+10 = 210');
  r = await A.raw(`/sales/unapprove/${so1}`, { body: f({ _: '1' }) });
  ok(r.status === 400, '销售单1 反审核被关联退货拦截');
  await A.raw(`/returns/${ro1}/record-refund`, { body: f({ amount: '600' }) });
  r = await A.raw('/returns/' + ro1);
  ok(r.text.includes('已退款'), '退货退款 600 后已退款');

  await A.raw('/inventory/adjust', { body: f({ product_id: String(pC), warehouse_id: String(w1), new_quantity: '40', reason: '盘亏' }) });
  invh = await gi();
  ok(invOf(invh, '赠品C') === 40, '库存调整 45→40');

  r = await A.raw(`/products/${pA}/delete`, { body: f({ _: '1' }) });
  ok(r.status === 400 && r.text.includes('无法删除'), '有单据商品删除被拒');
  r = await A.raw(`/customers/${custJia}/delete`, { body: f({ _: '1' }) });
  ok(r.status === 400, '有单据客户删除被拒');
  r = await A.raw(`/warehouses/${w1}/delete`, { body: f({ _: '1' }) });
  ok(r.status === 400, '有库存仓库删除被拒');
  r = await A.raw(`/suppliers/${sup1}/delete`, { body: f({ _: '1' }) });
  ok(r.status === 302, '无采购单的供应商可正常删除');

  // 自由退货
  await A.raw('/returns/new', { body: f({ warehouse_id: String(w2), order_date: '2026-09-08', items_json: JSON.stringify([{ id: pB, quantity: 5, price: 150, unit_choice: 'base' }]) }) });
  r = await A.raw('/returns');
  const ro2 = Number(r.text.match(/\/returns\/(\d+)"/)[1]);
  await A.raw(`/returns/submit/${ro2}`, { body: f({ _: '1' }) });
  r = await A.raw(`/returns/approve/${ro2}`, { body: f({ _: '1' }) });
  ok(r.status === 302, '自由退货可审核');

  section('D. 报表与导出');
  r = await A.raw('/reports?start=2026-09-01&end=2026-09-30');
  const clean = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/¥\s*/g, '¥');
  const money = [...clean(r.text).matchAll(/¥([\-\d,]+\.\d{2})/g)].map(m => m[1]);
  console.log('  报表金额序列: ' + money.join(' | '));
  ok(money.length >= 5, '报表渲染出全部汇总卡');
  // DOM 顺序：金额 div 在标签 div 之前，所以序列第 1 个 ¥ 就是销售额 2550
  ok(money[0] === '2550.00', '销售额卡片 = 2550（实为 ' + money[0] + '）');

  r = await A.raw('/sales/export');
  ok(r.ct.includes('csv') && r.text.includes('啤酒A'), '销售CSV 含明细数据');
  // BOM 单独用字节验证（fetch text() 会按规范剥离 BOM，不代表导出没有）
  const bomBuf = await fetch(BASE + '/sales/export', { headers: { Cookie: A.cookie } }).then(x => x.arrayBuffer());
  ok(new Uint8Array(bomBuf)[0] === 0xEF && new Uint8Array(bomBuf)[1] === 0xBB, '销售CSV 字节含 UTF-8 BOM');
  r = await A.raw('/returns/export');
  ok(r.ct.includes('csv'), '退货CSV');
  r = await A.raw('/stock-log/export');
  ok(r.ct.includes('csv') && r.text.includes('采购入库'), '流水CSV');
  r = await A.raw('/reports/export');
  ok(r.ct.includes('csv') && r.text.includes('销售') && r.text.includes('退货'), '报表CSV 订单级明细');
  ok(r.text.includes('#') || r.text.split('\r\n')[1].startsWith('销售,1'), '报表CSV 含销售单行');
  const csvOk = (csv) => !csv.split('\r\n').some(line => line.split(',').some(cell => cell && /^[=+\-@]/.test(cell) && !/^-?\d+(\.\d+)?$/.test(cell)));
  ok(csvOk(r.text), '报表CSV 无裸公式注入字段');

  section('E. 平台管理端');
  const P = new Client();
  r = await P.raw('/platform-admin');
  ok(r.status === 302, '未登录平台后台重定向');
  await P.loginPlatform('superadmin', 'super123');
  r = await P.raw('/platform-admin');
  ok(r.text.includes('rega') && r.text.includes('regb'), '平台列表含租户');
  r = await P.raw('/platform-admin/audit-log');
  ok(r.text.includes('create_tenant'), '审计日志有记录');
  r = await P.raw('/platform-admin/change-password', { body: f({ old_password: 'wrong', new_password: 'x12345678' }) });
  ok(r.text.includes('原密码不正确'), '平台改密旧密错误被拒');
  for (let i = 0; i < 10; i++) await P.raw('/platform-admin/login', { body: f({ username: 'superadmin', password: 'bad' + i }) });
  r = await P.raw('/platform-admin/login', { body: f({ username: 'superadmin', password: 'super123' }) });
  ok(r.status === 429, '平台超管连续错 10 次被锁（独立桶，不影响租户）');
  // 租户账号登录仍正常（验证平台桶独立）
  const A2 = new Client();
  r = await A2.login('rega', 'admin', 'pass12345');
  ok(r.loc === '/', '平台桶被锁不影响租户登录');

  section('F. 操作员边界');
  await A.raw('/users/new', { body: f({ username: 'opA', password: 'op123456', name: '操作员A', role: 'operator' }) });
  const O = new Client();
  r = await O.login('rega', 'opA', 'op123456');
  ok(r.loc === '/', '操作员登录');
  for (const [p, label] of [['/', '首页'], ['/sales', '销售'], ['/inventory', '库存'], ['/stock-log', '流水'], ['/products', '商品只读'], ['/change-password', '改密'], ['/customers', '客户']]) {
    const rr = await O.raw(p);
    ok(rr.status === 200, `操作员可访问 ${label}(${rr.status})`);
  }
  for (const [p, label] of [['/reports', '报表'], ['/users', '账号'], ['/purchases', '采购'], ['/products/1/edit', '商品编辑'], ['/inventory/adjust', '库存调整'], ['/customers/1/edit', '客户编辑'], ['/suppliers', '供应商']]) {
    const rr = await O.raw(p);
    ok(rr.status === 403, `操作员访问${label} 403(${rr.status})`);
  }
  r = await O.raw('/sales/' + so1);
  ok(r.status === 403, '操作员看他人销售单详情 403');
  r = await O.raw('/transfers/' + tf1);
  ok(r.status === 403, '操作员看他人调拨单 403');
  r = await O.raw('/customers/' + custJia + '/edit');
  ok(r.status === 403, '操作员编辑他人客户 403');

  section('G. 多租户隔离');
  const B = new Client();
  r = await B.login('regb', 'admin', 'pass12345');
  ok(r.loc === '/', '租户B登录');
  r = await B.raw('/products');
  ok(!r.text.includes('啤酒A'), '租户B无租户A商品');
  r = await B.raw('/sales');
  ok(!r.text.includes('客户甲'), '租户B无租户A单据');
  const X = new Client();
  r = await X.login('no_such_tenant', 'a', 'b');
  ok(r.status === 200 && r.text.includes('租户代码不存在'), '无效租户提示');
  const CC = new Client();
  r = await CC.login('regc', 'admin', 'pass12345');
  ok(r.status === 200 && r.text.includes('已被暂停'), '停用租户登录被拦');

  section('H. 健壮性与安全');
  r = await A.raw('/sales/999999');
  ok(r.status === 404, '不存在单据 404');
  r = await A.raw('/sales/abc');
  ok(r.status === 404, '非法 id 不崩溃');
  const apiNoOrigin = await fetch(BASE + '/api/trial/send-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '13812345678' }) });
  ok(apiNoOrigin.status === 403, '/api/ 无Origin被拒');
  await A.raw('/sales/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', items_json: JSON.stringify([{ id: pB, quantity: 99999, price: 150, unit_choice: 'base' }]) }) });
  r = await A.raw('/sales');
  const soX = Number(r.text.match(/\/sales\/(\d+)"/)[1]);
  await A.raw(`/sales/submit/${soX}`, { body: f({ _: '1' }) });
  r = await A.raw(`/sales/approve/${soX}`, { body: f({ _: '1' }) });
  ok(r.status === 400 && (r.text.includes('不足以') || r.text.includes('库存不足')), '库存不足审核被拒');
  r = await A.raw('/sales/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', items_json: JSON.stringify([{ id: pA, quantity: 1, price: -5, unit_choice: 'base' }]) }) });
  ok(r.status === 400 && r.text.includes('销售单价'), '负价被拒');
  for (const invalidPaid of ['-1', 'Infinity', 'not-a-number']) {
    r = await A.raw('/sales/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', paid_amount: invalidPaid, items_json: JSON.stringify([{ id: pA, quantity: 1, price: 60, unit_choice: 'base' }]) }) });
    ok(r.status === 400 && r.text.includes('已收款金额'), `非法已收款 ${invalidPaid} 被拒`);
  }
  for (const invalidRefunded of ['-1', 'Infinity', 'not-a-number']) {
    r = await A.raw('/returns/new', { body: f({ warehouse_id: String(w1), order_date: '2026-09-08', refunded_amount: invalidRefunded, items_json: JSON.stringify([{ id: pA, quantity: 1, price: 60, unit_choice: 'base' }]) }) });
    ok(r.status === 400 && r.text.includes('已退款金额'), `非法已退款 ${invalidRefunded} 被拒`);
  }
  r = await A.raw('/products/new', { body: f({ name: '非法价格商品', unit: '瓶', pack_size: '1', cost_price: 'Infinity', sale_price: '1', low_stock_threshold: '0' }) });
  ok(r.status === 400 && r.text.includes('成本价'), '商品 Infinity 成本价被拒');
  // 改密码：错误旧密
  r = await A.raw('/change-password', { body: f({ old_password: 'nope', new_password: 'whatever1' }) });
  ok(r.text.includes('原密码不正确'), '改密旧密错误被拒');
  // 禁用操作员
  r = await A.raw('/users');
  const opAId = rowIdOf(r.text, '操作员A', /users\/(\d+)\/toggle-active/);
  await A.raw(`/users/${opAId}/toggle-active`, { body: f({ _: '1' }) });
  const O2 = new Client();
  r = await O2.login('rega', 'opA', 'op123456');
  ok(r.text.includes('已被禁用'), '禁用账号登录被拒');
  await A.raw(`/users/${opAId}/toggle-active`, { body: f({ _: '1' }) });

  section('I. 数据一致性（DB 直查）');
  const Database = require('/Users/huyongbo/Downloads/jxc-app/node_modules/better-sqlite3');
  const db = new Database('/Users/huyongbo/Downloads/jxc-app/data/tenants/rega.db', { readonly: true });
  const invRows = db.prepare('SELECT product_id, warehouse_id, quantity FROM inventory').all();
  const txnMap = {};
  for (const t of db.prepare('SELECT product_id, warehouse_id, SUM(change_qty) AS net FROM stock_transactions GROUP BY product_id, warehouse_id').all()) txnMap[t.product_id + '_' + t.warehouse_id] = t.net;
  let mm = 0;
  for (const i of invRows) if ((txnMap[i.product_id + '_' + i.warehouse_id] || 0) !== i.quantity) { mm++; console.log('  不一致:', i, '流水', txnMap[i.product_id + '_' + i.warehouse_id]); }
  ok(mm === 0, '库存=流水净额 全对齐');
  ok(db.prepare('SELECT COUNT(*) c FROM inventory WHERE quantity<0').get().c === 0, '无负库存');
  const orphan = (rt) => db.prepare(`SELECT COUNT(*) c FROM stock_transactions st WHERE st.ref_type=? AND NOT EXISTS(SELECT 1 FROM ${rt} d WHERE d.id=st.ref_id)`).get(rt).c;
  ok(orphan('sales_orders') + orphan('return_orders') + orphan('transfer_orders') === 0, '销售/退货/调拨流水无孤儿');
  const nApproved = db.prepare("SELECT COUNT(*) c FROM sales_orders WHERE status='approved'").get().c;
  const nTxns = db.prepare("SELECT COUNT(DISTINCT ref_id) c FROM stock_transactions WHERE type='sale_out'").get().c;
  ok(nApproved === nTxns, `已审核销售单(${nApproved})全有 sale_out(${nTxns})`);
  // 报表毛利抽查：啤酒A 40*60 - 40*50(成本快照50) = 400
  const profitA = db.prepare(`SELECT COALESCE(SUM(soi.quantity*soi.unit_price - soi.base_quantity*soi.cost_price_snapshot),0) p FROM sales_order_items soi JOIN sales_orders so ON so.id=soi.sales_order_id WHERE so.id=?`).get(so1).p;
  console.log('  销售单1 毛利 =', profitA, '(含退货冲减前)');
  db.close();

  section('J. 欠款每日快照（debt_snapshots + debt-trend API）');
  const { snapshotTenantDb } = require('../lib/debtSnapshot');
  const apiKeys = require('../lib/apiKeys');
  const { getTenantByCode } = require('../lib/platformDb');
  const { todayLocalDate } = require('../utils/dates');
  const today = todayLocalDate();
  const snapDb = new Database('/Users/huyongbo/Downloads/jxc-app/data/tenants/rega.db');
  // 场景欠款：单1 = 2400-2400(已收)-600(已审核关联退货) = -600 → 负欠款排除；
  //           单2(散客) = 1500-0-0 = 1500 → 计入；soX submitted 不算
  let snap = snapshotTenantDb(snapDb, today);
  ok(snap.company_debt === 1500 && snap.company_debtors === 1, '快照口径=报表应收：全公司欠款 1500 / 欠款客户 1（负欠款不对冲）', `debt=${snap.company_debt}`);
  ok(snap.rows === 3 && snap.user_rows === 2, '行数 = 全公司 1 + 操作员 2（rega 有 admin+操作员A）', `rows=${snap.rows}`);
  const snapRows = snapDb.prepare('SELECT user_id, total_debt, debtor_customer_count FROM debt_snapshots WHERE snapshot_date = ? ORDER BY user_id').all(today);
  ok(snapRows.length === 3 && snapRows[0].user_id === null && snapRows[0].total_debt === 1500, '全公司行 user_id=NULL、欠款 1500，排序在最前');
  ok(snapRows[1].user_id === 1 && snapRows[1].total_debt === 1500 && snapRows[2].user_id === 2 && snapRows[2].total_debt === 0, '操作员行：admin 1500 / 操作员A 0（无欠款记 0，Σ操作员=全公司）');
  snapshotTenantDb(snapDb, today); // 手动重跑一次
  const snapCount = snapDb.prepare('SELECT COUNT(*) c FROM debt_snapshots WHERE snapshot_date = ?').get(today).c;
  ok(snapCount === 3, '重复执行幂等：行数不变（NULL 全公司行也被去重）', `count=${snapCount}`);
  snapDb.close();

  // debt-trend API：rega 的 read_only Key（apiAuth 每次实时查 platform.db，外部进程生成即刻可用）
  const tenantRega = getTenantByCode('rega');
  const snapKey = apiKeys.generateApiKey({ tenantId: tenantRega.id, permissionLevel: 'read_only', adminId: 1, adminUsername: 'superadmin' });
  r = await fetch(BASE + '/api/v1/reports/debt-trend', { headers: { Authorization: 'Bearer ' + snapKey.plaintext } });
  const jt = await r.json();
  ok(r.status === 200 && jt.items.length === 3, 'debt-trend: 返回当天 3 行', `status=${r.status}, items=${jt.items.length}`);
  ok(jt.items[0].user_id === null && jt.items[0].user_name === '全公司' && jt.items[0].total_debt === 1500, 'debt-trend: 首行=全公司汇总 1500');
  ok(jt.items.every(i => i.date === today), 'debt-trend: 日期全部为今天');
  r = await fetch(BASE + `/api/v1/reports/debt-trend?start=${today}&end=${today}`, { headers: { Authorization: 'Bearer ' + snapKey.plaintext } });
  ok((await r.json()).items.length === 3, 'debt-trend: start/end 范围过滤命中');
  r = await fetch(BASE + '/api/v1/reports/debt-trend?start=2099-01-01', { headers: { Authorization: 'Bearer ' + snapKey.plaintext } });
  ok(r.status === 200 && (await r.json()).items.length === 0, 'debt-trend: 范围外返回空列表');
  r = await fetch(BASE + '/api/v1/reports/debt-trend?start=bad-date', { headers: { Authorization: 'Bearer ' + snapKey.plaintext } });
  ok(r.status === 400, 'debt-trend: 非法日期参数 400');
  r = await fetch(BASE + '/api/v1/reports/debt-trend');
  ok(r.status === 401, 'debt-trend: 无 Key 401');
  apiKeys.revokeApiKey(snapKey.id); // 临时 Key 用完即吊销

  console.log('\n========================================');
  console.log(`PASS: ${PASSES}   FAIL: ${FAILS}`);
  console.log(FAILS === 0 ? '全部通过' : '存在失败项');
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
