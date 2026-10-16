'use strict';
// Captcha SVG tự sinh (không cần dịch vụ ngoài), chống bot đăng ký/đăng nhập
const crypto = require('crypto');
const config = require('../config');

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function rnd(min, max) {
  return min + crypto.randomInt(max - min + 1);
}

function create() {
  let text = '';
  for (let i = 0; i < 5; i++) text += CHARS[crypto.randomInt(CHARS.length)];
  const w = 150, h = 50;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
  svg += `<rect width="100%" height="100%" fill="#1e1b2e"/>`;
  for (let i = 0; i < 6; i++) {
    svg += `<path d="M${rnd(0, w)} ${rnd(0, h)} Q${rnd(0, w)} ${rnd(0, h)} ${rnd(0, w)} ${rnd(0, h)}" stroke="hsl(${rnd(0, 360)},70%,60%)" stroke-width="${rnd(1, 2)}" fill="none" opacity="0.6"/>`;
  }
  for (let i = 0; i < 25; i++) {
    svg += `<circle cx="${rnd(0, w)}" cy="${rnd(0, h)}" r="1" fill="hsl(${rnd(0, 360)},60%,70%)"/>`;
  }
  [...text].forEach((c, i) => {
    const x = 18 + i * 26 + rnd(-3, 3);
    const y = 34 + rnd(-5, 5);
    svg += `<text x="${x}" y="${y}" font-family="monospace" font-size="${rnd(24, 30)}" font-weight="bold" fill="hsl(${rnd(0, 360)},80%,75%)" transform="rotate(${rnd(-25, 25)} ${x} ${y})">${c}</text>`;
  });
  svg += '</svg>';
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
