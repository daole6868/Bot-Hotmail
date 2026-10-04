'use strict';
/**
 * Bộ máy đơn dịch vụ dùng chung cho 2 loại (kind):
 *  - 'boost' Cày thuê: Game -> danh mục loại Cày thuê -> danh mục con -> gói
 *  - 'topup' Nạp game: Game -> danh mục loại Nạp game -> gói (danh mục con ẩn, tạo tự động)
 * Giỏ hàng theo từng game + từng loại (lưu trên server, tự hết hạn), đặt đơn, 5 trạng thái, hoàn tiền, thông báo.
 *
 * Trạng thái: received (Nhận đơn) -> processing (Đang xử lý / Đang nạp) -> done (Đã xong / Đã nạp xong)
 *             need_info (Cần bổ sung thông tin: khách tự sửa thông tin -> quay lại Nhận đơn)
 *             cancelled (Đã hủy – tự hoàn tiền vào số dư)
 * Thông tin khách: method 'login' = tài khoản + mật khẩu (mã hóa, tự xóa sau N ngày) ; 'uid' = UID + server + tên nhân vật.
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
const STATUS_TOPUP = { ...STATUS, processing: { label: 'Đang nạp', tone: 'yellow' }, done: { label: 'Đã nạp xong', tone: 'green' } };
const KINDS = {
  boost: { name: 'Cày thuê', prefix: 'CT', status: STATUS, icon: '🛠' },
  topup: { name: 'Nạp game', prefix: 'NG', status: STATUS_TOPUP, icon: '💎' },
};
const kindOf = (k) => KINDS[k] || KINDS.boost;
const statusMap = (k) => kindOf(k).status;
const OPEN = ['received', 'processing', 'need_info'];
const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
class BoostError extends Error {}

const cartHours = (s = getSettings()) => int(s.boost_cart_hours, 24, 1, 720);
const parseOpts = (c) => { try { return JSON.parse(c?.options || '{}') || {}; } catch { return {}; } };
/** Hình thức nhập thông tin của danh mục: Cày thuê luôn là tài khoản/mật khẩu; Nạp game chọn trong admin */
const methodOf = (parent) => (parent?.sale_type === 'topup' && parseOpts(parent).method === 'uid' ? 'uid' : 'login');

/** Nạp game: Game -> Nạp game -> Gói. Gói nằm trong 1 danh mục con ẩn (tự tạo) để dùng chung bảng / giỏ / đơn với Cày thuê */
function topupSub(parent, create = true) {
  const row = db.prepare('SELECT * FROM boost_categories WHERE parent_id = ? ORDER BY id LIMIT 1').get(parent.id);
  if (row || !create) return row || null;
  const id = db.prepare('INSERT INTO boost_categories(game_id, parent_id, name, slug, sort_order, is_active) VALUES(?,?,?,?,0,1)')
    .run(parent.game_id, parent.id, parent.name, `_ng${parent.id}`).lastInsertRowid;
  return db.prepare('SELECT * FROM boost_categories WHERE id = ?').get(id);
}

// ---------- Giỏ hàng ----------
const pkgStmt = db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug, c.game_id, c.is_active AS cat_active, g.is_active AS game_active, g.slug AS game_slug,
    pc.is_active AS parent_active, pc.sale_type AS kind, pc.id AS parent_id
  FROM boost_packages p JOIN boost_categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id JOIN categories pc ON pc.id = c.parent_id WHERE p.id = ?`);
const orderable = (p) => p && p.is_active && p.cat_active && p.game_active && p.parent_active;

// Nạp game: mỗi danh mục 1 giỏ riêng (parentId) vì mỗi danh mục có hình thức nhập UID / tài khoản riêng
function cartItems(userId, gameId, kind = 'boost', parentId = 0) {
  if (!userId) return [];
  const minAt = nowS() - cartHours() * 3600;
  return db.prepare(`SELECT b.qty, p.id, p.name, p.price, p.old_price, p.unit, p.min_qty, p.max_qty, p.is_paused, p.icon, p.icon_color, p.image,
      c.name AS category_name, c.slug AS category_slug, pc.name AS parent_name
    FROM boost_carts b JOIN boost_packages p ON p.id = b.package_id JOIN boost_categories c ON c.id = p.category_id JOIN categories pc ON pc.id = c.parent_id
    WHERE b.user_id = ? AND b.game_id = ? AND b.updated_at > ? AND p.is_active = 1 AND c.is_active = 1 AND pc.is_active = 1 AND pc.sale_type = ? AND (? = 0 OR pc.id = ?)
    ORDER BY b.updated_at, p.id`).all(userId, gameId, minAt, kind, parentId, parentId)
    .map((r) => ({ ...r, category_name: kind === 'topup' ? r.parent_name : r.category_name, line: r.price * r.qty }));
}
function cartSummary(userId, gameId, kind = 'boost', parentId = 0) {
  const items = cartItems(userId, gameId, kind, parentId);
  return { items, count: items.reduce((a, b) => a + b.qty, 0), subtotal: items.reduce((a, b) => a + b.line, 0) };
}
// Đổi số lượng (qty = 0 -> xóa). add = true: cộng thêm vào số đang có
function setCart(userId, packageId, qty, add = false) {
  const p = pkgStmt.get(packageId);
  if (!orderable(p)) throw new BoostError('Gói không tồn tại hoặc đã ngừng bán');
  if (p.is_paused) throw new BoostError('Gói đang tạm ngưng nhận đơn');
  const res = { gameId: p.game_id, kind: p.kind, parentId: p.kind === 'topup' ? p.parent_id : 0 };
  const cur = db.prepare('SELECT qty, updated_at FROM boost_carts WHERE user_id = ? AND package_id = ?').get(userId, packageId);
  const alive = cur && cur.updated_at > nowS() - cartHours() * 3600;
  let n = add ? (alive ? cur.qty : 0) + (qty || p.min_qty) : qty;
  if (n <= 0) { db.prepare('DELETE FROM boost_carts WHERE user_id = ? AND package_id = ?').run(userId, packageId); return res; }
  n = Math.min(p.max_qty, Math.max(p.min_qty, n));
  db.prepare(`INSERT INTO boost_carts(user_id, game_id, package_id, qty, updated_at) VALUES(?,?,?,?,unixepoch())
    ON CONFLICT(user_id, package_id) DO UPDATE SET qty = excluded.qty, updated_at = unixepoch()`).run(userId, p.game_id, packageId, n);
  // giữ cả giỏ của game này "còn sống" khi khách đang thao tác
  db.prepare('UPDATE boost_carts SET updated_at = unixepoch() WHERE user_id = ? AND game_id = ?').run(userId, p.game_id);
  return res;
}
const purgeCarts = () => db.prepare('DELETE FROM boost_carts WHERE updated_at < ?').run(nowS() - cartHours() * 3600).changes;

/** Thông tin nạp lần trước của khách ở game này (điền sẵn form): UID, server, tên nhân vật, liên hệ */
function lastInfo(userId, gameId) {
  if (!userId) return {};
  const t = db.prepare("SELECT uid, server, char_name FROM boost_orders WHERE user_id = ? AND game_id = ? AND kind = 'topup' AND uid IS NOT NULL ORDER BY id DESC LIMIT 1").get(userId, gameId) || {};
  const c = db.prepare('SELECT contact FROM boost_orders WHERE user_id = ? AND contact IS NOT NULL ORDER BY id DESC LIMIT 1').get(userId);
  return { uid: t.uid || '', server: t.server || '', char_name: t.char_name || '', contact: c?.contact || '' };
}

// ---------- Đặt đơn ----------
function genCode(prefix) {
  for (let i = 0; i < 5; i++) {
    const c = prefix + randomCode(6);
    if (!db.prepare('SELECT 1 FROM boost_orders WHERE code = ?').get(c)) return c;
  }
  return prefix + randomCode(8);
}

const checkoutTx = db.transaction((userId, gameId, f, ip, kind, parentId) => {
  const K = kindOf(kind);
  const s = getSettings();
  const user = db.prepare('SELECT id, balance, status FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active') throw new BoostError('Tài khoản không hợp lệ');
  const open = db.prepare(`SELECT COUNT(*) n FROM boost_orders WHERE user_id = ? AND status IN ('received','processing','need_info')`).get(userId).n;
  if (open >= int(s.boost_max_open, 5, 1, 100)) throw new BoostError(`Bạn đang có ${open} đơn chưa xong. Vui lòng đợi đơn cũ hoàn thành.`);
  const items = cartItems(userId, gameId, kind, parentId);
  if (!items.length) throw new BoostError('Giỏ hàng trống hoặc đã hết hạn');
  for (const it of items) {
    if (it.is_paused) throw new BoostError(`Gói "${it.name}" đang tạm ngưng nhận đơn, hãy xóa khỏi giỏ`);
    if (it.qty < it.min_qty || it.qty > it.max_qty) throw new BoostError(`Số lượng gói "${it.name}" phải từ ${it.min_qty} đến ${it.max_qty}`);
  }
  const game = db.prepare('SELECT id, name FROM games WHERE id = ?').get(gameId);
  const subtotal = items.reduce((a, b) => a + b.line, 0);
  let discount = 0; let coupon = null;
  if (f.coupon) {
    const v = validateCoupon(f.coupon, userId, subtotal, gameId, kind);
    if (!v.ok) throw new BoostError(v.message);
    discount = v.discount; coupon = v.coupon;
  }
  const total = subtotal - discount;
  if (user.balance < total) throw new BoostError(`Số dư không đủ. Cần ${money(total)}, bạn có ${money(user.balance)}`);
  const upd = db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ? AND balance >= ?').run(total, total, userId, total);
  if (upd.changes !== 1) throw new BoostError('Số dư không đủ');

  const code = genCode(K.prefix);
  const login = f.method === 'login' ? encrypt(JSON.stringify({ u: f.account, p: f.password })) : null;
  const id = db.prepare(`INSERT INTO boost_orders(code, user_id, game_id, game_name, subtotal, discount, total, coupon_code, login_enc, server, note, contact, ip,
      kind, method, uid, char_name)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, userId, gameId, game?.name || '', subtotal, discount, total, coupon?.code || null, login,
    f.server || null, f.note || null, f.contact, ip, kind, f.method, f.method === 'uid' ? f.uid : null, f.method === 'uid' ? (f.char_name || null) : null).lastInsertRowid;
  const insItem = db.prepare('INSERT INTO boost_order_items(order_id, package_id, name, category_name, unit, price, qty, line_total) VALUES(?,?,?,?,?,?,?,?)');
  const sold = db.prepare('UPDATE boost_packages SET sold_count = sold_count + ? WHERE id = ?');
  const delCart = db.prepare('DELETE FROM boost_carts WHERE user_id = ? AND package_id = ?');
  for (const it of items) { insItem.run(id, it.id, it.name, it.category_name, it.unit, it.price, it.qty, it.line); sold.run(it.qty, it.id); delCart.run(userId, it.id); }
  db.prepare('INSERT INTO boost_order_events(order_id, status, message) VALUES(?,?,?)').run(id, 'received', 'Đặt đơn thành công');
  if (coupon) {
    db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(coupon.id);
    db.prepare('INSERT INTO coupon_usages(coupon_id, user_id, boost_order_id) VALUES(?,?,?)').run(coupon.id, userId, id);
  }
  const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)').run(userId, -total, bal, kind, code, `${K.name} ${game?.name || ''}`);
  db.prepare(`UPDATE boost_orders SET parent_id = (SELECT bc.parent_id FROM boost_order_items i JOIN boost_packages p ON p.id = i.package_id
    JOIN boost_categories bc ON bc.id = p.category_id WHERE i.order_id = ? LIMIT 1) WHERE id = ?`).run(id, id);
  require('./ctv').onBoostCheckout({ id, kind, code, total, subtotal });
  bumpStat(kind + '_revenue', total);
  bumpStat(kind + '_orders', 1);
  return { id, code, total, items, game: game?.name, contact: f.contact, kind, method: f.method, uid: f.uid, server: f.server, char_name: f.char_name };
});

/**
 * Đặt đơn. kind + parent (danh mục Cày thuê / Nạp game) quyết định form: login (tài khoản + mật khẩu) hay uid.
 * f: account, password | uid, uid2, char_name ; server, note, contact, coupon
 */
function checkout(userId, gameId, raw, ip, kind = 'boost', parent = null) {
  const t = (v, n) => String(v || '').trim().slice(0, n);
  const f = {
    method: kind === 'topup' ? methodOf(parent) : 'login',
    account: t(raw.account, 120), password: String(raw.password || '').slice(0, 120),
    uid: t(raw.uid, 60), uid2: t(raw.uid2, 60), char_name: t(raw.char_name, 60),
    server: t(raw.server, 60), note: t(raw.note, 1000), coupon: t(raw.coupon, 32), contact: t(raw.contact, 120),
  };
  if (f.method === 'uid') {
    if (!f.uid) return { ok: false, message: 'Vui lòng nhập UID / ID nhân vật' };
    if (f.uid !== f.uid2) return { ok: false, message: 'Hai lần nhập UID không khớp, vui lòng kiểm tra lại' };
  } else {
    if (!f.account) return { ok: false, message: 'Vui lòng nhập tài khoản game' };
    if (!f.password) return { ok: false, message: 'Vui lòng nhập mật khẩu game' };
  }
  if (!f.contact) return { ok: false, message: 'Vui lòng nhập thông tin liên hệ (Zalo / SĐT / Facebook)' };
  try {
    const r = checkoutTx.immediate(userId, gameId, f, ip, kind, kind === 'topup' ? (parent?.id || 0) : 0);
    logActivity(userId, kind === 'topup' ? 'topup_order' : 'boost_order', `${r.code} ${r.total}`, ip);
    require('./tracking').track(userId, 'purchase', r.total, r.code);
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
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)').run(o.user_id, o.total, bal, 'refund', o.code, `Hoàn tiền đơn ${kindOf(o.kind).name.toLowerCase()}: ${reason}`);
  bumpStat('refunds', o.total);
  return true;
});

const setStatusTx = db.transaction((id, status, msg, byAdmin, proof) => {
  const o = orderStmt.get(id);
  if (!o) throw new BoostError('Không tìm thấy đơn');
  if (o.status === 'cancelled') throw new BoostError('Đơn đã hủy, không đổi trạng thái được');
  if (!STATUS[status]) throw new BoostError('Trạng thái không hợp lệ');
  if (proof) db.prepare('UPDATE boost_orders SET proof = ? WHERE id = ?').run(proof, id);
  if (status === o.status && !msg) return orderStmt.get(id);
  const final = status === 'done' || status === 'cancelled';
  db.prepare(`UPDATE boost_orders SET status = ?, customer_msg = COALESCE(?, customer_msg), updated_at = unixepoch(), finished_at = ${final ? 'unixepoch()' : 'finished_at'} WHERE id = ?`)
    .run(status, msg || null, id);
  db.prepare('INSERT INTO boost_order_events(order_id, status, message, by_admin) VALUES(?,?,?,?)').run(id, status, msg || null, byAdmin ? 1 : 0);
  if (status === 'cancelled') refundTx(o, msg || 'đơn bị hủy');
  require('./ctv').onBoostStatus(orderStmt.get(id), status); // Đã xong -> cộng tiền CTV thực hiện; hủy / mở lại -> trừ lại
  return orderStmt.get(id);
});

/** proof: đường dẫn ảnh xác nhận (đã lưu) — tùy chọn */
function setStatus(id, status, msg, adminId, proof = null) {
  try {
    const before = orderStmt.get(id);
    const o = setStatusTx.immediate(id, status, String(msg || '').trim().slice(0, 1000) || null, !!adminId, proof);
    if (adminId) logActivity(adminId, 'boost_status', `${o.code} -> ${status}`, null);
    if (before && (before.status !== o.status || msg)) notifyStatus(o);
    return { ok: true, order: o, oldProof: proof && before?.proof !== proof ? before?.proof : null };
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
  const t = (v, n) => String(v || '').trim().slice(0, n);
  const contact = t(f.contact, 120);
  if (!contact) return { ok: false, message: 'Vui lòng nhập thông tin liên hệ (Zalo / SĐT / Facebook)' };
  const server = t(f.server, 60) || null; const note = t(f.note, 1000);
  if (o.method === 'uid') {
    const uid = t(f.uid, 60);
    if (!uid) return { ok: false, message: 'Vui lòng nhập UID / ID nhân vật' };
    if (uid !== t(f.uid2, 60)) return { ok: false, message: 'Hai lần nhập UID không khớp, vui lòng kiểm tra lại' };
    db.prepare('UPDATE boost_orders SET uid = ?, char_name = ?, server = ?, contact = ?, note = COALESCE(NULLIF(?, \'\'), note), updated_at = unixepoch() WHERE id = ?')
      .run(uid, t(f.char_name, 60) || null, server, contact, note, o.id);
    return setStatus(o.id, 'received', 'Khách đã cập nhật UID / thông tin nhân vật', null);
  }
  const account = t(f.account, 120); const password = String(f.password || '').slice(0, 120);
  if (!account || !password) return { ok: false, message: 'Vui lòng nhập đủ tài khoản và mật khẩu' };
  db.prepare('UPDATE boost_orders SET login_enc = ?, server = ?, contact = ?, note = COALESCE(NULLIF(?, \'\'), note), updated_at = unixepoch() WHERE id = ?')
    .run(encrypt(JSON.stringify({ u: account, p: password })), server, contact, note, o.id);
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
  if (u?.email) {
    require('./mailer').sendLater(u.email, 'boost', {
      username: u.username, code: o.code, status: o.status, label: statusMap(o.kind)[o.status].label, kindName: kindOf(o.kind).name,
      msg: o.customer_msg, total: o.total, refunded: o.status === 'cancelled',
    });
  }
}
function notifyNewOrder(r, userId) {
  const s = getSettings();
  // Báo CTV bán hàng được cấp danh mục của đơn
  try {
    const pid = db.prepare('SELECT parent_id FROM boost_orders WHERE code = ?').get(r.code)?.parent_id;
    const ctv = require('./ctv');
    if (pid) ctv.notify(ctv.sellersOfCat(pid), `${kindOf(r.kind).icon} Đơn ${kindOf(r.kind).name.toLowerCase()} mới ${r.code} — ${r.game}\n${r.items.map((i) => `• ${i.name} x${i.qty}`).join('\n')}\nVào trang quản lý để nhận đơn.`);
  } catch (e) { console.error('[ctv] notify', e.message); }
  const K = kindOf(r.kind);
  const u = db.prepare('SELECT username, email FROM users WHERE id = ?').get(userId);
  if (u?.email) require('./mailer').sendLater(u.email, 'boost', { username: u.username, code: r.code, status: 'received', label: STATUS.received.label, kindName: K.name, total: r.total, items: r.items });
  if (s.boost_tg_notify !== '0') {
    const lines = r.items.map((i) => `• ${i.name} x${i.qty} = ${money(i.line)}`).join('\n');
    const who = r.method === 'uid' ? `UID: ${r.uid}${r.server ? ' · Server: ' + r.server : ''}${r.char_name ? ' · ' + r.char_name : ''}\n` : '';
    require('./backup').notifyAdmin(`${K.icon} Đơn ${K.name.toLowerCase()} mới ${r.code}\n${r.game} — ${u?.username}\n${who}Liên hệ: ${r.contact}\n${lines}\nTổng: ${money(r.total)}`).catch(() => {});
  }
}

module.exports = {
  topupSub,
  STATUS, STATUS_TOPUP, KINDS, kindOf, statusMap, methodOf, parseOpts, OPEN,
  cartItems, cartSummary, setCart, purgeCarts, lastInfo, checkout, setStatus, customerCancel, customerUpdate, readLogin, wipeLogins, cartHours,
};
