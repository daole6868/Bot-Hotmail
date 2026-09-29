'use strict';
// Lưu session vào SQLite (không mất khi restart, không phình RAM như MemoryStore)
const session = require('express-session');
const { db } = require('./db');

class SQLiteStore extends session.Store {
  constructor() {
    super();
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare(`INSERT INTO sessions(sid, sess, expires) VALUES(?,?,?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`);
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.touched = new Map();
  }

  expiresOf(sess) {
    const maxAge = sess?.cookie?.maxAge || 86400000;
    return Date.now() + maxAge;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiresOf(sess));
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }

  // Gia hạn phiên: ghi DB tối đa 10 phút/lần cho mỗi phiên thay vì mỗi request (giảm ghi DB rất nhiều khi đông khách)
  touch(sid, sess, cb) {
    try {
      const now = Date.now();
      if (now - (this.touched.get(sid) || 0) > 10 * 60 * 1000) {
        this.touchStmt.run(this.expiresOf(sess), sid);
        if (this.touched.size > 50000) this.touched.clear();
        this.touched.set(sid, now);
      }
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }

  // Dùng được cả khi không có instance: SQLiteStore.destroyUser(id)
  static destroyUser(userId, exceptSid = null) {
    db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid != ?`).run(userId, exceptSid || '');
  }

  destroyUser(userId) {
    // Đăng xuất mọi phiên của 1 user (khi bị khóa / đổi mật khẩu)
    db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(userId);
  }

  static cleanup() {
    return db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()).changes;
  }
}

module.exports = SQLiteStore;
