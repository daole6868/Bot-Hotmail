'use strict';
/**
 * Bộ lọc tìm kiếm ở trang danh mục Acc VIP (Admin -> Giao diện -> Bộ lọc tìm kiếm). Lưu JSON trong settings.filter_cfg.
 * Game HoYoverse (Genshin / Star Rail / ZZZ) có thêm lọc AR, máy chủ, nhân vật, vũ khí theo thư viện ảnh của game đó.
 */
const { getSettings } = require('../db');

const FIELDS = {
  q: { label: 'Tìm kiếm', ph: 'Tìm tài khoản' },
  sort: { label: 'Sắp xếp', ph: 'Chọn sắp xếp' },
  price: { label: 'Mệnh giá', ph: 'Chọn mệnh giá' },
  lv: { label: 'AR', ph: 'AR tối thiểu' },
  server: { label: 'Máy chủ', ph: 'Chọn máy chủ' },
  chars: { label: 'Nhân vật', ph: 'Tìm kiếm nhân vật' },
  weapons: { label: 'Vũ khí', ph: 'Tìm kiếm vũ khí' },
};
const SORTS = [['default', 'Mặc định'], ['new', 'Mới nhất'], ['price_asc', 'Giá thấp đến cao'], ['price_desc', 'Giá cao đến thấp'], ['popular', 'Phổ biến'], ['lv_desc', 'AR cao nhất']];
const DEFAULTS = {
  fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, { on: true, label: v.label, ph: v.ph }])),
  prices: [
    { l: 'Dưới 100k', min: 0, max: 100000 }, { l: 'Từ 100k - 200k', min: 100000, max: 200000 },
    { l: 'Từ 200k - 500k', min: 200000, max: 500000 }, { l: 'Từ 500k - 1tr', min: 500000, max: 1000000 },
    { l: 'Từ 1tr - 2tr', min: 1000000, max: 2000000 }, { l: 'Trên 2tr', min: 2000000, max: 0 },
    { l: 'Trên 5tr', min: 5000000, max: 0 }, { l: 'Trên 10tr', min: 10000000, max: 0 },
  ],
  servers: [{ l: 'Asia', v: 'Asia' }, { l: 'Europe', v: 'Europe' }, { l: 'America', v: 'America' }, { l: 'TW, HK, MO', v: 'TW/HK/MO' }],
  sorts: SORTS.map(([k]) => k),
  mode: 'scroll', modeToggle: true, perPage: 12,
};

const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const s_ = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function cfg(s = getSettings()) {
  let c = {};
  try { c = JSON.parse(s.filter_cfg || '{}') || {}; } catch { c = {}; }
  const fields = {};
  for (const k of Object.keys(FIELDS)) fields[k] = { ...DEFAULTS.fields[k], ...((c.fields || {})[k] || {}) };
  return {
    fields,
    prices: Array.isArray(c.prices) && c.prices.length ? c.prices : DEFAULTS.prices,
    servers: Array.isArray(c.servers) && c.servers.length ? c.servers : DEFAULTS.servers,
    sorts: Array.isArray(c.sorts) && c.sorts.length ? c.sorts.filter((k) => SORTS.some(([x]) => x === k)) : DEFAULTS.sorts,
    mode: c.mode === 'page' ? 'page' : 'scroll',
    modeToggle: c.modeToggle !== false,
    perPage: int(c.perPage, 12, 4, 60),
  };
}

module.exports = { FIELDS, SORTS, DEFAULTS, cfg, int, s_ };
