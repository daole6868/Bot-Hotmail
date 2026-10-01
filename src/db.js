'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.paths.data, { recursive: true });
fs.mkdirSync(config.paths.backups, { recursive: true });
fs.mkdirSync(config.paths.uploads, { recursive: true });

const db = new Database(path.join(config.paths.data, 'shop.db'));

// Dùng lại câu lệnh SQL đã biên dịch (mỗi lần prepare tốn CPU) — giới hạn 1000 câu để không phình RAM.
// Câu lệnh cần .iterate() (đọc dần) phải dùng db.prepareFresh để tránh "statement busy" khi chạy song song.
{
  const stmtCache = new Map();
  const rawPrepare = db.prepare.bind(db);
  db.prepareFresh = rawPrepare;
  db.prepare = (sql) => {
    let st = stmtCache.get(sql);
    if (!st) {
      if (stmtCache.size >= 1000) stmtCache.clear();
      st = rawPrepare(sql);
      stmtCache.set(sql, st);
    }
    return st;
  };
}

// Tối ưu cho nhiều dữ liệu: WAL cho đọc/ghi đồng thời, cache lớn, đợi khóa thay vì lỗi
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('cache_size = -32000'); // ~32MB
db.pragma('temp_store = MEMORY');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  total_deposit INTEGER NOT NULL DEFAULT 0,
  total_spent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','banned')),
  ban_reason TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  last_login_at INTEGER,
  last_login_ip TEXT,
  register_ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  image TEXT,
  description TEXT,
  color TEXT DEFAULT '#6d28d9',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_hot INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  image TEXT,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(game_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_categories_game ON categories(game_id, is_active, sort_order);

-- type: 'account' = acc duy nhất (bán 1 lần) ; 'stock' = thẻ game / acc random có nhiều mã trong kho
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'account' CHECK(type IN ('account','stock')),
  price INTEGER NOT NULL CHECK(price >= 0),
  old_price INTEGER,
  images TEXT NOT NULL DEFAULT '[]',
  attributes TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  credentials_enc TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','hidden')),
  is_featured INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  sold_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category_id, status, price);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status, created_at);
CREATE INDEX IF NOT EXISTS idx_products_featured ON products(is_featured, status);

CREATE TABLE IF NOT EXISTS product_stock (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  data_enc TEXT NOT NULL,
  data_hash TEXT NOT NULL,
  is_sold INTEGER NOT NULL DEFAULT 0,
  order_id INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(product_id, data_hash)
);
CREATE INDEX IF NOT EXISTS idx_stock_product ON product_stock(product_id, is_sold);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'percent' CHECK(type IN ('percent','fixed')),
  value INTEGER NOT NULL CHECK(value > 0),
  max_discount INTEGER,
  min_order INTEGER NOT NULL DEFAULT 0,
  game_id INTEGER REFERENCES games(id) ON DELETE SET NULL,
  usage_limit INTEGER,
  per_user_limit INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  starts_at INTEGER,
  expires_at INTEGER,
  is_public INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_title TEXT NOT NULL,
  game_name TEXT,
  price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  coupon_code TEXT,
  delivered_enc TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','refunded')),
  note TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);

CREATE TABLE IF NOT EXISTS coupon_usages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_cu_coupon_user ON coupon_usages(coupon_id, user_id);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL CHECK(amount > 0),
  received INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','cancelled','expired')),
  method TEXT NOT NULL DEFAULT 'bank',
  bank_txn_id TEXT UNIQUE,
  note TEXT,
  handled_by INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status, created_at);

-- Giao dịch ngân hàng nhận từ webhook (kể cả không khớp) để đối soát
CREATE TABLE IF NOT EXISTS bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL UNIQUE,
  amount INTEGER NOT NULL,
  content TEXT,
  matched_deposit_id INTEGER,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK(status IN ('matched','unmatched','ignored')),
  raw TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_banktxn_status ON bank_transactions(status, created_at);

CREATE TABLE IF NOT EXISTS balance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  type TEXT NOT NULL,
  ref TEXT,
  note TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ballog_user ON balance_logs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT NOT NULL DEFAULT 'main' CHECK(position IN ('main','sidebar_left','sidebar_right','popup','strip')),
  title TEXT,
  image TEXT NOT NULL,
  link TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_actlog_created ON activity_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_actlog_user ON activity_logs(user_id, created_at);

CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  user_id INTEGER,
  success INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_loginlog_created ON login_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_loginlog_ip ON login_logs(ip, created_at);

-- Chặn IP spam (tự động hoặc thủ công)
CREATE TABLE IF NOT EXISTS ip_blocks (
  ip TEXT PRIMARY KEY,
  reason TEXT,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Thống kê gộp theo ngày: dashboard không phải quét toàn bộ bảng khi dữ liệu lớn
CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT PRIMARY KEY,
  revenue INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  deposits INTEGER NOT NULL DEFAULT 0,
  deposit_count INTEGER NOT NULL DEFAULT 0,
  new_users INTEGER NOT NULL DEFAULT 0,
  refunds INTEGER NOT NULL DEFAULT 0
);

-- ===== LƯU TRỮ (ARCHIVE) =====
-- Đơn hàng / nạp tiền cũ được chuyển sang bảng archive để bảng chính luôn nhỏ, ghi nhanh.
CREATE TABLE IF NOT EXISTS orders_archive (
  id INTEGER PRIMARY KEY,
  order_code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  product_id INTEGER,
  product_title TEXT NOT NULL,
  game_name TEXT,
  price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  coupon_code TEXT,
  delivered_enc TEXT,
  status TEXT NOT NULL,
  note TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oarch_user ON orders_archive(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oarch_code ON orders_archive(order_code);

CREATE TABLE IF NOT EXISTS deposits_archive (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  amount INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  method TEXT NOT NULL,
  bank_txn_id TEXT,
  note TEXT,
  handled_by INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_darch_user ON deposits_archive(user_id, created_at DESC);

CREATE VIEW IF NOT EXISTS v_orders AS
  SELECT id, order_code, user_id, product_id, product_title, game_name, price, discount, total, coupon_code,
         delivered_enc, status, note, ip, created_at, 0 AS archived FROM orders
  UNION ALL
  SELECT id, order_code, user_id, product_id, product_title, game_name, price, discount, total, coupon_code,
         delivered_enc, status, note, ip, created_at, 1 AS archived FROM orders_archive;

CREATE VIEW IF NOT EXISTS v_deposits AS
  SELECT id, user_id, code, amount, received, status, method, bank_txn_id, note, handled_by, created_at, completed_at, 0 AS archived FROM deposits
  UNION ALL
  SELECT id, user_id, code, amount, received, status, method, bank_txn_id, note, handled_by, created_at, completed_at, 1 AS archived FROM deposits_archive;

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);

-- Thuộc tính dùng lại (admin định nghĩa tên + nhiều giá trị), dùng khi thêm sản phẩm
CREATE TABLE IF NOT EXISTS attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  values_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;

db.exec(SCHEMA);

// ---- Nâng cấp DB cũ (thêm cột mới nếu chưa có) ----
function addColumn(table, col, def) {
  if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  return true;
}
addColumn('products', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
// Popup "Nạp tiền thành công": seen_at = lúc khách đã thấy thông báo (đơn cũ coi như đã thấy)
if (addColumn('deposits', 'seen_at', 'INTEGER')) db.exec("UPDATE deposits SET seen_at = completed_at WHERE status = 'success'");
// Loại danh mục: vip = mỗi acc bán 1 lần ; reroll = 1 sản phẩm chứa nhiều acc, mua nhiều lần tới khi hết
if (addColumn('categories', 'sale_type', "TEXT NOT NULL DEFAULT 'vip'")) {
  db.exec(`UPDATE categories SET sale_type = 'reroll'
    WHERE name LIKE '%Random%' OR name LIKE '%Reroll%' OR name LIKE '%Reg Giá Rẻ%'
       OR id IN (SELECT category_id FROM products WHERE type = 'stock')`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_products_sort ON products(category_id, sort_order)');
// Chống spam / DDoS: IP đang bị yêu cầu đăng nhập (g:<ip>), tài khoản đang phải chờ vì thao tác quá nhanh (c:<id>).
// Dùng chung cho mọi bản PM2 (mỗi bản đồng bộ vào bộ nhớ vài giây / lần)
db.exec(`CREATE TABLE IF NOT EXISTS shield_flags (
    key TEXT PRIMARY KEY,
    until INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
// Gmail bỏ qua dấu chấm và phần +tag: a.b+1@gmail.com và ab@gmail.com là cùng 1 hộp thư -> so trùng theo dạng chuẩn
db.function('gmail_norm', { deterministic: true }, (e) => {
  const m = String(e || '').toLowerCase().trim().match(/^([^@]+)@(gmail|googlemail)\.com$/);
  return m ? m[1].split('+')[0].replace(/\./g, '') + '@gmail.com' : String(e || '').toLowerCase().trim();
});

// ===== CÀY THUÊ: Game -> Danh mục cày thuê -> Gói; giỏ hàng theo game; đơn có 5 trạng thái =====
db.exec(`CREATE TABLE IF NOT EXISTS boost_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    image TEXT,
    icon TEXT NOT NULL DEFAULT 'g-sword',
    icon_color TEXT NOT NULL DEFAULT '#8b5cf6',
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(game_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_bcat_game ON boost_categories(game_id, is_active, sort_order);
  CREATE TABLE IF NOT EXISTS boost_packages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES boost_categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price INTEGER NOT NULL CHECK(price >= 0),
    old_price INTEGER,
    image TEXT,
    icon TEXT NOT NULL DEFAULT 'star',
    icon_color TEXT NOT NULL DEFAULT '#f59e0b',
    description TEXT,
    unit TEXT NOT NULL DEFAULT 'gói',
    min_qty INTEGER NOT NULL DEFAULT 1,
    max_qty INTEGER NOT NULL DEFAULT 10,
    eta TEXT,
    is_paused INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    sold_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_bpkg_cat ON boost_packages(category_id, is_active, sort_order);
  CREATE TABLE IF NOT EXISTS boost_carts (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    package_id INTEGER NOT NULL REFERENCES boost_packages(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, package_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bcart_user_game ON boost_carts(user_id, game_id);
  CREATE TABLE IF NOT EXISTS boost_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    game_id INTEGER,
    game_name TEXT,
    subtotal INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    coupon_code TEXT,
    login_enc TEXT,
    server TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','processing','need_info','done','cancelled')),
    customer_msg TEXT,
    admin_note TEXT,
    refunded INTEGER NOT NULL DEFAULT 0,
    ip TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    finished_at INTEGER,
    login_wiped_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_border_user ON boost_orders(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_border_status ON boost_orders(status, created_at);
  CREATE TABLE IF NOT EXISTS boost_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES boost_orders(id) ON DELETE CASCADE,
    package_id INTEGER,
    name TEXT NOT NULL,
    category_name TEXT,
    unit TEXT,
    price INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    line_total INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bitem_order ON boost_order_items(order_id);
  CREATE TABLE IF NOT EXISTS boost_order_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES boost_orders(id) ON DELETE CASCADE,
    status TEXT,
    message TEXT,
    by_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_bevent_order ON boost_order_events(order_id, id);`);
// Mã giảm giá: phạm vi áp dụng (all / acc / boost); lượt dùng mã cho đơn cày thuê
addColumn('coupons', 'scope', "TEXT NOT NULL DEFAULT 'all'");
addColumn('coupon_usages', 'boost_order_id', 'INTEGER');
addColumn('daily_stats', 'boost_revenue', 'INTEGER NOT NULL DEFAULT 0');
addColumn('daily_stats', 'boost_orders', 'INTEGER NOT NULL DEFAULT 0');
// Cày thuê nằm trong "Danh mục" như VIP / Reroll: danh mục loại 'boost' (sửa tên, ảnh, mô tả, thứ tự được)
// -> bên trong là danh mục con (boost_categories.parent_id) -> gói. options = cài đặt hiển thị riêng của danh mục cày thuê
addColumn('categories', 'options', 'TEXT');
addColumn('boost_categories', 'parent_id', 'INTEGER REFERENCES categories(id) ON DELETE CASCADE');
db.exec('CREATE INDEX IF NOT EXISTS idx_bcat_parent ON boost_categories(parent_id, is_active, sort_order)');
{
  // Danh mục con tạo trước khi có cấp "Cày thuê" -> gom vào 1 danh mục Cày thuê mới của đúng game
  const orphans = db.prepare('SELECT DISTINCT game_id FROM boost_categories WHERE parent_id IS NULL').all();
  if (orphans.length) {
    const st = (k, d) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || d;
    const name = st('boost_tile_title', 'Cày thuê');
    const opts = JSON.stringify(Object.fromEntries(['cat_mode', 'cat_cols_pc', 'cat_cols_m', 'cat_max', 'pkg_mode', 'pkg_cols_pc', 'pkg_cols_m', 'pkg_max']
      .map((k) => [k, st('boost_' + k, '')]).filter(([, v]) => v !== '')));
    db.transaction(() => {
      for (const { game_id: gid } of orphans) {
        let slug = 'cay-thue';
        for (let i = 2; db.prepare('SELECT 1 FROM categories WHERE game_id = ? AND slug = ?').get(gid, slug); i++) slug = 'cay-thue-' + i;
        const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM categories WHERE game_id = ?').get(gid).n;
        const cid = db.prepare("INSERT INTO categories(game_id, name, slug, image, description, sort_order, sale_type, options) VALUES(?,?,?,?,?,?,'boost',?)")
          .run(gid, name, slug, st('boost_tile_image', '') || null, st('boost_tile_desc', '') || null, next, opts).lastInsertRowid;
        db.prepare('UPDATE boost_categories SET parent_id = ? WHERE game_id = ? AND parent_id IS NULL').run(cid, gid);
      }
    })();
  }
}

// Bảo mật tài khoản: xác minh 2 lớp qua email, thiết bị tin cậy, đặt lại mật khẩu, nhật ký email
addColumn('users', 'email_verified_at', 'INTEGER');
addColumn('users', 'twofa_enabled', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`CREATE TABLE IF NOT EXISTS trusted_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_hash TEXT NOT NULL,
    user_agent TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_verified_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, device_hash)
  );
  CREATE TABLE IF NOT EXISTS email_otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    target_email TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_otp_user ON email_otps(user_id, purpose, id);
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    ip TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS email_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_maillog_created ON email_logs(created_at);`);

// Bố cục trang chủ: các khối hiển thị theo thứ tự admin sắp xếp (khối có sẵn + khối banner tự thêm)
db.exec(`CREATE TABLE IF NOT EXISTS home_blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE IF NOT EXISTS home_block_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id INTEGER NOT NULL REFERENCES home_blocks(id) ON DELETE CASCADE,
    image TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_hbi_block ON home_block_items(block_id, sort_order);`);
addColumn('home_block_items', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
if (!db.prepare('SELECT 1 FROM home_blocks LIMIT 1').get()) {
  const ins = db.prepare('INSERT INTO home_blocks(type, title, sort_order) VALUES(?,?,?)');
  [['slider', ''], ['strip', ''], ['games', 'Danh mục game'], ['coupons', 'Mã khuyến mãi'], ['featured', 'Acc nổi bật'], ['recent', 'Giao dịch gần đây']]
    .forEach(([t, title], i) => ins.run(t, title, i));
}
// Chỉ mục tìm kiếm toàn văn cho tên/mã acc (nhanh với hàng trăm nghìn acc, tìm được cả khi gõ không dấu)
const FTS_TRIGGERS = `CREATE TRIGGER IF NOT EXISTS products_fts_ai AFTER INSERT ON products BEGIN
      INSERT INTO products_fts(rowid, title, code) VALUES (new.id, new.title, new.code); END;
    CREATE TRIGGER IF NOT EXISTS products_fts_ad AFTER DELETE ON products BEGIN
      INSERT INTO products_fts(products_fts, rowid, title, code) VALUES ('delete', old.id, old.title, old.code); END;
    CREATE TRIGGER IF NOT EXISTS products_fts_au AFTER UPDATE OF title, code ON products BEGIN
      INSERT INTO products_fts(products_fts, rowid, title, code) VALUES ('delete', old.id, old.title, old.code);
      INSERT INTO products_fts(rowid, title, code) VALUES (new.id, new.title, new.code); END;`;
{
  const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'products_fts'").get();
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(title, code, content='products', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
    ${FTS_TRIGGERS}`);
  if (!hasFts) db.exec("INSERT INTO products_fts(products_fts) VALUES('rebuild')");
}
// Khôi phục dữ liệu: tạm bỏ trigger tìm kiếm khi nạp hàng loạt, xong thì tạo lại và dựng lại chỉ mục
const ftsPause = () => db.exec('DROP TRIGGER IF EXISTS products_fts_ai; DROP TRIGGER IF EXISTS products_fts_ad; DROP TRIGGER IF EXISTS products_fts_au;');
const ftsResume = () => { db.exec(FTS_TRIGGERS); db.exec("INSERT INTO products_fts(products_fts) VALUES('rebuild')"); };
// Thêm vị trí banner 'strip' (dải ảnh chạy ở trang chủ): SQLite không sửa được CHECK -> dựng lại bảng
{
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'banners'").get()?.sql || '';
  if (!sql.includes("'strip'")) {
    db.transaction(() => {
      db.exec(`CREATE TABLE banners_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        position TEXT NOT NULL DEFAULT 'main' CHECK(position IN ('main','sidebar_left','sidebar_right','popup','strip')),
        title TEXT, image TEXT NOT NULL, link TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
      db.exec('INSERT INTO banners_new(id, position, title, image, link, sort_order, is_active, created_at) SELECT id, position, title, image, link, sort_order, is_active, created_at FROM banners');
      db.exec('DROP TABLE banners');
      db.exec('ALTER TABLE banners_new RENAME TO banners');
    })();
  }
}

// ---- Helpers ----
const settingsCache = { data: null, at: 0 };

function getSettings() {
  if (settingsCache.data && Date.now() - settingsCache.at < 30000) return settingsCache.data;
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const data = {};
  for (const r of rows) data[r.key] = r.value;
  settingsCache.data = data;
  settingsCache.at = Date.now();
  return data;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value));
  settingsCache.data = null;
}

function logActivity(userId, action, detail, ip) {
  try {
    db.prepare('INSERT INTO activity_logs(user_id, action, detail, ip) VALUES(?,?,?,?)')
      .run(userId || null, action, detail ? String(detail).slice(0, 1000) : null, ip || null);
  } catch (e) {
    console.error('logActivity', e.message);
  }
}

// Cộng dồn thống kê ngày (giờ VN)
function bumpStat(field, amount = 1) {
  const allowed = ['revenue', 'orders', 'deposits', 'deposit_count', 'new_users', 'refunds', 'boost_revenue', 'boost_orders'];
  if (!allowed.includes(field)) return;
  const day = vnDay();
  db.prepare(`INSERT INTO daily_stats(day, ${field}) VALUES(?, ?)
    ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + excluded.${field}`).run(day, amount);
}

function vnDay(ts = Date.now()) {
  return new Date(ts + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

const clearSettingsCache = () => { settingsCache.data = null; };
module.exports = { db, getSettings, setSetting, logActivity, bumpStat, vnDay, ftsPause, ftsResume, clearSettingsCache };
