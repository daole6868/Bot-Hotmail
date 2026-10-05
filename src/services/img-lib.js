'use strict';
/**
 * Thư viện ảnh nhân vật / vũ khí từng game (Giao diện -> Quản lý ảnh).
 *  - Nạp thủ công: dán HTML trang HoYoLAB -> tách cặp (ảnh, tên) -> lọc trùng tên -> bỏ qua tên đã có ảnh -> tải về, nén webp.
 *  - Acc lấy dữ liệu sau đó dùng lại ảnh trong thư viện, không tải lại.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db');
const config = require('../config');
const hoyo = require('./hoyo');

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const attr = (tag, name) => { const m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(tag); return m ? decode(m[1]).trim() : ''; };

// Bỏ phần ?x-oss-process=... (ảnh thu nhỏ chất lượng thấp) để tải ảnh gốc nét hơn
function cleanSrc(src) {
  try { const u = new URL(src); if (/x-oss-process/i.test(u.search)) u.search = ''; return u.href; } catch { return ''; }
}

/**
 * HTML dán vào -> [{name, src, rarity}], đã lọc trùng tên.
 * Mỗi khối HoYoLAB: ảnh nhân vật (img, bỏ qua icon nguyên tố gt-icon__img), sau đó <p>Lv.x</p> và <p>Tên</p>.
 */
function parseHtml(html) {
  // Độ hiếm: Genshin / Star Rail dùng class star-bg-5 / star-bg-4; ZZZ dùng thuộc tính rarity="S" / "A"
  const re = /<img\b[^>]*>|<p\b([^>]*)>([\s\S]*?)<\/p>|star-bg-(\d)|\srarity="([SAB])"/gi;
  const out = [];
  const seen = new Set();
  let pending = null;
  let rarity = 0;
  const dup = [];
  let m;
  const text = String(html || '').slice(0, 3 * 1024 * 1024);
  while ((m = re.exec(text))) {
    if (m[3]) { rarity = parseInt(m[3], 10) || 0; continue; }
    if (m[4]) { rarity = { S: 5, A: 4, B: 3 }[m[4].toUpperCase()] || 0; continue; }
    if (m[0][1].toLowerCase() === 'i') {
      const cls = attr(m[0], 'class');
      const src = attr(m[0], 'origin-src') || attr(m[0], 'src');
      if (/gt-icon__img/.test(cls) || /\/gt-ui\//.test(src) || !/^https:\/\//i.test(src)) continue;
      pending = { src: cleanSrc(src), rarity };
      rarity = 0;
      continue;
    }
    // Dòng cấp (gt-card__info: "Lv.60", hoặc "-" khi chưa sở hữu) không phải tên
    if (/\bgt-card__info\b(?!-)/.test(attr('<p ' + m[1] + '>', 'class'))) continue;
    const name = decode(String(m[2] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!pending || !name || !/[\p{L}\p{N}]/u.test(name) || /^lv\.?\s*\d+$/i.test(name) || name.length > 60) continue;
    const k = hoyo.nkey(name);
    if (seen.has(k)) { if (!dup.includes(name)) dup.push(name); }
    else { seen.add(k); out.push({ name, src: pending.src, rarity: pending.rarity }); }
    pending = null;
  }
  return { items: out, dup };
}

/** Acc đã đăng có nhân vật / vũ khí chưa có ảnh -> điền từ thư viện */
function backfill(game) {
  const rows = db.prepare(`SELECT id, acc_detail FROM products WHERE acc_detail LIKE ? AND acc_detail LIKE '%"ic":""%' LIMIT 5000`).all('%"game":"' + game + '"%');
  const upd = db.prepare('UPDATE products SET acc_detail = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    let d; try { d = JSON.parse(r.acc_detail); } catch { continue; }
    const before = JSON.stringify(d);
    const after = JSON.stringify(hoyo.fillIcons(d));
    if (after !== before) { upd.run(after, r.id); n++; }
  }
  return n;
}

/** Nạp danh sách đã tách: bỏ qua tên đã có, tải ảnh còn thiếu (6 ảnh cùng lúc) */
async function importItems(game, kind, items) {
  const fresh = [];
  const existed = [];
  // Tên đã có mà chưa có độ hiếm (nạp trước khi nhận được hạng S/A của ZZZ) -> chỉ cập nhật độ hiếm, không tải lại ảnh
  const fixRarity = db.prepare('UPDATE hoyo_assets SET rarity = ? WHERE game = ? AND kind = ? AND nkey = ? AND rarity = 0');
  for (const it of items.slice(0, 400)) {
    if (hoyo.libGet(game, kind, it.name)) { existed.push(it.name); if (it.rarity) fixRarity.run(it.rarity, game, kind, hoyo.nkey(it.name)); }
    else fresh.push(it);
  }
  const added = [];
  const failed = [];
  for (let i = 0; i < fresh.length; i += 6) {
    const part = fresh.slice(i, i + 6);
    const icons = await Promise.all(part.map((it) => hoyo.cacheIcon(it.src)));
    part.forEach((it, k) => {
      if (icons[k] && hoyo.libAdd(game, kind, it.name, icons[k], it.src, it.rarity)) added.push(it.name);
      else if (!icons[k]) failed.push(it.name);
    });
  }
  const filled = added.length ? backfill(game) : 0;
  return { existed, added, failed, filled };
}

// Ảnh tải lên tay -> webp 160px trong /uploads/hoyo/
async function saveUpload(buffer) {
  const out = await require('sharp')(buffer).resize(160, 160, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
  const name = crypto.createHash('sha1').update(out).digest('hex') + '.webp';
  const dir = path.join(config.paths.uploads, hoyo.ICON_DIR);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), out);
  return '/uploads/' + hoyo.ICON_DIR + '/' + name;
}

async function addOne(game, kind, name, rarity, { buffer, url }) {
  name = String(name || '').trim().slice(0, 60);
  if (!hoyo.GAMES[game] || !['char', 'weapon'].includes(kind) || !name) return { ok: false, message: 'Nhập tên' };
  if (hoyo.libGet(game, kind, name)) return { ok: false, message: 'Tên này đã có ảnh trong thư viện' };
  let icon = '';
  try { icon = buffer ? await saveUpload(buffer) : await hoyo.cacheIcon(cleanSrc(url)); } catch { icon = ''; }
  if (!icon) return { ok: false, message: buffer ? 'File ảnh không hợp lệ' : 'Không tải được ảnh (chỉ nhận link ảnh của HoYoverse / HoYoLAB)' };
  hoyo.libAdd(game, kind, name, icon, buffer ? null : url, rarity);
  backfill(game);
  return { ok: true };
}

async function replace(id, buffer) {
  const a = db.prepare('SELECT * FROM hoyo_assets WHERE id = ?').get(id);
  if (!a) return { ok: false, message: 'Không tìm thấy' };
  let icon = '';
  try { icon = await saveUpload(buffer); } catch { return { ok: false, message: 'File ảnh không hợp lệ' }; }
  db.transaction(() => {
    db.prepare('UPDATE hoyo_assets SET icon = ? WHERE id = ?').run(icon, id);
    // acc đang dùng ảnh cũ -> đổi sang ảnh mới
    db.prepare('UPDATE products SET acc_detail = replace(acc_detail, ?, ?) WHERE acc_detail LIKE ?').run(a.icon, icon, '%' + a.icon + '%');
  })();
  return { ok: true };
}

function rename(id, name) {
  name = String(name || '').trim().slice(0, 60);
  const a = db.prepare('SELECT * FROM hoyo_assets WHERE id = ?').get(id);
  if (!a || !name) return { ok: false, message: 'Nhập tên' };
  const k = hoyo.nkey(name);
  if (db.prepare('SELECT 1 FROM hoyo_assets WHERE game = ? AND kind = ? AND nkey = ? AND id != ?').get(a.game, a.kind, k, id)) return { ok: false, message: 'Tên này đã có trong thư viện' };
  db.prepare('UPDATE hoyo_assets SET name = ?, nkey = ? WHERE id = ?').run(name, k, id);
  backfill(a.game);
  return { ok: true };
}

// Xóa khỏi thư viện (file ảnh giữ lại nếu acc còn dùng; mục dọn ảnh rác tự xóa khi không còn ai dùng)
const remove = (id) => db.prepare('DELETE FROM hoyo_assets WHERE id = ?').run(id).changes > 0;

// Khởi động: gắn độ hiếm cho ảnh cũ đã lưu (chỉ chạy khi còn ảnh chưa có độ hiếm)
setTimeout(() => { try { hoyo.libRarityAll(); } catch (e) { console.error('[img-lib] rarity:', e.message); } }, 5000).unref();

module.exports = { parseHtml, importItems, backfill, addOne, replace, rename, remove };
