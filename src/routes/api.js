'use strict';
/**
 * Webhook ngân hàng: cổng trung gian (SePay, Casso, hoặc script tự viết) gọi vào đây
 * mỗi khi tài khoản nhận tiền. Hệ thống tự đọc nội dung CK (VD: NAPAB12CD) để cộng tiền.
 *
 *  POST /api/bank/webhook
 *  Header: Authorization: Apikey <BANK_WEBHOOK_TOKEN>   (hoặc Bearer / X-Api-Key / secure-token)
 */
const express = require('express');
const config = require('../config');
const { logActivity } = require('../db');
const { limiters } = require('../middleware/security');
const { processBankTransactions } = require('../services/deposit');
const { safeEqual } = require('../utils/crypto');
const { clientIp } = require('../utils/helpers');

const router = express.Router();

function extractToken(req) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^(?:Apikey|Bearer|Token)\s+(.+)$/i);
  return (m && m[1]) || req.get('x-api-key') || req.get('secure-token') || '';
}

router.post('/bank/webhook', limiters.webhook, express.json({ limit: '200kb' }), (req, res) => {
  if (!config.bankWebhookToken || !safeEqual(extractToken(req), config.bankWebhookToken)) {
    logActivity(null, 'webhook_unauthorized', null, clientIp(req));
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  try {
    const results = processBankTransactions(req.body);
    res.json({ success: true, results });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).json({ success: false });
  }
});

router.get('/health', (req, res) => res.json({ ok: true, time: Date.now() }));

module.exports = router;
