// PM2: giữ web luôn chạy, tự khởi động lại khi lỗi / khi reboot VPS
module.exports = {
  apps: [{
    name: 'gachaz',
    script: 'server.js',
    cwd: __dirname + '/..',
    instances: 2, // cluster 2 bản (VPS 2 nhân); dùng chung 1 file SQLite ở chế độ WAL, chỉ bản 0 chạy dọn dẹp/backup
    exec_mode: 'cluster',
    autorestart: true,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
  }],
};
