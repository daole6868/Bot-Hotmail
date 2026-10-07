'use strict';
/**
 * Tổng quan -> Tạo ảnh acc (/admin/acc-image): dựng ảnh acc (nền + thông tin + lưới nhân vật / vũ khí + mã acc + logo)
 * và sửa ảnh (cắt, xoay, che, chữ, logo, màu). Ảnh vẽ trên trình duyệt (canvas), máy chủ chỉ nhận ảnh cuối.
 * Admin, quản lý, CTV bán hàng đều dùng được (CTV chỉ gắn ảnh vào sản phẩm của mình).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, getSettings, setSetting, logActivity } = require('../db');
const { saveImage, removeImage } = require('../utils/upload');
const thumbs = require('../utils/thumbs');
const hoyo = require('../services/hoyo');
const config = require('../config');
const H = require('../utils/helpers');

const router = express.Router();
const ctvSvc = require('../services/ctv');
const isStaff = (req) => req.perm === 'admin' || req.perm === 'manager';
const owns = (req, p) => !!p && (req.perm !== 'seller' || (p.owner_id === req.user.id && ctvSvc.canCat(req.user.id, p.category_id, ['vip', 'reroll'])));
const IMG_RE = /^\/uploads\/[\w\-/]+\.(webp|jpe?g|png|gif)$/i;
const exists = (pub) => {
  if (!IMG_RE.test(pub || '')) return false;
  const full = path.normalize(path.join(config.paths.uploads, pub.slice('/uploads/'.length)));
  return full.startsWith(config.paths.uploads + path.sep) && fs.existsSync(full);
};
const list = (key) => { try { const a = JSON.parse(getSettings()[key] || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const gameOfCat = (catId) => {
  const r = db.prepare('SELECT g.name FROM categories c JOIN games g ON g.id = c.game_id WHERE c.id = ?').get(catId);
  return r ? hoyo.gameOf(r.name) : '';
};

/** Dữ liệu 1 sản phẩm cho trình dựng ảnh */
function productData(req, id) {
  const p = db.prepare('SELECT id, code, title, category_id, owner_id, acc_detail, images FROM products WHERE id = ?').get(id);
  if (!owns(req, p)) return null;
  let d = null; try { d = JSON.parse(p.acc_detail || 'null'); } catch { d = null; }
  return { id: p.id, code: p.code, title: p.title, game: (d && d.game) || gameOfCat(p.category_id), detail: d, images: H.parseJSON(p.images, []) };
}

router.get('/', (req, res) => {
  const s = getSettings();
  const pid = H.toInt(req.query.product, 0);
  const product = pid ? productData(req, pid) : null;
  const img = exists(String(req.query.img || '')) ? String(req.query.img) : '';
  res.render('admin/acc-image', {
    title: 'Tạo ảnh acc',
    boot: {
      mode: req.query.mode === 'edit' || img ? 'edit' : (req.query.mode === 'batch' ? 'batch' : 'make'),
      fromForm: req.query.from === 'form', product, img,
      games: hoyo.GAMES, servers: hoyo.SERVERS, logo: s.logo || '', site: s.site_name || '',
      tpls: list('accimg_tpls'), bgs: list('accimg_bgs'), me: req.user.id, staff: isStaff(req),
    },
  });
});

// Danh sách acc VIP có chi tiết tài khoản (tạo ảnh hàng loạt)
router.get('/products', (req, res) => {
  const q = H.str(req.query.q, 60);
  const where = ["p.type = 'account'", "p.acc_detail IS NOT NULL AND p.acc_detail <> ''", "p.status <> 'sold'"];
  const params = [];
  if (q) { where.push('(p.code LIKE ? OR p.title LIKE ?)'); params.push('%' + q + '%', '%' + q + '%'); }
  if (req.perm === 'seller') { where.push('p.owner_id = ?'); params.push(req.user.id); }
  const rows = db.prepare(`SELECT p.id, p.code, p.title, p.images, p.category_id, p.owner_id, json_extract(p.acc_detail, '$.game') AS game
    FROM products p WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 200`).all(...params);
  res.json({ ok: true, rows: rows.filter((r) => owns(req, r)).map((r) => ({ id: r.id, code: r.code, title: r.title, game: r.game, img: H.parseJSON(r.images, []).length })) });
});
// Cung mệnh đã nạp (Quản lý ảnh -> Cung mệnh) của các nhân vật theo tên: { tên: { ring, slots: [{ s, n, i }] } }
router.post('/consts', (req, res) => {
  const b = req.body || {};
  const game = hoyo.GAMES[b.game] ? b.game : '';
  const names = Array.isArray(b.names) ? b.names.slice(0, 200).map((n) => H.str(n, 60)).filter(Boolean) : [];
  if (!game || !names.length) return res.json({ ok: true, data: {} });
  const cst = require('../services/hoyo-const');
  const one = db.prepare("SELECT id, ring FROM hoyo_assets WHERE game = ? AND kind = 'char' AND nkey = ?");
  const slots = db.prepare("SELECT slot AS s, name AS n, icon AS i FROM hoyo_consts WHERE asset_id = ? AND icon <> '' ORDER BY slot");
  const data = {};
  for (const n of names) {
    const a = one.get(game, hoyo.nkey(n));
    if (!a) continue;
    const s = slots.all(a.id);
    if (s.length) data[n] = { ring: cst.ringOf(game, a.ring), slots: s };
  }
  res.json({ ok: true, data });
});
router.get('/product/:id', (req, res) => {
  const p = productData(req, H.toInt(req.params.id, 0));
  res.json(p ? { ok: true, product: p } : { ok: false, message: 'Không tìm thấy sản phẩm' });
});

// Lưu ảnh: nén WebP + tạo ảnh nhỏ cho thẻ; product_id + attach -> gắn vào sản phẩm (ảnh đầu, hoặc thay ảnh cũ)
router.post('/save', async (req, res) => {
  const f = (req.files || []).find((x) => x.fieldname === 'accimg');
  if (!f) return res.json({ ok: false, message: 'Không nhận được ảnh' });
  const url = saveImage(f, 'products');
  if (!url) return res.json({ ok: false, message: 'Ảnh không hợp lệ' });
  await thumbs.make(url);
  const pid = H.toInt(req.body.product_id, 0);
  if (pid && req.body.attach === '1') {
    const p = db.prepare('SELECT id, owner_id, category_id, images FROM products WHERE id = ?').get(pid);
    if (!owns(req, p)) { removeImage(url); return res.json({ ok: false, message: 'Bạn không có quyền với sản phẩm này' }); }
    let imgs = H.parseJSON(p.images, []);
    const old = String(req.body.replace || '');
    if (old && imgs.includes(old)) { imgs = imgs.map((x) => (x === old ? url : x)); removeImage(old); } else imgs = [url, ...imgs];
    db.prepare('UPDATE products SET images = ?, updated_at = unixepoch() WHERE id = ?').run(JSON.stringify(imgs.slice(0, 10)), pid);
    require('./public').clearCache();
  }
  logActivity(req.user.id, 'acc_image', `${url}${pid ? ' -> SP #' + pid : ''}`, H.clientIp(req));
  res.json({ ok: true, url });
});

// Mẫu dùng chung: ai cũng tạo được; xóa: người tạo hoặc admin / quản lý
router.post('/tpl', (req, res) => {
  const name = H.str(req.body.name, 40);
  const data = req.body.data;
  if (!name || !data || typeof data !== 'object') return res.json({ ok: false, message: 'Thiếu tên mẫu' });
  const json = JSON.stringify(data);
  if (json.length > 20000) return res.json({ ok: false, message: 'Mẫu quá lớn' });
  const tpls = list('accimg_tpls').filter((t) => !(t.name === name && (t.by === req.user.id || isStaff(req))));
  if (tpls.length >= 60) return res.json({ ok: false, message: 'Tối đa 60 mẫu, hãy xóa bớt' });
  const t = { id: crypto.randomBytes(6).toString('hex'), name, by: req.user.id, data };
  tpls.push(t);
  setSetting('accimg_tpls', JSON.stringify(tpls));
  res.json({ ok: true, tpl: t });
});
router.post('/tpl/:id/delete', (req, res) => {
  const tpls = list('accimg_tpls');
  const t = tpls.find((x) => x.id === req.params.id);
  if (!t || (t.by !== req.user.id && !isStaff(req))) return res.json({ ok: false, message: 'Không xóa được mẫu này' });
  setSetting('accimg_tpls', JSON.stringify(tpls.filter((x) => x !== t)));
  res.json({ ok: true });
});

// Kho ảnh nền
router.post('/bg', (req, res) => {
  const f = (req.files || []).find((x) => x.fieldname === 'bg');
  const url = f ? saveImage(f, 'accbg') : null;
  if (!url) return res.json({ ok: false, message: 'Ảnh không hợp lệ' });
  const bgs = list('accimg_bgs');
  bgs.unshift({ u: url, by: req.user.id, g: H.str(req.body.game, 10) });
  setSetting('accimg_bgs', JSON.stringify(bgs.slice(0, 80)));
  res.json({ ok: true, bg: bgs[0] });
});
router.post('/bg/delete', (req, res) => {
  const bgs = list('accimg_bgs');
  const b = bgs.find((x) => x.u === req.body.u);
  if (!b || (b.by !== req.user.id && !isStaff(req))) return res.json({ ok: false, message: 'Không xóa được ảnh nền này' });
  setSetting('accimg_bgs', JSON.stringify(bgs.filter((x) => x !== b)));
  removeImage(b.u);
  res.json({ ok: true });
});

module.exports = router;
