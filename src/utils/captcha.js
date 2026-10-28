'use strict';
// Captcha SVG tự sinh (không cần dịch vụ ngoài), chống bot đăng ký/đăng nhập
const crypto = require('crypto');
const config = require('../config');

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function rnd(min, max) {
  return min + crypto.randomInt(max - min + 1);
}

// Nét vẽ từng ký tự trên lưới 4 x 6 (không dùng thẻ <text>: bot không đọc thẳng được chữ trong file SVG)
const G = {
  A: [[[0, 6], [2, 0], [4, 6]], [[1, 4], [3, 4]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[0, 0], [3, 0], [4, 1], [4, 2], [3, 3]]],
  C: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
  D: [[[0, 0], [0, 6], [2, 6], [4, 4], [4, 2], [2, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  F: [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
  G: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3], [2, 3]]],
  H: [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
  J: [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
  K: [[[0, 0], [0, 6]], [[4, 0], [0, 4]], [[1, 3], [4, 6]]],
  M: [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
  N: [[[0, 6], [0, 0], [4, 6], [4, 0]]],
  P: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]]],
  Q: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]], [[2, 4], [4, 6]]],
  R: [[[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]], [[2, 3], [4, 6]]],
  S: [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  T: [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
  U: [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
  V: [[[0, 0], [2, 6], [4, 0]]],
  W: [[[0, 0], [1, 6], [2, 3], [3, 6], [4, 0]]],
  X: [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
  Y: [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
  Z: [[[0, 0], [4, 0], [0, 6], [4, 6]]],
  2: [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
  3: [[[0, 0], [4, 0], [2, 2], [3, 2], [4, 3], [4, 5], [3, 6], [1, 6], [0, 5]]],
  4: [[[3, 6], [3, 0], [0, 4], [4, 4]]],
  5: [[[4, 0], [0, 0], [0, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
  6: [[[3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
  7: [[[0, 0], [4, 0], [1, 6]]],
  8: [[[1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]], [[1, 3], [0, 2], [0, 1], [1, 0]]],
  9: [[[4, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6]]],
};
const jit = (a) => (crypto.randomInt(2001) / 1000 - 1) * a;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function create() {
  let text = '';
  for (let i = 0; i < 5; i++) text += CHARS[crypto.randomInt(CHARS.length)];
  const w = 150, h = 50;
  const parts = [];
  for (let i = 0; i < 6; i++) {
    parts.push(`<path d="M${rnd(0, w)} ${rnd(0, h)} Q${rnd(0, w)} ${rnd(0, h)} ${rnd(0, w)} ${rnd(0, h)}" stroke="hsl(${rnd(0, 360)},70%,60%)" stroke-width="${rnd(1, 2)}" fill="none" opacity="0.6"/>`);
  }
  for (let i = 0; i < 25; i++) parts.push(`<circle cx="${rnd(0, w)}" cy="${rnd(0, h)}" r="1" fill="hsl(${rnd(0, 360)},60%,70%)"/>`);
  [...text].forEach((c, i) => {
    const sx = 4.2 + jit(0.5), sy = 4.3 + jit(0.4), ang = jit(0.35), ox = 16 + i * 26 + jit(3), oy = 12 + jit(4);
    const cos = Math.cos(ang), sin = Math.sin(ang), col = `hsl(${rnd(0, 360)},80%,75%)`, sw = (2.2 + jit(0.5)).toFixed(1);
    for (const st of G[c]) {
      const d = st.map(([x, y], k) => {
        const px = (x - 2) * sx + jit(0.7), py = (y - 3) * sy + jit(0.7);
        return `${k ? 'L' : 'M'}${(ox + 8 + px * cos - py * sin).toFixed(1)} ${(oy + 13 + px * sin + py * cos).toFixed(1)}`;
      }).join('');
      parts.push(`<path d="${d}" stroke="${col}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  });
  // nét nhiễu ngắn giống nét chữ (mảnh, mờ hơn) để máy khó tách chữ
  for (let i = 0; i < 4; i++) { const x = rnd(5, w - 20), y = rnd(8, h - 8); parts.push(`<path d="M${x} ${y}L${x + rnd(6, 16)} ${y + rnd(-8, 8)}" stroke="hsl(${rnd(0, 360)},70%,70%)" stroke-width="1.2" fill="none" opacity="0.55" stroke-linecap="round"/>`); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#1e1b2e"/>${shuffle(parts).join('')}</svg>`;
  return { text, svg };
}

function verify(req, input) {
  const expected = req.session.captcha;
  const created = req.session.captchaAt || 0;
  delete req.session.captcha; // dùng 1 lần
  delete req.session.captchaAt;
  if (!expected || Date.now() - created > 5 * 60 * 1000) return false;
  return String(input || '').trim().toUpperCase() === expected;
}

/**
 * Kiểm tra captcha: dùng Cloudflare Turnstile nếu đã cấu hình (chống bot mạnh hơn),
 * ngược lại dùng captcha SVG tự sinh.
 */
async function check(req) {
  const secret = config.turnstile.secret;
  if (!secret) return verify(req, req.body.captcha);
  const token = String(req.body['cf-turnstile-response'] || '');
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: req.ip || '' }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    return !!j.success;
  } catch (e) {
    console.error('turnstile verify error', e.message);
    return false;
  }
}

module.exports = { create, verify, check };
