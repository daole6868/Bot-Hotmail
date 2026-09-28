'use strict';
/**
 * Bộ icon SVG vẽ riêng cho shop (lưới 24x24, nét 2px, bo tròn, màu theo currentColor).
 * Dùng trong view: <%- I('cart') %>  hoặc  <%- I('cart', 'lg') %>
 */
const PATHS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  gamepad: '<path d="M7 7h10a5 5 0 0 1 4.9 6l-.8 3.6a2.6 2.6 0 0 1-4.5 1.1L14.8 16H9.2l-1.8 1.7a2.6 2.6 0 0 1-4.5-1.1L2.1 13A5 5 0 0 1 7 7Z"/><path d="M8 10v4M6 12h4"/><circle cx="15.5" cy="11" r=".6" fill="currentColor"/><circle cx="17.5" cy="13" r=".6" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20.5c1.2-3.8 4.3-5.5 8-5.5s6.8 1.7 8 5.5"/>',
  users: '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 19.5c.9-3.2 3.4-4.8 6.5-4.8s5.6 1.6 6.5 4.8"/><path d="M15.5 5.3a3.5 3.5 0 0 1 0 6.4M18 14.9c1.8.6 3 2.1 3.5 4.6"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19M6 15h4"/>',
  gift: '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5V20h14v-7.5M12 8.5V20"/><path d="M12 8.5C10.5 5 7 4.5 7 6.8S10 8.5 12 8.5ZM12 8.5c1.5-3.5 5-4 5-1.7S14 8.5 12 8.5Z"/>',
  cart: '<path d="M2.5 3.5h2.7l2.3 11h11l2-8H6.3"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
  bag: '<path d="M5 8h14l-1 12.5H6L5 8Z"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2.5h8.7A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-12Z"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.7 2.7L16 9.5"/>',
  alert: '<path d="M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r=".7" fill="currentColor"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'chevrons-left': '<path d="m12 6-6 6 6 6M18 6l-6 6 6 6"/>',
  'chevrons-right': '<path d="m6 6 6 6-6 6M12 6l6 6-6 6"/>',
  'caret-down': '<path d="m7 10 5 5 5-5"/>',
  save: '<path d="M5 3.5h11l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5Z"/><path d="M7.5 3.5v5h8v-5M7.5 20.5v-6h9v6"/>',
  chart: '<path d="M3.5 3.5v17h17"/><rect x="7" y="11" width="3" height="6" rx=".5"/><rect x="12" y="7" width="3" height="10" rx=".5"/><rect x="17" y="13" width="3" height="4" rx=".5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M4.4 6.1l1.7 1.7M17.9 16.2l1.7 1.7M2.8 12h2.4M18.8 12h2.4M4.4 17.9l1.7-1.7M17.9 7.8l1.7-1.7"/><circle cx="12" cy="12" r="6.5"/>',
  key: '<circle cx="8" cy="15" r="4.5"/><path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2.5"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.5"/><path d="M12 14.5v2.5"/>',
  box: '<path d="M12 2.8 20.5 7v10L12 21.2 3.5 17V7L12 2.8Z"/><path d="M3.5 7 12 11.2 20.5 7M12 11.2v10"/>',
  broom: '<path d="M14 3.5 10.5 11"/><path d="M6.5 11h8l2 3.5-1.5 6h-9l-1.5-6 2-3.5Z"/><path d="M9 20.5l.5-3M12 20.5v-3M15 20.5l-.5-3"/>',
  download: '<path d="M12 3.5v12M7 11l5 5 5-5"/><path d="M4 20.5h16"/>',
  inbox: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19v-5.5Z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
  bank: '<path d="M3 9.5 12 4l9 5.5H3Z"/><path d="M5 9.5v8M9.5 9.5v8M14.5 9.5v8M19 9.5v8M3 20.5h18"/>',
  shield: '<path d="M12 3 4.5 6v6c0 4.4 3.1 7.8 7.5 9 4.4-1.2 7.5-4.6 7.5-9V6L12 3Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  tools: '<path d="M14.5 6.5a4 4 0 0 0 5 5L12 19a2.1 2.1 0 0 1-3-3l7.5-7.5"/><path d="M14.5 6.5 17 4l3 3-2.5 2.5M4 4l5 5M3.5 7.5 7.5 3.5"/>',
  fire: '<path d="M12 21c-4 0-7-2.6-7-6.5 0-3.3 2.4-5.5 3.5-8 .8 1.8 2 2.8 3 3.2C11.3 6.5 13 4 15.5 3c-.4 2.5.7 4.5 2 6.2 1 1.4 1.5 3 1.5 5.3 0 3.9-3 6.5-7 6.5Z"/><path d="M12 21c-1.8 0-3-1.2-3-3 0-1.6 1.2-2.6 2-4 .8 1.2 1.6 1.6 2.3 1.8.3-.6.6-1.1 1.2-1.6.3 1 .5 1.8.5 2.8 0 2.4-1.2 4-3 4Z"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.8"/><path d="M6 9.5v5M18 9.5v5"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1"/><path d="M4.5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V8.5M10 12.5h4"/>',
  bolt: '<path d="M13.5 2.5 4.5 13.5H12l-1.5 8 9-11H12l1.5-8Z"/>',
  compress: '<path d="M9 3.5v5.5H3.5M15 3.5v5.5h5.5M9 20.5V15H3.5M15 20.5V15h5.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.3L3.5 9"/><path d="M3.5 4v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.3L20.5 15"/><path d="M20.5 20v-5h-5"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  receipt: '<path d="M5.5 3h13v18l-2.2-1.5L14.2 21 12 19.5 9.8 21l-2.1-1.5L5.5 21V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  ticket: '<path d="M3 8.5V6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v2a3.5 3.5 0 0 0 0 7v2a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-2a3.5 3.5 0 0 0 0-7Z"/><path d="M14.5 5v2.5M14.5 10.8v2.4M14.5 16.5V19"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 8.5"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r="1" fill="currentColor"/><circle cx="4.8" cy="12" r="1" fill="currentColor"/><circle cx="4.8" cy="17.5" r="1" fill="currentColor"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9S14.5 18.4 12 21c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z"/>',
  star: '<path d="m12 3.3 2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6-4.4-4.2 6-.9L12 3.3Z"/>',
  eye: '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3.5"/>',
  logout: '<path d="M14.5 4.5H18a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-3.5"/><path d="M10 16.5 5.5 12 10 7.5M5.5 12H15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  filter: '<path d="M3.5 5h17l-6.5 8v5.5l-4 2V13L3.5 5Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6 8.5 7 8.5-7"/>',
  chat: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-9l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M7.5 10h9M7.5 13h5"/>',
  tag: '<path d="M3.5 3.5h8l9 9-8 8-9-9v-8Z"/><circle cx="8" cy="8" r="1.5"/>',
  edit: '<path d="M4 20h4L19.5 8.5a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4h5v2.5M6 6.5l1 14h10l1-14"/><path d="M10 10.5v6M14 10.5v6"/>',
  layers: '<path d="M12 3 21 8l-9 5-9-5 9-5Z"/><path d="m3 12.5 9 5 9-5M3 17l9 5 9-5"/>',
  trophy: '<path d="M7.5 4h9v5a4.5 4.5 0 0 1-9 0V4Z"/><path d="M7.5 6H4.5a3 3 0 0 0 3 4.5M16.5 6h3a3 3 0 0 1-3 4.5M12 13.5V17M8.5 20.5h7M9.5 17h5l.5 3.5H9l.5-3.5Z"/>',
};

function I(name, cls = '') {
  const p = PATHS[name] || PATHS.star;
  return `<svg class="ico${cls ? ' ico-' + cls.split(' ').join(' ico-') : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

module.exports = { I, PATHS };
