// PM2: giữ web luôn chạy, tự khởi động lại khi lỗi / khi reboot VPS
const fs = require('fs');
const path = require('path');

// Web chạy bằng tài khoản riêng (không phải root) khi thư mục data/ thuộc tài khoản đó (deploy/harden-vps.sh tạo):
// lỡ có lỗ hổng thì kẻ xấu cũng không chiếm được cả VPS. Lệnh quản lý (pm2 restart gachaz) vẫn chạy bằng root như cũ.
let owner = {};
try {
  const data = path.join(__dirname, '..', 'data');
  const st = fs.statSync(data);
  // nhật ký PM2 để trong data/logs (tài khoản riêng không ghi được vào /root/.pm2)
  if (st.uid !== 0) owner = { uid: st.uid, gid: st.gid, out_file: path.join(data, 'logs', 'out.log'), error_file: path.join(data, 'logs', 'error.log') };
} catch { /* chưa có thư mục data: chạy như cũ */ }

module.exports = {
  apps: [{
    name: 'gachaz',
    script: 'server.js',
    cwd: path.join(__dirname, '..'),
    instances: 2, // cluster 2 bản (VPS 2 nhân); dùng chung 1 file SQLite ở chế độ WAL, chỉ bản 0 chạy dọn dẹp/backup
    exec_mode: 'cluster',
    autorestart: true,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
    ...owner,
  }],
};
