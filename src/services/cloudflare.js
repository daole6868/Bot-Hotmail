'use strict';
/**
 * Gọi API Cloudflare để bật / tắt chế độ "I'm Under Attack" (Security level) của tên miền.
 * Cần API Token quyền "Zone Settings: Edit" và Zone ID (trang Overview của tên miền trên Cloudflare).
 */
const { getSettings } = require('../db');
const { decrypt } = require('../utils/crypto');

const API = process.env.CF_API_URL || 'https://api.cloudflare.com/client/v4';
const LEVELS = ['essentially_off', 'low', 'medium', 'high', 'under_attack'];

function conf(s = getSettings()) {
  return { zone: String(s.cf_zone_id || '').trim(), token: s.cf_token_enc ? decrypt(s.cf_token_enc) : '' };
}
const ready = (s) => { const c = conf(s); return !!(c.zone && c.token); };

async function call(method, body) {
  const c = conf();
  if (!c.zone || !c.token) throw new Error('Chưa nhập Zone ID / API Token Cloudflare');
  let r;
  try {
    r = await fetch(`${API}/zones/${encodeURIComponent(c.zone)}/settings/security_level`, {
      method, headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'Cloudflare không phản hồi' : 'Lỗi kết nối tới Cloudflare');
  }
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error('Cloudflare báo: ' + (j.errors?.[0]?.message || `HTTP ${r.status}`));
  return j.result?.value;
}

const getSecurityLevel = () => call('GET');
async function setSecurityLevel(value) {
  if (!LEVELS.includes(value)) throw new Error('Mức bảo mật không hợp lệ');
  return call('PATCH', { value });
}

module.exports = { getSecurityLevel, setSecurityLevel, ready, LEVELS };
