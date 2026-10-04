/* Giao diện -> Quản lý ảnh: chọn file là gửi luôn; dán HTML để nạp ảnh nhân vật / vũ khí */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const csrf = $('meta[name="csrf-token"]')?.content || '';
  document.addEventListener('change', (e) => { if (e.target.matches('[data-img-auto]') && e.target.files.length) e.target.form.submit(); });

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
      show('Tìm thấy ' + j.total + ' mục' + (j.dup ? ' (bỏ ' + j.dup + ' trùng tên)' : '') + ' · chưa có ảnh: ' + j.fresh + (j.names.length ? ' — ' + j.names.join(', ') : ''));
      return;
    }
    let t = 'Đã thêm ' + j.added.length + ' · đã có sẵn ' + j.existed + (j.dup ? ' · trùng tên ' + j.dup : '');
    if (j.failed.length) t += ' · không tải được: ' + j.failed.join(', ');
    if (j.filled) t += ' · cập nhật ảnh cho ' + j.filled + ' acc';
    show(t, !!j.failed.length && !j.added.length);
    if (j.added.length) setTimeout(() => location.reload(), 1500);
  }
  $('[data-img-check]', box).addEventListener('click', (e) => send(true, e.currentTarget));
  $('[data-img-run]', box).addEventListener('click', (e) => send(false, e.currentTarget));
})();
