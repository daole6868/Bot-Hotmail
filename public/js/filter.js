/* Bộ lọc trang danh mục: chọn nhiều nhân vật / vũ khí (có tìm + ảnh), cuộn liên tục hoặc phân trang */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const form = $('[data-sf]');
  if (!form) return;
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Chọn nhiều ----------
  $$('[data-ms]', form).forEach((ms) => {
    const items = JSON.parse(ms.dataset.items || '[]');
    const name = ms.dataset.name;
    const panel = $('[data-ms-panel]', ms);
    const listEl = $('[data-ms-list]', ms);
    const qEl = $('[data-ms-q]', ms);
    const valEl = $('[data-ms-val]', ms);
    const box = $('[data-ms-inputs]', ms);
    const sel = new Set($$('input', box).map((i) => fold(i.value)));
    const label = () => {
      const names = items.filter((it) => sel.has(fold(it.n))).map((it) => it.n);
      valEl.textContent = names.length ? (names.length > 2 ? names.slice(0, 2).join(', ') + ' +' + (names.length - 2) : names.join(', ')) : ms.dataset.ph;
      ms.classList.toggle('has', names.length > 0);
      box.innerHTML = names.map((n) => '<input type="hidden" name="' + name + '" value="' + esc(n) + '">').join('');
    };
    const render = () => {
      const k = fold(qEl.value);
      const rows = items.filter((it) => !k || fold(it.n).includes(k));
      listEl.innerHTML = rows.length ? rows.map((it) => {
        const on = sel.has(fold(it.n));
        return '<button type="button" class="ms-row' + (on ? ' on' : '') + '" data-n="' + esc(it.n) + '"><span class="ms-ck"></span>' +
          (it.i ? '<img src="' + esc(it.i) + '" alt="" loading="lazy" width="32" height="32">' : '<i class="ms-noimg"></i>') + '<span>' + esc(it.n) + '</span></button>';
      }).join('') : '<div class="ms-empty">Không tìm thấy</div>';
    };
    $('[data-ms-btn]', ms).addEventListener('click', () => {
      const open = panel.hidden;
      $$('[data-ms-panel]', form).forEach((p) => { p.hidden = true; p.parentNode.classList.remove('open'); });
      if (open) { panel.hidden = false; ms.classList.add('open'); render(); qEl.focus({ preventScroll: true }); }
    });
    qEl.addEventListener('input', render);
    qEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    listEl.addEventListener('click', (e) => {
      const r = e.target.closest('.ms-row');
      if (!r) return;
      const k = fold(r.dataset.n);
      if (sel.has(k)) sel.delete(k); else sel.add(k);
      r.classList.toggle('on');
      label();
    });
    label();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-ms]')) $$('[data-ms-panel]', form).forEach((p) => { p.hidden = true; p.parentNode.classList.remove('open'); });
  });
  // Link gọn: bỏ ô trống khi gửi
  form.addEventListener('submit', () => {
    $$('input, select', form).forEach((el) => { if (el.name && (!el.value || (el.name === 'sort' && el.value === 'default'))) el.disabled = true; });
  });

  // ---------- Cuộn liên tục / Phân trang ----------
  const grid = $('[data-sf-grid]');
  const pager = $('[data-sf-pager]');
  const more = $('[data-sf-more]');
  if (!grid) return;
  let mode = form.dataset.mode;
  try { mode = localStorage.getItem('sf_mode') || mode; } catch (e) { /* bỏ qua */ }
  let io = null;
  let busy = false;
  async function loadMore() {
    if (busy || grid.dataset.more !== '1') return;
    busy = true; more.hidden = false;
    const u = new URL(location.href);
    u.searchParams.set('page', +grid.dataset.page + 1);
    u.searchParams.set('frag', '1');
    try {
      const j = await (await fetch(u, { headers: { Accept: 'application/json' } })).json();
      if (j.ok) {
        grid.insertAdjacentHTML('beforeend', j.html);
        grid.dataset.page = +grid.dataset.page + 1;
        grid.dataset.more = j.more ? '1' : '0';
      }
    } catch (e) { /* lần cuộn sau thử lại */ }
    busy = false;
    more.hidden = grid.dataset.more !== '1';
  }
  function apply(m) {
    mode = m === 'page' ? 'page' : 'scroll';
    $$('[data-sf-mode]', form).forEach((b) => b.classList.toggle('on', b.dataset.sfMode === mode));
    if (pager) pager.hidden = mode === 'scroll' && grid.dataset.page === '1';
    if (io) { io.disconnect(); io = null; }
    more.hidden = true;
    if (mode === 'scroll' && grid.dataset.more === '1' && 'IntersectionObserver' in window) {
      more.hidden = false;
      io = new IntersectionObserver((es) => { if (es[0].isIntersecting) loadMore(); }, { rootMargin: '600px' });
      io.observe(more);
    }
  }
  $$('[data-sf-mode]', form).forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('sf_mode', b.dataset.sfMode); } catch (e) { /* bỏ qua */ }
    apply(b.dataset.sfMode);
  }));
  apply(mode);
})();
