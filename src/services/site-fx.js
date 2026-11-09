'use strict';
// Giao diện -> Hiệu ứng: hiệu ứng dịp lễ / thường ngày trên trang khách (settings.site_fx).
// Mỗi hiệu ứng bật / tắt riêng, có thể đặt khoảng thời gian tự chạy (giờ Việt Nam) và chữ trên băng chúc mừng.
const { getSettings } = require('../db');

// k: mã hiệu ứng (khớp public/js/fx.js), g: nhóm, when: gợi ý thời gian, text: chữ băng mặc định, rb: [màu viền, màu giữa, màu chữ]
const LIST = [
  { k: 'tet', g: 'vn', name: 'Tết Nguyên Đán', when: '23 tháng Chạp – mùng 10 tháng Giêng', text: 'Chúc Mừng Năm Mới · An Khang Thịnh Vượng', rb: ['#b3121f', '#d61f2c', '#ffd66b'] },
  { k: 'ongtao', g: 'vn', name: 'Ông Công Ông Táo', when: '20 – 23 tháng Chạp', text: 'Tiễn Ông Công Ông Táo về trời · 23 tháng Chạp', rb: ['#7a2e00', '#a84300', '#ffe08a'] },
  { k: 'giotto', g: 'vn', name: 'Giỗ Tổ Hùng Vương', when: 'Mùng 8 – 10 tháng 3 âm lịch', text: 'Uống nước nhớ nguồn · Giỗ Tổ Hùng Vương mùng 10 tháng 3', rb: ['#4a3010', '#7a521d', '#f2cd88'] },
  { k: 'le304', g: 'vn', name: 'Thống nhất 30/4 · 1/5', when: '28/4 – 2/5', text: 'Mừng ngày Thống nhất đất nước 30/4 · Quốc tế Lao động 1/5', rb: ['#b3121f', '#d61f2c', '#ffe14d'] },
  { k: 'thieunhi', g: 'vn', name: 'Quốc tế Thiếu nhi 1/6', when: '30/5 – 2/6', text: 'Chúc mừng Quốc tế Thiếu nhi 1/6', rb: ['#1864ab', '#1c7ed6', '#ffffff'] },
  { k: 'vulan', g: 'vn', name: 'Vu Lan báo hiếu', when: 'Mùng 10 – 15 tháng 7 âm lịch', text: 'Vu Lan báo hiếu · Nhớ ơn cha mẹ', rb: ['#7d1d48', '#a61e4d', '#ffffff'] },
  { k: 'trungthu', g: 'vn', name: 'Tết Trung Thu', when: 'Mùng 10 – 16 tháng 8 âm lịch', text: 'Trung Thu đoàn viên · Rằm tháng Tám', rb: ['#8a4b00', '#b86a00', '#ffd66b'] },
  { k: 'quockhanh', g: 'vn', name: 'Quốc khánh 2/9', when: '31/8 – 3/9', text: 'Mừng Quốc khánh 2/9 · Độc lập – Tự do – Hạnh phúc', rb: ['#b3121f', '#d61f2c', '#ffe14d'] },
  { k: 'phunu', g: 'vn', name: 'Phụ nữ 8/3 · 20/10', when: '6/3 – 8/3 và 18/10 – 20/10', text: '', rb: ['#8c1d4a', '#c2255c', '#ffffff'] },
  { k: 'nhagiao', g: 'vn', name: 'Nhà giáo Việt Nam 20/11', when: '17/11 – 20/11', text: 'Tri ân thầy cô · Ngày Nhà giáo Việt Nam 20/11', rb: ['#0b5c4a', '#0f7a62', '#ffe066'] },
  { k: 'newyear', g: 'world', name: 'Năm mới dương lịch', when: '28/12 – 2/1', text: '', rb: ['#0b3a5c', '#0e4f7d', '#ffffff'], cd: 'newyear' },
  { k: 'valentine', g: 'world', name: 'Valentine', when: '12/2 – 15/2', text: 'Happy Valentine · Yêu thương ngập tràn', rb: ['#831843', '#be185d', '#ffffff'] },
  { k: 'halloween', g: 'world', name: 'Halloween', when: '25/10 – 1/11', text: 'Happy Halloween · Trick or Treat', rb: ['#2a0f3d', '#4a1766', '#ff9a3c'] },
  { k: 'noel', g: 'world', name: 'Giáng Sinh', when: '15/12 – 26/12', text: 'Merry Christmas · Giáng Sinh an lành', rb: ['#14532d', '#166534', '#ffffff'] },
  { k: 'sale', g: 'world', name: 'Sale 11.11 · 12.12', when: 'Tự chọn ngày', text: 'SIÊU SALE · Giảm giá toàn bộ Acc VIP · Số lượng có hạn', rb: ['#f97316', '#ef4444', '#ffffff'], marquee: true, cd: 'end' },
  { k: 'sakura', g: 'daily', name: 'Hoa anh đào', when: 'Mùa xuân hoặc quanh năm' },
  { k: 'snowlite', g: 'daily', name: 'Tuyết nhẹ', when: 'Mùa đông' },
  { k: 'fireflies', g: 'daily', name: 'Đom đóm', when: 'Quanh năm' },
  { k: 'meteor', g: 'daily', name: 'Sao băng', when: 'Quanh năm' },
  { k: 'gems', g: 'daily', name: 'Mưa đá quý gacha', when: 'Sự kiện gacha, nhân vật mới' },
  { k: 'glow', g: 'daily', name: 'Viền thẻ sản phẩm phát sáng', when: 'Quanh năm' },
  { k: 'confettiBuy', g: 'act', name: 'Pháo giấy khi mua / nạp thành công', when: 'Quanh năm' },
  { k: 'cursor', g: 'act', name: 'Vệt sao theo chuột (máy tính)', when: 'Quanh năm' },
];
const GROUPS = { vn: 'Lễ Việt Nam', world: 'Lễ quốc tế & mua sắm', daily: 'Hiệu ứng thường ngày', act: 'Hiệu ứng tương tác' };
const BY = Object.fromEntries(LIST.map((e) => [e.k, e]));
const DEFAULTS = { on: true, dens: 1, mobile: true, banner: true, items: {} };
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

let memo = { raw: null, cfg: DEFAULTS };
function cfg() {
  const raw = getSettings().site_fx || '';
  if (memo.raw === raw) return memo.cfg;
  let c = {};
  try { c = JSON.parse(raw || '{}'); } catch { c = {}; }
  const items = {};
  for (const e of LIST) {
    const it = (c.items || {})[e.k] || {};
    items[e.k] = { on: !!it.on, from: DT.test(it.from || '') ? it.from : '', to: DT.test(it.to || '') ? it.to : '', text: typeof it.text === 'string' ? it.text.slice(0, 160) : null };
  }
  const out = { on: c.on !== false, dens: [0.5, 1, 1.7].includes(+c.dens) ? +c.dens : 1, mobile: c.mobile !== false, banner: c.banner !== false, items };
  memo = { raw, cfg: out };
  return out;
}

// Giờ Việt Nam dạng 'YYYY-MM-DDTHH:mm' để so với ngày admin nhập
const vnNow = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 16);
/** Trạng thái 1 hiệu ứng: off | wait (chưa tới ngày) | done (đã qua) | live */
function state(it, now = vnNow()) {
  if (!it.on) return 'off';
  if (it.from && now < it.from) return 'wait';
  if (it.to && now > it.to) return 'done';
  return 'live';
}
const vnToMs = (s) => Date.parse(s + ':00+07:00');
function nextNewYear() { const y = new Date(Date.now() + 7 * 3600e3).getUTCFullYear() + 1; return Date.parse(`${y}-01-01T00:00:00+07:00`); }
function nextDay(m, d) { const n = new Date(Date.now() + 7 * 3600e3), y = n.getUTCFullYear(); const t = Date.parse(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+07:00`); return t > Date.now() ? t : Date.parse(`${y + 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T00:00:00+07:00`); }

/**
 * Hiệu ứng cho trang khách. preview = mã hiệu ứng admin bấm "Xem thử" (bỏ qua bật / tắt và ngày).
 * Trả về null nếu không có gì chạy, ngược lại { keys, dens, mobile, banner: { text, rb, marquee, cd } | null }
 */
let pageMemo = { key: '', v: null };
function forPage(preview) {
  const c = cfg();
  const minute = vnNow();
  if (!preview && pageMemo.key === memo.raw + minute) return pageMemo.v;
  let keys;
  if (preview && BY[preview]) keys = [preview];
  else keys = c.on ? LIST.filter((e) => state(c.items[e.k], minute) === 'live').map((e) => e.k) : [];
  let v = null;
  if (keys.length) {
    let banner = null;
    const bk = keys.find((k) => BY[k].rb);
    if (bk && (c.banner || preview)) {
      const e = BY[bk], it = c.items[bk];
      let text = it.text != null && it.text !== '' ? it.text : e.text;
      if (bk === 'phunu' && !text) text = nextDay(10, 20) < nextDay(3, 8) ? 'Chúc mừng ngày Phụ nữ Việt Nam 20/10' : 'Chúc mừng Quốc tế Phụ nữ 8/3';
      if (bk === 'newyear' && !text) text = `Happy New Year ${new Date(nextNewYear()).getUTCFullYear()}`;
      let cd = 0, cdLabel = '';
      if (e.cd === 'newyear') { cd = nextNewYear(); cdLabel = 'Còn'; }
      if (e.cd === 'end' && it.to) { cd = vnToMs(it.to); cdLabel = 'Kết thúc sau'; }
      banner = { text, rb: e.rb, marquee: !!e.marquee, cd: cd > Date.now() ? cd : 0, cdLabel };
    }
    v = { keys, dens: c.dens, mobile: c.mobile, banner };
  }
  if (!preview) pageMemo = { key: memo.raw + minute, v };
  return v;
}

module.exports = { LIST, GROUPS, BY, DEFAULTS, cfg, state, vnNow, forPage };
