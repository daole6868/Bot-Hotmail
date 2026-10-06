'use strict';
/** Giao diện -> Nền trang (/admin/site-bg): ảnh hoặc video ngắn làm nền toàn trang khách */
const express = require('express');
const { setSetting, logActivity } = require('../db');
const { saveImage, saveVideo, removeImage } = require('../utils/upload');
const bg = require('../services/site-bg');
const H = require('../utils/helpers');

const router = express.Router();
const fileOf = (req, field) => (req.files || []).find((f) => f.fieldname === field);

router.get('/', (req, res) => res.render('admin/site-bg', { title: 'Nền trang', c: bg.cfg() }));

router.post('/', (req, res) => {
  const b = req.body;
  const c = { ...bg.cfg() };
  const old = { img: c.img, video: c.video };
  const img = fileOf(req, 'sitebg');
  if (img) { const u = saveImage(img, 'sitebg'); if (!u) { req.flash('error', 'Ảnh không hợp lệ'); return res.redirect('/admin/site-bg'); } c.img = u; }
  const vid = fileOf(req, 'bg_video');
  if (vid) { const u = saveVideo(vid, 'sitebg'); if (!u) { req.flash('error', 'Video không hợp lệ (chỉ MP4 / WebM)'); return res.redirect('/admin/site-bg'); } c.video = u; }
  if (b.remove_img) c.img = '';
  if (b.remove_video) c.video = '';
  c.type = ['none', 'image', 'video'].includes(b.type) ? b.type : 'none';
  if (c.type === 'video' && !c.video) c.type = c.img ? 'image' : 'none';
  if (c.type === 'image' && !c.img) c.type = 'none';
  c.scope = b.scope === 'home' ? 'home' : 'all';
  c.dark = H.toInt(b.dark, 35, 0, 90);
  c.blur = H.toInt(b.blur, 0, 0, 20);
  c.mobileVideo = !!b.mobileVideo;
  setSetting('site_bg', JSON.stringify(c));
  // file cũ đã bị thay / gỡ -> xóa khỏi ổ cứng
  if (old.img && old.img !== c.img) removeImage(old.img);
  if (old.video && old.video !== c.video) removeImage(old.video);
  require('./public').clearCache();
  logActivity(req.user.id, 'site_bg', `nền trang: ${c.type}`, H.clientIp(req));
  req.flash('success', 'Đã lưu nền trang');
  res.redirect('/admin/site-bg');
});

module.exports = router;
