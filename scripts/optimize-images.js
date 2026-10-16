'use strict';
/**
 * Nén lại toàn bộ ảnh đã tải lên trước đây sang WebP (chạy 1 lần sau khi cập nhật):  npm run optimize-images
 *  - Sản phẩm, game, danh mục, banner -> WebP tối đa 1920px (chỉ thay khi ảnh mới nhỏ hơn)
 *  - Logo, ảnh chia sẻ link, GIF động: giữ nguyên
 *  - Tự backup database trước khi sửa; ảnh cũ chỉ bị xóa sau khi database đã trỏ sang ảnh mới
 * Thêm --dry để chỉ xem sẽ tiết kiệm được bao nhiêu mà không thay đổi gì.
 */
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { db } = require('../src/db');
const maintenance = require('../src/services/maintenance');
const { optimizeBuffer } = require('../src/utils/upload');

const DRY = process.argv.includes('--dry');
const fileOf = (p) => path.join(config.paths.uploads, p.slice('/uploads/'.length));
const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';

const done = new Map(); // ảnh dùng chung nhiều chỗ chỉ nén 1 lần
async function convert(publicPath, stats) {
  if (done.has(publicPath)) return done.get(publicPath);
  const r = await convertOne(publicPath, stats);
  done.set(publicPath, r);
  return r;
}
async function convertOne(publicPath, stats) {
  if (!publicPath || !publicPath.startsWith('/uploads/') || /\.webp$/i.test(publicPath)) return publicPath;
  const src = fileOf(publicPath);
  if (!src.startsWith(config.paths.uploads) || !fs.existsSync(src)) return publicPath;
  const buf = fs.readFileSync(src);
  let out = null;
  try { out = await optimizeBuffer(buf, 'image'); } catch (e) { stats.failed++; return publicPath; }
  if (!out || out.buf.length >= buf.length * 0.95) { stats.skipped++; return publicPath; }
  stats.before += buf.length;
  stats.after += out.buf.length;
  stats.converted++;
  if (DRY) return publicPath;
  const newPath = publicPath.replace(/\.[a-z]+$/i, '') + '.webp';
  fs.writeFileSync(fileOf(newPath), out.buf);
  stats.oldFiles.push(src);
  return newPath;
}

(async () => {
  if (!DRY) console.log('Đã backup database:', await maintenance.backup());
  const stats = { converted: 0, skipped: 0, failed: 0, before: 0, after: 0, oldFiles: [] };
  const updates = [];

  for (const p of db.prepare("SELECT id, images FROM products WHERE images LIKE '%/uploads/%'").all()) {
    const list = JSON.parse(p.images || '[]');
    const next = [];
    for (const img of list) next.push(await convert(img, stats));
    if (next.join() !== list.join()) updates.push(['UPDATE products SET images = ? WHERE id = ?', JSON.stringify(next), p.id]);
  }
  for (const table of ['games', 'categories', 'banners']) {
    for (const r of db.prepare(`SELECT id, image FROM ${table} WHERE image LIKE '/uploads/%'`).all()) {
      const n = await convert(r.image, stats);
      if (n !== r.image) updates.push([`UPDATE ${table} SET image = ? WHERE id = ?`, n, r.id]);
    }
  }

  if (!DRY) {
    db.transaction(() => { for (const [sql, a, b] of updates) db.prepare(sql).run(a, b); })();
    for (const f of stats.oldFiles) fs.promises.unlink(f).catch(() => {});
  }
  console.log(`${DRY ? '[Chạy thử] ' : ''}Đã nén ${stats.converted} ảnh: ${mb(stats.before)} -> ${mb(stats.after)}`
    + ` (tiết kiệm ${mb(stats.before - stats.after)}). Giữ nguyên ${stats.skipped} ảnh đã đủ nhẹ, lỗi ${stats.failed}.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
