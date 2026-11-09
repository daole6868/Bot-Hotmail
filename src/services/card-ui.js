'use strict';
// Giao diện -> Thẻ sản phẩm: số ô mỗi hàng (PC / điện thoại) + cỡ icon, cỡ chữ thẻ Acc VIP có dữ liệu nhân vật
// + theo từng cấp: căn tiêu đề (trái / giữa / phải / ẩn) và bật tắt dòng "đang bán / đã bán".
// Lưu ở settings.card_cfg, xuất ra 1 thẻ <style> nhỏ (biến CSS) chèn sau style.css.
const { getSettings } = require('../db');

// [khóa, nhãn, mặc định, min, max, bước]  (cỡ tính bằng px)
const SIZES = [
  ['ic', 'Icon nhân vật / vũ khí', 27, 21, 14, 48],
  ['title', 'Tên acc', 14.4, 11.8, 9, 22],
  ['info', '4 thông tin (AR, máy chủ...)', 11.5, 9.3, 7, 16],
  ['price', 'Giá', 16, 12.5, 9, 24],
  ['btn', 'Nút mũi tên', 13, 11.2, 8, 18],
];
// Cấp hiển thị: 1 game · 2 danh mục · 3 acc / reroll / danh mục con cày thuê · 4 gói cày thuê / nạp game (cấp 4 không có số liệu)
const LEVELS = [
  [1, 'Cấp 1 · Game', 'Thẻ game ở trang chủ', true],
  [2, 'Cấp 2 · Danh mục', 'Acc VIP, Reroll, Cày thuê, Nạp game trong trang game', true],
  [3, 'Cấp 3 · Acc / Reroll / Dịch vụ', 'Thẻ acc, thẻ reroll, danh mục con của Cày thuê (số liệu có ở Reroll và Cày thuê)', true],
  [4, 'Cấp 4 · Gói', 'Gói cày thuê, gói nạp game', false],
];
const ALIGNS = { left: 'Trái', center: 'Giữa', right: 'Phải', hide: 'Ẩn' };
const DEFAULTS = { colsPc: 4, colsMb: 2, icons: true, scroll: true, maxIcons: 20, speed: 1.6 };
LEVELS.forEach(([n, , , stats]) => { DEFAULTS['al' + n] = 'left'; if (stats) DEFAULTS['st' + n] = true; });
SIZES.forEach(([k, , pc, mb]) => { DEFAULTS[k + 'Pc'] = pc; DEFAULTS[k + 'Mb'] = mb; });

const num = (v, d, min, max) => { const n = parseFloat(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n * 10) / 10)) : d; };

function normalize(c = {}) {
  const o = {
    colsPc: num(c.colsPc, DEFAULTS.colsPc, 2, 6), colsMb: num(c.colsMb, DEFAULTS.colsMb, 1, 3),
    icons: c.icons !== false, scroll: c.scroll !== false,
    maxIcons: num(c.maxIcons, DEFAULTS.maxIcons, 4, 40), speed: num(c.speed, DEFAULTS.speed, 0.5, 5),
  };
  LEVELS.forEach(([n, , , stats]) => {
    const a = c['al' + n];
    o['al' + n] = ALIGNS[a] && !(a === 'hide' && n === 4) ? a : 'left'; // gói luôn hiện tên
    if (stats) o['st' + n] = c['st' + n] !== false;
  });
  o.colsPc = Math.round(o.colsPc); o.colsMb = Math.round(o.colsMb); o.maxIcons = Math.round(o.maxIcons);
  SIZES.forEach(([k, , pc, mb, min, max]) => { o[k + 'Pc'] = num(c[k + 'Pc'], pc, min, max); o[k + 'Mb'] = num(c[k + 'Mb'], mb, min, max); });
  return o;
}

let memo = { raw: null, cfg: null, css: '' };
function load() {
  const raw = getSettings().card_cfg || '';
  if (memo.raw === raw && memo.cfg) return memo;
  let c = {};
  try { c = JSON.parse(raw || '{}'); } catch { c = {}; }
  const cfg = normalize(c);
  const px = (v) => v + 'px';
  const tab = Math.min(cfg.colsPc, 3); // máy tính bảng: tối đa 3 ô
  const css = `<style>:root{--pg-pc:${cfg.colsPc};--pg-tab:${tab};--pg-mb:${cfg.colsMb};`
    + SIZES.map(([k]) => `--pc-${k}:${px(cfg[k + 'Pc'])};--mb-${k}:${px(cfg[k + 'Mb'])}`).join(';')
    + LEVELS.map(([n]) => { const a = cfg['al' + n] === 'hide' ? 'left' : cfg['al' + n]; return `;--al${n}:${a};--jc${n}:${{ left: 'flex-start', center: 'center', right: 'flex-end' }[a]}`; }).join('')
    + '}</style>';
  memo = { raw, cfg, css };
  return memo;
}

module.exports = { SIZES, LEVELS, ALIGNS, DEFAULTS, normalize, cfg: () => load().cfg, css: () => load().css };
