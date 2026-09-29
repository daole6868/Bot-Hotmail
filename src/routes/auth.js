'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { db, logActivity, getSettings, bumpStat } = require('../db');
const { limiters, honeypot, blockIp } = require('../middleware/security');
const captcha = require('../utils/captcha');
const { clientIp, str } = require('../utils/helpers');
const sec = require('../services/account-security');
const mailer = require('../services/mailer');
const SQLiteStore = require('../session-store');

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

  const opts = { remember: !!req.body.remember, returnTo: req.session.returnTo };
  // Xác minh 2 lớp: thiết bị lạ / quá lâu chưa xác minh -> gửi mã 6 số về email
  if (sec.needsOtp(user, req, res)) {
    const wait = sec.otpCooldown(user.id, 'login');
    if (!wait) {
      const r = await sec.sendOtp(user, 'login', { ip });
      if (!r.ok) return fail('Không gửi được mã xác minh tới email. Vui lòng thử lại sau hoặc liên hệ shop.');
    }
    req.session.loginFails = 0;
    req.session.pending2fa = { uid: user.id, at: Date.now(), sends: 1, ...opts };
    logActivity(user.id, 'login_2fa_sent', null, ip);
    return req.session.save(() => res.redirect('/login/verify'));
  }
  finishLogin(req, res, user, opts);
});

// Hoàn tất đăng nhập: tạo session mới (chống session fixation), cập nhật lần đăng nhập, chuyển trang
function finishLogin(req, res, user, { remember, returnTo }) {
  const ip = clientIp(req);
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('errors/error', { code: 500, message: 'Lỗi phiên đăng nhập' });
    req.session.userId = user.id;
    req.session.isAdmin = user.role === 'admin';
    if (req.session.isAdmin) {
      req.session.adminLastSeen = Date.now();
      req.session.cookie.maxAge = 8 * 3600 * 1000; // phiên admin tối đa 8h
    } else if (remember) {
      req.session.cookie.maxAge = 30 * 86400 * 1000;
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), ip, user.id);
    logActivity(user.id, user.role === 'admin' ? 'admin_login' : 'login', null, ip);
    req.session.save(() => {
      // Đúng tài khoản admin -> vào thẳng trang quản trị
      if (user.role === 'admin') return res.redirect('/admin');
      const safe = returnTo && /^\/(?!\/)[\w\-/?=&.%]*$/.test(returnTo) ? returnTo : '/';
      res.redirect(safe);
    });
  });
}

// ---------- Bước 2 đăng nhập: nhập mã gửi qua email ----------
function pendingUser(req) {
  const p = req.session.pending2fa;
  if (!p || Date.now() - p.at > 15 * 60 * 1000) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.uid);
  return u && u.status !== 'banned' ? { p, u } : null;
}
const renderVerify = (req, res, u, extra = {}) => res.render('pages/login-verify', {
  title: 'Xác minh đăng nhập', email: sec.maskEmail(u.email), wait: sec.otpCooldown(u.id, 'login'), ...extra,
});

router.get('/login/verify', (req, res) => {
  const pu = pendingUser(req);
  if (!pu) { delete req.session.pending2fa; return res.redirect('/login'); }
  renderVerify(req, res, pu.u);
});

router.post('/login/verify', limiters.otp, (req, res) => {
  const pu = pendingUser(req);
  if (!pu) { delete req.session.pending2fa; req.flash('error', 'Phiên xác minh đã hết hạn, vui lòng đăng nhập lại'); return res.redirect('/login'); }
  const { p, u } = pu;
  const v = sec.verifyOtp(u.id, 'login', req.body.code);
  if (!v.ok) {
    logActivity(u.id, 'login_2fa_fail', null, clientIp(req));
    res.status(400); return renderVerify(req, res, u, { error: v.message });
  }
  const known = sec.isKnownDevice(u.id, req, res);
  if (req.body.trust === '1') sec.trustDevice(u, req, res);
  if (!u.email_verified_at) db.prepare('UPDATE users SET email_verified_at = unixepoch() WHERE id = ?').run(u.id);
  if (!known) mailer.sendLater(u.email, 'login_alert', { username: u.username, ip: clientIp(req), ua: req.get('user-agent'), at: Math.floor(Date.now() / 1000) });
  finishLogin(req, res, u, p);
});

router.post('/login/resend', limiters.otp, async (req, res) => {
  const pu = pendingUser(req);
  if (!pu) return res.redirect('/login');
  const { p, u } = pu;
  const wait = sec.otpCooldown(u.id, 'login');
  if (wait > 0 || p.sends >= 5) return renderVerify(req, res, u, { error: p.sends >= 5 ? 'Đã gửi lại quá nhiều lần, vui lòng đăng nhập lại sau' : `Vui lòng chờ ${wait} giây rồi gửi lại` });
  const r = await sec.sendOtp(u, 'login', { ip: clientIp(req) });
  p.sends += 1;
  renderVerify(req, res, u, r.ok ? { info: 'Đã gửi mã mới tới email của bạn' } : { error: 'Không gửi được email, vui lòng thử lại sau' });
});

// ---------- Quên mật khẩu ----------
router.get('/forgot', (req, res) => {
  if (req.user) return res.redirect('/user/security');
  res.render('pages/forgot', { title: 'Quên mật khẩu', form: {}, ready: mailer.isReady() });
});

router.post('/forgot', limiters.forgot, honeypot, async (req, res) => {
  const ip = clientIp(req);
  const q = str(req.body.email, 100).toLowerCase();
  const render = (extra) => res.render('pages/forgot', { title: 'Quên mật khẩu', form: { email: q }, ready: mailer.isReady(), ...extra });
  if (!mailer.isReady()) return render({ error: 'Shop chưa bật gửi email. Vui lòng liên hệ admin để lấy lại mật khẩu.' });
  if (!q) return render({ error: 'Vui lòng nhập email hoặc tên đăng nhập' });
  if (!(await captcha.check(req))) return render({ error: 'Xác minh captcha không đúng' });
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR username = ?) AND status = ?').get(q, q, 'active');
  if (user && user.email) {
    const recent = db.prepare('SELECT COUNT(*) c FROM password_resets WHERE user_id = ? AND created_at > ?').get(user.id, Math.floor(Date.now() / 1000) - 3600).c;
    if (recent < 3) {
      const token = sec.createResetToken(user.id, ip);
      await mailer.send(user.email, 'reset', { username: user.username, url: `${require('../config').baseUrl}/reset/${token}` });
      logActivity(user.id, 'password_reset_request', null, ip);
    }
  }
  // Luôn trả cùng 1 thông báo -> không dò được email nào có tài khoản
  render({ sent: true });
});

router.get('/reset/:token', (req, res) => {
  const r = sec.findReset(req.params.token);
  res.set('Referrer-Policy', 'no-referrer').render('pages/reset', { title: 'Đặt lại mật khẩu', valid: !!r, token: req.params.token });
});

router.post('/reset/:token', limiters.forgot, async (req, res) => {
  const r = sec.findReset(req.params.token);
  const render = (error) => res.status(400).render('pages/reset', { title: 'Đặt lại mật khẩu', valid: !!r, token: req.params.token, error });
  if (!r) return render('Link đã hết hạn hoặc đã được sử dụng');
  const password = String(req.body.password || '');
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) return render('Mật khẩu 8-72 ký tự, gồm cả chữ và số');
  if (password !== req.body.password2) return render('Mật khẩu nhập lại không khớp');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.user_id);
  if (!user) return render('Tài khoản không tồn tại');
  const ip = clientIp(req);
  db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, unixepoch()) WHERE id = ?')
    .run(await bcrypt.hash(password, 12), user.id);
  sec.useReset(r.id);
  SQLiteStore.destroyUser(user.id); // đăng xuất mọi thiết bị
  logActivity(user.id, 'password_reset_done', null, ip);
  mailer.sendLater(user.email, 'password_changed', { username: user.username, ip, at: Math.floor(Date.now() / 1000), byReset: true });
  req.flash('success', 'Đã đặt lại mật khẩu. Hãy đăng nhập bằng mật khẩu mới.');
  res.redirect('/login');
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  const r = pendingReg(req);
  res.render('pages/register', { title: 'Đăng ký', form: r ? { username: r.username, email: r.email } : {} });
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
  if (!form.email) return render('Vui lòng nhập email');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email)) return render('Email không hợp lệ');
  if (password.length < 8 || password.length > 72 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return render('Mật khẩu 8-72 ký tự, gồm cả chữ và số');
  }
  if (password !== req.body.password2) return render('Mật khẩu nhập lại không khớp');
  if (!req.body.agree) return render('Bạn cần đồng ý điều khoản');

  const dup = db.prepare('SELECT username, email FROM users WHERE username = ? OR (email IS NOT NULL AND email = ?)').get(form.username, form.email);
  if (dup) return render(dup.username.toLowerCase() === form.username.toLowerCase() ? 'Tên đăng nhập đã tồn tại' : 'Email đã được sử dụng');

  // Giới hạn số tài khoản / IP / ngày (chống clone)
  const sameIp = db.prepare('SELECT COUNT(*) n FROM users WHERE register_ip = ? AND created_at > ?').get(ip, Math.floor(Date.now() / 1000) - 86400).n;
  if (sameIp >= 3) return render('IP của bạn đã tạo quá nhiều tài khoản hôm nay');

  const hash = await bcrypt.hash(password, 12);
  // Shop đã bật gửi email -> bắt buộc nhập mã 6 số gửi về email rồi mới tạo tài khoản
  if (mailer.isReady(s)) {
    const reg = { username: form.username, email: form.email, hash, at: Date.now(), sends: 1, otp: sec.createRegOtp(form.email) };
    const r = await mailer.send(form.email, 'otp', { code: reg.otp.code, username: form.username, purpose: 'register', ip });
    if (!r.ok) return render('Không gửi được mã tới email này, vui lòng kiểm tra lại địa chỉ email');
    delete reg.otp.code;
    req.session.pendingReg = reg;
    return req.session.save(() => res.redirect('/register/verify'));
  }
  createAccount(req, res, { username: form.username, email: form.email, hash }, false);
});

function createAccount(req, res, { username, email, hash }, verified) {
  const ip = clientIp(req);
  let id;
  try {
    id = db.prepare(`INSERT INTO users(username, email, password_hash, role, register_ip, email_verified_at, last_login_at, last_login_ip)
      VALUES(?,?,?,'user',?,?,unixepoch(),?)`).run(username, email || null, hash, ip, verified ? Math.floor(Date.now() / 1000) : null, ip).lastInsertRowid;
  } catch (e) {
    if (!/UNIQUE/.test(e.message)) throw e;
    req.flash('error', 'Tên đăng nhập hoặc email vừa được người khác sử dụng, vui lòng đăng ký lại');
    return res.redirect('/register');
  }
  bumpStat('new_users', 1);
  logActivity(id, 'register', null, ip);
  if (verified) sec.trustDevice({ id }, req, res); // vừa nhập đúng mã trên thiết bị này -> thiết bị tin cậy
  if (email) mailer.sendLater(email, 'welcome', { username });

  req.session.regenerate(() => {
    req.session.userId = id;
    req.session.isAdmin = false;
    req.flash('success', verified ? 'Đăng ký thành công! Email đã được xác minh, chào mừng bạn.' : 'Đăng ký thành công! Chào mừng bạn.');
    req.session.save(() => res.redirect('/'));
  });
}

// ---------- Bước 2 đăng ký: nhập mã gửi tới email ----------
function pendingReg(req) {
  const r = req.session.pendingReg;
  if (!r || Date.now() - r.at > 30 * 60 * 1000) { delete req.session.pendingReg; return null; }
  return r;
}
const regWait = (r) => Math.max(0, (r.otp?.sentAt || 0) + 60 - Math.floor(Date.now() / 1000));
const renderRegVerify = (req, res, r, extra = {}) => res.render('pages/register-verify', {
  title: 'Xác minh email đăng ký', email: r.email, wait: regWait(r), ...extra,
});

router.get('/register/verify', (req, res) => {
  const r = pendingReg(req);
  if (!r) return res.redirect('/register');
  renderRegVerify(req, res, r);
});

router.post('/register/verify', limiters.otp, (req, res) => {
  const r = pendingReg(req);
  if (!r) { req.flash('error', 'Phiên đăng ký đã hết hạn, vui lòng đăng ký lại'); return res.redirect('/register'); }
  const v = sec.verifyRegOtp(r, req.body.code);
  if (!v.ok) { res.status(400); return renderRegVerify(req, res, r, { error: v.message }); }
  delete req.session.pendingReg;
  createAccount(req, res, r, true);
});

router.post('/register/resend', limiters.otp, async (req, res) => {
  const r = pendingReg(req);
  if (!r) return res.redirect('/register');
  const wait = regWait(r);
  if (wait > 0 || r.sends >= 5) return renderRegVerify(req, res, r, { error: r.sends >= 5 ? 'Đã gửi lại quá nhiều lần, vui lòng đăng ký lại sau' : `Vui lòng chờ ${wait} giây rồi gửi lại` });
  const otp = sec.createRegOtp(r.email);
  const m = await mailer.send(r.email, 'otp', { code: otp.code, username: r.username, purpose: 'register', ip: clientIp(req) });
  if (!m.ok) return renderRegVerify(req, res, r, { error: 'Không gửi được email, vui lòng thử lại sau' });
  delete otp.code;
  r.otp = otp; r.sends += 1;
  renderRegVerify(req, res, r, { info: 'Đã gửi mã mới tới email của bạn' });
});

router.post('/register/cancel', (req, res) => { delete req.session.pendingReg; res.redirect('/register'); });

router.post('/logout', (req, res) => {
  const uid = req.session.userId;
  req.session.destroy(() => {
    if (uid) logActivity(uid, 'logout');
    res.clearCookie('sid');
    res.redirect('/');
  });
});

module.exports = router;
