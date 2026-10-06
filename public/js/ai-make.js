/* Tạo ảnh acc — chế độ dựng ảnh: bảng điều khiển, kéo / đổi cỡ khối, kéo nền, đổi thứ tự ô, hoàn tác, mẫu, xuất ảnh. Kèm bộ chuyển chế độ. */
(() => {
  'use strict';
  const A = window.AIC;
  if (!A) return;
  const { B, app, $, $$, esc, fold, clamp, api, upload, preload, imgNow, toast } = A;
  const canvas = $('[data-ai-canvas]', app);
  const ctx = canvas.getContext('2d');
  const tabsEl = $('[data-ai-tabs]', app);
  const bodyEl = $('[data-ai-body]', app);
  const barEl = $('[data-ai-bar]', app);

  // ---------- Bộ chuyển chế độ (Tạo ảnh / Sửa ảnh / Hàng loạt) ----------
  const MODES = {};
  const AIM = window.AIM = { MODES, canvas, ctx, tabsEl, bodyEl, barEl, current: '' };
  AIM.setMode = (m) => {
    if (!MODES[m]) return;
    if (AIM.current && MODES[AIM.current].leave) MODES[AIM.current].leave();
    AIM.current = m;
    $$('[data-ai-mode]', app).forEach((b) => b.classList.toggle('on', b.dataset.aiMode === m));
    app.dataset.mode = m;
    MODES[m].enter();
  };
  $$('[data-ai-mode]', app).forEach((b) => b.addEventListener('click', () => AIM.setMode(b.dataset.aiMode)));
  document.addEventListener('DOMContentLoaded', () => AIM.setMode(MODES[B.mode] ? B.mode : 'make'));
  /** Gửi ảnh về form sản phẩm đã mở trang này (nếu có) */
  AIM.toForm = (msg) => { try { if (B.fromForm && window.opener && !window.opener.closed) { window.opener.postMessage(Object.assign({ type: 'accimg' }, msg), location.origin); return true; } } catch (e) { /* bỏ qua */ } return false; };
  AIM.download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500); };
  AIM.libCache = {};
  AIM.lib = (game) => { if (!game) return Promise.resolve({ c: [], w: [] }); if (!AIM.libCache[game]) AIM.libCache[game] = api('/admin/hoyo/lib/' + game).then((r) => (r && r.ok ? r : { c: [], w: [] })); return AIM.libCache[game]; };

  // ---------- Trạng thái ----------
  let st = A.blank();
  A.applyTpl(st, A.TPL.A);
  let sel = '';
  let tab = 'tpl';
  let last = {}; // bố cục lưới lần vẽ gần nhất (để chọn ô)
  const hist = []; let hi = -1; let commitT = 0;
  const snap = () => JSON.stringify(st);
  function commitNow() { const s = snap(); if (hist[hi] === s) return; hist.splice(hi + 1); hist.push(s); if (hist.length > 30) hist.shift(); hi = hist.length - 1; bar(); }
  const commit = () => { clearTimeout(commitT); commitT = setTimeout(commitNow, 350); };
  function restore(s) { st = JSON.parse(s); preload(A.srcsOf(st)).then(draw); renderPanel(); bar(); }
  const undo = () => { commitNow(); if (hi > 0) restore(hist[--hi]); };
  const redo = () => { if (hi < hist.length - 1) restore(hist[++hi]); };

  let raf = 0;
  // Khung của khối: lưới nhân vật / vũ khí dùng đúng vùng lưới đang vẽ (ôm sát các ô), khối khác dùng khung đã đặt
  function boxOf(key) { const L = last[key]; return (key === 'chars' || key === 'weapons') && L && L.cells.length ? L.box : A.rect(st, key); }
  const uiK = () => st.W / Math.max(1, canvas.clientWidth || st.W); // 1 px màn hình = bao nhiêu px ảnh
  const handleSize = () => Math.max(Math.min(st.W, st.H * 1.87) * 0.02, 26 * uiK());
  function drawNow() {
    raf = 0;
    if (canvas.width !== st.W || canvas.height !== st.H) { canvas.width = st.W; canvas.height = st.H; }
    last = A.render(ctx, st, true, '') || {};
    // viền mờ cho mọi khối đang hiện (biết là kéo được), khối đang chọn viền xanh + tay nắm đổi cỡ ở góc
    const k = uiK(); const lw = Math.max(1, 1.5 * k);
    ctx.save();
    A.BLOCKS.forEach(([key]) => {
      if (!st.on[key]) return;
      const R = boxOf(key); const on = key === sel;
      ctx.setLineDash(on ? [6 * k, 4 * k] : [4 * k, 4 * k]); ctx.lineWidth = on ? lw * 1.6 : lw;
      ctx.strokeStyle = on ? '#4fd1ff' : 'rgba(255,255,255,.35)'; ctx.strokeRect(R.x, R.y, R.w, R.h);
      if (on) { const hs = handleSize(); ctx.setLineDash([]); ctx.fillStyle = '#4fd1ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = lw; ctx.fillRect(R.x + R.w - hs / 2, R.y + R.h - hs / 2, hs, hs); ctx.strokeRect(R.x + R.w - hs / 2, R.y + R.h - hs / 2, hs, hs); }
    });
    ctx.restore();
  }
  /** Bắt đầu kéo lưới: khớp khối theo đúng vùng lưới để kéo to / nhỏ theo góc lưới */
  function snapBlock(key) { if (key !== 'chars' && key !== 'weapons') return; const L = last[key]; if (!L || !L.cells.length) return; const b = L.box; st.blocks[key] = [b.x / st.W, b.y / st.H, b.w / st.W, b.h / st.H]; }
  const draw = () => { if (!raf) raf = requestAnimationFrame(drawNow); };
  const changed = () => { draw(); commit(); };

  // ---------- Dữ liệu ban đầu: từ form sản phẩm (cửa sổ mở trang này) hoặc ?product= ----------
  function boot() {
    let src = null;
    try { if (B.fromForm && window.opener && window.opener.__accImg) src = JSON.parse(JSON.stringify(window.opener.__accImg)); } catch (e) { src = null; }
    if (src) A.fromDetail(st, src.detail, { id: src.productId || 0, code: src.code || '', title: src.title || '', game: src.game, images: [] });
    else if (B.product) A.fromDetail(st, B.product.detail, B.product);
    if (src && !src.productId && src.code) st.product = { id: 0, code: src.code, title: src.title || '', images: [] };
  }

  // ---------- Bảng điều khiển ----------
  const TABS = [['tpl', 'Mẫu & cỡ'], ['data', 'Acc'], ['bg', 'Nền'], ['info', 'Thông tin'], ['c', 'Nhân vật'], ['w', 'Vũ khí'], ['text', 'Mã & chữ'], ['logo', 'Logo']];
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), st);
  function set(path, v) { const ks = path.split('.'); const k = ks.pop(); const o = ks.reduce((x, y) => x[y], st); o[k] = v; }
  const num = (path, label, min, max, step = 1) => `<label class="ai-f"><span>${label}</span><input type="number" data-b="${path}" min="${min}" max="${max}" step="${step}" value="${get(path)}"></label>`;
  const range = (path, label, min, max, step) => `<label class="ai-f"><span>${label} <b data-v="${path}">${get(path)}</b></span><input type="range" data-b="${path}" min="${min}" max="${max}" step="${step}" value="${get(path)}"></label>`;
  const chk = (path, label) => `<label class="ai-ck"><input type="checkbox" data-b="${path}" ${get(path) ? 'checked' : ''}><span>${label}</span></label>`;
  const txt = (path, label, ph = '', extra = '') => `<label class="ai-f"><span>${label}</span><input data-b="${path}" value="${esc(get(path))}" placeholder="${esc(ph)}" ${extra}></label>`;

  function tabTpl() {
    const sizeKey = st.W + 'x' + st.H;
    const known = A.SIZES.some(([k]) => k === sizeKey);
    const tpls = B.tpls || [];
    return `<div class="ai-sec"><b>Mẫu có sẵn</b><div class="ai-tpls">${Object.entries(A.TPL).map(([k, t]) => `<button type="button" class="ai-tpl" data-tpl="${k}">${esc(t.name)}</button>`).join('')}</div></div>` +
      (tpls.length ? `<div class="ai-sec"><b>Mẫu đã lưu</b><div class="ai-tpls">${tpls.map((t) => `<span class="ai-tpl-s"><button type="button" class="ai-tpl" data-tpl-s="${esc(t.id)}">${esc(t.name)}</button>${t.by === B.me || B.staff ? `<button type="button" class="ai-x" data-tpl-del="${esc(t.id)}" title="Xóa mẫu">×</button>` : ''}</span>`).join('')}</div></div>` : '') +
      `<div class="ai-sec"><b>Cỡ ảnh</b><select data-size>${A.SIZES.map(([k, l]) => `<option value="${k}" ${(known ? k === sizeKey : k === 'custom') ? 'selected' : ''}>${l}</option>`).join('')}</select>` +
      `<div class="ai-row2">${num('W', 'Rộng (px)', 600, 2560)}${num('H', 'Cao (px)', 400, 2560)}</div></div>` +
      `<div class="ai-sec"><b>Hiện các khối</b><div class="ai-cks">${A.BLOCKS.map(([k, l]) => chk('on.' + k, l)).join('')}</div>${range('panel', 'Độ đậm khung', 0, 1, 0.05)}<p class="ai-hint">Kéo khối trên ảnh để di chuyển, kéo ô vuông ở góc phải dưới để đổi cỡ.</p></div>` +
      `<div class="ai-sec"><b>Lưu bố cục hiện tại làm mẫu</b><div class="ai-inline"><input data-tpl-name maxlength="40" placeholder="Tên mẫu"><button type="button" class="a-btn a-btn-sm" data-tpl-save>Lưu mẫu</button></div></div>`;
  }
  function tabData() {
    const p = st.product;
    return `<div class="ai-sec"><b>Lấy dữ liệu từ acc</b>${p && p.code ? `<p class="ai-cur">Đang dùng: <b>#${esc(p.code)}</b> ${esc(p.title || '')}</p>` : ''}` +
      `<input type="search" data-psearch placeholder="Tìm mã hoặc tên acc VIP..." autocomplete="off"><div class="ai-plist" data-plist><p class="ai-hint">Gõ để tìm acc có Chi tiết tài khoản.</p></div></div>` +
      `<div class="ai-sec"><b>Game</b><select data-b="game"><option value="">-- Chọn game --</option>${Object.entries(B.games).map(([k, g]) => `<option value="${k}" ${st.game === k ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></div>`;
  }
  function tabBg() {
    const bgs = B.bgs || [];
    return `<div class="ai-sec"><b>Kho ảnh nền</b><div class="ai-bgs">${bgs.map((b) => `<span class="ai-bg ${st.bg.src === b.u ? 'on' : ''}"><img src="${esc(b.u)}" alt="" loading="lazy" data-bg="${esc(b.u)}">${b.by === B.me || B.staff ? `<button type="button" class="ai-x" data-bg-del="${esc(b.u)}" title="Xóa">×</button>` : ''}</span>`).join('') || '<p class="ai-hint">Chưa có ảnh nền.</p>'}</div>` +
      `<div class="ai-inline"><label class="a-btn a-btn-sm">Tải ảnh nền lên kho<input type="file" accept="image/*" hidden data-bg-up></label><label class="a-btn a-btn-sm a-ghost">Dùng ảnh trong máy<input type="file" accept="image/*" hidden data-bg-local></label>${st.bg.src ? '<button type="button" class="a-btn a-btn-sm a-ghost" data-bg-none>Bỏ ảnh nền</button>' : ''}</div></div>` +
      `<div class="ai-sec">${range('bg.zoom', 'Phóng to', 1, 3, 0.05)}${range('bg.x', 'Lệch ngang', 0, 1, 0.01)}${range('bg.y', 'Lệch dọc', 0, 1, 0.01)}${range('bg.dark', 'Làm tối', 0, 0.85, 0.05)}${range('bg.blur', 'Làm mờ', 0, 20, 1)}` +
      `<label class="ai-f"><span>Màu nền (khi không có ảnh)</span><input type="color" data-b="bg.color" value="${esc(st.bg.color)}"></label><p class="ai-hint">Ở tab này kéo trên ảnh để di chuyển nền, 2 ngón hoặc con lăn để phóng to.</p></div>`;
  }
  function tabInfo() {
    const g = A.G(st);
    return `<div class="ai-sec">${txt('info.name', 'Tên hiển thị', 'VD: ChunChin')}${txt('info.uid', 'UID', 'VD: 841956798', 'inputmode="numeric"')}${chk('info.mask', 'Che UID (841•••798)')}` +
      `<div class="ai-row2">${txt('info.lv', esc(g.lv), '60', 'inputmode="numeric"')}<label class="ai-f"><span>Máy chủ</span><input data-b="info.server" value="${esc(st.info.server)}" list="aiSv"><datalist id="aiSv">${(B.servers || []).map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label></div>` +
      `<label class="ai-f"><span>Dòng thêm <small>(mỗi dòng 1 ý, dạng "Nhãn: giá trị")</small></span><textarea data-b="info.extra" rows="3" placeholder="Cấp thế giới: 9">${esc(st.info.extra)}</textarea></label></div>` +
      `<div class="ai-sec"><b>Kiểu khung thông tin</b><label class="ai-f"><span>Màu chữ</span><input type="color" data-b="info.color" value="${esc(st.info.color || '#ffffff')}"></label>` +
      `<span class="ai-f"><span>Ảnh nền khung <small>(chỉ hiện trong khung thông tin)</small></span></span>` +
      `<div class="ai-bgs">${(B.bgs || []).map((b) => `<span class="ai-bg ${st.info.bg === b.u ? 'on' : ''}"><img src="${esc(b.u)}" alt="" loading="lazy" data-ibg="${esc(b.u)}"></span>`).join('')}</div>` +
      `<div class="ai-inline"><label class="a-btn a-btn-sm">Tải ảnh lên<input type="file" accept="image/*" hidden data-ibg-up></label><label class="a-btn a-btn-sm a-ghost">Ảnh trong máy<input type="file" accept="image/*" hidden data-ibg-local></label>${st.info.bg ? '<button type="button" class="a-btn a-btn-sm a-ghost" data-ibg-none>Bỏ ảnh nền khung</button>' : ''}</div>` +
      (st.info.bg ? range('info.bgDark', 'Làm tối ảnh nền khung', 0, 0.85, 0.05) : '') + '</div>';
  }
  function tabGrid(k) {
    const g = st.grids[k];
    const lab = k === 'c' ? 'nhân vật' : A.G(st).w.toLowerCase();
    const sym = k === 'c' ? A.G(st).c : A.G(st).r;
    return `<div class="ai-sec"><div class="ai-row2">${num(`grids.${k}.cols`, 'Số cột', 1, 20)}${num(`grids.${k}.rows`, 'Số hàng', 1, 12)}</div>` +
      `<label class="ai-f"><span>Khi nhiều hơn số ô</span><select data-b="grids.${k}.over"><option value="more" ${g.over === 'more' ? 'selected' : ''}>Ô cuối hiện "+N"</option><option value="grow" ${g.over === 'grow' ? 'selected' : ''}>Tự thêm hàng</option><option value="cut" ${g.over === 'cut' ? 'selected' : ''}>Chỉ hiện vừa số ô</option></select></label>` +
      `<div class="ai-cks">${chk(`grids.${k}.lv`, 'Hiện thanh Lv')}${chk(`grids.${k}.k`, `Hiện ${sym}`)}</div></div>` +
      `<div class="ai-sec"><div class="ai-inline"><b>${g.items.length} ${lab}</b><button type="button" class="a-btn a-btn-sm a-ghost" data-sort="${k}">Sắp xếp tự động</button><button type="button" class="a-btn a-btn-sm" data-pick="${k}">+ Thêm từ thư viện</button></div>` +
      `<div class="ai-pick" data-pickbox="${k}" hidden><input type="search" data-pq="${k}" placeholder="Tìm ${lab}..." autocomplete="off"><div class="ai-pl" data-pl="${k}"></div><div class="ai-inline"><span>Đã chọn <b data-pn="${k}">0</b></span><button type="button" class="a-btn a-btn-sm a-primary" data-padd="${k}">Thêm</button></div></div>` +
      `<p class="ai-hint">Bỏ tích để ẩn khỏi ảnh. Ô Lv / ${sym} để trống thì không hiện. Có thể kéo ô trên ảnh để đổi chỗ.</p>` +
      `<div class="ai-items">${g.items.map((it, i) => `<div class="ai-it" data-g="${k}" data-i="${i}"><input type="checkbox" data-it="on" ${it.on ? 'checked' : ''}><span class="ai-it-ic r${it.r}">${it.i ? `<img src="${esc(it.i)}" alt="" loading="lazy">` : esc((it.n || '?').slice(0, 1))}</span><span class="ai-it-n" title="${esc(it.n)}">${esc(it.n)}</span><input data-it="lv" value="${esc(it.lv)}" placeholder="Lv" inputmode="numeric" maxlength="3"><input data-it="k" value="${it.k || ''}" placeholder="${sym}" inputmode="numeric" maxlength="1"><button type="button" data-it-mv="-1" title="Lên">↑</button><button type="button" data-it-mv="1" title="Xuống">↓</button><button type="button" data-it-del title="Xóa">×</button></div>`).join('')}</div></div>`;
  }
  function tabText() {
    return `<div class="ai-sec"><b>Mã acc</b>${chk('code.auto', 'Tự sinh theo mã sản phẩm')}${chk('code.server', 'Kèm máy chủ (VD: A455 AS)')}` +
      `<label class="ai-f"><span>Mã hiển thị <small>(sửa tay sẽ tắt tự sinh)</small></span><input data-code value="${esc(A.codeText(st))}" maxlength="30"></label>` +
      `<label class="ai-f"><span>Màu chữ</span><input type="color" data-b="code.color" value="${esc(st.code.color)}"></label></div>` +
      `<div class="ai-sec"><b>Thống kê nhanh</b>${chk('on.stats', 'Hiện dòng thống kê')}<p class="ai-cur" data-stats>${esc(A.render ? statsPreview() : '')}</p></div>` +
      `<div class="ai-sec"><b>Khung ghi chú</b>${chk('on.note', 'Hiện khung ghi chú')}<textarea data-b="note.text" rows="4" placeholder="Mỗi dòng 1 ý: thánh di vật, điểm nổi bật...">${esc(st.note.text)}</textarea></div>`;
  }
  function statsPreview() { const g = A.G(st); const lab = (n) => { const v = g['r' + n] || n + '★'; return v.includes('★') ? v : 'hạng ' + v; }; const c5 = st.grids.c.items.filter((x) => x.on && x.r === 5).length; const w5 = st.grids.w.items.filter((x) => x.on && x.r === 5).length; return [c5 ? `${c5} nhân vật ${lab(5)}` : '', w5 ? `${w5} ${g.w} ${lab(5)}` : '', st.info.lv ? `${g.lv} ${st.info.lv}` : ''].filter(Boolean).join(' · ') || 'Chưa có dữ liệu'; }
  function tabLogo() {
    return `<div class="ai-sec">${chk('on.logo', 'Hiện logo')}${range('logo.op', 'Độ rõ', 0.1, 1, 0.05)}` +
      `<div class="ai-inline"><label class="a-btn a-btn-sm">Chọn logo khác<input type="file" accept="image/*" hidden data-logo-local></label>${B.logo ? '<button type="button" class="a-btn a-btn-sm a-ghost" data-logo-shop>Dùng logo shop</button>' : ''}</div>` +
      `${st.logo.src ? `<div class="ai-logo-pv"><img src="${esc(st.logo.src)}" alt=""></div>` : '<p class="ai-hint">Chưa có logo. Cài logo shop ở Cài đặt thông tin hoặc chọn ảnh khác.</p>'}</div>`;
  }
  function renderTabs() { tabsEl.innerHTML = TABS.map(([k, l]) => `<button type="button" class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join(''); }
  function renderPanel() {
    renderTabs();
    bodyEl.innerHTML = { tpl: tabTpl, data: tabData, bg: tabBg, info: tabInfo, c: () => tabGrid('c'), w: () => tabGrid('w'), text: tabText, logo: tabLogo }[tab]();
  }
  function bar() {
    if (AIM.current !== 'make') return;
    const target = B.fromForm ? 'Gắn vào sản phẩm' : (st.product && st.product.id ? `Lưu vào acc #${esc(st.product.code)}` : 'Lưu ảnh');
    barEl.innerHTML = `<div class="ai-bar-l"><button type="button" class="a-btn a-btn-sm a-ghost" data-undo ${hi > 0 ? '' : 'disabled'} title="Hoàn tác">↶</button><button type="button" class="a-btn a-btn-sm a-ghost" data-redo ${hi < hist.length - 1 ? '' : 'disabled'} title="Làm lại">↷</button></div>` +
      `<div class="ai-bar-r"><label class="ai-ck"><input type="checkbox" data-also53 ${st.W + 'x' + st.H === '1500x900' ? 'disabled' : ''}><span><span class="ai-hm">Kèm bản </span>5:3</span></label><button type="button" class="a-btn a-btn-sm a-ghost" data-dl>Tải về</button><button type="button" class="a-btn a-btn-sm a-primary" data-save>${target}</button></div>`;
  }

  // ---------- Sự kiện bảng điều khiển ----------
  tabsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (!b || AIM.current !== 'make') return; tab = b.dataset.tab; renderPanel(); });
  function onBind(el) {
    const path = el.dataset.b;
    let v = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'number' || el.type === 'range') v = parseFloat(v) || 0;
    if (path === 'W' || path === 'H') v = clamp(Math.round(v), path === 'W' ? 600 : 400, 2560);
    if (/^grids\.\w\.(cols|rows)$/.test(path)) v = clamp(Math.round(v), 1, 20);
    set(path, v);
    const out = $(`[data-v="${path}"]`, bodyEl); if (out) out.textContent = v;
    if (path === 'game') { AIM.lib(st.game); }
    if (path === 'code.auto' || path === 'code.server' || path.startsWith('info.')) { const c = $('[data-code]', bodyEl); if (c) c.value = A.codeText(st); }
    if (path === 'note.text' && v && !st.on.note) { st.on.note = true; }
    changed();
  }
  bodyEl.addEventListener('input', (e) => {
    if (AIM.current !== 'make') return;
    const el = e.target;
    if (el.dataset.b && el.type !== 'checkbox' && el.tagName !== 'SELECT') onBind(el);
    if (el.matches('[data-code]')) { st.code.auto = false; st.code.text = el.value; const a = $('[data-b="code.auto"]', bodyEl); if (a) a.checked = false; changed(); }
    if (el.matches('[data-it="lv"], [data-it="k"]')) {
      const row = el.closest('.ai-it'); const it = st.grids[row.dataset.g].items[+row.dataset.i];
      if (el.dataset.it === 'lv') it.lv = el.value.replace(/\D/g, '').slice(0, 3); else it.k = clamp(parseInt(el.value, 10) || 0, 0, 6);
      changed();
    }
    if (el.matches('[data-pq]')) pickRender(el.dataset.pq);
    if (el.matches('[data-psearch]')) { clearTimeout(el._t); el._t = setTimeout(() => psearch(el.value), 250); }
  });
  bodyEl.addEventListener('change', async (e) => {
    if (AIM.current !== 'make') return;
    const el = e.target;
    if (el.dataset.b && (el.type === 'checkbox' || el.tagName === 'SELECT')) { onBind(el); if (el.dataset.b === 'game' || el.dataset.b.startsWith('on.')) renderPanel(); }
    if (el.matches('[data-size]')) { if (el.value !== 'custom') { const [w, h] = el.value.split('x').map(Number); st.W = w; st.H = h; } renderPanel(); changed(); }
    if (el.matches('[data-it="on"]')) { const row = el.closest('.ai-it'); st.grids[row.dataset.g].items[+row.dataset.i].on = el.checked; changed(); }
    if (el.matches('[data-bg-up]') && el.files[0]) {
      toast('Đang tải ảnh nền lên...');
      const r = await upload('/admin/acc-image/bg', { game: st.game }, el.files[0], 'bg');
      if (!r.ok) { toast(r.message || 'Không tải được', true); return; }
      B.bgs = [r.bg, ...(B.bgs || [])]; st.bg.src = r.bg.u; await preload([st.bg.src]); renderPanel(); changed();
    }
    if (el.matches('[data-ibg-up]') && el.files[0]) {
      toast('Đang tải ảnh lên...');
      const r = await upload('/admin/acc-image/bg', { game: st.game }, el.files[0], 'bg');
      if (!r.ok) { toast(r.message || 'Không tải được', true); return; }
      B.bgs = [r.bg, ...(B.bgs || [])]; st.info.bg = r.bg.u; await preload([st.info.bg]); renderPanel(); changed();
    }
    if (el.matches('[data-ibg-local]') && el.files[0]) { st.info.bg = URL.createObjectURL(el.files[0]); await preload([st.info.bg]); renderPanel(); changed(); }
    if (el.matches('[data-bg-local]') && el.files[0]) { st.bg.src = URL.createObjectURL(el.files[0]); await preload([st.bg.src]); renderPanel(); changed(); }
    if (el.matches('[data-logo-local]') && el.files[0]) { st.logo.src = URL.createObjectURL(el.files[0]); st.on.logo = true; await preload([st.logo.src]); renderPanel(); changed(); }
  });
  bodyEl.addEventListener('click', async (e) => {
    if (AIM.current !== 'make') return;
    const t = e.target;
    const tp = t.closest('[data-tpl]'); if (tp) { A.applyTpl(st, A.TPL[tp.dataset.tpl]); sel = ''; renderPanel(); changed(); return; }
    const ts = t.closest('[data-tpl-s]');
    if (ts) { const x = (B.tpls || []).find((y) => y.id === ts.dataset.tplS); if (x) { A.applyTpl(st, x.data); await preload(A.srcsOf(st)); sel = ''; renderPanel(); changed(); } return; }
    const td = t.closest('[data-tpl-del]');
    if (td) { if (!confirm('Xóa mẫu này?')) return; const r = await api('/admin/acc-image/tpl/' + td.dataset.tplDel + '/delete', {}); if (r.ok) { B.tpls = B.tpls.filter((y) => y.id !== td.dataset.tplDel); renderPanel(); } else toast(r.message, true); return; }
    if (t.closest('[data-tpl-save]')) {
      const name = $('[data-tpl-name]', bodyEl).value.trim(); if (!name) { toast('Nhập tên mẫu', true); return; }
      const r = await api('/admin/acc-image/tpl', { name, data: A.tplOf(st) });
      if (r.ok) { B.tpls = [...(B.tpls || []).filter((y) => !(y.name === name)), r.tpl]; renderPanel(); toast('Đã lưu mẫu "' + name + '"'); } else toast(r.message, true);
      return;
    }
    const ibg = t.closest('[data-ibg]'); if (ibg) { st.info.bg = ibg.dataset.ibg; await preload([st.info.bg]); renderPanel(); changed(); return; }
    if (t.closest('[data-ibg-none]')) { st.info.bg = ''; renderPanel(); changed(); return; }
    const bgi = t.closest('[data-bg]'); if (bgi) { st.bg.src = bgi.dataset.bg; await preload([st.bg.src]); renderPanel(); changed(); return; }
    const bgd = t.closest('[data-bg-del]');
    if (bgd) { if (!confirm('Xóa ảnh nền này khỏi kho?')) return; const r = await api('/admin/acc-image/bg/delete', { u: bgd.dataset.bgDel }); if (r.ok) { B.bgs = B.bgs.filter((y) => y.u !== bgd.dataset.bgDel); if (st.bg.src === bgd.dataset.bgDel) st.bg.src = ''; renderPanel(); changed(); } else toast(r.message, true); return; }
    if (t.closest('[data-bg-none]')) { st.bg.src = ''; renderPanel(); changed(); return; }
    if (t.closest('[data-logo-shop]')) { st.logo.src = B.logo; st.on.logo = true; await preload([B.logo]); renderPanel(); changed(); return; }
    const so = t.closest('[data-sort]'); if (so) { const g = st.grids[so.dataset.sort]; g.items = A.sortItems(g.items); renderPanel(); changed(); return; }
    const mv = t.closest('[data-it-mv]');
    if (mv) { const row = mv.closest('.ai-it'); const list = st.grids[row.dataset.g].items; const i = +row.dataset.i; const j = i + (+mv.dataset.itMv); if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; renderPanel(); changed(); return; }
    const dl = t.closest('[data-it-del]'); if (dl) { const row = dl.closest('.ai-it'); st.grids[row.dataset.g].items.splice(+row.dataset.i, 1); renderPanel(); changed(); return; }
    const pk = t.closest('[data-pick]'); if (pk) { const box = $(`[data-pickbox="${pk.dataset.pick}"]`, bodyEl); box.hidden = !box.hidden; if (!box.hidden) { if (!st.game) { toast('Chọn game ở tab "Acc" trước', true); box.hidden = true; return; } picked[pk.dataset.pick] = new Set(); pickRender(pk.dataset.pick); } return; }
    const pr = t.closest('[data-prow]'); if (pr) { const k = pr.dataset.prow; const s = picked[k] || (picked[k] = new Set()); if (s.has(pr.dataset.n)) s.delete(pr.dataset.n); else s.add(pr.dataset.n); pr.classList.toggle('on'); $(`[data-pn="${k}"]`, bodyEl).textContent = s.size; return; }
    const pa = t.closest('[data-padd]'); if (pa) { await pickAdd(pa.dataset.padd); return; }
    const pi = t.closest('[data-pid]'); if (pi) { await loadProduct(+pi.dataset.pid); return; }
  });

  // ---------- Thêm từ thư viện ảnh đã nạp ----------
  const picked = {};
  async function pickRender(k) {
    const lib = await AIM.lib(st.game);
    const list = lib[k] || [];
    const q = fold(($(`[data-pq="${k}"]`, bodyEl) || {}).value);
    const have = new Set(st.grids[k].items.map((x) => fold(x.n)));
    const s = picked[k] || new Set();
    const el = $(`[data-pl="${k}"]`, bodyEl); if (!el) return;
    const rows = list.filter((x) => !q || fold(x.n).includes(q));
    el.innerHTML = rows.length ? rows.map((x) => { const done = have.has(fold(x.n)); return `<button type="button" class="ai-prow ${s.has(x.n) ? 'on' : ''} ${done ? 'done' : ''}" data-prow="${k}" data-n="${esc(x.n)}" ${done ? 'disabled' : ''}><span class="ai-pck"></span><img src="${esc(x.t || x.i)}" alt="" loading="lazy"><span>${esc(x.n)}</span></button>`; }).join('')
      : `<p class="ai-hint">${list.length ? 'Không tìm thấy' : 'Chưa có ảnh trong thư viện của game này.'}</p>`;
  }
  async function pickAdd(k) {
    const lib = await AIM.lib(st.game);
    const s = picked[k]; if (!s || !s.size) return;
    (lib[k] || []).filter((x) => s.has(x.n)).forEach((x) => st.grids[k].items.push({ n: x.n, i: x.i, r: x.r || (k === 'c' ? 4 : 4), lv: '', k: 0, on: true }));
    picked[k] = new Set();
    await preload(st.grids[k].items.map((x) => x.i));
    renderPanel(); changed();
  }
  async function psearch(q) {
    const el = $('[data-plist]', bodyEl); if (!el) return;
    const r = await api('/admin/acc-image/products?q=' + encodeURIComponent(q || ''));
    el.innerHTML = r.ok && r.rows.length ? r.rows.map((p) => `<button type="button" class="ai-prod" data-pid="${p.id}"><b>#${esc(p.code)}</b><span>${esc(p.title)}</span><small>${esc((B.games[p.game] || {}).name || '')}</small></button>`).join('') : '<p class="ai-hint">Không có acc phù hợp.</p>';
  }
  async function loadProduct(id) {
    const r = await api('/admin/acc-image/product/' + id);
    if (!r.ok) { toast(r.message || 'Không tải được acc', true); return; }
    A.fromDetail(st, r.product.detail, r.product);
    await preload(A.srcsOf(st));
    toast('Đã lấy dữ liệu acc #' + r.product.code);
    renderPanel(); changed(); bar();
  }

  // ---------- Kéo trên ảnh ----------
  const pts = new Map();
  let drag = null;
  const toC = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * st.W / r.width, y: (e.clientY - r.top) * st.H / r.height }; };
  const inR = (p, R) => p.x >= R.x && p.x <= R.x + R.w && p.y >= R.y && p.y <= R.y + R.h;
  const ORDER = ['logo', 'code', 'stats', 'note', 'info', 'weapons', 'chars'];
  function bgSpan() { const im = imgNow[st.bg.src]; if (!im) return null; const sc = Math.max(st.W / im.width, st.H / im.height) * (st.bg.zoom || 1); return { dw: im.width * sc, dh: im.height * sc }; }
  canvas.addEventListener('pointerdown', (e) => {
    if (AIM.current !== 'make') return;
    canvas.setPointerCapture(e.pointerId);
    const p = toC(e); pts.set(e.pointerId, p);
    if (pts.size === 2 && tab === 'bg') { const [a, b] = [...pts.values()]; drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: st.bg.zoom }; return; }
    if (tab === 'bg' && st.bg.src) { drag = { type: 'pan', p0: p, x0: st.bg.x, y0: st.bg.y }; return; }
    if (tab === 'c' || tab === 'w') {
      const L = last[tab === 'c' ? 'chars' : 'weapons'];
      const c = L && L.cells.find((x) => inR(p, x));
      if (c) { drag = { type: 'cell', k: tab, it: c.it }; return; }
    }
    if (sel && st.on[sel]) { const R = boxOf(sel); const hs = handleSize() * 0.9; if (Math.abs(p.x - (R.x + R.w)) <= hs && Math.abs(p.y - (R.y + R.h)) <= hs) { snapBlock(sel); drag = { type: 'size', key: sel, p0: p, b0: st.blocks[sel].slice() }; return; } }
    const key = ORDER.find((k) => st.on[k] && inR(p, boxOf(k)));
    sel = key || '';
    if (key) { snapBlock(key); drag = { type: 'move', key, p0: p, b0: st.blocks[key].slice() }; }
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || AIM.current !== 'make') return;
    const p = toC(e); pts.set(e.pointerId, p);
    if (drag.type === 'pinch' && pts.size >= 2) { const [a, b] = [...pts.values()]; st.bg.zoom = clamp(drag.z0 * Math.hypot(a.x - b.x, a.y - b.y) / (drag.d0 || 1), 1, 3); draw(); return; }
    if (drag.type === 'pan') { const s = bgSpan(); if (!s) return; if (s.dw > st.W) st.bg.x = clamp(drag.x0 + (p.x - drag.p0.x) / (st.W - s.dw), 0, 1); if (s.dh > st.H) st.bg.y = clamp(drag.y0 + (p.y - drag.p0.y) / (st.H - s.dh), 0, 1); draw(); return; }
    if (drag.type === 'move') { const b = st.blocks[drag.key]; b[0] = clamp(drag.b0[0] + (p.x - drag.p0.x) / st.W, -b[2] * 0.5, 1 - b[2] * 0.5); b[1] = clamp(drag.b0[1] + (p.y - drag.p0.y) / st.H, -b[3] * 0.5, 1 - b[3] * 0.5); draw(); return; }
    if (drag.type === 'size') {
      const b = st.blocks[drag.key];
      if (drag.key === 'chars' || drag.key === 'weapons') { // lưới: giữ tỉ lệ (theo số cột × hàng), kéo hướng nào cũng phóng to / thu nhỏ
        const f = Math.max((drag.b0[2] + (p.x - drag.p0.x) / st.W) / drag.b0[2], (drag.b0[3] + (p.y - drag.p0.y) / st.H) / drag.b0[3]);
        const ff = clamp(f, 0.1, Math.min(1.5 / drag.b0[2], 1.5 / drag.b0[3]));
        b[2] = drag.b0[2] * ff; b[3] = drag.b0[3] * ff;
      } else { b[2] = clamp(drag.b0[2] + (p.x - drag.p0.x) / st.W, 0.03, 1.2); b[3] = clamp(drag.b0[3] + (p.y - drag.p0.y) / st.H, 0.03, 1.2); }
      draw();
    }
  });
  function endDrag(e) {
    if (!pts.has(e.pointerId)) return;
    const p = toC(e); pts.delete(e.pointerId);
    if (!drag) return;
    if (drag.type === 'cell') {
      const L = last[drag.k === 'c' ? 'chars' : 'weapons'];
      const c = L && L.cells.find((x) => inR(p, x));
      if (c && c.it !== drag.it) { const list = st.grids[drag.k].items; const i = list.indexOf(drag.it); const j = list.indexOf(c.it); list.splice(i, 1); list.splice(j, 0, drag.it); renderPanel(); }
    }
    if (drag.type === 'pan' || drag.type === 'pinch') renderPanelVals();
    drag = null; changed();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => { if (AIM.current !== 'make' || tab !== 'bg' || !st.bg.src) return; e.preventDefault(); st.bg.zoom = clamp(st.bg.zoom * (e.deltaY < 0 ? 1.06 : 0.94), 1, 3); renderPanelVals(); changed(); }, { passive: false });
  function renderPanelVals() { ['bg.zoom', 'bg.x', 'bg.y'].forEach((k) => { const i = $(`[data-b="${k}"]`, bodyEl); const v = $(`[data-v="${k}"]`, bodyEl); const val = Math.round(get(k) * 100) / 100; if (i) i.value = val; if (v) v.textContent = val; }); }

  // ---------- Xuất / lưu ----------
  async function blobs(also53) {
    const out = [{ blob: await A.exportBlob(st), tag: 'full' }];
    if (also53) { const s2 = JSON.parse(JSON.stringify(st)); A.applyTpl(s2, A.TPL.C); s2.bg = st.bg; s2.logo = st.logo; s2.note = st.note; out.push({ blob: await A.exportBlob(s2), tag: '53' }); }
    return out;
  }
  barEl.addEventListener('click', async (e) => {
    if (AIM.current !== 'make') return;
    if (e.target.closest('[data-undo]')) { undo(); return; }
    if (e.target.closest('[data-redo]')) { redo(); return; }
    const also53 = !!$('[data-also53]', barEl)?.checked;
    if (e.target.closest('[data-dl]')) {
      const code = (A.codeText(st) || 'anh-acc').replace(/[^\w-]+/g, '-');
      (await blobs(also53)).forEach((b) => AIM.download(b.blob, code + (b.tag === '53' ? '-5x3' : '') + '.webp'));
      return;
    }
    const sv = e.target.closest('[data-save]');
    if (!sv) return;
    sv.disabled = true; toast('Đang lưu ảnh...');
    try {
      const list = await blobs(also53);
      // bản 5:3 làm ảnh đại diện (đứng đầu), bản đầy đủ ngay sau
      const order = list.length > 1 ? [list[0], list[1]] : list;
      const pid = !B.fromForm && st.product && st.product.id ? st.product.id : 0;
      const urls = [];
      for (const b of order) {
        const r = await upload('/admin/acc-image/save', { product_id: pid, attach: pid ? '1' : '0' }, new File([b.blob], 'acc.webp', { type: 'image/webp' }), 'accimg');
        if (!r.ok) throw new Error(r.message || 'Không lưu được');
        urls.unshift(r.url);
      }
      if (AIM.toForm({ urls })) toast('Đã gắn ' + urls.length + ' ảnh vào form sản phẩm. Nhớ bấm Lưu ở form.');
      else if (pid) toast('Đã lưu và gắn ' + urls.length + ' ảnh vào acc #' + st.product.code);
      else { toast('Đã lưu ảnh'); prompt('Link ảnh đã lưu:', location.origin + urls[0]); }
    } catch (err) { toast(err.message, true); }
    sv.disabled = false;
  });

  MODES.make = {
    enter() { $('[data-ai-empty]', app).hidden = true; canvas.hidden = false; renderPanel(); bar(); preload(A.srcsOf(st)).then(draw); draw(); },
  };
  boot();
  AIM.lib(st.game);
  commitNow();
  if (document.fonts && document.fonts.load) document.fonts.load("800 40px 'Be Vietnam Pro'").then(() => { if (AIM.current === 'make') draw(); });
})();
