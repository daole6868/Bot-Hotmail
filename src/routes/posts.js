'use strict';
/**
 * Trang khách: Tin tức / Hướng dẫn — /tin-tuc, /tin-tuc/chuyen-muc/:slug, /tin-tuc/:slug
 */
const express = require('express');
const { db } = require('../db');
const config = require('../config');
const P = require('../services/posts');
const { toInt, paginate, clientIp } = require('../utils/helpers');

const router = express.Router();
const PUB = "p.status = 'published' AND p.published_at <= unixepoch()";
const SELECT = `p.id, p.title, p.slug, p.excerpt, p.cover, p.published_at, p.views, c.name AS cat_name, c.slug AS cat_slug, g.name AS game_name, g.image AS game_image`;
const FROM = 'posts p LEFT JOIN post_categories c ON c.id = p.category_id LEFT JOIN games g ON g.id = p.game_id';
const cats = () => db.prepare(`SELECT c.name, c.slug, (SELECT COUNT(*) FROM posts p WHERE p.category_id = c.id AND ${PUB}) AS n
  FROM post_categories c WHERE c.is_active = 1 ORDER BY c.sort_order, c.id`).all().filter((c) => c.n);

function list(req, res, cat) {
  const where = [PUB]; const params = [];
  if (cat) { where.push('p.category_id = ?'); params.push(cat.id); }
  const result = paginate(db, { select: SELECT, from: FROM, where: 'WHERE ' + where.join(' AND '), params, order: 'ORDER BY p.published_at DESC, p.id DESC', page: toInt(req.query.page, 1, 1), perPage: 12 });
  res.render('pages/posts', {
    title: cat ? `${cat.name} - Tin tức` : 'Tin tức & Hướng dẫn', result, cats: cats(), cat, query: {},
    metaDesc: cat ? (cat.description || `Bài viết chuyên mục ${cat.name}: tin game, hướng dẫn, mẹo chơi và khuyến mãi mới nhất.`) : 'Tin tức game, hướng dẫn mua acc, nạp game, cày thuê và mẹo chơi Genshin Impact, Honkai: Star Rail, Wuthering Waves, Zenless Zone Zero...',
    breadcrumb: cat ? [{ name: 'Tin tức', url: '/tin-tuc' }, { name: cat.name }] : [{ name: 'Tin tức' }],
  });
}
router.get('/tin-tuc', (req, res) => list(req, res, null));
router.get('/tin-tuc/chuyen-muc/:slug', (req, res, next) => {
  const cat = db.prepare('SELECT * FROM post_categories WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!cat) return next();
  list(req, res, cat);
});

const viewSeen = new Map();
router.get('/tin-tuc/:slug', (req, res, next) => {
  const preview = req.user?.role === 'admin' && req.query.preview === '1';
  const p = db.prepare(`SELECT p.*, c.name AS cat_name, c.slug AS cat_slug, g.name AS game_name, g.slug AS game_slug, u.username AS author
    FROM posts p LEFT JOIN post_categories c ON c.id = p.category_id LEFT JOIN games g ON g.id = p.game_id LEFT JOIN users u ON u.id = p.author_id
    WHERE p.slug = ?${preview ? '' : ` AND ${PUB}`}`).get(req.params.slug);
  if (!p) return next();
  if (!preview) {
    const k = clientIp(req) + ':' + p.id; const seen = viewSeen.get(k);
    if (!seen || Date.now() - seen > 6 * 3600 * 1000) {
      if (viewSeen.size > 100000) viewSeen.clear();
      viewSeen.set(k, Date.now());
      db.prepare('UPDATE posts SET views = views + 1 WHERE id = ?').run(p.id);
    }
  }
  const { html, toc } = P.render(p.content);
  const faq = P.faqList(p.faq);
  const related = db.prepare(`SELECT ${SELECT} FROM ${FROM} WHERE ${PUB} AND p.id != ? ORDER BY (p.game_id IS ? ) DESC, (p.category_id IS ?) DESC, p.published_at DESC LIMIT 4`)
    .all(p.id, p.game_id, p.category_id);
  const base = String(config.baseUrl).replace(/\/$/, '');
  const img = p.cover ? (/^https?:/.test(p.cover) ? p.cover : base + p.cover) : null;
  const ld = [{
    '@context': 'https://schema.org', '@type': 'BlogPosting', headline: p.title.slice(0, 110), description: p.seo_desc || p.excerpt || '',
    ...(img ? { image: [img] } : {}), datePublished: new Date((p.published_at || p.created_at) * 1000).toISOString(), dateModified: new Date(p.updated_at * 1000).toISOString(),
    author: { '@type': 'Organization', name: res.locals.s.site_name || 'Shop' }, mainEntityOfPage: `${base}/tin-tuc/${p.slug}`,
  }];
  if (faq.length) ld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  if (preview) res.set('Cache-Control', 'private, no-store');
  res.render('pages/post', {
    title: p.title, seoTitle: p.seo_title || null, metaDesc: p.seo_desc || p.excerpt || P.plain(p.content).slice(0, 160), metaImage: p.cover,
    p, html, toc, faq, related, minutes: P.readMinutes(p.content), jsonLd: ld, preview, noindex: preview || p.status !== 'published',
    breadcrumb: [{ name: 'Tin tức', url: '/tin-tuc' }, ...(p.cat_name ? [{ name: p.cat_name, url: `/tin-tuc/chuyen-muc/${p.cat_slug}` }] : []), { name: p.title }],
  });
});

module.exports = router;
