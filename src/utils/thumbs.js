'use strict';
// Ảnh nhỏ cho thẻ sản phẩm: /uploads/products/.../abc.webp -> abc.t.webp (tối thiểu 600x360, WebP).
// Thẻ chỉ hiện ~200-300px nên bản 600px vẫn nét trên màn hình Retina; trang chi tiết vẫn dùng ảnh gốc.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const WIDTH = 600;
const HEIGHT = 360; // khung thẻ tỉ lệ 5:3 -> cả 2 chiều đều đủ cho màn hình nét, ảnh quá ngang / quá dọc không bị mờ khi cắt vừa khung
// 2 loại ảnh nhỏ:
//  .t.webp  ảnh sản phẩm trên thẻ (tối thiểu 600x360)
//  .m.webp  icon nhân vật / vũ khí trên thẻ (72x72, hiện ~34px -> nét trên màn hình Retina, ~2 KB)
const IMG = /^\/uploads\/[\w\-/]+\.(webp|jpe?g|png|gif)$/i;
const VARIANT = /\.(t|m|w|l)\.webp$/i;
// Các cỡ ảnh nhỏ (tên -> đuôi file):
//  card .t.webp  ảnh thẻ sản phẩm / thẻ game (tối thiểu 600x360)
//  icon .m.webp  icon nhân vật / vũ khí (72x72)
//  wide .w.webp  banner, slider, popup (tối đa 1200px — khung hiện ~600-950px)
//  logo .l.webp  logo đầu trang (cao 120px, GIF động vẫn giữ chuyển động)
const SIZES = {
  card: { ext: '.t.webp', resize: { width: WIDTH, height: HEIGHT, fit: 'outside', withoutEnlargement: true }, q: 80 },
  icon: { ext: '.m.webp', resize: { width: 72, height: 72, fit: 'cover' }, q: 72 },
  wide: { ext: '.w.webp', resize: { width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }, q: 78 },
  logo: { ext: '.l.webp', resize: { width: 480, height: 120, fit: 'inside', withoutEnlargement: true }, q: 82, animated: true },
};
// Tự chọn cỡ theo thư mục khi không chỉ định
const AUTO = [
  { re: /^\/uploads\/(products|games)\/[\w\-/]+\.(webp|jpe?g|png|gif)$/i, size: 'card' },
  { re: /^\/uploads\/hoyo\/[a-f0-9]{40}\.webp$/, size: 'icon' },
];
function kindOf(pub, size) {
  if (!IMG.test(pub || '') || VARIANT.test(pub)) return null;
  if (size) return SIZES[size] || null;
  const a = AUTO.find((x) => x.re.test(pub));
  return a ? SIZES[a.size] : null;
}
/** Ảnh nhỏ abc.t.webp / .m / .w / .l -> các đường dẫn ảnh gốc có thể có (để dọn ảnh mồ côi không xóa nhầm) */
const originsOf = (pub) => {
  const m = /^(.*)\.(t|m|w|l)\.webp$/i.exec(pub || '');
  return m ? ['.webp', '.jpg', '.jpeg', '.png', '.gif'].map((e) => m[1] + e) : [];
};

let sharp = null;
try { sharp = require('sharp'); } catch { /* chưa cài sharp: dùng ảnh gốc */ }

const thumbPath = (pub, size) => { const k = kindOf(pub, size); return k ? pub.replace(/\.[a-z]+$/i, k.ext) : ''; };
const diskPath = (pub) => {
  const full = path.normalize(path.join(config.paths.uploads, pub.slice('/uploads/'.length)));
  return full.startsWith(config.paths.uploads + path.sep) ? full : '';
};

/** Tạo ảnh nhỏ (bỏ qua nếu đã có). Trả về đường dẫn ảnh nhỏ hoặc '' */
async function make(pub, size) {
  const t = thumbPath(pub, size);
  if (!t || !sharp) return '';
  const src = diskPath(pub);
  const dst = diskPath(t);
  if (!src || !dst) return '';
  if (fs.existsSync(dst)) return t;
  try {
    const k = kindOf(pub, size);
    let img = sharp(src, { limitInputPixels: 50e6, animated: !!k.animated });
    if (!k.animated) img = img.rotate();
    const buf = await img.resize(k.resize).webp({ quality: k.q, effort: 4 }).toBuffer();
    const tmp = dst + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dst);
    known.set(pub + k.ext, t);
    return t;
  } catch { return ''; }
}

// Nhớ ảnh nào đã có bản nhỏ để không phải kiểm tra đĩa mỗi lần hiện thẻ
const known = new Map();
const queue = new Set();
let running = false;
async function drain() {
  if (running) return;
  running = true;
  for (const q of queue) { queue.delete(q); const i = q.indexOf('|'); await make(q.slice(i + 1), q.slice(0, i) || undefined); }
  running = false;
}

/** Dùng khi hiện ảnh: có bản nhỏ -> trả bản nhỏ; chưa có -> trả ảnh gốc và tạo bản nhỏ ở nền. size: card | icon | wide | logo */
function thumbOf(pub, size) {
  const t = thumbPath(pub, size);
  if (!t) return pub;
  const key = pub + t.slice(t.length - 7);
  const k = known.get(key);
  if (k === t) return t;
  if (k && Date.now() < k) return pub; // vừa kiểm tra chưa có -> 60 giây sau mới xem lại (bản PM2 khác có thể đã tạo)
  if (known.size > 50000) known.clear();
  const dst = diskPath(t);
  if (dst && fs.existsSync(dst)) { known.set(key, t); return t; }
  known.set(key, Date.now() + 60000);
  if (sharp && queue.size < 5000) { queue.add((size || '') + '|' + pub); setImmediate(drain); }
  return pub;
}

// Khởi động (chỉ bản PM2 số 0): tạo trước ảnh nhỏ cho ảnh đại diện của các sản phẩm đang hiện
setTimeout(() => {
  if (!sharp || (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0')) return;
  try {
    const { db } = require('../db');
    for (const r of db.prepare("SELECT images FROM products WHERE status <> 'sold' AND images LIKE '[\"/uploads/products/%'").all()) {
      try { const first = JSON.parse(r.images)[0]; if (first) thumbOf(first); } catch { /* bỏ qua */ }
    }
    for (const r of db.prepare('SELECT icon FROM hoyo_assets').all()) thumbOf(r.icon); // icon nhân vật / vũ khí cho thẻ sản phẩm
  } catch (e) { console.error('[thumbs]', e.message); }
}, 15000).unref();

module.exports = { WIDTH, thumbPath, thumbOf, make, originsOf };
