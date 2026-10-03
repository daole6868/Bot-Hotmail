# 🎮 ShopAcc – Website bán Acc game

Node.js + Express + SQLite (better-sqlite3) + EJS. Không cần cài MySQL, chạy được trên VPS/hosting Node bất kỳ.

## 1. Cài đặt & chạy

```bash
npm install
cp .env.example .env      # rồi sửa các giá trị trong .env
npm start                 # http://localhost:3000
```

Lần chạy đầu tự tạo: database `data/shop.db`, tài khoản admin (lấy từ `.env`), **danh mục game thật** (Liên Quân, Free Fire, PUBG, Genshin, Roblox, Valorant, FC Online, Play Together + danh mục con) và banner/sidebar. Shop khởi đầu **không có sản phẩm, đơn hàng hay mã KM giả** — admin tự thêm acc, mã KM và điền tài khoản ngân hàng trong *Admin › Cài đặt*.
Muốn có sản phẩm thử nghiệm để test: `SEED_DEMO=true` (không bật khi chạy thật).

### Gắn tên miền
Trỏ DNS tên miền về server, rồi sửa trong `.env`: `BASE_URL=https://ten-mien-cua-ban.com`, `NODE_ENV=production`, `TRUST_PROXY=true` (khi đi qua Nginx/Cloudflare). URL webhook ngân hàng sẽ là `https://ten-mien-cua-ban.com/api/bank/webhook`.

**Đăng nhập admin:** vào `/login` như người dùng thường, dùng `ADMIN_USERNAME` / `ADMIN_PASSWORD`, hệ thống tự chuyển tới `/admin`.
Quên mật khẩu admin: `npm run reset-admin -- MatKhauMoi123`

### Chạy thật (production)
1. `NODE_ENV=production`, đổi `SESSION_SECRET`, `APP_KEY`, `ADMIN_PASSWORD`, `BANK_WEBHOOK_TOKEN` (nếu chưa đổi, server không chịu chạy).
   Tạo chuỗi ngẫu nhiên: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Đặt web sau Nginx/Cloudflare, bật HTTPS, `TRUST_PROXY=true`, `BASE_URL=https://ten-mien.com`.
3. Giữ server luôn chạy bằng PM2: `npm i -g pm2 && pm2 start server.js --name shopacc -i 2` (`-i 2` = chạy 2 bản trên 2 nhân CPU, chịu tải gấp đôi; VPS 1 nhân thì bỏ `-i 2`).
4. **Không bao giờ đổi `APP_KEY`** sau khi đã có dữ liệu (thông tin acc được mã hóa bằng khóa này).

## 2. Bố cục giao diện (3 cấp)

| Cấp | URL | Nội dung |
|---|---|---|
| 1 | `/` | Banner chính (slider), sidebar trái/phải, thông báo chạy chữ, **thẻ các game**, mã KM, acc nổi bật, giao dịch gần đây |
| 2 | `/game/:game` | Các **danh mục con** của game (Acc VIP, Acc Random, Thẻ...), giá thấp nhất, số lượng còn |
| 3 | `/game/:game/:danh-muc` | **Danh sách sản phẩm / thẻ game**, lọc theo giá, tìm kiếm, sắp xếp, phân trang |
| — | `/product/:ma` | Chi tiết, nhiều ảnh, thuộc tính, nhập mã KM (kiểm tra ngay), mua |

Hai loại sản phẩm:
- **Acc** – mỗi acc bán đúng 1 lần.
- **Kho mã** (thẻ game / acc random) – một sản phẩm chứa nhiều mã, mỗi lần mua giao 1 mã; admin dán nhiều dòng một lúc, tự bỏ mã trùng.

## Icon
Toàn bộ icon là SVG vẽ riêng trong `src/utils/icons.js` (dùng trong view: `<%- I('cart') %>`), không dùng emoji hay thư viện icon ngoài. Ảnh game/banner mặc định cũng được vẽ bằng SVG khi khởi tạo; admin có thể thay bằng ảnh thật.

## 3. Trang Admin (`/admin`)
Dashboard (doanh thu/nạp theo ngày, biểu đồ 30 ngày, kho sắp hết) · Game · Danh mục con · Sản phẩm (sửa hàng loạt, nhập nhiều acc) · Đơn hàng (lọc, xuất CSV, hoàn tiền) · Nạp tiền (duyệt/hủy) · Giao dịch ngân hàng (khớp tay khi khách ghi sai nội dung) · Mã giảm giá · Người dùng (cộng/trừ tiền, khóa, đặt lại mật khẩu, xem tài khoản cùng IP) · Banner/Sidebar/Popup · Cài đặt (ngân hàng, thông báo, bảo trì) · Bảo mật (chặn IP) · Nhật ký · Bảo trì dữ liệu (backup, lưu trữ, tối ưu).

## 4. Nạp tiền tự động qua ngân hàng
1. Khách tạo yêu cầu nạp → nhận mã QR VietQR với nội dung chuyển khoản riêng (VD `NAPAB12CD`).
2. Đăng ký webhook trên SePay / Casso (hoặc tự viết) trỏ về:
   `POST https://ten-mien.com/api/bank/webhook`, header `Authorization: Apikey <BANK_WEBHOOK_TOKEN>`
3. Có tiền vào → hệ thống đọc mã trong nội dung, cộng đúng số tiền nhận được; trang nạp của khách tự cập nhật.
   Webhook gửi trùng không bị cộng 2 lần. Giao dịch không khớp nằm ở *Admin › GD ngân hàng* để khớp tay.

Hỗ trợ sẵn định dạng SePay, Casso và dạng chung `{ "txn_id", "amount", "content" }`.

## 5. Bảo mật & chống spam
- Mật khẩu băm bcrypt; thông tin acc/mã thẻ mã hóa AES-256-GCM trong DB.
- CSRF token cho mọi form, cookie HttpOnly/SameSite, tạo phiên mới khi đăng nhập, Helmet CSP.
- Giới hạn tốc độ: toàn trang, đăng nhập, đăng ký, mua, nạp, thử mã KM, webhook.
- Captcha (SVG tự sinh, hoặc **Cloudflare Turnstile** nếu điền `TURNSTILE_*` – khuyên dùng khi chạy thật), ô honeypot bắt bot.
- Sai mật khẩu 5 lần → khóa 15 phút; một IP sai ≥ 30 lần/giờ → tự chặn IP; tối đa 3 tài khoản/IP/ngày.
- Trang admin trả **404** với người không phải admin; phiên admin tự hết hạn sau 60 phút không thao tác; có thể giới hạn IP admin (`ADMIN_IP_WHITELIST`).
- Mua hàng & cộng tiền chạy trong transaction khóa ghi: không bán trùng acc, số dư không bao giờ âm.
- Upload ảnh: kiểm tra chữ ký file, đổi tên ngẫu nhiên, giới hạn 4MB.

## 6. Tự xử lý khi dữ liệu lớn
- SQLite chế độ WAL, index cho mọi truy vấn chính, **mọi danh sách đều phân trang**, cache ngắn cho trang chủ/menu.
- Dashboard đọc từ bảng thống kê gộp theo ngày (`daily_stats`) thay vì quét toàn bộ đơn hàng.
- Tự chạy mỗi 10 phút: cho hết hạn đơn nạp bỏ dở, dọn session/IP block đã hết hạn.
- Tự chạy mỗi ngày: chuyển đơn hàng & nạp tiền cũ sang bảng lưu trữ (khách vẫn xem được lịch sử), xóa log / GD ngân hàng / biến động số dư quá hạn, backup DB (giữ N bản), tối ưu index.
- Thời gian lưu giữ chỉnh trong `.env` (`*_RETENTION_DAYS`, `ARCHIVE_AFTER_DAYS`, `BACKUP_KEEP`). Xuất CSV chạy dạng stream nên xuất được rất nhiều đơn.

## 7. Cấu trúc thư mục
```
server.js                 # khởi động app, middleware bảo mật
src/config.js             # đọc .env
src/db.js                 # schema SQLite, index, view, helpers
src/seed.js               # admin + dữ liệu mẫu
src/session-store.js      # lưu session trong SQLite
src/middleware/security.js# CSRF, rate limit, chặn IP, honeypot, phân quyền
src/services/             # order (mua/hoàn), deposit (nạp/webhook), coupon, maintenance
src/routes/               # public, auth, user, admin, api
src/utils/                # crypto, captcha, upload, helpers
views/                    # EJS: pages, user, admin, partials, errors
public/                   # css, js, img, uploads
scripts/                  # reset-admin, backup
data/                     # database + backups (tự tạo)
```
