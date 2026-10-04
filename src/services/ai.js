'use strict';
/**
 * AI viết bài: nhiều nhà cung cấp, chọn trong Admin -> AI viết bài.
 * Gọi thẳng API bằng fetch (không cần cài thêm thư viện). API key lưu mã hóa trong settings.
 * Viết bài chạy nền (bảng ai_jobs) -> trình duyệt hỏi tiến độ vài giây 1 lần (không bị Nginx cắt khi AI viết lâu,
 * và chạy được với PM2 nhiều bản vì tiến độ nằm trong database).
 */
const { db, getSettings } = require('../db');
const { decrypt } = require('../utils/crypto');
const posts = require('./posts');

const PROVIDERS = {
  openai: { name: 'OpenAI (ChatGPT)', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o-mini'], keyHint: 'sk-...', url: 'https://api.openai.com/v1/chat/completions' },
  anthropic: { name: 'Anthropic (Claude)', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'], keyHint: 'sk-ant-...' },
  gemini: { name: 'Google Gemini', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], keyHint: 'AIza...' },
  deepseek: { name: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'], keyHint: 'sk-...', url: 'https://api.deepseek.com/chat/completions' },
  custom: { name: 'Khác (API tương thích OpenAI: OpenRouter, Groq, Qwen...)', models: [], keyHint: 'API key' },
};
// Model Claude hỗ trợ "fallbacks": bị từ chối do bộ lọc an toàn thì API tự chạy lại bằng model dự phòng
const CLAUDE_FALLBACK = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5'];

class AiError extends Error {}
const keyOf = (s, p) => { try { return s[`ai_key_${p}_enc`] ? decrypt(s[`ai_key_${p}_enc`]) : ''; } catch { return ''; } };
const modelOf = (s, p) => s[`ai_model_${p}`] || PROVIDERS[p]?.models[0] || '';

/** Trạng thái để hiện trong admin: nhà cung cấp nào đã có key */
function status(s = getSettings()) {
  const provider = PROVIDERS[s.ai_provider] ? s.ai_provider : 'openai';
  return { provider, model: modelOf(s, provider), ready: !!keyOf(s, provider) && (provider !== 'custom' || !!s.ai_custom_url), hasKey: Object.fromEntries(Object.keys(PROVIDERS).map((p) => [p, !!s[`ai_key_${p}_enc`]])) };
}

async function post(url, headers, body, ms) {
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new AiError(e.name === 'TimeoutError' ? 'AI trả lời quá lâu, vui lòng thử lại' : 'Không kết nối được tới máy chủ AI: ' + e.message);
  }
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* không phải JSON */ }
  if (!r.ok) {
    throw new AiError(friendlyError(r.status, String(j?.error?.message || j?.message || text || '')));
  }
  if (!j) throw new AiError('AI trả về dữ liệu không đọc được');
  return j;
}

/** Lỗi từ AI -> câu ngắn, dễ hiểu (bản gốc rất dài, VD lỗi hết lượt của Google) */
function friendlyError(status, raw) {
  const msg = raw.replace(/\s+/g, ' ').trim();
  const short = (msg.split(/(?<=\.)\s/)[0] || msg).slice(0, 160);
  if (status === 401 || status === 403 || /api key not valid|invalid.*api key|incorrect api key|authentication/i.test(msg)) return `API key sai hoặc không có quyền (lỗi ${status}). Kiểm tra lại API key.`;
  if (status === 429 && /free_tier|limit: 0/i.test(msg)) return 'Model này không dùng được với gói miễn phí (giới hạn 0 lượt). Hãy bật thanh toán trong tài khoản AI, hoặc đổi sang model rẻ hơn (VD gemini-2.5-flash).';
  if (status === 429 && /quota|billing|credit|balance|insufficient/i.test(msg)) return `Tài khoản AI đã hết lượt hoặc hết tiền (lỗi 429). Nạp thêm tiền / kiểm tra gói của bạn. Chi tiết: ${short}`;
  if (status === 429) { const w = /retry in ([\dhms.]+)/i.exec(msg); return `Gửi quá nhiều yêu cầu, AI tạm chặn (lỗi 429)${w ? `, thử lại sau ${w[1].replace(/\.\d+s$/, 's')}` : ''}.`; }
  if (status === 404 || /model.*(not found|does not exist|not supported)/i.test(msg)) return `Không tìm thấy model này (lỗi ${status}). Kiểm tra lại tên model.`;
  if (status >= 500) return `Máy chủ AI đang lỗi (lỗi ${status}), vui lòng thử lại sau.`;
  return `AI báo lỗi ${status}: ${short}`;
}

/** Gửi 1 yêu cầu tới AI đang chọn (hoặc provider truyền vào) -> văn bản trả lời */
async function complete(system, user, { json = false, ms = 300000, s = getSettings(), provider = null } = {}) {
  const p = PROVIDERS[provider] ? provider : PROVIDERS[s.ai_provider] ? s.ai_provider : 'openai';
  const key = keyOf(s, p); const model = modelOf(s, p);
  if (!key) throw new AiError(`Chưa nhập API key cho ${PROVIDERS[p].name}`);
  if (!model) throw new AiError('Chưa chọn model AI');

  if (p === 'anthropic') {
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const body = { model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }] };
    if (CLAUDE_FALLBACK.includes(model)) { headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; body.fallbacks = 'default'; }
    const j = await post('https://api.anthropic.com/v1/messages', headers, body, ms);
    if (j.stop_reason === 'refusal') throw new AiError('AI từ chối viết nội dung này, hãy đổi cách ra lệnh');
    return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  if (p === 'gemini') {
    const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] };
    if (json) body.generationConfig = { responseMimeType: 'application/json' };
    const j = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': key }, body, ms);
    const c = j.candidates?.[0];
    if (!c) throw new AiError('AI không trả lời (có thể bị bộ lọc an toàn chặn), hãy đổi cách ra lệnh');
    return (c.content?.parts || []).map((x) => x.text || '').join('');
  }
  // OpenAI và các API cùng chuẩn (DeepSeek, OpenRouter, Groq...)
  let url = PROVIDERS[p].url;
  if (p === 'custom') {
    url = String(s.ai_custom_url || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(url)) throw new AiError('Địa chỉ API tùy chỉnh phải bắt đầu bằng https://');
    if (!/\/chat\/completions$/.test(url)) url += '/chat/completions';
  }
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (json && p !== 'custom') body.response_format = { type: 'json_object' };
  const j = await post(url, { Authorization: `Bearer ${key}` }, body, ms);
  const text = j.choices?.[0]?.message?.content;
  if (!text) throw new AiError('AI không trả lời, hãy thử lại');
  return text;
}

// ---------- Viết bài ----------
function linkList() {
  const games = db.prepare('SELECT name, slug FROM games WHERE is_active = 1 ORDER BY sort_order, id LIMIT 40').all();
  const cats = db.prepare(`SELECT c.name, c.slug, g.slug AS gslug, g.name AS gname FROM categories c JOIN games g ON g.id = c.game_id
    WHERE c.is_active = 1 AND g.is_active = 1 ORDER BY g.sort_order, c.sort_order LIMIT 120`).all();
  return [...games.map((g) => `- Game ${g.name}: [[game:${g.slug}]]`), ...cats.map((c) => `- ${c.gname} › ${c.name}: [[cat:${c.gslug}/${c.slug}]]`)].join('\n');
}

function buildPrompt(input, s = getSettings()) {
  const site = s.site_name || 'shop';
  const words = { short: 600, medium: 1000, long: 1600 }[input.length] || 1000;
  const system = `Bạn là chuyên gia viết nội dung chuẩn SEO tiếng Việt cho website "${site}" — shop bán tài khoản game, nạp game và dịch vụ cày thuê.
Yêu cầu bắt buộc:
- Viết tiếng Việt tự nhiên, có dấu, hữu ích thật sự cho người chơi; không nhồi nhét từ khóa.
- Không bịa giá tiền, khuyến mãi, cam kết hay thông tin phiên bản game mà bạn không chắc chắn.
- content_html chỉ dùng các thẻ: h2, h3, p, ul, ol, li, strong, em, blockquote, table, thead, tbody, tr, th, td, a. Không dùng h1, không dùng style, class, script.
- Từ khóa chính xuất hiện trong tiêu đề, câu đầu tiên và ít nhất 1 thẻ h2.
- Có thể chèn thẻ liên kết tới trang của shop bằng mã dạng [[...]] (đặt riêng 1 dòng trong thẻ <p>), chỉ dùng mã có trong danh sách:
${linkList() || '(chưa có)'}
${s.ai_extra ? `Thông tin thêm về shop / yêu cầu riêng:\n${s.ai_extra}\n` : ''}
Chỉ trả về đúng 1 đối tượng JSON (không kèm chữ nào khác) với các khóa:
{"title": "tiêu đề bài 50-65 ký tự", "seo_title": "tiêu đề SEO 50-60 ký tự", "seo_desc": "mô tả SEO 120-160 ký tự", "focus_kw": "từ khóa chính", "slug": "duong-dan-khong-dau", "excerpt": "tóm tắt 1-2 câu", "content_html": "nội dung HTML", "faq": [{"q": "câu hỏi", "a": "trả lời"}]}`;
  const user = [
    `Yêu cầu: ${input.prompt}`,
    input.keyword ? `Từ khóa chính: ${input.keyword}` : '',
    input.game ? `Game liên quan: ${input.game}` : '',
    `Độ dài khoảng ${words} chữ, 3-5 câu hỏi thường gặp.`,
    `Giọng văn: ${input.tone || s.ai_tone || 'thân thiện, dễ hiểu, chuyên nghiệp'}.`,
  ].filter(Boolean).join('\n');
  return { system, user };
}

function parseResult(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new AiError('AI không trả về đúng định dạng, hãy thử lại');
  let j; try { j = JSON.parse(t.slice(a, b + 1)); } catch { throw new AiError('AI trả về sai định dạng JSON, hãy thử lại'); }
  const cut = (v, n) => String(v || '').trim().slice(0, n);
  const content = posts.sanitize(j.content_html || j.content || '');
  if (posts.wordCount(content) < 50) throw new AiError('Bài AI viết quá ngắn, hãy thử lại');
  return {
    title: cut(j.title, 200), seo_title: cut(j.seo_title, 70), seo_desc: cut(j.seo_desc, 170), focus_kw: cut(j.focus_kw, 80),
    slug: require('../utils/helpers').slugify(j.slug || j.title), excerpt: cut(j.excerpt, 400), content,
    faq: (Array.isArray(j.faq) ? j.faq : []).filter((f) => f && f.q && f.a).slice(0, 10).map((f) => `${cut(f.q, 300)}\n${cut(f.a, 2000)}`).join('\n\n'),
  };
}

const STALE = 15 * 60;
/** Tạo việc viết bài chạy nền -> id */
function startWrite(userId, input) {
  db.prepare("UPDATE ai_jobs SET status = 'error', error = 'Quá thời gian', finished_at = unixepoch() WHERE status = 'running' AND created_at < unixepoch() - ?").run(STALE);
  db.prepare('DELETE FROM ai_jobs WHERE created_at < unixepoch() - 7 * 86400').run();
  if (db.prepare("SELECT 1 FROM ai_jobs WHERE user_id = ? AND status = 'running'").get(userId)) throw new AiError('AI đang viết 1 bài khác, vui lòng đợi xong');
  const s = getSettings(); const st = status(s);
  if (!st.ready) throw new AiError('Chưa cài đặt AI. Vào Admin -> AI viết bài để nhập API key');
  const id = db.prepare('INSERT INTO ai_jobs(user_id, provider, model, input) VALUES(?,?,?,?)').run(userId, st.provider, st.model, JSON.stringify(input)).lastInsertRowid;
  setImmediate(async () => {
    try {
      const { system, user } = buildPrompt(input, s);
      const out = parseResult(await complete(system, user, { json: true, s }));
      db.prepare("UPDATE ai_jobs SET status = 'done', result = ?, finished_at = unixepoch() WHERE id = ?").run(JSON.stringify(out), id);
    } catch (e) {
      db.prepare("UPDATE ai_jobs SET status = 'error', error = ?, finished_at = unixepoch() WHERE id = ?").run(e instanceof AiError ? e.message : 'Lỗi: ' + e.message, id);
      if (!(e instanceof AiError)) console.error('[ai]', e);
    }
  });
  return id;
}
function job(id, userId) {
  const j = db.prepare('SELECT * FROM ai_jobs WHERE id = ? AND user_id = ?').get(id, userId);
  if (!j) return null;
  if (j.status === 'running' && j.created_at < Math.floor(Date.now() / 1000) - STALE) return { status: 'error', error: 'Quá thời gian, vui lòng thử lại' };
  return { status: j.status, error: j.error, result: j.result ? JSON.parse(j.result) : null, seconds: Math.floor(Date.now() / 1000) - j.created_at };
}

/** Thử kết nối (nút "Thử kết nối" trong admin) */
async function test(provider) {
  const t = await complete('Bạn là trợ lý. Trả lời ngắn gọn.', 'Trả lời đúng 1 từ: OK', { ms: 60000, provider });
  return String(t).trim().slice(0, 100);
}

module.exports = { PROVIDERS, AiError, status, complete, startWrite, job, test, buildPrompt, parseResult };
