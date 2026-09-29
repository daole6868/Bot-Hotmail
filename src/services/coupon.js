'use strict';
const { db } = require('../db');
const { now, money } = require('../utils/helpers');

/**
 * Kiểm tra mã giảm giá cho 1 đơn.
 * @returns {{ok:boolean, message?:string, coupon?:object, discount?:number}}
 */
function validateCoupon(code, userId, price, gameId) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return { ok: false, message: 'Chưa nhập mã giảm giá' };
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) return { ok: false, message: 'Mã giảm giá không hợp lệ' };
  const c = db.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1').get(code);
  if (!c) return { ok: false, message: 'Mã giảm giá không tồn tại hoặc đã tắt' };
  const t = now();
  if (c.starts_at && t < c.starts_at) return { ok: false, message: 'Mã chưa đến thời gian áp dụng' };
  if (c.expires_at && t > c.expires_at) return { ok: false, message: 'Mã đã hết hạn' };
  if (c.usage_limit != null && c.used_count >= c.usage_limit) return { ok: false, message: 'Mã đã hết lượt sử dụng' };
  if (c.game_id && gameId && c.game_id !== gameId) return { ok: false, message: 'Mã không áp dụng cho game này' };
  if (price < c.min_order) return { ok: false, message: `Đơn tối thiểu ${money(c.min_order)} để dùng mã này` };
  if (userId && c.per_user_limit) {
    const used = db.prepare('SELECT COUNT(*) n FROM coupon_usages WHERE coupon_id = ? AND user_id = ?').get(c.id, userId).n;
    if (used >= c.per_user_limit) return { ok: false, message: 'Bạn đã dùng hết lượt của mã này' };
  }
  let discount = c.type === 'percent' ? Math.floor((price * c.value) / 100) : c.value;
  if (c.max_discount) discount = Math.min(discount, c.max_discount);
  discount = Math.min(discount, price);
  return { ok: true, coupon: c, discount };
}

// Danh sách mã công khai hiện ở nhiều trang -> nhớ 30 giây (admin sửa mã thì xóa nhớ ngay)
let pcCache = { at: 0, rows: null };
function clearCouponCache() { pcCache = { at: 0, rows: null }; }
function publicCoupons(limit = 6) {
  if (!pcCache.rows || Date.now() - pcCache.at > 30000) pcCache = { at: Date.now(), rows: loadPublicCoupons() };
  return pcCache.rows.slice(0, limit);
}
function loadPublicCoupons() {
  const t = now();
  const limit = 50;
  return db.prepare(`SELECT c.*, g.name AS game_name FROM coupons c LEFT JOIN games g ON g.id = c.game_id
    WHERE c.is_active = 1 AND c.is_public = 1
      AND (c.starts_at IS NULL OR c.starts_at <= ?) AND (c.expires_at IS NULL OR c.expires_at >= ?)
      AND (c.usage_limit IS NULL OR c.used_count < c.usage_limit)
    ORDER BY c.created_at DESC LIMIT ?`).all(t, t, limit);
}

module.exports = { validateCoupon, publicCoupons, clearCouponCache };
