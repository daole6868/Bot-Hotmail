/* Form sản phẩm: khung "Chi tiết tài khoản" (game, cấp, máy chủ, nhân vật / vũ khí 5★ 4★) + popup "Lấy dữ liệu HoYoLAB" */
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

  function init(box) {
    box.dataset.init = '1';
    const form = box.closest('form');
    const field = $('[data-acc-field]', form);
    const view = $('[data-acc-view]', box);
    const games = JSON.parse(box.dataset.games || '{}');
    const servers = JSON.parse(box.dataset.servers || '[]');
    let st = null;
    try { st = JSON.parse(field.value || 'null'); } catch (e) { st = null; }
    st = Object.assign({ game: box.dataset.guess || '', lv: 0, server: '', uid: '', c5: [], c4: [], w5: [], w4: [] }, st || {});

    const G = () => games[st.game] || { lv: 'Cấp', c: 'C', w: 'Vũ khí', r: 'R' };
    const save = () => {
      const empty = !st.lv && !st.server && !st.c5.length && !st.c4.length && !st.w5.length && !st.w4.length;
      field.value = empty ? '' : JSON.stringify(st);
    };
    function chip(item, key, kind) {
      const g = G();
      const badge = kind === 'c' ? g.c + (item.k || 0) : g.r + (item.r || 1);
      const ic = item.ic ? '<img src="' + esc(item.ic) + '" alt="" loading="lazy">' : '';
      return '<span class="a-acc-chip">' + ic + '<b>' + esc(item.n) + '</b><i>' + badge + '</i>' +
        '<button type="button" data-acc-del="' + key + '" aria-label="Bỏ">' + X + '</button></span>';
    }
    function opts(n, from, prefix, cur) {
      let h = '';
      for (let i = from; i <= n; i++) h += '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>' + prefix + i + '</option>';
      return h;
    }
    function render() {
      const g = G();
      const gOpt = '<option value="">-- Game --</option>' + Object.keys(games).map((k) => '<option value="' + k + '"' + (k === st.game ? ' selected' : '') + '>' + esc(games[k].name) + '</option>').join('');
      const svList = servers.includes(st.server) || !st.server ? servers : servers.concat([st.server]);
      const sOpt = '<option value="">-- Máy chủ --</option>' + svList.map((s) => '<option' + (s === st.server ? ' selected' : '') + '>' + esc(s) + '</option>').join('');
      let h = '<div class="a-row a-row-3">' +
        '<div><label>Game</label><select data-acc-k="game">' + gOpt + '</select></div>' +
        '<div><label>' + esc(g.lv) + '</label><input type="number" min="0" max="999" data-acc-k="lv" value="' + (st.lv || '') + '"></div>' +
        '<div><label>Máy chủ</label><select data-acc-k="server">' + sOpt + '</select></div></div>';
      SECS.forEach(([key, title, kind, n]) => {
        const label = (kind === 'c' ? title : g.w) + ' ' + rk(g, n);
        const list = st[key];
        h += '<div class="a-acc-sec"><div class="a-acc-sh"><b>' + esc(label) + '</b><small>' + list.length + '</small></div>' +
          '<div class="a-acc-chips">' + list.map((it, i) => chip(it, key + ':' + i, kind)).join('') + '</div>' +
          '<div class="a-acc-add"><input placeholder="Tên ' + (kind === 'c' ? 'nhân vật' : esc(g.w.toLowerCase())) + '" data-acc-name="' + key + '" maxlength="60">' +
          '<select data-acc-lvl="' + key + '">' + (kind === 'c' ? opts(6, 0, g.c, 0) : opts(5, 1, g.r, 1)) + '</select>' +
          '<button type="button" class="a-btn a-btn-sm" data-acc-add="' + key + '">Thêm</button></div></div>';
      });
      view.innerHTML = h;
      save();
    }
    function addItem(key) {
      const inp = $('[data-acc-name="' + key + '"]', view);
      const name = inp.value.trim();
      if (!name) { inp.focus(); return; }
      const lvl = parseInt($('[data-acc-lvl="' + key + '"]', view).value, 10) || 0;
      st[key].push(key[0] === 'c' ? { n: name, k: lvl, l: 0, el: '', ic: '' } : { n: name, r: lvl || 1, l: 0, ic: '' });
      render();
      const again = $('[data-acc-name="' + key + '"]', view);
      if (again) again.focus();
    }
    view.addEventListener('change', (e) => {
      const k = e.target.dataset.accK;
      if (!k) return;
      st[k] = k === 'lv' ? (parseInt(e.target.value, 10) || 0) : e.target.value;
      if (k === 'game') render(); else save();
    });
    view.addEventListener('input', (e) => { if (e.target.dataset.accK === 'lv') { st.lv = parseInt(e.target.value, 10) || 0; save(); } });
    view.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.dataset.accName) { e.preventDefault(); addItem(e.target.dataset.accName); }
    });
    view.addEventListener('click', (e) => {
      const add = e.target.closest('[data-acc-add]');
      if (add) { addItem(add.dataset.accAdd); return; }
      const del = e.target.closest('[data-acc-del]');
      if (del) { const [key, i] = del.dataset.accDel.split(':'); st[key].splice(+i, 1); render(); }
    });
    render();

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
      st = Object.assign({ game: '', lv: 0, server: '', uid: '', c5: [], c4: [], w5: [], w4: [] }, r);
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
        if (st.game && games[st.game]) $('[data-hoyo-game]', pk).value = st.game;
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
})();
