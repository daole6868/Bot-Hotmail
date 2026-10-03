#!/usr/bin/env bash
# Bật chống spam / quá tải tầng Nginx cho gachaz.online trong 1 lệnh (chạy lại nhiều lần cũng không sao):
#   sudo bash /var/www/gachaz/deploy/apply-nginx-shield.sh
# - Sao lưu file site trước khi sửa, lỗi thì tự khôi phục
# - Giới hạn 15 yêu cầu/giây/IP (dồn tối đa 40), 40 kết nối/IP, cắt kết nối gửi chậm, webhook nạp tiền không bị giới hạn
# - Microcache 2 giây cho trang khách chưa đăng nhập, tối đa 400 yêu cầu khách cùng lúc, trang "đang đông" nhẹ
set -u
SITE="${1:-/etc/nginx/sites-available/gachaz.online}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ZONE=/etc/nginx/conf.d/gachaz-shield.conf
CACHE=/var/cache/nginx/gachaz
WEBROOT="$(cd "$DIR/.." && pwd)/public"

[ "$(id -u)" = 0 ] || { echo "❌ Cần chạy bằng sudo"; exit 1; }
[ -f "$SITE" ] || { echo "❌ Không tìm thấy $SITE (chạy: sudo bash $0 /đường/dẫn/file-site)"; exit 1; }
# Không có real IP của Cloudflare thì Nginx thấy mọi khách là vài IP Cloudflare -> giới hạn theo IP sẽ chặn nhầm tất cả
if ! grep -rqs "set_real_ip_from" /etc/nginx/; then
  echo "❌ Chưa cấu hình IP thật từ Cloudflare (set_real_ip_from). Chép deploy/cloudflare-realip.conf vào /etc/nginx/conf.d/ trước."
  exit 1
fi

BAK="$SITE.bak-$(date +%Y%m%d-%H%M%S)"
ZBAK=""
cp "$SITE" "$BAK"
[ -f "$ZONE" ] && { ZBAK="$ZONE.bak"; cp "$ZONE" "$ZBAK"; }
cp "$DIR/nginx-shield.conf" "$ZONE"
mkdir -p "$CACHE"
NGUSER="$(grep -m1 -oP '^\s*user\s+\K[^;\s]+' /etc/nginx/nginx.conf 2>/dev/null)"
chown -R "${NGUSER:-www-data}" "$CACHE" 2>/dev/null || true

PROXY="$(grep -m1 -oP 'proxy_pass\s+\Khttp://[^;]+' "$SITE")"
PROXY="${PROXY:-http://127.0.0.1:3200}"

if grep -q "gz_req" "$SITE"; then
  echo "ℹ️  File site đã có giới hạn theo IP."
else
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

if grep -q "gz_micro" "$SITE"; then
  echo "ℹ️  File site đã có microcache, chỉ cập nhật vùng đếm."
else
  WEBROOT="$WEBROOT" perl -0pi -e '
    my $root = $ENV{WEBROOT};
    # 4. Microcache + giới hạn tổng + trang "đang đông" trong mọi "location / {"
    my $c = "    limit_conn gz_total 400;\n    error_page 429 /busy.html;\n    proxy_cache gz_micro;\n    proxy_cache_key \"\$scheme\$host\$request_uri\";\n    proxy_cache_bypass \$gz_nocache;\n    proxy_no_cache \$gz_nocache;\n    proxy_cache_lock on;\n    proxy_cache_lock_timeout 5s;\n    proxy_cache_use_stale updating error timeout http_500 http_502 http_503 http_504;\n    proxy_cache_background_update on;\n    add_header X-Micro-Cache \$upstream_cache_status always;\n";
    s/^([ \t]*)(location \/ \{[^\n]*\n)/my ($i,$l)=($1,$2); (my $cc=$c) =~ s{^}{$i}mg; "$i$l$cc"/mge;
    # 5. Trang "đang đông" do Nginx trả (đặt trước location / đầu tiên của mỗi server)
    my $b = "location = \/busy.html {\n        root $root;\n        internal;\n        add_header Cache-Control \"no-store\" always;\n        add_header Retry-After \"10\" always;\n    }\n\n";
    s/^([ \t]*)(location \/ \{)/$1$b$1$2/mg;
  ' "$SITE"
fi

if nginx -t 2>/tmp/nginx-shield-test.log; then
  systemctl reload nginx 2>/dev/null || nginx -s reload
  echo "✅ Đã bật chống spam + microcache Nginx. Bản sao lưu: $BAK"
else
  cp "$BAK" "$SITE"
  if [ -n "$ZBAK" ]; then mv "$ZBAK" "$ZONE"; else rm -f "$ZONE"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  echo "❌ Cấu hình lỗi, đã khôi phục lại như cũ. Chi tiết:"
  cat /tmp/nginx-shield-test.log
  exit 1
fi
rm -f "$ZBAK"
