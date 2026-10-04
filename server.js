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
require('./src/services/posts').seedSamples(); // 4 bài mẫu (Nháp), chỉ chèn 1 lần
require('./src/services/popup').migrate(); // popup cũ (banner) -> trang Popup riêng, chỉ chạy 1 lần

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
// Mã phiên bản file tĩnh: đổi mỗi lần khởi động lại -> trình duyệt tự tải CSS/JS mới sau khi cập nhật code
app.locals.assetV = Date.now().toString(36);

// ---------- Bảo mật HTTP headers ----------
const gAllow = (domains) => () => { const s = getSettings(); return s.ga4_id || s.gads_id ? domains : "'self'"; };
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      // Google Analytics / Ads: chỉ mở cho tên miền của Google khi admin đã nhập mã (SEO & Google)
      'script-src': ["'self'", 'https://challenges.cloudflare.com', gAllow('https://*.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://www.google.com')],
      'connect-src': ["'self'", gAllow('https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.g.doubleclick.net https://www.google.com https://www.googleadservices.com https://pagead2.googlesyndication.com')],
      'frame-src': ['https://challenges.cloudflare.com', gAllow('https://td.doubleclick.net https://www.googletagmanager.com')],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
      'img-src': ["'self'", 'data:', 'blob:', 'https://img.vietqr.io', gAllow('https://*.google-analytics.com https://*.googletagmanager.com https://*.g.doubleclick.net https://www.google.com https://www.google.com.vn')], // blob: để xem trước ảnh trước khi upload
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

// Khách chưa đăng nhập xem trang công khai -> cho Cloudflare / Nginx lưu sẵn vài giây; trang còn lại không ai được lưu
app.use(require('./src/middleware/edge-cache').middleware);

// Webhook ngân hàng đặt TRƯỚC session/CSRF (xác thực bằng token riêng)
app.use('/api', require('./src/routes/api'));
app.use(require('./src/routes/seo')); // robots.txt, sitemap.xml (không cần phiên)

// Chống spam / DDoS lớp 1: khách không có cookie phiên bị đếm theo IP ngay tại đây, trước khi đọc form / phiên / database
const shield = require('./src/services/shield');
app.use(shield.early);

app.use(express.urlencoded({ extended: false, limit: '200kb', parameterLimit: 500 }));
app.use('/admin/ai/write', express.json({ limit: '300kb' })); // lệnh cho AI viết bài có thể dài (dán cả bài gốc)
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
// Nút Hỗ trợ: tính lại khi cài đặt đổi (so theo chuỗi cấu hình)
const supportSvc = require('./src/services/support');
let supportCache = { raw: null, v: null };
const supportView = (s) => { if (supportCache.raw !== s.support_cfg) supportCache = { raw: s.support_cfg, v: supportSvc.forView(s) }; return supportCache.v; };
const popupSvc = require('./src/services/popup');
let popupCache = { raw: null, v: null };
const popupView = (s) => { if (popupCache.raw !== s.popup_cfg) popupCache = { raw: s.popup_cfg, v: popupSvc.forView(s) }; return popupCache.v; };
const chatSvc = require('./src/services/chat');
let chatCache = { raw: null, v: null };
const chatView = (s) => {
  if (chatCache.raw !== s.chat_cfg) { const c = chatSvc.cfg(s); chatCache = { raw: s.chat_cfg, v: c.enabled ? { title: c.title, greeting: c.greeting, color: c.color, agent: c.agent_name, in_support: c.in_support, position: c.position } : null }; }
  return chatCache.v;
};
let navCache = { at: 0, games: [], sideLeft: [], sideRight: [] };
app.use((req, res, next) => {
  if (Date.now() - navCache.at > 30000) {
    navCache = {
      at: Date.now(),
      games: db.prepare('SELECT name, slug, image, color, is_hot FROM games WHERE is_active = 1 ORDER BY sort_order, id').all(),
      sideLeft: db.prepare("SELECT * FROM banners WHERE position = 'sidebar_left' AND is_active = 1 ORDER BY sort_order LIMIT 3").all(),
      sideRight: db.prepare("SELECT * FROM banners WHERE position = 'sidebar_right' AND is_active = 1 ORDER BY sort_order LIMIT 3").all(),
    };
  }
  const s0 = getSettings();
  Object.assign(res.locals, {
    support: supportView(s0), popup: popupView(s0), chat: chatView(s0),
    s: s0, H, I, baseUrl: config.baseUrl, currentUrl: req.originalUrl, turnstileSiteKey: config.turnstile.siteKey, nav: navCache, currentPath: req.path, query: {}, breadcrumb: null, layoutAdmin: false, user: null,
  });
  next();
});
app.locals.clearNav = () => { navCache.at = 0; };

// Phiên khách chưa đăng nhập: cookie cũng chỉ 1 giờ (khớp với hạn trong database)
app.use((req, res, next) => { if (req.session && !req.session.userId) req.session.cookie.maxAge = 60 * 60 * 1000; next(); });
app.use(security.flash);
app.use(security.csrf);
app.use(security.loadUser);
app.use(shield.late); // lớp 2: đã đăng nhập -> đếm theo tài khoản; có cookie nhưng chưa đăng nhập -> đếm theo IP

// Popup "Nạp tiền thành công": tiền về lúc khách đang ở trang khác -> hiện ở lần mở trang tiếp theo (1 lần)
const depositSvc = require('./src/services/deposit');
app.use((req, res, next) => {
  if (!req.user || req.method !== 'GET' || req.xhr || req.path.startsWith('/admin') || !(req.get('accept') || '').includes('text/html')) return next();
  const d = depositSvc.unseenStmt.get(req.user.id);
  if (d) {
    res.locals.depositPopup = depositSvc.depositReceipt(d);
    res.on('finish', () => { if (res.statusCode === 200) depositSvc.markSeen(d.id); });
  }
  next();
});

// Đo chuyển đổi Google (đăng ký / nạp tiền / mua hàng): gửi ở lần mở trang tiếp theo của khách
const tracking = require('./src/services/tracking');
app.use((req, res, next) => {
  if (!req.user || req.method !== 'GET' || req.xhr || req.path.startsWith('/admin') || !(req.get('accept') || '').includes('text/html')) return next();
  const ev = tracking.pending(req.user.id);
  if (ev.length) {
    res.locals.gtagEvents = ev.map((e) => ({ e: e.event, v: e.value, r: e.ref }));
    res.on('finish', () => { if (res.statusCode === 200) tracking.markSent(ev.map((e) => e.id)); });
  }
  next();
});

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
app.use('/chat', require('./src/routes/chat')); // chat trực tiếp (khách)
app.use('/admin/chat', require('./src/routes/admin-chat')); // chat trực tiếp (admin + nhân viên), trước router admin
app.use('/admin', require('./src/routes/admin'));
app.use('/', require('./src/routes/posts')); // tin tức / hướng dẫn
app.use('/', require('./src/routes/boost')); // cày thuê (trước public: /game/:slug/cay-thue)
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

// Chạy PM2 nhiều bản (cluster): chỉ bản số 0 chạy dọn dẹp / backup định kỳ
if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') {
  maintenance.startScheduler();
  require('./src/services/apicanhan').start(); // quét giao dịch APICANHAN (chỉ chạy khi bật trong Cài đặt bank và có đơn chờ)
  require('./src/services/traffic').start(); // tự phát hiện truy cập bất thường -> tự chặn khách mới / bật Cloudflare Under Attack
  require('./src/services/chat-bot').startTelegram(); // chat: nhận tin trả lời khách từ Telegram
}
require('./src/services/backup').watchRestart(); // khôi phục dữ liệu xong -> mọi bản PM2 tự khởi động lại

app.listen(config.port, config.host, () => {
  console.log(`Shop đang chạy tại ${config.baseUrl} (${config.host}:${config.port})`);
});

module.exports = app;
