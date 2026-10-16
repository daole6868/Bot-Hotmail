'use strict';
/** Kinh doanh -> Nguồn hàng API (/admin/api-shop): kết nối web nguồn, chọn sản phẩm bán, giá, đơn hàng API. Chỉ admin. */
const express = require('express');
const { db, logActivity } = require('../db');
const H = require('../utils/helpers');
const ap = require('../services/apishop');

const router = express.Router();
const { toInt, str, clientIp } = H;
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const back = (req, res, type, msg, url) => { if (msg) req.flash(type, msg); res.redirect(url || '/admin/api-shop'); };

router.get('/', (req, res) => {
  const c = ap.cfg();
  const cats = db.prepare('SELECT * FROM api_cats ORDER BY sort_order, CAST(src_id AS INTEGER), src_id').all();
  const q = str(req.query.q, 60).trim().toLowerCase();
  const show = ['on', 'off', 'stock'].includes(req.query.show) ? req.query.show : '';
  const prods = db.prepare('SELECT * FROM api_products ORDER BY sort_order, CAST(src_id AS INTEGER)').all()
    .filter((p) => (!q || [p.name, p.title, p.description, p.src_id].some((x) => String(x || '').toLowerCase().includes(q)))
      && (show !== 'on' || p.is_active) && (show !== 'off' || !p.is_active) && (show !== 'stock' || (p.stock > 0 && !p.removed)));
  const groups = cats.map((cat) => ({ cat, items: prods.filter((p) => p.cat_src_id === cat.src_id) })).filter((g) => g.items.length || (!q && !show));
  const counts = db.prepare('SELECT COUNT(*) total, SUM(is_active) active, SUM(CASE WHEN removed = 0 AND stock > 0 THEN 1 ELSE 0 END) instock FROM api_products').get();
  res.render('admin/apishop', {
    title: 'Nguồn hàng API', UI: ap.UI, c, key: ap.maskKey(c), game: ap.gameOf(c), apiGames: db.prepare("SELECT id, name FROM games WHERE kind = 'api' ORDER BY id").all(),
    groups, counts, q, show, sync: ap.syncInfo(), priceOf: (p) => ap.priceOf(p, c), losing: ap.losing,
    checking: db.prepare("SELECT COUNT(*) c FROM api_orders WHERE status = 'checking'").get().c,
  });
});

router.post('/settings', (req, res) => {
  const b = req.body;
  const patch = { markup: toInt(b.markup, 30, 0, 1000), low: toInt(b.low, 0, 0, 1e10) };
  const url = str(b.url, 200).trim().replace(/\/+$/, '');
  if (url) {
    if (!/^https:\/\/[\w.-]+(:\d+)?$/i.test(url)) return back(req, res, 'error', 'Địa chỉ web nguồn phải dạng https://ten-mien.com');
    patch.url = url;
  }
  ap.saveCfg(patch);
  if (b.remove_key) ap.setKey('');
  else if (str(b.api_key, 300).trim()) ap.setKey(str(b.api_key, 300).trim());
  audit(req, 'apishop_settings', `lãi ${patch.markup}%, cảnh báo ${patch.low}${b.api_key ? ', đổi API key' : ''}${b.remove_key ? ', gỡ API key' : ''}`);
  back(req, res, 'success', 'Đã lưu cài đặt nguồn hàng');
});

router.post('/ui', (req, res) => {
  const b = req.body;
  if (b.reset) ap.saveCfg({ ui: {}, keepDays: ap.DEFAULTS.keepDays });
  else ap.saveCfg({ keepDays: toInt(b.keepDays, ap.DEFAULTS.keepDays, 0, 3650), ui: { namePc: b.namePc, nameMb: b.nameMb, descPc: b.descPc, descMb: b.descMb, lh: b.lh } });
  require('./public').clearCache();
  audit(req, 'apishop_ui', b.reset ? 'khôi phục mặc định' : `lưu ${toInt(b.keepDays, 0, 0, 3650)} ngày`);
  back(req, res, 'success', b.reset ? 'Đã khôi phục mặc định' : 'Đã lưu giao diện & thời gian lưu đơn');
});

router.post('/test', async (req, res) => {
  try { const p = await ap.profile(); res.json({ ok: true, username: p.username, money: p.money }); } catch (e) { res.json({ ok: false, message: e.message }); }
});

router.post('/sync', async (req, res) => {
  try {
    const r = await ap.sync();
    audit(req, 'apishop_sync', `${r.cats} chuyên mục, ${r.n} sản phẩm`);
    back(req, res, 'success', `Đã đồng bộ ${r.cats} chuyên mục, ${r.n} sản phẩm`);
  } catch (e) { back(req, res, 'error', 'Không đồng bộ được: ' + e.message); }
});

// Mục hiển thị trên web (cùng cấp game): tạo mới hoặc chọn mục có sẵn
router.post('/game', (req, res) => {
  const b = req.body;
  if (b.game_id) {
    const g = db.prepare("SELECT id FROM games WHERE id = ? AND kind = 'api'").get(toInt(b.game_id));
    if (!g) return back(req, res, 'error', 'Không tìm thấy mục');
    ap.saveCfg({ gameId: g.id });
    return back(req, res, 'success', 'Đã chọn mục hiển thị');
  }
  const name = str(b.name, 80).trim() || 'Mail số lượng lớn';
  let slug = H.slugify(name) || 'hang-api';
  for (let i = 2; db.prepare('SELECT 1 FROM games WHERE slug = ?').get(slug); i++) slug = H.slugify(name) + '-' + i;
  const next = (db.prepare('SELECT MAX(sort_order) m FROM games').get().m || 0) + 1;
  const id = db.prepare("INSERT INTO games(name, slug, color, is_active, sort_order, kind) VALUES(?,?,?,1,?,'api')").run(name, slug, '#0ea5e9', next).lastInsertRowid;
  ap.saveCfg({ gameId: Number(id) });
  req.app.locals.clearNav && req.app.locals.clearNav();
  require('./public').clearCache();
  audit(req, 'apishop_game', `tạo mục "${name}"`);
  back(req, res, 'success', `Đã tạo mục "${name}". Đổi tên, ảnh, thứ tự ở Sản phẩm → Game.`);
});

router.post('/cats/:src', (req, res) => {
  const b = req.body;
  const cat = db.prepare('SELECT * FROM api_cats WHERE src_id = ?').get(String(req.params.src));
  if (!cat) return res.json({ ok: false, message: 'Không tìm thấy' });
  db.prepare('UPDATE api_cats SET title = ?, is_active = ?, sort_order = ? WHERE src_id = ?')
    .run(str(b.title, 120).trim() || null, b.is_active ? 1 : 0, toInt(b.sort_order, 0, -9999, 9999), cat.src_id);
  require('./public').clearCache();
  res.json({ ok: true });
});

router.post('/products/:id', (req, res) => {
  const b = req.body;
  const p = db.prepare('SELECT * FROM api_products WHERE id = ?').get(toInt(req.params.id));
  if (!p) return res.json({ ok: false, message: 'Không tìm thấy' });
  const price = String(b.price ?? '').trim() === '' ? null : toInt(b.price, 0, 0, 1e9) || null;
  const on = b.is_active ? 1 : 0;
  if (on && price != null && price < p.cost) return res.json({ ok: false, message: `Giá bán thấp hơn giá vốn (${H.money(Math.ceil(p.cost))}) — sẽ bán lỗ` });
  db.prepare('UPDATE api_products SET title = ?, price = ?, is_active = ?, sort_order = ?, paused = CASE WHEN ? THEN NULL ELSE paused END WHERE id = ?')
    .run(str(b.title, 200).trim() || null, price, on, toInt(b.sort_order, 0, -9999, 9999), on, p.id);
  require('./public').clearCache();
  const np = db.prepare('SELECT * FROM api_products WHERE id = ?').get(p.id);
  res.json({ ok: true, price: ap.priceOf(np) });
});

router.post('/products-bulk', (req, res) => {
  const act = req.body.act;
  if (act === 'on-stock') db.prepare('UPDATE api_products SET is_active = 1, paused = NULL WHERE removed = 0 AND stock > 0 AND (price IS NULL OR price >= cost)').run();
  else if (act === 'off-all') db.prepare('UPDATE api_products SET is_active = 0').run();
  else if (act === 'reset-price') db.prepare('UPDATE api_products SET price = NULL').run();
  else return back(req, res, 'error', 'Thao tác không hợp lệ');
  require('./public').clearCache();
  audit(req, 'apishop_bulk', act);
  back(req, res, 'success', 'Đã cập nhật');
});

// ---------- Đơn hàng API ----------
const STATUS = { processing: 'Đang xử lý', completed: 'Hoàn thành', refunded: 'Đã hoàn tiền', checking: 'Chờ kiểm tra' };
router.get('/orders', (req, res) => {
  const where = []; const params = [];
  const status = STATUS[req.query.status] ? req.query.status : '';
  const q = str(req.query.q, 60).trim();
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (q) { where.push('(o.code LIKE ? OR o.trans_id LIKE ? OR u.username LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const result = H.paginate(db, {
    select: 'o.*, u.username', from: 'api_orders o JOIN users u ON u.id = o.user_id',
    where: where.length ? 'WHERE ' + where.join(' AND ') : '', params, order: 'ORDER BY o.id DESC', page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  res.render('admin/apishop-orders', { title: 'Đơn hàng API', result, STATUS, status, q, query: req.query });
});

const orderOf = (id) => db.prepare('SELECT o.*, u.username FROM api_orders o JOIN users u ON u.id = o.user_id WHERE o.id = ?').get(id);
router.get('/orders/:id', (req, res, next) => {
  const o = orderOf(toInt(req.params.id));
  if (!o) return next();
  const data = ap.dataOf(o);
  const lines = data ? data.split('\n') : [];
  res.render('admin/apishop-order', { title: 'Đơn ' + o.code, o, STATUS, preview: lines.slice(0, 200), lineCount: lines.length });
});
router.get('/orders/:id/data.txt', (req, res, next) => {
  const o = orderOf(toInt(req.params.id));
  if (!o) return next();
  audit(req, 'apishop_data_view', o.code);
  const mp = req.query.type === 'mp';
  res.type('text/plain; charset=utf-8').attachment(`${o.code}${mp ? '-mail-pass' : ''}.txt`).send(mp ? ap.mailPass(ap.dataOf(o), o.fmt) : ap.dataOf(o));
});
router.post('/orders/:id/refund', (req, res) => {
  const r = ap.adminRefund(toInt(req.params.id), req.user.id, str(req.body.reason, 200).trim() || 'Admin hoàn tiền');
  back(req, res, r.ok ? 'success' : 'error', r.ok ? 'Đã hoàn tiền cho khách' : r.message, '/admin/api-shop/orders/' + toInt(req.params.id));
});
router.post('/orders/:id/deliver', (req, res) => {
  const r = ap.adminDeliver(toInt(req.params.id), req.user.id, String(req.body.data || '').slice(0, 5e6));
  back(req, res, r.ok ? 'success' : 'error', r.ok ? 'Đã giao hàng cho khách' : r.message, '/admin/api-shop/orders/' + toInt(req.params.id));
});

module.exports = router;
