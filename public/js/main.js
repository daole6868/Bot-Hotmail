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
    if (f.dataset.confirm && !confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (f.dataset.submitting) { e.preventDefault(); return; }
    f.dataset.submitting = '1';
    $$('button[type=submit], button:not([type])', f).forEach((b) => { b.disabled = true; });
    setTimeout(() => { delete f.dataset.submitting; $$('button', f).forEach((b) => { b.disabled = false; }); }, 8000);
  });

  // Slider banner
  const slider = $('[data-slider]');
  if (slider) {
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
  }

  // Gallery sản phẩm
  const gal = $('[data-gallery]');
  if (gal) {
    const main = $('.gallery-main', gal);
    $$('.gallery-thumbs img', gal).forEach((t) => t.addEventListener('click', () => {
      main.src = t.src;
      $$('.gallery-thumbs img', gal).forEach((x) => x.classList.toggle('active', x === t));
    }));
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

  // Trang nạp tiền: tự kiểm tra trạng thái mỗi 5 giây
  const dep = $('[data-deposit-code]');
  if (dep) {
    const code = dep.dataset.depositCode;
    let tries = 0;
    const check = async () => {
      if (++tries > 180) return; // tối đa 15 phút
      try {
        const r = await fetch('/user/deposit/' + encodeURIComponent(code) + '/status', { headers: { Accept: 'application/json' } });
        const j = await r.json();
        if (j.ok && j.status === 'success') {
          $('#depositStatus').innerHTML = '';
          $('#depositStatus').textContent = 'Nạp thành công ' + j.received.toLocaleString('vi-VN') + 'đ! Đang tải lại...';
          setTimeout(() => { location.href = '/user/deposit'; }, 1800);
          return;
        }
        if (j.ok && j.status !== 'pending') { $('#depositStatus').textContent = 'Yêu cầu nạp đã ' + (j.status === 'expired' ? 'hết hạn' : 'bị hủy'); return; }
      } catch (e) { /* thử lại */ }
      setTimeout(check, 5000);
    };
    setTimeout(check, 5000);
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
