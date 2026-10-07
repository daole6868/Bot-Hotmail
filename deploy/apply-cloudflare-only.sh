#!/usr/bin/env bash
# Chỉ cho Cloudflare truy cập web (chặn ai gọi thẳng IP của VPS để vượt qua Cloudflare):
#   sudo bash /var/www/gachaz/deploy/apply-cloudflare-only.sh        # bật
#   sudo bash /var/www/gachaz/deploy/apply-cloudflare-only.sh --off  # tắt, trả lại như cũ
# - Chỉ tác động tới web (Nginx), KHÔNG động tới SSH -> không thể tự khóa mình khỏi VPS
# - Lấy danh sách IP mới nhất của Cloudflare, cập nhật luôn phần lấy IP thật (cloudflare-realip.conf)
# - Sao lưu trước khi sửa, lỗi thì tự khôi phục
set -u
SITE=/etc/nginx/sites-available/gachaz.online
MODE=on
for a in "$@"; do case "$a" in --off) MODE=off ;; *) SITE="$a" ;; esac; done
DIR="$(cd "$(dirname "$0")" && pwd)"
GEO=/etc/nginx/conf.d/gachaz-cf-only.conf
REALIP=/etc/nginx/conf.d/cloudflare-realip.conf

[ "$(id -u)" = 0 ] || { echo "❌ Cần chạy bằng sudo"; exit 1; }
[ -f "$SITE" ] || { echo "❌ Không tìm thấy $SITE"; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$SITE" "$SITE.bak-$STAMP"
[ -f "$REALIP" ] && cp "$REALIP" "/root/cloudflare-realip.conf.bak-$STAMP"
[ -f "$GEO" ] && cp "$GEO" "/root/gachaz-cf-only.conf.bak-$STAMP"

restore() {
  cp "$SITE.bak-$STAMP" "$SITE"
  if [ -f "/root/cloudflare-realip.conf.bak-$STAMP" ]; then cp "/root/cloudflare-realip.conf.bak-$STAMP" "$REALIP"; fi
  if [ -f "/root/gachaz-cf-only.conf.bak-$STAMP" ]; then cp "/root/gachaz-cf-only.conf.bak-$STAMP" "$GEO"; else rm -f "$GEO"; fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
}

if [ "$MODE" = off ]; then
  sed -i '/gz_from_cf/d' "$SITE"
  rm -f "$GEO"
  if nginx -t 2>/tmp/cf-only.log; then systemctl reload nginx; echo "✅ Đã tắt: web lại cho truy cập thẳng bằng IP."; else restore; cat /tmp/cf-only.log; exit 1; fi
  exit 0
fi

# 1. Danh sách IP Cloudflare (lấy mới, lỗi mạng thì dùng danh sách có sẵn trong repo)
V4="$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v4 2>/dev/null)"
V6="$(curl -fsS --max-time 10 https://www.cloudflare.com/ips-v6 2>/dev/null)"
LIST="$(printf '%s\n%s\n' "$V4" "$V6" | grep -E '^[0-9a-fA-F:.]+/[0-9]+$')"
if [ "$(echo "$LIST" | grep -c /)" -lt 10 ]; then
  echo "ℹ️  Không tải được danh sách IP mới của Cloudflare, dùng danh sách có sẵn."
  LIST="$(grep -oP 'set_real_ip_from\s+\K[0-9a-fA-F:.]+/[0-9]+' "$DIR/cloudflare-realip.conf")"
fi

# 2. Cập nhật phần lấy IP thật (chỉ khi file này đã có, tránh khai báo trùng ở chỗ khác)
if [ -f "$REALIP" ]; then
  {
    echo "# Lấy IP thật của khách sau Cloudflare (tạo bởi deploy/apply-cloudflare-only.sh)"
    echo "$LIST" | sed 's/^/set_real_ip_from /; s/$/;/'
    echo "real_ip_header CF-Connecting-IP;"
  } > "$REALIP"
fi

# 3. Biến $gz_from_cf = 1 nếu kết nối đến từ Cloudflare (dùng IP gốc của kết nối, trước khi đổi sang IP thật của khách)
{
  echo "# Chỉ cho Cloudflare truy cập (tạo bởi deploy/apply-cloudflare-only.sh)"
  echo 'geo $realip_remote_addr $gz_from_cf {'
  echo '    default 0;'
  echo '    127.0.0.1/32 1;'
  echo '    ::1/128 1;'
  echo "$LIST" | sed 's/^/    /; s/$/ 1;/'
  echo '}'
} > "$GEO"

# 4. Trong mỗi khối server: không đến từ Cloudflare -> đóng kết nối luôn (444, không trả gì)
if ! grep -q "gz_from_cf" "$SITE"; then
  perl -0pi -e 's/^([ \t]*)(server_name[^\n]*\n)/$1$2$1if (\$gz_from_cf = 0) { return 444; }\n/mg' "$SITE"
fi

if nginx -t 2>/tmp/cf-only.log; then
  systemctl reload nginx
  echo "✅ Đã bật: chỉ Cloudflare truy cập được web ($(echo "$LIST" | grep -c /) dải IP). Tắt: sudo bash $0 --off"
else
  restore
  echo "❌ Cấu hình lỗi, đã khôi phục lại như cũ. Chi tiết:"
  cat /tmp/cf-only.log
  exit 1
fi
