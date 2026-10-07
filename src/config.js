'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

const config = {
  isProd,
  port: int(env.PORT, 3000),
  baseUrl: env.BASE_URL || 'http://localhost:3000',
  trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
  // Chạy sau Nginx (TRUST_PROXY=true): chỉ nhận kết nối từ chính VPS -> không ai gọi thẳng IP:cổng để vượt Cloudflare / Nginx / giả IP
  host: env.HOST || (env.TRUST_PROXY === 'true' ? '127.0.0.1' : '0.0.0.0'),
  sessionSecret: env.SESSION_SECRET || 'dev_secret_change_me',
  appKey: env.APP_KEY || '0'.repeat(64),
  admin: {
    username: env.ADMIN_USERNAME || 'admin',
    password: env.ADMIN_PASSWORD || 'Admin@123456',
    email: env.ADMIN_EMAIL || 'admin@example.com',
    ipWhitelist: (env.ADMIN_IP_WHITELIST || '').split(',').map((s) => s.trim()).filter(Boolean),
  },
  turnstile: {
    siteKey: env.TURNSTILE_SITE_KEY || '',
    secret: env.TURNSTILE_SECRET_KEY || '',
  },
  bankWebhookToken: env.BANK_WEBHOOK_TOKEN || '',
  depositPrefix: (env.DEPOSIT_PREFIX || 'NAP').toUpperCase().replace(/[^A-Z]/g, '') || 'NAP',
  seedCatalog: env.SEED_CATALOG !== 'false',
  seedDemo: env.SEED_DEMO === 'true',
  retention: {
    logDays: int(env.LOG_RETENTION_DAYS, 90),
    depositDays: int(env.DEPOSIT_RETENTION_DAYS, 60),
    depositExpireMinutes: int(env.DEPOSIT_EXPIRE_MINUTES, 1440),
    backupKeep: int(env.BACKUP_KEEP, 10),
    backupDays: int(env.BACKUP_DAYS, 10),
    archiveDays: int(env.ARCHIVE_AFTER_DAYS, 180),
    balanceLogDays: int(env.BALANCE_LOG_RETENTION_DAYS, 365),
    bankTxnDays: int(env.BANK_TXN_RETENTION_DAYS, 90),
  },
  paths: {
    root: path.join(__dirname, '..'),
    // GZ_DATA_DIR chỉ dùng cho scripts/bench-purchase.js (chạy trên bản sao database trong thư mục tạm)
    data: env.GZ_DATA_DIR || path.join(__dirname, '..', 'data'),
    backups: path.join(env.GZ_DATA_DIR || path.join(__dirname, '..', 'data'), 'backups'),
    uploads: path.join(__dirname, '..', 'public', 'uploads'),
  },
};

if (isProd) {
  const weak = [];
  if (config.sessionSecret.length < 32 || config.sessionSecret.startsWith('change_me')) weak.push('SESSION_SECRET');
  if (/^0+$/.test(config.appKey)) weak.push('APP_KEY');
  if (config.admin.password === 'Admin@123456') weak.push('ADMIN_PASSWORD');
  if (!config.bankWebhookToken || config.bankWebhookToken.startsWith('change_me')) weak.push('BANK_WEBHOOK_TOKEN');
  if (weak.length) {
    console.error(`[SECURITY] Chạy production nhưng các biến sau chưa được đổi: ${weak.join(', ')}`);
    process.exit(1);
  }
}

module.exports = config;
