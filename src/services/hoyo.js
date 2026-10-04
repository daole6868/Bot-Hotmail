'use strict';
/**
 * Lấy dữ liệu acc HoYoverse (Genshin / Star Rail / ZZZ) qua "worker" chạy trên máy tính admin.
 *  - Admin / quản lý / CTV bán hàng bấm "Lấy dữ liệu HoYoLAB" trong form sản phẩm -> tạo 1 job (tài khoản + mật khẩu mã hóa).
 *  - Worker (tools/hoyolab-worker) hỏi /api/hoyo/claim mỗi 3 giây, nhận job -> đăng nhập HoYoLAB, lấy nhân vật / vũ khí -> nộp kết quả.
 *  - Tài khoản / mật khẩu bị xóa khỏi database ngay khi worker nhận job.
 *  - Ảnh nhân vật / vũ khí được tải về VPS 1 lần (webp nhỏ), dùng chung cho mọi acc.
 * Cài đặt (Admin -> Kết nối API -> HoYoLAB worker) lưu JSON trong settings.hoyo_cfg, mã worker lưu dạng băm ở settings.hoyo_token_hash.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSettings } = require('../db');
const config = require('../config');
const { encrypt, decrypt, sha256, safeEqual } = require('../utils/crypto');

const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const s_ = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

const GAMES = {
  genshin: { name: 'Genshin Impact', lv: 'AR', c: 'C', w: 'Vũ khí', r: 'R' },
  hsr: { name: 'Honkai: Star Rail', lv: 'Cấp khai phá', c: 'E', w: 'Nón Ánh Sáng', r: 'S' },
  zzz: { name: 'Zenless Zone Zero', lv: 'Cấp Inter-Knot', c: 'M', w: 'W-Engine', r: 'R' },
};
const SERVERS = ['Asia', 'America', 'Europe', 'TW/HK/MO'];

const DEFAULTS = { captcha_sec: 90, job_min: 8, wait_sec: 90, per_user: 1 };
function cfg(s = getSettings()) {
  let c = {};
  try { c = JSON.parse(s.hoyo_cfg || '{}') || {}; } catch { c = {}; }
  return {
    captcha_sec: int(c.captcha_sec, DEFAULTS.captcha_sec, 20, 600),
    job_min: int(c.job_min, DEFAULTS.job_min, 2, 30),
    wait_sec: int(c.wait_sec, DEFAULTS.wait_sec, 20, 900),
  };
}

// ---------------- Mã worker ----------------
const tokenStmt = db.prepare("SELECT value FROM settings WHERE key = 'hoyo_token_hash'");
function checkToken(token) {
  const r = tokenStmt.get();
  return !!(r && r.value && token && safeEqual(sha256(token), r.value));
}
const hasToken = () => !!(tokenStmt.get() || {}).value;

const ONLINE_SEC = 20;
function workers() {
  return db.prepare('SELECT name, ip, version, last_seen FROM hoyo_workers ORDER BY last_seen DESC LIMIT 10').all()
    .map((w) => ({ ...w, online: nowS() - w.last_seen <= ONLINE_SEC }));
}
const onlineCount = () => db.prepare('SELECT COUNT(*) n FROM hoyo_workers WHERE last_seen >= ?').get(nowS() - ONLINE_SEC).n;

// ---------------- Job ----------------
/** Job quá hạn: chờ quá lâu không có worker nhận / chạy quá lâu (máy admin tắt ngang) -> báo lỗi cho người tạo */
function expire() {
  const c = cfg();
  const t = nowS();
  db.prepare(`UPDATE hoyo_jobs SET status = 'failed', cred_enc = NULL, finished_at = ?,
    error = 'Máy lấy dữ liệu (worker) chưa bật hoặc đang bận. Vui lòng thao tác lại sau.'
    WHERE status = 'pending' AND created_at < ?`).run(t, t - c.wait_sec);
  db.prepare(`UPDATE hoyo_jobs SET status = 'failed', cred_enc = NULL, finished_at = ?,
    error = 'Quá thời gian xử lý (worker mất kết nối). Vui lòng thao tác lại sau.'
    WHERE status = 'running' AND lease_until < ?`).run(t, t);
}

let lastPurge = 0;
function purge() {
  if (Date.now() - lastPurge < 3600 * 1000) return;
  lastPurge = Date.now();
  db.prepare("DELETE FROM hoyo_jobs WHERE status IN ('done','failed','cancelled') AND created_at < ?").run(nowS() - 3 * 86400);
  db.prepare('DELETE FROM hoyo_workers WHERE last_seen < ?').run(nowS() - 30 * 86400);
}

function createJob(userId, f) {
  const game = GAMES[f.game] ? f.game : null;
  const server = SERVERS.includes(f.server) ? f.server : '';
  const user = s_(f.username, 200);
  const pass = String(f.password == null ? '' : f.password).slice(0, 200);
  if (!game) return { ok: false, message: 'Chọn game' };
  if (!user || !pass) return { ok: false, message: 'Nhập tài khoản và mật khẩu HoYoLAB' };
  expire(); purge();
  if (db.prepare("SELECT 1 FROM hoyo_jobs WHERE user_id = ? AND status IN ('pending','running')").get(userId)) {
    return { ok: false, message: 'Bạn đang có 1 lượt lấy dữ liệu chưa xong. Chờ xong hoặc hủy lượt đó trước.' };
  }
  if (db.prepare("SELECT COUNT(*) n FROM hoyo_jobs WHERE status = 'pending'").get().n >= 30) {
    return { ok: false, message: 'Hàng chờ đang đầy, vui lòng thao tác lại sau.' };
  }
  const id = db.prepare('INSERT INTO hoyo_jobs(user_id, game, server, cred_enc, message) VALUES(?,?,?,?,?)')
    .run(userId, game, server || null, encrypt(JSON.stringify({ u: user, p: pass })), 'Đang chờ máy lấy dữ liệu nhận việc...').lastInsertRowid;
  return { ok: true, id: Number(id), online: onlineCount() > 0 };
}

/** Trạng thái job cho người tạo (admin / quản lý xem được mọi job) */
function jobFor(id, userId, all) {
  expire();
  const j = db.prepare('SELECT id, user_id, game, server, status, progress, message, result, error, created_at FROM hoyo_jobs WHERE id = ?').get(id);
  if (!j || (!all && j.user_id !== userId)) return null;
  let result = null;
  if (j.status === 'done') { try { result = JSON.parse(j.result); } catch { result = null; } }
  return { id: j.id, game: j.game, server: j.server, status: j.status, progress: j.progress, message: j.message, error: j.error, result, online: onlineCount() > 0 };
}

function cancel(id, userId, all) {
  const r = db.prepare(`UPDATE hoyo_jobs SET status = 'cancelled', cred_enc = NULL, finished_at = unixepoch(), error = 'Đã hủy'
    WHERE id = ? AND status IN ('pending','running')${all ? '' : ' AND user_id = ?'}`).run(...(all ? [id] : [id, userId]));
  return r.changes > 0;
}

// ---------------- Phía worker ----------------
function seen(name, ip, version) {
  db.prepare(`INSERT INTO hoyo_workers(name, ip, version, last_seen) VALUES(?,?,?,unixepoch())
    ON CONFLICT(name) DO UPDATE SET ip = excluded.ip, version = excluded.version, last_seen = excluded.last_seen`)
    .run(s_(name, 40) || 'worker', s_(ip, 60), s_(version, 20));
}

/** Worker nhận 1 job (mỗi job chỉ 1 worker nhận được). Tài khoản / mật khẩu xóa khỏi DB ngay sau khi giao. */
const claimTx = db.transaction((worker) => {
  const j = db.prepare("SELECT * FROM hoyo_jobs WHERE status = 'pending' ORDER BY id LIMIT 1").get();
  if (!j) return null;
  const c = cfg();
  const r = db.prepare(`UPDATE hoyo_jobs SET status = 'running', worker = ?, started_at = unixepoch(), lease_until = ?, cred_enc = NULL,
    progress = 5, message = 'Máy lấy dữ liệu đã nhận việc, đang mở trình duyệt...' WHERE id = ? AND status = 'pending'`)
    .run(worker, nowS() + c.job_min * 60, j.id);
  if (!r.changes) return null;
  let cred = {};
  try { cred = JSON.parse(decrypt(j.cred_enc)); } catch { cred = {}; }
  return { id: j.id, game: j.game, server: j.server || '', username: cred.u || '', password: cred.p || '', captcha_sec: c.captcha_sec, job_sec: c.job_min * 60 };
});
function claim(worker, ip, version) {
  seen(worker, ip, version);
  expire();
  return claimTx.immediate(s_(worker, 40) || 'worker');
}

function progress(id, worker, pct, msg) {
  return db.prepare("UPDATE hoyo_jobs SET progress = ?, message = ? WHERE id = ? AND status = 'running' AND worker = ?")
    .run(int(pct, 0, 0, 99), s_(msg, 300), id, worker).changes > 0;
}

function fail(id, worker, error) {
  const msg = s_(error, 400) || 'Lỗi không rõ';
  return db.prepare("UPDATE hoyo_jobs SET status = 'failed', error = ?, finished_at = unixepoch() WHERE id = ? AND status = 'running' AND worker = ?")
    .run(msg, id, worker).changes > 0;
}

// ---------------- Chuẩn hóa dữ liệu ----------------
const ICON_DIR = 'hoyo';
const ICON_RE = /^\/uploads\/hoyo\/[a-f0-9]{40}\.webp$/;
const ICON_HOST = /(^|\.)(hoyoverse|hoyolab|mihoyo|hoyoverse-cdn|mhyimg|hoyo)\.com$|(^|\.)enka\.network$/i;

const iconOk = (v) => (typeof v === 'string' && ICON_RE.test(v) ? v : '');

/** Dữ liệu chi tiết tài khoản (từ form admin hoặc từ worker sau khi đã thay ảnh) -> dạng gọn, an toàn để lưu */
function sanitize(d) {
  if (!d || typeof d !== 'object') return null;
  const ch = (a) => (Array.isArray(a) ? a : []).slice(0, 150).map((x) => ({
    n: s_(x && x.n, 60), k: int(x && x.k, 0, 0, 6), l: int(x && x.l, 0, 0, 100), el: s_(x && x.el, 20), ic: iconOk(x && x.ic),
  })).filter((x) => x.n);
  const we = (a) => (Array.isArray(a) ? a : []).slice(0, 150).map((x) => ({
    n: s_(x && x.n, 60), r: int(x && x.r, 1, 1, 5), l: int(x && x.l, 0, 0, 100), ic: iconOk(x && x.ic),
  })).filter((x) => x.n);
  const out = {
    game: GAMES[d.game] ? d.game : '',
    lv: int(d.lv, 0, 0, 999),
    server: s_(d.server, 30),
    uid: /^\d{6,12}$/.test(String(d.uid || '')) ? String(d.uid) : '',
    c5: ch(d.c5), c4: ch(d.c4), w5: we(d.w5), w4: we(d.w4),
  };
  const empty = !out.game && !out.lv && !out.server && !out.c5.length && !out.c4.length && !out.w5.length && !out.w4.length;
  return empty ? null : out;
}

/** Bản ngắn cho thẻ sản phẩm */
function brief(d) {
  if (!d) return null;
  return { g: d.game, lv: d.lv, sv: d.server, n5: d.c5.length, n4: d.c4.length, w5: d.w5.length, top: d.c5.slice(0, 6).map((c) => [c.n, c.k]) };
}

/** Kết quả worker (dạng build_result_* của tool cũ) -> chi tiết tài khoản, ảnh vẫn là link gốc (chưa tải) */
function fromWorker(r, game) {
  const a = (r && r.account) || {};
  const chars = (list) => (Array.isArray(list) ? list : []).map((c) => ({
    n: s_(c.name, 60), k: int(c.constellation ?? c.rank ?? c.eidolon, 0, 0, 6), l: int(c.level, 0, 0, 100),
    el: s_(c.element || c.path || '', 20), src: typeof c.icon === 'string' ? c.icon : '',
  })).filter((c) => c.n);
  const byR = (r && r.weapons_by_rarity) || {};
  const weap = (list) => (Array.isArray(list) ? list : []).map((w) => ({
    n: s_(w.name, 60), r: int(w.refinement ?? w.rank ?? w.star ?? w.superimpose, 1, 1, 5), l: int(w.level, 0, 0, 100), src: typeof w.icon === 'string' ? w.icon : '',
  })).filter((w) => w.n);
  const c5 = chars(r && r.characters_5star);
  const c4 = chars(r && r.characters_4star);
  return {
    game, lv: int(a.level, 0, 0, 999), server: s_(a.server, 30), uid: /^\d{6,12}$/.test(String(a.uid || '')) ? String(a.uid) : '',
    c5: c5.sort((x, y) => y.k - x.k || y.l - x.l), c4: c4.sort((x, y) => y.k - x.k || y.l - x.l),
    w5: weap(byR[5] || byR['5']), w4: weap(byR[4] || byR['4']),
  };
}

// Tải ảnh về /uploads/hoyo/<sha1>.webp (đã có thì dùng lại). Chỉ tải từ máy chủ ảnh của HoYoverse.
async function cacheIcon(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  if (u.protocol !== 'https:' || !ICON_HOST.test(u.hostname)) return '';
  const name = crypto.createHash('sha1').update(u.href).digest('hex') + '.webp';
  const dir = path.join(config.paths.uploads, ICON_DIR);
  const full = path.join(dir, name);
  const pub = `/uploads/${ICON_DIR}/${name}`;
  if (fs.existsSync(full)) return pub;
  try {
    const res = await fetch(u.href, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!res.ok) return '';
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 3 * 1024 * 1024) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 3 * 1024 * 1024) return '';
    const out = await require('sharp')(buf).resize(160, 160, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, out);
    return pub;
  } catch { return ''; }
}

// ---------------- Thư viện ảnh nhân vật / vũ khí (Giao diện -> Quản lý ảnh) ----------------
const nkey = (n) => String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/\s+/g, ' ').trim();
const KIND_OF = { c5: 'char', c4: 'char', w5: 'weapon', w4: 'weapon' };
const libStmt = db.prepare('SELECT icon FROM hoyo_assets WHERE game = ? AND kind = ? AND nkey = ?');
const libGet = (game, kind, name) => (libStmt.get(game, kind, nkey(name)) || {}).icon || '';
function libAdd(game, kind, name, icon, src, rarity) {
  if (!GAMES[game] || !icon || !name) return false;
  return db.prepare('INSERT OR IGNORE INTO hoyo_assets(game, kind, name, nkey, icon, src, rarity) VALUES(?,?,?,?,?,?,?)')
    .run(game, kind, s_(name, 60), nkey(name), icon, src ? s_(src, 500) : null, int(rarity, 0, 0, 5)).changes > 0;
}

/** Điền ảnh còn trống bằng thư viện (nhân vật / vũ khí thêm tay theo tên) */
function fillIcons(d) {
  if (!d || !GAMES[d.game]) return d;
  for (const key of Object.keys(KIND_OF)) {
    for (const x of d[key] || []) if (!x.ic) x.ic = libGet(d.game, KIND_OF[key], x.n);
  }
  return d;
}

async function withIcons(d) {
  const todo = [];
  for (const key of Object.keys(KIND_OF)) {
    for (const x of d[key]) {
      const have = GAMES[d.game] ? libGet(d.game, KIND_OF[key], x.n) : '';
      if (have) { x.ic = have; delete x.src; } else todo.push([key, x]);
    }
  }
  const urls = [...new Set(todo.map(([, x]) => x.src).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < urls.length; i += 6) {
    const part = urls.slice(i, i + 6);
    const got = await Promise.all(part.map(cacheIcon));
    part.forEach((u, k) => map.set(u, got[k]));
  }
  for (const [key, x] of todo) {
    x.ic = map.get(x.src) || '';
    if (x.ic) libAdd(d.game, KIND_OF[key], x.n, x.ic, x.src, key.endsWith('5') ? 5 : 4); // nhân vật mới -> tự thêm vào thư viện
    delete x.src;
  }
  return d;
}

/** Worker nộp kết quả: trả lời worker ngay, tải ảnh nền rồi mới đánh dấu xong */
function done(id, worker, result) {
  const j = db.prepare("SELECT id, game FROM hoyo_jobs WHERE id = ? AND status = 'running' AND worker = ?").get(id, worker);
  if (!j) return false;
  const raw = fromWorker(result, j.game);
  if (!raw.c5.length && !raw.c4.length) {
    fail(id, worker, 'Worker không gửi danh sách nhân vật (0 nhân vật). Kiểm tra bước lấy dữ liệu của worker rồi thao tác lại.');
    return true;
  }
  db.prepare("UPDATE hoyo_jobs SET progress = 95, message = 'Đang lưu ảnh nhân vật...', lease_until = ? WHERE id = ?").run(nowS() + 120, id);
  withIcons(raw).then((d) => {
    const clean = sanitize(d);
    db.prepare(`UPDATE hoyo_jobs SET status = 'done', progress = 100, result = ?, finished_at = unixepoch(),
      message = ? WHERE id = ? AND status = 'running'`)
      .run(JSON.stringify(clean), `Xong: ${clean.c5.length} nhân vật 5★, ${clean.c4.length} nhân vật 4★`, id);
  }).catch((e) => {
    db.prepare("UPDATE hoyo_jobs SET status = 'failed', error = ?, finished_at = unixepoch() WHERE id = ? AND status = 'running'")
      .run('Lỗi lưu dữ liệu: ' + s_(e.message, 200), id);
  });
  return true;
}

module.exports = {
  GAMES, SERVERS, DEFAULTS, cfg, checkToken, hasToken, workers, onlineCount,
  createJob, jobFor, cancel, claim, progress, fail, done, sanitize, brief, fromWorker, ICON_RE,
  nkey, libGet, libAdd, fillIcons, cacheIcon, ICON_DIR,
};
