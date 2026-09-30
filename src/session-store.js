'use strict';
// Lưu session vào SQLite (không mất khi restart, không phình RAM như MemoryStore)
const session = require('express-session');
const { db } = require('./db');

// Phiên của khách CHƯA đăng nhập (chỉ để giữ mã captcha, thông báo, bước nhập mã 6 số) chỉ sống 1 giờ;
// đăng nhập xong thì phiên mới sống theo thời hạn bình thường (7 ngày / 30 ngày nếu ghi nhớ / 8 giờ với admin)
const GUEST_TTL = 60 * 60 * 1000;
let migrated = false;

class SQLiteStore extends session.Store {
  constructor() {
    super();
    if (!migrated) {
      migrated = true; // phiên khách cũ (trước khi có quy tắc 1 giờ) -> rút hạn còn tối đa 1 giờ
      db.prepare("UPDATE sessions SET expires = MIN(expires, ?) WHERE json_extract(sess, '$.userId') IS NULL").run(Date.now() + GUEST_TTL);
    }
    this.getStmt = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare(`INSERT INTO sessions(sid, sess, expires) VALUES(?,?,?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`);
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.touched = new Map();
  }

  expiresOf(sess) {
    const maxAge = sess?.userId ? (sess?.cookie?.maxAge || 86400000) : GUEST_TTL;
    return Date.now() + maxAge;
  }

  /** Số phiên còn hạn: đã đăng nhập / khách tạm thời */
  static stats() {
    return db.prepare(`SELECT SUM(json_extract(sess, '$.userId') IS NOT NULL) logged, SUM(json_extract(sess, '$.userId') IS NULL) guest
      FROM sessions WHERE expires > ?`).get(Date.now());
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
