'use strict';
/**
 * Bài viết: lọc HTML an toàn (chỉ giữ thẻ định dạng bài viết), hiển thị (mục lục, thẻ sản phẩm), FAQ.
 */
const { db } = require('../db');
const { slugify, money } = require('../utils/helpers');

// ---------- Lọc HTML: mọi thẻ được dựng lại từ danh sách cho phép, còn lại bỏ ----------
const ALLOWED = {
  p: [], br: [], hr: [], h2: [], h3: [], h4: [], strong: [], b: [], em: [], i: [], u: [], s: [],
  blockquote: [], ul: [], ol: [], li: [], table: [], thead: [], tbody: [], tr: [], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'],
  figure: [], figcaption: [], code: [], pre: [],
  a: ['href', 'title'], img: ['src', 'alt', 'width', 'height', 'title'],
};
const RENAME = { h1: 'h2', h5: 'h4', h6: 'h4', div: 'p', section: 'p', article: 'p' };
const VOID = new Set(['br', 'hr', 'img']);
const DROP_BLOCK = /<(script|style|iframe|object|embed|noscript|template|svg|math|head|textarea|select|button|form)\b[\s\S]*?<\/\1\s*>/gi;

const decodeEnt = (v) => String(v)
  .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10) || 32))
  .replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '').replace(/&amp;/gi, '&');
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escText = (t) => t.replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function safeUrl(v, img) {
  const u = decodeEnt(v).replace(/[\u0000- \u007f]+/g, '');
  if (img) return /^(https:\/\/|\/(?!\/))/i.test(u) ? u : null;
  return /^(https?:\/\/|\/(?!\/)|#|mailto:)/i.test(u) ? u : null;
}

function sanitize(html) {
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, '').replace(DROP_BLOCK, '');
  const out = []; const stack = [];
  const parts = src.split(/(<[^>]*>)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part[0] !== '<') { out.push(escText(part)); continue; }
    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)([\s\S]*?)\/?\s*>$/.exec(part);
    if (!m) continue;
    let tag = m[2].toLowerCase(); tag = RENAME[tag] || tag;
    if (!ALLOWED[tag]) continue;
    if (m[1]) { // thẻ đóng
      if (VOID.has(tag)) continue;
      const at = stack.lastIndexOf(tag);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
      continue;
    }
    const attrs = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let a;
    while ((a = re.exec(m[3]))) {
      const name = a[1].toLowerCase(); const val = a[3] ?? a[4] ?? a[5] ?? '';
      if (!ALLOWED[tag].includes(name)) continue;
      if (name === 'href' || name === 'src') {
        const u = safeUrl(val, name === 'src');
        if (!u) continue;
        attrs.push(`${name}="${escAttr(u)}"`);
      } else if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan') {
        const n = parseInt(val, 10); if (n > 0 && n < 5000) attrs.push(`${name}="${n}"`);
      } else attrs.push(`${name}="${escAttr(decodeEnt(val).slice(0, 300))}"`);
    }
    if (tag === 'img' && !attrs.some((x) => x.startsWith('src='))) continue;
    if (tag === 'a') {
      const href = (attrs.find((x) => x.startsWith('href=')) || '').slice(6, -1);
      if (/^https?:\/\//i.test(href)) attrs.push('target="_blank"', 'rel="nofollow noopener"');
    }
    out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
    if (!VOID.has(tag)) stack.push(tag);
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('').replace(/<p>\s*<\/p>/g, '').trim();
}

const plain = (html) => decodeEnt(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\[\[[^\]]+\]\]/g, ' ').replace(/\s+/g, ' ').trim();
const wordCount = (html) => (plain(html).match(/\S+/g) || []).length;
const readMinutes = (html) => Math.max(1, Math.round(wordCount(html) / 220));

// ---------- FAQ: "Câu hỏi" dòng đầu, câu trả lời các dòng sau, mỗi cặp cách nhau 1 dòng trống ----------
function parseFaq(text) {
  return String(text || '').replace(/\r/g, '').split(/\n\s*\n/).map((b) => {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;
    return { q: lines[0].replace(/^(hỏi|q)\s*[:.]\s*/i, '').slice(0, 300), a: lines.slice(1).join(' ').replace(/^(đáp|a)\s*[:.]\s*/i, '').slice(0, 2000) };
  }).filter(Boolean).slice(0, 20);
}
const faqText = (json) => { try { return (JSON.parse(json || '[]') || []).map((f) => `${f.q}\n${f.a}`).join('\n\n'); } catch { return ''; } };
const faqList = (json) => { try { return JSON.parse(json || '[]') || []; } catch { return []; } };

// ---------- Hiển thị: id cho H2/H3 (mục lục) + thẻ sản phẩm [[game:slug]] [[cat:game/danh-muc]] [[sp:MA]] ----------
const escH = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function card(href, img, name, sub, price) {
  return `<a class="post-card-link" href="${escH(href)}">${img ? `<img src="${escH(img)}" alt="${escH(name)}" loading="lazy">` : '<span class="pcl-ico">🎮</span>'}`
    + `<span class="pcl-body"><b>${escH(name)}</b>${sub ? `<small>${escH(sub)}</small>` : ''}</span>${price ? `<span class="pcl-price">${escH(price)}</span>` : ''}<span class="pcl-go">Xem ngay →</span></a>`;
}
function shortcode(kind, ref) {
  if (kind === 'game') {
    const g = db.prepare('SELECT name, slug, image, description FROM games WHERE slug = ? AND is_active = 1').get(ref);
    return g ? card(`/game/${g.slug}`, g.image, g.name, g.description || 'Xem tất cả acc, cày thuê, nạp game') : '';
  }
  if (kind === 'cat') {
    const [gs, cs] = ref.split('/');
    const c = db.prepare(`SELECT c.id, c.name, c.slug, c.image, c.sale_type, g.name AS gname, g.slug AS gslug, g.image AS gimage FROM categories c JOIN games g ON g.id = c.game_id
      WHERE g.slug = ? AND c.slug = ? AND c.is_active = 1 AND g.is_active = 1`).get(gs, cs);
    if (!c) return '';
    const min = c.sale_type === 'vip' || c.sale_type === 'reroll'
      ? db.prepare("SELECT MIN(price) m FROM products WHERE category_id = ? AND status = 'available'").get(c.id).m
      : db.prepare('SELECT MIN(p.price) m FROM boost_packages p JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = ? AND p.is_active = 1').get(c.id).m;
    return card(`/game/${c.gslug}/${c.slug}`, c.image || c.gimage, c.name, c.gname, min ? 'Từ ' + money(min) : '');
  }
  if (kind === 'sp') {
    const p = db.prepare(`SELECT p.code, p.title, p.price, p.images, g.name AS gname FROM products p JOIN categories c ON c.id = p.category_id JOIN games g ON g.id = c.game_id
      WHERE p.code = ? AND p.status = 'available'`).get(ref.toUpperCase());
    if (!p) return '';
    let img = null; try { img = (JSON.parse(p.images || '[]') || [])[0] || null; } catch { /* bỏ qua */ }
    return card(`/product/${p.code}`, img, p.title, p.gname, money(p.price));
  }
  return '';
}

function render(html) {
  const toc = []; const used = new Set();
  let out = String(html || '').replace(/<(h2|h3)>([\s\S]*?)<\/\1>/g, (all, tag, inner) => {
    let id = slugify(plain(inner)).slice(0, 60) || 'muc'; let k = id; let n = 2;
    while (used.has(k)) k = `${id}-${n++}`;
    used.add(k); toc.push({ id: k, level: tag === 'h2' ? 2 : 3, text: plain(inner) });
    return `<${tag} id="${k}">${inner}</${tag}>`;
  });
  const sc = /\[\[(game|cat|sp):([\w/-]{1,120})\]\]/g;
  out = out.replace(/<p>\s*(?:<(?:b|strong|em|i|u)>\s*)*(\[\[(?:game|cat|sp):[\w/-]{1,120}\]\])(?:\s*<\/(?:b|strong|em|i|u)>)*\s*<\/p>/g, '$1').replace(sc, (_, k, ref) => shortcode(k, ref));
  out = out.replace(/<img /g, '<img loading="lazy" ').replace(/<table>/g, '<div class="post-table"><table>').replace(/<\/table>/g, '</table></div>');
  return { html: out, toc };
}

// ---------- 4 bài mẫu (chèn 1 lần, dạng Nháp để admin xem lại rồi đăng) ----------
function seedSamples() {
  if (db.prepare("SELECT value FROM settings WHERE key = 'seed_posts_v1'").get()) return;
  const samples = require('./post-samples');
  const cat = db.prepare("SELECT id FROM post_categories WHERE slug = 'huong-dan'").get();
  const ins = db.prepare(`INSERT OR IGNORE INTO posts(title, slug, excerpt, content, category_id, game_id, focus_kw, seo_title, seo_desc, faq, status)
    VALUES(?,?,?,?,?,?,?,?,?,?,'draft')`);
  for (const p of samples) {
    const g = db.prepare('SELECT id, slug FROM games WHERE ' + p.match.map(() => 'LOWER(name) LIKE ?').join(' OR ') + ' ORDER BY id LIMIT 1').get(...p.match.map((m) => `%${m}%`));
    const content = p.content.replace(/\{\{GAME\}\}/g, g ? `[[game:${g.slug}]]` : '');
    ins.run(p.title, p.slug, p.excerpt, sanitize(content), cat?.id || null, g?.id || null, p.focus_kw, p.seo_title, p.seo_desc, JSON.stringify(p.faq));
  }
  db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('seed_posts_v1', '1')").run();
}

module.exports = { sanitize, render, plain, wordCount, readMinutes, parseFaq, faqText, faqList, seedSamples };
