'use strict';
/**
 * Admin -> SEO & Bài viết: bài viết, chuyên mục, AI viết bài, SEO & Google (Search Console, GA4, Google Ads).
 * Gắn vào /admin (đã qua requireAdmin + CSRF + bộ nhận ảnh của router admin).
 */
const express = require('express');
const { db, getSettings, setSetting, logActivity } = require('../db');
const { saveImage, removeImage } = require('../utils/upload');
const { encrypt } = require('../utils/crypto');
const { randomCode } = require('../utils/crypto');
const H = require('../utils/helpers');
const P = require('../services/posts');
const ai = require('../services/ai');
const seo = require('./seo');

const { paginate, toInt, str, bool, clientIp } = H;
const router = express.Router();
const fileOf = (req, field) => (req.files || []).find((f) => f.fieldname === field);
const audit = (req, action, detail) => logActivity(req.user.id, action, detail, clientIp(req));
const back = (req, res, type, msg, url) => { if (msg) req.flash(type, msg); res.redirect(url); };
const now = () => Math.floor(Date.now() / 1000);

// ======================= BÀI VIẾT =======================
const STATUS = { draft: 'Nháp', published: 'Đã đăng', scheduled: 'Hẹn giờ' };
router.get('/posts', (req, res) => {
  const q = { status: ['draft', 'published', 'scheduled'].includes(req.query.status) ? req.query.status : '', q: str(req.query.q, 80), cat: toInt(req.query.cat, 0) };
  const where = []; const params = [];
  if (q.status === 'draft') where.push("p.status = 'draft'");
  if (q.status === 'published') where.push("p.status = 'published' AND p.published_at <= unixepoch()");
  if (q.status === 'scheduled') where.push("p.status = 'published' AND p.published_at > unixepoch()");
  if (q.q) { where.push('(p.title LIKE ? OR p.focus_kw LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.cat) { where.push('p.category_id = ?'); params.push(q.cat); }
  const result = paginate(db, {
    select: 'p.id, p.title, p.slug, p.status, p.published_at, p.updated_at, p.views, p.focus_kw, p.cover, c.name AS cat_name, g.name AS game_name',
    from: 'posts p LEFT JOIN post_categories c ON c.id = p.category_id LEFT JOIN games g ON g.id = p.game_id',
    where: where.length ? 'WHERE ' + where.join(' AND ') : '', params, order: 'ORDER BY p.updated_at DESC, p.id DESC', page: toInt(req.query.page, 1, 1), perPage: 30,
  });
  const counts = db.prepare(`SELECT
      SUM(status = 'draft') draft, SUM(status = 'published' AND published_at <= unixepoch()) published, SUM(status = 'published' AND published_at > unixepoch()) scheduled, COUNT(*) total
    FROM posts`).get();
  res.render('admin/posts', { title: 'Bài viết', result, query: q, counts, cats: db.prepare('SELECT id, name FROM post_categories ORDER BY sort_order, id').all() });
});

function formData(p) {
  return {
    title: p ? (p.id ? 'Sửa bài viết' : 'Viết bài mới') : 'Viết bài mới', p: p || {},
    cats: db.prepare('SELECT id, name FROM post_categories ORDER BY sort_order, id').all(),
    games: db.prepare('SELECT id, name, slug FROM games ORDER BY sort_order, id').all(),
    faqText: p ? P.faqText(p.faq) : '', aiStatus: ai.status(), aiName: ai.PROVIDERS[ai.status().provider].name,
  };
}
router.get('/posts/new', (req, res) => res.set('Cache-Control', 'no-store').render('admin/post-form', formData(null)));
router.get('/posts/:id/edit', (req, res, next) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(toInt(req.params.id));
  if (!p) return next();
  res.set('Cache-Control', 'no-store').render('admin/post-form', formData(p));
});

router.post('/posts/save', (req, res) => {
  const b = req.body;
  const id = toInt(b.id);
  const old = id ? db.prepare('SELECT * FROM posts WHERE id = ?').get(id) : null;
  if (id && !old) return back(req, res, 'error', 'Không tìm thấy bài viết', '/admin/posts');
  const title = str(b.title, 200);
  const backUrl = old ? `/admin/posts/${id}/edit` : '/admin/posts/new';
  if (!title) return back(req, res, 'error', 'Tiêu đề không được trống', backUrl);
  let slug = H.slugify(b.slug || title);
  if (db.prepare('SELECT 1 FROM posts WHERE slug = ? AND id != ?').get(slug, id)) slug += '-' + randomCode(3).toLowerCase();
  // ảnh bìa
  let cover = old?.cover || null;
  const f = fileOf(req, 'cover');
  if (f) {
    const saved = saveImage(f, 'posts');
    if (!saved) return back(req, res, 'error', 'File ảnh bìa không hợp lệ', backUrl);
    if (old?.cover) removeImage(old.cover);
    cover = saved;
  } else if (old && b.remove_cover) { removeImage(old.cover); cover = null; }
  // trạng thái: draft | publish (ngay hoặc hẹn giờ)
  const action = b.act === 'publish' ? 'publish' : b.act === 'unpublish' || b.act === 'draft' ? 'draft' : (old?.status === 'published' ? 'publish' : 'draft');
  let status = action === 'publish' ? 'published' : action === 'draft' ? 'draft' : action;
  let pubAt = old?.published_at || null;
  const when = H.fromInputDate(b.published_at);
  if (status === 'published') pubAt = when || (old?.status === 'published' ? old.published_at : null) || now();
  if (b.act === 'unpublish') pubAt = null;
  const cat = toInt(b.category_id) || null; const game = toInt(b.game_id) || null;
  const data = [title, slug, str(b.excerpt, 400) || null, P.sanitize(String(b.content || '').slice(0, 300000)), cover,
    cat && db.prepare('SELECT 1 FROM post_categories WHERE id = ?').get(cat) ? cat : null, game && db.prepare('SELECT 1 FROM games WHERE id = ?').get(game) ? game : null,
    str(b.focus_kw, 80) || null, str(b.seo_title, 70) || null, str(b.seo_desc, 170) || null, JSON.stringify(P.parseFaq(b.faq)), status, pubAt];
  let pid = id;
  if (old) {
    db.prepare('UPDATE posts SET title=?, slug=?, excerpt=?, content=?, cover=?, category_id=?, game_id=?, focus_kw=?, seo_title=?, seo_desc=?, faq=?, status=?, published_at=?, updated_at=unixepoch() WHERE id=?').run(...data, id);
  } else {
    pid = db.prepare('INSERT INTO posts(title, slug, excerpt, content, cover, category_id, game_id, focus_kw, seo_title, seo_desc, faq, status, published_at, author_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...data, req.user.id).lastInsertRowid;
  }
  seo.clearSitemap();
  audit(req, old ? 'post_update' : 'post_create', `${title} [${status}]`);
  const msg = status === 'published' ? (pubAt > now() ? `Đã hẹn giờ đăng lúc ${H.fmtDate(pubAt)}` : 'Đã đăng bài lên web') : 'Đã lưu nháp';
  back(req, res, 'success', msg, `/admin/posts/${pid}/edit`);
});

router.post('/posts/:id/delete', (req, res) => {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(toInt(req.params.id));
  if (!p) return back(req, res, 'error', 'Không tìm thấy', '/admin/posts');
  db.prepare('DELETE FROM posts WHERE id = ?').run(p.id);
  removeImage(p.cover);
  // ảnh chèn trong bài (đã tải lên web) -> xóa nếu không bài nào khác dùng
  for (const m of String(p.content).matchAll(/src="(\/uploads\/posts\/[^"]+)"/g)) {
    if (!db.prepare('SELECT 1 FROM posts WHERE content LIKE ?').get(`%${m[1]}%`)) removeImage(m[1]);
  }
  seo.clearSitemap();
  audit(req, 'post_delete', p.title);
  back(req, res, 'success', 'Đã xóa bài viết', '/admin/posts');
});

// Tải ảnh chèn vào bài (trình soạn thảo) -> { url }
router.post('/posts/upload', (req, res) => {
  const f = fileOf(req, 'image');
  const url = f ? saveImage(f, 'posts') : null;
  if (!url) return res.status(400).json({ ok: false, message: 'File ảnh không hợp lệ (JPG/PNG/WEBP ≤ 8MB)' });
  res.json({ ok: true, url });
});

// ======================= CHUYÊN MỤC =======================
router.get('/post-categories', (req, res) => {
  const cats = db.prepare('SELECT c.*, (SELECT COUNT(*) FROM posts p WHERE p.category_id = c.id) AS n FROM post_categories c ORDER BY c.sort_order, c.id').all();
  res.render('admin/post-categories', { title: 'Chuyên mục bài viết', cats, edit: req.query.id ? cats.find((c) => c.id === toInt(req.query.id)) : null });
});
router.post('/post-categories/save', (req, res) => {
  const id = toInt(req.body.id); const name = str(req.body.name, 80);
  if (!name) return back(req, res, 'error', 'Tên chuyên mục không được trống', '/admin/post-categories');
  let slug = H.slugify(req.body.slug || name);
  if (db.prepare('SELECT 1 FROM post_categories WHERE slug = ? AND id != ?').get(slug, id)) slug += '-' + randomCode(3).toLowerCase();
  const data = [name, slug, str(req.body.description, 300) || null, toInt(req.body.sort_order, 0, 0, 999), bool(req.body.is_active)];
  if (id) db.prepare('UPDATE post_categories SET name=?, slug=?, description=?, sort_order=?, is_active=? WHERE id=?').run(...data, id);
  else db.prepare('INSERT INTO post_categories(name, slug, description, sort_order, is_active) VALUES(?,?,?,?,?)').run(...data);
  seo.clearSitemap();
  back(req, res, 'success', id ? 'Đã cập nhật chuyên mục' : 'Đã thêm chuyên mục', '/admin/post-categories');
});
router.post('/post-categories/:id/delete', (req, res) => {
  db.prepare('DELETE FROM post_categories WHERE id = ?').run(toInt(req.params.id)); // bài viết bên trong chuyển thành "không chuyên mục"
  seo.clearSitemap();
  back(req, res, 'success', 'Đã xóa chuyên mục', '/admin/post-categories');
});

// ======================= AI VIẾT BÀI =======================
router.get('/ai', (req, res) => {
  const s = getSettings();
  res.render('admin/ai', { title: 'AI viết bài', PROVIDERS: ai.PROVIDERS, st: ai.status(s), s });
});
router.post('/ai', (req, res) => {
  const b = req.body;
  if (ai.PROVIDERS[b.ai_provider]) setSetting('ai_provider', b.ai_provider);
  for (const p of Object.keys(ai.PROVIDERS)) {
    if (b[`model_${p}`] !== undefined) setSetting(`ai_model_${p}`, str(b[`model_${p}`], 80));
    const k = String(b[`key_${p}`] || '').trim();
    if (k) setSetting(`ai_key_${p}_enc`, encrypt(k.slice(0, 300)));
    if (b[`clear_${p}`]) setSetting(`ai_key_${p}_enc`, '');
  }
  if (b.ai_custom_url !== undefined) {
    const u = str(b.ai_custom_url, 200).trim();
    if (u && !/^https:\/\//i.test(u)) return back(req, res, 'error', 'Địa chỉ API tùy chỉnh phải bắt đầu bằng https://', '/admin/ai');
    setSetting('ai_custom_url', u);
  }
  if (b.ai_anthropic_workspace !== undefined) {
    const w = str(b.ai_anthropic_workspace, 100).trim();
    if (w && !/^[\w-]+$/.test(w)) return back(req, res, 'error', 'Workspace ID chỉ gồm chữ, số, dấu - và _', '/admin/ai');
    setSetting('ai_anthropic_workspace', w);
  }
  if (b.ai_tone !== undefined) setSetting('ai_tone', str(b.ai_tone, 200));
  if (b.ai_extra !== undefined) setSetting('ai_extra', str(b.ai_extra, 2000));
  audit(req, 'ai_settings', b.ai_provider || '');
  back(req, res, 'success', 'Đã lưu cài đặt AI', '/admin/ai');
});
router.post('/ai/test', async (req, res) => {
  const p = ai.PROVIDERS[req.body?.provider] ? req.body.provider : null;
  console.log(`[ai] thử kết nối ${p || ai.status().provider}, bản PM2 ${process.env.NODE_APP_INSTANCE ?? '-'}, workspace: ${getSettings().ai_anthropic_workspace || '(trống)'}`);
  const name = ai.PROVIDERS[p || ai.status().provider].name;
  try { res.json({ ok: true, message: `${name}: kết nối thành công. AI trả lời: “${await ai.test(p)}”` }); } catch (e) {
    res.json({ ok: false, message: `${name}: ${e instanceof ai.AiError ? e.message : 'Lỗi: ' + e.message}` });
  }
});
router.post('/ai/write', (req, res) => {
  const b = req.body;
  const input = { prompt: str(b.prompt, 20000), keyword: str(b.keyword, 80), game: str(b.game, 80), length: ['short', 'medium', 'long'].includes(b.length) ? b.length : 'medium', tone: str(b.tone, 200) };
  if (input.prompt.length < 5) return res.json({ ok: false, message: 'Hãy nhập yêu cầu cho AI (VD: Viết bài hướng dẫn mua acc Genshin Impact cho người mới)' });
  try {
    const id = ai.startWrite(req.user.id, input);
    audit(req, 'ai_write', input.prompt.slice(0, 120));
    res.json({ ok: true, id });
  } catch (e) {
    if (e instanceof ai.AiError) return res.json({ ok: false, message: e.message });
    throw e;
  }
});
router.get('/ai/jobs/:id', (req, res) => {
  const j = ai.job(toInt(req.params.id), req.user.id);
  res.set('Cache-Control', 'no-store').json(j ? { ok: true, ...j } : { ok: false, message: 'Không tìm thấy' });
});

// ======================= SEO & GOOGLE =======================
const GKEYS = { gsc_verify: 120, ga4_id: 30, gads_id: 30, gads_label_signup: 60, gads_label_deposit: 60, gads_label_purchase: 60 };
router.get('/seo', (req, res) => {
  const sources = db.prepare(`SELECT COALESCE(json_extract(signup_source, '$.s'), '(trực tiếp / không rõ)') AS src, COALESCE(json_extract(signup_source, '$.c'), '') AS camp,
      COUNT(*) users, SUM(total_deposit > 0) paying, COALESCE(SUM(total_deposit), 0) deposit
    FROM users WHERE role = 'user' AND created_at > unixepoch() - 30 * 86400 GROUP BY src, camp ORDER BY users DESC LIMIT 30`).all();
  res.render('admin/seo', { title: 'SEO & Google', s: getSettings(), sources, counts: {
    posts: db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'published' AND published_at <= unixepoch()").get().n,
    products: db.prepare("SELECT COUNT(*) n FROM products WHERE status = 'available'").get().n,
  } });
});
router.post('/seo', (req, res) => {
  const b = req.body;
  // dán cả thẻ <meta name="google-site-verification" content="..."> cũng được -> lấy phần content
  const m = /content=["']([^"']+)["']/.exec(String(b.gsc_verify || ''));
  if (m) b.gsc_verify = m[1];
  for (const [k, n] of Object.entries(GKEYS)) if (b[k] !== undefined) setSetting(k, str(b[k], n).trim());
  const bad = [];
  if (getSettings().ga4_id && !/^G-[A-Z0-9]{4,20}$/i.test(getSettings().ga4_id)) bad.push('Mã GA4 phải dạng G-XXXXXXX');
  if (getSettings().gads_id && !/^AW-\d{5,15}$/i.test(getSettings().gads_id)) bad.push('Mã Google Ads phải dạng AW-123456789');
  if (bad.length) { setSetting('ga4_id', /^G-[A-Z0-9]{4,20}$/i.test(getSettings().ga4_id) ? getSettings().ga4_id : ''); setSetting('gads_id', /^AW-\d{5,15}$/i.test(getSettings().gads_id) ? getSettings().gads_id : ''); }
  for (const k of ['gads_label_signup', 'gads_label_deposit', 'gads_label_purchase']) if (!/^[\w-]*$/.test(getSettings()[k] || '')) setSetting(k, '');
  if (getSettings().gsc_verify && !/^[\w-]+$/.test(getSettings().gsc_verify)) setSetting('gsc_verify', '');
  audit(req, 'seo_settings', '');
  back(req, res, bad.length ? 'error' : 'success', bad.length ? bad.join('. ') : 'Đã lưu cài đặt SEO & Google', '/admin/seo');
});

module.exports = router;
module.exports.STATUS = STATUS;
