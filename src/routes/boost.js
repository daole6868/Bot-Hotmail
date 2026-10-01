'use strict';
/**
 * Trang khách: Game -> "Cày thuê" -> Danh mục cày thuê -> Gói (+ giỏ hàng theo game, đặt đơn).
 * Đặt TRƯỚC router public để /game/:slug/cay-thue không bị hiểu là 1 danh mục acc.
 */
const express = require('express');
const { db, getSettings } = require('../db');
const { requireLogin, limiters } = require('../middleware/security');
const boost = require('../services/boost');
const { validateCoupon, publicCoupons } = require('../services/coupon');
const { str, toInt, clientIp } = require('../utils/helpers');

const router = express.Router();
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

/** Cài đặt hiển thị cho 1 cấp ('cat' | 'pkg') */
function display(level, s = getSettings()) {
  return {
    mode: s[`boost_${level}_mode`] === 'icon' ? 'icon' : 'image',
    colsPc: int(s[`boost_${level}_cols_pc`], 4, 1, 6),
    colsM: int(s[`boost_${level}_cols_m`], 2, 1, 3),
    max: int(s[`boost_${level}_max`], 12, 1, 200),
  };
}

const gameBySlug = (slug) => db.prepare('SELECT * FROM games WHERE slug = ? AND is_active = 1').get(slug);
const categoriesOf = (gameId) => db.prepare(`SELECT c.*,
    (SELECT COUNT(*) FROM boost_packages p WHERE p.category_id = c.id AND p.is_active = 1) AS package_count,
    (SELECT MIN(price) FROM boost_packages p WHERE p.category_id = c.id AND p.is_active = 1) AS min_price,
    (SELECT COALESCE(SUM(sold_count), 0) FROM boost_packages p WHERE p.category_id = c.id) AS sold
  FROM boost_categories c WHERE c.game_id = ? AND c.is_active = 1 ORDER BY c.sort_order, c.id`).all(gameId);

// ---------- Cấp 1: danh mục cày thuê của game ----------
router.get('/game/:slug/cay-thue', (req, res, next) => {
  const game = gameBySlug(req.params.slug);
  if (!game) return next();
  const categories = categoriesOf(game.id);
  if (!categories.length) return next();
  const s = getSettings();
  res.render('pages/boost-cats', {
    title: `${s.boost_tile_title || 'Cày thuê'} ${game.name}`, game, categories, disp: display('cat', s),
    coupons: publicCoupons(10, 'boost').filter((c) => !c.game_id || c.game_id === game.id),
    breadcrumb: [{ name: game.name, url: `/game/${game.slug}` }, { name: s.boost_tile_title || 'Cày thuê' }],
  });
});

// ---------- Cấp 2: gói trong danh mục + giỏ + đặt đơn ----------
router.get('/game/:slug/cay-thue/:cat', (req, res, next) => {
  const game = gameBySlug(req.params.slug);
  if (!game) return next();
  const category = db.prepare('SELECT * FROM boost_categories WHERE game_id = ? AND slug = ? AND is_active = 1').get(game.id, req.params.cat);
  if (!category) return next();
  const s = getSettings();
  const packages = db.prepare('SELECT * FROM boost_packages WHERE category_id = ? AND is_active = 1 ORDER BY sort_order, id').all(category.id);
  const siblings = db.prepare('SELECT name, slug, icon, icon_color FROM boost_categories WHERE game_id = ? AND is_active = 1 ORDER BY sort_order, id').all(game.id);
  const cart = boost.cartSummary(req.user?.id, game.id);
  res.set('Cache-Control', 'no-store');
  res.render('pages/boost-packages', {
    title: `${category.name} - ${game.name}`, game, category, packages, siblings, cart, disp: display('pkg', s),
    coupons: publicCoupons(10, 'boost').filter((c) => !c.game_id || c.game_id === game.id), terms: s.boost_terms || '', cartHours: boost.cartHours(s),
    breadcrumb: [{ name: game.name, url: `/game/${game.slug}` }, { name: s.boost_tile_title || 'Cày thuê', url: `/game/${game.slug}/cay-thue` }, { name: category.name }],
  });
});

// ---------- Giỏ hàng (AJAX) -> trả về HTML giỏ để thay vào trang ----------
function cartResponse(req, res, gameId) {
  const cart = boost.cartSummary(req.user.id, gameId);
  res.render('partials/boost/cart', { cart, layout: false }, (err, html) => {
    if (err) return res.status(500).json({ ok: false, message: 'Lỗi hiển thị giỏ' });
    res.json({ ok: true, html, count: cart.count, subtotal: cart.subtotal });
  });
}
router.post('/boost/cart', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, login: true, message: 'Vui lòng đăng nhập để thêm vào giỏ' });
  try {
    const r = boost.setCart(req.user.id, toInt(req.body.package, 0), toInt(req.body.qty, 0, 0, 1000), req.body.mode === 'add');
    cartResponse(req, res, r.gameId);
  } catch (e) {
    if (e.constructor.name === 'BoostError') return res.json({ ok: false, message: e.message });
    throw e;
  }
});

// Kiểm tra mã giảm giá theo tổng giỏ hiện tại
router.post('/api/boost/coupon/check', limiters.coupon, (req, res) => {
  if (!req.user) return res.json({ ok: false, message: 'Vui lòng đăng nhập' });
  const gameId = toInt(req.body.game, 0);
  const cart = boost.cartSummary(req.user.id, gameId);
  if (!cart.items.length) return res.json({ ok: false, message: 'Giỏ hàng trống' });
  const v = validateCoupon(req.body.code, req.user.id, cart.subtotal, gameId, 'boost');
  if (!v.ok) return res.json({ ok: false, message: v.message });
  res.json({ ok: true, discount: v.discount, total: cart.subtotal - v.discount, message: `Áp dụng thành công: giảm ${v.discount.toLocaleString('vi-VN')}đ` });
});

// ---------- Đặt đơn ----------
router.post('/boost/checkout', requireLogin, limiters.buy, (req, res) => {
  const gameId = toInt(req.body.game, 0);
  const back = str(req.body.back, 200);
  const safeBack = /^\/game\/[\w-]+\/cay-thue(\/[\w-]+)?$/.test(back) ? back : '/';
  if (!req.body.agree) { req.flash('error', 'Bạn cần đồng ý điều khoản dịch vụ'); return res.redirect(safeBack); }
  const r = boost.checkout(req.user.id, gameId, req.body, clientIp(req));
  if (!r.ok) { req.flash('error', r.message); return res.redirect(safeBack); }
  req.flash('success', `Đặt đơn cày thuê ${r.code} thành công! Shop sẽ xử lý sớm nhất.`);
  res.redirect(`/user/boost/${r.code}`);
});

module.exports = router;
module.exports.display = display;
module.exports.categoriesOf = categoriesOf;
