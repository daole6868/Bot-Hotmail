'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logActivity, getSettings } = require('../db');
const { requireLogin, limiters } = require('../middleware/security');
const { createDeposit, cancelDeposit, limits } = require('../services/deposit');
const maintenance = require('../services/maintenance');
const { decrypt } = require('../utils/crypto');
const { paginate, toInt, str, clientIp } = require('../utils/helpers');
const SQLiteStore = require('../session-store');
const sec = require('../services/account-security');
const mailer = require('../services/mailer');

const GMAIL = /^[a-z0-9](?:[a-z0-9.+_-]{0,62}[a-z0-9])?@(gmail|googlemail)\.com$/i; // khách chỉ dùng Gmail
const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  const uid = req.user.id;
  const stats = {
    orders: db.prepare("SELECT COUNT(*) c FROM v_orders WHERE user_id = ? AND status = 'completed'").get(uid).c,
  };
  const recentOrders = db.prepare('SELECT order_code, product_title, total, status, created_at FROM v_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 5').all(uid);
  res.render('user/profile', { title: 'Tài khoản của tôi', stats, recentOrders, tab: 'profile' });
});

router.get('/orders', (req, res) => {
  const result = paginate(db, {
    select: 'order_code, product_title, game_name, price, discount, total, coupon_code, status, created_at, archived',
    from: 'v_orders', where: 'WHERE user_id = ?', params: [req.user.id],
    order: 'ORDER BY created_at DESC', page: toInt(req.query.page, 1, 1), perPage: 15,
  });
  res.render('user/orders', { title: 'Lịch sử mua hàng', result, query: {}, tab: 'orders' });
});

router.get('/orders/:code', (req, res, next) => {
  const o = db.prepare('SELECT * FROM v_orders WHERE order_code = ? AND user_id = ?').get(str(req.params.code, 30), req.user.id);
  if (!o) return next();
  o.delivered = require('../utils/helpers').formatDelivered(decrypt(o.delivered_enc));
  res.set('Cache-Control', 'no-store');
  res.render('user/order-detail', { title: `Đơn hàng ${o.order_code}`, o, tab: 'orders' });
});

// ---------- Bảo mật: email, xác minh 2 lớp, thiết bị tin cậy ----------
router.get('/security', (req, res) => {
  const s = getSettings();
  const devices = db.prepare('SELECT * FROM trusted_devices WHERE user_id = ? ORDER BY last_seen_at DESC').all(req.user.id);
  res.set('Cache-Control', 'no-store').render('user/security', {
    title: 'Bảo mật tài khoản', tab: 'security', devices, currentDevice: sec.currentDeviceHash(req, res),
    ready: mailer.isReady(s), mode: req.user.role === 'admin' ? (s.twofa_admin !== '0' ? 'required' : 'off') : (s.twofa_mode_user || 'optional'),
    active: sec.twofaApplies(req.user, s), days: sec.twofaDays(s),
    pendingEmail: req.session.pendingEmail || null, wait: req.session.pendingEmail ? sec.otpCooldown(req.user.id, 'email') : 0,
  });
});
const secBack = (req, res, type, msg) => { if (msg) req.flash(type, msg); res.redirect('/user/security'); };
const checkPassword = async (req) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  return bcrypt.compare(String(req.body.password || ''), u.password_hash);
};

// Thêm / đổi email (hoặc xác minh email hiện tại): gửi mã 6 số tới email đó
router.post('/email', limiters.otp, async (req, res) => {
  if (!mailer.isReady()) return secBack(req, res, 'error', 'Shop chưa bật gửi email');
  const email = str(req.body.email, 100).toLowerCase() || req.user.email;
  if (!email || !(req.user.role === 'admin' ? /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/ : GMAIL).test(email)) return secBack(req, res, 'error', 'Email không hợp lệ');
  if (!(await checkPassword(req))) return secBack(req, res, 'error', 'Mật khẩu không đúng');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) return secBack(req, res, 'error', 'Email đã được tài khoản khác sử dụng');
  const wait = sec.otpCooldown(req.user.id, 'email');
  if (wait > 0) return secBack(req, res, 'error', `Vui lòng chờ ${wait} giây rồi gửi lại mã`);
  const r = await sec.sendOtp(req.user, 'email', { email });
  if (!r.ok) return secBack(req, res, 'error', 'Không gửi được email, kiểm tra lại địa chỉ hoặc thử lại sau');
  req.session.pendingEmail = email;
  logActivity(req.user.id, 'email_verify_sent', sec.maskEmail(email), clientIp(req));
  secBack(req, res, 'success', `Đã gửi mã xác minh tới ${sec.maskEmail(email)}`);
});

router.post('/email/verify', limiters.otp, (req, res) => {
  const email = req.session.pendingEmail;
  if (!email) return secBack(req, res, 'error', 'Không có yêu cầu xác minh email nào');
  const v = sec.verifyOtp(req.user.id, 'email', req.body.code);
  if (!v.ok) { if (v.expired) delete req.session.pendingEmail; return secBack(req, res, 'error', v.message); }
  if (v.row.target_email !== email) return secBack(req, res, 'error', 'Mã không khớp với email đang xác minh');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) return secBack(req, res, 'error', 'Email đã được tài khoản khác sử dụng');
  const old = req.user.email;
  db.prepare('UPDATE users SET email = ?, email_verified_at = unixepoch() WHERE id = ?').run(email, req.user.id);
  delete req.session.pendingEmail;
  sec.trustDevice(req.user, req, res); // vừa nhập đúng mã trên thiết bị này -> coi là thiết bị tin cậy
  logActivity(req.user.id, old && old !== email ? 'email_changed' : 'email_verified', sec.maskEmail(email), clientIp(req));
  secBack(req, res, 'success', old && old.toLowerCase() !== email ? 'Đã đổi email thành công' : 'Đã xác minh email thành công');
});

router.post('/email/cancel', (req, res) => { delete req.session.pendingEmail; secBack(req, res); });

// Bật / tắt xác minh 2 lớp (khi admin để chế độ "khách tự chọn")
router.post('/2fa', limiters.otp, async (req, res) => {
  const s = getSettings();
  if (req.user.role === 'admin' || s.twofa_mode_user !== 'optional') return secBack(req, res, 'error', 'Chế độ xác minh 2 lớp do shop quy định');
  if (!(await checkPassword(req))) return secBack(req, res, 'error', 'Mật khẩu không đúng');
  const on = req.body.enable === '1';
  if (on && !(req.user.email && req.user.email_verified_at)) return secBack(req, res, 'error', 'Cần xác minh email trước khi bật xác minh 2 lớp');
  db.prepare('UPDATE users SET twofa_enabled = ? WHERE id = ?').run(on ? 1 : 0, req.user.id);
  if (on) sec.trustDevice(req.user, req, res); // thiết bị đang dùng coi như đã xác minh
  logActivity(req.user.id, on ? 'twofa_on' : 'twofa_off', null, clientIp(req));
  secBack(req, res, 'success', on ? 'Đã bật xác minh 2 lớp' : 'Đã tắt xác minh 2 lớp');
});

router.post('/devices/:id/delete', (req, res) => {
  db.prepare('DELETE FROM trusted_devices WHERE id = ? AND user_id = ?').run(toInt(req.params.id), req.user.id);
  logActivity(req.user.id, 'device_removed', req.params.id, clientIp(req));
  secBack(req, res, 'success', 'Đã xóa thiết bị. Lần đăng nhập sau trên thiết bị đó sẽ phải nhập mã xác minh.');
});
router.post('/devices/clear', (req, res) => {
  db.prepare('DELETE FROM trusted_devices WHERE user_id = ?').run(req.user.id);
  SQLiteStore.destroyUser(req.user.id, req.sessionID); // đăng xuất mọi thiết bị khác
  logActivity(req.user.id, 'devices_cleared', null, clientIp(req));
  secBack(req, res, 'success', 'Đã xóa mọi thiết bị tin cậy và đăng xuất các thiết bị khác.');
});

// ---------- Nạp tiền ----------
router.get('/deposit', (req, res) => {
  maintenance.expireDeposits(); // đơn quá thời gian chờ -> hủy ngay, không đợi lịch chạy
  const s = getSettings();
  const expireSec = maintenance.depositExpireMinutes() * 60;
  const pending = db.prepare("SELECT * FROM deposits WHERE user_id = ? AND status = 'pending' ORDER BY id DESC").all(req.user.id);
  const history = paginate(db, {
    select: '*', from: 'v_deposits', where: "WHERE user_id = ? AND status != 'pending'", params: [req.user.id],
    order: 'ORDER BY created_at DESC', page: toInt(req.query.page, 1, 1), perPage: 10,
  });
  const active = req.query.code ? pending.find((d) => d.code === req.query.code) : null;
  pending.forEach((d) => { d.expires_at = d.created_at + expireSec; });
  res.set('Cache-Control', 'no-store');
  res.render('user/deposit', { title: 'Nạp tiền', s, pending, history, active, limits: limits(), query: {}, tab: 'deposit',
    expireMinutes: expireSec / 60, now: Math.floor(Date.now() / 1000) });
});

router.post('/deposit', limiters.deposit, (req, res) => {
  const amount = toInt(req.body.amount, 0, 0);
  maintenance.expireDeposits(); // không tái sử dụng đơn đã quá hạn
  const r = createDeposit(req.user.id, amount);
  if (!r.ok) {
    req.flash('error', r.message);
    return res.redirect('/user/deposit');
  }
  logActivity(req.user.id, 'deposit_create', `${r.deposit.code} ${amount}`, clientIp(req));
  res.redirect('/user/deposit?code=' + encodeURIComponent(r.deposit.code));
});

router.post('/deposit/:id/cancel', (req, res) => {
  maintenance.expireDeposits();
  const ok = cancelDeposit(toInt(req.params.id), req.user.id);
  req.flash(ok ? 'success' : 'error', ok ? 'Đã hủy yêu cầu nạp' : 'Không thể hủy yêu cầu này');
  res.redirect('/user/deposit');
});

// Trạng thái đơn nạp (trang nạp tự kiểm tra định kỳ)
router.get('/deposit/:code/status', (req, res) => {
  maintenance.expireDeposits();
  const d = db.prepare('SELECT status, received FROM deposits WHERE code = ? AND user_id = ?').get(str(req.params.code, 20), req.user.id);
  res.json(d ? { ok: true, status: d.status, received: d.received } : { ok: false });
});

// ---------- Biến động số dư ----------
router.get('/balance', (req, res) => {
  const result = paginate(db, {
    select: '*', from: 'balance_logs', where: 'WHERE user_id = ?', params: [req.user.id],
    order: 'ORDER BY id DESC', page: toInt(req.query.page, 1, 1), perPage: 20,
  });
  res.render('user/balance', { title: 'Biến động số dư', result, query: {}, tab: 'balance' });
});

// ---------- Đổi mật khẩu ----------
router.get('/password', (req, res) => res.redirect('/user/security#password')); // trang cũ -> đã gộp vào Bảo mật

router.post('/password', limiters.login, async (req, res) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const { current = '', password = '', password2 = '' } = req.body;
  const back = (type, msg) => { req.flash(type, msg); res.redirect(req.user.role === 'admin' && req.body.from !== 'security' ? '/admin/profile' : '/user/security' + (type === 'error' ? '#password' : '')); };
  if (!(await bcrypt.compare(String(current), u.password_hash))) return back('error', 'Mật khẩu hiện tại không đúng');
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return back('error', 'Mật khẩu mới 8-72 ký tự, gồm chữ và số');
  if (password !== password2) return back('error', 'Mật khẩu nhập lại không khớp');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 12), req.user.id);
  logActivity(req.user.id, 'change_password', null, clientIp(req));
  mailer.sendLater(req.user.email, 'password_changed', { username: req.user.username, ip: clientIp(req), at: Math.floor(Date.now() / 1000) });
  // Đăng xuất các thiết bị khác
  new SQLiteStore().destroyUser(req.user.id);
  req.session.regenerate(() => {
    req.session.userId = req.user.id;
    req.session.isAdmin = req.user.role === 'admin';
    req.session.adminLastSeen = Date.now();
    back('success', 'Đổi mật khẩu thành công. Các thiết bị khác đã bị đăng xuất.');
  });
});

module.exports = router;
