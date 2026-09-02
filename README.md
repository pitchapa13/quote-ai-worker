# quote-ai-worker

Cloudflare Worker เล็กๆ เป็น backend ให้ระบบ Quote (pitchapa13.github.io/quote-system)
รับคำอธิบายงานวิจัย → เรียก Claude (Haiku) → คืน JSON ทีม/RD/ค่าใช้จ่าย ให้หน้าเว็บกรอกฟอร์มอัตโนมัติ

API key เก็บเป็น secret ที่ Worker (ไม่อยู่ในเว็บ public)

## Deploy (Cloudflare dashboard — ไม่ต้องลง wrangler)

1. ไป https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**
2. ตั้งชื่อ เช่น `quote-ai-worker` → **Deploy** (ได้ worker เปล่าก่อน)
3. กด **Edit code** → ลบโค้ดเดิม → วางเนื้อหาไฟล์ [`src/index.js`](src/index.js) ทั้งหมด → **Deploy**
4. ไปแท็บ **Settings → Variables and Secrets** → **Add** →
   - Type: **Secret** · Name: `ANTHROPIC_API_KEY` · Value: (Anthropic API key ของคุณ) → **Save/Deploy**
5. คัดลอก URL ของ worker (เช่น `https://quote-ai-worker.<subdomain>.workers.dev`)
6. เปิดแอป Quote → แท็บ **ตั้งค่าทีม / เรท** → ช่อง **AI endpoint** → วาง URL → เสร็จ

## Deploy (git build — อัปเดตอัตโนมัติเวลาแก้)

เชื่อม repo นี้ที่ Workers & Pages → Create → Workers → Connect to Git → เลือก repo →
Deploy command `npx wrangler deploy` → แล้วตั้ง secret `ANTHROPIC_API_KEY` เหมือนข้อ 4

## CORS

โค้ดอนุญาต origin `https://pitchapa13.github.io` (+ localhost สำหรับเทสต์) ไว้แล้วใน `ALLOW`
ถ้าเปลี่ยนโดเมนเว็บ ต้องแก้ลิสต์นี้ใน `src/index.js`
