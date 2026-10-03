#!/usr/bin/env bash
# Tạo file .env production với khóa bí mật ngẫu nhiên. Chạy 1 lần: bash deploy/setup-env.sh
set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then echo ".env đã tồn tại, không ghi đè."; exit 1; fi
rnd() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
read -rp "Tên đăng nhập admin [admin]: " AU; AU=${AU:-admin}
read -rsp "Mật khẩu admin (>= 8 ký tự, có chữ và số): " AP; echo
read -rp "Email admin: " AE
cp .env.example .env
sed -i "s#^NODE_ENV=.*#NODE_ENV=production#" .env
sed -i "s#^PORT=.*#PORT=3200#" .env
sed -i "s#^BASE_URL=.*#BASE_URL=https://gachaz.online#" .env
sed -i "s#^TRUST_PROXY=.*#TRUST_PROXY=true#" .env
sed -i "s#^SESSION_SECRET=.*#SESSION_SECRET=$(rnd 32)#" .env
sed -i "s#^APP_KEY=.*#APP_KEY=$(rnd 32)#" .env
sed -i "s#^BANK_WEBHOOK_TOKEN=.*#BANK_WEBHOOK_TOKEN=$(rnd 24)#" .env
# Ghi thông tin admin bằng node để mật khẩu có ký tự đặc biệt không bị lỗi
AU="$AU" AP="$AP" AE="$AE" node -e "
const fs=require('fs');let s=fs.readFileSync('.env','utf8');
const set=(k,v)=>{if(v.includes(\"'\")){console.error('Không dùng dấu nháy đơn trong '+k);process.exit(1)}s=s.replace(new RegExp('^'+k+'=.*','m'),()=>k+\"='\"+v+\"'\")};
set('ADMIN_USERNAME',process.env.AU);set('ADMIN_PASSWORD',process.env.AP);set('ADMIN_EMAIL',process.env.AE);
fs.writeFileSync('.env',s);"
chmod 600 .env
echo "Đã tạo .env. HÃY SAO LƯU GIÁ TRỊ APP_KEY Ở NƠI AN TOÀN (mất là không giải mã được thông tin acc)."
grep '^APP_KEY=' .env
