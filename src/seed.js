'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, setSetting, getSettings } = require('./db');
const { encrypt, sha256, randomCode } = require('./utils/crypto');
const config = require('./config');

const DEFAULT_SETTINGS = {
  site_name: 'ShopAcc.VN',
  site_slogan: 'Shop acc game uy tín - Giao dịch tự động 24/7',
  site_description: 'Mua bán tài khoản game Liên Quân, Free Fire, PUBG, Genshin, Roblox, Valorant... uy tín, giao acc tự động 24/7.',
  notice: 'Nạp tiền qua ngân hàng được cộng tự động sau 1-3 phút. Nhập mã KM để được giảm giá!',
  // Footer (sửa ở Admin › Footer)
  footer_about_title: '',
  footer_about_text: '',
  footer_col1_title: 'Hỗ trợ',
  footer_col1_links: 'Nạp tiền | /user/deposit\nMã khuyến mãi | /khuyen-mai\nLịch sử mua hàng | /user/orders',
  footer_col2_title: 'Chính sách',
  footer_col2_links: 'Giao acc tự động ngay sau khi mua\nNạp tiền ngân hàng tự động 24/7\nBảo hành theo mô tả từng sản phẩm',
  footer_col3_title: '',
  footer_col3_links: '',
  social_facebook: '',
  social_zalo: '',
  social_tiktok: '',
  social_youtube: '',
  social_telegram: '',
  bank_code: 'MB',
  bank_name: 'MB Bank',
  bank_account: '',
  bank_owner: '',
  deposit_min: '10000',
  deposit_max: '50000000',
  maintenance_mode: '0',
  allow_register: '1',
  footer_text: '© ShopAcc.VN - Hệ thống bán acc game tự động.',
};

function ensureSettings() {
  const cur = getSettings();
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (cur[k] === undefined) setSetting(k, v);
}

function ensureAdmin() {
  const has = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (has) return;
  const hash = bcrypt.hashSync(config.admin.password, 12);
  db.prepare("INSERT INTO users(username, email, password_hash, role) VALUES(?,?,?,'admin')")
    .run(config.admin.username, config.admin.email, hash);
  console.log(`[seed] Đã tạo tài khoản admin "${config.admin.username}" (đổi mật khẩu ngay sau khi đăng nhập)`);
}

// ---------- Ảnh demo dạng SVG (thay bằng ảnh thật trong trang Admin) ----------
function svgBanner(title, sub, c1, c2, w = 1200, h = 400) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<circle cx="${w * 0.85}" cy="${h * 0.3}" r="${h * 0.45}" fill="#fff" opacity=".08"/>
<circle cx="${w * 0.1}" cy="${h * 0.9}" r="${h * 0.35}" fill="#fff" opacity=".06"/>
<text x="50%" y="${h * 0.48}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${Math.round(h / 7)}" font-weight="900" fill="#fff">${title}</text>
<text x="50%" y="${h * 0.66}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${Math.round(h / 16)}" fill="#fff" opacity=".9">${sub}</text>
</svg>`;
}

function svgSide(title, sub, c1, c2) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="600" viewBox="0 0 300 600">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect width="100%" height="100%" rx="16" fill="url(#g)"/>
<text x="150" y="250" text-anchor="middle" font-family="Arial" font-size="42" font-weight="900" fill="#fff">${title}</text>
<text x="150" y="300" text-anchor="middle" font-family="Arial" font-size="22" fill="#fff">${sub}</text>
<rect x="60" y="360" width="180" height="50" rx="25" fill="#fff"/><text x="150" y="393" text-anchor="middle" font-family="Arial" font-size="20" font-weight="700" fill="${c2}">XEM NGAY</text>
</svg>`;
}

function writeDemo(name, content) {
  const dir = path.join(config.paths.root, 'public', 'img', 'catalog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
  return '/img/catalog/' + name;
}

// Danh mục game thật (cấu trúc cấp 1 + cấp 2). Sản phẩm do admin tự thêm.
const CATALOG = [
  { name: 'Liên Quân Mobile', c: ['#2563eb', '#7c3aed'], hot: 1, glyph: 'sword',
    cats: ['Acc VIP Full Skin', 'Acc Rank Cao Thủ', 'Acc Reg Giá Rẻ', 'Random Liên Quân'] },
  { name: 'Free Fire', c: ['#f97316', '#dc2626'], hot: 1, glyph: 'target',
    cats: ['Acc Nhiều Súng Nâng Cấp', 'Acc Reg Giá Rẻ', 'Random Free Fire'] },
  { name: 'PUBG Mobile', c: ['#ca8a04', '#78350f'], hot: 0, glyph: 'target', cats: ['Acc Nhiều Outfit', 'Acc Rank Cao'] },
  { name: 'Genshin Impact', c: ['#0891b2', '#4f46e5'], hot: 1, glyph: 'star', cats: ['Acc Reroll 5 Sao', 'Acc Endgame'] },
  { name: 'Roblox', c: ['#16a34a', '#0f172a'], hot: 0, glyph: 'cube', cats: ['Acc Blox Fruits', 'Acc Nhiều Robux'] },
  { name: 'Valorant', c: ['#e11d48', '#1e1b4b'], hot: 0, glyph: 'target', cats: ['Acc Nhiều Skin', 'Acc Rank Cao'] },
  { name: 'FC Online', c: ['#059669', '#1e3a8a'], hot: 0, glyph: 'ball', cats: ['Acc Đội Hình Khủng', 'Acc Nhiều BP'] },
  { name: 'Play Together', c: ['#ec4899', '#8b5cf6'], hot: 0, glyph: 'star', cats: ['Acc VIP', 'Acc Nhiều Sao'] },
];

// Họa tiết vẽ tay cho ảnh game (SVG, không dùng icon có sẵn)
const GLYPHS = {
  sword: '<path d="M60 20 L68 28 L36 60 L28 60 L28 52 Z M24 56 L36 68 M20 72 L32 60" />',
  target: '<circle cx="48" cy="48" r="26"/><circle cx="48" cy="48" r="14"/><path d="M48 12 V30 M48 66 V84 M12 48 H30 M66 48 H84"/>',
  star: '<path d="M48 14 L57 38 L82 39 L62 54 L69 79 L48 65 L27 79 L34 54 L14 39 L39 38 Z"/>',
  cube: '<path d="M48 14 L78 30 L78 64 L48 82 L18 64 L18 30 Z M18 30 L48 46 L78 30 M48 46 V82"/>',
  ball: '<circle cx="48" cy="48" r="30"/><path d="M48 32 L60 41 L55 56 H41 L36 41 Z M48 18 V32 M60 41 L76 36 M55 56 L64 72 M41 56 L32 72 M36 41 L20 36"/>',
};

function svgGame(title, c1, c2, glyph, w = 400, h = 250) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
<pattern id="d" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="#fff" opacity=".12"/></pattern></defs>
<rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" fill="url(#d)"/>
<g transform="translate(${w - 150} ${h / 2 - 70}) scale(1.45)" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".28">${GLYPHS[glyph] || GLYPHS.star}</g>
<path d="M0 ${h * 0.78} Q${w / 2} ${h * 0.6} ${w} ${h * 0.82} V${h} H0Z" fill="#000" opacity=".18"/>
<text x="24" y="${h * 0.56}" font-family="Arial,sans-serif" font-size="${Math.round(h / 8.5)}" font-weight="900" fill="#fff">${title}</text>
</svg>`;
}

function seedCatalog() {
  if (db.prepare('SELECT COUNT(*) c FROM games').get().c > 0) return;
  console.log('[seed] Tạo danh mục game & banner...');
  const banners = [
    ['main', 'SHOP ACC GAME UY TÍN', 'Giao acc tự động ngay sau khi thanh toán', '#7c3aed', '#db2777'],
    ['main', 'NẠP TIỀN TỰ ĐỘNG 24/7', 'Chuyển khoản ngân hàng - cộng tiền sau 1 phút', '#f59e0b', '#ef4444'],
    ['main', 'SĂN MÃ GIẢM GIÁ', 'Theo dõi mục Khuyến mãi để nhận mã mới', '#0ea5e9', '#6366f1'],
  ];
  const insBanner = db.prepare('INSERT INTO banners(position, title, image, link, sort_order) VALUES(?,?,?,?,?)');
  banners.forEach((b, i) => insBanner.run(b[0], b[1], writeDemo(`banner-${i + 1}.svg`, svgBanner(b[1], b[2], b[3], b[4])), i === 1 ? '/user/deposit' : '/khuyen-mai', i));
  insBanner.run('sidebar_left', 'Khuyến mãi', writeDemo('side-left.svg', svgSide('KHUYẾN MÃI', 'Mã giảm giá mới', '#22c55e', '#0f766e')), '/khuyen-mai', 0);
  insBanner.run('sidebar_right', 'Nạp tiền', writeDemo('side-right.svg', svgSide('NẠP TIỀN', 'Tự động 24/7', '#f97316', '#be123c')), '/user/deposit', 0);

  const slug = (x) => require('./utils/helpers').slugify(x);
  const insGame = db.prepare('INSERT INTO games(name, slug, image, color, sort_order, is_hot, description) VALUES(?,?,?,?,?,?,?)');
  const insCat = db.prepare('INSERT INTO categories(game_id, name, slug, image, sort_order, description) VALUES(?,?,?,?,?,?)');
  db.transaction(() => {
    CATALOG.forEach((g, gi) => {
      const gs = slug(g.name);
      const gid = insGame.run(g.name, gs, writeDemo(`game-${gs}.svg`, svgGame(g.name.toUpperCase(), g.c[0], g.c[1], g.glyph)),
        g.c[0], gi, g.hot, `Mua bán acc ${g.name} uy tín, giá tốt, giao acc tự động.`).lastInsertRowid;
      g.cats.forEach((cn, ci) => {
        const cs = slug(cn);
        insCat.run(gid, cn, cs, writeDemo(`cat-${gs}-${cs}.svg`, svgGame(cn, g.c[1], g.c[0], g.glyph, 400, 220)), ci, `${cn} - ${g.name}`);
      });
    });
  })();
}

// Sản phẩm + mã KM mẫu để thử nghiệm (chỉ khi SEED_DEMO=true). KHÔNG bật khi chạy thật.
function seedDemoProducts() {
  if (db.prepare('SELECT COUNT(*) c FROM products').get().c > 0) return;
  console.log('[seed] SEED_DEMO=true -> tạo sản phẩm thử nghiệm');
  const cats = db.prepare('SELECT c.id, c.name, c.image FROM categories c').all();
  const insProd = db.prepare(`INSERT INTO products(category_id, code, title, type, price, images, attributes, description, credentials_enc)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const insStock = db.prepare('INSERT INTO product_stock(product_id, data_enc, data_hash) VALUES(?,?,?)');
  db.transaction(() => {
    for (const c of cats) {
      const isStock = /Random/.test(c.name);
      for (let i = 1; i <= 3; i++) {
        const code = randomCode(8);
        const pid = insProd.run(c.id, code, `[TEST] ${c.name} #${code}`, isStock ? 'stock' : 'account', 10000 * i,
          JSON.stringify([c.image]), JSON.stringify([{ k: 'Ghi chú', v: 'Sản phẩm thử nghiệm' }]), 'Sản phẩm thử nghiệm.',
          isStock ? null : encrypt(`TK: test_${code.toLowerCase()}\nMK: ${randomCode(10)}`)).lastInsertRowid;
        if (isStock) for (let k = 0; k < 5; k++) { const d = `TEST-${randomCode(12)}`; insStock.run(pid, encrypt(d), sha256(d)); }
      }
    }
    db.prepare("INSERT INTO coupons(code, description, type, value, max_discount, is_public) VALUES('TEST10','Mã thử nghiệm 10%','percent',10,50000,1)").run();
  })();
}

function runSeed() {
  ensureSettings();
  ensureAdmin();
  if (config.seedCatalog) seedCatalog();
  if (config.seedDemo) seedDemoProducts();
}

module.exports = { runSeed, DEFAULT_SETTINGS };
