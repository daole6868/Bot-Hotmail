'use strict';
/**
 * Chống quá tải lớp 3: tự phát hiện lượng truy cập bất thường và xử lý trước khi VPS sập.
 *
 * Đếm: mỗi bản PM2 đếm lượt truy cập vào tới Node theo khung 10 giây (tổng, khách chưa đăng nhập, số IP, độ trễ)
 *      rồi cộng dồn vào bảng traffic_buckets (1 lần ghi / 10 giây / bản, rất nhẹ).
 * Mức nền: lượt truy cập / phút của CÙNG KHUNG GIỜ trong 7 ngày trước (lấy mức cao 95%).
 * Bất thường: lượt / phút > N lần mức nền (và vượt ngưỡng tối thiểu), hoặc số IP / phút > N lần mức nền,
 *             hoặc web xử lý chậm liên tục 30 giây.
 * Xử lý (chỉ bản PM2 số 0 chạy, 10 giây / lần):
 *   Bậc 1: khách chưa đăng nhập phải đăng nhập mới vào được trang chưa lưu sẵn (trang đã lưu ở Cloudflare vẫn xem được);
 *          người đã đăng nhập, admin, webhook nạp tiền không ảnh hưởng.
 *   Bậc 2: vẫn bất thường sau X giây -> tự bật "I'm Under Attack" trên Cloudflare.
 *   Yên ổn liên tục N phút -> tự tắt hết, trả Cloudflare về mức cũ. Mỗi lần đổi bậc đều báo Telegram.
 */
const { db, getSettings, setSetting } = require('../db');

const BUCKET = 10; // giây
const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

function conf(s = getSettings()) {
  return {
    on: s.ad_enabled !== '0',
    mult: int(s.ad_mult, 5, 2, 100),
    floorRpm: int(s.ad_floor_rpm, 1200, 60, 10000000),
    ipFloor: int(s.ad_ip_floor, 300, 10, 10000000),
    escalateSec: int(s.ad_escalate_sec, 120, 20, 3600),
    calmMin: int(s.ad_calm_min, 15, 1, 1440),
    autoGate: s.ad_auto_gate !== '0',
    autoCf: s.ad_auto_cf !== '0',
    overloadMs: int(s.as_overload_ms, 300, 50, 5000),
  };
}

// ---------- Đếm (mọi bản PM2) ----------
const MAX_IPS = 100000;
let cur = { ts: 0, total: 0, guests: 0, ips: new Set(), lag: 0 };
const upBucket = db.prepare(`INSERT INTO traffic_buckets(ts, total, guests, ips, lag_ms) VALUES(?,?,?,?,?)
  ON CONFLICT(ts) DO UPDATE SET total = total + excluded.total, guests = guests + excluded.guests,
    ips = ips + excluded.ips, lag_ms = MAX(lag_ms, excluded.lag_ms)`);
function rotate() {
  const t = Math.floor(nowS() / BUCKET) * BUCKET;
  if (t === cur.ts) return;
  const b = cur;
  cur = { ts: t, total: 0, guests: 0, ips: new Set(), lag: 0 };
  if (b.ts && (b.total || b.lag)) {
    try { upBucket.run(b.ts, b.total, b.guests, b.ips.size, b.lag); } catch { /* DB bận: bỏ qua 1 khung */ }
  }
}
function record(ip, guest) {
  rotate();
  cur.total++;
  if (guest) cur.guests++;
  if (cur.ips.size < MAX_IPS) cur.ips.add(ip);
}
/** Gọi mỗi giây từ bộ đo độ trễ của shield (để khung vẫn được ghi khi không có lượt nào) */
function noteLag(ms) {
  rotate();
  if (ms > cur.lag) cur.lag = ms;
}

// ---------- Số liệu ----------
const selRecent = db.prepare('SELECT * FROM traffic_buckets WHERE ts >= ? AND ts < ? ORDER BY ts');
/** Lượt / phút và IP / phút tính trên 30 giây gần nhất (3 khung đã xong) */
function live() {
  const end = Math.floor(nowS() / BUCKET) * BUCKET;
  const rows = selRecent.all(end - 3 * BUCKET, end);
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    rpm: sum('total') * 2, guestRpm: sum('guests') * 2, ipm: sum('ips') * 2,
    lagMs: rows.reduce((a, r) => Math.max(a, r.lag_ms), 0),
    slow: (overloadMs) => rows.length === 3 && rows.every((r) => r.lag_ms > overloadMs),
  };
}

// Mức nền: lượt / phút của cùng khung giờ (giờ Việt Nam) trong 7 ngày trước, lấy mức cao 95%
const VN = 7 * 3600;
const selMinutes = db.prepare('SELECT ts / 60 AS m, SUM(total) AS t, SUM(ips) AS i FROM traffic_buckets WHERE ts >= ? AND ts < ? GROUP BY m');
let baseCache = { key: '', v: null };
const p95 = (arr) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))]; };
function baseline() {
  const t = nowS();
  const hourStart = Math.floor((t + VN) / 3600) * 3600 - VN;
  const key = String(hourStart) + ':' + Math.floor(t / 300);
  if (baseCache.key === key) return baseCache.v;
  const rpm = []; const ips = [];
  for (let d = 1; d <= 7; d++) {
    const from = hourStart - d * 86400;
    for (const r of selMinutes.all(from, from + 3600)) { rpm.push(r.t); ips.push(r.i); }
  }
  // Chưa đủ dữ liệu (web mới chạy): chỉ dùng ngưỡng tối thiểu
  const v = rpm.length >= 30 ? { rpm: p95(rpm), ips: p95(ips), samples: rpm.length } : { rpm: 0, ips: 0, samples: rpm.length };
  baseCache = { key, v };
  return v;
}
function thresholds(c = conf()) {
  const b = baseline();
  return { base: b, rpm: Math.max(c.floorRpm, c.mult * b.rpm), ipm: Math.max(c.ipFloor, c.mult * b.ips) };
}

// ---------- Trạng thái (đọc / ghi thẳng DB: mọi bản PM2 và trang admin thấy ngay) ----------
const selState = db.prepare("SELECT value FROM settings WHERE key = 'ad_state'");
function getState() {
  try { return { level: 0, ...JSON.parse(selState.get()?.value || '{}') }; } catch { return { level: 0 }; }
}
function saveState(st) { setSetting('ad_state', JSON.stringify(st)); }

const insEvent = db.prepare('INSERT INTO traffic_events(level, message) VALUES(?,?)');
const LEVEL_NAME = ['Bình thường', 'Bậc 1 – khách mới phải đăng nhập', 'Bậc 2 – Cloudflare Under Attack'];
function event(level, message) {
  try { insEvent.run(level, message); } catch { /* bỏ qua */ }
  const host = String(require('../config').baseUrl).replace(/^https?:\/\//, '');
  require('./backup').notifyAdmin(`🛡 ${host}\n${message}`).catch(() => {});
}

const shield = () => require('./shield');
const GATE_KEY = 'auto:gate';
const GATE_TTL = 120; // giây, được gia hạn mỗi 10 giây khi còn ở bậc >= 1

async function cfUnderAttack(st) {
  const cf = require('./cloudflare');
  const prev = await cf.getSecurityLevel();
  if (prev !== 'under_attack') await cf.setSecurityLevel('under_attack');
  st.cfPrev = prev === 'under_attack' ? (st.cfPrev || 'medium') : prev;
  st.cfSet = true;
}
async function cfRestore(st) {
  if (!st.cfSet) return null;
  const to = st.cfPrev && st.cfPrev !== 'under_attack' ? st.cfPrev : 'medium';
  await require('./cloudflare').setSecurityLevel(to);
  st.cfSet = false;
  return to;
}

/** Kết thúc mọi xử lý tự động (gọi khi yên ổn hoặc admin bấm tắt) */
async function stand(reason) {
  const st = getState();
  shield().clearFlag(GATE_KEY);
  let msg = `✅ Trở lại bình thường: ${reason}.`;
  try {
    const to = await cfRestore(st);
    if (to) msg += ` Cloudflare về mức "${to}".`;
  } catch (e) { msg += ` ⚠️ Chưa trả được Cloudflare về mức cũ (${e.message}), hãy tắt Under Attack bằng tay.`; }
  const was = st.level;
  saveState({ level: 0, cfSet: st.cfSet || false, cfPrev: st.cfPrev || null, endedAt: nowS() });
  if (was > 0) event(0, msg);
  return msg;
}

/** Admin bật Under Attack bằng tay (không tự tắt, admin bấm tắt khi xong) */
async function manualUnderAttack() {
  const st = getState();
  await cfUnderAttack(st);
  Object.assign(st, { level: 2, since: st.since || nowS(), reason: 'Admin bật bằng tay', manual: true });
  saveState(st);
  event(2, '🛑 Admin bật Cloudflare Under Attack bằng tay.');
}

// ---------- Bộ phát hiện (chỉ bản PM2 số 0) ----------
let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const c = conf();
    const st = getState();
    if (!c.on) { if (st.level > 0 && !st.manual) await stand('đã tắt tự phát hiện'); return; }
    const L = live(); const T = thresholds(c);
    const why = [];
    if (L.rpm > T.rpm) why.push(`${L.rpm.toLocaleString('vi-VN')} lượt/phút (ngưỡng ${T.rpm.toLocaleString('vi-VN')})`);
    if (L.ipm > T.ipm) why.push(`${L.ipm.toLocaleString('vi-VN')} IP/phút (ngưỡng ${T.ipm.toLocaleString('vi-VN')})`);
    if (L.slow(c.overloadMs)) why.push(`web xử lý chậm ${L.lagMs}ms liên tục 30 giây`);
    const t = nowS();

    if (why.length) {
      st.hits = (st.hits || 0) + 1;
      st.calmSince = null;
      if (st.level === 0 && st.hits >= 2) { // bất thường 2 lần liền (20 giây) mới xử lý, tránh báo nhầm khi tăng vọt chốc lát
        Object.assign(st, { level: 1, since: t, reason: why.join('; '), manual: false });
        event(1, `⚠️ Phát hiện truy cập bất thường: ${st.reason}.\n${c.autoGate ? 'Bậc 1: khách mới chưa đăng nhập phải đăng nhập (người đã đăng nhập không ảnh hưởng).' : 'Bậc 1: chỉ báo (đang tắt tự chặn khách mới).'}`);
      } else if (st.level === 1 && t - st.since >= c.escalateSec && c.autoCf && require('./cloudflare').ready()) {
        try {
          await cfUnderAttack(st);
          st.level = 2;
          const d = t - st.since;
          event(2, `🛑 Vẫn bất thường sau ${d >= 120 ? Math.round(d / 60) + ' phút' : d + ' giây'} (${why.join('; ')}).\nBậc 2: đã bật Cloudflare "I'm Under Attack".`);
        } catch (e) {
          if (!st.cfErrAt || t - st.cfErrAt > 600) { st.cfErrAt = t; event(1, `⚠️ Không bật được Cloudflare Under Attack: ${e.message}`); }
        }
      }
    } else {
      st.hits = 0;
      if (st.level > 0 && !st.manual) {
        st.calmSince = st.calmSince || t;
        if (t - st.calmSince >= c.calmMin * 60) { await stand(`không còn bất thường trong ${c.calmMin} phút`); return; }
      }
    }
    // Bậc >= 1: giữ cổng đăng nhập cho khách mới (gia hạn liên tục, bản PM2 nào cũng đọc được qua shield_flags)
    if (st.level >= 1 && c.autoGate && !st.manual) shield().setFlag(GATE_KEY, GATE_TTL, 'Tự phát hiện truy cập bất thường');
    saveState(st);
  } catch (e) {
    console.error('[traffic]', e);
  } finally {
    busy = false;
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  setInterval(() => { tick(); }, BUCKET * 1000).unref();
  // Dọn: giữ số liệu 8 ngày, nhật ký 500 dòng
  setInterval(() => {
    try {
      db.prepare('DELETE FROM traffic_buckets WHERE ts < ?').run(nowS() - 8 * 86400);
      db.prepare('DELETE FROM traffic_events WHERE id <= (SELECT id FROM traffic_events ORDER BY id DESC LIMIT 1 OFFSET 500)').run();
    } catch { /* bỏ qua */ }
  }, 3600 * 1000).unref();
}

/** Cho trang admin */
function status() {
  const c = conf(); const L = live(); const T = thresholds(c); const st = getState();
  return {
    conf: c, live: { rpm: L.rpm, guestRpm: L.guestRpm, ipm: L.ipm, lagMs: L.lagMs }, thr: T, state: st, levelName: LEVEL_NAME[st.level] || '',
    cfReady: require('./cloudflare').ready(),
    events: db.prepare('SELECT * FROM traffic_events ORDER BY id DESC LIMIT 20').all(),
  };
}

module.exports = { record, noteLag, start, tick, status, stand, manualUnderAttack, live, thresholds, getState, GATE_KEY };
