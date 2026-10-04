'use strict';
/**
 * Chat trực tiếp — việc chạy nền sau mỗi tin của khách:
 *  - Báo Telegram cho admin / nhân viên (kèm ảnh), trả lời ngay trong Telegram bằng cách bấm Reply vào tin của bot
 *  - Tin tự động ngoài giờ làm việc
 *  - AI tự trả lời (bật / tắt, chế độ trong cài đặt chat), chuyển nhân viên khi khách cần người thật
 */
const fs = require('fs');
const path = require('path');
const { db, getSettings } = require('../db');
const { decrypt } = require('../utils/crypto');
const config = require('../config');
const chat = require('./chat');

const TG = () => process.env.TG_API_URL || 'https://api.telegram.org';
const tgToken = (s = getSettings()) => { try { return s.tg_token_enc ? decrypt(s.tg_token_enc) : ''; } catch { return ''; } };

async function tg(method, body, ms = 15000) {
  const token = tgToken(); if (!token) throw new Error('Chưa cài bot Telegram');
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const r = await fetch(`${TG()}/bot${token}/${method}`, {
    method: 'POST', body: isForm ? body : JSON.stringify(body), headers: isForm ? undefined : { 'content-type': 'application/json' }, signal: AbortSignal.timeout(ms),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error(j.description || 'Telegram lỗi'); e.code = j.error_code; throw e; }
  return j.result;
}

/** Nơi nhận tin Telegram: chat admin (Bảo trì dữ liệu) + nhân viên có nhập Telegram chat ID */
function recipients(s = getSettings()) {
  const out = [];
  if (s.tg_chat_id) out.push({ chat: String(s.tg_chat_id), staffId: null, name: null });
  for (const u of db.prepare("SELECT id, username, staff_name, staff_tg FROM users WHERE staff = 1 AND staff_tg IS NOT NULL AND staff_tg != ''").all()) {
    if (!out.some((r) => r.chat === String(u.staff_tg))) out.push({ chat: String(u.staff_tg), staffId: u.id, name: u.staff_name || u.username });
  }
  return out;
}

async function notifyTelegram(conv, msg, force = false) {
  const c = chat.cfg(); const s = getSettings();
  if (!c.tg_notify || !tgToken(s) || (!force && chat.viewingConv(conv.id))) return; // đang có người mở cuộc chat này trên web -> khỏi báo
  const who = `${conv.name || 'Khách'}${conv.user_id ? '' : ' (chưa đăng nhập)'}${conv.contact ? ' · ' + conv.contact : ''}`;
  let ref = ''; try { const r = msg.ref ? JSON.parse(msg.ref) : null; if (r) ref = `\n📦 Đơn ${r.code}: ${r.title} · ${r.totalText} · ${r.status}`; } catch { /* bỏ qua */ }
  const text = `💬 Chat #${conv.id} · ${who}\n${msg.body || (msg.image ? '[Ảnh]' : '')}${ref}${c.tg_reply ? '\n\n↩️ Bấm Trả lời (Reply) tin này để nhắn lại khách' : ''}`.slice(0, 3900);
  for (const r of recipients(s)) {
    try {
      let res;
      const file = msg.image ? path.join(config.paths.uploads, msg.image.replace(/^\/uploads\//, '')) : null;
      if (file && fs.existsSync(file)) {
        const fd = new FormData();
        fd.append('chat_id', r.chat); fd.append('caption', text.slice(0, 1000));
        fd.append('photo', await fs.openAsBlob(file), path.basename(file));
        res = await tg('sendPhoto', fd, 30000);
      } else res = await tg('sendMessage', { chat_id: r.chat, text, disable_web_page_preview: true });
      db.prepare('INSERT OR REPLACE INTO chat_tg(tg_chat, tg_msg, conv_id) VALUES(?,?,?)').run(r.chat, res.message_id, conv.id);
    } catch (e) { console.error('[chat] telegram', e.message); }
  }
}

// ---------- Nhận trả lời từ Telegram (chỉ 1 bản PM2 chạy, hỏi Telegram liên tục kiểu long-polling) ----------
let tgState = { running: false, status: '', at: 0 };
const tgStatus = () => tgState;
async function downloadPhoto(photos) {
  const big = photos[photos.length - 1];
  const f = await tg('getFile', { file_id: big.file_id });
  const r = await fetch(`${TG()}/file/bot${tgToken()}/${f.file_path}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('Không tải được ảnh');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('Ảnh quá lớn');
  const { saveImage, optimizeBuffer } = require('../utils/upload');
  let file = { buffer: buf };
  try { const o = await optimizeBuffer(buf, 'chat'); if (o && o.buf.length < buf.length) file = { buffer: o.buf }; } catch { /* giữ ảnh gốc */ }
  return saveImage(file, 'chat');
}
async function handleUpdate(u) {
  const m = u.message; if (!m || !m.chat) return;
  const from = recipients().find((r) => r.chat === String(m.chat.id));
  if (!from) return; // tin từ người lạ -> bỏ qua
  let convId = null; let text = (m.text || m.caption || '').trim();
  if (m.reply_to_message) convId = db.prepare('SELECT conv_id FROM chat_tg WHERE tg_chat = ? AND tg_msg = ?').get(String(m.chat.id), m.reply_to_message.message_id)?.conv_id || null;
  const cmd = /^\/c\s+(\d+)\s*([\s\S]*)$/i.exec(text);
  if (!convId && cmd) { convId = +cmd[1]; text = cmd[2].trim(); }
  if (!convId) {
    if (text.startsWith('/start')) return;
    await tg('sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: 'Bấm Trả lời (Reply) vào tin nhắn của khách để nhắn lại, hoặc gõ: /c <số cuộc chat> <nội dung>' }).catch(() => {});
    return;
  }
  const conv = chat.convById(convId);
  if (!conv) { await tg('sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: `Không tìm thấy cuộc chat #${convId} (có thể đã bị xóa)` }).catch(() => {}); return; }
  let image = null;
  if (m.photo?.length) { try { image = await downloadPhoto(m.photo); } catch (e) { console.error('[chat] tg photo', e.message); } }
  if (!text && !image) return;
  const c = chat.cfg();
  chat.addMsg(conv.id, 'admin', { staffId: from.staffId, staffName: from.name || c.agent_name, body: text.slice(0, 2000), image });
  pauseAi(conv.id);
  await tg('setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] }).catch(() => {});
}
function startTelegram() {
  if (process.env.NODE_APP_INSTANCE && process.env.NODE_APP_INSTANCE !== '0') return; // PM2 cluster: chỉ bản số 0 nhận tin
  if (tgState.running) return;
  tgState.running = true;
  let offset = parseInt(getSettings().chat_tg_offset, 10) || 0;
  const loop = async () => {
    for (;;) {
      const c = chat.cfg();
      if (!c.enabled || !c.tg_reply || !tgToken()) { tgState.status = ''; await sleep(30000); continue; }
      try {
        const ups = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40000);
        tgState = { running: true, status: 'ok', at: Date.now() };
        for (const u of ups) {
          offset = u.update_id + 1;
          try { await handleUpdate(u); } catch (e) { console.error('[chat] tg update', e.message); }
        }
        if (ups.length) require('../db').setSetting('chat_tg_offset', String(offset));
      } catch (e) {
        tgState = { running: true, status: e.code === 409 ? 'Bot đang dùng webhook ở nơi khác nên không nhận được tin trả lời' : 'Lỗi kết nối Telegram: ' + e.message, at: Date.now() };
        await sleep(e.code === 409 ? 60000 : 10000);
      }
    }
  };
  loop();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

// ---------- AI tự trả lời ----------
const pauseAi = (convId, minutes = 30) => db.prepare('UPDATE chat_convs SET ai_pause_until = ? WHERE id = ?').run(chat.nowS() + minutes * 60, convId);
function aiShould(conv, c = chat.cfg()) {
  if (!c.ai_on || conv.ai_off || conv.blocked || conv.ai_pause_until > chat.nowS()) return false;
  if (!require('./ai').status().ready) return false;
  if (c.ai_mode !== 'always' && chat.inHours(c) && chat.agentsOnline() > 0) return false; // đang có nhân viên trực
  const dayStart = Math.floor((Date.now() + 7 * 3600e3) / 86400e3) * 86400 - 7 * 3600;
  const perConv = db.prepare("SELECT COUNT(*) c FROM chat_msgs WHERE conv_id = ? AND sender = 'ai' AND created_at >= ?").get(conv.id, dayStart).c;
  if (perConv >= chat.int(c.ai_max, 20, 1, 500)) return false;
  const all = db.prepare("SELECT COUNT(*) c FROM chat_msgs WHERE sender = 'ai' AND created_at >= ?").get(dayStart).c;
  return all < chat.int(c.ai_day, 300, 1, 100000);
}
function shopInfo() {
  const s = getSettings(); const c = chat.cfg();
  const cats = db.prepare(`SELECT c.id, c.name, c.slug, c.sale_type, g.name gname, g.slug gslug FROM categories c JOIN games g ON g.id = c.game_id
    WHERE c.is_active = 1 AND g.is_active = 1 ORDER BY g.sort_order, c.sort_order LIMIT 80`).all();
  const minAcc = db.prepare("SELECT MIN(price) m, COUNT(*) n FROM products WHERE category_id = ? AND status = 'available'");
  const minPkg = db.prepare('SELECT MIN(p.price) m, COUNT(*) n FROM boost_packages p JOIN boost_categories b ON b.id = p.category_id WHERE b.parent_id = ? AND p.is_active = 1');
  const TYPE = { vip: 'Acc VIP', reroll: 'Acc reroll', boost: 'Cày thuê', topup: 'Nạp game' };
  const lines = cats.map((x) => {
    const r = (x.sale_type === 'boost' || x.sale_type === 'topup' ? minPkg : minAcc).get(x.id);
    return `- ${x.gname} › ${x.name} (${TYPE[x.sale_type] || x.sale_type}): ${r.n ? `${r.n} ${x.sale_type === 'boost' || x.sale_type === 'topup' ? 'gói' : 'acc'}, giá từ ${require('../utils/helpers').money(r.m)}` : 'tạm hết hàng'} — ${config.baseUrl}/game/${x.gslug}/${x.slug}`;
  });
  return [
    `Tên shop: ${s.site_name || ''}. Website: ${config.baseUrl}`,
    c.hours_on ? `Giờ làm việc: ${c.open} - ${c.close} (giờ Việt Nam)` : 'Hỗ trợ 24/7',
    'Nạp tiền vào tài khoản: mục Nạp tiền (' + config.baseUrl + '/user/deposit), chuyển khoản theo mã QR, tiền tự cộng.',
    'Danh mục đang bán:', ...lines,
    c.ai_info ? 'Thông tin thêm do shop cung cấp:\n' + c.ai_info : '',
  ].filter(Boolean).join('\n');
}
const HANDOFF = '[CHUYEN_NHAN_VIEN]';
async function aiReply(convId, afterMsgId) {
  const c = chat.cfg();
  const conv = chat.convById(convId);
  if (!conv || !aiShould(conv, c)) return;
  const last = db.prepare('SELECT id, sender FROM chat_msgs WHERE conv_id = ? ORDER BY id DESC LIMIT 1').get(convId);
  if (!last || last.id !== afterMsgId || last.sender !== 'user') return; // khách nhắn tiếp / đã có người trả lời
  chat.signal(convId, 'typing', { who: 'agent', name: c.ai_name });
  const hist = chat.recent(convId, 0, 14).map((m) => `${m.sender === 'user' ? 'Khách' : 'Shop'}: ${m.body || (m.image ? '[gửi 1 ảnh]' : '')}${m.ref ? ' [gửi kèm 1 đơn hàng]' : ''}`).join('\n');
  let orders = '';
  if (conv.user_id) orders = chat.userOrders(conv.user_id, 5).map((o) => `- ${o.code}: ${o.title} · ${o.status} · ${o.at ? new Date(o.at * 1000 + 7 * 3600e3).toISOString().slice(0, 10) : ''}`).join('\n');
  const system = `Bạn là "${c.ai_name}", nhân viên tư vấn qua chat của shop bán acc game và dịch vụ cày thuê / nạp game.
Quy tắc:
- Trả lời bằng tiếng Việt, thân thiện, ngắn gọn (tối đa khoảng 80 từ), không dùng định dạng markdown.
- Chỉ dựa vào THÔNG TIN SHOP bên dưới. Không bịa giá, khuyến mãi, chính sách hay thời gian xử lý không có trong thông tin.
- Không bao giờ hỏi mật khẩu hay mã OTP của khách trong chat.
- Khi khách muốn gặp người thật, khiếu nại, cần kiểm tra / xử lý một đơn cụ thể, đòi hoàn tiền, hoặc bạn không chắc câu trả lời: trả lời 1 câu ngắn rằng bạn đã chuyển cho nhân viên hỗ trợ, rồi thêm đúng chuỗi ${HANDOFF} ở cuối.

THÔNG TIN SHOP:
${shopInfo()}${orders ? `\n\nĐơn gần đây của khách này:\n${orders}` : ''}`;
  let text;
  try {
    text = await require('./ai').complete(system, `Đoạn chat (mới nhất ở cuối):\n${hist}\n\nHãy viết câu trả lời tiếp theo của Shop.`, { ms: 60000, maxTokens: 1000 });
  } catch (e) { console.error('[chat] ai', e.message); return; }
  const now = db.prepare('SELECT id FROM chat_msgs WHERE conv_id = ? ORDER BY id DESC LIMIT 1').get(convId);
  if (!now || now.id !== afterMsgId) return; // trong lúc AI nghĩ khách / nhân viên đã nhắn thêm
  const handoff = text.includes(HANDOFF);
  text = text.replace(HANDOFF, '').replace(/\*\*/g, '').trim().slice(0, 2000);
  if (text) chat.addMsg(convId, 'ai', { body: text });
  if (handoff) {
    db.prepare('UPDATE chat_convs SET ai_off = 1 WHERE id = ?').run(convId);
    chat.signal(convId, 'conv', { handoff: true });
    const fresh = chat.convById(convId);
    notifyTelegram(fresh, { body: '🙋 Khách cần gặp nhân viên (AI đã dừng trả lời cuộc này)' }, true).catch(() => {});
  }
}
const aiTimers = new Map();
function scheduleAi(convId, msgId) {
  clearTimeout(aiTimers.get(convId));
  aiTimers.set(convId, setTimeout(() => { aiTimers.delete(convId); aiReply(convId, msgId).catch((e) => console.error('[chat] ai', e.message)); }, 3500));
}

/** Gọi sau mỗi tin của khách */
function onUserMessage(conv, msg) {
  const c = chat.cfg();
  const willAi = aiShould(conv, c);
  if (!chat.inHours(c) && !willAi && conv.offline_notice_day !== chat.vnToday()) {
    db.prepare('UPDATE chat_convs SET offline_notice_day = ? WHERE id = ?').run(chat.vnToday(), conv.id);
    chat.addMsg(conv.id, 'system', { body: c.offline_msg });
  }
  if (willAi) scheduleAi(conv.id, msg.id);
  notifyTelegram(chat.convById(conv.id) || conv, msg).catch(() => {});
}

module.exports = { onUserMessage, startTelegram, tgStatus, pauseAi, notifyTelegram, aiShould, shopInfo };
