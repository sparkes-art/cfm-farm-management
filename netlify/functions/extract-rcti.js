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
        body: JSON.stringify({ farm_id, extraction_id, corrected_data: correction, created_at: new Date().toISOString() }),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ saved: true }) };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (!pdf_base64 && !pdf_text) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No PDF data provided' }) };

  // Load few-shot examples only when using binary PDF path (text path is fast enough without them)
  let examples = [];
  if (!pdf_text) {
    try {
      examples = await sb('rcti_extraction_examples?farm_id=eq.' + farm_id + '&order=created_at.desc&limit=3&select=corrected_data');
    } catch(e) { /* table may not exist yet */ }
  }

  const exampleText = examples.length > 0
    ? 'Here are examples of correctly extracted data from previous documents for this farm:\n\n' +
      examples.map((ex, i) => 'Example ' + (i+1) + ':\n' + JSON.stringify(ex.corrected_data, null, 2)).join('\n\n') + '\n\n'
    : '';

  const isGinReceipt = document_type === 'gin_receipt';

  const ginReceiptPrompt = exampleText +
    'Extract all charges from this gin receipt or ginning charge document. ' +
    'Return ONLY a valid JSON object with no other text or markdown:\n' +
    '{\n' +
    '  "receipt_number": "reference or receipt number",\n' +
    '  "gin_name": "the gin company name",\n' +
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
    'Extract all available information from this RCTI (Recipient Created Tax Invoice) or gin advice document. ' +
    'Return ONLY a valid JSON object with no other text or markdown:\n' +
    '{\n' +
    '  "rcti_number": "the RCTI or invoice reference number",\n' +
    '  "gin_name": "the gin or buyer company name",\n' +
    '  "gin_address": "gin location/address if shown",\n' +
    '  "grower_name": "the grower or property name",\n' +
    '  "grower_pid": "property identification code if shown",\n' +
    '  "crop_year": "e.g. 2025-26",\n' +
    '  "invoice_date": "YYYY-MM-DD format",\n' +
    '  "payment_date": "YYYY-MM-DD format or null",\n' +
    '  "docket_numbers": ["array of all docket/bale lot numbers found"],\n' +
    '  "bale_count": 0,\n' +
    '  "gross_weight_kg": null,\n' +
    '  "lint_weight_kg": null,\n' +
    '  "average_micronaire": null,\n' +
    '  "average_staple_length": null,\n' +
    '  "average_strength": null,\n' +
    '  "average_colour": null,\n' +
    '  "base_price_per_kg": null,\n' +
    '  "base_price_per_bale": null,\n' +
    '  "quality_premiums_discounts": [\n' +
    '    {"description": "e.g. Micronaire premium", "amount_per_kg": null, "total_amount": 0}\n' +
    '  ],\n' +
    '  "gross_proceeds": 0,\n' +
    '  "deductions": [\n' +
    '    {"description": "e.g. Ginning charge", "rate": null, "total_amount": 0}\n' +
    '  ],\n' +
    '  "net_payment": 0,\n' +
    '  "gst_amount": null,\n' +
    '  "gst_exclusive": true,\n' +
    '  "currency": "AUD",\n' +
    '  "notes": "any other relevant information",\n' +
    '  "_unfound_fields": ["list standard RCTI fields you could not find"],\n' +
    '  "_confidence_issues": ["describe fields where you had low confidence"]\n' +
    '}\n' +
    'Extract EVERY field you can find. Return only the JSON object.';

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
    const text = data.content?.map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();

    let extracted;
    try { extracted = JSON.parse(clean); }
    catch { return { statusCode: 200, headers, body: JSON.stringify({ error: 'Could not parse extraction', raw: text }) }; }

    // Save extraction record
    let extractionId = null;
    try {
      const saved = await sb('rcti_extraction_examples', {
        method: 'POST',
        body: JSON.stringify({ farm_id, extracted_data: extracted, corrected_data: null, created_at: new Date().toISOString() }),
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
