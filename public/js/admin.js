(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const csrf = $('meta[name="csrf-token"]')?.content || '';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } },
  };

  function toast(msg, isErr) {
    const t = $('#aToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  async function post(url, data) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
      body: JSON.stringify(data || {}),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  // ---------------- Modal ----------------
  const modal = $('#aModal');
  const modalBody = $('#aModalBody');
  async function openModal(url, title) {
    if (!modal) return;
    $('#aModalTitle').textContent = title || '';
    modalBody.innerHTML = '<div class="a-loading">Đang tải...</div>';
    modal.hidden = false;
    document.body.classList.add('a-modal-open');
    try {
      const r = await fetch(url, { headers: { 'X-Requested-With': 'fetch' } });
      if (!r.ok) throw new Error();
      modalBody.innerHTML = await r.text();
      // Sau khi lưu sẽ quay lại đúng trang đang xem
      $$('input[name="_back"]', modalBody).forEach((i) => { i.value = location.pathname + location.search; });
      const first = $('[autofocus]', modalBody) || $('input:not([type=hidden]), select, textarea', modalBody);
      if (first) setTimeout(() => first.focus(), 50);
    } catch (e) {
      modalBody.innerHTML = '<p class="a-empty">Không tải được nội dung. Hãy thử lại.</p>';
    }
  }
  function closeModal() {
    if (!modal) return;
    modal.hidden = true;
    modalBody.innerHTML = '';
    document.body.classList.remove('a-modal-open');
  }
  if (modal) {
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });
  }

  // ---------------- Accordion ----------------
  function setOpen(acc, open) {
    acc.classList.toggle('open', open);
    const key = acc.dataset.acc;
    if (key) {
      const st = store.get('acc') || {};
      if (open) st[key] = 1; else delete st[key];
      store.set('acc', st);
    }
    if (open) loadRows(acc);
  }

  // Tải danh sách sản phẩm của danh mục khi mở lần đầu
  async function loadRows(acc, page) {
    const url = acc.dataset.rowsUrl;
    if (!url) return;
    const box = $(':scope > [data-rows]', acc);
    if (!page && acc.dataset.loaded) return;
    acc.dataset.loaded = '1';
    try {
      const r = await fetch(url + (page ? '&page=' + page : ''), { headers: { 'X-Requested-With': 'fetch' } });
      const html = await r.text();
      if (!page) { box.innerHTML = html; return; }
      const tpl = document.createElement('template');
      tpl.innerHTML = '<table><tbody>' + html.replace(/<div class="a-more"[\s\S]*$/, '') + '</tbody></table>';
      const tbody = $('[data-rows-body]', box);
      $$('tr', tpl.content).forEach((tr) => tbody.appendChild(tr));
      const moreTpl = document.createElement('template');
      moreTpl.innerHTML = (html.match(/<div class="a-more"[\s\S]*$/) || [''])[0];
      const oldMore = $('[data-more-wrap]', box);
      if (oldMore) oldMore.remove();
      if (moreTpl.content.firstElementChild) box.appendChild(moreTpl.content.firstElementChild);
    } catch (e) {
      box.innerHTML = '<div class="a-empty">Không tải được danh sách.</div>';
      delete acc.dataset.loaded;
    }
  }

  function initAccordions() {
    const st = store.get('acc') || {};
    $$('.a-acc').forEach((acc) => { if (st[acc.dataset.acc]) setOpen(acc, true); });
    // Mở theo #game-1 / #cat-2 trên URL
    if (location.hash) {
      const target = document.getElementById(location.hash.slice(1));
      if (target && target.classList.contains('a-acc')) {
        let p = target;
        while (p) { if (p.classList.contains('a-acc')) setOpen(p, true); p = p.parentElement.closest('.a-acc'); }
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
      }
    }
  }
  initAccordions();

  // ---------------- Chọn hàng loạt ----------------
  function updateBulk() {
    const bar = $('#bulkForm');
    if (!bar) return;
    const n = $$('input[name=ids][form=bulkForm]:checked').length;
    bar.hidden = n === 0;
    const c = $('[data-bulk-count]', bar);
    if (c) c.textContent = n;
  }

  // ---------------- Sự kiện click ----------------
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-toggle-side]')) $('#aSide').classList.toggle('open');

    const mo = t.closest('[data-modal-url]');
    if (mo) { e.preventDefault(); openModal(mo.dataset.modalUrl, mo.dataset.modalTitle); return; }
    if (t.closest('[data-modal-close]')) { closeModal(); return; }

    const at = t.closest('[data-acc-toggle]');
    if (at) { const acc = at.closest('.a-acc'); setOpen(acc, !acc.classList.contains('open')); return; }
    const all = t.closest('[data-acc-all]');
    if (all) { $$('.a-acc:not(.a-acc-sub)').forEach((a) => setOpen(a, all.dataset.accAll === 'open')); return; }

    const more = t.closest('[data-load-more]');
    if (more) { more.disabled = true; more.textContent = 'Đang tải...'; loadRows(more.closest('.a-acc'), more.dataset.loadMore); return; }

    const mv = t.closest('[data-move]');
    if (mv) {
      mv.disabled = true;
      try {
        const r = await post(mv.dataset.move, { dir: mv.dataset.dir });
        if (r.ok) location.reload(); else { toast('Không thể di chuyển', true); mv.disabled = false; }
      } catch (err) { toast('Lỗi kết nối', true); mv.disabled = false; }
      return;
    }

    const tg = t.closest('[data-toggle-el]');
    if (tg) { const el = $(tg.dataset.toggleEl); if (el) el.hidden = !el.hidden; }
    const rc = t.closest('[data-reveal-click]');
    if (rc) rc.classList.toggle('show');

    if (t.closest('[data-add-attr]')) {
      const scope = t.closest('form') || document;
      const list = $('[data-attr-list]', scope) || $('#attrList');
      const row = document.createElement('div');
      row.className = 'a-attr';
      row.innerHTML = '<input name="attr_k" placeholder="Tên"><input name="attr_v" placeholder="Giá trị">' +
        '<button type="button" class="a-icon-btn a-icon-danger" data-remove-attr aria-label="Xóa"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
      list.appendChild(row);
      row.querySelector('input').focus();
    }
    const rm = t.closest('[data-remove-attr]');
    if (rm) rm.parentElement.remove();
  });

  // ---------------- Sự kiện change ----------------
  document.addEventListener('change', async (e) => {
    const t = e.target;

    // Công tắc hiển thị
    if (t.matches('input[data-toggle-url]')) {
      const want = t.checked;
      t.disabled = true;
      try {
        const r = await post(t.dataset.toggleUrl);
        if (!r.ok) throw new Error(r.message || 'Lỗi');
        t.checked = r.active;
        const tr = t.closest('tr');
        if (tr && tr.closest('.a-products, .a-card')) tr.classList.toggle('a-row-off', !r.active);
        toast(r.active ? 'Đã bật hiển thị' : 'Đã ẩn');
      } catch (err) {
        t.checked = !want;
        toast(err.message && err.message !== 'Lỗi' ? err.message : 'Không cập nhật được', true);
      } finally { t.disabled = false; }
      return;
    }

    if (t.matches('[data-check-all]')) {
      const scope = t.closest('table') || document;
      $$('input[name=ids]', scope).forEach((c) => { c.checked = t.checked; });
      updateBulk();
      return;
    }
    if (t.matches('input[name=ids][form=bulkForm]')) { updateBulk(); return; }

    if (t.matches('[data-autosubmit]')) { t.form.submit(); return; }

    // Đổi loại sản phẩm -> ẩn/hiện ô tương ứng
    if (t.matches('[data-type-select]')) {
      const f = t.closest('form') || document;
      $('[data-type-account]', f).hidden = t.value !== 'account';
      $('[data-type-stock]', f).hidden = t.value !== 'stock';
      return;
    }

    if (t.classList.contains('a-invalid')) {
      t.classList.remove('a-invalid');
      if (t.nextElementSibling?.classList.contains('a-field-error')) t.nextElementSibling.remove();
    }
    // Xem trước 1 ảnh
    if (t.matches('input[type=file][data-preview-input]')) {
      const f = t.files[0];
      const box = $('[data-preview-box]', t.closest('form') || document);
      if (f && box) box.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`;
      return;
    }
    // Xem trước nhiều ảnh sản phẩm
    if (t.matches('input[type=file][data-preview-multi-input]')) {
      const box = $('[data-preview-multi]', t.closest('form') || document);
      $$('.a-img-new', box).forEach((n) => n.remove());
      Array.from(t.files).slice(0, 10).forEach((f) => {
        const el = document.createElement('label');
        el.className = 'a-img-keep a-img-new';
        el.innerHTML = `<img src="${URL.createObjectURL(f)}" alt=""><span>Ảnh mới</span>`;
        box.appendChild(el);
      });
    }
  });

  // ---------------- Kiểm tra ô bắt buộc trước khi gửi ----------------
  function validateForm(f) {
    $$('.a-field-error', f).forEach((el) => el.remove());
    $$('.a-invalid', f).forEach((el) => el.classList.remove('a-invalid'));
    let first = null;
    $$('[required]', f).forEach((el) => {
      if (el.disabled || el.closest('[hidden]') || el.type === 'radio' || el.type === 'checkbox') return;
      let msg = '';
      if (el.type === 'file') { if (!el.files.length) msg = 'Vui lòng chọn ảnh'; }
      else if (!String(el.value || '').trim()) msg = el.tagName === 'SELECT' ? 'Vui lòng chọn một mục' : 'Vui lòng nhập thông tin này';
      else if (el.type === 'number' && el.min !== '' && Number(el.value) < Number(el.min)) msg = 'Giá trị không hợp lệ';
      if (!msg) return;
      el.classList.add('a-invalid');
      const d = document.createElement('div');
      d.className = 'a-field-error';
      d.textContent = msg;
      el.insertAdjacentElement('afterend', d);
      first = first || el;
    });
    if (first) {
      first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      first.focus({ preventScroll: true });
      toast('Vui lòng điền đủ các ô bắt buộc (*)', true);
      return false;
    }
    return true;
  }
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('a-invalid')) {
      t.classList.remove('a-invalid');
      if (t.nextElementSibling?.classList.contains('a-field-error')) t.nextElementSibling.remove();
    }
    if (t.matches('[data-count-lines]')) {
      const n = t.value.split(/\r?\n/).filter((l) => l.trim()).length;
      const out = $('[data-line-count]', t.closest('form') || document);
      if (out) out.textContent = n.toLocaleString('vi-VN') + ' acc';
    }
  });

  // ---------------- Xác nhận & chống gửi 2 lần ----------------
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.hasAttribute('data-validate') && !validateForm(f)) { e.preventDefault(); return; }
    if (f.dataset.confirm && !confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (f.dataset.submitting) { e.preventDefault(); return; }
    if (f.method.toLowerCase() === 'post') {
      f.dataset.submitting = '1';
      $$('button:not([type=button])', f).forEach((b) => { b.disabled = true; });
      setTimeout(() => { delete f.dataset.submitting; $$('button', f).forEach((b) => { b.disabled = false; }); }, 8000);
    }
  });
})();
