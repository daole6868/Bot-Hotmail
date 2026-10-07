'use strict';
/**
 * Nút / thanh Hỗ trợ (Admin -> Giao diện -> Hỗ trợ): cài đặt lưu JSON trong settings.support_cfg.
 * Mỗi kênh: loại nền tảng + tiêu đề + mô tả + giá trị (SĐT / tên trang / link) -> tự tạo đường dẫn đúng.
 */
const { getSettings } = require('../db');

const digits = (v) => String(v || '').replace(/[^\d+]/g, '');
const intl = (v) => { const d = digits(v).replace(/^\+/, ''); return d.startsWith('0') ? '84' + d.slice(1) : d; }; // 0901... -> 84901...
const handle = (v) => String(v || '').trim().replace(/^@/, '');
const isUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());
const url = (v, base) => (isUrl(v) ? String(v).trim() : base + encodeURIComponent(handle(v)));

// Danh sách nền tảng: tên, icon, màu nền, gợi ý nhập, cách tạo link
const TYPES = {
  zalo: { name: 'Zalo', icon: 's-zalo', color: '#0068ff', hint: 'Số điện thoại Zalo hoặc link zalo.me/...', desc: 'Tư vấn & báo giá nhanh', link: (v) => (isUrl(v) ? v.trim() : `https://zalo.me/${digits(v).replace(/^\+84/, '0')}`) },
  messenger: { name: 'Messenger', icon: 's-messenger', color: 'linear-gradient(135deg,#00b2ff,#a033ff 60%,#ff5c87)', hint: 'Tên trang Facebook (m.me/ten-trang) hoặc link', desc: 'Nhắn tin qua Facebook', link: (v) => url(v, 'https://m.me/') },
  facebook: { name: 'Facebook', icon: 's-facebook', color: '#1877f2', hint: 'Link trang / nhóm Facebook', desc: 'Theo dõi fanpage', link: (v) => url(v, 'https://facebook.com/') },
  telegram: { name: 'Telegram', icon: 's-telegram', color: '#229ed9', hint: 'Username Telegram (không cần @) hoặc link t.me/...', desc: 'Nhắn tin Telegram', link: (v) => url(v, 'https://t.me/') },
  phone: { name: 'Gọi điện', icon: 'phone-call', color: '#16a34a', hint: 'Số điện thoại', desc: '', link: (v) => `tel:${digits(v)}` },
  sms: { name: 'Tin nhắn SMS', icon: 's-sms', color: '#0ea5e9', hint: 'Số điện thoại', desc: '', link: (v) => `sms:${digits(v)}` },
  whatsapp: { name: 'WhatsApp', icon: 's-whatsapp', color: '#25d366', hint: 'Số điện thoại WhatsApp', desc: 'Nhắn tin WhatsApp', link: (v) => (isUrl(v) ? v.trim() : `https://wa.me/${intl(v)}`) },
  viber: { name: 'Viber', icon: 's-viber', color: '#7360f2', hint: 'Số điện thoại Viber', desc: 'Nhắn tin Viber', link: (v) => `viber://chat?number=%2B${intl(v)}` },
  line: { name: 'LINE', icon: 's-line', color: '#06c755', hint: 'LINE ID hoặc link line.me/...', desc: 'Nhắn tin LINE', link: (v) => (isUrl(v) ? v.trim() : `https://line.me/ti/p/~${encodeURIComponent(handle(v))}`) },
  discord: { name: 'Discord', icon: 's-discord', color: '#5865f2', hint: 'Link mời server Discord (discord.gg/...)', desc: 'Tham gia cộng đồng', link: (v) => url(v, 'https://discord.gg/') },
  instagram: { name: 'Instagram', icon: 's-instagram', color: 'linear-gradient(45deg,#f9a825,#e1306c 50%,#833ab4)', hint: 'Username Instagram hoặc link', desc: 'Theo dõi Instagram', link: (v) => url(v, 'https://instagram.com/') },
  tiktok: { name: 'TikTok', icon: 's-tiktok', color: '#111111', hint: 'Username TikTok (không cần @) hoặc link', desc: 'Xem video trên TikTok', link: (v) => (isUrl(v) ? v.trim() : `https://www.tiktok.com/@${encodeURIComponent(handle(v))}`) },
  youtube: { name: 'YouTube', icon: 's-youtube', color: '#ff0000', hint: 'Link kênh YouTube', desc: 'Xem video hướng dẫn', link: (v) => url(v, 'https://youtube.com/@') },
  x: { name: 'X (Twitter)', icon: 's-x', color: '#000000', hint: 'Username X hoặc link', desc: 'Theo dõi trên X', link: (v) => url(v, 'https://x.com/') },
  email: { name: 'Email', icon: 'mail', color: '#ea4335', hint: 'Địa chỉ email', desc: '', link: (v) => `mailto:${String(v || '').trim()}` },
  website: { name: 'Liên kết khác', icon: 'link', color: '#6366f1', hint: 'Đường dẫn bất kỳ (https://... hoặc /trang-trong-web)', desc: '', link: (v) => String(v || '').trim() },
};
const SAFE_LINK = /^(https?:\/\/|tel:|sms:|mailto:|viber:\/\/|\/(?!\/))/i;

const DEFAULTS = {
  enabled: false, mode: 'corner', side: 'right', corner: 'br', auto: 2, once: true, device: 'all',
  title: 'Hỗ trợ nhanh', subtitle: 'Phản hồi trong 5 phút', color: '#2563eb', label: 'Hỗ trợ',
  channels: [
    { type: 'zalo', title: 'Zalo', desc: 'Tư vấn & báo giá nhanh', value: '', on: true },
    { type: 'messenger', title: 'Messenger', desc: 'Nhắn tin qua Facebook', value: '', on: true },
    { type: 'phone', title: 'Gọi điện', desc: '', value: '', on: true },
  ],
};

function config(s = getSettings()) {
  let c = {};
  try { c = JSON.parse(s.support_cfg || '{}') || {}; } catch { c = {}; }
  const cfg = { ...DEFAULTS, ...c };
  if (!Array.isArray(cfg.channels)) cfg.channels = DEFAULTS.channels;
  return cfg;
}

/** Cấu hình để vẽ ngoài web: chỉ kênh đang bật, có giá trị và link hợp lệ */
function forView(s = getSettings()) {
  const c = config(s);
  if (!c.enabled) return null;
  const items = c.channels.filter((ch) => ch.on && ch.value && TYPES[ch.type]).map((ch) => {
    const T = TYPES[ch.type];
    const href = T.link(ch.value);
    if (!SAFE_LINK.test(href)) return null;
    const ext = /^https?:/i.test(href);
    return { ...ch, href, ext, icon: T.icon, color: T.color, title: ch.title || T.name, desc: ch.desc || (['phone', 'sms', 'email'].includes(ch.type) ? ch.value : T.desc) };
  }).filter(Boolean);
  return items.length ? { ...c, items } : null;
}

module.exports = { TYPES, DEFAULTS, config, forView, SAFE_LINK };
