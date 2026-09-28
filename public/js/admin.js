(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-toggle-side]')) $('#aSide').classList.toggle('open');
    const tg = e.target.closest('[data-toggle-el]');
    if (tg) { const el = $(tg.dataset.toggleEl); if (el) el.hidden = !el.hidden; }
    const rc = e.target.closest('[data-reveal-click]');
    if (rc) rc.classList.toggle('show');
    if (e.target.closest('[data-add-attr]')) {
      const row = document.createElement('div');
      row.className = 'a-attr';
      row.innerHTML = '<input name="attr_k" placeholder="Tên"><input name="attr_v" placeholder="Giá trị"><button type="button" class="a-btn a-xs a-danger" data-remove-attr aria-label="Xóa"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
      $('#attrList').appendChild(row);
    }
    const rm = e.target.closest('[data-remove-attr]');
    if (rm) rm.parentElement.remove();
  });

  // Chọn tất cả
  const all = $('[data-check-all]');
  if (all) all.addEventListener('change', () => $$('input[name=ids]').forEach((c) => { c.checked = all.checked; }));

  // Tự submit bộ lọc
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.submit()));

  // Đổi loại sản phẩm -> ẩn/hiện ô
  const typeSel = $('[data-type-select]');
  if (typeSel) typeSel.addEventListener('change', () => {
    $('[data-type-account]').hidden = typeSel.value !== 'account';
    $('[data-type-stock]').hidden = typeSel.value !== 'stock';
  });

  // Xem trước ảnh
  $$('input[type=file][data-preview]').forEach((inp) => inp.addEventListener('change', () => {
    const f = inp.files[0];
    if (!f) return;
    let img = inp.previousElementSibling;
    if (!img || img.tagName !== 'IMG') { img = document.createElement('img'); img.className = 'a-preview'; inp.before(img); }
    img.src = URL.createObjectURL(f);
  }));

  // Xác nhận & chống submit 2 lần
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.dataset.confirm && !confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (f.dataset.submitting) { e.preventDefault(); return; }
    if (f.method.toLowerCase() === 'post') {
      f.dataset.submitting = '1';
      setTimeout(() => { delete f.dataset.submitting; }, 5000);
    }
  });
})();
