'use strict';
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db, getSettings, setSetting, logActivity, vnDay } = require('../db');
const { requireStaff, verifyCsrf, blockIp, unblockIp } = require('../middleware/security');
const { upload, saveImage, removeImage, optimizeUploads } = require('../utils/upload');
const { encrypt, decrypt, sha256, randomCode } = require('../utils/crypto');
const H = require('../utils/helpers');
const { refund } = require('../services/order');
const { completeDeposit, cancelDeposit } = require('../services/deposit');
const maintenance = require('../services/maintenance');
const backupSvc = require('../services/backup');
const SQLiteStore = require('../session-store');
const publicRouter = require('./public');
const config = require('../config');

const { paginate, toInt, str, bool, clientIp } = H;
const router = express.Router();

// ---------- Phân quyền: admin / CTV quản lý / CTV bán hàng / CSKH ----------
// Quản lý: mọi trang trừ nhóm Giao diện & Hệ thống. Bán hàng: chỉ sản phẩm / cày thuê / nạp game được cấp + ví.
// CSKH: chỉ ví (trang chat ở /admin/chat).
const MANAGER_BLOCK = ['/home-layout', '/home-blocks', '/banners', '/popup', '/footer', '/support', '/settings', '/boost/settings', '/api', '/security', '/antispam', '/logs', '/maintenance', '/profile'];
const SELLER_ALLOW = [
  /^\/(vip|reroll)$/, /^\/products\/(rows|form|save|bulk|import-form|import)$/, /^\/products\/\d+\/(edit|duplicate|delete|stock|toggle)$/, /^\/stock\/\d+\/delete$/,
  /^\/boost(\/(c\/\d+|topup(\/\d+)?|orders(\/\d+(\/(login|status|note))?)?|topup-orders|categories\/(form|save|\d+(\/delete)?)|packages\/(form|save|\d+\/(pause|delete))))?$/,
  /^\/(boost-categories|boost-packages)\/\d+\/toggle$/,
];
const denied = (res) => res.status(403).render('errors/error', { code: 403, message: 'Bạn không có quyền vào trang này' });
const ctvSvc = require('../services/ctv');
router.use(requireStaff);
router.use((req, res, next) => {
  const p = req.path;
  if (req.perm === 'admin') return next();
  if (p === '/me' || p.startsWith('/me/')) return next(); // ví & tổng quan của chính CTV
  if (req.perm === 'manager') return MANAGER_BLOCK.some((x) => p === x || p.startsWith(x + '/')) ? denied(res) : next();
  if (p === '/') return res.redirect(req.perm === 'support' ? '/admin/chat' : '/admin/me');
  if (req.perm === 'seller' && SELLER_ALLOW.some((re) => re.test(p))) return next();
  return denied(res);
});
router.use((req, res, next) => {
  res.locals.layoutAdmin = true;
  res.locals.path = req.path;
  res.locals.perm = req.perm;
  if (req.perm === 'seller') res.locals.ctvTypes = ctvSvc.allowedTypes(req.user.id);
  if (req.perm === 'seller' || req.perm === 'support') { res.locals.adminBadges = {}; return next(); }
  res.locals.adminBadges = {
    deposits: db.prepare("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'").get().c,
    ...Object.fromEntries(['boost', 'topup'].map((k) => [k, 0])),
    ...Object.fromEntries(db.prepare("SELECT kind, COUNT(*) c FROM boost_orders WHERE status = 'received' GROUP BY kind").all().map((r) => [r.kind, r.c])),
    bank: db.prepare("SELECT COUNT(*) c FROM bank_transactions WHERE status = 'unmatched'").get().c,
    chat: db.prepare('SELECT COUNT(*) c FROM chat_convs WHERE unread_admin > 0 AND blocked = 0').get().c,
    ctv: db.prepare("SELECT COUNT(*) c FROM ctv_withdrawals WHERE status = 'pending'").get().c,
  };
  next();
});

// Multipart (upload ảnh): parse rồi kiểm tra CSRF
router.use((req, res, next) => {
  if (!req.is('multipart/form-data') || req.path === '/maintenance/restore') return next(); // khôi phục dữ liệu có bộ nhận file riêng
  upload.any()(req, res, (err) => {
    if (err) {
      req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'Ảnh vượt quá 8MB' : err.message);
      return res.redirect(req.get('referer') || '/admin');
    }
    if (!verifyCsrf(req)) return res.status(403).render('errors/error', { code: 403, message: 'CSRF token không hợp lệ' });
    optimizeUploads(req).then(() => next(), () => next());
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
// Quay lại trang đang đứng (form trong modal gửi kèm _back), chỉ chấp nhận đường dẫn nội bộ /admin
const safeBack = (req) => {
  const b = String(req.body?._back || '');
  return /^\/admin(\/|\?|$)/.test(b) ? b : null;
};
const back = (req, res, type, msg, url) => { if (msg) req.flash(type, msg); res.redirect(safeBack(req) || url || req.get('referer') || '/admin'); };

// ======================= DASHBOARD =======================
router.get('/', (req, res) => {
  const days = [];
  for (let i = 29; i >= 0; i--) days.push(vnDay(Date.now() - i * 86400000));
  const dayStart = (ago) => Math.floor((Date.now() + 7 * 3600e3) / 86400e3 - ago) * 86400 - 7 * 3600;
  const ranges = { today: dayStart(0), d7: dayStart(6), d30: dayStart(29), all: 0 };
  // Doanh thu = tiền khách trả (đã trừ mã giảm giá, không tính đơn hoàn / hủy). Trả CTV = phần CTV nhận. Lãi shop = doanh thu − trả CTV
  const KINDS = [['vip', 'Acc VIP'], ['reroll', 'Reroll'], ['boost', 'Cày thuê'], ['topup', 'Nạp game']];
  const rev = {};
  for (const [r, from] of Object.entries(ranges)) {
    const rows = db.prepare("SELECT kind, COUNT(*) n, COALESCE(SUM(amount), 0) amount, COALESCE(SUM(ctv_amount), 0) ctv FROM sales WHERE status = 'ok' AND created_at >= ? GROUP BY kind").all(from);
    const by = Object.fromEntries(rows.map((x) => [x.kind, x]));
    rev[r] = Object.fromEntries(KINDS.map(([k]) => [k, by[k] || { n: 0, amount: 0, ctv: 0 }]));
    rev[r].total = KINDS.reduce((acc, [k]) => ({ n: acc.n + rev[r][k].n, amount: acc.amount + rev[r][k].amount, ctv: acc.ctv + rev[r][k].ctv }), { n: 0, amount: 0, ctv: 0 });
  }
  const statRows = db.prepare('SELECT * FROM daily_stats WHERE day >= ?').all(days[0]);
  const map = Object.fromEntries(statRows.map((r) => [r.day, r]));
  const revDay = Object.fromEntries(db.prepare("SELECT date(created_at, 'unixepoch', '+7 hours') d, SUM(amount) a FROM sales WHERE status = 'ok' AND created_at >= ? GROUP BY d").all(ranges.d30).map((r) => [r.d, r.a]));
  const series = days.map((d) => ({ day: d, revenue: revDay[d] || 0, deposits: map[d]?.deposits || 0, new_users: map[d]?.new_users || 0 }));
  const sum = (k) => series.reduce((a, x) => a + (x[k] || 0), 0);
  const today = map[days[29]] || {};
  const open = (kind) => db.prepare("SELECT COUNT(*) c FROM boost_orders WHERE kind = ? AND status IN ('received','processing','need_info')").get(kind).c;
  const lowStock = db.prepare(`SELECT p.id, p.title, (SELECT COUNT(*) FROM product_stock s WHERE s.product_id = p.id AND s.is_sold = 0) AS left_count
      FROM products p WHERE p.type = 'stock' AND p.status = 'available' AND left_count < 3 ORDER BY left_count LIMIT 10`).all();
  res.render('admin/dashboard', {
    title: 'Tổng quan', series, rev, KINDS,
    money: {
      depToday: today.deposits || 0, depTodayN: today.deposit_count || 0, dep30: sum('deposits'),
      depAll: db.prepare('SELECT COALESCE(SUM(deposits), 0) s FROM daily_stats').get().s,
      balance: db.prepare('SELECT COALESCE(SUM(balance), 0) c FROM users').get().c,
      ctvBalance: db.prepare('SELECT COALESCE(SUM(ctv_balance), 0) c FROM users').get().c,
      users: db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'user'").get().c, newUsers: sum('new_users'),
    },
    todo: {
      boost: open('boost'), topup: open('topup'), lowStock: lowStock.length,
      products: db.prepare("SELECT COUNT(*) c FROM products WHERE status = 'available'").get().c,
    },
    lowStock,
    recentOrders: db.prepare('SELECT o.*, u.username FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 8').all(),
    pendingDeposits: db.prepare("SELECT d.*, u.username FROM deposits d JOIN users u ON u.id = d.user_id WHERE d.status = 'pending' ORDER BY d.id DESC LIMIT 8").all(),
  });
});

// ======================= SẮP XẾP & BẬT/TẮT HIỂN THỊ (dùng chung) =======================
const SORTABLE = {
  games: { table: 'games', group: null, order: 'sort_order, id' },
  categories: { table: 'categories', group: 'game_id', order: 'sort_order, id' },
  products: { table: 'products', group: 'category_id', order: 'sort_order, id DESC' },
  banners: { table: 'banners', group: 'position', order: 'sort_order, id' },
  'home-blocks': { table: 'home_blocks', group: null, order: 'sort_order, id' },
  'boost-categories': { table: 'boost_categories', group: 'game_id', order: 'sort_order, id' },
  'boost-packages': { table: 'boost_packages', group: 'category_id', order: 'sort_order, id' },
};

function moveItem(kind, id, dir) {
  const s = SORTABLE[kind];
  const row = db.prepare(`SELECT * FROM ${s.table} WHERE id = ?`).get(id);
  if (!row) return false;
  const ids = db.prepare(`SELECT id FROM ${s.table} ${s.group ? `WHERE ${s.group} = ?` : ''} ORDER BY ${s.order}`)
    .all(...(s.group ? [row[s.group]] : [])).map((r) => r.id);
  const i = ids.indexOf(id);
  const j = dir === 'up' ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= ids.length) return false;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  const upd = db.prepare(`UPDATE ${s.table} SET sort_order = ? WHERE id = ?`);
  db.transaction(() => ids.forEach((x, k) => upd.run(k, x)))();
  return true;
}

function toggleItem(kind, id) {
  if (kind === 'products') {
    const p = db.prepare('SELECT status FROM products WHERE id = ?').get(id);
    if (!p || p.status === 'sold') return { ok: false, message: 'Sản phẩm đã bán, không thể bật/tắt' };
    const next = p.status === 'available' ? 'hidden' : 'available';
    db.prepare('UPDATE products SET status = ?, updated_at = unixepoch() WHERE id = ?').run(next, id);
    return { ok: true, active: next === 'available' };
  }
  const t = SORTABLE[kind].table;
  const r = db.prepare(`UPDATE ${t} SET is_active = 1 - is_active WHERE id = ?`).run(id);
  if (!r.changes) return { ok: false, message: 'Không tìm thấy' };
  return { ok: true, active: !!db.prepare(`SELECT is_active FROM ${t} WHERE id = ?`).get(id).is_active };
}

// Kéo thả (nút 6 chấm): nhận danh sách id theo thứ tự mới của các dòng đang hiện trên trang.
// Trang có phân trang chỉ gửi 1 phần -> giữ nguyên các vị trí của phần còn lại, chỉ đổi chỗ giữa các id được gửi.
const REORDERABLE = { ...SORTABLE, attributes: { table: 'attributes', group: null, order: 'sort_order, id' } };
function reorderItems(kind, ids) {
  const s = REORDERABLE[kind];
  ids = [...new Set(ids.map((x) => toInt(x)).filter(Boolean))].slice(0, 500);
  if (ids.length < 2) return false;
  const rows = db.prepare(`SELECT id${s.group ? ', ' + s.group + ' AS g' : ''} FROM ${s.table} WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (rows.length !== ids.length) return false;
  if (s.group && new Set(rows.map((r) => r.g)).size !== 1) return false; // chỉ sắp xếp trong cùng 1 nhóm
  const full = db.prepare(`SELECT id FROM ${s.table} ${s.group ? `WHERE ${s.group} = ?` : ''} ORDER BY ${s.order}`)
    .all(...(s.group ? [rows[0].g] : [])).map((r) => r.id);
  const slots = full.map((id, i) => (ids.includes(id) ? i : -1)).filter((i) => i >= 0);
  slots.forEach((slot, k) => { full[slot] = ids[k]; });
  const upd = db.prepare(`UPDATE ${s.table} SET sort_order = ? WHERE id = ?`);
  db.transaction(() => full.forEach((x, k) => upd.run(k, x)))();
  return true;
}
for (const kind of Object.keys(REORDERABLE)) {
  router.post(`/${kind}/reorder`, (req, res) => {
    const ok = reorderItems(kind, [].concat(req.body.ids || []));
    if (ok) audit(req, `${kind}_reorder`, String(req.body.ids).slice(0, 200));
    res.json({ ok });
  });
}

for (const kind of Object.keys(SORTABLE)) {
  router.post(`/${kind}/:id/move`, (req, res) => {
    const ok = moveItem(kind, toInt(req.params.id), req.body.dir === 'up' ? 'up' : 'down');
    if (req.get('x-csrf-token')) return res.json({ ok });
    back(req, res, ok ? 'success' : 'error', ok ? null : 'Không thể di chuyển');
  });
  router.post(`/${kind}/:id/toggle`, (req, res) => {
    if (req.perm === 'seller') {
      const id = toInt(req.params.id);
      const ok = kind === 'products' ? ownsProduct(req, db.prepare('SELECT owner_id, category_id FROM products WHERE id = ?').get(id))
        : ctvSvc.canCat(req.user.id, db.prepare(kind === 'boost-categories' ? 'SELECT parent_id p FROM boost_categories WHERE id = ?' : 'SELECT bc.parent_id p FROM boost_packages x JOIN boost_categories bc ON bc.id = x.category_id WHERE x.id = ?').get(id)?.p, ['boost', 'topup']);
      if (!ok) return res.status(403).json({ ok: false, message: 'Không có quyền' });
    }
    const r = toggleItem(kind, toInt(req.params.id));
    if (r.ok) audit(req, `${kind}_toggle`, `${req.params.id} -> ${r.active ? 'hiện' : 'ẩn'}`);
    if (req.get('x-csrf-token')) return res.json(r);
    back(req, res, r.ok ? 'success' : 'error', r.ok ? null : r.message);
  });
}

// Cày thuê: danh mục, gói, đơn, cài đặt
router.use('/boost', require('./admin-boost'));
router.use('/api', require('./admin-api')); // Kết nối API: Telegram, AI
router.use('/', require('./admin-ctv').router); // Quản lý CTV + trang của CTV (/admin/me)
router.use('/', require('./admin-posts')); // bài viết, AI viết bài, SEO & Google

// Nội dung form trong modal (trả về HTML không có layout)
const modal = (res, view, data) => res.render('admin/modals/' + view, data);

// ======================= GAME (CẤP 1) =======================
router.get('/games', (req, res) => {
  const games = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM categories c WHERE c.game_id = g.id) AS cat_count,
    (SELECT COUNT(*) FROM products p JOIN categories c ON c.id = p.category_id WHERE c.game_id = g.id AND p.status != 'sold') AS product_count
    FROM games g ORDER BY g.sort_order, g.id`).all();
  res.render('admin/games', { title: 'Game', games });
});

router.get('/games/form', (req, res) => {
  const g = req.query.id ? db.prepare('SELECT * FROM games WHERE id = ?').get(toInt(req.query.id)) : null;
  modal(res, 'game-form', { g });
});

router.post('/games/save', (req, res) => {
  let id = toInt(req.body.id);
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
  } else if (old && req.body.remove_image) {
    removeImage(old.image);
    image = null;
  }
  const data = [name, slug, image, str(req.body.description, 1000), str(req.body.color, 20) || '#6d28d9', bool(req.body.is_active), bool(req.body.is_hot)];
  if (old) {
    db.prepare('UPDATE games SET name=?, slug=?, image=?, description=?, color=?, is_active=?, is_hot=? WHERE id=?').run(...data, id);
  } else {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM games').get().n;
    id = db.prepare('INSERT INTO games(name, slug, image, description, color, is_active, is_hot, sort_order) VALUES(?,?,?,?,?,?,?,?)').run(...data, next).lastInsertRowid;
  }
  saveSeo('games', id, req.body);
  audit(req, old ? 'game_update' : 'game_create', name);
  back(req, res, 'success', old ? 'Đã cập nhật game' : 'Đã thêm game', '/admin/games');
});

router.post('/games/:id/delete', (req, res) => {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(toInt(req.params.id));
  if (!g) return back(req, res, 'error', 'Không tìm thấy');
  const sold = db.prepare("SELECT COUNT(*) c FROM products p JOIN categories c ON c.id = p.category_id WHERE c.game_id = ? AND p.status = 'sold'").get(g.id).c;
  if (sold) return back(req, res, 'error', `Game có ${sold} sản phẩm đã bán. Hãy tắt hiển thị thay vì xóa.`);
  db.prepare('DELETE FROM games WHERE id = ?').run(g.id);
  removeImage(g.image);
  audit(req, 'game_delete', g.name);
  back(req, res, 'success', 'Đã xóa game', '/admin/games');
});

// Tiêu đề / mô tả SEO riêng (để trống -> tự tạo)
const saveSeo = (table, id, b) => db.prepare(`UPDATE ${table} SET seo_title = ?, seo_desc = ? WHERE id = ?`).run(str(b.seo_title, 70) || null, str(b.seo_desc, 170) || null, id);

// ======================= DANH MỤC CON (CẤP 2) =======================
router.get('/categories', (req, res) => {
  const games = db.prepare(`SELECT g.id, g.name, g.image, g.color, g.is_active,
    (SELECT COUNT(*) FROM categories c WHERE c.game_id = g.id) AS cat_count FROM games g ORDER BY g.sort_order, g.id`).all();
  const cats = db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status != 'sold') AS product_count,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'available') AS available_count,
      (SELECT MIN(price) FROM products p WHERE p.category_id = c.id AND p.status = 'available') AS min_price,
      (SELECT COUNT(*) FROM boost_categories b WHERE b.parent_id = c.id) AS sub_count,
      (SELECT COUNT(*) FROM boost_packages p JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = c.id) AS pkg_count,
      (SELECT MIN(p.price) FROM boost_packages p JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = c.id AND p.is_active = 1 AND b.is_active = 1) AS pkg_min
    FROM categories c ORDER BY c.sort_order, c.id`).all();
  games.forEach((g) => { g.cats = cats.filter((c) => c.game_id === g.id); });
  res.render('admin/categories', { title: 'Danh mục', games });
});

router.get('/categories/form', (req, res) => {
  const c = req.query.id ? db.prepare('SELECT * FROM categories WHERE id = ?').get(toInt(req.query.id)) : null;
  if (c) {
    c.product_count = db.prepare('SELECT COUNT(*) n FROM products WHERE category_id = ?').get(c.id).n
      + (c.sale_type === 'topup'
        ? db.prepare('SELECT COUNT(*) n FROM boost_packages p JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = ?').get(c.id).n
        : db.prepare('SELECT COUNT(*) n FROM boost_categories WHERE parent_id = ?').get(c.id).n);
  }
  const games = db.prepare('SELECT id, name FROM games ORDER BY sort_order, id').all();
  const disp = require('./boost').display;
  modal(res, 'category-form', { c, games, gameId: c ? c.game_id : toInt(req.query.game_id), boostDisp: { cat: disp('cat', c), pkg: disp('pkg', c) }, topupMethod: c ? require('../services/boost').methodOf(c) : 'uid' });
});

router.post('/categories/save', (req, res) => {
  let id = toInt(req.body.id);
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
  } else if (old && req.body.remove_image) {
    removeImage(old.image);
    image = null;
  }
  const saleType = ['reroll', 'boost', 'topup'].includes(req.body.sale_type) ? req.body.sale_type : 'vip';
  if (old && old.sale_type !== saleType) {
    // Không cho đổi loại khi đã có hàng bên trong (acc VIP, kho acc Reroll và gói cày thuê lưu khác nhau)
    const n = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id = ?').get(old.id).c;
    if (n) return back(req, res, 'error', `Danh mục đã có ${n} sản phẩm, không thể đổi loại. Hãy tạo danh mục mới.`);
    if (old.sale_type === 'topup') {
      const k = db.prepare('SELECT COUNT(*) c FROM boost_packages p JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = ?').get(old.id).c;
      if (k) return back(req, res, 'error', `Danh mục đã có ${k} gói nạp, không thể đổi loại. Hãy tạo danh mục mới.`);
      db.prepare('DELETE FROM boost_categories WHERE parent_id = ?').run(old.id); // danh mục con ẩn (trống)
    }
    const b = db.prepare('SELECT COUNT(*) c FROM boost_categories WHERE parent_id = ?').get(old.id).c;
    if (b) return back(req, res, 'error', `Danh mục đã có ${b} danh mục con cày thuê, không thể đổi loại. Hãy tạo danh mục mới.`);
  }
  // Cày thuê: cài đặt hiển thị riêng (danh mục con + gói). Nạp game: hiển thị gói + hình thức nhập (UID / tài khoản)
  let options = old?.options || null;
  if (saleType === 'boost' || saleType === 'topup') {
    const o = {};
    if (saleType === 'topup') o.method = req.body.topup_method === 'uid' ? 'uid' : 'login';
    for (const lv of saleType === 'topup' ? ['pkg'] : ['cat', 'pkg']) {
      o[`${lv}_mode`] = req.body[`${lv}_mode`] === 'icon' ? 'icon' : 'image';
      o[`${lv}_cols_pc`] = String(toInt(req.body[`${lv}_cols_pc`], 4, 1, 6));
      o[`${lv}_cols_m`] = String(toInt(req.body[`${lv}_cols_m`], 2, 1, 3));
      o[`${lv}_max`] = String(toInt(req.body[`${lv}_max`], 12, 1, 200));
    }
    options = JSON.stringify(o);
  }
  const data = [gameId, name, slug, image, str(req.body.description, 1000), bool(req.body.is_active), saleType, options];
  if (old) {
    db.prepare('UPDATE categories SET game_id=?, name=?, slug=?, image=?, description=?, is_active=?, sale_type=?, options=? WHERE id=?').run(...data, id);
    if (saleType === 'topup') db.prepare('UPDATE boost_categories SET name = ? WHERE parent_id = ?').run(name, id);
    // chuyển danh mục cày thuê sang game khác -> danh mục con đi theo (giỏ hàng tính theo game)
    if (old.game_id !== gameId) db.prepare('UPDATE boost_categories SET game_id = ? WHERE parent_id = ?').run(gameId, id);
  } else {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM categories WHERE game_id = ?').get(gameId).n;
    id = db.prepare('INSERT INTO categories(game_id, name, slug, image, description, is_active, sale_type, options, sort_order) VALUES(?,?,?,?,?,?,?,?,?)').run(...data, next).lastInsertRowid;
  }
  saveSeo('categories', id, req.body);
  audit(req, old ? 'category_update' : 'category_create', name);
  back(req, res, 'success', old ? 'Đã cập nhật danh mục' : 'Đã thêm danh mục', '/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  const c = db.prepare('SELECT * FROM categories WHERE id = ?').get(toInt(req.params.id));
  if (!c) return back(req, res, 'error', 'Không tìm thấy');
  const sold = db.prepare("SELECT COUNT(*) n FROM products WHERE category_id = ? AND status = 'sold'").get(c.id).n;
  if (sold) return back(req, res, 'error', `Danh mục có ${sold} sản phẩm đã bán. Hãy tắt hiển thị thay vì xóa.`);
  const rented = db.prepare('SELECT COUNT(*) n FROM boost_order_items i JOIN boost_packages p ON p.id = i.package_id JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = ?').get(c.id).n;
  if (rented) return back(req, res, 'error', `Danh mục ${c.sale_type === 'topup' ? 'nạp game' : 'cày thuê'} đã có ${rented} ${c.sale_type === 'topup' ? 'lượt nạp' : 'lượt thuê'}. Hãy tắt hiển thị thay vì xóa.`);
  db.prepare('SELECT b.image FROM boost_categories b WHERE b.parent_id = ? UNION ALL SELECT p.image FROM boost_packages p JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = ?')
    .all(c.id, c.id).forEach((r) => removeImage(r.image));
  db.prepare('SELECT images FROM products WHERE category_id = ?').all(c.id).forEach((r) => H.parseJSON(r.images, []).forEach(removeImage));
  db.prepare('DELETE FROM categories WHERE id = ?').run(c.id);
  removeImage(c.image);
  audit(req, 'category_delete', c.name);
  back(req, res, 'success', 'Đã xóa danh mục');
});

// ======================= SẢN PHẨM (CẤP 3) =======================
// CTV bán hàng: chỉ danh mục được cấp và chỉ sản phẩm do chính mình đăng
const sellerCats = (req, types = ['vip', 'reroll']) => (req.perm === 'seller' ? ctvSvc.allowedCats(req.user.id, types) : null);
const ownsProduct = (req, p) => !!p && (req.perm !== 'seller' || (p.owner_id === req.user.id && ctvSvc.canCat(req.user.id, p.category_id, ['vip', 'reroll'])));
const inList = (ids) => (ids.length ? ids.join(',') : '0'); // id là số nguyên lấy từ DB
function categoryOptions(req) {
  const cats = req ? sellerCats(req) : null;
  return db.prepare(`SELECT c.id, c.name, g.name AS game_name FROM categories c JOIN games g ON g.id = c.game_id WHERE c.sale_type IN ('vip','reroll')${cats ? ` AND c.id IN (${inList(cats)})` : ''} ORDER BY g.sort_order, c.sort_order, c.id`).all();
}

const PRODUCT_ROW_SELECT = `p.id, p.code, p.title, p.type, p.price, p.old_price, p.images, p.status, p.views, p.sold_count, p.is_featured,
  p.created_at, p.category_id, c.name AS category_name, g.name AS game_name,
  (CASE WHEN p.type = 'stock' THEN (SELECT COUNT(*) FROM product_stock s WHERE s.product_id = p.id AND s.is_sold = 0) END) AS stock_left`;

function productFilter(req) {
  const q = str(req.query.q, 60);
  const status = ['available', 'sold', 'hidden'].includes(req.query.status) ? req.query.status : '';
  const where = [];
  const params = [];
  if (q) { where.push('(p.title LIKE ? OR p.code LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (status) { where.push('p.status = ?'); params.push(status); }
  // Acc VIP đã bán không còn là hàng trong kho -> ẩn khỏi danh sách mặc định (vẫn tra cứu được ở Đơn hàng
  // hoặc chọn lọc "Đã bán"); khi tìm theo tên/mã thì vẫn ra để tra cứu
  else if (!q) where.push("p.status != 'sold'");
  return { q, status, where, params };
}

// Trang sản phẩm tách theo loại: Acc VIP (/admin/vip) và Reroll (/admin/reroll)
// Game -> Danh mục (sản phẩm tải khi mở danh mục, phân trang => chịu được hàng nghìn acc)
const PRODUCT_PAGES = { vip: { title: 'Acc VIP', base: '/admin/vip' }, reroll: { title: 'Reroll', base: '/admin/reroll' } };
const productsBase = (saleType) => (saleType === 'reroll' ? '/admin/reroll' : '/admin/vip');
router.get('/products', (req, res) => res.redirect('/admin/vip' + (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '')));
router.get(['/vip', '/reroll'], (req, res) => {
  const type = req.path === '/reroll' ? 'reroll' : 'vip';
  const page = PRODUCT_PAGES[type];
  const f = productFilter(req);
  const query = { q: f.q, status: f.status };
  const mine = sellerCats(req);
  if (mine) { f.where.push(`p.owner_id = ? AND p.category_id IN (${inList(mine)})`); f.params.push(req.user.id); }
  if (f.q) {
    const result = paginate(db, {
      select: PRODUCT_ROW_SELECT,
      from: 'products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id',
      where: 'WHERE ' + [...f.where, 'c.sale_type = ?'].join(' AND '), params: [...f.params, type],
      order: 'ORDER BY p.id DESC', page: toInt(req.query.page, 1, 1), perPage: 50,
    });
    return res.render('admin/products', { title: page.title, query, result, games: null, saleType: type, base: page.base });
  }
  const own = mine ? ' AND p.owner_id = ' + Number(req.user.id) : '';
  const statusSql = (f.status ? ' AND p.status = ?' : " AND p.status != 'sold'") + own;
  const sp = f.status ? [f.status] : [];
  let games = db.prepare('SELECT id, name, image, color FROM games ORDER BY sort_order, id').all();
  const cats = db.prepare(`SELECT c.id, c.game_id, c.name, c.image, c.sale_type,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id${statusSql}) AS product_count,
      (SELECT MIN(price) FROM products p WHERE p.category_id = c.id AND p.status = 'available'${own}) AS min_price
    FROM categories c WHERE c.sale_type = ?${mine ? ` AND c.id IN (${inList(mine)})` : ''} ORDER BY c.sort_order, c.id`).all(...sp, type);
  games.forEach((g) => {
    g.cats = cats.filter((c) => c.game_id === g.id);
    g.product_count = g.cats.reduce((a, c) => a + c.product_count, 0);
  });
  if (mine) games = games.filter((g) => g.cats.length);
  res.render('admin/products', { title: page.title, query, result: null, games, saleType: type, base: page.base });
});

// Danh sách sản phẩm của 1 danh mục (HTML, tải bằng JS)
router.get('/products/rows', (req, res) => {
  const f = productFilter(req);
  const categoryId = toInt(req.query.category_id);
  const mine = sellerCats(req);
  if (mine) {
    if (!mine.includes(categoryId)) return res.status(403).send('<p class="a-empty">Bạn không được bán ở danh mục này</p>');
    f.where.push('p.owner_id = ?'); f.params.push(req.user.id);
  }
  const result = paginate(db, {
    select: PRODUCT_ROW_SELECT,
    from: 'products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id',
    where: 'WHERE ' + ['p.category_id = ?', ...f.where].join(' AND '), params: [categoryId, ...f.params],
    order: 'ORDER BY p.sort_order, p.id DESC', page: toInt(req.query.page, 1, 1), perPage: 50,
  });
  res.render('admin/partials/product-rows', { rows: result.rows, result, categoryId, showCategory: false, sortable: !f.status && req.perm !== 'seller' });
});

function loadProductForForm(id) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!p) return null;
  p.attrList = H.parseJSON(p.attributes, []);
  p.imageList = H.parseJSON(p.images, []);
  p.credentials = decrypt(p.credentials_enc);
  if (p.type === 'stock') p.stockLeft = db.prepare('SELECT COUNT(*) c FROM product_stock WHERE product_id = ? AND is_sold = 0').get(p.id).c;
  return p;
}

const categoryInfo = (id) => db.prepare(`SELECT c.id, c.name, c.sale_type, g.name AS game_name
  FROM categories c JOIN games g ON g.id = c.game_id WHERE c.id = ?`).get(id);

// Tách "Tài khoản: x / Mật khẩu: y / phần còn lại" để sửa trong 2 ô riêng
function splitCredentials(text) {
  const lines = String(text || '').split(/\r?\n/);
  const pick = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) return '';
    const v = lines[i].replace(re, '').trim();
    lines.splice(i, 1);
    return v;
  };
  const user = pick(/^\s*(tài khoản|tai khoan|tk|user(name)?|account)\s*[:：]\s*/i);
  const pass = pick(/^\s*(mật khẩu|mat khau|mk|pass(word)?)\s*[:：]\s*/i);
  return { user, pass, extra: lines.join('\n').trim() };
}
function joinCredentials(user, pass, extra) {
  return [`Tài khoản: ${user}`, `Mật khẩu: ${pass}`, extra].filter(Boolean).join('\n');
}

router.get('/products/form', (req, res) => {
  const p = req.query.id ? loadProductForForm(toInt(req.query.id))
    : { status: 'available', attrList: [], imageList: [], category_id: toInt(req.query.category_id) };
  if (!p) return res.status(404).send('<p class="a-empty">Không tìm thấy sản phẩm</p>');
  if (req.perm === 'seller' && (p.id ? !ownsProduct(req, p) : !sellerCats(req).includes(p.category_id))) return res.status(403).send('<p class="a-empty">Bạn không có quyền với sản phẩm / danh mục này</p>');
  const cat = categoryInfo(p.category_id);
  if (!cat) return res.status(404).send('<p class="a-empty">Không tìm thấy danh mục</p>');
  if (!p.id) p.type = cat.sale_type === 'reroll' ? 'stock' : 'account';
  if (p.type === 'account') Object.assign(p, splitCredentials(p.credentials));
  modal(res, 'product-form', { p, cat, attrs: loadAttributes() });
});

router.get('/products/new', (req, res) => res.redirect('/admin/products'));

// Trang riêng để quản lý kho mã (thẻ game / acc random)
router.get('/products/:id/edit', (req, res, next) => {
  const p = loadProductForForm(toInt(req.params.id));
  if (!p) return next();
  if (!ownsProduct(req, p)) return denied(res);
  let stock = null;
  if (p.type === 'stock') {
    stock = paginate(db, {
      select: 'id, data_enc, is_sold, order_id, created_at', from: 'product_stock', where: 'WHERE product_id = ?', params: [p.id],
      order: 'ORDER BY is_sold, id DESC', page: toInt(req.query.page, 1, 1), perPage: 50,
    });
    stock.rows.forEach((s) => { s.data = decrypt(s.data_enc); });
    stock.left = p.stockLeft;
  }
  res.render('admin/product-form', { title: 'Sửa sản phẩm', p, categories: categoryOptions(req), stock, query: {} });
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
  if (!title || price < 0 || !db.prepare("SELECT 1 FROM categories WHERE id = ? AND sale_type IN ('vip','reroll')").get(categoryId)) {
    return back(req, res, 'error', 'Vui lòng nhập tên, giá và chọn danh mục');
  }
  if (req.perm === 'seller' && ((old && !ownsProduct(req, old)) || !sellerCats(req).includes(categoryId))) return back(req, res, 'error', 'Bạn không có quyền với sản phẩm / danh mục này');
  const cat = categoryInfo(categoryId);
  // Loại sản phẩm do loại danh mục quyết định: VIP -> acc bán 1 lần, Reroll -> kho nhiều acc
  const type = old ? old.type : (cat.sale_type === 'reroll' ? 'stock' : 'account');
  const code = str(req.body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '') || old?.code || randomCode(8);
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

  const status = ['available', 'sold', 'hidden'].includes(req.body.status) ? req.body.status : 'available';
  const oldPrice = toInt(req.body.old_price, 0, 0) || null;
  let credEnc = old?.credentials_enc || null;
  if (type === 'account') {
    let credRaw;
    if (req.body.acc_user !== undefined || req.body.acc_pass !== undefined) {
      const user = str(req.body.acc_user, 200);
      const pass = str(req.body.acc_pass, 200);
      if (!user || !pass) return back(req, res, 'error', 'Vui lòng nhập đủ Tài khoản và Mật khẩu của acc');
      credRaw = joinCredentials(user, pass, String(req.body.acc_extra || '').slice(0, 3000).trim());
    } else {
      credRaw = String(req.body.credentials || '').slice(0, 5000).trim(); // trang quản lý kho cũ
    }
    if (credRaw && credRaw !== decrypt(old?.credentials_enc)) credEnc = encrypt(credRaw);
    if (!credRaw) credEnc = null;
    if (!credEnc && status === 'available') return back(req, res, 'error', 'Acc cần nhập thông tin đăng nhập để giao cho khách');
  } else if (!old && !String(req.body.stock_lines || '').trim()) {
    return back(req, res, 'error', 'Vui lòng nhập ít nhất 1 acc (mỗi dòng: tài khoản | mật khẩu)');
  }
  const data = [categoryId, code, title, price, oldPrice, JSON.stringify(images), JSON.stringify(parseAttrs(req.body)),
    str(req.body.description, 5000), credEnc, status, bool(req.body.is_featured)];
  let pid = id;
  if (old) {
    db.prepare(`UPDATE products SET category_id=?, code=?, title=?, price=?, old_price=?, images=?, attributes=?, description=?,
      credentials_enc=?, status=?, is_featured=?, updated_at=unixepoch() WHERE id=?`).run(...data, id);
  } else {
    pid = db.prepare(`INSERT INTO products(category_id, code, title, price, old_price, images, attributes, description, credentials_enc, status, is_featured, type, owner_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...data, type, req.perm === 'seller' ? req.user.id : null).lastInsertRowid;
  }
  let msg = old ? 'Đã cập nhật sản phẩm' : 'Đã thêm sản phẩm';
  if (type === 'stock' && req.body.stock_lines) {
    const r = addStockLines(pid, req.body.stock_lines);
    msg += `. Thêm ${r.added} mã vào kho${r.dup ? `, bỏ qua ${r.dup} mã trùng` : ''}`;
  }
  audit(req, old ? 'product_update' : 'product_create', `${code} ${title}`);
  back(req, res, 'success', msg, productsBase(cat.sale_type));
});

router.post('/products/:id/duplicate', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(toInt(req.params.id));
  if (!ownsProduct(req, p)) return back(req, res, 'error', 'Không tìm thấy');
  // Bản sao ở trạng thái ẩn, không sao chép thông tin đăng nhập / kho mã (tránh bán trùng 1 acc)
  db.prepare(`INSERT INTO products(category_id, code, title, type, price, old_price, images, attributes, description, status, sort_order, owner_id)
    VALUES(?,?,?,?,?,?,?,?,?,'hidden',?,?)`).run(p.category_id, randomCode(8), p.title + ' (bản sao)', p.type, p.price, p.old_price,
    '[]', p.attributes, p.description, p.sort_order, p.owner_id);
  audit(req, 'product_duplicate', p.code);
  back(req, res, 'success', 'Đã nhân bản (đang ẩn). Hãy sửa, thêm ảnh và thông tin đăng nhập rồi bật hiển thị.');
});

router.post('/products/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(toInt(req.params.id));
  if (!ownsProduct(req, p)) return back(req, res, 'error', 'Không tìm thấy');
  if (p.status === 'sold' || p.sold_count > 0) return back(req, res, 'error', 'Sản phẩm đã có đơn bán, hãy tắt hiển thị thay vì xóa');
  H.parseJSON(p.images, []).forEach(removeImage);
  db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  audit(req, 'product_delete', p.code);
  back(req, res, 'success', 'Đã xóa sản phẩm');
});

router.post('/products/:id/stock', (req, res) => {
  const p = db.prepare("SELECT id, code, owner_id, category_id FROM products WHERE id = ? AND type = 'stock'").get(toInt(req.params.id));
  if (!ownsProduct(req, p)) return back(req, res, 'error', 'Không tìm thấy sản phẩm kho');
  const r = addStockLines(p.id, req.body.stock_lines);
  audit(req, 'stock_import', `${p.code} +${r.added}`);
  back(req, res, 'success', `Đã thêm ${r.added} mã${r.dup ? `, bỏ qua ${r.dup} mã trùng` : ''}`);
});

router.post('/stock/:sid/delete', (req, res) => {
  if (req.perm === 'seller' && !ownsProduct(req, db.prepare('SELECT p.owner_id, p.category_id FROM product_stock s JOIN products p ON p.id = s.product_id WHERE s.id = ?').get(toInt(req.params.sid)))) return back(req, res, 'error', 'Không tìm thấy');
  const r = db.prepare('DELETE FROM product_stock WHERE id = ? AND is_sold = 0').run(toInt(req.params.sid));
  back(req, res, r.changes ? 'success' : 'error', r.changes ? 'Đã xóa mã' : 'Không thể xóa mã đã bán');
});

router.post('/products/bulk', (req, res) => {
  let ids = [].concat(req.body.ids || []).map((x) => toInt(x)).filter(Boolean).slice(0, 500);
  const action = req.body.action;
  if (req.perm === 'seller' && ids.length) {
    ids = db.prepare(`SELECT id, owner_id, category_id FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).filter((p) => ownsProduct(req, p)).map((p) => p.id);
    if (action === 'feature' || action === 'unfeature') return back(req, res, 'error', 'Bạn không có quyền đặt sản phẩm nổi bật');
  }
  if (!ids.length) return back(req, res, 'error', 'Chưa chọn sản phẩm');
  const ph = ids.map(() => '?').join(',');
  let n = 0;
  if (action === 'hide') n = db.prepare(`UPDATE products SET status = 'hidden' WHERE status = 'available' AND id IN (${ph})`).run(...ids).changes;
  else if (action === 'show') n = db.prepare(`UPDATE products SET status = 'available' WHERE status = 'hidden' AND id IN (${ph})`).run(...ids).changes;
  else if (action === 'feature') n = db.prepare(`UPDATE products SET is_featured = 1 WHERE id IN (${ph})`).run(...ids).changes;
  else if (action === 'unfeature') n = db.prepare(`UPDATE products SET is_featured = 0 WHERE id IN (${ph})`).run(...ids).changes;
  else if (action === 'delete') {
    const rows = db.prepare(`SELECT id, images FROM products WHERE status != 'sold' AND sold_count = 0 AND id IN (${ph})`).all(...ids);
    rows.forEach((r) => H.parseJSON(r.images, []).forEach(removeImage));
    n = db.prepare(`DELETE FROM products WHERE status != 'sold' AND sold_count = 0 AND id IN (${ph})`).run(...ids).changes;
  }
  audit(req, 'product_bulk_' + action, ids.join(','));
  back(req, res, 'success', `Đã xử lý ${n} sản phẩm`);
});

// Nhập nhiều acc cùng lúc vào 1 danh mục: mỗi dòng "tên|giá|thông tin đăng nhập"
router.get('/products/import-form', (req, res) => {
  const cat = categoryInfo(toInt(req.query.category_id));
  if (!cat || (req.perm === 'seller' && !sellerCats(req).includes(cat.id))) return res.status(404).send('<p class="a-empty">Không tìm thấy danh mục</p>');
  modal(res, 'import-form', { cat });
});

router.post('/products/import', (req, res) => {
  const categoryId = toInt(req.body.category_id);
  const icat = categoryInfo(categoryId);
  if (!icat || (req.perm === 'seller' && !sellerCats(req).includes(categoryId))) return back(req, res, 'error', 'Không tìm thấy danh mục');
  if (icat.sale_type !== 'vip') return back(req, res, 'error', 'Nhập nhiều acc chỉ dùng cho danh mục VIP. Với Reroll, hãy thêm acc vào kho của sản phẩm.');
  const lines = String(req.body.lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 2000);
  const ins = db.prepare(`INSERT INTO products(category_id, code, title, price, credentials_enc, type, owner_id) VALUES(?,?,?,?,?,'account',${req.perm === 'seller' ? Number(req.user.id) : 'NULL'})`);
  let ok = 0, bad = 0;
  db.transaction(() => {
    for (const l of lines) {
      const [title, price, ...cred] = l.split('|');
      const pr = toInt(price, -1);
      if (!title || pr < 0 || !cred.join('|').trim()) { bad++; continue; }
      // "Tên|Giá|Tài khoản|Mật khẩu|Ghi chú..." -> lưu dạng Tài khoản / Mật khẩu như form thêm lẻ
      const [u, pw, ...rest] = cred.map((x) => x.trim());
      const text = pw ? joinCredentials(u, pw, rest.join(' | ')) : cred.join('|').trim().replace(/\\n/g, '\n');
      ins.run(categoryId, randomCode(8), str(title, 200), pr, encrypt(text));
      ok++;
    }
  })();
  audit(req, 'product_import', `cat ${categoryId}: ${ok}`);
  back(req, res, 'success', `Đã nhập ${ok} acc${bad ? `, ${bad} dòng lỗi định dạng` : ''}`);
});

// ======================= THUỘC TÍNH (tên + nhiều giá trị, dùng khi thêm sản phẩm) =======================
function loadAttributes() {
  return db.prepare('SELECT * FROM attributes ORDER BY sort_order, id').all()
    .map((a) => ({ ...a, values: H.parseJSON(a.values_json, []) }));
}
function parseValues(text) {
  const seen = new Set();
  return String(text || '').split(/\r?\n|,/).map((v) => str(v, 100)).filter((v) => {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 200);
}

router.get('/attributes', (req, res) => res.render('admin/attributes', { title: 'Thuộc tính', attrs: loadAttributes() }));

router.get('/attributes/form', (req, res) => {
  const a = req.query.id ? loadAttributes().find((x) => x.id === toInt(req.query.id)) : null;
  modal(res, 'attribute-form', { a });
});

router.post('/attributes/save', (req, res) => {
  const id = toInt(req.body.id);
  const name = str(req.body.name, 60);
  const values = parseValues(req.body.values);
  if (!name) return back(req, res, 'error', 'Vui lòng nhập tên thuộc tính');
  if (!values.length) return back(req, res, 'error', 'Vui lòng nhập ít nhất 1 giá trị');
  if (db.prepare('SELECT id FROM attributes WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id)) return back(req, res, 'error', 'Tên thuộc tính đã tồn tại');
  if (id) db.prepare('UPDATE attributes SET name = ?, values_json = ? WHERE id = ?').run(name, JSON.stringify(values), id);
  else {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM attributes').get().n;
    db.prepare('INSERT INTO attributes(name, values_json, sort_order) VALUES(?,?,?)').run(name, JSON.stringify(values), next);
  }
  audit(req, id ? 'attribute_update' : 'attribute_create', name);
  back(req, res, 'success', id ? 'Đã cập nhật thuộc tính' : 'Đã thêm thuộc tính', '/admin/attributes');
});

router.post('/attributes/:id/delete', (req, res) => {
  const a = db.prepare('SELECT name FROM attributes WHERE id = ?').get(toInt(req.params.id));
  if (a) { db.prepare('DELETE FROM attributes WHERE id = ?').run(toInt(req.params.id)); audit(req, 'attribute_delete', a.name); }
  back(req, res, 'success', 'Đã xóa thuộc tính (sản phẩm đã gắn vẫn giữ nguyên)', '/admin/attributes');
});

router.post('/attributes/:id/move', (req, res) => {
  const ids = db.prepare('SELECT id FROM attributes ORDER BY sort_order, id').all().map((r) => r.id);
  const id = toInt(req.params.id);
  const i = ids.indexOf(id);
  const j = req.body.dir === 'up' ? i - 1 : i + 1;
  let ok = false;
  if (i >= 0 && j >= 0 && j < ids.length) {
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const upd = db.prepare('UPDATE attributes SET sort_order = ? WHERE id = ?');
    db.transaction(() => ids.forEach((x, k) => upd.run(k, x)))();
    ok = true;
  }
  if (req.get('x-csrf-token')) return res.json({ ok });
  back(req, res, ok ? 'success' : 'error', ok ? null : 'Không thể di chuyển', '/admin/attributes');
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
  const it = db.prepareFresh(`SELECT o.*, u.username FROM ${f.table} o LEFT JOIN users u ON u.id = o.user_id ${f.where} ORDER BY o.id DESC`).iterate(...f.params);
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
  o.delivered = require('../utils/helpers').formatDelivered(decrypt(o.delivered_enc));
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

// CTV quản lý không được thao tác lên tài khoản admin, quản lý khác hoặc chính mình (VD tự cộng tiền)
const managerCantTouch = (req, id) => {
  if (req.perm !== 'manager') return false;
  const t = db.prepare('SELECT role, ctv_role FROM users WHERE id = ?').get(id);
  return !t || t.role === 'admin' || t.ctv_role === 'manager' || id === req.user.id;
};
router.post(['/users/:id/balance', '/users/:id/ban', '/users/:id/reset-password', '/users/:id/unlock'], (req, res, next) => (managerCantTouch(req, toInt(req.params.id)) ? back(req, res, 'error', 'Bạn không có quyền thao tác trên tài khoản này') : next()));

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
  if (r.ok) audit(req, 'deposit_approve', `nạp #${id}: ${amount}`);
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
  res.render('admin/coupons', { title: 'Mã giảm giá', coupons, edit, games: db.prepare('SELECT id, name FROM games ORDER BY sort_order').all(),
    layout: H.couponLayout(getSettings()), serverNow: Math.floor(Date.now() / 1000) });
});

// Kích cỡ thẻ mã + số mã mỗi hàng ngoài web
router.post('/coupons/layout', (req, res) => {
  const w = toInt(req.body.w, 0, 0, 4000), h = toInt(req.body.h, 0, 0, 4000);
  const pc = toInt(req.body.cols_pc, 0, 0, 6), m = toInt(req.body.cols_m, 0, 0, 3);
  if (w < 100 || h < 50 || w / h > 6 || h / w > 3) return back(req, res, 'error', 'Kích cỡ không hợp lệ (rộng ≥ 100, cao ≥ 50, tỉ lệ hợp lý)', '/admin/coupons');
  if (pc < 1 || m < 1) return back(req, res, 'error', 'Số mã mỗi hàng không hợp lệ', '/admin/coupons');
  setSetting('coupon_size', `${w}x${h}`);
  setSetting('coupon_cols_pc', String(pc));
  setSetting('coupon_cols_m', String(m));
  require('./public').clearCache?.();
  audit(req, 'coupon_layout', `${w}x${h} ${pc}/${m}`);
  back(req, res, 'success', `Đã lưu: thẻ ${w}×${h}, PC ${pc} mã/hàng, điện thoại ${m} mã/hàng`, '/admin/coupons');
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
    H.fromInputDate(req.body.starts_at), H.fromInputDate(req.body.expires_at), bool(req.body.is_public), bool(req.body.is_active),
    ['acc', 'boost', 'topup'].includes(req.body.scope) ? req.body.scope : 'all'];
  if (id) db.prepare(`UPDATE coupons SET code=?, description=?, type=?, value=?, max_discount=?, min_order=?, game_id=?, usage_limit=?,
      per_user_limit=?, starts_at=?, expires_at=?, is_public=?, is_active=?, scope=? WHERE id=?`).run(...data, id);
  else db.prepare(`INSERT INTO coupons(code, description, type, value, max_discount, min_order, game_id, usage_limit, per_user_limit,
      starts_at, expires_at, is_public, is_active, scope) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...data);
  require('../services/coupon').clearCouponCache();
  audit(req, id ? 'coupon_update' : 'coupon_create', code);
  back(req, res, 'success', 'Đã lưu mã giảm giá', '/admin/coupons');
});

router.post('/coupons/:id/delete', (req, res) => {
  db.prepare('DELETE FROM coupons WHERE id = ?').run(toInt(req.params.id));
  require('../services/coupon').clearCouponCache();
  audit(req, 'coupon_delete', req.params.id);
  back(req, res, 'success', 'Đã xóa mã', '/admin/coupons');
});

// ======================= BỐ CỤC TRANG CHỦ =======================
// Link khi bấm banner: chỉ nhận đường dẫn nội bộ hoặc http(s) (chặn javascript:...)
const safeLink = (u) => { u = str(u, 300); return /^(\/(?!\/)|https?:\/\/)/i.test(u) ? u : ''; };
const HOME_BLOCK_INFO = {
  slider: { name: 'Banner slider', icon: 'image', images: true, desc: 'Ảnh lớn tự chuyển, có nút trái/phải. Hợp đặt đầu trang.', def: { w: 1200, h: 450 } },
  strip: { name: 'Dải ảnh chạy', icon: 'layers', images: true, desc: 'Hàng ảnh nhỏ trôi ngang liên tục.', def: { w: 600, h: 300 } },
  banner: { name: 'Khối banner', icon: 'image', images: true, desc: 'Ảnh đứng yên, chọn số ảnh mỗi hàng (1–6). Hợp chèn giữa các phần.', def: { w: 1200, h: 400, cols_pc: 2, cols_m: 1 } },
  games: { name: 'Danh mục game', icon: 'gamepad', desc: 'Thẻ các game kèm số acc đang bán / đã bán. Chọn hiện tất cả hoặc vài game.', title: 'Danh mục game' },
  coupons: { name: 'Mã khuyến mãi', icon: 'gift', desc: 'Thẻ mã giảm giá đang chạy, bấm để sao chép.', title: 'Mã khuyến mãi', def: { limit: 8 } },
  featured: { name: 'Danh sách acc', icon: 'star', desc: 'Lưới acc theo nguồn: nổi bật, mới nhất, bán chạy, giá rẻ… lọc theo game / danh mục.', title: 'Acc nổi bật', def: { source: 'featured', limit: 12 } },
  boost: { name: 'Cày thuê nổi bật', icon: 'g-swords', desc: 'Các gói cày thuê bán chạy / mới nhất, bấm vào mở trang gói. Chọn tất cả hoặc 1 game.', title: 'Cày thuê nổi bật', def: { source: 'bestseller', limit: 8 } },
  posts: { name: 'Bài viết mới', icon: 'g-book', desc: 'Các bài Tin tức / Hướng dẫn mới nhất, chọn 1 chuyên mục hoặc tất cả.', title: 'Tin tức & Hướng dẫn', def: { limit: 4 } },
  recent: { name: 'Giao dịch gần đây', icon: 'bag', desc: 'Các đơn mua mới nhất (tên khách được che bớt).', title: 'Giao dịch gần đây', def: { limit: 10 } },
};
const BOOST_SOURCES = { bestseller: 'Thuê nhiều nhất', newest: 'Gói mới thêm', cheap: 'Giá rẻ nhất' };
const PRODUCT_SOURCES = { featured: 'Acc được đánh dấu Nổi bật (xáo ngẫu nhiên)', newest: 'Acc mới đăng', bestseller: 'Bán chạy nhất', cheap: 'Giá rẻ nhất', random: 'Ngẫu nhiên' };

function blockSummary(b) {
  const st = b.settings, info = b.info;
  if (info.images) return `${b.item_count} ảnh · tỉ lệ ${st.w || info.def.w}×${st.h || info.def.h}` + (b.type === 'banner' ? ` · ${st.cols_pc || 1} ảnh/hàng trên PC, ${st.cols_m || 1} trên điện thoại` : '');
  if (b.type === 'games') return (st.game_ids || []).length ? `${st.game_ids.length} game được chọn` : 'Tất cả game đang bật';
  if (b.type === 'coupons') return `Tối đa ${st.limit || 8} mã`;
  if (b.type === 'featured') return `${PRODUCT_SOURCES[st.source || 'featured']} · tối đa ${st.limit || 12} acc`;
  if (b.type === 'recent') return `${st.limit || 10} đơn mới nhất`;
  if (b.type === 'posts') return `${st.limit || 4} bài mới nhất`;
  if (b.type === 'boost') return `${(BOOST_SOURCES[st.source] || BOOST_SOURCES.bestseller)} · tối đa ${st.limit || 8} gói`;
  return '';
}

router.get('/home-layout', (req, res) => {
  const blocks = db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM home_block_items i WHERE i.block_id = b.id) AS item_count,
      (SELECT image FROM home_block_items i WHERE i.block_id = b.id ORDER BY sort_order, id LIMIT 1) AS thumb
    FROM home_blocks b ORDER BY b.sort_order, b.id`).all()
    .map((b) => ({ ...b, settings: H.parseJSON(b.settings, {}), info: HOME_BLOCK_INFO[b.type] || { name: b.type, icon: 'box' } }))
    .map((b) => ({ ...b, summary: blockSummary(b) }));
  res.render('admin/home-layout', { title: 'Bố cục trang chủ', blocks });
});

// Bước 1 khi thêm: chọn loại khối
router.get('/home-blocks/new', (req, res) => modal(res, 'home-block-types', { types: HOME_BLOCK_INFO }));

// Bước 2: form cài đặt (thêm mới theo ?type= hoặc sửa theo ?id=)
router.get('/home-blocks/form', (req, res) => {
  const b = req.query.id ? db.prepare('SELECT * FROM home_blocks WHERE id = ?').get(toInt(req.query.id)) : null;
  if (req.query.id && !b) return res.status(404).send('<p class="a-empty">Không tìm thấy khối</p>');
  const type = b ? b.type : req.query.type;
  const info = HOME_BLOCK_INFO[type];
  if (!info) return res.status(404).send('<p class="a-empty">Loại khối không hợp lệ</p>');
  modal(res, 'home-block-form', {
    b, type, info, sources: PRODUCT_SOURCES, boostSources: BOOST_SOURCES,
    settings: b ? { ...(info.def || {}), ...H.parseJSON(b.settings, {}) } : { ...(info.def || {}) },
    items: b ? db.prepare('SELECT * FROM home_block_items WHERE block_id = ? ORDER BY sort_order, id').all(b.id) : [],
    games: db.prepare('SELECT id, name FROM games ORDER BY sort_order, id').all(),
    postCats: type === 'posts' ? db.prepare('SELECT id, name FROM post_categories ORDER BY sort_order, id').all() : [],
    categories: type === 'featured' ? db.prepare("SELECT c.id, c.name, g.name AS game FROM categories c JOIN games g ON g.id = c.game_id WHERE c.sale_type IN ('vip','reroll') ORDER BY g.sort_order, c.sort_order").all() : [],
  });
});

function blockSettingsFromBody(type, body, info) {
  const st = { show_title: bool(body.show_title) };
  if (info.images) {
    st.w = toInt(body.w, info.def.w, 100, 4000);
    st.h = toInt(body.h, info.def.h, 50, 4000);
    if (type === 'banner') { st.cols_pc = toInt(body.cols_pc, 1, 1, 6); st.cols_m = toInt(body.cols_m, 1, 1, 3); }
  } else if (type === 'games') {
    st.game_ids = [].concat(body.game_ids || []).map((x) => toInt(x)).filter(Boolean).slice(0, 100);
  } else if (type === 'coupons') {
    st.limit = toInt(body.limit, 8, 1, 50); st.game_id = toInt(body.game_id, 0, 0) || null;
  } else if (type === 'featured') {
    st.source = PRODUCT_SOURCES[body.source] ? body.source : 'featured';
    st.limit = toInt(body.limit, 12, 1, 48);
    st.game_id = toInt(body.game_id, 0, 0) || null;
    st.category_id = toInt(body.category_id, 0, 0) || null;
  } else if (type === 'recent') {
    st.limit = toInt(body.limit, 10, 1, 30);
  } else if (type === 'posts') {
    st.limit = toInt(body.limit, 4, 1, 12);
    st.category_id = toInt(body.category_id, 0, 0) || null;
  } else if (type === 'boost') {
    st.source = BOOST_SOURCES[body.source] ? body.source : 'bestseller';
    st.limit = toInt(body.limit, 8, 1, 48);
    st.game_id = toInt(body.game_id, 0, 0) || null;
  }
  return JSON.stringify(st);
}

router.post('/home-blocks/save', (req, res) => {
  const id = toInt(req.body.id);
  const old = id ? db.prepare('SELECT * FROM home_blocks WHERE id = ?').get(id) : null;
  if (id && !old) return back(req, res, 'error', 'Không tìm thấy khối', '/admin/home-layout');
  const type = old ? old.type : req.body.type;
  const info = HOME_BLOCK_INFO[type];
  if (!info) return back(req, res, 'error', 'Loại khối không hợp lệ', '/admin/home-layout');
  const title = str(req.body.title, 120);
  const settings = blockSettingsFromBody(type, req.body, info);
  const current = old && info.images ? db.prepare('SELECT * FROM home_block_items WHERE block_id = ? ORDER BY sort_order, id').all(id) : [];
  const removing = current.filter((it) => req.body['remove_' + it.id]);
  const files = info.images ? filesOf(req, 'images') : [];
  if (info.images && !files.length && current.length - removing.length <= 0) return back(req, res, 'error', 'Khối này cần ít nhất 1 ảnh', '/admin/home-layout');
  const saved = [];
  for (const f of files.slice(0, 20)) {
    const p = saveImage(f, 'blocks');
    if (!p) { saved.forEach(removeImage); return back(req, res, 'error', 'Có file ảnh không hợp lệ', '/admin/home-layout'); }
    saved.push(p);
  }
  let blockId = id;
  db.transaction(() => {
    if (old) db.prepare('UPDATE home_blocks SET title = ?, settings = ? WHERE id = ?').run(title, settings, id);
    else {
      const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM home_blocks').get().n;
      blockId = db.prepare('INSERT INTO home_blocks(type, title, settings, sort_order) VALUES(?, ?, ?, ?)').run(type, title, settings, next).lastInsertRowid;
    }
    if (!info.images) return;
    const upd = db.prepare('UPDATE home_block_items SET link = ?, sort_order = ?, is_active = ? WHERE id = ?');
    current.forEach((it) => { if (!req.body['remove_' + it.id]) upd.run(safeLink(req.body['link_' + it.id]), toInt(req.body['order_' + it.id], it.sort_order, 0, 999), req.body['hide_' + it.id] ? 0 : 1, it.id); });
    const del = db.prepare('DELETE FROM home_block_items WHERE id = ?');
    removing.forEach((it) => del.run(it.id));
    const base = current.length ? Math.max(...current.map((it) => it.sort_order)) + 1 : 0;
    const ins = db.prepare('INSERT INTO home_block_items(block_id, image, link, sort_order) VALUES(?,?,?,?)');
    saved.forEach((p, k) => ins.run(blockId, p, safeLink(req.body.new_link), base + k));
  })();
  removing.forEach((it) => removeImage(it.image));
  audit(req, old ? 'home_block_update' : 'home_block_create', `${type} ${title}`);
  back(req, res, 'success', old ? 'Đã lưu khối' : `Đã thêm khối “${title || info.name}” (nằm cuối trang, kéo nút ⠿ để đổi vị trí)`, '/admin/home-layout');
});

router.post('/home-blocks/:id/delete', (req, res) => {
  const b = db.prepare('SELECT * FROM home_blocks WHERE id = ?').get(toInt(req.params.id));
  if (!b) return back(req, res, 'error', 'Không tìm thấy khối', '/admin/home-layout');
  const imgs = db.prepare('SELECT image FROM home_block_items WHERE block_id = ?').all(b.id);
  db.prepare('DELETE FROM home_blocks WHERE id = ?').run(b.id);
  imgs.forEach((r) => removeImage(r.image));
  audit(req, 'home_block_delete', `${b.type} ${b.title}`);
  back(req, res, 'success', 'Đã xóa khối', '/admin/home-layout');
});

// ======================= BANNER / SIDEBAR =======================
// Banner chính & dải ảnh chạy nay nằm trong Bố cục trang chủ (mỗi khối tự giữ ảnh)
const BANNER_POSITIONS = ['sidebar_left', 'sidebar_right'];

router.get('/banners', (req, res) => {
  const banners = db.prepare('SELECT * FROM banners ORDER BY sort_order, id').all();
  const st = getSettings();
  const sizes = Object.fromEntries(BANNER_POSITIONS.map((p) => [p, H.bannerSize(st, p)]));
  res.render('admin/banners', { title: 'Banner & Sidebar', banners, sizes });
});

// Lưu kích cỡ hiển thị của 1 vị trí banner (tự ghi nhớ cho lần sau)
router.post('/banners/size', (req, res) => {
  const pos = BANNER_POSITIONS.includes(req.body.position) ? req.body.position : null;
  const w = toInt(req.body.w, 0, 0, 4000);
  const h = toInt(req.body.h, 0, 0, 4000);
  const ok = !!pos && w >= 50 && h >= 50;
  if (ok) { setSetting('banner_size_' + pos, `${w}x${h}`); audit(req, 'banner_size', `${pos} ${w}x${h}`); }
  if (req.get('x-csrf-token')) return res.json(ok ? { ok, w, h } : { ok, message: 'Kích cỡ phải từ 50 đến 4000 px' });
  back(req, res, ok ? 'success' : 'error', ok ? 'Đã lưu kích cỡ' : 'Kích cỡ không hợp lệ', '/admin/banners');
});

router.get('/banners/form', (req, res) => {
  const b = req.query.id ? db.prepare('SELECT * FROM banners WHERE id = ?').get(toInt(req.query.id)) : null;
  const position = b ? b.position : (BANNER_POSITIONS.includes(req.query.position) ? req.query.position : 'sidebar_left');
  modal(res, 'banner-form', { b, position, size: H.bannerSize(getSettings(), position) });
});

router.post('/banners/save', (req, res) => {
  const id = toInt(req.body.id);
  const old = id ? db.prepare('SELECT * FROM banners WHERE id = ?').get(id) : null;
  const position = BANNER_POSITIONS.includes(req.body.position) ? req.body.position : 'sidebar_left';
  let image = old?.image;
  const f = fileOf(req, 'image');
  if (f) {
    const saved = saveImage(f, 'banners');
    if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ');
    if (old?.image) removeImage(old.image);
    image = saved;
  }
  if (!image) return back(req, res, 'error', 'Vui lòng chọn ảnh banner');
  let link = str(req.body.link, 300);
  if (link && !/^(\/(?!\/)|https?:\/\/)/i.test(link)) link = ''; // chặn javascript: URL
  const data = [position, str(req.body.title, 150), image, link, bool(req.body.is_active)];
  if (old) {
    db.prepare('UPDATE banners SET position=?, title=?, image=?, link=?, is_active=? WHERE id=?').run(...data, id);
  } else {
    const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM banners WHERE position = ?').get(position).n;
    db.prepare('INSERT INTO banners(position, title, image, link, is_active, sort_order) VALUES(?,?,?,?,?,?)').run(...data, next);
  }
  audit(req, old ? 'banner_update' : 'banner_create', position);
  back(req, res, 'success', old ? 'Đã cập nhật banner' : 'Đã thêm banner', '/admin/banners');
});

router.post('/banners/:id/delete', (req, res) => {
  const b = db.prepare('SELECT * FROM banners WHERE id = ?').get(toInt(req.params.id));
  if (b) { db.prepare('DELETE FROM banners WHERE id = ?').run(b.id); removeImage(b.image); audit(req, 'banner_delete', b.position); }
  back(req, res, 'success', 'Đã xóa banner', '/admin/banners');
});

// ======================= FOOTER =======================
const FOOTER_KEYS = ['footer_about_title', 'footer_about_text', 'footer_col1_title', 'footer_col1_links', 'footer_col2_title',
  'footer_col2_links', 'footer_col3_title', 'footer_col3_links', 'social_facebook', 'social_zalo', 'social_tiktok',
  'social_youtube', 'social_telegram', 'footer_text'];

// ======================= HỖ TRỢ (nút / thanh liên hệ nhanh) =======================
// ======================= POPUP =======================
const popupSvc = require('../services/popup');
const { sanitizeRich } = require('../services/posts');
router.get('/popup', (req, res) => res.render('admin/popup', { title: 'Popup', cfg: popupSvc.config() }));
router.post('/popup', (req, res) => {
  const b = req.body; const old = popupSvc.config();
  const color = (v, d) => (popupSvc.HEX.test(v || '') ? v : d);
  const link = (v) => { const u = str(v, 300).trim(); return popupSvc.SAFE_LINK.test(u) ? u : ''; };
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const D = popupSvc.DEFAULTS;
  let image = old.image;
  const f = fileOf(req, 'popup_image');
  if (f) {
    const saved = saveImage(f, 'banners');
    if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ', '/admin/popup');
    if (old.image) removeImage(old.image);
    image = saved;
  } else if (b.remove_image && old.image) { removeImage(old.image); image = ''; }
  const cfg = {
    enabled: !!bool(b.enabled), v: Date.now(), pages: pick(b.pages, ['home', 'all'], 'home'),
    delay: toInt(b.delay, 0, 0, 60), repeat: toInt(b.repeat, 12, 0, 720),
    width: toInt(b.width, D.width, 260, 1200),
    image, img_link: link(b.img_link), img_pos: pick(b.img_pos, ['top', 'bottom'], 'top'), img_style: pick(b.img_style, ['inset', 'full'], 'inset'), img_w: toInt(b.img_w, 100, 20, 100),
    img_rw: toInt(b.img_rw, 0, 0, 4000), img_rh: toInt(b.img_rh, 0, 0, 4000),
    title: str(b.title, 150), title_theme: !!bool(b.title_theme), title_color: color(b.title_color, D.title_color), title_size: toInt(b.title_size, D.title_size, 12, 60),
    title_align: pick(b.title_align, ['left', 'center', 'right'], 'center'),
    content: sanitizeRich(String(b.content || '').slice(0, 20000)),
    btn_text: str(b.btn_text, 60), btn_link: link(b.btn_link),
  };
  if (!cfg.img_rw || !cfg.img_rh) { cfg.img_rw = 0; cfg.img_rh = 0; }
  if (cfg.content.replace(/<[^>]+>|&nbsp;|\s/g, '') === '') cfg.content = '';
  setSetting('popup_cfg', JSON.stringify(cfg));
  audit(req, 'popup_update', cfg.enabled ? 'bật' : 'tắt');
  back(req, res, 'success', 'Đã lưu Popup', '/admin/popup');
});

const supportSvc = require('../services/support');
router.get('/support', (req, res) => res.render('admin/support', { title: 'Hỗ trợ', cfg: supportSvc.config(), TYPES: supportSvc.TYPES }));
router.post('/support', (req, res) => {
  const b = req.body;
  const arr = (k) => [].concat(b[k] ?? []);
  const types = arr('ch_type'); const titles = arr('ch_title'); const descs = arr('ch_desc'); const values = arr('ch_value'); const ons = arr('ch_on');
  const channels = types.slice(0, 20).map((t, i) => ({
    type: supportSvc.TYPES[t] ? t : 'website', title: str(titles[i], 40), desc: str(descs[i], 80), value: str(values[i], 300).trim(), on: ons[i] === '1',
  })).filter((c) => c.value || c.title);
  // link không hợp lệ (VD javascript:...) -> bỏ kênh đó, vẫn lưu các kênh còn lại
  const bad = [];
  for (let i = channels.length - 1; i >= 0; i--) {
    const c = channels[i]; const href = c.value ? supportSvc.TYPES[c.type].link(c.value) : '';
    if (href && !supportSvc.SAFE_LINK.test(href)) { bad.unshift(c.title || supportSvc.TYPES[c.type].name); channels.splice(i, 1); }
  }
  const cfg = {
    enabled: bool(b.enabled), mode: b.mode === 'side' ? 'side' : 'corner', side: b.side === 'left' ? 'left' : 'right',
    corner: ['tl', 'tr', 'bl', 'br'].includes(b.corner) ? b.corner : 'br', auto: toInt(b.auto, 2, 0, 60), once: bool(b.once),
    device: ['all', 'pc', 'mobile'].includes(b.device) ? b.device : 'all',
    title: str(b.title, 60) || 'Hỗ trợ nhanh', subtitle: str(b.subtitle, 80), label: str(b.label, 20) || 'Hỗ trợ',
    color: /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#2563eb', channels,
  };
  setSetting('support_cfg', JSON.stringify(cfg));
  audit(req, 'support_update', cfg.enabled ? 'bật' : 'tắt');
  back(req, res, bad.length ? 'error' : 'success', bad.length ? `Đã lưu. Bỏ kênh có đường dẫn không hợp lệ: ${bad.join(', ')}` : 'Đã lưu cài đặt Hỗ trợ', '/admin/support');
});

router.get('/footer', (req, res) => res.render('admin/footer', { title: 'Footer', s: getSettings() }));

router.post('/footer', (req, res) => {
  // Form mới: mỗi mục 1 dòng (tên + link) -> ghép lại thành "Tên | link" như cũ
  const badLinks = [];
  if (req.body.fc_rows) {
    for (const n of [1, 2, 3]) {
      const names = [].concat(req.body[`fc${n}_name`] ?? []); const urls = [].concat(req.body[`fc${n}_url`] ?? []);
      req.body[`footer_col${n}_links`] = names.slice(0, 30).map((nm, i) => {
        const text = str(nm, 120).replace(/\|/g, '/').trim(); let url = str(urls[i], 300).trim();
        if (url && !/^(\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(url)) { badLinks.push(text || url); url = ''; }
        return text ? (url ? `${text} | ${url}` : text) : '';
      }).filter(Boolean).join('\n');
    }
  }
  for (const k of FOOTER_KEYS) {
    let v = str(req.body[k], 3000);
    // Link mạng xã hội chỉ nhận http(s)
    if (k.startsWith('social_') && v && !/^https?:\/\//i.test(v)) v = k === 'social_zalo' && /^\d{8,12}$/.test(v) ? `https://zalo.me/${v}` : '';
    setSetting(k, v);
  }
  audit(req, 'footer_update');
  back(req, res, badLinks.length ? 'error' : 'success', badLinks.length ? `Đã lưu. Link không hợp lệ đã bỏ (chỉ nhận /trang, https://, mailto:, tel:): ${badLinks.join(', ')}` : 'Đã lưu footer', '/admin/footer');
});

// ======================= CÀI ĐẶT =======================
// --- Cài đặt thông tin: tên, logo, SEO, ảnh chia sẻ link, thông báo, hệ thống ---
const INFO_KEYS = ['site_name', 'site_slogan', 'site_description', 'seo_title', 'notice'];

router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Cài đặt thông tin', s: getSettings(), baseUrl: config.baseUrl }));

router.post('/settings', (req, res) => {
  for (const k of INFO_KEYS) if (req.body[k] !== undefined) setSetting(k, str(req.body[k], k === 'site_description' ? 300 : 2000));
  setSetting('maintenance_mode', bool(req.body.maintenance_mode));
  setSetting('allow_register', bool(req.body.allow_register));
  const st = getSettings();
  for (const [field, key, folder] of [['logo', 'logo', 'site'], ['favicon', 'favicon', 'site'], ['og_image', 'og_image', 'site']]) {
    const f = fileOf(req, field);
    if (f) {
      const saved = saveImage(f, folder);
      if (!saved) return back(req, res, 'error', 'File ảnh không hợp lệ', '/admin/settings');
      if (st[key]) removeImage(st[key]);
      setSetting(key, saved);
    } else if (req.body['remove_' + field] && st[key]) {
      removeImage(st[key]);
      setSetting(key, '');
    }
  }
  audit(req, 'settings_update');
  back(req, res, 'success', 'Đã lưu cài đặt thông tin', '/admin/settings');
});

// --- Cài đặt bank: tài khoản nhận tiền, hạn mức nạp ---
const BANK_KEYS = ['bank_code', 'bank_name', 'bank_account', 'bank_owner', 'deposit_min', 'deposit_max'];

router.get('/settings/bank', (req, res) => {
  // Secret Key cho webhook ký HMAC (NIFY): tự tạo lần đầu, admin copy dán sang bên cổng thanh toán
  // INSERT OR IGNORE thẳng vào DB: nhiều bản PM2 cùng mở trang cũng chỉ tạo đúng 1 key, không đè nhau
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('webhook_secret_enc', ?)").run(encrypt(crypto.randomBytes(24).toString('hex')));
  res.render('admin/settings-bank', renderBank());
});
const renderBank = () => ({
  title: 'Cài đặt bank', s: getSettings(), webhookUrl: config.baseUrl + '/api/bank/webhook',
  webhookSecret: decrypt(db.prepare("SELECT value FROM settings WHERE key = 'webhook_secret_enc'").get()?.value || ''), depositPrefix: config.depositPrefix,
  expireMinutes: maintenance.depositExpireMinutes(),
  pendingCount: db.prepare("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'").get().c,
  acnHasKey: !!getSettings().acn_key_enc, acnWindowMin: Math.ceil(require('../services/apicanhan').windowSec(require('../services/apicanhan').conf()) / 60),
});

router.post('/settings/bank', (req, res) => {
  for (const k of BANK_KEYS) if (req.body[k] !== undefined) setSetting(k, str(req.body[k], 200));
  setSetting('bank_owner', str(req.body.bank_owner, 100).toUpperCase());
  // Thời gian chờ nạp: 5 phút – 7 ngày
  const expMin = toInt(req.body.deposit_expire_minutes, 0, 0);
  if (expMin < 5 || expMin > 10080) return back(req, res, 'error', 'Thời gian chờ nạp phải từ 5 đến 10080 phút (7 ngày)', '/admin/settings/bank');
  setSetting('deposit_expire_minutes', String(expMin));
  setSetting('deposit_late_credit', req.body.deposit_late_credit ? '1' : '0');
  if (req.body.regen_secret) setSetting('webhook_secret_enc', encrypt(crypto.randomBytes(24).toString('hex')));
  // Nạp tự động: NIFY (webhook) và APICANHAN (quét giao dịch)
  setSetting('nify_enabled', req.body.nify_enabled ? '1' : '0');
  setSetting('acn_enabled', req.body.acn_enabled ? '1' : '0');
  const acnKey = String(req.body.acn_key || '').trim();
  if (acnKey) {
    if (!/^[A-Za-z0-9_\-.]{8,200}$/.test(acnKey)) return back(req, res, 'error', 'ApiKey APICANHAN không hợp lệ', '/admin/settings/bank');
    setSetting('acn_key_enc', encrypt(acnKey));
  }
  if (req.body.acn_clear_key) setSetting('acn_key_enc', '');
  setSetting('acn_bank', ['ACBnew', 'MB'].includes(req.body.acn_bank) ? req.body.acn_bank : 'ACBnew');
  setSetting('acn_interval', String(toInt(req.body.acn_interval, 5, 3, 120)));
  setSetting('acn_extra_pct', String(toInt(req.body.acn_extra_pct, 20, 0, 300)));
  maintenance.expireDeposits(true); // áp dụng ngay cho các đơn đang chờ
  audit(req, 'settings_bank_update');
  back(req, res, 'success', 'Đã lưu cài đặt bank', '/admin/settings/bank');
});

// Quét APICANHAN ngay (thử ApiKey / lấy giao dịch mới mà không đợi vòng quét)
router.post('/settings/bank/acn-scan', async (req, res) => {
  const r = await require('../services/apicanhan').pollOnce({ force: true });
  audit(req, 'acn_scan', r.message);
  back(req, res, r.ok ? 'success' : 'error', 'APICANHAN: ' + r.message, '/admin/settings/bank');
});

// --- Email & Bảo mật: SMTP, xác minh 2 lớp, loại email thông báo ---
const MAIL_TOGGLES = [['mail_on_welcome', 'Chào mừng khi đăng ký'], ['mail_on_order', 'Mua hàng thành công'], ['mail_on_deposit', 'Nạp tiền thành công'],
  ['mail_on_password', 'Mật khẩu vừa được thay đổi'], ['mail_on_login_alert', 'Đăng nhập từ thiết bị mới']];
router.get('/settings/email', (req, res) => {
  const mailer = require('../services/mailer');
  const s = getSettings();
  res.render('admin/settings-email', {
    title: 'Email & Bảo mật', s, ready: mailer.isReady(s), toggles: MAIL_TOGGLES, hasPass: !!s.smtp_pass_enc,
    logs: db.prepare('SELECT * FROM email_logs ORDER BY id DESC LIMIT 40').all(),
    stats: db.prepare("SELECT SUM(status = 'sent') sent, SUM(status = 'failed') failed FROM email_logs WHERE created_at > unixepoch() - 86400").get(),
    adminsNoEmail: db.prepare("SELECT username FROM users WHERE role = 'admin' AND (email IS NULL OR email = '')").all().map((r) => r.username),
  });
});
router.post('/settings/email', (req, res) => {
  const mailer = require('../services/mailer');
  setSetting('smtp_host', str(req.body.smtp_host, 120));
  setSetting('smtp_port', String(toInt(req.body.smtp_port, 587, 1, 65535)));
  setSetting('smtp_secure', ['ssl', 'tls', 'none'].includes(req.body.smtp_secure) ? req.body.smtp_secure : 'tls');
  setSetting('smtp_user', str(req.body.smtp_user, 150));
  if (req.body.smtp_pass) setSetting('smtp_pass_enc', mailer.encryptPass(String(req.body.smtp_pass).slice(0, 300)));
  if (req.body.clear_pass) setSetting('smtp_pass_enc', '');
  setSetting('mail_from_name', str(req.body.mail_from_name, 100));
  const from = str(req.body.mail_from_email, 150);
  if (from && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(from)) return back(req, res, 'error', 'Email người gửi không hợp lệ', '/admin/settings/email');
  setSetting('mail_from_email', from);
  setSetting('twofa_mode_user', ['off', 'optional', 'required'].includes(req.body.twofa_mode_user) ? req.body.twofa_mode_user : 'optional');
  setSetting('twofa_admin', req.body.twofa_admin ? '1' : '0');
  setSetting('twofa_days', String(toInt(req.body.twofa_days, 30, 1, 365)));
  for (const [k] of MAIL_TOGGLES) setSetting(k, req.body[k] ? '1' : '0');
  audit(req, 'settings_email_update');
  back(req, res, 'success', 'Đã lưu cài đặt email & bảo mật', '/admin/settings/email');
});
router.post('/settings/email/test', async (req, res) => {
  const mailer = require('../services/mailer');
  const to = str(req.body.to, 150) || req.user.email;
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return back(req, res, 'error', 'Nhập email nhận thử hợp lệ', '/admin/settings/email');
  const r = await mailer.send(to, 'test');
  audit(req, 'email_test', `${to} ${r.ok ? 'ok' : r.error}`);
  back(req, res, r.ok ? 'success' : 'error', r.ok ? `Đã gửi email thử tới ${to}. Hãy kiểm tra hộp thư (cả mục Spam).` : `Gửi thất bại: ${r.error}`, '/admin/settings/email');
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

// ======================= CHỐNG SPAM & DDOS =======================
const AS_NUM = {
  as_guest_limit: [10, 100000], as_gate_minutes: [1, 1440], as_ban_limit: [20, 100000], as_ban_minutes: [1, 10080],
  as_user_limit: [5, 10000], as_user_cooldown: [1, 600], as_overload_ms: [50, 5000], edge_cache_seconds: [0, 600],
  ad_mult: [2, 100], ad_floor_rpm: [60, 10000000], ad_ip_floor: [10, 10000000], ad_escalate_sec: [20, 3600], ad_calm_min: [1, 1440],
  reg_hour_limit: [1, 1000], reg_ip_day: [1, 1000], reg_min_seconds: [0, 60],
};
const AS_BOOL = ['as_enabled', 'as_ban_enabled', 'as_overload', 'as_emergency', 'ad_enabled', 'ad_auto_gate', 'ad_auto_cf'];
router.get('/antispam', (req, res) => {
  const shield = require('../services/shield');
  res.render('admin/antispam', { title: 'Chống spam & DDoS', s: getSettings(), st: shield.status(), ad: require('../services/traffic').status(), myIp: clientIp(req) });
});

// ---- Tự phát hiện truy cập bất thường: Cloudflare + xử lý bằng tay ----
router.post('/antispam/cloudflare', (req, res) => {
  const zone = str(req.body.cf_zone_id, 64).replace(/[^a-f0-9]/gi, '');
  if (req.body.cf_zone_id && zone.length !== 32) return back(req, res, 'error', 'Zone ID không đúng (32 ký tự chữ và số)', '/admin/antispam');
  setSetting('cf_zone_id', zone);
  const token = str(req.body.cf_token, 200);
  if (token) setSetting('cf_token_enc', encrypt(token));
  if (req.body.cf_clear) setSetting('cf_token_enc', '');
  audit(req, 'cloudflare_api', zone ? 'cập nhật' : 'xóa');
  back(req, res, 'success', 'Đã lưu thông tin Cloudflare', '/admin/antispam');
});
router.post('/antispam/cloudflare/test', async (req, res) => {
  try {
    const level = await require('../services/cloudflare').getSecurityLevel();
    back(req, res, 'success', `Kết nối Cloudflare thành công. Security level hiện tại: ${level}`, '/admin/antispam');
  } catch (e) { back(req, res, 'error', e.message, '/admin/antispam'); }
});
router.post('/antispam/auto/stop', async (req, res) => {
  const msg = await require('../services/traffic').stand('admin tắt bằng tay');
  audit(req, 'auto_shield_stop', '');
  back(req, res, msg.includes('⚠️') ? 'error' : 'success', msg.replace(/^✅ /, ''), '/admin/antispam');
});
router.post('/antispam/auto/under-attack', async (req, res) => {
  try {
    await require('../services/traffic').manualUnderAttack();
    audit(req, 'auto_shield_ua', 'bật bằng tay');
    back(req, res, 'success', 'Đã bật Cloudflare Under Attack. Nhớ bấm “Trở lại bình thường” khi hết bị tấn công.', '/admin/antispam');
  } catch (e) { back(req, res, 'error', e.message, '/admin/antispam'); }
});
router.post('/antispam', (req, res) => {
  const cur = getSettings();
  for (const [k, [min, max]] of Object.entries(AS_NUM)) setSetting(k, String(toInt(req.body[k], parseInt(cur[k], 10) || min, min, max)));
  for (const k of AS_BOOL) setSetting(k, req.body[k] ? '1' : '0');
  const wl = String(req.body.as_whitelist || '').split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^[0-9a-fA-F:.]{3,45}$/.test(x)).slice(0, 200);
  setSetting('as_whitelist', wl.join('\n'));
  if (toInt(req.body.as_ban_limit, 0) <= toInt(req.body.as_guest_limit, 0)) setSetting('as_ban_limit', String(Math.min(AS_NUM.as_ban_limit[1], toInt(req.body.as_guest_limit, 120) * 2)));
  audit(req, 'antispam_update', req.body.as_emergency ? 'emergency ON' : '');
  back(req, res, 'success', 'Đã lưu cài đặt chống spam', '/admin/antispam');
});
router.post('/antispam/release', (req, res) => {
  const shield = require('../services/shield');
  const key = str(req.body.key, 80);
  if (key === 'all') db.prepare("DELETE FROM shield_flags WHERE key LIKE 'g:%'").run();
  else if (/^[gc]:/.test(key)) shield.clearFlag(key);
  shield.syncFlags();
  audit(req, 'antispam_release', key);
  back(req, res, 'success', 'Đã gỡ chặn', '/admin/antispam');
});

// ======================= BẢO TRÌ DỮ LIỆU =======================
router.get('/maintenance', async (req, res) => {
  const s = getSettings();
  res.render('admin/maintenance', { title: 'Bảo trì dữ liệu', info: maintenance.dbInfo(), s, retention: config.retention,
    expireMinutes: maintenance.depositExpireMinutes(), uploads: await backupSvc.uploadsSize(),
    tgHasToken: !!s.tg_token_enc, hasBackupPass: !!s.backup_pass_enc, img: require('../services/image-cleanup').config() });
});

router.post('/maintenance/run', async (req, res) => {
  const task = req.body.task;
  const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
  const lightMsg = (r) => `hủy ${r.expired} đơn nạp quá hạn; xóa ${r.activityLogs + r.loginLogs} nhật ký cũ, ${r.deadDeposits} đơn nạp hủy cũ, `
    + `${r.bankTxns} GD bank cũ, ${r.balanceLogs} biến động số dư cũ, ${r.sessions} phiên hết hạn, ${r.ipBlocks} IP hết hạn chặn`;
  const archMsg = (r) => `chuyển ${r.orders} đơn hàng và ${r.deposits} đơn nạp cũ sang lưu trữ`;
  let msg;
  try {
    if (task === 'light') msg = 'Dọn dẹp nhanh xong: ' + lightMsg(maintenance.runLight());
    else if (task === 'archive') msg = 'Lưu trữ xong: ' + archMsg(maintenance.archive());
    else if (task === 'backup') msg = 'Đã tạo bản backup ' + (await maintenance.backup());
    else if (task === 'optimize') { const r = maintenance.optimize(false); msg = `Đã tối ưu chỉ mục (dung lượng ${mb(r.before)} → ${mb(r.after)})`; }
    else if (task === 'vacuum') { const r = maintenance.optimize(true); msg = `Đã VACUUM, thu gọn file DB ${mb(r.before)} → ${mb(r.after)}`; }
    else if (task === 'images') {
      const r = await require('../services/image-cleanup').run();
      msg = r ? `Dọn ảnh xong: ${r.sold.n} ảnh acc đã bán, ${r.proof.n} ảnh xác nhận đơn, ${r.orphan.n} ảnh rác — giải phóng ${mb(r.bytes)}` : 'Đang dọn ảnh, thử lại sau ít phút';
    } else if (task === 'stats') msg = `Đã tính lại thống kê cho ${maintenance.rebuildStats()} ngày`;
    else if (task === 'daily') {
      const r = await maintenance.runDaily();
      msg = `Chạy toàn bộ xong: ${lightMsg(r.light)}; ${archMsg(r.archived)};${r.images ? ` dọn ${r.images.sold.n + r.images.proof.n + r.images.orphan.n} ảnh (${mb(r.images.bytes)});` : ''} tối ưu chỉ mục; backup ${r.backup}`;
    } else return back(req, res, 'error', 'Tác vụ không hợp lệ', '/admin/maintenance');
  } catch (e) {
    console.error('[maintenance]', task, e);
    return back(req, res, 'error', 'Lỗi khi chạy tác vụ: ' + e.message, '/admin/maintenance');
  }
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
router.post('/maintenance/backup/:name/delete', (req, res) => {
  const ok = backupSvc.deleteBackup(path.basename(String(req.params.name)));
  if (ok) audit(req, 'backup_delete', req.params.name);
  back(req, res, ok ? 'success' : 'error', ok ? 'Đã xóa bản sao lưu' : 'Không tìm thấy bản sao lưu', '/admin/maintenance');
});

// --- Sao lưu về Telegram + mật khẩu gói sao lưu ---
// Bot token / Chat ID nhập ở Kết nối API — đây chỉ bật / tắt sao lưu và đặt mật khẩu gói
router.post('/maintenance/telegram', (req, res) => {
  const pass = String(req.body.backup_pass || '');
  if (pass) {
    if (pass.length < 8) return back(req, res, 'error', 'Mật khẩu gói sao lưu phải từ 8 ký tự', '/admin/maintenance');
    if (pass !== String(req.body.backup_pass2 || '')) return back(req, res, 'error', 'Nhập lại mật khẩu gói sao lưu không khớp', '/admin/maintenance');
    setSetting('backup_pass_enc', encrypt(pass));
  }
  setSetting('tg_enabled', req.body.tg_enabled ? '1' : '0');
  setSetting('alert_admin', req.body.alert_admin ? '1' : '0');
  audit(req, 'backup_settings', pass ? 'password' : '');
  back(req, res, 'success', 'Đã lưu cài đặt sao lưu', '/admin/maintenance');
});
// Đối chiếu số dư khách với lịch sử giao dịch ngay (bình thường tự chạy mỗi đêm)
router.post('/maintenance/images', (req, res) => {
  setSetting('img_sold_days', String(toInt(req.body.img_sold_days, 30, 0, 3650)));
  setSetting('img_proof_days', String(toInt(req.body.img_proof_days, 30, 0, 3650)));
  setSetting('img_orphan', bool(req.body.img_orphan));
  audit(req, 'image_cleanup_settings');
  back(req, res, 'success', 'Đã lưu cài đặt tự dọn ảnh', '/admin/maintenance');
});

router.post('/maintenance/reconcile', (req, res) => {
  const r = require('../services/alerts').reconcileAndReport();
  const money = (n) => H.money(n);
  if (!r.mismatches.length) return back(req, res, 'success', `Đối chiếu ${r.checked.toLocaleString('vi-VN')} tài khoản: số dư khớp hoàn toàn với lịch sử giao dịch`, '/admin/maintenance');
  const list = r.mismatches.slice(0, 5).map((m) => `${m.username} (${money(m.balance)} / ${money(m.expected)})`).join(', ');
  back(req, res, 'error', `${r.mismatches.length} tài khoản số dư không khớp lịch sử giao dịch: ${list}${r.mismatches.length > 5 ? '…' : ''}`, '/admin/maintenance');
});
router.post('/maintenance/telegram/test', async (req, res) => {
  const r = await backupSvc.backupToTelegram();
  audit(req, 'backup_telegram', r.message);
  back(req, res, r.ok ? 'success' : 'error', 'Telegram: ' + r.message, '/admin/maintenance');
});
// Tải gói sao lưu đầy đủ (mã hóa bằng mật khẩu gói) về máy
router.post('/maintenance/package', async (req, res) => {
  let pkg;
  try { pkg = await backupSvc.makePackage({ withUploads: true }); } catch (e) { return back(req, res, 'error', e.message, '/admin/maintenance'); }
  audit(req, 'backup_package', path.basename(pkg.file));
  res.download(pkg.file, path.basename(pkg.file), () => fs.rm(pkg.file, { force: true }, () => {}));
});

// --- Khôi phục dữ liệu từ gói sao lưu (.gzbak) hoặc file .db ---
const MAX_RESTORE = 10 * 1024 ** 3; // gói sao lưu tối đa 10GB
const restoreUpload = require('multer')({ dest: backupSvc.TMP, limits: { fileSize: MAX_RESTORE, files: 1 } });
const restoreLines = (r) => {
  const c = r.summary;
  return [`Người dùng: ${c.users || 0}`, `Sản phẩm: ${c.products || 0}`, `Đơn hàng: ${c.orders || 0}`, `Đơn nạp: ${c.deposits || 0}`,
    r.uploads ? 'Ảnh: đã thay bằng ảnh trong gói' : 'Ảnh: giữ nguyên (gói không có ảnh)',
    c._reencrypted ? `Đã mã hóa lại ${c._reencrypted} mục cho khóa của VPS này` : '',
    `Bản sao lưu dữ liệu trước khi khôi phục: ${r.safety}`].filter(Boolean);
};
router.post('/maintenance/restore', (req, res) => {
  restoreUpload.single('file')(req, res, async (err) => {
    const cleanup = () => req.file && ['', '-wal', '-shm', '-journal'].forEach((x) => fs.rm(req.file.path + x, { force: true }, () => {})); // kèm file phụ của SQLite
    const fail = (m) => { cleanup(); back(req, res, 'error', m, '/admin/maintenance'); };
    if (err) return fail('Lỗi tải file: ' + err.message);
    if (!verifyCsrf(req)) { cleanup(); return res.status(403).render('errors/error', { code: 403, message: 'CSRF token không hợp lệ' }); }
    if (!req.file) return fail('Chưa chọn file sao lưu');
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'XOA HET') return fail('Gõ đúng XOA HET để xác nhận xóa dữ liệu hiện tại');
    audit(req, 'restore_start', req.file.originalname);
    let r;
    try {
      r = await backupSvc.restoreFromFile(req.file.path, String(req.body.password || ''));
    } catch (e) {
      console.error('[restore]', e);
      return fail('Không khôi phục được: ' + e.message + '. Dữ liệu hiện tại vẫn giữ nguyên.');
    }
    cleanup();
    const lines = restoreLines(r);
    logActivity(null, 'restore_done', lines.join(' | '), clientIp(req));
    res.render('errors/error', { code: 'OK', message: 'Khôi phục dữ liệu thành công. ' + lines.join(' · ') + '. Web đang tự khởi động lại, vui lòng đăng nhập lại bằng tài khoản trong bản sao lưu.' });
    setTimeout(() => backupSvc.requestRestart(), 300);
  });
});

// Tải file sao lưu lớn theo từng phần (20MB/lần): vượt giới hạn 100MB/lần của Cloudflare và giới hạn của Nginx,
// mạng chập chờn thì tải tiếp từ phần đang dở. Ghi thẳng xuống đĩa, không giữ trong RAM.
const partFile = (id) => path.join(backupSvc.TMP, `up-${id}.part`);
router.post('/maintenance/restore/chunk', async (req, res) => {
  const id = String(req.query.id || '');
  const offset = Number(req.query.offset);
  const total = Number(req.query.total);
  if (!/^[a-f0-9]{24}$/.test(id) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total <= 0) return res.status(400).json({ ok: false, message: 'Tham số không hợp lệ' });
  if (total > MAX_RESTORE) return res.status(413).json({ ok: false, message: 'File vượt quá 10GB' });
  const f = partFile(id);
  const have = fs.existsSync(f) ? fs.statSync(f).size : 0;
  if (offset !== have) return res.json({ ok: false, resume: have }); // lệch vị trí (tải lại sau khi mất mạng) -> báo vị trí đúng
  let n = 0;
  const limit = new (require('stream').Transform)({
    transform(chunk, enc, cb) { n += chunk.length; if (n > 32 * 1024 * 1024 || have + n > total) return cb(new Error('Phần tải lên quá lớn')); cb(null, chunk); },
  });
  try {
    await require('stream/promises').pipeline(req, limit, fs.createWriteStream(f, { flags: 'a' }));
  } catch (e) {
    return res.status(400).json({ ok: false, message: e.message, resume: fs.existsSync(f) ? fs.statSync(f).size : 0 });
  }
  res.json({ ok: true, received: have + n });
});
router.post('/maintenance/restore/finish', async (req, res) => {
  const id = String(req.body.id || '');
  if (!/^[a-f0-9]{24}$/.test(id)) return res.status(400).json({ ok: false, message: 'Tham số không hợp lệ' });
  const f = partFile(id);
  const cleanup = () => ['', '-wal', '-shm', '-journal'].forEach((x) => fs.rm(f + x, { force: true }, () => {}));
  if (!fs.existsSync(f) || fs.statSync(f).size !== Number(req.body.total)) { cleanup(); return res.json({ ok: false, message: 'File tải lên chưa đủ, vui lòng thử lại' }); }
  if (String(req.body.confirm || '').trim().toUpperCase() !== 'XOA HET') { cleanup(); return res.json({ ok: false, message: 'Gõ đúng XOA HET để xác nhận xóa dữ liệu hiện tại' }); }
  audit(req, 'restore_start', String(req.body.name || '').slice(0, 100));
  // Chạy nền: gói lớn có thể mất vài phút, vượt thời gian chờ của Nginx / Cloudflare -> trang tự hỏi kết quả
  const job = crypto.randomBytes(12).toString('hex');
  backupSvc.setJob(job, { state: 'running' });
  res.json({ ok: true, job });
  const password = String(req.body.password || '');
  const ip = clientIp(req);
  setImmediate(async () => {
    try {
      const r = await backupSvc.restoreFromFile(f, password);
      const lines = restoreLines(r);
      logActivity(null, 'restore_done', lines.join(' | '), ip);
      backupSvc.setJob(job, { state: 'done', lines });
      setTimeout(() => backupSvc.requestRestart(), 1500);
    } catch (e) {
      console.error('[restore]', e);
      backupSvc.setJob(job, { state: 'error', message: 'Không khôi phục được: ' + e.message + '. Dữ liệu hiện tại vẫn giữ nguyên.' });
    } finally { cleanup(); }
  });
});

// ======================= TÀI KHOẢN ADMIN =======================
router.get('/profile', (req, res) => res.render('admin/profile', { title: 'Tài khoản admin' }));

module.exports = router;
