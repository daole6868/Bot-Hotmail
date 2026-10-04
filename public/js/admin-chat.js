/* Chat trực tiếp — hộp thư admin / nhân viên (3 cột: danh sách · đoạn chat · thông tin khách) */
(function () {
  'use strict';
  const box = document.querySelector('[data-chat]');
  if (!box) return;
  const $ = (s, el = box) => el.querySelector(s);
  const $$ = (s, el = box) => [...el.querySelectorAll(s)];
  const boot = JSON.parse(document.querySelector('[data-chat-boot]').textContent);
  const csrf = document.querySelector('meta[name=csrf-token]')?.content || '';
  const role = box.dataset.role; const meId = +box.dataset.me;
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>').replace(/\n/g, '<br>');
  const pad = (n) => String(n).padStart(2, '0');
  const when = (ts) => {
    const d = new Date(ts * 1000); const now = new Date();
    if (d.toDateString() === now.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
  };
  const full = (ts) => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
  function toast(msg, err) {
    const t = document.getElementById('aToast'); if (!t) return;
    t.textContent = msg; t.classList.toggle('err', !!err); t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }
  async function api(url, opt = {}) {
    const headers = { Accept: 'application/json', 'x-csrf-token': csrf };
    if (opt.json) { headers['content-type'] = 'application/json'; opt.body = JSON.stringify({ ...opt.json, _csrf: csrf }); }
    if (opt.body instanceof FormData) opt.body.append('_csrf', csrf);
    try {
      const r = await fetch(url, { method: opt.body ? 'POST' : 'GET', body: opt.body, headers, credentials: 'same-origin' });
      return await r.json();
    } catch (e) { return { ok: false, message: 'Lỗi kết nối, thử lại sau' }; }
  }
  function beep() {
    try {
      const A = window.AudioContext || window.webkitAudioContext; const ctx = new A(); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 760; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.45);
    } catch (e) { /* bỏ qua */ }
  }

  // ---------- Danh sách cuộc chat ----------
  const convs = new Map(); boot.convs.forEach((c) => convs.set(c.id, c));
  let filter = 'all'; let seg = 'all'; let q = ''; let cur = null; let curInfo = null; const msgs = new Map(); let seenUser = 0;
  const initial = (n) => esc((n || '?').trim().slice(0, 1).toUpperCase());
  const color = (id) => `hsl(${(id * 67) % 360} 62% 52%)`;
  const staffName = (id) => (boot.staff.find((s) => s.id === id) || {}).name || '';
  function matches(c) {
    if (seg === 'member' && c.guest) return false;
    if (seg === 'guest' && !c.guest) return false;
    if (filter === 'unread' && !c.unread) return false;
    if (filter === 'open' && (c.status !== 'open' || c.blocked)) return false;
    if (filter === 'closed' && c.status !== 'closed') return false;
    if (filter === 'mine' && c.assignee !== meId) return false;
    if (filter === 'blocked' && !c.blocked) return false;
    return true;
  }
  function renderList() {
    const rows = [...convs.values()].filter(matches).sort((a, b) => b.at - a.at);
    $('[data-cl]').innerHTML = rows.length ? rows.map((c) => `
      <button type="button" class="a-cl ${c.id === cur ? 'on' : ''} ${c.unread ? 'unread' : ''}" data-id="${c.id}">
        <span class="a-chat-av" style="background:${color(c.id)}">${initial(c.name)}</span>
        <span class="a-cl-tx"><span class="a-cl-top"><b>${esc(c.name)}</b><small>${when(c.at)}</small></span>
          <span class="a-cl-bot"><span class="a-cl-last">${c.last_from && c.last_from !== 'user' ? (c.last_from === 'ai' ? 'AI: ' : 'Bạn: ') : ''}${esc(c.last)}</span>${c.unread ? `<i class="a-cl-n">${c.unread > 99 ? '99+' : c.unread}</i>` : ''}</span>
          <span class="a-cl-tags">${c.note ? `<em class="note" title="${esc(c.note)}">${esc(c.note.length > 28 ? c.note.slice(0, 28) + '…' : c.note)}</em>` : ''}${c.guest ? '<em>Khách lạ</em>' : ''}${c.status === 'closed' ? '<em>Đã đóng</em>' : ''}${c.blocked ? '<em class="red">Đã chặn</em>' : ''}${c.assignee ? `<em>${esc(staffName(c.assignee) || 'Đã nhận')}</em>` : ''}</span></span>
      </button>`).join('') : '<div class="a-chat-none">Không có cuộc chat nào</div>';
  }
  function navBadge() {
    const n = [...convs.values()].filter((c) => c.unread && !c.blocked).length;
    document.querySelectorAll('[data-chat-nav-badge]').forEach((b) => { b.hidden = !n; b.textContent = n; });
    document.title = (n ? `(${n}) ` : '') + document.title.replace(/^\(\d+\) /, '');
  }
  let listT = 0;
  async function reloadList() {
    const j = await api(`/admin/chat/list?f=${filter}&s=${seg}&q=${encodeURIComponent(q)}`);
    if (!j.ok) return;
    if (!q && filter === 'all' && seg === 'all') convs.clear();
    setCounts(j.counts);
    j.convs.forEach((c) => convs.set(c.id, c));
    renderList(); navBadge();
  }
  $('[data-cl-q]').addEventListener('input', (e) => { q = e.target.value.trim(); clearTimeout(listT); listT = setTimeout(reloadList, 300); });
  $('[data-cl-tabs]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    $$('[data-cl-tabs] button').forEach((x) => x.classList.toggle('on', x === b));
    filter = b.dataset.f; renderList(); reloadList();
  });
  $('[data-cl-seg]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    $$('[data-cl-seg] button').forEach((x) => x.classList.toggle('on', x === b));
    seg = b.dataset.s; renderList(); reloadList();
  });
  function setCounts(c) {
    if (!c) return;
    $$('[data-seg-n]').forEach((el) => { const n = c[el.dataset.segN] || 0; el.hidden = !n; el.textContent = n > 99 ? '99+' : n; });
  }
  let cntT = 0;
  const refreshCounts = () => { clearTimeout(cntT); cntT = setTimeout(async () => { const j = await api('/admin/chat/counts'); if (j.ok) setCounts(j.counts); }, 800); };
  $('[data-cl]').addEventListener('click', (e) => { const r = e.target.closest('.a-cl'); if (r) openConv(+r.dataset.id); });

  // ---------- Đoạn chat ----------
  const msgBox = $('[data-msgs]');
  function refCard(r) {
    return `<button type="button" class="a-ref" data-order="${esc(r.t)}:${r.id}"><span class="a-ref-ic">📦</span><span><b>${esc(r.code)}</b><small>${esc(r.title)}</small><small>${esc(r.totalText || '')} · ${esc(r.status || '')}</small></span></button>`;
  }
  function bubble(m) {
    if (m.sender === 'system') return `<div class="a-cm-sys" data-id="${m.id}">${linkify(m.body)}</div>`;
    const mine = m.sender !== 'user';
    return `<div class="a-cm ${mine ? 'out' : 'in'} ${m.sender === 'ai' ? 'ai' : ''}" data-id="${m.id}">
      ${mine ? `<div class="a-cm-name">${esc(m.name || '')}${m.sender === 'ai' ? ' · AI' : ''}</div>` : ''}
      ${m.image ? `<a class="a-cm-img" href="${esc(m.image)}" target="_blank"><img src="${esc(m.image)}" alt="" loading="lazy"></a>` : ''}
      ${m.ref ? refCard(m.ref) : ''}
      ${m.body ? `<div class="a-cm-b">${linkify(m.body)}</div>` : ''}
      <div class="a-cm-t" title="${full(m.at)}">${when(m.at)}</div></div>`;
  }
  function renderMsgs(keepScroll) {
    const arr = [...msgs.values()].sort((a, b) => a.id - b.id);
    const lastOut = [...arr].reverse().find((m) => m.sender !== 'user');
    const seen = lastOut && seenUser >= lastOut.id && arr[arr.length - 1] === lastOut ? '<div class="a-cm-seen">Khách đã xem</div>' : '';
    const h = msgBox.scrollHeight; const top = msgBox.scrollTop;
    msgBox.innerHTML = (arr.length >= 50 ? '<div class="a-cm-more"><button type="button" data-older>Xem tin cũ hơn</button></div>' : '') + arr.map(bubble).join('') + seen;
    if (keepScroll) msgBox.scrollTop = msgBox.scrollHeight - h + top;
  }
  const atBottom = () => msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 100;
  const toBottom = () => { msgBox.scrollTop = msgBox.scrollHeight; };
  msgBox.addEventListener('click', async (e) => {
    if (e.target.closest('[data-older]')) {
      const first = Math.min(...msgs.keys());
      const j = await api(`/admin/chat/c/${cur}/history?before=${first}`);
      if (j.ok) { j.msgs.forEach((m) => msgs.set(m.id, m)); renderMsgs(true); if (!j.msgs.length) e.target.closest('.a-cm-more').remove(); }
      return;
    }
    const im = e.target.closest('.a-cm-img'); if (im) { e.preventDefault(); const lb = document.querySelector('[data-lb]'); lb.querySelector('img').src = im.href; lb.hidden = false; return; }
    const o = e.target.closest('[data-order]'); if (o) showOrder(o.dataset.order);
  });
  document.querySelector('[data-lb]').addEventListener('click', (e) => { e.currentTarget.hidden = true; });

  function header() {
    const c = convs.get(cur); if (!c) return;
    $('[data-cm-av]').style.background = color(c.id); $('[data-cm-av]').innerHTML = initial(c.name);
    $('[data-cm-name]').textContent = c.name;
    const ne = $('[data-note-edit]'); ne.textContent = c.note ? c.note : '+ Ghi chú'; ne.classList.toggle('has', !!c.note);
    $('[data-cm-sub]').textContent = `#${c.id} · ${c.guest ? 'Khách chưa đăng nhập' : 'Thành viên'}${c.assignee ? ' · ' + (staffName(c.assignee) || 'đã nhận') + ' xử lý' : ''}${c.blocked ? ' · ĐÃ CHẶN' : ''}`;
    const st = $('[data-act-toggle=status]'); st.textContent = c.status === 'closed' ? 'Mở lại' : 'Đóng chat'; st.dataset.v = c.status === 'closed' ? 'open' : 'close';
    const ai = $('[data-act-toggle=ai]'); ai.classList.toggle('on', !c.ai_off); ai.title = c.ai_off ? 'AI đang tắt cho cuộc chat này — bấm để bật' : 'AI được phép trả lời cuộc chat này — bấm để tắt'; ai.dataset.v = c.ai_off ? 'ai_on' : 'ai_off';
    $$('[data-more-menu] [data-act]').forEach((b) => {
      const a = b.dataset.act;
      b.hidden = (a === 'assign' && c.assignee === meId) || (a === 'unassign' && !c.assignee) || (a === 'block' && c.blocked) || (a === 'unblock' && !c.blocked);
    });
  }
  async function openConv(id) {
    cur = id; msgs.clear(); seenUser = 0;
    box.classList.add('has-conv');
    $('[data-cm-empty]').hidden = true; $('.a-chat-mh').hidden = false; msgBox.hidden = false; $('.a-chat-foot').hidden = false;
    msgBox.innerHTML = '<div class="a-cm-sys">Đang tải...</div>';
    renderList();
    api('/admin/chat/viewing', { json: { id } });
    const j = await api('/admin/chat/c/' + id);
    if (!j.ok || cur !== id) { if (!j.ok) toast(j.message, true); return; }
    convs.set(id, { ...j.conv, unread: 0 });
    j.msgs.forEach((m) => msgs.set(m.id, m));
    curInfo = j.info;
    header(); renderMsgs(); toBottom(); renderInfo(); renderList(); navBadge();
    if (j.conv.unread) api(`/admin/chat/c/${id}/seen`, { json: {} });
    if (matchMedia('(pointer: fine)').matches) $('[data-input]').focus();
    history.replaceState(null, '', '#c' + id);
  }
  $('[data-cm-back]').addEventListener('click', () => { box.classList.remove('has-conv', 'show-info'); cur = null; renderList(); api('/admin/chat/viewing', { json: { id: 0 } }); history.replaceState(null, '', location.pathname); });

  // ---------- Thông tin khách (cột phải) ----------
  const ci = $('[data-ci]');
  function renderInfo() {
    const i = curInfo; if (!i) return;
    const row = (k, v) => (v ? `<div class="a-ci-r"><span>${k}</span><b>${esc(v)}</b></div>` : '');
    const orders = (i.orders || []).map((o) => `<button type="button" class="a-ci-o" data-order="${esc(o.t)}:${o.id}"><span><b>${esc(o.code)}</b><small>${esc(o.time)}</small></span><span class="a-ci-ot">${esc(o.title)}</span><span><small>${esc(o.status)}</small><b>${esc(o.totalText)}</b></span></button>`).join('');
    ci.innerHTML = `
      <div class="a-ci-head"><span class="a-chat-av big" style="background:${color(cur)}">${initial(i.name)}</span><b>${esc(i.username || i.name)}</b><small>${i.guest ? 'Khách chưa đăng nhập' : 'Thành viên'}</small>
        <button type="button" class="a-icon-btn a-ci-x" data-info-toggle aria-label="Đóng">✕</button></div>
      <div class="a-ci-sec">
        ${row('Liên hệ', i.contact)}${row('Tin đã gửi (chưa đăng nhập)', i.guestMsgs)}${i.ipConvs > 1 ? row('Cuộc chat cùng IP', String(i.ipConvs)) : ''}${row('Email', i.email)}${row('Số dư', i.balance)}${row('Tổng nạp', i.deposit)}${row('Tổng chi', i.spent)}
        ${row('Trạng thái', i.status === 'banned' ? 'Đã khóa' : i.status ? 'Hoạt động' : '')}${row('Ngày đăng ký', i.registered)}${row('Đăng nhập gần nhất', i.lastLogin)}
        ${row('IP', i.ip)}${row('IP đăng nhập', i.lastIp)}${row('Nguồn', i.source)}${row('Đang xem trang', i.page)}${row('Bắt đầu chat', i.since)}
        ${i.userId ? `<a class="a-btn a-soft a-btn-sm a-ci-link" href="/admin/users/${i.userId}" target="_blank">Mở hồ sơ khách</a>` : ''}
      </div>
      <div class="a-ci-sec"><div class="a-ci-h">Ghi chú nội bộ <small>(khách không thấy)</small></div>
        <textarea data-note rows="3" maxlength="1000" placeholder="VD: khách quen, hay mua acc Genshin...">${esc(i.note)}</textarea>
        <button type="button" class="a-btn a-soft a-btn-sm" data-note-save>Lưu ghi chú</button></div>
      ${i.guest ? '' : `<div class="a-ci-sec"><div class="a-ci-h">Đơn hàng gần đây</div>${orders || '<div class="a-muted a-small">Chưa có đơn hàng</div>'}</div>`}`;
  }
  ci.addEventListener('click', async (e) => {
    const o = e.target.closest('[data-order]'); if (o) return showOrder(o.dataset.order);
    if (e.target.closest('[data-note-save]')) saveNote($('[data-note]', ci).value.trim());
  });
  // Thông tin khách: chỉ hiện khi bấm avatar / tên, bấm ✕ để đóng
  box.addEventListener('click', async (e) => {
    if (e.target.closest('[data-info-toggle]')) box.classList.toggle('show-info');
    if (e.target.closest('[data-note-edit]') && cur) {
      const c = convs.get(cur);
      const v = prompt('Ghi chú nội bộ cho khách này (khách không thấy). Để trống = xóa ghi chú:', c.note || '');
      if (v === null) return;
      saveNote(v.trim());
    }
  });
  async function saveNote(note) {
    const j = await api(`/admin/chat/c/${cur}/action`, { json: { act: 'note', note } });
    if (!j.ok) return toast(j.message, true);
    convs.set(cur, { ...convs.get(cur), ...j.conv, unread: 0 });
    if (curInfo) { curInfo.note = j.conv.note; const ta = $('[data-note]', ci); if (ta) ta.value = j.conv.note; }
    header(); renderList(); toast('Đã lưu ghi chú');
  }
  async function showOrder(key) {
    const [t, id] = key.split(':');
    const j = await api(`/admin/chat/order/${t}/${id}`);
    if (!j.ok) return toast(j.message, true);
    const o = j.order;
    const m = document.getElementById('aModal');
    document.getElementById('aModalTitle').textContent = `${o.type} · ${o.code}`;
    document.getElementById('aModalBody').innerHTML = `<table class="a-table a-kv">${o.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>
      ${o.proof ? `<p><b>Ảnh xác nhận</b></p><img src="${esc(o.proof)}" alt="" style="max-width:100%;border-radius:10px">` : ''}
      ${o.admin ? `<p style="margin-top:14px"><a class="a-btn a-primary" href="${o.admin}" target="_blank">Mở trang quản lý đơn</a></p>` : ''}`;
    m.hidden = false;
  }

  // ---------- Thao tác ----------
  async function act(a, extra = {}) {
    if (a === 'delete' && !confirm('Xóa vĩnh viễn cuộc chat này (toàn bộ tin nhắn và ảnh)?')) return;
    if (a === 'block' && !confirm('Chặn khách này gửi tin nhắn?')) return;
    const j = await api(`/admin/chat/c/${cur}/action`, { json: { act: a, ...extra } });
    if (!j.ok) return toast(j.message, true);
    if (j.deleted) { convs.delete(cur); $('[data-cm-back]').click(); renderList(); return; }
    convs.set(cur, { ...convs.get(cur), ...j.conv, unread: 0 }); header(); renderList();
  }
  $$('[data-act-toggle]').forEach((b) => b.addEventListener('click', () => act(b.dataset.v)));
  const menu = $('[data-more-menu]');
  $('[data-more]').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'status') return act($('[data-act-toggle=status]').dataset.v);
    act(a === 'unassign' ? 'assign' : a, a === 'unassign' ? { to: 'none' } : a === 'assign' ? { to: meId } : {});
  });

  // ---------- Soạn tin ----------
  const input = $('[data-input]'); const quick = $('[data-quick]');
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(160, input.scrollHeight) + 'px'; };
  let lastTyping = 0;
  input.addEventListener('input', () => {
    grow();
    const v = input.value;
    if (v.startsWith('/')) {
      quick.hidden = false;
      const k = v.slice(1).toLowerCase();
      $$('[data-q]', quick).forEach((b) => { b.hidden = k && !boot.quick[+b.dataset.q].t.toLowerCase().includes(k); });
    } else quick.hidden = true;
    if (cur && v.trim() && Date.now() - lastTyping > 3000) { lastTyping = Date.now(); api(`/admin/chat/c/${cur}/typing`, { json: {} }); }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!quick.hidden) { const first = $$('[data-q]', quick).find((b) => !b.hidden); if (first) { first.click(); return; } }
      send();
    }
    if (e.key === 'Escape') quick.hidden = true;
  });
  $('[data-quick-btn]').addEventListener('click', () => { quick.hidden = !quick.hidden; $$('[data-q]', quick).forEach((b) => { b.hidden = false; }); });
  quick.addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]'); if (!b) return;
    input.value = boot.quick[+b.dataset.q].b; quick.hidden = true; grow(); input.focus();
  });
  $('[data-send]').addEventListener('click', send);
  $('[data-file]').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendImage(f); });
  input.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); sendImage(f); }
  });
  let sending = false;
  async function send() {
    const body = input.value.trim(); if (!body || !cur || sending) return;
    sending = true; input.value = ''; grow();
    const j = await api(`/admin/chat/c/${cur}/send`, { json: { body } });
    sending = false;
    if (!j.ok) { input.value = body; return toast(j.message, true); }
    addMsg(j.msg, true);
  }
  async function sendImage(f) {
    if (!cur) return;
    toast('Đang gửi ảnh...');
    const fd = new FormData(); fd.append('image', f);
    const j = await api(`/admin/chat/c/${cur}/send`, { body: fd });
    if (!j.ok) return toast(j.message, true);
    addMsg(j.msg, true);
  }
  function addMsg(m, scroll) {
    if (m.conv !== cur || msgs.has(m.id)) return false;
    const stick = atBottom();
    msgs.set(m.id, m); renderMsgs();
    if (scroll || stick) toBottom();
    if (m.sender !== 'user') $('[data-cm-typing]').hidden = true;
    return true;
  }

  // ---------- Realtime ----------
  let es = null; let typingT = 0;
  function connect() {
    es = new EventSource('/admin/chat/stream');
    es.addEventListener('msg', (e) => {
      const d = JSON.parse(e.data); const m = d.msg;
      if (d.conv) {
        const viewing = m.conv === cur && document.visibilityState === 'visible';
        convs.set(d.conv.id, viewing ? { ...d.conv, unread: 0 } : d.conv);
      }
      if (m.conv === cur) { if (addMsg(m) && m.sender === 'user' && document.visibilityState === 'visible') api(`/admin/chat/c/${cur}/seen`, { json: {} }); }
      if (m.sender === 'user' && (m.conv !== cur || document.visibilityState !== 'visible')) beep();
      renderList(); navBadge(); refreshCounts();
    });
    es.addEventListener('conv', (e) => {
      const d = JSON.parse(e.data);
      if (d.deleted) { convs.delete(d.id); if (cur === d.id) $('[data-cm-back]').click(); }
      else if (d.conv) { const old = convs.get(d.conv.id); convs.set(d.conv.id, d.conv.id === cur ? { ...d.conv, unread: 0 } : d.conv); if (d.conv.id === cur) header(); if (d.handoff && (!old || old.ai_off !== d.conv.ai_off)) beep(); }
      renderList(); navBadge(); refreshCounts();
    });
    es.addEventListener('seen', (e) => { const d = JSON.parse(e.data); if (d.conv === cur && d.by === 'user') { seenUser = Math.max(seenUser, d.id); renderMsgs(true); } if (d.by === 'agent') { if (convs.get(d.conv)) { convs.get(d.conv).unread = 0; renderList(); navBadge(); } refreshCounts(); } });
    es.addEventListener('typing', (e) => {
      const d = JSON.parse(e.data); if (d.conv !== cur) return;
      const t = $('[data-cm-typing]');
      if (d.who === 'user') t.textContent = 'Khách đang nhập...'; else if (d.name) t.textContent = `${d.name} đang nhập...`; else return;
      t.hidden = false; clearTimeout(typingT); typingT = setTimeout(() => { t.hidden = true; }, 6000);
    });
    es.addEventListener('open', () => { if (connect.dropped) { connect.dropped = false; reloadList(); if (cur) openConv(cur); } });
    es.addEventListener('error', () => { connect.dropped = true; });
  }
  connect();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cur && convs.get(cur)?.unread) api(`/admin/chat/c/${cur}/seen`, { json: {} }); });

  renderList(); navBadge();
  const h = /^#c(\d+)$/.exec(location.hash);
  if (h) openConv(+h[1]);
})();
