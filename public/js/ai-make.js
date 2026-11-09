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
  // Định dạng + chất lượng ảnh xuất (nhớ trong trình duyệt), dùng chung cho Tạo ảnh / Sửa ảnh / Hàng loạt
  const OUTS = [['png', 'PNG (nét nhất)'], ['jpeg:1', 'JPG 100%'], ['jpeg:0.95', 'JPG 95%'], ['jpeg:0.9', 'JPG 90%'], ['webp:1', 'WebP 100%'], ['webp:0.95', 'WebP 95%'], ['webp:0.9', 'WebP 90%'], ['webp:0.8', 'WebP 80%']];
  let outKey = 'webp:0.95';
  try { const v = localStorage.getItem('ai_out'); if (OUTS.some(([k]) => k === v)) outKey = v; } catch (e) { /* bỏ qua */ }
  AIM.out = () => { const [f, q] = outKey.split(':'); return { type: 'image/' + f, q: q ? +q : 1, ext: f === 'jpeg' ? 'jpg' : f }; };
  AIM.outSelect = () => `<select class="ai-out" data-out title="Định dạng & chất lượng ảnh">${OUTS.map(([k, l]) => `<option value="${k}" ${k === outKey ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const RES = [['0.75', '0,75×'], ['1', '1×'], ['1.5', '1,5×'], ['2', '2× (nét nhất)']];
  let resKey = '1';
  try { const v = localStorage.getItem('ai_res'); if (RES.some(([k]) => k === v)) resKey = v; } catch (e) { /* bỏ qua */ }
  AIM.res = () => +resKey;
  AIM.resSelect = (W, H) => `<select class="ai-out" data-res title="Độ phân giải ảnh xuất">${RES.map(([k, l]) => `<option value="${k}" ${k === resKey ? 'selected' : ''}>${l}${W ? ' · ' + Math.round(W * k) + '×' + Math.round(H * k) : ''}</option>`).join('')}</select>`;
  AIM.fileOf = (blob, name) => { const o = AIM.out(); return new File([blob], name + '.' + o.ext, { type: o.type }); };
  AIM.tooBig = (blob) => { if (blob && blob.size > 19.5 * 1024 * 1024) { toast('Ảnh ' + (blob.size / 1048576).toFixed(1) + ' MB vượt giới hạn 20 MB. Chọn JPG / WebP hoặc độ phân giải thấp hơn.', true); return true; } return false; };
  barEl.addEventListener('change', (e) => { if (e.target.matches('[data-res]')) { resKey = e.target.value; try { localStorage.setItem('ai_res', resKey); } catch (x) { /* bỏ qua */ } } if (e.target.matches('[data-out]')) { outKey = e.target.value; try { localStorage.setItem('ai_out', outKey); } catch (x) { /* bỏ qua */ } } });
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
  // Khung của khối = vùng đã đặt (lưới chia đều ô bên trong vùng này)
  // Khung cung mệnh: mỗi nhân vật 1 khối riêng 'k:<tên>'
  const cstKeys = () => (st.cstOn !== false ? (st.cst || []).map((c) => c.key) : []);
  const allKeys = () => [...A.BLOCKS.map(([k]) => k), ...cstKeys()];
  const boxOf = (key) => A.rect(st, key);
  const uiK = () => st.W / Math.max(1, canvas.clientWidth || st.W); // 1 px màn hình = bao nhiêu px ảnh
  const handleSize = () => Math.max(Math.min(st.W, st.H * 1.87) * 0.02, 26 * uiK());
  let fastUntil = 0; let fastT = 0;
  const fastFx = () => { fastUntil = performance.now() + 280; clearTimeout(fastT); fastT = setTimeout(draw, 300); };
  const ensureFx = () => { if (!st.fx) st.fx = { filter: 'none', amount: 100, tone: {} }; if (!st.fx.tone) st.fx.tone = {}; };
  function drawNow() {
    raf = 0; ensureFx();
    if (canvas.width !== st.W || canvas.height !== st.H) { canvas.width = st.W; canvas.height = st.H; }
    last = A.render(ctx, st, true, '') || {};
    if (!drag && A.fxActive(st.fx)) {
      if (performance.now() < fastUntil) { // đang kéo thanh chỉnh: xem trước ở nửa độ phân giải cho mượt, thả tay vẽ lại đủ nét
        const h = document.createElement('canvas'); h.width = Math.round(st.W / 2); h.height = Math.round(st.H / 2);
        const hc = h.getContext('2d'); hc.drawImage(canvas, 0, 0, h.width, h.height);
        A.applyFx(hc, h.width, h.height, { ...st.fx, tone: { ...st.fx.tone, sharp: 0 } });
        ctx.drawImage(h, 0, 0, st.W, st.H);
      } else A.applyFx(ctx, st.W, st.H, st.fx);
    }
    // viền mờ cho mọi khối đang hiện (biết là kéo được), khối đang chọn viền xanh + tay nắm đổi cỡ ở góc
    const k = uiK(); const lw = Math.max(1, 1.5 * k);
    ctx.save();
    allKeys().forEach((key) => {
      if (!st.on[key]) return;
      const R = boxOf(key); const on = key === sel;
      ctx.setLineDash(on ? [6 * k, 4 * k] : [4 * k, 4 * k]); ctx.lineWidth = on ? lw * 1.6 : lw;
      ctx.strokeStyle = on ? '#4fd1ff' : 'rgba(255,255,255,.35)'; ctx.strokeRect(R.x, R.y, R.w, R.h);
      if (on) { const hs = handleSize(); ctx.setLineDash([]); ctx.fillStyle = '#4fd1ff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = lw; ctx.fillRect(R.x + R.w - hs / 2, R.y + R.h - hs / 2, hs, hs); ctx.strokeRect(R.x + R.w - hs / 2, R.y + R.h - hs / 2, hs, hs); }
    });
    // đường gióng khi khối đang thẳng hàng với khối khác / giữa ảnh
    ctx.setLineDash([]); ctx.strokeStyle = '#ff3da5'; ctx.lineWidth = lw * 1.4;
    guides.x.forEach((x) => { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, st.H); ctx.stroke(); });
    guides.y.forEach((y) => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(st.W, y); ctx.stroke(); });
    ctx.restore();
  }
  /** Bắt đầu kéo lưới: khớp khối theo đúng vùng lưới để kéo to / nhỏ theo góc lưới */
  function snapBlock() { /* khung lưới = đúng khối đã đặt, không cần khớp lại */ }
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
  const TABS = [['tpl', 'Mẫu & cỡ'], ['data', 'Acc'], ['bg', 'Nền'], ['info', 'Thông tin'], ['c', 'Nhân vật'], ['w', 'Vũ khí'], ['k', 'Cung mệnh'], ['text', 'Mã & chữ'], ['logo', 'Logo'], ['filter', 'Bộ lọc'], ['tone', 'Tông màu']];
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
      `<div class="ai-sec"><b>Căn khối đang chọn</b>${sel ? `<div class="ai-tpls">${[['l', '⇤ Trái'], ['cx', '↔ Giữa ngang'], ['r', 'Phải ⇥'], ['t', '⤒ Trên'], ['cy', '↕ Giữa dọc'], ['b', 'Dưới ⤓']].map(([k, l]) => `<button type="button" class="ai-tpl" data-align="${k}">${l}</button>`).join('')}</div>` : '<p class="ai-hint">Bấm vào 1 khối trên ảnh để chọn. Khi kéo, khối tự hút thẳng hàng với khối khác (đường hồng).</p>'}</div>` +
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
  function tabCst() {
    const sym = A.G(st).c;
    const list = st.cst || [];
    return `<div class="ai-sec">${chk('cstOn', 'Hiện khung cung mệnh')}<div class="ai-inline"><b>${list.length} nhân vật</b>${list.length ? '<button type="button" class="a-btn a-btn-sm a-ghost" data-cst-reset>Xếp lại vị trí</button>' : ''}</div>` +
      (list.length ? `<div class="ai-items">${list.map((c) => `<div class="ai-it ai-cst-it ${c.key === sel ? 'on' : ''}"><input type="checkbox" data-cst-on="${esc(c.key)}" ${st.on[c.key] ? 'checked' : ''}><span class="ai-it-ic r${c.r}">${c.ic ? `<img src="${esc(c.ic)}" alt="" loading="lazy">` : esc((c.n || '?').slice(0, 1))}</span><span class="ai-it-n" title="${esc(c.n)}">${esc(c.n)}</span><i class="ai-cst-dot" style="background:${esc(c.ring)}"></i><b class="ai-cst-k">${esc(sym)}${c.k}</b><button type="button" data-cst-sel="${esc(c.key)}" title="Chọn khung trên ảnh">◎</button></div>`).join('')}</div>` : '') +
      `<p class="ai-hint">${list.length ? 'Bỏ tích để ẩn. Bấm ◎ hoặc bấm khung trên ảnh để chọn, kéo để di chuyển, kéo góc để đổi cỡ.' : `Chưa có nhân vật nào từ ${sym}1 trở lên có dữ liệu cung mệnh. Nạp ở Quản lý ảnh → Cung mệnh.`}</p></div>`;
  }
  function tabText() {
    return `<div class="ai-sec"><b>Mã acc</b>${chk('code.auto', 'Tự sinh theo mã sản phẩm')}${chk('code.server', 'Kèm máy chủ (VD: A455 AS)')}` +
      `<label class="ai-f"><span>Mã hiển thị <small>(sửa tay sẽ tắt tự sinh)</small></span><input data-code value="${esc(A.codeText(st))}" maxlength="30"></label>` +
      `<label class="ai-f"><span>Màu chữ</span><input type="color" data-b="code.color" value="${esc(st.code.color)}"></label></div>` +
      `<div class="ai-sec"><b>Thống kê nhanh</b>${chk('on.stats', 'Hiện dòng thống kê')}<p class="ai-cur" data-stats>${esc(A.render ? statsPreview() : '')}</p></div>` +
      `<div class="ai-sec"><b>Khung ghi chú</b>${chk('on.note', 'Hiện khung ghi chú')}<textarea data-b="note.text" rows="4" placeholder="Mỗi dòng 1 ý: thánh di vật, điểm nổi bật...">${esc(st.note.text)}</textarea></div>`;
  }
  function statsPreview() { const g = A.G(st); const lab = (n) => { const v = g['r' + n] || n + '★'; return v.includes('★') ? v : 'hạng ' + v; }; const c5 = st.grids.c.items.filter((x) => x.on && x.r === 5).length; const w5 = st.grids.w.items.filter((x) => x.on && x.r === 5).length; return [c5 ? `${c5} nhân vật ${lab(5)}` : '', w5 ? `${w5} ${g.w} ${lab(5)}` : '', st.info.lv ? `${g.lv} ${st.info.lv}` : ''].filter(Boolean).join(' · ') || 'Chưa có dữ liệu'; }
  // ---------- Bộ lọc & tông màu ----------
  const TICON = { // biểu tượng nút tông màu
    bright: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
    contrast: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
    sat: '<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/><path d="M12 9.5v9a4 4 0 0 0 4-4" />',
    vib: '<path d="M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z"/>',
    warm: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/><path d="M12 10v6"/>',
    tint: '<circle cx="8.5" cy="9" r="4.5"/><circle cx="15.5" cy="9" r="4.5"/><circle cx="12" cy="15" r="4.5"/>',
    hi: '<circle cx="12" cy="13" r="4"/><path d="M12 3v3M5 6l2 2M19 6l-2 2M3 20h18"/>',
    sh: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
    sharp: '<path d="M12 3l9 17H3z"/><path d="M12 9v6"/>',
    vig: '<rect x="3" y="5" width="18" height="14" rx="3"/><ellipse cx="12" cy="12" rx="5" ry="3.5"/>',
    fade: '<path d="M4 8h16M4 12h12M4 16h8"/>',
  };
  let toneKey = 'bright';
  function tabFilter() {
    return `<div class="ai-sec"><b>Bộ lọc</b><div class="ai-filters">${A.FILTERS.map(([k, l]) => `<button type="button" class="ai-flt ${st.fx.filter === k ? 'on' : ''}" data-flt="${k}"><canvas width="132" height="80" data-fthumb="${k}"></canvas><span>${l}</span></button>`).join('')}</div>` +
      (st.fx.filter !== 'none' ? range('fx.amount', 'Độ mạnh (%)', 0, 100, 1) : '') + '</div>';
  }
  function tabTone() {
    const t = st.fx.tone || {}; const cur = A.TONES.find((x) => x[0] === toneKey) || A.TONES[0];
    return `<div class="ai-sec"><b class="ai-tone-name">${cur[1]} <span data-tone-v>${+t[cur[0]] || 0}</span></b><div class="ai-tones">${A.TONES.map(([k, l]) => `<button type="button" class="ai-tone ${k === toneKey ? 'on' : ''} ${+t[k] ? 'set' : ''}" data-tone="${k}" title="${l}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${TICON[k]}</svg></button>`).join('')}</div>` +
      `<input type="range" class="ai-tone-r" data-tone-r min="${cur[2]}" max="${cur[3]}" step="1" value="${+t[cur[0]] || 0}"><div class="ai-inline"><button type="button" class="a-btn a-btn-sm a-ghost" data-tone-zero>Về 0</button><button type="button" class="a-btn a-btn-sm a-ghost" data-tone-reset>Đặt lại tất cả</button></div></div>`;
  }
  // Ảnh xem trước nhỏ của từng bộ lọc (từ ảnh hiện tại, chưa có hiệu ứng)
  function filterThumbs() {
    const src = document.createElement('canvas'); src.width = st.W; src.height = st.H;
    A.render(src.getContext('2d'), st, false);
    A.FILTERS.forEach(([k]) => {
      const c = $(`[data-fthumb="${k}"]`, bodyEl); if (!c) return;
      const x = c.getContext('2d'); const sc = Math.max(c.width / st.W, c.height / st.H);
      x.drawImage(src, (c.width - st.W * sc) / 2, (c.height - st.H * sc) / 2, st.W * sc, st.H * sc);
      A.applyFx(x, c.width, c.height, { filter: k, amount: st.fx.filter === k ? st.fx.amount : 100, tone: st.fx.tone });
    });
  }
  function tabLogo() {
    return `<div class="ai-sec">${chk('on.logo', 'Hiện logo')}${range('logo.op', 'Độ rõ', 0.1, 1, 0.05)}` +
      `<div class="ai-inline"><label class="a-btn a-btn-sm">Chọn logo khác<input type="file" accept="image/*" hidden data-logo-local></label>${B.logo ? '<button type="button" class="a-btn a-btn-sm a-ghost" data-logo-shop>Dùng logo shop</button>' : ''}</div>` +
      `${st.logo.src ? `<div class="ai-logo-pv"><img src="${esc(st.logo.src)}" alt=""></div>` : '<p class="ai-hint">Chưa có logo. Cài logo shop ở Cài đặt thông tin hoặc chọn ảnh khác.</p>'}</div>`;
  }
  function renderTabs() { tabsEl.innerHTML = TABS.map(([k, l]) => `<button type="button" class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join(''); }
  function renderPanel() {
    ensureFx();
    renderTabs();
    bodyEl.innerHTML = { tpl: tabTpl, data: tabData, bg: tabBg, info: tabInfo, c: () => tabGrid('c'), w: () => tabGrid('w'), k: tabCst, text: tabText, logo: tabLogo, filter: tabFilter, tone: tabTone }[tab]();
    if (tab === 'filter') filterThumbs();
  }
  function bar() {
    if (AIM.current !== 'make') return;
    const target = B.fromForm ? 'Gắn vào sản phẩm' : (st.product && st.product.id ? `Lưu vào acc #${esc(st.product.code)}` : 'Lưu ảnh');
    barEl.innerHTML = `<div class="ai-bar-l"><button type="button" class="a-btn a-btn-sm a-ghost" data-undo ${hi > 0 ? '' : 'disabled'} title="Hoàn tác">↶</button><button type="button" class="a-btn a-btn-sm a-ghost" data-redo ${hi < hist.length - 1 ? '' : 'disabled'} title="Làm lại">↷</button></div>` +
      `<div class="ai-bar-r"><label class="ai-ck"><input type="checkbox" data-also53 ${st.W + 'x' + st.H === '1500x900' ? 'disabled' : ''}><span><span class="ai-hm">Kèm bản </span>5:3</span></label>${AIM.resSelect(st.W, st.H)}${AIM.outSelect()}<button type="button" class="a-btn a-btn-sm a-ghost" data-dl title="Tải về"><span class="ai-hm">Tải về</span><span class="ai-sm">⬇</span></button><button type="button" class="a-btn a-btn-sm a-primary" data-save><span class="ai-hm">${target}</span><span class="ai-sm">Lưu</span></button></div>`;
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
    if (el.matches('[data-tone-r]') || el.dataset.b === 'fx.amount') fastFx();
    if (el.matches('[data-tone-r]')) { st.fx.tone = st.fx.tone || {}; st.fx.tone[toneKey] = +el.value; const v = $('[data-tone-v]', bodyEl); if (v) v.textContent = el.value; const btn = $(`[data-tone="${toneKey}"]`, bodyEl); if (btn) btn.classList.toggle('set', !!+el.value); changed(); }
    if (el.matches('[data-code]')) { st.code.auto = false; st.code.text = el.value; const a = $('[data-b="code.auto"]', bodyEl); if (a) a.checked = false; changed(); }
    if (el.matches('[data-it="lv"], [data-it="k"]')) {
      const row = el.closest('.ai-it'); const it = st.grids[row.dataset.g].items[+row.dataset.i];
      if (el.dataset.it === 'lv') it.lv = el.value.replace(/\D/g, '').slice(0, 3); else it.k = clamp(parseInt(el.value, 10) || 0, 0, 6);
      changed();
      if (el.dataset.it === 'k' && row.dataset.g === 'c') { clearTimeout(el._k); el._k = setTimeout(syncCst, 400); }
    }
    if (el.matches('[data-pq]')) pickRender(el.dataset.pq);
    if (el.matches('[data-psearch]')) { clearTimeout(el._t); el._t = setTimeout(() => psearch(el.value), 250); }
  });
  bodyEl.addEventListener('change', async (e) => {
    if (AIM.current !== 'make') return;
    const el = e.target;
    if (el.dataset.b && (el.type === 'checkbox' || el.tagName === 'SELECT')) { onBind(el); if (el.dataset.b === 'game' || el.dataset.b.startsWith('on.')) renderPanel(); }
    if (el.matches('[data-size]')) { if (el.value !== 'custom') { const [w, h] = el.value.split('x').map(Number); st.W = w; st.H = h; } renderPanel(); changed(); }
    if (el.matches('[data-it="on"]')) { const row = el.closest('.ai-it'); st.grids[row.dataset.g].items[+row.dataset.i].on = el.checked; changed(); if (row.dataset.g === 'c') syncCst(); }
    if (el.matches('[data-cst-on]')) { st.on[el.dataset.cstOn] = el.checked; if (!el.checked && sel === el.dataset.cstOn) sel = ''; changed(); }
    if (el.dataset.b === 'game') syncCst();
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
    const fl = t.closest('[data-flt]'); if (fl) { st.fx.filter = fl.dataset.flt; if (!st.fx.amount) st.fx.amount = 100; renderPanel(); changed(); return; }
    const tb = t.closest('[data-tone]'); if (tb) { toneKey = tb.dataset.tone; renderPanel(); return; }
    if (t.closest('[data-tone-zero]')) { st.fx.tone[toneKey] = 0; renderPanel(); changed(); return; }
    if (t.closest('[data-tone-reset]')) { st.fx.tone = {}; renderPanel(); changed(); return; }
    const al = t.closest('[data-align]');
    if (al && sel && st.on[sel]) {
      snapBlock(sel); const b = st.blocks[sel]; const m = 0.012; // lề sát mép ảnh
      ({ l: () => { b[0] = m; }, cx: () => { b[0] = (1 - b[2]) / 2; }, r: () => { b[0] = 1 - b[2] - m; }, t: () => { b[1] = m * 1.87; }, cy: () => { b[1] = (1 - b[3]) / 2; }, b: () => { b[1] = 1 - b[3] - m * 1.87; } })[al.dataset.align]();
      changed(); return;
    }
    const cs = t.closest('[data-cst-sel]'); if (cs) { sel = cs.dataset.cstSel; st.on[sel] = true; renderPanel(); draw(); return; }
    if (t.closest('[data-cst-reset]')) { (st.cst || []).forEach((c) => { delete st.blocks[c.key]; delete st.on[c.key]; }); st.cst = []; await syncCst(); renderPanel(); return; }
    const tp = t.closest('[data-tpl]'); if (tp) { A.applyTpl(st, A.TPL[tp.dataset.tpl]); sel = ''; await syncCst(true); renderPanel(); changed(); return; }
    const ts = t.closest('[data-tpl-s]');
    if (ts) { const x = (B.tpls || []).find((y) => y.id === ts.dataset.tplS); if (x) { A.applyTpl(st, x.data); await syncCst(true); await preload(A.srcsOf(st)); sel = ''; renderPanel(); changed(); } return; }
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
    const dl = t.closest('[data-it-del]'); if (dl) { const row = dl.closest('.ai-it'); st.grids[row.dataset.g].items.splice(+row.dataset.i, 1); if (row.dataset.g === 'c') await syncCst(); renderPanel(); changed(); return; }
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
  /** Chèn sau mục cuối cùng có độ hiếm >= mục mới: 5★ luôn ở trên, 4★ (và thấp hơn) luôn ở dưới, giữ thứ tự đã thêm trong từng nhóm */
  function insertByRarity(list, it) {
    let at = list.length;
    for (let i = list.length - 1; i >= 0; i--) { if ((list[i].r || 0) >= it.r) { at = i + 1; break; } if (i === 0) at = 0; }
    list.splice(at, 0, it);
  }
  async function pickAdd(k) {
    const lib = await AIM.lib(st.game);
    const s = picked[k]; if (!s || !s.size) return;
    [...s].map((n) => (lib[k] || []).find((x) => x.n === n)).filter(Boolean).forEach((x) => insertByRarity(st.grids[k].items, { n: x.n, i: x.i, r: x.r || 4, lv: '', k: 0, on: true }));
    picked[k] = new Set();
    await preload(st.grids[k].items.map((x) => x.i));
    if (k === 'c') await syncCst();
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
    await syncCst();
    await preload(A.srcsOf(st));
    toast('Đã lấy dữ liệu acc #' + r.product.code);
    renderPanel(); changed(); bar();
  }

  // ---------- Khung cung mệnh ----------
  // Nhân vật đang hiện có C1 trở lên + đã nạp cung mệnh -> 1 khung riêng, 5★ trước 4★, chỉ lấy tới đúng số C của acc
  const cstCache = {};
  let cstTok = 0;
  async function syncCst(fresh) {
    const tok = ++cstTok;
    const game = st.game;
    const want = st.grids.c.items.filter((x) => x.on && x.k >= 1).sort((a, b) => (b.r || 0) - (a.r || 0));
    const cache = cstCache[game] || (cstCache[game] = {});
    const miss = game ? [...new Set(want.map((x) => x.n))].filter((n) => !(n in cache)) : [];
    if (miss.length) { const r = await api('/admin/acc-image/consts', { game, names: miss }); if (r && r.ok) miss.forEach((n) => { cache[n] = r.data[n] || null; }); }
    if (tok !== cstTok) return;
    const list = [];
    if (game) {
      want.forEach((x) => {
        const d = cache[x.n]; if (!d) return;
        const slots = d.slots.filter((s) => s.s <= x.k).map((s) => ({ n: s.n, i: s.i }));
        const key = 'k:' + fold(x.n);
        if (slots.length && !list.some((c) => c.key === key)) list.push({ key, n: x.n, r: x.r, k: x.k, ic: x.i, ring: d.ring, slots });
      });
    }
    const old = new Map((st.cst || []).map((c) => [c.key, c]));
    old.forEach((c, key) => { if (!list.some((l) => l.key === key)) { delete st.blocks[key]; delete st.on[key]; if (sel === key) sel = ''; } });
    // khung mới: xếp thành cột từ giữa ảnh, hết chỗ thì sang cột kế bên; khung cũ đổi số C -> giữ chỗ, đổi chiều cao
    const rowPx = st.W * 0.031; const padPx = st.W * 0.008; const w = 0.16;
    let x = 0.335; let y = 0.28;
    list.forEach((c) => {
      const h = (c.slots.length * rowPx + 2 * padPx) / st.H;
      if (y + h > 0.98) { y = 0.28; x += w + 0.01; if (x + w > 1) x = 0.335; }
      const o = old.get(c.key);
      if (fresh || !st.blocks[c.key]) { st.blocks[c.key] = [x, y, w, h]; st.on[c.key] = true; }
      else if (o && o.slots.length !== c.slots.length) st.blocks[c.key][3] *= c.slots.length / o.slots.length;
      y += h + 0.012;
    });
    st.cst = list;
    await preload(A.srcsOf(st));
    if (tab === 'k') renderPanel();
    changed();
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
    const key = [...cstKeys().reverse(), ...ORDER].find((k) => st.on[k] && inR(p, boxOf(k)));
    const was = sel;
    sel = key || '';
    if (was !== sel && tab === 'tpl') renderPanel(); // hiện / ẩn nút căn khối
    if (key) { snapBlock(key); drag = { type: 'move', key, p0: p, b0: st.blocks[key].slice() }; }
    draw();
  });
  let guides = { x: [], y: [] };
  function snapTargets(except) {
    const xs = [0, st.W / 2, st.W]; const ys = [0, st.H / 2, st.H];
    allKeys().forEach((k) => { if (!st.on[k] || k === except) return; const R = boxOf(k); xs.push(R.x, R.x + R.w / 2, R.x + R.w); ys.push(R.y, R.y + R.h / 2, R.y + R.h); });
    return { xs, ys };
  }
  function nearest(vals, targets, th) {
    let best = null;
    vals.forEach((v) => targets.forEach((t) => { const d = t - v; if (Math.abs(d) <= th && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t }; }));
    return best;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || AIM.current !== 'make') return;
    const p = toC(e); pts.set(e.pointerId, p);
    if (drag.type === 'pinch' && pts.size >= 2) { const [a, b] = [...pts.values()]; st.bg.zoom = clamp(drag.z0 * Math.hypot(a.x - b.x, a.y - b.y) / (drag.d0 || 1), 1, 3); draw(); return; }
    if (drag.type === 'pan') { const s = bgSpan(); if (!s) return; if (s.dw > st.W) st.bg.x = clamp(drag.x0 + (p.x - drag.p0.x) / (st.W - s.dw), 0, 1); if (s.dh > st.H) st.bg.y = clamp(drag.y0 + (p.y - drag.p0.y) / (st.H - s.dh), 0, 1); draw(); return; }
    if (drag.type === 'move') {
      const b = st.blocks[drag.key];
      b[0] = clamp(drag.b0[0] + (p.x - drag.p0.x) / st.W, -b[2] * 0.5, 1 - b[2] * 0.5); b[1] = clamp(drag.b0[1] + (p.y - drag.p0.y) / st.H, -b[3] * 0.5, 1 - b[3] * 0.5);
      const T = snapTargets(drag.key); const th = 8 * uiK();
      const x = b[0] * st.W; const y = b[1] * st.H; const w = b[2] * st.W; const h = b[3] * st.H;
      const sx = nearest([x, x + w / 2, x + w], T.xs, th); const sy = nearest([y, y + h / 2, y + h], T.ys, th);
      if (sx) b[0] += sx.d / st.W;
      if (sy) b[1] += sy.d / st.H;
      guides = { x: sx ? [sx.t] : [], y: sy ? [sy.t] : [] };
      draw(); return;
    }
    if (drag.type === 'size') {
      const b = st.blocks[drag.key];
      // mọi khối (cả lưới): kéo ngang dài ngang, kéo dọc dài dọc; lưới tự chia đều ô bên trong
      b[2] = clamp(drag.b0[2] + (p.x - drag.p0.x) / st.W, 0.03, 1.2); b[3] = clamp(drag.b0[3] + (p.y - drag.p0.y) / st.H, 0.03, 1.2);
      const T = snapTargets(drag.key); const th = 8 * uiK();
      const sx = nearest([(b[0] + b[2]) * st.W], T.xs, th); const sy = nearest([(b[1] + b[3]) * st.H], T.ys, th);
      if (sx) b[2] += sx.d / st.W;
      if (sy) b[3] += sy.d / st.H;
      guides = { x: sx ? [sx.t] : [], y: sy ? [sy.t] : [] };
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
    drag = null; guides = { x: [], y: [] }; changed();
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => { if (AIM.current !== 'make' || tab !== 'bg' || !st.bg.src) return; e.preventDefault(); st.bg.zoom = clamp(st.bg.zoom * (e.deltaY < 0 ? 1.06 : 0.94), 1, 3); renderPanelVals(); changed(); }, { passive: false });
  function renderPanelVals() { ['bg.zoom', 'bg.x', 'bg.y'].forEach((k) => { const i = $(`[data-b="${k}"]`, bodyEl); const v = $(`[data-v="${k}"]`, bodyEl); const val = Math.round(get(k) * 100) / 100; if (i) i.value = val; if (v) v.textContent = val; }); }

  // ---------- Xuất / lưu ----------
  async function blobs(also53) {
    const o = AIM.out();
    const out = [{ blob: await A.exportBlob(st, o.type, o.q, AIM.res()), tag: 'full' }];
    if (also53) { const s2 = JSON.parse(JSON.stringify(st)); A.applyTpl(s2, A.TPL.C); s2.bg = st.bg; s2.logo = st.logo; s2.note = st.note; out.push({ blob: await A.exportBlob(s2, o.type, o.q, AIM.res()), tag: '53' }); }
    return out;
  }
  barEl.addEventListener('click', async (e) => {
    if (AIM.current !== 'make') return;
    if (e.target.closest('[data-undo]')) { undo(); return; }
    if (e.target.closest('[data-redo]')) { redo(); return; }
    const also53 = !!$('[data-also53]', barEl)?.checked;
    if (e.target.closest('[data-dl]')) {
      const code = (A.codeText(st) || 'anh-acc').replace(/[^\w-]+/g, '-');
      (await blobs(also53)).forEach((b) => AIM.download(b.blob, code + (b.tag === '53' ? '-5x3' : '') + '.' + AIM.out().ext));
      return;
    }
    const sv = e.target.closest('[data-save]');
    if (!sv) return;
    sv.disabled = true; toast('Đang lưu ảnh...');
    try {
      const list = await blobs(also53);
      if (list.some((b) => AIM.tooBig(b.blob))) { sv.disabled = false; return; }
      // bản 5:3 làm ảnh đại diện (đứng đầu), bản đầy đủ ngay sau
      const order = list.length > 1 ? [list[0], list[1]] : list;
      const pid = !B.fromForm && st.product && st.product.id ? st.product.id : 0;
      const urls = [];
      for (const b of order) {
        const r = await upload('/admin/acc-image/save', { product_id: pid, attach: pid ? '1' : '0' }, AIM.fileOf(b.blob, 'acc'), 'accimg');
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
  syncCst();
  if (document.fonts && document.fonts.load) document.fonts.load("800 40px 'Be Vietnam Pro'").then(() => { if (AIM.current === 'make') draw(); });
})();
