// netlify/functions/extract-rcti.js
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': opts.method === 'POST' ? 'return=representation' : '',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  // Accept either raw text (extracted client-side) or base64 PDF fallback
  const { pdf_base64, pdf_text, farm_id, save_example, correction, extraction_id, document_type } = body;

  // Save correction as training example
  if (save_example && extraction_id && correction) {
    try {
      await sb('rcti_extraction_examples', {
        method: 'POST',
        body: JSON.stringify({ farm_id, extraction_id, buyer_name: correction.buyer_name || null, corrected_data: correction, created_at: new Date().toISOString() }),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (!pdf_base64 && !pdf_text) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No PDF data provided' }) };

  // Load all farm corrections — buyer-specific ones sorted to top dynamically
  // No hardcoded buyer list — we detect buyers from our own correction history
  let examples = [];
  try {
    const allExamples = await sb('rcti_extraction_examples?farm_id=eq.' + farm_id + '&corrected_data=not.is.null&order=created_at.desc&limit=20&select=corrected_data,buyer_name');
    if (pdf_text && allExamples.length > 0) {
      // Find any buyer from our correction history that appears in this document
      const knownBuyers = [...new Set(allExamples.map(e => e.buyer_name).filter(Boolean))];
      const matchedBuyer = knownBuyers.find(b => pdf_text.toLowerCase().includes(b.toLowerCase()));
      if (matchedBuyer) {
        // Buyer-specific examples first, then others, cap at 5 total
        const buyerFirst = allExamples.filter(e => e.buyer_name?.toLowerCase() === matchedBuyer.toLowerCase());
        const others = allExamples.filter(e => e.buyer_name?.toLowerCase() !== matchedBuyer.toLowerCase());
        examples = [...buyerFirst, ...others].slice(0, 5);
      } else {
        examples = allExamples.slice(0, 5);
      }
    } else {
      examples = allExamples.slice(0, 5);
    }
  } catch(e) { /* table may not exist yet */ }

  const exampleText = examples.length > 0
    ? 'IMPORTANT: Previous extractions from this farm have been corrected. Use these as reference for the expected format and values:\n\n' +
      examples.map((ex, i) => {
        const d = ex.corrected_data || {};
        const ginLabel = ex.buyer_name || d.buyer_name || '?';
        return `Correction ${i+1} (${ginLabel}): gin="${d.buyer_name||'?'}", date="${d.invoice_date||'?'}", bales=${d.bale_count||'?'}, gross=${d.gross_proceeds||'?'}`;
      }).join('\n') + '\n\nPrioritise corrections from the same buyer when extracting.\n\n'
    : '';

  const isGinReceipt = document_type === 'gin_receipt';

  const ginReceiptPrompt = exampleText +
    'Extract all charges from this gin receipt or ginning charge document. ' +
    'Return ONLY a valid JSON object with no other text or markdown:\n' +
    '{\n' +
    '  "receipt_number": "reference or receipt number",\n' +
    '  "buyer_name": "the buyer name",\n' +
    '  "grower_name": "grower or property name",\n' +
    '  "date": "YYYY-MM-DD",\n' +
    '  "bale_count": null,\n' +
    '  "charges": [\n' +
    '    {"description": "e.g. Ginning charge", "rate": "e.g. $71/bale", "total_amount": 0}\n' +
    '  ],\n' +
    '  "total_charges": 0,\n' +
    '  "gst_amount": null,\n' +
    '  "notes": "any other relevant information"\n' +
    '}\n' +
    'Extract EVERY charge line item separately. For fields not found use null. Return only the JSON object.';

  const rctiPrompt = exampleText +
    'Extract information from this RCTI (Recipient Created Tax Invoice). ' +
    'Respond with ONLY a JSON object — no explanation, no markdown, no text before or after. ' +
    'Start your response with { and end with }.\n' +
    '{\n' +
    '  "rcti_number": "invoice reference number",\n' +
    '  "buyer_name": "gin or buyer company name",\n' +
    '  "grower_name": "grower or property name",\n' +
    '  "crop_year": "e.g. 2025-26",\n' +
    '  "invoice_date": "YYYY-MM-DD",\n' +
    '  "payment_date": "YYYY-MM-DD or null",\n' +
    '  "docket_numbers": ["docket or bale lot numbers"],\n' +
    '  "bale_count": 0,\n' +
    '  "quality_premiums_discounts": [\n' +
    '    {"description": "e.g. Micronaire premium", "total_amount": 0}\n' +
    '  ],\n' +
    '  "gross_proceeds": 0,\n' +
    '  "net_payment": 0,\n' +
    '  "gst_amount": null,\n' +
    '  "_unfound_fields": ["fields you could not find"]\n' +
    '}';

  const prompt = isGinReceipt ? ginReceiptPrompt : rctiPrompt;

  console.log('[extract-rcti] path:', pdf_text ? 'text (' + pdf_text.length + ' chars)' : 'binary pdf');

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Use Haiku for speed — fast enough for structured extraction
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: pdf_text
            // Text extracted client-side — much faster, no binary transfer
            ? [{ type: 'text', text: prompt + '\n\nDocument text:\n' + pdf_text }]
            // Fallback: send raw PDF (slower, may timeout on large files)
            : [
                { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
                { type: 'text', text: prompt }
              ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, headers, body: JSON.stringify({ error: 'Claude API error: ' + err }) };
    }

    const data = await response.json();
    const raw = data.content?.map(c => c.text || '').join('') || '';
    // Extract JSON object regardless of any surrounding text
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[extract-rcti] No JSON found in response:', raw.slice(0, 200));
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Could not parse extraction', raw: raw.slice(0, 500) }) };
    }
    const clean = raw.slice(start, end + 1);

    let extracted;
    try { extracted = JSON.parse(clean); }
    catch(e) {
      console.error('[extract-rcti] JSON parse error:', e.message, 'raw:', clean.slice(0, 300));
      return { statusCode: 200, headers, body: JSON.stringify({ error: 'Could not parse extraction', raw: clean.slice(0, 500) }) };
    }

    // Save extraction record
    let extractionId = null;
    try {
      const saved = await sb('rcti_extraction_examples', {
        method: 'POST',
        body: JSON.stringify({ farm_id, buyer_name: extracted.buyer_name || null, extracted_data: extracted, corrected_data: null, created_at: new Date().toISOString() }),
      });
      extractionId = saved?.[0]?.id;
    } catch(e) { /* non-fatal */ }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ extracted, extraction_id: extractionId, examples_used: examples.length }),
    };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};