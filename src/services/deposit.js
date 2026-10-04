'use strict';
const { db, bumpStat, logActivity, getSettings } = require('../db');
const { randomCode } = require('../utils/crypto');
const { money } = require('../utils/helpers');
const config = require('../config');


function limits() {
  const s = getSettings();
  return {
    min: parseInt(s.deposit_min, 10) || 10000,
    max: parseInt(s.deposit_max, 10) || 50000000,
  };
}

/** Mỗi user chỉ có 1 mã nạp chờ thanh toán. replace = true -> hủy mã cũ (không cộng tiền nữa) rồi tạo mã mới */
function createDeposit(userId, amount, { replace = false } = {}) {
  const st = getSettings();
  if (!st.bank_account || !st.bank_code) return { ok: false, message: 'Shop chưa cấu hình tài khoản ngân hàng nhận tiền. Vui lòng liên hệ admin.' };
  const { min, max } = limits();
  if (!Number.isInteger(amount) || amount < min || amount > max) {
    return { ok: false, message: `Số tiền nạp từ ${money(min)} đến ${money(max)}` };
  }
  return createTx(userId, amount, replace);
}
const createTx = db.transaction((userId, amount, replace) => {
  const pending = db.prepare("SELECT COUNT(*) n FROM deposits WHERE user_id = ? AND status = 'pending'").get(userId).n;
  if (pending && !replace) return { ok: false, pending: true, message: 'Bạn có đơn nạp chưa thanh toán. Nếu tạo mã mới đơn nạp cũ sẽ bị hủy.' };
  if (pending) db.prepare("UPDATE deposits SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'").run(userId);

  let code;
  for (let i = 0; i < 5; i++) {
    code = config.depositPrefix + randomCode(6, '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ');
    if (!db.prepare('SELECT 1 FROM v_deposits WHERE code = ?').get(code)) break;
  }
  const id = db.prepare('INSERT INTO deposits(user_id, code, amount) VALUES(?,?,?)').run(userId, code, amount).lastInsertRowid;
  return { ok: true, deposit: db.prepare('SELECT * FROM deposits WHERE id = ?').get(id) };
});

/** Thông tin cho popup "Nạp tiền thành công": số tiền, số dư trước / sau */
function depositReceipt(d) {
  const log = db.prepare("SELECT amount, balance_after FROM balance_logs WHERE user_id = ? AND type = 'deposit' AND ref = ? ORDER BY id DESC LIMIT 1").get(d.user_id, d.code);
  const after = log ? log.balance_after : null;
  return { id: d.id, code: d.code, received: d.received, before: after == null ? null : after - (log.amount || d.received), after, at: d.completed_at };
}
const unseenStmt = db.prepare("SELECT * FROM deposits WHERE user_id = ? AND status = 'success' AND seen_at IS NULL AND completed_at > unixepoch() - 86400 ORDER BY id DESC LIMIT 1");
const markSeen = (id) => db.prepare('UPDATE deposits SET seen_at = unixepoch() WHERE id = ? AND seen_at IS NULL').run(id);

/** Cộng tiền cho 1 đơn nạp. Idempotent: chỉ cộng khi đơn còn pending/expired. */
const completeTx = db.transaction((depositId, received, { txnId = null, adminId = null, note = null } = {}) => {
  const d = db.prepare('SELECT * FROM deposits WHERE id = ?').get(depositId);
  if (!d) return { ok: false, message: 'Không tìm thấy yêu cầu nạp' };
  if (!['pending', 'expired'].includes(d.status)) return { ok: false, message: 'Yêu cầu nạp đã được xử lý' };
  received = Math.max(0, Math.floor(received));
  if (!received) return { ok: false, message: 'Số tiền không hợp lệ' };

  const r = db.prepare(`UPDATE deposits SET status = 'success', received = ?, bank_txn_id = ?, handled_by = ?, note = ?, completed_at = unixepoch()
    WHERE id = ? AND status IN ('pending','expired')`).run(received, txnId, adminId, note, d.id);
  if (r.changes !== 1) return { ok: false, message: 'Yêu cầu nạp đã được xử lý' };

  db.prepare('UPDATE users SET balance = balance + ?, total_deposit = total_deposit + ? WHERE id = ?').run(received, received, d.user_id);
  const bal = db.prepare('SELECT balance FROM users WHERE id = ?').get(d.user_id).balance;
  db.prepare('INSERT INTO balance_logs(user_id, amount, balance_after, type, ref, note) VALUES(?,?,?,?,?,?)')
    .run(d.user_id, received, bal, 'deposit', d.code, adminId ? 'Admin duyệt nạp tiền' : 'Nạp tiền tự động');
  bumpStat('deposits', received);
  bumpStat('deposit_count', 1);
  return { ok: true, deposit: d, received };
});

function completeDeposit(depositId, received, opts) {
  const r = completeTx.immediate(depositId, received, opts);
  if (r.ok) logActivity(opts?.adminId || r.deposit.user_id, opts?.adminId ? 'admin_deposit_approve' : 'deposit_auto', `${r.deposit.code} +${money(r.received)}`);
  if (r.ok) {
    require('./tracking').track(r.deposit.user_id, 'deposit', r.received, r.deposit.code);
    const u = db.prepare('SELECT username, email, balance FROM users WHERE id = ?').get(r.deposit.user_id);
    if (u?.email) require('./mailer').sendLater(u.email, 'deposit', { username: u.username, code: r.deposit.code, amount: r.received, balance: u.balance });
  }
  return r;
}

function cancelDeposit(depositId, userId = null, adminId = null) {
  const sql = userId
    ? "UPDATE deposits SET status = 'cancelled', handled_by = ? WHERE id = ? AND user_id = ? AND status = 'pending'"
    : "UPDATE deposits SET status = 'cancelled', handled_by = ? WHERE id = ? AND status IN ('pending','expired')";
  const r = userId ? db.prepare(sql).run(adminId, depositId, userId) : db.prepare(sql).run(adminId, depositId);
  return r.changes === 1;
}

/**
 * Chuẩn hóa payload từ nhiều cổng (SePay, Casso, tự viết) về [{txnId, amount, content}]
 */
function normalizeWebhook(body) {
  const list = [];
  if (!body || typeof body !== 'object') return list;
  if (Array.isArray(body.transactions)) {
    // NIFY: { event:'new_transactions', account:{ account_number }, transactions:[{ amount, description, reference, transaction_date }] }
    const acc = String((body.account || body.bank)?.account_number || '').replace(/\D/g, '');
    const mine = String(getSettings().bank_account || '').replace(/\D/g, '');
    if (acc && mine && acc !== mine) return list; // giao dịch của tài khoản khác -> bỏ qua
    for (const t of body.transactions) {
      list.push({ txnId: String(t.reference || t.id || ''), amount: Number(t.amount), content: String(t.description || t.content || '') });
    }
  } else if (Array.isArray(body.data)) {
    // Casso: { error:0, data:[{ id|tid, amount, description }] }
    for (const t of body.data) {
      list.push({ txnId: String(t.tid || t.id || t.reference || ''), amount: Number(t.amount), content: String(t.description || t.content || '') });
    }
  } else if (body.transferAmount != null) {
    // SePay: { id, transferType:'in', transferAmount, content, referenceCode }
    if (body.transferType && body.transferType !== 'in') return list;
    list.push({ txnId: String(body.referenceCode || body.id || ''), amount: Number(body.transferAmount), content: String(body.content || body.description || '') });
  } else if (body.amount != null) {
    // Định dạng chung: { txn_id, amount, content }
    list.push({ txnId: String(body.txn_id || body.id || ''), amount: Number(body.amount), content: String(body.content || body.description || '') });
  }
  return list.filter((t) => t.txnId && Number.isFinite(t.amount) && t.amount > 0);
}

function processBankTransactions(body) {
  return processTxns(normalizeWebhook(body), 'Webhook ngân hàng');
}

/**
 * Khớp danh sách giao dịch tiền vào { txnId, amount, content } với đơn nạp (dùng chung cho webhook NIFY/SePay và quét APICANHAN).
 * - Mã GD đã xử lý -> bỏ qua (không cộng 2 lần)
 * - Cùng 1 lần chuyển khoản báo về từ 2 nguồn (mã GD mỗi nguồn khác nhau) -> nguồn đến sau ghi "Bỏ qua", không cộng lại
 */
const ACN = 'acn:'; // tiền tố mã GD từ APICANHAN
function processTxns(txns, note) {
  require('./maintenance').expireDeposits(); // đơn quá thời gian chờ phải được đánh dấu trước khi khớp tiền
  const re = new RegExp(config.depositPrefix + '[0-9A-Z]{6}');
  const lateOk = getSettings().deposit_late_credit !== '0';
  const results = [];
  for (const t of txns) {
    const exists = db.prepare('SELECT id, status FROM bank_transactions WHERE txn_id = ?').get(t.txnId);
    if (exists) { results.push({ txnId: t.txnId, status: 'duplicate' }); continue; }
    const normalized = t.content.toUpperCase().replace(/[^0-9A-Z]/g, '');
    const m = normalized.match(re);
    const amount = Math.floor(t.amount);
    let status = 'unmatched';
    let depositId = null;
    if (m) {
      const d = db.prepare('SELECT id, status, received, bank_txn_id, completed_at FROM deposits WHERE code = ?').get(m[0]);
      // Đơn đã quá hạn: chỉ tự cộng nếu admin bật "cộng tiền khi khách chuyển muộn"; nếu tắt, GD nằm ở mục chưa khớp để admin xử lý
      if (d && (d.status === 'pending' || (lateOk && d.status === 'expired'))) {
        const r = completeDeposit(d.id, amount, { txnId: t.txnId, note });
        if (r.ok) { status = 'matched'; depositId = d.id; }
      } else if (d && d.status === 'success' && d.received === amount && d.completed_at > Math.floor(Date.now() / 1000) - 6 * 3600
        && String(d.bank_txn_id || '').startsWith(ACN) !== t.txnId.startsWith(ACN)) {
        status = 'ignored'; depositId = d.id; // đã cộng qua nguồn kia
      }
    }
    db.prepare('INSERT OR IGNORE INTO bank_transactions(txn_id, amount, content, matched_deposit_id, status, raw) VALUES(?,?,?,?,?,?)')
      .run(t.txnId, amount, t.content.slice(0, 500), depositId, status, JSON.stringify(t).slice(0, 2000));
    results.push({ txnId: t.txnId, status });
  }
  return results;
}

module.exports = { createDeposit, completeDeposit, cancelDeposit, processBankTransactions, processTxns, limits, depositReceipt, unseenStmt, markSeen };
