/* Chat trực tiếp — khung chat cho khách. Chỉ tải khi khách bấm mở chat hoặc đã từng chat (để báo tin mới). */
(function () {
  'use strict';
  if (window.GZChat) return;
  const root = document.getElementById('gzChat');
  if (!root) return;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkify = (t) => esc(t).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener nofollow">$1</a>').replace(/\n/g, '<br>');
  const hhmm = (ts) => { const d = new Date(ts * 1000); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* bỏ qua */ } } };
  const ICON = {
    x: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    img: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 8.5"/></svg>',
    bag: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 7h12l1 13H5L6 7Z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>',
  };

  let S = null; // dữ liệu từ /chat/init
  let token = '';
  let panel = null; let es = null; let open = false; let pollT = 0; let lastUnread = 0;
  const msgs = new Map(); let seenAgent = 0; let typingT = 0; let lastTyping = 0; let loadingOld = false; let noMore = false;

  async function api(url, opt = {}) {
    const headers = { Accept: 'application/json', 'x-csrf-token': token };
    if (opt.json) { headers['content-type'] = 'application/json'; opt.body = JSON.stringify(opt.json); }
    const r = await fetch(url, { method: opt.method || (opt.body ? 'POST' : 'GET'), body: opt.body, headers, credentials: 'same-origin' });
    let j = {}; try { j = await r.json(); } catch (e) { j = { ok: false, message: 'Lỗi kết nối, thử lại sau' }; }
    return j;
  }

  // ---------- Âm báo + số tin chưa đọc ----------
  function beep() {
    try {
      const A = window.AudioContext || window.webkitAudioContext; const ctx = new A(); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
    } catch (e) { /* bỏ qua */ }
  }
  function badge(n) {
    document.querySelectorAll('[data-chat-badge]').forEach((b) => { b.hidden = !n; b.textContent = n > 9 ? '9+' : n; });
    if (n > lastUnread) beep();
    lastUnread = n;
  }
  async function pollUnread() {
    clearTimeout(pollT);
    if (!open && document.visibilityState === 'visible') {
      const j = await api('/chat/unread').catch(() => null);
      if (j && j.ok) badge(j.n);
    }
    if (!open) pollT = setTimeout(pollUnread, 25000);
  }

  // ---------- Vẽ khung chat ----------
  function build() {
    panel = document.createElement('div');
    panel.className = 'ch-panel ch-' + (root.dataset.pos || 'br') + (root.dataset.layout === 'corner' ? '' : ' ch-center');
    if (root.dataset.layout !== 'corner') {
      const bd = document.createElement('div'); bd.className = 'ch-backdrop'; bd.addEventListener('click', close);
      document.body.appendChild(bd); panel.backdrop = bd;
    }
    panel.style.cssText = root.getAttribute('style') || '';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', root.dataset.title);
    panel.innerHTML = `
      <div class="ch-head"><div class="ch-av">${esc((root.dataset.agent || 'S').slice(0, 1).toUpperCase())}</div>
        <div class="ch-ht"><b>${esc(root.dataset.title)}</b><small data-ch-status></small></div>
        <button type="button" class="ch-x" data-ch-close aria-label="Đóng">${ICON.x}</button></div>
      <div class="ch-body" data-ch-body><div class="ch-list" data-ch-list></div><div class="ch-typing" data-ch-typing hidden><span></span><span></span><span></span></div></div>
      <div class="ch-foot" data-ch-foot></div>`;
    document.body.appendChild(panel);
    $('[data-ch-close]', panel).addEventListener('click', close);
    const body = $('[data-ch-body]', panel);
    body.addEventListener('scroll', () => { if (body.scrollTop < 40) loadOlder(); });
    body.addEventListener('click', (e) => {
      const im = e.target.closest('.ch-img img');
      if (im) { e.preventDefault(); lightbox(im.src); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && !document.querySelector('.ch-lb')) close(); });
  }
  function lightbox(src) {
    const lb = document.createElement('div'); lb.className = 'ch-lb'; lb.innerHTML = `<img src="${esc(src)}" alt=""><button type="button" aria-label="Đóng">${ICON.x}</button>`;
    lb.addEventListener('click', () => lb.remove()); document.body.appendChild(lb);
  }
  function setStatus() {
    const el = $('[data-ch-status]', panel); if (!el) return;
    el.innerHTML = S.status === 'online' ? '<i class="ch-dot"></i>Đang trực tuyến' : S.status === 'away' ? 'Thường trả lời trong vài phút' : 'Ngoài giờ làm việc';
  }
  function refCard(r) {
    const url = r.t === 'acc' ? '/user/orders/' + encodeURIComponent(r.code) : '/user/boost/' + encodeURIComponent(r.code);
    return `<a class="ch-ref" href="${url}" target="_blank"><span class="ch-ref-ic">${ICON.bag}</span><span><b>${esc(r.code)}</b><small>${esc(r.title)}</small><small>${esc(r.totalText || '')} · ${esc(r.status || '')}</small></span></a>`;
  }
  function bubble(m) {
    if (m.sender === 'system') return `<div class="ch-sys" data-id="${m.id}">${linkify(m.body)}</div>`;
    const me = m.sender === 'user';
    return `<div class="ch-row ${me ? 'me' : 'them'}" data-id="${m.id}">
      ${!me ? `<div class="ch-name">${esc(m.name || root.dataset.agent)}${m.sender === 'ai' ? ' <span class="ch-ai">AI</span>' : ''}</div>` : ''}
      ${m.image ? `<a class="ch-img" href="${esc(m.image)}" target="_blank"><img src="${esc(m.image)}" alt="" loading="lazy"></a>` : ''}
      ${m.ref ? refCard(m.ref) : ''}
      ${m.body ? `<div class="ch-b">${linkify(m.body)}</div>` : ''}
      <div class="ch-t">${hhmm(m.at)}</div></div>`;
  }
  function renderList() {
    const list = $('[data-ch-list]', panel);
    const arr = [...msgs.values()].sort((a, b) => a.id - b.id);
    const greet = root.dataset.greeting ? `<div class="ch-row them ch-greet"><div class="ch-name">${esc(root.dataset.agent)}</div><div class="ch-b">${linkify(root.dataset.greeting)}</div></div>` : '';
    list.innerHTML = greet + arr.map(bubble).join('') + seenMark(arr);
  }
  function seenMark(arr) {
    const mine = arr.filter((m) => m.sender === 'user');
    const last = mine[mine.length - 1];
    return last && seenAgent >= last.id && arr[arr.length - 1] === last ? '<div class="ch-seen">Đã xem</div>' : '';
  }
  const atBottom = () => { const b = $('[data-ch-body]', panel); return b.scrollHeight - b.scrollTop - b.clientHeight < 80; };
  const toBottom = () => { const b = $('[data-ch-body]', panel); b.scrollTop = b.scrollHeight; };
  function addMsg(m, scroll) {
    if (msgs.has(m.id)) return false;
    const stick = atBottom();
    msgs.set(m.id, m); renderList();
    if (scroll || stick || m.sender === 'user') toBottom();
    if (m.sender !== 'user') { $('[data-ch-typing]', panel).hidden = true; }
    return true;
  }

  // ---------- Ô nhập ----------
  function renderFoot() {
    const foot = $('[data-ch-foot]', panel);
    const me = S.me;
    if (S.conv && S.conv.blocked) { foot.innerHTML = '<div class="ch-note">Bạn không thể gửi tin nhắn lúc này.</div>'; return; }
    if (!me.logged && !S.guest.allowed) {
      foot.innerHTML = '<div class="ch-login"><p>Vui lòng đăng nhập để chat với shop</p><div><a class="btn btn-primary btn-sm" href="/login">Đăng nhập</a><a class="btn btn-ghost btn-sm" href="/register">Đăng ký</a></div></div>';
      return;
    }
    if (!me.logged && !S.conv) {
      foot.innerHTML = `<form class="ch-start" data-ch-start>
        <p>Để lại tên ${S.guest.contact ? 'và số điện thoại / Zalo ' : ''}để shop tiện hỗ trợ bạn</p>
        <input name="name" maxlength="40" placeholder="Tên của bạn" required autocomplete="name">
        ${S.guest.contact ? '<input name="contact" maxlength="60" placeholder="Số điện thoại / Zalo / email" required autocomplete="tel">' : ''}
        <input name="website" tabindex="-1" autocomplete="off" class="ch-hp" aria-hidden="true">
        <button class="btn btn-primary">Bắt đầu chat</button>
        <small>Đã có tài khoản? <a href="/login">Đăng nhập</a></small></form>`;
      $('[data-ch-start]', foot).addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target; const btn = f.querySelector('button'); btn.disabled = true;
        const j = await api('/chat/start', { json: { name: f.name.value, contact: f.contact ? f.contact.value : '', website: f.website.value, page: location.pathname } });
        btn.disabled = false;
        if (!j.ok) return note(j.message);
        S.conv = { id: j.conv.id, blocked: false };
        store.set('gz_chat', '1');
        renderFoot(); connect();
        $('[data-ch-input]', panel)?.focus();
      });
      return;
    }
    if (!me.logged && me.guestLeft === 0) {
      foot.innerHTML = '<div class="ch-login"><p>Bạn đã gửi hết số tin cho khách chưa đăng nhập. Đăng nhập để tiếp tục chat.</p><div><a class="btn btn-primary btn-sm" href="/login">Đăng nhập</a><a class="btn btn-ghost btn-sm" href="/register">Đăng ký</a></div></div>';
      return;
    }
    foot.innerHTML = `
      ${!me.logged && me.guestLeft != null ? `<div class="ch-left">Còn ${me.guestLeft} tin khi chưa đăng nhập · <a href="/login">Đăng nhập</a></div>` : ''}
      <div class="ch-orders" data-ch-orders hidden></div>
      <div class="ch-compose">
        ${me.canImage ? `<label class="ch-tool" title="Gửi ảnh">${ICON.img}<input type="file" accept="image/*" data-ch-file hidden></label>` : ''}
        ${me.logged ? `<button type="button" class="ch-tool" data-ch-order title="Gửi đơn hàng">${ICON.bag}</button>` : ''}
        <textarea data-ch-input rows="1" maxlength="1000" placeholder="Nhập tin nhắn..."></textarea>
        <button type="button" class="ch-send" data-ch-send aria-label="Gửi">${ICON.send}</button>
      </div>`;
    const ta = $('[data-ch-input]', foot);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; };
    ta.addEventListener('input', () => {
      grow();
      if (Date.now() - lastTyping > 3000 && ta.value.trim()) { lastTyping = Date.now(); api('/chat/typing', { method: 'POST', json: {} }).catch(() => {}); }
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendText(); } });
    $('[data-ch-send]', foot).addEventListener('click', sendText);
    $('[data-ch-file]', foot)?.addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendForm({ file: f }); });
    $('[data-ch-order]', foot)?.addEventListener('click', toggleOrders);
  }
  function note(msg) {
    const n = document.createElement('div'); n.className = 'ch-toast'; n.textContent = msg;
    panel.appendChild(n); setTimeout(() => n.remove(), 4000);
  }
  async function toggleOrders() {
    const box = $('[data-ch-orders]', panel);
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '<div class="ch-o-empty">Đang tải...</div>';
    const j = await api('/chat/orders');
    if (!j.ok) { box.innerHTML = `<div class="ch-o-empty">${esc(j.message)}</div>`; return; }
    if (!j.orders.length) { box.innerHTML = '<div class="ch-o-empty">Bạn chưa có đơn hàng nào</div>'; return; }
    box.innerHTML = '<div class="ch-o-head">Chọn đơn hàng để gửi</div>' + j.orders.map((o) => `<button type="button" class="ch-o" data-t="${esc(o.t)}" data-code="${esc(o.code)}"><b>${esc(o.code)}</b><span>${esc(o.title)}</span><small>${esc(o.totalText)} · ${esc(o.status)} · ${esc(o.time)}</small></button>`).join('');
    box.querySelectorAll('.ch-o').forEach((b) => b.addEventListener('click', () => { box.hidden = true; sendForm({ ref_t: b.dataset.t, ref_code: b.dataset.code }); }));
  }
  function sendText() {
    const ta = $('[data-ch-input]', panel); const body = ta.value.trim();
    if (!body) return;
    ta.value = ''; ta.style.height = 'auto';
    sendForm({ body });
  }
  let sending = false;
  async function sendForm({ body = '', file = null, ref_t = '', ref_code = '' }) {
    if (sending) return; sending = true;
    let j;
    try {
      if (file) {
        const fd = new FormData(); fd.append('image', file); fd.append('page', location.pathname);
        note('Đang gửi ảnh...');
        j = await api('/chat/send', { method: 'POST', body: fd });
      } else j = await api('/chat/send', { json: { body, ref_t, ref_code, page: location.pathname } });
    } finally { sending = false; }
    if (!j.ok) {
      if (body) { const ta = $('[data-ch-input]', panel); if (ta && !ta.value) ta.value = body; }
      if (j.start) { S.conv = null; renderFoot(); }
      if (j.login && !S.me.logged) { S.me.guestLeft = 0; renderFoot(); }
      return note(j.message);
    }
    store.set('gz_chat', '1');
    panel.querySelectorAll('.ch-toast').forEach((t) => t.remove());
    if (!S.conv) S.conv = { id: j.msg.conv, blocked: false };
    const left = S.me.guestLeft;
    S.me = j.me;
    addMsg(j.msg, true);
    if (!es) connect();
    if (left !== S.me.guestLeft) renderFoot();
  }

  async function loadOlder() {
    if (loadingOld || noMore || !msgs.size) return;
    loadingOld = true;
    const first = Math.min(...msgs.keys());
    const j = await api('/chat/history?before=' + first);
    loadingOld = false;
    if (!j.ok || !j.msgs.length) { noMore = true; return; }
    const b = $('[data-ch-body]', panel); const h = b.scrollHeight;
    j.msgs.forEach((m) => msgs.set(m.id, m)); renderList();
    b.scrollTop = b.scrollHeight - h;
  }

  // ---------- Kết nối realtime ----------
  function connect() {
    if (es || !S.conv) return;
    const last = msgs.size ? Math.max(...msgs.keys()) : 0;
    es = new EventSource('/chat/stream?after=' + last);
    es.addEventListener('msg', (e) => {
      const d = JSON.parse(e.data);
      if (addMsg(d.msg) && d.msg.sender !== 'user') { if (document.visibilityState === 'visible') seen(); else beep(); }
    });
    es.addEventListener('seen', (e) => { const d = JSON.parse(e.data); if (d.by === 'agent') { seenAgent = Math.max(seenAgent, d.id); renderList(); } });
    es.addEventListener('typing', (e) => {
      const d = JSON.parse(e.data); if (d.who !== 'agent') return;
      const t = $('[data-ch-typing]', panel); const stick = atBottom(); t.hidden = false; if (stick) toBottom();
      clearTimeout(typingT); typingT = setTimeout(() => { t.hidden = true; }, 6000);
    });
  }
  function disconnect() { if (es) { es.close(); es = null; } }
  function seen() { if (open) api('/chat/seen', { method: 'POST', json: {} }).catch(() => {}); badge(0); }

  async function openChat() {
    if (!panel) build();
    open = true; clearTimeout(pollT);
    panel.classList.add('open'); panel.backdrop?.classList.add('open'); document.documentElement.classList.add('ch-lock');
    document.querySelector('[data-support]')?.classList.remove('open');
    if (!S) {
      $('[data-ch-list]', panel).innerHTML = '<div class="ch-sys">Đang tải...</div>';
      const j = await api('/chat/init');
      if (!j.ok) { $('[data-ch-list]', panel).innerHTML = `<div class="ch-sys">${esc(j.message)}</div>`; return; }
      S = j; token = j.token;
      if (j.conv) store.set('gz_chat', '1');
      j.msgs.forEach((m) => msgs.set(m.id, m));
      setStatus(); renderList(); renderFoot(); toBottom();
    }
    connect(); seen();
    if (matchMedia('(pointer: fine)').matches) $('[data-ch-input]', panel)?.focus();
  }
  function close() {
    open = false;
    panel?.classList.remove('open'); panel?.backdrop?.classList.remove('open'); document.documentElement.classList.remove('ch-lock');
    disconnect();
    if (store.get('gz_chat')) pollT = setTimeout(pollUnread, 25000);
  }
  document.addEventListener('visibilitychange', () => {
    if (open && document.visibilityState === 'visible') seen();
    if (!open && document.visibilityState === 'visible' && store.get('gz_chat')) pollUnread();
  });

  window.GZChat = { open: openChat, close, poll: pollUnread };
})();
