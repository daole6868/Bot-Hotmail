'use strict';
/** Giao diện -> Bộ lọc tìm kiếm (/admin/search-filter): bật/tắt, đổi tên từng ô lọc, mệnh giá, máy chủ, kiểu tải */
const express = require('express');
const { setSetting, logActivity } = require('../db');
const sf = require('../services/search-filter');
const H = require('../utils/helpers');

const router = express.Router();

router.get('/', (req, res) => {
  res.render('admin/search-filter', { title: 'Bộ lọc tìm kiếm', c: sf.cfg(), FIELDS: sf.FIELDS, SORTS: sf.SORTS });
});

router.post('/', (req, res) => {
  const b = req.body;
  const fields = {};
  for (const k of Object.keys(sf.FIELDS)) {
    fields[k] = { on: !!b['on_' + k], label: sf.s_(b['label_' + k], 40) || sf.FIELDS[k].label, ph: sf.s_(b['ph_' + k], 60) || sf.FIELDS[k].ph };
  }
  // Mỗi dòng: Tên | từ | đến  (đến = 0: không giới hạn)
  const prices = String(b.prices || '').split(/\r?\n/).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0])
    .slice(0, 30).map(([l, min, max]) => ({ l: l.slice(0, 40), min: sf.int(String(min || '').replace(/\D/g, ''), 0, 0, 1e12), max: sf.int(String(max || '').replace(/\D/g, ''), 0, 0, 1e12) }));
  // Mỗi dòng: Tên hiển thị | giá trị (khớp máy chủ trong Chi tiết tài khoản)
  const servers = String(b.servers || '').split(/\r?\n/).map((l) => l.split('|').map((x) => x.trim())).filter((p) => p[0])
    .slice(0, 20).map(([l, v]) => ({ l: l.slice(0, 40), v: (v || l).slice(0, 30) }));
  const sorts = [].concat(b.sorts || []).filter((k) => sf.SORTS.some(([x]) => x === k));
  setSetting('filter_cfg', JSON.stringify({
    fields, prices, servers, sorts: sorts.length ? sorts : ['default'],
    mode: b.mode === 'page' ? 'page' : 'scroll', modeToggle: !!b.modeToggle, perPage: sf.int(b.perPage, 12, 4, 60),
  }));
  require('./public').clearCache();
  logActivity(req.user.id, 'filter_cfg', 'cập nhật bộ lọc tìm kiếm', H.clientIp(req));
  req.flash('success', 'Đã lưu bộ lọc tìm kiếm');
  res.redirect('/admin/search-filter');
});

module.exports = router;
