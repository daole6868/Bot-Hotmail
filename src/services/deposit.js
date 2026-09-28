'use strict';
const { db, bumpStat, logActivity, getSettings } = require('../db');
const { randomCode } = require('../utils/crypto');
const { money } = require('../utils/helpers');
const config = require('../config');

const MAX_PENDING = 3;

function limits() {
  const s = getSettings();
  return {
    min: parseInt(s.deposit_min, 10) || 10000,
    max: parseInt(s.deposit_max, 10) || 50000000,
  };
}

function createDeposit(userId, amount) {
  const st = getSettings();
  if (!st.bank_account || !st.bank_code) return { ok: false, message: 'Shop chưa cấu hình tài khoản ngân hàng nhận tiền. Vui lòng liên hệ admin.' };
  const { min, max } = limits();
  if (!Number.isInteger(amount) || amount < min || amount > max) {
    return { ok: false, message: `Số tiền nạp từ ${money(min)} đến ${money(max)}` };
  }
  // Tái sử dụng yêu cầu đang chờ cùng số tiền, tránh spam tạo đơn
  const same = db.prepare("SELECT * FROM deposits WHERE user_id = ? AND status = 'pending' AND amount = ? ORDER BY id DESC LIMIT 1").get(userId, amount);
  if (same) return { ok: true, deposit: same };
  const pending = db.prepare("SELECT COUNT(*) n FROM deposits WHERE user_id = ? AND status = 'pending'").get(userId).n;
  if (pending >= MAX_PENDING) return { ok: false, message: `Bạn đang có ${pending} yêu cầu nạp chưa thanh toán. Hãy thanh toán hoặc hủy bớt.` };

  let code;
  for (let i = 0; i < 5; i++) {
    code = config.depositPrefix + randomCode(6, '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ');
    if (!db.prepare('SELECT 1 FROM v_deposits WHERE code = ?').get(code)) break;
  }
  const id = db.prepare('INSERT INTO deposits(user_id, code, amount) VALUES(?,?,?)').run(userId, code, amount).lastInsertRowid;
  return { ok: true, deposit: db.prepare('SELECT * FROM deposits WHERE id = ?').get(id) };
}

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
  if (Array.isArray(body.data)) {
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
  const txns = normalizeWebhook(body);
  require('./maintenance').expireDeposits(); // đơn quá thời gian chờ phải được đánh dấu trước khi khớp tiền
  const re = new RegExp(config.depositPrefix + '[0-9A-Z]{6}');
  const results = [];
  for (const t of txns) {
    const exists = db.prepare('SELECT id, status FROM bank_transactions WHERE txn_id = ?').get(t.txnId);
    if (exists) { results.push({ txnId: t.txnId, status: 'duplicate' }); continue; }
    const normalized = t.content.toUpperCase().replace(/[^0-9A-Z]/g, '');
    const m = normalized.match(re);
    let status = 'unmatched';
    let depositId = null;
    if (m) {
      // Đơn đã quá hạn: chỉ tự cộng nếu admin bật "cộng tiền khi khách chuyển muộn"; nếu tắt, GD nằm ở mục chưa khớp để admin xử lý
      const lateOk = getSettings().deposit_late_credit !== '0';
      const d = db.prepare(`SELECT id FROM deposits WHERE code = ? AND status IN ('pending'${lateOk ? ", 'expired'" : ''})`).get(m[0]);
      if (d) {
        const r = completeDeposit(d.id, Math.floor(t.amount), { txnId: t.txnId, note: 'Webhook ngân hàng' });
        if (r.ok) { status = 'matched'; depositId = d.id; }
      }
    }
    db.prepare('INSERT OR IGNORE INTO bank_transactions(txn_id, amount, content, matched_deposit_id, status, raw) VALUES(?,?,?,?,?,?)')
      .run(t.txnId, Math.floor(t.amount), t.content.slice(0, 500), depositId, status, JSON.stringify(t).slice(0, 2000));
    results.push({ txnId: t.txnId, status });
  }
  return results;
}

module.exports = { createDeposit, completeDeposit, cancelDeposit, processBankTransactions, limits };
