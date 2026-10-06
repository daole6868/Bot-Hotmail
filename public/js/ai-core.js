/* Tạo ảnh acc — lõi dùng chung: mẫu bố cục, trạng thái, vẽ canvas (nền, thông tin, lưới nhân vật / vũ khí, mã acc, ghi chú, logo) */
(() => {
  'use strict';
  const app = document.querySelector('[data-ai-app]');
  if (!app) return;
  const B = JSON.parse(app.dataset.boot || '{}');
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const FONT = "'Be Vietnam Pro', system-ui, sans-serif";

  async function api(url, body) {
    const opt = body === undefined ? { headers: { Accept: 'application/json' } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: JSON.stringify(body) };
    try { const r = await fetch(url, opt); return await r.json(); } catch (e) { return { ok: false, message: 'Lỗi kết nối, thử lại' }; }
  }
  async function upload(url, fields, file, field) {
    const fd = new FormData();
    fd.append('_csrf', csrf);
    Object.entries(fields || {}).forEach(([k, v]) => fd.append(k, v));
    if (file) fd.append(field, file, file.name || field + '.webp');
    try { const r = await fetch(url, { method: 'POST', body: fd, headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' } }); return await r.json(); } catch (e) { return { ok: false, message: 'Lỗi kết nối, thử lại' }; }
  }
  const imgCache = new Map();
  function loadImg(src) {
    if (!src) return Promise.resolve(null);
    if (imgCache.has(src)) return imgCache.get(src);
    const p = new Promise((res) => { const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
    imgCache.set(src, p);
    return p;
  }
  const imgNow = {}; // src -> ảnh đã tải xong (vẽ đồng bộ)
  async function preload(srcs) { await Promise.all([...new Set(srcs.filter(Boolean))].map(async (s) => { imgNow[s] = await loadImg(s); })); }
  function toast(msg, err) {
    const t = $('[data-ai-toast]', app);
    t.textContent = msg; t.className = 'ai-toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3500);
  }

  // ---------- Mẫu bố cục (tỉ lệ 0..1 theo chiều rộng / cao ảnh) ----------
  const SIZES = [['2000x1070', '2000 × 1070 (như ảnh mẫu)'], ['1920x1080', '1920 × 1080 (16:9)'], ['1500x900', '1500 × 900 (5:3 — thẻ sản phẩm)'], ['1200x1200', '1200 × 1200 (vuông)'], ['1080x1350', '1080 × 1350 (dọc 4:5)'], ['custom', 'Tự nhập']];
  const BLOCKS = [['chars', 'Lưới nhân vật'], ['weapons', 'Lưới vũ khí'], ['info', 'Thẻ thông tin'], ['note', 'Khung ghi chú'], ['stats', 'Thống kê nhanh'], ['code', 'Mã acc'], ['logo', 'Logo']];
  const TPL = {
    A: {
      name: 'Mẫu A — như ảnh mẫu', W: 2000, H: 1070, dark: 0.15, blur: 0,
      blocks: { info: [0.01, 0.012, 0.31, 0.255], chars: [0.01, 0.28, 0.31, 0.71], weapons: [0.51, 0.585, 0.48, 0.405], code: [0.6, 0.015, 0.385, 0.11], stats: [0.6, 0.135, 0.385, 0.06], note: [0.785, 0.33, 0.2, 0.23], logo: [0.335, 0.86, 0.09, 0.12] },
      on: { info: 1, chars: 1, weapons: 1, code: 1, stats: 0, note: 0, logo: 0 }, grids: { c: [6, 6], w: [8, 3] },
    },
    B: {
      name: 'Mẫu B — nhân vật trên, vũ khí dưới', W: 2000, H: 1070, dark: 0.45, blur: 6,
      blocks: { info: [0.015, 0.03, 0.3, 0.2], code: [0.55, 0.03, 0.43, 0.12], stats: [0.33, 0.07, 0.3, 0.07], note: [0.33, 0.155, 0.3, 0.09], chars: [0.015, 0.27, 0.97, 0.42], weapons: [0.015, 0.71, 0.97, 0.27], logo: [0.87, 0.165, 0.11, 0.09] },
      on: { info: 1, chars: 1, weapons: 1, code: 1, stats: 1, note: 0, logo: 0 }, grids: { c: [12, 3], w: [14, 2] },
    },
    C: {
      name: 'Mẫu C — 5:3 gọn (ảnh đại diện)', W: 1500, H: 900, dark: 0.35, blur: 4,
      blocks: { code: [0.03, 0.03, 0.5, 0.13], stats: [0.03, 0.165, 0.6, 0.07], info: [0.62, 0.03, 0.35, 0.2], note: [0.62, 0.16, 0.35, 0.08], chars: [0.03, 0.26, 0.94, 0.44], weapons: [0.03, 0.72, 0.94, 0.25], logo: [0.84, 0.84, 0.13, 0.12] },
      on: { info: 0, chars: 1, weapons: 1, code: 1, stats: 1, note: 0, logo: 0 }, grids: { c: [8, 2], w: [9, 1] },
    },
  };
  const blank = () => ({
    W: 2000, H: 1070, game: '', tpl: 'A', product: null,
    bg: { src: '', x: 0.5, y: 0.5, zoom: 1, dark: 0.15, blur: 0, color: '#141a33' },
    blocks: JSON.parse(JSON.stringify(TPL.A.blocks)), on: { ...TPL.A.on },
    info: { name: '', uid: '', mask: true, lv: '', server: '', extra: '', color: '#ffffff', bg: '', bgDark: 0.3 },
    grids: {
      c: { cols: 6, rows: 6, over: 'more', lv: true, k: true, items: [] },
      w: { cols: 8, rows: 3, over: 'more', lv: true, k: true, items: [] },
    },
    code: { text: '', auto: true, server: true, color: '#ffffff' },
    note: { text: '' },
    logo: { src: B.logo || '', op: 0.85 },
    panel: 0.72,
    fx: { filter: 'none', amount: 100, tone: {} },
  });
  function applyTpl(st, t) {
    st.W = t.W; st.H = t.H;
    st.blocks = JSON.parse(JSON.stringify(t.blocks));
    st.on = { ...t.on };
    if (t.grids) { st.grids.c.cols = t.grids.c[0]; st.grids.c.rows = t.grids.c[1]; st.grids.w.cols = t.grids.w[0]; st.grids.w.rows = t.grids.w[1]; }
    if (t.dark != null) st.bg.dark = t.dark;
    if (t.blur != null) st.bg.blur = t.blur;
    // mẫu đã lưu: mang theo cả kiểu lưới, mã acc, nền, logo, độ đậm khung
    if (t.gridOpt) ['c', 'w'].forEach((k) => Object.assign(st.grids[k], t.gridOpt[k] || {}));
    if (t.codeOpt) Object.assign(st.code, t.codeOpt);
    if (t.bgOpt) Object.assign(st.bg, t.bgOpt);
    if (t.logoOpt) Object.assign(st.logo, t.logoOpt);
    if (t.infoOpt) Object.assign(st.info, t.infoOpt);
    if (t.fx) st.fx = JSON.parse(JSON.stringify(t.fx));
    if (t.panel != null) st.panel = t.panel;
    if (t.note != null) st.note.text = t.note;
  }
  /** Lưu mẫu: chỉ bố cục + kiểu, không mang dữ liệu acc */
  const tplOf = (st) => ({
    W: st.W, H: st.H, blocks: st.blocks, on: st.on, panel: st.panel,
    grids: { c: [st.grids.c.cols, st.grids.c.rows], w: [st.grids.w.cols, st.grids.w.rows] },
    gridOpt: { c: { over: st.grids.c.over, lv: st.grids.c.lv, k: st.grids.c.k }, w: { over: st.grids.w.over, lv: st.grids.w.lv, k: st.grids.w.k } },
    codeOpt: { auto: st.code.auto, server: st.code.server, color: st.code.color },
    bgOpt: { src: /^\/uploads\//.test(st.bg.src) ? st.bg.src : '', x: st.bg.x, y: st.bg.y, zoom: st.bg.zoom, dark: st.bg.dark, blur: st.bg.blur, color: st.bg.color },
    logoOpt: { op: st.logo.op }, note: st.note.text,
    fx: st.fx,
    infoOpt: { color: st.info.color || '#ffffff', bg: /^\/uploads\//.test(st.info.bg || '') ? st.info.bg : '', bgDark: st.info.bgDark },
  });

  // ---------- Dữ liệu acc -> trạng thái ----------
  const G = (st) => B.games[st.game] || { lv: 'Cấp', c: 'C', w: 'Vũ khí', r: 'R', r5: '5★', r4: '4★' };
  function fromDetail(st, d, product) {
    st.product = product ? { id: product.id, code: product.code, title: product.title, images: product.images || [] } : null;
    if (d && B.games[d.game]) st.game = d.game;
    else if (product && B.games[product.game]) st.game = product.game;
    if (!d) return st;
    st.info.lv = d.lv || '';
    st.info.server = d.server || '';
    st.info.uid = d.uid || '';
    const ch = (list, r) => (list || []).map((x) => ({ n: x.n, i: x.ic || '', r, lv: x.l || '', k: x.k || 0, on: true }));
    const wp = (list, r) => (list || []).map((x) => ({ n: x.n, i: x.ic || '', r, lv: x.l || '', k: x.r || 0, on: true }));
    st.grids.c.items = [...ch(d.c5, 5), ...ch(d.c4, 4)];
    st.grids.w.items = [...wp(d.w5, 5), ...wp(d.w4, 4)];
    return st;
  }
  const SV = { asia: 'AS', america: 'NA', europe: 'EU', 'tw/hk/mo': 'TW', cn: 'CN' };
  const svShort = (s) => SV[fold(s)] || String(s || '').split(/[\s/]/)[0].toUpperCase();
  function codeText(st) {
    if (!st.code.auto) return st.code.text;
    const base = st.product ? st.product.code : (st.code.text || '').replace(/\s+\S+$/, '');
    return [base, st.code.server && st.info.server ? svShort(st.info.server) : ''].filter(Boolean).join(' ');
  }
  const maskUid = (u) => { u = String(u || ''); return u.length > 6 ? u.slice(0, 3) + '•••' + u.slice(-3) : u; };
  function sortItems(items) {
    return items.slice().sort((a, b) => (b.r - a.r) || ((parseInt(b.lv, 10) || 0) - (parseInt(a.lv, 10) || 0)) || ((b.k || 0) - (a.k || 0)) || a.n.localeCompare(b.n));
  }
  const srcsOf = (st) => [st.bg.src, st.logo.src, st.info.bg, ...st.grids.c.items.map((x) => x.i), ...st.grids.w.items.map((x) => x.i)];

  // ---------- Vẽ ----------
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fitFont(ctx, text, maxW, maxH, weight) {
    let size = Math.max(6, maxH);
    ctx.font = `${weight} ${size}px ${FONT}`;
    const w = ctx.measureText(text).width;
    if (w > maxW && w > 0) size = Math.max(6, size * maxW / w);
    ctx.font = `${weight} ${size}px ${FONT}`;
    return size;
  }
  const RAR = { 5: ['#a5662f', '#e3a64f'], 4: ['#5e4aa0', '#9a78d6'], 3: ['#2f5d9e', '#4f8fd8'], 0: ['#5d6273', '#8a8fa3'] };
  function panel(ctx, st, x, y, w, h, s) {
    ctx.save();
    rr(ctx, x, y, w, h, s * 0.012);
    ctx.fillStyle = `rgba(14, 18, 38, ${st.panel})`; ctx.fill();
    ctx.lineWidth = Math.max(1, s * 0.0012); ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.stroke();
    ctx.restore();
  }
  let blurCache = { key: '', c: null };
  function drawBg(ctx, st) {
    const { W, H, bg } = st;
    ctx.fillStyle = bg.color || '#141a33'; ctx.fillRect(0, 0, W, H);
    const im = imgNow[bg.src];
    if (im) {
      const sc = Math.max(W / im.width, H / im.height) * (bg.zoom || 1);
      const dw = im.width * sc; const dh = im.height * sc;
      const dx = (W - dw) * clamp(bg.x, 0, 1); const dy = (H - dh) * clamp(bg.y, 0, 1);
      if (bg.blur > 0) { // làm mờ: thu nhỏ rồi phóng to (chạy được trên mọi trình duyệt); nhớ sẵn để kéo khối không phải tính lại
        const key = [bg.src, W, H, bg.zoom, bg.x, bg.y, bg.blur].join('|');
        if (blurCache.key !== key) {
          const k = 1 / (1 + bg.blur * 0.6);
          const t = document.createElement('canvas'); t.width = Math.max(1, Math.round(W * k)); t.height = Math.max(1, Math.round(H * k));
          const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high'; tc.drawImage(im, dx * k, dy * k, dw * k, dh * k);
          blurCache = { key, c: t };
        }
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(blurCache.c, 0, 0, W, H);
      } else { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(im, dx, dy, dw, dh); }
    } else {
      const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, 'rgba(90,70,200,.35)'); g.addColorStop(1, 'rgba(20,140,200,.25)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }
    if (bg.dark > 0) { ctx.fillStyle = `rgba(0,0,0,${bg.dark})`; ctx.fillRect(0, 0, W, H); }
  }
  const rect = (st, key) => { const b = st.blocks[key] || [0, 0, 0.1, 0.1]; return { x: b[0] * st.W, y: b[1] * st.H, w: b[2] * st.W, h: b[3] * st.H }; };

  /** Bố cục lưới: trả về ô đã tính sẵn (dùng cả để vẽ lẫn để chọn ô khi kéo đổi thứ tự) */
  function gridLayout(st, key) {
    const g = st.grids[key === 'chars' ? 'c' : 'w'];
    const R = rect(st, key);
    const items = g.items.filter((x) => x.on);
    const n = items.length;
    let cols = Math.max(1, g.cols | 0); let rows = Math.max(1, g.rows | 0);
    if (g.over === 'grow') rows = Math.max(rows, Math.ceil(n / cols));
    const cap = rows * cols;
    let show = items; let more = 0;
    if (n > cap) { if (g.over === 'more') { show = items.slice(0, cap - 1); more = n - (cap - 1); } else show = items.slice(0, cap); }
    const usedRows = Math.max(1, Math.min(rows, Math.ceil((show.length + (more ? 1 : 0)) / cols)));
    const s = Math.min(st.W, st.H * 1.87);
    const pad = s * 0.008; const gap = s * 0.006;
    const hasLv = g.lv && show.some((x) => x.lv);
    const asp = hasLv ? 1.2 : 1;
    let cw = (R.w - 2 * pad - gap * (cols - 1)) / cols;
    const needH = usedRows * cw * asp + gap * (usedRows - 1) + 2 * pad;
    if (needH > R.h) cw = (R.h - 2 * pad - gap * (usedRows - 1)) / (usedRows * asp);
    cw = Math.max(4, cw);
    const ch = cw * asp;
    const gw = cols * cw + (cols - 1) * gap;
    const x0 = R.x + (R.w - gw) / 2; const y0 = R.y + pad;
    const cells = show.map((it, i) => ({ it, x: x0 + (i % cols) * (cw + gap), y: y0 + Math.floor(i / cols) * (ch + gap), w: cw, h: ch }));
    const moreCell = more ? { x: x0 + (show.length % cols) * (cw + gap), y: y0 + Math.floor(show.length / cols) * (ch + gap), w: cw, h: ch, more } : null;
    const box = { x: x0 - pad, y: R.y, w: gw + 2 * pad, h: usedRows * ch + (usedRows - 1) * gap + 2 * pad };
    return { g, cells, moreCell, hasLv, box, kind: key === 'chars' ? 'c' : 'w', n };
  }
  function drawCell(ctx, st, c, L) {
    const { x, y, w, h, it } = c;
    const r = w * 0.1;
    ctx.save();
    rr(ctx, x, y, w, h, r); ctx.clip();
    const col = RAR[it.r] || RAR[0];
    const gr = ctx.createLinearGradient(x, y, x + w * 0.6, y + w); gr.addColorStop(0, col[0]); gr.addColorStop(1, col[1]);
    ctx.fillStyle = gr; ctx.fillRect(x, y, w, h);
    const im = imgNow[it.i];
    if (im) { const sc = Math.max(w / im.width, w / im.height); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(im, x + (w - im.width * sc) / 2, y + (w - im.height * sc) / 2, im.width * sc, im.height * sc); } else {
      ctx.fillStyle = 'rgba(255,255,255,.9)'; fitFont(ctx, (it.n || '?').slice(0, 1).toUpperCase(), w * 0.6, w * 0.5, 800);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText((it.n || '?').slice(0, 1).toUpperCase(), x + w / 2, y + w / 2);
    }
    if (L.hasLv) {
      const bh = h - w;
      ctx.fillStyle = '#efe9dc'; ctx.fillRect(x, y + w, w, bh);
      if (it.lv) { ctx.fillStyle = '#4a4540'; fitFont(ctx, 'Lv.' + it.lv, w * 0.86, bh * 0.66, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Lv.' + it.lv, x + w / 2, y + w + bh / 2 + bh * 0.04); }
    }
    ctx.restore();
    const kk = L.kind === 'c' ? it.k > 0 : it.k > 1;
    if (L.g.k && kk) {
      const g = G(st);
      const t = (L.kind === 'c' ? g.c : g.r) + it.k;
      const bs = w * 0.26;
      ctx.save(); ctx.font = `800 ${bs * 0.68}px ${FONT}`;
      const tw = ctx.measureText(t).width + bs * 0.5;
      rr(ctx, x + w * 0.05, y + w * 0.05, tw, bs, bs / 2); ctx.fillStyle = 'rgba(10,10,20,.72)'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x + w * 0.05 + tw / 2, y + w * 0.05 + bs / 2 + bs * 0.04);
      ctx.restore();
    }
  }
  function drawGrid(ctx, st, key, guides) {
    const L = gridLayout(st, key);
    if (!L.cells.length) {
      if (guides) { const R = rect(st, key); ctx.save(); ctx.fillStyle = 'rgba(255,255,255,.55)'; fitFont(ctx, key === 'chars' ? 'Chưa có nhân vật' : 'Chưa có vũ khí', R.w * 0.8, Math.min(R.h * 0.12, 40), 600); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(key === 'chars' ? 'Chưa có nhân vật' : 'Chưa có vũ khí', R.x + R.w / 2, R.y + R.h / 2); ctx.restore(); }
      return L;
    }
    const s = Math.min(st.W, st.H * 1.87);
    panel(ctx, st, L.box.x, L.box.y, L.box.w, L.box.h, s);
    L.cells.forEach((c) => drawCell(ctx, st, c, L));
    if (L.moreCell) {
      const m = L.moreCell;
      ctx.save(); rr(ctx, m.x, m.y, m.w, m.h, m.w * 0.1); ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fill();
      ctx.fillStyle = '#fff'; fitFont(ctx, '+' + m.more, m.w * 0.8, m.w * 0.36, 800); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('+' + m.more, m.x + m.w / 2, m.y + m.h / 2); ctx.restore();
    }
    return L;
  }
  function drawInfo(ctx, st) {
    const R = rect(st, 'info'); const s = Math.min(st.W, st.H * 1.87); const g = G(st);
    const ib = imgNow[st.info.bg];
    if (ib) { // ảnh nền riêng của khung thông tin: chỉ vẽ trong khung (cắt theo góc bo)
      ctx.save(); rr(ctx, R.x, R.y, R.w, R.h, s * 0.012); ctx.clip();
      const sc = Math.max(R.w / ib.width, R.h / ib.height); ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(ib, R.x + (R.w - ib.width * sc) / 2, R.y + (R.h - ib.height * sc) / 2, ib.width * sc, ib.height * sc);
      if (st.info.bgDark > 0) { ctx.fillStyle = `rgba(0,0,0,${st.info.bgDark})`; ctx.fillRect(R.x, R.y, R.w, R.h); }
      ctx.restore();
      ctx.save(); rr(ctx, R.x, R.y, R.w, R.h, s * 0.012); ctx.lineWidth = Math.max(1, s * 0.0012); ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.stroke(); ctx.restore();
    } else panel(ctx, st, R.x, R.y, R.w, R.h, s);
    const tc = st.info.color || '#ffffff';
    const p = R.h * 0.1;
    const lines = [];
    if (st.info.uid) lines.push(['UID', st.info.mask ? maskUid(st.info.uid) : st.info.uid]);
    if (st.info.lv) lines.push([g.lv, String(st.info.lv)]);
    if (st.info.server) lines.push(['Máy chủ', st.info.server]);
    String(st.info.extra || '').split('\n').map((x) => x.trim()).filter(Boolean).forEach((x) => { const i = x.indexOf(':'); lines.push(i > 0 ? [x.slice(0, i).trim(), x.slice(i + 1).trim()] : [x, '']); });
    const name = st.info.name || '';
    const nameH = name ? R.h * 0.26 : 0;
    const rows = Math.max(1, lines.length);
    const lh = Math.min((R.h - 2 * p - nameH) / rows, R.h * 0.22);
    ctx.save(); ctx.textBaseline = 'middle';
    if (name) { ctx.fillStyle = tc; fitFont(ctx, name, R.w - 2 * p, nameH * 0.86, 800); ctx.textAlign = 'left'; ctx.fillText(name, R.x + p, R.y + p + nameH / 2); }
    lines.forEach(([k, v], i) => {
      const cy = R.y + p + nameH + lh * (i + 0.5);
      ctx.fillStyle = tc; ctx.globalAlpha = 0.82; fitFont(ctx, k, (R.w - 2 * p) * 0.5, lh * 0.7, 600); ctx.textAlign = 'left'; ctx.fillText(k, R.x + p, cy); ctx.globalAlpha = 1;
      if (v) { ctx.fillStyle = tc; fitFont(ctx, v, (R.w - 2 * p) * 0.48, lh * 0.76, 700); ctx.textAlign = 'right'; ctx.fillText(v, R.x + R.w - p, cy); }
      if (i < lines.length - 1) { ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(R.x + p, cy + lh / 2, R.w - 2 * p, Math.max(1, s * 0.0008)); }
    });
    ctx.restore();
  }
  function statsText(st) {
    const g = G(st); const lab = (n) => { const v = g['r' + n] || n + '★'; return v.includes('★') ? v : 'hạng ' + v; };
    const c5 = st.grids.c.items.filter((x) => x.on && x.r === 5).length;
    const w5 = st.grids.w.items.filter((x) => x.on && x.r === 5).length;
    return [c5 ? `${c5} nhân vật ${lab(5)}` : '', w5 ? `${w5} ${g.w} ${lab(5)}` : '', st.info.lv ? `${g.lv} ${st.info.lv}` : ''].filter(Boolean).join('  ·  ');
  }
  function drawStats(ctx, st) {
    const t = statsText(st); if (!t) return;
    const R = rect(st, 'stats'); const s = Math.min(st.W, st.H * 1.87);
    ctx.save(); const size = fitFont(ctx, t, R.w * 0.92, R.h * 0.55, 700);
    const tw = ctx.measureText(t).width + size * 1.4;
    const left = R.x + R.w / 2 > st.W / 2 ? R.x + R.w - tw : R.x;
    panel(ctx, st, left, R.y, tw, R.h, s);
    ctx.fillStyle = '#ffe9a8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, left + tw / 2, R.y + R.h / 2 + size * 0.04);
    ctx.restore();
  }
  function drawCode(ctx, st) {
    const t = codeText(st); if (!t) return;
    const R = rect(st, 'code');
    ctx.save();
    const size = fitFont(ctx, t, R.w, R.h * 0.92, 800);
    const right = R.x + R.w / 2 > st.W / 2;
    ctx.textAlign = right ? 'right' : 'left'; ctx.textBaseline = 'middle';
    const x = right ? R.x + R.w : R.x; const y = R.y + R.h / 2;
    ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.09; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.strokeText(t, x, y);
    ctx.shadowColor = 'rgba(0,0,0,.45)'; ctx.shadowBlur = size * 0.12;
    ctx.fillStyle = st.code.color || '#fff'; ctx.fillText(t, x, y);
    ctx.restore();
  }
  function drawNote(ctx, st) {
    const lines = String(st.note.text || '').split('\n').map((x) => x.trim()).filter(Boolean);
    if (!lines.length) return;
    const R = rect(st, 'note'); const s = Math.min(st.W, st.H * 1.87);
    panel(ctx, st, R.x, R.y, R.w, R.h, s);
    const p = R.h * 0.08; const lh = Math.min((R.h - 2 * p) / lines.length, R.h * 0.3);
    ctx.save(); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => { fitFont(ctx, l, R.w - 2 * p, lh * 0.6, 600); ctx.fillText(l, R.x + p, R.y + p + lh * (i + 0.5)); });
    ctx.restore();
  }
  function drawLogo(ctx, st) {
    const im = imgNow[st.logo.src]; if (!im) return;
    const R = rect(st, 'logo');
    const sc = Math.min(R.w / im.width, R.h / im.height);
    ctx.save(); ctx.globalAlpha = clamp(st.logo.op, 0.05, 1);
    ctx.drawImage(im, R.x + (R.w - im.width * sc) / 2, R.y + (R.h - im.height * sc) / 2, im.width * sc, im.height * sc);
    ctx.restore();
  }
  /** Vẽ toàn bộ ảnh. guides = khung chọn / tay nắm (chỉ ở bản xem trước, không vào ảnh xuất) */
  function render(ctx, st, guides, sel) {
    drawBg(ctx, st);
    const out = {};
    if (st.on.chars) out.chars = drawGrid(ctx, st, 'chars', guides);
    if (st.on.weapons) out.weapons = drawGrid(ctx, st, 'weapons', guides);
    if (st.on.info) drawInfo(ctx, st);
    if (st.on.note) drawNote(ctx, st);
    if (st.on.stats) drawStats(ctx, st);
    if (st.on.code) drawCode(ctx, st);
    if (st.on.logo) drawLogo(ctx, st);
    if (guides && sel && st.on[sel]) {
      const R = rect(st, sel); const s = Math.min(st.W, st.H * 1.87); const hs = s * 0.018;
      ctx.save(); ctx.setLineDash([s * 0.008, s * 0.006]); ctx.lineWidth = Math.max(2, s * 0.0018); ctx.strokeStyle = '#4fd1ff'; ctx.strokeRect(R.x, R.y, R.w, R.h);
      ctx.setLineDash([]); ctx.fillStyle = '#4fd1ff'; ctx.fillRect(R.x + R.w - hs, R.y + R.h - hs, hs, hs);
      ctx.restore();
    }
    return out;
  }
  /** Ảnh xuất: canvas đúng cỡ, không khung chọn */
  // ---------- Bộ lọc & tông màu (áp cho toàn ảnh) ----------
  // Tông màu: [khóa, nhãn, min, max]
  const TONES = [['bright', 'Độ sáng', -100, 100], ['contrast', 'Tương phản', -100, 100], ['sat', 'Độ bão hòa', -100, 100], ['vib', 'Độ sống động', -100, 100],
    ['warm', 'Nhiệt độ', -100, 100], ['tint', 'Sắc thái', -100, 100], ['hi', 'Vùng sáng', -100, 100], ['sh', 'Vùng tối', -100, 100],
    ['sharp', 'Độ nét', 0, 100], ['vig', 'Làm tối viền', 0, 100], ['fade', 'Phai màu', 0, 100]];
  // Bộ lọc = bộ tông màu dựng sẵn (+ trắng đen / sepia / tách tông) — độ mạnh 0..100%
  const FILTERS = [
    ['none', 'Gốc', {}],
    ['vivid', 'Sống động', { sat: 30, vib: 25, contrast: 12 }],
    ['pop', 'Rực rỡ', { sat: 45, contrast: 20, sharp: 30, bright: 4 }],
    ['warm', 'Ấm áp', { warm: 30, sat: 8 }],
    ['cool', 'Mát lạnh', { warm: -30, tint: -5 }],
    ['cinema', 'Điện ảnh', { contrast: 15, sat: -8, split: 45, vig: 25 }],
    ['dream', 'Mơ màng', { bright: 8, contrast: -12, sat: 10, fade: 18, warm: 6 }],
    ['retro', 'Hoài cổ', { fade: 28, sat: -22, warm: 18, contrast: -6 }],
    ['night', 'Đêm', { bright: -10, warm: -25, contrast: 18, vig: 40 }],
    ['sepia', 'Nâu cổ', { sepia: 85, contrast: 6 }],
    ['bw', 'Trắng đen', { gray: 100, contrast: 10 }],
    ['noir', 'Noir', { gray: 100, contrast: 38, vig: 35 }],
  ];
  const fxActive = (fx) => !!fx && ((fx.filter && fx.filter !== 'none' && fx.amount > 0) || Object.values(fx.tone || {}).some((v) => +v));
  function fxParams(fx) {
    const F = (FILTERS.find((f) => f[0] === fx.filter) || FILTERS[0])[2]; const k = (fx.amount == null ? 100 : fx.amount) / 100;
    const P = {};
    ['bright', 'contrast', 'sat', 'vib', 'warm', 'tint', 'hi', 'sh', 'sharp', 'vig', 'fade', 'sepia', 'gray', 'split'].forEach((key) => { P[key] = (+((fx.tone || {})[key]) || 0) + (F[key] || 0) * k; });
    return P;
  }
  /** Áp bộ lọc + tông màu lên ctx (W×H). Chạy 1 vòng qua điểm ảnh, độ nét thêm 1 vòng. */
  function applyFx(ctx, W, H, fx) {
    if (!fxActive(fx)) return;
    const P = fxParams(fx);
    const img = ctx.getImageData(0, 0, W, H); const d = img.data;
    const cv = clamp(P.contrast, -100, 100) * 2.55; const cf = (259 * (cv + 255)) / (255 * (259 - cv));
    const bv = P.bright * 1.2; const sf = 1 + clamp(P.sat, -100, 100) / 100; const vb = P.vib / 100;
    const wr = P.warm * 0.45; const tn = P.tint * 0.35; const hi = P.hi / 100; const sh = P.sh / 100;
    const fade = clamp(P.fade, 0, 100) * 0.55; const sep = clamp(P.sepia, 0, 100) / 100; const gray = clamp(P.gray, 0, 100) / 100; const split = clamp(P.split, 0, 100) / 100;
    const vig = clamp(P.vig, 0, 100) / 100; const cx = W / 2; const cy = H / 2; const md = cx * cx + cy * cy;
    for (let y = 0, i = 0; y < H; y++) {
      const dy = (y - cy) * (y - cy);
      for (let x = 0; x < W; x++, i += 4) {
        let r = d[i]; let g = d[i + 1]; let b = d[i + 2];
        r += wr + bv; g += bv - tn; b += bv - wr; // cân bằng trắng + sáng
        if (hi || sh) { const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255; const lt = hi * l * l * 70 + sh * (1 - l) * (1 - l) * 70; r += lt; g += lt; b += lt; } // vùng sáng / vùng tối
        r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; b = cf * (b - 128) + 128;
        let gr = 0.299 * r + 0.587 * g + 0.114 * b;
        if (vb) { const mx = Math.max(r, g, b); const amt = vb * (1 - Math.abs(mx - gr) / 128); r = gr + (r - gr) * (1 + amt); g = gr + (g - gr) * (1 + amt); b = gr + (b - gr) * (1 + amt); }
        if (sf !== 1) { r = gr + (r - gr) * sf; g = gr + (g - gr) * sf; b = gr + (b - gr) * sf; }
        if (gray) { gr = 0.299 * r + 0.587 * g + 0.114 * b; r += (gr - r) * gray; g += (gr - g) * gray; b += (gr - b) * gray; }
        if (sep) { const sr = 0.393 * r + 0.769 * g + 0.189 * b; const sg = 0.349 * r + 0.686 * g + 0.168 * b; const sb = 0.272 * r + 0.534 * g + 0.131 * b; r += (sr - r) * sep; g += (sg - g) * sep; b += (sb - b) * sep; }
        if (split) { const l = clamp((0.299 * r + 0.587 * g + 0.114 * b) / 255, 0, 1); const s2 = (1 - l) * split * 40; const h2 = l * split * 40; r += h2 - s2 * 0.6; g += -h2 * 0.1 + s2 * 0.25; b += s2 - h2 * 0.7; } // vùng tối xanh ngọc, vùng sáng cam
        if (fade) { r = fade + r * (1 - fade / 255); g = fade + g * (1 - fade / 255); b = fade + b * (1 - fade / 255); }
        if (vig) { const f = 1 - vig * 0.85 * Math.pow(((x - cx) * (x - cx) + dy) / md, 1.3); r *= f; g *= f; b *= f; }
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }
    if (P.sharp > 0) { // làm nét: nhân chập 3x3 (tăng chi tiết cạnh)
      const k = clamp(P.sharp, 0, 100) / 100 * 0.9; const src = new Uint8ClampedArray(d); const row = W * 4;
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * row + x * 4;
        for (let c = 0; c < 3; c++) { const v = src[i + c] * (1 + 4 * k) - k * (src[i + c - 4] + src[i + c + 4] + src[i + c - row] + src[i + c + row]); d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v; }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  async function exportBlob(st, type = 'image/webp', q = 0.92) {
    await preload(srcsOf(st));
    const c = document.createElement('canvas'); c.width = st.W; c.height = st.H;
    render(c.getContext('2d'), st, false);
    applyFx(c.getContext('2d'), st.W, st.H, st.fx);
    return new Promise((res) => c.toBlob((b) => res(b), type, q));
  }

  window.AIC = {
    B, app, csrf, $, $$, esc, fold, clamp, api, upload, loadImg, preload, imgNow, toast, TONES, FILTERS, applyFx, fxActive,
    SIZES, BLOCKS, TPL, blank, applyTpl, tplOf, fromDetail, codeText, svShort, maskUid, sortItems, srcsOf, G,
    render, rect, gridLayout, exportBlob, rr, fitFont, FONT,
  };
})();
