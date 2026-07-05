// netlify/functions/push-cotton-prices.js
// Receives daily LDC Cotton PDF from Power Automate
// Extracts prices using Claude API, stores in cotton_prices table

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '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';
const COTTON_PRICES_API_KEY = process.env.COTTON_PRICES_API_KEY || 'cfm-ldc-cotton-2026-xxxx';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];
  if (!COTTON_PRICES_API_KEY || apiKey !== COTTON_PRICES_API_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Support both old structured format and new PDF format
  if (body.date && body.regions) {
    // Old format — pre-extracted data, process directly
    return await _processExtracted(body, headers);
  }

  if (body.pdfBase64) {
    // New format — extract from PDF first
    return await _extractAndProcess(body.pdfBase64, headers);
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing pdfBase64 or date/regions' }) };
};

async function _extractAndProcess(pdfBase64, headers) {
  try {
    console.log('Extracting cotton prices from PDF via Claude...');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 }
            },
            {
              type: 'text',
              text: `Extract the cotton lint prices from this LDC daily pricing PDF.

Return ONLY a JSON object, no other text:
{
  "date": "YYYY-MM-DD",
  "audusd": 0.0000,
  "regions": {
    "Central QLD": {"2026": 000, "2027": 000},
    "Darling Downs": {"2026": 000, "2027": 000},
    "MacIntyre": {"2026": 000, "2027": 000},
    "Gwydir": {"2026": 000, "2027": 000},
    "LDC Moree": {"2026": 000, "2027": 000},
    "Mungindi/St George": {"2026": 000, "2027": 000},
    "Namoi Valley": {"2026": 000, "2027": 000},
    "Macquarie Valley": {"2026": 000, "2027": 000},
    "Lachlan/Sth NSW": {"2026": 000, "2027": 000},
    "NT / WA": {"2026": null, "2027": null}
  },
  "futures": [
    {"month": "Jul 26", "price": 00.00, "change": -0.00}
  ],
  "marketUpdate": "brief summary of market update text"
}

Use the date shown on the PDF. Use null for POA prices. Extract the AUD/USD spot rate.`
            }
          ]
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error('Claude API error: ' + err);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.map(b => b.text || '').join('') || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(clean);

    console.log('Extracted date:', extracted.date, 'regions:', Object.keys(extracted.regions || {}).length);
    return await _processExtracted(extracted, headers);

  } catch (err) {
    console.error('Cotton extraction error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
}

async function _processExtracted(data, headers) {
  const { date, source, audusd, regions, futures, marketUpdate } = data;

  if (!date || !regions) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing date or regions' }) };
  }

  const serviceHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Prefer': 'resolution=merge-duplicates',
  };

  try {
    // Build rows for each region × crop_year
    const rows = [];
    for (const [region, prices] of Object.entries(regions)) {
      for (const [cropYear, price] of Object.entries(prices)) {
        if (price === null) continue;
        rows.push({
          price_date: date,
          source: source || 'LDC',
          region,
          crop_year: parseInt(cropYear),
          price_aud: price,
          audusd: audusd || null,
        });
      }
    }

    const pricesRes = await fetch(`${SUPABASE_URL}/rest/v1/cotton_prices`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify(rows),
    });

    if (!pricesRes.ok) {
      const err = await pricesRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase error: ' + err }) };
    }

    // Store futures
    if (futures && futures.length) {
      const futureRows = futures.map(f => ({
        price_date: date,
        contract_month: f.month,
        price_usd: f.price,
        change: f.change,
        audusd: audusd || null,
      }));
      await fetch(`${SUPABASE_URL}/rest/v1/cotton_futures`, {
        method: 'POST',
        headers: serviceHeaders,
        body: JSON.stringify(futureRows),
      });
    }

    // Store market update
    if (marketUpdate) {
      await fetch(`${SUPABASE_URL}/rest/v1/cotton_market_updates`, {
        method: 'POST',
        headers: serviceHeaders,
        body: JSON.stringify([{ price_date: date, source: source || 'LDC', update_text: marketUpdate }]),
      });
    }

    console.log('Cotton prices updated:', date, '—', rows.length, 'rows');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, date, rows_inserted: rows.length }),
    };

  } catch (err) {
    console.error('Cotton process error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
}
