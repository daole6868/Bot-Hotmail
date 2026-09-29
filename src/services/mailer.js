'use strict';
/**
 * Gửi email qua SMTP (cấu hình ở Admin > Email & Bảo mật). Mật khẩu SMTP lưu mã hóa bằng APP_KEY.
 * Mọi email đều ghi vào email_logs (đã gửi / lỗi) để admin tra cứu.
 */
const nodemailer = require('nodemailer');
const { db, getSettings } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const config = require('../config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function smtpConfig(s = getSettings()) {
  return {
    host: (s.smtp_host || '').trim(),
    port: parseInt(s.smtp_port, 10) || 587,
    secure: s.smtp_secure || 'tls',
    user: (s.smtp_user || '').trim(),
    pass: s.smtp_pass_enc ? decrypt(s.smtp_pass_enc) : '',
    fromName: (s.mail_from_name || s.site_name || 'Shop').trim(),
    fromEmail: (s.mail_from_email || s.smtp_user || '').trim(),
  };
}
/** Đã cấu hình đủ để gửi email chưa (chưa cấu hình -> tự bỏ qua xác minh 2 lớp để không khóa ai ngoài) */
const isReady = (s) => { const c = smtpConfig(s); return !!(c.host && c.fromEmail); };
const encryptPass = (p) => encrypt(p);

let cache = { key: '', t: null };
function transporter() {
  const c = smtpConfig();
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass]);
  if (cache.key !== key) {
    cache = { key, t: nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure === 'ssl', requireTLS: c.secure === 'tls',
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
    }) };
  }
  return { t: cache.t, c };
}

// ---------- Khung email chung ----------
function layout({ title, intro, body = '', button, note }) {
  const s = getSettings();
  const site = esc(s.site_name || 'Shop');
  const logo = s.logo ? `<img src="${esc(config.baseUrl + s.logo)}" alt="${site}" style="max-height:44px;max-width:200px">` : `<b style="font-size:20px;color:#fff">${site}</b>`;
  return `<!doctype html><html><body style="margin:0;background:#f3f1fb;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e1a33">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1fb;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 18px rgba(40,30,90,.08)">
      <tr><td style="background:linear-gradient(135deg,#7c3aed,#db2777);padding:18px 24px">${logo}</td></tr>
      <tr><td style="padding:26px 24px 8px">
        <h1 style="margin:0 0 10px;font-size:20px;line-height:1.35">${esc(title)}</h1>
        ${intro ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#4a4566">${intro}</p>` : ''}
        ${body}
        ${button ? `<p style="margin:22px 0"><a href="${esc(button.url)}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${esc(button.text)}</a></p>` : ''}
        ${note ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#7a7596">${note}</p>` : ''}
      </td></tr>
      <tr><td style="padding:18px 24px 22px;font-size:12px;color:#9a95b5;border-top:1px solid #eee">Email tự động từ <a href="${esc(config.baseUrl)}" style="color:#7c3aed">${site}</a>. Vui lòng không trả lời email này.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}
const row = (k, v) => `<tr><td style="padding:8px 0;color:#7a7596;font-size:14px">${esc(k)}</td><td style="padding:8px 0;font-weight:700;font-size:14px;text-align:right">${v}</td></tr>`;
const table = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin:6px 0 4px">${rows.join('')}</table>`;
const money = (n) => (Number(n) || 0).toLocaleString('vi-VN') + 'đ';
const fmt = (ts) => require('../utils/helpers').fmtDate(ts);

// ---------- Các mẫu email ----------
const TEMPLATES = {
  otp: (d) => ({
    subject: `${d.code} là mã xác minh của bạn`,
    html: layout({
      title: d.purpose === 'register' ? 'Xác minh đăng ký tài khoản' : d.purpose === 'email' ? 'Xác minh địa chỉ email' : 'Mã xác minh đăng nhập',
      intro: d.purpose === 'register' ? `Xin chào <b>${esc(d.username)}</b>, nhập mã dưới đây để hoàn tất đăng ký tài khoản.`
        : d.purpose === 'email' ? `Xin chào <b>${esc(d.username)}</b>, nhập mã dưới đây để xác minh email này cho tài khoản của bạn.`
        : `Xin chào <b>${esc(d.username)}</b>, có yêu cầu đăng nhập tài khoản của bạn${d.ip ? ` từ IP <b>${esc(d.ip)}</b>` : ''}. Nhập mã dưới đây để tiếp tục.`,
      body: `<div style="font-size:34px;font-weight:800;letter-spacing:10px;text-align:center;background:#f5f0ff;border:1px dashed #c4b5fd;border-radius:12px;padding:16px;color:#5b21b6">${esc(d.code)}</div>`,
      note: `Mã có hiệu lực <b>10 phút</b> và chỉ dùng được 1 lần. <b>Không chia sẻ mã này cho bất kỳ ai</b>, kể cả người tự xưng là nhân viên shop. Nếu không phải bạn, hãy đổi mật khẩu ngay.`,
    }),
  }),
  reset: (d) => ({
    subject: 'Đặt lại mật khẩu tài khoản',
    html: layout({
      title: 'Đặt lại mật khẩu',
      intro: `Xin chào <b>${esc(d.username)}</b>, chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.`,
      button: { text: 'Đặt mật khẩu mới', url: d.url },
      note: `Link có hiệu lực <b>30 phút</b> và chỉ dùng được 1 lần. Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu hiện tại vẫn giữ nguyên.<br>Không bấm được nút? Sao chép link: <span style="word-break:break-all">${esc(d.url)}</span>`,
    }),
  }),
  password_changed: (d) => ({
    subject: 'Mật khẩu tài khoản vừa được thay đổi',
    html: layout({
      title: 'Mật khẩu đã được thay đổi',
      intro: `Xin chào <b>${esc(d.username)}</b>, mật khẩu tài khoản của bạn vừa được ${d.byReset ? 'đặt lại qua email' : 'thay đổi'} lúc <b>${esc(fmt(d.at))}</b>${d.ip ? ` từ IP <b>${esc(d.ip)}</b>` : ''}.`,
      note: 'Các thiết bị khác đã bị đăng xuất. Nếu không phải bạn thực hiện, hãy dùng chức năng <b>Quên mật khẩu</b> ngay và liên hệ shop.',
      button: { text: 'Đăng nhập', url: config.baseUrl + '/login' },
    }),
  }),
  login_alert: (d) => ({
    subject: 'Đăng nhập từ thiết bị mới',
    html: layout({
      title: 'Tài khoản vừa đăng nhập trên thiết bị mới',
      intro: `Xin chào <b>${esc(d.username)}</b>, tài khoản của bạn vừa được đăng nhập và xác minh thành công.`,
      body: table([row('Thời gian', esc(fmt(d.at))), row('IP', esc(d.ip || '—')), row('Thiết bị', esc((d.ua || '—').slice(0, 80)))]),
      note: 'Nếu không phải bạn, hãy đổi mật khẩu ngay và xóa thiết bị lạ ở mục <b>Tài khoản → Bảo mật</b>.',
    }),
  }),
  welcome: (d) => ({
    subject: `Chào mừng bạn đến với ${getSettings().site_name || 'shop'}`,
    html: layout({
      title: `Chào mừng ${d.username}!`,
      intro: 'Tài khoản của bạn đã được tạo thành công. Nạp tiền và chọn acc ưng ý, hệ thống giao acc tự động ngay sau khi thanh toán.',
      button: { text: 'Vào shop ngay', url: config.baseUrl },
      note: 'Mẹo bảo mật: bật <b>xác minh 2 lớp</b> ở mục Tài khoản → Bảo mật để tài khoản an toàn hơn.',
    }),
  }),
  order: (d) => ({
    subject: `Mua thành công đơn ${d.code}`,
    html: layout({
      title: 'Mua hàng thành công 🎉',
      intro: `Xin chào <b>${esc(d.username)}</b>, cảm ơn bạn đã mua hàng.`,
      body: table([row('Mã đơn', esc(d.code)), row('Sản phẩm', esc(d.title)), ...(d.discount ? [row('Giảm giá', '-' + money(d.discount))] : []), row('Thanh toán', `<span style="color:#db2777">${money(d.total)}</span>`), row('Thời gian', esc(fmt(d.at)))]),
      button: { text: 'Xem thông tin tài khoản đã mua', url: `${config.baseUrl}/user/orders/${d.code}` },
      note: 'Vì lý do bảo mật, thông tin đăng nhập acc chỉ hiển thị trên web sau khi bạn đăng nhập. Hãy đổi mật khẩu acc sau khi nhận.',
    }),
  }),
  deposit: (d) => ({
    subject: `Nạp tiền thành công +${money(d.amount)}`,
    html: layout({
      title: 'Nạp tiền thành công',
      intro: `Xin chào <b>${esc(d.username)}</b>, tài khoản của bạn vừa được cộng tiền.`,
      body: table([row('Mã nạp', esc(d.code)), row('Số tiền', `<span style="color:#16a34a">+${money(d.amount)}</span>`), row('Số dư hiện tại', money(d.balance))]),
      button: { text: 'Mua acc ngay', url: config.baseUrl },
    }),
  }),
  test: () => ({
    subject: 'Email thử nghiệm',
    html: layout({ title: 'Cấu hình email hoạt động tốt ✅', intro: 'Nếu bạn nhận được email này, shop đã có thể gửi mã xác minh, link đặt lại mật khẩu và các thông báo cho khách.' }),
  }),
};

// Loại email thông báo có thể tắt trong admin (mã xác minh / đặt lại mật khẩu luôn gửi)
const TOGGLE = { welcome: 'mail_on_welcome', order: 'mail_on_order', deposit: 'mail_on_deposit', password_changed: 'mail_on_password', login_alert: 'mail_on_login_alert' };

/** Gửi và chờ kết quả -> { ok, error } */
async function send(to, type, data = {}) {
  const s = getSettings();
  if (!to) return { ok: false, error: 'Không có email' };
  if (!isReady(s)) return { ok: false, error: 'Chưa cấu hình SMTP' };
  if (TOGGLE[type] && s[TOGGLE[type]] === '0') return { ok: false, error: 'Loại email này đang tắt', skipped: true };
  const { subject, html } = TEMPLATES[type](data);
  const logId = db.prepare('INSERT INTO email_logs(to_email, subject, type) VALUES(?,?,?)').run(to, subject, type).lastInsertRowid;
  try {
    const { t, c } = transporter();
    const msg = { from: { name: c.fromName, address: c.fromEmail }, to, subject, html,
      text: html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
    // Lỗi mạng thoáng qua -> thử lại 1 lần sau 1,5 giây
    try { await t.sendMail(msg); } catch (e) {
      if (!/ECONN|ETIMEDOUT|closed|socket|EAI_AGAIN/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1500));
      await t.sendMail(msg);
    }
    db.prepare("UPDATE email_logs SET status = 'sent' WHERE id = ?").run(logId);
    return { ok: true };
  } catch (e) {
    db.prepare("UPDATE email_logs SET status = 'failed', error = ? WHERE id = ?").run(String(e.message).slice(0, 300), logId);
    console.error('[mail]', type, to, e.message);
    return { ok: false, error: e.message };
  }
}
/** Gửi nền, không làm chậm trang (thông báo mua hàng, nạp tiền...) */
function sendLater(to, type, data) {
  if (!to) return;
  setImmediate(() => { send(to, type, data).catch(() => {}); });
}

module.exports = { send, sendLater, isReady, smtpConfig, encryptPass };
