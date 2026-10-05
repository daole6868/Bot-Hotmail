'use strict';
// Ảnh nhỏ cho thẻ sản phẩm: /uploads/products/.../abc.webp -> abc.t.webp (tối thiểu 600x360, WebP).
// Thẻ chỉ hiện ~200-300px nên bản 600px vẫn nét trên màn hình Retina; trang chi tiết vẫn dùng ảnh gốc.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const WIDTH = 600;
const HEIGHT = 360; // khung thẻ tỉ lệ 5:3 -> cả 2 chiều đều đủ cho màn hình nét, ảnh quá ngang / quá dọc không bị mờ khi cắt vừa khung
const QUALITY = 80;
const SRC_RE = /^\/uploads\/products\/[\w\-/]+\.(webp|jpe?g|png|gif)$/i;

let sharp = null;
try { sharp = require('sharp'); } catch { /* chưa cài sharp: dùng ảnh gốc */ }

const thumbPath = (pub) => (SRC_RE.test(pub || '') ? pub.replace(/\.[a-z]+$/i, '.t.webp') : '');
const diskPath = (pub) => {
  const full = path.normalize(path.join(config.paths.uploads, pub.slice('/uploads/'.length)));
  return full.startsWith(config.paths.uploads + path.sep) ? full : '';
};

/** Tạo ảnh nhỏ (bỏ qua nếu đã có). Trả về đường dẫn ảnh nhỏ hoặc '' */
async function make(pub) {
  const t = thumbPath(pub);
  if (!t || !sharp) return '';
  const src = diskPath(pub);
  const dst = diskPath(t);
  if (!src || !dst) return '';
  if (fs.existsSync(dst)) return t;
  try {
    const buf = await sharp(src, { limitInputPixels: 50e6 }).rotate()
      .resize({ width: WIDTH, height: HEIGHT, fit: 'outside', withoutEnlargement: true }).webp({ quality: QUALITY, effort: 4 }).toBuffer();
    const tmp = dst + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dst);
    known.set(pub, t);
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
  for (const pub of queue) { queue.delete(pub); await make(pub); }
  running = false;
}

/** Dùng khi hiện thẻ: có bản nhỏ -> trả bản nhỏ; chưa có -> trả ảnh gốc và tạo bản nhỏ ở nền */
function thumbOf(pub) {
  const t = thumbPath(pub);
  if (!t) return pub;
  const k = known.get(pub);
  if (k === t) return t;
  if (k && Date.now() < k) return pub; // vừa kiểm tra chưa có -> 60 giây sau mới xem lại (bản PM2 khác có thể đã tạo)
  if (known.size > 50000) known.clear();
  const dst = diskPath(t);
  if (dst && fs.existsSync(dst)) { known.set(pub, t); return t; }
  known.set(pub, Date.now() + 60000);
  if (sharp && queue.size < 5000) { queue.add(pub); setImmediate(drain); }
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
  } catch (e) { console.error('[thumbs]', e.message); }
}, 15000).unref();

module.exports = { WIDTH, thumbPath, thumbOf, make };
