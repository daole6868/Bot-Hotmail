'use strict';
/**
 * Chống spam / DDoS ở tầng ứng dụng (sau Cloudflare và Nginx).
 *
 * Thứ tự rẻ -> đắt:
 *  1. early(): chạy TRƯỚC khi đọc phiên. Khách không có cookie phiên -> đếm theo IP ngay.
 *  2. late():  chạy sau khi nạp user. Đã đăng nhập -> đếm theo tài khoản; có cookie nhưng chưa đăng nhập -> đếm theo IP.
 *
 * Khách chưa đăng nhập gửi quá nhiều -> IP bị "yêu cầu đăng nhập" (vẫn vào được trang đăng nhập / đăng ký).
 * Vẫn tiếp tục gửi dồn dập -> khóa hẳn IP (bảng ip_blocks).
 * Đã đăng nhập mà thao tác quá nhanh -> phải chờ N giây (đếm ngược trên trình duyệt).
 * VPS quá tải -> tạm từ chối khách chưa đăng nhập để khách đã đăng nhập vẫn mua / nạp được.
 *
 * Bộ đếm nằm trong bộ nhớ từng bản PM2 (nhanh, không ghi DB mỗi request); giới hạn chia theo số bản.
 * Trạng thái bị chặn lưu ở bảng shield_flags để mọi bản dùng chung.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { monitorEventLoopDelay } = require('perf_hooks');
const { db, getSettings, logActivity } = require('../db');
const { clientIp } = require('../utils/helpers');

// Số bản PM2 đang chạy: request được chia đều cho các bản nên mỗi bản chỉ cần đếm 1/N giới hạn
const INSTANCES = (() => {
  const v = process.env.instances;
  if (v === 'max' || v === '-1' || v === '0') return os.cpus().length;
  return Math.max(1, parseInt(v, 10) || 1);
})();
const perInstance = (n) => Math.max(1, Math.ceil(n / INSTANCES));

// Trang khách bị yêu cầu đăng nhập vẫn vào được
const AUTH_PATH = /^\/(login|register|forgot|reset|captcha\.svg|logout)(\/|$)/;
const MAX_TRACKED = 200000; // giới hạn bộ nhớ bộ đếm khi bị tấn công bằng rất nhiều IP

const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

// ---------- Cấu hình (tính lại khi cache cài đặt đổi) ----------
let cfgSrc = null;
let cfg = null;
function conf() {
  const s = getSettings();
  if (s === cfgSrc && cfg) return cfg;
  cfgSrc = s;
  cfg = {
    on: s.as_enabled !== '0',
    guestLimit: int(s.as_guest_limit, 120, 10, 100000),
    gateMin: int(s.as_gate_minutes, 30, 1, 1440),
    banOn: s.as_ban_enabled !== '0',
    banLimit: int(s.as_ban_limit, 300, 20, 100000),
    banMin: int(s.as_ban_minutes, 60, 1, 10080),
    userLimit: int(s.as_user_limit, 40, 5, 10000),
    cooldown: int(s.as_user_cooldown, 10, 1, 600),
    overloadOn: s.as_overload !== '0',
    overloadMs: int(s.as_overload_ms, 300, 50, 5000),
    emergency: s.as_emergency === '1',
    whitelist: new Set(String(s.as_whitelist || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)),
  };
  return cfg;
}

// ---------- Bộ đếm cửa sổ cố định ----------
function counter(winMs) {
  const b = { win: 0, map: new Map() };
  const hit = (key) => {
    const w = Math.floor(Date.now() / winMs);
    if (w !== b.win) { b.win = w; b.map.clear(); }
    const n = (b.map.get(key) || 0) + 1;
    if (n === 1 && b.map.size >= MAX_TRACKED) return 1; // quá nhiều IP: không theo dõi thêm (lớp quá tải sẽ lo)
    b.map.set(key, n);
    return n;
  };
  hit.reset = (key) => b.map.delete(key);
  return hit;
}
const hitGuest = counter(60 * 1000); // khách: số yêu cầu / phút / IP
const hitUser = counter(10 * 1000);  // đã đăng nhập: số yêu cầu / 10 giây / tài khoản

// ---------- Trạng thái chặn dùng chung (shield_flags) ----------
let flags = new Map(); // key -> hết hạn (ms)
const selFlags = db.prepare('SELECT key, until FROM shield_flags WHERE until > ?');
const upFlag = db.prepare(`INSERT INTO shield_flags(key, until, reason) VALUES(?,?,?)
  ON CONFLICT(key) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_at = unixepoch()`);
const delFlag = db.prepare('DELETE FROM shield_flags WHERE key = ?');
function syncFlags() {
  const m = new Map();
  for (const r of selFlags.all(Math.floor(Date.now() / 1000))) m.set(r.key, r.until * 1000);
  flags = m;
}
function setFlag(key, seconds, reason) {
  const until = Math.floor(Date.now() / 1000) + seconds;
  flags.set(key, until * 1000);
  try { upFlag.run(key, until, reason); } catch { /* DB bận: vẫn chặn trong bộ nhớ */ }
}
function clearFlag(key) { flags.delete(key); delFlag.run(key); }
const flagLeft = (key) => Math.max(0, (flags.get(key) || 0) - Date.now());

// ---------- Đo độ bận (event loop lag) ----------
const lag = { ms: 0, overloadedUntil: 0 };
const hist = monitorEventLoopDelay({ resolution: 20 });
hist.enable();

// ---------- Thống kê cho trang admin (bản hiện tại) ----------
const stats = { since: Date.now(), gated: 0, banned: 0, slowed: 0, shed: 0 };

let timers = false;
function startTimers() {
  if (timers) return;
  timers = true;
  syncFlags();
  setInterval(() => { try { syncFlags(); } catch { /* bỏ qua */ } }, 3000).unref();
  setInterval(() => {
    lag.ms = Math.round(hist.percentile(90) / 1e6);
    hist.reset();
    const c = conf();
    if (c.overloadOn && lag.ms > c.overloadMs) lag.overloadedUntil = Date.now() + 5000;
  }, 1000).unref();
  setInterval(() => { try { db.prepare('DELETE FROM shield_flags WHERE until < unixepoch() - 86400').run(); } catch { /* bỏ qua */ } }, 10 * 60 * 1000).unref();
}
const overloaded = () => Date.now() < lag.overloadedUntil;

// ---------- Phản hồi (nhẹ, không đọc DB, không dựng layout) ----------
const wantsJson = (req) => req.xhr || (req.get('accept') || '').includes('application/json') || req.path.endsWith('.json');
const tpl = {};
function page(name, data) {
  if (!tpl[name]) tpl[name] = ejs.compile(fs.readFileSync(path.join(__dirname, '..', '..', 'views', 'errors', name + '.ejs'), 'utf8'));
  return tpl[name](data);
}
let gateCache = { key: '', html: '' };
function gateResponse(req, res, secondsLeft) {
  res.set('Cache-Control', 'no-store');
  if (secondsLeft) res.set('Retry-After', String(secondsLeft));
  const message = 'Vui lòng đăng nhập để tiếp tục';
  if (wantsJson(req)) return res.status(429).json({ ok: false, login: true, message });
  const s = getSettings();
  const key = (s.site_name || '') + '|' + (s.logo || '') + '|' + req.app.locals.assetV;
  if (gateCache.key !== key) gateCache = { key, html: page('gate', { s, assetV: req.app.locals.assetV }) };
  res.status(429).type('html').send(gateCache.html);
}
function slowResponse(req, res, seconds) {
  const until = Math.floor(Date.now() / 1000) + seconds;
  res.set('Cache-Control', 'no-store');
  res.set('Retry-After', String(seconds));
  // Cookie đọc được bằng JS: mọi tab của khách cùng hiện đếm ngược và khóa thao tác
  res.cookie('slow', String(until), { maxAge: seconds * 1000, sameSite: 'lax', path: '/', httpOnly: false });
  const message = `Bạn đang thao tác quá nhanh, vui lòng chậm lại sau ${seconds} giây`;
  if (wantsJson(req)) return res.status(429).json({ ok: false, slow: seconds, message });
  res.status(429).type('html').send(page('slow', { s: getSettings(), assetV: req.app.locals.assetV, seconds, until, method: req.method }));
}
function overloadResponse(req, res) {
  stats.shed++;
  res.set('Retry-After', '10');
  if (wantsJson(req)) return res.status(503).json({ ok: false, message: 'Hệ thống đang quá tải, vui lòng thử lại sau ít phút' });
  res.status(503).type('text').send('Hệ thống đang quá tải, vui lòng thử lại sau ít phút.');
}

// ---------- Kiểm tra ----------
function checkGuest(req, res, next, ip, c) {
  req.shieldDone = true;
  const n = hitGuest(ip);
  if (c.banOn && n > perInstance(c.banLimit)) {
    if (n === perInstance(c.banLimit) + 1) { // chỉ khóa 1 lần, các request sau đã bị chặn ở ipBlock
      require('../middleware/security').blockIp(ip, c.banMin, 'Tự khóa: gửi quá nhiều yêu cầu');
      logActivity(null, 'shield_ban', `${n} yêu cầu/phút`, ip);
      stats.banned++;
    }
    return res.status(403).type('text').send('IP của bạn đã bị tạm khóa do gửi quá nhiều yêu cầu.');
  }
  const auth = AUTH_PATH.test(req.path);
  if (overloaded() && !auth) return overloadResponse(req, res);
  let left = flagLeft('g:' + ip);
  if (!left && n > perInstance(c.guestLimit)) {
    setFlag('g:' + ip, c.gateMin * 60, `${n} yêu cầu/phút`);
    logActivity(null, 'shield_gate', `${n} yêu cầu/phút -> yêu cầu đăng nhập ${c.gateMin} phút`, ip);
    stats.gated++;
    left = c.gateMin * 60000;
  }
  if ((left || c.emergency) && !auth) return gateResponse(req, res, Math.ceil(left / 1000));
  next();
}

function checkUser(req, res, next, u, c) {
  req.shieldDone = true;
  const key = 'c:' + u.id;
  const left = flagLeft(key);
  if (left) return slowResponse(req, res, Math.ceil(left / 1000));
  if (hitUser(u.id) > perInstance(c.userLimit)) {
    setFlag(key, c.cooldown, 'Thao tác quá nhanh');
    hitUser.reset(u.id); // hết giờ chờ là bắt đầu đếm lại từ 0
    logActivity(u.id, 'shield_slow', req.originalUrl, clientIp(req));
    stats.slowed++;
    return slowResponse(req, res, c.cooldown);
  }
  next(); // khách đã đăng nhập không bị từ chối khi quá tải
}

const hasSession = (req) => /(?:^|;\s*)sid=/.test(req.headers.cookie || '');

/** Trước khi đọc phiên: chặn khách không có cookie ngay tại đây */
function early(req, res, next) {
  startTimers();
  const c = conf();
  if (!c.on) return next();
  const ip = clientIp(req);
  if (c.whitelist.has(ip)) { req.shieldDone = true; return next(); }
  if (hasSession(req)) return next(); // có cookie: đợi nạp user rồi mới quyết định
  return checkGuest(req, res, next, ip, c);
}

/** Sau khi nạp user */
function late(req, res, next) {
  const c = conf();
  if (!c.on || req.shieldDone) return next();
  if (req.user) {
    if (req.user.role === 'admin') return next();
    return checkUser(req, res, next, req.user, c);
  }
  return checkGuest(req, res, next, clientIp(req), c);
}

function status() {
  const now = Math.floor(Date.now() / 1000);
  return {
    instances: INSTANCES, lagMs: lag.ms, overloaded: overloaded(), stats,
    gated: db.prepare("SELECT key, until, reason, created_at FROM shield_flags WHERE key LIKE 'g:%' AND until > ? ORDER BY created_at DESC LIMIT 200").all(now)
      .map((r) => ({ ...r, ip: r.key.slice(2) })),
    cooling: db.prepare(`SELECT f.key, f.until, u.username FROM shield_flags f LEFT JOIN users u ON u.id = CAST(substr(f.key, 3) AS INTEGER)
      WHERE f.key LIKE 'c:%' AND f.until > ? ORDER BY f.created_at DESC LIMIT 50`).all(now),
    autoBans: db.prepare("SELECT COUNT(*) c FROM ip_blocks WHERE reason LIKE 'Tự khóa%' AND (expires_at IS NULL OR expires_at > ?)").get(now).c,
  };
}

module.exports = { early, late, status, clearFlag, syncFlags, conf, INSTANCES };
