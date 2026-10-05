'use strict';
/**
 * Giao diện -> Quản lý ảnh (/admin/images): ảnh game, danh mục lớn, danh mục nhỏ, sản phẩm
 * và thư viện ảnh nhân vật / vũ khí từng game (nạp thủ công bằng cách dán HTML HoYoLAB).
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { db, logActivity } = require('../db');
const config = require('../config');
const H = require('../utils/helpers');
const { saveImage, removeImage } = require('../utils/upload');
const hoyo = require('../services/hoyo');
const lib = require('../services/img-lib');

const router = express.Router();
const { toInt, str, clientIp } = H;
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const fileOf = (req, field) => (req.files || []).find((f) => f.fieldname === field);
const back = (req, res, type, msg, url) => { if (msg) req.flash(type, msg); res.redirect(url || '/admin/images'); };
const libUrl = (game, kind) => `/admin/images?tab=hoyo&game=${encodeURIComponent(game || 'genshin')}&kind=${kind === 'weapon' ? 'weapon' : 'char'}`;
const libOf = (id) => db.prepare('SELECT game, kind FROM hoyo_assets WHERE id = ?').get(id) || {};

// Bảng có 1 ảnh mỗi dòng
const SLOTS = {
  games: { table: 'games', label: 'Ảnh game', folder: 'games' },
  cats: { table: 'categories', label: 'Danh mục lớn', folder: 'categories' },
  subcats: { table: 'boost_categories', label: 'Danh mục nhỏ', folder: 'boost' },
};

function size(pub) {
  if (!pub || !pub.startsWith('/uploads/')) return 0;
  const full = path.normalize(path.join(config.paths.uploads, pub.slice(9)));
  if (!full.startsWith(config.paths.uploads)) return 0;
  try { return fs.statSync(full).size; } catch { return 0; }
}

const TABS = ['games', 'cats', 'subcats', 'products', 'hoyo'];
router.get('/', (req, res) => {
  const tab = TABS.includes(req.query.tab) ? req.query.tab : 'games';
  const q = str(req.query.q, 60).trim();
  const data = { title: 'Quản lý ảnh', tab, q, SLOTS, GAMES: hoyo.GAMES, query: req.query };
  if (tab === 'games') data.rows = db.prepare('SELECT id, name, image, NULL AS game_name FROM games ORDER BY sort_order, id').all();
  if (tab === 'cats') data.rows = db.prepare('SELECT c.id, c.name, c.image, g.name AS game_name FROM categories c JOIN games g ON g.id = c.game_id ORDER BY g.sort_order, g.id, c.sort_order, c.id').all();
  if (tab === 'subcats') data.rows = db.prepare('SELECT b.id, b.name, b.image, g.name AS game_name FROM boost_categories b JOIN games g ON g.id = b.game_id WHERE b.parent_id IS NOT NULL ORDER BY g.sort_order, g.id, b.sort_order, b.id').all();
  if (data.rows) data.rows.forEach((r) => { r.size = size(r.image); });
  if (tab === 'products') {
    const where = ["p.images NOT IN ('', '[]')"]; const params = [];
    if (['available', 'sold', 'hidden'].includes(req.query.status)) { where.push('p.status = ?'); params.push(req.query.status); }
    if (q) { where.push('(p.title LIKE ? OR p.code LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
    data.result = H.paginate(db, {
      select: 'p.id, p.code, p.title, p.status, p.images, c.name AS cat_name, g.name AS game_name',
      from: 'products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id',
      where: 'WHERE ' + where.join(' AND '), params, order: 'ORDER BY p.id DESC', page: toInt(req.query.page, 1, 1), perPage: 30,
    });
    data.result.rows.forEach((r) => { r.list = H.parseJSON(r.images, []); r.size = r.list.reduce((a, i) => a + size(i), 0); });
  }
  if (tab === 'hoyo') {
    data.game = hoyo.GAMES[req.query.game] ? req.query.game : 'genshin';
    data.kind = req.query.kind === 'weapon' ? 'weapon' : 'char';
    const params = [data.game, data.kind]; let extra = '';
    if (q) { extra = ' AND nkey LIKE ?'; params.push('%' + hoyo.nkey(q) + '%'); }
    // Mỗi lần 120 mục, kéo xuống tự tải tiếp (trang nhẹ, ít yêu cầu ảnh một lúc)
    const PER = 120;
    data.page = toInt(req.query.page, 1, 1, 1000);
    data.total = db.prepare(`SELECT COUNT(*) n FROM hoyo_assets WHERE game = ? AND kind = ?${extra}`).get(...params).n;
    data.assets = db.prepare(`SELECT id, name, icon, rarity FROM hoyo_assets WHERE game = ? AND kind = ?${extra} ORDER BY rarity DESC, name LIMIT ? OFFSET ?`).all(...params, PER, (data.page - 1) * PER);
    data.hasMore = data.page * PER < data.total;
    if (req.query.frag) return res.render('admin/partials/lib-items', { assets: data.assets, libG: hoyo.GAMES[data.game], libKind: data.kind, csrfToken: res.locals.csrfToken }, (err, html) => res.json(err ? { ok: false } : { ok: true, html, more: data.hasMore }));
    data.counts = Object.fromEntries(db.prepare('SELECT game || kind AS k, COUNT(*) n FROM hoyo_assets GROUP BY game, kind').all().map((r) => [r.k, r.n]));
  }
  res.render('admin/images', data);
});

// ---------- Ảnh game / danh mục: thay / xóa ----------
router.post('/slot/:type/:id/replace', (req, res) => {
  const s = SLOTS[req.params.type];
  const id = toInt(req.params.id);
  const row = s && db.prepare(`SELECT id, name, image FROM ${s.table} WHERE id = ?`).get(id);
  const url = '/admin/images?tab=' + (s ? req.params.type : 'games');
  if (!row) return back(req, res, 'error', 'Không tìm thấy', url);
  const f = fileOf(req, 'image');
  const saved = f && saveImage(f, s.folder);
  if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ', url);
  db.prepare(`UPDATE ${s.table} SET image = ? WHERE id = ?`).run(saved, id);
  if (row.image) removeImage(row.image);
  if (req.params.type !== 'subcats') require('./public').clearCache();
  audit(req, 'image_replace', `${s.label}: ${row.name}`);
  back(req, res, 'success', 'Đã thay ảnh ' + row.name, url);
});
router.post('/slot/:type/:id/remove', (req, res) => {
  const s = SLOTS[req.params.type];
  const id = toInt(req.params.id);
  const row = s && db.prepare(`SELECT id, name, image FROM ${s.table} WHERE id = ?`).get(id);
  const url = '/admin/images?tab=' + (s ? req.params.type : 'games');
  if (!row || !row.image) return back(req, res, 'error', 'Không có ảnh để xóa', url);
  db.prepare(`UPDATE ${s.table} SET image = NULL WHERE id = ?`).run(id);
  removeImage(row.image);
  if (req.params.type !== 'subcats') require('./public').clearCache();
  audit(req, 'image_remove', `${s.label}: ${row.name}`);
  back(req, res, 'success', 'Đã xóa ảnh ' + row.name, url);
});

// ---------- Ảnh sản phẩm: xóa toàn bộ ảnh của 1 sản phẩm ----------
router.post('/products/:id/clear', (req, res) => {
  const p = db.prepare('SELECT id, code, images FROM products WHERE id = ?').get(toInt(req.params.id));
  const url = '/admin/images?tab=products';
  if (!p) return back(req, res, 'error', 'Không tìm thấy', url);
  const list = H.parseJSON(p.images, []);
  db.prepare("UPDATE products SET images = '[]' WHERE id = ?").run(p.id);
  list.forEach(removeImage);
  require('./public').clearCache();
  audit(req, 'image_clear_product', p.code);
  back(req, res, 'success', `Đã xóa ${list.length} ảnh của #${p.code}`, url);
});

// ---------- Thư viện ảnh nhân vật / vũ khí ----------
const gameKind = (b) => ({ game: hoyo.GAMES[b.game] ? b.game : '', kind: b.kind === 'weapon' ? 'weapon' : 'char' });

// Dán HTML: tách trước để xem trước (preview = 1), hoặc nạp luôn
router.post('/hoyo/import', async (req, res) => {
  const { game, kind } = gameKind(req.body || {});
  if (!game) return res.json({ ok: false, message: 'Chọn game' });
  const { items, dup } = lib.parseHtml(String((req.body && req.body.html) || ''));
  if (!items.length) return res.json({ ok: false, message: 'Không tìm thấy ảnh + tên nào trong HTML đã dán' });
  if (req.body.preview) {
    const fresh = items.filter((it) => !hoyo.libGet(game, kind, it.name));
    const had = items.filter((it) => !fresh.includes(it)).map((x) => x.name);
    return res.json({ ok: true, total: items.length, dup: dup.slice(0, 50), had: had.slice(0, 200), fresh: fresh.length, names: fresh.map((x) => x.name).slice(0, 200) });
  }
  const r = await lib.importItems(game, kind, items);
  audit(req, 'image_lib_import', `${game}/${kind}: +${r.added.length}, có sẵn ${r.existed.length}, lỗi ${r.failed.length}`);
  res.json({ ok: true, total: items.length, ...r, dup: dup.slice(0, 50), existed: r.existed.slice(0, 200) });
});

router.post('/hoyo/add', async (req, res) => {
  const { game, kind } = gameKind(req.body);
  const f = fileOf(req, 'image');
  const r = await lib.addOne(game, kind, req.body.name, toInt(req.body.rarity, 0, 0, 5), { buffer: f && f.buffer, url: str(req.body.url, 500) });
  if (r.ok) audit(req, 'image_lib_add', `${game}/${kind}: ${str(req.body.name, 60)}`);
  back(req, res, r.ok ? 'success' : 'error', r.ok ? 'Đã thêm ' + str(req.body.name, 60) : r.message, libUrl(game, kind));
});
router.post('/hoyo/:id/replace', async (req, res) => {
  const a = libOf(toInt(req.params.id));
  const f = fileOf(req, 'image');
  if (!f) return back(req, res, 'error', 'Chọn file ảnh', libUrl(a.game, a.kind));
  const r = await lib.replace(toInt(req.params.id), f.buffer);
  back(req, res, r.ok ? 'success' : 'error', r.ok ? 'Đã thay ảnh' : r.message, libUrl(a.game, a.kind));
});
router.post('/hoyo/:id/rename', (req, res) => {
  const a = libOf(toInt(req.params.id));
  const r = lib.rename(toInt(req.params.id), req.body.name);
  back(req, res, r.ok ? 'success' : 'error', r.ok ? 'Đã đổi tên' : r.message, libUrl(a.game, a.kind));
});
router.post('/hoyo/:id/delete', (req, res) => {
  const a = libOf(toInt(req.params.id));
  const ok = lib.remove(toInt(req.params.id));
  if (ok) audit(req, 'image_lib_delete', '#' + req.params.id);
  back(req, res, ok ? 'success' : 'error', ok ? 'Đã xóa khỏi thư viện' : 'Không tìm thấy', libUrl(a.game, a.kind));
});

module.exports = router;
