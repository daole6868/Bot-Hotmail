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
  if (field === 'sitebg') { // ảnh nền toàn trang: giữ nét trên màn hình lớn
    return { buf: await img.resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85, effort: 4 }).toBuffer(), mime: 'image/webp' };
  }
  if (field === 'accimg') return null; // ảnh từ Tạo ảnh acc / Sửa ảnh: giữ nguyên định dạng + chất lượng người dùng chọn (không nén lần 2 cho khỏi mờ)
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
  // các bản nhỏ đi kèm (thẻ / banner / logo)
  if (/\.(webp|jpe?g|png|gif)$/i.test(publicPath) && !/\.(t|m|w|l)\.webp$/i.test(publicPath)) ['.t.webp', '.w.webp', '.l.webp'].forEach((e) => fs.promises.unlink(full.replace(/\.[a-z]+$/i, e)).catch(() => {}));
}

// Ảnh dựng sẵn từ Tạo ảnh acc / Sửa ảnh (có thể xuất 2× PNG): cho phép tới 20MB, chỉ 1-2 file
const uploadBig = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 2, fields: 20 },
  fileFilter(req, file, cb) { if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) return cb(new Error('Chỉ cho phép ảnh JPG, PNG, WEBP')); cb(null, true); } });

// Nền trang: ảnh hoặc video ngắn (MP4 / WebM) tới 40MB
const VIDEO_SIG = [
  { ext: '.mp4', mime: 'video/mp4', test: (b) => b.length > 12 && b.slice(4, 8).toString('ascii') === 'ftyp' },
  { ext: '.webm', mime: 'video/webm', test: (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];
const uploadMedia = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 2, fields: 30 },
  fileFilter(req, file, cb) { if (!/^(image\/(jpeg|png|webp|gif)|video\/(mp4|webm))$/.test(file.mimetype)) return cb(new Error('Chỉ cho phép ảnh JPG, PNG, WEBP hoặc video MP4, WEBM')); cb(null, true); } });
/** Lưu video đã upload (kiểm tra đúng file MP4 / WebM theo nội dung, đổi tên ngẫu nhiên) */
function saveVideo(file, folder = 'sitebg') {
  if (!file || !file.buffer) return null;
  const sig = VIDEO_SIG.find((s) => s.test(file.buffer));
  if (!sig) return null;
  const now = new Date();
  const sub = path.join(folder, `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`);
  const dir = path.join(config.paths.uploads, sub);
  fs.mkdirSync(dir, { recursive: true });
  const name = crypto.randomBytes(12).toString('hex') + sig.ext;
  fs.writeFileSync(path.join(dir, name), file.buffer);
  return '/uploads/' + sub.split(path.sep).join('/') + '/' + name;
}

module.exports = { uploadMedia, saveVideo, uploadBig, upload, saveImage, removeImage, optimizeUploads, optimizeBuffer, SIGNATURES };
