# Cài đặt trên VPS – gachaz.online

Áp dụng cho Ubuntu 22.04 / 24.04. Chạy các lệnh với quyền root (hoặc thêm `sudo`).

## 1. Trỏ tên miền
Tại nơi quản lý DNS của `gachaz.online`, tạo 2 bản ghi **A** trỏ về IP VPS:
`@ → IP_VPS` và `www → IP_VPS`. Kiểm tra: `ping gachaz.online` ra đúng IP.

## 2. Cài phần mềm
```bash
apt update && apt upgrade -y
apt install -y git nginx build-essential python3 ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
node -v   # >= v22
```

## 3. Tải code
```bash
mkdir -p /var/www && cd /var/www
git clone -b claude/game-account-shop-3xk1lk https://github.com/daole6868/Bot-Hotmail.git gachaz
cd gachaz
npm ci --omit=dev
```
Repo riêng tư → GitHub sẽ hỏi username và **Personal Access Token** (không phải mật khẩu).

## 4. Tạo file cấu hình `.env`
```bash
bash deploy/setup-env.sh
```
Nhập tên đăng nhập, mật khẩu, email admin. Script tự sinh khóa bí mật ngẫu nhiên.
**Sao lưu dòng `APP_KEY` in ra** – mất khóa này là không đọc được thông tin acc đã lưu.

## 5. Chạy web bằng PM2
```bash
pm2 start deploy/ecosystem.config.js
pm2 save
pm2 startup          # chạy lệnh mà nó in ra để tự bật lại khi reboot
pm2 logs gachaz      # xem log, Ctrl+C để thoát
```

## 6. Nginx + HTTPS
```bash
cp deploy/nginx-gachaz.online.conf /etc/nginx/sites-available/gachaz.online
ln -s /etc/nginx/sites-available/gachaz.online /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d gachaz.online -d www.gachaz.online --redirect -m EMAIL_CUA_BAN --agree-tos
```

## 7. Tường lửa
```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```
Không mở port 3000 ra ngoài – chỉ Nginx được gọi vào.

## 8. Vào web
- Web: https://gachaz.online
- Admin: đăng nhập tại https://gachaz.online/login bằng tài khoản admin vừa tạo → tự vào `/admin`.
- Vào *Admin › Cài đặt* để sửa tên shop, logo, thông báo, liên hệ.

## Cập nhật code sau này
```bash
cd /var/www/gachaz
git pull
npm ci --omit=dev
pm2 restart gachaz
```

## Sao lưu
Web tự backup DB mỗi ngày vào `data/backups/` (giữ 7 bản). Nên chép thêm ra ngoài VPS định kỳ, ví dụ:
`scp root@IP_VPS:/var/www/gachaz/data/backups/*.db ./`

## Lỗi thường gặp
| Hiện tượng | Cách xử lý |
|---|---|
| `502 Bad Gateway` | Web chưa chạy: `pm2 logs gachaz` để xem lỗi |
| Server báo `[SECURITY] ... chưa được đổi` | Chạy lại bước 4 (xóa `.env` cũ trước) |
| Đăng nhập xong vẫn bị đá ra | Chưa có HTTPS hoặc thiếu `TRUST_PROXY=true`; làm xong bước 6 |
| Quên mật khẩu admin | `npm run reset-admin -- MatKhauMoi123` |
