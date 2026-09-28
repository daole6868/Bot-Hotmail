'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logActivity, getSettings, bumpStat } = require('../db');
const { limiters, honeypot, blockIp } = require('../middleware/security');
const captcha = require('../utils/captcha');
const { clientIp, str } = require('../utils/helpers');

const router = express.Router();

const MAX_FAILS = 5;          // sai 5 lần -> khóa tài khoản tạm thời
const LOCK_MINUTES = 15;
const CAPTCHA_AFTER = 2;      // sai 2 lần trong phiên -> bắt nhập captcha
const RESERVED = ['admin', 'administrator', 'root', 'support', 'system', 'mod', 'moderator', 'shop', 'staff'];
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

router.get('/captcha.svg', (req, res) => {
  const c = captcha.create();
  req.session.captcha = c.text;
  req.session.captchaAt = Date.now();
  res.set('Cache-Control', 'no-store').type('image/svg+xml').send(c.svg);
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' && req.session.isAdmin ? '/admin' : '/');
  res.render('pages/login', {
    title: 'Đăng nhập',
    needCaptcha: (req.session.loginFails || 0) >= CAPTCHA_AFTER,
    form: {},
  });
});

router.post('/login', limiters.login, honeypot, async (req, res) => {
  const ip = clientIp(req);
  const username = str(req.body.username, 32);
  const password = String(req.body.password || '').slice(0, 128);
  const needCaptcha = (req.session.loginFails || 0) >= CAPTCHA_AFTER;
  const fail = (msg) => {
    req.session.loginFails = (req.session.loginFails || 0) + 1;
    res.status(400).render('pages/login', {
      title: 'Đăng nhập', error: msg, form: { username },
      needCaptcha: req.session.loginFails >= CAPTCHA_AFTER,
    });
  };

  if (!username || !password) return fail('Vui lòng nhập tài khoản và mật khẩu');
  if (needCaptcha && !(await captcha.check(req))) return fail('Xác minh captcha không đúng');

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  const nowS = Math.floor(Date.now() / 1000);

  if (user && user.locked_until && user.locked_until > nowS) {
    const mins = Math.ceil((user.locked_until - nowS) / 60);
    return fail(`Tài khoản tạm khóa do đăng nhập sai nhiều lần. Thử lại sau ${mins} phút.`);
  }

  // Luôn chạy bcrypt để chống dò tài khoản bằng thời gian phản hồi
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  db.prepare('INSERT INTO login_logs(username, user_id, success, ip, user_agent) VALUES(?,?,?,?,?)')
    .run(username, user?.id || null, ok && user ? 1 : 0, ip, str(req.get('user-agent'), 200));

  if (!user || !ok) {
    if (user) {
      const fails = user.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? nowS + LOCK_MINUTES * 60 : null;
      db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(lock ? 0 : fails, lock, user.id);
      if (lock) logActivity(user.id, 'account_locked', `Sai mật khẩu ${MAX_FAILS} lần`, ip);
    }
    // IP thử sai quá nhiều trong 1 giờ -> chặn IP 1 giờ
    const ipFails = db.prepare('SELECT COUNT(*) n FROM login_logs WHERE ip = ? AND success = 0 AND created_at > ?').get(ip, nowS - 3600).n;
    if (ipFails >= 30) blockIp(ip, 60, 'Brute-force đăng nhập');
    return fail('Sai tài khoản hoặc mật khẩu');
  }
  if (user.status === 'banned') return fail(`Tài khoản đã bị khóa${user.ban_reason ? ': ' + user.ban_reason : ''}`);

  const returnTo = req.session.returnTo;
  // Tạo session mới sau đăng nhập (chống session fixation)
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('errors/error', { code: 500, message: 'Lỗi phiên đăng nhập' });
    req.session.userId = user.id;
    req.session.isAdmin = user.role === 'admin';
    if (req.session.isAdmin) {
      req.session.adminLastSeen = Date.now();
      req.session.cookie.maxAge = 8 * 3600 * 1000; // phiên admin tối đa 8h
    } else if (req.body.remember) {
      req.session.cookie.maxAge = 30 * 86400 * 1000;
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?').run(nowS, ip, user.id);
    logActivity(user.id, user.role === 'admin' ? 'admin_login' : 'login', null, ip);
    req.session.save(() => {
      // Đúng tài khoản admin -> vào thẳng trang quản trị
      if (user.role === 'admin') return res.redirect('/admin');
      const safe = returnTo && /^\/(?!\/)[\w\-/?=&.%]*$/.test(returnTo) ? returnTo : '/';
      res.redirect(safe);
    });
  });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('pages/register', { title: 'Đăng ký', form: {} });
});

router.post('/register', limiters.register, honeypot, async (req, res) => {
  const ip = clientIp(req);
  const s = getSettings();
  const form = { username: str(req.body.username, 32), email: str(req.body.email, 100).toLowerCase() };
  const render = (error) => res.status(400).render('pages/register', { title: 'Đăng ký', error, form });

  if (s.allow_register === '0') return render('Hệ thống đang tạm dừng đăng ký');
  if (!(await captcha.check(req))) return render('Xác minh captcha không đúng');
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{4,20}$/.test(form.username)) return render('Tên đăng nhập 4-20 ký tự, chỉ gồm chữ, số, dấu gạch dưới');
  if (RESERVED.some((r) => form.username.toLowerCase().includes(r))) return render('Tên đăng nhập này không được phép sử dụng');
  if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email)) return render('Email không hợp lệ');
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return render('Mật khẩu 8-72 ký tự, gồm cả chữ và số');
  }
  if (password !== req.body.password2) return render('Mật khẩu nhập lại không khớp');
  if (!req.body.agree) return render('Bạn cần đồng ý điều khoản');

  const dup = db.prepare('SELECT username, email FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)').get(form.username, form.email || null);
  if (dup) return render(dup.username.toLowerCase() === form.username.toLowerCase() ? 'Tên đăng nhập đã tồn tại' : 'Email đã được sử dụng');

  // Giới hạn số tài khoản / IP / ngày (chống clone)
  const sameIp = db.prepare('SELECT COUNT(*) n FROM users WHERE register_ip = ? AND created_at > ?').get(ip, Math.floor(Date.now() / 1000) - 86400).n;
  if (sameIp >= 3) return render('IP của bạn đã tạo quá nhiều tài khoản hôm nay');

  const hash = await bcrypt.hash(password, 12);
  const id = db.prepare("INSERT INTO users(username, email, password_hash, role, register_ip) VALUES(?,?,?,'user',?)")
    .run(form.username, form.email || null, hash, ip).lastInsertRowid;
  bumpStat('new_users', 1);
  logActivity(id, 'register', null, ip);

  req.session.regenerate(() => {
    req.session.userId = id;
    req.session.isAdmin = false;
    req.flash('success', 'Đăng ký thành công! Chào mừng bạn.');
    req.session.save(() => res.redirect('/'));
  });
});

router.post('/logout', (req, res) => {
  const uid = req.session.userId;
  req.session.destroy(() => {
    if (uid) logActivity(uid, 'logout');
    res.clearCookie('sid');
    res.redirect('/');
  });
});

module.exports = router;
