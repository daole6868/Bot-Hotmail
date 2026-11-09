'use strict';
/**
 * Nguồn hàng API: bán lại hàng của web khác (mặc định 1smail.shop) qua API của họ.
 *  - Đồng bộ chuyên mục + sản phẩm (products.php) 5 phút / lần -> giá vốn, tồn kho, min / max.
 *  - Giá bán = giá vốn × (100 + % lãi) / 100 (làm tròn lên), hoặc giá đặt riêng từng sản phẩm.
 *  - Mua: trừ tiền khách + tạo đơn (1 transaction, chống bấm 2 lần) -> gọi buy_product ĐÚNG 1 LẦN ->
 *      thành công: giao hàng (thiếu thì hoàn phần thiếu) | lỗi rõ ràng: hoàn tiền | mất kết nối: "chờ kiểm tra", báo admin.
 *    API mua không nhận mã đơn của mình -> mất kết nối thì không biết bên kia đã trừ tiền chưa: không tự mua lại, không tự hoàn.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getSettings, setSetting, bumpStat, logActivity } = require('../db');
const { encrypt, decrypt, randomCode } = require('../utils/crypto');
const { money } = require('../utils/helpers');
const config = require('../config');
const idem = require('./idem');

const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const s_ = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n);
class ApiErr extends Error {}

// ---------- Cấu hình (settings.apishop_cfg) ----------
const DEFAULTS = { url: 'https://1smail.shop', markup: 30, low: 100000, gameId: 0, keepDays: 15 };
// Cỡ chữ trang khách (px) + khoảng cách dòng
const UI = { namePc: 15, nameMb: 14, descPc: 13, descMb: 12, lh: 1.4 };
const fl = (v, d, min, max) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : d; };
const fl2 = (v, d, min, max) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 100) / 100)) : d; };
function cfg(s = getSettings()) {
  let c = {};
  try { c = JSON.parse(s.apishop_cfg || '{}') || {}; } catch { c = {}; }
  return {
    url: /^https:\/\/[\w.-]+(:\d+)?$/i.test(c.url || '') ? c.url.replace(/\/+$/, '') : DEFAULTS.url,
    keyEnc: c.keyEnc || '',
    markup: int(c.markup, DEFAULTS.markup, 0, 1000),
    low: int(c.low, DEFAULTS.low, 0, 1e10),
    gameId: int(c.gameId, 0, 0, 1e9),
    keepDays: int(c.keepDays, DEFAULTS.keepDays, 0, 3650), // 0 = giữ mãi
    ui: {
      namePc: fl(c.ui && c.ui.namePc, UI.namePc, 10, 32), nameMb: fl(c.ui && c.ui.nameMb, UI.nameMb, 10, 28),
      descPc: fl(c.ui && c.ui.descPc, UI.descPc, 9, 24), descMb: fl(c.ui && c.ui.descMb, UI.descMb, 9, 22),
      lh: fl2(c.ui && c.ui.lh, UI.lh, 1, 2.2),
    },
  };
}
/** Định dạng dữ liệu trong mô tả sản phẩm: "Định dạng : mail|pass|refresh_token|client_id" -> ['mail','pass','refresh_token','client_id'] */
function fmtOf(desc) {
  for (const line of String(desc || '').split(/\r?\n/)) {
    const m = /([A-Za-z_]\w*(?:\s*\|\s*[A-Za-z_][\w ]*)+)/.exec(line);
    if (m) return m[1].split('|').map((x) => x.trim()).filter(Boolean).join('|').slice(0, 200);
  }
  return '';
}
/** Vị trí ô mail / pass trong định dạng (không có định dạng -> ô 1, 2) */
function mpIndex(fmt) {
  const f = String(fmt || '').toLowerCase().split('|');
  let mi = f.findIndex((x) => /^(e-?mail|mail|account|tài khoản|user(name)?|login)$/.test(x));
  if (mi < 0) mi = f.findIndex((x) => /mail/.test(x) && !/recovery|khôi phục/.test(x));
  let pi = f.findIndex((x, i) => i !== mi && /^pass(word)?$/.test(x));
  if (pi < 0) pi = f.findIndex((x, i) => i !== mi && /pass/.test(x) && !/recovery/.test(x));
  return [mi < 0 ? 0 : mi, pi < 0 ? 1 : pi];
}
/** Dữ liệu gốc -> chỉ mail|pass (dòng không đủ ô thì giữ nguyên) */
function mailPass(data, fmt) {
  const [mi, pi] = mpIndex(fmt);
  return String(data || '').split('\n').filter(Boolean).map((l) => { const f = l.split('|'); return f.length > Math.max(mi, pi) ? `${f[mi].trim()}|${f[pi].trim()}` : l; }).join('\n');
}
function saveCfg(patch) {
  const c = { ...cfg(), ...patch };
  setSetting('apishop_cfg', JSON.stringify(c));
  return cfg();
}
const apiKey = (c = cfg()) => { try { return c.keyEnc ? decrypt(c.keyEnc) : ''; } catch { return ''; } };
const setKey = (k) => saveCfg({ keyEnc: k ? encrypt(String(k).trim()) : '' });
const maskKey = (c = cfg()) => { const k = apiKey(c); return k ? k.slice(0, 4) + '••••••••' + k.slice(-4) : ''; };
const ready = (c = cfg()) => !!apiKey(c);
// Cho phép đổi địa chỉ web nguồn khi chạy thử (máy chủ giả)
const baseUrl = (c) => process.env.APISHOP_URL || c.url;

// ---------- Gọi API web nguồn ----------
async function call(file, params, { method = 'GET', timeout = 15000 } = {}) {
  const c = cfg();
  const key = apiKey(c);
  if (!key) throw new ApiErr('Chưa nhập API key');
  const url = new URL(baseUrl(c) + '/api/' + file);
  let body;
  if (method === 'GET') {
    url.searchParams.set('api_key', key);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  } else {
    body = new FormData();
    body.set('api_key', key);
    for (const [k, v] of Object.entries(params || {})) body.set(k, String(v));
  }
  const res = await fetch(url, { method, body, signal: AbortSignal.timeout(timeout), redirect: 'error', headers: { Accept: 'application/json' } });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text.replace(/^﻿/, '')); } catch { const e = new Error('Phản hồi không phải JSON (HTTP ' + res.status + ')'); e.unknown = true; throw e; }
  return j;
}
const okOf = (j) => j && String(j.status).toLowerCase() === 'success';
const msgOf = (j) => s_(j && j.msg, 300) || 'Lỗi không rõ';
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };

/** Thông tin tài khoản bên nguồn: { username, money } */
async function profile() {
  const j = await call('profile.php');
  if (!okOf(j)) throw new ApiErr(msgOf(j));
  const d = j.data || {};
  const r = { username: s_(d.username, 60), money: Math.floor(num(d.money)), at: nowS() };
  balanceCache = r;
  return r;
}
let balanceCache = null;
async function balance(maxAgeSec = 30) {
  if (balanceCache && nowS() - balanceCache.at <= maxAgeSec) return balanceCache;
  return profile();
}

// ---------- Giá ----------
/** Giá bán 1 cái: giá đặt riêng, hoặc giá vốn + % lãi (làm tròn lên, tối thiểu 1đ) */
function priceOf(p, c = cfg()) {
  if (p.price != null && p.price > 0) return p.price;
  return Math.max(1, Math.ceil(num(p.cost) * (100 + c.markup) / 100 - 1e-9));
}
/** Giá đặt riêng thấp hơn giá vốn -> bán lỗ */
const losing = (p) => p.price != null && p.price > 0 && p.price < num(p.cost);

// ---------- Ảnh chuyên mục (tải về máy chủ: trang khách không gọi ảnh web khác) ----------
const ICON_DIR = 'apishop';
async function cacheIcon(src) {
  let u;
  try { u = new URL(src); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  const name = crypto.createHash('sha1').update(u.href).digest('hex') + '.webp';
  const dir = path.join(config.paths.uploads, ICON_DIR);
  const full = path.join(dir, name);
  const pub = `/uploads/${ICON_DIR}/${name}`;
  if (fs.existsSync(full)) return pub;
  try {
    const r = await fetch(u.href, { signal: AbortSignal.timeout(10000), redirect: 'follow' });
    if (!r.ok) return '';
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return '';
    const out = await require('sharp')(buf, { limitInputPixels: 25e6 }).resize(128, 128, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, out);
    return pub;
  } catch { return ''; }
}

// ---------- Đồng bộ ----------
let syncing = null;
/** Lấy toàn bộ chuyên mục + sản phẩm, cập nhật giá vốn / tồn kho. Sản phẩm không còn trên web nguồn -> đánh dấu đã gỡ. */
async function sync() {
  if (syncing) return syncing;
  syncing = (async () => {
    const j = await call('products.php', {}, { timeout: 30000 });
    if (!okOf(j)) throw new ApiErr(msgOf(j));
    const cats = Array.isArray(j.categories) ? j.categories : [];
    const t = nowS();
    const icons = {};
    for (const c of cats) {
      const src = s_(c && c.icon, 500);
      if (src && !db.prepare('SELECT 1 FROM api_cats WHERE src_id = ? AND icon_src = ? AND icon IS NOT NULL AND icon <> \'\'').get(s_(c.id, 40), src)) icons[s_(c.id, 40)] = await cacheIcon(src);
    }
    const upCat = db.prepare(`INSERT INTO api_cats(src_id, name, icon_src, icon) VALUES(?,?,?,?)
      ON CONFLICT(src_id) DO UPDATE SET name = excluded.name, icon_src = excluded.icon_src, icon = COALESCE(NULLIF(excluded.icon, ''), api_cats.icon)`);
    const upProd = db.prepare(`INSERT INTO api_products(src_id, cat_src_id, name, description, cost, stock, min_qty, max_qty, removed, synced_at) VALUES(?,?,?,?,?,?,?,?,0,?)
      ON CONFLICT(src_id) DO UPDATE SET cat_src_id = excluded.cat_src_id, name = excluded.name, description = excluded.description, cost = excluded.cost,
        stock = excluded.stock, min_qty = excluded.min_qty, max_qty = excluded.max_qty, removed = 0, synced_at = excluded.synced_at`);
    let n = 0;
    db.transaction(() => {
      for (const c of cats) {
        const cid = s_(c && c.id, 40);
        if (!cid) continue;
        upCat.run(cid, s_(c.name, 120), s_(c.icon, 500), icons[cid] || '');
        for (const p of Array.isArray(c.products) ? c.products : []) {
          const pid = s_(p && p.id, 40);
          if (!pid) continue;
          const min = int(p.min, 1, 1, 1e7);
          upProd.run(pid, cid, s_(p.name, 200), s_(p.description, 2000), num(p.price), int(p.amount, 0, 0, 1e9), min, Math.max(min, int(p.max, min, 1, 1e7)), t);
          n++;
        }
      }
      db.prepare('UPDATE api_products SET removed = 1, stock = 0 WHERE synced_at < ?').run(t);
    })();
    lastSync = { at: t, n, cats: cats.length, error: '' };
    checkLosing();
    return lastSync;
  })();
  try { return await syncing; } catch (e) { lastSync = { ...(lastSync || {}), error: e.message, errAt: nowS() }; throw e; } finally { syncing = null; }
}
let lastSync = null;
const syncInfo = () => lastSync;

/** Giá đặt riêng thấp hơn giá vốn mới -> tự tạm ngừng bán + báo admin */
function checkLosing() {
  const rows = db.prepare('SELECT id, src_id, name, title, cost, price FROM api_products WHERE is_active = 1 AND paused IS NULL AND price > 0 AND price < cost').all();
  for (const p of rows) {
    db.prepare("UPDATE api_products SET paused = ? WHERE id = ?").run(`Giá vốn ${money(Math.ceil(p.cost))} cao hơn giá bán ${money(p.price)}`, p.id);
    notify(`⚠️ Nguồn hàng API: tạm ngừng bán "${p.title || p.name}" vì giá vốn (${money(Math.ceil(p.cost))}) cao hơn giá bán đã đặt (${money(p.price)}).`, 'losing:' + p.id);
  }
}

// ---------- Báo admin (Telegram), chống gửi trùng ----------
const sentAt = new Map();
function notify(text, key, everySec = 6 * 3600) {
  if (key) { const last = sentAt.get(key) || 0; if (Date.now() - last < everySec * 1000) return; sentAt.set(key, Date.now()); }
  require('./backup').notifyAdmin(text).catch(() => {});
}
async function checkLowBalance() {
  const c = cfg();
  if (!ready(c) || !c.low) return;
  try {
    const b = await profile();
    if (b.money < c.low) notify(`💸 Số dư bên nguồn hàng API còn ${money(b.money)} (dưới mức cảnh báo ${money(c.low)}). Nạp thêm để khách mua không bị lỗi.`, 'low');
  } catch { /* lỗi mạng: lần sau kiểm tra lại */ }
}

// ---------- Dữ liệu cho trang khách / admin ----------
const gameOf = (c = cfg()) => (c.gameId ? db.prepare("SELECT * FROM games WHERE id = ? AND kind = 'api'").get(c.gameId) : null);
/** Sản phẩm đang bán, nhóm theo chuyên mục */
function listing(c = cfg()) {
  const cats = db.prepare('SELECT * FROM api_cats WHERE is_active = 1 ORDER BY sort_order, CAST(src_id AS INTEGER), src_id').all();
  const prods = db.prepare(`SELECT * FROM api_products WHERE is_active = 1 AND removed = 0 AND paused IS NULL
    ORDER BY sort_order, CAST(src_id AS INTEGER)`).all();
  return cats.map((cat) => ({
    id: cat.src_id, name: cat.title || cat.name || 'Chuyên mục ' + cat.src_id, icon: cat.icon || '',
    items: prods.filter((p) => p.cat_src_id === cat.src_id).map((p) => view(p, c)),
  })).filter((x) => x.items.length);
}
function view(p, c = cfg()) {
  return {
    id: p.id, name: p.title || p.name || (p.description || '').split('\n')[0] || 'Sản phẩm ' + p.src_id, desc: p.description || '',
    price: priceOf(p, c), stock: p.stock, min: p.min_qty, max: Math.min(p.max_qty, Math.max(p.stock, p.min_qty)), sold: p.sold_count,
  };
}

// ---------- Mua hàng ----------
function genCode() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return `AP${d.toISOString().slice(2, 10).replace(/-/g, '')}${randomCode(6)}`;
}
const logBal = (userId, amount, type, ref, note) => {
  const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId).balance;
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)').run(userId, amount, bal, type, ref, note);
};

// Bước 1 (1 transaction): kiểm tra + trừ tiền + tạo đơn "đang xử lý"
const openTx = db.transaction((userId, p, qty, unit, ip, key) => {
  const prev = idem.seen(userId, key);
  if (prev) return { dup: true, code: prev.ref };
  const user = db.prepare('SELECT id, balance, status FROM users WHERE id = ?').get(userId);
  if (!user || user.status !== 'active') throw new ApiErr('Tài khoản không hợp lệ');
  const total = unit * qty;
  if (user.balance < total) throw new ApiErr(`Số dư không đủ. Cần ${money(total)}, bạn có ${money(user.balance)}`);
  const upd = db.prepare('UPDATE users SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ? AND balance >= ?').run(total, total, userId, total);
  if (upd.changes !== 1) throw new ApiErr('Số dư không đủ');
  const code = genCode();
  const title = p.title || p.name || 'Sản phẩm ' + p.src_id;
  const id = db.prepare(`INSERT INTO api_orders(code, user_id, product_id, title, qty, unit_price, total, ip, fmt) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(code, userId, p.id, title, qty, unit, total, ip || null, fmtOf(p.description) || null).lastInsertRowid;
  logBal(userId, -total, 'purchase', code, `Mua ${qty} × ${title}`);
  idem.save(userId, key, 'apiorder', code);
  return { id, code, total };
});

// Hoàn (một phần / toàn bộ) — chỉ hoàn phần chưa hoàn
function refundPart(orderId, amount, note) {
  const o = db.prepare('SELECT * FROM api_orders WHERE id = ?').get(orderId);
  const can = Math.max(0, Math.min(amount, o.total - o.refunded));
  if (!can) return 0;
  db.prepare('UPDATE api_orders SET refunded = refunded + ?, updated_at = unixepoch() WHERE id = ?').run(can, orderId);
  db.prepare('UPDATE users SET balance = balance + ?, total_spent = MAX(0, total_spent - ?) WHERE id = ?').run(can, can, o.user_id);
  logBal(o.user_id, can, 'refund', o.code, note);
  return can;
}
function recordSale(o) {
  const amount = o.total - o.refunded;
  db.prepare(`INSERT INTO sales(kind, ref_id, ref_code, amount, price, cost, status, created_at) VALUES('api',?,?,?,?,?,'ok',?)
    ON CONFLICT(kind, ref_id) DO UPDATE SET amount = excluded.amount, price = excluded.price, cost = excluded.cost, status = 'ok'`)
    .run(o.id, o.code, amount, o.total, o.cost, o.created_at);
  bumpStat('revenue', amount);
  bumpStat('orders', 1);
}

const MSG = [ // lỗi web nguồn -> lời dễ hiểu cho khách (admin vẫn xem được lời gốc)
  [/số dư|so du|không đủ tiền|balance|money/i, 'Shop đang tạm hết hàng, vui lòng thử lại sau ít phút'],
  [/hết hàng|het hang|out of stock|không đủ số lượng|kho/i, 'Sản phẩm vừa hết hàng, vui lòng giảm số lượng hoặc chọn sản phẩm khác'],
];
const friendly = (m) => (MSG.find(([re]) => re.test(m)) || [null, 'Mua không thành công: ' + m])[1];

/** Kiểm tra lại giá vốn / tồn kho ngay trước khi mua (product.php). Không gọi được -> dùng số đã đồng bộ. */
async function refresh(p) {
  try {
    const j = await call('product.php', { product: p.src_id }, { timeout: 10000 });
    if (!okOf(j)) return p;
    const d = Array.isArray(j.product) ? j.product[0] : j.product;
    if (Array.isArray(j.product) && !j.product.length) {
      db.prepare('UPDATE api_products SET removed = 1, stock = 0 WHERE id = ?').run(p.id);
      throw new ApiErr('Sản phẩm đã ngừng bán');
    }
    if (d && typeof d === 'object' && d.price != null) {
      const cost = num(d.price);
      const stock = d.amount != null ? int(d.amount, p.stock, 0, 1e9) : p.stock;
      db.prepare('UPDATE api_products SET cost = ?, stock = ? WHERE id = ?').run(cost, stock, p.id);
      return { ...p, cost, stock };
    }
  } catch (e) { if (e instanceof ApiErr) throw e; }
  return p;
}

/**
 * Khách mua: trả { ok, code } hoặc { ok:false, message }.
 * expectUnit: giá 1 cái khách đã thấy — giá vốn vừa tăng làm giá bán đổi thì báo khách xem lại, không tự trừ giá mới.
 */
async function buy(userId, productId, qty, expectUnit, ip, idemKey) {
  const c = cfg();
  const key = idem.clean(idemKey);
  try {
    if (!ready(c)) throw new ApiErr('Mục này đang bảo trì, vui lòng quay lại sau');
    if (key) { const prev = idem.seen(userId, key); if (prev) return { ok: true, code: prev.ref, dup: true }; }
    let p = db.prepare('SELECT * FROM api_products WHERE id = ?').get(productId);
    const cat = p && db.prepare('SELECT is_active FROM api_cats WHERE src_id = ?').get(p.cat_src_id);
    const game = gameOf(c);
    if (!p || !p.is_active || p.removed || p.paused || !cat || !cat.is_active || !game || !game.is_active) throw new ApiErr('Sản phẩm không tồn tại hoặc đã ngừng bán');
    qty = int(qty, 0, 0, 1e7);
    if (qty < p.min_qty) throw new ApiErr(`Số lượng tối thiểu là ${p.min_qty}`);
    if (qty > p.max_qty) throw new ApiErr(`Số lượng tối đa mỗi đơn là ${p.max_qty.toLocaleString('vi-VN')}`);
    p = await refresh(p);
    if (losing(p)) { checkLosing(); throw new ApiErr('Sản phẩm tạm ngừng bán'); }
    if (qty > p.stock) throw new ApiErr(p.stock ? `Chỉ còn ${p.stock.toLocaleString('vi-VN')} sản phẩm` : 'Sản phẩm đã hết hàng');
    const unit = priceOf(p, c);
    if (expectUnit && unit !== int(expectUnit, 0, 0, 1e12)) throw new ApiErr(`Giá vừa thay đổi thành ${money(unit)} / cái. Vui lòng xem lại rồi mua.`);
    // Số dư bên nguồn không đủ -> từ chối trước khi trừ tiền khách
    const costTotal = Math.ceil(num(p.cost) * qty);
    let before = null;
    try { before = (await balance(0)).money; } catch { before = null; }
    if (before != null && before < costTotal) {
      notify(`💸 Khách mua ${qty} × "${p.title || p.name}" (${money(costTotal)}) nhưng số dư bên nguồn chỉ còn ${money(before)}. Nạp thêm để bán tiếp.`, 'empty', 1800);
      throw new ApiErr('Shop đang tạm hết hàng, vui lòng thử lại sau ít phút');
    }

    const o = openTx.immediate(userId, p, qty, unit, ip, key);
    if (o.dup) return { ok: true, code: o.code, dup: true };
    db.prepare('UPDATE api_orders SET src_balance_before = ? WHERE id = ?').run(before, o.id);
    logActivity(userId, 'api_purchase', `${o.code} - ${qty} × ${p.src_id} - ${money(o.total)}`, ip);

    // Bước 2: gọi mua ĐÚNG 1 LẦN
    let j;
    try {
      j = await call('buy_product', { action: 'buyProduct', id: p.src_id, amount: qty, coupon: '' }, { method: 'POST', timeout: 90000 });
    } catch (e) {
      return unknown(o, p, e);
    }
    if (!okOf(j)) {
      const m = msgOf(j);
      db.transaction(() => {
        refundPart(o.id, o.total, 'Hoàn tiền: mua không thành công');
        db.prepare("UPDATE api_orders SET status = 'refunded', msg = ?, updated_at = unixepoch() WHERE id = ?").run(m, o.id);
      }).immediate();
      if (/số dư|so du|balance|money/i.test(m)) notify(`💸 Web nguồn báo không đủ số dư khi khách mua (đơn ${o.code}). Đã hoàn tiền cho khách.`, 'empty', 1800);
      return { ok: false, message: friendly(m), code: o.code, refunded: true };
    }
    const lines = (Array.isArray(j.data) ? j.data : String(j.data || '').split(/\r?\n/)).map((x) => s_(typeof x === 'string' ? x : JSON.stringify(x), 4000)).filter(Boolean);
    if (!lines.length) return unknown(o, p, new Error('Báo thành công nhưng không có dữ liệu hàng (mã đơn nguồn ' + s_(j.trans_id, 60) + ')'), s_(j.trans_id, 60));
    const got = Math.min(lines.length, qty);
    db.transaction(() => {
      db.prepare(`UPDATE api_orders SET status = 'completed', delivered = ?, trans_id = ?, data_enc = ?, cost = ?, msg = ?, updated_at = unixepoch() WHERE id = ?`)
        .run(lines.length, s_(j.trans_id, 60), encrypt(lines.join('\n')), Math.ceil(num(p.cost) * lines.length), got < qty ? `Web nguồn chỉ giao ${got}/${qty}` : null, o.id);
      if (got < qty) refundPart(o.id, (qty - got) * unit, `Hoàn ${qty - got} sản phẩm không giao được`);
      db.prepare('UPDATE api_products SET sold_count = sold_count + ?, stock = MAX(0, stock - ?) WHERE id = ?').run(got, got, p.id);
      recordSale(db.prepare('SELECT * FROM api_orders WHERE id = ?').get(o.id));
    }).immediate();
    require('./tracking').track(userId, 'purchase', o.total, o.code);
    balanceCache = null;
    setImmediate(checkLowBalance);
    return { ok: true, code: o.code, partial: got < qty ? got : 0 };
  } catch (e) {
    if (e instanceof ApiErr) return { ok: false, message: e.message };
    console.error('[apishop] buy', e);
    return { ok: false, message: 'Có lỗi xảy ra, vui lòng thử lại' };
  }
}

/** Không rõ kết quả: giữ tiền, chờ admin đối chiếu bên web nguồn rồi giao / hoàn */
async function unknown(o, p, err, transId) {
  let after = null;
  try { after = (await profile()).money; } catch { after = null; }
  db.prepare("UPDATE api_orders SET status = 'checking', msg = ?, trans_id = COALESCE(?, trans_id), src_balance_after = ?, updated_at = unixepoch() WHERE id = ?")
    .run(s_(err.message || String(err), 300), transId || null, after, o.id);
  const ord = db.prepare('SELECT * FROM api_orders WHERE id = ?').get(o.id);
  notify(`🟠 Đơn ${o.code} (${ord.qty} × "${ord.title}", ${money(ord.total)}) không rõ kết quả: ${s_(err.message, 200)}.\n`
    + `Số dư nguồn trước: ${ord.src_balance_before != null ? money(ord.src_balance_before) : '?'}, sau: ${after != null ? money(after) : '?'}.\n`
    + 'Vào Admin → Nguồn hàng API → Đơn hàng để kiểm tra rồi Giao hàng hoặc Hoàn tiền.');
  return { ok: true, code: o.code, checking: true };
}

// ---------- Admin xử lý đơn ----------
function adminRefund(orderId, adminId, reason) {
  const o = db.prepare('SELECT * FROM api_orders WHERE id = ?').get(orderId);
  if (!o) return { ok: false, message: 'Không tìm thấy đơn' };
  if (o.status === 'refunded' || o.refunded >= o.total) return { ok: false, message: 'Đơn đã hoàn tiền' };
  db.transaction(() => {
    const amt = refundPart(o.id, o.total, reason || 'Hoàn tiền đơn hàng');
    db.prepare("UPDATE api_orders SET status = 'refunded', msg = COALESCE(?, msg), updated_at = unixepoch() WHERE id = ?").run(reason || null, o.id);
    db.prepare("UPDATE sales SET status = 'refunded' WHERE kind = 'api' AND ref_id = ?").run(o.id);
    bumpStat('refunds', amt);
  }).immediate();
  logActivity(adminId, 'admin_refund', `${o.code} ${money(o.total - o.refunded)} ${reason || ''}`);
  return { ok: true };
}
/** Đơn "chờ kiểm tra": admin dán dữ liệu lấy từ web nguồn để giao cho khách */
function adminDeliver(orderId, adminId, text) {
  const o = db.prepare('SELECT * FROM api_orders WHERE id = ?').get(orderId);
  if (!o) return { ok: false, message: 'Không tìm thấy đơn' };
  if (o.status !== 'checking') return { ok: false, message: 'Chỉ giao tay được đơn đang chờ kiểm tra' };
  const lines = String(text || '').split(/\r?\n/).map((x) => s_(x, 4000)).filter(Boolean).slice(0, o.qty);
  if (!lines.length) return { ok: false, message: 'Dán dữ liệu hàng (mỗi dòng 1 sản phẩm)' };
  const p = o.product_id ? db.prepare('SELECT cost FROM api_products WHERE id = ?').get(o.product_id) : null;
  db.transaction(() => {
    db.prepare(`UPDATE api_orders SET status = 'completed', delivered = ?, data_enc = ?, cost = ?, msg = ?, updated_at = unixepoch() WHERE id = ?`)
      .run(lines.length, encrypt(lines.join('\n')), Math.ceil(num(p ? p.cost : 0) * lines.length), 'Admin giao tay', o.id);
    if (lines.length < o.qty) refundPart(o.id, (o.qty - lines.length) * o.unit_price, `Hoàn ${o.qty - lines.length} sản phẩm không giao được`);
    if (o.product_id) db.prepare('UPDATE api_products SET sold_count = sold_count + ? WHERE id = ?').run(lines.length, o.product_id);
    recordSale(db.prepare('SELECT * FROM api_orders WHERE id = ?').get(o.id));
  }).immediate();
  logActivity(adminId, 'api_deliver', `${o.code}: ${lines.length}/${o.qty}`);
  return { ok: true };
}
const dataOf = (o) => { try { return o.data_enc ? decrypt(o.data_enc) : ''; } catch { return ''; } };

/** Xóa dữ liệu hàng của đơn quá số ngày lưu (giữ lại đơn để đối soát), giải phóng dung lượng */
function purgeOld(c = cfg()) {
  if (!c.keepDays) return 0;
  const n = db.prepare("UPDATE api_orders SET data_enc = NULL, purged_at = unixepoch() WHERE data_enc IS NOT NULL AND status IN ('completed', 'refunded') AND created_at < ?")
    .run(nowS() - c.keepDays * 86400).changes;
  return n;
}

// ---------- Chạy nền (chỉ bản PM2 số 0) ----------
let timer = null;
function start() {
  if (timer) return;
  const tick = async () => {
    const c = cfg();
    if (!ready(c)) return;
    try { await sync(); } catch (e) { /* lỗi mạng: thử lại lần sau */ }
    await checkLowBalance();
    purgeOld(c);
    // Đơn kẹt "đang xử lý" quá 10 phút (máy chủ khởi động lại giữa chừng) -> chuyển chờ kiểm tra
    for (const o of db.prepare("SELECT * FROM api_orders WHERE status = 'processing' AND created_at < ?").all(nowS() - 600)) {
      await unknown(o, null, new Error('Đơn bị gián đoạn khi đang xử lý (máy chủ khởi động lại)'));
    }
  };
  setTimeout(tick, 20000).unref();
  timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
}

module.exports = {
  DEFAULTS, cfg, saveCfg, setKey, maskKey, ready, profile, balance, sync, syncInfo, priceOf, losing, listing, view, gameOf,
  buy, adminRefund, adminDeliver, dataOf, start, notify, fmtOf, mailPass, purgeOld, UI,
};
