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

  // ---------------- Thuộc tính sản phẩm (công tắc + cửa sổ chọn) ----------------
  const X_ICON = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  function attrData(form) {
    const sec = $('[data-attr-section]', form);
    try { return JSON.parse(sec.dataset.attrs || '[]'); } catch (e) { return []; }
  }
  function addAttrChip(form, k, v) {
    const chips = $('[data-attr-chips]', form);
    // Mỗi thuộc tính chỉ 1 giá trị: chọn lại thì thay giá trị cũ
    $$('.a-chip-attr', chips).forEach((c) => { if ($('input[name=attr_k]', c).value === k) c.remove(); });
    const chip = document.createElement('span');
    chip.className = 'a-chip a-chip-attr';
    const b = document.createElement('b'); b.textContent = k + ':';
    chip.append(b, document.createTextNode(' ' + v));
    const ik = document.createElement('input'); ik.type = 'hidden'; ik.name = 'attr_k'; ik.value = k;
    const iv = document.createElement('input'); iv.type = 'hidden'; iv.name = 'attr_v'; iv.value = v;
    const rm = document.createElement('button'); rm.type = 'button'; rm.setAttribute('data-attr-remove', ''); rm.setAttribute('aria-label', 'Bỏ'); rm.innerHTML = X_ICON;
    chip.append(ik, iv, rm);
    chips.appendChild(chip);
  }
  function closePicker(form) { const pk = $('[data-attr-picker]', form); if (pk) pk.hidden = true; }

  document.addEventListener('click', (e) => {
    const t = e.target;
    const form = t.closest('form');
    if (!form) return;
    if (t.closest('[data-attr-open]')) {
      const pk = $('[data-attr-picker]', form);
      $('[data-attr-name]', pk).value = '';
      const vs = $('[data-attr-value]', pk);
      vs.innerHTML = '<option value="">-- Chọn thuộc tính trước --</option>';
      vs.disabled = true;
      $('[data-attr-error]', pk).hidden = true;
      pk.hidden = false;
      $('[data-attr-name]', pk).focus();
      return;
    }
    if (t.closest('[data-attr-close]')) { closePicker(form); return; }
    if (t.closest('[data-attr-add]')) {
      const pk = $('[data-attr-picker]', form);
      const k = $('[data-attr-name]', pk).value;
      const v = $('[data-attr-value]', pk).value;
      const err = $('[data-attr-error]', pk);
      if (!k || !v) { err.textContent = !k ? 'Vui lòng chọn thuộc tính' : 'Vui lòng chọn giá trị'; err.hidden = false; return; }
      addAttrChip(form, k, v);
      closePicker(form);
      return;
    }
    const rm = t.closest('[data-attr-remove]');
    if (rm) { rm.closest('.a-chip-attr').remove(); }
  });

  // ---------------- Banner: khung xanh (hiển thị) / đỏ (bị cắt) theo tỉ lệ của phần ----------------
  function updateCrop(img) {
    const box = img.closest('[data-crop]');
    if (!box || !img.naturalWidth) return;
    const [w, h] = (box.dataset.ratio || '1/1').split('/').map(Number);
    const target = w / h;
    const ir = img.naturalWidth / img.naturalHeight;
    const keep = $('[data-crop-keep]', box);
    let kw = 100, kh = 100;
    if (ir > target) kw = (target / ir) * 100; else kh = (ir / target) * 100;
    Object.assign(keep.style, { width: kw + '%', height: kh + '%', left: (100 - kw) / 2 + '%', top: (100 - kh) / 2 + '%' });
    const cut = 100 - Math.min(kw, kh);
    const info = $('[data-crop-info]', box);
    if (info) {
      info.textContent = 'Ảnh gốc ' + img.naturalWidth + '×' + img.naturalHeight +
        (cut < 0.5 ? ' · vừa khít, không bị cắt' : ' · bị cắt ' + Math.round(cut) + '% ' + (kw < 100 ? 'chiều ngang' : 'chiều dọc'));
    }
    $('[data-crop-stage]', box).hidden = false;
    $('[data-crop-empty]', box).hidden = true;
    $('[data-crop-legend]', box).hidden = false;
  }
  // 'load' không nổi bọt -> bắt ở pha capture (ảnh nằm trong modal tải bằng JS)
  document.addEventListener('load', (e) => { if (e.target.matches && e.target.matches('[data-crop-img]')) updateCrop(e.target); }, true);
  const cropObserver = new MutationObserver(() => $$('[data-crop-img]').forEach((i) => { if (i.complete && i.naturalWidth) updateCrop(i); }));
  if (modalBody) cropObserver.observe(modalBody, { childList: true });

  // Kích cỡ từng phần banner: tự lưu khi thay đổi
  let sizeTimer;
  document.addEventListener('input', (e) => {
    const f = e.target.closest('[data-size-form]');
    if (!f) return;
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(async () => {
      const w = +f.elements.w.value, h = +f.elements.h.value;
      if (!(w >= 50 && h >= 50)) return;
      try {
        const r = await post('/admin/banners/size', { position: f.dataset.sizeForm, w, h });
        if (!r.ok) throw new Error(r.message);
        const t = $(`[data-ratio-text="${f.dataset.sizeForm}"]`);
        if (t) t.textContent = r.w + ' × ' + r.h;
        f.classList.add('saved');
        setTimeout(() => f.classList.remove('saved'), 1200);
        toast('Đã lưu kích cỡ ' + r.w + ' × ' + r.h);
      } catch (err) { toast(err.message || 'Không lưu được kích cỡ', true); }
    }, 600);
  });
  document.addEventListener('submit', (e) => { if (e.target.matches('[data-size-form]')) e.preventDefault(); }, true);

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

    // Bật/tắt thuộc tính: tắt thì không gửi thuộc tính (sản phẩm lưu không có thuộc tính)
    if (t.matches('[data-attr-toggle]')) {
      const f = t.closest('form');
      const body = $('[data-attr-body]', f);
      body.hidden = !t.checked;
      $$('input[name=attr_k], input[name=attr_v]', body).forEach((i) => { i.disabled = !t.checked; });
      if (!t.checked) closePicker(f);
      return;
    }
    // Chọn thuộc tính -> nạp danh sách giá trị của thuộc tính đó
    if (t.matches('[data-attr-name]')) {
      const f = t.closest('form');
      const vs = $('[data-attr-value]', f);
      const a = attrData(f).find((x) => x.n === t.value);
      vs.innerHTML = '';
      const first = document.createElement('option');
      first.value = ''; first.textContent = a ? '-- Chọn giá trị --' : '-- Chọn thuộc tính trước --';
      vs.appendChild(first);
      (a ? a.v : []).forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; vs.appendChild(o); });
      vs.disabled = !a;
      $('[data-attr-error]', f).hidden = true;
      return;
    }

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
    // Banner: chọn ảnh -> hiện toàn bộ ảnh + khung cắt
    if (t.matches('input[type=file][data-crop-input]')) {
      const f = t.files[0];
      const img = $('[data-crop-img]', t.closest('form') || document);
      if (f && img) img.src = URL.createObjectURL(f);
      return;
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
      if (out) out.textContent = n.toLocaleString('vi-VN') + ' ' + (t.dataset.countUnit || 'acc');
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
