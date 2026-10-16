/* Giao diện -> Quản lý ảnh: chọn file là gửi luôn; dán HTML để nạp ảnh nhân vật / vũ khí */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const csrf = $('meta[name="csrf-token"]')?.content || '';
  document.addEventListener('change', (e) => { if (e.target.matches('[data-img-auto]') && e.target.files.length) e.target.form.submit(); });

  // Thư viện: mỗi lần 120 mục, kéo tới cuối thì tự tải tiếp
  const more = $('[data-lib-more]');
  const grid = $('[data-lib-grid]');
  if (more && grid) {
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true; more.disabled = true;
      const u = new URL(location.href);
      u.searchParams.set('page', more.dataset.next);
      u.searchParams.set('frag', '1');
      try {
        const j = await (await fetch(u, { headers: { Accept: 'application/json' } })).json();
        if (j.ok) {
          grid.insertAdjacentHTML('beforeend', j.html);
          more.dataset.next = +more.dataset.next + 1;
          more.textContent = 'Tải thêm';
          if (!j.more) { more.parentNode.remove(); io && io.disconnect(); }
        }
      } catch (e) { /* bấm lại để thử */ }
      busy = false; more.disabled = false;
    };
    more.addEventListener('click', load);
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { if (es[0].isIntersecting) load(); }, { rootMargin: '300px' }) : null;
    if (io) io.observe(more);
  }

  const box = $('[data-img-import]');
  if (!box) return;
  const out = $('[data-img-out]', box);
  const html = $('[data-img-html]', box);
  const show = (t, err) => { out.hidden = false; out.className = 'a-small a-img-out ' + (err ? 'a-text-err' : ''); out.textContent = t; };
  async function send(preview, btn) {
    if (!html.value.trim()) { show('Dán HTML trước', true); return; }
    btn.disabled = true;
    show(preview ? 'Đang kiểm tra...' : 'Đang tải ảnh, vui lòng chờ...');
    let j;
    try {
      const r = await fetch('/admin/images/hoyo/import', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
        body: JSON.stringify({ game: box.dataset.game, kind: box.dataset.kind, html: html.value, preview: preview ? 1 : 0 }),
      });
      j = await r.json();
    } catch (e) { j = { ok: false, message: 'Lỗi kết nối hoặc HTML quá lớn' }; }
    btn.disabled = false;
    if (!j.ok) { show(j.message || 'Có lỗi', true); return; }
    if (preview) {
      show('Tìm thấy ' + j.total + ' mục · chưa có trong thư viện: ' + j.fresh + (j.names.length ? ' — ' + j.names.join(', ') : '') +
        (j.had.length ? '\nĐã có trong thư viện (' + j.had.length + '): ' + j.had.join(', ') : '') +
        (j.dup.length ? '\nTên lặp 2 lần trong HTML đã dán: ' + j.dup.join(', ') : ''));
      return;
    }
    let t = 'Đã thêm ' + j.added.length + (j.added.length ? ': ' + j.added.join(', ') : '') +
      (j.existed.length ? '\nĐã có trong thư viện (' + j.existed.length + '): ' + j.existed.join(', ') : '') +
      (j.dup.length ? '\nTên lặp 2 lần trong HTML đã dán: ' + j.dup.join(', ') : '');
    if (j.failed.length) t += '\nKhông tải được ảnh: ' + j.failed.join(', ');
    if (j.filled) t += '\nCập nhật ảnh cho ' + j.filled + ' acc';
    show(t, !!j.failed.length && !j.added.length);
    if (j.added.length) setTimeout(() => location.reload(), 1500);
  }
  $('[data-img-check]', box).addEventListener('click', (e) => send(true, e.currentTarget));
  $('[data-img-run]', box).addEventListener('click', (e) => send(false, e.currentTarget));
})();

// Cung mệnh / Tinh Hồn / Ý Cảnh: bấm nhân vật -> 6 ô xếp theo đường cong, chọn màu vòng bo, dán HTML hoặc sửa từng ô
(() => {
  'use strict';
  const app = document.querySelector('[data-cst-app]');
  const modal = document.querySelector('[data-cst-modal]');
  if (!app || !modal) return;
  const $ = (s, r = modal) => r.querySelector(s);
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const LABEL = app.dataset.label;
  const PAL = JSON.parse(app.dataset.palette || '[]');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let C = null; let sel = 0;

  const api = async (url, body) => {
    try {
      const opt = { headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' } };
      if (body !== undefined) {
        opt.method = 'POST';
        if (body instanceof FormData) opt.body = body;
        else { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
      }
      return await (await fetch(url, opt)).json();
    } catch (e) { return { ok: false, message: 'Lỗi kết nối' }; }
  };
  const msg = (t, err) => { const m = $('[data-cst-msg]'); m.hidden = !t; m.className = 'a-small ' + (err ? 'a-text-err' : 'a-muted'); m.textContent = t || ''; };
  const ic = (icon, extra = '') => `<span class="cst-ic ${extra}">${icon ? `<img src="${esc(icon)}" alt="">` : '<i>+</i>'}</span>`;
  const row = (s) => `<div class="a-cst-row">${ic(s.icon)}<div><b>${esc(s.name) || '<span class="a-muted">Chưa có tên</span>'}</b><small>${esc(LABEL)} <em>${s.slot}</em></small></div></div>`;

  function render() {
    modal.style.setProperty('--rc', C.ring);
    $('[data-cst-title]').textContent = `${C.name} · ${LABEL}`;
    $('[data-cst-portrait]').src = C.icon;
    $('[data-cst-arc]').innerHTML = C.slots.map((s) => `<button type="button" class="a-cst-slot s${s.slot} ${sel === s.slot ? 'on' : ''}" data-cst-slot="${s.slot}" title="${esc(LABEL)} ${s.slot}${s.name ? ': ' + esc(s.name) : ''}">${ic(s.icon, s.icon ? '' : 'empty')}</button>`).join('');
    $('[data-cst-pal]').innerHTML = PAL.map(([c, n]) => `<button type="button" class="a-cst-sw ${c === C.ring ? 'on' : ''}" style="--c:${c}" data-cst-ring="${c}" title="${esc(n)}"></button>`).join('');
    const p = PAL.find((x) => x[0] === C.ring);
    $('[data-cst-color]').value = C.ring;
    $('.a-cst-custom').firstChild.textContent = p ? p[1] + ' · ' : 'Màu tự chọn · ';
    $('[data-cst-list]').innerHTML = C.slots.map(row).join('');
    const ed = $('[data-cst-edit]');
    ed.hidden = !sel;
    if (sel) {
      const s = C.slots[sel - 1];
      $('[data-cst-edit-t]').textContent = `${LABEL} ${sel}`;
      $('[data-cst-name]').value = s.name || '';
      $('[data-cst-file]').value = ''; $('[data-cst-url]').value = '';
      $('[data-cst-slot-del]').hidden = !s.icon && !s.name;
    }
  }
  // Cập nhật ô ở lưới bên ngoài (số ô, màu)
  function syncCard() {
    const b = app.querySelector(`[data-cst-open="${C.id}"]`);
    if (!b) return;
    const n = C.slots.filter((s) => s.icon).length;
    b.style.setProperty('--rc', C.ring);
    const sm = b.querySelector('small'); sm.innerHTML = `<i></i>${n}/6`; sm.classList.toggle('full', n >= 6);
  }
  async function open(id) {
    const j = await api('/admin/images/const/' + id);
    if (!j.ok) return alert(j.message || 'Có lỗi');
    C = j.c; sel = 0;
    $('[data-cst-html]').value = ''; msg('');
    render();
    modal.hidden = false; document.body.classList.add('a-modal-open');
  }
  const close = () => { modal.hidden = true; document.body.classList.remove('a-modal-open'); };
  const done = (j, t) => { if (!j.ok) { msg(j.message || 'Có lỗi', true); return false; } C = j.c; render(); syncCard(); if (t) msg(t); return true; };

  app.addEventListener('click', (e) => { const b = e.target.closest('[data-cst-open]'); if (b) open(b.dataset.cstOpen); });
  modal.addEventListener('click', async (e) => {
    const t = e.target;
    if (t === modal || t.closest('[data-cst-close]')) return close();
    const sl = t.closest('[data-cst-slot]');
    if (sl) { sel = sel === +sl.dataset.cstSlot ? 0 : +sl.dataset.cstSlot; render(); if (sel) $('[data-cst-name]').focus({ preventScroll: true }); return; }
    const sw = t.closest('[data-cst-ring]');
    if (sw) { done(await api(`/admin/images/const/${C.id}/ring`, { ring: sw.dataset.cstRing })); return; }
    if (t.closest('[data-cst-parse]') || t.closest('[data-cst-import]')) {
      const html = $('[data-cst-html]').value;
      if (!html.trim()) return msg('Dán HTML trước', true);
      const save = !!t.closest('[data-cst-import]');
      const btn = t.closest('button'); btn.disabled = true;
      msg(save ? 'Đang tải ảnh...' : 'Đang đọc...');
      const j = await api(`/admin/images/const/${C.id}/${save ? 'import' : 'parse'}`, { html });
      btn.disabled = false;
      if (!j.ok) return msg(j.message || 'Có lỗi', true);
      if (!save) {
        $('[data-cst-list]').innerHTML = '<p class="a-small a-muted">Xem trước — bấm Lưu để áp dụng:</p>' + j.items.map((x) => row({ slot: x.slot, name: x.name, icon: x.src })).join('');
        return msg(`Tìm thấy ${j.items.length} ô: ${j.items.map((x) => x.slot).join(', ')}`);
      }
      if (done(j, `Đã lưu ${j.saved} ô` + (j.failed.length ? ` · không tải được ảnh ô ${j.failed.join(', ')}` : ''))) $('[data-cst-html]').value = '';
      return;
    }
    if (t.closest('[data-cst-slot-save]')) {
      const fd = new FormData();
      fd.append('name', $('[data-cst-name]').value);
      fd.append('url', $('[data-cst-url]').value);
      const f = $('[data-cst-file]').files[0]; if (f) fd.append('image', f);
      done(await api(`/admin/images/const/${C.id}/slot/${sel}`, fd), `Đã lưu ${LABEL} ${sel}`);
      return;
    }
    if (t.closest('[data-cst-slot-del]')) {
      if (!confirm(`Xóa ${LABEL} ${sel}?`)) return;
      const s = sel; sel = 0;
      done(await api(`/admin/images/const/${C.id}/slot/${s}/delete`, {}), `Đã xóa ${LABEL} ${s}`);
    }
  });
  $('[data-cst-color]').addEventListener('change', async (e) => done(await api(`/admin/images/const/${C.id}/ring`, { ring: e.target.value })));
  $('[data-cst-color]').addEventListener('input', (e) => modal.style.setProperty('--rc', e.target.value));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });
})();
