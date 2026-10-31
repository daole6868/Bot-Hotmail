'use strict';
/**
 * Cổng cho worker lấy dữ liệu HoYoLAB (tools/hoyolab-worker) — gắn ở /api/hoyo, trước session/CSRF.
 * Xác thực: header Authorization: Bearer <mã worker> (tạo ở Admin -> Kết nối API -> HoYoLAB worker).
 *  POST /api/hoyo/claim                 {worker, version}       -> {job: null | {id, game, server, username, password, captcha_sec, job_sec}}
 *  POST /api/hoyo/jobs/:id/progress     {worker, progress, message}
 *  POST /api/hoyo/jobs/:id/done         {worker, result}
 *  POST /api/hoyo/jobs/:id/fail         {worker, error}
 */
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { logActivity } = require('../db');
const hoyo = require('../services/hoyo');
const { clientIp } = require('../utils/helpers');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false });

let lastBad = 0;
function auth(req, res, next) {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m && hoyo.checkToken(m[1].trim())) return next();
  // Ghi log tối đa 1 lần / phút để log không bị ngập khi worker cấu hình sai
  if (Date.now() - lastBad > 60000) { lastBad = Date.now(); logActivity(null, 'hoyo_worker_unauthorized', 'sai mã worker', clientIp(req)); }
  res.status(401).json({ ok: false, message: 'Sai mã worker' });
}

const worker = (req) => String((req.body && req.body.worker) || 'worker').slice(0, 40);
const jid = (req) => parseInt(req.params.id, 10) || 0;

router.use(limiter, auth);
router.post('/claim', express.json({ limit: '10kb' }), (req, res) => {
  const job = hoyo.claim(worker(req), clientIp(req), req.body && req.body.version);
  if (job) logActivity(null, 'hoyo_job_claim', `#${job.id} ${job.game} -> ${worker(req)}`, clientIp(req));
  res.json({ ok: true, job });
});
router.post('/jobs/:id/progress', express.json({ limit: '10kb' }), (req, res) => {
  res.json({ ok: hoyo.progress(jid(req), worker(req), req.body.progress, req.body.message) });
});
router.post('/jobs/:id/fail', express.json({ limit: '20kb' }), (req, res) => {
  res.json({ ok: hoyo.fail(jid(req), worker(req), req.body.error) });
});
router.post('/jobs/:id/done', express.json({ limit: '3mb' }), (req, res) => {
  res.json({ ok: hoyo.done(jid(req), worker(req), req.body.result) });
});
router.use((err, req, res, next) => { // JSON hỏng / quá lớn
  if (err) return res.status(err.status || 400).json({ ok: false, message: err.type === 'entity.too.large' ? 'Dữ liệu quá lớn' : 'Dữ liệu không hợp lệ' });
  next();
});

module.exports = router;
