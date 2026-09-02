/**
 * AI Quote Extractor — Cloudflare Worker
 * รับคำอธิบายงานวิจัย (ภาษาไทย/อังกฤษ) → ให้ Claude แตกเป็น ทีม / RD / ค่าใช้จ่ายอื่น → คืน JSON
 * ต้องตั้ง secret ที่ Worker:  ANTHROPIC_API_KEY
 * (ตั้ง var MODEL ได้ถ้าอยากเปลี่ยนรุ่น — ค่าเริ่มต้น Haiku 4.5)
 */

const ALLOW = [
  'https://pitchapa13.github.io',
  'http://localhost:8731',
  'http://localhost:8733',
  'http://localhost:8735',
  'http://localhost:8737',
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
  description: 'กรอกรายการทีมงาน ค่าตอบแทนผู้ตอบ (RD) และค่าใช้จ่ายอื่น ตามคำอธิบายงานวิจัยตลาด',
  input_schema: {
    type: 'object',
    properties: {
      team: {
        type: 'array',
        description: 'คนในทีมที่ต้องใช้ + จำนวนวันทำงาน (manday)',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'ชื่อคน ให้ตรงกับรายชื่อทีมที่ให้มา ถ้าไม่มีให้ใส่ชื่อตำแหน่งสั้นๆ' },
            days: { type: 'number', description: 'จำนวนวันทำงาน (manday)' },
            people: { type: 'number', description: 'จำนวนคน ปกติ 1 (ใส่มากกว่าได้เฉพาะตำแหน่งที่ระบุว่าใส่จำนวนคนได้ เช่น Intern)' },
          },
          required: ['name', 'days'],
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
    const people = (ctx.people || []).map((p) => `${p.name}${p.multi ? ' (ใส่จำนวนคนได้)' : ''}`).join(', ');
    const respP = (ctx.respPresets || []).map((r) => `${r.name} ${r.price}฿/หัว`).join(', ');
    const otherP = (ctx.otherPresets || []).map((r) => `${r.name} ${r.price}฿/หน่วย`).join(', ');

    const sys = [
      'คุณเป็นผู้ช่วยตั้งราคางานวิจัยตลาด (market research) ของทีม Crowdabout',
      'ผู้ใช้จะอธิบายว่าจะทำงานวิจัยอะไร คุณต้องประเมินว่าต้องใช้ทีมกี่คนกี่วัน, ค่าตอบแทนผู้ตอบ (RD) เท่าไหร่, และค่าใช้จ่ายอื่น แล้วเรียกเครื่องมือ fill_quote เสมอ',
      'ถ้าผู้ใช้ระบุตัวเลขชัด (เช่น quanti 400 คน, FGD 3 กลุ่ม กลุ่มละ 8 คน) ให้ใช้ตามนั้น ถ้าไม่ระบุให้ประมาณอย่างสมเหตุสมผลตามสเกลงาน',
      people ? `รายชื่อทีมที่มี: ${people} — ใช้ชื่อให้ตรงเมื่ออ้างถึงคนเหล่านี้` : '',
      respP ? `RD preset: ${respP}` : '',
      otherP ? `ค่าใช้จ่าย preset: ${otherP}` : '',
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
          max_tokens: 1500,
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
    return json({ team: out.team || [], resp: out.resp || [], other: out.other || [] }, 200, h);
  },
};
