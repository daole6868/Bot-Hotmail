#!/usr/bin/env bash
# Gia cố VPS cho gachaz.online trong 1 lệnh (chạy lại nhiều lần cũng không sao):
#   sudo bash /var/www/gachaz/deploy/harden-vps.sh
#
#  1. Web chạy bằng tài khoản riêng "gachaz" (không phải root); chỉ tài khoản này đọc được .env và dữ liệu.
#     Lệnh cập nhật vẫn như cũ: cd /var/www/gachaz && git pull && pm2 restart gachaz
#  2. fail2ban: tự chặn IP dò mật khẩu SSH (không bao giờ chặn IP bạn đang dùng)
#  3. Tự cài bản vá bảo mật của Ubuntu mỗi ngày
#  4. SSH chỉ cho đăng nhập bằng khóa (CHỈ làm khi đã có khóa SSH và bạn gõ "y" đồng ý)
#  5. Kiểm tra web chỉ nghe ở 127.0.0.1 (không ai gọi thẳng cổng 3200 được)
# Lỗi ở bước nào thì bước đó tự quay lại như cũ, không ảnh hưởng web.
set -u
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER=gachaz
PM2_NAME=gachaz
ok()   { echo "✅ $*"; }
info() { echo "ℹ️  $*"; }
warn() { echo "⚠️  $*"; }

[ "$(id -u)" = 0 ] || { echo "❌ Cần chạy bằng sudo"; exit 1; }
[ -f "$APP_DIR/server.js" ] || { echo "❌ Không thấy web ở $APP_DIR"; exit 1; }
command -v pm2 >/dev/null || { echo "❌ Không tìm thấy pm2"; exit 1; }
cd "$APP_DIR" || exit 1
PORT="$(grep -oP '^PORT=\K\d+' .env 2>/dev/null || echo 3200)"

runs_as_app() { # mọi tiến trình web đang chạy bằng tài khoản riêng
  local pids; pids="$(pm2 pid "$PM2_NAME" 2>/dev/null | grep -E '^[1-9][0-9]*$')"
  [ -n "$pids" ] || return 1
  for p in $pids; do [ "$(ps -o user= -p "$p" 2>/dev/null | tr -d ' ')" = "$APP_USER" ] || return 1; done
}
web_ok() { # web trả lời trong 20 giây
  for _ in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null)"
    case "$code" in 200|301|302|429|503) return 0 ;; esac
    sleep 1
  done
  return 1
}

echo "=== 1. Chạy web bằng tài khoản riêng ($APP_USER) ==="
OWNER="$(stat -c %U "$APP_DIR/data" 2>/dev/null)"
if [ "$OWNER" = "$APP_USER" ] && runs_as_app; then
  info "Web đã chạy bằng tài khoản $APP_USER."
else
  id "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  # Chỉ những chỗ web cần ghi mới thuộc tài khoản riêng; mã nguồn vẫn của root (web không sửa được code của chính nó)
  mkdir -p data/logs data/backups data/tmp public/uploads public/img/catalog
  chown -R "$APP_USER:$APP_USER" data public/uploads public/img/catalog
  chmod 750 data
  [ -f .env ] && { chown "$APP_USER:$APP_USER" .env; chmod 600 .env; }
  pm2 delete "$PM2_NAME" >/dev/null 2>&1
  pm2 start deploy/ecosystem.config.js >/dev/null
  if web_ok && runs_as_app; then
    pm2 save >/dev/null
    ok "Web đang chạy bằng tài khoản $APP_USER. Nhật ký web: $APP_DIR/data/logs/"
  else
    warn "Web không chạy được bằng tài khoản riêng -> quay lại chạy như cũ."
    pm2 logs "$PM2_NAME" --lines 20 --nostream 2>/dev/null | tail -20
    chown -R root:root data public/uploads public/img/catalog
    [ -f .env ] && chown root:root .env
    pm2 delete "$PM2_NAME" >/dev/null 2>&1
    pm2 start deploy/ecosystem.config.js >/dev/null && pm2 save >/dev/null
    web_ok && ok "Web đã chạy lại như cũ (bằng root)." || warn "Web chưa lên, kiểm tra: pm2 logs $PM2_NAME"
  fi
fi

echo "=== 2. fail2ban (chặn IP dò mật khẩu SSH) ==="
export DEBIAN_FRONTEND=noninteractive
if ! command -v fail2ban-server >/dev/null; then apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq fail2ban >/dev/null 2>&1; fi
if command -v fail2ban-server >/dev/null; then
  MYIP="$(echo "${SSH_CLIENT:-}" | awk '{print $1}')"
  cat > /etc/fail2ban/jail.d/gachaz.conf <<EOF
# Tạo bởi deploy/harden-vps.sh
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 ${MYIP}
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
EOF
  systemctl enable --now fail2ban >/dev/null 2>&1; systemctl restart fail2ban >/dev/null 2>&1
  systemctl is-active --quiet fail2ban && ok "fail2ban đang chạy (sai 5 lần / 10 phút -> chặn 1 giờ${MYIP:+, bỏ qua IP của bạn $MYIP})." || warn "fail2ban chưa chạy được (không ảnh hưởng web)."
else
  warn "Không cài được fail2ban (không ảnh hưởng web)."
fi

echo "=== 3. Tự cài bản vá bảo mật ==="
dpkg -s unattended-upgrades >/dev/null 2>&1 || apt-get install -y -qq unattended-upgrades >/dev/null 2>&1
if dpkg -s unattended-upgrades >/dev/null 2>&1; then
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
  ok "Ubuntu tự cài bản vá bảo mật mỗi ngày (không tự khởi động lại VPS)."
else
  warn "Không cài được unattended-upgrades."
fi

echo "=== 4. SSH chỉ đăng nhập bằng khóa ==="
HAS_KEY=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -s "$f" ] && grep -qE '^(ssh-|ecdsa-|sk-)' "$f" && HAS_KEY=1
done
SSHD_D=/etc/ssh/sshd_config.d
CUR_PASS="$(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
if [ "$CUR_PASS" = "no" ]; then
  info "SSH đã tắt đăng nhập bằng mật khẩu từ trước."
elif [ "$HAS_KEY" = 0 ]; then
  info "Chưa có khóa SSH trên VPS -> GIỮ NGUYÊN đăng nhập bằng mật khẩu (tắt lúc này sẽ tự khóa bạn ra ngoài)."
elif ! grep -qE '^\s*Include\s+/etc/ssh/sshd_config.d' /etc/ssh/sshd_config; then
  info "Bản SSH này không hỗ trợ file cấu hình riêng -> bỏ qua bước này."
else
  echo "VPS đã có khóa SSH. Tắt đăng nhập bằng mật khẩu (chỉ cho đăng nhập bằng khóa)?"
  echo "Chỉ gõ y nếu bạn ĐANG đăng nhập được bằng khóa SSH (không phải mật khẩu)."
  read -r -p "Tắt đăng nhập bằng mật khẩu? (y/N): " ANS
  if [ "${ANS:-n}" = "y" ] || [ "${ANS:-n}" = "Y" ]; then
    mkdir -p "$SSHD_D"
    cat > "$SSHD_D/90-gachaz.conf" <<'EOF'
# Tạo bởi deploy/harden-vps.sh — xóa file này để bật lại đăng nhập bằng mật khẩu
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 4
EOF
    if sshd -t 2>/dev/null; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
      ok "SSH chỉ cho đăng nhập bằng khóa. Phiên đang mở không bị ngắt."
      info "Mở thêm 1 cửa sổ SSH mới để thử đăng nhập trước khi đóng cửa sổ này."
    else
      rm -f "$SSHD_D/90-gachaz.conf"
      warn "Cấu hình SSH lỗi -> đã quay lại như cũ."
    fi
  else
    info "Giữ nguyên đăng nhập bằng mật khẩu."
  fi
fi

echo "=== 5. Kiểm tra cổng web ==="
LISTEN="$(ss -ltnH "sport = :$PORT" 2>/dev/null | awk '{print $4}' | head -1)"
case "$LISTEN" in
  127.0.0.1:*|"[::1]:"*) ok "Web chỉ nghe ở $LISTEN (không ai gọi thẳng cổng $PORT từ ngoài được)." ;;
  "") warn "Không thấy web nghe ở cổng $PORT." ;;
  *) warn "Web đang nghe ở $LISTEN (mọi địa chỉ). Thêm dòng TRUST_PROXY=true vào $APP_DIR/.env rồi chạy: pm2 restart $PM2_NAME" ;;
esac

echo
ok "Xong. Lệnh cập nhật web vẫn như cũ: cd $APP_DIR && git pull && pm2 restart $PM2_NAME"
