'use strict';
/**
 * Chat trực tiếp — phía quản trị: /admin/chat/...
 *  - Admin: toàn quyền (xem cả email, số dư..., cài đặt, nhân viên).
 *  - Nhân viên (users.staff = 1): chỉ trang chat + thông tin đơn hàng của khách, không thấy email / số dư / IP.
 */
const express = require('express');
const { db, setSetting, getSettings, logActivity } = require('../db');
const { requireAdmin, verifyCsrf } = require('../middleware/security');
const { upload, saveImage, optimizeBuffer } = require('../utils/upload');
const chat = require('../services/chat');
const bot = require('../services/chat-bot');
const H = require('../utils/helpers');

const router = express.Router();
const { toInt, str, clientIp } = H;
const fail = (res, message, code = 400) => res.status(code).json({ ok: false, message });

// ---------- Quyền: admin (đã qua bước đăng nhập quản trị) hoặc nhân viên chat ----------
router.use((req, res, next) => {
  if (req.user?.role === 'admin') return requireAdmin(req, res, () => { req.agent = { role: 'admin', id: req.user.id, name: chat.cfg().agent_name }; next(); });
  if (req.user?.staff) { req.agent = { role: 'staff', id: req.user.id, name: req.user.staff_name || req.user.username }; return next(); }
  if (!req.user && req.method === 'GET' && !req.path.startsWith('/stream') && !req.xhr && req.accepts(['html', 'json']) === 'html') {
    req.session.returnTo = req.originalUrl; req.flash('error', 'Vui lòng đăng nhập để tiếp tục'); return res.redirect('/login');
  }
  return res.status(404).render('errors/error', { code: 404, message: 'Không tìm thấy trang' });
});
const adminOnly = (req, res, next) => (req.agent.role === 'admin' ? next() : res.status(403).render('errors/error', { code: 403, message: 'Chỉ admin mới vào được trang này' }));
router.use((req, res, next) => {
  res.locals.layoutAdmin = true;
  res.locals.path = '/chat' + (req.path === '/' ? '' : req.path);
  res.locals.agentRole = req.agent.role;
  res.locals.adminBadges = req.agent.role === 'admin' ? {
    deposits: db.prepare("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'").get().c,
    ...Object.fromEntries(db.prepare("SELECT kind, COUNT(*) c FROM boost_orders WHERE status = 'received' GROUP BY kind").all().map((r) => [r.kind, r.c])),
    bank: db.prepare("SELECT COUNT(*) c FROM bank_transactions WHERE status = 'unmatched'").get().c,
    chat: db.prepare('SELECT COUNT(*) c FROM chat_convs WHERE unread_admin > 0 AND blocked = 0').get().c,
  } : { chat: unreadCount() };
  next();
});
// Form có ảnh (multipart): kiểm tra CSRF sau khi đọc form
const one = upload.single('image');
const multipart = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  one(req, res, (e) => {
    if (e) return fail(res, e.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 8MB' : e.message);
    if (!verifyCsrf(req)) return fail(res, 'Phiên làm việc hết hạn, tải lại trang', 403);
    next();
  });
};
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const unreadCount = () => db.prepare('SELECT COUNT(*) c FROM chat_convs WHERE unread_admin > 0 AND blocked = 0').get().c;

// ---------- Hộp thư ----------
const LIST_SQL = {
  all: '1 = 1', unread: 'unread_admin > 0', open: "status = 'open' AND blocked = 0", closed: "status = 'closed'", mine: 'assignee = ?', guest: 'user_id IS NULL', blocked: 'blocked = 1',
};
function listConvs(req) {
  const f = LIST_SQL[req.query.f] ? req.query.f : 'all';
  const where = [LIST_SQL[f]]; const args = f === 'mine' ? [req.agent.id] : [];
  const q = str(req.query.q, 60).trim();
  if (q) {
    where.push('(c.name LIKE ? OR c.contact LIKE ? OR c.last_msg LIKE ? OR c.id = ? OR c.user_id IN (SELECT id FROM users WHERE username LIKE ?' + (req.agent.role === 'admin' ? ' OR email LIKE ?' : '') + '))');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, toInt(q, 0), `%${q}%`); if (req.agent.role === 'admin') args.push(`%${q}%`);
  }
  const before = toInt(req.query.before, 0, 0);
  if (before) { where.push('c.last_at < ?'); args.push(before); }
  return db.prepare(`SELECT c.* FROM chat_convs c WHERE ${where.join(' AND ')} ORDER BY c.last_at DESC LIMIT 40`).all(...args).map(chat.convRow);
}

router.get('/', (req, res) => {
  chat.touchPresence(req.agent.id);
  const c = chat.cfg();
  res.render('admin/chat', {
    title: 'Chat trực tiếp', convs: listConvs(req), cfg: c, me: req.agent,
    quick: c.quick, staff: db.prepare('SELECT id, username, staff_name FROM users WHERE staff = 1 OR role = \'admin\'').all().map((u) => ({ id: u.id, name: u.staff_name || u.username })),
  });
});
router.get('/list', (req, res) => res.json({ ok: true, convs: listConvs(req), unread: unreadCount() }));
router.get('/unread', (req, res) => res.json({ ok: true, n: unreadCount() }));

/** Thông tin khách hiện ở cột phải — nhân viên chỉ thấy đơn hàng */
function info(conv, role) {
  const out = { name: conv.name, guest: !conv.user_id, contact: conv.contact, page: conv.page, since: H.fmtDate(conv.created_at), note: conv.note || '' };
  if (conv.user_id) {
    const u = db.prepare('SELECT id, username, email, balance, total_deposit, total_spent, status, created_at, last_login_at, last_login_ip, signup_source FROM users WHERE id = ?').get(conv.user_id);
    if (u) {
      out.username = u.username;
      if (role === 'admin') {
        Object.assign(out, {
          userId: u.id, email: u.email, balance: H.money(u.balance), deposit: H.money(u.total_deposit), spent: H.money(u.total_spent), status: u.status,
          registered: H.fmtDate(u.created_at), lastLogin: u.last_login_at ? H.fmtDate(u.last_login_at) : '', lastIp: u.last_login_ip, source: u.signup_source,
        });
      }
    }
    out.orders = chat.userOrders(conv.user_id, 15).map((o) => ({ ...o, totalText: H.money(o.total), time: H.fmtDate(o.at) }));
  }
  if (role === 'admin') out.ip = conv.ip;
  return out;
}

router.get('/c/:id', (req, res) => {
  const conv = chat.convById(toInt(req.params.id)); if (!conv) return fail(res, 'Không tìm thấy cuộc chat', 404);
  chat.touchPresence(req.agent.id, conv.id);
  const c = chat.cfg();
  res.json({ ok: true, conv: chat.convRow(conv), msgs: chat.recent(conv.id, 0, 50).map((m) => chat.msgView(m, c)), info: info(conv, req.agent.role) });
});
router.get('/c/:id/history', (req, res) => {
  const id = toInt(req.params.id); const before = toInt(req.query.before, 0, 0);
  res.json({ ok: true, msgs: chat.recent(id, before, 30).map((m) => chat.msgView(m)) });
});

// Chi tiết 1 đơn (nhân viên cũng xem được, không có tài khoản / mật khẩu game)
router.get('/order/:t/:id', (req, res) => {
  const t = req.params.t; const id = toInt(req.params.id);
  if (t === 'acc') {
    const o = db.prepare('SELECT id, order_code, user_id, product_title, game_name, price, discount, total, coupon_code, status, created_at FROM v_orders WHERE id = ?').get(id);
    if (!o) return fail(res, 'Không tìm thấy đơn', 404);
    return res.json({ ok: true, order: { type: 'Mua acc', code: o.order_code, rows: [['Sản phẩm', o.product_title], ['Game', o.game_name], ['Giá', H.money(o.price)], ['Giảm giá', H.money(o.discount) + (o.coupon_code ? ` (${o.coupon_code})` : '')], ['Thanh toán', H.money(o.total)], ['Trạng thái', o.status === 'refunded' ? 'Đã hoàn tiền' : 'Hoàn thành'], ['Thời gian', H.fmtDate(o.created_at)]], admin: req.agent.role === 'admin' ? `/admin/orders/${o.id}` : null } });
  }
  const o = db.prepare('SELECT * FROM boost_orders WHERE id = ?').get(id);
  if (!o) return fail(res, 'Không tìm thấy đơn', 404);
  const boost = require('../services/boost');
  const items = db.prepare('SELECT name, category_name, qty, unit, line_total FROM boost_order_items WHERE order_id = ?').all(o.id);
  const rows = [['Game', o.game_name], ...items.map((i) => [i.category_name ? `${i.category_name} › ${i.name}` : i.name, `x${i.qty}${i.unit ? ' ' + i.unit : ''} · ${H.money(i.line_total)}`]),
    ['Thanh toán', H.money(o.total)], ['Trạng thái', boost.statusMap(o.kind)[o.status]?.label || o.status]];
  if (o.kind === 'topup' && o.uid) rows.push(['UID', o.uid + (o.server ? ` · ${o.server}` : '') + (o.char_name ? ` · ${o.char_name}` : '')]);
  else if (o.server) rows.push(['Server', o.server]);
  if (o.note) rows.push(['Ghi chú của khách', o.note]);
  if (o.customer_msg) rows.push(['Lời nhắn cho khách', o.customer_msg]);
  rows.push(['Thời gian', H.fmtDate(o.created_at)]);
  res.json({ ok: true, order: { type: boost.kindOf(o.kind).name, code: o.code, rows, proof: o.proof || null, admin: req.agent.role === 'admin' ? `/admin/boost/orders/${o.id}` : null } });
});

router.post('/c/:id/send', multipart, async (req, res) => {
  const conv = chat.convById(toInt(req.params.id)); if (!conv) return fail(res, 'Không tìm thấy cuộc chat', 404);
  const body = String(req.body.body || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 3000);
  let image = null;
  if (req.file) {
    try { const o = await optimizeBuffer(req.file.buffer, 'chat'); if (o && o.buf.length < req.file.buffer.length) req.file.buffer = o.buf; } catch { /* giữ ảnh gốc */ }
    image = saveImage(req.file, 'chat');
    if (!image) return fail(res, 'File ảnh không hợp lệ');
  }
  if (!body && !image) return fail(res, 'Tin nhắn trống');
  const m = chat.addMsg(conv.id, 'admin', { staffId: req.agent.id, staffName: req.agent.name, body, image });
  bot.pauseAi(conv.id);
  if (!conv.assignee) db.prepare('UPDATE chat_convs SET assignee = ? WHERE id = ? AND assignee IS NULL').run(req.agent.id, conv.id);
  if (conv.unread_admin) chat.markSeen(conv.id, 'agent');
  chat.touchPresence(req.agent.id, conv.id);
  res.json({ ok: true, msg: chat.msgView(m) });
});

router.post('/c/:id/seen', (req, res) => {
  const conv = chat.convById(toInt(req.params.id));
  if (conv) { chat.touchPresence(req.agent.id, conv.id); if (conv.unread_admin) chat.markSeen(conv.id, 'agent'); }
  res.json({ ok: true, unread: unreadCount() });
});
const typingAt = new Map();
router.post('/c/:id/typing', (req, res) => {
  const id = toInt(req.params.id);
  if (id && Date.now() - (typingAt.get(id) || 0) > 2500) { typingAt.set(id, Date.now()); chat.signal(id, 'typing', { who: 'agent', name: req.agent.name }); }
  res.json({ ok: true });
});

router.post('/c/:id/action', (req, res) => {
  const conv = chat.convById(toInt(req.params.id)); if (!conv) return fail(res, 'Không tìm thấy cuộc chat', 404);
  const act = String(req.body.act || '');
  const set = (sql, ...a) => db.prepare(`UPDATE chat_convs SET ${sql} WHERE id = ?`).run(...a, conv.id);
  if (act === 'close') set("status = 'closed'");
  else if (act === 'open') set("status = 'open'");
  else if (act === 'assign') set('assignee = ?', req.body.to === 'none' ? null : toInt(req.body.to, req.agent.id) || req.agent.id);
  else if (act === 'block') set('blocked = 1');
  else if (act === 'unblock') set('blocked = 0');
  else if (act === 'ai_on') set('ai_off = 0, ai_pause_until = 0');
  else if (act === 'ai_off') set('ai_off = 1');
  else if (act === 'note') set('note = ?', str(req.body.note, 1000) || null);
  else if (act === 'delete') {
    if (req.agent.role !== 'admin') return fail(res, 'Chỉ admin được xóa cuộc chat', 403);
    const n = chat.deleteConv(conv.id);
    audit(req, 'chat_delete', `#${conv.id} ${conv.name} (${n} ảnh)`);
    return res.json({ ok: true, deleted: true });
  } else return fail(res, 'Thao tác không hợp lệ');
  chat.signal(conv.id, 'conv', { act });
  res.json({ ok: true, conv: chat.convRow(chat.convById(conv.id)) });
});

// Nhận tin realtime cho trang Chat (tin mới mọi cuộc chat, đang nhập, đã xem)
router.get('/stream', (req, res) => {
  chat.touchPresence(req.agent.id, toInt(req.query.viewing, 0) || null);
  const client = { agent: req.agent.id, viewing: toInt(req.query.viewing, 0) || null, ip: clientIp(req) + ':a' };
  if (!chat.openStream(req, res, client)) return;
  const key = req.agent.id + ':' + Math.random().toString(36).slice(2);
  router.streams.set(key, client);
  req.on('close', () => router.streams.delete(key));
});
router.streams = new Map();
router.post('/viewing', (req, res) => {
  const id = toInt(req.body.id, 0) || null;
  for (const [k, cl] of router.streams) if (k.startsWith(req.agent.id + ':')) cl.viewing = id;
  chat.touchPresence(req.agent.id, id);
  res.json({ ok: true });
});

// ---------- Cài đặt (chỉ admin) ----------
router.get('/settings', adminOnly, (req, res) => {
  const staff = db.prepare('SELECT id, username, email, staff_name, staff_tg FROM users WHERE staff = 1 ORDER BY id').all();
  res.render('admin/chat-settings', { title: 'Cài đặt chat', cfg: chat.cfg(), keepHours: chat.keepHours(), staff, tg: bot.tgStatus(), tgReady: !!getSettings().tg_token_enc, tgChat: getSettings().tg_chat_id || '', ai: require('../services/ai').status() });
});
router.post('/settings', adminOnly, (req, res) => {
  const b = req.body; const D = chat.DEFAULTS; const I = (k, min, max) => toInt(b[k], D[k], min, max); const B = (k) => !!H.bool(b[k]);
  const hm = (v, d) => (/^\d{2}:\d{2}$/.test(v || '') ? v : d);
  const titles = [].concat(b.q_t || []); const bodies = [].concat(b.q_b || []);
  const c = {
    enabled: B('enabled'), title: str(b.title, 60) || D.title, agent_name: str(b.agent_name, 40) || D.agent_name, greeting: str(b.greeting, 300), color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : D.color,
    in_support: B('in_support'), position: ['br', 'bl'].includes(b.position) ? b.position : 'br', layout: b.layout === 'corner' ? 'corner' : 'center',
    hours_on: B('hours_on'), open: hm(b.open, D.open), close: hm(b.close, D.close), offline_msg: str(b.offline_msg, 300) || D.offline_msg,
    guest: B('guest'), guest_limit: I('guest_limit', 1, 200), guest_contact: B('guest_contact'), guest_images: B('guest_images'), guest_ip_day: I('guest_ip_day', 1, 100),
    rate: I('rate', 2, 60), max_len: I('max_len', 100, 3000),
    tg_notify: B('tg_notify'), tg_reply: B('tg_reply'),
    ai_on: B('ai_on'), ai_mode: b.ai_mode === 'always' ? 'always' : 'offline', ai_name: str(b.ai_name, 40) || D.ai_name, ai_info: str(b.ai_info, 8000), ai_max: I('ai_max', 1, 500), ai_day: I('ai_day', 1, 100000),
    keep_hours: Math.min(87600, Math.max(1, toInt(b.keep_n, 90, 1, 87600) * (b.keep_unit === 'h' ? 1 : 24))),
    quick: titles.map((t, i) => ({ t: str(t, 40).trim(), b: str(bodies[i], 1000).trim() })).filter((q) => q.t && q.b).slice(0, 50),
  };
  setSetting('chat_cfg', JSON.stringify(c));
  audit(req, 'chat_settings', c.enabled ? 'bật' : 'tắt');
  req.flash('success', 'Đã lưu cài đặt chat');
  res.redirect('/admin/chat/settings');
});

router.post('/staff/add', adminOnly, (req, res) => {
  const q = str(req.body.user, 120).trim();
  const u = q && db.prepare('SELECT id, username, role, staff FROM users WHERE username = ? OR email = ?').get(q, q.toLowerCase());
  if (!u) { req.flash('error', 'Không tìm thấy tài khoản ' + q); return res.redirect('/admin/chat/settings#staff'); }
  if (u.role === 'admin') { req.flash('error', 'Tài khoản admin đã có toàn quyền chat'); return res.redirect('/admin/chat/settings#staff'); }
  db.prepare('UPDATE users SET staff = 1, staff_name = COALESCE(staff_name, ?) WHERE id = ?').run(str(req.body.name, 40) || u.username, u.id);
  audit(req, 'chat_staff_add', u.username);
  req.flash('success', `Đã thêm nhân viên ${u.username}. Nhân viên đăng nhập như khách rồi vào /admin/chat`);
  res.redirect('/admin/chat/settings#staff');
});
router.post('/staff/:id/save', adminOnly, (req, res) => {
  const tgId = str(req.body.staff_tg, 30).trim();
  db.prepare('UPDATE users SET staff_name = ?, staff_tg = ? WHERE id = ? AND staff = 1').run(str(req.body.staff_name, 40) || null, /^-?\d{3,20}$/.test(tgId) ? tgId : null, toInt(req.params.id));
  req.flash('success', 'Đã lưu nhân viên'); res.redirect('/admin/chat/settings#staff');
});
router.post('/staff/:id/remove', adminOnly, (req, res) => {
  const u = db.prepare('SELECT username FROM users WHERE id = ? AND staff = 1').get(toInt(req.params.id));
  if (u) { db.prepare('UPDATE users SET staff = 0 WHERE id = ?').run(toInt(req.params.id)); audit(req, 'chat_staff_remove', u.username); }
  req.flash('success', 'Đã gỡ quyền nhân viên'); res.redirect('/admin/chat/settings#staff');
});

module.exports = router;
