#!/usr/bin/env bash
# Bật chống spam tầng Nginx cho gachaz.online trong 1 lệnh (chạy lại nhiều lần cũng không sao):
#   sudo bash /var/www/gachaz/deploy/apply-nginx-shield.sh
# - Sao lưu file site trước khi sửa, lỗi thì tự khôi phục
# - Thêm: giới hạn 15 yêu cầu/giây/IP (dồn tối đa 40), 40 kết nối/IP, cắt kết nối gửi chậm, webhook nạp tiền không bị giới hạn
set -u
SITE="${1:-/etc/nginx/sites-available/gachaz.online}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ZONE=/etc/nginx/conf.d/gachaz-shield.conf

[ "$(id -u)" = 0 ] || { echo "❌ Cần chạy bằng sudo"; exit 1; }
[ -f "$SITE" ] || { echo "❌ Không tìm thấy $SITE (chạy: sudo bash $0 /đường/dẫn/file-site)"; exit 1; }
# Không có real IP của Cloudflare thì Nginx thấy mọi khách là vài IP Cloudflare -> giới hạn theo IP sẽ chặn nhầm tất cả
if ! grep -rqs "set_real_ip_from" /etc/nginx/; then
  echo "❌ Chưa cấu hình IP thật từ Cloudflare (set_real_ip_from). Chép deploy/cloudflare-realip.conf vào /etc/nginx/conf.d/ trước."
  exit 1
fi

BAK="$SITE.bak-$(date +%Y%m%d-%H%M%S)"
cp "$SITE" "$BAK"
cp "$DIR/nginx-shield.conf" "$ZONE"

if grep -q "gz_req" "$SITE"; then
  echo "ℹ️  File site đã có cấu hình chống spam, chỉ cập nhật vùng đếm."
else
  PROXY="$(grep -m1 -oP 'proxy_pass\s+\Khttp://[^;]+' "$SITE")"
  PROXY="${PROXY:-http://127.0.0.1:3200}"
  PROXY="$PROXY" perl -0pi -e '
    my $p = $ENV{PROXY};
    # 1. Cắt kết nối gửi chậm (sau client_max_body_size, không có thì sau server_name đầu tiên)
    my $t = "client_header_timeout 10s;\n    client_body_timeout 30s;\n    send_timeout 30s;\n";
    unless (s/^([ \t]*)(client_max_body_size[^\n]*\n)/$1$2$1$t/m) { s/^([ \t]*)(server_name[^\n]*\n)/$1$2$1$t/m; }
    # 2. Giới hạn tốc độ trong mọi "location / {"
    s/^([ \t]*)(location \/ \{[^\n]*\n)/$1$2$1    limit_req zone=gz_req burst=40 nodelay;\n$1    limit_conn gz_conn 40;\n/mg;
    # 3. Webhook nạp tiền không giới hạn (đặt trước location / đầu tiên)
    my $w = "location = /api/bank/webhook {\n        proxy_pass $p;\n        proxy_http_version 1.1;\n        proxy_set_header Host \$host;\n        proxy_set_header X-Real-IP \$remote_addr;\n        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto \$scheme;\n    }\n\n";
    s/^([ \t]*)(location \/ \{)/$1$w$1$2/m;
  ' "$SITE"
fi

if nginx -t 2>/tmp/nginx-shield-test.log; then
  systemctl reload nginx
  echo "✅ Đã bật chống spam Nginx. Bản sao lưu: $BAK"
else
  cp "$BAK" "$SITE"
  rm -f "$ZONE"
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  echo "❌ Cấu hình lỗi, đã khôi phục lại như cũ. Chi tiết:"
  cat /tmp/nginx-shield-test.log
  exit 1
fi
