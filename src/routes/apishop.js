'use strict';
/** Trang khách của Nguồn hàng API: mục /game/:slug (games.kind = 'api') + mua hàng. Đơn của khách ở /user/api-orders (routes/user.js). */
const express = require('express');
const { db } = require('../db');
const { str, toInt, clientIp } = require('../utils/helpers');
const { limiters } = require('../middleware/security');
const ap = require('../services/apishop');

const router = express.Router();

router.get('/game/:slug', (req, res, next) => {
  const game = db.prepare("SELECT * FROM games WHERE slug = ? AND is_active = 1 AND kind = 'api'").get(req.params.slug);
  if (!game) return next();
  const c = ap.cfg();
  const groups = c.gameId === game.id && ap.ready(c) ? ap.listing(c) : [];
  const all = groups.flatMap((g) => g.items);
  res.render('pages/api-shop', {
    title: game.name, game, groups, ui: c.ui, breadcrumb: [{ name: game.name }],
    seoTitle: game.seo_title,
    metaDesc: game.seo_desc || game.description || `${game.name}: ${all.length} sản phẩm${all.length ? ', giá từ ' + Math.min(...all.map((x) => x.price)).toLocaleString('vi-VN') + 'đ' : ''}. Giao hàng tự động ngay sau khi thanh toán.`,
    metaImage: game.image,
  });
});

router.post('/api-shop/buy', limiters.buy, async (req, res) => {
  if (!req.user) return res.status(401).json({ ok: false, login: true, message: 'Vui lòng đăng nhập để mua' });
  const b = req.body || {};
  const r = await ap.buy(req.user.id, toInt(b.id), toInt(b.qty), toInt(b.unit), clientIp(req), str(b.idem, 64));
  if (r.ok) require('./public').clearCache();
  res.json(r);
});

module.exports = router;
