'use strict';
/**
 * Đo tốc độ mua acc khi nhiều khách bấm mua cùng lúc — chạy trên BẢN SAO database trong thư mục tạm,
 * không đụng dữ liệu thật, web vẫn chạy bình thường. Chạy xong tự xóa bản sao.
 *
 *   node scripts/bench-purchase.js                 (1000 khách, 10% mua trùng, 2 tiến trình như PM2)
 *   node scripts/bench-purchase.js 3000 20 2       (3000 khách, 20% mua trùng, 2 tiến trình)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ---------------- Tiến trình con: giống 1 instance PM2 ----------------
if (process.env.GZ_BENCH_WORKER) {
  const { purchase } = require('../src/services/order');
  const plan = JSON.parse(fs.readFileSync(path.join(process.env.GZ_DATA_DIR, 'plan.json'), 'utf8'));
  const w = Number(process.env.GZ_BENCH_WORKER) - 1;
  const jobs = [];
  for (let i = w; i < plan.n; i += plan.procs) {
    // khách < uniq mua acc riêng; còn lại tranh nhau các acc "hot" (10 người / acc)
    const pid = i < plan.uniq ? plan.p0 + i : plan.p0 + plan.uniq + ((i - plan.uniq) % plan.hot);
    jobs.push([plan.u0 + i, pid]);
  }
  process.on('message', () => {
    const lat = []; let ok = 0, taken = 0; const other = {};
    for (const [u, p] of jobs) {
      const s = process.hrtime.bigint();
      const r = purchase(u, p, null, '127.0.0.1');
      lat.push(Number(process.hrtime.bigint() - s) / 1e6);
      if (r.ok) ok++; else if (/bán|người khác mua/.test(r.message)) taken++; else other[r.message] = (other[r.message] || 0) + 1;
    }
    process.send({ ok, taken, other, lat });
  });
  process.send('ready');
  return;
}

// ---------------- Tiến trình chính ----------------
const Database = require('better-sqlite3');
const n = Math.max(10, parseInt(process.argv[2], 10) || 1000);
const dupPct = Math.min(90, Math.max(0, parseInt(process.argv[3], 10) || 10));
const procs = Math.min(8, Math.max(1, parseInt(process.argv[4], 10) || 2));
const dupUsers = Math.round(n * dupPct / 100);
const uniq = n - dupUsers;
const hot = Math.max(1, Math.ceil(dupUsers / 10));

const real = path.join(ROOT, 'data', 'shop.db');
if (!fs.existsSync(real)) { console.error('Không thấy data/shop.db'); process.exit(1); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gachaz-bench-'));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* bỏ qua */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));

(async () => {
  console.log(`Sao chép database sang ${tmp} ...`);
  const src = new Database(real, { readonly: true, fileMustExist: true });
  await src.backup(path.join(tmp, 'shop.db'));
  src.close();

  // Tạo khách + acc thử trong BẢN SAO
  const db = new Database(path.join(tmp, 'shop.db'));
  const cat = db.prepare('SELECT id FROM categories ORDER BY is_active DESC, id LIMIT 1').get();
  if (!cat) { console.error('Chưa có danh mục nào để tạo acc thử'); process.exit(1); }
  const insU = db.prepare("INSERT INTO users(username, email, password_hash, balance, email_verified_at) VALUES(?,?,'x',?,unixepoch())");
  const insP = db.prepare("INSERT INTO products(category_id, code, title, price, images, attributes, description, credentials_enc, status, type) VALUES(?,?,?,1000000,'[]','{}','','x','available','account')");
  const tag = Date.now().toString(36);
  let u0, p0;
  db.transaction(() => {
    for (let i = 0; i < n; i++) { const id = insU.run(`bench_${tag}_${i}`, `bench_${tag}_${i}@bench.local`, 5000000).lastInsertRowid; if (!i) u0 = Number(id); }
    for (let i = 0; i < uniq + hot; i++) { const id = insP.run(cat.id, `BENCH${tag}${i}`, `Acc thử ${i}`).lastInsertRowid; if (!i) p0 = Number(id); }
  })();
  db.close();
  fs.writeFileSync(path.join(tmp, 'plan.json'), JSON.stringify({ n, uniq, hot, procs, u0, p0 }));

  console.log(`${n} khách cùng bấm mua: ${uniq} mua acc riêng, ${dupUsers} khách (${dupPct}%) tranh ${hot} acc · ${procs} tiến trình\n`);
  const ws = [...Array(procs)].map((_, i) => fork(__filename, [], { env: { ...process.env, GZ_BENCH_WORKER: String(i + 1), GZ_DATA_DIR: tmp } }));
  let ready = 0, t0 = 0; const res = [];
  ws.forEach((w) => w.on('message', (m) => {
    if (m === 'ready') { if (++ready === procs) { t0 = Date.now(); ws.forEach((x) => x.send('go')); } return; }
    res.push(m); w.kill();
    if (res.length < procs) return;
    const wall = Date.now() - t0;
    const lat = res.flatMap((r) => r.lat).sort((a, b) => a - b);
    const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(2);
    const sum = (k) => res.reduce((a, r) => a + r[k], 0);
    const other = Object.assign({}, ...res.map((r) => r.other));

    const v = new Database(path.join(tmp, 'shop.db'), { readonly: true });
    const like = `bench_${tag}_%`;
    const c = v.prepare(`SELECT
      (SELECT COUNT(*) FROM orders o JOIN users u ON u.id = o.user_id WHERE u.username LIKE ?) orders,
      (SELECT COUNT(*) FROM (SELECT o.product_id FROM orders o JOIN users u ON u.id = o.user_id WHERE u.username LIKE ? GROUP BY o.product_id HAVING COUNT(*) > 1)) dup,
      (SELECT COUNT(*) FROM users WHERE username LIKE ? AND balance < 0) neg,
      (SELECT COALESCE(SUM(5000000 - balance), 0) FROM users WHERE username LIKE ?) spent,
      (SELECT COALESCE(SUM(o.total), 0) FROM orders o JOIN users u ON u.id = o.user_id WHERE u.username LIKE ?) total`).get(like, like, like, like, like);
    v.close();

    const good = c.orders === uniq + hot && c.dup === 0 && c.neg === 0 && c.spent === c.total && !Object.keys(other).length;
    console.log(`Xử lý xong ${n} lượt mua trong ${(wall / 1000).toFixed(2)} giây  (~${Math.round(n / wall * 1000)} lượt/giây)`);
    console.log(`Thời gian 1 lượt: trung bình ${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(2)} ms · 95% dưới ${pct(0.95)} ms · chậm nhất ${lat[lat.length - 1].toFixed(2)} ms`);
    console.log(`Mua thành công ${sum('ok')} · báo "đã bán / người khác mua" ${sum('taken')}${Object.keys(other).length ? ' · LỖI KHÁC ' + JSON.stringify(other) : ''}`);
    console.log(`Kiểm tra: ${c.orders} đơn · acc bán trùng ${c.dup} · tài khoản âm tiền ${c.neg} · tiền trừ ${c.spent.toLocaleString('vi-VN')}đ = tổng đơn ${c.total.toLocaleString('vi-VN')}đ`);
    console.log(good ? '\nKẾT QUẢ: ĐÚNG — không bán trùng, không mất tiền.' : '\nKẾT QUẢ: CÓ VẤN ĐỀ — gửi lại toàn bộ dòng trên để kiểm tra.');
    process.exit(good ? 0 : 2);
  }));
})().catch((e) => { console.error(e); process.exit(1); });
