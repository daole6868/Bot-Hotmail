'use strict';
/**
 * Lưu sẵn trang cho khách chưa đăng nhập (chống quá tải khi lượng truy cập tăng đột biến).
 *
 * - Khách chưa đăng nhập (không có cookie phiên "sid") mở trang công khai (trang chủ, game, danh mục, sản phẩm,
 *   khuyến mãi, tìm kiếm) -> trả kèm Cache-Control cho Cloudflare lưu N giây và X-Accel-Expires cho Nginx lưu 2 giây.
 *   Nhiều người cùng mở / F5 1 trang thì Cloudflare (hoặc Nginx) trả lời, Node gần như không phải làm gì.
 * - Mọi trang khác (đã đăng nhập, admin, tài khoản, form đăng nhập...) luôn "private, no-store": không nơi nào lưu lại.
 * - Trang được lưu không tạo cookie, không có mã CSRF riêng của ai (dùng chung cho mọi khách được).
 * - Tham số lạ trên đường dẫn (VD /?x=123 để né bộ nhớ đệm) -> chuyển về đường dẫn sạch.
 */
const { getSettings } = require('../db');

// Đường dẫn công khai được lưu + tham số hợp lệ của từng loại
const RULES = [
  { re: /^\/$/, params: [] },
  { re: /^\/khuyen-mai$/, params: [] },
  { re: /^\/search$/, params: ['q', 'page'] },
  { re: /^\/product\/[\w-]+$/, params: [] },
  { re: /^\/game\/[\w-]+$/, params: [] },
  { re: /^\/game\/[\w-]+\/[\w-]+$/, params: ['q', 'min', 'max', 'sort', 'page'] },
  { re: /^\/game\/[\w-]+\/[\w-]+\/[\w-]+$/, params: [] },
  { re: /^\/tin-tuc$/, params: ['page'] },
  { re: /^\/tin-tuc\/chuyen-muc\/[\w-]+$/, params: ['page'] },
  { re: /^\/tin-tuc\/[\w-]+$/, params: ['preview'] },
];
const ruleOf = (path) => RULES.find((r) => r.re.test(path));
// Tham số của link quảng cáo: giữ nguyên (Google Ads cần gclid trên đường dẫn để đo chuyển đổi), không coi là tham số lạ
const TRACK = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'ttclid'];
const hasSession = (req) => /(?:^|;\s*)sid=/.test(req.headers.cookie || '');
const edgeSeconds = () => {
  const n = parseInt(getSettings().edge_cache_seconds, 10);
  return Number.isFinite(n) ? Math.min(600, Math.max(0, n)) : 30;
};
const NGINX_SECONDS = 2;

function middleware(req, res, next) {
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  const rule = isRead ? ruleOf(req.path) : null;

  // Đường dẫn sạch: bỏ tham số không dùng tới (chặn kiểu tấn công thêm ?ngẫu-nhiên để mọi yêu cầu đều vào tới Node)
  if (rule) {
    const qs = req.originalUrl.indexOf('?');
    if (qs >= 0) {
      const src = new URLSearchParams(req.originalUrl.slice(qs + 1));
      const keys = [...src.keys()];
      const allowed = (k) => rule.params.includes(k) || (TRACK.includes(k) && src.get(k).length <= 300);
      const bad = !keys.length || keys.some((k, i) => !allowed(k) || !src.get(k) || keys.indexOf(k) !== i);
      if (bad) {
        const keep = new URLSearchParams();
        for (const k of [...rule.params, ...TRACK]) { const v = src.get(k); if (v && allowed(k)) keep.set(k, v); }
        const clean = keep.toString();
        res.setHeader('Cache-Control', `public, max-age=300, s-maxage=3600`);
        return res.redirect(301, req.path + (clean ? '?' + clean : ''));
      }
    }
  }

  const sec = rule && !hasSession(req) ? edgeSeconds() : 0;
  req.edgeCache = sec > 0; // CSRF không cấp cookie / mã riêng cho trang này

  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    if (!res.getHeader('Cache-Control')) {
      const status = typeof args[0] === 'number' ? args[0] : res.statusCode;
      if (req.edgeCache && status === 200 && !res.getHeader('Set-Cookie')) {
        res.setHeader('Cache-Control', `public, max-age=0, s-maxage=${sec}`);
        res.setHeader('X-Accel-Expires', String(Math.min(NGINX_SECONDS, sec)));
      } else {
        res.setHeader('Cache-Control', 'private, no-store');
      }
    }
    return writeHead.apply(this, args);
  };
  next();
}

module.exports = { middleware, edgeSeconds, RULES };
