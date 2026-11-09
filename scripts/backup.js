'use strict';
// Backup DB thủ công (có thể đặt cron hệ thống): npm run backup
const maintenance = require('../src/services/maintenance');
maintenance.backup().then((name) => { console.log('Đã backup:', name); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
