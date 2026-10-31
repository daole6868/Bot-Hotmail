/* Áp dụng cài đặt giao diện của người dùng TRƯỚC khi trang hiển thị (tránh nháy màu).
   Lưu trong localStorage của trình duyệt, không gửi lên máy chủ. */
(function () {
  'use strict';
  var KEY = 'ui-settings';
  // [tên, màu đậm, màu nhạt, chữ trên nút]
  var ACCENTS = {
    red: ['Đỏ', '#dc2626', '#f87171'], orange: ['Cam', '#ea580c', '#fb923c'], amber: ['Hổ phách', '#d97706', '#fbbf24', '#1a1200'],
    yellow: ['Vàng', '#ca8a04', '#facc15', '#1a1400'], lime: ['Chanh', '#65a30d', '#a3e635', '#111a00'], green: ['Xanh lá', '#16a34a', '#4ade80'],
    emerald: ['Ngọc lục bảo', '#059669', '#34d399'], teal: ['Xanh mòng két', '#0d9488', '#2dd4bf'], cyan: ['Xanh lơ', '#0891b2', '#22d3ee'],
    sky: ['Xanh trời', '#0284c7', '#38bdf8'], blue: ['Xanh dương', '#2563eb', '#60a5fa'], indigo: ['Chàm', '#4f46e5', '#818cf8'],
    violet: ['Tím (mặc định)', '#7c3aed', '#a855f7'], purple: ['Tím hồng', '#9333ea', '#c084fc'], fuchsia: ['Hồng tím', '#c026d3', '#e879f9'],
    pink: ['Hồng', '#db2777', '#f472b6'], rose: ['Hồng đỏ', '#e11d48', '#fb7185'],
  };
  var BGS = { purple: ['Tím đêm', '#2f2952'], slate: ['Xám xanh', '#475569'], gray: ['Xám', '#52525b'], zinc: ['Xám kẽm', '#3f3f46'], stone: ['Xám ấm', '#57534e'] };
  var RADII = { '0': 0, '0.125': 0.4, '0.25': 0.7, '0.375': 1, '0.5': 1.35 };
  var DEFAULTS = { accent: 'violet', bg: 'purple', mode: 'dark', radius: '0.375' };

  function load() {
    var u = {};
    try { u = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { u = {}; }
    return {
      accent: ACCENTS[u.accent] ? u.accent : DEFAULTS.accent,
      bg: BGS[u.bg] ? u.bg : DEFAULTS.bg,
      mode: ['light', 'dark', 'system'].indexOf(u.mode) >= 0 ? u.mode : DEFAULTS.mode,
      radius: RADII[u.radius] !== undefined ? u.radius : DEFAULTS.radius,
    };
  }
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function apply(u) {
    var d = document.documentElement;
    var a = ACCENTS[u.accent];
    d.style.setProperty('--primary', a[1]);
    d.style.setProperty('--primary2', a[2]);
    d.style.setProperty('--on-primary', a[3] || '#fff');
    d.style.setProperty('--rk', String(RADII[u.radius]));
    d.setAttribute('data-bg', u.bg);
    var light = u.mode === 'light' || (u.mode === 'system' && mq && mq.matches);
    d.setAttribute('data-theme', light ? 'light' : 'dark');
  }
  function save(u) {
    try { localStorage.setItem(KEY, JSON.stringify(u)); } catch (e) { /* trình duyệt chặn lưu: vẫn áp dụng trong phiên */ }
  }
  var current = load();
  apply(current);
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (current.mode === 'system') apply(current); });

  window.UI_THEME = {
    ACCENTS: ACCENTS, BGS: BGS, RADII: RADII, DEFAULTS: DEFAULTS,
    get: function () { return Object.assign({}, current); },
    set: function (patch) { current = Object.assign({}, current, patch); apply(current); save(current); return current; },
    reset: function () { current = Object.assign({}, DEFAULTS); apply(current); try { localStorage.removeItem(KEY); } catch (e) { /* bỏ qua */ } return current; },
  };
})();
