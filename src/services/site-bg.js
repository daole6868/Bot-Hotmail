'use strict';
// Giao diện -> Nền trang: ảnh hoặc video ngắn làm nền phía sau toàn bộ trang khách (settings.site_bg)
const { getSettings } = require('../db');

const DEFAULTS = { type: 'none', img: '', video: '', scope: 'all', dark: 35, blur: 0, mobileVideo: false };
let memo = { raw: null, cfg: DEFAULTS };
function cfg() {
  const raw = getSettings().site_bg || '';
  if (memo.raw === raw) return memo.cfg;
  let c = {};
  try { c = JSON.parse(raw || '{}'); } catch { c = {}; }
  const n = (v, d, a, b) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : d; };
  const out = {
    type: ['none', 'image', 'video'].includes(c.type) ? c.type : 'none',
    img: /^\/uploads\/[\w\-/.]+$/.test(c.img || '') ? c.img : '',
    video: /^\/uploads\/[\w\-/.]+\.(mp4|webm)$/.test(c.video || '') ? c.video : '',
    scope: c.scope === 'home' ? 'home' : 'all',
    dark: n(c.dark, DEFAULTS.dark, 0, 90), blur: n(c.blur, 0, 0, 20), mobileVideo: !!c.mobileVideo,
  };
  memo = { raw, cfg: out };
  return out;
}
/** Nền cần hiện ở trang này? (null = không) */
function forPage(path) {
  const c = cfg();
  if (c.type === 'none' || (c.type === 'image' && !c.img) || (c.type === 'video' && !c.video)) return null;
  if (c.scope === 'home' && path !== '/') return null;
  return c;
}
module.exports = { DEFAULTS, cfg, forPage };
