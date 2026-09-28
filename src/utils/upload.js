'use strict';
// Upload ảnh an toàn: giới hạn dung lượng, kiểm tra magic bytes, đổi tên ngẫu nhiên
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const MAX_SIZE = 4 * 1024 * 1024;

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
}

module.exports = { upload, saveImage, removeImage };
