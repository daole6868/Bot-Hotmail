'use strict';
const crypto = require('crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { db, logActivity } = require('../db');
const { randomToken, safeEqual } = require('../utils/crypto');
const { clientIp } = require('../utils/helpers');
const config = require('../config');

// ---------- CSRF ----------
// Mã chống giả mạo có chữ ký HMAC, lưu trong cookie riêng (double-submit): khách chỉ xem trang không cần tạo
// phiên trong database (bot/máy quét không làm phình bảng sessions). Phiên cũ đã có mã trong session vẫn dùng tiếp.
const CSRF_COOKIE = 'xsrf';
const signCsrf = (nonce) => nonce + '.' + crypto.createHmac('sha256', config.sessionSecret).update('csrf:' + nonce).digest('base64url').slice(0, 32);
const validCsrf = (t) => typeof t === 'string' && /^[a-f0-9]{32}\.[A-Za-z0-9_-]{32}$/.test(t) && safeEqual(t, signCsrf(t.split('.')[0]));
function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
function expectedCsrf(req) {
  if (req.session?.csrf) return req.session.csrf;
  const c = readCookie(req, CSRF_COOKIE);
  return validCsrf(c) ? c : null;
}

// Yêu cầu chỉ đọc dữ liệu (không đổi gì) -> không cần mã CSRF; gọi được từ trang khách đã lưu sẵn (không có mã riêng)
const CSRF_FREE = new Set(['/api/coupon/check']);

function csrf(req, res, next) {
  // Trang khách được lưu sẵn ở Cloudflare / Nginx: dùng chung cho mọi người -> không tạo cookie, không in mã của ai
  if (req.edgeCache) { res.locals.csrfToken = ''; return next(); }
  if (req.method === 'POST' && CSRF_FREE.has(req.path)) { res.locals.csrfToken = expectedCsrf(req) || ''; return next(); }
  let token = expectedCsrf(req);
  if (!token) {
    token = signCsrf(randomToken(16));
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86400 * 1000,
      secure: config.isProd && config.baseUrl.startsWith('https'),
    });
    req.headers.cookie = (req.headers.cookie ? req.headers.cookie + '; ' : '') + CSRF_COOKIE + '=' + token;
  }
  res.locals.csrfToken = token;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Form upload ảnh (multipart) chỉ có ở trang admin: router admin tự kiểm tra CSRF sau khi parse form
  if (req.is('multipart/form-data') && req.path.startsWith('/admin')) return next();
  if (!verifyCsrf(req)) {
    logActivity(req.session.userId, 'csrf_fail', req.originalUrl, clientIp(req));
    return res.status(403).render('errors/error', { code: 403, message: 'Phiên làm việc hết hạn hoặc yêu cầu không hợp lệ. Vui lòng tải lại trang.' });
  }
  next();
}

function verifyCsrf(req) {
  const token = req.body?._csrf || req.get('x-csrf-token');
  const expected = expectedCsrf(req);
  return typeof token === 'string' && !!expected && safeEqual(token, expected);
}

// ---------- Chặn IP (bảng ip_blocks) ----------
// Toàn bộ danh sách nằm trong bộ nhớ (làm mới 10 giây / lần, dùng chung giữa các bản PM2 qua DB):
// IP bị khóa bị từ chối ngay mà không tốn 1 truy vấn nào, kể cả khi bị tấn công bằng rất nhiều IP.
let blocked = new Map(); // ip -> hết hạn (ms), Infinity = vĩnh viễn
let blockedAt = 0;
const selBlocks = db.prepare('SELECT ip, expires_at FROM ip_blocks WHERE expires_at IS NULL OR expires_at > ?');
function refreshBlocks() {
  const m = new Map();
  for (const r of selBlocks.all(Math.floor(Date.now() / 1000))) m.set(r.ip, r.expires_at ? r.expires_at * 1000 : Infinity);
  blocked = m;
  blockedAt = Date.now();
}
function ipBlock(req, res, next) {
  if (Date.now() - blockedAt > 10000) { try { refreshBlocks(); } catch { /* DB bận: dùng danh sách cũ */ } }
  const exp = blocked.get(clientIp(req));
  if (exp && exp > Date.now()) return res.status(403).type('text').send('IP của bạn đã bị tạm khóa do hoạt động bất thường.');
  next();
}

function blockIp(ip, minutes, reason) {
  const exp = minutes ? Math.floor(Date.now() / 1000) + minutes * 60 : null;
  db.prepare(`INSERT INTO ip_blocks(ip, reason, expires_at) VALUES(?,?,?)
    ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at`).run(ip, reason, exp);
  blocked.set(ip, exp ? exp * 1000 : Infinity);
}
function unblockIp(ip) {
  db.prepare('DELETE FROM ip_blocks WHERE ip = ?').run(ip);
  blocked.delete(ip);
}

// ---------- Rate limit ----------
function limitHandler(message) {
  return (req, res) => {
    logActivity(req.session?.userId, 'rate_limited', req.originalUrl, clientIp(req));
    if (req.xhr || req.get('accept')?.includes('json')) return res.status(429).json({ ok: false, message });
    res.status(429).render('errors/error', { code: 429, message });
  };
}

const limiters = {
  login: rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true,
    keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler: limitHandler('Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.'),
  }),
  register: rateLimit({
    windowMs: 60 * 60 * 1000, limit: () => Math.max(1, parseInt(require('../db').getSettings().reg_hour_limit, 10) || 5),
    handler: limitHandler('Bạn đã tạo quá nhiều tài khoản. Thử lại sau 1 giờ.'),
  }),
  buy: rateLimit({
    windowMs: 60 * 1000, limit: 10,
    keyGenerator: (req) => 'u' + (req.session.userId || ipKeyGenerator(req.ip)),
    handler: limitHandler('Bạn mua quá nhanh, vui lòng đợi 1 phút.'),
  }),
  deposit: rateLimit({
    windowMs: 10 * 60 * 1000, limit: 6,
    keyGenerator: (req) => 'u' + (req.session.userId || ipKeyGenerator(req.ip)),
    handler: limitHandler('Bạn tạo quá nhiều yêu cầu nạp. Vui lòng đợi ít phút.'),
  }),
  coupon: rateLimit({
    windowMs: 60 * 1000, limit: 15,
    handler: limitHandler('Bạn thử mã quá nhiều lần.'),
  }),
  webhook: rateLimit({ windowMs: 60 * 1000, limit: 120 }),
  otp: rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler: limitHandler('Bạn nhập mã quá nhiều lần. Vui lòng thử lại sau 15 phút.'),
  }),
  forgot: rateLimit({
    windowMs: 60 * 60 * 1000, limit: 6, keyGenerator: (req) => ipKeyGenerator(req.ip),
    handler: limitHandler('Bạn yêu cầu đặt lại mật khẩu quá nhiều lần. Vui lòng thử lại sau 1 giờ.'),
  }),
};

// ---------- Honeypot: form có ô ẩn "website", bot điền vào sẽ bị chặn ----------
function honeypot(req, res, next) {
  if (req.body && req.body.website) {
    const ip = clientIp(req);
    logActivity(null, 'honeypot', req.originalUrl, ip);
    blockIp(ip, 60, 'Honeypot bot');
    return res.status(400).render('errors/error', { code: 400, message: 'Yêu cầu không hợp lệ.' });
  }
  next();
}

// ---------- Nạp user hiện tại ----------
const userStmt = db.prepare('SELECT id, username, email, email_verified_at, twofa_enabled, role, balance, status, ban_reason, total_deposit, total_spent, created_at, staff, staff_name FROM users WHERE id = ?');
function loadUser(req, res, next) {
  res.locals.user = null;
  if (req.session.userId) {
    const u = userStmt.get(req.session.userId);
    if (!u || u.status === 'banned') {
      return req.session.regenerate(() => {
        req.flash('error', u ? `Tài khoản đã bị khóa${u.ban_reason ? ': ' + u.ban_reason : ''}` : 'Phiên đăng nhập không hợp lệ');
        res.redirect('/login');
      });
    }
    req.user = u;
    res.locals.user = u;
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    req.flash('error', 'Vui lòng đăng nhập để tiếp tục');
    return res.redirect('/login');
  }
  next();
}

const ADMIN_IDLE_MS = 60 * 60 * 1000; // admin không thao tác 60 phút -> tự đăng xuất
function requireAdmin(req, res, next) {
  const ip = clientIp(req);
  if (config.admin.ipWhitelist.length && !config.admin.ipWhitelist.includes(ip)) {
    logActivity(req.user?.id, 'admin_ip_denied', req.originalUrl, ip);
    return res.status(404).render('errors/error', { code: 404, message: 'Không tìm thấy trang' });
  }
  if (!req.user || req.user.role !== 'admin' || !req.session.isAdmin) {
    if (req.user) logActivity(req.user.id, 'admin_denied', req.originalUrl, ip);
    // Trả 404 để không lộ sự tồn tại của trang admin
    return res.status(404).render('errors/error', { code: 404, message: 'Không tìm thấy trang' });
  }
  const last = req.session.adminLastSeen || 0;
  if (last && Date.now() - last > ADMIN_IDLE_MS) {
    return req.session.regenerate(() => {
      req.flash('error', 'Phiên quản trị đã hết hạn, vui lòng đăng nhập lại');
      res.redirect('/login');
    });
  }
  req.session.adminLastSeen = Date.now();
  next();
}

// ---------- Flash message đơn giản ----------
function flash(req, res, next) {
  req.flash = (type, msg) => {
    req.session.flash = req.session.flash || [];
    req.session.flash.push({ type, msg });
  };
  res.locals.flashes = req.session.flash || [];
  delete req.session.flash;
  next();
}

module.exports = {
  csrf, verifyCsrf, ipBlock, blockIp, unblockIp, limiters, honeypot, loadUser, requireLogin, requireAdmin, flash,
};
