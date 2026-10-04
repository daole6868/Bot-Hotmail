'use strict';
/**
 * Tự dọn ảnh không còn cần (chạy hằng ngày cùng bảo trì, hoặc bấm tay ở Bảo trì dữ liệu):
 *  - Ảnh acc đã bán: xóa sau N ngày kể từ lúc bán
 *  - Ảnh xác nhận đơn cày thuê / nạp game: xóa sau N ngày kể từ lúc đơn xong / hủy
 *  - Ảnh rác: file trong uploads không còn dòng dữ liệu nào dùng tới (chèn vào bài rồi bỏ, ...)
 * Ảnh game, danh mục, gói, banner, bài viết... đang dùng thì không bao giờ bị xóa.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { db, getSettings } = require('../db');
const config = require('../config');

const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

function config_() {
  const s = getSettings();
  return {
    soldDays: int(s.img_sold_days, 30, 0, 3650),
    proofDays: int(s.img_proof_days, 30, 0, 3650),
    orphan: s.img_orphan !== '0',
  };
}

// Xóa file thật, trả về số byte giải phóng
async function unlinkUpload(pub) {
  if (!pub || !pub.startsWith('/uploads/')) return 0;
  const full = path.normalize(path.join(config.paths.uploads, pub.slice('/uploads/'.length)));
  if (!full.startsWith(config.paths.uploads + path.sep)) return 0;
  try { const st = await fsp.stat(full); await fsp.unlink(full); return st.size; } catch { return 0; }
}

const parse = (j) => { try { const a = JSON.parse(j || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

async function soldImages(days) {
  if (!days) return { n: 0, bytes: 0 };
  const rows = db.prepare("SELECT id, images FROM products WHERE status = 'sold' AND images IS NOT NULL AND images NOT IN ('', '[]') AND updated_at < ? LIMIT 2000")
    .all(nowS() - days * DAY);
  let n = 0, bytes = 0;
  const clear = db.prepare("UPDATE products SET images = '[]' WHERE id = ? AND status = 'sold'");
  for (const r of rows) {
    const imgs = parse(r.images);
    if (!clear.run(r.id).changes) continue;
    for (const i of imgs) { bytes += await unlinkUpload(i); n++; }
  }
  return { n, bytes };
}

async function proofImages(days) {
  if (!days) return { n: 0, bytes: 0 };
  const rows = db.prepare("SELECT id, proof FROM boost_orders WHERE proof IS NOT NULL AND status IN ('done','cancelled') AND finished_at < ? LIMIT 2000")
    .all(nowS() - days * DAY);
  let n = 0, bytes = 0;
  const clear = db.prepare('UPDATE boost_orders SET proof = NULL WHERE id = ? AND proof = ?');
  for (const r of rows) {
    if (!clear.run(r.id, r.proof).changes) continue;
    bytes += await unlinkUpload(r.proof); n++;
  }
  return { n, bytes };
}

// Gom mọi đường dẫn /uploads/... đang được nhắc tới ở bất kỳ bảng / cột nào trong database
function referenced() {
  const set = new Set();
  const re = /\/uploads\/[\w\-./]+/g;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").all().map((r) => r.name);
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    for (const c of cols) {
      for (const r of db.prepare(`SELECT "${c}" v FROM "${t}" WHERE typeof("${c}") = 'text' AND "${c}" LIKE '%/uploads/%'`).iterate()) {
        for (const m of r.v.match(re) || []) set.add(m.replace(/[.]+$/, ''));
      }
    }
  }
  return set;
}

async function walk(dir, out = []) {
  let items;
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) await walk(full, out);
    else if (it.isFile() && !it.name.startsWith('.')) out.push(full);
  }
  return out;
}

// Chỉ xóa file cũ hơn 3 ngày: ảnh vừa chèn vào bài viết chưa kịp lưu vẫn an toàn
async function orphanImages() {
  const used = referenced();
  const minAge = Date.now() - 3 * DAY * 1000;
  let n = 0, bytes = 0;
  for (const full of await walk(config.paths.uploads)) {
    const pub = '/uploads/' + path.relative(config.paths.uploads, full).split(path.sep).join('/');
    if (used.has(pub)) continue;
    try {
      const st = await fsp.stat(full);
      if (st.mtimeMs > minAge) continue;
      await fsp.unlink(full); n++; bytes += st.size;
    } catch { /* bỏ qua */ }
  }
  return { n, bytes };
}

let busy = false;
async function run() {
  if (busy) return null;
  busy = true;
  try {
    const c = config_();
    const sold = await soldImages(c.soldDays);
    const proof = await proofImages(c.proofDays);
    const orphan = c.orphan ? await orphanImages() : { n: 0, bytes: 0 };
    return { sold, proof, orphan, bytes: sold.bytes + proof.bytes + orphan.bytes };
  } finally { busy = false; }
}

module.exports = { run, config: config_ };
