/**
 * AI Quote Extractor — Cloudflare Worker
 * รับคำอธิบายงานวิจัย (ภาษาไทย/อังกฤษ) → ให้ Claude แตกเป็น
 *   - tasks: แต่ละงาน ใช้กี่วัน ต่อแต่ละตำแหน่ง (ลงตาราง งาน × ตำแหน่ง)
 *   - resp: ค่าตอบแทนผู้ตอบ (RD)
 *   - other: ค่าใช้จ่ายอื่น
 * ต้องตั้ง secret ที่ Worker:  ANTHROPIC_API_KEY
 * (ตั้ง var MODEL ได้ถ้าอยากเปลี่ยนรุ่น — ค่าเริ่มต้น Haiku 4.5)
 */

const ALLOW = [
  'https://pitchapa13.github.io',
  'http://localhost:8731',
  'http://localhost:8733',
  'http://localhost:8735',
  'http://localhost:8737',
  'http://localhost:8739',
];

function corsHeaders(origin) {
  const allow = ALLOW.includes(origin) ? origin : ALLOW[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}),
  });
}

const TOOL = {
  name: 'fill_quote',
  description: 'แตกงานวิจัยตลาดเป็นตารางงาน (แต่ละงานใช้กี่วันต่อแต่ละตำแหน่ง) + ค่าตอบแทนผู้ตอบ (RD) + ค่าใช้จ่ายอื่น',
  input_schema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'รายการงาน (task) แต่ละงานระบุว่าตำแหน่งไหนใช้กี่วัน',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'ชื่องาน เช่น Landscape & research, Quanti, Analysis (ใช้ชื่อจากรายการงานตั้งต้นถ้าตรง)' },
            assignments: {
              type: 'array',
              description: 'ตำแหน่งไหนทำงานนี้กี่วัน',
              items: {
                type: 'object',
                properties: {
                  position: { type: 'string', description: 'ชื่อตำแหน่ง ให้ตรงกับรายการตำแหน่งที่ให้มา' },
                  days: { type: 'number', description: 'จำนวนวัน (manday) ของตำแหน่งนี้ในงานนี้' },
                },
                required: ['position', 'days'],
              },
            },
          },
          required: ['task', 'assignments'],
        },
      },
      resp: {
        type: 'array',
        description: 'ค่าตอบแทนผู้ตอบแบบสอบถาม/สัมภาษณ์ (RD)',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'ประเภท เช่น quanti, quali — ให้ตรง preset ถ้ามี' },
            pricePerHead: { type: 'number', description: 'ราคาต่อหัว ถ้าตรง preset ไม่ต้องใส่ก็ได้' },
            heads: { type: 'number', description: 'จำนวนหัว/คน' },
          },
          required: ['label', 'heads'],
        },
      },
      other: {
        type: 'array',
        description: 'ค่าใช้จ่ายอื่น / freelance',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            price: { type: 'number', description: 'ราคาต่อหน่วย' },
            qty: { type: 'number', description: 'จำนวน ปกติ 1' },
          },
          required: ['label', 'price'],
        },
      },
    },
    required: [],
  },
};

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const h = corsHeaders(origin);

    if (req.method === 'OPTIONS') return new Response(null, { headers: h });
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405, h);
    if (!env.ANTHROPIC_API_KEY) return json({ error: 'ยังไม่ได้ตั้ง ANTHROPIC_API_KEY ที่ Worker' }, 500, h);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400, h); }

    const text = String(body.text || '').slice(0, 6000).trim();
    if (!text) return json({ error: 'empty text' }, 400, h);

    const ctx = body.context || {};
    const positions = (ctx.people || []).map((p) => `${p.name}`).join(', ');
    const tasks = (ctx.taskPresets || []).join(', ');
    const respP = (ctx.respPresets || []).map((r) => `${r.name} ${r.price}฿/หัว`).join(', ');
    const otherP = (ctx.otherPresets || []).map((r) => `${r.name} ${r.price}฿/หน่วย`).join(', ');
    const examples = Array.isArray(ctx.examples) ? ctx.examples.slice(0, 5) : [];

    const sys = [
      'คุณเป็นผู้ช่วยตั้งราคางานวิจัยตลาด (market research) ของทีม Crowdabout',
      'ผู้ใช้จะอธิบายว่าจะทำงานวิจัยอะไร คุณต้องแตกงานออกเป็น "งาน (task)" หลายๆ งาน แล้วประเมินว่าแต่ละงานตำแหน่งไหนใช้กี่วัน (manday) — เรียกเครื่องมือ fill_quote เสมอ',
      'สำคัญ: ต้องระบุจำนวนวันของแต่ละตำแหน่งในแต่ละงานให้ครบ (assignments) ไม่ใช่แค่ยอดรวม',
      'ประเมินค่าตอบแทนผู้ตอบ (RD) และค่าใช้จ่ายอื่นด้วยถ้ามี',
      'ถ้าผู้ใช้ระบุตัวเลขชัด (เช่น quanti 400 คน, FGD 3 กลุ่ม) ให้ใช้ตามนั้น ถ้าไม่ระบุให้ประมาณอย่างสมเหตุสมผลตามสเกลงาน',
      positions ? `ตำแหน่งที่มี (ใช้ชื่อให้ตรง): ${positions}` : '',
      tasks ? `รายการงานตั้งต้นที่ใช้บ่อย (เลือกใช้/เพิ่มได้): ${tasks}` : '',
      'ตั้งชื่อ resp.label / other.label ให้ตรงกับชื่อ preset ด้านล่างเมื่อเข้าข่าย (เช่น quanti, quali, transcription, interview) เพื่อให้ระบบดึงราคาให้อัตโนมัติ',
      respP ? `RD preset: ${respP}` : '',
      otherP ? `ค่าใช้จ่าย preset: ${otherP}` : '',
      examples.length ? ('ตัวอย่าง quote ที่ทีมเคยทำจริง (เรียนรู้สไตล์ทีม — จำนวนวัน/ตำแหน่ง/RD ให้ใกล้เคียงของจริง อย่าลอกทั้งดุ้น ปรับตามสเกลงานใหม่):\n' + JSON.stringify(examples).slice(0, 4000)) : '',
      'อย่าเดาเกินจริง ถ้าไม่แน่ใจให้ใส่เฉพาะรายการที่มั่นใจ',
    ].filter(Boolean).join('\n');

    let ar;
    try {
      ar = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: env.MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 2000,
          system: sys,
          tools: [TOOL],
          tool_choice: { type: 'tool', name: 'fill_quote' },
          messages: [{ role: 'user', content: text }],
        }),
      });
    } catch (e) {
      return json({ error: 'เรียก Anthropic ไม่ได้: ' + e.message }, 502, h);
    }

    if (!ar.ok) {
      const t = await ar.text();
      return json({ error: 'Anthropic ' + ar.status, detail: t.slice(0, 500) }, 502, h);
    }

    const data = await ar.json();
    const tu = (data.content || []).find((c) => c.type === 'tool_use');
    if (!tu) return json({ error: 'AI ไม่ได้ตอบเป็นรูปแบบที่ต้องการ' }, 502, h);

    const out = tu.input || {};
    return json({ tasks: out.tasks || [], resp: out.resp || [], other: out.other || [] }, 200, h);
  },
};
