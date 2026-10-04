(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const csrf = $('meta[name="csrf-token"]')?.content || '';
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } },
  };

  // Ô ngày giờ: trình duyệt có thể hiển thị kiểu tháng/ngày -> ghi rõ ngày đã chọn theo kiểu Việt Nam
  function datePreview(inp) {
    const out = inp.parentElement.querySelector('[data-date-out]');
    if (!out) return;
    if (!out.dataset.empty) out.dataset.empty = out.textContent;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(inp.value);
    out.innerHTML = m ? `Đã chọn: <b>ngày ${+m[3]} tháng ${+m[2]} năm ${m[1]}, ${m[4]}:${m[5]}</b>` : out.dataset.empty;
  }
  $$('[data-date-preview]').forEach((inp) => { datePreview(inp); inp.addEventListener('input', () => datePreview(inp)); inp.addEventListener('change', () => datePreview(inp)); });

  // Mã giảm giá: cảnh báo nếu giờ máy chủ lệch với giờ thiết bị (mã sẽ hiện sai thời điểm)
  const clk = $('[data-server-now]');
  if (clk) {
    const diff = Math.round((Date.now() / 1000 - +clk.dataset.serverNow) / 60);
    const w = $('.a-clock-warn', clk);
    if (Math.abs(diff) >= 5 && w) {
      w.hidden = false;
      w.textContent = `⚠ Giờ máy chủ đang ${diff > 0 ? 'CHẬM' : 'NHANH'} hơn điện thoại/máy tính của bạn khoảng ${Math.abs(diff) >= 90 ? Math.round(Math.abs(diff) / 60) + ' giờ' : Math.abs(diff) + ' phút'}. `
        + 'Hãy chỉnh giờ VPS (lệnh: sudo timedatectl set-ntp true) để mã, hạn nạp tiền... chạy đúng giờ.';
    }
  }
  // Giao diện thẻ mã: chọn nhanh kích cỡ + xem trước tỉ lệ
  const cpf = $('[data-cp-layout]');
  if (cpf) {
    const pv = $('[data-cp-preview]', cpf);
    const upd = () => {
      const w = +cpf.w.value || 600, h = +cpf.h.value || 350;
      pv.style.aspectRatio = `${w} / ${h}`;
      pv.style.maxWidth = w / h < 1 ? `${Math.round(320 * w / h)}px` : '';
      pv.classList.toggle('vertical', w / h < 1.15);
    };
    cpf.addEventListener('input', upd);
    cpf.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cp-preset]');
      if (!b) return;
      const [w, h] = b.dataset.cpPreset.split('x');
      cpf.w.value = w; cpf.h.value = h; upd();
    });
    upd();
  }

  // ---------------- Kéo thả bằng nút 6 chấm (chuột & cảm ứng) ----------------
  // Giữ nút 6 chấm rồi kéo lên/xuống: dòng di chuyển theo tay, thả ra là lưu thứ tự mới.
  const itemOf = (el) => el.closest('tr, .a-banner-row, .a-hb-row');
  const sortSiblings = (item) => Array.from(item.parentElement.children).filter((x) => x.querySelector(':scope .a-move[data-sort-kind]'));
  function refreshMoveButtons(list) {
    list.forEach((row, i) => {
      const up = $('[data-dir="up"]', row), down = $('[data-dir="down"]', row);
      if (up) up.disabled = i === 0;
      if (down) down.disabled = i === list.length - 1;
      const no = $('.a-hb-no', row);
      if (no) no.textContent = i + 1;
    });
  }
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('.a-grip');
    if (!grip || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const mv = grip.closest('.a-move[data-sort-kind]');
    const item = mv && itemOf(mv);
    if (!item || sortSiblings(item).length < 2) return;
    e.preventDefault();
    const list = sortSiblings(item);
    drag = { item, kind: mv.dataset.sortKind, before: list.map((r) => $('.a-move', r).dataset.sortId).join(','), y: e.clientY, pid: e.pointerId };
    grip.setPointerCapture?.(e.pointerId);
    item.classList.add('a-dragging');
    document.body.classList.add('a-drag-on');
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    e.preventDefault();
    drag.y = e.clientY;
    const list = sortSiblings(drag.item).filter((x) => x !== drag.item);
    const target = list.find((x) => { const r = x.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    const parent = drag.item.parentElement;
    if (target) { if (drag.item.nextElementSibling !== target) parent.insertBefore(drag.item, target); }
    else { const last = list[list.length - 1]; if (last && last.nextElementSibling !== drag.item) last.after(drag.item); }
    // Tự cuộn trang khi kéo gần mép trên/dưới màn hình
    const edge = 70;
    if (e.clientY < edge) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - edge) window.scrollBy(0, 12);
  }, { passive: false });
  const endDrag = async (e) => {
    if (!drag || (e && e.pointerId !== drag.pid)) return;
    const { item, kind, before } = drag;
    drag = null;
    item.classList.remove('a-dragging');
    document.body.classList.remove('a-drag-on');
    const list = sortSiblings(item);
    const ids = list.map((r) => $('.a-move', r).dataset.sortId);
    if (ids.join(',') === before) return;
    refreshMoveButtons(list);
    item.classList.add('a-dropped');
    setTimeout(() => item.classList.remove('a-dropped'), 700);
    try {
      const r = await post(`/admin/${kind}/reorder`, { ids });
      if (r.ok) toast('Đã lưu thứ tự mới'); else { toast('Không lưu được thứ tự', true); setTimeout(() => location.reload(), 800); }
    } catch (err) { toast('Lỗi kết nối, đang tải lại...', true); setTimeout(() => location.reload(), 800); }
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // ---------------- Bảng dạng thẻ trên điện thoại ----------------
  // Gắn nhãn cột (lấy từ <th>) vào từng ô; CSS ở màn hẹp biến mỗi dòng thành 1 khung "Nhãn ..... Giá trị"
  function labelTables(root) {
    $$('table.a-table:not(.a-kv)', root).forEach((tb) => {
      tb.classList.add('a-cards');
      const heads = [];
      $$('thead th', tb).forEach((th) => { const n = +th.colSpan || 1; for (let i = 0; i < n; i++) heads.push(th.textContent.trim()); });
      $$(':scope > tbody > tr, :scope > tr', tb).forEach((tr) => {
        if (tr.dataset.lbl || tr.closest('thead')) return;
        tr.dataset.lbl = '1';
        let col = 0, titled = false;
        Array.from(tr.children).forEach((td) => {
          if (td.tagName !== 'TD') { col += +td.colSpan || 1; return; }
          const label = td.colSpan > 1 ? '' : (heads[col] || '');
          col += +td.colSpan || 1;
          const act = !!$('button, .a-btn, form, .a-switch, input:not([type=hidden])', td);
          const empty = !td.textContent.trim() && !$('img, svg, input, button', td);
          if (td.colSpan > 1) td.classList.add('a-cell-full');
          else if (empty) td.classList.add('a-cell-empty');
          else if (!titled && !act) { td.classList.add('a-cell-title'); titled = true; }
          else if (act) { td.classList.add('a-cell-act'); if (!$('.a-cell-act', tr) || td === $('.a-cell-act', tr)) td.classList.add('a-cell-act1'); }
          else if (label) {
            td.dataset.label = label;
            // gói nội dung vào 1 khối để nhiều dòng (VD tên SP + game) dồn về bên phải thay vì bị tách 2 bên
            const v = document.createElement('div');
            v.className = 'a-cv';
            while (td.firstChild) v.appendChild(td.firstChild);
            td.appendChild(v);
          }
        });
      });
    });
  }
  labelTables(document);
  new MutationObserver((ms) => { if (ms.some((m) => m.addedNodes.length)) labelTables(document); })
    .observe(document.body, { childList: true, subtree: true });

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
  // Khối ảnh trang chủ (slider / dải ảnh / banner): xem trước bằng chính ảnh đã chọn
  //  - "Hiển thị trên web": ảnh cắt theo tỉ lệ khung, đúng số ảnh mỗi hàng như ngoài web
  //  - "Kiểm tra cắt ảnh": ảnh gốc với khung xanh (phần hiện) / vùng đỏ (phần bị cắt)
  function hbPreview(f) {
    const box = $('[data-hb-preview]', f);
    if (!box) return;
    const kind = box.dataset.hbKind || 'banner';
    const fileInput = $('input[type=file][name=images]', f);
    let urls = [];
    const sources = () => {
      if (urls.length) return urls;
      return $$('.a-hb-item', f).filter((it) => !$('[name^=remove_]', it)?.checked && !$('[name^=hide_]', it)?.checked).map((it) => $('img', it).src);
    };
    const draw = () => {
      const w = +$('[data-hb-w]', f).value || 1200, h = +$('[data-hb-h]', f).value || 400;
      const n = kind === 'strip' ? 5 : kind === 'slider' ? 1 : (+($('[data-hb-cols]', f) || {}).value || 1);
      const src = sources();
      const cells = Array.from({ length: n }, (_, k) => src.length ? src[k % src.length] : null);
      const view = $('[data-hb-view]', box), crops = $('[data-hb-crops]', box);
      view.style.gridTemplateColumns = `repeat(${n}, minmax(0, 1fr))`;
      view.innerHTML = cells.map((u) => `<div class="a-hb-cell" style="aspect-ratio:${w}/${h}">${u ? `<img src="${u}" alt="">` : '<span>Chưa có ảnh</span>'}</div>`).join('');
      $('[data-hb-note]', box).textContent = kind === 'slider' ? `Ảnh tự chuyển lần lượt (${src.length || 0} ảnh)` : kind === 'strip' ? 'Hàng ảnh trôi ngang liên tục' : `${n} ảnh mỗi hàng trên PC`;
      crops.hidden = !src.length;
      crops.innerHTML = src.slice(0, 10).map((u) => `<div class="a-crop a-crop-sm" data-crop data-ratio="${w}/${h}">
          <div class="a-crop-stage" data-crop-stage><img data-crop-img src="${u}" alt=""><div class="a-crop-keep" data-crop-keep></div></div>
          <div class="a-crop-empty" data-crop-empty hidden></div><div class="a-crop-legend" data-crop-legend hidden><span class="a-muted" data-crop-info></span></div>
        </div>`).join('');
      $$('[data-crop-img]', crops).forEach((img) => { if (img.complete && img.naturalWidth) updateCrop(img); });
    };
    if (!f.dataset.hbInit) {
      f.dataset.hbInit = '1';
      f.addEventListener('input', draw);
      f.addEventListener('change', (e) => {
        if (e.target === fileInput) {
          urls.forEach((u) => URL.revokeObjectURL(u));
          urls = Array.from(fileInput.files || []).filter((x) => /^image\//.test(x.type)).map((x) => URL.createObjectURL(x));
        }
        draw();
      });
      f.addEventListener('click', (e) => {
        const p = e.target.closest('[data-hb-preset]');
        if (!p) return;
        const [w, h] = p.dataset.hbPreset.split('x');
        $('[data-hb-w]', f).value = w; $('[data-hb-h]', f).value = h; draw();
      });
    }
    draw();
  }

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
      $$('[data-hb-form]', modalBody).forEach(hbPreview);
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

    const si = t.closest('[data-set-input]');
    if (si) { const inp = $(`[name="${si.dataset.setInput}"]`, si.form || document); if (inp) { inp.value = si.dataset.value; inp.dispatchEvent(new Event('input', { bubbles: true })); } return; }

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
        if (tr && tr.closest('.a-products, .a-card') && !t.dataset.onMsg) tr.classList.toggle('a-row-off', !r.active);
        toast(r.active ? (t.dataset.onMsg || 'Đã bật hiển thị') : (t.dataset.offMsg || 'Đã ẩn'));
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
      // Lấy khung xem trước gần nhất (1 form có thể có nhiều ô chọn ảnh)
      const box = $('[data-preview-box]', t.closest('.a-upload-row') || t.closest('form') || document);
      if (f && box) box.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`;
      if (f && t.dataset.share === 'img') {
        const si = $('[data-share-img]');
        if (si) { si.hidden = false; si.innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`; }
      }
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
  // Cài đặt thông tin: xem trước khung chia sẻ link khi đang gõ
  document.addEventListener('input', (e) => {
    const f = e.target.closest('[data-share-form]');
    if (!f || !e.target.dataset.share) return;
    const v = (k) => (($(`[data-share="${k}"]`, f) || {}).value || '').trim();
    const title = v('title') || ((v('name') || 'ShopAcc') + (v('slogan') ? ' - ' + v('slogan') : ''));
    $('[data-share-out="title"]', f).textContent = title;
    $('[data-share-out="desc"]', f).textContent = v('desc');
  });

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

  // Nút con mắt: xem / ẩn mật khẩu đang nhập
  const EYE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.6A10.6 10.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-2.6 3.4M6.6 6.6C3.7 8.4 2 12 2 12s3.6 6.5 10 6.5c1.9 0 3.5-.5 4.9-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/></svg>';
  $$('input[type="password"]').forEach((inp) => {
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pw-eye';
    b.tabIndex = -1;
    b.setAttribute('aria-label', 'Hiện mật khẩu');
    b.innerHTML = EYE;
    b.addEventListener('click', () => {
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      b.innerHTML = show ? EYE_OFF : EYE;
      b.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
      inp.focus();
    });
    wrap.appendChild(b);
  });

  // Nút Sao chép (data-copy)
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const done = () => { const t = b.textContent; b.textContent = 'Đã chép'; setTimeout(() => { b.textContent = t; }, 1200); };
    const text = b.dataset.copy;
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(done).catch(() => {
      const inp = b.parentElement.querySelector('input');
      if (inp) { inp.select(); document.execCommand('copy'); done(); }
    });
  });

  // Khôi phục dữ liệu: tải file theo từng phần 20MB (vượt giới hạn 100MB/lần của Cloudflare), rồi khôi phục chạy nền và hỏi kết quả
  const rsForm = $('form[data-chunk-restore]');
  if (rsForm) {
    const bar = $('.rs-bar span', rsForm), txt = $('.rs-text', rsForm), box = $('.rs-progress', rsForm), btn = $('button.a-danger', rsForm);
    const CHUNK = 20 * 1024 * 1024;
    const show = (pct, msg, err) => { box.hidden = false; bar.style.width = pct + '%'; bar.classList.toggle('err', !!err); txt.innerHTML = msg; };
    const fmt = (b) => (b / 1048576).toFixed(b > 104857600 ? 0 : 1) + 'MB';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    rsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = rsForm.elements.file.files[0];
      if (!file) return;
      if (rsForm.elements.confirm.value.trim().toUpperCase() !== 'XOA HET') { show(0, 'Gõ đúng <b>XOA HET</b> để xác nhận.', true); return; }
      if (file.size > 10 * 1024 ** 3) { show(0, 'File vượt quá 10GB.', true); return; }
      if (!confirm('XÓA toàn bộ dữ liệu hiện tại và khôi phục từ file này?')) return;
      btn.disabled = true;
      const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
      let offset = 0, fails = 0;
      try {
        while (offset < file.size) {
          show(Math.floor(offset / file.size * 90), `Đang tải lên ${fmt(offset)} / ${fmt(file.size)}…`);
          let j;
          try {
            const r = await fetch(`/admin/maintenance/restore/chunk?id=${id}&offset=${offset}&total=${file.size}`, {
              method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrf }, body: file.slice(offset, offset + CHUNK),
            });
            j = await r.json();
          } catch (err) { j = null; }
          if (j && j.ok) { offset = j.received; fails = 0; continue; }
          if (j && typeof j.resume === 'number') { offset = j.resume; }
          if (j && j.message && !('resume' in j)) throw new Error(j.message);
          if (++fails > 5) throw new Error('Mất kết nối khi tải lên, vui lòng thử lại');
          show(Math.floor(offset / file.size * 90), `Mạng chập chờn, đang thử lại (${fails}/5)…`);
          await sleep(2000 * fails);
        }
        show(92, 'Đã tải lên xong. Đang giải mã và khôi phục dữ liệu, vui lòng không đóng trang…');
        const body = new URLSearchParams({ _csrf: csrf, id, total: file.size, name: file.name, password: rsForm.elements.password.value, confirm: rsForm.elements.confirm.value });
        const f = await (await fetch('/admin/maintenance/restore/finish', { method: 'POST', body })).json();
        if (!f.ok) throw new Error(f.message || 'Không khôi phục được');
        for (let i = 0; i < 1800; i++) { // tối đa 1 giờ
          await sleep(2000);
          let st;
          try { st = await (await fetch('/api/restore-status/' + f.job, { cache: 'no-store' })).json(); } catch (err) { continue; }
          if (st.state === 'done') {
            show(100, '<b>Khôi phục dữ liệu thành công.</b><br>' + st.lines.map((l) => '• ' + l).join('<br>') + '<br>Web đang tự khởi động lại. <a href="/login">Đăng nhập lại</a> bằng tài khoản admin trong bản sao lưu.');
            return;
          }
          if (st.state === 'error') throw new Error(st.message);
        }
        throw new Error('Quá lâu chưa có kết quả, hãy tải lại trang để kiểm tra');
      } catch (err) {
        show(100, err.message, true);
        btn.disabled = false;
      }
    });
  }

  // ---------------- Cày thuê ----------------
  // Chọn màu icon (ô màu / chấm màu gợi ý) -> đổi màu xem trước
  document.addEventListener('input', (e) => {
    const c = e.target.closest('[data-icon-color]');
    if (c) c.closest('.a-icon-pick').style.setProperty('--ic', c.value);
  });
  document.addEventListener('click', async (e) => {
    const dot = e.target.closest('[data-icon-color-set]');
    if (dot) {
      const box = dot.closest('.a-icon-pick'), inp = $('[data-icon-color]', box);
      inp.value = dot.dataset.iconColorSet; box.style.setProperty('--ic', inp.value);
      return;
    }
    const rv = e.target.closest('[data-bo-reveal]');
    if (rv) {
      const box = rv.closest('[data-bo-login]');
      rv.disabled = true;
      try {
        const r = await post(box.dataset.boLogin);
        if (!r.ok) throw new Error(r.message);
        $('[data-bo-u]', box).textContent = r.account;
        $('[data-bo-p]', box).textContent = r.password;
        $('.a-bo-cred', box).hidden = false;
        rv.hidden = true;
      } catch (err) { toast(err.message || 'Không xem được', true); rv.disabled = false; }
      return;
    }
    const cp = e.target.closest('[data-bo-copy]');
    if (cp) {
      const t = $('[data-bo-' + cp.dataset.boCopy + ']', cp.closest('[data-bo-login]')).textContent;
      try { await navigator.clipboard.writeText(t); toast('Đã sao chép'); } catch (err) { toast('Không sao chép được', true); }
    }
  });
  // ---------- Đếm ký tự ô SEO (tiêu đề / mô tả) ----------
  const COUNT = { title: [30, 65], seo_title: [50, 60], seo_desc: [120, 160] };
  function countOne(inp) {
    const k = inp.dataset.count; const out = inp.form && $(`[data-count-for="${k}"]`, inp.form);
    if (!out || !COUNT[k]) return;
    const n = inp.value.trim().length; const [a, b] = COUNT[k];
    out.textContent = n ? `${n} ký tự (nên ${a}–${b})` : `${a}–${b} ký tự`;
    out.classList.toggle('a-count-ok', n >= a && n <= b);
    out.classList.toggle('a-count-bad', n > 0 && (n < a || n > b));
  }
  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('[data-count]')) countOne(e.target); });
  new MutationObserver(() => $$('[data-count]').forEach((i) => { if (!i.dataset.counted) { i.dataset.counted = '1'; countOne(i); } })).observe(document.body, { childList: true, subtree: true });
  $$('[data-count]').forEach((i) => { i.dataset.counted = '1'; countOne(i); });

  // ---------- Viết bài: trình soạn thảo + chấm điểm SEO + AI ----------
  const pf = $('[data-post-form]');
  if (pf) {
    const ed = $('[data-editor]', pf), src = $('[data-editor-src]', pf), hidden = $('#postContent'), fileIn = $('[data-editor-file]', pf);
    let htmlMode = false;
    const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = () => (htmlMode ? src.value : ed.innerHTML);
    const exec = (c, v) => { ed.focus(); document.execCommand(c, false, v); seoCheck(); };
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* bỏ qua */ }
    let savedRange = null;
    const saveSel = () => { const sel = getSelection(); if (sel.rangeCount && ed.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange(); };
    const restoreSel = () => { ed.focus(); if (savedRange) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); } };
    ed.addEventListener('keyup', saveSel); ed.addEventListener('mouseup', saveSel); ed.addEventListener('input', () => { saveSel(); seoCheck(); });
    // Dán từ web khác: chỉ lấy chữ + định dạng cơ bản (máy chủ cũng lọc lại khi lưu)
    ed.addEventListener('paste', (e) => {
      const t = e.clipboardData?.getData('text/plain');
      if (t && !e.clipboardData.getData('text/html')) return;
      if (t) { e.preventDefault(); exec('insertHTML', t.split(/\n{2,}/).map((x) => `<p>${esc(x).replace(/\n/g, '<br>')}</p>`).join('')); }
    });
    $('.a-editor-bar', pf).addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    $('.a-editor-bar', pf).addEventListener('click', async (e) => {
      const b = e.target.closest('[data-cmd]'); if (!b) return;
      const c = b.dataset.cmd;
      if (c === 'html') {
        htmlMode = !htmlMode;
        if (htmlMode) { src.value = ed.innerHTML.replace(/(<\/(p|h2|h3|ul|ol|blockquote|table)>)/g, '$1\n'); }
        else ed.innerHTML = src.value;
        src.hidden = !htmlMode; ed.hidden = htmlMode; b.classList.toggle('on', htmlMode);
        $$('.a-editor-bar button:not([data-cmd=html])', pf).forEach((x) => { x.disabled = htmlMode; });
        return;
      }
      if (htmlMode) return;
      if (c === 'h2' || c === 'h3' || c === 'p') return exec('formatBlock', `<${c}>`);
      if (c === 'quote') return exec('formatBlock', '<blockquote>');
      if (c === 'bold' || c === 'italic' || c === 'undo' || c === 'redo') return exec(c);
      if (c === 'ul') return exec('insertUnorderedList');
      if (c === 'ol') return exec('insertOrderedList');
      if (c === 'link') {
        saveSel();
        const u = prompt('Dán đường dẫn (VD /game/genshin-impact hoặc https://...):');
        if (!u) return;
        if (!/^(https?:\/\/|\/)/i.test(u.trim())) { toast('Link phải bắt đầu bằng / hoặc https://', true); return; }
        restoreSel();
        if (getSelection().isCollapsed) exec('insertHTML', `<a href="${esc(u.trim())}">${esc(u.trim())}</a>`); else exec('createLink', u.trim());
        return;
      }
      if (c === 'image') { saveSel(); fileIn.click(); return; }
      if (c === 'card') {
        saveSel();
        const g = $('[data-post-game] option:checked', pf);
        const def = g && g.value ? `[[game:${g.dataset.slug}]]` : '[[game:duong-dan-game]]';
        const v = prompt('Mã thẻ sản phẩm:\n[[game:duong-dan-game]]  -  trang game\n[[cat:game/danh-muc]]  -  danh mục\n[[sp:MÃ_ACC]]  -  1 acc', def);
        if (!v) return;
        if (!/^\[\[(game|cat|sp):[\w/-]+\]\]$/.test(v.trim())) { toast('Mã không đúng dạng', true); return; }
        restoreSel(); exec('insertParagraph'); exec('insertText', v.trim()); exec('insertParagraph');
      }
    });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; if (!f) return;
      const fd = new FormData(); fd.append('_csrf', csrf); fd.append('image', f);
      toast('Đang tải ảnh...');
      try {
        const r = await (await fetch('/admin/posts/upload', { method: 'POST', body: fd, headers: { 'x-csrf-token': csrf, Accept: 'application/json' } })).json();
        if (!r.ok) throw new Error(r.message);
        const alt = prompt('Mô tả ảnh (giúp Google hiểu ảnh, VD: Đội hình Genshin Impact):', $('[name=focus_kw]', pf).value || '') || '';
        restoreSel(); exec('insertHTML', `<img src="${esc(r.url)}" alt="${esc(alt)}">`);
      } catch (err) { toast(err.message || 'Không tải được ảnh', true); }
      fileIn.value = '';
    });
    // Enter trong ô nhập không tự gửi form (tránh lưu nhầm trạng thái)
    pf.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox]):not([type=file])')) e.preventDefault(); });
    pf.addEventListener('submit', (e) => {
      if (e.submitter?.dataset.confirm && !confirm(e.submitter.dataset.confirm)) { e.preventDefault(); return; }
      pf.elements.act.value = e.submitter?.dataset.act || '';
      hidden.value = html();
    });

    // --- Chấm điểm SEO (giống Yoast) ---
    const val = (n) => ($(`[name="${n}"]`, pf)?.value || '').trim();
    const norm = (t) => t.toLowerCase().normalize('NFC');
    const slugify = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    const base = pf.dataset.base;
    function seoCheck() {
      const tmp = document.createElement('div'); tmp.innerHTML = html();
      const text = tmp.textContent.replace(/\[\[[^\]]+\]\]/g, ' ').replace(/\s+/g, ' ').trim();
      const words = (text.match(/\S+/g) || []).length;
      const kw = norm(val('focus_kw')); const title = val('title'); const st = val('seo_title') || title;
      const sd = val('seo_desc') || val('excerpt'); const slug = val('slug') || slugify(title);
      const first = norm((tmp.querySelector('p')?.textContent || text).slice(0, 300));
      const h2s = [...tmp.querySelectorAll('h2,h3')].map((h) => norm(h.textContent));
      const imgs = [...tmp.querySelectorAll('img')];
      const links = [...tmp.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
      const internal = links.filter((h) => h.startsWith('/')).length + (html().match(/\[\[(game|cat|sp):/g) || []).length;
      const count = kw ? (norm(text).split(kw).length - 1) : 0;
      const density = words && kw ? (count * kw.split(/\s+/).length / words) * 100 : 0;
      const checks = [
        [!!kw, 'Đã nhập từ khóa chính', 'Nhập từ khóa chính để chấm điểm đầy đủ'],
        [kw && norm(st).includes(kw), 'Từ khóa có trong tiêu đề SEO', 'Thêm từ khóa vào tiêu đề'],
        [st.length >= 40 && st.length <= 65, `Độ dài tiêu đề SEO tốt (${st.length} ký tự)`, `Tiêu đề SEO nên 50–60 ký tự (hiện ${st.length})`],
        [sd.length >= 120 && sd.length <= 160, `Độ dài mô tả tốt (${sd.length} ký tự)`, `Mô tả SEO nên 120–160 ký tự (hiện ${sd.length})`],
        [kw && norm(sd).includes(kw), 'Từ khóa có trong mô tả', 'Thêm từ khóa vào mô tả SEO'],
        [kw && slug.includes(slugify(kw)), 'Từ khóa có trong đường dẫn', 'Đường dẫn nên chứa từ khóa'],
        [kw && first.includes(kw), 'Từ khóa xuất hiện ở đoạn đầu', 'Nhắc từ khóa trong đoạn mở đầu'],
        [kw && h2s.some((h) => h.includes(kw)), 'Từ khóa có trong tiêu đề H2/H3', 'Thêm từ khóa vào ít nhất 1 tiêu đề H2'],
        [words >= 800, `Độ dài bài tốt (${words} chữ)`, `Bài nên từ 800 chữ trở lên (hiện ${words})`],
        [h2s.length >= 2, `Có ${h2s.length} tiêu đề H2/H3`, 'Chia bài bằng ít nhất 2 tiêu đề H2'],
        [kw && density >= 0.3 && density <= 3, `Mật độ từ khóa hợp lý (${density.toFixed(1)}%)`, kw ? `Mật độ từ khóa ${density.toFixed(1)}% (nên 0.5–2.5%)` : 'Mật độ từ khóa'],
        [internal >= 1, `Có ${internal} liên kết / thẻ tới trang trong web`, 'Thêm link hoặc thẻ sản phẩm tới trang trong web'],
        [!imgs.length ? !!($('[data-preview-box] img', pf)) : imgs.every((i) => i.alt.trim()), imgs.length ? 'Ảnh trong bài đều có mô tả (alt)' : 'Có ảnh bìa', imgs.length ? 'Thêm mô tả (alt) cho mọi ảnh' : 'Thêm ảnh bìa hoặc ảnh trong bài'],
      ];
      const ok = checks.filter((c) => c[0]).length; const score = Math.round(ok / checks.length * 100);
      const ring = $('[data-seo-ring]', pf); ring.textContent = score;
      ring.className = 'a-seo-ring ' + (score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad');
      $('[data-seo-label]', pf).textContent = score >= 80 ? 'Tốt — sẵn sàng đăng' : score >= 50 ? 'Tạm được — nên sửa thêm' : 'Cần cải thiện';
      $('[data-seo-checks]', pf).innerHTML = checks.map((c) => `<li class="${c[0] ? 'ok' : 'no'}">${esc(c[0] ? c[1] : c[2])}</li>`).join('');
      $('[data-gp-url]', pf).textContent = `${base.replace(/^https?:\/\//, '')} › tin-tuc › ${slug}`;
      $('[data-gp-title]', pf).textContent = st.length > 60 ? st.slice(0, 58) + '…' : (st || 'Tiêu đề bài viết');
      $('[data-gp-desc]', pf).textContent = (sd || text).slice(0, 158) + ((sd || text).length > 158 ? '…' : '');
    }
    pf.addEventListener('input', (e) => { if (e.target.matches('[data-seo-in], [name=excerpt], [data-editor-src]')) seoCheck(); });
    pf.addEventListener('change', seoCheck);
    seoCheck();

    // --- AI viết bài ---
    const aiBtn = $('[data-ai-write]', pf);
    if (aiBtn) {
      const st = $('[data-ai-status]', pf);
      const ai = (k) => $(`[data-ai="${k}"]`, pf);
      const fill = (r) => {
        const set = (n, v) => { const el = $(`[name="${n}"]`, pf); if (el && v != null) el.value = v; };
        set('title', r.title); set('slug', r.slug); set('excerpt', r.excerpt); set('focus_kw', r.focus_kw); set('seo_title', r.seo_title); set('seo_desc', r.seo_desc); set('faq', r.faq);
        if (htmlMode) src.value = r.content; else ed.innerHTML = r.content;
        const g = ai('game').selectedOptions[0];
        if (g && g.dataset.gid && !$('[name=game_id]', pf).value) $('[name=game_id]', pf).value = g.dataset.gid;
        $$('[data-count]', pf).forEach(countOne); seoCheck();
      };
      ai('length')?.addEventListener('change', () => { const c = ai('length-custom'); c.hidden = ai('length').value !== 'custom'; if (!c.hidden) c.focus(); });
      const cnt = $('[data-ai-count]', pf);
      if (cnt) ai('prompt').addEventListener('input', () => { cnt.textContent = ai('prompt').value.length.toLocaleString('vi-VN'); });
      aiBtn.addEventListener('click', async () => {
        if (ai('prompt').value.trim().length < 5) { toast('Hãy nhập yêu cầu cho AI', true); ai('prompt').focus(); return; }
        if (ed.textContent.trim().length > 50 && !confirm('AI sẽ thay toàn bộ nội dung đang có trong form. Tiếp tục?')) return;
        aiBtn.disabled = true; st.textContent = 'Đang gửi yêu cầu...';
        try {
          const r = await (await fetch('/admin/ai/write', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' },
            body: JSON.stringify({ prompt: ai('prompt').value, keyword: ai('keyword').value, game: ai('game').value, length: ai('length').value === 'custom' ? (ai('length-custom').value || 1000) : ai('length').value, tone: ai('tone').value }) })).json();
          if (!r.ok) throw new Error(r.message);
          for (;;) {
            await new Promise((ok) => setTimeout(ok, 3000));
            const j = await (await fetch('/admin/ai/jobs/' + r.id, { headers: { Accept: 'application/json' } })).json();
            if (!j.ok) throw new Error(j.message);
            if (j.status === 'error') throw new Error(j.error);
            if (j.status === 'done') { fill(j.result); st.textContent = '✅ AI đã viết xong và điền vào form. Đọc lại, sửa nếu cần rồi bấm Đăng bài.'; toast('AI đã viết xong'); break; }
            st.textContent = `AI đang viết bài... ${j.seconds}s (thường mất 30–120 giây)`;
          }
        } catch (err) { st.textContent = ''; toast(err.message || 'AI lỗi', true); }
        aiBtn.disabled = false;
      });
    }
  }

  // ---------- Cài đặt AI: thử kết nối ----------
  const aiTest = $('[data-ai-test]');
  if (aiTest) aiTest.addEventListener('click', async () => {
    aiTest.disabled = true; const out = $('[data-ai-test-out]'); out.hidden = false; out.textContent = 'Đang thử...'; out.className = 'a-small a-ai-test-out';
    try {
      const provider = $('[name=ai_provider]')?.value || '';
      const r = await (await fetch('/admin/ai/test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf, Accept: 'application/json' }, body: JSON.stringify({ provider }) })).json();
      out.textContent = r.message; out.className = 'a-small a-ai-test-out ' + (r.ok ? 'is-ok' : 'is-err');
    } catch (e) { out.textContent = 'Lỗi kết nối'; }
    aiTest.disabled = false;
  });

  // ---------- Hỗ trợ: danh sách kênh liên hệ ----------
  const spf = $('[data-sp-form]');
  if (spf) {
    const list = $('[data-sp-list]', spf); const types = JSON.parse($('[data-sp-types]').textContent);
    const sync = (row) => { $('input[name=ch_on]', row).value = $('[data-sp-on]', row).checked ? '1' : '0'; };
    spf.addEventListener('change', (e) => {
      const row = e.target.closest('[data-sp-row]'); if (!row) return;
      if (e.target.matches('[data-sp-on]')) sync(row);
      if (e.target.matches('[data-sp-type]')) {
        const t = types[e.target.value]; const tile = $('[data-sp-tile]', row);
        tile.style.background = t.color; tile.innerHTML = t.icon;
        $('[data-sp-value]', row).placeholder = t.hint;
        $('[data-sp-desc]', row).placeholder = 'Mô tả ngắn' + (t.desc ? ` (VD: ${t.desc})` : '');
      }
    });
    spf.addEventListener('click', (e) => {
      const row = e.target.closest('[data-sp-row]');
      if (e.target.closest('[data-sp-add]')) {
        list.insertAdjacentHTML('beforeend', $('[data-sp-tpl]').innerHTML);
        $('[data-sp-empty]')?.remove(); $('[data-sp-value]', list.lastElementChild).focus(); return;
      }
      if (!row) return;
      if (e.target.closest('[data-sp-del]')) row.remove();
      if (e.target.closest('[data-sp-up]') && row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling);
      if (e.target.closest('[data-sp-down]') && row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row);
    });
    spf.addEventListener('submit', () => $$('[data-sp-row]', spf).forEach(sync));
  }

  // ---------- Footer: các cột liên kết (mục = tên + link) ----------
  $$('[data-fc]').forEach((col) => {
    const list = $('[data-fc-list]', col);
    const refresh = () => {
      $('[data-fc-count]', col).textContent = $$('[data-fc-row]', list).length + ' mục';
      $('[data-fc-title]', col).textContent = $('[data-fc-title-in]', col).value.trim() || '(đang ẩn)';
    };
    col.addEventListener('input', (e) => { if (e.target.matches('[data-fc-title-in]')) refresh(); });
    col.addEventListener('click', (e) => {
      if (e.target.closest('[data-fc-add]')) { list.insertAdjacentHTML('beforeend', $('[data-fc-tpl]', col).innerHTML); $('input', list.lastElementChild).focus(); refresh(); return; }
      const row = e.target.closest('[data-fc-row]'); if (!row) return;
      if (e.target.closest('[data-fc-del]')) { row.remove(); refresh(); }
      if (e.target.closest('[data-fc-up]') && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
      if (e.target.closest('[data-fc-down]') && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    });
  });

  // ---------- Popup: trình soạn thảo nội dung + xem trước trực tiếp ----------
  const ppf = $('[data-pp-form]');
  if (ppf) {
    const ed = $('[data-pp-editor]', ppf), out = $('[data-pp-content]', ppf), pv = $('[data-pp-preview]', ppf);
    const v = (n) => ppf.elements[n]?.value || '';
    const escP = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    let imgSrc = $('[data-preview-box] img', ppf)?.getAttribute('src') || '';
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* bỏ qua */ }
    let range = null;
    const save = () => { const sel = getSelection(); if (sel.rangeCount && ed.contains(sel.anchorNode)) range = sel.getRangeAt(0).cloneRange(); };
    const restore = () => { ed.focus(); if (range) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); } };
    const exec = (c, val, css = true) => { restore(); document.execCommand('styleWithCSS', false, css); document.execCommand(c, false, val); save(); render(); };
    ['keyup', 'mouseup', 'input'].forEach((ev) => ed.addEventListener(ev, () => { save(); if (ev === 'input') render(); }));
    ed.addEventListener('paste', (e) => {
      const t = e.clipboardData?.getData('text/plain'); if (!t) return;
      e.preventDefault(); exec('insertHTML', t.split(/\n{2,}/).map((x) => `<p>${escP(x).replace(/\n/g, '<br>')}</p>`).join(''));
    });
    const bar = $('[data-pp-bar]', ppf);
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]'); if (!b) return;
      const c = b.dataset.cmd;
      if (c === 'link') {
        save();
        const u = (prompt('Dán đường dẫn (VD /game/genshin-impact hoặc https://...):') || '').trim();
        if (!u) return;
        if (!/^(https?:\/\/|\/(?!\/))/i.test(u)) { toast('Link phải bắt đầu bằng / hoặc https://', true); return; }
        restore();
        if (getSelection().isCollapsed) exec('insertHTML', `<a href="${escP(u)}">${escP(u)}</a>`); else exec('createLink', u);
        return;
      }
      exec(c);
    });
    $$('[data-pp-color]', ppf).forEach((inp) => {
      inp.addEventListener('pointerdown', save);
      inp.addEventListener('input', () => { inp.previousElementSibling.style[inp.dataset.ppColor === 'foreColor' ? 'color' : 'background'] = inp.value; exec(inp.dataset.ppColor, inp.value); });
    });
    const size = $('[data-pp-size]', ppf);
    size.addEventListener('pointerdown', save);
    size.addEventListener('change', () => {
      const px = size.value; size.value = ''; if (!px) return;
      exec('fontSize', '7', false); // tạm dùng cỡ 7 rồi đổi thành px
      $$('font[size="7"]', ed).forEach((f) => { const sp = document.createElement('span'); sp.style.fontSize = px + 'px'; sp.innerHTML = f.innerHTML; f.replaceWith(sp); });
      $$('[style*="xxx-large"]', ed).forEach((x) => { x.style.fontSize = px + 'px'; });
      render();
    });
    $('[data-pp-file]', ppf)?.addEventListener('change', (e) => { const f = e.target.files[0]; if (f) { imgSrc = URL.createObjectURL(f); render(); } });
    function render() {
      const removed = ppf.elements.remove_image?.checked && !$('[data-pp-file]', ppf).files.length;
      const src = removed ? '' : imgSrc;
      const html = ed.innerHTML.replace(/<p><br><\/p>/g, '');
      const hasBody = !!(v('title').trim() || ed.textContent.trim() || v('btn_text').trim());
      const rw = +v('img_rw'), rh = +v('img_rh'), w = Math.min(100, Math.max(20, +v('img_w') || 100));
      const img = src ? `<div class="pp-img${w < 100 && hasBody ? ' pp-img-sm' : ''}" style="width:${w}%"><img src="${escP(src)}" alt=""${rw && rh ? ` style="aspect-ratio:${rw} / ${rh}"` : ''}></div>` : '';
      const body = hasBody ? `<div class="pp-body">${v('title').trim() ? `<h3 style="color:${v('title_color')};font-size:${+v('title_size') || 24}px;text-align:${v('title_align')}">${escP(v('title'))}</h3>` : ''}`
        + `<div class="pp-content">${ed.textContent.trim() ? html : ''}</div>`
        + `${v('btn_text').trim() ? `<span class="pp-btn" style="background:${v('btn_bg')};color:${v('btn_color')}">${escP(v('btn_text'))}</span>` : ''}</div>` : '';
      pv.className = 'a-pp-box' + (hasBody ? '' : ' pp-imgonly');
      pv.style.cssText = `--pw:${Math.min(1200, Math.max(260, +v('width') || 520))}px;--pbg:${v('bg')};--ptx:${v('text')};--prad:${+v('radius') || 0}px`;
      pv.innerHTML = '<span class="pp-x">×</span>' + (v('img_pos') === 'bottom' ? body + img : img + body) || '<span class="a-muted">Chưa có nội dung</span>';
      if (!img && !body) pv.innerHTML = '<p class="a-muted a-center">Chưa có ảnh hoặc nội dung</p>';
    }
    ppf.addEventListener('input', (e) => { if (!ed.contains(e.target)) render(); });
    ppf.addEventListener('change', (e) => { if (!ed.contains(e.target)) render(); });
    ppf.addEventListener('submit', () => { out.value = ed.textContent.trim() ? ed.innerHTML : ''; });
    render();
  }
})();
