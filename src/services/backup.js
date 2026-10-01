'use strict';
/**
 * Sao lưu & khôi phục toàn bộ dữ liệu.
 *
 * Gói sao lưu (.gzbak) = database + ảnh đã tải lên + thông tin khóa mã hóa, nén gzip rồi mã hóa AES-256-GCM
 * bằng mật khẩu riêng (khóa sinh bằng scrypt). Rơi vào tay người khác cũng không mở được nếu không có mật khẩu.
 *   [8 byte "GZBAK001"][16 byte salt][12 byte iv][...dữ liệu mã hóa...][16 byte tag]
 * Bên trong: chuỗi mục [4 byte độ dài][JSON {name,size}][size byte dữ liệu], kết thúc bằng {end:true}.
 * Mọi bước đọc/ghi đều theo luồng (stream) -> gói vài trăm MB cũng không tốn RAM.
 *
 * Khôi phục: giải mã ra thư mục tạm -> kiểm tra -> tự sao lưu dữ liệu hiện tại -> xóa sạch dữ liệu cũ và nạp dữ liệu
 * trong gói (1 transaction: lỗi giữa chừng thì dữ liệu cũ còn nguyên) -> thay thư mục ảnh -> mã hóa lại thông tin acc
 * nếu VPS mới có APP_KEY khác -> các bản web tự khởi động lại.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');
const { db, getSettings, setSetting, ftsPause, ftsResume, clearSettingsCache } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const config = require('../config');

const MAGIC = Buffer.from('GZBAK001');
const HEAD = MAGIC.length + 16 + 12;
const TMP = path.join(config.paths.data, 'tmp');
const TG_LIMIT = 49 * 1024 * 1024; // bot Telegram gửi file tối đa 50MB
const nowS = () => Math.floor(Date.now() / 1000);
const stamp = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().replace(/[:T]/g, '-').slice(0, 19); // giờ VN
fs.mkdirSync(TMP, { recursive: true });

const deriveKey = (password, salt) => new Promise((res, rej) => crypto.scrypt(String(password), salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));
const backupPassword = () => { const e = getSettings().backup_pass_enc; return e ? decrypt(e) : ''; };

// ---------- Tạo gói ----------
async function walk(dir, base = dir, out = []) {
  let items;
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) await walk(full, base, out);
    else if (it.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

let busy = false;
/** -> { file, size, withUploads, counts } (file nằm trong thư mục tạm, người gọi tự xóa) */
async function makePackage({ withUploads = true, password = backupPassword() } = {}) {
  if (!password) throw new Error('Chưa đặt mật khẩu gói sao lưu');
  if (busy) throw new Error('Đang tạo 1 gói sao lưu khác, thử lại sau ít phút');
  busy = true;
  const dbCopy = path.join(TMP, `pkg-${Date.now()}.db`);
  const out = path.join(TMP, `gachaz-${stamp()}${withUploads ? '' : '-chi-du-lieu'}.gzbak`);
  try {
    await db.backup(dbCopy); // chụp DB theo từng phần, không khóa web
    const files = withUploads ? await walk(config.paths.uploads) : [];
    const counts = tableCounts(['users', 'products', 'orders', 'deposits']);
    const manifest = { app: 'gachaz', version: 1, createdAt: nowS(), baseUrl: config.baseUrl, appKey: config.appKey, withUploads, files: files.length, counts };

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', await deriveKey(password, salt), iv);
    const src = new PassThrough();
    const fileOut = fs.createWriteStream(out);
    fileOut.write(Buffer.concat([MAGIC, salt, iv]));
    const done = pipeline(src, zlib.createGzip({ level: 6 }), cipher, fileOut);

    const write = (buf) => (src.write(buf) ? Promise.resolve() : new Promise((r) => src.once('drain', r)));
    const header = (obj) => { const h = Buffer.from(JSON.stringify(obj)); const len = Buffer.alloc(4); len.writeUInt32BE(h.length); return write(Buffer.concat([len, h])); };
    const addFile = async (name, full) => {
      const st = await fsp.stat(full);
      await header({ name, size: st.size });
      for await (const chunk of fs.createReadStream(full)) await write(chunk);
    };
    const mf = Buffer.from(JSON.stringify(manifest));
    await header({ name: 'manifest.json', size: mf.length }); await write(mf);
    await addFile('shop.db', dbCopy);
    for (const f of files) await addFile('uploads/' + f.rel, f.full);
    await header({ end: true });
    src.end();
    await done;
    await fsp.appendFile(out, cipher.getAuthTag());
    const size = (await fsp.stat(out)).size;
    return { file: out, size, withUploads, counts, files: files.length };
  } catch (e) {
    await fsp.rm(out, { force: true });
    throw e;
  } finally {
    busy = false;
    await fsp.rm(dbCopy, { force: true });
  }
}

// ---------- Đọc gói ----------
const safeName = (n) => n === 'manifest.json' || n === 'shop.db' || (/^uploads\/[\w\-./]+$/.test(n) && !n.split('/').includes('..'));

/** Giải mã + giải nén vào thư mục dir -> { manifest, dbPath, uploadsDir|null } */
async function readPackage(file, password, dir) {
  const fh = await fsp.open(file, 'r');
  let size, head, tag;
  try {
    size = (await fh.stat()).size;
    if (size < HEAD + 16) throw new Error('File không phải gói sao lưu');
    head = Buffer.alloc(HEAD); await fh.read(head, 0, HEAD, 0);
    tag = Buffer.alloc(16); await fh.read(tag, 0, 16, size - 16);
  } finally { await fh.close(); }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('File không phải gói sao lưu của web');
  const salt = head.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = head.subarray(MAGIC.length + 16, HEAD);
  const decipher = crypto.createDecipheriv('aes-256-gcm', await deriveKey(password, salt), iv);
  decipher.setAuthTag(tag);
  await fsp.mkdir(dir, { recursive: true });

  let buf = Buffer.alloc(0); let cur = null; let left = 0; let ended = false; let manifest = null; let mfBuf = [];
  const parser = async function* (source) {
    for await (const chunk of source) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length && !ended) {
        if (!cur) {
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (len > 4096) throw new Error('Gói sao lưu hỏng');
          if (buf.length < 4 + len) break;
          const h = JSON.parse(buf.subarray(4, 4 + len).toString());
          buf = buf.subarray(4 + len);
          if (h.end) { ended = true; break; }
          if (!safeName(h.name) || !(h.size >= 0)) throw new Error('Gói sao lưu chứa tên file không hợp lệ');
          left = h.size;
          if (h.name === 'manifest.json') cur = { name: h.name };
          else {
            const full = path.join(dir, h.name);
            await fsp.mkdir(path.dirname(full), { recursive: true });
            cur = { name: h.name, ws: fs.createWriteStream(full) };
          }
          if (left === 0) { if (cur.ws) await new Promise((r) => cur.ws.end(r)); cur = null; }
          continue;
        }
        const take = Math.min(left, buf.length);
        const part = buf.subarray(0, take);
        buf = buf.subarray(take);
        left -= take;
        if (cur.ws) { if (!cur.ws.write(part)) await new Promise((r) => cur.ws.once('drain', r)); } else mfBuf.push(part);
        if (left === 0) {
          if (cur.ws) await new Promise((r) => cur.ws.end(r)); else manifest = JSON.parse(Buffer.concat(mfBuf).toString());
          cur = null;
        }
      }
    }
    yield Buffer.alloc(0);
  };
  try {
    await pipeline(fs.createReadStream(file, { start: HEAD, end: size - 17 }), decipher, zlib.createGunzip(), parser, async function (src) { for await (const _ of src); });
  } catch (e) {
    if (/unable to authenticate|incorrect header check|invalid|unexpected end/i.test(e.message)) throw new Error('Sai mật khẩu hoặc file sao lưu bị hỏng');
    throw e;
  }
  if (!ended || !manifest || manifest.app !== 'gachaz') throw new Error('Gói sao lưu không đầy đủ');
  const dbPath = path.join(dir, 'shop.db');
  if (!fs.existsSync(dbPath)) throw new Error('Gói sao lưu thiếu database');
  const up = path.join(dir, 'uploads');
  return { manifest, dbPath, uploadsDir: manifest.withUploads ? (fs.existsSync(up) ? up : null) : null };
}

// ---------- Khôi phục ----------
const keyOf = (appKey) => crypto.createHash('sha256').update(String(appKey)).digest();
function decryptWith(key, payload) {
  const [iv, tag, enc] = String(payload).split('.').map((p) => Buffer.from(p, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const ENC_COLS = [['products', 'credentials_enc'], ['product_stock', 'data_enc'], ['orders', 'delivered_enc'], ['orders_archive', 'delivered_enc'], ['boost_orders', 'login_enc']];

// Dữ liệu mã hóa bằng APP_KEY cũ -> giải mã rồi mã hóa lại bằng APP_KEY của VPS hiện tại
function reencryptAll(oldAppKey) {
  const oldKey = keyOf(oldAppKey);
  let n = 0;
  const fix = (v) => (v ? encrypt(decryptWith(oldKey, v)) : v);
  for (const [t, c] of ENC_COLS) {
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(t)) continue;
    const sel = db.prepare(`SELECT rowid AS rid, ${c} AS v FROM ${t} WHERE rowid > ? AND ${c} IS NOT NULL ORDER BY rowid LIMIT 2000`);
    const upd = db.prepare(`UPDATE ${t} SET ${c} = ? WHERE rowid = ?`);
    for (let last = 0; ;) {
      const rows = sel.all(last);
      if (!rows.length) break;
      for (const r of rows) { upd.run(fix(r.v), r.rid); last = r.rid; n++; }
    }
  }
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE '%\\_enc' ESCAPE '\\' AND value != ''").all()) {
    try { db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(fix(r.value), r.key); n++; } catch { db.prepare("UPDATE settings SET value = '' WHERE key = ?").run(r.key); }
  }
  return n;
}

// File .db lẻ (không có APP_KEY đi kèm): chỉ nhận nếu giải mã được bằng APP_KEY hiện tại
function checkDbKey(dbPath) {
  const x = new (require('better-sqlite3'))(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tbl = new Set(x.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (!tbl.has('users') || !tbl.has('settings')) throw new Error('File không phải database của web');
    for (const [t, c] of ENC_COLS) {
      if (!tbl.has(t)) continue;
      const r = x.prepare(`SELECT ${c} AS v FROM ${t} WHERE ${c} IS NOT NULL LIMIT 1`).get();
      if (r && decrypt(r.v).startsWith('[Không giải mã')) throw new Error('File .db này được mã hóa bằng APP_KEY khác (VPS cũ). Hãy dùng gói sao lưu đầy đủ (.gzbak).');
    }
  } finally { x.close(); }
}

function importDatabase(srcPath, oldAppKey) {
  const chk = new (require('better-sqlite3'))(srcPath, { readonly: true, fileMustExist: true });
  const srcTables = new Set(chk.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  chk.close();
  if (!srcTables.has('users') || !srcTables.has('settings')) throw new Error('Database trong bản sao lưu không hợp lệ');

  const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  db.pragma('foreign_keys = OFF');
  db.exec(`ATTACH DATABASE '${srcPath.replace(/'/g, "''")}' AS rs`);
  const summary = {};
  try {
    const tables = db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products_fts%'").all().map((r) => r.name);
    db.transaction(() => {
      ftsPause();
      for (const t of tables) {
        db.prepare(`DELETE FROM main.${q(t)}`).run(); // xóa sạch dữ liệu cũ
        if (!srcTables.has(t)) continue;
        const mine = db.prepare(`PRAGMA main.table_info(${q(t)})`).all().map((c) => c.name);
        const theirs = new Set(db.prepare(`PRAGMA rs.table_info(${q(t)})`).all().map((c) => c.name));
        const cols = mine.filter((c) => theirs.has(c)).map(q).join(', ');
        if (cols) summary[t] = db.prepare(`INSERT INTO main.${q(t)} (${cols}) SELECT ${cols} FROM rs.${q(t)}`).run().changes;
      }
      if (oldAppKey && oldAppKey !== config.appKey) summary._reencrypted = reencryptAll(oldAppKey);
      ftsResume();
    })();
  } finally {
    db.exec('DETACH DATABASE rs');
    db.pragma('foreign_keys = ON');
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  clearSettingsCache();
  return summary;
}

// Thay nội dung thư mục ảnh (chuyển từng mục bên trong, không đổi tên chính thư mục uploads):
// web chạy bằng tài khoản riêng chỉ có quyền ghi trong public/uploads, không có quyền với public/
async function swapUploads(newDir) {
  const cur = config.paths.uploads;
  const old = path.join(TMP, `uploads-cu-${Date.now()}`);
  await fsp.mkdir(cur, { recursive: true });
  await fsp.mkdir(old, { recursive: true });
  const moveAll = async (from, to) => { for (const n of await fsp.readdir(from)) await fsp.rename(path.join(from, n), path.join(to, n)); };
  await moveAll(cur, old);
  try { await moveAll(newDir, cur); } catch (e) {
    for (const n of await fsp.readdir(cur)) await fsp.rm(path.join(cur, n), { recursive: true, force: true });
    await moveAll(old, cur);
    throw e;
  }
  await fsp.rm(old, { recursive: true, force: true });
}

/** Khôi phục từ file tải lên (.gzbak hoặc .db). -> { summary, manifest, safety } */
async function restoreFromFile(file, password) {
  const work = path.join(TMP, `restore-${Date.now()}`);
  try {
    const fh = await fsp.open(file, 'r'); const sig = Buffer.alloc(16); await fh.read(sig, 0, 16, 0); await fh.close();
    let dbPath, uploadsDir = null, manifest = null;
    if (sig.toString('latin1').startsWith('SQLite format 3')) {
      dbPath = file;
      checkDbKey(dbPath);
    } else {
      ({ manifest, dbPath, uploadsDir } = await readPackage(file, password, work));
    }
    const safety = await localBackup('truoc-khoi-phuc'); // lưu lại dữ liệu hiện tại phòng khi cần quay lại
    const summary = importDatabase(dbPath, manifest?.appKey);
    if (uploadsDir) await swapUploads(uploadsDir);
    return { summary, manifest, safety, uploads: !!uploadsDir };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

// ---------- Bản sao lưu hằng ngày trên VPS (giữ tối đa N bản, xóa bản cũ hơn N ngày) ----------
const BACKUP_RE = /^shop-[\w-]+\.db$/;
function listBackups() {
  return fs.readdirSync(config.paths.backups).filter((f) => BACKUP_RE.test(f))
    .map((f) => { const st = fs.statSync(path.join(config.paths.backups, f)); return { name: f, size: st.size, at: Math.floor(st.mtimeMs / 1000) }; })
    .sort((a, b) => b.at - a.at);
}
function pruneBackups() {
  const list = listBackups();
  const minAt = nowS() - config.retention.backupDays * 86400;
  list.forEach((b, i) => { if (i >= config.retention.backupKeep || b.at < minAt) fs.rmSync(path.join(config.paths.backups, b.name), { force: true }); });
}
async function localBackup(tag = '') {
  const name = `shop-${stamp()}${tag ? '-' + tag : ''}.db`;
  await db.backup(path.join(config.paths.backups, name));
  pruneBackups();
  setSetting('last_backup', String(nowS()));
  return name;
}
function deleteBackup(name) {
  if (!BACKUP_RE.test(name)) return false;
  const f = path.join(config.paths.backups, path.basename(name));
  if (!fs.existsSync(f)) return false;
  fs.rmSync(f);
  return true;
}

// ---------- Telegram ----------
const fmtMB = (b) => (b / 1024 / 1024).toFixed(1) + 'MB';
async function sendTelegram(file, caption) {
  const s = getSettings();
  const token = s.tg_token_enc ? decrypt(s.tg_token_enc) : '';
  if (!token || !s.tg_chat_id) throw new Error('Chưa nhập Bot token hoặc Chat ID');
  const fd = new FormData();
  fd.append('chat_id', s.tg_chat_id);
  fd.append('caption', caption.slice(0, 1000));
  fd.append('document', await fs.openAsBlob(file), path.basename(file));
  let j;
  try {
    const r = await fetch(`${process.env.TG_API_URL || 'https://api.telegram.org'}/bot${token}/sendDocument`, { method: 'POST', body: fd, signal: AbortSignal.timeout(300000) });
    j = await r.json();
  } catch (e) { throw new Error(e.name === 'TimeoutError' ? 'Gửi Telegram quá lâu (hơn 5 phút)' : 'Không kết nối được Telegram'); }
  if (!j.ok) throw new Error('Telegram báo: ' + (j.description || 'lỗi không rõ'));
}

/** Gửi tin nhắn ngắn cho admin qua bot Telegram (đơn cày thuê mới...) — chưa cấu hình bot thì bỏ qua */
async function notifyAdmin(text) {
  const s = getSettings();
  const token = s.tg_token_enc ? decrypt(s.tg_token_enc) : '';
  if (!token || !s.tg_chat_id) return false;
  const r = await fetch(`${process.env.TG_API_URL || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: s.tg_chat_id, text: String(text).slice(0, 4000) }), signal: AbortSignal.timeout(15000),
  });
  return (await r.json()).ok;
}

/** Tạo gói và gửi Telegram (gói > 49MB thì gửi bản chỉ dữ liệu, không kèm ảnh) */
async function backupToTelegram() {
  const host = String(config.baseUrl).replace(/^https?:\/\//, '');
  let pkg;
  try {
    pkg = await makePackage({ withUploads: true });
    if (pkg.size > TG_LIMIT) { await fsp.rm(pkg.file, { force: true }); pkg = await makePackage({ withUploads: false }); }
    const c = pkg.counts;
    const caption = `🗄 Sao lưu ${host} — ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}\n`
      + `${fmtMB(pkg.size)} · ${c.users} người dùng · ${c.products} sản phẩm · ${c.orders} đơn · ${c.deposits} đơn nạp\n`
      + (pkg.withUploads ? `Kèm ${pkg.files} ảnh.` : '⚠️ Ảnh quá nặng để gửi Telegram (giới hạn 50MB) — gói này chỉ có dữ liệu, tải gói đầy đủ ở Admin > Bảo trì dữ liệu.')
      + '\nKhôi phục: Admin > Bảo trì dữ liệu > Khôi phục dữ liệu (cần mật khẩu gói).';
    await sendTelegram(pkg.file, caption);
    const msg = `Đã gửi ${fmtMB(pkg.size)}${pkg.withUploads ? '' : ' (chỉ dữ liệu)'}`;
    setSetting('tg_last_at', String(nowS())); setSetting('tg_last_ok', '1'); setSetting('tg_last_msg', msg);
    return { ok: true, message: msg };
  } catch (e) {
    setSetting('tg_last_at', String(nowS())); setSetting('tg_last_ok', '0'); setSetting('tg_last_msg', e.message.slice(0, 200));
    return { ok: false, message: e.message };
  } finally {
    if (pkg) await fsp.rm(pkg.file, { force: true });
  }
}

// ---------- Thống kê cho trang admin ----------
function tableCounts(only) {
  const names = only || db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products_fts%' ORDER BY name").all().map((r) => r.name);
  const out = {};
  for (const t of names) { try { out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c; } catch { out[t] = 0; } }
  return out;
}
let upCache = { at: 0, size: 0, files: 0 };
async function uploadsSize() {
  if (Date.now() - upCache.at < 60000) return upCache;
  const files = await walk(config.paths.uploads);
  let size = 0;
  for (const f of files) { try { size += (await fsp.stat(f.full)).size; } catch { /* bỏ qua */ } }
  upCache = { at: Date.now(), size, files: files.length };
  return upCache;
}

// Sau khi khôi phục: báo mọi bản PM2 tự khởi động lại (đọc lại cài đặt, cache) — chỉ khi chạy dưới PM2
const restartStmt = db.prepare("SELECT value FROM settings WHERE key = 'restart_token'");
let myToken = null;
function watchRestart() {
  if (process.env.pm_id === undefined) return;
  myToken = restartStmt.get()?.value || '';
  setInterval(() => {
    try { if ((restartStmt.get()?.value || '') !== myToken) { console.log('[backup] dữ liệu vừa được khôi phục -> khởi động lại'); process.exit(0); } } catch { /* bỏ qua */ }
  }, 5000).unref();
}
const requestRestart = () => setSetting('restart_token', String(Date.now()));

// Trạng thái khôi phục chạy nền: lưu ra file (còn đọc được sau khi web tự khởi động lại và phiên đăng nhập đã đổi)
const jobFile = (id) => path.join(TMP, `job-${id}.json`);
const setJob = (id, data) => fs.writeFileSync(jobFile(id), JSON.stringify({ ...data, at: nowS() }));
const getJob = (id) => { if (!/^[a-f0-9]{24}$/.test(id)) return null; try { return JSON.parse(fs.readFileSync(jobFile(id), 'utf8')); } catch { return null; } };

// Dọn file tạm bị bỏ dở (tải lên nửa chừng, gói lỗi...) cũ hơn 1 ngày
function cleanTmp() {
  const old = Date.now() - 86400000;
  for (const f of fs.readdirSync(TMP)) {
    const full = path.join(TMP, f);
    try { if (fs.statSync(full).mtimeMs < old) fs.rmSync(full, { recursive: true, force: true }); } catch { /* bỏ qua */ }
  }
}

module.exports = {
  notifyAdmin, cleanTmp, setJob, getJob,
  makePackage, readPackage, restoreFromFile, importDatabase, localBackup, listBackups, deleteBackup, pruneBackups,
  sendTelegram, backupToTelegram, tableCounts, uploadsSize, watchRestart, requestRestart, TMP,
};
