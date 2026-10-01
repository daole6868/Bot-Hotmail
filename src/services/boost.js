'use strict';
/**
 * Cày thuê: giỏ hàng (theo từng game, lưu trên server, tự hết hạn), đặt đơn, 5 trạng thái đơn, hoàn tiền, thông báo.
 *
 * Trạng thái: received (Nhận đơn) -> processing (Đang xử lý) -> done (Đã xong)
 *             need_info (Cần bổ sung thông tin: khách tự sửa tài khoản/mật khẩu -> quay lại Nhận đơn)
 *             cancelled (Đã hủy – tự hoàn tiền vào số dư)
 * Đặt đơn / hoàn tiền chạy trong transaction IMMEDIATE: không trừ âm, không hoàn 2 lần dù nhiều request cùng lúc.
 */
const { db, getSettings, bumpStat, logActivity } = require('../db');
const { validateCoupon } = require('./coupon');
const { encrypt, decrypt, randomCode } = require('../utils/crypto');
const { money } = require('../utils/helpers');

const STATUS = {
  received: { label: 'Nhận đơn', tone: 'blue' },
  processing: { label: 'Đang xử lý', tone: 'yellow' },
  need_info: { label: 'Cần bổ sung thông tin', tone: 'orange' },
  done: { label: 'Đã xong', tone: 'green' },
  cancelled: { label: 'Đã hủy – hoàn tiền', tone: 'red' },
};
const OPEN = ['received', 'processing', 'need_info'];
const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
class BoostError extends Error {}

const cartHours = (s = getSettings()) => int(s.boost_cart_hours, 24, 1, 720);

// ---------- Giỏ hàng ----------
const pkgStmt = db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.game_id, c.is_active AS cat_active, g.is_active AS game_active, g.slug AS game_slug
  FROM boost_packages p JOIN boost_categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id WHERE p.id = ?`);
const orderable = (p) => p && p.is_active && p.cat_active && p.game_active;

function cartItems(userId, gameId) {
  if (!userId) return [];
  const minAt = nowS() - cartHours() * 3600;
  return db.prepare(`SELECT b.qty, p.id, p.name, p.price, p.old_price, p.unit, p.min_qty, p.max_qty, p.is_paused, p.icon, p.icon_color, p.image,
      c.name AS category_name, c.slug AS category_slug
    FROM boost_carts b JOIN boost_packages p ON p.id = b.package_id JOIN boost_categories c ON c.id = p.category_id
    WHERE b.user_id = ? AND b.game_id = ? AND b.updated_at > ? AND p.is_active = 1 AND c.is_active = 1
    ORDER BY b.updated_at, p.id`).all(userId, gameId, minAt)
    .map((r) => ({ ...r, line: r.price * r.qty }));
}
function cartSummary(userId, gameId) {
  const items = cartItems(userId, gameId);
  return { items, count: items.reduce((a, b) => a + b.qty, 0), subtotal: items.reduce((a, b) => a + b.line, 0) };
}
// Đổi số lượng (qty = 0 -> xóa). add = true: cộng thêm vào số đang có
function setCart(userId, packageId, qty, add = false) {
  const p = pkgStmt.get(packageId);
  if (!orderable(p)) throw new BoostError('Gói không tồn tại hoặc đã ngừng bán');
  if (p.is_paused) throw new BoostError('Gói đang tạm ngưng nhận đơn');
  const cur = db.prepare('SELECT qty, updated_at FROM boost_carts WHERE user_id = ? AND package_id = ?').get(userId, packageId);
  const alive = cur && cur.updated_at > nowS() - cartHours() * 3600;
  let n = add ? (alive ? cur.qty : 0) + (qty || p.min_qty) : qty;
  if (n <= 0) { db.prepare('DELETE FROM boost_carts WHERE user_id = ? AND package_id = ?').run(userId, packageId); return { gameId: p.game_id }; }
  n = Math.min(p.max_qty, Math.max(p.min_qty, n));
  db.prepare(`INSERT INTO boost_carts(user_id, game_id, package_id, qty, updated_at) VALUES(?,?,?,?,unixepoch())
    ON CONFLICT(user_id, package_id) DO UPDATE SET qty = excluded.qty, updated_at = unixepoch()`).run(userId, p.game_id, packageId, n);
  // giữ cả giỏ của game này "còn sống" khi khách đang thao tác
  db.prepare('UPDATE boost_carts SET updated_at = unixepoch() WHERE user_id = ? AND game_id = ?').run(userId, p.game_id);
  return { gameId: p.game_id };
}
const purgeCarts = () => db.prepare('DELETE FROM boost_carts WHERE updated_at < ?').run(nowS() - cartHours() * 3600).changes;

// ---------- Đặt đơn ----------
function genCode() {
  for (let i = 0; i < 5; i++) {
    const c = 'CT' + randomCode(6);
    if (!db.prepare('SELECT 1 FROM boost_orders WHERE code = ?').get(c)) return c;
  }
  return 'CT' + randomCode(8);
}

const checkoutTx = db.transaction((userId, gameId, f, ip) => {
  const s = getSettings();
  const user = db.prepare('SELECT id, balance, status FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active') throw new BoostError('Tài khoản không hợp lệ');
  const open = db.prepare(`SELECT COUNT(*) n FROM boost_orders WHERE user_id = ? AND status IN ('received','processing','need_info')`).get(userId).n;
  if (open >= int(s.boost_max_open, 5, 1, 100)) throw new BoostError(`Bạn đang có ${open} đơn cày thuê chưa xong. Vui lòng đợi đơn cũ hoàn thành.`);
  const items = cartItems(userId, gameId);
  if (!items.length) throw new BoostError('Giỏ hàng trống hoặc đã hết hạn');
  for (const it of items) {
    if (it.is_paused) throw new BoostError(`Gói "${it.name}" đang tạm ngưng nhận đơn, hãy xóa khỏi giỏ`);
    if (it.qty < it.min_qty || it.qty > it.max_qty) throw new BoostError(`Số lượng gói "${it.name}" phải từ ${it.min_qty} đến ${it.max_qty}`);
  }
  const game = db.prepare('SELECT id, name FROM games WHERE id = ?').get(gameId);
  const subtotal = items.reduce((a, b) => a + b.line, 0);
  let discount = 0; let coupon = null;
  if (f.coupon) {
    const v = validateCoupon(f.coupon, userId, subtotal, gameId, 'boost');
    if (!v.ok) throw new BoostError(v.message);
    discount = v.discount; coupon = v.coupon;
  }
  const total = subtotal - discount;
  if (user.balance < total) throw new BoostError(`Số dư không đủ. Cần ${money(total)}, bạn có ${money(user.balance)}`);
  const upd = db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ? AND balance >= ?').run(total, total, userId, total);
  if (upd.changes !== 1) throw new BoostError('Số dư không đủ');

  const code = genCode();
  const login = encrypt(JSON.stringify({ u: f.account, p: f.password }));
  const id = db.prepare(`INSERT INTO boost_orders(code, user_id, game_id, game_name, subtotal, discount, total, coupon_code, login_enc, server, note, ip)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, userId, gameId, game?.name || '', subtotal, discount, total, coupon?.code || null, login, f.server || null, f.note || null, ip).lastInsertRowid;
  const insItem = db.prepare('INSERT INTO boost_order_items(order_id, package_id, name, category_name, unit, price, qty, line_total) VALUES(?,?,?,?,?,?,?,?)');
  const sold = db.prepare('UPDATE boost_packages SET sold_count = sold_count + ? WHERE id = ?');
  for (const it of items) { insItem.run(id, it.id, it.name, it.category_name, it.unit, it.price, it.qty, it.line); sold.run(it.qty, it.id); }
  db.prepare('INSERT INTO boost_order_events(order_id, status, message) VALUES(?,?,?)').run(id, 'received', 'Đặt đơn thành công');
  if (coupon) {
    db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(coupon.id);
    db.prepare('INSERT INTO coupon_usages(coupon_id, user_id, boost_order_id) VALUES(?,?,?)').run(coupon.id, userId, id);
  }
  const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)').run(userId, -total, bal, 'boost', code, `Cày thuê ${game?.name || ''}`);
  db.prepare('DELETE FROM boost_carts WHERE user_id = ? AND game_id = ?').run(userId, gameId);
  bumpStat('boost_revenue', total);
  bumpStat('boost_orders', 1);
  return { id, code, total, items, game: game?.name };
});

function checkout(userId, gameId, f, ip) {
  f = {
    account: String(f.account || '').trim().slice(0, 120), password: String(f.password || '').slice(0, 120),
    server: String(f.server || '').trim().slice(0, 60), note: String(f.note || '').trim().slice(0, 1000), coupon: String(f.coupon || '').trim().slice(0, 32),
  };
  if (!f.account) return { ok: false, message: 'Vui lòng nhập tài khoản game' };
  if (!f.password) return { ok: false, message: 'Vui lòng nhập mật khẩu game' };
  try {
    const r = checkoutTx.immediate(userId, gameId, f, ip);
    logActivity(userId, 'boost_order', `${r.code} ${r.total}`, ip);
    notifyNewOrder(r, userId);
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof BoostError) return { ok: false, message: e.message };
    throw e;
  }
}

// ---------- Trạng thái ----------
const orderStmt = db.prepare('SELECT * FROM boost_orders WHERE id = ?');
const refundTx = db.transaction((o, reason) => {
  const r = db.prepare("UPDATE boost_orders SET refunded = 1 WHERE id = ? AND refunded = 0").run(o.id);
  if (r.changes !== 1) return false;
  db.prepare('UPDATE users SET balance = balance + ?, total_spent = MAX(0, total_spent - ?) WHERE id = ?').run(o.total, o.total, o.user_id);
  const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(o.user_id).balance;
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)').run(o.user_id, o.total, bal, 'refund', o.code, 'Hoàn tiền đơn cày thuê: ' + reason);
  bumpStat('refunds', o.total);
  return true;
});

const setStatusTx = db.transaction((id, status, msg, byAdmin) => {
  const o = orderStmt.get(id);
  if (!o) throw new BoostError('Không tìm thấy đơn');
  if (o.status === 'cancelled') throw new BoostError('Đơn đã hủy, không đổi trạng thái được');
  if (!STATUS[status]) throw new BoostError('Trạng thái không hợp lệ');
  if (status === o.status && !msg) return o;
  const final = status === 'done' || status === 'cancelled';
  db.prepare(`UPDATE boost_orders SET status = ?, customer_msg = COALESCE(?, customer_msg), updated_at = unixepoch(), finished_at = ${final ? 'unixepoch()' : 'finished_at'} WHERE id = ?`)
    .run(status, msg || null, id);
  db.prepare('INSERT INTO boost_order_events(order_id, status, message, by_admin) VALUES(?,?,?,?)').run(id, status, msg || null, byAdmin ? 1 : 0);
  if (status === 'cancelled') refundTx(o, msg || 'đơn bị hủy');
  return orderStmt.get(id);
});

function setStatus(id, status, msg, adminId) {
  try {
    const o = setStatusTx.immediate(id, status, String(msg || '').trim().slice(0, 1000) || null, !!adminId);
    if (adminId) logActivity(adminId, 'boost_status', `${o.code} -> ${status}`, null);
    notifyStatus(o);
    return { ok: true, order: o };
  } catch (e) {
    if (e instanceof BoostError) return { ok: false, message: e.message };
    throw e;
  }
}

/** Khách tự hủy khi đơn còn "Nhận đơn" (nếu shop bật) */
function customerCancel(userId, code) {
  if (getSettings().boost_self_cancel === '0') return { ok: false, message: 'Shop không cho tự hủy đơn, vui lòng liên hệ admin' };
  const o = db.prepare('SELECT * FROM boost_orders WHERE code = ? AND user_id = ?').get(code, userId);
  if (!o) return { ok: false, message: 'Không tìm thấy đơn' };
  if (o.status !== 'received') return { ok: false, message: 'Đơn đã được shop xử lý, không tự hủy được' };
  return setStatus(o.id, 'cancelled', 'Khách tự hủy đơn', null);
}

/** Khách bổ sung thông tin khi đơn ở trạng thái "Cần bổ sung thông tin" -> quay lại "Nhận đơn" */
function customerUpdate(userId, code, f) {
  const o = db.prepare('SELECT * FROM boost_orders WHERE code = ? AND user_id = ?').get(code, userId);
  if (!o) return { ok: false, message: 'Không tìm thấy đơn' };
  if (o.status !== 'need_info') return { ok: false, message: 'Đơn không ở trạng thái cần bổ sung thông tin' };
  const account = String(f.account || '').trim().slice(0, 120); const password = String(f.password || '').slice(0, 120);
  if (!account || !password) return { ok: false, message: 'Vui lòng nhập đủ tài khoản và mật khẩu' };
  db.prepare('UPDATE boost_orders SET login_enc = ?, server = ?, note = COALESCE(NULLIF(?, \'\'), note), updated_at = unixepoch() WHERE id = ?')
    .run(encrypt(JSON.stringify({ u: account, p: password })), String(f.server || '').trim().slice(0, 60) || null, String(f.note || '').trim().slice(0, 1000), o.id);
  return setStatus(o.id, 'received', 'Khách đã cập nhật thông tin đăng nhập', null);
}

const readLogin = (o) => { if (!o.login_enc) return null; try { return JSON.parse(decrypt(o.login_enc)); } catch { return null; } };

// Xóa thông tin đăng nhập của khách sau N ngày kể từ khi đơn xong / hủy
function wipeLogins() {
  const days = int(getSettings().boost_wipe_days, 7, 1, 365);
  return db.prepare(`UPDATE boost_orders SET login_enc = NULL, login_wiped_at = unixepoch()
    WHERE login_enc IS NOT NULL AND status IN ('done','cancelled') AND finished_at < ?`).run(nowS() - days * 86400).changes;
}

// ---------- Thông báo ----------
function notifyStatus(o) {
  const u = db.prepare('SELECT username, email FROM users WHERE id = ?').get(o.user_id);
  if (u?.email) require('./mailer').sendLater(u.email, 'boost', { username: u.username, code: o.code, status: o.status, label: STATUS[o.status].label, msg: o.customer_msg, total: o.total, refunded: o.status === 'cancelled' });
}
function notifyNewOrder(r, userId) {
  const s = getSettings();
  const u = db.prepare('SELECT username, email FROM users WHERE id = ?').get(userId);
  if (u?.email) require('./mailer').sendLater(u.email, 'boost', { username: u.username, code: r.code, status: 'received', label: STATUS.received.label, total: r.total, items: r.items });
  if (s.boost_tg_notify !== '0') {
    const lines = r.items.map((i) => `• ${i.name} x${i.qty} = ${money(i.line)}`).join('\n');
    require('./backup').notifyAdmin(`🛠 Đơn cày thuê mới ${r.code}\n${r.game} — ${u?.username}\n${lines}\nTổng: ${money(r.total)}`).catch(() => {});
  }
}

module.exports = {
  STATUS, OPEN, cartItems, cartSummary, setCart, purgeCarts, checkout, setStatus, customerCancel, customerUpdate, readLogin, wipeLogins, cartHours,
};
