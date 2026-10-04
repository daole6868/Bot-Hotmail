'use strict';
/**
 * Admin -> Kết nối API: nơi duy nhất nhập API key / token của dịch vụ bên ngoài (Telegram, các AI).
 * Các trang khác (Bảo trì dữ liệu, AI viết bài, Chat...) chỉ bật / tắt và chọn dùng kết nối nào.
 * Gắn vào /admin/api (đã qua requireAdmin + CSRF của router admin).
 */
const express = require('express');
const { getSettings, setSetting, logActivity } = require('../db');
const { encrypt } = require('../utils/crypto');
const H = require('../utils/helpers');
const ai = require('../services/ai');
const hoyo = require('../services/hoyo');
const { sha256, randomToken } = require('../utils/crypto');

const router = express.Router();
const { str, clientIp } = H;
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const back = (req, res, type, msg, hash = '') => { req.flash(type, msg); res.redirect('/admin/api' + hash); };

router.get('/', (req, res) => {
  const s = getSettings();
  res.render('admin/api', {
    title: 'Kết nối API', s, PROVIDERS: ai.PROVIDERS, st: ai.status(s),
    ready: Object.fromEntries(Object.keys(ai.PROVIDERS).map((p) => [p, ai.status(s, p).ready])),
    tg: { hasToken: !!s.tg_token_enc, chat: s.tg_chat_id || '', listen: s.chat_tg_status || '' },
    hoyo: { cfg: hoyo.cfg(s), hasToken: hoyo.hasToken(), workers: hoyo.workers(), newToken: req.session.hoyoToken || '' },
  });
  delete req.session.hoyoToken; // mã worker mới chỉ hiện 1 lần
});

// ---------- HoYoLAB worker ----------
router.post('/hoyo', (req, res) => {
  const b = req.body;
  const n = (v, d, min, max) => { const x = parseInt(v, 10); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d; };
  setSetting('hoyo_cfg', JSON.stringify({
    captcha_sec: n(b.captcha_sec, hoyo.DEFAULTS.captcha_sec, 20, 600),
    job_min: n(b.job_min, hoyo.DEFAULTS.job_min, 2, 30),
    wait_sec: n(b.wait_sec, hoyo.DEFAULTS.wait_sec, 20, 900),
  }));
  audit(req, 'api_hoyo', 'cài đặt worker');
  back(req, res, 'success', 'Đã lưu cài đặt HoYoLAB worker', '#hoyo');
});
router.post('/hoyo/token', (req, res) => {
  if (req.body.clear) { setSetting('hoyo_token_hash', ''); audit(req, 'api_hoyo', 'thu hồi mã worker'); return back(req, res, 'success', 'Đã thu hồi mã worker. Worker cũ không kết nối được nữa.', '#hoyo'); }
  const token = 'hyw_' + randomToken(24);
  setSetting('hoyo_token_hash', sha256(token));
  req.session.hoyoToken = token;
  audit(req, 'api_hoyo', 'tạo mã worker mới');
  back(req, res, 'success', 'Đã tạo mã worker mới. Sao chép ngay, mã chỉ hiện 1 lần.', '#hoyo');
});

// ---------- Telegram ----------
router.post('/telegram', (req, res) => {
  const token = String(req.body.tg_token || '').trim();
  if (token) {
    if (!/^\d{5,15}:[\w-]{20,60}$/.test(token)) return back(req, res, 'error', 'Bot token không đúng dạng (VD: 123456789:AAF...)', '#telegram');
    setSetting('tg_token_enc', encrypt(token));
  }
  if (req.body.tg_clear) setSetting('tg_token_enc', '');
  const chat = String(req.body.tg_chat_id || '').trim();
  if (chat && !/^-?\d{3,20}$/.test(chat)) return back(req, res, 'error', 'Chat ID phải là số (VD: 123456789 hoặc -100123...)', '#telegram');
  setSetting('tg_chat_id', chat);
  audit(req, 'api_telegram', token ? 'đổi token' : req.body.tg_clear ? 'xóa token' : 'chat id');
  back(req, res, 'success', 'Đã lưu kết nối Telegram', '#telegram');
});
router.post('/telegram/test', async (req, res) => {
  const s = getSettings();
  let token = ''; try { token = s.tg_token_enc ? require('../utils/crypto').decrypt(s.tg_token_enc) : ''; } catch { token = ''; }
  if (!token || !s.tg_chat_id) return res.json({ ok: false, message: 'Chưa nhập Bot token hoặc Chat ID' });
  try {
    const r = await fetch(`${process.env.TG_API_URL || 'https://api.telegram.org'}/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ chat_id: s.tg_chat_id, text: `✅ Kết nối Telegram thành công — ${s.site_name || 'shop'}` }),
    });
    const j = await r.json().catch(() => ({}));
    res.json(j.ok ? { ok: true, message: 'Đã gửi tin thử, kiểm tra Telegram của bạn' } : { ok: false, message: 'Telegram báo: ' + (j.description || 'lỗi không rõ') + '. Kiểm tra token, Chat ID và đã nhắn /start cho bot chưa.' });
  } catch (e) { res.json({ ok: false, message: 'Không kết nối được Telegram' }); }
});

// ---------- AI ----------
router.post('/ai', (req, res) => {
  const b = req.body;
  for (const p of Object.keys(ai.PROVIDERS)) {
    if (b[`model_${p}`] !== undefined) setSetting(`ai_model_${p}`, str(b[`model_${p}`], 80));
    const k = String(b[`key_${p}`] || '').trim();
    if (k) setSetting(`ai_key_${p}_enc`, encrypt(k.slice(0, 300)));
    if (b[`clear_${p}`]) setSetting(`ai_key_${p}_enc`, '');
  }
  if (b.ai_custom_url !== undefined) {
    const u = str(b.ai_custom_url, 200).trim();
    if (u && !/^https:\/\//i.test(u)) return back(req, res, 'error', 'Địa chỉ API tùy chỉnh phải bắt đầu bằng https://', '#ai');
    setSetting('ai_custom_url', u);
  }
  if (b.ai_anthropic_workspace !== undefined) {
    const w = str(b.ai_anthropic_workspace, 100).trim();
    if (w && !/^[\w-]+$/.test(w)) return back(req, res, 'error', 'Workspace ID chỉ gồm chữ, số, dấu - và _', '#ai');
    setSetting('ai_anthropic_workspace', w);
  }
  audit(req, 'api_ai', 'cập nhật API key / model');
  back(req, res, 'success', 'Đã lưu kết nối AI', '#ai');
});

module.exports = router;
