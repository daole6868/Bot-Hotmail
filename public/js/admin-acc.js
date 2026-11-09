/* Form sản phẩm: khung "Chi tiết tài khoản" (cấp, máy chủ, nhân vật / vũ khí 5★ 4★ chọn từ ảnh đã nạp) + popup "Lấy dữ liệu HoYoLAB". Game gán theo danh mục. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const csrf = $('meta[name="csrf-token"]')?.content || '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const X = '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const api = async (url, body) => {
    const opt = body === undefined ? { headers: { Accept: 'application/json' } }
      : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: JSON.stringify(body) };
    try { const r = await fetch(url, opt); return await r.json(); } catch (e) { return { ok: false, message: 'Lỗi kết nối, thử lại' }; }
  };
  const SECS = [['c5', 'Nhân vật', 'c', 5], ['c4', 'Nhân vật', 'c', 4], ['w5', '', 'w', 5], ['w4', '', 'w', 4]];
  const rk = (g, n) => { const v = g['r' + n] || n + '★'; return v.includes('★') ? v : 'hạng ' + v; };
  const fold = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();
  const libCache = {};

  function init(box) {
    box.dataset.init = '1';
    const form = box.closest('form');
    const field = $('[data-acc-field]', form);
    const view = $('[data-acc-view]', box);
    const games = JSON.parse(box.dataset.games || '{}');
    const servers = JSON.parse(box.dataset.servers || '[]');
    const GAME = box.dataset.guess || '';
    let st = null;
    try { st = JSON.parse(field.value || 'null'); } catch (e) { st = null; }
    st = Object.assign({ lv: 0, server: '', uid: '', c5: [], c4: [], w5: [], w4: [] }, st || {}, { game: GAME }); // game gán theo danh mục
    let lib = null; // {c: [...], w: [...]} ảnh đã nạp ở Quản lý ảnh
    const picked = {}; // mục đang tích trong danh sách chọn: key -> Set(tên)
    let openKey = '';

    const G = () => games[st.game] || { lv: 'Cấp', c: 'C', w: 'Vũ khí', r: 'R' };
    const save = () => {
      const empty = !st.lv && !st.server && !st.c5.length && !st.c4.length && !st.w5.length && !st.w4.length;
      field.value = empty ? '' : JSON.stringify(st);
    };
    function chip(item, key, kind) {
      const g = G();
      const lvl = kind === 'c' ? (item.k > 0 ? g.c + item.k : '') : (item.r > 1 ? g.r + item.r : ''); // chỉ hiện khi có (dữ liệu HoYoLAB)
      const ic = item.ic ? '<img src="' + esc(item.ic) + '" alt="" loading="lazy">' : '';
      return '<span class="a-acc-chip">' + ic + '<b>' + esc(item.n) + '</b>' + (lvl ? '<i>' + lvl + '</i>' : '') +
        '<button type="button" data-acc-del="' + key + '" aria-label="Bỏ">' + X + '</button></span>';
    }
    // Ảnh thư viện theo mục: 5★ -> độ hiếm 5, 4★ -> 4 (ZZZ hạng B vào 4), chưa rõ độ hiếm -> hiện ở cả hai
    const libFor = (key) => {
      const list = lib ? lib[key[0]] : [];
      const want = +key[1];
      return list.filter((x) => !x.r || x.r === want || (want === 4 && x.r < 4));
    };
    function pickList(key) {
      const q = fold(($('[data-pick-q="' + key + '"]', view) || {}).value);
      const have = new Set(['c5', 'c4', 'w5', 'w4'].filter((k) => k[0] === key[0]).flatMap((k) => st[k].map((x) => fold(x.n))));
      const sel = picked[key] || new Set();
      const rows = libFor(key).filter((x) => !q || fold(x.n).includes(q));
      if (!lib) return '<div class="a-pick-empty">Đang tải danh sách...</div>';
      if (!rows.length) return '<div class="a-pick-empty">' + (libFor(key).length ? 'Không tìm thấy' : 'Chưa có ảnh trong thư viện. Nạp ở Giao diện → Quản lý ảnh.') + '</div>';
      return rows.map((x) => {
        const done = have.has(fold(x.n));
        const on = sel.has(x.n);
        return '<button type="button" class="a-pick-row' + (on ? ' on' : '') + (done ? ' done' : '') + '" data-pick-row="' + key + '" data-n="' + esc(x.n) + '"' + (done ? ' disabled' : '') + '>' +
          '<span class="a-pick-ck"></span>' + (x.t ? '<img src="' + esc(x.t) + '" alt="" loading="lazy" width="30" height="30">' : '<i class="a-pick-noimg"></i>') +
          '<span>' + esc(x.n) + '</span>' + (done ? '<small>đã thêm</small>' : '') + '</button>';
      }).join('');
    }
    function render() {
      const g = G();
      const svList = servers.includes(st.server) || !st.server ? servers : servers.concat([st.server]);
      const sOpt = '<option value="">-- Máy chủ --</option>' + svList.map((s) => '<option' + (s === st.server ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
      let h = '<div class="a-row">' +
        '<div><label>' + esc(g.lv) + '</label><input type="number" min="0" max="999" data-acc-k="lv" value="' + (st.lv || '') + '"></div>' +
        '<div><label>Máy chủ</label><select data-acc-k="server">' + sOpt + '</select></div></div>';
      SECS.forEach(([key, title, kind, n]) => {
        const label = (kind === 'c' ? title : g.w) + ' ' + rk(g, n);
        const list = st[key];
        const open = openKey === key;
        const cnt = (picked[key] || new Set()).size;
        h += '<div class="a-acc-sec"><div class="a-acc-sh"><b>' + esc(label) + '</b><small>' + list.length + '</small>' +
          '<button type="button" class="a-btn a-btn-sm a-pick-open" data-pick-open="' + key + '">' + (open ? 'Đóng' : '+ Chọn') + '</button></div>' +
          '<div class="a-acc-chips">' + list.map((it, i) => chip(it, key + ':' + i, kind)).join('') + '</div>' +
          (open ? '<div class="a-pick"><input type="search" placeholder="Tìm ' + (kind === 'c' ? 'nhân vật' : esc(g.w.toLowerCase())) + '..." data-pick-q="' + key + '" autocomplete="off">' +
            '<div class="a-pick-list" data-pick-list="' + key + '">' + pickList(key) + '</div>' +
            '<div class="a-pick-foot"><span>Đã chọn <b data-pick-n="' + key + '">' + cnt + '</b></span>' +
            '<button type="button" class="a-btn a-btn-sm a-primary" data-pick-add="' + key + '">Thêm</button></div></div>' : '') +
          '</div>';
      });
      view.innerHTML = h;
      save();
    }
    async function loadLib() {
      if (!GAME) return;
      if (!libCache[GAME]) libCache[GAME] = api('/admin/hoyo/lib/' + GAME);
      const r = await libCache[GAME];
      lib = r && r.ok ? r : { c: [], w: [] };
      if (openKey) { const l = $('[data-pick-list="' + openKey + '"]', view); if (l) l.innerHTML = pickList(openKey); }
    }
    function addPicked(key) {
      const sel = picked[key];
      if (!sel || !sel.size) return;
      const src = libFor(key);
      for (const name of sel) {
        const x = src.find((y) => y.n === name);
        if (!x) continue;
        st[key].push(key[0] === 'c' ? { n: x.n, k: 0, l: 0, el: '', ic: x.i } : { n: x.n, r: 1, l: 0, ic: x.i });
      }
      picked[key] = new Set();
      openKey = '';
      render();
    }
    view.addEventListener('change', (e) => {
      const k = e.target.dataset.accK;
      if (!k) return;
      st[k] = k === 'lv' ? (parseInt(e.target.value, 10) || 0) : e.target.value;
      save();
    });
    view.addEventListener('input', (e) => {
      if (e.target.dataset.accK === 'lv') { st.lv = parseInt(e.target.value, 10) || 0; save(); }
      const pq = e.target.dataset.pickQ;
      if (pq) $('[data-pick-list="' + pq + '"]', view).innerHTML = pickList(pq);
    });
    view.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset.pickQ) e.preventDefault(); });
    view.addEventListener('click', (e) => {
      const op = e.target.closest('[data-pick-open]');
      if (op) { openKey = openKey === op.dataset.pickOpen ? '' : op.dataset.pickOpen; render(); if (openKey) { const q = $('[data-pick-q="' + openKey + '"]', view); if (q) q.focus({ preventScroll: true }); } return; }
      const row = e.target.closest('[data-pick-row]');
      if (row) {
        const key = row.dataset.pickRow;
        const sel = picked[key] || (picked[key] = new Set());
        if (sel.has(row.dataset.n)) sel.delete(row.dataset.n); else sel.add(row.dataset.n);
        row.classList.toggle('on');
        $('[data-pick-n="' + key + '"]', view).textContent = sel.size;
        return;
      }
      const add = e.target.closest('[data-pick-add]');
      if (add) { addPicked(add.dataset.pickAdd); return; }
      const del = e.target.closest('[data-acc-del]');
      if (del) { const [key, i] = del.dataset.accDel.split(':'); st[key].splice(+i, 1); render(); }
    });
    render();
    loadLib();

    // ---------- Popup lấy dữ liệu HoYoLAB ----------
    const pk = $('[data-hoyo-picker]', form);
    if (!pk) return;
    const pf = $('[data-hoyo-form]', pk);
    const run = $('[data-hoyo-run]', pk);
    const err = $('[data-hoyo-error]', pk);
    const bar = $('[data-hoyo-bar]', pk);
    const msg = $('[data-hoyo-msg]', pk);
    let jobId = 0;
    let timer = 0;
    const showErr = (t) => { err.textContent = t; err.hidden = !t; };
    const stop = () => { clearTimeout(timer); timer = 0; jobId = 0; };
    const toForm = (t) => { stop(); run.hidden = true; pf.hidden = false; showErr(t || ''); };
    
    const setProg = (p, t) => { bar.style.width = Math.max(3, Math.min(100, p || 0)) + '%'; msg.textContent = t || ''; };
    function apply(r) {
      if (!r) return;
      st = Object.assign({ lv: 0, server: '', uid: '', c5: [], c4: [], w5: [], w4: [] }, r, { game: GAME });
      render();
    }
    async function poll() {
      if (!jobId) return;
      const j = await api('/admin/hoyo/jobs/' + jobId);
      if (!jobId) return;
      if (!j.ok) { toForm(j.message || 'Không lấy được trạng thái. Thao tác lại sau.'); return; }
      const job = j.job;
      if (job.status === 'done') { apply(job.result); setProg(100, job.message); stop(); setTimeout(() => { pk.hidden = true; toForm(''); }, 700); return; }
      if (job.status === 'failed' || job.status === 'cancelled') { toForm(job.error || 'Lấy dữ liệu thất bại. Thao tác lại sau.'); return; }
      const wait = job.status === 'pending' && !job.online ? ' (máy lấy dữ liệu chưa bật, đang chờ...)' : '';
      setProg(job.progress, (job.message || '') + wait);
      timer = setTimeout(poll, 2000);
    }
    form.addEventListener('click', async (e) => {
      if (e.target.closest('[data-hoyo-open]')) {
        const u = form.elements.acc_user; const p = form.elements.acc_pass;
        if (u && !$('[data-hoyo-user]', pk).value) $('[data-hoyo-user]', pk).value = u.value;
        if (p && !$('[data-hoyo-pass]', pk).value) $('[data-hoyo-pass]', pk).value = p.value;
        if (st.server) $('[data-hoyo-server]', pk).value = st.server;
        if (!jobId) toForm('');
        pk.hidden = false;
        return;
      }
      if (e.target.closest('[data-hoyo-close]')) { pk.hidden = true; return; }
      if (e.target.closest('[data-hoyo-cancel]')) {
        const id = jobId; toForm('Đã hủy lượt lấy dữ liệu');
        if (id) api('/admin/hoyo/jobs/' + id + '/cancel', {});
        return;
      }
      const startBtn = e.target.closest('[data-hoyo-start]');
      if (startBtn) {
        const body = {
          game: $('[data-hoyo-game]', pk).value, server: $('[data-hoyo-server]', pk).value,
          username: $('[data-hoyo-user]', pk).value.trim(), password: $('[data-hoyo-pass]', pk).value,
        };
        if (!body.username || !body.password) { showErr('Nhập tài khoản và mật khẩu HoYoLAB'); return; }
        startBtn.disabled = true;
        const r = await api('/admin/hoyo/jobs', body);
        startBtn.disabled = false;
        if (!r.ok) { showErr(r.message || 'Không gửi được yêu cầu'); return; }
        jobId = r.id; pf.hidden = true; run.hidden = false; showErr('');
        setProg(2, r.online ? 'Đã gửi, chờ máy lấy dữ liệu nhận việc...' : 'Đã gửi. Máy lấy dữ liệu chưa bật, đang chờ...');
        timer = setTimeout(poll, 1500);
      }
    });
  }

  // Form sản phẩm nằm trong modal tải bằng fetch -> tự khởi tạo khi khung xuất hiện
  const scan = () => $$('[data-acc-box]:not([data-init])').forEach(init);
  scan();
  let q = 0;
  new MutationObserver(() => { if (!q) q = requestAnimationFrame(() => { q = 0; scan(); }); }).observe(document.body, { childList: true, subtree: true });

  // ---------- Tạo ảnh acc / Sửa ảnh (mở trang /admin/acc-image ở tab mới, ảnh làm xong gửi về form này) ----------
  function handoff(form) {
    const field = $('[data-acc-field]', form);
    let detail = null; try { detail = JSON.parse((field && field.value) || 'null'); } catch (e) { detail = null; }
    const box = $('[data-acc-box]', form);
    window.__accImg = { detail, code: form.elements.code ? form.elements.code.value.trim() : '', title: form.elements.title ? form.elements.title.value : '', productId: form.elements.id ? +form.elements.id.value || 0 : 0, game: box ? box.dataset.guess : '' };
    return window.__accImg.productId;
  }
  document.addEventListener('click', (e) => {
    const mk = e.target.closest('[data-accimg-make]');
    if (mk) { const id = handoff(mk.closest('form')); window.open('/admin/acc-image?from=form' + (id ? '&product=' + id : ''), '_blank'); return; }
    const ed = e.target.closest('[data-img-edit]');
    if (ed) { e.preventDefault(); const id = handoff(ed.closest('form')); window.open('/admin/acc-image?mode=edit&from=form&img=' + encodeURIComponent(ed.dataset.imgEdit) + (id ? '&product=' + id : ''), '_blank'); }
  });
  const keepLabel = (u) => '<label class="a-img-keep a-img-fresh"><img src="' + esc(u) + '" alt=""><span><input type="checkbox" name="keep_images" value="' + esc(u) + '" checked> Giữ<button type="button" class="a-img-edit" data-img-edit="' + esc(u) + '">Sửa</button></span></label>';
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.type !== 'accimg') return;
    const form = document.querySelector('form[action="/admin/products/save"]');
    const box = form && $('[data-preview-multi]', form);
    if (!box) return;
    const urls = (e.data.urls || []).filter((u) => /^\/uploads\/products\//.test(u));
    const old = e.data.replace && $$('input[name="keep_images"]', box).find((i) => i.value === e.data.replace);
    if (old && urls[0]) { // thay đúng ảnh đã sửa, giữ nguyên vị trí
      const lb = old.closest('.a-img-keep'); old.value = urls[0]; old.checked = true; $('img', lb).src = urls[0]; $('[data-img-edit]', lb).dataset.imgEdit = urls[0]; lb.classList.add('a-img-fresh');
      return;
    }
    urls.slice().reverse().forEach((u) => box.insertAdjacentHTML('afterbegin', keepLabel(u))); // ảnh mới đứng đầu (ảnh đại diện)
  });
})();