'use strict';
/**
 * Trang khách: Game -> danh mục loại Cày thuê -> danh mục con -> gói (+ giỏ hàng theo game, đặt đơn).
 *             Game -> danh mục loại Nạp game -> gói (không có cấp danh mục con; mỗi danh mục 1 giỏ riêng).
 * Đặt TRƯỚC router public: danh mục Cày thuê / Nạp game xử lý ở đây, danh mục VIP / Reroll đi tiếp sang router public.
 */
const express = require('express');
const { db, getSettings } = require('../db');
const { requireLogin, limiters } = require('../middleware/security');
const boost = require('../services/boost');
const { validateCoupon, publicCoupons } = require('../services/coupon');
const { str, toInt, clientIp } = require('../utils/helpers');

const router = express.Router();
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

/** Cài đặt hiển thị cho 1 cấp ('cat' = danh mục con | 'pkg' = gói): lấy theo danh mục Cày thuê, chưa chỉnh thì theo mặc định */
function display(level, parent, s = getSettings()) {
  let o = {};
  try { o = JSON.parse(parent?.options || '{}') || {}; } catch { o = {}; }
  const v = (k) => (o[`${level}_${k}`] !== undefined && o[`${level}_${k}`] !== '' ? o[`${level}_${k}`] : s[`boost_${level}_${k}`]);
  return {
    mode: v('mode') === 'icon' ? 'icon' : 'image',
    colsPc: int(v('cols_pc'), 4, 1, 6),
    colsM: int(v('cols_m'), 2, 1, 3),
    max: int(v('max'), 12, 1, 200),
  };
}

const gameBySlug = (slug) => db.prepare('SELECT * FROM games WHERE slug = ? AND is_active = 1').get(slug);
const boostParent = (gameId, slug) => db.prepare("SELECT * FROM categories WHERE game_id = ? AND slug = ? AND is_active = 1 AND sale_type IN ('boost','topup')").get(gameId, slug);
const categoriesOf = (parentId) => db.prepare(`SELECT c.*,
    (SELECT COUNT(*) FROM boost_packages p WHERE p.category_id = c.id AND p.is_active = 1) AS package_count,
    (SELECT MIN(price) FROM boost_packages p WHERE p.category_id = c.id AND p.is_active = 1) AS min_price,
    (SELECT COALESCE(SUM(sold_count), 0) FROM boost_packages p WHERE p.category_id = c.id) AS sold
  FROM boost_categories c WHERE c.parent_id = ? AND c.is_active = 1 ORDER BY c.sort_order, c.id`).all(parentId);
const boostCoupons = (gameId, kind = 'boost') => publicCoupons(10, kind).filter((c) => !c.game_id || c.game_id === gameId);

/** Trang gói + giỏ + form đặt đơn (dùng chung Cày thuê / Nạp game) */
function renderPackages(req, res, game, parent, category) {
  const s = getSettings();
  const kind = parent.sale_type === 'topup' ? 'topup' : 'boost';
  const topup = kind === 'topup';
  const packages = db.prepare('SELECT * FROM boost_packages WHERE category_id = ? AND is_active = 1 ORDER BY sort_order, id').all(category.id);
  const siblings = topup ? [] : db.prepare('SELECT name, slug, icon, icon_color FROM boost_categories WHERE parent_id = ? AND is_active = 1 ORDER BY sort_order, id').all(parent.id);
  const cart = boost.cartSummary(req.user?.id, game.id, kind, topup ? parent.id : 0);
  const here = topup ? `/game/${game.slug}/${parent.slug}` : `/game/${game.slug}/${parent.slug}/${category.slug}`;
  const crumbs = [{ name: game.name, url: `/game/${game.slug}` }];
  crumbs.push(topup ? { name: parent.name } : { name: parent.name, url: `/game/${game.slug}/${parent.slug}` });
  if (!topup) crumbs.push({ name: category.name });
  res.set('Cache-Control', 'no-store');
  res.render('pages/boost-packages', {
    title: `${topup ? parent.name : category.name} - ${game.name}`, game, parent, category, packages, siblings, cart, disp: display('pkg', parent),
    kind, topup, method: boost.methodOf(parent), here, prefill: req.user ? boost.lastInfo(req.user.id, game.id) : {},
    desc: topup ? parent.description : category.description,
    coupons: boostCoupons(game.id, kind), terms: (topup ? s.topup_terms : s.boost_terms) || '', cartHours: boost.cartHours(s),
    breadcrumb: crumbs,
    seoTitle: topup ? parent.seo_title : null,
    metaDesc: (topup ? parent.seo_desc || parent.description : category.description)
      || `${topup ? parent.name : category.name} ${game.name}${packages.length ? `: ${packages.length} gói, giá từ ${Math.min(...packages.map((p) => p.price)).toLocaleString('vi-VN')}đ` : ''}. Uy tín, nhanh chóng.`,
    metaImage: (topup ? parent.image : category.image) || game.image,
  });
}

// ---------- Danh mục loại Cày thuê -> danh sách danh mục con ----------
router.get('/game/:slug/:cat', (req, res, next) => {
  const game = gameBySlug(req.params.slug);
  if (!game) return next();
  const parent = boostParent(game.id, req.params.cat);
  if (!parent) return next(); // danh mục VIP / Reroll -> router public
  if (parent.sale_type === 'topup') return renderPackages(req, res, game, parent, boost.topupSub(parent));
  res.render('pages/boost-cats', {
    title: `${parent.name} - ${game.name}`, game, parent, categories: categoriesOf(parent.id), disp: display('cat', parent),
    coupons: boostCoupons(game.id),
    seoTitle: parent.seo_title, metaDesc: parent.seo_desc || parent.description || `Dịch vụ ${parent.name} ${game.name} uy tín, nhanh, an toàn.`, metaImage: parent.image || game.image,
    breadcrumb: [{ name: game.name, url: `/game/${game.slug}` }, { name: parent.name }],
  });
});

// ---------- Danh mục con -> gói + giỏ + đặt đơn ----------
router.get('/game/:slug/:cat/:sub', (req, res, next) => {
  const game = gameBySlug(req.params.slug);
  if (!game) return next();
  const parent = boostParent(game.id, req.params.cat);
  if (!parent || parent.sale_type !== 'boost') return next();
  const category = db.prepare('SELECT * FROM boost_categories WHERE parent_id = ? AND slug = ? AND is_active = 1').get(parent.id, req.params.sub);
  if (!category) return next();
  renderPackages(req, res, game, parent, category);
});

// ---------- Giỏ hàng (AJAX) -> trả về HTML giỏ để thay vào trang ----------
function cartResponse(req, res, r) {
  const cart = boost.cartSummary(req.user.id, r.gameId, r.kind, r.parentId);
  res.render('partials/boost/cart', { cart, layout: false }, (err, html) => {
    if (err) return res.status(500).json({ ok: false, message: 'Lỗi hiển thị giỏ' });
    res.json({ ok: true, html, count: cart.count, subtotal: cart.subtotal });
  });
}
router.post('/boost/cart', (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, login: true, message: 'Vui lòng đăng nhập để thêm vào giỏ' });
  try {
    const r = boost.setCart(req.user.id, toInt(req.body.package, 0), toInt(req.body.qty, 0, 0, 1000), req.body.mode === 'add');
    cartResponse(req, res, r);
  } catch (e) {
    if (e.constructor.name === 'BoostError') return res.json({ ok: false, message: e.message });
    throw e;
  }
});

// cat = id danh mục Nạp game (form nạp game gửi kèm); không có -> giỏ cày thuê
const topupParent = (gameId, id) => (id ? db.prepare("SELECT * FROM categories WHERE id = ? AND game_id = ? AND sale_type = 'topup' AND is_active = 1").get(id, gameId) : null);

// Kiểm tra mã giảm giá theo tổng giỏ hiện tại
router.post('/api/boost/coupon/check', limiters.coupon, (req, res) => {
  if (!req.user) return res.json({ ok: false, message: 'Vui lòng đăng nhập' });
  const gameId = toInt(req.body.game, 0);
  const parent = topupParent(gameId, toInt(req.body.cat, 0));
  const kind = parent ? 'topup' : 'boost';
  const cart = boost.cartSummary(req.user.id, gameId, kind, parent ? parent.id : 0);
  if (!cart.items.length) return res.json({ ok: false, message: 'Giỏ hàng trống' });
  const v = validateCoupon(req.body.code, req.user.id, cart.subtotal, gameId, kind);
  if (!v.ok) return res.json({ ok: false, message: v.message });
  res.json({ ok: true, discount: v.discount, total: cart.subtotal - v.discount, message: `Áp dụng thành công: giảm ${v.discount.toLocaleString('vi-VN')}đ` });
});

// ---------- Đặt đơn ----------
router.post('/boost/checkout', requireLogin, limiters.buy, (req, res) => {
  const gameId = toInt(req.body.game, 0);
  const back = str(req.body.back, 200);
  const safeBack = /^\/game\/[\w-]+\/[\w-]+(\/[\w-]+)?$/.test(back) ? back : '/';
  if (!req.body.agree) { req.flash('error', 'Bạn cần đồng ý điều khoản dịch vụ'); return res.redirect(safeBack); }
  const parent = topupParent(gameId, toInt(req.body.cat, 0));
  if (req.body.cat && !parent) { req.flash('error', 'Danh mục nạp game không tồn tại hoặc đã tạm ẩn'); return res.redirect(safeBack); }
  const kind = parent ? 'topup' : 'boost';
  const r = boost.checkout(req.user.id, gameId, req.body, clientIp(req), kind, parent);
  if (!r.ok) { req.flash('error', r.message); return res.redirect(safeBack); }
  if (r.dup) { req.flash('success', `Đơn ${r.code} đã được đặt trước đó, không trừ tiền thêm.`); return res.redirect(`/user/boost/${r.code}`); }
  req.flash('success', `Đặt đơn ${boost.kindOf(kind).name.toLowerCase()} ${r.code} thành công! Shop sẽ xử lý sớm nhất.`);
  res.redirect(`/user/boost/${r.code}`);
});

module.exports = router;
module.exports.display = display;
module.exports.categoriesOf = categoriesOf;
