require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SqliteSessionStore = require('./lib/sqliteSessionStore');
const path = require('path');
const fs = require('fs');

const { resolveTenant } = require('./middleware/tenant');

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
  secret: process.env.SESSION_SECRET || 'change-this-secret-in-env',
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

  if (err && err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return res.status(400).render('global_error', {
      message: '操作失败：这条记录还被其他单据引用着，无法删除，请先处理相关单据。'
    });
  }

  res.status(500).render('global_error', {
    message: '系统开小差了，请稍后重试；如果反复出现，请联系管理员。'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`进销存系统已启动: http://localhost:${PORT}`);
});
