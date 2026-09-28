'use strict';
const { db, bumpStat, logActivity } = require('../db');
const { validateCoupon } = require('./coupon');
const { randomCode } = require('../utils/crypto');
const { money } = require('../utils/helpers');

class OrderError extends Error {}

function genOrderCode() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  const ymd = d.toISOString().slice(2, 10).replace(/-/g, '');
  return `DH${ymd}${randomCode(6)}`;
}

/**
 * Mua sản phẩm — toàn bộ chạy trong 1 transaction IMMEDIATE:
 * khóa ghi DB => không thể mua trùng 1 acc hay trừ tiền âm dù có nhiều request cùng lúc.
 */
const purchaseTx = db.transaction((userId, productId, couponCode, ip) => {
  const p = db.prepare(`SELECT p.*, c.name AS category_name, c.is_active AS cat_active,
      g.id AS game_id, g.name AS game_name, g.is_active AS game_active
    FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id
    WHERE p.id = ?`).get(productId);
  if (!p || p.status === 'hidden' || !p.cat_active || !p.game_active) throw new OrderError('Sản phẩm không tồn tại');
  if (p.status !== 'available') throw new OrderError('Sản phẩm đã được bán');

  const user = db.prepare('SELECT id, balance, status FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active') throw new OrderError('Tài khoản không hợp lệ');

  // Mã giảm giá
  let discount = 0;
  let coupon = null;
  if (couponCode) {
    const v = validateCoupon(couponCode, userId, p.price, p.game_id);
    if (!v.ok) throw new OrderError(v.message);
    discount = v.discount;
    coupon = v.coupon;
  }
  const total = p.price - discount;
  if (user.balance < total) throw new OrderError(`Số dư không đủ. Cần ${money(total)}, bạn có ${money(user.balance)}`);

  // Lấy dữ liệu giao cho khách
  let deliveredEnc;
  let stockId = null;
  if (p.type === 'account') {
    const r = db.prepare(`UPDATE products SET status = 'sold', sold_count = sold_count + 1, updated_at = unixepoch()
      WHERE id = ? AND status = 'available'`).run(p.id);
    if (r.changes !== 1) throw new OrderError('Sản phẩm vừa được người khác mua');
    deliveredEnc = p.credentials_enc;
  } else {
    const item = db.prepare('SELECT id, data_enc FROM product_stock WHERE product_id = ? AND is_sold = 0 ORDER BY id LIMIT 1').get(p.id);
    if (!item) throw new OrderError('Sản phẩm đã hết hàng');
    db.prepare('UPDATE product_stock SET is_sold = 1 WHERE id = ? AND is_sold = 0').run(item.id);
    db.prepare('UPDATE products SET sold_count = sold_count + 1, updated_at = unixepoch() WHERE id = ?').run(p.id);
    deliveredEnc = item.data_enc;
    stockId = item.id;
  }

  // Trừ tiền có điều kiện (không bao giờ âm)
  const upd = db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ? AND balance >= ?')
    .run(total, total, userId, total);
  if (upd.changes !== 1) throw new OrderError('Số dư không đủ');

  const code = genOrderCode();
  const orderId = db.prepare(`INSERT INTO orders(order_code, user_id, product_id, product_title, game_name, price, discount, total, coupon_code, delivered_enc, ip)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(code, userId, p.id, p.title, p.game_name, p.price, discount, total, coupon?.code || null, deliveredEnc, ip).lastInsertRowid;

  if (stockId) db.prepare('UPDATE product_stock SET order_id = ? WHERE id = ?').run(orderId, stockId);
  if (coupon) {
    db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').run(coupon.id);
    db.prepare('INSERT INTO coupon_usages(coupon_id, user_id, order_id) VALUES(?,?,?)').run(coupon.id, userId, orderId);
  }
  const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)')
    .run(userId, -total, bal, 'purchase', code, `Mua ${p.title}`);
  bumpStat('revenue', total);
  bumpStat('orders', 1);
  return { orderId, code, total };
});

function purchase(userId, productId, couponCode, ip) {
  try {
    const r = purchaseTx.immediate(userId, productId, couponCode, ip);
    logActivity(userId, 'purchase', `${r.code} - ${money(r.total)}`, ip);
    return { ok: true, ...r };
  } catch (e) {
    if (e instanceof OrderError) return { ok: false, message: e.message };
    console.error('purchase error', e);
    return { ok: false, message: 'Có lỗi xảy ra, vui lòng thử lại' };
  }
}

/** Hoàn tiền (admin). restock = mở bán lại acc / trả mã về kho */
const refundTx = db.transaction((orderId, adminId, reason, restock) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) throw new OrderError('Không tìm thấy đơn (đơn đã lưu trữ không thể hoàn)');
  if (o.status === 'refunded') throw new OrderError('Đơn đã được hoàn tiền trước đó');
  db.prepare("UPDATE orders SET status = 'refunded', note = ? WHERE id = ?").run(reason || 'Hoàn tiền', o.id);
  db.prepare('UPDATE users SET balance = balance + ?, total_spent = MAX(0, total_spent - ?) WHERE id = ?').run(o.total, o.total, o.user_id);
  const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(o.user_id).balance;
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)')
    .run(o.user_id, o.total, bal, 'refund', o.order_code, reason || 'Hoàn tiền đơn hàng');
  if (restock && o.product_id) {
    const p = db.prepare('SELECT type FROM products WHERE id = ?').get(o.product_id);
    if (p?.type === 'account') db.prepare("UPDATE products SET status = 'available', sold_count = MAX(0, sold_count - 1) WHERE id = ?").run(o.product_id);
    if (p?.type === 'stock') db.prepare('UPDATE product_stock SET is_sold = 0, order_id = NULL WHERE order_id = ?').run(o.id);
  }
  bumpStat('refunds', o.total);
  logActivity(adminId, 'admin_refund', `${o.order_code} ${money(o.total)} ${reason || ''}`);
  return o;
});

function refund(orderId, adminId, reason, restock) {
  try {
    refundTx.immediate(orderId, adminId, reason, restock);
    return { ok: true };
  } catch (e) {
    if (e instanceof OrderError) return { ok: false, message: e.message };
    throw e;
  }
}

module.exports = { purchase, refund };
