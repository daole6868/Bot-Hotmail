'use strict';
/**
 * Chat trực tiếp.
 *  - Cài đặt: settings.chat_cfg (JSON), chỉnh ở Admin -> Chat trực tiếp -> Cài đặt.
 *  - Tin nhắn lưu SQLite. Mỗi bản PM2 có 1 vòng kiểm tra tin mới / giây (chỉ chạy khi có người đang mở chat)
 *    rồi đẩy xuống trình duyệt qua SSE -> 2 bản PM2 vẫn thấy tin của nhau, không cần Redis.
 *  - Khách chỉ mở kết nối khi bấm mở khung chat (người chỉ xem trang không tốn gì).
 */
const crypto = require('crypto');
const { db, getSettings } = require('../db');
const config = require('../config');
const { money } = require('../utils/helpers');

const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

const DEFAULTS = {
  enabled: false, title: 'Chat với shop', agent_name: 'Shop', greeting: 'Xin chào 👋 Shop có thể giúp gì cho bạn?', color: '#4f6bed',
  in_support: true, position: 'br', layout: 'center',
  hours_on: false, open: '08:00', close: '23:00', offline_msg: 'Shop đang ngoài giờ làm việc. Bạn cứ để lại tin nhắn, shop sẽ trả lời sớm nhất có thể!',
  guest: true, guest_limit: 10, guest_contact: true, guest_images: false, guest_ip_day: 5,
  rate: 8, max_len: 1000,
  tg_notify: true, tg_reply: true,
  ai_on: false, ai_mode: 'offline', ai_name: 'Trợ lý ảo', ai_info: '', ai_max: 20, ai_day: 300,
  keep_days: 90,
  quick: [
    { t: 'Chào khách', b: 'Chào bạn 👋 Shop có thể giúp gì cho bạn ạ?' },
    { t: 'Hướng dẫn nạp tiền', b: 'Bạn vào mục Nạp tiền, quét mã QR hoặc chuyển khoản đúng nội dung, tiền sẽ tự cộng sau 1–3 phút ạ.' },
    { t: 'Đang xử lý đơn', b: 'Shop đã nhận đơn và đang xử lý, bạn vui lòng chờ một chút nhé!' },
  ],
};

function cfg(s = getSettings()) {
  let c = {};
  try { c = JSON.parse(s.chat_cfg || '{}') || {}; } catch { c = {}; }
  const out = { ...DEFAULTS, ...c };
  if (!Array.isArray(out.quick)) out.quick = [];
  return out;
}

// ---------- Giờ làm việc (giờ VN) ----------
const toMin = (hm) => { const m = /^(\d{1,2}):(\d{2})$/.exec(hm || ''); return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null; };
function inHours(c = cfg()) {
  if (!c.hours_on) return true;
  const o = toMin(c.open), cl = toMin(c.close);
  if (o == null || cl == null || o === cl) return true;
  const d = new Date(Date.now() + 7 * 3600 * 1000); const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return o < cl ? m >= o && m < cl : m >= o || m < cl; // qua nửa đêm (VD 20:00 - 02:00)
}
const vnToday = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// ---------- Nhân viên đang trực (có mở trang Chat trong 60 giây qua) ----------
const presenceUp = db.prepare('INSERT INTO chat_presence(user_id, conv_id, seen_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET conv_id = excluded.conv_id, seen_at = excluded.seen_at');
const touchPresence = (userId, convId = null) => presenceUp.run(userId, convId, nowS());
const agentsOnline = () => db.prepare('SELECT COUNT(*) c FROM chat_presence WHERE seen_at > ?').get(nowS() - 60).c;
const viewingConv = (convId) => !!db.prepare('SELECT 1 FROM chat_presence WHERE conv_id = ? AND seen_at > ?').get(convId, nowS() - 25);

// ---------- Mã khách vãng lai (cookie gzc, có chữ ký để không đoán / giả được) ----------
const sign = (v) => crypto.createHmac('sha256', config.sessionSecret).update('chat:' + v).digest('base64url').slice(0, 22);
const newVisitor = () => { const v = crypto.randomBytes(12).toString('hex'); return v + '.' + sign(v); };
const visitorOf = (req) => {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)gzc=([a-f0-9]{24})\.([\w-]{22})/);
  return m && crypto.timingSafeEqual(Buffer.from(sign(m[1])), Buffer.from(m[2])) ? m[1] : null;
};

// ---------- Cuộc chat ----------
const convById = (id) => db.prepare('SELECT * FROM chat_convs WHERE id = ?').get(id);
/** Cuộc chat của người đang xem (đã đăng nhập: theo tài khoản; chưa: theo cookie). Đăng nhập rồi thì nhận luôn cuộc chat lúc chưa đăng nhập */
function convOf(req) {
  const v = visitorOf(req);
  if (req.user) {
    let c = db.prepare('SELECT * FROM chat_convs WHERE user_id = ?').get(req.user.id);
    if (!c && v) {
      const g = db.prepare('SELECT * FROM chat_convs WHERE visitor = ? AND user_id IS NULL').get(v);
      if (g) { db.prepare('UPDATE chat_convs SET user_id = ?, visitor = NULL, name = ? WHERE id = ?').run(req.user.id, req.user.username, g.id); c = convById(g.id); }
    }
    return c || null;
  }
  return v ? db.prepare('SELECT * FROM chat_convs WHERE visitor = ?').get(v) || null : null;
}

function createConv({ userId = null, visitor = null, name, contact = null, ip, page }) {
  const id = db.prepare('INSERT INTO chat_convs(user_id, visitor, name, contact, ip, page) VALUES(?,?,?,?,?,?)')
    .run(userId, visitor, String(name || 'Khách').slice(0, 60), contact ? String(contact).slice(0, 80) : null, ip || null, page ? String(page).slice(0, 200) : null).lastInsertRowid;
  return convById(id);
}

// ---------- Tin nhắn ----------
function msgView(m, c = cfg()) {
  let ref = null; try { ref = m.ref ? JSON.parse(m.ref) : null; } catch { ref = null; }
  const name = m.sender === 'ai' ? c.ai_name : m.sender === 'admin' ? (m.staff_name || c.agent_name) : m.sender === 'system' ? c.agent_name : null;
  return { id: m.id, conv: m.conv_id, sender: m.sender, name, body: m.body || '', image: m.image || null, ref, at: m.created_at };
}

const insMsg = db.prepare('INSERT INTO chat_msgs(conv_id, sender, staff_id, staff_name, body, image, ref) VALUES(?,?,?,?,?,?,?)');
const addMsgTx = db.transaction((convId, sender, { staffId = null, staffName = null, body = '', image = null, ref = null } = {}) => {
  const id = insMsg.run(convId, sender, staffId, staffName, body || null, image, ref ? JSON.stringify(ref) : null).lastInsertRowid;
  const preview = (body || (image ? '[Ảnh]' : ref ? `[Đơn ${ref.code}]` : '')).slice(0, 120);
  if (sender === 'user') {
    db.prepare(`UPDATE chat_convs SET last_msg = ?, last_from = 'user', last_at = unixepoch(), last_user_at = unixepoch(), unread_admin = unread_admin + 1,
      status = 'open', guest_msgs = guest_msgs + (CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) WHERE id = ?`).run(preview, convId);
  } else {
    db.prepare('UPDATE chat_convs SET last_msg = ?, last_from = ?, last_at = unixepoch(), unread_user = unread_user + 1 WHERE id = ?').run(preview, sender, convId);
  }
  return id;
});
function addMsg(convId, sender, data) {
  const id = addMsgTx.immediate(convId, sender, data);
  bus.poll(); // đẩy ngay cho người đang mở chat ở bản này; bản PM2 kia nhận trong ≤ 1 giây
  return db.prepare('SELECT * FROM chat_msgs WHERE id = ?').get(id);
}

const recent = (convId, before = 0, limit = 40) => db.prepare(`SELECT * FROM (SELECT * FROM chat_msgs WHERE conv_id = ? ${before ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ?) ORDER BY id`)
  .all(...(before ? [convId, before, limit] : [convId, limit]));

function signal(convId, kind, data = {}) {
  db.prepare('INSERT INTO chat_signals(conv_id, kind, data) VALUES(?,?,?)').run(convId, kind, JSON.stringify(data));
  bus.poll();
}

function markSeen(convId, by) {
  if (by === 'user') db.prepare('UPDATE chat_convs SET unread_user = 0 WHERE id = ? AND unread_user > 0').run(convId);
  else db.prepare('UPDATE chat_convs SET unread_admin = 0 WHERE id = ? AND unread_admin > 0').run(convId);
  const last = db.prepare("SELECT MAX(id) m FROM chat_msgs WHERE conv_id = ? AND sender " + (by === 'user' ? "!= 'user'" : "= 'user'")).get(convId).m || 0;
  signal(convId, 'seen', { by, id: last });
}

/** Chống spam: số tin khách gửi trong 60 giây */
const sentLastMinute = (convId) => db.prepare("SELECT COUNT(*) c FROM chat_msgs WHERE conv_id = ? AND sender = 'user' AND created_at > ?").get(convId, nowS() - 60).c;
const newConvsFromIp = (ip) => db.prepare('SELECT COUNT(*) c FROM chat_convs WHERE ip = ? AND user_id IS NULL AND created_at > ?').get(ip, nowS() - 86400).c;

// ---------- Đơn hàng gửi kèm tin nhắn ----------
function userOrders(userId, limit = 10) {
  const acc = db.prepare('SELECT id, order_code code, product_title title, total, status, created_at FROM v_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit)
    .map((o) => ({ t: 'acc', id: o.id, code: o.code, title: o.title, total: o.total, status: o.status === 'refunded' ? 'Đã hoàn tiền' : 'Hoàn thành', at: o.created_at }));
  const boost = require('./boost');
  const bo = db.prepare(`SELECT o.id, o.code, o.kind, o.total, o.status, o.game_name, o.created_at,
      (SELECT GROUP_CONCAT(name || ' x' || qty, ', ') FROM boost_order_items WHERE order_id = o.id) items
    FROM boost_orders o WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ?`).all(userId, limit)
    .map((o) => ({ t: o.kind === 'topup' ? 'topup' : 'boost', id: o.id, code: o.code, title: `${boost.kindOf(o.kind).name} ${o.game_name || ''} · ${o.items || ''}`.slice(0, 120), total: o.total, status: boost.statusMap(o.kind)[o.status]?.label || o.status, at: o.created_at }));
  return [...acc, ...bo].sort((a, b) => b.at - a.at).slice(0, limit);
}
function orderRef(userId, t, code) {
  const o = userOrders(userId, 30).find((x) => x.t === t && x.code === String(code));
  return o ? { t: o.t, id: o.id, code: o.code, title: o.title, total: o.total, totalText: money(o.total), status: o.status } : null;
}

// ---------- Bộ phát tin (mỗi bản PM2 một bộ) ----------
const bus = {
  clients: new Set(), lastMsg: 0, lastSig: 0, timer: null, beat: null,
  init() {
    if (this.lastMsg) return;
    this.lastMsg = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM chat_msgs').get().m || -1;
    this.lastSig = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM chat_signals').get().m || -1;
  },
  add(client) {
    this.init(); this.clients.add(client);
    if (!this.timer) this.timer = setInterval(() => this.poll(), 1000);
    if (!this.beat) {
      this.beat = setInterval(() => {
        for (const c of this.clients) { try { c.res.write(': ping\n\n'); if (c.agent) touchPresence(c.agent, c.viewing || null); } catch { /* bỏ qua */ } }
        db.prepare('DELETE FROM chat_signals WHERE created_at < ?').run(nowS() - 120);
      }, 25000);
    }
  },
  remove(client) {
    this.clients.delete(client);
    if (!this.clients.size) { clearInterval(this.timer); clearInterval(this.beat); this.timer = null; this.beat = null; this.lastMsg = 0; this.lastSig = 0; }
  },
  poll() {
    if (!this.clients.size) return;
    this.init();
    const c = cfg();
    const msgs = db.prepare('SELECT * FROM chat_msgs WHERE id > ? ORDER BY id LIMIT 300').all(Math.max(0, this.lastMsg));
    const sigs = db.prepare('SELECT * FROM chat_signals WHERE id > ? ORDER BY id LIMIT 300').all(Math.max(0, this.lastSig));
    if (msgs.length) this.lastMsg = msgs[msgs.length - 1].id;
    if (sigs.length) this.lastSig = sigs[sigs.length - 1].id;
    if (!msgs.length && !sigs.length) return;
    const convs = new Map();
    const convFor = (id) => { if (!convs.has(id)) convs.set(id, convById(id)); return convs.get(id); };
    for (const m of msgs) {
      const v = msgView(m, c);
      for (const cl of this.clients) {
        if (cl.agent) send(cl, 'msg', { msg: v, conv: convRow(convFor(m.conv_id)) }, m.id);
        else if (cl.conv === m.conv_id) send(cl, 'msg', { msg: v }, m.id);
      }
    }
    for (const s of sigs) {
      let data = {}; try { data = JSON.parse(s.data || '{}'); } catch { /* bỏ qua */ }
      for (const cl of this.clients) {
        if (cl.agent) { if (s.kind === 'conv') send(cl, 'conv', { conv: convRow(convFor(s.conv_id)), id: s.conv_id, ...data }); else send(cl, s.kind, { conv: s.conv_id, ...data }); }
        else if (cl.conv === s.conv_id && s.kind !== 'conv' && data.by !== 'user' && data.who !== 'user') send(cl, s.kind, data);
      }
    }
  },
};
function send(cl, event, data, id) {
  try { cl.res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* bỏ qua */ }
}

/** Dòng hiển thị ở danh sách cuộc chat (admin) */
function convRow(c) {
  if (!c) return null;
  return { id: c.id, name: c.name || 'Khách', guest: !c.user_id, user_id: c.user_id, last: c.last_msg || '', last_from: c.last_from, at: c.last_at, unread: c.unread_admin, status: c.status, assignee: c.assignee, blocked: !!c.blocked, ai_off: !!c.ai_off, note: c.note || '' };
}

// Giới hạn số kết nối SSE mỗi IP (mỗi bản PM2)
const perIp = new Map();
function openStream(req, res, client) {
  const ip = client.ip;
  const n = perIp.get(ip) || 0;
  if (n >= 6) { res.status(429).end(); return false; }
  perIp.set(ip, n + 1);
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  client.res = res;
  bus.add(client);
  req.on('close', () => { bus.remove(client); const k = (perIp.get(ip) || 1) - 1; if (k > 0) perIp.set(ip, k); else perIp.delete(ip); });
  return true;
}

// ---------- Dọn dữ liệu cũ (gọi từ bảo trì hằng ngày) ----------
function purge() {
  const c = cfg();
  const cut = nowS() - int(c.keep_days, 90, 1, 3650) * 86400;
  const ids = db.prepare('SELECT id FROM chat_convs WHERE last_at < ? LIMIT 5000').all(cut).map((r) => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM chat_msgs WHERE conv_id = ?').run(id);
    db.prepare('DELETE FROM chat_convs WHERE id = ?').run(id);
  }
  db.prepare('DELETE FROM chat_tg WHERE created_at < ?').run(cut);
  db.prepare('DELETE FROM chat_presence WHERE seen_at < ?').run(nowS() - 86400);
  db.prepare('DELETE FROM chat_signals WHERE created_at < ?').run(nowS() - 300);
  return ids.length;
}

module.exports = {
  DEFAULTS, cfg, inHours, vnToday, agentsOnline, viewingConv, touchPresence,
  newVisitor, visitorOf, convById, convOf, createConv, msgView, addMsg, recent, signal, markSeen, sentLastMinute, newConvsFromIp,
  userOrders, orderRef, bus, openStream, convRow, purge, int, nowS,
};
