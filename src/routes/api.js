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
const { logActivity } = require('../db');
const { limiters } = require('../middleware/security');
const { processBankTransactions } = require('../services/deposit');
const { safeEqual, decrypt } = require('../utils/crypto');
const { getSettings } = require('../db');
const { clientIp } = require('../utils/helpers');

const router = express.Router();

function extractToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^(?:Apikey|Bearer|Token)\s+(.+)$/i);
  return (m && m[1]) || req.get('x-api-key') || req.get('secure-token') || '';
}

function validSignature(req) {
  const sig = String(req.get('x-webhook-signature') || '').trim().toLowerCase();
  const enc = getSettings().webhook_secret_enc;
  if (!sig || !enc || !req.rawBody) return false;
  const secret = decrypt(enc);
  return !!secret && safeEqual(sig, crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex'));
}

const keepRaw = express.json({ limit: '200kb', verify: (req, res, buf) => { req.rawBody = buf; } });
router.post('/bank/webhook', limiters.webhook, keepRaw, (req, res) => {
  const tokenOk = config.bankWebhookToken && safeEqual(extractToken(req), config.bankWebhookToken);
  if (!tokenOk && !validSignature(req)) {
    logActivity(null, 'webhook_unauthorized', null, clientIp(req));
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
