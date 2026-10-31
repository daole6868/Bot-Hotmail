'use strict';
/**
 * Cung mệnh (Genshin) / Tinh Hồn (Star Rail) / Ý Cảnh (ZZZ) của nhân vật trong thư viện ảnh.
 *  - Mỗi nhân vật 6 ô: ảnh biểu tượng + tên. Vòng bo bên ngoài do CSS vẽ theo màu "ring" của nhân vật.
 *  - Nạp bằng cách dán HTML HoYoLAB (khối tên có sẵn ảnh + tên + số thứ tự), hoặc sửa tay từng ô.
 */
const { db } = require('../db');
const hoyo = require('./hoyo');
const lib = require('./img-lib');

const LABEL = { genshin: 'Cung Mệnh', hsr: 'Tinh Hồn', zzz: 'Ý Cảnh' };
// Bảng màu gợi ý từng game (mã màu không trùng giữa các game)
const PALETTES = {
  genshin: [
    ['#e9c98b', 'Vàng kim (mặc định)'],
    ['#ff7a45', 'Đỏ lửa · Hu Tao, Arlecchino'],
    ['#3fa9f5', 'Xanh nước · Furina, Neuvillette'],
    ['#4fd1b5', 'Xanh ngọc gió · Venti, Xiao'],
    ['#b16cf0', 'Tím lôi · Raiden, Clorinde'],
    ['#8fcf3c', 'Xanh lá thảo · Nahida, Alhaitham'],
    ['#8fdcf2', 'Xanh băng · Ayaka, Wriothesley'],
    ['#e8a93a', 'Vàng nham · Zhongli, Navia'],
  ],
  hsr: [
    ['#d8c7f7', 'Tím bạc (mặc định)'],
    ['#f2603d', 'Đỏ hỏa · Himeko, Firefly'],
    ['#74c8f0', 'Xanh băng · Jingliu, Herta'],
    ['#c873f2', 'Tím lôi · Kafka, Acheron'],
    ['#3ecf8e', 'Xanh phong · Feixiao, Blade'],
    ['#7468f2', 'Chàm lượng tử · Seele, Silver Wolf'],
    ['#f5d44a', 'Vàng số ảo · Dr. Ratio, Luocha'],
    ['#cfd3d9', 'Xám vật lý · Clara, Boothill'],
  ],
  zzz: [
    ['#c8f23a', 'Xanh chanh (mặc định)'],
    ['#ff4b1f', 'Đỏ cam lửa · Soldier 11, Burnice'],
    ['#6ee7ff', 'Xanh băng · Ellen, Lycaon'],
    ['#a8b8ff', 'Lam sương · Miyabi'],
    ['#2f8cff', 'Xanh điện · Anby, Qingyi'],
    ['#ff3fa4', 'Hồng ether · Zhu Yuan, Nicole'],
    ['#ffc93d', 'Vàng vật lý · Jane Doe, Caesar'],
  ],
};
const ringOf = (game, ring) => (/^#[0-9a-f]{6}$/i.test(ring || '') ? ring : PALETTES[game][0][0]);

const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
const attr = (tag, name) => { const m = new RegExp('\\s' + name + '\\s*=\\s*"([^"]*)"', 'i').exec(tag); return m ? decode(m[1]).trim() : ''; };
const clean = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const cleanSrc = (src) => { try { const u = new URL(src); if (/x-oss-process/i.test(u.search)) u.search = ''; return u.href; } catch { return ''; } };
// Dòng "Cung Mệnh 1" / "Constellation 1" / "Eidolon 1"... -> số ô
const SLOT_LINE = /^(?:cung\s*m[eệ]nh|constellation|eidolon|tinh\s*h[oồ]n|mindscape|[yý]\s*c[aả]nh|c|e|m)?\s*[.:#-]?\s*([1-6])$/i;

/**
 * HTML dán vào -> [{slot, src, name}].
 *  - Khối tên: <img ảnh> <p>Tên</p> <p>Cung Mệnh <span>N</span></p> (bỏ qua thẻ <font> của Google Dịch)
 *  - Khối chòm sao: class constellation-N + <img class="icon-value"> (bỏ qua khung hệ, ổ khóa: đường dẫn không phải https)
 */
function parse(html) {
  const text = String(html || '').slice(0, 1024 * 1024);
  const re = /<img\b[^>]*>|<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<div\b[^>]*\sclass="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/div>|\bconstellation-([1-6])\b/gi;
  const out = [];
  let cur = null;
  let nextSlot = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[4]) { nextSlot = +m[4]; continue; }
    if (m[0][1].toLowerCase() === 'i') {
      const src = attr(m[0], 'origin-src') || attr(m[0], 'src');
      if (!/^https:\/\//i.test(src)) continue;
      cur = { slot: nextSlot, src: cleanSrc(src), name: '' };
      nextSlot = 0;
      out.push(cur);
      continue;
    }
    const t = clean(m[2] !== undefined ? m[2] : m[3]);
    if (!cur || !t) continue;
    const sm = SLOT_LINE.exec(t);
    if (sm) { if (!cur.slot) cur.slot = +sm[1]; continue; }
    if (!cur.name && /[\p{L}\p{N}]/u.test(t) && t.length <= 80 && !/^lv\.?\s*\d+$/i.test(t)) cur.name = t;
  }
  // Cùng 1 ảnh xuất hiện 2 lần (dán cả khối chòm sao lẫn khối tên) -> gộp
  const bySrc = new Map();
  for (const it of out) {
    const o = bySrc.get(it.src);
    if (!o) bySrc.set(it.src, { ...it });
    else { o.slot = o.slot || it.slot; o.name = o.name || it.name; }
  }
  const list = [...bySrc.values()];
  // Ô chưa có số -> điền vào ô trống theo thứ tự
  const used = new Set(list.filter((x) => x.slot).map((x) => x.slot));
  for (const it of list) {
    if (it.slot) continue;
    for (let s = 1; s <= 6; s++) if (!used.has(s)) { it.slot = s; used.add(s); break; }
  }
  const bySlot = new Map();
  for (const it of list) if (it.slot && !bySlot.has(it.slot)) bySlot.set(it.slot, it);
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}

const charOf = (id) => db.prepare("SELECT id, game, name, icon, rarity, ring FROM hoyo_assets WHERE id = ? AND kind = 'char'").get(id);

/** Lưới nhân vật của 1 game kèm số ô đã có */
function list(game, q) {
  const params = [game]; let extra = '';
  if (q) { extra = ' AND a.nkey LIKE ?'; params.push('%' + hoyo.nkey(q) + '%'); }
  return db.prepare(`SELECT a.id, a.name, a.icon, a.rarity, a.ring, COUNT(c.slot) AS n FROM hoyo_assets a LEFT JOIN hoyo_consts c ON c.asset_id = a.id AND c.icon <> ''
    WHERE a.game = ? AND a.kind = 'char'${extra} GROUP BY a.id ORDER BY a.rarity DESC, a.name`).all(...params)
    .map((r) => ({ ...r, ring: ringOf(game, r.ring) }));
}

function get(id) {
  const a = charOf(id);
  if (!a) return null;
  const rows = db.prepare('SELECT slot, name, icon FROM hoyo_consts WHERE asset_id = ? ORDER BY slot').all(id);
  const slots = [1, 2, 3, 4, 5, 6].map((s) => rows.find((r) => r.slot === s) || { slot: s, name: '', icon: '' });
  return { ...a, ring: ringOf(a.game, a.ring), label: LABEL[a.game], slots };
}

const upsert = (id, slot, name, icon, src) => db.prepare(`INSERT INTO hoyo_consts(asset_id, slot, name, icon, src) VALUES(?,?,?,?,?)
  ON CONFLICT(asset_id, slot) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
  icon = CASE WHEN excluded.icon <> '' THEN excluded.icon ELSE icon END, src = COALESCE(excluded.src, src)`).run(id, slot, name, icon, src);

/** Lưu kết quả dán HTML: tải ảnh về (3 ảnh cùng lúc), giữ tên / ảnh cũ ở ô không có dữ liệu mới */
async function saveParsed(id, items) {
  if (!charOf(id)) return { ok: false, message: 'Không tìm thấy nhân vật' };
  const failed = [];
  let saved = 0;
  for (let i = 0; i < items.length; i += 3) {
    const part = items.slice(i, i + 3);
    const icons = await Promise.all(part.map((it) => hoyo.cacheIcon(it.src)));
    part.forEach((it, k) => {
      if (!icons[k] && !it.name) { failed.push(it.slot); return; }
      if (!icons[k]) failed.push(it.slot);
      upsert(id, it.slot, String(it.name || '').slice(0, 80), icons[k] || '', icons[k] ? it.src.slice(0, 500) : null);
      saved++;
    });
  }
  return { ok: true, saved, failed };
}

async function setSlot(id, slot, { name, buffer, url }) {
  if (!charOf(id) || !(slot >= 1 && slot <= 6)) return { ok: false, message: 'Không tìm thấy' };
  let icon = '';
  if (buffer) { try { icon = await lib.saveUpload(buffer); } catch { return { ok: false, message: 'File ảnh không hợp lệ' }; } }
  else if (url) { icon = await hoyo.cacheIcon(cleanSrc(url)); if (!icon) return { ok: false, message: 'Không tải được ảnh (chỉ nhận link ảnh HoYoverse)' }; }
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const had = db.prepare('SELECT 1 FROM hoyo_consts WHERE asset_id = ? AND slot = ?').get(id, slot);
  if (!had && !icon) return { ok: false, message: 'Chọn ảnh cho ô này' };
  if (had) db.prepare('UPDATE hoyo_consts SET name = ?, icon = CASE WHEN ? <> \'\' THEN ? ELSE icon END WHERE asset_id = ? AND slot = ?').run(name, icon, icon, id, slot);
  else upsert(id, slot, name, icon, buffer ? null : url || null);
  return { ok: true };
}

const removeSlot = (id, slot) => db.prepare('DELETE FROM hoyo_consts WHERE asset_id = ? AND slot = ?').run(id, slot).changes > 0;
function setRing(id, ring) {
  const a = charOf(id);
  if (!a) return false;
  db.prepare('UPDATE hoyo_assets SET ring = ? WHERE id = ?').run(/^#[0-9a-f]{6}$/i.test(ring || '') ? ring.toLowerCase() : '', id);
  return true;
}

module.exports = { LABEL, PALETTES, ringOf, parse, list, get, saveParsed, setSlot, removeSlot, setRing };
