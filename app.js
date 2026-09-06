require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SqliteSessionStore = require('./lib/sqliteSessionStore');
const path = require('path');
const fs = require('fs');

const { resolveTenant } = require('./middleware/tenant');

// SESSION_SECRET 是用来签 session cookie 的密钥，绝对不能用公开的默认值——
// 否则任何看过源码的人都能伪造登录态。缺失或太弱就直接拒绝启动，把问题暴露在部署阶段。
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('启动失败：缺少 SESSION_SECRET 环境变量。请复制 .env.example 为 .env 并设置，可用 `openssl rand -hex 32` 生成。');
  process.exit(1);
}
if (SESSION_SECRET.length < 32) {
  console.error('启动失败：SESSION_SECRET 太短（至少 32 个字符）。请用 `openssl rand -hex 32` 重新生成，不要用随手编的短字符串。');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();

// 如果部署在 Nginx/Caddy 等反向代理后面、由代理终止 HTTPS，需要这行 Express 才能正确识别
// 请求本来是走 HTTPS 来的（不然下面 cookie.secure 判断不出来），用环境变量 TRUST_PROXY=1 开启
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 产品介绍主页（含试用注册），挂在独立路径下，不占用 "/"
// "/" 留给已有客户的登录后台，两者不冲突。
// 访问地址：https://erp.yayaagent.com/welcome/
app.use('/welcome', express.static(path.join(__dirname, 'public-site')));

app.use(session({
  store: new SqliteSessionStore(path.join(DATA_DIR, 'sessions.db')),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7天
    sameSite: 'lax', // 缓解跨站请求伪造（CSRF）
    // 只有确认走的是 HTTPS 才启用 secure（否则 http 部署下浏览器会直接不发这个 cookie，导致谁都登不进去）
    // 上了 HTTPS 之后，在 .env 里设置 COOKIE_SECURE=true 打开
    secure: process.env.COOKIE_SECURE === 'true'
  }
}));

// 根据 session 里的 tenant_code 挂载对应租户的 db 连接到 req.tenantDb
app.use(resolveTenant);

// CSRF 防护（与 cookie 的 SameSite=Lax 形成双层防线）：
// 现代浏览器发起跨站 POST 时都会带 Origin 头——只要 Origin 存在且与本站不同源就拒绝。
// 表单请求不带 Origin 的场景（极老浏览器、服务器间调用）放行，由 SameSite=Lax 兜底；
// 这个方案不用给全站几十个表单埋 token，模板零改动。
// 对 JSON API（/api/ 开头，如官网试用注册接口）收紧一档：必须带 Origin 且同源——
// 这类接口只被同源页面的 fetch 调用，没有"无 Origin 兼容"的需求，收紧后脚本工具无法直接打接口。
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  const isJsonApi = req.path.startsWith('/api/');
  if (!origin) {
    if (isJsonApi) return res.status(403).json({ ok: false, message: '非法请求' });
    return next();
  }
  try {
    if (new URL(origin).host === req.headers.host) return next();
  } catch (e) { /* 解析不了的 Origin 一律视为非法 */ }
  if (isJsonApi) return res.status(403).json({ ok: false, message: '非法请求' });
  return res.status(403).send('跨站请求被拒绝（CSRF 校验失败）');
});

// 所有已登录页面统一注入 currentUser，方便模板使用
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.currentTenant = req.tenant || null;
  next();
});

// 平台管理后台（独立于租户体系，单独的登录入口和权限）
app.use(require('./routes/platformAdmin'));

// 官网试用自助注册（手机号验证码 -> 立即开通租户），同样独立于租户体系
app.use(require('./routes/trialAuth'));

app.use(require('./routes/auth'));
app.use(require('./routes/dashboard'));
app.use(require('./routes/products'));
app.use(require('./routes/report'));
app.use(require('./routes/warehouses'));
app.use(require('./routes/partners'));
app.use(require('./routes/purchases'));
app.use(require('./routes/sales'));
app.use(require('./routes/returns'));
app.use(require('./routes/transfers'));
app.use(require('./routes/inventory'));
app.use(require('./routes/users'));

app.use((req, res) => {
  res.status(404).send('页面不存在');
});

// 全局错误兜底：任何路由里抛出的异常（比如数据库外键约束报错）最终都会落到这里，
// 不能让原始报错堆栈（含服务器文件路径）直接展示给用户。
app.use((err, req, res, next) => {
  console.error(err);

  // better-sqlite3 抛的是扩展错误码（如 SQLITE_CONSTRAINT_FOREIGNKEY / _CHECK / _UNIQUE），用前缀匹配
  if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    const message = err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
      ? '操作失败：这条记录还被其他单据引用着，无法删除，请先处理相关单据。'
      : '操作失败：数据不符合业务规则（例如库存不能扣成负数、内容重复），请核对后重试。';
    return res.status(400).render('global_error', { message });
  }

  res.status(500).render('global_error', {
    message: '系统开小差了，请稍后重试；如果反复出现，请联系管理员。'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`进销存系统已启动: http://localhost:${PORT}`);
});
