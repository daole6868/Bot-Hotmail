(function () {
  'use strict';
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

  // Toggle menu / dropdown
  document.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-toggle]');
    if (tg) {
      e.preventDefault();
      $(tg.dataset.toggle)?.classList.toggle('open');
      return;
    }
    if (!e.target.closest('.dropdown')) $$('.dropdown-menu.open').forEach((m) => m.classList.remove('open'));

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
    if (e.target.closest('[data-close-popup]')) closePopup();
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
          $('#depositStatus').textContent = 'Nạp thành công ' + j.received.toLocaleString('vi-VN') + 'đ! Đang tải lại...';
          setTimeout(() => { location.href = '/user/deposit'; }, 1800);
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

  // Popup trang chủ (hiện 1 lần / 12h)
  const popup = $('#sitePopup');
  function closePopup() {
    if (!popup) return;
    popup.hidden = true;
    try { localStorage.setItem('popup_' + popup.dataset.popupId, Date.now()); } catch (e) { /* ignore */ }
  }
  if (popup) {
    let last = 0;
    try { last = +localStorage.getItem('popup_' + popup.dataset.popupId) || 0; } catch (e) { /* ignore */ }
    if (Date.now() - last > 12 * 3600 * 1000) popup.hidden = false;
    popup.addEventListener('click', (e) => { if (e.target === popup) closePopup(); });
  }
})();
