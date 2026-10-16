'use strict';
/**
 * Báo Telegram ngay khi có thao tác nhạy cảm (phát hiện sớm nếu tài khoản admin bị chiếm).
 * Gắn vào logActivity (db.js): mọi thao tác đã ghi nhật ký đều đi qua đây, không phải sửa từng chỗ.
 * Bật / tắt ở Bảo trì dữ liệu -> Telegram ("Báo khi có thao tác admin nhạy cảm").
 */
const { db, getSettings } = require('../db');

// action -> [biểu tượng + nội dung]; userRole 'admin' = chỉ báo khi người làm là admin
const RULES = {
  admin_login: ['🔐 Admin đăng nhập'],
  admin_balance: ['💰 Admin cộng / trừ tiền khách'],
  deposit_approve: ['💰 Admin duyệt nạp tiền bằng tay'],
  admin_refund: ['↩️ Admin hoàn tiền đơn hàng'],
  user_reset_password: ['🔑 Admin đặt lại mật khẩu của khách'],
  user_ban: ['🚫 Admin khóa tài khoản khách'],
  settings_bank_update: ['⚙️ Đổi cài đặt ngân hàng / nạp tiền'],
  settings_email_update: ['⚙️ Đổi cài đặt email & bảo mật'],
  backup_settings: ['⚙️ Đổi cài đặt Telegram / mật khẩu sao lưu'],
  cloudflare_api: ['⚙️ Đổi kết nối Cloudflare'],
  restore_start: ['♻️ Bắt đầu khôi phục dữ liệu'],
  restore_done: ['♻️ Đã khôi phục dữ liệu'],
  orders_export: ['📤 Tải danh sách đơn hàng (CSV)'],
  backup_download: ['📤 Tải bản sao lưu về máy'],
  backup_package: ['📦 Tạo gói sao lưu'],
  backup_delete: ['🗑 Xóa bản sao lưu'],
  ip_unblock: ['🔓 Gỡ khóa IP'],
  change_password: ['🔑 Admin đổi mật khẩu', 'admin'],
  devices_cleared: ['📱 Admin xóa toàn bộ thiết bị tin cậy', 'admin'],
  account_locked: ['🚨 Tài khoản admin bị tạm khóa do nhập sai mật khẩu nhiều lần', 'admin'],
  admin_ip_denied: ['🚨 Có người vào trang admin từ IP không được phép'],
};
// Xem tài khoản / mật khẩu game của khách cày thuê: chỉ báo khi xem dồn dập
const BURST = { boost_login_view: { n: 10, sec: 600, text: '👀 Admin xem tài khoản game của khách cày thuê rất nhiều lần' } };

const sent = new Map(); // chống gửi trùng: key -> lúc gửi
const burst = new Map(); // action:user -> [thời điểm]
const userStmt = db.prepare('SELECT username, role FROM users WHERE id = ?');

function onActivity(userId, action, detail, ip) {
  if (!RULES[action] && !BURST[action]) return;
  const s = getSettings();
  if (s.alert_admin === '0' || !s.tg_chat_id || !s.tg_token_enc) return;
  const u = userId ? userStmt.get(userId) : null;
  const now = Date.now();
  let text;
  if (BURST[action]) {
    const b = BURST[action]; const k = action + ':' + userId;
    const arr = (burst.get(k) || []).filter((t) => now - t < b.sec * 1000);
    arr.push(now); burst.set(k, arr);
    if (arr.length < b.n) return;
    burst.set(k, []);
    text = `${b.text} (${b.n} lần / ${Math.round(b.sec / 60)} phút)`;
  } else {
    const [label, role] = RULES[action];
    if (role === 'admin' && u?.role !== 'admin') return;
    text = label;
  }
  const key = action + '|' + userId + '|' + (detail || '');
  if (now - (sent.get(key) || 0) < 60000) return; // cùng 1 việc trong 1 phút chỉ báo 1 lần
  sent.set(key, now);
  if (sent.size > 5000) sent.clear();
  const host = String(require('../config').baseUrl).replace(/^https?:\/\//, '');
  const lines = [`${text}`, `Tài khoản: ${u ? u.username : '—'}`, `IP: ${ip || '—'}`];
  if (detail) lines.push(`Chi tiết: ${String(detail).slice(0, 300)}`);
  lines.push(`Lúc: ${require('../utils/helpers').fmtDate(Math.floor(now / 1000))}`);
  require('./backup').notifyAdmin(`🛡 ${host}\n${lines.join('\n')}`).catch(() => {});
}

// ---------- Đối chiếu tiền hằng đêm ----------
/**
 * Số dư hiện tại của từng khách phải bằng số dư sau giao dịch cuối cùng trong biến động số dư (balance_logs).
 * Lệch -> có ai sửa thẳng database hoặc có lỗi cộng / trừ tiền. -> { checked, mismatches: [...] }
 */
function reconcile() {
  const rows = db.prepare(`SELECT u.id, u.username, u.balance,
      (SELECT l.balance_after FROM balance_logs l WHERE l.user_id = u.id ORDER BY l.id DESC LIMIT 1) AS last_after,
      EXISTS(SELECT 1 FROM balance_logs l WHERE l.user_id = u.id) AS n
    FROM users u`).all();
  const mismatches = [];
  let checked = 0;
  for (const r of rows) {
    if (!r.n) continue; // chưa có / đã dọn hết lịch sử (quá số ngày giữ) -> không có gì để đối chiếu
    checked++;
    if (r.balance !== r.last_after) mismatches.push({ id: r.id, username: r.username, balance: r.balance, expected: r.last_after });
  }
  return { checked, mismatches };
}

function reconcileAndReport() {
  const r = reconcile();
  const s = getSettings();
  if (!r.mismatches.length || s.alert_admin === '0') return r;
  const money = (n) => Number(n).toLocaleString('vi-VN') + 'đ';
  const host = String(require('../config').baseUrl).replace(/^https?:\/\//, '');
  const list = r.mismatches.slice(0, 15).map((m) => `• ${m.username}: số dư ${money(m.balance)}, theo lịch sử ${money(m.expected)} (lệch ${money(m.balance - m.expected)})`);
  if (r.mismatches.length > 15) list.push(`… và ${r.mismatches.length - 15} tài khoản khác`);
  require('./backup').notifyAdmin(`🚨 ${host}\nĐối chiếu tiền: ${r.mismatches.length} tài khoản có số dư không khớp lịch sử giao dịch\n${list.join('\n')}`).catch(() => {});
  return r;
}

module.exports = { onActivity, reconcile, reconcileAndReport, RULES };
