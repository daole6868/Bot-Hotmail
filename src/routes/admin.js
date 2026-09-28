'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, getSettings, setSetting, logActivity, vnDay } = require('../db');
const { requireAdmin, verifyCsrf, blockIp, unblockIp } = require('../middleware/security');
const { upload, saveImage, removeImage } = require('../utils/upload');
const { encrypt, decrypt, sha256, randomCode } = require('../utils/crypto');
const H = require('../utils/helpers');
const { refund } = require('../services/order');
const { completeDeposit, cancelDeposit } = require('../services/deposit');
const maintenance = require('../services/maintenance');
const SQLiteStore = require('../session-store');
const publicRouter = require('./public');
const config = require('../config');

const { paginate, toInt, str, bool, clientIp } = H;
const router = express.Router();

router.use(requireAdmin);
router.use((req, res, next) => {
  res.locals.layoutAdmin = true;
  res.locals.path = req.path;
  res.locals.adminBadges = {
    deposits: db.prepare("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'").get().c,
    bank: db.prepare("SELECT COUNT(*) c FROM bank_transactions WHERE status = 'unmatched'").get().c,
  };
  next();
});

// Multipart (upload ảnh): parse rồi kiểm tra CSRF
router.use((req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  upload.any()(req, res, (err) => {
    if (err) {
      req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 4MB' : err.message);
      return res.redirect(req.get('referer') || '/admin');
    }
    if (!verifyCsrf(req)) return res.status(403).render('errors/error', { code: 403, message: 'CSRF token không hợp lệ' });
    next();
  });
});

// Mọi thay đổi dữ liệu -> xóa cache trang chủ
router.use((req, res, next) => {
  if (req.method === 'POST') { publicRouter.clearCache(); req.app.locals.clearNav?.(); }
  next();
});

const fileOf = (req, field) => (req.files || []).find((f) => f.fieldname === field);
const filesOf = (req, field) => (req.files || []).filter((f) => f.fieldname === field);
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const back = (req, res, type, msg, url) => { if (msg) req.flash(type, msg); res.redirect(url || req.get('referer') || '/admin'); };

// ======================= DASHBOARD =======================
router.get('/', (req, res) => {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(vnDay(Date.now() - i * 86400000));
  const statRows = db.prepare('SELECT * FROM daily_stats WHERE day >= ?').all(days[0]);
  const map = Object.fromEntries(statRows.map((r) => [r.day, r]));
  const series = days.map((d) => ({ day: d, ...(map[d] || { revenue: 0, orders: 0, deposits: 0, new_users: 0, refunds: 0 }) }));
  const sum = (arr, k) => arr.reduce((a, b) => a + (b[k] || 0), 0);
  const today = series[series.length - 1];
  const last7 = series.slice(-7);
  const totals = db.prepare('SELECT COALESCE(SUM(revenue),0) revenue, COALESCE(SUM(deposits),0) deposits, COALESCE(SUM(orders),0) orders FROM daily_stats').get();

  res.render('admin/dashboard', {
    title: 'Tổng quan',
    today, series,
    week: { revenue: sum(last7, 'revenue'), orders: sum(last7, 'orders'), deposits: sum(last7, 'deposits') },
    month: { revenue: sum(series, 'revenue'), orders: sum(series, 'orders'), deposits: sum(series, 'deposits'), users: sum(series, 'new_users') },
    totals,
    counts: {
      users: db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'user'").get().c,
      balance: db.prepare('SELECT COALESCE(SUM(balance),0) c FROM users').get().c,
      available: db.prepare("SELECT COUNT(*) c FROM products WHERE status = 'available'").get().c,
      sold: db.prepare("SELECT COUNT(*) c FROM products WHERE status = 'sold'").get().c,
      games: db.prepare('SELECT COUNT(*) c FROM games').get().c,
    },
    lowStock: db.prepare(`SELECT p.id, p.title, (SELECT COUNT(*) FROM product_stock s WHERE s.product_id = p.id AND s.is_sold = 0) AS left_count
      FROM products p WHERE p.type = 'stock' AND p.status = 'available' AND left_count < 3 ORDER BY left_count LIMIT 10`).all(),
    recentOrders: db.prepare('SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 8').all(),
    pendingDeposits: db.prepare("SELECT d.*, u.username FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'pending' ORDER BY d.id DESC LIMIT 8").all(),
  });
});

// ======================= GAME (CẤP 1) =======================
router.get('/games', (req, res) => {
  const games = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM categories c WHERE c.game_id = g.id) AS cat_count,
    (SELECT COUNT(*) FROM products p JOIN categories c ON c.id = p.category_id WHERE c.game_id = g.id) AS product_count
    FROM games g ORDER BY g.sort_order, g.id`).all();
  const edit = req.query.edit ? db.prepare('SELECT * FROM games WHERE id = ?').get(toInt(req.query.edit)) : null;
  res.render('admin/games', { title: 'Danh mục game', games, edit });
});

router.post('/games/save', (req, res) => {
  const id = toInt(req.body.id);
  const name = str(req.body.name, 100);
  if (!name) return back(req, res, 'error', 'Tên game không được trống');
  let slug = H.slugify(req.body.slug || name);
  if (db.prepare('SELECT id FROM games WHERE slug = ? AND id != ?').get(slug, id)) slug += '-' + randomCode(3).toLowerCase();
  const old = id ? db.prepare('SELECT * FROM games WHERE id = ?').get(id) : null;
  let image = old?.image || null;
  const f = fileOf(req, 'image');
  if (f) {
    const saved = saveImage(f, 'games');
    if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ');
    if (old?.image) removeImage(old.image);
    image = saved;
  }
  const data = [name, slug, image, str(req.body.description, 1000), str(req.body.color, 20) || '#6d28d9',
    toInt(req.body.sort_order), bool(req.body.is_active), bool(req.body.is_hot)];
  if (old) {
    db.prepare('UPDATE games SET name=?, slug=?, image=?, description=?, color=?, sort_order=?, is_active=?, is_hot=? WHERE id=?').run(...data, id);
    audit(req, 'game_update', name);
  } else {
    db.prepare('INSERT INTO games(name, slug, image, description, color, sort_order, is_active, is_hot) VALUES(?,?,?,?,?,?,?,?)').run(...data);
    audit(req, 'game_create', name);
  }
  back(req, res, 'success', 'Đã lưu game', '/admin/games');
});

router.post('/games/:id/delete', (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(toInt(req.params.id));
  if (!g) return back(req, res, 'error', 'Không tìm thấy');
  const sold = db.prepare("SELECT COUNT(*) c FROM products p JOIN categories c ON c.id = p.category_id WHERE c.game_id = ? AND p.status = 'sold'").get(g.id).c;
  if (sold && req.body.force !== '1') return back(req, res, 'error', `Game có ${sold} sản phẩm đã bán. Hãy ẩn game thay vì xóa.`);
  db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
  removeImage(g.image);
  audit(req, 'game_delete', g.name);
  back(req, res, 'success', 'Đã xóa game', '/admin/games');
});

// ======================= DANH MỤC CON (CẤP 2) =======================
router.get('/categories', (req, res) => {
  const games = db.prepare('SELECT id, name FROM games ORDER BY sort_order, id').all();
  const gameId = toInt(req.query.game_id, 0);
  const cats = db.prepare(`SELECT c.*, g.name AS game_name,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'available') AS available_count
    FROM categories c JOIN games g ON g.id = c.game_id ${gameId ? 'WHERE c.game_id = ?' : ''} ORDER BY g.sort_order, c.sort_order, c.id`)
    .all(...(gameId ? [gameId] : []));
  const edit = req.query.edit ? db.prepare('SELECT * FROM categories WHERE id = ?').get(toInt(req.query.edit)) : null;
  res.render('admin/categories', { title: 'Danh mục con', games, cats, gameId, edit });
});

router.post('/categories/save', (req, res) => {
  const id = toInt(req.body.id);
  const gameId = toInt(req.body.game_id);
  const name = str(req.body.name, 100);
  if (!name || !db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) return back(req, res, 'error', 'Thiếu tên hoặc game');
  let slug = H.slugify(req.body.slug || name);
  if (db.prepare('SELECT id FROM categories WHERE game_id = ? AND slug = ? AND id != ?').get(gameId, slug, id)) slug += '-' + randomCode(3).toLowerCase();
  const old = id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(id) : null;
  let image = old?.image || null;
  const f = fileOf(req, 'image');
  if (f) {
    const saved = saveImage(f, 'categories');
    if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ');
    if (old?.image) removeImage(old.image);
    image = saved;
  }
  const data = [gameId, name, slug, image, str(req.body.description, 1000), toInt(req.body.sort_order), bool(req.body.is_active)];
  if (old) db.prepare('UPDATE categories SET game_id=?, name=?, slug=?, image=?, description=?, sort_order=?, is_active=? WHERE id=?').run(...data, id);
  else db.prepare('INSERT INTO categories(game_id, name, slug, image, description, sort_order, is_active) VALUES(?,?,?,?,?,?,?)').run(...data);
  audit(req, old ? 'category_update' : 'category_create', name);
  back(req, res, 'success', 'Đã lưu danh mục', '/admin/categories?game_id=' + gameId);
});

router.post('/categories/:id/delete', (req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(toInt(req.params.id));
  if (!c) return back(req, res, 'error', 'Không tìm thấy');
  const sold = db.prepare("SELECT COUNT(*) n FROM products WHERE category_id = ? AND status = 'sold'").get(c.id).n;
  if (sold) return back(req, res, 'error', `Danh mục có ${sold} sản phẩm đã bán. Hãy ẩn thay vì xóa.`);
  db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
  removeImage(c.image);
  audit(req, 'category_delete', c.name);
  back(req, res, 'success', 'Đã xóa danh mục');
});

// ======================= SẢN PHẨM (CẤP 3) =======================
function categoryOptions() {
  return db.prepare('SELECT c.id, c.name, g.name AS game_name FROM categories c JOIN games g ON g.id = c.game_id ORDER BY g.sort_order, c.sort_order').all();
}

router.get('/products', (req, res) => {
  const q = {
    q: str(req.query.q, 60), category_id: toInt(req.query.category_id, 0),
    status: ['available', 'sold', 'hidden'].includes(req.query.status) ? req.query.status : '',
    type: ['account', 'stock'].includes(req.query.type) ? req.query.type : '',
  };
  const where = [];
  const params = [];
  if (q.q) { where.push('(p.title LIKE ? OR p.code LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.category_id) { where.push('p.category_id = ?'); params.push(q.category_id); }
  if (q.status) { where.push('p.status = ?'); params.push(q.status); }
  if (q.type) { where.push('p.type = ?'); params.push(q.type); }
  const result = paginate(db, {
    select: `p.*, c.name AS category_name, g.name AS game_name,
      (SELECT COUNT(*) FROM product_stock s WHERE s.product_id = p.id AND s.is_sold = 0) AS stock_left`,
    from: 'products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id',
    where: where.length ? 'WHERE ' + where.join(' AND ') : '', params,
    order: 'ORDER BY p.id DESC', page: toInt(req.query.page, 1, 1), perPage: 25,
  });
  res.render('admin/products', { title: 'Sản phẩm', result, query: q, categories: categoryOptions() });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', {
    title: 'Thêm sản phẩm', p: { type: 'account', status: 'available', attrList: [], imageList: [], category_id: toInt(req.query.category_id) },
    categories: categoryOptions(), stock: null,
  });
});

router.get('/products/:id/edit', (req, res, next) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(toInt(req.params.id));
  if (!p) return next();
  p.attrList = H.parseJSON(p.attributes, []);
  p.imageList = H.parseJSON(p.images, []);
  p.credentials = decrypt(p.credentials_enc);
  let stock = null;
  if (p.type === 'stock') {
    stock = paginate(db, {
      select: 'id, data_enc, is_sold, order_id, created_at', from: 'product_stock', where: 'WHERE product_id = ?', params: [p.id],
      order: 'ORDER BY is_sold, id DESC', page: toInt(req.query.page, 1, 1), perPage: 50,
    });
    stock.rows.forEach((s) => { s.data = decrypt(s.data_enc); });
    stock.left = db.prepare('SELECT COUNT(*) c FROM product_stock WHERE product_id = ? AND is_sold = 0').get(p.id).c;
  }
  res.render('admin/product-form', { title: 'Sửa sản phẩm', p, categories: categoryOptions(), stock, query: {} });
});

function parseAttrs(body) {
  const keys = [].concat(body.attr_k || []);
  const vals = [].concat(body.attr_v || []);
  return keys.map((k, i) => ({ k: str(k, 60), v: str(vals[i], 200) })).filter((a) => a.k && a.v).slice(0, 30);
}

function addStockLines(productId, text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5000);
  const ins = db.prepare('INSERT OR IGNORE INTO product_stock(product_id, data_enc, data_hash) VALUES(?,?,?)');
  let added = 0;
  db.transaction(() => { for (const l of lines) added += ins.run(productId, encrypt(l), sha256(l)).changes; })();
  return { added, dup: lines.length - added };
}

router.post('/products/save', (req, res) => {
  const id = toInt(req.body.id);
  const old = id ? db.prepare('SELECT * FROM products WHERE id = ?').get(id) : null;
  const categoryId = toInt(req.body.category_id);
  const title = str(req.body.title, 200);
  const price = toInt(req.body.price, -1, -1);
  if (!title || price < 0 || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) {
    return back(req, res, 'error', 'Vui lòng nhập tên, giá và chọn danh mục');
  }
  const type = old ? old.type : (req.body.type === 'stock' ? 'stock' : 'account');
  let code = str(req.body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '') || old?.code || randomCode(8);
  if (db.prepare('SELECT id FROM products WHERE code = ? AND id != ?').get(code, id)) return back(req, res, 'error', 'Mã sản phẩm đã tồn tại');

  // Ảnh: giữ ảnh cũ được tick, thêm ảnh mới
  let images = old ? H.parseJSON(old.images, []) : [];
  const keep = [].concat(req.body.keep_images || []);
  if (old) {
    images.filter((i) => !keep.includes(i)).forEach(removeImage);
    images = images.filter((i) => keep.includes(i));
  }
  for (const f of filesOf(req, 'images')) {
    const saved = saveImage(f, 'products');
    if (saved) images.push(saved);
  }
  images = images.slice(0, 10);

  let status = ['available', 'sold', 'hidden'].includes(req.body.status) ? req.body.status : 'available';
  const oldPrice = toInt(req.body.old_price, 0, 0) || null;
  const credRaw = String(req.body.credentials || '').slice(0, 5000).trim();
  let credEnc = old?.credentials_enc || null;
  if (type === 'account') {
    if (credRaw && credRaw !== decrypt(old?.credentials_enc)) credEnc = encrypt(credRaw);
    if (!credRaw) credEnc = null;
    if (!credEnc && status === 'available') return back(req, res, 'error', 'Acc cần nhập thông tin đăng nhập để giao cho khách');
  }
  const data = [categoryId, code, title, price, oldPrice, JSON.stringify(images), JSON.stringify(parseAttrs(req.body)),
    str(req.body.description, 5000), credEnc, status, bool(req.body.is_featured)];
  let pid = id;
  if (old) {
    db.prepare(`UPDATE products SET category_id=?, code=?, title=?, price=?, old_price=?, images=?, attributes=?, description=?,
      credentials_enc=?, status=?, is_featured=?, updated_at=unixepoch() WHERE id=?`).run(...data, id);
  } else {
    pid = db.prepare(`INSERT INTO products(category_id, code, title, price, old_price, images, attributes, description, credentials_enc, status, is_featured, type)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(...data, type).lastInsertRowid;
  }
  let msg = 'Đã lưu sản phẩm';
  if (type === 'stock' && req.body.stock_lines) {
    const r = addStockLines(pid, req.body.stock_lines);
    msg += `. Thêm ${r.added} mã vào kho${r.dup ? `, bỏ qua ${r.dup} mã trùng` : ''}`;
  }
  audit(req, old ? 'product_update' : 'product_create', `${code} ${title}`);
  back(req, res, 'success', msg, `/admin/products/${pid}/edit`);
});

router.post('/products/:id/stock', (req, res) => {
  const p = db.prepare("SELECT id, code FROM products WHERE id = ? AND type = 'stock'").get(toInt(req.params.id));
  if (!p) return back(req, res, 'error', 'Không tìm thấy sản phẩm kho');
  const r = addStockLines(p.id, req.body.stock_lines);
  audit(req, 'stock_import', `${p.code} +${r.added}`);
  back(req, res, 'success', `Đã thêm ${r.added} mã${r.dup ? `, bỏ qua ${r.dup} mã trùng` : ''}`);
});

router.post('/stock/:sid/delete', (req, res) => {
  const r = db.prepare('DELETE FROM product_stock WHERE id = ? AND is_sold = 0').run(toInt(req.params.sid));
  back(req, res, r.changes ? 'success' : 'error', r.changes ? 'Đã xóa mã' : 'Không thể xóa mã đã bán');
});

router.post('/products/bulk', (req, res) => {
  const ids = [].concat(req.body.ids || []).map((x) => toInt(x)).filter(Boolean).slice(0, 500);
  const action = req.body.action;
  if (!ids.length) return back(req, res, 'error', 'Chưa chọn sản phẩm');
  const ph = ids.map(() => '?').join(',');
  let n = 0;
  if (action === 'hide') n = db.prepare(`UPDATE products SET status = 'hidden' WHERE status = 'available' AND id IN (${ph})`).run(...ids).changes;
  else if (action === 'show') n = db.prepare(`UPDATE products SET status = 'available' WHERE status = 'hidden' AND id IN (${ph})`).run(...ids).changes;
  else if (action === 'feature') n = db.prepare(`UPDATE products SET is_featured = 1 WHERE id IN (${ph})`).run(...ids).changes;
  else if (action === 'unfeature') n = db.prepare(`UPDATE products SET is_featured = 0 WHERE id IN (${ph})`).run(...ids).changes;
  else if (action === 'delete') {
    const rows = db.prepare(`SELECT id, images FROM products WHERE status != 'sold' AND id IN (${ph})`).all(...ids);
    rows.forEach((r) => H.parseJSON(r.images, []).forEach(removeImage));
    n = db.prepare(`DELETE FROM products WHERE status != 'sold' AND id IN (${ph})`).run(...ids).changes;
  }
  audit(req, 'product_bulk_' + action, ids.join(','));
  back(req, res, 'success', `Đã xử lý ${n} sản phẩm`);
});

// Nhập nhiều acc cùng lúc: mỗi dòng "tên|giá|thông tin đăng nhập"
router.post('/products/import', (req, res) => {
  const categoryId = toInt(req.body.category_id);
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) return back(req, res, 'error', 'Chọn danh mục');
  const lines = String(req.body.lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2000);
  const ins = db.prepare(`INSERT INTO products(category_id, code, title, price, credentials_enc, type) VALUES(?,?,?,?,?,'account')`);
  let ok = 0, bad = 0;
  db.transaction(() => {
    for (const l of lines) {
      const [title, price, ...cred] = l.split('|');
      const pr = toInt(price, -1);
      if (!title || pr < 0 || !cred.join('|').trim()) { bad++; continue; }
      ins.run(categoryId, randomCode(8), str(title, 200), pr, encrypt(cred.join('|').trim().replace(/\\n/g, '\n')));
      ok++;
    }
  })();
  audit(req, 'product_import', `cat ${categoryId}: ${ok}`);
  back(req, res, 'success', `Đã nhập ${ok} acc${bad ? `, ${bad} dòng lỗi định dạng` : ''}`);
});

// ======================= ĐƠN HÀNG =======================
function orderFilters(req) {
  const q = {
    q: str(req.query.q, 60),
    status: ['completed', 'refunded'].includes(req.query.status) ? req.query.status : '',
    from: str(req.query.from, 10), to: str(req.query.to, 10),
    archived: req.query.archived === '1' ? '1' : '',
  };
  const where = [];
  const params = [];
  if (q.q) { where.push('(o.order_code LIKE ? OR o.product_title LIKE ? OR u.username LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  if (q.status) { where.push('o.status = ?'); params.push(q.status); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from)) { where.push('o.created_at >= ?'); params.push(H.fromInputDate(q.from + 'T00:00')); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) { where.push('o.created_at < ?'); params.push(H.fromInputDate(q.to + 'T00:00') + 86400); }
  return { q, where: where.length ? 'WHERE ' + where.join(' AND ') : '', params, table: q.archived ? 'orders_archive' : 'orders' };
}

router.get('/orders', (req, res) => {
  const f = orderFilters(req);
  const result = paginate(db, {
    select: 'o.*, u.username', from: `${f.table} o LEFT JOIN users u ON u.id = o.user_id`,
    where: f.where, params: f.params, order: 'ORDER BY o.id DESC', page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  const sum = db.prepare(`SELECT COALESCE(SUM(o.total),0) s FROM ${f.table} o LEFT JOIN users u ON u.id = o.user_id ${f.where}${f.where ? ' AND' : ' WHERE'} o.status = 'completed'`).get(...f.params).s;
  res.render('admin/orders', { title: 'Đơn hàng', result, query: f.q, sum });
});

router.get('/orders/export.csv', (req, res) => {
  const f = orderFilters(req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${vnDay()}.csv"`);
  res.write('﻿Mã đơn,Khách,Game,Sản phẩm,Giá,Giảm,Thanh toán,Mã KM,Trạng thái,Thời gian\n');
  // Stream theo từng dòng -> xuất được hàng trăm nghìn đơn mà không tốn RAM
  const it = db.prepare(`SELECT o.*, u.username FROM ${f.table} o LEFT JOIN users u ON u.id = o.user_id ${f.where} ORDER BY o.id DESC`).iterate(...f.params);
  for (const o of it) {
    res.write([o.order_code, o.username, o.game_name, o.product_title, o.price, o.discount, o.total, o.coupon_code, o.status, H.fmtDate(o.created_at)]
      .map(H.escapeCsv).join(',') + '\n');
  }
  audit(req, 'orders_export', JSON.stringify(f.q));
  res.end();
});

router.get('/orders/:id', (req, res, next) => {
  const archived = req.query.archived === '1';
  const o = db.prepare(`SELECT o.*, u.username, u.email FROM ${archived ? 'orders_archive' : 'orders'} o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = ?`).get(toInt(req.params.id));
  if (!o) return next();
  o.delivered = decrypt(o.delivered_enc);
  o.archived = archived;
  res.render('admin/order-detail', { title: 'Đơn ' + o.order_code, o });
});

router.post('/orders/:id/refund', (req, res) => {
  const r = refund(toInt(req.params.id), req.user.id, str(req.body.reason, 200), bool(req.body.restock));
  back(req, res, r.ok ? 'success' : 'error', r.ok ? 'Đã hoàn tiền cho khách' : r.message);
});

// ======================= NGƯỜI DÙNG =======================
router.get('/users', (req, res) => {
  const q = { q: str(req.query.q, 60), status: ['active', 'banned'].includes(req.query.status) ? req.query.status : '', sort: req.query.sort || '' };
  const where = [];
  const params = [];
  if (q.q) { where.push('(username LIKE ? OR email LIKE ? OR last_login_ip = ? OR register_ip = ?)'); params.push(`%${q.q}%`, `%${q.q}%`, q.q, q.q); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  const order = { balance: 'balance DESC', deposit: 'total_deposit DESC', spent: 'total_spent DESC' }[q.sort] || 'id DESC';
  const result = paginate(db, {
    select: '*', from: 'users', where: where.length ? 'WHERE ' + where.join(' AND ') : '', params,
    order: 'ORDER BY ' + order, page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  res.render('admin/users', { title: 'Người dùng', result, query: q });
});

router.get('/users/:id', (req, res, next) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(toInt(req.params.id));
  if (!u) return next();
  res.render('admin/user-detail', {
    title: 'Người dùng ' + u.username, u,
    orders: db.prepare('SELECT * FROM v_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(u.id),
    deposits: db.prepare('SELECT * FROM v_deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(u.id),
    balanceLogs: db.prepare('SELECT * FROM balance_logs WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(u.id),
    logins: db.prepare('SELECT * FROM login_logs WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(u.id),
    sameIp: u.register_ip ? db.prepare('SELECT id, username FROM users WHERE (register_ip = ? OR last_login_ip = ?) AND id != ? LIMIT 20').all(u.register_ip, u.register_ip, u.id) : [],
  });
});

router.post('/users/:id/balance', (req, res) => {
  const id = toInt(req.params.id);
  const amount = toInt(req.body.amount, 0);
  const note = str(req.body.note, 200) || 'Admin điều chỉnh';
  if (!amount) return back(req, res, 'error', 'Số tiền không hợp lệ');
  const r = db.transaction(() => {
    const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(id);
    if (!u) return 'Không tìm thấy';
    if (u.balance + amount < 0) return 'Số dư không đủ để trừ';
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amount, id);
    db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)')
      .run(id, amount, u.balance + amount, 'admin', 'ADMIN#' + req.user.id, note);
    return null;
  }).immediate();
  if (r) return back(req, res, 'error', r);
  audit(req, 'admin_balance', `user ${id}: ${amount} (${note})`);
  back(req, res, 'success', 'Đã cập nhật số dư');
});

router.post('/users/:id/ban', (req, res) => {
  const id = toInt(req.params.id);
  const u = db.prepare('SELECT role, status FROM users WHERE id = ?').get(id);
  if (!u || u.role === 'admin') return back(req, res, 'error', 'Không thể khóa tài khoản này');
  const ban = u.status === 'active';
  db.prepare('UPDATE users SET status = ?, ban_reason = ? WHERE id = ?').run(ban ? 'banned' : 'active', ban ? str(req.body.reason, 200) : null, id);
  if (ban) new SQLiteStore().destroyUser(id);
  audit(req, ban ? 'user_ban' : 'user_unban', String(id));
  back(req, res, 'success', ban ? 'Đã khóa tài khoản' : 'Đã mở khóa');
});

router.post('/users/:id/reset-password', async (req, res) => {
  const id = toInt(req.params.id);
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
  if (!u || u.role === 'admin') return back(req, res, 'error', 'Không thể đặt lại mật khẩu tài khoản này');
  const pw = randomCode(10, 'abcdefghijkmnpqrstuvwxyz23456789');
  db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(await bcrypt.hash(pw, 12), id);
  new SQLiteStore().destroyUser(id);
  audit(req, 'user_reset_password', String(id));
  back(req, res, 'success', `Mật khẩu mới: ${pw} (chỉ hiện 1 lần, hãy gửi cho khách)`);
});

router.post('/users/:id/unlock', (req, res) => {
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(toInt(req.params.id));
  back(req, res, 'success', 'Đã mở khóa đăng nhập');
});

// ======================= NẠP TIỀN & NGÂN HÀNG =======================
router.get('/deposits', (req, res) => {
  const q = { q: str(req.query.q, 60), status: ['pending', 'success', 'cancelled', 'expired'].includes(req.query.status) ? req.query.status : '' };
  const where = [];
  const params = [];
  if (q.q) { where.push('(d.code LIKE ? OR u.username LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.status) { where.push('d.status = ?'); params.push(q.status); }
  const result = paginate(db, {
    select: 'd.*, u.username', from: 'v_deposits d LEFT JOIN users u ON u.id = d.user_id',
    where: where.length ? 'WHERE ' + where.join(' AND ') : '', params,
    order: "ORDER BY (d.status = 'pending') DESC, d.created_at DESC", page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  res.render('admin/deposits', { title: 'Nạp tiền', result, query: q });
});

router.post('/deposits/:id/approve', (req, res) => {
  const id = toInt(req.params.id);
  const d = db.prepare('SELECT amount FROM deposits WHERE id = ?').get(id);
  if (!d) return back(req, res, 'error', 'Không tìm thấy');
  const amount = toInt(req.body.amount, d.amount, 1);
  const r = completeDeposit(id, amount, { adminId: req.user.id, note: str(req.body.note, 200) || 'Admin duyệt' });
  back(req, res, r.ok ? 'success' : 'error', r.ok ? `Đã cộng ${H.money(amount)}` : r.message);
});

router.post('/deposits/:id/cancel', (req, res) => {
  const ok = cancelDeposit(toInt(req.params.id), null, req.user.id);
  if (ok) audit(req, 'deposit_cancel', req.params.id);
  back(req, res, ok ? 'success' : 'error', ok ? 'Đã hủy' : 'Không thể hủy');
});

router.get('/bank', (req, res) => {
  const status = ['matched', 'unmatched', 'ignored'].includes(req.query.status) ? req.query.status : '';
  const result = paginate(db, {
    select: 'b.*, d.code AS deposit_code', from: 'bank_transactions b LEFT JOIN deposits d ON d.id = b.matched_deposit_id',
    where: status ? 'WHERE b.status = ?' : '', params: status ? [status] : [],
    order: 'ORDER BY b.id DESC', page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  res.render('admin/bank', { title: 'Giao dịch ngân hàng', result, query: { status }, webhookUrl: config.baseUrl + '/api/bank/webhook' });
});

// Khớp thủ công giao dịch bank (khách ghi sai nội dung) vào 1 đơn nạp hoặc 1 user
router.post('/bank/:id/match', (req, res) => {
  const t = db.prepare("SELECT * FROM bank_transactions WHERE id = ? AND status = 'unmatched'").get(toInt(req.params.id));
  if (!t) return back(req, res, 'error', 'Giao dịch không tồn tại hoặc đã xử lý');
  const target = str(req.body.target, 60);
  let dep = db.prepare("SELECT id FROM deposits WHERE code = ? AND status IN ('pending','expired')").get(target.toUpperCase());
  if (!dep) {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(target);
    if (!u) return back(req, res, 'error', 'Không tìm thấy mã nạp hoặc tên người dùng');
    const code = config.depositPrefix + randomCode(6);
    dep = { id: db.prepare("INSERT INTO deposits(user_id, code, amount, method) VALUES(?,?,?,'manual')").run(u.id, code, t.amount).lastInsertRowid };
  }
  const r = completeDeposit(dep.id, t.amount, { txnId: t.txn_id, adminId: req.user.id, note: 'Khớp thủ công GD bank' });
  if (!r.ok) return back(req, res, 'error', r.message);
  db.prepare("UPDATE bank_transactions SET status = 'matched', matched_deposit_id = ? WHERE id = ?").run(dep.id, t.id);
  audit(req, 'bank_match', `${t.txn_id} -> ${target}`);
  back(req, res, 'success', 'Đã khớp và cộng tiền');
});

router.post('/bank/:id/ignore', (req, res) => {
  db.prepare("UPDATE bank_transactions SET status = 'ignored' WHERE id = ? AND status = 'unmatched'").run(toInt(req.params.id));
  back(req, res, 'success', 'Đã bỏ qua giao dịch');
});

// ======================= MÃ GIẢM GIÁ =======================
router.get('/coupons', (req, res) => {
  const coupons = db.prepare('SELECT c.*, g.name AS game_name FROM coupons c LEFT JOIN games g ON g.id = c.game_id ORDER BY c.id DESC').all();
  const edit = req.query.edit ? db.prepare('SELECT * FROM coupons WHERE id = ?').get(toInt(req.query.edit)) : null;
  res.render('admin/coupons', { title: 'Mã giảm giá', coupons, edit, games: db.prepare('SELECT id, name FROM games ORDER BY sort_order').all() });
});

router.post('/coupons/save', (req, res) => {
  const id = toInt(req.body.id);
  const code = str(req.body.code, 32).toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const type = req.body.type === 'fixed' ? 'fixed' : 'percent';
  const value = toInt(req.body.value, 0, 0);
  if (code.length < 2 || !value || (type === 'percent' && value > 100)) return back(req, res, 'error', 'Mã hoặc giá trị không hợp lệ (% tối đa 100)');
  if (db.prepare('SELECT id FROM coupons WHERE code = ? AND id != ?').get(code, id)) return back(req, res, 'error', 'Mã đã tồn tại');
  const data = [code, str(req.body.description, 200), type, value, toInt(req.body.max_discount, 0, 0) || null, toInt(req.body.min_order, 0, 0),
    toInt(req.body.game_id, 0) || null, toInt(req.body.usage_limit, 0, 0) || null, toInt(req.body.per_user_limit, 1, 0),
    H.fromInputDate(req.body.starts_at), H.fromInputDate(req.body.expires_at), bool(req.body.is_public), bool(req.body.is_active)];
  if (id) db.prepare(`UPDATE coupons SET code=?, description=?, type=?, value=?, max_discount=?, min_order=?, game_id=?, usage_limit=?,
      per_user_limit=?, starts_at=?, expires_at=?, is_public=?, is_active=? WHERE id=?`).run(...data, id);
  else db.prepare(`INSERT INTO coupons(code, description, type, value, max_discount, min_order, game_id, usage_limit, per_user_limit,
      starts_at, expires_at, is_public, is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...data);
  audit(req, id ? 'coupon_update' : 'coupon_create', code);
  back(req, res, 'success', 'Đã lưu mã giảm giá', '/admin/coupons');
});

router.post('/coupons/:id/delete', (req, res) => {
  db.prepare('DELETE FROM coupons WHERE id = ?').run(toInt(req.params.id));
  audit(req, 'coupon_delete', req.params.id);
  back(req, res, 'success', 'Đã xóa mã', '/admin/coupons');
});

// ======================= BANNER / SIDEBAR =======================
router.get('/banners', (req, res) => {
  const banners = db.prepare('SELECT * FROM banners ORDER BY position, sort_order, id').all();
  const edit = req.query.edit ? db.prepare('SELECT * FROM banners WHERE id = ?').get(toInt(req.query.edit)) : null;
  res.render('admin/banners', { title: 'Banner & Sidebar', banners, edit });
});

router.post('/banners/save', (req, res) => {
  const id = toInt(req.body.id);
  const old = id ? db.prepare('SELECT * FROM banners WHERE id = ?').get(id) : null;
  const position = ['main', 'sidebar_left', 'sidebar_right', 'popup'].includes(req.body.position) ? req.body.position : 'main';
  let image = old?.image;
  const f = fileOf(req, 'image');
  if (f) {
    const saved = saveImage(f, 'banners');
    if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ');
    if (old?.image) removeImage(old.image);
    image = saved;
  }
  if (!image) return back(req, res, 'error', 'Vui lòng chọn ảnh');
  let link = str(req.body.link, 300);
  if (link && !/^(\/(?!\/)|https?:\/\/)/i.test(link)) link = ''; // chặn javascript: URL
  const data = [position, str(req.body.title, 150), image, link, toInt(req.body.sort_order), bool(req.body.is_active)];
  if (old) db.prepare('UPDATE banners SET position=?, title=?, image=?, link=?, sort_order=?, is_active=? WHERE id=?').run(...data, id);
  else db.prepare('INSERT INTO banners(position, title, image, link, sort_order, is_active) VALUES(?,?,?,?,?,?)').run(...data);
  audit(req, 'banner_save', position);
  back(req, res, 'success', 'Đã lưu banner', '/admin/banners');
});

router.post('/banners/:id/delete', (req, res) => {
  const b = db.prepare('SELECT * FROM banners WHERE id = ?').get(toInt(req.params.id));
  if (b) { db.prepare('DELETE FROM banners WHERE id = ?').run(b.id); removeImage(b.image); }
  back(req, res, 'success', 'Đã xóa banner', '/admin/banners');
});

// ======================= CÀI ĐẶT =======================
const SETTING_KEYS = ['site_name', 'site_slogan', 'site_description', 'notice', 'contact_facebook', 'contact_zalo', 'contact_email',
  'bank_code', 'bank_name', 'bank_account', 'bank_owner', 'deposit_min', 'deposit_max', 'footer_text'];

router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Cài đặt', s: getSettings() }));

router.post('/settings', (req, res) => {
  for (const k of SETTING_KEYS) if (req.body[k] !== undefined) setSetting(k, str(req.body[k], 2000));
  setSetting('maintenance_mode', bool(req.body.maintenance_mode));
  setSetting('allow_register', bool(req.body.allow_register));
  const logo = fileOf(req, 'logo');
  if (logo) { const saved = saveImage(logo, 'site'); if (saved) setSetting('logo', saved); }
  audit(req, 'settings_update');
  back(req, res, 'success', 'Đã lưu cài đặt', '/admin/settings');
});

// ======================= NHẬT KÝ & BẢO MẬT =======================
router.get('/logs', (req, res) => {
  const tab = req.query.tab === 'login' ? 'login' : 'activity';
  const q = { tab, q: str(req.query.q, 60) };
  const result = tab === 'login'
    ? paginate(db, { select: '*', from: 'login_logs', where: q.q ? 'WHERE username LIKE ? OR ip = ?' : '', params: q.q ? [`%${q.q}%`, q.q] : [],
      order: 'ORDER BY id DESC', page: toInt(req.query.page, 1, 1), perPage: 50 })
    : paginate(db, { select: 'l.*, u.username', from: 'activity_logs l LEFT JOIN users u ON u.id = l.user_id',
      where: q.q ? 'WHERE l.action LIKE ? OR u.username LIKE ? OR l.ip = ?' : '', params: q.q ? [`%${q.q}%`, `%${q.q}%`, q.q] : [],
      order: 'ORDER BY l.id DESC', page: toInt(req.query.page, 1, 1), perPage: 50 });
  res.render('admin/logs', { title: 'Nhật ký', result, query: q, tab });
});

router.get('/security', (req, res) => {
  const t = Math.floor(Date.now() / 1000);
  res.render('admin/security', {
    title: 'Bảo mật',
    blocks: db.prepare('SELECT * FROM ip_blocks ORDER BY created_at DESC LIMIT 200').all(),
    topFailIps: db.prepare('SELECT ip, COUNT(*) n FROM login_logs WHERE success = 0 AND created_at > ? GROUP BY ip ORDER BY n DESC LIMIT 15').all(t - 86400),
    admins: db.prepare("SELECT id, username, last_login_at, last_login_ip FROM users WHERE role = 'admin'").all(),
    whitelist: config.admin.ipWhitelist,
    myIp: clientIp(req),
  });
});

router.post('/security/block', (req, res) => {
  const ip = str(req.body.ip, 60);
  if (!ip || ip === clientIp(req)) return back(req, res, 'error', 'IP không hợp lệ (không thể tự chặn chính mình)');
  blockIp(ip, toInt(req.body.minutes, 0, 0) || null, str(req.body.reason, 200) || 'Admin chặn');
  audit(req, 'ip_block', ip);
  back(req, res, 'success', 'Đã chặn IP ' + ip);
});

router.post('/security/unblock', (req, res) => {
  unblockIp(str(req.body.ip, 60));
  audit(req, 'ip_unblock', req.body.ip);
  back(req, res, 'success', 'Đã bỏ chặn');
});

// ======================= BẢO TRÌ DỮ LIỆU =======================
router.get('/maintenance', (req, res) => {
  res.render('admin/maintenance', { title: 'Bảo trì dữ liệu', info: maintenance.dbInfo(), s: getSettings(), retention: config.retention });
});

router.post('/maintenance/run', async (req, res) => {
  const task = req.body.task;
  let msg = '';
  if (task === 'light') msg = 'Dọn dẹp: ' + JSON.stringify(maintenance.runLight());
  else if (task === 'archive') msg = 'Lưu trữ: ' + JSON.stringify(maintenance.archive());
  else if (task === 'backup') msg = 'Đã backup: ' + (await maintenance.backup());
  else if (task === 'optimize') { maintenance.optimize(false); msg = 'Đã tối ưu chỉ mục'; }
  else if (task === 'vacuum') { maintenance.optimize(true); msg = 'Đã VACUUM (thu gọn file DB)'; }
  else if (task === 'stats') { maintenance.rebuildStats(); msg = 'Đã tính lại thống kê'; }
  else if (task === 'daily') msg = 'Hoàn tất: ' + JSON.stringify(await maintenance.runDaily());
  audit(req, 'maintenance_' + task, msg.slice(0, 300));
  back(req, res, 'success', msg, '/admin/maintenance');
});

router.get('/maintenance/backup/:name', (req, res, next) => {
  const name = path.basename(String(req.params.name));
  const file = path.join(config.paths.backups, name);
  if (!/^shop-[\w-]+\.db$/.test(name) || !fs.existsSync(file)) return next();
  audit(req, 'backup_download', name);
  res.download(file);
});

// ======================= TÀI KHOẢN ADMIN =======================
router.get('/profile', (req, res) => res.render('admin/profile', { title: 'Tài khoản admin' }));

module.exports = router;
