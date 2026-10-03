'use strict';
/**
 * Quét giao dịch ngân hàng qua APICANHAN (web tự hỏi định kỳ, khác webhook NIFY là bên kia tự gửi về).
 *
 * - Chỉ hỏi khi đang có đơn nạp chờ, hoặc đơn vừa quá hạn trong "thời hạn mã QR + X%"; không có đơn -> không gọi gì.
 * - Mỗi lần gọi lấy giao dịch mới của CẢ tài khoản shop rồi khớp với mọi mã nạp -> 1 hay 5.000 khách đang nạp vẫn chỉ 1 lần gọi.
 * - Gặp "vui lòng chờ" / lỗi mạng -> tự giãn nhịp, không gọi dồn.
 * - Chạy song song với webhook NIFY: cùng 1 lần chuyển khoản chỉ được cộng 1 lần (xem deposit.processTxns).
 * - Chỉ bản PM2 số 0 chạy vòng quét (server.js), nút "Quét ngay" ở admin gọi pollOnce trực tiếp.
 */
const { db, getSettings, setSetting } = require('../db');
const { decrypt } = require('../utils/crypto');
const config = require('../config');

const API = process.env.ACN_API_URL || 'https://api.apicanhan.com/transactions';
const TIMEOUT_MS = 8000;
const nowS = () => Math.floor(Date.now() / 1000);
const int = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };

function conf(s = getSettings()) {
  return {
    on: s.acn_enabled === '1',
    key: s.acn_key_enc ? decrypt(s.acn_key_enc) : '',
    bank: ['ACBnew', 'MB'].includes(s.acn_bank) ? s.acn_bank : 'ACBnew',
    interval: int(s.acn_interval, 5, 3, 120),
    extraPct: int(s.acn_extra_pct, 20, 0, 300),
  };
}

// Khoảng thời gian cần quét = thời hạn mã QR + X%
function windowSec(c) {
  const exp = require('./maintenance').depositExpireMinutes() * 60;
  return Math.ceil(exp * (1 + c.extraPct / 100));
}
const activeStmt = db.prepare("SELECT 1 FROM deposits WHERE status IN ('pending','expired') AND created_at > ? LIMIT 1");
const hasActiveDeposits = (c) => !!activeStmt.get(nowS() - windowSec(c));

// "10:00:00 27/4/2026" (giờ Việt Nam) -> giây
function parseDate(v) {
  const m = String(v || '').match(/(\d{1,2}):(\d{2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? Math.floor(Date.UTC(+m[6], +m[5] - 1, +m[4], +m[1] - 7, +m[2], +m[3]) / 1000) : null;
}

// ---------- Trạng thái (lưu vào settings để trang admin ở bản PM2 nào cũng đọc được) ----------
let lastSaved = { msg: '', at: 0 };
function saveStatus(ok, msg, newCount) {
  if (msg === lastSaved.msg && !newCount && Date.now() - lastSaved.at < 60000) return;
  lastSaved = { msg, at: Date.now() };
  setSetting('acn_last_at', String(nowS()));
  setSetting('acn_last_ok', ok ? '1' : '0');
  setSetting('acn_last_msg', msg.slice(0, 200));
  if (newCount) setSetting('acn_last_new_at', String(nowS()));
}

let backoffUntil = 0;
let running = false;

/** Gọi API 1 lần. -> { ok, message, received, matched } */
async function pollOnce({ force = false } = {}) {
  const c = conf();
  if (!c.key) return { ok: false, message: 'Chưa nhập ApiKey' };
  if (!c.on && !force) return { ok: false, message: 'Đang tắt' };
  if (running) return { ok: false, message: 'Đang quét, thử lại sau vài giây' };
  running = true;
  try {
    const url = c.bank === 'MB' ? `${API}/MB/${encodeURIComponent(c.key)}/?version=3` : `${API}/${c.bank}/${encodeURIComponent(c.key)}`;
    let data;
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      data = await r.json();
    } catch (e) {
      backoffUntil = Date.now() + 15000;
      const msg = e.name === 'TimeoutError' ? 'APICANHAN không phản hồi (quá 8 giây)' : 'Lỗi kết nối tới APICANHAN';
      saveStatus(false, msg, 0);
      return { ok: false, message: msg };
    }
    if (!data || data.status !== 'success') {
      const m = String(data?.message || 'Phản hồi không hợp lệ');
      if (/chờ/i.test(m)) backoffUntil = Date.now() + 30000; // bị giới hạn tần suất -> nghỉ 30 giây
      else backoffUntil = Date.now() + 60000;
      saveStatus(false, 'APICANHAN báo: ' + m, 0);
      return { ok: false, message: 'APICANHAN báo: ' + m };
    }
    // Chỉ lấy tiền vào, có mã nạp trong nội dung, và thuộc khoảng thời gian đang quét (bỏ lịch sử cũ khi mới bật)
    const since = nowS() - windowSec(c) - 600;
    const prefix = config.depositPrefix;
    const list = [];
    for (const t of Array.isArray(data.transactions) ? data.transactions : []) {
      if (String(t.type || '').toUpperCase() !== 'IN') continue;
      const amount = parseInt(String(t.amount ?? '').replace(/\D/g, ''), 10);
      const content = String(t.description || '');
      if (!amount || amount <= 0 || t.transactionID == null) continue;
      if (!content.toUpperCase().replace(/[^0-9A-Z]/g, '').includes(prefix)) continue;
      const at = parseDate(t.transactionDate);
      if (at && at < since) continue;
      list.push({ txnId: 'acn:' + c.bank + ':' + t.transactionID, amount, content, at });
    }
    const results = list.length ? require('./deposit').processTxns(list, 'APICANHAN') : [];
    const fresh = results.filter((x) => x.status !== 'duplicate');
    const matched = results.filter((x) => x.status === 'matched').length;
    const msg = `OK · ${data.transactions?.length || 0} GD trả về · ${fresh.length} GD nạp mới${matched ? ` · cộng tiền ${matched} đơn` : ''}`;
    saveStatus(true, msg, fresh.length);
    return { ok: true, message: msg, received: fresh.length, matched };
  } catch (e) {
    console.error('[apicanhan]', e);
    saveStatus(false, 'Lỗi xử lý: ' + e.message, 0);
    return { ok: false, message: 'Lỗi xử lý: ' + e.message };
  } finally {
    running = false;
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  const tick = async () => {
    let next = 5000; // không có việc: 5 giây kiểm tra lại 1 lần (chỉ 1 truy vấn nhẹ)
    try {
      const c = conf();
      if (c.on && c.key && Date.now() >= backoffUntil && hasActiveDeposits(c)) {
        await pollOnce();
        next = c.interval * 1000;
      }
    } catch (e) { console.error('[apicanhan]', e); }
    setTimeout(tick, next).unref();
  };
  setTimeout(tick, 3000).unref();
}

module.exports = { start, pollOnce, conf, windowSec, parseDate };
