'use strict';
/**
 * Lấy dữ liệu HoYoLAB từ form sản phẩm (admin / quản lý / CTV bán hàng) — gắn ở /admin/hoyo.
 *  POST /admin/hoyo/jobs            {game, server, username, password} -> {ok, id}
 *  GET  /admin/hoyo/jobs/:id        -> trạng thái + kết quả (chi tiết tài khoản)
 *  POST /admin/hoyo/jobs/:id/cancel
 */
const express = require('express');
const { db, logActivity } = require('../db');
const hoyo = require('../services/hoyo');
const { clientIp } = require('../utils/helpers');

const router = express.Router();
const all = (req) => req.perm === 'admin' || req.perm === 'manager';
const jid = (req) => parseInt(req.params.id, 10) || 0;

router.post('/jobs', (req, res) => {
  const r = hoyo.createJob(req.user.id, req.body || {});
  if (r.ok) logActivity(req.user.id, 'hoyo_job_create', `#${r.id} ${req.body.game}`, clientIp(req));
  res.json(r);
});
router.get('/jobs/:id', (req, res) => {
  const j = hoyo.jobFor(jid(req), req.user.id, all(req));
  res.json(j ? { ok: true, job: j } : { ok: false, message: 'Không tìm thấy' });
});
// Danh sách nhân vật / vũ khí đã nạp ở Quản lý ảnh (chọn thủ công trong form sản phẩm)
// i = ảnh gốc (lưu vào chi tiết acc), t = ảnh nhỏ 72px để hiện trong danh sách chọn
router.get('/lib/:game', (req, res) => {
  const game = hoyo.GAMES[req.params.game] ? req.params.game : '';
  if (!game) return res.json({ ok: false });
  const thumbs = require('../utils/thumbs');
  const rows = db.prepare('SELECT kind, name, icon, rarity FROM hoyo_assets WHERE game = ? ORDER BY rarity DESC, name').all(game);
  const pick = (k) => rows.filter((r) => r.kind === k).map((r) => ({ n: r.name, i: r.icon, t: thumbs.thumbOf(r.icon), r: r.rarity }));
  res.set('Cache-Control', 'private, max-age=60');
  res.json({ ok: true, c: pick('char'), w: pick('weapon') });
});
router.post('/jobs/:id/cancel', (req, res) => res.json({ ok: hoyo.cancel(jid(req), req.user.id, all(req)) }));

module.exports = router;
