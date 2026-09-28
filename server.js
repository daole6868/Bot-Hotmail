'use strict';
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const compression = require('compression');

const config = require('./src/config');
const { getSettings } = require('./src/db');
const { runSeed } = require('./src/seed');
const SQLiteStore = require('./src/session-store');
const security = require('./src/middleware/security');
const H = require('./src/utils/helpers');
const { I } = require('./src/utils/icons');
const maintenance = require('./src/services/maintenance');

runSeed();

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
// Mã phiên bản file tĩnh: đổi mỗi lần khởi động lại -> trình duyệt tự tải CSS/JS mới sau khi cập nhật code
app.locals.assetV = Date.now().toString(36);

// ---------- Bảo mật HTTP headers ----------
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://challenges.cloudflare.com'],
      'frame-src': ['https://challenges.cloudflare.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'https://img.vietqr.io'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: config.isProd,
}));
app.use(compression());

// ---------- File tĩnh ----------
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: config.isProd ? '7d' : 0,
  setHeaders(res, filePath) {
    // Không cho trình duyệt thực thi file trong thư mục upload
    if (filePath.includes(`${path.sep}uploads${path.sep}`)) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  },
}));

app.use(security.ipBlock);

// Webhook ngân hàng đặt TRƯỚC session/CSRF (xác thực bằng token riêng)
app.use('/api', require('./src/routes/api'));

app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 500 }));
app.use(express.json({ limit: '50kb' }));

app.use(session({
  name: 'sid',
  store: new SQLiteStore(),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd && config.baseUrl.startsWith('https'),
    maxAge: 7 * 86400 * 1000,
  },
}));

// ---------- Biến dùng chung cho view ----------
const { db } = require('./src/db');
let navCache = { at: 0, games: [], sideLeft: [], sideRight: [], popup: null };
app.use((req, res, next) => {
  if (Date.now() - navCache.at > 30000) {
    navCache = {
      at: Date.now(),
      games: db.prepare('SELECT name, slug, image, color, is_hot FROM games WHERE is_active = 1 ORDER BY sort_order, id').all(),
      sideLeft: db.prepare("SELECT * FROM banners WHERE position = 'sidebar_left' AND is_active = 1 ORDER BY sort_order LIMIT 3").all(),
      sideRight: db.prepare("SELECT * FROM banners WHERE position = 'sidebar_right' AND is_active = 1 ORDER BY sort_order LIMIT 3").all(),
      popup: db.prepare("SELECT * FROM banners WHERE position = 'popup' AND is_active = 1 ORDER BY sort_order LIMIT 1").get() || null,
    };
  }
  Object.assign(res.locals, {
    s: getSettings(), H, I, turnstileSiteKey: config.turnstile.siteKey, nav: navCache, currentPath: req.path, query: {}, breadcrumb: null, layoutAdmin: false, user: null,
  });
  next();
});
app.locals.clearNav = () => { navCache.at = 0; };

app.use(security.flash);
app.use(security.limiters.global);
app.use(security.csrf);
app.use(security.loadUser);

// Chế độ bảo trì: chỉ admin vào được
app.use((req, res, next) => {
  if (res.locals.s.maintenance_mode === '1' && !(req.user && req.user.role === 'admin')
    && !['/login', '/captcha.svg'].includes(req.path)) {
    return res.status(503).render('errors/maintenance');
  }
  next();
});

app.use('/', require('./src/routes/auth'));
app.use('/user', require('./src/routes/user'));
app.use('/admin', require('./src/routes/admin'));
app.use('/', require('./src/routes/public'));

// ---------- 404 & lỗi ----------
app.use((req, res) => res.status(404).render('errors/error', { code: 404, message: 'Không tìm thấy trang bạn yêu cầu' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  const code = err.status || err.statusCode || 500;
  if (res.headersSent) return;
  res.status(code).render('errors/error', { code, message: code === 500 ? 'Lỗi máy chủ, vui lòng thử lại sau' : err.message });
});

maintenance.startScheduler();

app.listen(config.port, () => {
  console.log(`Shop đang chạy tại ${config.baseUrl} (port ${config.port})`);
});

module.exports = app;
