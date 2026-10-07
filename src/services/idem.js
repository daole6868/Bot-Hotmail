'use strict';
// Chống trừ tiền 2 lần khi yêu cầu bị gửi lại (mất phản hồi, mạng chập chờn, trình duyệt "gửi lại biểu mẫu").
// Mỗi form mua có 1 mã ngẫu nhiên; mã được ghi CÙNG transaction với trừ tiền + tạo đơn.
// Gặp lại mã cũ -> trả về đơn đã tạo, không trừ tiền lần nữa.
const crypto = require('crypto');
const { db } = require('../db');

const KEEP_SEC = 86400; // giữ mã 1 ngày
const clean = (k) => (/^[A-Za-z0-9_-]{16,64}$/.test(String(k || '')) ? String(k) : '');
const newKey = () => crypto.randomBytes(16).toString('base64url');

const getStmt = db.prepare('SELECT kind, ref FROM idem_keys WHERE user_id = ? AND k = ?');
const putStmt = db.prepare('INSERT INTO idem_keys(user_id, k, kind, ref) VALUES(?,?,?,?)');

/** Gọi BÊN TRONG transaction mua: mã đã dùng -> {kind, ref} của đơn cũ */
const seen = (userId, k) => (k ? getStmt.get(userId, k) || null : null);
/** Gọi BÊN TRONG transaction mua, sau khi tạo đơn */
const save = (userId, k, kind, ref) => { if (k) putStmt.run(userId, k, kind, String(ref)); };
const purge = () => db.prepare('DELETE FROM idem_keys WHERE created_at < ?').run(Math.floor(Date.now() / 1000) - KEEP_SEC).changes;

module.exports = { clean, newKey, seen, save, purge };
