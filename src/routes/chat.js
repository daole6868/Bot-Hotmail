'use strict';
/** Chat trực tiếp — phía khách: /chat/... (JSON + SSE) */
const express = require('express');
const { upload, saveImage, optimizeBuffer } = require('../utils/upload');
const chat = require('../services/chat');
const bot = require('../services/chat-bot');
const H = require('../utils/helpers');
const config = require('../config');

const router = express.Router();
const { clientIp } = H;
const fail = (res, message, code = 400, extra = {}) => res.status(code).json({ ok: false, message, ...extra });
const clean = (t, max) => String(t || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, max);

router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (!chat.cfg().enabled) return fail(res, 'Chat đang tắt', 404);
  next();
});

function meOf(req, c, conv) {
  return {
    logged: !!req.user, name: req.user ? req.user.username : conv?.name || '',
    guestLeft: !req.user && c.guest ? Math.max(0, c.guest_limit - (conv?.guest_msgs || 0)) : null,
    canImage: !!req.user || c.guest_images,
  };
}

// Mở khung chat: cấp mã CSRF (trang có thể đang lưu sẵn ở Cloudflare nên không có mã), trả về tin nhắn gần đây
router.get('/init', (req, res) => {
  const c = chat.cfg();
  const conv = chat.convOf(req);
  const online = chat.inHours(c) && chat.agentsOnline() > 0;
  res.json({
    ok: true, token: res.locals.csrfToken, me: meOf(req, c, conv),
    guest: { allowed: c.guest, contact: c.guest_contact, limit: c.guest_limit },
    status: online ? 'online' : chat.inHours(c) ? 'away' : 'offline', offlineMsg: c.offline_msg,
    conv: conv ? { id: conv.id, blocked: !!conv.blocked, unread: conv.unread_user } : null,
    msgs: conv ? chat.recent(conv.id, 0, 40).map((m) => chat.msgView(m, c)) : [],
  });
});

router.get('/history', (req, res) => {
  const conv = chat.convOf(req); if (!conv) return res.json({ ok: true, msgs: [] });
  const before = H.toInt(req.query.before, 0, 0);
  res.json({ ok: true, msgs: chat.recent(conv.id, before, 30).map((m) => chat.msgView(m)) });
});

// Khung chat đang đóng: hỏi nhẹ số tin chưa đọc (chỉ khách đã từng chat mới gọi)
router.get('/unread', (req, res) => {
  const conv = chat.convOf(req);
  res.json({ ok: true, n: conv ? conv.unread_user : 0, last: conv?.unread_user ? conv.last_msg : null });
});

router.get('/orders', (req, res) => {
  if (!req.user) return fail(res, 'Đăng nhập để gửi đơn hàng', 401);
  res.json({ ok: true, orders: chat.userOrders(req.user.id, 15).map((o) => ({ ...o, totalText: H.money(o.total), time: H.fmtDate(o.at) })) });
});

// Khách chưa đăng nhập: nhập tên + liên hệ để bắt đầu
router.post('/start', (req, res) => {
  const c = chat.cfg();
  if (req.user) return res.json({ ok: true });
  if (!c.guest) return fail(res, 'Vui lòng đăng nhập để chat với shop', 401, { login: true });
  if (req.body.website) return fail(res, 'Không hợp lệ'); // bẫy bot
  const name = clean(req.body.name, 40);
  const contact = clean(req.body.contact, 60);
  if (name.length < 2) return fail(res, 'Vui lòng nhập tên của bạn');
  if (c.guest_contact && !/^[\w.+@\s-]{6,60}$/.test(contact)) return fail(res, 'Vui lòng nhập số điện thoại / Zalo hoặc email để shop liên hệ lại');
  let conv = chat.convOf(req);
  if (!conv) {
    const ip = clientIp(req);
    if (chat.ipBlocked(ip)) return fail(res, 'Bạn không thể chat lúc này. Vui lòng đăng nhập để được hỗ trợ.', 403, { login: true });
    if (chat.newConvsFromIp(ip) >= c.guest_ip_day) return fail(res, 'Bạn đã mở quá nhiều cuộc chat hôm nay. Vui lòng đăng nhập để tiếp tục.', 429, { login: true });
    const token = chat.newVisitor();
    conv = chat.createConv({ visitor: token.split('.')[0], name, contact, ip, page: req.body.page });
    res.cookie('gzc', token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 180 * 86400 * 1000, secure: config.isProd && config.baseUrl.startsWith('https') });
  }
  res.json({ ok: true, conv: { id: conv.id } });
});

// Gửi tin: chữ / ảnh (multipart) / đơn hàng
const one = upload.single('image');
router.post('/send', (req, res, next) => (req.is('multipart/form-data') ? one(req, res, (e) => (e ? fail(res, e.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 8MB' : e.message) : next())) : next()), async (req, res) => {
  const c = chat.cfg();
  if (!req.user && !c.guest) return fail(res, 'Vui lòng đăng nhập để chat với shop', 401, { login: true });
  let conv = chat.convOf(req);
  if (!conv && req.user) conv = chat.createConv({ userId: req.user.id, name: req.user.username, ip: clientIp(req), page: req.body.page });
  if (!conv) return fail(res, 'Vui lòng nhập tên để bắt đầu chat', 400, { start: true });
  if (conv.blocked) return fail(res, 'Bạn không thể gửi tin nhắn lúc này');
  if (!req.user && conv.guest_msgs >= c.guest_limit) return fail(res, `Bạn đã gửi tối đa ${c.guest_limit} tin khi chưa đăng nhập. Vui lòng đăng nhập để tiếp tục chat.`, 403, { login: true });
  if (chat.sentLastMinute(conv.id) >= c.rate) return fail(res, 'Bạn gửi nhanh quá, vui lòng chờ một chút', 429);
  const body = clean(req.body.body, c.max_len);
  let image = null; let ref = null;
  if (req.file) {
    if (!req.user && !c.guest_images) return fail(res, 'Vui lòng đăng nhập để gửi ảnh', 403, { login: true });
    try { const o = await optimizeBuffer(req.file.buffer, 'chat'); if (o && o.buf.length < req.file.buffer.length) req.file.buffer = o.buf; } catch { /* giữ ảnh gốc */ }
    image = saveImage(req.file, 'chat');
    if (!image) return fail(res, 'File ảnh không hợp lệ (JPG, PNG, WEBP)');
  }
  if (req.body.ref_t && req.body.ref_code) {
    if (!req.user) return fail(res, 'Đăng nhập để gửi đơn hàng', 401);
    ref = chat.orderRef(req.user.id, String(req.body.ref_t), String(req.body.ref_code).slice(0, 30));
    if (!ref) return fail(res, 'Không tìm thấy đơn hàng');
  }
  if (!body && !image && !ref) return fail(res, 'Tin nhắn trống');
  if (req.body.page) require('../db').db.prepare('UPDATE chat_convs SET page = ? WHERE id = ?').run(String(req.body.page).slice(0, 200), conv.id);
  const m = chat.addMsg(conv.id, 'user', { body, image, ref });
  bot.onUserMessage(conv, m);
  const fresh = chat.convById(conv.id);
  res.json({ ok: true, msg: chat.msgView(m, c), me: meOf(req, c, fresh) });
});

router.post('/seen', (req, res) => {
  const conv = chat.convOf(req);
  if (conv && conv.unread_user) chat.markSeen(conv.id, 'user');
  res.json({ ok: true });
});

const typingAt = new Map();
router.post('/typing', (req, res) => {
  const conv = chat.convOf(req);
  if (conv && Date.now() - (typingAt.get(conv.id) || 0) > 2500) {
    typingAt.set(conv.id, Date.now());
    if (typingAt.size > 5000) typingAt.clear();
    chat.signal(conv.id, 'typing', { who: 'user' });
  }
  res.json({ ok: true });
});

// Nhận tin realtime (chỉ mở khi khách đang mở khung chat)
router.get('/stream', (req, res) => {
  const conv = chat.convOf(req);
  if (!conv) return res.status(204).end();
  const client = { conv: conv.id, ip: clientIp(req) };
  if (!chat.openStream(req, res, client)) return;
  const after = H.toInt(req.get('last-event-id') || req.query.after, 0, 0);
  if (after) for (const m of chat.recent(conv.id, 0, 50).filter((x) => x.id > after)) res.write(`id: ${m.id}\nevent: msg\ndata: ${JSON.stringify({ msg: chat.msgView(m) })}\n\n`);
});

module.exports = router;
