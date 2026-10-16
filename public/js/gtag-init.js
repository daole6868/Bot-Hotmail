// Google Analytics 4 / Google Ads: khởi tạo + gửi sự kiện chuyển đổi (đăng ký, nạp tiền, mua hàng)
(function () {
  'use strict';
  var me = document.currentScript; if (!me) return;
  var d = me.dataset;
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());
  if (d.ga4) gtag('config', d.ga4);
  if (d.ads) gtag('config', d.ads);
  var ev = []; try { ev = JSON.parse(d.events || '[]'); } catch (e) { ev = []; }
  ev.forEach(function (x) {
    var money = x.v ? { value: x.v, currency: 'VND' } : {};
    if (x.r) money.transaction_id = x.r;
    if (d.ga4) gtag('event', x.e, money);
    var label = { sign_up: d.lSignup, deposit: d.lDeposit, purchase: d.lPurchase }[x.e];
    if (d.ads && label) gtag('event', 'conversion', Object.assign({ send_to: d.ads + '/' + label }, money));
  });
})();
