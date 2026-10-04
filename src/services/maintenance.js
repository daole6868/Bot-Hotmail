'use strict';
/**
 * Tự động bảo trì dữ liệu — giúp web vẫn nhanh khi dữ liệu nạp/mua bán tăng lớn:
 *  - Hết hạn đơn nạp treo, xóa đơn nạp hủy cũ
 *  - Chuyển đơn hàng / nạp tiền cũ sang bảng lưu trữ (archive)
 *  - Xóa log cũ, session hết hạn, IP block hết hạn, giao dịch bank đã khớp cũ
 *  - Checkpoint WAL, PRAGMA optimize, backup DB hàng ngày (giữ N bản)
 */
const fs = require('fs');
const path = require('path');
const { db, setSetting, getSettings, vnDay } = require('../db');
const SQLiteStore = require('../session-store');
const config = require('../config');

const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);

// Thời gian chờ thanh toán đơn nạp (phút): chỉnh ở Admin > Cài đặt bank, mặc định lấy từ .env
function depositExpireMinutes() {
  const v = parseInt(getSettings().deposit_expire_minutes, 10);
  return v >= 5 && v <= 10080 ? v : config.retention.depositExpireMinutes;
}

// Đơn nạp quá thời gian chờ -> chuyển 'expired' (hiện cho khách là "Đã hủy (quá hạn)", không thao tác được nữa)
// Gọi rất thường xuyên (mỗi lần trang nạp tự kiểm tra, mỗi webhook...) -> tối đa 1 lần / 2 giây mỗi bản web,
// tránh mỗi request đều mở 1 lệnh ghi vào database khi nhiều khách cùng nạp
let lastExpire = 0;
function expireDeposits(force = false) {
  if (!force && Date.now() - lastExpire < 2000) return 0;
  lastExpire = Date.now();
  const cutoff = nowS() - depositExpireMinutes() * 60;
  return db.prepare("UPDATE deposits SET status = 'expired' WHERE status = 'pending' AND created_at < ?").run(cutoff).changes;
}

function purgeOld() {
  const r = config.retention;
  const t = nowS();
  const out = {};
  out.activityLogs = db.prepare('DELETE FROM activity_logs WHERE created_at < ?').run(t - r.logDays * DAY).changes;
  out.loginLogs = db.prepare('DELETE FROM login_logs WHERE created_at < ?').run(t - r.logDays * DAY).changes;
  out.deadDeposits = db.prepare("DELETE FROM deposits WHERE status IN ('cancelled','expired') AND created_at < ?").run(t - r.depositDays * DAY).changes;
  // luôn giữ dòng mới nhất của mỗi khách (để đối chiếu số dư hằng đêm)
  out.balanceLogs = db.prepare('DELETE FROM balance_logs WHERE created_at < ? AND id NOT IN (SELECT MAX(id) FROM balance_logs GROUP BY user_id)').run(t - r.balanceLogDays * DAY).changes;
  out.bankTxns = db.prepare("DELETE FROM bank_transactions WHERE status IN ('matched','ignored') AND created_at < ?").run(t - r.bankTxnDays * DAY).changes;
  out.sessions = SQLiteStore.cleanup();
  try { const b = require('./boost'); out.boostCarts = b.purgeCarts(); out.boostLogins = b.wipeLogins(); } catch (e) { console.error('[maintenance] boost', e.message); }
  out.ipBlocks = db.prepare('DELETE FROM ip_blocks WHERE expires_at IS NOT NULL AND expires_at < ?').run(t).changes;
  // Mã xác minh / link đặt lại mật khẩu đã dùng hoặc hết hạn, nhật ký email cũ, thiết bị không dùng 180 ngày
  out.otps = db.prepare('DELETE FROM email_otps WHERE expires_at < ?').run(t - DAY).changes
    + db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(t - DAY).changes;
  out.emailLogs = db.prepare('DELETE FROM email_logs WHERE created_at < ?').run(t - r.logDays * DAY).changes;
  out.devices = db.prepare('DELETE FROM trusted_devices WHERE last_seen_at < ?').run(t - 180 * DAY).changes;
  try { out.chats = require('./chat').purge(); } catch (e) { console.error('[maintenance] chat', e.message); }
  return out;
}

// Chuyển theo lô 5000 dòng để không khóa DB lâu
const archiveOrdersTx = db.transaction((cutoff) => {
  const ids = db.prepare('SELECT id FROM orders WHERE created_at < ? ORDER BY id LIMIT 5000').all(cutoff).map((r) => r.id);
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`INSERT OR IGNORE INTO orders_archive SELECT id, order_code, user_id, product_id, product_title, game_name, price, discount, total,
    coupon_code, delivered_enc, status, note, ip, created_at FROM orders WHERE id IN (${ph})`).run(...ids);
  db.prepare(`UPDATE coupon_usages SET order_id = NULL WHERE order_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM orders WHERE id IN (${ph})`).run(...ids);
  return ids.length;
});

const archiveDepositsTx = db.transaction((cutoff) => {
  const ids = db.prepare("SELECT id FROM deposits WHERE status = 'success' AND created_at < ? ORDER BY id LIMIT 5000").all(cutoff).map((r) => r.id);
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  db.prepare(`INSERT OR IGNORE INTO deposits_archive SELECT id, user_id, code, amount, received, status, method, bank_txn_id, note, handled_by,
    created_at, completed_at FROM deposits WHERE id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM deposits WHERE id IN (${ph})`).run(...ids);
  return ids.length;
});

function archive() {
  const cutoff = nowS() - config.retention.archiveDays * DAY;
  let orders = 0, deposits = 0, n;
  // tối đa 20 lô / lần chạy
  for (let i = 0; i < 20 && (n = archiveOrdersTx.immediate(cutoff)); i++) orders += n;
  for (let i = 0; i < 20 && (n = archiveDepositsTx.immediate(cutoff)); i++) deposits += n;
  return { orders, deposits };
}

// Bản sao lưu DB trên VPS: giữ tối đa BACKUP_KEEP bản (mặc định 10), tự xóa bản cũ hơn BACKUP_DAYS ngày (mặc định 10)
function backup() {
  return require('./backup').localBackup();
}

const dbFile = () => path.join(config.paths.data, 'shop.db');
const fileSize = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);

/** Trả về dung lượng (file DB + WAL) trước/sau để admin thấy hiệu quả */
function optimize(vacuum = false) {
  const before = fileSize(dbFile()) + fileSize(dbFile() + '-wal');
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('optimize');
  if (vacuum) { db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); }
  return { before, after: fileSize(dbFile()) + fileSize(dbFile() + '-wal') };
}

/** Tính lại toàn bộ thống kê ngày từ dữ liệu gốc (dùng khi cần đối soát) */
function rebuildStats() {
  const tz = "'+7 hours'";
  db.transaction(() => {
    db.exec('DELETE FROM daily_stats');
    db.exec(`INSERT INTO daily_stats(day, revenue, orders)
      SELECT date(created_at, 'unixepoch', ${tz}) d, SUM(total), COUNT(*) FROM v_orders GROUP BY d`);
    db.exec(`INSERT INTO daily_stats(day, refunds)
      SELECT date(created_at, 'unixepoch', ${tz}) d, SUM(total) FROM v_orders WHERE status = 'refunded' GROUP BY d
      ON CONFLICT(day) DO UPDATE SET refunds = excluded.refunds`);
    db.exec(`INSERT INTO daily_stats(day, deposits, deposit_count)
      SELECT date(completed_at, 'unixepoch', ${tz}) d, SUM(received), COUNT(*) FROM v_deposits WHERE status = 'success' GROUP BY d
      ON CONFLICT(day) DO UPDATE SET deposits = excluded.deposits, deposit_count = excluded.deposit_count`);
    db.exec(`INSERT INTO daily_stats(day, new_users)
      SELECT date(created_at, 'unixepoch', ${tz}) d, COUNT(*) FROM users GROUP BY d
      ON CONFLICT(day) DO UPDATE SET new_users = excluded.new_users`);
  })();
  return db.prepare('SELECT COUNT(*) c FROM daily_stats').get().c;
}

function dbInfo() {
  const file = path.join(config.paths.data, 'shop.db');
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const walFile = file + '-wal';
  const wal = fs.existsSync(walFile) ? fs.statSync(walFile).size : 0;
  const counts = require('./backup').tableCounts();
  const sessions = SQLiteStore.stats();
  const backups = require('./backup').listBackups();
  return { size, wal, counts, backups, sessions: { logged: sessions.logged || 0, guest: sessions.guest || 0 } };
}

function runLight() {
  const expired = expireDeposits(true);
  const purged = purgeOld();
  db.pragma('wal_checkpoint(PASSIVE)');
  return { expired, ...purged };
}

async function runDaily() {
  const res = { light: runLight(), archived: archive() };
  try { require('./backup').cleanTmp(); } catch { /* bỏ qua */ }
  try { res.images = await require('./image-cleanup').run(); } catch (e) { console.error('[maintenance] images', e.message); }
  optimize(false);
  res.backup = await backup();
  // Đối chiếu số dư khách với lịch sử giao dịch, lệch thì báo Telegram
  try { res.reconcile = require('./alerts').reconcileAndReport().mismatches.length; } catch (e) { console.error('[reconcile]', e); }
  setSetting('last_maintenance', String(nowS()));
  // Gửi gói sao lưu về Telegram (nếu đã bật) — chạy nền, không chặn web
  if (getSettings().tg_enabled === '1') res.telegram = (await require('./backup').backupToTelegram()).message;
  return res;
}

let timer = null;
function startScheduler() {
  if (timer) return;
  const tick = async () => {
    try {
      runLight();
      const s = getSettings();
      // Chạy việc nặng 1 lần/ngày
      if (s.last_daily_day !== vnDay()) {
        setSetting('last_daily_day', vnDay());
        const r = await runDaily();
        console.log('[maintenance] daily done', JSON.stringify(r));
      }
    } catch (e) {
      console.error('[maintenance] error', e);
    }
  };
  setTimeout(tick, 5000);
  timer = setInterval(tick, 10 * 60 * 1000); // 10 phút
  timer.unref();
  // Hết hạn đơn nạp cần chính xác theo phút -> kiểm tra riêng mỗi phút (câu lệnh rất nhẹ)
  setInterval(() => { try { expireDeposits(true); } catch (e) { console.error('[maintenance] expire', e.message); } }, 60 * 1000).unref();
}

module.exports = { runLight, runDaily, archive, backup, optimize, rebuildStats, dbInfo, startScheduler, expireDeposits, depositExpireMinutes };
