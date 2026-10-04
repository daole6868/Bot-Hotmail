'use strict';
/**
 * Popup (Admin -> Giao diện -> Popup): ảnh + tiêu đề + nội dung + nút bấm. Cài đặt lưu JSON trong settings.popup_cfg.
 */
const { db, getSettings } = require('../db');

const HEX = /^#[0-9a-f]{6}$/i;
const SAFE_LINK = /^(https?:\/\/|\/(?!\/))/i;

const DEFAULTS = {
  enabled: false, v: 0, pages: 'home', delay: 0, repeat: 12,
  width: 520, bg: '#ffffff', text: '#374151', radius: 14,
  image: '', img_link: '', img_pos: 'top', img_w: 100, img_rw: 600, img_rh: 600,
  title: '', title_color: '#111827', title_size: 24, title_align: 'center',
  content: '',
  btn_text: '', btn_link: '', btn_bg: '#4f6bed', btn_color: '#ffffff',
};

function config(s = getSettings()) {
  let c = {};
  try { c = JSON.parse(s.popup_cfg || '{}') || {}; } catch { c = {}; }
  return { ...DEFAULTS, ...c };
}

/** Cấu hình để vẽ ngoài web: null khi tắt hoặc chưa có gì để hiện */
function forView(s = getSettings()) {
  const c = config(s);
  if (!c.enabled) return null;
  const body = !!(c.title || c.content || c.btn_text);
  if (!c.image && !body) return null;
  return { ...c, body, ratio: c.img_rw && c.img_rh ? `${c.img_rw} / ${c.img_rh}` : '' };
}

// Chuyển popup cũ (1 banner vị trí "popup" ở trang Sidebar & Popup) sang cài đặt mới — chạy 1 lần
function migrate() {
  if (getSettings().popup_cfg) return;
  const b = db.prepare("SELECT * FROM banners WHERE position = 'popup' ORDER BY is_active DESC, sort_order, id LIMIT 1").get();
  const [rw, rh] = String(getSettings().banner_size_popup || '600x600').split('x').map((n) => parseInt(n, 10));
  const cfg = b ? { ...DEFAULTS, enabled: !!b.is_active, v: Date.now(), image: b.image, img_link: b.link || '', img_rw: rw || 600, img_rh: rh || 600 } : DEFAULTS;
  const r = db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('popup_cfg', ?)").run(JSON.stringify(cfg));
  if (r.changes) db.prepare("DELETE FROM banners WHERE position = 'popup'").run();
}

module.exports = { DEFAULTS, config, forView, migrate, HEX, SAFE_LINK };
