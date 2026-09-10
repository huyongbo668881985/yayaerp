require('dotenv').config();
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const SqliteSessionStore = require('./lib/sqliteSessionStore');
const path = require('path');
const fs = require('fs');

const { resolveTenant } = require('./middleware/tenant');
const { issueCsrfToken, csrfProtection } = require('./middleware/csrf');

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

const DATA_DIR = process.env.JXC_DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null
    }
  },
  xFrameOptions: { action: 'deny' },
  strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

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

// 平台超管专属 REST API（v1）：给 n8n、Codex 等自动化工具调用（AI 日报、销售龙虎榜等场景）。
// API Key 认证（Authorization: Bearer / X-API-Key，见 middleware/apiAuth.js），与 Web 的
// session/Cookie 体系完全分开——挂在 session 之前，API 请求不创建、不读取任何会话；
// 凭据走请求头而不是 Cookie，天然没有 CSRF 风险，因此也不经过下面针对浏览器请求的 Origin 校验。
// Key 只能在平台超管后台 /platform-admin/api-keys 生成/吊销，租户设置页不暴露入口。
app.use('/api/v1', require('./routes/apiV1'));

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

app.use(issueCsrfToken);
app.get('/api/csrf-token', (req, res) => res.json({ token: req.session.csrfToken }));

// 根据 session 里的 tenant_code 挂载对应租户的 db 连接到 req.tenantDb
app.use(resolveTenant);

// 浏览器表单和官网 JSON 接口统一使用 session 同步 token；API v1 在 session 之前挂载，继续使用 API Key。
app.use(csrfProtection);

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
