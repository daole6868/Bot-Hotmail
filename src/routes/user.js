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
router.get('/password', (req, res) => res.render('user/password', { title: 'Đổi mật khẩu', tab: 'password' }));

router.post('/password', limiters.login, async (req, res) => {
  const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  const { current = '', password = '', password2 = '' } = req.body;
  const back = (type, msg) => { req.flash(type, msg); res.redirect(req.user.role === 'admin' ? '/admin/profile' : '/user/password'); };
  if (!(await bcrypt.compare(String(current), u.password_hash))) return back('error', 'Mật khẩu hiện tại không đúng');
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return back('error', 'Mật khẩu mới 8-72 ký tự, gồm chữ và số');
  if (password !== password2) return back('error', 'Mật khẩu nhập lại không khớp');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 12), req.user.id);
  logActivity(req.user.id, 'change_password', null, clientIp(req));
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
