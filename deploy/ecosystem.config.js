// PM2: giữ web luôn chạy, tự khởi động lại khi lỗi / khi reboot VPS
module.exports = {
  apps: [{
    name: 'gachaz',
    script: 'server.js',
    cwd: __dirname + '/..',
    instances: 1, // SQLite: chỉ chạy 1 tiến trình
    autorestart: true,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
  }],
};
