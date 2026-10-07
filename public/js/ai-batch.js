/* Tạo ảnh acc — chế độ Hàng loạt: chọn nhiều acc VIP + 1 mẫu -> tạo ảnh lần lượt và gắn làm ảnh đầu của từng acc */
(() => {
  'use strict';
  const A = window.AIC; const AIM = window.AIM;
  if (!A || !AIM) return;
  const { B, app, $, esc, api, upload, toast } = A;
  const { canvas, ctx, tabsEl, bodyEl, barEl } = AIM;
  let rows = [];
  const chosen = new Set();
  let tplKey = 'A';
  let also53 = true;
  let bgSrc = '';
  let running = false;

  const tplList = () => [...Object.entries(A.TPL).map(([k, t]) => ({ key: k, name: t.name, data: t })), ...(B.tpls || []).map((t) => ({ key: 's:' + t.id, name: t.name, data: t.data }))];
  function panel() {
    if (AIM.current !== 'batch') return;
    tabsEl.innerHTML = '<button type="button" class="on">Tạo ảnh cho nhiều acc</button>';
    bodyEl.innerHTML = `<div class="ai-sec"><b>1. Chọn mẫu</b><select data-b-tpl>${tplList().map((t) => `<option value="${esc(t.key)}" ${t.key === tplKey ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>` +
      `<label class="ai-f"><span>Ảnh nền</span><select data-b-bg><option value="">Theo mẫu / không có</option>${(B.bgs || []).map((b) => `<option value="${esc(b.u)}" ${bgSrc === b.u ? 'selected' : ''}>${esc(b.u.split('/').pop())}</option>`).join('')}</select></label>` +
      `<label class="ai-ck"><input type="checkbox" data-b-53 ${also53 ? 'checked' : ''}><span>Kèm bản 5:3 làm ảnh đại diện</span></label></div>` +
      `<div class="ai-sec"><b>2. Chọn acc</b> <small data-b-n>${chosen.size} đã chọn</small><div class="ai-inline"><input type="search" data-b-q placeholder="Tìm mã / tên acc..." autocomplete="off"><button type="button" class="a-btn a-btn-sm a-ghost" data-b-all>Chọn tất cả</button></div>` +
      `<div class="ai-blist" data-b-list>${rows.map((p) => `<label class="ai-brow"><input type="checkbox" data-b-id="${p.id}" ${chosen.has(p.id) ? 'checked' : ''}><b>#${esc(p.code)}</b><span>${esc(p.title)}</span><small>${esc((B.games[p.game] || {}).name || '')} · ${p.img} ảnh</small></label>`).join('') || '<p class="ai-hint">Không có acc VIP nào có Chi tiết tài khoản.</p>'}</div></div>` +
      `<div class="ai-sec"><div class="ai-prog" data-b-prog hidden><div data-b-bar></div></div><p class="ai-hint" data-b-msg>Ảnh tạo xong được gắn làm ảnh đầu tiên của từng acc.</p></div>`;
  }
  function bar() {
    if (AIM.current !== 'batch') return;
    barEl.innerHTML = `<div class="ai-bar-l"></div><div class="ai-bar-r">${AIM.resSelect()}${AIM.outSelect()}<button type="button" class="a-btn a-btn-sm a-primary" data-b-run ${chosen.size && !running ? '' : 'disabled'}>Tạo ${chosen.size} ảnh</button></div>`;
  }
  async function load(q) {
    const r = await api('/admin/acc-image/products?q=' + encodeURIComponent(q || ''));
    rows = r.ok ? r.rows : [];
    panel(); bar();
  }
  async function preview() {
    const first = rows.find((p) => chosen.has(p.id)) || rows[0];
    $('[data-ai-empty]', app).hidden = !!first; canvas.hidden = !first;
    if (!first) { $('[data-ai-empty]', app).textContent = 'Chưa có acc để xem trước'; return; }
    const st = await stateFor(first.id);
    if (!st) return;
    await A.preload(A.srcsOf(st));
    canvas.width = st.W; canvas.height = st.H;
    A.render(ctx, st, false);
  }
  async function stateFor(id) {
    const r = await api('/admin/acc-image/product/' + id);
    if (!r.ok) return null;
    const st = A.blank();
    const t = tplList().find((x) => x.key === tplKey) || tplList()[0];
    A.applyTpl(st, t.data);
    if (bgSrc) st.bg.src = bgSrc;
    A.fromDetail(st, r.product.detail, r.product);
    st.grids.c.items = A.sortItems(st.grids.c.items); st.grids.w.items = A.sortItems(st.grids.w.items);
    return st;
  }
  async function run() {
    if (running || !chosen.size) return;
    if (!confirm(`Tạo ảnh và gắn vào ${chosen.size} acc?`)) return;
    running = true; bar();
    const ids = rows.filter((p) => chosen.has(p.id)).map((p) => p.id);
    const prog = $('[data-b-prog]', bodyEl); const pb = $('[data-b-bar]', bodyEl); const msg = $('[data-b-msg]', bodyEl);
    prog.hidden = false;
    let ok = 0; const fail = [];
    for (let i = 0; i < ids.length; i++) {
      const p = rows.find((x) => x.id === ids[i]);
      msg.textContent = `Đang tạo ${i + 1}/${ids.length}: #${p.code}`;
      try {
        const st = await stateFor(p.id);
        if (!st) throw new Error('không tải được');
        const o = AIM.out();
        const list = [await A.exportBlob(st, o.type, o.q, AIM.res())];
        if (also53 && st.W + 'x' + st.H !== '1500x900') { const s2 = JSON.parse(JSON.stringify(st)); A.applyTpl(s2, A.TPL.C); s2.bg = st.bg; list.push(await A.exportBlob(s2, o.type, o.q, AIM.res())); }
        for (const b of list) { // bản đầy đủ trước, bản 5:3 sau -> bản 5:3 đứng đầu
          const r = await upload('/admin/acc-image/save', { product_id: p.id, attach: '1' }, AIM.fileOf(b, 'acc'), 'accimg');
          if (!r.ok) throw new Error(r.message);
        }
        ok++;
      } catch (e) { fail.push('#' + p.code); }
      pb.style.width = Math.round((i + 1) / ids.length * 100) + '%';
    }
    msg.textContent = `Xong: ${ok}/${ids.length} acc` + (fail.length ? ` · lỗi: ${fail.join(', ')}` : '');
    toast(msg.textContent, !!fail.length);
    running = false; chosen.clear(); await load($('[data-b-q]', bodyEl)?.value || '');
  }

  bodyEl.addEventListener('change', (e) => {
    if (AIM.current !== 'batch') return;
    const el = e.target;
    if (el.matches('[data-b-tpl]')) { tplKey = el.value; preview(); }
    if (el.matches('[data-b-bg]')) { bgSrc = el.value; preview(); }
    if (el.matches('[data-b-53]')) also53 = el.checked;
    if (el.matches('[data-b-id]')) { const id = +el.dataset.bId; if (el.checked) chosen.add(id); else chosen.delete(id); $('[data-b-n]', bodyEl).textContent = chosen.size + ' đã chọn'; bar(); if (chosen.size === 1 && el.checked) preview(); }
  });
  bodyEl.addEventListener('input', (e) => { if (AIM.current === 'batch' && e.target.matches('[data-b-q]')) { clearTimeout(e.target._t); const v = e.target.value; e.target._t = setTimeout(async () => { await load(v); const q = $('[data-b-q]', bodyEl); if (q) { q.value = v; q.focus(); } }, 300); } });
  bodyEl.addEventListener('click', (e) => { if (AIM.current === 'batch' && e.target.closest('[data-b-all]')) { rows.forEach((p) => chosen.add(p.id)); panel(); bar(); } });
  barEl.addEventListener('click', (e) => { if (AIM.current === 'batch' && e.target.closest('[data-b-run]')) run(); });

  AIM.MODES.batch = {
    async enter() { panel(); bar(); await load(''); preview(); },
  };
})();
