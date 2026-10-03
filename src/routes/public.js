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
  if (cache.size > 500) cache.clear(); // từ khóa tìm kiếm rất đa dạng -> không để bộ nhớ phình
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
// Trang chủ vẽ theo "Bố cục trang chủ" (admin): mỗi khối tự giữ cài đặt & nội dung riêng,
// một loại khối có thể thêm nhiều lần (VD 2 slider, 3 danh sách acc theo từng game).
const toIds = (a) => (Array.isArray(a) ? a.map((x) => toInt(x)).filter(Boolean) : []);
function loadHomeBlocks() {
  const blocks = db.prepare('SELECT * FROM home_blocks WHERE is_active = 1 ORDER BY sort_order, id').all()
    .map((b) => ({ ...b, settings: parseJSON(b.settings, {}) }));
  const items = db.prepare('SELECT * FROM home_block_items WHERE block_id = ? AND is_active = 1 ORDER BY sort_order, id');
  let allGames = null;
  for (const b of blocks) {
    const st = b.settings;
    if (['slider', 'strip', 'banner'].includes(b.type)) b.items = items.all(b.id);
    else if (b.type === 'games') {
      allGames = allGames || db.prepare(`SELECT g.*,
          (SELECT COUNT(*) FROM products p JOIN categories c ON c.id = p.category_id
             WHERE c.game_id = g.id AND c.is_active = 1 AND p.status = 'available') AS product_count,
          (SELECT COALESCE(SUM(p.sold_count),0) FROM products p JOIN categories c ON c.id = p.category_id WHERE c.game_id = g.id) AS sold
        FROM games g WHERE g.is_active = 1 ORDER BY g.sort_order, g.id`).all();
      const ids = toIds(st.game_ids);
      b.games = ids.length ? allGames.filter((g) => ids.includes(g.id)) : allGames;
    } else if (b.type === 'coupons') {
      const gid = toInt(st.game_id);
      b.coupons = publicCoupons(50).filter((c) => !gid || !c.game_id || c.game_id === gid).slice(0, toInt(st.limit, 8, 1, 50));
    } else if (b.type === 'boost') {
      const order = { newest: 'p.id DESC', cheap: 'p.price ASC, p.id DESC' }[st.source] || 'p.sold_count DESC, p.id DESC';
      const gid = toInt(st.game_id);
      b.packages = db.prepare(`SELECT p.*, c.name AS category_name, c.slug AS category_slug, g.name AS game_name, g.slug AS game_slug, pc.slug AS parent_slug
        FROM boost_packages p JOIN boost_categories c ON c.id = p.category_id JOIN categories pc ON pc.id = c.parent_id JOIN games g ON g.id = c.game_id
        WHERE p.is_active = 1 AND c.is_active = 1 AND pc.is_active = 1 AND g.is_active = 1${gid ? ' AND g.id = ?' : ''} ORDER BY ${order} LIMIT ?`)
        .all(...(gid ? [gid] : []), toInt(st.limit, 8, 1, 48));
    } else if (b.type === 'recent') {
      // Đơn mua acc + đơn cày thuê (không tính đơn đã hủy / hoàn tiền), mới nhất trước
      const lim = toInt(st.limit, 10, 1, 30);
      b.recent = db.prepare(`SELECT * FROM (
          SELECT o.product_title, o.total, o.created_at, u.username FROM orders o JOIN users u ON u.id = o.user_id
            WHERE o.status = 'completed' ORDER BY o.id DESC LIMIT ?)
        UNION ALL SELECT * FROM (
          SELECT 'Cày thuê: ' || (SELECT GROUP_CONCAT(name, ', ') FROM boost_order_items i WHERE i.order_id = b.id), b.total, b.created_at, u.username
            FROM boost_orders b JOIN users u ON u.id = b.user_id WHERE b.status != 'cancelled' ORDER BY b.id DESC LIMIT ?)
        ORDER BY created_at DESC LIMIT ?`).all(lim, lim, lim).map((o) => ({ ...o, username: maskName(o.username) }));
    }
  }
  return blocks;
}

// Khối danh sách acc: lấy theo nguồn admin chọn (nổi bật / mới nhất / bán chạy / giá rẻ / ngẫu nhiên), lọc theo game hoặc danh mục
function productsForBlock(st) {
  const where = ["p.status = 'available'", 'c.is_active = 1', 'g.is_active = 1'];
  const params = [];
  const src = st.source || 'featured';
  if (src === 'featured') where.push('p.is_featured = 1');
  if (toInt(st.category_id)) { where.push('p.category_id = ?'); params.push(toInt(st.category_id)); }
  else if (toInt(st.game_id)) { where.push('g.id = ?'); params.push(toInt(st.game_id)); }
  const order = { newest: 'p.id DESC', bestseller: 'p.sold_count DESC, p.id DESC', cheap: 'p.price ASC, p.id DESC' }[src] || 'RANDOM()';
  return db.prepare(`SELECT ${PRODUCT_SELECT} FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id
    WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...params, toInt(st.limit, 12, 1, 48)).map(decorate);
}

router.get('/', (req, res) => {
  const blocks = cached('home', 30000, loadHomeBlocks);
  // Danh sách acc lấy mỗi lần tải trang (nguồn "ngẫu nhiên"/"nổi bật" xáo trộn khác nhau cho từng khách)
  const view = blocks.map((b) => (b.type === 'featured' ? { ...b, products: productsForBlock(b.settings) } : b))
    .filter((b) => (b.items ? b.items.length : true) && (b.products ? b.products.length : true) && (b.recent ? b.recent.length : true) && (b.games ? b.games.length : true) && (b.packages ? b.packages.length : true));
  res.render('pages/home', { title: null, blocks: view });
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
  const coupons = publicCoupons(10, 'acc').filter((c) => !c.game_id || c.game_id === game.id);
  // Danh mục loại Cày thuê: số gói / lượt thuê / giá từ lấy theo các gói trong danh mục con
  const bStat = db.prepare(`SELECT COUNT(p.id) pkgs, MIN(p.price) min_price, COALESCE(SUM(p.sold_count), 0) sold
    FROM boost_categories b JOIN boost_packages p ON p.category_id = b.id AND p.is_active = 1 WHERE b.parent_id = ? AND b.is_active = 1`);
  categories.forEach((c) => { if (c.sale_type === 'boost') Object.assign(c, bStat.get(c.id)); });
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

const relatedCache = new Map();
const viewSeen = new Map();
function relatedIds(gameId) {
  const c = relatedCache.get(gameId);
  if (c && Date.now() - c.at < 60000) return c.ids.slice();
  const ids = db.prepare(`SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
    WHERE c.game_id = ? AND c.is_active = 1 AND p.status = 'available' ORDER BY p.id DESC LIMIT 2000`).all(gameId).map((r) => r.id);
  relatedCache.set(gameId, { at: Date.now(), ids });
  return ids.slice();
}

router.get('/product/:code', (req, res, next) => {
  const p = loadProduct(str(req.params.code, 20));
  if (!p) return next();
  // Đếm lượt xem: mỗi IP tính 1 lần / acc / 6 giờ (nhớ trong RAM, không tạo phiên cho khách chưa đăng nhập)
  const vk = clientIp(req) + ':' + p.id;
  const seen = viewSeen.get(vk);
  if (!seen || Date.now() - seen > 6 * 3600 * 1000) {
    if (viewSeen.size > 100000) viewSeen.clear();
    viewSeen.set(vk, Date.now());
    db.prepare('UPDATE products SET views = views + 1 WHERE id = ?').run(p.id);
  }
  // Tài khoản liên quan: ngẫu nhiên 8 acc cùng game. Danh sách id acc đang bán của game được nhớ 60 giây,
  // chọn ngẫu nhiên trong JS rồi lấy đúng 8 acc theo id -> không phải xáo trộn cả nghìn acc mỗi lần mở trang
  const ids = relatedIds(p.game_id).filter((id) => id !== p.id);
  const pick = [];
  for (let i = 0; i < 8 && ids.length; i++) pick.push(ids.splice(Math.random() * ids.length | 0, 1)[0]);
  const related = pick.length ? db.prepare(`SELECT ${PRODUCT_SELECT} FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id
    WHERE p.id IN (${pick.map(() => '?').join(',')}) AND p.status = 'available'`).all(...pick).map(decorate) : [];
  const coupons = publicCoupons(10, 'acc').filter((c) => !c.game_id || c.game_id === p.game_id);
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
  const o = db.prepare('SELECT order_code, product_title, discount, total, created_at FROM orders WHERE id = ?').get(r.orderId);
  if (o) require('../services/mailer').sendLater(req.user.email, 'order', { username: req.user.username, code: o.order_code, title: o.product_title, discount: o.discount, total: o.total, at: o.created_at });
  req.flash('success', 'Mua thành công! Thông tin tài khoản ở bên dưới.');
  res.redirect(`/user/orders/${r.code}`);
});

// Kiểm tra mã giảm giá (AJAX)
router.post('/api/coupon/check', limiters.coupon, (req, res) => {
  const p = loadProduct(str(req.body.product, 20));
  if (!p) return res.json({ ok: false, message: 'Sản phẩm không tồn tại' });
  const v = validateCoupon(req.body.code, req.user?.id, p.price, p.game_id, 'acc');
  if (!v.ok) return res.json({ ok: false, message: v.message });
  res.json({ ok: true, discount: v.discount, total: p.price - v.discount, message: `Áp dụng thành công: giảm ${v.discount.toLocaleString('vi-VN')}đ` });
});

// ================= TÌM KIẾM & KHUYẾN MÃI =================
router.get('/search', (req, res) => {
  const q = str(req.query.q, 60);
  let result = { rows: [], total: 0, page: 1, pages: 1 };
  // Từ khóa -> truy vấn FTS: mỗi từ khớp tiền tố ("lien quan" khớp "Liên Quân ...")
  const terms = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  const page = toInt(req.query.page, 1, 1);
  const ck = 'search:' + terms.join(' ') + ':' + page;
  if (q.length >= 2 && terms.length) result = cached(ck, 20000, () => {
    const match = terms.map((t) => `"${t}"*`).join(' ');
    // Tên game / danh mục (bảng nhỏ): so khớp không dấu, VD "lien quan" khớp "Liên Quân Mobile"
    const plain = (x) => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
    const pq = plain(terms.join(' '));
    const catIds = db.prepare('SELECT c.id, c.name, g.name AS game FROM categories c JOIN games g ON g.id = c.game_id').all()
      .filter((c) => plain(c.name).includes(pq) || plain(c.game).includes(pq)).map((c) => c.id);
    const r = paginate(db, {
      select: PRODUCT_SELECT,
      from: 'products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id',
      where: `WHERE p.status = 'available' AND c.is_active = 1 AND g.is_active = 1
        AND (p.id IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)${catIds.length ? ` OR p.category_id IN (${catIds.join(',')})` : ''})`,
      params: [match],
      order: 'ORDER BY p.id DESC', page, perPage: 12,
    });
    r.rows.forEach(decorate);
    return r;
  });
  res.render('pages/search', { title: 'Tìm kiếm', q, result, query: { q }, breadcrumb: [{ name: 'Tìm kiếm' }] });
});

router.get('/khuyen-mai', (req, res) => {
  res.render('pages/coupons', { title: 'Mã khuyến mãi', coupons: publicCoupons(50), breadcrumb: [{ name: 'Khuyến mãi' }] });
});

module.exports = router;
