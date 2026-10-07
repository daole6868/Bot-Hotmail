'use strict';
// Nạp cung mệnh từ file JSON (tool lay_cung_menh.py) vào Quản lý ảnh -> Cung mệnh:
//   npm run import-consts -- imports/cung-menh-genshin.json
// Nhân vật khớp theo tên trong thư viện ảnh của game; ảnh tải về máy chủ như khi dán HTML. Ô đã có được ghi đè bằng dữ liệu mới.
const fs = require('fs');
const { db } = require('../src/db');
const hoyo = require('../src/services/hoyo');
const cst = require('../src/services/hoyo-const');

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) { console.error('Cách dùng: npm run import-consts -- <file.json>'); process.exit(1); }
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('File JSON không hợp lệ'); process.exit(1); }
  const game = data.game;
  if (!hoyo.GAMES[game] || !data.chars || typeof data.chars !== 'object') { console.error('File thiếu "game" hoặc "chars"'); process.exit(1); }
  const find = db.prepare("SELECT id FROM hoyo_assets WHERE game = ? AND kind = 'char' AND nkey = ?");
  const missing = []; let chars = 0; let slots = 0; const failed = [];
  for (const [name, list] of Object.entries(data.chars)) {
    const a = find.get(game, hoyo.nkey(name));
    if (!a) { missing.push(name); continue; }
    const items = Object.entries(list || {})
      .map(([s, v]) => ({ slot: parseInt(s, 10), name: String((v && v.name) || '').replace(/\s+/g, ' ').trim().slice(0, 80), src: String((v && v.icon) || '') }))
      .filter((x) => x.slot >= 1 && x.slot <= 6 && (x.name || x.src));
    if (!items.length) continue;
    const r = await cst.saveParsed(a.id, items);
    chars++; slots += r.saved || 0;
    if (r.failed && r.failed.length) failed.push(`${name} (ô ${r.failed.join(', ')})`);
    console.log(`  ${name}: ${r.saved} ô`);
  }
  console.log(`Xong: ${chars} nhân vật, ${slots} cung mệnh (${hoyo.GAMES[game].name})`);
  if (failed.length) console.log('Không tải được ảnh: ' + failed.join('; '));
  if (missing.length) console.log(`Chưa có trong thư viện ảnh (nạp nhân vật trước rồi chạy lại): ${missing.join(', ')}`);
})();
