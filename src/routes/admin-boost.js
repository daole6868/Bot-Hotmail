'use strict';
/**
 * Admin -> Cày thuê: danh mục & gói (theo game), đơn cày thuê (đổi trạng thái, hoàn tiền), cài đặt hiển thị.
 * Gắn vào /admin/boost (đã qua requireAdmin + CSRF + bộ nhận ảnh của router admin).
 */
const express = require('express');
const { db, getSettings, setSetting, logActivity } = require('../db');
const { saveImage, removeImage } = require('../utils/upload');
const { randomCode } = require('../utils/crypto');
const { BOOST_ICONS } = require('../utils/icons');
const H = require('../utils/helpers');
const boost = require('../services/boost');

const { paginate, toInt, str, bool, clientIp } = H;
const router = express.Router();

const fileOf = (req, field) => (req.files || []).find((f) => f.fieldname === field);
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const safeBack = (req) => { const b = String(req.body?._back || ''); return /^\/admin(\/|\?|$)/.test(b) ? b : null; };
const back = (req, res, type, msg, url) => { if (msg) req.flash(type, msg); res.redirect(safeBack(req) || url || req.get('referer') || '/admin/boost'); };
const modal = (res, view, data) => res.render('admin/modals/' + view, data);
const color = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : d);
const icon = (v, d) => (BOOST_ICONS.includes(v) ? v : d);

// Lưu ảnh tải lên (hoặc xóa ảnh cũ) -> đường dẫn ảnh mới; null khi file lỗi
function imageFrom(req, old, folder) {
  const f = fileOf(req, 'image');
  if (f) {
    const saved = saveImage(f, folder);
    if (!saved) return undefined;
    if (old?.image) removeImage(old.image);
    return saved;
  }
  if (old && req.body.remove_image) { removeImage(old.image); return null; }
  return old?.image || null;
}

// ======================= DANH MỤC & GÓI =======================
router.get('/', (req, res) => {
  const games = db.prepare('SELECT id, name, image, color, is_active FROM games ORDER BY sort_order, id').all();
  const cats = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM boost_packages p WHERE p.category_id = c.id) AS pkg_count,
      (SELECT MIN(price) FROM boost_packages p WHERE p.category_id = c.id AND p.is_active = 1) AS min_price,
      (SELECT COALESCE(SUM(sold_count), 0) FROM boost_packages p WHERE p.category_id = c.id) AS sold
    FROM boost_categories c ORDER BY c.sort_order, c.id`).all();
  games.forEach((g) => { g.cats = cats.filter((c) => c.game_id === g.id); });
  res.render('admin/boost', { title: 'Cày thuê – Danh mục & gói', games });
});

router.get('/categories/form', (req, res) => {
  const c = req.query.id ? db.prepare('SELECT * FROM boost_categories WHERE id = ?').get(toInt(req.query.id)) : null;
  const games = db.prepare('SELECT id, name FROM games ORDER BY sort_order, id').all();
  modal(res, 'boost-category-form', { c, games, gameId: c ? c.game_id : toInt(req.query.game_id), icons: BOOST_ICONS });
});

router.post('/categories/save', (req, res) => {
  const id = toInt(req.body.id);
  const gameId = toInt(req.body.game_id);
  const name = str(req.body.name, 100);
  if (!name || !db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) return back(req, res, 'error', 'Thiếu tên hoặc game');
  let slug = H.slugify(req.body.slug || name);
  if (db.prepare('SELECT id FROM boost_categories WHERE game_id = ? AND slug = ? AND id != ?').get(gameId, slug, id)) slug += '-' + randomCode(3).toLowerCase();
  const old = id ? db.prepare('SELECT * FROM boost_categories WHERE id = ?').get(id) : null;
  if (id && !old) return back(req, res, 'error', 'Không tìm thấy');
  const image = imageFrom(req, old, 'boost');
  if (image === undefined) return back(req, res, 'error', 'File ảnh không hợp lệ');
  const data = [gameId, name, slug, image, icon(req.body.icon, 'g-sword'), color(req.body.icon_color, '#8b5cf6'), str(req.body.description, 1000), bool(req.body.is_active)];
  if (old) db.prepare('UPDATE boost_categories SET game_id=?, name=?, slug=?, image=?, icon=?, icon_color=?, description=?, is_active=? WHERE id=?').run(...data, id);
  else {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM boost_categories WHERE game_id = ?').get(gameId).n;
    db.prepare('INSERT INTO boost_categories(game_id, name, slug, image, icon, icon_color, description, is_active, sort_order) VALUES(?,?,?,?,?,?,?,?,?)').run(...data, next);
  }
  audit(req, old ? 'boost_cat_update' : 'boost_cat_create', name);
  back(req, res, 'success', old ? 'Đã cập nhật danh mục cày thuê' : 'Đã thêm danh mục cày thuê', '/admin/boost');
});

router.post('/categories/:id/delete', (req, res) => {
  const c = db.prepare('SELECT * FROM boost_categories WHERE id = ?').get(toInt(req.params.id));
  if (!c) return back(req, res, 'error', 'Không tìm thấy');
  const used = db.prepare('SELECT COUNT(*) n FROM boost_order_items i JOIN boost_packages p ON p.id = i.package_id WHERE p.category_id = ?').get(c.id).n;
  if (used) return back(req, res, 'error', `Danh mục đã có ${used} lượt thuê. Hãy tắt hiển thị thay vì xóa.`);
  const imgs = db.prepare('SELECT image FROM boost_packages WHERE category_id = ?').all(c.id);
  db.prepare('DELETE FROM boost_categories WHERE id = ?').run(c.id);
  imgs.forEach((r) => removeImage(r.image));
  removeImage(c.image);
  audit(req, 'boost_cat_delete', c.name);
  back(req, res, 'success', 'Đã xóa danh mục', '/admin/boost');
});

// Gói trong 1 danh mục
router.get('/categories/:id', (req, res, next) => {
  const c = db.prepare('SELECT c.*, g.name AS game_name, g.slug AS game_slug FROM boost_categories c JOIN games g ON g.id = c.game_id WHERE c.id = ?').get(toInt(req.params.id));
  if (!c) return next();
  const packages = db.prepare('SELECT * FROM boost_packages WHERE category_id = ? ORDER BY sort_order, id').all(c.id);
  res.render('admin/boost-packages', { title: `Gói – ${c.name}`, c, packages });
});

router.get('/packages/form', (req, res) => {
  const p = req.query.id ? db.prepare('SELECT * FROM boost_packages WHERE id = ?').get(toInt(req.query.id)) : null;
  const categories = db.prepare('SELECT c.id, c.name, g.name AS game_name FROM boost_categories c JOIN games g ON g.id = c.game_id ORDER BY g.sort_order, c.sort_order, c.id').all();
  modal(res, 'boost-package-form', { p, categories, catId: p ? p.category_id : toInt(req.query.category_id), icons: BOOST_ICONS });
});

router.post('/packages/save', (req, res) => {
  const id = toInt(req.body.id);
  const catId = toInt(req.body.category_id);
  const name = str(req.body.name, 150);
  const price = toInt(req.body.price, 0, 0);
  if (!name || !db.prepare('SELECT 1 FROM boost_categories WHERE id = ?').get(catId)) return back(req, res, 'error', 'Thiếu tên hoặc danh mục');
  if (price < 1000) return back(req, res, 'error', 'Giá tối thiểu 1.000đ');
  const minQ = toInt(req.body.min_qty, 1, 1, 1000), maxQ = toInt(req.body.max_qty, 10, 1, 1000);
  if (maxQ < minQ) return back(req, res, 'error', 'Số lượng tối đa phải ≥ tối thiểu');
  const old = id ? db.prepare('SELECT * FROM boost_packages WHERE id = ?').get(id) : null;
  if (id && !old) return back(req, res, 'error', 'Không tìm thấy');
  const image = imageFrom(req, old, 'boost');
  if (image === undefined) return back(req, res, 'error', 'File ảnh không hợp lệ');
  const oldPrice = toInt(req.body.old_price, 0, 0) || null;
  const data = [catId, name, price, oldPrice && oldPrice > price ? oldPrice : null, image, icon(req.body.icon, 'star'), color(req.body.icon_color, '#f59e0b'),
    str(req.body.description, 2000), str(req.body.unit, 20) || 'gói', minQ, maxQ, str(req.body.eta, 60) || null, bool(req.body.is_paused), bool(req.body.is_active)];
  if (old) db.prepare('UPDATE boost_packages SET category_id=?, name=?, price=?, old_price=?, image=?, icon=?, icon_color=?, description=?, unit=?, min_qty=?, max_qty=?, eta=?, is_paused=?, is_active=? WHERE id=?').run(...data, id);
  else {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM boost_packages WHERE category_id = ?').get(catId).n;
    db.prepare('INSERT INTO boost_packages(category_id, name, price, old_price, image, icon, icon_color, description, unit, min_qty, max_qty, eta, is_paused, is_active, sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...data, next);
  }
  audit(req, old ? 'boost_pkg_update' : 'boost_pkg_create', `${name} ${price}`);
  back(req, res, 'success', old ? 'Đã cập nhật gói' : 'Đã thêm gói', '/admin/boost/categories/' + catId);
});

router.post('/packages/:id/pause', (req, res) => {
  const id = toInt(req.params.id);
  const r = db.prepare('UPDATE boost_packages SET is_paused = 1 - is_paused WHERE id = ?').run(id);
  const on = r.changes ? !!db.prepare('SELECT is_paused FROM boost_packages WHERE id = ?').get(id).is_paused : false;
  if (r.changes) audit(req, 'boost_pkg_pause', `${id} -> ${on ? 'tạm ngưng' : 'mở lại'}`);
  if (req.get('x-csrf-token')) return res.json({ ok: !!r.changes, active: !on }); // active = đang nhận đơn
  back(req, res, r.changes ? 'success' : 'error', r.changes ? (on ? 'Đã tạm ngưng nhận đơn gói này' : 'Đã mở lại gói') : 'Không tìm thấy', '/admin/boost');
});

router.post('/packages/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM boost_packages WHERE id = ?').get(toInt(req.params.id));
  if (!p) return back(req, res, 'error', 'Không tìm thấy');
  if (p.sold_count || db.prepare('SELECT 1 FROM boost_order_items WHERE package_id = ? LIMIT 1').get(p.id)) return back(req, res, 'error', 'Gói đã có người thuê. Hãy tắt hiển thị thay vì xóa.', '/admin/boost/categories/' + p.category_id);
  db.prepare('DELETE FROM boost_packages WHERE id = ?').run(p.id);
  removeImage(p.image);
  audit(req, 'boost_pkg_delete', p.name);
  back(req, res, 'success', 'Đã xóa gói', '/admin/boost/categories/' + p.category_id);
});

// ======================= ĐƠN CÀY THUÊ =======================
function orderFilters(req) {
  const q = { status: boost.STATUS[req.query.status] ? req.query.status : (req.query.status === 'open' ? 'open' : ''), q: str(req.query.q, 60), game: toInt(req.query.game, 0) };
  const where = []; const params = [];
  if (q.status === 'open') where.push("o.status IN ('received','processing','need_info')");
  else if (q.status) { where.push('o.status = ?'); params.push(q.status); }
  if (q.game) { where.push('o.game_id = ?'); params.push(q.game); }
  if (q.q) { where.push('(o.code LIKE ? OR u.username LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  return { q, where: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}
router.get('/orders', (req, res) => {
  const f = orderFilters(req);
  const result = paginate(db, {
    select: 'o.id, o.code, o.game_name, o.total, o.status, o.created_at, o.updated_at, u.username, (SELECT GROUP_CONCAT(name || \' ×\' || qty, \', \') FROM boost_order_items i WHERE i.order_id = o.id) AS items',
    from: 'boost_orders o LEFT JOIN users u ON u.id = o.user_id', where: f.where, params: f.params,
    order: 'ORDER BY o.id DESC', page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM boost_orders GROUP BY status').all().map((r) => [r.status, r.n]));
  res.render('admin/boost-orders', {
    title: 'Đơn cày thuê', result, query: f.q, counts, STATUS: boost.STATUS,
    games: db.prepare('SELECT id, name FROM games ORDER BY sort_order, id').all(),
  });
});

const orderById = (id) => db.prepare('SELECT o.*, u.username, u.email, u.balance FROM boost_orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?').get(id);
router.get('/orders/:id', (req, res, next) => {
  const o = orderById(toInt(req.params.id));
  if (!o) return next();
  res.set('Cache-Control', 'no-store');
  res.render('admin/boost-order', {
    title: 'Đơn cày thuê ' + o.code, o, STATUS: boost.STATUS,
    items: db.prepare('SELECT * FROM boost_order_items WHERE order_id = ? ORDER BY id').all(o.id),
    events: db.prepare('SELECT * FROM boost_order_events WHERE order_id = ? ORDER BY id DESC').all(o.id),
  });
});

// Xem tài khoản / mật khẩu game của khách (ghi nhật ký mỗi lần xem)
router.post('/orders/:id/login', (req, res) => {
  const o = orderById(toInt(req.params.id));
  if (!o) return res.json({ ok: false, message: 'Không tìm thấy đơn' });
  const l = boost.readLogin(o);
  if (!l) return res.json({ ok: false, message: o.login_wiped_at ? 'Thông tin đăng nhập đã được tự xóa' : 'Không có thông tin đăng nhập' });
  audit(req, 'boost_login_view', o.code);
  res.json({ ok: true, account: l.u, password: l.p });
});

router.post('/orders/:id/status', (req, res) => {
  const id = toInt(req.params.id);
  const status = String(req.body.status || '');
  const msg = str(req.body.message, 1000);
  if (status === 'need_info' && !msg) return back(req, res, 'error', 'Hãy ghi rõ khách cần bổ sung thông tin gì', '/admin/boost/orders/' + id);
  const r = boost.setStatus(id, status, msg, req.user.id);
  back(req, res, r.ok ? 'success' : 'error', r.ok ? (status === 'cancelled' ? 'Đã hủy đơn và hoàn tiền cho khách' : 'Đã cập nhật trạng thái, khách sẽ thấy ngay') : r.message, '/admin/boost/orders/' + id);
});

router.post('/orders/:id/note', (req, res) => {
  const id = toInt(req.params.id);
  db.prepare('UPDATE boost_orders SET admin_note = ? WHERE id = ?').run(str(req.body.admin_note, 2000) || null, id);
  back(req, res, 'success', 'Đã lưu ghi chú nội bộ', '/admin/boost/orders/' + id);
});

// ======================= CÀI ĐẶT =======================
router.get('/settings', (req, res) => res.render('admin/boost-settings', { title: 'Cài đặt cày thuê', s: getSettings() }));

router.post('/settings', (req, res) => {
  const b = req.body;
  for (const lv of ['cat', 'pkg']) {
    setSetting(`boost_${lv}_mode`, b[`${lv}_mode`] === 'icon' ? 'icon' : 'image');
    setSetting(`boost_${lv}_cols_pc`, String(toInt(b[`${lv}_cols_pc`], 4, 1, 6)));
    setSetting(`boost_${lv}_cols_m`, String(toInt(b[`${lv}_cols_m`], 2, 1, 3)));
    setSetting(`boost_${lv}_max`, String(toInt(b[`${lv}_max`], 12, 1, 200)));
  }
  setSetting('boost_cart_hours', String(toInt(b.cart_hours, 24, 1, 720)));
  setSetting('boost_max_open', String(toInt(b.max_open, 5, 1, 100)));
  setSetting('boost_wipe_days', String(toInt(b.wipe_days, 7, 1, 365)));
  setSetting('boost_self_cancel', bool(b.self_cancel) ? '1' : '0');
  setSetting('boost_tg_notify', bool(b.tg_notify) ? '1' : '0');
  setSetting('mail_on_boost', bool(b.mail_on_boost) ? '1' : '0');
  setSetting('boost_tile_title', str(b.tile_title, 60) || 'Cày thuê');
  setSetting('boost_tile_desc', str(b.tile_desc, 300));
  setSetting('boost_terms', str(b.terms, 5000));
  const s = getSettings();
  const f = fileOf(req, 'tile_image');
  if (f) {
    const saved = saveImage(f, 'boost');
    if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ', '/admin/boost/settings');
    if (s.boost_tile_image) removeImage(s.boost_tile_image);
    setSetting('boost_tile_image', saved);
  } else if (b.remove_tile_image && s.boost_tile_image) {
    removeImage(s.boost_tile_image);
    setSetting('boost_tile_image', '');
  }
  audit(req, 'boost_settings', '');
  back(req, res, 'success', 'Đã lưu cài đặt cày thuê', '/admin/boost/settings');
});

module.exports = router;
