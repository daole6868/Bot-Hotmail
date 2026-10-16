'use strict';
/** Giao diện -> Hiệu ứng (/admin/site-fx): bật / tắt từng hiệu ứng dịp lễ, khoảng thời gian tự chạy, chữ trên băng chúc mừng */
const express = require('express');
const { setSetting, logActivity } = require('../db');
const fx = require('../services/site-fx');
const H = require('../utils/helpers');

const router = express.Router();
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

router.get('/', (req, res) => {
  const c = fx.cfg(), now = fx.vnNow();
  res.render('admin/site-fx', { title: 'Hiệu ứng', c, LIST: fx.LIST, GROUPS: fx.GROUPS, st: (k) => fx.state(c.items[k], now), live: fx.forPage(null) });
});

router.post('/', (req, res) => {
  const b = req.body;
  if (b.all_off) {
    const c = fx.cfg(), items = {};
    for (const e of fx.LIST) items[e.k] = { ...c.items[e.k], on: false };
    setSetting('site_fx', JSON.stringify({ ...c, items }));
    logActivity(req.user.id, 'site_fx', 'tắt tất cả hiệu ứng', H.clientIp(req));
    req.flash('success', 'Đã tắt tất cả hiệu ứng');
    return res.redirect('/admin/site-fx');
  }
  const items = {}, bad = [];
  for (const e of fx.LIST) {
    let from = String(b['from_' + e.k] || '').trim(), to = String(b['to_' + e.k] || '').trim();
    if (!DT.test(from)) from = ''; if (!DT.test(to)) to = '';
    if (from && to && to < from) bad.push(e.name);
    const t = b['text_' + e.k];
    items[e.k] = { on: !!b['on_' + e.k], from, to, text: e.rb && typeof t === 'string' ? H.str(t, 160).trim() || null : null };
  }
  if (bad.length) { req.flash('error', `Ngày kết thúc phải sau ngày bắt đầu: ${bad.join(', ')}`); return res.redirect('/admin/site-fx'); }
  const dens = [0.5, 1, 1.7].includes(+b.dens) ? +b.dens : 1;
  setSetting('site_fx', JSON.stringify({ on: !!b.on, dens, mobile: !!b.mobile, banner: !!b.banner, items }));
  const n = Object.values(items).filter((it) => it.on).length;
  logActivity(req.user.id, 'site_fx', `${b.on ? 'bật' : 'tắt'} hiệu ứng, ${n} mục được bật`, H.clientIp(req));
  req.flash('success', 'Đã lưu hiệu ứng');
  res.redirect('/admin/site-fx');
});

module.exports = router;
