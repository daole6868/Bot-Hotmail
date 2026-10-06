'use strict';
// Upload ảnh an toàn: giới hạn dung lượng, kiểm tra magic bytes, đổi tên ngẫu nhiên
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const MAX_SIZE = 8 * 1024 * 1024; // ảnh được tự nén sau khi tải lên nên cho phép ảnh gốc lớn hơn

const SIGNATURES = [
  { ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.png', test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: '.gif', test: (b) => b.slice(0, 4).toString('ascii') === 'GIF8' },
  { ext: '.webp', test: (b) => b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE, files: 10, fields: 60 },
  fileFilter(req, file, cb) {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) return cb(new Error('Chỉ cho phép ảnh JPG, PNG, GIF, WEBP'));
    cb(null, true);
  },
});

// ---------- Tự nén ảnh khi tải lên ----------
// Ảnh thường -> WebP (nhẹ hơn ~60-80%), thu về tối đa 1920px, xoay đúng chiều, xóa thông tin EXIF (vị trí GPS...).
// Ảnh chia sẻ link (og_image) -> JPEG 1200px vì Zalo/Facebook đọc JPEG ổn định nhất. Logo & GIF động giữ nguyên.
let sharp = null;
try { sharp = require('sharp'); sharp.cache(false); sharp.concurrency(1); } catch (e) { console.warn('[upload] Chưa cài sharp -> lưu ảnh gốc không nén'); }

async function optimizeBuffer(buf, field) {
  if (!sharp || field === 'logo') return null;
  const img = sharp(buf, { failOn: 'error', limitInputPixels: 50e6 }).rotate();
  const meta = await img.metadata();
  if (meta.format === 'gif' && (meta.pages || 1) > 1) return null; // GIF động
  if (field === 'favicon') { // icon tab trình duyệt: vuông 192px, nền trong suốt, PNG
    return { buf: await img.resize({ width: 192, height: 192, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer(), mime: 'image/png' };
  }
  if (field === 'og_image') {
    return { buf: await img.resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer(), mime: 'image/jpeg' };
  }
  if (field === 'accimg') { // ảnh acc dựng sẵn (Tạo ảnh acc / Sửa ảnh): giữ cỡ người dùng chọn tới 2560px, nét chữ hơn
    return { buf: await img.resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).webp({ quality: 88, effort: 4 }).toBuffer(), mime: 'image/webp' };
  }
  return { buf: await img.resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toBuffer(), mime: 'image/webp' };
}

/** Nén lần lượt các ảnh vừa upload (thay buffer tại chỗ). Lỗi / không nhỏ hơn -> giữ ảnh gốc. */
async function optimizeUploads(req) {
  for (const f of req.files || []) {
    try {
      if (!SIGNATURES.some((s) => s.test(f.buffer))) continue; // file lạ: để saveImage từ chối
      const out = await optimizeBuffer(f.buffer, f.fieldname);
      if (out && out.buf.length < f.buffer.length * 0.98) { f.buffer = out.buf; f.mimetype = out.mime; f.size = out.buf.length; }
      else if (out && f.fieldname === 'og_image') { f.buffer = out.buf; f.mimetype = out.mime; f.size = out.buf.length; }
    } catch (e) { /* ảnh hỏng: giữ nguyên, saveImage sẽ kiểm tra */ }
  }
}

/** Lưu buffer đã upload ra đĩa, trả về đường dẫn public hoặc null nếu không hợp lệ */
function saveImage(file, folder = 'misc') {
  if (!file || !file.buffer) return null;
  const sig = SIGNATURES.find((s) => s.test(file.buffer));
  if (!sig) return null;
  const now = new Date();
  const sub = path.join(folder, `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`);
  const dir = path.join(config.paths.uploads, sub);
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(12).toString('hex') + sig.ext;
  fs.writeFileSync(path.join(dir, name), file.buffer);
  return '/uploads/' + sub.split(path.sep).join('/') + '/' + name;
}

function removeImage(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const full = path.normalize(path.join(config.paths.uploads, publicPath.slice('/uploads/'.length)));
  if (!full.startsWith(config.paths.uploads)) return;
  fs.promises.unlink(full).catch(() => {});
  if (/\/uploads\/products\/.+\.(webp|jpe?g|png|gif)$/i.test(publicPath) && !/\.t\.webp$/i.test(publicPath)) fs.promises.unlink(full.replace(/\.[a-z]+$/i, '.t.webp')).catch(() => {});
}

module.exports = { upload, saveImage, removeImage, optimizeUploads, optimizeBuffer, SIGNATURES };
