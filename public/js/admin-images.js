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
