'use strict';
/**
 * SEO: robots.txt + sitemap.xml (tự cập nhật theo game / danh mục / acc / bài viết).
 * Đặt TRƯỚC session: không tạo cookie, Cloudflare lưu được.
 */
const express = require('express');
const { db } = require('../db');
const config = require('../config');

const router = express.Router();
const base = () => String(config.baseUrl).replace(/\/$/, '');
const esc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const day = (ts) => new Date((ts || Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10);

router.get('/robots.txt', (req, res) => {
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600, s-maxage=3600').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /user',
    'Disallow: /login',
    'Disallow: /register',
    'Disallow: /forgot',
    'Disallow: /reset',
    'Disallow: /search',
    'Disallow: /boost/',
    'Disallow: /api/',
    '',
    `Sitemap: ${base()}/sitemap.xml`,
    '',
  ].join('\n'));
});

// Sitemap nhớ 1 giờ trong RAM (mỗi bản PM2 tự tạo lại khi hết hạn)
let cache = { at: 0, xml: '' };
const MAX_PRODUCTS = 20000;
function buildSitemap() {
  const b = base();
  const urls = [{ loc: '/', pri: '1.0', freq: 'daily' }, { loc: '/khuyen-mai', pri: '0.6', freq: 'daily' }, { loc: '/tin-tuc', pri: '0.7', freq: 'daily' }];
  const games = db.prepare('SELECT id, slug, created_at FROM games WHERE is_active = 1 ORDER BY sort_order, id').all();
  for (const g of games) urls.push({ loc: `/game/${g.slug}`, pri: '0.9', freq: 'daily' });
  db.prepare(`SELECT c.slug, g.slug AS gslug FROM categories c JOIN games g ON g.id = c.game_id WHERE c.is_active = 1 AND g.is_active = 1 ORDER BY g.sort_order, c.sort_order`).all()
    .forEach((c) => urls.push({ loc: `/game/${c.gslug}/${c.slug}`, pri: '0.8', freq: 'daily' }));
  // danh mục con cày thuê (trang gói)
  db.prepare(`SELECT b.slug, pc.slug AS pslug, g.slug AS gslug FROM boost_categories b JOIN categories pc ON pc.id = b.parent_id JOIN games g ON g.id = b.game_id
    WHERE b.is_active = 1 AND pc.is_active = 1 AND g.is_active = 1 AND pc.sale_type = 'boost'`).all()
    .forEach((c) => urls.push({ loc: `/game/${c.gslug}/${c.pslug}/${c.slug}`, pri: '0.7', freq: 'weekly' }));
  db.prepare("SELECT c.slug FROM post_categories c WHERE c.is_active = 1 AND EXISTS(SELECT 1 FROM posts p WHERE p.category_id = c.id AND p.status = 'published' AND p.published_at <= unixepoch())").all().forEach((c) => urls.push({ loc: `/tin-tuc/chuyen-muc/${c.slug}`, pri: '0.5', freq: 'weekly' }));
  db.prepare("SELECT slug, updated_at FROM posts WHERE status = 'published' AND published_at <= unixepoch() ORDER BY published_at DESC").all()
    .forEach((p) => urls.push({ loc: `/tin-tuc/${p.slug}`, pri: '0.7', freq: 'monthly', mod: p.updated_at }));
  db.prepare(`SELECT p.code, p.created_at FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id
    WHERE p.status = 'available' AND c.is_active = 1 AND g.is_active = 1 ORDER BY p.id DESC LIMIT ?`).all(MAX_PRODUCTS)
    .forEach((p) => urls.push({ loc: `/product/${p.code}`, pri: '0.6', freq: 'weekly', mod: p.created_at }));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => `<url><loc>${esc(b + u.loc)}</loc>${u.mod ? `<lastmod>${day(u.mod)}</lastmod>` : ''}<changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')
    + '\n</urlset>\n';
}
router.get('/sitemap.xml', (req, res) => {
  if (!cache.xml || Date.now() - cache.at > 3600 * 1000) cache = { at: Date.now(), xml: buildSitemap() };
  res.type('application/xml').set('Cache-Control', 'public, max-age=600, s-maxage=3600').send(cache.xml);
});
const clearSitemap = () => { cache.at = 0; };

module.exports = router;
module.exports.clearSitemap = clearSitemap;
