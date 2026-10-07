(function () {
  'use strict';

  // Nguồn khách: link quảng cáo (utm_*, gclid) hoặc trang giới thiệu -> cookie gz_src 30 ngày, lưu vào tài khoản lúc đăng ký
  try {
    const q = new URLSearchParams(location.search);
    const has = /(?:^|;\s*)gz_src=/.test(document.cookie);
    let src = null;
    if (q.get('utm_source') || q.get('utm_campaign') || q.get('gclid') || q.get('gbraid') || q.get('wbraid') || q.get('fbclid')) {
      src = { s: q.get('utm_source') || (q.get('gclid') || q.get('gbraid') || q.get('wbraid') ? 'google-ads' : 'facebook'), m: q.get('utm_medium') || (q.get('fbclid') ? 'social' : 'cpc'), c: q.get('utm_campaign') || '' };
      if (q.get('gclid') || q.get('gbraid') || q.get('wbraid')) src.g = 1;
    } else if (!has && document.referrer) {
      const h = new URL(document.referrer).hostname.replace(/^www\./, '');
      if (h && h !== location.hostname.replace(/^www\./, '')) src = { s: h, m: /google\.|bing\.|coccoc\.|yahoo\./.test(h) ? 'organic' : 'referral' };
    }
    if (src) document.cookie = 'gz_src=' + encodeURIComponent(JSON.stringify(src)) + '; Max-Age=2592000; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  } catch (e) { /* bỏ qua */ }
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const csrf = $('meta[name="csrf-token"]')?.content || '';

  function toast(msg, color) {
    const t = document.createElement('div');
    t.className = 'toast';
    if (color) t.style.background = color;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  function copy(text) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast('Đã sao chép'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); toast('Đã sao chép'); } catch (e) { /* ignore */ }
        ta.remove();
      });
  }

  // Nút Hỗ trợ: bấm để mở / đóng; tự mở khi vào web rồi thu lại sau N giây (admin chỉnh)
  const sp = $('[data-support]');
  if (sp) {
    const btn = $('[data-sp-toggle]', sp);
    let timer = 0;
    const setOpen = (o) => { sp.classList.toggle('open', o); btn.setAttribute('aria-expanded', o ? 'true' : 'false'); };
    btn.addEventListener('click', () => { clearTimeout(timer); setOpen(!sp.classList.contains('open')); });
    $('[data-sp-close]', sp).addEventListener('click', () => { clearTimeout(timer); setOpen(false); });
    document.addEventListener('click', (e) => { if (!e.target.closest('[data-support]') && sp.classList.contains('open')) { clearTimeout(timer); setOpen(false); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
    ['pointerenter', 'touchstart', 'focusin'].forEach((ev) => sp.addEventListener(ev, () => clearTimeout(timer), { passive: true }));
    const n = +sp.dataset.auto || 0;
    let seen = false; try { seen = sp.dataset.once === '1' && sessionStorage.getItem('sp_auto') === '1'; } catch (e) { /* bỏ qua */ }
    if (n > 0 && !seen && getComputedStyle(sp).display !== 'none') {
      setTimeout(() => {
        setOpen(true);
        try { sessionStorage.setItem('sp_auto', '1'); } catch (e) { /* bỏ qua */ }
        timer = setTimeout(() => setOpen(false), n * 1000);
      }, 700);
    }
  }

  // Chat trực tiếp: chỉ tải chat.js khi khách bấm mở chat, hoặc đã từng chat (để báo tin shop trả lời)
  const chatRoot = $('#gzChat');
  if (chatRoot) {
    let loading = null;
    const loadChat = () => loading || (loading = new Promise((ok, no) => {
      const sc = document.createElement('script'); sc.src = '/js/chat.js?v=' + (document.querySelector('script[src*="main.js"]')?.src.split('v=')[1] || '1');
      sc.onload = () => ok(window.GZChat); sc.onerror = no; document.head.appendChild(sc);
    }));
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-chat-open]'); if (!t) return;
      e.preventDefault(); loadChat().then((c) => c && c.open());
    });
    if (location.hash === '#chat') loadChat().then((c) => c && c.open());
    let had = false; try { had = !!localStorage.getItem('gz_chat'); } catch (e) { /* bỏ qua */ }
    if (had) setTimeout(() => loadChat().then((c) => c && c.poll()), 2500);
  }

  // Toggle menu / dropdown
  // Menu điện thoại: lớp phủ phía sau -> chạm ra ngoài chỉ đóng menu, không bấm nhầm banner / link bên dưới
  const mnav = $('#mobileNav');
  if (mnav) {
    const bd = document.createElement('div'); bd.className = 'nav-backdrop'; bd.hidden = true; document.body.appendChild(bd);
    new MutationObserver(() => { bd.hidden = !mnav.classList.contains('open'); }).observe(mnav, { attributes: true, attributeFilter: ['class'] });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.catbar.open, .dropdown-menu.open').forEach((m) => m.classList.remove('open')); });
  document.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      e.preventDefault();
      $(tg.dataset.toggle)?.classList.toggle('open');
      return;
    }
    if (!e.target.closest('.dropdown')) $$('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));
    // Menu điện thoại: bấm ra ngoài menu thì thu lại
    if (!e.target.closest('.catbar')) $$('.catbar.open').forEach((m) => m.classList.remove('open'));

    const c = e.target.closest('[data-copy]');
    if (c) copy(c.dataset.copy);
    const ct = e.target.closest('[data-copy-target]');
    if (ct) copy($(ct.dataset.copyTarget)?.textContent.trim() || '');
    const rv = e.target.closest('[data-reveal-btn]');
    if (rv) $(rv.dataset.revealBtn)?.classList.toggle('blurred');
    const rc = e.target.closest('[data-refresh-captcha]');
    if (rc) rc.src = '/captcha.svg?' + Date.now();
    const fc = e.target.closest('[data-fill-coupon]');
    if (fc && $('#couponInput')) { $('#couponInput').value = fc.dataset.fillCoupon; $('#couponCheck')?.click(); }
    const am = e.target.closest('[data-amount]');
    if (am && $('#amountInput')) $('#amountInput').value = am.dataset.amount;
    if (e.target.closest('[data-close-popup]')) { if (e.target.closest('a[href="#"]')) e.preventDefault(); closePopup(); }
  });

  // Xác nhận trước khi submit + chống bấm 2 lần
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (e.defaultPrevented) return; // đã bị chặn (VD đang mở popup xác nhận mua)
    if (f.dataset.confirm && !confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (f.dataset.submitting) { e.preventDefault(); return; }
    f.dataset.submitting = '1';
    $$('button[type=submit], button:not([type])', f).forEach((b) => { b.disabled = true; });
    setTimeout(() => { delete f.dataset.submitting; $$('button', f).forEach((b) => { b.disabled = false; }); }, 8000);
  });

  // Slider banner (trang chủ có thể có nhiều slider)
  $$('[data-slider]').forEach((slider) => {
    const slides = $$('.slide', slider);
    const dots = $$('[data-dot]', slider);
    let i = 0, timer;
    const go = (n) => {
      i = (n + slides.length) % slides.length;
      slides.forEach((s, k) => s.classList.toggle('active', k === i));
      dots.forEach((d, k) => d.classList.toggle('active', k === i));
    };
    const auto = () => { clearInterval(timer); timer = setInterval(() => go(i + 1), 5000); };
    $('[data-prev]', slider)?.addEventListener('click', () => { go(i - 1); auto(); });
    $('[data-next]', slider)?.addEventListener('click', () => { go(i + 1); auto(); });
    dots.forEach((d) => d.addEventListener('click', () => { go(+d.dataset.dot); auto(); }));
    if (slides.length > 1) auto();
  });

  // Gallery sản phẩm + xem ảnh phóng to (lightbox)
  const gal = $('[data-gallery]');
  if (gal) {
    const main = $('.gallery-main', gal);
    const thumbs = $$('.gallery-thumbs img', gal);
    let cur = 0;
    thumbs.forEach((t, i) => t.addEventListener('click', () => {
      cur = i;
      main.src = t.src;
      thumbs.forEach((x) => x.classList.toggle('active', x === t));
    }));

    const lb = $('#lightbox');
    if (lb && main.hasAttribute('data-zoom')) {
      let imgs = [];
      try { imgs = JSON.parse(lb.dataset.images || '[]'); } catch (e) { imgs = []; }
      const lbImg = $('.lb-img', lb);
      const count = $('[data-lb-count]', lb);
      let idx = 0;
      const show = (i) => {
        idx = (i + imgs.length) % imgs.length;
        lbImg.src = imgs[idx];
        if (count) count.textContent = imgs.length > 1 ? (idx + 1) + ' / ' + imgs.length : '';
      };
      const open = () => {
        if (!imgs.length) return;
        show(cur);
        lb.hidden = false;
        document.body.classList.add('lb-open');
      };
      const close = () => {
        lb.hidden = true;
        document.body.classList.remove('lb-open');
        main.focus({ preventScroll: true });
      };
      main.addEventListener('click', open);
      main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      lb.addEventListener('click', (e) => {
        if (e.target.closest('[data-lb-close]') || e.target === lb) close();
        else if (e.target.closest('[data-lb-prev]')) show(idx - 1);
        else if (e.target.closest('[data-lb-next]')) show(idx + 1);
      });
      document.addEventListener('keydown', (e) => {
        if (lb.hidden) return;
        if (e.key === 'Escape') close();
        else if (e.key === 'ArrowLeft') show(idx - 1);
        else if (e.key === 'ArrowRight') show(idx + 1);
      });
      // Vuốt trái/phải trên điện thoại để chuyển ảnh
      let sx = null;
      lb.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
      lb.addEventListener('touchend', (e) => {
        if (sx === null || imgs.length < 2) return;
        const dx = e.changedTouches[0].clientX - sx;
        if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
        sx = null;
      });
    }
  }

  // Kiểm tra mã giảm giá
  const cBtn = $('#couponCheck');
  if (cBtn) {
    const input = $('#couponInput');
    const msg = $('#couponMsg');
    const priceEl = $('#finalPrice');
    const base = +priceEl.dataset.price;
    const fmt = (n) => n.toLocaleString('vi-VN') + 'đ';
    cBtn.addEventListener('click', async () => {
      const code = input.value.trim();
      if (!code) { msg.textContent = ''; priceEl.textContent = fmt(base); return; }
      cBtn.disabled = true;
      try {
        const r = await fetch('/api/coupon/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
          body: JSON.stringify({ code, product: input.dataset.product }),
        });
        const j = await r.json();
        msg.textContent = j.message;
        msg.style.color = j.ok ? '#86efac' : '#fca5a5';
        priceEl.textContent = fmt(j.ok ? j.total : base);
      } catch (e) {
        msg.textContent = 'Lỗi kết nối';
      } finally { cBtn.disabled = false; }
    });
  }

  // Điện thoại: cuộn xuống quá 1 đoạn thì ẩn thanh tìm kiếm, cuộn lên thì hiện lại
  const topbar = $('.topbar');
  const mq = window.matchMedia('(max-width: 720px)');
  if (topbar && $('.search', topbar)) {
    let lastY = window.scrollY, ticking = false, lockUntil = 0;
    const update = () => {
      ticking = false;
      const y = window.scrollY;
      const hidden = topbar.classList.contains('search-hidden');
      const canScroll = document.documentElement.scrollHeight - window.innerHeight > 400;
      if (!mq.matches || !canScroll || y < 80 || document.activeElement?.closest('.search')) {
        if (hidden) topbar.classList.remove('search-hidden');
      } else if (Date.now() > lockUntil) {
        if (!hidden && y > lastY + 8) { topbar.classList.add('search-hidden'); lockUntil = Date.now() + 300; }
        else if (hidden && y < lastY - 8) { topbar.classList.remove('search-hidden'); lockUntil = Date.now() + 300; }
      }
      if (Math.abs(y - lastY) > 8 || y < 80) lastY = y;
    };
    window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  }

  // Nút "Gửi lại mã": đếm ngược thời gian chờ
  $$('[data-resend-wait]').forEach((btn) => {
    let w = +btn.dataset.resendWait || 0;
    if (w <= 0) return;
    const label = 'Gửi lại mã';
    const t = setInterval(() => {
      w -= 1;
      btn.textContent = w > 0 ? `${label} (${w}s)` : label;
      if (w <= 0) { btn.disabled = false; clearInterval(t); }
    }, 1000);
  });
  // Ô nhập mã 6 số: chỉ giữ chữ số
  $$('.otp-input').forEach((inp) => inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); }));

  // Popup xác nhận mua: kiểm tra mã KM + số dư trước khi gửi đơn
  // Nạp tiền: đang có đơn chờ -> hỏi trước khi tạo mã mới (đồng ý = hủy đơn cũ)
  const depForm = $('form[data-has-pending]'), dr = $('#depReplace');
  if (depForm && dr) {
    const close = () => { dr.hidden = true; document.body.classList.remove('no-scroll'); };
    depForm.addEventListener('submit', (e) => {
      if (depForm.elements.replace.value === '1') return;
      e.preventDefault();
      dr.hidden = false; document.body.classList.add('no-scroll');
      $('[data-dr-ok]', dr).focus();
    });
    $('[data-dr-ok]', dr).addEventListener('click', () => { close(); depForm.elements.replace.value = '1'; depForm.requestSubmit(); });
    $$('[data-dr-close]', dr).forEach((b) => b.addEventListener('click', close));
    dr.addEventListener('click', (e) => { if (e.target === dr) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dr.hidden) close(); });
  }

  const bc = $('#buyConfirm');
  const buyForm = $('[data-buy-form]');
  if (bc && buyForm) {
    const fmt = (n) => n.toLocaleString('vi-VN') + 'đ';
    const balance = +bc.dataset.balance, price = +bc.dataset.price;
    const okBtn = $('[data-bc-ok]', bc), topup = $('[data-bc-topup]', bc), err = $('[data-bc-err]', bc);
    let sending = false;
    const close = () => { bc.hidden = true; document.body.classList.remove('no-scroll'); };
    const render = (discount, code, errMsg) => {
      const total = price - discount;
      $('.bc-coupon', bc).hidden = !discount;
      $('[data-bc-code]', bc).textContent = code || '';
      $('[data-bc-discount]', bc).textContent = '-' + fmt(discount);
      $('[data-bc-total]', bc).textContent = fmt(total);
      const after = balance - total;
      const aEl = $('[data-bc-after]', bc);
      aEl.textContent = fmt(after);
      aEl.classList.toggle('bc-neg', after < 0);
      let msg = errMsg || '';
      if (after < 0) msg = (msg ? msg + ' ' : '') + `Số dư chưa đủ, cần nạp thêm ${fmt(-after)}.`;
      err.hidden = !msg;
      err.textContent = msg;
      okBtn.hidden = after < 0 || !!errMsg;
      topup.hidden = after >= 0;
      $('span', okBtn).textContent = 'Xác nhận mua · ' + fmt(total);
    };
    buyForm.addEventListener('submit', async (e) => {
      if (sending) return;
      e.preventDefault();
      const code = ($('#couponInput')?.value || '').trim();
      render(0, '', code ? 'Đang kiểm tra mã giảm giá...' : '');
      okBtn.hidden = true;
      bc.hidden = false;
      document.body.classList.add('no-scroll');
      if (!code) { render(0, ''); okBtn.focus(); return; }
      try {
        const r = await fetch('/api/coupon/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' },
          body: JSON.stringify({ code, product: $('#couponInput').dataset.product }),
        });
        const j = await r.json();
        if (j.ok) render(j.discount, code.toUpperCase());
        else render(0, '', `Mã “${code}” không dùng được: ${j.message}. Hãy xóa hoặc đổi mã rồi bấm Mua lại.`);
      } catch (x) { render(0, '', 'Lỗi kết nối, vui lòng thử lại.'); }
    });
    okBtn.addEventListener('click', () => {
      sending = true;
      okBtn.disabled = true;
      $('span', okBtn).textContent = 'Đang xử lý...';
      buyForm.requestSubmit ? buyForm.requestSubmit() : buyForm.submit();
    });
    bc.addEventListener('click', (e) => { if (e.target === bc || e.target.closest('[data-bc-close]')) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !bc.hidden) close(); });
  }

  // Đếm ngược hạn thanh toán đơn nạp (theo giờ máy chủ, bù lệch giờ máy khách)
  const cds = $$('[data-countdown]');
  let depExpired = false;
  if (cds.length) {
    const skew = Math.floor(Date.now() / 1000) - (+cds[0].dataset.now || 0);
    const fmt = (s) => {
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
      const p = (n) => String(n).padStart(2, '0');
      return (d ? d + ' ngày ' : '') + (d || h ? p(h) + ':' : '') + p(m) + ':' + p(x);
    };
    const tick = () => {
      const t = Math.floor(Date.now() / 1000) - skew;
      let alive = 0;
      cds.forEach((el) => {
        const left = (+el.dataset.countdown) - t;
        if (left > 0) { el.textContent = fmt(left); alive++; return; }
        if (el.dataset.done) return;
        el.dataset.done = '1';
        el.textContent = '00:00';
        el.classList.add('cd-over');
        const row = el.closest('tr');
        const act = row && $('.actions', row);
        if (act) act.innerHTML = '<span class="status status-expired">Đã hủy (quá hạn)</span>';
        const box = el.closest('[data-deposit-code]');
        if (box) {
          depExpired = true;
          $$('.qr, .deposit-grid .table', box).forEach((n) => { n.style.opacity = '.35'; n.style.pointerEvents = 'none'; });
          const al = el.closest('.alert');
          if (al) { al.className = 'alert alert-error'; al.textContent = 'Yêu cầu nạp đã quá thời gian chờ và bị hủy. Không chuyển khoản vào mã này nữa, vui lòng tạo yêu cầu mới.'; }
          $('#depositStatus').textContent = '';
        }
      });
      if (alive) setTimeout(tick, 1000);
    };
    tick();
  }

  // Popup "Nạp tiền thành công" (giữa màn hình). Đóng -> tải lại để số dư trên đầu trang cập nhật
  const depPopup = $('#depPopup');
  const money = (n) => Number(n || 0).toLocaleString('vi-VN') + 'đ';
  function showDepositPopup(r) {
    if (!depPopup) return;
    const set = (k, v) => { const el = $('[data-dp="' + k + '"]', depPopup); if (el) el.textContent = v; };
    set('received', '+' + money(r.received));
    set('before', r.before == null ? '—' : money(r.before));
    set('after', r.after == null ? '—' : money(r.after));
    set('code', r.code || '');
    set('at', r.at ? new Date(r.at * 1000).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
    if (r.after != null) $$('.top-balance').forEach((b) => { const ico = b.querySelector('svg'); b.textContent = ' ' + money(r.after); if (ico) b.prepend(ico); });
    depPopup.hidden = false;
    depPopup.dataset.reload = '1';
    document.body.classList.add('no-scroll');
  }
  if (depPopup) {
    if (!depPopup.hidden) document.body.classList.add('no-scroll');
    const closeDp = () => {
      depPopup.hidden = true;
      document.body.classList.remove('no-scroll');
      if (depPopup.dataset.reload) location.href = '/user/deposit';
    };
    $$('[data-dp-close]', depPopup).forEach((b) => b.addEventListener('click', closeDp));
    depPopup.addEventListener('click', (e) => { if (e.target === depPopup) closeDp(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !depPopup.hidden) closeDp(); });
  }

  // Trang nạp tiền: tự kiểm tra trạng thái mỗi 5 giây
  const dep = $('[data-deposit-code]');
  if (dep) {
    const code = dep.dataset.depositCode;
    let tries = 0;
    const check = async () => {
      if (depExpired || ++tries > 720) return; // tối đa 1 giờ
      try {
        const r = await fetch('/user/deposit/' + encodeURIComponent(code) + '/status', { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (j.ok && j.status === 'success') {
          $('#depositStatus').innerHTML = '';
          $('#depositStatus').textContent = 'Nạp thành công ' + j.received.toLocaleString('vi-VN') + 'đ!';
          showDepositPopup(j.receipt || { received: j.received, code });
          return;
        }
        if (j.ok && j.status !== 'pending') { $('#depositStatus').textContent = 'Yêu cầu nạp đã ' + (j.status === 'expired' ? 'quá thời gian chờ và bị hủy. Vui lòng tạo yêu cầu mới.' : 'bị hủy'); return; }
      } catch (e) { /* thử lại */ }
      setTimeout(check, 5000);
    };
    setTimeout(check, 5000);
  }

  // ---------------- Cài đặt giao diện ----------------
  const uiBox = $('#uiSettings');
  const T = window.UI_THEME;
  if (uiBox && T) {
    const accentBox = $('[data-ui-group="accent"]', uiBox);
    const bgBox = $('[data-ui-group="bg"]', uiBox);
    const makeSwatch = (group, key, name, color) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ui-swatch';
      b.setAttribute('role', 'radio');
      b.dataset.value = key;
      b.title = name;
      b.setAttribute('aria-label', name);
      b.style.setProperty('--sw', color);
      return b;
    };
    Object.keys(T.ACCENTS).forEach((k) => accentBox.appendChild(makeSwatch('accent', k, T.ACCENTS[k][0], T.ACCENTS[k][2])));
    Object.keys(T.BGS).forEach((k) => bgBox.appendChild(makeSwatch('bg', k, T.BGS[k][0], T.BGS[k][1])));

    const render = () => {
      const u = T.get();
      $$('[data-ui-group]', uiBox).forEach((g) => {
        $$('[data-value]', g).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === u[g.dataset.uiGroup])));
      });
      $('[data-ui-name="accent"]', uiBox).textContent = T.ACCENTS[u.accent][0];
      $('[data-ui-name="bg"]', uiBox).textContent = T.BGS[u.bg][0];
    };
    const openUI = () => { render(); uiBox.hidden = false; $('[aria-checked="true"]', uiBox)?.focus(); };
    const closeUI = () => { uiBox.hidden = true; };

    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-ui-open]')) {
        e.preventDefault();
        $$('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));
        openUI();
        return;
      }
      if (uiBox.hidden) return;
      if (e.target === uiBox || e.target.closest('[data-ui-close]')) { closeUI(); return; }
      if (e.target.closest('[data-ui-reset]')) { T.reset(); render(); toast('Đã khôi phục giao diện mặc định'); return; }
      const opt = e.target.closest('[data-ui-group] [data-value]');
      if (opt) { T.set({ [opt.closest('[data-ui-group]').dataset.uiGroup]: opt.dataset.value }); render(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !uiBox.hidden) closeUI(); });
  }

  // Popup (Admin -> Giao diện -> Popup): hiện sau N giây, ẩn lại N giờ sau khi khách đóng (0 = lần nào vào cũng hiện)
  const popup = $('#sitePopup');
  function closePopup() {
    if (!popup || popup.hidden) return;
    popup.hidden = true;
    try { localStorage.setItem('popup_' + popup.dataset.popupId, Date.now()); } catch (e) { /* ignore */ }
  }
  if (popup) {
    let last = 0;
    try { last = +localStorage.getItem('popup_' + popup.dataset.popupId) || 0; } catch (e) { /* ignore */ }
    const repeat = +popup.dataset.repeat || 0;
    if (!repeat || Date.now() - last > repeat * 3600 * 1000) {
      setTimeout(() => { if (!(depPopup && !depPopup.hidden)) popup.hidden = false; }, (+popup.dataset.delay || 0) * 1000);
    }
    popup.addEventListener('click', (e) => { if (e.target === popup) closePopup(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
  }

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

  // Trang Bảo mật: nút Đổi email / Đổi mật khẩu mở bảng tương ứng (mở 1 bảng một lúc)
  const secBtns = $$('[data-sec-toggle]');
  function secOpen(name, focus) {
    secBtns.forEach((b) => {
      const on = b.dataset.secToggle === name && b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(on));
      b.classList.toggle('active', on);
      const panel = $(`[data-sec-panel="${b.dataset.secToggle}"]`);
      if (panel) panel.hidden = !on;
      if (on && focus && panel) panel.querySelector('input:not([type=hidden])')?.focus();
    });
  }
  secBtns.forEach((b) => b.addEventListener('click', () => secOpen(b.dataset.secToggle, true)));
  if (location.hash === '#password' && $('[data-sec-panel="password"]')) secOpen('password', true);

  // ---------------- Cày thuê ----------------
  // Danh sách vượt quá N ô -> khung cuộn cao đúng N ô đầu
  const scrollLists = $$('[data-scroll-max]');
  function sizeScroll() {
    scrollLists.forEach((l) => {
      const n = +l.dataset.scrollMax || 0, items = l.children;
      l.classList.remove('bx-scroll'); l.style.maxHeight = '';
      if (!n || items.length <= n) return;
      const top = items[0].offsetTop, cut = items[n];
      const h = cut.offsetTop - top;
      if (h <= 0) return; // hàng cuối của N ô nằm cùng hàng với ô N+1 (không xảy ra khi N chia hết số cột)
      l.style.maxHeight = (h - 4) + 'px';
      l.classList.add('bx-scroll');
    });
  }
  if (scrollLists.length) {
    sizeScroll();
    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(sizeScroll, 150); });
    window.addEventListener('load', sizeScroll);
  }
  // Mô tả dài: bấm để xem hết
  $$('[data-expand]').forEach((d) => {
    if (d.scrollHeight > d.clientHeight + 2) { d.classList.add('can-expand'); d.addEventListener('click', () => { d.classList.toggle('open'); sizeScroll(); }); }
  });

  const bPage = $('[data-boost-page]');
  if (bPage) {
    const gameId = bPage.dataset.game, catId = bPage.dataset.cat || '';
    const form = $('#bForm'), fab = $('.bp-fab'), box = $('#boostCartBox');
    let subtotal = +($('.ck-cart')?.dataset.subtotal || 0), count = +($('.ck-cart')?.dataset.count || 0);
    let discount = 0, couponOk = '';
    const balance = form ? +form.dataset.balance : 0;
    const post = async (url, body) => {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, Accept: 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname); throw new Error('login'); }
      return r.json();
    };
    const renderTotals = () => {
      if (!form) return;
      const total = Math.max(0, subtotal - discount);
      $('[data-b-sub]', form).textContent = money(subtotal);
      $('.bp-disc', form).hidden = !discount;
      $('[data-b-disc]', form).textContent = '-' + money(discount);
      $('[data-b-total]', form).textContent = money(total);
      $('[data-b-topup]', form).hidden = balance >= total;
    };
    const checkCoupon = async (silent) => {
      const inp = $('#bCoupon'), msg = $('#bCouponMsg');
      if (!inp) return;
      const code = inp.value.trim();
      discount = 0; couponOk = '';
      if (!code) { msg.textContent = ''; renderTotals(); return; }
      if (!subtotal) { renderTotals(); return; }
      try {
        const j = await post('/api/boost/coupon/check', { game: gameId, cat: catId, code });
        if (j.ok) { discount = j.discount; couponOk = code.toUpperCase(); }
        msg.textContent = j.message; msg.className = 'small ' + (j.ok ? 'text-ok' : 'text-err');
      } catch (e) { if (!silent) msg.textContent = 'Lỗi kết nối'; }
      renderTotals();
    };
    const cartIco = $('.ck-cart')?.closest('.bp-cart')?.querySelector('h2 svg')?.outerHTML;
    const markInCart = () => {
      const qty = {};
      $$('[data-cart-row]').forEach((r) => { qty[r.dataset.cartRow] = +$('[data-cart-input]', r).value; });
      $$('[data-pkg]').forEach((el) => {
        let b = $('[data-incart]', el);
        const n = qty[el.dataset.pkg];
        if (!n) { b?.remove(); return; }
        if (!b) {
          b = document.createElement('span'); b.className = 'bx-incart'; b.dataset.incart = '';
          ($('.bx-thumb', el) || $('h3', el)).appendChild(b);
        }
        b.innerHTML = (cartIco || '') + ' ' + n;
      });
    };
    const apply = (j) => {
      if (!j.ok) { toast(j.message, '#dc2626'); return false; }
      $('#bCart').innerHTML = j.html;
      subtotal = j.subtotal; count = j.count;
      $$('[data-cart-count]').forEach((c) => { c.textContent = count; });
      if (form) form.hidden = !count;
      if (fab) fab.hidden = !count;
      markInCart();
      checkCoupon(true);
      return true;
    };
    let busy = false;
    const send = async (pkg, qty, mode) => {
      if (busy) return; busy = true;
      try { return apply(await post('/boost/cart', { package: pkg, qty, mode })); } catch (e) { if (e.message !== 'login') toast('Lỗi kết nối, thử lại', '#dc2626'); } finally { busy = false; }
    };
    bPage.addEventListener('click', async (e) => {
      const add = e.target.closest('[data-boost-add]');
      if (add) {
        add.disabled = true;
        if (await send(add.dataset.boostAdd, 0, 'add')) { toast('Đã thêm vào giỏ'); add.classList.add('added'); setTimeout(() => add.classList.remove('added'), 900); }
        add.disabled = false;
        return;
      }
      const q = e.target.closest('[data-cart-qty]');
      if (q) { const inp = $(`[data-cart-input="${q.dataset.cartQty}"]`); send(q.dataset.cartQty, (+inp.value || 0) + (+q.dataset.delta), 'set'); return; }
      const d = e.target.closest('[data-cart-del]');
      if (d) send(d.dataset.cartDel, 0, 'set');
    });
    bPage.addEventListener('change', (e) => {
      const inp = e.target.closest('[data-cart-input]');
      if (inp) send(inp.dataset.cartInput, Math.max(0, parseInt(inp.value, 10) || 0), 'set');
    });
    $('#bCouponCheck')?.addEventListener('click', () => checkCoupon(false));
    $('#bCoupon')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); checkCoupon(false); } });
    $$('[data-boost-coupon]').forEach((b) => b.addEventListener('click', () => { $('#bCoupon').value = b.dataset.boostCoupon; checkCoupon(false); }));

    // Nút "Xem giỏ" nổi (mobile): ẩn khi giỏ đang nằm trong màn hình
    if (fab && box) {
      fab.addEventListener('click', () => box.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      if ('IntersectionObserver' in window) new IntersectionObserver((en) => { fab.classList.toggle('away', en[0].isIntersecting); }, { rootMargin: '0px 0px -30% 0px' }).observe(box);
    }

    // Điều khoản
    const tm = $('#termsModal');
    if (tm) {
      const close = () => { tm.hidden = true; document.body.classList.remove('no-scroll'); };
      document.addEventListener('click', (e) => {
        if (e.target.closest('[data-open-terms]')) { e.preventDefault(); tm.hidden = false; document.body.classList.add('no-scroll'); }
        if (e.target === tm || e.target.closest('[data-close-terms]')) close();
        if (e.target.closest('[data-accept-terms]')) { const a = form?.elements.agree; if (a) a.checked = true; close(); }
      });
    }

    // Xác nhận thanh toán
    const cf = $('#boostConfirm');
    if (form && cf) {
      let sending = false;
      const okBtn = $('[data-bcf-ok]', cf), topup = $('[data-bcf-topup]', cf), err = $('[data-bcf-err]', cf);
      const close = () => { cf.hidden = true; document.body.classList.remove('no-scroll'); };
      const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      form.addEventListener('submit', async (e) => {
        if (sending) return;
        e.preventDefault();
        const u1 = form.elements.uid, u2 = form.elements.uid2, ue = $('[data-uid-err]', form);
        if (u1 && u2 && u1.value.trim() !== u2.value.trim()) { if (ue) ue.hidden = false; u2.focus(); toast('Hai lần nhập UID không khớp', '#dc2626'); return; }
        if (ue) ue.hidden = true;
        if ($('#bCoupon').value.trim().toUpperCase() !== couponOk) await checkCoupon(true);
        const code = $('#bCoupon').value.trim();
        const total = Math.max(0, subtotal - discount);
        const rows = $$('[data-cart-row]').map((r) => `<div><span>${esc($('.ck-info b', r).textContent)} × ${esc($('[data-cart-input]', r).value)}</span><b>${esc($('.ck-line', r).textContent)}</b></div>`).join('');
        const who = u1 ? `<div><span>UID</span><b>${esc(u1.value.trim())}${form.elements.server?.value.trim() ? ' · ' + esc(form.elements.server.value.trim()) : ''}</b></div>` : '';
        $('[data-bcf-lines]', cf).innerHTML = who + rows
          + (discount ? `<div><span>Mã giảm giá <em>${esc(couponOk)}</em></span><b class="bc-minus">-${money(discount)}</b></div>` : '')
          + `<div class="bc-total"><span>Thanh toán</span><b>${money(total)}</b></div>`;
        const after = balance - total;
        const a = $('[data-bcf-after]', cf);
        a.textContent = money(after); a.classList.toggle('bc-neg', after < 0);
        let msg = code && !couponOk ? `Mã “${code}” không dùng được. Hãy xóa hoặc đổi mã.` : '';
        if (after < 0) msg = (msg ? msg + ' ' : '') + `Số dư chưa đủ, cần nạp thêm ${money(-after)}.`;
        err.hidden = !msg; err.textContent = msg;
        okBtn.hidden = after < 0 || !!(code && !couponOk);
        topup.hidden = after >= 0;
        $('span', okBtn).textContent = 'Xác nhận';
        cf.hidden = false; document.body.classList.add('no-scroll');
      });
      okBtn.addEventListener('click', () => {
        sending = true; okBtn.disabled = true;
        $('span', okBtn).textContent = 'Đang xử lý...';
        form.requestSubmit ? form.requestSubmit() : form.submit();
      });
      cf.addEventListener('click', (e) => { if (e.target === cf || e.target.closest('[data-bcf-close]')) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !cf.hidden) close(); });
    }
  }

  // Chi tiết đơn cày thuê: tự cập nhật khi shop đổi trạng thái
  const bo = $('[data-boost-order]');
  if (bo && bo.dataset.open === '1') {
    const st = bo.dataset.status, at = bo.dataset.updated;
    let tries = 0;
    const poll = async () => {
      if (document.hidden) { setTimeout(poll, 15000); return; }
      if (++tries > 480) return;
      try {
        const r = await fetch('/user/boost/' + encodeURIComponent(bo.dataset.boostOrder) + '/status', { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (j.ok && (j.status !== st || String(j.updated_at) !== at)) {
          if (!document.querySelector('[data-boost-update] input:focus, [data-boost-update] textarea:focus')) { location.reload(); return; }
        }
      } catch (e) { /* thử lại */ }
      setTimeout(poll, 15000);
    };
    setTimeout(poll, 15000);
  }
})();

/* Chi tiết tài khoản: mỗi mục chỉ hiện 2 hàng đầu, còn lại sau nút "Xem tất cả" */
(() => {
  const grids = Array.from(document.querySelectorAll('[data-acd-grid]'));
  if (!grids.length) return;
  function fold(g) {
    const btn = g.parentElement.querySelector('[data-acd-more]');
    if (!btn || g.dataset.open) return;
    const items = Array.from(g.children);
    items.forEach((x) => x.classList.remove('acd-hide'));
    const tops = [];
    let hid = 0;
    items.forEach((x) => {
      const t = x.offsetTop;
      if (!tops.includes(t)) tops.push(t);
      if (tops.length > 2) { x.classList.add('acd-hide'); hid++; }
    });
    btn.hidden = !hid;
  }
  grids.forEach((g) => {
    fold(g);
    const btn = g.parentElement.querySelector('[data-acd-more]');
    if (btn) btn.addEventListener('click', () => { g.dataset.open = '1'; g.querySelectorAll('.acd-hide').forEach((x) => x.classList.remove('acd-hide')); btn.hidden = true; });
  });
  let t = 0;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => grids.forEach(fold), 150); });
})();

/* Mã chống trừ tiền 2 lần: trang được mở lại từ bộ nhớ trình duyệt (nút Back) -> tạo mã mới cho lượt mua mới */
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  document.querySelectorAll('[data-idem]').forEach((i) => {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    i.value = btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  });
});

/* Thẻ Acc VIP: dòng icon nhân vật / vũ khí dài hơn khung -> nhân đôi và chạy ngang nối đuôi; ra khỏi màn hình thì dừng cho nhẹ */
(() => {
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => e.target.classList.toggle('off', !e.isIntersecting))) : null;
  function init(el) {
    el.dataset.ri = '1';
    const tr = el.firstElementChild;
    if (!tr || tr.scrollWidth <= el.clientWidth + 1) return;
    const n = tr.children.length;
    Array.from(tr.children).forEach((c) => { const k = c.cloneNode(true); k.setAttribute('aria-hidden', 'true'); tr.appendChild(k); });
    el.style.setProperty('--dur', Math.max(6, n * (parseFloat(el.dataset.speed) || 1.6)) + 's');
    el.classList.add('run');
    if (io) io.observe(el);
  }
  const scan = () => document.querySelectorAll('[data-roll]:not([data-ri])').forEach(init);
  scan();
  let q = 0;
  new MutationObserver(() => { if (!q) q = requestAnimationFrame(() => { q = 0; scan(); }); }).observe(document.body, { childList: true, subtree: true });
})();

// Nền trang dạng video: tải sau khi trang hiện; có ảnh nền thì dùng ảnh khi điện thoại được đặt dùng ảnh / tiết kiệm dữ liệu
(() => {
  const v = document.querySelector('.site-bg-v[data-src]');
  if (!v) return;
  const hasImg = !!document.querySelector('.site-bg-img');
  const mob = matchMedia('(max-width: 720px), (pointer: coarse)').matches;
  if (hasImg && ((mob && v.dataset.mobImg === '1') || navigator.connection?.saveData)) { v.remove(); return; }
  v.muted = true; v.defaultMuted = true; v.playsInline = true; v.autoplay = true;
  v.src = v.dataset.src; v.preload = 'auto';
  const show = () => v.classList.add('on');
  v.addEventListener('playing', show, { once: true });
  v.addEventListener('loadeddata', show, { once: true });
  const play = () => { const p = v.play(); if (p) p.catch(() => {}); };
  play();
  // một số điện thoại chặn tự phát -> phát ở lần chạm đầu tiên
  const kick = () => { if (v.paused) play(); };
  ['touchstart', 'click', 'scroll'].forEach((ev) => addEventListener(ev, kick, { once: true, passive: true }));
  // tab ẩn -> dừng video cho đỡ tốn CPU / pin
  document.addEventListener('visibilitychange', () => { if (document.hidden) v.pause(); else play(); });
})();
