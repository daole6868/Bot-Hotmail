'use strict';

function slugify(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function money(n) {
  return (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000 + 7 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 90 -> "1 giờ 30 phút", 1440 -> "1 ngày"
function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return [d && d + ' ngày', h && h + ' giờ', mm && mm + ' phút'].filter(Boolean).join(' ') || '0 phút';
}

// "2026-09-28T10:00" (giờ VN) <-> unix
function toInputDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000 + 7 * 3600 * 1000).toISOString().slice(0, 16);
}
function fromInputDate(s) {
  if (!s) return null;
  const t = Date.parse(s + ':00Z');
  return Number.isFinite(t) ? Math.floor(t / 1000) - 7 * 3600 : null;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function toInt(v, def = 0, min = -Infinity, max = Infinity) {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function str(v, max = 255) {
  return String(v ?? '').trim().slice(0, max);
}

function bool(v) {
  return v === 'on' || v === '1' || v === 'true' || v === true || v === 1 ? 1 : 0;
}

/**
 * Phân trang chung — luôn dùng LIMIT/OFFSET có giới hạn để không load toàn bộ bảng.
 */
function paginate(db, { select, from, where = '', params = [], order = '', page = 1, perPage = 20 }) {
  perPage = Math.min(100, Math.max(1, perPage));
  const total = db.prepare(`SELECT COUNT(*) c FROM ${from} ${where}`).get(...params).c;
  const pages = Math.max(1, Math.ceil(total / perPage));
  page = Math.min(Math.max(1, page), pages);
  const rows = db.prepare(`SELECT ${select} FROM ${from} ${where} ${order} LIMIT ? OFFSET ?`)
    .all(...params, perPage, (page - 1) * perPage);
  return { rows, total, page, pages, perPage };
}

// Tạo query string giữ nguyên bộ lọc khi chuyển trang
function pageUrl(baseQuery, page) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(baseQuery || {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v !== undefined && v !== '' && k !== 'page') q.set(k, v);
  }
  q.set('page', page);
  return '?' + q.toString();
}

function parseJSON(s, def) {
  try {
    const v = JSON.parse(s);
    return v ?? def;
  } catch {
    return def;
  }
}

function clientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function escapeCsv(v) {
  const s = String(v ?? '');
  // Chống CSV injection khi mở bằng Excel
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[",\n]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

// Acc Reroll lưu dạng "tài khoản | mật khẩu" -> hiển thị rõ ràng cho khách
function formatDelivered(text) {
  const t = String(text || '').trim();
  const m = !t.includes('\n') && t.match(/^(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+))?$/);
  if (!m) return t;
  return [`Tài khoản: ${m[1]}`, `Mật khẩu: ${m[2]}`, m[3] ? `Ghi chú: ${m[3]}` : ''].filter(Boolean).join('\n');
}

// Kích cỡ hiển thị từng vị trí banner (admin chỉnh ở trang Banner, lưu trong settings)
const BANNER_DEFAULT_SIZE = { main: [1200, 400], strip: [600, 300], sidebar_left: [300, 600], sidebar_right: [300, 600], popup: [600, 600] };
function bannerSize(settings, pos) {
  const d = BANNER_DEFAULT_SIZE[pos] || [1200, 400];
  const m = String((settings || {})['banner_size_' + pos] || '').match(/^(\d{2,4})x(\d{2,4})$/);
  return m ? { w: +m[1], h: +m[2] } : { w: d[0], h: d[1] };
}

// Giao diện thẻ mã khuyến mãi: kích cỡ (tỉ lệ) + số mã mỗi hàng, chỉnh ở Admin > Mã giảm giá
function couponLayout(settings) {
  const s = settings || {};
  const m = String(s.coupon_size || '').match(/^(\d{2,4})x(\d{2,4})$/);
  const w = m ? +m[1] : 600, h = m ? +m[2] : 260;
  const clamp = (v, d, lo, hi) => { const n = parseInt(v, 10); return n >= lo && n <= hi ? n : d; };
  const pc = clamp(s.coupon_cols_pc, 4, 1, 6), mobile = clamp(s.coupon_cols_m, 2, 1, 3);
  return { w, h, pc, mobile, tablet: Math.min(pc, 3), vertical: w / h < 1.15 };
}

module.exports = {
  couponLayout, formatDelivered, bannerSize, BANNER_DEFAULT_SIZE,
  slugify, money, fmtDate, fmtDuration, toInputDate, fromInputDate, now, toInt, str, bool,
  paginate, pageUrl, parseJSON, clientIp, escapeCsv,
};
