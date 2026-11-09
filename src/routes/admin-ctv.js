'use strict';
/**
 * Cộng tác viên:
 *  /admin/ctv/...  — Quản lý CTV (admin + CTV quản lý): danh sách, quyền bán, hoa hồng, số dư, lệnh rút tiền.
 *  /admin/me/...   — Trang của chính CTV: tổng quan doanh thu, ví & rút tiền.
 * Gắn vào router admin (đã qua phân quyền + CSRF).
 */
const express = require('express');
const { db, logActivity } = require('../db');
const H = require('../utils/helpers');
const ctv = require('../services/ctv');

const { toInt, str, clientIp, paginate } = H;
const router = express.Router();
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const back = (req, res, type, msg, url) => { req.flash(type, msg); res.redirect(url); };
const nowS = () => Math.floor(Date.now() / 1000);
const dayStart = (daysAgo = 0) => Math.floor((Date.now() + 7 * 3600e3) / 86400e3 - daysAgo) * 86400 - 7 * 3600;
const KIND_NAME = { vip: 'Acc VIP', reroll: 'Reroll', boost: 'Cày thuê', topup: 'Nạp game' };
const LEDGER_NAME = { sale: 'Bán sản phẩm', boost: 'Hoàn thành đơn', refund: 'Đơn bị hoàn tiền', reverse: 'Trừ lại đơn', withdraw: 'Rút tiền', withdraw_reject: 'Hoàn lệnh rút', adjust: 'Điều chỉnh' };

const isMgr = (req) => req.perm === 'admin' || req.perm === 'manager';
const mgrOnly = (req, res, next) => (isMgr(req) ? next() : res.status(403).render('errors/error', { code: 403, message: 'Bạn không có quyền vào trang này' }));
/** Quản lý chỉ quản được CTV bán hàng / CSKH (không đụng admin, quản lý khác, chính mình) */
const canManage = (req, u) => !!u && u.role !== 'admin' && (req.perm === 'admin' || (u.ctv_role !== 'manager' && u.id !== req.user.id));
const roleLabel = (u) => (u.ctv_role ? ctv.ROLES[u.ctv_role] : u.staff ? ctv.ROLES.support : '');

// ======================= QUẢN LÝ CTV =======================
router.get('/ctv', mgrOnly, (req, res) => {
  const tab = ['manager', 'seller', 'support'].includes(req.query.tab) ? req.query.tab : '';
  const where = tab === 'support' ? 'u.staff = 1 AND u.ctv_role IS NULL' : tab ? 'u.ctv_role = ?' : "(u.ctv_role IS NOT NULL OR u.staff = 1)";
  const list = db.prepare(`SELECT u.id, u.username, u.email, u.ctv_role, u.staff, u.ctv_rate, u.ctv_balance, u.ctv_paused, u.staff_name,
      (SELECT COALESCE(SUM(ctv_amount), 0) FROM sales s WHERE s.ctv_id = u.id AND s.status = 'ok') AS earned,
      (SELECT COUNT(*) FROM ctv_withdrawals w WHERE w.user_id = u.id AND w.status = 'pending') AS pending
    FROM users u WHERE ${where} ORDER BY u.ctv_role IS NULL, u.ctv_role, u.id`).all(...(tab && tab !== 'support' ? [tab] : []));
  const gr = db.prepare('SELECT gr.user_id, g.name AS game, c.name AS cat FROM ctv_grants gr JOIN games g ON g.id = gr.game_id LEFT JOIN categories c ON c.id = gr.category_id').all();
  list.forEach((u) => { u.role = roleLabel(u); u.grants = gr.filter((x) => x.user_id === u.id).map((x) => x.cat ? `${x.game} › ${x.cat}` : `${x.game} (cả game)`); });
  const counts = db.prepare("SELECT SUM(ctv_role = 'manager') manager, SUM(ctv_role = 'seller') seller, SUM(staff = 1 AND ctv_role IS NULL) support FROM users").get();
  res.render('admin/ctv-list', { title: 'Quản lý CTV', list, tab, counts, pendingWd: db.prepare("SELECT COUNT(*) n FROM ctv_withdrawals WHERE status = 'pending'").get().n });
});

router.post('/ctv/add', mgrOnly, (req, res) => {
  const q = str(req.body.user, 120).trim();
  const role = ['manager', 'seller', 'support'].includes(req.body.role) ? req.body.role : 'seller';
  const u = q && db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(q, q.toLowerCase());
  if (!u) return back(req, res, 'error', 'Không tìm thấy tài khoản ' + q, '/admin/ctv');
  if (u.role === 'admin') return back(req, res, 'error', 'Tài khoản admin đã có toàn quyền', '/admin/ctv');
  if (role === 'manager' && req.perm !== 'admin') return back(req, res, 'error', 'Chỉ admin mới thêm được CTV quản lý', '/admin/ctv');
  if (!canManage(req, u)) return back(req, res, 'error', 'Bạn không có quyền với tài khoản này', '/admin/ctv');
  if (role === 'support') db.prepare('UPDATE users SET staff = 1, ctv_paused = 0 WHERE id = ?').run(u.id);
  else db.prepare('UPDATE users SET ctv_role = ?, ctv_rate = ?, ctv_paused = 0 WHERE id = ?').run(role, toInt(req.body.rate, u.ctv_rate ?? 20, 0, 100), u.id);
  audit(req, 'ctv_add', `${u.username} -> ${role}`);
  back(req, res, 'success', `Đã thêm ${u.username} làm CTV ${ctv.ROLES[role]}. CTV đăng nhập như khách rồi vào trang /admin`, '/admin/ctv/' + u.id);
});

const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
router.get('/ctv/withdrawals', mgrOnly, (req, res) => {
  const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const result = paginate(db, {
    select: 'w.*, u.username, h.username AS handler', from: 'ctv_withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN users h ON h.id = w.handled_by',
    where: 'WHERE w.status = ?', params: [status], order: 'ORDER BY w.id DESC', page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM ctv_withdrawals GROUP BY status').all().map((r) => [r.status, r.n]));
  res.render('admin/ctv-withdrawals', { title: 'Lệnh rút tiền CTV', result, status, counts, bankName: ctv.bankName, query: { status } });
});
router.post('/ctv/withdrawals/:id/:act', mgrOnly, (req, res) => {
  const act = req.params.act === 'paid' ? 'paid' : 'reject';
  const r = ctv.handleWithdraw(toInt(req.params.id), act, req.user.id, req.body.note);
  if (!r.ok) return back(req, res, 'error', r.message, '/admin/ctv/withdrawals');
  audit(req, 'ctv_withdraw_' + act, `${r.w.code} ${r.w.amount}`);
  const u = userById(r.w.user_id);
  ctv.notify([u.id], act === 'paid' ? `✅ Lệnh rút ${r.w.code} (${H.money(r.w.amount)}) đã được chuyển khoản.` : `❌ Lệnh rút ${r.w.code} bị từ chối: ${str(req.body.note, 300)}. Tiền đã hoàn lại vào số dư.`);
  back(req, res, 'success', act === 'paid' ? `Đã xác nhận chuyển ${H.money(r.w.amount)} cho ${u.username}` : 'Đã từ chối và hoàn tiền vào số dư CTV', '/admin/ctv/withdrawals');
});

router.get('/ctv/:id', mgrOnly, (req, res, next) => {
  const u = userById(toInt(req.params.id));
  if (!u || (!u.ctv_role && !u.staff)) return next();
  res.render('admin/ctv-detail', {
    title: 'CTV ' + u.username, u, role: roleLabel(u), editable: canManage(req, u),
    grants: ctv.grants(u.id),
    games: db.prepare('SELECT id, name FROM games ORDER BY sort_order, id').all(),
    cats: db.prepare("SELECT c.id, c.game_id, c.name, c.sale_type FROM categories c ORDER BY c.sort_order, c.id").all(),
    stats: statsOf(u.id),
    ledger: db.prepare('SELECT * FROM ctv_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id),
    withdrawals: db.prepare('SELECT * FROM ctv_withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id),
    LEDGER_NAME, KIND_NAME, bankName: ctv.bankName, isAdmin: req.perm === 'admin',
  });
});
router.post('/ctv/:id/save', mgrOnly, (req, res) => {
  const u = userById(toInt(req.params.id));
  if (!canManage(req, u)) return back(req, res, 'error', 'Bạn không có quyền với tài khoản này', '/admin/ctv');
  let role = ['manager', 'seller'].includes(req.body.ctv_role) ? req.body.ctv_role : null;
  if (role === 'manager' && req.perm !== 'admin') role = u.ctv_role === 'manager' ? 'manager' : 'seller';
  const tgId = str(req.body.staff_tg, 30).trim();
  db.prepare('UPDATE users SET ctv_role = ?, staff = ?, ctv_rate = ?, ctv_paused = ?, staff_name = ?, staff_tg = ? WHERE id = ?').run(
    role, H.bool(req.body.staff) ? 1 : 0, toInt(req.body.ctv_rate, 20, 0, 100), H.bool(req.body.ctv_paused) ? 1 : 0,
    str(req.body.staff_name, 40) || null, /^-?\d{3,20}$/.test(tgId) ? tgId : null, u.id,
  );
  if (H.bool(req.body.ctv_paused) || role !== 'seller') db.prepare("UPDATE products SET status = 'hidden' WHERE owner_id = ? AND status = 'available'").run(u.id); // tạm dừng -> ẩn hàng
  audit(req, 'ctv_update', `${u.username}: ${role || 'none'} ${req.body.ctv_rate}%${H.bool(req.body.ctv_paused) ? ' tạm dừng' : ''}`);
  if (!role && !H.bool(req.body.staff)) return back(req, res, 'success', `Đã gỡ quyền CTV của ${u.username}`, '/admin/ctv');
  back(req, res, 'success', 'Đã lưu CTV', '/admin/ctv/' + u.id);
});
router.post('/ctv/:id/grants/add', mgrOnly, (req, res) => {
  const u = userById(toInt(req.params.id));
  if (!canManage(req, u)) return back(req, res, 'error', 'Bạn không có quyền với tài khoản này', '/admin/ctv');
  const gameId = toInt(req.body.game_id); const catId = toInt(req.body.category_id, 0) || null;
  if (!db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) return back(req, res, 'error', 'Chọn game', '/admin/ctv/' + u.id);
  if (catId && !db.prepare('SELECT 1 FROM categories WHERE id = ? AND game_id = ?').get(catId, gameId)) return back(req, res, 'error', 'Danh mục không thuộc game đã chọn', '/admin/ctv/' + u.id);
  db.prepare('INSERT OR IGNORE INTO ctv_grants(user_id, game_id, category_id) VALUES(?,?,?)').run(u.id, gameId, catId);
  audit(req, 'ctv_grant', `${u.username}: game ${gameId} cat ${catId || 'all'}`);
  back(req, res, 'success', 'Đã cấp quyền bán', '/admin/ctv/' + u.id);
});
router.post('/ctv/:id/grants/:gid/delete', mgrOnly, (req, res) => {
  const u = userById(toInt(req.params.id));
  if (!canManage(req, u)) return back(req, res, 'error', 'Bạn không có quyền với tài khoản này', '/admin/ctv');
  db.prepare('DELETE FROM ctv_grants WHERE id = ? AND user_id = ?').run(toInt(req.params.gid), u.id);
  audit(req, 'ctv_ungrant', `${u.username}: ${req.params.gid}`);
  back(req, res, 'success', 'Đã gỡ quyền bán', '/admin/ctv/' + u.id);
});
router.post('/ctv/:id/adjust', mgrOnly, (req, res) => {
  const u = userById(toInt(req.params.id));
  if (!canManage(req, u)) return back(req, res, 'error', 'Bạn không có quyền với tài khoản này', '/admin/ctv');
  const amount = toInt(req.body.amount, 0, -1e10, 1e10);
  const note = str(req.body.note, 200);
  if (!amount || !note) return back(req, res, 'error', 'Nhập số tiền (âm = trừ) và lý do', '/admin/ctv/' + u.id);
  ctv.adjust(u.id, amount, note);
  audit(req, 'ctv_adjust', `${u.username}: ${amount} (${note})`);
  back(req, res, 'success', 'Đã điều chỉnh số dư CTV', '/admin/ctv/' + u.id);
});

// ======================= TRANG CỦA CTV =======================
function statsOf(userId, types = null) {
  const ranges = { today: dayStart(0), d7: dayStart(6), d30: dayStart(29), all: 0 };
  const rows = {};
  for (const kind of types || ['vip', 'reroll', 'boost', 'topup']) {
    rows[kind] = {};
    for (const [k, from] of Object.entries(ranges)) {
      rows[kind][k] = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(price), 0) sold, COALESCE(SUM(ctv_amount), 0) earn FROM sales WHERE ctv_id = ? AND kind = ? AND status = 'ok' AND created_at >= ?").get(userId, kind, from);
    }
  }
  return rows;
}
router.get('/me', (req, res) => {
  if (req.perm !== 'seller') return res.redirect(req.perm === 'support' ? '/admin/chat' : '/admin');
  const u = userById(req.user.id);
  const types = req.perm === 'seller' ? ctv.allowedTypes(u.id) : [];
  const kinds = ['vip', 'reroll', 'boost', 'topup'].filter((k) => types.includes(k));
  let open = null;
  if (kinds.includes('boost') || kinds.includes('topup')) {
    const ids = ctv.allowedCats(u.id, ['boost', 'topup']);
    const inIds = ids.length ? ids.join(',') : '0';
    open = db.prepare(`SELECT SUM(ctv_id IS NULL AND status = 'received') waiting, SUM(ctv_id = ? AND status IN ('received','processing','need_info')) mine FROM boost_orders WHERE parent_id IN (${inIds})`).get(u.id);
  }
  res.render('admin/ctv-me', {
    title: 'Tổng quan CTV', u, role: roleLabel(u), kinds, stats: statsOf(u.id, kinds), KIND_NAME, open,
    ledger: db.prepare('SELECT * FROM ctv_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(u.id), LEDGER_NAME,
    pending: db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM ctv_withdrawals WHERE user_id = ? AND status = 'pending'").get(u.id).s,
    products: kinds.some((k) => k === 'vip' || k === 'reroll') ? db.prepare("SELECT SUM(status = 'available') on_sale, SUM(status = 'sold') sold FROM products WHERE owner_id = ?").get(u.id) : null,
  });
});
router.get('/me/wallet', (req, res) => {
  if (req.perm !== 'seller') return res.redirect(req.perm === 'support' ? '/admin/chat' : '/admin');
  const u = userById(req.user.id);
  let bank = {}; try { bank = JSON.parse(u.ctv_bank || '{}') || {}; } catch { bank = {}; }
  res.render('admin/ctv-wallet', {
    title: 'Ví & rút tiền', u, bank, BANKS: ctv.BANKS, MIN: ctv.MIN_WITHDRAW, bankName: ctv.bankName, LEDGER_NAME,
    ledger: db.prepare('SELECT * FROM ctv_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id),
    withdrawals: db.prepare('SELECT * FROM ctv_withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(u.id),
  });
});
router.post('/me/withdraw', (req, res) => {
  if (req.perm !== 'seller') return res.redirect(req.perm === 'support' ? '/admin/chat' : '/admin');
  const r = ctv.withdraw(req.user.id, req.body);
  if (!r.ok) return back(req, res, 'error', r.message, '/admin/me/wallet');
  audit(req, 'ctv_withdraw', `${r.code} ${req.body.amount}`);
  require('../services/backup').notifyAdmin(`💸 CTV ${req.user.username} tạo lệnh rút ${r.code}: ${H.money(toInt(req.body.amount, 0))}`).catch(() => {});
  back(req, res, 'success', `Đã gửi lệnh rút ${r.code}.`, '/admin/me/wallet');
});

module.exports = { router, statsOf, KIND_NAME, nowS };
