'use strict';
// Đặt lại mật khẩu admin: npm run reset-admin -- MatKhauMoi123 [username]
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const config = require('../src/config');

const pw = process.argv[2];
const username = process.argv[3] || config.admin.username;
if (!pw || pw.length < 8) {
  console.error('Cách dùng: npm run reset-admin -- <mật_khẩu_mới ≥ 8 ký tự> [username]');
  process.exit(1);
}
const u = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
if (u) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'admin', status = 'active', failed_logins = 0, locked_until = NULL WHERE id = ?")
    .run(bcrypt.hashSync(pw, 12), u.id);
  db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(u.id);
  console.log(`Đã đặt lại mật khẩu cho admin "${username}".`);
} else {
  db.prepare("INSERT INTO users(username, email, password_hash, role) VALUES(?, NULL, ?, 'admin')").run(username, bcrypt.hashSync(pw, 12));
  console.log(`Đã tạo admin mới "${username}".`);
}
