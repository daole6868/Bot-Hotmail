/* Tạo ảnh acc — chế độ Sửa ảnh: cắt (tỉ lệ), xoay / lật, che vùng (mờ / pixel / tô đen), chèn chữ, logo, chỉnh màu. Vẽ trên trình duyệt. */
(() => {
  'use strict';
  const A = window.AIC; const AIM = window.AIM;
  if (!A || !AIM) return;
  const { B, app, $, esc, clamp, api, upload, loadImg, toast } = A;
  const { canvas, ctx, tabsEl, bodyEl, barEl } = AIM;
  const MAX = 2560;     // cạnh dài tối đa khi sửa (đủ nét, không đơ máy yếu)
  const KEEP = 8;       // số bước hoàn tác

  let work = null;      // canvas ảnh hiện tại
  let source = { url: '', product: null }; // ảnh đang sửa thuộc sản phẩm nào (để lưu đè đúng chỗ)
  const undoSt = []; const redoSt = [];
  let tab = 'src';
  const o = { // tùy chọn công cụ
    ratio: 'free', crop: null, hide: 'blur', power: 12, text: '', tsize: 6, tcolor: '#ffffff', tbg: true, tpos: null,
    logoSrc: B.logo || '', lsize: 18, lop: 0.85, lpos: null, adj: { b: 0, c: 0, s: 0 }, sel: null,
  };

  const clone = (c) => { const n = document.createElement('canvas'); n.width = c.width; n.height = c.height; n.getContext('2d').drawImage(c, 0, 0); return n; };
  function push() { if (!work) return; undoSt.push(clone(work)); if (undoSt.length > KEEP) undoSt.shift(); redoSt.length = 0; bar(); }
  function setWork(c, keepHist) { work = c; if (!keepHist) { undoSt.length = 0; redoSt.length = 0; } o.crop = null; o.tpos = null; o.lpos = null; o.adj = { b: 0, c: 0, s: 0 }; draw(); renderPanel(); bar(); }
  async function open(src, meta) {
    const im = await loadImg(src);
    if (!im) { toast('Không mở được ảnh', true); return; }
    const k = Math.min(1, MAX / Math.max(im.width, im.height));
    const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    source = Object.assign({ url: '', product: null }, meta || {});
    tab = 'crop';
    setWork(c);
  }

  // ---------- Xử lý ảnh ----------
  function adjusted(src, a) {
    if (!a.b && !a.c && !a.s) return src;
    const c = clone(src); const x = c.getContext('2d');
    const d = x.getImageData(0, 0, c.width, c.height); const p = d.data;
    const cv = a.c * 2.55; const cf = (259 * (cv + 255)) / (255 * (259 - cv)); const bv = a.b * 2.55; const sf = 1 + a.s / 100;
    for (let i = 0; i < p.length; i += 4) {
      let r = cf * (p[i] - 128) + 128 + bv; let g = cf * (p[i + 1] - 128) + 128 + bv; let b = cf * (p[i + 2] - 128) + 128 + bv;
      const gr = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gr + (r - gr) * sf; g = gr + (g - gr) * sf; b = gr + (b - gr) * sf;
      p[i] = r < 0 ? 0 : r > 255 ? 255 : r; p[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; p[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    x.putImageData(d, 0, 0);
    return c;
  }
  function hideRect(r) {
    const x = work.getContext('2d');
    const R = { x: Math.round(clamp(r.x, 0, work.width)), y: Math.round(clamp(r.y, 0, work.height)) };
    R.w = Math.round(clamp(r.x + r.w, 0, work.width)) - R.x; R.h = Math.round(clamp(r.y + r.h, 0, work.height)) - R.y;
    if (R.w < 3 || R.h < 3) return;
    push();
    if (o.hide === 'black') { x.fillStyle = '#000'; x.fillRect(R.x, R.y, R.w, R.h); return; }
    const k = o.hide === 'pixel' ? Math.max(4, o.power * 1.5) : Math.max(3, o.power);
    const t = document.createElement('canvas'); t.width = Math.max(1, Math.round(R.w / k)); t.height = Math.max(1, Math.round(R.h / k));
    const tc = t.getContext('2d');
    tc.imageSmoothingEnabled = o.hide !== 'pixel'; tc.drawImage(work, R.x, R.y, R.w, R.h, 0, 0, t.width, t.height);
    x.save(); x.imageSmoothingEnabled = o.hide !== 'pixel'; x.imageSmoothingQuality = 'high';
    x.drawImage(t, 0, 0, t.width, t.height, R.x, R.y, R.w, R.h);
    if (o.hide === 'blur') x.drawImage(t, 0, 0, t.width, t.height, R.x, R.y, R.w, R.h); // 2 lớp cho mịn hơn
    x.restore();
  }
  function rotate(dir) {
    push();
    const c = document.createElement('canvas'); c.width = work.height; c.height = work.width;
    const x = c.getContext('2d'); x.translate(c.width / 2, c.height / 2); x.rotate(dir * Math.PI / 2); x.drawImage(work, -work.width / 2, -work.height / 2);
    setWork(c, true);
  }
  function flip(h) {
    push();
    const c = document.createElement('canvas'); c.width = work.width; c.height = work.height;
    const x = c.getContext('2d'); x.translate(h ? c.width : 0, h ? 0 : c.height); x.scale(h ? -1 : 1, h ? 1 : -1); x.drawImage(work, 0, 0);
    setWork(c, true);
  }
  const RATIOS = [['free', 'Tự do'], ['5:3', '5:3 (thẻ SP)'], ['16:9', '16:9'], ['4:3', '4:3'], ['1:1', '1:1'], ['4:5', '4:5']];
  const ratioVal = () => { if (o.ratio === 'free') return 0; const [a, b] = o.ratio.split(':').map(Number); return a / b; };
  function initCrop() {
    const r = ratioVal(); const W = work.width; const H = work.height;
    let w = W * 0.9; let h = H * 0.9;
    if (r) { if (w / h > r) w = h * r; else h = w / r; }
    o.crop = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }
  function applyCrop() {
    const c0 = o.crop; if (!c0) return;
    push();
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(c0.w)); c.height = Math.max(1, Math.round(c0.h));
    c.getContext('2d').drawImage(work, c0.x, c0.y, c0.w, c0.h, 0, 0, c.width, c.height);
    setWork(c, true);
  }
  function textBox(x2) {
    const size = work.width * o.tsize / 100;
    x2.font = `800 ${size}px ${A.FONT}`;
    const tw = x2.measureText(o.text).width;
    const pos = o.tpos || { x: work.width - tw - size * 0.8, y: size * 0.4 };
    return { size, tw, x: pos.x, y: pos.y, w: tw + size * 0.6, h: size * 1.35 };
  }
  function drawText(x2) {
    if (!o.text) return null;
    const b = textBox(x2);
    if (o.tbg) { A.rr(x2, b.x, b.y, b.w, b.h, b.size * 0.25); x2.fillStyle = 'rgba(0,0,0,.55)'; x2.fill(); }
    x2.textBaseline = 'middle'; x2.textAlign = 'left';
    if (!o.tbg) { x2.lineJoin = 'round'; x2.lineWidth = b.size * 0.09; x2.strokeStyle = 'rgba(0,0,0,.6)'; x2.strokeText(o.text, b.x + b.size * 0.3, b.y + b.h / 2); }
    x2.fillStyle = o.tcolor; x2.fillText(o.text, b.x + b.size * 0.3, b.y + b.h / 2);
    return b;
  }
  function logoBox() {
    const im = A.imgNow[o.logoSrc]; if (!im) return null;
    const w = work.width * o.lsize / 100; const h = w * im.height / im.width;
    const pos = o.lpos || { x: work.width - w - work.width * 0.02, y: work.height - h - work.width * 0.02 };
    return { im, x: pos.x, y: pos.y, w, h };
  }
  function drawLogo(x2) { const b = logoBox(); if (!b) return null; x2.save(); x2.globalAlpha = o.lop; x2.drawImage(b.im, b.x, b.y, b.w, b.h); x2.restore(); return b; }

  // ---------- Xem trước ----------
  let raf = 0;
  function drawNow() {
    raf = 0;
    if (!work) return;
    if (canvas.width !== work.width || canvas.height !== work.height) { canvas.width = work.width; canvas.height = work.height; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tab === 'adj' ? adjusted(work, o.adj) : work, 0, 0);
    const lw = Math.max(2, work.width * 0.002);
    if (tab === 'crop' && o.crop) {
      const c = o.crop;
      ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(0, 0, work.width, c.y); ctx.fillRect(0, c.y + c.h, work.width, work.height - c.y - c.h); ctx.fillRect(0, c.y, c.x, c.h); ctx.fillRect(c.x + c.w, c.y, work.width - c.x - c.w, c.h);
      ctx.strokeStyle = '#4fd1ff'; ctx.lineWidth = lw; ctx.strokeRect(c.x, c.y, c.w, c.h);
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = lw / 2;
      for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(c.x + c.w * i / 3, c.y); ctx.lineTo(c.x + c.w * i / 3, c.y + c.h); ctx.moveTo(c.x, c.y + c.h * i / 3); ctx.lineTo(c.x + c.w, c.y + c.h * i / 3); ctx.stroke(); }
      const hs = Math.min(work.width, work.height) * 0.035; ctx.fillStyle = '#4fd1ff';
      [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]].forEach(([px, py]) => ctx.fillRect(px - hs / 2, py - hs / 2, hs, hs));
      ctx.restore();
    }
    if (tab === 'hide' && o.sel) { ctx.save(); ctx.setLineDash([lw * 4, lw * 3]); ctx.strokeStyle = '#ff5c7a'; ctx.lineWidth = lw; ctx.strokeRect(o.sel.x, o.sel.y, o.sel.w, o.sel.h); ctx.restore(); }
    if (tab === 'text') { const b = drawText(ctx); if (b) { ctx.save(); ctx.setLineDash([lw * 4, lw * 3]); ctx.strokeStyle = '#4fd1ff'; ctx.lineWidth = lw; ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.restore(); } }
    if (tab === 'logo') { const b = drawLogo(ctx); if (b) { ctx.save(); ctx.setLineDash([lw * 4, lw * 3]); ctx.strokeStyle = '#4fd1ff'; ctx.lineWidth = lw; ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.restore(); } }
  }
  const draw = () => { if (!raf) raf = requestAnimationFrame(drawNow); };

  // ---------- Bảng điều khiển ----------
  const TABS = [['src', 'Ảnh'], ['crop', 'Cắt'], ['rot', 'Xoay'], ['hide', 'Che'], ['text', 'Chữ'], ['logo', 'Logo'], ['adj', 'Màu']];
  const rng = (k, label, min, max, step, val) => `<label class="ai-f"><span>${label} <b data-ev="${k}">${val}</b></span><input type="range" data-e="${k}" min="${min}" max="${max}" step="${step}" value="${val}"></label>`;
  function panelHtml() {
    if (tab === 'src') {
      const imgs = source.product ? source.product.images : (B.product ? B.product.images : []);
      return `<div class="ai-sec"><b>Chọn ảnh để sửa</b><div class="ai-inline"><label class="a-btn a-btn-sm">Chọn ảnh trong máy<input type="file" accept="image/*" hidden data-e-file></label></div>` +
        `<input type="search" data-e-ps placeholder="Hoặc tìm acc để lấy ảnh..." autocomplete="off"><div class="ai-plist" data-e-pl></div>` +
        (imgs && imgs.length ? `<div class="ai-bgs">${imgs.map((u) => `<span class="ai-bg ${source.url === u ? 'on' : ''}"><img src="${esc(u)}" alt="" data-e-img="${esc(u)}"></span>`).join('')}</div>` : '') + '</div>';
    }
    if (!work) return '<div class="ai-sec"><p class="ai-hint">Chưa có ảnh. Mở tab "Ảnh" để chọn.</p></div>';
    if (tab === 'crop') return `<div class="ai-sec"><b>Tỉ lệ</b><div class="ai-tpls">${RATIOS.map(([k, l]) => `<button type="button" class="ai-tpl ${o.ratio === k ? 'on' : ''}" data-e-ratio="${k}">${l}</button>`).join('')}</div><p class="ai-hint">Kéo khung để di chuyển, kéo 4 góc để đổi cỡ.</p><button type="button" class="a-btn a-primary" data-e-crop>Cắt ảnh</button></div>`;
    if (tab === 'rot') return `<div class="ai-sec"><div class="ai-tpls"><button type="button" class="ai-tpl" data-e-rot="-1">⟲ Xoay trái</button><button type="button" class="ai-tpl" data-e-rot="1">⟳ Xoay phải</button><button type="button" class="ai-tpl" data-e-flip="h">⇋ Lật ngang</button><button type="button" class="ai-tpl" data-e-flip="v">⇵ Lật dọc</button></div></div>`;
    if (tab === 'hide') return `<div class="ai-sec"><b>Kiểu che</b><div class="ai-tpls">${[['blur', 'Làm mờ'], ['pixel', 'Ô vuông (pixel)'], ['black', 'Tô đen']].map(([k, l]) => `<button type="button" class="ai-tpl ${o.hide === k ? 'on' : ''}" data-e-hide="${k}">${l}</button>`).join('')}</div>${o.hide !== 'black' ? rng('power', 'Độ che', 4, 40, 1, o.power) : ''}<p class="ai-hint">Kéo một khung trên ảnh (VD chỗ UID) là che ngay. Không gỡ ngược được, lỡ tay thì bấm Hoàn tác.</p></div>`;
    if (tab === 'text') return `<div class="ai-sec"><label class="ai-f"><span>Nội dung</span><input data-e-text value="${esc(o.text)}" maxlength="60" placeholder="VD: MS: ${esc(source.product ? source.product.code : '190070')}"></label>${source.product ? `<button type="button" class="a-btn a-btn-sm a-ghost" data-e-ms>Điền "MS: ${esc(source.product.code)}"</button>` : ''}${rng('tsize', 'Cỡ chữ (% chiều rộng)', 2, 20, 0.5, o.tsize)}<label class="ai-f"><span>Màu chữ</span><input type="color" data-e-color value="${esc(o.tcolor)}"></label><label class="ai-ck"><input type="checkbox" data-e-tbg ${o.tbg ? 'checked' : ''}><span>Nền tối sau chữ</span></label><p class="ai-hint">Chạm / kéo trên ảnh để đặt vị trí chữ.</p><button type="button" class="a-btn a-primary" data-e-tapply>Chèn chữ</button></div>`;
    if (tab === 'logo') return `<div class="ai-sec"><div class="ai-inline"><label class="a-btn a-btn-sm">Chọn logo<input type="file" accept="image/*" hidden data-e-logo></label>${B.logo ? '<button type="button" class="a-btn a-btn-sm a-ghost" data-e-logoshop>Logo shop</button>' : ''}</div>${rng('lsize', 'Cỡ (% chiều rộng)', 5, 50, 1, o.lsize)}${rng('lop', 'Độ rõ', 0.1, 1, 0.05, o.lop)}<p class="ai-hint">Kéo trên ảnh để đặt vị trí logo.</p><button type="button" class="a-btn a-primary" data-e-lapply>Đóng dấu logo</button></div>`;
    if (tab === 'adj') return `<div class="ai-sec">${rng('b', 'Độ sáng', -100, 100, 1, o.adj.b)}${rng('c', 'Tương phản', -100, 100, 1, o.adj.c)}${rng('s', 'Độ đậm màu', -100, 100, 1, o.adj.s)}<div class="ai-inline"><button type="button" class="a-btn a-btn-sm a-ghost" data-e-areset>Về 0</button><button type="button" class="a-btn a-primary" data-e-aapply>Áp dụng màu</button></div></div>`;
    return '';
  }
  function renderPanel() {
    if (AIM.current !== 'edit') return;
    tabsEl.innerHTML = TABS.map(([k, l]) => `<button type="button" class="${k === tab ? 'on' : ''}" data-etab="${k}">${l}</button>`).join('');
    bodyEl.innerHTML = panelHtml();
    $('[data-ai-empty]', app).hidden = !!work; canvas.hidden = !work;
    if (!work) $('[data-ai-empty]', app).textContent = 'Chọn ảnh để bắt đầu sửa';
  }
  function bar() {
    if (AIM.current !== 'edit') return;
    const target = B.fromForm ? (source.url ? 'Thay ảnh trong form' : 'Gắn vào sản phẩm') : (source.product && source.url ? `Lưu đè ảnh acc #${esc(source.product.code)}` : 'Lưu ảnh');
    barEl.innerHTML = `<div class="ai-bar-l"><button type="button" class="a-btn a-btn-sm a-ghost" data-eundo ${undoSt.length ? '' : 'disabled'}>↶</button><button type="button" class="a-btn a-btn-sm a-ghost" data-eredo ${redoSt.length ? '' : 'disabled'}>↷</button></div>` +
      `<div class="ai-bar-r"><button type="button" class="a-btn a-btn-sm a-ghost" data-edl ${work ? '' : 'disabled'}>Tải về</button><button type="button" class="a-btn a-btn-sm a-primary" data-esave ${work ? '' : 'disabled'}>${target}</button></div>`;
  }
  tabsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-etab]'); if (!b || AIM.current !== 'edit') return; tab = b.dataset.etab; if (tab === 'crop' && work && !o.crop) initCrop(); if (tab !== 'hide') o.sel = null; renderPanel(); draw(); });
  bodyEl.addEventListener('input', (e) => {
    if (AIM.current !== 'edit') return;
    const el = e.target;
    if (el.dataset.e) { const v = parseFloat(el.value); if (['b', 'c', 's'].includes(el.dataset.e)) o.adj[el.dataset.e] = v; else o[el.dataset.e] = v; const ev = bodyEl.querySelector(`[data-ev="${el.dataset.e}"]`); if (ev) ev.textContent = v; draw(); }
    if (el.matches('[data-e-text]')) { o.text = el.value; draw(); }
    if (el.matches('[data-e-color]')) { o.tcolor = el.value; draw(); }
    if (el.matches('[data-e-ps]')) { clearTimeout(el._t); el._t = setTimeout(async () => { const r = await api('/admin/acc-image/products?q=' + encodeURIComponent(el.value)); const pl = $('[data-e-pl]', bodyEl); if (pl) pl.innerHTML = r.ok ? r.rows.map((p) => `<button type="button" class="ai-prod" data-e-pid="${p.id}"><b>#${esc(p.code)}</b><span>${esc(p.title)}</span><small>${p.img} ảnh</small></button>`).join('') : ''; }, 250); }
  });
  bodyEl.addEventListener('change', async (e) => {
    if (AIM.current !== 'edit') return;
    const el = e.target;
    if (el.matches('[data-e-tbg]')) { o.tbg = el.checked; draw(); }
    if (el.matches('[data-e-file]') && el.files[0]) await open(URL.createObjectURL(el.files[0]), { url: '', product: null });
    if (el.matches('[data-e-logo]') && el.files[0]) { o.logoSrc = URL.createObjectURL(el.files[0]); await A.preload([o.logoSrc]); draw(); }
  });
  bodyEl.addEventListener('click', async (e) => {
    if (AIM.current !== 'edit') return;
    const t = e.target;
    const pid = t.closest('[data-e-pid]');
    if (pid) { const r = await api('/admin/acc-image/product/' + pid.dataset.ePid); if (r.ok) { source = { url: '', product: r.product }; renderPanel(); } return; }
    const im = t.closest('[data-e-img]'); if (im) { await open(im.dataset.eImg, { url: im.dataset.eImg, product: source.product || B.product }); return; }
    const ra = t.closest('[data-e-ratio]'); if (ra) { o.ratio = ra.dataset.eRatio; initCrop(); renderPanel(); draw(); return; }
    if (t.closest('[data-e-crop]')) { applyCrop(); return; }
    const ro = t.closest('[data-e-rot]'); if (ro) { rotate(+ro.dataset.eRot); return; }
    const fl = t.closest('[data-e-flip]'); if (fl) { flip(fl.dataset.eFlip === 'h'); return; }
    const hd = t.closest('[data-e-hide]'); if (hd) { o.hide = hd.dataset.eHide; renderPanel(); return; }
    if (t.closest('[data-e-ms]')) { o.text = 'MS: ' + source.product.code; renderPanel(); draw(); return; }
    if (t.closest('[data-e-tapply]')) { if (!o.text) { toast('Nhập nội dung chữ', true); return; } push(); drawText(work.getContext('2d')); o.text = ''; o.tpos = null; renderPanel(); draw(); return; }
    if (t.closest('[data-e-logoshop]')) { o.logoSrc = B.logo; await A.preload([o.logoSrc]); draw(); return; }
    if (t.closest('[data-e-lapply]')) { await A.preload([o.logoSrc]); if (!logoBox()) { toast('Chọn logo trước', true); return; } push(); drawLogo(work.getContext('2d')); draw(); return; }
    if (t.closest('[data-e-areset]')) { o.adj = { b: 0, c: 0, s: 0 }; renderPanel(); draw(); return; }
    if (t.closest('[data-e-aapply]')) { push(); const c = adjusted(work, o.adj); work.getContext('2d').drawImage(c, 0, 0); o.adj = { b: 0, c: 0, s: 0 }; renderPanel(); draw(); }
  });

  // ---------- Kéo trên ảnh ----------
  let drag = null;
  const toI = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
  canvas.addEventListener('pointerdown', (e) => {
    if (AIM.current !== 'edit' || !work) return;
    canvas.setPointerCapture(e.pointerId);
    const p = toI(e);
    if (tab === 'crop' && o.crop) {
      const c = o.crop; const hs = Math.min(work.width, work.height) * 0.06;
      const corners = [[c.x, c.y, 'tl'], [c.x + c.w, c.y, 'tr'], [c.x, c.y + c.h, 'bl'], [c.x + c.w, c.y + c.h, 'br']];
      const hit = corners.find(([x, y]) => Math.abs(p.x - x) < hs && Math.abs(p.y - y) < hs);
      if (hit) drag = { type: 'corner', k: hit[2], c0: { ...c } };
      else if (p.x > c.x && p.x < c.x + c.w && p.y > c.y && p.y < c.y + c.h) drag = { type: 'cmove', p0: p, c0: { ...c } };
      return;
    }
    if (tab === 'hide') { drag = { type: 'sel', p0: p }; o.sel = { x: p.x, y: p.y, w: 0, h: 0 }; return; }
    if (tab === 'text' && o.text) { const b = textBox(ctx); o.tpos = { x: p.x - b.w / 2, y: p.y - b.h / 2 }; drag = { type: 'text' }; draw(); return; }
    if (tab === 'logo') { const b = logoBox(); if (b) { o.lpos = { x: p.x - b.w / 2, y: p.y - b.h / 2 }; drag = { type: 'logo' }; draw(); } }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || AIM.current !== 'edit') return;
    const p = toI(e); const W = work.width; const H = work.height;
    if (drag.type === 'cmove') { const c = o.crop; c.x = clamp(drag.c0.x + p.x - drag.p0.x, 0, W - c.w); c.y = clamp(drag.c0.y + p.y - drag.p0.y, 0, H - c.h); }
    if (drag.type === 'corner') {
      const c0 = drag.c0; const r = ratioVal();
      const ax = drag.k.includes('l') ? c0.x + c0.w : c0.x; const ay = drag.k.includes('t') ? c0.y + c0.h : c0.y; // góc đối diện đứng yên
      let w = Math.abs(clamp(p.x, 0, W) - ax); let h = Math.abs(clamp(p.y, 0, H) - ay);
      if (r) { if (w / h > r) w = h * r; else h = w / r; }
      w = Math.max(20, w); h = Math.max(20, h);
      const x = drag.k.includes('l') ? ax - w : ax; const y = drag.k.includes('t') ? ay - h : ay;
      if (x >= 0 && y >= 0 && x + w <= W + 0.5 && y + h <= H + 0.5) o.crop = { x, y, w, h };
    }
    if (drag.type === 'sel') { o.sel = { x: Math.min(p.x, drag.p0.x), y: Math.min(p.y, drag.p0.y), w: Math.abs(p.x - drag.p0.x), h: Math.abs(p.y - drag.p0.y) }; }
    if (drag.type === 'text') { const b = textBox(ctx); o.tpos = { x: p.x - b.w / 2, y: p.y - b.h / 2 }; }
    if (drag.type === 'logo') { const b = logoBox(); if (b) o.lpos = { x: p.x - b.w / 2, y: p.y - b.h / 2 }; }
    draw();
  });
  const up = () => { if (!drag) return; if (drag.type === 'sel' && o.sel) { hideRect(o.sel); o.sel = null; } drag = null; draw(); };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);

  // ---------- Thanh dưới ----------
  barEl.addEventListener('click', async (e) => {
    if (AIM.current !== 'edit') return;
    if (e.target.closest('[data-eundo]') && undoSt.length) { redoSt.push(clone(work)); work = undoSt.pop(); o.crop = null; draw(); bar(); return; }
    if (e.target.closest('[data-eredo]') && redoSt.length) { undoSt.push(clone(work)); work = redoSt.pop(); o.crop = null; draw(); bar(); return; }
    if (!work) return;
    const blob = await new Promise((res) => work.toBlob(res, 'image/webp', 0.92));
    if (e.target.closest('[data-edl]')) { AIM.download(blob, 'anh-sua.webp'); return; }
    const sv = e.target.closest('[data-esave]'); if (!sv) return;
    sv.disabled = true; toast('Đang lưu ảnh...');
    const pid = !B.fromForm && source.product && source.url ? source.product.id : 0;
    const r = await upload('/admin/acc-image/save', { product_id: pid, attach: pid ? '1' : '0', replace: source.url || '' }, new File([blob], 'edit.webp', { type: 'image/webp' }), 'accimg');
    sv.disabled = false;
    if (!r.ok) { toast(r.message || 'Không lưu được', true); return; }
    if (AIM.toForm({ urls: [r.url], replace: source.url || '' })) toast('Đã gửi ảnh về form sản phẩm. Nhớ bấm Lưu ở form.');
    else if (pid) { toast('Đã lưu đè ảnh của acc #' + source.product.code); source.url = r.url; }
    else { toast('Đã lưu ảnh'); prompt('Link ảnh đã lưu:', location.origin + r.url); }
  });

  AIM.MODES.edit = {
    enter() { renderPanel(); bar(); draw(); },
  };
  if (B.img) { source = { url: B.img, product: B.product }; open(B.img, source); }
})();
