/* Hiệu ứng dịp lễ trên trang khách (Admin -> Giao diện -> Hiệu ứng). Web chỉ tải file này khi có hiệu ứng đang bật.
   Mỗi hình chi tiết vẽ 1 lần ra canvas phụ rồi dán lại; chuyển tab là dừng; máy bật "giảm chuyển động" thì chỉ hiện trang trí tĩnh. */
(() => {
  const cfgEl = document.getElementById('siteFx'); if (!cfgEl) return;
  let C; try { C = JSON.parse(cfgEl.dataset.fx || '{}'); } catch (e) { return; }
  if (!C.keys || !C.keys.length || (!C.mobile && innerWidth < 640)) return;
  const RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.createElement('div'); root.className = 'fx-layer'; root.setAttribute('aria-hidden', 'true');
  const deco = document.createElement('div'); deco.className = 'fx-deco';
  const cv = document.createElement('canvas'); cv.className = 'fx-cv';
  root.append(deco, cv); document.body.appendChild(root);
  const ctx = cv.getContext('2d');
  const tb = document.querySelector('.topbar'), rb = document.querySelector('.fx-ribbon'), TOPY = tb ? tb.offsetHeight : 64;
  root.style.setProperty('--fx-top', (rb ? rb.offsetTop + rb.offsetHeight : TOPY) + 'px'); // trang trí nằm ngay dưới băng chữ (nếu có)
  const stage = { get clientWidth() { return innerWidth; }, get clientHeight() { return innerHeight; }, classList: { contains: () => false }, style: root.style };
  const R = (a, b) => a + Math.random() * (b - a), pick = (a) => a[(Math.random() * a.length) | 0];

  // ---------- Đếm ngược ----------
  function nextDate(m, d) { const now = new Date(); let t = new Date(now.getFullYear(), m - 1, d); if (t < now) t = new Date(now.getFullYear() + 1, m - 1, d); return t; }
  function fmtLeft(t) { let s = Math.max(0, (t - Date.now()) / 1000 | 0); const d = s / 86400 | 0; s %= 86400; const h = s / 3600 | 0; s %= 3600; const m = s / 60 | 0; s %= 60; return `${d} ngày ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; }

  // ---------- Trang trí tĩnh (SVG nhẹ) ----------
  const lanternSvg = `<svg viewBox="0 0 46 96" aria-hidden="true"><line x1="23" y1="0" x2="23" y2="14" stroke="#e8b04a" stroke-width="2"/><rect x="13" y="12" width="20" height="6" rx="2" fill="#f2c14e"/><ellipse cx="23" cy="40" rx="21" ry="24" fill="#d61f2c"/><ellipse cx="23" cy="40" rx="13" ry="24" fill="none" stroke="#ff6b5b" stroke-width="1.5" opacity=".7"/><ellipse cx="23" cy="40" rx="4" ry="24" fill="none" stroke="#ff6b5b" stroke-width="1.5" opacity=".7"/><text x="23" y="46" text-anchor="middle" font-size="15" font-weight="700" fill="#ffd66b" font-family="serif">福</text><rect x="13" y="62" width="20" height="6" rx="2" fill="#f2c14e"/><g stroke="#f2c14e" stroke-width="1.6"><line x1="18" y1="68" x2="17" y2="92"/><line x1="23" y1="68" x2="23" y2="94"/><line x1="28" y1="68" x2="29" y2="92"/></g></svg>`;
  const webSvg = `<svg viewBox="0 0 150 150" aria-hidden="true" fill="none" stroke="#d9d4ff" stroke-width="1">${[0, 18, 36, 54, 72, 90].map((a) => { const r = a * Math.PI / 180; return `<line x1="0" y1="0" x2="${150 * Math.cos(r)}" y2="${150 * Math.sin(r)}"/>`; }).join('')}${[30, 60, 92, 126].map((r) => `<path d="${[0, 18, 36, 54, 72, 90].map((a, i) => { const t = a * Math.PI / 180; return `${i ? 'Q' + (r * 0.86 * Math.cos(t - 0.157)).toFixed(1) + ' ' + (r * 0.86 * Math.sin(t - 0.157)).toFixed(1) + ' ' : 'M'}${(r * Math.cos(t)).toFixed(1)} ${(r * Math.sin(t)).toFixed(1)}`; }).join(' ')}"/>`).join('')}</svg>`;
  const pumpkinSvg = `<svg viewBox="0 0 60 52" aria-hidden="true"><path d="M30 8c2-6 6-8 9-7-3 2-5 5-6 8z" fill="#3f7d2c"/><ellipse cx="18" cy="31" rx="15" ry="19" fill="#e8730f"/><ellipse cx="42" cy="31" rx="15" ry="19" fill="#e8730f"/><ellipse cx="30" cy="31" rx="13" ry="21" fill="#f58a1f"/><path d="M19 26l6 4-7 2zM41 26l-6 4 7 2z" fill="#2b1203"/><path d="M18 38q12 9 24 0l-4 2-3-2-3 3-3-3-3 3-3-3-3 2z" fill="#2b1203"/></svg>`;
  function garlandSvg(w) { const n = Math.max(8, Math.round(w / 46)); let path = 'M0 4', dots = ''; const cols = ['#ff4d4d', '#ffd23f', '#3ddc84', '#4dabf7', '#ff77d9']; for (let i = 0; i < n; i++) { const x0 = i * w / n, x1 = (i + 1) * w / n; path += ` Q${(x0 + x1) / 2} 22 ${x1} 4`; const cx = ((x0 + x1) / 2).toFixed(1), c = cols[i % cols.length]; dots += `<g class="b" transform="translate(${cx} 13)"><circle cy="9" r="9" fill="${c}" opacity=".28"/><rect x="-2.6" y="-1" width="5.2" height="4" rx="1" fill="#2f4a33"/><path d="M0 3 C-4.5 6 -4.5 12 0 16 C4.5 12 4.5 6 0 3Z" fill="${c}"/><ellipse cx="-1.4" cy="8" rx="1" ry="2.2" fill="#fff" opacity=".6"/></g>`; } return `<svg class="garland" viewBox="0 0 ${w} 36" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="#24442b" stroke-width="2"/>${dots}</svg>`; }
  const hatSvg = `<svg class="snowcap" viewBox="0 0 40 34" aria-hidden="true"><path d="M4 26 Q14 2 34 8 L30 26z" fill="#d61f2c"/><circle cx="35" cy="8" r="4.5" fill="#fff"/><rect x="1" y="24" width="33" height="8" rx="4" fill="#fff"/></svg>`;

  // ---------- Danh sách hiệu ứng ----------
  const FX = {
    tet: { g: 'Lễ Việt Nam', name: 'Tết Nguyên Đán', c: '#e11d2a', load: 2,
      deco: () => `<div class="lantern l">${lanternSvg}</div><div class="lantern r">${lanternSvg}</div><div class="ribbon">Xuân Đinh Mùi · Chúc Mừng Năm Mới<small>Lì xì đầu năm</small></div>`,
      layers: [{ n: 30, make: blossom }], fireworks: 9000 },
    trungthu: { g: 'Lễ Việt Nam', name: 'Tết Trung Thu', c: '#f5b301', load: 1,
      deco: () => `<div class="moon"></div><div class="ribbon" style="--rb:linear-gradient(90deg,transparent,#8a4b00 18%,#b86a00 50%,#8a4b00 82%,transparent)">Trung Thu đoàn viên · Rằm tháng Tám<small>Quà trăng rằm</small></div>`,
      layers: [{ n: 12, make: skylan }, { n: 6, make: lantern }, { n: 14, make: firefly }] },
    halloween: { g: 'Lễ quốc tế & mua sắm', name: 'Halloween', c: '#f97316', load: 1,
      deco: () => `<div class="moon hw"></div><div class="fog"></div><div class="vignette"></div><div class="web">${webSvg}</div><div class="spider"><svg viewBox="0 0 40 34" aria-hidden="true"><g stroke="#151017" stroke-width="1.4" fill="none" stroke-linecap="round"><path d="M17 15 L9 8 L3 12"/><path d="M17 17 L7 15 L1 21"/><path d="M17 19 L8 22 L4 30"/><path d="M18 20 L13 27 L12 33"/><path d="M23 15 L31 8 L37 12"/><path d="M23 17 L33 15 L39 21"/><path d="M23 19 L32 22 L36 30"/><path d="M22 20 L27 27 L28 33"/></g><ellipse cx="20" cy="24" rx="6.5" ry="8" fill="#1a1220"/><path d="M17.5 22 L22.5 22 L20 27 Z" fill="#c92a2a" opacity=".8"/><circle cx="20" cy="14" r="4.2" fill="#120c16"/><circle cx="18.5" cy="13" r=".8" fill="#ff6b4a"/><circle cx="21.5" cy="13" r=".8" fill="#ff6b4a"/></svg></div><div class="pumpkin">${pumpkinSvg}</div><div class="ribbon" style="--rb:linear-gradient(90deg,transparent,#2a0f3d 18%,#4a1766 50%,#2a0f3d 82%,transparent);--rc:#ff9a3c">Happy Halloween · Trick or Treat<small>Ưu đãi ma quái</small></div>`,
      layers: [{ n: 9, make: bat }] },
    noel: { g: 'Lễ quốc tế & mua sắm', name: 'Giáng Sinh', c: '#22c55e', load: 1,
      deco: () => `${garlandSvg(stage.clientWidth)}<div class="ribbon" style="top:74px;--rb:linear-gradient(90deg,transparent,#14532d 18%,#166534 50%,#14532d 82%,transparent);--rc:#fff">Merry Christmas · Giáng Sinh an lành<small>Quà Noel</small></div>`,
      hat: true, layers: [{ n: 70, make: snow }] },
    newyear: { g: 'Lễ quốc tế & mua sắm', name: 'Năm mới dương lịch', c: '#38bdf8', load: 2,
      deco: () => `<div class="ribbon" style="--rb:linear-gradient(90deg,transparent,#0b3a5c 18%,#0e4f7d 50%,#0b3a5c 82%,transparent);--rc:#fff">Happy New Year ${nextDate(1, 1).getFullYear()}</div><div class="countdown"><small>Còn tới năm mới</small><b data-cd="1-1"></b></div>`,
      layers: [], fireworks: 1300 },
    valentine: { g: 'Lễ quốc tế & mua sắm', name: 'Valentine', c: '#ec4899', load: 1,
      deco: () => `<div class="ribbon" style="--rb:linear-gradient(90deg,transparent,#831843 18%,#be185d 50%,#831843 82%,transparent);--rc:#fff">Happy Valentine · Yêu thương ngập tràn</div>`,
      layers: [{ n: 22, make: heart }] },
    quockhanh: { g: 'Lễ Việt Nam', name: 'Quốc khánh 2/9', c: '#dc2626', load: 2,
      deco: () => `<div class="ribbon" style="--rc:#ffe14d">Mừng Quốc khánh 2/9 · Độc lập – Tự do – Hạnh phúc</div>`,
      layers: [{ n: 2, make: flag, fixed: true }, { n: 20, make: vnstar }], fireworks: 6000, fwColors: ['255,59,59', '255,212,59', '255,243,176'] },
    sale: { g: 'Lễ quốc tế & mua sắm', name: 'Sale 11.11 · 12.12', c: '#fb923c', load: 1,
      deco: () => `<div class="marquee"><span>🔥 SIÊU SALE 11.11 · Giảm đến 50% toàn bộ Acc VIP · Nhập mã GACHAZ11 giảm thêm 20.000đ · Số lượng có hạn</span></div><div class="countdown"><small>Sale bắt đầu sau</small><b data-cd="11-11"></b></div>`,
      cls: 'sale', layers: [{ n: 30, make: confetti }] },
    sakura: { g: 'Thường ngày', name: 'Hoa anh đào', c: '#f9a8d4', load: 1,
      layers: [{ n: 30, make: sakura }] },
    snowlite: { g: 'Thường ngày', name: 'Tuyết nhẹ', c: '#e0f2fe', load: 1, layers: [{ n: 60, make: snow }] },
    fireflies: { g: 'Thường ngày', name: 'Đom đóm', c: '#fde047', load: 1, layers: [{ n: 26, make: firefly }] },
    meteor: { g: 'Thường ngày', name: 'Sao băng', c: '#a5b4fc', load: 1, layers: [{ n: 50, make: twinkle }, { n: 2, make: meteor }] },
    gems: { g: 'Thường ngày', name: 'Mưa đá quý gacha', c: '#a855f7', load: 1, layers: [{ n: 24, make: gem }] },
    glow: { g: 'Thường ngày', name: 'Viền thẻ phát sáng', c: '#22d3ee', load: 1, cls: 'glow', layers: [] },
    confettiBuy: { g: 'Tương tác', name: 'Pháo giấy khi mua', c: '#facc15', load: 1, layers: [], burst: true },
    cursor: { g: 'Tương tác', name: 'Vệt sao theo chuột', c: '#c4b5fd', load: 1, layers: [], trail: true },
  };


  // ---------- Hình chi tiết: vẽ 1 lần ra canvas phụ, mỗi khung hình chỉ dán lại nên rất nhẹ ----------
  const SC = 2, SPR = {};
  let DPR = 1, wind = 0;
  function mk(key, w, h, fn) {
    if (SPR[key]) return SPR[key];
    const c = document.createElement('canvas'); c.width = Math.ceil(w * SC); c.height = Math.ceil(h * SC);
    const g = c.getContext('2d'); g.scale(SC, SC); g.translate(w / 2, h / 2); fn(g, Math.min(w, h) / 2);
    return (SPR[key] = c);
  }
  function xf(x, y, rot, fx, fy) { const c = Math.cos(rot), s = Math.sin(rot); ctx.setTransform(DPR * c * fx, DPR * s * fx, -DPR * s * fy, DPR * c * fy, DPR * x, DPR * y); }
  function blit(img, x, y, w, h, rot, fx, fy, a) { xf(x, y, rot, fx, fy); ctx.globalAlpha = a; ctx.drawImage(img, -w / 2, -h / 2, w, h); }
  function reset() { ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
  const rng = (s) => () => (s = (s * 16807) % 2147483647) / 2147483647;
  const add = (fn) => { ctx.globalCompositeOperation = 'lighter'; fn(); ctx.globalCompositeOperation = 'source-over'; };

  const glow = (rgb) => mk('glow' + rgb, 64, 64, (g, r) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, `rgba(${rgb},1)`); gr.addColorStop(.18, `rgba(${rgb},.65)`); gr.addColorStop(.45, `rgba(${rgb},.18)`); gr.addColorStop(1, `rgba(${rgb},0)`); g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r); });
  const bokeh = (soft) => mk('bokeh' + soft, 32, 32, (g, r) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); if (soft) { gr.addColorStop(0, 'rgba(235,245,255,.55)'); gr.addColorStop(.55, 'rgba(235,245,255,.4)'); gr.addColorStop(.8, 'rgba(235,245,255,.12)'); } else { gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.3, 'rgba(255,255,255,.85)'); gr.addColorStop(.6, 'rgba(240,248,255,.25)'); } gr.addColorStop(1, 'rgba(235,245,255,0)'); g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r); });
  const flare = () => mk('flare', 48, 48, (g, r) => { const gl = g.createRadialGradient(0, 0, 0, 0, 0, r * .35); gl.addColorStop(0, 'rgba(255,255,255,1)'); gl.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gl; g.fillRect(-r, -r, 2 * r, 2 * r); for (const [w, h] of [[r, r * .07], [r * .07, r]]) { const lg = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h)); lg.addColorStop(0, 'rgba(255,255,255,.95)'); lg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = lg; g.beginPath(); g.moveTo(-w, 0); g.lineTo(0, -h); g.lineTo(w, 0); g.lineTo(0, h); g.closePath(); g.fill(); } });

  // Bông tuyết: 6 nhánh tinh thể, nhánh con song song nhánh chính (đúng cấu trúc tuyết thật), 4 kiểu x 2 biến thể
  function hexP(g, x, y, r) { g.beginPath(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); }
  const flakeSpr = (v) => mk('flake' + v, 64, 64, (g, r) => {
    const rand = rng(v * 7919 + 17), type = v % 4; r *= .9;
    g.strokeStyle = g.fillStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
    g.shadowColor = 'rgba(160,205,255,1)'; g.shadowBlur = 4;
    const br = [.28 + rand() * .08, .48 + rand() * .08, .68 + rand() * .08], bl = br.map((p) => (1 - p) * (.55 + rand() * .3) * (type === 3 ? 1.3 : 1));
    for (let i = 0; i < 6; i++) {
      g.save(); g.rotate(i * Math.PI / 3);
      g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -r); g.stroke();
      if (type === 1) { g.globalAlpha = .45; hexP(g, 0, -r * .8, r * .15); g.fill(); g.globalAlpha = 1; g.lineWidth = 1; g.stroke(); }
      br.forEach((p, k) => {
        if (type === 2 && k === 0) return;
        const y = -r * p, L = r * bl[k];
        for (const sg of [-1, 1]) {
          g.lineWidth = 1.4; g.beginPath(); g.moveTo(0, y); g.lineTo(sg * L * .866, y - L * .5); g.stroke();
          if (type !== 1 && L > r * .14) {
            g.lineWidth = .9;
            for (const m of [.45, .75]) { const mx = sg * L * .866 * m, my = y - L * .5 * m, l2 = L * (1 - m) * .55; g.beginPath(); g.moveTo(mx, my); g.lineTo(mx, my - l2); g.moveTo(mx, my); g.lineTo(mx + sg * l2 * .866, my + l2 * .5); g.stroke(); }
          }
        }
      });
      if (type !== 1) { g.lineWidth = 1.1; g.beginPath(); g.moveTo(-r * .07, -r * .9); g.lineTo(0, -r * 1.02); g.lineTo(r * .07, -r * .9); g.stroke(); }
      g.restore();
    }
    g.lineWidth = 1.1; g.globalAlpha = .5; hexP(g, 0, 0, r * (type === 2 ? .3 : .15)); g.fill(); g.globalAlpha = 1; g.stroke();
    if (type === 2) { hexP(g, 0, 0, r * .18); g.stroke(); for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * r * .3, Math.sin(a) * r * .3); g.stroke(); } }
  });

  // Cánh hoa anh đào: khía hình chữ V ở đầu cánh, gân mảnh, mặt trước sáng, mặt sau đậm hơn
  function sakPath(g, r) { g.beginPath(); g.moveTo(0, r * .95); g.bezierCurveTo(-r * .6, r * .55, -r * .66, -r * .38, -r * .24, -r * .9); g.quadraticCurveTo(-r * .09, -r * .74, 0, -r * .66); g.quadraticCurveTo(r * .09, -r * .74, r * .24, -r * .9); g.bezierCurveTo(r * .66, -r * .38, r * .6, r * .55, 0, r * .95); g.closePath(); }
  function veins(g, r, col, n) { g.strokeStyle = col; g.lineWidth = .5; for (let k = -n; k <= n; k++) { g.beginPath(); g.moveTo(0, r * .9); g.quadraticCurveTo(k * r * .1, r * .1, k * r * .14, -r * .78); g.stroke(); } }
  function sakPetal(g, r, back) {
    sakPath(g, r); const gr = g.createLinearGradient(0, r, 0, -r);
    gr.addColorStop(0, back ? '#f39ab8' : '#ff9ebd'); gr.addColorStop(.35, back ? '#f7bfd2' : '#ffc6d9'); gr.addColorStop(1, back ? '#fbe3ec' : '#fff1f6');
    g.fillStyle = gr; g.fill(); g.save(); g.clip();
    const h = g.createRadialGradient(-r * .25, -r * .1, 0, -r * .25, -r * .1, r * .8); h.addColorStop(0, 'rgba(255,255,255,.5)'); h.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = h; g.fillRect(-r, -r, 2 * r, 2 * r);
    veins(g, r, 'rgba(214,90,135,.25)', 3);
    g.restore(); g.strokeStyle = 'rgba(220,110,150,.4)'; g.lineWidth = .6; sakPath(g, r); g.stroke();
  }
  function stamens(g, r, n, fil, anth, seed) { const rand = rng(seed); g.lineCap = 'round'; for (let k = 0; k < n; k++) { const a = rand() * 6.28, l = r * (.6 + rand() * .4), ex = Math.cos(a) * l, ey = Math.sin(a) * l; g.strokeStyle = fil; g.lineWidth = .55; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(Math.cos(a + .2) * l * .5, Math.sin(a + .2) * l * .5, ex, ey); g.stroke(); g.fillStyle = anth; g.beginPath(); g.arc(ex, ey, .95, 0, 6.28); g.fill(); } }
  const sakSpr = (back) => mk('sak' + back, 40, 40, (g, r) => sakPetal(g, r * .95, back));
  const sakFlower = () => mk('sakF', 56, 56, (g, r) => {
    for (let k = 0; k < 5; k++) { g.save(); g.rotate(k * 1.2566); g.translate(0, -r * .48); sakPetal(g, r * .5, false); g.restore(); }
    stamens(g, r * .3, 18, 'rgba(230,90,140,.85)', '#ffd86b', 5);
    const c = g.createRadialGradient(0, 0, 0, 0, 0, r * .12); c.addColorStop(0, '#c2255c'); c.addColorStop(1, 'rgba(194,37,92,0)'); g.fillStyle = c; g.beginPath(); g.arc(0, 0, r * .12, 0, 6.28); g.fill();
  });

  // Hoa mai (5 cánh tròn vàng, nhụy cam đỏ) và hoa đào (2 lớp cánh, tâm đậm, nhạt dần ra mép)
  function obo(g, r) { g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-r * .32, -r * .12, -r * .5, -r * .8, 0, -r * .95); g.bezierCurveTo(r * .5, -r * .8, r * .32, -r * .12, 0, 0); g.closePath(); }
  function maiPetal(g, r) {
    obo(g, r); const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, '#ffef8a'); gr.addColorStop(.5, '#ffd43b'); gr.addColorStop(1, '#f5a700'); g.fillStyle = gr; g.fill();
    g.save(); g.clip(); g.strokeStyle = 'rgba(214,120,0,.3)'; g.lineWidth = .5; for (let k = -2; k <= 2; k++) { g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(k * r * .12, -r * .45, k * r * .2, -r * .9); g.stroke(); }
    const h = g.createRadialGradient(-r * .12, -r * .6, 0, -r * .12, -r * .6, r * .4); h.addColorStop(0, 'rgba(255,255,230,.6)'); h.addColorStop(1, 'rgba(255,255,230,0)'); g.fillStyle = h; g.fillRect(-r, -r, 2 * r, r); g.restore();
    g.strokeStyle = 'rgba(200,120,0,.35)'; g.lineWidth = .5; obo(g, r); g.stroke();
  }
  function daoPetal(g, r) { sakPath(g, r); const gr = g.createLinearGradient(0, r, 0, -r); gr.addColorStop(0, '#d6336c'); gr.addColorStop(.4, '#ff8fb1'); gr.addColorStop(1, '#ffe6ee'); g.fillStyle = gr; g.fill(); g.save(); g.clip(); veins(g, r, 'rgba(190,40,90,.22)', 3); g.restore(); g.strokeStyle = 'rgba(200,60,110,.35)'; g.lineWidth = .5; sakPath(g, r); g.stroke(); }
  const maiFlower = () => mk('maiF', 52, 52, (g, r) => { for (let k = 0; k < 5; k++) { g.save(); g.rotate(k * 1.2566 + (k % 2) * .06); maiPetal(g, r * .95); g.restore(); } stamens(g, r * .4, 22, 'rgba(240,140,0,.9)', '#c2410c', 3); g.fillStyle = '#9bbf3a'; g.beginPath(); g.arc(0, 0, r * .07, 0, 6.28); g.fill(); });
  const daoFlower = () => mk('daoF', 52, 52, (g, r) => {
    for (let k = 0; k < 5; k++) { g.save(); g.rotate(k * 1.2566); g.translate(0, -r * .5); daoPetal(g, r * .52); g.restore(); }
    for (let k = 0; k < 5; k++) { g.save(); g.rotate(k * 1.2566 + .63); g.translate(0, -r * .32); daoPetal(g, r * .34); g.restore(); }
    stamens(g, r * .34, 20, 'rgba(255,190,210,.95)', '#f59f00', 9);
    const c = g.createRadialGradient(0, 0, 0, 0, 0, r * .14); c.addColorStop(0, '#a61e4d'); c.addColorStop(1, 'rgba(166,30,77,0)'); g.fillStyle = c; g.beginPath(); g.arc(0, 0, r * .14, 0, 6.28); g.fill();
  });
  const maiP = () => mk('maiP', 24, 24, (g, r) => { g.translate(0, r * .45); maiPetal(g, r * .95); });
  const daoP = () => mk('daoP', 24, 24, (g, r) => daoPetal(g, r * .9));

  // Dơi: 12 khung đập cánh, có xương cánh tay, 4 ngón, màng cánh lượn vào giữa các ngón, tai nhọn, mắt đỏ
  const batFrame = (i) => mk('bat' + i, 120, 80, (g) => {
    const up = Math.sin(i / 12 * 6.2832), wy = -24 * up, span = 1 - Math.abs(up) * .12;
    for (const sg of [-1, 1]) {
      g.save(); g.scale(sg, 1);
      const S = [5, -3], Lg = [6, 14], Wr = [28 * span, -8 + wy * .7];
      const T = [[56 * span, -16 + wy * 1.15], [57 * span, 2 + wy * .95], [47 * span, 15 + wy * .65], [30 * span, 20 + wy * .35]];
      const sc = (a, b) => { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; return [mx + (Wr[0] - mx) * .3, my + (Wr[1] - my) * .3]; };
      const gr = g.createLinearGradient(0, Wr[1] - 12, 0, Wr[1] + 30); gr.addColorStop(0, '#2e1a3c'); gr.addColorStop(1, '#09050d');
      g.fillStyle = gr; g.beginPath(); g.moveTo(S[0], S[1]); g.lineTo(Wr[0], Wr[1]); g.lineTo(T[0][0], T[0][1]);
      for (let k = 1; k < 4; k++) { const c = sc(T[k - 1], T[k]); g.quadraticCurveTo(c[0], c[1], T[k][0], T[k][1]); }
      const c = sc(T[3], Lg); g.quadraticCurveTo(c[0], c[1], Lg[0], Lg[1]); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(92,64,110,.95)'; g.lineCap = 'round'; g.lineWidth = 1.7; g.beginPath(); g.moveTo(S[0], S[1]); g.lineTo(Wr[0], Wr[1]); g.stroke();
      g.lineWidth = .8; g.beginPath(); for (const t of T) { g.moveTo(Wr[0], Wr[1]); g.lineTo(t[0], t[1]); } g.stroke();
      g.fillStyle = '#1a1020'; g.beginPath(); g.moveTo(Wr[0], Wr[1]); g.lineTo(Wr[0] - 1, Wr[1] - 5); g.lineTo(Wr[0] + 2, Wr[1] - 1); g.fill();
      g.restore();
    }
    const b = g.createRadialGradient(-2, -2, 1, 0, 2, 14); b.addColorStop(0, '#3d2a4a'); b.addColorStop(1, '#0a060e');
    g.fillStyle = b; g.beginPath(); g.ellipse(0, 3, 7, 13, 0, 0, 6.28); g.fill();
    g.fillStyle = '#0d0811'; g.beginPath(); g.arc(0, -11, 6, 0, 6.28); g.fill();
    g.beginPath(); g.moveTo(-5.5, -13); g.lineTo(-6.5, -23); g.lineTo(-1.5, -15.5); g.closePath(); g.moveTo(5.5, -13); g.lineTo(6.5, -23); g.lineTo(1.5, -15.5); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,90,60,.9)'; g.beginPath(); g.arc(-2.2, -11.5, .9, 0, 6.28); g.moveTo(3.1, -11.5); g.arc(2.2, -11.5, .9, 0, 6.28); g.fill();
    g.strokeStyle = '#0d0811'; g.lineWidth = 1.2; g.beginPath(); g.moveTo(-3, 15); g.lineTo(-4, 20); g.moveTo(3, 15); g.lineTo(4, 20); g.stroke();
  });

  // Đèn lồng giấy có nan, chóp, tua rua; đèn trời (đèn Khổng Minh) sáng từ đáy
  const LAN = [['255,120,60', '#ff6b3d', '#b8320f'], ['255,180,70', '#ffb03b', '#c46a00'], ['255,80,120', '#ff3d6e', '#a3123d'], ['255,215,90', '#ffd84d', '#c79100']];
  const lanSpr = (i) => mk('lan' + i, 40, 64, (g) => {
    const [, c, d] = LAN[i];
    g.strokeStyle = '#6b2a0a'; g.lineWidth = .8; g.beginPath(); g.moveTo(0, -31); g.lineTo(0, -21); g.stroke();
    const gr = g.createRadialGradient(0, 4, 2, 0, 2, 20); gr.addColorStop(0, '#fff4c2'); gr.addColorStop(.45, c); gr.addColorStop(1, d);
    g.fillStyle = gr; g.beginPath(); g.ellipse(0, 1, 15, 18, 0, 0, 6.28); g.fill();
    g.strokeStyle = 'rgba(90,25,0,.35)'; g.lineWidth = .7; for (let k = 1; k <= 3; k++) { g.beginPath(); g.ellipse(0, 1, 15 * k / 3.6, 18, 0, 0, 6.28); g.stroke(); }
    g.fillStyle = '#7a1f0a'; g.fillRect(-7, -19, 14, 3.5); g.fillRect(-7, 18, 14, 3.5);
    g.fillStyle = '#f2c14e'; g.fillRect(-7, -16.5, 14, 1); g.fillRect(-7, 18, 14, 1);
    g.strokeStyle = '#e8590c'; g.lineWidth = .8; for (let k = -3; k <= 3; k++) { g.beginPath(); g.moveTo(k * .6, 21.5); g.lineTo(k * 1.1, 31); g.stroke(); }
  });
  const skySpr = () => mk('sky', 30, 40, (g) => {
    g.beginPath(); g.moveTo(-11, -13); g.quadraticCurveTo(0, -21, 11, -13); g.lineTo(7.5, 14); g.quadraticCurveTo(0, 16.5, -7.5, 14); g.closePath();
    const gr = g.createLinearGradient(0, 16, 0, -19); gr.addColorStop(0, '#fff3c4'); gr.addColorStop(.45, '#ffb84d'); gr.addColorStop(1, '#d9480f'); g.fillStyle = gr; g.fill();
    g.strokeStyle = 'rgba(140,50,0,.3)'; g.lineWidth = .6; for (const x of [-4, 0, 4]) { g.beginPath(); g.moveTo(x * 1.4, -16); g.lineTo(x, 15); g.stroke(); }
    const f = g.createRadialGradient(0, 15, 0, 0, 15, 5); f.addColorStop(0, '#ffffff'); f.addColorStop(.4, '#ffe066'); f.addColorStop(1, 'rgba(255,160,0,0)'); g.fillStyle = f; g.beginPath(); g.arc(0, 15, 5, 0, 6.28); g.fill();
  });

  // Tim bóng 3D, sao vàng 5 cánh vát cạnh, đá quý giác cắt
  const HEART = [['#ffd0dc', '#ff4d79', '#a8113a'], ['#ffe1ea', '#ff85a8', '#d63a6a'], ['#ffb3b3', '#e11d48', '#7a0a24']];
  function hpath(g, s) { g.beginPath(); g.moveTo(0, s * .9); g.bezierCurveTo(-s * 1.3, 0, -s * .95, -s * 1.05, 0, -s * .42); g.bezierCurveTo(s * .95, -s * 1.05, s * 1.3, 0, 0, s * .9); g.closePath(); }
  const heartSpr = (i) => mk('heart' + i, 48, 48, (g, r) => {
    const [l, m, d] = HEART[i], s = r * .85; hpath(g, s); const gr = g.createRadialGradient(-s * .35, -s * .4, s * .05, 0, 0, s * 1.2); gr.addColorStop(0, l); gr.addColorStop(.45, m); gr.addColorStop(1, d); g.fillStyle = gr; g.fill();
    g.save(); g.clip(); g.strokeStyle = 'rgba(60,0,15,.22)'; g.lineWidth = s * .14; hpath(g, s * 1.04); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.ellipse(-s * .45, -s * .42, s * .2, s * .1, -.75, 0, 6.28); g.fill();
    g.fillStyle = 'rgba(255,255,255,.45)'; g.beginPath(); g.arc(-s * .18, -s * .6, s * .05, 0, 6.28); g.fill(); g.restore();
  });
  const starSpr = () => mk('vnstar', 48, 48, (g, r) => {
    const gl = g.createRadialGradient(0, 0, 0, 0, 0, r); gl.addColorStop(0, 'rgba(255,220,80,.55)'); gl.addColorStop(1, 'rgba(255,220,80,0)'); g.fillStyle = gl; g.fillRect(-r, -r, 2 * r, 2 * r);
    const R = r * .56, ri = R * .4, P = []; for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, q = i % 2 ? ri : R; P.push([Math.cos(a) * q, Math.sin(a) * q]); }
    for (let i = 0; i < 10; i++) { const a = P[i], b = P[(i + 1) % 10]; g.fillStyle = i % 2 ? '#f2a900' : '#ffe14d'; g.strokeStyle = g.fillStyle; g.lineWidth = .3; g.beginPath(); g.moveTo(0, 0); g.lineTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.closePath(); g.fill(); g.stroke(); }
    g.strokeStyle = 'rgba(255,245,180,.7)'; g.lineWidth = .5; g.beginPath(); P.forEach((p, i) => g[i ? 'lineTo' : 'moveTo'](p[0], p[1])); g.closePath(); g.stroke();
  });
  const GEM = [275, 190, 42];
  const gemSpr = (i) => mk('gem' + i, 40, 48, (g) => {
    const h = GEM[i], f = (l, s = 80) => `hsl(${h},${s}%,${l}%)`, G = [[-14, -6], [-7, -6], [0, -6], [7, -6], [14, -6]], T = [[-7, -14], [7, -14]], B = [0, 20];
    const faces = [[[G[0], T[0], G[1]], 64], [[T[0], G[2], G[1]], 50], [[T[0], T[1], G[2]], 82], [[T[1], G[3], G[2]], 58], [[T[1], G[4], G[3]], 42], [[G[0], G[1], B], 38], [[G[1], G[2], B], 60], [[G[2], G[3], B], 48], [[G[3], G[4], B], 30]];
    for (const [pts, l] of faces) { g.fillStyle = f(l); g.beginPath(); pts.forEach((p, k) => g[k ? 'lineTo' : 'moveTo'](p[0], p[1])); g.closePath(); g.fill(); g.strokeStyle = f(Math.min(95, l + 22), 90); g.lineWidth = .4; g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.moveTo(-4, -13); g.lineTo(1, -13); g.lineTo(-2, -8); g.closePath(); g.fill();
  });
  const CONF = [['#ff6b6b', '#c92a2a'], ['#ffd43b', '#e67700'], ['#51cf66', '#2b8a3e'], ['#4dabf7', '#1864ab'], ['#cc5de8', '#862e9c'], ['#ff922b', '#d9480f'], ['#ffffff', '#adb5bd']];

  // ---------- Tạo hạt (z = độ xa gần: xa thì nhỏ, mờ, chậm; gần thì to, rõ, nhanh) ----------
  const Z = (z) => z ?? Math.random();
  function fall(W, H, init, z) { return { x: R(-20, W + 20), y: init ? R(-20, H) : R(-60, -10), rot: R(0, 6.28), ph: R(0, 6.28), ph2: R(0, 6.28), z: Z(z) }; }
  function snow(W, H, init, z0) { const p = fall(W, H, init, z0), z = p.z; p.t = 'snow'; p.k = z < .5 ? 0 : z < .95 ? 1 : 2; p.s = p.k === 0 ? 1 + z * 2.6 : p.k === 1 ? 11 + (z - .5) * 50 : R(28, 46); p.a = p.k === 2 ? .3 : .45 + z * .5; p.v = (Math.random() * 8) | 0; p.vy = .3 + z * 1.3; p.vx = R(-.1, .1); p.sw = .15 + z * .45; p.wk = .3 + z * 1.1; p.vr = R(-.012, .012); return p; }
  function sakura(W, H, init, z0) { const p = fall(W, H, init, z0), z = p.z; p.t = 'sak'; p.fl = Math.random() < .18; p.s = (p.fl ? R(24, 34) : R(14, 22)) * (.6 + z * .55); p.vy = R(.45, .9) * (.6 + z * .6); p.vx = R(.2, .6); p.sw = R(.3, .8); p.wk = .6 + z; p.vr = R(-.025, .025); p.fr = R(.0015, .004); return p; }
  function blossom(W, H, init, z0) { const p = sakura(W, H, init, z0), r = Math.random(); p.t = 'blo'; p.kind = r < .3 ? 0 : r < .5 ? 1 : r < .8 ? 2 : 3; p.s = (p.kind < 2 ? R(24, 36) : R(12, 18)) * (.65 + p.z * .45); p.vx = R(-.2, .3); return p; }
  function lantern(W, H, init) { return { t: 'lan', x: R(20, W - 20), y: init ? R(H * .2, H) : H + R(30, 200), ph: R(0, 6.28), rot: 0, c: (Math.random() * 4) | 0, s: R(16, 24), vy: -R(.35, .6), vx: R(-.1, .1), sw: R(.15, .35), up: true }; }
  function skylan(W, H, init) { const z = Math.random(); return { t: 'sky', x: R(0, W), y: init ? R(0, H) : H + R(20, 300), ph: R(0, 6.28), rot: 0, z, s: 6 + z * 10, vy: -(.2 + z * .45), vx: R(.05, .2), sw: .1, up: true, wk: .3 }; }
  function firefly(W, H) { return { t: 'ff', x: R(0, W), y: R(H * .2, H), ph: R(0, 6.28), a: R(0, 6.28), sp: R(.25, .55), s: R(1.4, 2.6), per: R(1800, 3200), wander: true }; }
  function twinkle(W, H) { return { t: 'tw', x: R(0, W), y: R(0, H), s: R(.5, 1.8), ph: R(0, 6.28), per: R(700, 1600), still: true }; }
  function meteor(W, H, init) { return { t: 'met', x: R(W * .3, W * 1.2), y: R(-H * .2, H * .25), vx: -R(7, 10), vy: R(3, 4.5), len: R(90, 160), wait: init ? R(30, 200) : R(160, 520) }; }
  function bat(W, H, init) { const d = Math.random() < .5 ? 1 : -1, z = Math.random(); return { t: 'bat', x: init ? R(0, W) : (d > 0 ? -60 : W + 60), y: R(70, H * .75), z, s: 34 + z * 46, vx: d * (1 + z * 1.6), ph: R(0, 1), per: R(380, 520) / (.8 + z * .4), sw: R(.3, .9), side: true, rot: 0 }; }
  function heart(W, H, init) { return { t: 'hrt', x: R(0, W), y: init ? R(0, H) : H + R(10, 140), ph: R(0, 6.28), rot: R(-.25, .25), c: (Math.random() * 3) | 0, s: R(12, 26), vy: -R(.45, 1), vx: 0, sw: R(.3, .8), up: true }; }
  function vnstar(W, H, init, z0) { const p = fall(W, H, init, z0); return Object.assign(p, { t: 'star', s: R(9, 18) * (.6 + p.z * .6), vy: R(.35, .8), vx: R(-.15, .15), sw: R(.2, .5), vr: R(-.012, .012), wk: .3 }); }
  function confetti(W, H, init, z0) { const p = fall(W, H, init, z0); return Object.assign(p, { t: 'conf', c: (Math.random() * CONF.length) | 0, rib: Math.random() < .2, s: R(6, 10), vy: R(.8, 1.5), vx: R(-.3, .3), sw: R(.3, .8), vr: R(-.06, .06), fr: R(.006, .014), wk: .8 }); }
  function gem(W, H, init, z0) { const p = fall(W, H, init, z0); return Object.assign(p, { t: 'gem', c: (Math.random() * 3) | 0, rot: R(-.35, .35), s: R(12, 20) * (.6 + p.z * .55), vy: R(.5, 1.1), vx: R(-.15, .15), sw: R(.15, .4), vr: 0, fr: R(.002, .004), wk: .2 }); }

  // ---------- Hình cho các lễ Việt Nam ----------
  function star5(g, x, y, R, ri, col) { g.fillStyle = col; g.beginPath(); for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5 - Math.PI / 2, q = i % 2 ? ri : R; g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); } g.closePath(); g.fill(); }
  // Cờ đỏ sao vàng: cắt thành 24 dải dọc, mỗi dải lệch theo sóng + đổ bóng sáng tối nên cờ phấp phới như vải thật
  const flagSpr = () => mk('flag', 90, 60, (g) => { const gr = g.createLinearGradient(0, -30, 0, 30); gr.addColorStop(0, '#e3302a'); gr.addColorStop(1, '#c81d17'); g.fillStyle = gr; g.fillRect(-45, -30, 90, 60); star5(g, 0, 0, 18, 7.2, '#ffcd00'); });
  function drawFlag(p, t) {
    const img = flagSpr(), N = 24, fw = p.s, fh = p.s * 2 / 3, dw = fw / N, sw = img.width / N;
    reset();
    const pg = ctx.createLinearGradient(p.x - 2, 0, p.x + 2, 0); pg.addColorStop(0, '#8d8d8d'); pg.addColorStop(.5, '#f1f1f1'); pg.addColorStop(1, '#7a7a7a');
    ctx.fillStyle = pg; ctx.fillRect(p.x - 1.6, p.y - 8, 3.2, fh * 2);
    ctx.fillStyle = '#e8b931'; ctx.beginPath(); ctx.arc(p.x, p.y - 9, 3.4, 0, 6.28); ctx.fill();
    for (let i = 0; i < N; i++) {
      const u = i / N, w = t / 260 - u * 5.5 + p.ph, off = Math.sin(w) * fh * .1 * (u + .08), sh = Math.cos(w) * Math.min(1, u * 3);
      const dx = p.dir > 0 ? p.x + 1.5 + i * dw : p.x - 1.5 - (i + 1) * dw, dy = p.y + off;
      ctx.drawImage(img, (p.dir > 0 ? i : N - 1 - i) * sw, 0, sw, img.height, dx, dy, dw + .6, fh);
      ctx.fillStyle = sh > 0 ? `rgba(255,255,255,${sh * .13})` : `rgba(0,0,0,${-sh * .22})`; ctx.fillRect(dx, dy, dw + .6, fh);
    }
  }
  // Chim Lạc (hoa văn trống đồng Đông Sơn): mỏ dài, mào ngả sau, cánh răng cưa, đuôi dài xẻ
  function lacBird(g, up, col, dk) {
    g.fillStyle = col; g.strokeStyle = dk; g.lineWidth = .8; g.lineJoin = 'round';
    const poly = (pts) => { g.beginPath(); pts.forEach((p, k) => g[k ? 'lineTo' : 'moveTo'](p[0], p[1])); g.closePath(); g.fill(); g.stroke(); };
    poly([[-14, 0], [-54, -7], [-46, 0], [-58, 5], [-44, 5], [-14, 4]]);
    g.beginPath(); g.ellipse(0, 1, 18, 5.5, 0, 0, 6.28); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(14, -1); g.quadraticCurveTo(22, -10, 26, -12); g.lineTo(28, -9); g.quadraticCurveTo(22, -4, 17, 3); g.closePath(); g.fill(); g.stroke();
    g.beginPath(); g.arc(27, -11, 3.4, 0, 6.28); g.fill(); g.stroke();
    poly([[29.5, -12.6], [60, -9.2], [29.5, -9.4]]);
    g.beginPath(); g.moveTo(25, -14); g.quadraticCurveTo(14, -25, 2, -23); g.quadraticCurveTo(14, -20, 23, -12); g.fill(); g.stroke();
    const tip = [-8, -2 - 26 * up], base = [-15, -1], sh = [7, -2];
    let dx = base[0] - tip[0], dy = base[1] - tip[1]; const m = Math.hypot(dx, dy) || 1; dx /= m; dy /= m; let px = -dy, py = dx; if (px * (sh[0] - tip[0]) + py * (sh[1] - tip[1]) > 0) { px = -px; py = -py; }
    const pts = [sh, tip]; for (let k = 1; k <= 4; k++) { const qx = tip[0] + (base[0] - tip[0]) * k / 5, qy = tip[1] + (base[1] - tip[1]) * k / 5; pts.push([qx + px * 5, qy + py * 5], [qx, qy]); } pts.push(base); poly(pts);
    g.fillStyle = dk; g.beginPath(); g.arc(27.6, -11.6, .9, 0, 6.28); for (const x of [-8, -2, 4]) { g.moveTo(x + 1.3, 1.5); g.arc(x, 1.5, 1.3, 0, 6.28); } g.fill();
  }
  const lacFrame = (i) => mk('lac' + i, 140, 70, (g) => lacBird(g, Math.sin(i / 8 * 6.2832), '#e7b864', '#8a5a20'));
  // Mặt trống đồng Đông Sơn: sao 14 cánh, lông công, vòng chấm tròn tiếp tuyến, vạch chéo, vòng chim Lạc bay ngược chiều kim đồng hồ
  const drumSpr = () => mk('drum', 300, 300, (g, r) => {
    r *= .98; const bz = g.createRadialGradient(0, 0, r * .1, 0, 0, r); bz.addColorStop(0, '#a57d48'); bz.addColorStop(1, '#5c4122'); g.fillStyle = bz; g.beginPath(); g.arc(0, 0, r, 0, 6.28); g.fill();
    const ln = '#f2cd88'; g.strokeStyle = ln; g.fillStyle = ln; g.lineWidth = 1.1;
    g.beginPath(); for (let i = 0; i < 28; i++) { const a = i * Math.PI / 14, q = i % 2 ? r * .07 : r * .2; g.lineTo(Math.cos(a) * q, Math.sin(a) * q); } g.closePath(); g.fill();
    g.lineWidth = .9; for (let i = 0; i < 14; i++) { g.save(); g.rotate((i + .5) * Math.PI / 14); g.beginPath(); g.moveTo(r * .09, 0); g.quadraticCurveTo(r * .15, -r * .025, r * .19, 0); g.quadraticCurveTo(r * .15, r * .025, r * .09, 0); g.stroke(); g.restore(); }
    for (const rr of [.24, .3, .36, .44, .5, .62, .68, .76, .84, .92, .97]) { g.beginPath(); g.arc(0, 0, r * rr, 0, 6.28); g.stroke(); }
    const dots = (r1, r2, n) => { const m = (r1 + r2) / 2 * r, s = (r2 - r1) * r * .32; for (let k = 0; k < n; k++) { const a = k / n * 6.2832, x = Math.cos(a) * m, y = Math.sin(a) * m; g.beginPath(); g.arc(x, y, s, 0, 6.28); g.stroke(); g.beginPath(); g.arc(x, y, s * .3, 0, 6.28); g.fill(); if (k) { const a0 = (k - 1) / n * 6.2832; g.beginPath(); g.moveTo(Math.cos(a0) * m, Math.sin(a0) * m - 0); g.lineTo(x, y); g.globalAlpha = .5; g.stroke(); g.globalAlpha = 1; } } };
    const hatch = (r1, r2, n) => { g.beginPath(); for (let k = 0; k < n; k++) { const a = k / n * 6.2832; g.moveTo(Math.cos(a) * r * r1, Math.sin(a) * r * r1); g.lineTo(Math.cos(a + .05) * r * r2, Math.sin(a + .05) * r * r2); } g.stroke(); };
    dots(.24, .3, 26); hatch(.3, .36, 64); hatch(.44, .5, 90); dots(.62, .68, 58); hatch(.76, .84, 130); dots(.84, .92, 74); hatch(.92, .97, 160);
    for (let k = 0; k < 8; k++) { g.save(); g.rotate(k / 8 * 6.2832); g.translate(0, -r * .56); g.scale(-.42, .42); lacBird(g, .6, '#f2cd88', '#f2cd88'); g.restore(); }
    for (let k = 0; k < 14; k++) { g.save(); g.rotate(k / 14 * 6.2832 + .2); g.translate(0, -r * .4); g.scale(-.22, .22); lacBird(g, -.4, '#f2cd88', '#f2cd88'); g.restore(); }
  });
  // Hoa hồng: cánh rơi cong mép, bông nguyên nhiều lớp xoáy, có lá
  const ROSE = [['#6a0018', '#c9184a', '#ff5c7a'], ['#a3165a', '#f06292', '#ffc1d6']];
  function rpPath(g, r) { g.beginPath(); g.moveTo(0, r * .9); g.bezierCurveTo(-r * .95, r * .45, -r * .85, -r * .75, -r * .25, -r * .82); g.quadraticCurveTo(0, -r * .7, r * .25, -r * .82); g.bezierCurveTo(r * .85, -r * .75, r * .95, r * .45, 0, r * .9); g.closePath(); }
  const rosePetal = (i) => mk('rp' + i, 36, 36, (g, r) => { const [d, m, l] = ROSE[i]; r *= .95; rpPath(g, r); const gr = g.createRadialGradient(0, r * .8, 0, 0, r * .2, r * 1.1); gr.addColorStop(0, d); gr.addColorStop(.55, m); gr.addColorStop(1, l); g.fillStyle = gr; g.fill(); g.save(); g.clip(); g.strokeStyle = 'rgba(255,220,225,.55)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(-r * .7, -r * .55); g.quadraticCurveTo(0, -r * .9, r * .7, -r * .55); g.stroke(); veins(g, r, 'rgba(90,0,20,.18)', 2); g.restore(); });
  const roseSpr = (i) => mk('rose' + i, 64, 64, (g, r) => {
    const [d, m, l] = ROSE[i];
    for (const a of [-.6, 2.2]) { g.save(); g.rotate(a); g.translate(0, -r * .62); const lg = g.createLinearGradient(-r * .2, 0, r * .2, 0); lg.addColorStop(0, '#2b7a2e'); lg.addColorStop(1, '#4caf50'); g.fillStyle = lg; g.beginPath(); g.moveTo(0, r * .35); g.quadraticCurveTo(-r * .28, 0, 0, -r * .36); g.quadraticCurveTo(r * .28, 0, 0, r * .35); g.fill(); g.strokeStyle = '#1b5e20'; g.lineWidth = .7; g.beginPath(); g.moveTo(0, r * .33); g.lineTo(0, -r * .34); for (const y of [-.15, .02, .18]) { g.moveTo(0, r * y); g.lineTo(-r * .12, r * (y - .08)); g.moveTo(0, r * y); g.lineTo(r * .12, r * (y - .08)); } g.stroke(); g.restore(); }
    const ring = (n, dist, rad, off, dark) => { for (let k = 0; k < n; k++) { const a = k / n * 6.2832 + off, x = Math.cos(a) * dist, y = Math.sin(a) * dist, gr = g.createRadialGradient(x * .2, y * .2, rad * .1, x, y, rad * 1.1); gr.addColorStop(0, d); gr.addColorStop(dark ? .7 : .5, m); gr.addColorStop(1, dark ? m : l); g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 6.28); g.fill(); g.strokeStyle = 'rgba(255,215,225,.5)'; g.lineWidth = .8; g.beginPath(); g.arc(x, y, rad * .96, a - 1.1, a + 1.1); g.stroke(); } };
    ring(5, r * .36, r * .4, 0, false); ring(5, r * .22, r * .3, .63, false); ring(4, r * .11, r * .21, .3, true);
    g.strokeStyle = 'rgba(60,0,15,.55)'; g.lineWidth = .9; g.beginPath(); for (let a = 0; a < 12.5; a += .2) { const q = 1 + a * r * .012; g.lineTo(Math.cos(a) * q, Math.sin(a) * q); } g.stroke();
  });
  // Hoa cúc vàng 3 lớp cánh mảnh
  const cucSpr = () => mk('cuc', 56, 56, (g, r) => {
    for (let ring = 0; ring < 3; ring++) { const n = 24 - ring * 5, L = r * (.95 - ring * .25), w = r * (.09 - ring * .015); for (let k = 0; k < n; k++) { g.save(); g.rotate(k / n * 6.2832 + ring * .3); const gr = g.createLinearGradient(0, 0, 0, -L); gr.addColorStop(0, '#e67700'); gr.addColorStop(.5, ring === 2 ? '#ffb000' : '#ffd43b'); gr.addColorStop(1, ring === 0 ? '#fff3a0' : '#ffe066'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(-w * 1.6, -L * .55, 0, -L); g.quadraticCurveTo(w * 1.6, -L * .55, 0, 0); g.fill(); g.restore(); } }
    const c = g.createRadialGradient(0, 0, 0, 0, 0, r * .2); c.addColorStop(0, '#b35c00'); c.addColorStop(1, 'rgba(230,119,0,0)'); g.fillStyle = c; g.beginPath(); g.arc(0, 0, r * .2, 0, 6.28); g.fill();
  });
  // Bóng bay bóng loáng, có nút thắt
  const BAL = ['255,77,77', '255,212,59', '77,171,247', '81,207,102', '247,131,172', '177,151,252', '255,146,43'];
  const mix = (c, to, a) => c.split(',').map((v) => Math.round(v * (1 - a) + to * a)).join(',');
  const balSpr = (i) => mk('bal' + i, 40, 52, (g) => {
    const c = BAL[i]; g.beginPath(); g.moveTo(0, -24); g.bezierCurveTo(17, -24, 17, 6, 0, 18); g.bezierCurveTo(-17, 6, -17, -24, 0, -24); g.closePath();
    const gr = g.createRadialGradient(-6, -12, 1, 0, -4, 24); gr.addColorStop(0, `rgb(${mix(c, 255, .55)})`); gr.addColorStop(.45, `rgb(${c})`); gr.addColorStop(1, `rgb(${mix(c, 0, .35)})`); g.fillStyle = gr; g.fill();
    g.fillStyle = 'rgba(255,255,255,.75)'; g.beginPath(); g.ellipse(-6, -13, 3, 5.5, -.5, 0, 6.28); g.fill(); g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.arc(-2, -19, 1.3, 0, 6.28); g.fill();
    g.fillStyle = `rgb(${mix(c, 0, .3)})`; g.beginPath(); g.moveTo(0, 17); g.lineTo(-2.8, 21.5); g.lineTo(2.8, 21.5); g.closePath(); g.fill();
  });
  // Đèn hoa đăng hình hoa sen thắp nến
  function lotPetal(g, w, h, a, c1, c2) { g.save(); g.rotate(a); const gr = g.createLinearGradient(0, 0, 0, -h); gr.addColorStop(0, c1); gr.addColorStop(1, c2); g.fillStyle = gr; g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-w, -h * .3, -w * .55, -h * .85, 0, -h); g.bezierCurveTo(w * .55, -h * .85, w, -h * .3, 0, 0); g.fill(); g.strokeStyle = 'rgba(200,60,110,.35)'; g.lineWidth = .5; g.beginPath(); g.moveTo(0, -h * .1); g.lineTo(0, -h * .9); g.stroke(); g.restore(); }
  const lotusSpr = () => mk('lotus', 64, 52, (g) => {
    g.translate(0, 14);
    g.fillStyle = '#2b6e3a'; g.beginPath(); g.ellipse(0, 4, 28, 6, 0, 0, 6.28); g.fill(); g.fillStyle = '#3f8f4f'; g.beginPath(); g.ellipse(0, 2.5, 26, 4.5, 0, 0, 6.28); g.fill();
    for (const a of [-1.2, -.75, -.3, .3, .75, 1.2]) lotPetal(g, 9, 26, a, '#f7b3cc', '#e64980');
    const f = g.createRadialGradient(0, -12, 0, 0, -12, 14); f.addColorStop(0, '#ffffff'); f.addColorStop(.25, '#fff3b0'); f.addColorStop(.6, 'rgba(255,190,80,.6)'); f.addColorStop(1, 'rgba(255,170,60,0)'); g.fillStyle = f; g.beginPath(); g.arc(0, -12, 14, 0, 6.28); g.fill();
    for (const a of [-.95, -.45, 0, .45, .95]) lotPetal(g, 10, 30 - Math.abs(a) * 6, a, '#fff0f5', '#f06595');
  });
  const lotusP = () => mk('lotusP', 20, 30, (g) => { g.translate(0, 13); lotPetal(g, 8, 26, 0, '#fff0f5', '#f06595'); });
  // Cá chép: thân uốn theo sóng (16 đốt), vảy, vây ngực phe phẩy, đuôi xòe trong suốt, đốm màu kiểu Koi
  const KOI = [[['#ff8a3d', '#e8481a'], '#fff6ee', '255,150,80'], [['#fffaf3', '#e9e1d8'], '#e03131', '255,245,240'], [['#ffe08a', '#e9a21f'], '#ff922b', '255,214,120']];
  let scalePat = null;
  function scalePattern() { if (scalePat) return scalePat; const c = document.createElement('canvas'); c.width = 8; c.height = 6; const g = c.getContext('2d'); g.strokeStyle = 'rgba(110,35,0,.9)'; g.lineWidth = .7; g.beginPath(); g.arc(4, 3, 4, 0, Math.PI); g.stroke(); g.beginPath(); g.arc(0, 0, 4, 0, Math.PI); g.stroke(); g.beginPath(); g.arc(8, 0, 4, 0, Math.PI); g.stroke(); return (scalePat = ctx.createPattern(c, 'repeat')); }
  function koiDraw(p, t) {
    const N = 16, L = p.s, pts = [], [cols, patch, fin] = KOI[p.c];
    for (let i = 0; i <= N; i++) { const u = i / N; pts.push([p.x + Math.sin(t / 210 - u * 3.4 + p.ph) * L * .11 * (.15 + u), p.y + u * L]); }
    const wid = (u) => L * .15 * Math.pow(Math.sin(Math.PI * Math.min(.97, .12 + u * .9)), .75) * (1 - u * .5);
    const left = [], right = [];
    for (let i = 0; i <= N; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(N, i + 1)]; let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const m = Math.hypot(nx, ny) || 1; nx /= m; ny /= m; const w = wid(i / N); left.push([pts[i][0] + nx * w, pts[i][1] + ny * w]); right.push([pts[i][0] - nx * w, pts[i][1] - ny * w]); }
    reset(); const tl = pts[N], tw = Math.sin(t / 210 - 3.4 + p.ph);
    ctx.fillStyle = `rgba(${fin},.7)`; ctx.beginPath(); ctx.moveTo(tl[0], tl[1] - L * .04);
    ctx.quadraticCurveTo(tl[0] - L * .22 + tw * L * .06, tl[1] + L * .12, tl[0] - L * .17 + tw * L * .1, tl[1] + L * .32); ctx.quadraticCurveTo(tl[0] + tw * L * .05, tl[1] + L * .16, tl[0] + L * .17 + tw * L * .1, tl[1] + L * .32); ctx.quadraticCurveTo(tl[0] + L * .22 + tw * L * .06, tl[1] + L * .12, tl[0], tl[1] - L * .04); ctx.fill();
    ctx.strokeStyle = `rgba(${fin},.9)`; ctx.lineWidth = .5; ctx.beginPath(); for (const k of [-.12, -.05, .05, .12]) { ctx.moveTo(tl[0], tl[1]); ctx.lineTo(tl[0] + k * L + tw * L * .08, tl[1] + L * .28); } ctx.stroke();
    const fp = pts[Math.round(N * .28)], fl = Math.sin(t / 160 + p.ph) * .35;
    for (const sg of [-1, 1]) { ctx.save(); ctx.translate(fp[0] + sg * wid(.28) * .8, fp[1]); ctx.rotate(sg * (.9 + fl)); ctx.fillStyle = `rgba(${fin},.6)`; ctx.beginPath(); ctx.ellipse(0, L * .07, L * .045, L * .1, 0, 0, 6.28); ctx.fill(); ctx.restore(); }
    ctx.beginPath(); left.forEach((q, i) => ctx[i ? 'lineTo' : 'moveTo'](q[0], q[1])); for (let i = N; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]); ctx.closePath();
    const gr = ctx.createLinearGradient(p.x - L * .16, 0, p.x + L * .16, 0); gr.addColorStop(0, cols[1]); gr.addColorStop(.5, cols[0]); gr.addColorStop(1, cols[1]);
    ctx.fillStyle = gr; ctx.fill(); ctx.save(); ctx.clip();
    ctx.fillStyle = patch; ctx.globalAlpha = .85; for (const [u, dx, r] of p.spots) { const q = pts[Math.round(u * N)]; ctx.beginPath(); ctx.ellipse(q[0] + dx * L * .08, q[1], r * L * .09, r * L * .13, 0, 0, 6.28); ctx.fill(); }
    ctx.globalAlpha = .2; ctx.fillStyle = scalePattern(); ctx.fillRect(p.x - L * .3, p.y + L * .12, L * .6, L);
    ctx.globalAlpha = .35; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(pts[5][0] - L * .03, pts[5][1], L * .022, L * .2, 0, 0, 6.28); ctx.fill();
    ctx.restore(); ctx.globalAlpha = 1;
    ctx.fillStyle = '#111'; for (const sg of [-1, 1]) { ctx.beginPath(); ctx.arc(pts[1][0] + sg * wid(.06) * .55, pts[1][1], L * .016, 0, 6.28); ctx.fill(); }
    ctx.strokeStyle = `rgba(${fin},.8)`; ctx.lineWidth = .7; ctx.beginPath(); for (const sg of [-1, 1]) { ctx.moveTo(pts[0][0] + sg * L * .03, pts[0][1] + L * .015); ctx.quadraticCurveTo(pts[0][0] + sg * L * .08, pts[0][1] - L * .02, pts[0][0] + sg * L * .1, pts[0][1] + L * .06); } ctx.stroke();
  }
  // Máy bay giấy (2 mặt gấp sáng tối) kèm vệt chấm
  function drawPlane(p) {
    reset(); if (p.tr.length > 4) { ctx.setLineDash([2, 6]); ctx.strokeStyle = 'rgba(255,255,255,.3)'; ctx.lineWidth = 1; ctx.beginPath(); for (let i = 0; i < p.tr.length; i += 2) ctx[i ? 'lineTo' : 'moveTo'](p.tr[i], p.tr[i + 1]); ctx.stroke(); ctx.setLineDash([]); }
    const s = p.s; xf(p.x, p.y, Math.atan2(p.vyy || 0, p.vx), 1, p.vx > 0 ? 1 : -1); ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * .8, -s * .55); ctx.lineTo(-s * .45, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#d6dde8'; ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * .45, 0); ctx.lineTo(-s * .8, s * .38); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#9aa8bd'; ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * .45, 0); ctx.lineTo(-s * .62, s * .13); ctx.closePath(); ctx.fill();
  }

  // ---------- Tạo hạt cho các lễ Việt Nam ----------
  let flagN = 0;
  function flag(W) { const l = flagN++ % 2 === 0; return { t: 'flag', still: true, x: l ? 14 : W - 14, y: TOPY + 6, dir: l ? 1 : -1, s: W < 500 ? 54 : 84, ph: l ? 0 : 1.7 }; }
  function drum(W, H) { return { t: 'drum', still: true, x: W - 30, y: H - 10, s: Math.min(W, H) * .85 }; }
  function lac(W, H, init) { const d = Math.random() < .5 ? 1 : -1, z = Math.random(); return { t: 'lac', x: init ? R(0, W) : (d > 0 ? -90 : W + 90), y: R(100, H * .6), z, s: 70 + z * 60, vx: d * (.9 + z * 1.1), ph: R(0, 1), per: R(850, 1100), sw: R(.2, .5), side: true, rot: 0 }; }
  function balloon(W, H, init) { const z = Math.random(); return { t: 'bal', x: R(10, W - 10), y: init ? R(0, H) : H + R(40, 200), z, c: (Math.random() * BAL.length) | 0, s: 30 + z * 26, vy: -(.5 + z * .7), vx: 0, sw: R(.2, .5), ph: R(0, 6.28), up: true, ext: 90 }; }
  function koi(W, H, init) { const s = R(54, 82) * (W < 500 ? .75 : 1); return { t: 'koi', x: R(W * .1, W * .9), y: init ? R(0, H) : H + R(80, 300), s, vy: -R(.55, 1), vx: R(-.12, .12), sw: 0, ph: R(0, 6.28), c: (Math.random() * 3) | 0, spots: Array.from({ length: 3 }, () => [R(.15, .8), R(-1, 1), R(.6, 1.2)]), up: true, ext: s * 1.4 }; }
  function hoadang(W, H, init) { const z = Math.random(), d = Math.random() < .5 ? 1 : -1; return { t: 'hd', z, x: init ? R(0, W) : (d > 0 ? -40 : W + 40), y: H - 80 + z * 48, s: 28 + z * 26, vx: d * (.15 + z * .25), ph: R(0, 6.28), side: true, sw: 0, rot: 0 }; }
  function plane(W, H, init) { const d = Math.random() < .5 ? 1 : -1, by = R(110, H * .75); return { t: 'plane', x: init ? R(0, W) : (d > 0 ? -40 : W + 40), by, y: by, s: R(13, 19), vx: d * R(1.6, 2.6), amp: R(15, 40), per: R(1400, 2400), ph: R(0, 6.28), tr: [], plane: true }; }
  const sprFall = (imgs, a, b, mn) => (W, H, init, z0) => { const p = fall(W, H, init, z0); return Object.assign(p, { t: 'spr', img: pick(imgs), s: R(a, b) * (.65 + p.z * .5), vy: R(.45, .95) * (.7 + p.z * .5), vx: R(-.15, .25), sw: R(.3, .8), vr: R(-.02, .02), fr: R(.0015, .004), wk: .5 + p.z * .6, mn: mn || .15 }); };
  const roseM = sprFall([() => roseSpr(0), () => roseSpr(1)], 38, 54, .6), rosePM = sprFall([() => rosePetal(0), () => rosePetal(1)], 13, 21), cucM = sprFall([cucSpr], 24, 36, .55), lotusPM = sprFall([lotusP], 12, 18);


  const RB = (a, b, c, txt) => `<div class="ribbon" style="--rb:linear-gradient(90deg,transparent,${a} 18%,${b} 50%,${a} 82%,transparent);--rc:${c}">${txt}</div>`;
  Object.assign(FX, {
    ongtao: { g: 'Lễ Việt Nam', name: 'Ông Công Ông Táo', c: '#ff8a3d', load: 1,
      deco: () => `<div class="rays"></div>${RB('#7a2e00', '#a84300', '#ffe08a', 'Tiễn Ông Công Ông Táo về trời · 23 tháng Chạp')}`,
      layers: [{ n: 6, make: koi }] },
    giotto: { g: 'Lễ Việt Nam', name: 'Giỗ Tổ Hùng Vương', c: '#c08a3e', load: 1,
      deco: () => RB('#4a3010', '#7a521d', '#f2cd88', 'Uống nước nhớ nguồn · Giỗ Tổ Hùng Vương mùng 10 tháng 3'),
      layers: [{ n: 1, make: drum, fixed: true }, { n: 5, make: lac }] },
    le304: { g: 'Lễ Việt Nam', name: 'Thống nhất 30/4 · 1/5', c: '#e03131', load: 2,
      deco: () => RB('#b3121f', '#d61f2c', '#ffe14d', 'Mừng ngày Thống nhất đất nước 30/4 · Quốc tế Lao động 1/5'), tank: true,
      layers: [{ n: 2, make: flag, fixed: true }], fireworks: 1300, fwColors: ['255,59,59', '255,212,59', '255,243,176'] },
    thieunhi: { g: 'Lễ Việt Nam', name: 'Quốc tế Thiếu nhi 1/6', c: '#4dabf7', load: 1,
      deco: () => RB('#1864ab', '#1c7ed6', '#fff', 'Chúc mừng Quốc tế Thiếu nhi 1/6'),
      layers: [{ n: 16, make: balloon }, { n: 16, make: confetti }] },
    vulan: { g: 'Lễ Việt Nam', name: 'Vu Lan báo hiếu', c: '#f06595', load: 1,
      deco: () => `<div class="water"></div>${RB('#7d1d48', '#a61e4d', '#fff', 'Vu Lan báo hiếu · Nhớ ơn cha mẹ')}`,
      layers: [{ n: 7, make: hoadang }, { n: 10, make: lotusPM }] },
    phunu: { g: 'Lễ Việt Nam', name: 'Phụ nữ 8/3 · 20/10', c: '#e64980', load: 1,
      deco: () => RB('#8c1d4a', '#c2255c', '#fff', nextDate(10, 20) < nextDate(3, 8) ? 'Chúc mừng ngày Phụ nữ Việt Nam 20/10' : 'Chúc mừng Quốc tế Phụ nữ 8/3'),
      layers: [{ n: 14, make: twinkle }, { n: 8, make: roseM }, { n: 22, make: rosePM }] },
    nhagiao: { g: 'Lễ Việt Nam', name: 'Nhà giáo Việt Nam 20/11', c: '#fab005', load: 1,
      deco: () => RB('#0b5c4a', '#0f7a62', '#ffe066', 'Tri ân thầy cô · Ngày Nhà giáo Việt Nam 20/11'),
      layers: [{ n: 5, make: plane }, { n: 14, make: cucM }] },
  });


  function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  // ---------- 3D gọn nhẹ: khối đa giác, chiếu phối cảnh, đổ bóng theo hướng sáng, vẽ xa trước gần sau ----------
  const rotY = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c]; };
  const rotX = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c]; };
  const rotZ = (p, a) => { const c = Math.cos(a), s = Math.sin(a); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]; };
  const LIGHT = (() => { const l = [-.35, -.85, -.45], m = Math.hypot(...l); return l.map((v) => v / m); })(); // hướng về phía nguồn sáng (trên, trái, trước)
  function shadeCol(c, v) {
    const a = v[0], b = v[1], d = v[2], ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx; const m = Math.hypot(nx, ny, nz) || 1; nx /= m; ny /= m; nz /= m;
    if (nz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    const k = .4 + .66 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    return `rgb(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0})`;
  }
  // cam: { tf(p) -> toạ độ camera, pj(q) -> [sx, sy] }
  function push3(out, cam, verts, c, bias, fixed) { const v = verts.map(cam.tf); let z = 0; for (const q of v) z += q[2]; out.push({ v, p: v.map(cam.pj), z: z / v.length - (bias || 0), c, fixed }); }
  function render3(faces, a) {
    faces.sort((p, q) => q.z - p.z); reset(); ctx.globalAlpha = a; ctx.lineJoin = 'round'; ctx.lineWidth = .7;
    for (const f of faces) {
      if (f.tex) { f.tex(); continue; }
      ctx.fillStyle = ctx.strokeStyle = f.fixed || shadeCol(f.c, f.v); ctx.beginPath(); for (let i = 0; i < f.p.length; i++) ctx[i ? 'lineTo' : 'moveTo'](f.p[i][0], f.p[i][1]); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function box3(F, x0, x1, y0, y1, z0, z1, c) {
    const q = (...v) => F.push({ v, c });
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]); q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]); q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  }
  function extrude3(F, poly, z0, z1, c, cap) { const n = poly.length; for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; F.push({ v: [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], c }); } F.push({ v: poly.map((p) => [p[0], p[1], z0]), c: cap || c }); F.push({ v: poly.map((p) => [p[0], p[1], z1]), c: cap || c }); }
  // Tiện tròn: prof = [[bán kính, vị trí dọc trục]], trục 'y' (đứng) hoặc 'x' (ngang), o = tâm, sx = kéo giãn theo x
  function lathe3(F, prof, n, c, axis, o, sx) {
    const pt = (r, h, a) => axis === 'y' ? [o[0] + Math.cos(a) * r * (sx || 1), o[1] + h, o[2] + Math.sin(a) * r] : [o[0] + h, o[1] + Math.cos(a) * r, o[2] + Math.sin(a) * r];
    for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < n; i++) {
      const a0 = i / n * 6.2832, a1 = (i + 1) / n * 6.2832, [r0, h0] = prof[j], [r1, h1] = prof[j + 1];
      const v = [pt(r0, h0, a0), pt(r0, h0, a1), pt(r1, h1, a1), pt(r1, h1, a0)];
      F.push({ v: r1 === 0 ? v.slice(0, 3) : r0 === 0 ? [v[0], v[2], v[3]] : v, c });
    }
  }
  // Dán ảnh lên tam giác (dùng cho lá cờ vải 3D)
  function texTri(img, s0, s1, s2, d0, d1, d2) {
    const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]); if (!den) return;
    const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den, b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
    const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den, d = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
    const e = d0[0] - a * s0[0] - c * s0[1], f = d0[1] - b * s0[0] - d * s0[1];
    ctx.save(); ctx.beginPath(); const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3, g = (q) => [q[0] + (q[0] - cx) * .04, q[1] + (q[1] - cy) * .04];
    const p0 = g(d0), p1 = g(d1), p2 = g(d2); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.closePath(); ctx.clip();
    ctx.transform(a, b, c, d, e, f); ctx.drawImage(img, 0, 0); ctx.restore();
  }

  // ---------- Cảnh 30/4 bằng 3D: xe tăng T-54 số 390 húc đổ cổng Dinh Độc Lập, tự chạy lại mỗi 10 giây ----------
  const OL = [96, 114, 54], OD = [64, 78, 36], TR = [42, 44, 36];
  const TANK = (() => {
    const F = [], arc = (cx, cy, r, a0, a1, n) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
    const track = [...arc(2.65, -.5, .5, -Math.PI / 2, Math.PI / 2, 5), ...arc(-2.65, -.5, .5, Math.PI / 2, Math.PI * 1.5, 5)];
    for (const sg of [-1, 1]) { extrude3(F, track, sg * 1.15, sg * 1.68, TR); box3(F, -3.25, 3.3, -1.1, -1.0, sg * 1.04, sg * 1.74, OD); }
    extrude3(F, [[-3.1, -1.0], [-3.1, -1.78], [1.9, -1.82], [3.25, -1.06], [3.25, -1.0]], -1.15, 1.15, OL);
    box3(F, -3.05, -1.6, -1.95, -1.78, -1.0, 1.0, OD); // nắp khoang máy
    lathe3(F, [[.27, 0], [.27, .85], [0, .85]], 8, [70, 82, 40], 'x', [-3.0, -1.4, 1.4]); lathe3(F, [[.27, 0], [.27, .85], [0, .85]], 8, [70, 82, 40], 'x', [-2.0, -1.4, 1.4]); // thùng dầu phụ
    lathe3(F, [[1.32, 0], [1.24, -.32], [1.0, -.68], [.6, -.9], [0, -.96]], 14, OL, 'y', [.2, -1.82, 0], 1.12); // tháp pháo đúc hình bát úp
    box3(F, 1.3, 1.7, -2.42, -1.98, -.36, .36, OD);
    lathe3(F, [[.11, 0], [.11, 4.0], [.16, 4.0], [.16, 4.4], [0, 4.4]], 8, [84, 100, 48], 'x', [1.65, -2.2, 0]);
    lathe3(F, [[.34, 0], [.34, -.22], [0, -.28]], 8, OD, 'y', [-.3, -2.66, .45]); lathe3(F, [[.24, 0], [.24, -.14], [0, -.18]], 8, OD, 'y', [-.15, -2.62, -.5]);
    box3(F, 3.0, 3.3, -1.3, -1.12, 1.25, 1.5, [210, 210, 190]); // đèn pha
    return F;
  })();
  const GATE_LEAF = (() => { // nửa cổng trong toạ độ (u: từ bản lề 0..3, y: độ cao 0..-3, w: độ dày); song sắt có bề dày thật
    const L = [], I = [44, 46, 52], G = [214, 170, 48], bx = (u0, u1, y0, y1, w0, w1, c) => box3(L, u0, u1, y0, y1, w0, w1, c);
    bx(0, 3, -.34, -.44, -.06, .06, I); bx(0, 3, -1.55, -1.64, -.05, .05, I); bx(0, 3, -2.6, -2.7, -.05, .05, I); bx(0, .12, 0, -2.85, -.07, .07, I); bx(2.88, 3, 0, -2.85, -.07, .07, I);
    for (let u = .3; u < 2.88; u += .27) { bx(u - .035, u + .035, -.05, -2.82, -.035, .035, I); L.push({ v: [[u - .07, -2.82, 0], [u + .07, -2.82, 0], [u, -3.06, 0]], c: G }); }
    for (let u = .43; u < 2.88; u += .54) L.push({ v: [[u, -1.8, .06], [u + .16, -2.1, .06], [u, -2.4, .06], [u - .16, -2.1, .06]], c: G });
    return L;
  })();
  const PILLARS = (() => { const F = [], st = [214, 207, 190]; for (const sg of [-1, 1]) { box3(F, -.38, .38, -3.6, 0, sg * 3.02, sg * 3.78, st); box3(F, -.48, .48, -3.8, -3.6, sg * 2.92, sg * 3.88, [226, 220, 205]); const c = sg * 3.4, tp = [0, -4.25, c]; for (const [a, b] of [[[-.48, -3.8, c - .48], [.48, -3.8, c - .48]], [[.48, -3.8, c - .48], [.48, -3.8, c + .48]], [[.48, -3.8, c + .48], [-.48, -3.8, c + .48]], [[-.48, -3.8, c + .48], [-.48, -3.8, c - .48]]]) F.push({ v: [a, b, tp], c: [196, 188, 170] }); } return F; })();
  const t390 = () => mk('t390', 64, 26, (g) => { g.fillStyle = '#f1f3f5'; g.font = 'bold 20px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('390', 0, 1); });
  const libFlag = () => mk('libflag', 60, 40, (g) => { g.fillStyle = '#da251d'; g.fillRect(-30, -20, 60, 20); g.fillStyle = '#1c7ed6'; g.fillRect(-30, 0, 60, 20); star5(g, 0, 0, 11, 4.4, '#ffcd00'); });
  const bokehD = () => mk('bokehD', 32, 32, (g, r) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, 'rgba(48,44,42,.8)'); gr.addColorStop(.5, 'rgba(48,44,42,.45)'); gr.addColorStop(1, 'rgba(48,44,42,0)'); g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r); });
  const bokehS = () => mk('bokehS', 32, 32, (g, r) => { const gr = g.createRadialGradient(0, 0, 0, 0, 0, r); gr.addColorStop(0, 'rgba(196,176,146,.7)'); gr.addColorStop(.5, 'rgba(186,166,136,.38)'); gr.addColorStop(1, 'rgba(186,166,136,0)'); g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r); });
  let scene = null;
  function drawTankScene(now) {
    let e = (now - scene.t0) / 1000; if (e < 0) return;
    const ci = Math.floor(e / 10); e -= ci * 10; if (ci !== scene.ci) scene = { t0: scene.t0, ci }; // mỗi 10 giây chạy lại từ đầu
    if (e > 9.6) { stage.style.transform = ''; return; }
    const A = Math.min(1, e / .5, Math.max(0, 9.6 - e)), ph = mobile();
    const punch = e > 3 && e < 3.6 ? 1 + .035 * (1 - (e - 3) / .6) : 1; // máy quay giật nhẹ lúc va chạm
    const ppu = (ph ? Math.max(10, W / 36) : Math.max(15, Math.min(25, W / 46))) * punch, D = 32;
    const cam = { tf: (p) => { let q = [p[0] + 2, p[1] + 1.3, p[2]]; q = rotY(q, .55); q = rotX(q, .22); return [q[0], q[1], q[2] + D]; }, pj: (q) => [W * .5 + q[0] * ppu * D / q[2], H - (ph ? 70 : 100) + q[1] * ppu * D / q[2]] };
    const P = (x, y, z) => cam.pj(cam.tf([x, y, z]));
    // Quãng đường: tăng tốc lao tới, khựng lại khi húc, rồi ủi qua cổng, cán lên cánh cổng đổ và dừng
    const x0 = -26, xc = -3.25, xe = 6.8; let tx;
    if (e < 3) { const u = e / 3; tx = x0 + (xc - x0) * (u * u * .5 + u * .5); }
    else if (e < 3.3) { const u = (e - 3) / .3; tx = xc + .35 * (1 - (1 - u) * (1 - u)); }
    else if (e < 5.9) { const u = (e - 3.3) / 2.6; tx = xc + .35 + (xe - xc - .35) * u * u * (3 - 2 * u); }
    else tx = xe;
    const dist = tx - x0, moving = e < 5.9;
    // Cổng: bị đẩy nghiêng theo mũi xe rồi đổ sập về phía trước, nảy nhẹ khi chạm đất
    const front = tx + 3.25, g0 = Math.max(0, e - 3.02), grav = Math.min(1.5708, g0 * g0 * 3.4), push = Math.min(1.5708, Math.asin(Math.min(1, Math.max(0, front) / 2.6)));
    let tauL = Math.max(grav, push), tauR = Math.max(Math.min(1.5708, Math.max(0, e - 3.12) ** 2 * 3.1), push);
    const landT = 3.02 + Math.sqrt(1.5708 / 3.4); if (e > landT && e < landT + .35) tauL -= Math.abs(Math.sin((e - landT) / .35 * Math.PI)) * .07 * (1 - (e - landT) / .35);
    const flat = Math.min(tauL, tauR) > 1.45;
    // xe chồm lên khi cán qua cánh cổng nằm dưới đất
    const hgt = (x) => flat && x > .1 && x < 3.1 ? .16 * Math.min(1, (x - .1) / .25, (3.1 - x) / .25) : 0, hf = hgt(tx + 2.6), hr = hgt(tx - 2.6);
    let pitch = -Math.atan((hf - hr) / 5.2); const lift = -(hf + hr) / 2;
    if (e > 3 && e < 3.3) pitch += .045 * Math.sin((e - 3) / .3 * Math.PI); // chúi mũi lúc va chạm
    if (e > 3.3 && e < 3.9) pitch -= .025 * Math.sin((e - 3.3) / .6 * Math.PI); // ngóc đầu khi tăng ga lại
    const bob = moving ? Math.sin(dist * 2.4) * .02 : 0;
    const tk = (v) => { const r = rotZ([v[0], v[1], v[2]], pitch); return [r[0] + tx, r[1] + bob + lift, r[2]]; };
    const s30 = ppu / 25;
    if (e >= 3 && !scene.hit) {
      scene.hit = 1;
      for (let i = 0; i < 34; i++) { const q = P(R(-.3, .6), -R(.2, 2.4), R(-2.6, 2.6)); pcs.push({ k: 'sdust', x: q[0], y: q[1], vx: R(-2.2, 2.6), vy: -R(.2, 1.4), g: -.003, drag: .965, s: R(18, 40) * s30, gr: .45, life: 1, decay: R(.007, .012) }); }
      for (let i = 0; i < 70; i++) { const q = P(.05, -R(.6, 1.9), R(-1.6, 1.6)), a = R(-Math.PI * .95, -.05); pcs.push({ k: 'spark', x: q[0], y: q[1], vx: Math.cos(a) * R(1.5, 7), vy: Math.sin(a) * R(1.5, 6.5), life: 1, decay: R(.02, .04), g: .14, drag: .965, w: 1.3, tr: 2.2, rgb: pick(['255,210,130', '255,240,200', '255,170,80']) }); }
      for (let i = 0; i < 22; i++) { const q = P(R(0, .4), -R(.5, 2.6), R(-2.5, 2.5)); pcs.push({ k: 'conf', col: i % 4 ? '#2b2d33' : '#d4a72c', x: q[0], y: q[1], vx: R(-2.5, 6), vy: -R(1.5, 5.5), rot: R(0, 6), vr: R(-.35, .35), fr: R(.01, .03), ph: R(0, 6), s: R(4, 9) * s30, c: 0, life: 1, decay: .01 }); }
      pcs.push({ k: 'flash', ...(() => { const q = P(0, -1.3, 0); return { x: q[0], y: q[1] }; })(), s: 220 * s30, life: .7, decay: .08, rgb: '255,220,160' });
    }
    if (flat && !scene.land) { scene.land = 1; for (let i = 0; i < 24; i++) { const q = P(R(1.8, 3.1), -.05, R(-3, 3)); pcs.push({ k: 'sdust', x: q[0], y: q[1], vx: R(-1.5, 1.5), vy: -R(.3, 1), g: -.003, drag: .96, s: R(14, 28) * s30, gr: .5, life: .9, decay: R(.01, .016) }); } }
    const shake = e >= 3 && e < 3.5 ? 7 * (1 - (e - 3) / .5) : e > landT && e < landT + .22 ? 2.5 : 0;
    stage.style.transform = shake ? `translate(${R(-shake, shake).toFixed(1)}px,${R(-shake * .7, shake * .7).toFixed(1)}px)` : '';
    // mặt đường + vệt bánh xích
    reset(); ctx.globalAlpha = A;
    const road = [P(-44, 0, -2.6), P(22, 0, -2.6), P(22, 0, 2.6), P(-44, 0, 2.6)]; ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.beginPath(); road.forEach((q, i) => ctx[i ? 'lineTo' : 'moveTo'](q[0], q[1])); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(road[0][0], road[0][1]); ctx.lineTo(road[1][0], road[1][1]); ctx.moveTo(road[3][0], road[3][1]); ctx.lineTo(road[2][0], road[2][1]); ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = Math.max(2, 9 * s30); ctx.beginPath(); for (const z of [-1.42, 1.42]) { const a = P(x0, 0, z), b = P(tx - 2.6, 0, z); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); } ctx.stroke();
    const sh = [P(tx - 2.7, 0, -1.2), P(tx + 4.0, 0, -1.2), P(tx + 4.0, 0, 2.3), P(tx - 2.7, 0, 2.3)]; ctx.globalAlpha = .42 * A; ctx.fillStyle = '#000'; ctx.beginPath(); sh.forEach((q, i) => ctx[i ? 'lineTo' : 'moveTo'](q[0], q[1])); ctx.fill();
    const out = [];
    // xe tăng
    for (const f of TANK) push3(out, cam, f.v.map(tk), f.c);
    const nearZ = cam.tf([0, 0, -1])[2] < cam.tf([0, 0, 1])[2] ? -1 : 1, zs = nearZ * 1.69;
    const poly = (cx, cy, r, n, a0) => Array.from({ length: n }, (_, i) => { const a = a0 + i / n * 6.2832; return [cx + Math.cos(a) * r, cy + Math.sin(a) * r]; });
    const ang = dist / .44;
    for (const [wx, wy, wr] of [[-2.3, -.45, .44], [-1.15, -.45, .44], [0, -.45, .44], [1.15, -.45, .44], [2.3, -.45, .44], [-2.72, -.6, .36], [2.74, -.62, .32]]) {
      push3(out, cam, poly(wx, wy, wr, 14, 0).map(([x, y]) => tk([x, y, zs])), [36, 38, 32], .05);
      push3(out, cam, poly(wx, wy, wr * .8, 14, 0).map(([x, y]) => tk([x, y, zs + nearZ * .01])), [78, 92, 46], .06);
      for (let h = 0; h < 5; h++) { const a = ang * (.44 / wr) + h * 1.2566; push3(out, cam, poly(wx + Math.cos(a) * wr * .5, wy + Math.sin(a) * wr * .5, wr * .14, 6, 0).map(([x, y]) => tk([x, y, zs + nearZ * .02])), [30, 34, 24], .07); }
      push3(out, cam, poly(wx, wy, wr * .2, 8, 0).map(([x, y]) => tk([x, y, zs + nearZ * .02])), [120, 132, 80], .07);
    }
    const lk = dist % .3;
    for (let x = -2.6 + lk; x < 2.6; x += .3) push3(out, cam, [[x, -1.0, zs], [x + .12, -1.0, zs], [x + .12, -.9, zs], [x, -.9, zs]].map(tk), [26, 27, 22], .04);
    for (let x = -2.6 + (.3 - lk); x < 2.6; x += .3) push3(out, cam, [[x, -.1, zs], [x + .12, -.1, zs], [x + .12, 0, zs], [x, 0, zs]].map(tk), [26, 27, 22], .04);
    { const zt = nearZ * 1.33, c0 = tk([-.25, -2.0, zt]), q0 = cam.pj(cam.tf(c0)), q1 = cam.pj(cam.tf(tk([.75, -2.0, zt]))), q2 = cam.pj(cam.tf(tk([-.25, -1.6, zt]))), z = cam.tf(c0)[2] - .5, img = t390();
      out.push({ z, tex: () => { reset(); ctx.globalAlpha = A; ctx.setTransform(DPR * (q1[0] - q0[0]) / img.width, DPR * (q1[1] - q0[1]) / img.width, DPR * (q2[0] - q0[0]) / img.height, DPR * (q2[1] - q0[1]) / img.height, DPR * q0[0], DPR * q0[1]); ctx.drawImage(img, 0, 0); } }); }
    // cổng sắt (song có độ dày), cánh mở hé theo lực húc rồi đổ sập
    const op = Math.min(1, Math.max(0, (e - 3) / .3)) * .22;
    const leaf = (side, al, tau) => { const hz = side * 3, d = [Math.sin(al), 0, -side * Math.cos(al)], n = [Math.cos(al), 0, side * Math.sin(al)], ct = Math.cos(tau), st = Math.sin(tau), bias = st > .97 ? -5 : 0;
      for (const f of GATE_LEAF) push3(out, cam, f.v.map(([u, y, w]) => { const yy = y * ct + w * st - .07 * st, ww = w * ct - y * st; return [d[0] * u + n[0] * ww, yy, hz + d[2] * u + n[2] * ww]; }), f.c, bias); };
    leaf(-1, op, tauL); leaf(1, op * .8, tauR);
    for (const f of PILLARS) push3(out, cam, f.v, f.c);
    // cột cờ + lá cờ vải 3D trên tháp pháo
    const pb = tk([-.75, -2.65, 0]), pt = tk([-.95, -5.2, 0]), img = libFlag(), NU = 6, NV = 3, fw = 1.75, fh = 1.1, grid = [], spd = moving ? 1 : .9;
    for (let i = 0; i <= NU; i++) { grid.push([]); for (let j = 0; j <= NV; j++) { const u = i / NU, v = j / NV, wv = Math.sin(now / 140 - u * 4) * .28 * u; grid[i].push([pt[0] - u * fw * spd, pt[1] + v * fh + u * (moving ? .05 : .25), pt[2] + wv]); } }
    { const z = cam.tf(pt)[2] - .2; out.push({ z, tex: () => { const pa = cam.pj(cam.tf(pb)), pq = cam.pj(cam.tf(pt)); reset(); ctx.globalAlpha = A; ctx.strokeStyle = '#2a2f20'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pq[0], pq[1]); ctx.stroke();
      const iw = img.width, ih = img.height, pr = grid.map((r) => r.map((q) => cam.pj(cam.tf(q))));
      for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) { const s = (a, b) => [(NU - a) / NU * iw, b / NV * ih], u0 = s(i, j), u1 = s(i + 1, j), u2 = s(i + 1, j + 1), u3 = s(i, j + 1); reset(); ctx.globalAlpha = A; texTri(img, u0, u1, u2, pr[i][j], pr[i + 1][j], pr[i + 1][j + 1]); texTri(img, u0, u2, u3, pr[i][j], pr[i + 1][j + 1], pr[i][j + 1]);
        const lv = Math.cos(now / 140 - (i + .5) / NU * 4) * (i / NU); ctx.globalAlpha = A * Math.abs(lv) * .25; ctx.fillStyle = lv > 0 ? '#fff' : '#000'; ctx.beginPath(); [pr[i][j], pr[i + 1][j], pr[i + 1][j + 1], pr[i][j + 1]].forEach((q, k) => ctx[k ? 'lineTo' : 'moveTo'](q[0], q[1])); ctx.fill(); }
    } }); }
    render3(out, A);
    // khói: đen đặc lúc tăng ga, xám khi chạy đều; bụi đất bốc lên sau xích
    if (moving && pcs.length < 1100) {
      const hard = (e > 1.9 && e < 2.7) || (e > 3.3 && e < 4.1), ex = P(tx - 3.15, -1.55 + lift, -.6);
      if (Math.random() < (hard ? .9 : .35)) pcs.push({ k: hard ? 'dsmoke' : 'smoke', x: ex[0], y: ex[1], vx: -R(.4, 1.2), vy: -R(.4, 1), g: -.004, drag: .98, s: R(8, 15) * s30 * (hard ? 1.4 : 1), gr: hard ? .4 : .25, life: hard ? 1 : .8, decay: R(.01, .018) });
      if (Math.random() < .5) { const q = P(tx - 2.7, -.08, R(-1.6, 1.6)); pcs.push({ k: 'sdust', x: q[0], y: q[1], vx: -R(.3, 1.2), vy: -R(.1, .5), g: -.002, drag: .97, s: R(8, 16) * s30, gr: .3, life: .7, decay: R(.012, .02) }); }
    }
    // pháo hoa mừng chiến thắng bắn dồn dập sau khi xe vào cổng
    for (const [at, fx] of [[3.9, .22], [4.3, .78], [4.7, .46], [5.1, .12], [5.5, .88], [5.9, .34], [6.3, .64], [6.7, .5], [7.1, .2], [7.5, .8], [7.9, .42]]) if (e >= at && !scene['f' + at]) { scene['f' + at] = 1; explode({ x: W * fx, y: H * R(.14, .34), rgb: pick(['255,59,59', '255,212,59', '255,243,176']), type: pick(['peony', 'two', 'willow', 'ring', 'crackle']), cols: ['255,59,59', '255,212,59', '255,243,176'] }); }
    if (e > 5.4) { const ap = Math.min(1, (e - 5.4) * 1.5) * A, fs = ph ? 12 : 13, txt = ph ? '30/4/1975 · Xe tăng 390 húc đổ cổng Dinh Độc Lập' : 'Trưa 30/4/1975 · Xe tăng 390 húc đổ cổng Dinh Độc Lập', cy = H - 12; reset(); ctx.globalAlpha = ap; ctx.font = `600 ${fs}px "Be Vietnam Pro", system-ui, sans-serif`; const tw = Math.min(W - 16, ctx.measureText(txt).width + 24); ctx.fillStyle = 'rgba(15,13,26,.8)'; rr(ctx, W / 2 - tw / 2, cy - fs - 6, tw, fs + 14, (fs + 14) / 2); ctx.fill(); ctx.fillStyle = '#ffe14d'; ctx.textAlign = 'center'; ctx.fillText(txt, W / 2, cy, W - 28); ctx.textAlign = 'start'; }
    reset();
  }

  // ---------- Vẽ ----------
  function draw(p, t) {
    switch (p.t) {
      case 'snow':
        if (p.k === 0) blit(bokeh(0), p.x, p.y, p.s * 2.4, p.s * 2.4, 0, 1, 1, p.a);
        else if (p.k === 1) blit(flakeSpr(p.v), p.x, p.y, p.s, p.s, p.rot, 1, .72 + .28 * Math.cos(t / 1100 + p.ph2), p.a);
        else blit(bokeh(1), p.x, p.y, p.s, p.s, 0, 1, 1, p.a);
        break;
      case 'sak': { const fx = Math.cos(t * p.fr + p.ph2); if (p.fl) blit(sakFlower(), p.x, p.y, p.s, p.s, p.rot, Math.max(.35, Math.abs(fx)), 1, .95); else blit(sakSpr(fx < 0 ? 1 : 0), p.x, p.y, p.s, p.s, p.rot, Math.max(.1, Math.abs(fx)), .8 + .2 * Math.sin(t * p.fr * 1.3 + p.ph), .95); break; }
      case 'blo': { const fx = Math.cos(t * p.fr + p.ph2), img = [maiFlower, daoFlower, maiP, daoP][p.kind](); blit(img, p.x, p.y, p.s, p.s, p.rot, Math.max(p.kind < 2 ? .45 : .12, Math.abs(fx)), 1, 1); break; }
      case 'lan': { const fl = .75 + .15 * Math.sin(t / 110 + p.ph) + .1 * Math.sin(t / 47 + p.ph * 2); add(() => blit(glow(LAN[p.c][0]), p.x, p.y + 2, p.s * 5, p.s * 5, 0, 1, 1, .42 * fl)); blit(lanSpr(p.c), p.x, p.y, p.s * 1.25, p.s * 2, Math.sin(t / 1300 + p.ph) * .1, 1, 1, 1); break; }
      case 'sky': { const fl = .7 + .2 * Math.sin(t / 130 + p.ph) + .1 * Math.sin(t / 53 + p.ph); add(() => blit(glow('255,170,70'), p.x, p.y + p.s * .3, p.s * 5, p.s * 5, 0, 1, 1, .35 * fl * (.5 + p.z * .5))); blit(skySpr(), p.x, p.y, p.s * 1.5, p.s * 2, Math.sin(t / 1600 + p.ph) * .06, 1, 1, .55 + p.z * .45); break; }
      case 'ff': { const b = Math.max(0, Math.sin(t / p.per * 6.28 + p.ph)), a = b * b; if (a < .02) break; add(() => { blit(glow('190,255,90'), p.x, p.y, p.s * 12, p.s * 12, 0, 1, 1, a * .55); blit(glow('255,255,210'), p.x, p.y, p.s * 3, p.s * 3, 0, 1, 1, a); }); break; }
      case 'tw': { const a = .3 + .7 * Math.abs(Math.sin(t / p.per + p.ph)); blit(bokeh(0), p.x, p.y, p.s * 3, p.s * 3, 0, 1, 1, a); if (p.s > 1.35) add(() => blit(flare(), p.x, p.y, p.s * 9, p.s * 9, 0, 1, 1, a * .7)); break; }
      case 'met': {
        if (p.wait > 0) break;
        const m = Math.hypot(p.vx, p.vy), ux = p.vx / m, uy = p.vy / m, tx = p.x - ux * p.len, ty = p.y - uy * p.len;
        reset(); add(() => { const gr = ctx.createLinearGradient(p.x, p.y, tx, ty); gr.addColorStop(0, 'rgba(255,255,255,.95)'); gr.addColorStop(.25, 'rgba(190,210,255,.55)'); gr.addColorStop(1, 'rgba(150,170,255,0)'); ctx.fillStyle = gr; ctx.beginPath(); ctx.moveTo(p.x - uy * 1.8, p.y + ux * 1.8); ctx.lineTo(tx, ty); ctx.lineTo(p.x + uy * 1.8, p.y - ux * 1.8); ctx.closePath(); ctx.fill(); blit(glow('210,225,255'), p.x, p.y, 22, 22, 0, 1, 1, 1); });
        break;
      }
      case 'bat': { const fi = Math.floor(((t / p.per + p.ph) % 1) * 12), up = Math.sin(fi / 12 * 6.2832); blit(batFrame(fi), p.x, p.y + up * p.s * .06, p.s, p.s * .667, Math.sin(t / 800 + p.ph * 6) * .08, p.vx > 0 ? 1 : -1, 1, .55 + p.z * .45); break; }
      case 'hrt': { const a = Math.min(1, Math.max(0, (p.y + 30) / (H * .55))), pu = 1 + .06 * Math.sin(t / 260 + p.ph); blit(heartSpr(p.c), p.x, p.y, p.s * pu, p.s * pu, p.rot + Math.sin(t / 900 + p.ph) * .18, 1, 1, a); break; }
      case 'star': blit(starSpr(), p.x, p.y, p.s * 2.4, p.s * 2.4, p.rot, 1, 1, .7 + .3 * Math.abs(Math.sin(t / 600 + p.ph))); break;
      case 'conf': {
        const fx = Math.cos(t * p.fr + p.ph2), c = CONF[p.c]; xf(p.x, p.y, p.rot, fx, 1); ctx.globalAlpha = 1;
        if (p.rib) { ctx.strokeStyle = fx > 0 ? c[0] : c[1]; ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-p.s, 0); ctx.bezierCurveTo(-p.s * .5, -p.s * .6, 0, p.s * .6, p.s * .5, 0); ctx.quadraticCurveTo(p.s * .8, -p.s * .35, p.s * 1.1, 0); ctx.stroke(); }
        else { ctx.fillStyle = fx > 0 ? c[0] : c[1]; ctx.fillRect(-p.s / 2, -p.s * .3, p.s, p.s * .6); }
        break;
      }
      case 'flag': drawFlag(p, t); break;
      case 'drum': blit(drumSpr(), p.x, p.y, p.s, p.s, t / 30000, 1, 1, .2); break;
      case 'lac': blit(lacFrame(Math.floor(((t / p.per + p.ph) % 1) * 8)), p.x, p.y, p.s, p.s * .5, 0, p.vx > 0 ? 1 : -1, 1, .8 + p.z * .2); break;
      case 'bal': { const rot = Math.sin(t / 1300 + p.ph) * .12, kx = p.x - Math.sin(rot) * p.s * .52, ky = p.y + Math.cos(rot) * p.s * .52, L = p.s * 1.6; reset(); ctx.strokeStyle = 'rgba(235,235,245,.5)'; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(kx, ky); ctx.quadraticCurveTo(kx + Math.sin(t / 500 + p.ph) * 7, ky + L * .5, kx + Math.sin(t / 380 + p.ph) * 4, ky + L); ctx.stroke(); blit(balSpr(p.c), p.x, p.y, p.s, p.s * 1.3, rot, 1, 1, .85 + p.z * .15); break; }
      case 'koi': koiDraw(p, t); if (Math.random() < .03 && pcs.length < 800) pcs.push({ k: 'bub', x: p.x + R(-3, 3), y: p.y - 4, vx: 0, vy: -R(.4, .9), drag: 1, g: 0, life: 1, decay: R(.005, .009), s: R(1.5, 3.5), ph: R(0, 6) }); break;
      case 'hd': {
        const y = p.y + Math.sin(t / 900 + p.ph) * 2, fl = .75 + .15 * Math.sin(t / 120 + p.ph) + .1 * Math.sin(t / 51 + p.ph * 2);
        add(() => { blit(glow('255,190,90'), p.x, y - p.s * .3, p.s * 3.2, p.s * 3.2, 0, 1, 1, .5 * fl); blit(glow('255,190,90'), p.x, y + p.s * .55, p.s * 2.6, p.s * .5, 0, 1, 1, .45 * fl); });
        blit(lotusSpr(), p.x, y + p.s * .78, p.s, p.s * .81, 0, 1, -1, .22); blit(lotusSpr(), p.x, y, p.s, p.s * .81, Math.sin(t / 1100 + p.ph) * .04, 1, 1, 1);
        if (Math.random() < .04 && pcs.length < 800) pcs.push({ k: 'dust', x: p.x + R(-4, 4), y: y - p.s * .3, vx: R(-.2, .2), vy: -R(.4, .9), drag: .995, g: -.003, life: 1, decay: R(.008, .015), s: R(.6, 1.3), rgb: '255,190,90' });
        break;
      }
      case 'plane': drawPlane(p); break;
      case 'spr': { const fx = Math.cos(t * p.fr + p.ph2); blit(p.img(), p.x, p.y, p.s, p.s, p.rot, Math.max(p.mn, Math.abs(fx)), 1, 1); break; }
      case 'gem': { const fx = Math.cos(t * p.fr + p.ph2); blit(gemSpr(p.c), p.x, p.y, p.s * 1.7, p.s * 2, p.rot + Math.sin(t / 1400 + p.ph) * .15, Math.max(.45, Math.abs(fx)), 1, 1); const s = Math.sin(t / 500 + p.ph); if (s > .9) add(() => blit(flare(), p.x - p.s * .2, p.y - p.s * .35, p.s * 4, p.s * 4, 0, 1, 1, (s - .9) * 10)); break; }
    }
  }

  // ---------- Vòng lặp ----------
  let M = { layers: [] }, dens = 1, layers = [], pcs = [], rockets = [], W = 0, H = 0, raf = 0, lastFw = 0, last = 0;
  const mobile = () => stage.classList.contains('phone') || innerWidth < 640;
  function size() { DPR = Math.min(1.5, devicePixelRatio || 1); W = stage.clientWidth; H = stage.clientHeight; cv.width = W * DPR; cv.height = H * DPR; reset(); }
  function build() {
    const f = M, k = dens * (mobile() ? .5 : 1) * Math.max(.6, Math.min(1.6, W * H / 644000)); flagN = 0;
    layers = (f.layers || []).map((L) => ({ make: L.make, list: Array.from({ length: L.fixed ? L.n : Math.max(1, Math.round(L.n * k)) }, () => L.make(W, H, true)).sort((a, b) => (a.z ?? 0) - (b.z ?? 0)) }));
    pcs = []; rockets = []; lastFw = 0; stage.style.transform = '';
    scene = f.tank && !RM ? { t0: performance.now() + 500 } : null;
  }
  function step(p, L, dt, now) {
    if (p.t === 'met') {
      if (p.wait > 0) { p.wait -= dt; return; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (Math.random() < .5) pcs.push({ k: 'dust', x: p.x, y: p.y, vx: R(-.3, .3), vy: R(-.3, .3), life: 1, decay: R(.03, .06), s: R(.6, 1.4), rgb: '200,215,255' });
      if (p.x < -p.len || p.y > H + p.len) Object.assign(p, L.make(W, H, false));
      return;
    }
    if (p.still) return;
    if (p.plane) { p.x += p.vx * dt; const ny = p.by + Math.sin(now / p.per * 6.28 + p.ph) * p.amp; p.vyy = (ny - p.y) / Math.max(dt, .01); p.y = ny; p.tr.push(p.x, p.y); if (p.tr.length > 44) p.tr.splice(0, 2); if (p.x < -60 || p.x > W + 60) Object.assign(p, L.make(W, H, false)); return; }
    if (p.wander) { p.a += R(-.12, .12) * dt; p.x += Math.cos(p.a) * p.sp * dt; p.y += Math.sin(p.a) * p.sp * dt - .05 * dt; if (p.x < -10) p.x = W + 10; else if (p.x > W + 10) p.x = -10; if (p.y < -10) p.y = H + 10; else if (p.y > H + 10) p.y = -10; return; }
    p.ph += .02 * dt; if (p.vr) p.rot += p.vr * dt;
    if (p.side) { p.x += p.vx * dt; p.y += Math.sin(now / 900 + p.ph * 6) * p.sw * dt; if (p.x < -90 || p.x > W + 90) Object.assign(p, L.make(W, H, false)); return; }
    p.x += (p.vx + Math.sin(p.ph) * p.sw + wind * (p.wk || 0)) * dt; p.y += p.vy * dt;
    if (p.up ? p.y + (p.ext || 0) < -60 : p.y > H + 40) Object.assign(p, L.make(W, H, false, p.z));
    if (p.x > W + 50) p.x = -40; else if (p.x < -50) p.x = W + 40;
  }
  // Pháo hoa: 5 kiểu nổ (cúc tròn, liễu rủ vàng, vòng nhẫn, 2 màu, nổ lách tách), có vệt sáng và chớp sáng lúc nổ
  const FWC = ['255,90,90', '255,212,59', '105,219,124', '77,171,247', '218,119,242', '255,169,77', '255,255,255'];
  function launch() { const cols = M.fwColors || FWC; rockets.push({ x: R(W * .15, W * .85), y: H + 5, vx: R(-.5, .5), vy: -R(7.5, 9.5) * Math.sqrt(H / 560), rgb: pick(cols), type: pick(['peony', 'peony', 'willow', 'ring', 'two', 'crackle']), cols }); }
  function explode(r) {
    const n = mobile() ? 50 : 90, sp = 3.4 * Math.sqrt(H / 560), other = pick(r.cols.filter((c) => c !== r.rgb));
    pcs.push({ k: 'flash', x: r.x, y: r.y, s: 140, life: 1, decay: .09, rgb: r.type === 'willow' ? '255,210,140' : r.rgb });
    for (let i = 0; i < n; i++) {
      let a = R(0, 6.2832), v = sp * R(.82, 1);
      const s = { k: 'spark', x: r.x, y: r.y, life: 1, decay: R(.011, .016), g: .045, drag: .975, w: 1.7, tr: 3, rgb: r.rgb, gl: true };
      if (r.type === 'ring') { a = i / n * 6.2832; v = sp * .9; }
      if (r.type === 'willow') { v = sp * R(.55, .95); Object.assign(s, { rgb: '255,200,120', decay: R(.006, .009), g: .055, drag: .955, w: 1.3, tr: 7 }); }
      if (r.type === 'two' && i % 2) s.rgb = other;
      if (r.type === 'crackle') s.cr = true;
      s.vx = Math.cos(a) * v; s.vy = Math.sin(a) * v * (r.type === 'ring' ? .55 : 1);
      pcs.push(s);
    }
  }
  function burst(x, y, col, n, spd, grav, multi) { // multi = pháo giấy khi mua thành công
    if (!multi) return explode({ x, y, rgb: col, type: 'peony', cols: FWC });
    for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + R(-1, 1); pcs.push({ k: 'conf', x, y, vx: Math.cos(a) * R(2, spd), vy: Math.sin(a) * R(3, spd + 2), rot: R(0, 6.28), vr: R(-.2, .2), fr: R(.01, .02), ph: R(0, 6.28), s: R(5, 9), c: (Math.random() * CONF.length) | 0, life: 1, decay: .006 }); }
  }
  function drawPcs(dt, now) {
    for (let i = pcs.length - 1; i >= 0; i--) {
      const s = pcs[i];
      s.life -= s.decay * dt; if (s.life <= 0 || s.y > H + 30) { pcs.splice(i, 1); continue; }
      if (s.k === 'conf') {
        s.vx = s.vx * .97 + Math.sin(now / 180 + s.ph) * .06; s.vy = s.vy * .97 + .13 * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt;
        const fx = Math.cos(now * s.fr + s.ph), c = CONF[s.c]; xf(s.x, s.y, s.rot, fx, 1); ctx.globalAlpha = Math.min(1, s.life * 3); ctx.fillStyle = s.col || (fx > 0 ? c[0] : c[1]); ctx.fillRect(-s.s / 2, -s.s * .3, s.s, s.s * .6);
        continue;
      }
      const dr = s.drag || .98; s.vx *= dr; s.vy = s.vy * dr + (s.g || 0) * dt; s.x += s.vx * dt; s.y += s.vy * dt;
      if (s.cr && !s.done && s.life < .35) { s.done = 1; for (let j = 0; j < 3; j++) pcs.push({ k: 'dust', x: s.x, y: s.y, vx: R(-1.2, 1.2), vy: R(-1.2, 1.2), life: 1, decay: R(.06, .1), s: R(.6, 1.2), rgb: '255,250,230' }); }
      if (s.k === 'smoke' || s.k === 'dsmoke' || s.k === 'sdust') { s.s += (s.gr || .25) * dt; blit(s.k === 'dsmoke' ? bokehD() : s.k === 'sdust' ? bokehS() : bokeh(1), s.x, s.y, s.s, s.s, 0, 1, 1, Math.min(.7, s.life) * .9); continue; }
      add(() => {
        if (s.k === 'flash') blit(glow(s.rgb), s.x, s.y, s.s, s.s, 0, 1, 1, s.life);
        else if (s.k === 'spark') {
          const a = s.gl && s.life < .5 && Math.random() < .4 ? s.life * .3 : s.life;
          reset(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(${s.rgb},${a})`; ctx.lineWidth = s.w; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(s.x - s.vx * s.tr, s.y - s.vy * s.tr); ctx.lineTo(s.x, s.y); ctx.stroke();
          blit(glow(s.rgb), s.x, s.y, s.w * 6, s.w * 6, 0, 1, 1, a * .9);
        } else if (s.k === 'bub') { const ox = s.x + Math.sin(now / 300 + s.ph) * 2; reset(); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = `rgba(200,230,255,${s.life * .6})`; ctx.lineWidth = .8; ctx.beginPath(); ctx.arc(ox, s.y, s.s, 0, 6.28); ctx.stroke(); ctx.fillStyle = `rgba(255,255,255,${s.life * .7})`; ctx.beginPath(); ctx.arc(ox - s.s * .35, s.y - s.s * .35, s.s * .25, 0, 6.28); ctx.fill();
        } else if (s.k === 'tr') blit(flare(), s.x, s.y, s.s * 7, s.s * 7, s.rot || 0, 1, 1, s.life);
        else blit(glow(s.rgb || '255,240,200'), s.x, s.y, s.s * 5, s.s * 5, 0, 1, 1, s.life);
      });
    }
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(3, last ? (now - last) / 16.67 : 1); last = now;
    wind = .45 * Math.sin(now / 5200) + .25 * Math.sin(now / 2300 + 1.3) + .12 * Math.sin(now / 870 + .4); // gió lúc mạnh lúc nhẹ
    reset(); ctx.clearRect(0, 0, W, H);
    for (const L of layers) for (const p of L.list) { step(p, L, dt, now); draw(p, now); }
    if (scene) drawTankScene(now);
    const f = M;
    if (f.fireworks && now - lastFw > f.fireworks * (mobile() ? 1.4 : 1) / Math.max(.5, dens)) { lastFw = now; launch(); }
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i]; r.vy += .07 * dt; r.x += r.vx * dt; r.y += r.vy * dt;
      if (pcs.length < 1500) pcs.push({ k: 'dust', x: r.x + R(-1, 1), y: r.y + 3, vx: R(-.3, .3), vy: R(.5, 1.5), g: .02, life: 1, decay: R(.04, .07), s: R(.6, 1.3), rgb: '255,200,120' });
      add(() => blit(glow('255,230,180'), r.x, r.y, 14, 14, 0, 1, 1, 1));
      if (r.vy > -1.2) { explode(r); rockets.splice(i, 1); }
    }
    drawPcs(dt, now);
    reset();
  }
  function run() { cancelAnimationFrame(raf); last = 0; reset(); if (!RM && !document.hidden) raf = requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H); }
  document.addEventListener('visibilitychange', run); // chuyển tab là dừng, không tốn CPU
  // ---------- Bật các hiệu ứng admin chọn ----------
  const keys = C.keys.filter((k) => FX[k]);
  dens = +C.dens || 1;
  M = { layers: [], fireworks: 0, fwColors: null };
  const decoFns = [];
  for (const k of keys) {
    const f = FX[k];
    M.layers.push(...(f.layers || []));
    if (f.fireworks) M.fireworks = M.fireworks ? Math.min(M.fireworks, f.fireworks) : f.fireworks;
    if (f.fwColors && !M.fwColors) M.fwColors = f.fwColors;
    for (const x of ['tank', 'burst', 'trail', 'hat']) if (f[x]) M[x] = true;
    if (f.cls) document.body.classList.add('fx-' + f.cls);
    if (f.deco) decoFns.push(f.deco);
  }
  function setDeco() { // băng chữ, dải chạy, đếm ngược đã có sẵn trên trang (server dựng) nên bỏ phần đó của trang trí
    deco.innerHTML = decoFns.map((fn) => fn()).join('');
    deco.querySelectorAll('.ribbon, .marquee, .countdown').forEach((el) => el.remove());
  }
  setDeco();
  const logo = document.querySelector('.topbar .logo');
  if (M.hat && logo) { logo.classList.add('fx-hat'); logo.insertAdjacentHTML('beforeend', hatSvg); }
  const cds = document.querySelectorAll('[data-fx-cd]');
  if (cds.length) { const tick = () => cds.forEach((el) => { el.textContent = fmtLeft(+el.dataset.fxCd); }); tick(); setInterval(tick, 1000); }
  const anim = M.layers.length || M.fireworks || M.tank || M.burst || M.trail;
  if (!anim || RM) { cv.remove(); return; }
  size(); build(); run();
  let lastW = innerWidth;
  addEventListener('resize', () => { size(); if (Math.abs(innerWidth - lastW) > 40) { lastW = innerWidth; build(); setDeco(); } }); // điện thoại cuộn làm đổi chiều cao: chỉ đổi cỡ khung, không dựng lại
  if (M.burst) {
    const ok = C.burst || [...document.querySelectorAll('.main .alert-success')].some((el) => /mua|thanh toán|nạp|đơn/i.test(el.textContent));
    if (ok) setTimeout(() => burst(W / 2, H * .38, '#fff', mobile() ? 60 : 110, 8, .18, true), 350);
  }
  if (M.trail && matchMedia('(pointer: fine)').matches) addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || pcs.length > 400) return;
    for (let i = 0; i < 2; i++) pcs.push({ k: 'tr', x: e.clientX + R(-3, 3), y: e.clientY + R(-3, 3), vx: R(-.6, .6), vy: R(-.2, .8), s: R(1, 2.4), rot: R(0, .8), life: 1, decay: R(.025, .04), g: .02 });
  }, { passive: true });
})();
