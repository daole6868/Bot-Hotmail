'use strict';
/**
 * Webhook ngân hàng: cổng trung gian (SePay, Casso, hoặc script tự viết) gọi vào đây
 * mỗi khi tài khoản nhận tiền. Hệ thống tự đọc nội dung CK (VD: NAPAB12CD) để cộng tiền.
 *
 *  POST /api/bank/webhook
 *  Xác thực 1 trong 2 cách:
 *   - Header: Authorization: Apikey <BANK_WEBHOOK_TOKEN>   (hoặc Bearer / X-Api-Key / secure-token) — SePay, Casso
 *   - Header: X-Webhook-Signature = HMAC-SHA256(body gốc, Secret Key trong Cài đặt bank) — NIFY
 */
const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { db, logActivity, getSettings } = require('../db');
const { limiters } = require('../middleware/security');
const { processBankTransactions } = require('../services/deposit');
const { safeEqual, decrypt } = require('../utils/crypto');
const { clientIp } = require('../utils/helpers');

const router = express.Router();

function extractToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^(?:Apikey|Bearer|Token)\s+(.+)$/i);
  return (m && m[1]) || req.get('x-api-key') || req.get('secure-token') || '';
}

// Đọc thẳng từ DB (không qua cache 30s): chạy nhiều bản PM2 thì cache của bản khác có thể còn key cũ
const secretStmt = db.prepare("SELECT value FROM settings WHERE key = 'webhook_secret_enc'");
const webhookSecret = () => { const r = secretStmt.get(); return r && r.value ? decrypt(r.value) : ''; };

/** -> '' nếu hợp lệ, ngược lại là lý do (ghi log để admin tra) */
function checkSignature(req, secret) {
  if (!secret) return 'chưa có Secret Key';
  // Cách phụ: ?key=<Secret Key> trên URL (cổng thanh toán không hỗ trợ ký)
  if (req.query.key && safeEqual(String(req.query.key), secret)) return '';
  let sig = String(req.get('x-webhook-signature') || req.get('x-signature') || '').trim();
  if (!sig) return 'thiếu header X-Webhook-Signature';
  sig = sig.replace(/^sha256=/i, '');
  const mac = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest();
  if (safeEqual(sig.toLowerCase(), mac.toString('hex')) || safeEqual(sig, mac.toString('base64'))) return '';
  return `chữ ký không khớp (nhận ${sig.slice(0, 8)}…, dài ${sig.length})`;
}

const keepRaw = express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } });
router.post('/bank/webhook', limiters.webhook, keepRaw, (req, res) => {
  const tokenOk = config.bankWebhookToken && safeEqual(extractToken(req), config.bankWebhookToken);
  const why = tokenOk ? '' : checkSignature(req, webhookSecret());
  if (!why && !tokenOk && getSettings().nify_enabled === '0') {
    // NIFY đang tắt trong Cài đặt bank: vẫn trả 200 để NIFY không gửi lại mãi, nhưng không xử lý
    return res.json({ success: true, status: 'success', message: 'NIFY đang tắt trên web', results: [] });
  }
  if (why) {
    logActivity(null, 'webhook_unauthorized', why, clientIp(req));
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const results = processBankTransactions(req.body);
    res.json({ success: true, status: 'success', message: `Received ${results.length} transactions`, results });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).json({ success: false });
  }
});

router.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

module.exports = router;
