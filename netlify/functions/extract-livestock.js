// netlify/functions/extract-livestock.js
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const sb = async (path, opts = {}) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.method === 'POST' ? 'return=representation' : undefined,
      ...opts.headers,
    },
  });
  if (!res.ok && res.status !== 204) return null;
  if (res.status === 204) return null;
  return res.json().catch(() => null);
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { pdf_base64, pdf_text, farm_id, save_example, correction, extraction_id, agent_name } = body;

  // Save correction
  if (save_example && extraction_id && correction) {
    try {
      await sb('livestock_extraction_examples', {
        method: 'POST',
        body: JSON.stringify({ farm_id, extraction_id, agent_name: correction.agent_name || null, corrected_data: correction, created_at: new Date().toISOString() }),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (!pdf_base64 && !pdf_text) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No document data provided' }) };

  // Load past corrections — agent-specific first
  let examples = [];
  try {
    const allExamples = await sb('livestock_extraction_examples?farm_id=eq.' + farm_id + '&corrected_data=not.is.null&order=created_at.desc&limit=20&select=corrected_data,agent_name') || [];
    if (pdf_text && allExamples.length > 0) {
      const knownAgents = [...new Set(allExamples.map(e => e.agent_name).filter(Boolean))];
      const matched = knownAgents.find(a => pdf_text.toLowerCase().includes(a.toLowerCase()));
      if (matched) {
        const specific = allExamples.filter(e => e.agent_name?.toLowerCase() === matched.toLowerCase());
        const others = allExamples.filter(e => e.agent_name?.toLowerCase() !== matched.toLowerCase());
        examples = [...specific, ...others].slice(0, 5);
      } else {
        examples = allExamples.slice(0, 5);
      }
    } else {
      examples = allExamples.slice(0, 5);
    }
  } catch(e) { /* table may not exist yet */ }

  const exampleText = examples.length > 0
    ? 'PREVIOUS CORRECTIONS from this farm (same agent corrections are most relevant):\n' +
      examples.map((ex, i) => {
        const d = ex.corrected_data || {};
        return `  Correction ${i+1} (agent: ${ex.agent_name||'?'}): ` +
          `date="${d.sale_date||'?'}", agent="${d.agent_name||'?'}", location="${d.sale_location||'?'}", ` +
          `commission=${d.commission_amount||'?'}, lots=${d.lots?.length||'?'}`;
      }).join('\n') + '\n\n'
    : '';

  const prompt = exampleText +
    'Extract information from this livestock sale statement or account sale document. ' +
    'Respond with ONLY a JSON object — no explanation, no markdown.\n' +
    'RULES:\n' +
    '1. sale_date: YYYY-MM-DD format. Convert "01-SEP-2026"→"2026-09-01".\n' +
    '2. All monetary values in AUD only.\n' +
    '3. For each lot: estimate price_basis as "per_kg" if live weight is shown, else "per_head".\n' +
    '4. weight_estimated: true if weight shown as "est" or "approx" or clearly calculated not weighed.\n' +
    '5. category: must be one of: Steer, Heifer, Bull, Cow, PTIC Cow, Cull Cow, Weaner Steer, Weaner Heifer, Wether, Ram, Ewe, Ewe Lamb, Wether Lamb, X-bred Lamb, PTIC Ewe, Cull Ewe.\n\n' +
    '{\n' +
    '  "agent_name": "auctioneer or buyer company name",\n' +
    '  "sale_date": "YYYY-MM-DD",\n' +
    '  "sale_location": "sale yard name or location",\n' +
    '  "vendor_number": "vendor or account number if shown",\n' +
    '  "commission_amount": 0,\n' +
    '  "lots": [\n' +
    '    {\n' +
    '      "category": "Steer",\n' +
    '      "description": "18mo description",\n' +
    '      "head": 0,\n' +
    '      "avg_weight_kg": 0,\n' +
    '      "weight_estimated": false,\n' +
    '      "price_basis": "per_kg",\n' +
    '      "price": 0,\n' +
    '      "gross": 0\n' +
    '    }\n' +
    '  ],\n' +
    '  "total_gross": 0,\n' +
    '  "_unfound_fields": ["fields not found"]\n' +
    '}';

  console.log('[extract-livestock] path:', pdf_text ? 'text (' + pdf_text.length + ' chars)' : 'binary');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: pdf_text
            ? [{ type: 'text', text: prompt + '\n\nDocument text:\n' + pdf_text }]
            : [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } }, { type: 'text', text: prompt }]
        }]
      })
    });

    const data = await response.json();
    const raw = data.content?.map(c => c.text || '').join('') || '';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return { statusCode: 200, headers, body: JSON.stringify({ error: 'Could not parse extraction' }) };
    const clean = raw.slice(start, end + 1);

    let extracted;
    try { extracted = JSON.parse(clean); }
    catch(e) { return { statusCode: 200, headers, body: JSON.stringify({ error: 'Could not parse extraction' }) }; }

    // Fix date format
    if (extracted.sale_date && !/^\d{4}-\d{2}-\d{2}$/.test(extracted.sale_date)) {
      const months = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
      const m1 = extracted.sale_date.match(/^(\d{1,2})[\/\-]([A-Z]{3})[\/\-](\d{4})$/i);
      if (m1 && months[m1[2].toUpperCase()]) extracted.sale_date = `${m1[3]}-${String(months[m1[2].toUpperCase()]).padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
      const m2 = extracted.sale_date.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (m2) extracted.sale_date = `${m2[3]}-${m2[2].padStart(2,'0')}-${m2[1].padStart(2,'0')}`;
    }

    // Save extraction record
    let extractionId = null;
    try {
      const saved = await sb('livestock_extraction_examples', {
        method: 'POST',
        body: JSON.stringify({ farm_id, agent_name: extracted.agent_name || null, extracted_data: extracted, corrected_data: null, created_at: new Date().toISOString() }),
      });
      extractionId = saved?.[0]?.id;
    } catch(e) {}

    return { statusCode: 200, headers, body: JSON.stringify({ extracted, extraction_id: extractionId, examples_used: examples.length }) };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
