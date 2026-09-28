'use strict';
const express = require('express');
const { db } = require('../db');
const { limiters, requireLogin } = require('../middleware/security');
const { publicCoupons, validateCoupon } = require('../services/coupon');
const { purchase } = require('../services/order');
const { paginate, toInt, str, parseJSON, clientIp } = require('../utils/helpers');

const router = express.Router();

// Cache ngắn cho dữ liệu trang chủ (giảm truy vấn khi đông khách)
const cache = new Map();
function cached(key, ttlMs, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttlMs) return c.v;
  const v = fn();
  cache.set(key, { v, at: Date.now() });
  return v;
}
router.clearCache = () => cache.clear();

function maskName(n) {
  n = String(n || '');
  return n.length <= 3 ? n[0] + '**' : n.slice(0, 2) + '***' + n.slice(-1);
}

function decorate(p) {
  p.imageList = parseJSON(p.images, []);
  p.attrList = parseJSON(p.attributes, []);
  p.discountPercent = p.old_price && p.old_price > p.price ? Math.round((1 - p.price / p.old_price) * 100) : 0;
  return p;
}

const PRODUCT_SELECT = `p.id, p.code, p.title, p.type, p.price, p.old_price, p.images, p.attributes, p.status, p.sold_count, p.views,
  p.is_featured, p.created_at, c.name AS category_name, c.slug AS category_slug, g.name AS game_name, g.slug AS game_slug,
  (CASE WHEN p.type = 'stock' THEN (SELECT COUNT(*) FROM product_stock s WHERE s.product_id = p.id AND s.is_sold = 0) ELSE NULL END) AS stock_left`;

// ================= CẤP 1: TRANG CHỦ - DANH MỤC GAME =================
router.get('/', (req, res) => {
  const data = cached('home', 30000, () => ({
    banners: db.prepare("SELECT * FROM banners WHERE position = 'main' AND is_active = 1 ORDER BY sort_order, id").all(),
    strip: db.prepare("SELECT * FROM banners WHERE position = 'strip' AND is_active = 1 ORDER BY sort_order, id").all(),
    games: db.prepare(`SELECT g.*,
        (SELECT COUNT(*) FROM categories c WHERE c.game_id = g.id AND c.is_active = 1) AS cat_count,
        (SELECT COUNT(*) FROM products p JOIN categories c ON c.id = p.category_id
           WHERE c.game_id = g.id AND c.is_active = 1 AND p.status = 'available') AS product_count,
        (SELECT COALESCE(SUM(p.sold_count),0) FROM products p JOIN categories c ON c.id = p.category_id WHERE c.game_id = g.id) AS sold
      FROM games g WHERE g.is_active = 1 ORDER BY g.sort_order, g.id`).all(),
    coupons: publicCoupons(8),
    recent: db.prepare(`SELECT o.product_title, o.total, o.created_at, u.username FROM orders o JOIN users u ON u.id = o.user_id
      WHERE o.status = 'completed' ORDER BY o.id DESC LIMIT 10`).all().map((o) => ({ ...o, username: maskName(o.username) })),
    stats: {
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      sold: db.prepare("SELECT COUNT(*) c FROM v_orders WHERE status = 'completed'").get().c,
      available: db.prepare("SELECT COUNT(*) c FROM products WHERE status = 'available'").get().c,
    },
  }));
  // Acc nổi bật: xáo trộn ngẫu nhiên, tối đa 12, khác nhau mỗi lần tải trang / mỗi user
  const featured = db.prepare(`SELECT ${PRODUCT_SELECT} FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id
    WHERE p.is_featured = 1 AND p.status = 'available' AND c.is_active = 1 AND g.is_active = 1
    ORDER BY RANDOM() LIMIT 12`).all().map(decorate);
  res.render('pages/home', { title: null, ...data, featured });
});

// ================= CẤP 2: DANH MỤC CON TRONG GAME =================
router.get('/game/:slug', (req, res, next) => {
  const game = db.prepare('SELECT * FROM games WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!game) return next();
  const categories = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'available') AS product_count,
      (SELECT MIN(price) FROM products p WHERE p.category_id = c.id AND p.status = 'available') AS min_price,
      (SELECT COALESCE(SUM(sold_count),0) FROM products p WHERE p.category_id = c.id) AS sold
    FROM categories c WHERE c.game_id = ? AND c.is_active = 1 ORDER BY c.sort_order, c.id`).all(game.id);
  const coupons = publicCoupons(10).filter((c) => !c.game_id || c.game_id === game.id);
  res.render('pages/game', { title: game.name, game, categories, coupons, breadcrumb: [{ name: game.name }] });
});

// ================= CẤP 3: DANH SÁCH SẢN PHẨM / THẺ GAME =================
router.get('/game/:slug/:cat', (req, res, next) => {
  const game = db.prepare('SELECT * FROM games WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!game) return next();
  const category = db.prepare('SELECT * FROM categories WHERE game_id = ? AND slug = ? AND is_active = 1').get(game.id, req.params.cat);
  if (!category) return next();

  const q = {
    q: str(req.query.q, 60),
    min: toInt(req.query.min, 0, 0),
    max: toInt(req.query.max, 0, 0),
    sort: ['default', 'new', 'price_asc', 'price_desc', 'popular'].includes(req.query.sort) ? req.query.sort : 'default',
  };
  const where = ["p.category_id = ?", "p.status = 'available'"];
  const params = [category.id];
  if (q.q) { where.push('(p.title LIKE ? OR p.code LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.min) { where.push('p.price >= ?'); params.push(q.min); }
  if (q.max) { where.push('p.price <= ?'); params.push(q.max); }
  const order = { default: 'p.sort_order, p.id DESC', new: 'p.id DESC', price_asc: 'p.price ASC', price_desc: 'p.price DESC', popular: 'p.sold_count DESC, p.views DESC' }[q.sort];

  const result = paginate(db, {
    select: PRODUCT_SELECT,
    from: 'products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id',
    where: 'WHERE ' + where.join(' AND '), params, order: 'ORDER BY ' + order,
    page: toInt(req.query.page, 1, 1), perPage: 12,
  });
  result.rows.forEach(decorate);
  const siblings = db.prepare('SELECT name, slug FROM categories WHERE game_id = ? AND is_active = 1 ORDER BY sort_order, id').all(game.id);
  res.render('pages/category', {
    title: `${category.name} - ${game.name}`, game, category, siblings, result, query: q,
    breadcrumb: [{ name: game.name, url: `/game/${game.slug}` }, { name: category.name }],
  });
});

// ================= CHI TIẾT SẢN PHẨM =================
function loadProduct(code) {
  const p = db.prepare(`SELECT ${PRODUCT_SELECT}, p.description, p.category_id, g.id AS game_id, c.is_active AS cat_active, g.is_active AS game_active
    FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id WHERE p.code = ?`).get(code);
  if (!p || p.status === 'hidden' || !p.cat_active || !p.game_active) return null;
  return decorate(p);
}

router.get('/product/:code', (req, res, next) => {
  const p = loadProduct(str(req.params.code, 20));
  if (!p) return next();
  // Đếm lượt xem 1 lần / phiên
  req.session.viewed = (req.session.viewed || []).slice(-50);
  if (!req.session.viewed.includes(p.id)) {
    req.session.viewed.push(p.id);
    db.prepare('UPDATE products SET views = views + 1 WHERE id = ?').run(p.id);
  }
  // Tài khoản liên quan: ngẫu nhiên các acc cùng game (mọi danh mục), tối đa 8
  const related = db.prepare(`SELECT ${PRODUCT_SELECT} FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id
    WHERE g.id = ? AND p.id != ? AND p.status = 'available' AND c.is_active = 1 ORDER BY RANDOM() LIMIT 8`).all(p.game_id, p.id).map(decorate);
  const coupons = publicCoupons(10).filter((c) => !c.game_id || c.game_id === p.game_id);
  res.render('pages/product', {
    title: p.title, p, related, coupons,
    metaDesc: (p.description || '').replace(/\s+/g, ' ').trim().slice(0, 200) || `${p.title} - ${p.game_name} · ${p.category_name}`,
    metaImage: p.imageList[0] || null,
    breadcrumb: [
      { name: p.game_name, url: `/game/${p.game_slug}` },
      { name: p.category_name, url: `/game/${p.game_slug}/${p.category_slug}` },
      { name: p.code },
    ],
  });
});

router.post('/product/:code/buy', requireLogin, limiters.buy, (req, res) => {
  const p = loadProduct(str(req.params.code, 20));
  if (!p) {
    req.flash('error', 'Sản phẩm không tồn tại');
    return res.redirect('/');
  }
  const r = purchase(req.user.id, p.id, str(req.body.coupon, 32), clientIp(req));
  if (!r.ok) {
    req.flash('error', r.message);
    return res.redirect(`/product/${p.code}`);
  }
  router.clearCache();
  req.flash('success', 'Mua thành công! Thông tin tài khoản ở bên dưới.');
  res.redirect(`/user/orders/${r.code}`);
});

// Kiểm tra mã giảm giá (AJAX)
router.post('/api/coupon/check', limiters.coupon, (req, res) => {
  const p = loadProduct(str(req.body.product, 20));
  if (!p) return res.json({ ok: false, message: 'Sản phẩm không tồn tại' });
  const v = validateCoupon(req.body.code, req.user?.id, p.price, p.game_id);
  if (!v.ok) return res.json({ ok: false, message: v.message });
  res.json({ ok: true, discount: v.discount, total: p.price - v.discount, message: `Áp dụng thành công: giảm ${v.discount.toLocaleString('vi-VN')}đ` });
});

// ================= TÌM KIẾM & KHUYẾN MÃI =================
router.get('/search', (req, res) => {
  const q = str(req.query.q, 60);
  let result = { rows: [], total: 0, page: 1, pages: 1 };
  if (q.length >= 2) {
    result = paginate(db, {
      select: PRODUCT_SELECT,
      from: 'products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id',
      where: "WHERE p.status = 'available' AND c.is_active = 1 AND g.is_active = 1 AND (p.title LIKE ? OR p.code LIKE ? OR g.name LIKE ? OR c.name LIKE ?)",
      params: [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`],
      order: 'ORDER BY p.id DESC', page: toInt(req.query.page, 1, 1), perPage: 12,
    });
    result.rows.forEach(decorate);
  }
  res.render('pages/search', { title: 'Tìm kiếm', q, result, query: { q }, breadcrumb: [{ name: 'Tìm kiếm' }] });
});

router.get('/khuyen-mai', (req, res) => {
  res.render('pages/coupons', { title: 'Mã khuyến mãi', coupons: publicCoupons(50), breadcrumb: [{ name: 'Khuyến mãi' }] });
});

module.exports = router;
