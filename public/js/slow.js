// Đếm ngược khi thao tác quá nhanh: server đặt cookie "slow" = thời điểm hết chờ (giây).
// Trong lúc chờ: hiện thông báo nhỏ, chặn bấm / gửi form ở mọi tab. Hết giờ: tải lại (trang báo chờ) hoặc tiếp tục.
(function () {
  'use strict';
  let timer = null, box = null, shield = null;
  const until = () => { const m = document.cookie.match(/(?:^|;\s*)slow=(\d+)/); return m ? +m[1] : 0; };
  const left = () => Math.max(0, Math.ceil(until() - Date.now() / 1000));
  const page = document.body && document.body.dataset.slowPage;

  function block(e) {
    if (!left()) return;
    e.preventDefault(); e.stopPropagation();
    if (box) { box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake'); }
  }
  function stop() {
    clearInterval(timer); timer = null;
    if (page) { if (page === 'GET') location.reload(); else history.back(); return; }
    if (box && !box.classList.contains('slow-static')) box.remove();
    if (shield) shield.remove();
    box = shield = null;
    document.removeEventListener('submit', block, true);
    document.removeEventListener('click', block, true);
  }
  function start() {
    if (timer || !left()) return;
    box = document.querySelector('.slow-toast');
    if (!box) {
      box = document.createElement('div');
      box.className = 'slow-toast';
      box.setAttribute('role', 'status');
      box.innerHTML = '<span>Bạn đang thao tác quá nhanh, vui lòng chậm lại sau <b data-slow-left></b> giây</span>';
      document.body.appendChild(box);
    }
    shield = document.createElement('div');
    shield.className = 'slow-shield';
    document.body.appendChild(shield);
    document.addEventListener('submit', block, true);
    document.addEventListener('click', block, true);
    const tick = () => { const n = left(); if (!n) return stop(); box.querySelector('[data-slow-left]').textContent = n; };
    tick();
    timer = setInterval(tick, 250);
  }
  // fetch / XHR bị trả 429 -> cookie vừa được đặt -> bắt đầu đếm
  if (window.fetch) {
    const f = window.fetch;
    window.fetch = function () { return f.apply(this, arguments).then((r) => { if (r.status === 429) setTimeout(start, 0); return r; }); };
  }
  window.slowCheck = start;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('focus', start);
})();
