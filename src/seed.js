'use strict';
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db, setSetting, getSettings } = require('./db');
const { encrypt, sha256, randomCode } = require('./utils/crypto');
const config = require('./config');

const DEFAULT_SETTINGS = {
  // Email & xác minh 2 lớp (chỉ hoạt động khi đã cấu hình SMTP ở Admin > Email & Bảo mật)
  twofa_mode_user: 'optional', twofa_admin: '1', twofa_days: '30',
  mail_on_welcome: '1', mail_on_order: '1', mail_on_deposit: '1', mail_on_password: '1', mail_on_login_alert: '1',
  smtp_port: '587', smtp_secure: 'tls',
  // Chống spam / DDoS (Admin > Chống spam & DDoS)
  edge_cache_seconds: '30', alert_admin: '1',
  ad_enabled: '1', ad_mult: '5', ad_floor_rpm: '1200', ad_ip_floor: '300', ad_escalate_sec: '120', ad_calm_min: '15', ad_auto_gate: '1', ad_auto_cf: '1', cf_zone_id: '', cf_token_enc: '', as_enabled: '1', as_guest_limit: '120', as_gate_minutes: '30', as_ban_enabled: '1', as_ban_limit: '300', as_ban_minutes: '60',
  as_user_limit: '40', as_user_cooldown: '10', as_overload: '1', as_overload_ms: '300', as_emergency: '0', as_whitelist: '',
  reg_hour_limit: '5', reg_ip_day: '3', reg_min_seconds: '3',
  // Nạp tự động: NIFY (webhook) và APICANHAN (quét giao dịch) — bật riêng, chạy song song được
  // Cày thuê (Admin > Cày thuê > Cài đặt)
  boost_cat_mode: 'image', boost_cat_cols_pc: '4', boost_cat_cols_m: '2', boost_cat_max: '12',
  boost_pkg_mode: 'icon', boost_pkg_cols_pc: '4', boost_pkg_cols_m: '2', boost_pkg_max: '12',
  boost_cart_hours: '24', boost_self_cancel: '1', boost_wipe_days: '7', boost_max_open: '5', boost_tg_notify: '1', mail_on_boost: '1',
  boost_tile_title: 'Cày thuê', boost_tile_desc: 'Thuê cày cấp, nhiệm vụ, farm nguyên liệu — làm nhanh, uy tín',
  boost_terms: '1. Shop chỉ đăng nhập để thực hiện đúng gói bạn đã chọn, không thay đổi thông tin tài khoản.\n2. Vui lòng tắt xác minh 2 lớp / cung cấp mã khi được yêu cầu.\n3. Không đăng nhập vào tài khoản trong thời gian shop đang xử lý đơn.\n4. Đơn bị hủy do không đăng nhập được sẽ được hoàn tiền vào số dư.',
  topup_terms: '1. Vui lòng nhập chính xác UID / server / tài khoản. Shop không chịu trách nhiệm khi bạn nhập sai thông tin.\n2. Thời gian nạp thường từ 5 – 30 phút, cao điểm có thể lâu hơn.\n3. Không đăng nhập vào tài khoản trong thời gian shop đang nạp (với hình thức đăng nhập).\n4. Đơn không thực hiện được sẽ được hoàn tiền vào số dư.',
  nify_enabled: '1', acn_enabled: '0', acn_bank: 'ACBnew', acn_interval: '5', acn_extra_pct: '20',
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
  const insCat = db.prepare('INSERT INTO categories(game_id, name, slug, image, sort_order, description, sale_type) VALUES(?,?,?,?,?,?,?)');
  db.transaction(() => {
    CATALOG.forEach((g, gi) => {
      const gs = slug(g.name);
      const gid = insGame.run(g.name, gs, writeDemo(`game-${gs}.svg`, svgGame(g.name.toUpperCase(), g.c[0], g.c[1], g.glyph)),
        g.c[0], gi, g.hot, `Mua bán acc ${g.name} uy tín, giá tốt, giao acc tự động.`).lastInsertRowid;
      g.cats.forEach((cn, ci) => {
        const cs = slug(cn);
        insCat.run(gid, cn, cs, writeDemo(`cat-${gs}-${cs}.svg`, svgGame(cn, g.c[1], g.c[0], g.glyph, 400, 220)), ci, `${cn} - ${g.name}`,
          /Random|Reroll|Reg Giá Rẻ/.test(cn) ? 'reroll' : 'vip');
      });
    });
  })();
}

// Sản phẩm + mã KM mẫu để thử nghiệm (chỉ khi SEED_DEMO=true). KHÔNG bật khi chạy thật.
function seedDemoProducts() {
  if (db.prepare('SELECT COUNT(*) c FROM products').get().c > 0) return;
  console.log('[seed] SEED_DEMO=true -> tạo sản phẩm thử nghiệm');
  const cats = db.prepare('SELECT c.id, c.name, c.image, c.sale_type FROM categories c').all();
  const insProd = db.prepare(`INSERT INTO products(category_id, code, title, type, price, images, attributes, description, credentials_enc)
    VALUES(?,?,?,?,?,?,?,?,?)`);
  const insStock = db.prepare('INSERT INTO product_stock(product_id, data_enc, data_hash) VALUES(?,?,?)');
  db.transaction(() => {
    for (const c of cats) {
      const isStock = c.sale_type === 'reroll';
      for (let i = 1; i <= 3; i++) {
        const code = randomCode(8);
        const pid = insProd.run(c.id, code, `[TEST] ${c.name} #${code}`, isStock ? 'stock' : 'account', 10000 * i,
          JSON.stringify([c.image]), JSON.stringify([{ k: 'Ghi chú', v: 'Sản phẩm thử nghiệm' }]), 'Sản phẩm thử nghiệm.',
          isStock ? null : encrypt(`Tài khoản: test_${code.toLowerCase()}\nMật khẩu: ${randomCode(10)}`)).lastInsertRowid;
        if (isStock) for (let k = 0; k < 5; k++) { const d = `test_${randomCode(8).toLowerCase()} | ${randomCode(10)}`; insStock.run(pid, encrypt(d), sha256(d)); }
      }
    }
    db.prepare("INSERT INTO coupons(code, description, type, value, max_discount, is_public) VALUES('TEST10','Mã thử nghiệm 10%','percent',10,50000,1)").run();
  })();
}

// Thuộc tính mẫu (chỉ tạo 1 lần; admin xóa đi thì không tạo lại)
function seedAttributes() {
  if (getSettings().attributes_seeded === '1') return;
  if (db.prepare('SELECT COUNT(*) c FROM attributes').get().c === 0) {
    const ins = db.prepare('INSERT INTO attributes(name, values_json, sort_order) VALUES(?,?,?)');
    [
      ['Rank', ['Đồng', 'Bạc', 'Vàng', 'Bạch Kim', 'Kim Cương', 'Tinh Anh', 'Cao Thủ', 'Chiến Tướng', 'Chiến Thần']],
      ['Loại đăng ký', ['Garena', 'Facebook', 'Google', 'Email', 'Số điện thoại', 'Apple ID']],
      ['Server', ['Việt Nam', 'Asia', 'America', 'Europe']],
      ['Tình trạng', ['Trắng thông tin', 'Có thể đổi thông tin', 'Liên kết đầy đủ']],
    ].forEach(([n, v], i) => ins.run(n, JSON.stringify(v), i));
  }
  setSetting('attributes_seeded', '1');
}

// Ảnh mẫu cho dải ảnh chạy trang chủ (300x150) - chỉ tạo 1 lần để test, admin thay bằng ảnh thật
function seedStrip() {
  if (getSettings().strip_seeded === '1') return;
  if (db.prepare("SELECT COUNT(*) c FROM banners WHERE position = 'strip'").get().c === 0) {
    const items = [
      ['ACC VIP GIÁ RẺ', 'Chỉ từ 50K', '#7c3aed', '#db2777', '/khuyen-mai'],
      ['NẠP TIỀN 24/7', 'Cộng tiền tự động', '#f59e0b', '#ef4444', '/user/deposit'],
      ['RANDOM LIÊN QUÂN', 'Thử vận may', '#2563eb', '#7c3aed', '/game/lien-quan-mobile'],
      ['FREE FIRE', 'Acc nhiều súng', '#f97316', '#dc2626', '/game/free-fire'],
      ['GENSHIN IMPACT', 'Acc 5 sao', '#0891b2', '#4f46e5', '/game/genshin-impact'],
      ['MÃ GIẢM GIÁ', 'Săn mã mỗi ngày', '#22c55e', '#0f766e', '/khuyen-mai'],
    ];
    const ins = db.prepare("INSERT INTO banners(position, title, image, link, sort_order) VALUES('strip',?,?,?,?)");
    items.forEach(([t, sub, c1, c2, link], i) => ins.run(t, writeDemo(`strip-${i + 1}.svg`, svgBanner(t, sub, c1, c2, 600, 300)), link, i));
  }
  setSetting('strip_seeded', '1');
}

// Ảnh "Banner chính" và "Dải ảnh chạy" trước đây quản lý ở Banner & Sidebar -> chuyển vào khối tương ứng
// ở Bố cục trang chủ (mỗi khối tự giữ ảnh + kích cỡ riêng, thêm được nhiều khối cùng loại). Chạy 1 lần.
function migrateHomeBanners() {
  if (getSettings().home_banners_migrated === '1') return;
  const H = require('./utils/helpers');
  const s = getSettings();
  db.transaction(() => {
    for (const [type, pos] of [['slider', 'main'], ['strip', 'strip']]) {
      const rows = db.prepare('SELECT * FROM banners WHERE position = ? ORDER BY sort_order, id').all(pos);
      let block = db.prepare('SELECT * FROM home_blocks WHERE type = ? ORDER BY sort_order, id LIMIT 1').get(type);
      if (!block && !rows.length) continue;
      const sz = H.bannerSize(s, pos);
      if (!block) {
        const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM home_blocks').get().n;
        block = { id: db.prepare('INSERT INTO home_blocks(type, title, sort_order) VALUES(?,?,?)').run(type, '', next).lastInsertRowid };
      }
      db.prepare('UPDATE home_blocks SET settings = ? WHERE id = ?').run(JSON.stringify({ w: sz.w, h: sz.h }), block.id);
      const ins = db.prepare('INSERT INTO home_block_items(block_id, image, link, title, sort_order, is_active) VALUES(?,?,?,?,?,?)');
      rows.forEach((r, i) => ins.run(block.id, r.image, r.link || '', r.title || '', i, r.is_active));
      db.prepare('DELETE FROM banners WHERE position = ?').run(pos);
    }
  })();
  setSetting('home_banners_migrated', '1');
}

function runSeed() {
  ensureSettings();
  ensureAdmin();
  seedAttributes();
  if (config.seedCatalog) seedCatalog();
  seedStrip();
  if (config.seedDemo) seedDemoProducts();
  migrateHomeBanners();
}

module.exports = { runSeed, DEFAULT_SETTINGS };
