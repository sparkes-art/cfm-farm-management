// netlify/functions/push-cotton-prices.js
// Receives LDC Cotton price PDF/PNG from Power Automate
// Extracts prices using Claude, stores in Supabase cotton_prices table

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const COTTON_PRICES_API_KEY = process.env.COTTON_PRICES_API_KEY || 'test123';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

function detectFileType(base64) {
  if (base64.startsWith('iVBORw0KGgo')) return { type: 'image', mediaType: 'image/png' };
  if (base64.startsWith('/9j/'))         return { type: 'image', mediaType: 'image/jpeg' };
  if (base64.startsWith('JVBER'))        return { type: 'pdf',   mediaType: 'application/pdf' };
  try {
    const buf = Buffer.from(base64.slice(0, 20), 'base64');
    const hex = buf.toString('hex').toUpperCase();
    const ascii = buf.toString('ascii');
    if (ascii.startsWith('%PDF'))   return { type: 'pdf',   mediaType: 'application/pdf' };
    if (hex.startsWith('89504E47')) return { type: 'image', mediaType: 'image/png' };
    if (hex.startsWith('FFD8FF'))   return { type: 'image', mediaType: 'image/jpeg' };
  } catch(e) {}
  return null;
}

function unwrapBase64(raw) {
  let data = raw;
  if (data.includes(',')) data = data.split(',').pop();
  data = data.replace(/[\s\r\n\t]/g, '');
  let fileInfo = detectFileType(data);
  if (fileInfo) return { data, fileInfo };
  // Try double-encoded
  try {
    const decoded = Buffer.from(data, 'base64').toString('utf8').replace(/[\s\r\n\t]/g, '');
    fileInfo = detectFileType(decoded);
    if (fileInfo) return { data: decoded, fileInfo, wasDoubleEncoded: true };
  } catch(e) {}
  return { data, fileInfo: null };
}

const PROMPT = `This is an LDC (Louis Dreyfus Company) daily cotton price update for Australia.
Extract all data and return ONLY a JSON object with this exact structure:
{
  "date": "YYYY-MM-DD",
  "source": "LDC",
  "audusd": number,
  "regions": {
    "Central QLD":        { "2026": number or null, "2027": number or null },
    "Darling Downs":      { "2026": number or null, "2027": number or null },
    "MacIntyre":          { "2026": number or null, "2027": number or null },
    "Gwydir":             { "2026": number or null, "2027": number or null },
    "LDC Moree":          { "2026": number or null, "2027": number or null },
    "Mungindi/St George": { "2026": number or null, "2027": number or null },
    "Namoi Valley":       { "2026": number or null, "2027": number or null },
    "Macquarie Valley":   { "2026": number or null, "2027": number or null },
    "Lachlan/Sth NSW":    { "2026": number or null, "2027": number or null },
    "NT / WA":            { "2026": null, "2027": null }
  },
  "futures": [
    { "contract": "Jul 26", "price": number, "change": number }
  ],
  "marketUpdate": "first sentence of market update only"
}
For POA prices use null. Prices are in AUD $/bale. Return ONLY valid JSON, no explanation or markdown.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];
  if (apiKey !== COTTON_PRICES_API_KEY) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  let pdfBase64;
  try {
    ({ pdfBase64 } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!pdfBase64) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Attachment data required' }) };

  console.log('Received data, length:', pdfBase64.length, 'first 20:', pdfBase64.substring(0, 20));

  const { data: cleanData, fileInfo, wasDoubleEncoded } = unwrapBase64(pdfBase64);

  if (!fileInfo) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({
        error: 'Unrecognised file type',
        hint: `First 30 chars: ${pdfBase64.slice(0, 30)}`,
        decoded20: Buffer.from(pdfBase64.slice(0, 20), 'base64').toString('hex').toUpperCase()
      })
    };
  }

  console.log('File type detected:', fileInfo.type, fileInfo.mediaType, wasDoubleEncoded ? '(was double-encoded)' : '');

  const contentBlock = fileInfo.type === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: cleanData } }
    : { type: 'image',    source: { type: 'base64', media_type: fileInfo.mediaType,  data: cleanData } };

  const claudeHeaders = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (fileInfo.type === 'pdf') claudeHeaders['anthropic-beta'] = 'pdfs-2024-09-25';

  try {
    console.log('Calling Claude...');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: claudeHeaders,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: PROMPT }] }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);

    const claudeData = await response.json();
    const text = claudeData.content?.map(c => c.text || '').join('') || '';
    console.log('Claude response received, length:', text.length);

    const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response: ' + text.slice(0, 200));
    const extracted = JSON.parse(match[0]);

    // Store in Supabase cotton_prices table
    const rows = [];
    const date = extracted.date;
    const audusd = extracted.audusd;

    for (const [region, prices] of Object.entries(extracted.regions || {})) {
      for (const [cropYear, price] of Object.entries(prices)) {
        if (price === null) continue;
        rows.push({
          price_date: date,
          region,
          crop_year: cropYear,
          price_aud: price,
          audusd,
          source: 'LDC',
        });
      }
    }

    if (rows.length) {
      const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/cotton_prices`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates return=minimal',
        },
        body: JSON.stringify(rows),
      });
      if (!upsertRes.ok) {
        const err = await upsertRes.text();
        console.error('Supabase error:', err);
        throw new Error('Supabase upsert failed: ' + err);
      }
      console.log('Stored', rows.length, 'price rows for', date);
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        success: true,
        date,
        fileType: fileInfo.type,
        wasDoubleEncoded: wasDoubleEncoded || false,
        rows_stored: rows.length,
        regions: Object.keys(extracted.regions || {}),
      })
    };

  } catch (err) {
    console.error('Extraction failed:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Extraction failed', message: err.message }) };
  }
};