'use strict';
/**
 * Đo chuyển đổi Google Analytics 4 / Google Ads + nguồn khách.
 * - Sự kiện (đăng ký, nạp tiền, mua hàng) lưu vào conv_events; lần mở trang tiếp theo của khách sẽ gửi lên Google rồi đánh dấu đã gửi
 *   (nạp tiền tự động về lúc khách đang ở trang khác vẫn đo được).
 * - Chỉ lưu khi đã nhập mã GA4 hoặc Google Ads.
 * - Nguồn khách: cookie gz_src (main.js ghi từ utm_* / gclid / trang giới thiệu) -> lưu vào users.signup_source lúc đăng ký.
 */
const { db, getSettings } = require('../db');

const enabled = (s = getSettings()) => !!(s.ga4_id || s.gads_id);
const insStmt = db.prepare('INSERT INTO conv_events(user_id, event, value, ref) VALUES(?,?,?,?)');
let lastPrune = 0;
function track(userId, event, value = 0, ref = null) {
  if (!userId || !enabled()) return;
  try {
    insStmt.run(userId, event, Math.max(0, Math.round(value || 0)), ref ? String(ref).slice(0, 40) : null);
    if (Date.now() - lastPrune > 3600 * 1000) { lastPrune = Date.now(); db.prepare('DELETE FROM conv_events WHERE created_at < unixepoch() - 14 * 86400').run(); }
  } catch (e) { console.error('[tracking]', e.message); }
}
const pendingStmt = db.prepare('SELECT id, event, value, ref FROM conv_events WHERE user_id = ? AND sent_at IS NULL AND created_at > unixepoch() - 7 * 86400 ORDER BY id LIMIT 10');
const pending = (userId) => (enabled() ? pendingStmt.all(userId) : []);
const markSent = (ids) => { if (ids.length) db.prepare(`UPDATE conv_events SET sent_at = unixepoch() WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids); };

/** Cookie gz_src -> JSON gọn để lưu (s: nguồn, m: kênh, c: chiến dịch, g: có gclid) */
function sourceFromCookie(header) {
  const m = /(?:^|;\s*)gz_src=([^;]+)/.exec(header || '');
  if (!m) return null;
  try {
    const j = JSON.parse(decodeURIComponent(m[1]));
    const t = (v, n) => String(v || '').replace(/[^\p{L}\p{N} ._\-/:]/gu, '').slice(0, n);
    const out = { s: t(j.s, 60) || null, m: t(j.m, 40) || null, c: t(j.c, 80) || null };
    if (j.g) out.g = 1;
    return out.s || out.c ? JSON.stringify(out) : null;
  } catch { return null; }
}

module.exports = { enabled, track, pending, markSent, sourceFromCookie };
