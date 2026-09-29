'use strict';
/**
 * Xác minh 2 lớp qua email (mã 6 số), thiết bị tin cậy, link đặt lại mật khẩu.
 * Mã & token chỉ lưu dạng băm (HMAC) -> lộ database cũng không dùng được.
 */
const crypto = require('crypto');
const { db, getSettings } = require('../db');
const mailer = require('./mailer');
const config = require('../config');

const OTP_TTL = 10 * 60;          // mã có hiệu lực 10 phút
const OTP_MAX_TRIES = 5;          // sai 5 lần -> hủy mã
const RESET_TTL = 30 * 60;        // link đặt lại mật khẩu 30 phút
const DEVICE_COOKIE = 'did';
const nowS = () => Math.floor(Date.now() / 1000);
const hmac = (v) => crypto.createHmac('sha256', config.sessionSecret).update(String(v)).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- Mã xác minh 6 số ----------
function createOtp(userId, purpose, targetEmail = null) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  db.prepare('UPDATE email_otps SET used_at = ? WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(nowS(), userId, purpose);
  db.prepare('INSERT INTO email_otps(user_id, purpose, code_hash, target_email, expires_at) VALUES(?,?,?,?,?)')
    .run(userId, purpose, hmac(`${userId}:${purpose}:${code}`), targetEmail, nowS() + OTP_TTL);
  return code;
}
/** -> { ok, message, row } */
function verifyOtp(userId, purpose, code) {
  code = String(code || '').replace(/\D/g, '');
  const row = db.prepare('SELECT * FROM email_otps WHERE user_id = ? AND purpose = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1').get(userId, purpose);
  if (!row || row.expires_at < nowS()) return { ok: false, expired: true, message: 'Mã đã hết hạn, hãy bấm Gửi lại mã' };
  if (row.attempts >= OTP_MAX_TRIES) return { ok: false, expired: true, message: 'Nhập sai quá nhiều lần, hãy gửi lại mã mới' };
  if (code.length !== 6 || !safeEq(hmac(`${userId}:${purpose}:${code}`), row.code_hash)) {
    db.prepare('UPDATE email_otps SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = OTP_MAX_TRIES - row.attempts - 1;
    return { ok: false, message: left > 0 ? `Mã không đúng, còn ${left} lần thử` : 'Nhập sai quá nhiều lần, hãy gửi lại mã mới', expired: left <= 0 };
  }
  db.prepare('UPDATE email_otps SET used_at = ? WHERE id = ?').run(nowS(), row.id);
  return { ok: true, row };
}
/** Chống spam gửi mã: tối thiểu 60 giây / lần, tối đa 8 mã / giờ cho 1 tài khoản */
function otpCooldown(userId, purpose) {
  const last = db.prepare('SELECT created_at FROM email_otps WHERE user_id = ? AND purpose = ? ORDER BY id DESC LIMIT 1').get(userId, purpose);
  const wait = last ? last.created_at + 60 - nowS() : 0;
  if (wait > 0) return wait;
  const n = db.prepare('SELECT COUNT(*) c FROM email_otps WHERE user_id = ? AND created_at > ?').get(userId, nowS() - 3600).c;
  return n >= 8 ? 600 : 0;
}
async function sendOtp(user, purpose, { email, ip } = {}) {
  const to = email || user.email;
  const code = createOtp(user.id, purpose, to);
  return mailer.send(to, 'otp', { code, username: user.username, purpose, ip });
}

// ---------- Thiết bị tin cậy ----------
function deviceId(req, res) {
  let id = (req.headers.cookie || '').match(/(?:^|;\s*)did=([a-f0-9]{48})/)?.[1];
  if (!id) {
    id = crypto.randomBytes(24).toString('hex');
    res.cookie(DEVICE_COOKIE, id, { httpOnly: true, sameSite: 'lax', maxAge: 400 * 86400 * 1000, secure: config.isProd && config.baseUrl.startsWith('https') });
  }
  return id;
}
const deviceHash = (id) => hmac('device:' + id);

/** Cài đặt xác minh 2 lớp đang áp dụng cho 1 tài khoản? (chưa có SMTP / chưa có email -> không áp dụng) */
function twofaApplies(user, s = getSettings()) {
  if (!mailer.isReady(s) || !user.email) return false;
  if (user.role === 'admin') return s.twofa_admin !== '0';
  if (s.twofa_mode_user === 'required') return true;
  if (s.twofa_mode_user === 'optional') return !!user.twofa_enabled;
  return false;
}
const twofaDays = (s = getSettings()) => Math.min(365, Math.max(1, parseInt(s.twofa_days, 10) || 30));

/** Cần hỏi mã không: thiết bị lạ, thiết bị quá N ngày chưa xác minh, hoặc tài khoản quá N ngày không đăng nhập */
function needsOtp(user, req, res) {
  const s = getSettings();
  if (!twofaApplies(user, s)) return false;
  const limit = nowS() - twofaDays(s) * 86400;
  const dev = db.prepare('SELECT * FROM trusted_devices WHERE user_id = ? AND device_hash = ?').get(user.id, deviceHash(deviceId(req, res)));
  if (!dev || dev.last_verified_at < limit) return true;
  if (user.last_login_at && user.last_login_at < limit) return true;
  db.prepare('UPDATE trusted_devices SET last_seen_at = ?, ip = ? WHERE id = ?').run(nowS(), req.ip, dev.id);
  return false;
}
function trustDevice(user, req, res) {
  db.prepare(`INSERT INTO trusted_devices(user_id, device_hash, user_agent, ip) VALUES(?,?,?,?)
    ON CONFLICT(user_id, device_hash) DO UPDATE SET last_verified_at = unixepoch(), last_seen_at = unixepoch(), ip = excluded.ip, user_agent = excluded.user_agent`)
    .run(user.id, deviceHash(deviceId(req, res)), String(req.get('user-agent') || '').slice(0, 200), req.ip);
}
const isKnownDevice = (userId, req, res) => !!db.prepare('SELECT 1 FROM trusted_devices WHERE user_id = ? AND device_hash = ?').get(userId, deviceHash(deviceId(req, res)));
const currentDeviceHash = (req, res) => deviceHash(deviceId(req, res));

// ---------- Đặt lại mật khẩu ----------
function createResetToken(userId, ip) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(nowS(), userId);
  db.prepare('INSERT INTO password_resets(user_id, token_hash, expires_at, ip) VALUES(?,?,?,?)').run(userId, hmac('reset:' + token), nowS() + RESET_TTL, ip);
  return token;
}
function findReset(token) {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(String(token || ''))) return null;
  const r = db.prepare('SELECT * FROM password_resets WHERE token_hash = ?').get(hmac('reset:' + token));
  return r && !r.used_at && r.expires_at > nowS() ? r : null;
}
const useReset = (id) => db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(nowS(), id);
const maskEmail = (e) => String(e || '').replace(/^(.{1,2})[^@]*(@.*)$/, (m, a, b) => a + '***' + b);

module.exports = {
  createOtp, verifyOtp, otpCooldown, sendOtp, twofaApplies, twofaDays, needsOtp, trustDevice, isKnownDevice, currentDeviceHash,
  createResetToken, findReset, useReset, maskEmail, OTP_TTL,
};
