'use strict';
/**
 * Cộng tác viên (CTV):
 *  - manager (Quản lý): vào được mọi trang quản trị trừ nhóm Giao diện & Hệ thống, quản lý CTV bán hàng / CSKH.
 *  - seller (Bán hàng): được cấp cả game hoặc từng danh mục trong game.
 *      Acc VIP / Reroll: chỉ thấy & bán sản phẩm do mình đăng. Bán xong cộng tiền ngay.
 *      Cày thuê / Nạp game: các CTV cùng mục thấy chung danh mục con, gói; đơn chưa ai nhận thì ai cũng thấy,
 *      CTV nào đổi trạng thái trước là người thực hiện. Đơn "Đã xong" mới cộng tiền.
 *  - CSKH: cột users.staff (nhân viên chat).
 * Tiền CTV nhận = giá bán (trước mã giảm giá — shop chịu phần giảm) × (100% − hoa hồng shop).
 */
const crypto = require('crypto');
const { db, getSettings } = require('../db');
const { money } = require('../utils/helpers');

const ROLES = { manager: 'Quản lý', seller: 'Bán hàng', support: 'CSKH' };
const MIN_WITHDRAW = 10000;
const MAX_PENDING = 3;
// Ngân hàng nhận tiền (mã dùng cho ảnh VietQR)
const BANKS = [
  ['VCB', 'Vietcombank'], ['MB', 'MB Bank'], ['TCB', 'Techcombank'], ['ACB', 'ACB'], ['BIDV', 'BIDV'], ['ICB', 'VietinBank'],
  ['VBA', 'Agribank'], ['VPB', 'VPBank'], ['TPB', 'TPBank'], ['STB', 'Sacombank'], ['HDB', 'HDBank'], ['VIB', 'VIB'],
  ['SHB', 'SHB'], ['MSB', 'MSB'], ['OCB', 'OCB'], ['EIB', 'Eximbank'], ['SEAB', 'SeABank'], ['LPB', 'LPBank'],
  ['NAB', 'Nam A Bank'], ['BAB', 'Bac A Bank'], ['ABB', 'ABBANK'], ['KLB', 'KienlongBank'], ['VCCB', 'BVBank (Bản Việt)'],
  ['NCB', 'NCB'], ['PGB', 'PGBank'], ['SGICB', 'Saigonbank'], ['VAB', 'VietABank'], ['BVB', 'BaoViet Bank'],
  ['CAKE', 'CAKE by VPBank'], ['UBANK', 'Ubank by VPBank'], ['TIMO', 'Timo'], ['WOO', 'Woori Bank'], ['SHBVN', 'Shinhan Bank'],
];
const bankName = (code) => (BANKS.find((b) => b[0] === code) || [code, code])[1];

/** Vai trò quản trị của 1 tài khoản: admin | manager | seller | support | null */
function roleOf(u) {
  if (!u) return null;
  if (u.role === 'admin') return 'admin';
  if (u.ctv_paused) return u.staff ? 'support' : null;
  if (u.ctv_role === 'manager' || u.ctv_role === 'seller') return u.ctv_role;
  return u.staff ? 'support' : null;
}

// ---------- Quyền bán ----------
const grants = (userId) => db.prepare(`SELECT gr.id, gr.game_id, gr.category_id, g.name AS game_name, c.name AS category_name, c.sale_type
  FROM ctv_grants gr JOIN games g ON g.id = gr.game_id LEFT JOIN categories c ON c.id = gr.category_id WHERE gr.user_id = ? ORDER BY g.sort_order, g.id, c.sort_order`).all(userId);
/** Danh mục (cấp 2) CTV được bán, lọc theo loại: vip | reroll | boost | topup */
function allowedCats(userId, types = ['vip', 'reroll', 'boost', 'topup']) {
  const ph = types.map(() => '?').join(',');
  return db.prepare(`SELECT DISTINCT c.id FROM categories c JOIN ctv_grants gr ON gr.game_id = c.game_id AND (gr.category_id IS NULL OR gr.category_id = c.id)
    WHERE gr.user_id = ? AND c.sale_type IN (${ph})`).all(userId, ...types).map((r) => r.id);
}
const canCat = (userId, catId, types) => allowedCats(userId, types).includes(+catId);
/** Loại hàng CTV được bán (để hiện menu) */
function allowedTypes(userId) {
  return db.prepare(`SELECT DISTINCT c.sale_type FROM categories c JOIN ctv_grants gr ON gr.game_id = c.game_id AND (gr.category_id IS NULL OR gr.category_id = c.id)
    WHERE gr.user_id = ?`).all(userId).map((r) => r.sale_type);
}

// ---------- Ví ----------
/** Cộng / trừ số dư CTV + ghi lịch sử (gọi bên trong transaction của nghiệp vụ) */
function credit(userId, amount, type, ref, note) {
  if (!amount) return 0;
  db.prepare('UPDATE users SET ctv_balance = ctv_balance + ? WHERE id = ?').run(amount, userId);
  const bal = db.prepare('SELECT ctv_balance FROM users WHERE id = ?').get(userId)?.ctv_balance ?? 0;
  db.prepare('INSERT INTO ctv_ledger(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)').run(userId, amount, bal, type, ref || null, note || null);
  return bal;
}
const payout = (price, rate) => Math.max(0, Math.round(price * (100 - Math.min(100, Math.max(0, rate ?? 20))) / 100));

// ---------- Ghi doanh thu (bảng sales) + cộng tiền CTV ----------
/** Bán acc (trong transaction mua hàng) */
function onAccSale(orderId, code, p, total) {
  let ctvId = null; let amt = 0;
  if (p.owner_id) {
    const o = db.prepare('SELECT id, ctv_rate FROM users WHERE id = ?').get(p.owner_id);
    if (o) { ctvId = o.id; amt = payout(p.price, o.ctv_rate); credit(o.id, amt, 'sale', code, `Bán ${p.title}`); }
  }
  const kind = db.prepare('SELECT sale_type FROM categories WHERE id = ?').get(p.category_id)?.sale_type || 'vip';
  db.prepare('INSERT OR REPLACE INTO sales(kind, ref_id, ref_code, amount, price, ctv_id, ctv_amount) VALUES(?,?,?,?,?,?,?)').run(kind, orderId, code, total, p.price, ctvId, amt);
}
/** Hoàn tiền đơn acc -> trừ lại tiền đã cộng cho CTV */
function onAccRefund(order) {
  const s = db.prepare("SELECT * FROM sales WHERE kind IN ('vip','reroll') AND ref_id = ?").get(order.id);
  if (!s || s.status === 'refunded') return;
  db.prepare("UPDATE sales SET status = 'refunded' WHERE id = ?").run(s.id);
  if (s.ctv_id && s.ctv_amount) credit(s.ctv_id, -s.ctv_amount, 'refund', s.ref_code, 'Đơn bị hoàn tiền');
}
/** Đặt đơn cày thuê / nạp game */
function onBoostCheckout(o) {
  db.prepare('INSERT OR IGNORE INTO sales(kind, ref_id, ref_code, amount, price) VALUES(?,?,?,?,?)').run(o.kind, o.id, o.code, o.total, o.subtotal);
}
/** Đổi trạng thái đơn cày / nạp (trong transaction): Đã xong -> cộng tiền CTV thực hiện; hủy / mở lại -> trừ lại */
function onBoostStatus(o, status) {
  let s = db.prepare("SELECT * FROM sales WHERE kind IN ('boost','topup') AND ref_id = ?").get(o.id);
  if (!s) { onBoostCheckout(o); s = db.prepare("SELECT * FROM sales WHERE kind IN ('boost','topup') AND ref_id = ?").get(o.id); }
  if (s.ctv_amount && status !== 'done') {
    credit(s.ctv_id, -s.ctv_amount, 'reverse', o.code, status === 'cancelled' ? 'Đơn bị hủy – hoàn tiền' : 'Đơn chuyển lại trạng thái chưa xong');
    db.prepare('UPDATE sales SET ctv_amount = 0 WHERE id = ?').run(s.id);
  }
  if (status === 'cancelled') db.prepare("UPDATE sales SET status = 'refunded' WHERE id = ?").run(s.id);
  if (status === 'done' && o.ctv_id && !s.ctv_amount) {
    const u = db.prepare('SELECT ctv_rate FROM users WHERE id = ?').get(o.ctv_id);
    const amt = payout(o.subtotal, u?.ctv_rate);
    credit(o.ctv_id, amt, 'boost', o.code, `Hoàn thành đơn ${o.code}`);
    db.prepare('UPDATE sales SET ctv_id = ?, ctv_amount = ? WHERE id = ?').run(o.ctv_id, amt, s.id);
  }
}

// ---------- Rút tiền ----------
class CtvError extends Error {}
const withdrawTx = db.transaction((userId, f) => {
  const u = db.prepare('SELECT id, ctv_balance FROM users WHERE id = ?').get(userId);
  const amount = parseInt(f.amount, 10) || 0;
  if (amount < MIN_WITHDRAW) throw new CtvError(`Số tiền rút tối thiểu ${money(MIN_WITHDRAW)}`);
  if (amount > u.ctv_balance) throw new CtvError(`Số dư không đủ (hiện có ${money(u.ctv_balance)})`);
  if (db.prepare("SELECT COUNT(*) n FROM ctv_withdrawals WHERE user_id = ? AND status = 'pending'").get(userId).n >= MAX_PENDING) throw new CtvError(`Bạn đang có ${MAX_PENDING} lệnh rút chờ duyệt, vui lòng đợi admin xử lý`);
  const code = 'RT' + crypto.randomBytes(4).toString('hex').toUpperCase();
  credit(userId, -amount, 'withdraw', code, `Rút tiền về ${bankName(f.bank_code)} ${f.bank_acc}`);
  db.prepare('INSERT INTO ctv_withdrawals(code, user_id, amount, bank_code, bank_acc, bank_owner) VALUES(?,?,?,?,?,?)').run(code, userId, amount, f.bank_code, f.bank_acc, f.bank_owner);
  db.prepare('UPDATE users SET ctv_bank = ? WHERE id = ?').run(JSON.stringify({ code: f.bank_code, acc: f.bank_acc, owner: f.bank_owner }), userId);
  return code;
});
function withdraw(userId, f) {
  const bank_code = String(f.bank_code || '');
  const bank_acc = String(f.bank_acc || '').replace(/\s+/g, '');
  const bank_owner = String(f.bank_owner || '').trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/Đ/g, 'D').replace(/[^A-Z ]/g, '').replace(/\s+/g, ' ').slice(0, 60);
  if (!BANKS.some((b) => b[0] === bank_code)) return { ok: false, message: 'Vui lòng chọn ngân hàng' };
  if (!/^\d{6,20}$/.test(bank_acc)) return { ok: false, message: 'Số tài khoản chỉ gồm 6–20 chữ số' };
  if (bank_owner.length < 3) return { ok: false, message: 'Vui lòng nhập tên chủ tài khoản' };
  try { return { ok: true, code: withdrawTx.immediate(userId, { amount: f.amount, bank_code, bank_acc, bank_owner }) }; } catch (e) {
    if (e instanceof CtvError) return { ok: false, message: e.message };
    throw e;
  }
}
const handleTx = db.transaction((id, action, byId, note) => {
  const w = db.prepare('SELECT * FROM ctv_withdrawals WHERE id = ?').get(id);
  if (!w) throw new CtvError('Không tìm thấy lệnh rút');
  if (w.status !== 'pending') throw new CtvError('Lệnh rút đã được xử lý');
  if (w.user_id === byId) throw new CtvError('Không thể tự duyệt lệnh rút của chính mình');
  if (action === 'paid') db.prepare("UPDATE ctv_withdrawals SET status = 'paid', note = ?, handled_by = ?, handled_at = unixepoch() WHERE id = ?").run(note || null, byId, id);
  else {
    if (!note) throw new CtvError('Hãy ghi lý do từ chối');
    db.prepare("UPDATE ctv_withdrawals SET status = 'rejected', note = ?, handled_by = ?, handled_at = unixepoch() WHERE id = ?").run(note, byId, id);
    credit(w.user_id, w.amount, 'withdraw_reject', w.code, 'Lệnh rút bị từ chối: ' + note);
  }
  return w;
});
function handleWithdraw(id, action, byId, note) {
  try { return { ok: true, w: handleTx.immediate(id, action === 'paid' ? 'paid' : 'reject', byId, String(note || '').trim().slice(0, 300)) }; } catch (e) {
    if (e instanceof CtvError) return { ok: false, message: e.message };
    throw e;
  }
}
const adjust = (userId, amount, note) => db.transaction(() => credit(userId, amount, 'adjust', null, note))();

/** Báo Telegram cho CTV (đã nhập Telegram chat ID ở Quản lý CTV) */
function notify(userIds, text) {
  const s = getSettings();
  let token = ''; try { token = s.tg_token_enc ? require('../utils/crypto').decrypt(s.tg_token_enc) : ''; } catch { token = ''; }
  if (!token || !userIds.length) return;
  const ph = userIds.map(() => '?').join(',');
  for (const u of db.prepare(`SELECT staff_tg FROM users WHERE id IN (${ph}) AND staff_tg IS NOT NULL AND staff_tg != ''`).all(...userIds)) {
    fetch(`${process.env.TG_API_URL || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: u.staff_tg, text: String(text).slice(0, 3900) }), signal: AbortSignal.timeout(15000),
    }).catch(() => {});
  }
}
/** CTV bán hàng đang được cấp 1 danh mục (để báo đơn mới) */
const sellersOfCat = (catId) => db.prepare(`SELECT DISTINCT u.id FROM users u JOIN ctv_grants gr ON gr.user_id = u.id JOIN categories c ON c.game_id = gr.game_id AND (gr.category_id IS NULL OR gr.category_id = c.id)
  WHERE c.id = ? AND u.ctv_role = 'seller' AND u.ctv_paused = 0`).all(catId).map((r) => r.id);

module.exports = {
  ROLES, BANKS, bankName, MIN_WITHDRAW, roleOf, grants, allowedCats, canCat, allowedTypes,
  credit, payout, onAccSale, onAccRefund, onBoostCheckout, onBoostStatus, withdraw, handleWithdraw, adjust, notify, sellersOfCat,
};
