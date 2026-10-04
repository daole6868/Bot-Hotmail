# Cổng API cho máy lấy dữ liệu HoYoLAB (worker)

Web GACHAZ chỉ giao việc và nhận kết quả. Máy worker (chương trình riêng của shop) tự lo phần đăng nhập HoYoLAB và lấy dữ liệu.

## Chuẩn bị
1. Admin → **Kết nối API** → **HoYoLAB worker** → **Tạo mã**. Sao chép mã (chỉ hiện 1 lần).
2. Mọi request gửi header: `Authorization: Bearer <mã worker>` và `Content-Type: application/json`.
3. Địa chỉ gốc: `https://gachaz.online/api/hoyo`

Mỗi máy worker đặt 1 tên riêng (`worker`, ví dụ `may-admin-1`), gửi kèm trong mọi request.

## 1. Nhận việc — `POST /api/hoyo/claim`
Gọi mỗi ~3 giây (tối đa 240 lần/phút).
```json
{ "worker": "may-admin-1", "version": "1.0" }
```
Trả về `{"ok": true, "job": null}` khi chưa có việc, hoặc:
```json
{ "ok": true, "job": {
  "id": 12, "game": "genshin", "server": "Asia",
  "username": "...", "password": "...",
  "captcha_sec": 90, "job_sec": 480 } }
```
- `game`: `genshin` | `hsr` | `zzz`
- `server`: `Asia` | `America` | `Europe` | `TW/HK/MO` hoặc chuỗi rỗng (tự động)
- `captcha_sec`, `job_sec`: thời gian tối đa admin đặt. Quá `job_sec` mà chưa nộp kết quả, web tự báo lỗi cho người bấm.
- Tài khoản / mật khẩu bị xóa khỏi database ngay khi giao — worker không được ghi chúng ra file / log.

## 2. Báo tiến trình — `POST /api/hoyo/jobs/:id/progress`
```json
{ "worker": "may-admin-1", "progress": 40, "message": "Đang lấy dữ liệu nhân vật..." }
```
`progress` 0–99. Nội dung `message` hiện trực tiếp trong popup cho admin / CTV.

## 3. Báo lỗi — `POST /api/hoyo/jobs/:id/fail`
```json
{ "worker": "may-admin-1", "error": "Sai mật khẩu. Vui lòng thao tác lại sau." }
```
Nội dung `error` hiện cho người bấm.

## 4. Nộp kết quả — `POST /api/hoyo/jobs/:id/done`
```json
{ "worker": "may-admin-1", "result": {
  "account": { "level": 58, "server": "Asia", "uid": "812345678" },
  "characters_5star": [ { "name": "Furina", "icon": "https://...png", "element": "Hydro", "level": 90, "constellation": 2 } ],
  "characters_4star": [ { "name": "Xingqiu", "icon": "https://...png", "level": 80, "constellation": 6 } ],
  "weapons_by_rarity": {
    "5": [ { "name": "Splendor of Tranquil Waters", "icon": "https://...png", "level": 90, "refinement": 1 } ],
    "4": [ { "name": "Sacrificial Sword", "icon": "https://...png", "level": 90, "refinement": 5 } ] } } }
```
- Đúng dạng `build_result_genshin / build_result_hsr / build_result_zzz` (giữ nguyên được).
- Bậc nhân vật đọc từ `constellation` (Genshin), `rank` / `eidolon` (Star Rail), `rank` (ZZZ).
- Tinh luyện vũ khí đọc từ `refinement` / `rank` / `superimpose` / `star`.
- Ảnh: chỉ nhận link `https://` từ máy chủ ảnh của HoYoverse (`*.hoyoverse.com`, `*.hoyolab.com`, `*.mihoyo.com`, `enka.network`). Web tự tải về, nén webp và dùng chung cho mọi acc.
- Không cần gửi `detailed_raw` (thánh di vật, relic...) — web bỏ qua, gửi chỉ làm chậm. Giới hạn 3 MB.

Sau khi nộp, popup của admin / CTV tự điền **Chi tiết tài khoản** (cấp, máy chủ, nhân vật & vũ khí 5★ 4★), người bấm kiểm tra rồi lưu sản phẩm.

## Mã lỗi
- `401` — sai / chưa có mã worker (Kết nối API → tạo mã mới).
- `{"ok": false}` ở progress / fail / done — job không còn chạy (đã hủy, quá thời gian hoặc do máy khác nhận).
