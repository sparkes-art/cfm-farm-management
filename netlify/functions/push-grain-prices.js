// netlify/functions/push-grain-prices.js
// Receives daily LDC Grains SE PDF from Power Automate
// Extracts site prices for configured grades using Claude API
// Stores in market_prices table per commodity

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GRAIN_PRICES_API_KEY = process.env.GRAIN_PRICES_API_KEY;

// Grades to extract per commodity (first/primary grade only)
const GRADE_MAP = {
  Wheat: 'APW1',
  Barley: 'BAR1',
  Canola: 'CAN1',
  'Faba Beans': 'FAB2',
  Lentils: 'NIPT1',
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Auth check
  const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'];
  if (!GRAIN_PRICES_API_KEY || apiKey !== GRAIN_PRICES_API_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { pdf_base64, date } = body;
  if (!pdf_base64 || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing pdf_base64 or date' }) };
  }

  try {
    // Extract prices from PDF using Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
            },
            {
              type: 'text',
              text: `Extract grain prices from this LDC Grains Australia pricing PDF.

For each delivery site listed, extract the price for these specific grades only:
- Wheat: APW1
- Barley: BAR1  
- Canola: CAN1
- Faba Beans: FAB2 (if present)
- Lentils: NIPT1 (if present)

Return ONLY a JSON object in this exact format, no other text:
{
  "sites": {
    "SITE NAME": {
      "Wheat": { "grade": "APW1", "price": 309.25 },
      "Barley": { "grade": "BAR1", "price": 263.00 },
      "Canola": { "grade": "CAN1", "price": 710.50 },
      "Faba Beans": { "grade": "FAB2", "price": 180.00 },
      "Lentils": { "grade": "NIPT1", "price": null }
    }
  }
}

Use null for any grade/site combination where a price is not listed. Use the exact site names as they appear in the PDF. Include ALL sites listed in the PDF.`
            }
          ]
        }]
      })
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const claudeData = await claudeRes.json();
    const text = claudeData.content?.map(b => b.text || '').join('') || '';

    let extracted;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      extracted = JSON.parse(clean);
    } catch {
      throw new Error('Could not parse Claude response: ' + text.slice(0, 200));
    }

    // Fetch commodities from Supabase to get IDs
    const commRes = await fetch(`${SUPABASE_URL}/rest/v1/commodities?select=id,name`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      }
    });
    const commodities = await commRes.json();
    const commMap = {};
    commodities.forEach(c => { commMap[c.name.toLowerCase()] = c.id; });

    // Build rows for market_prices
    const rows = [];
    for (const [siteName, pricesByCommodity] of Object.entries(extracted.sites || {})) {
      for (const [commodity, data] of Object.entries(pricesByCommodity)) {
        if (!data?.price) continue;
        const commodityId = commMap[commodity.toLowerCase()];
        if (!commodityId) continue;

        rows.push({
          price_date: date,
          commodity_id: commodityId,
          commodity: commodity,
          price_per_unit: data.price,
          unit: 't',
          source: 'LDC Grains SE',
          region: siteName,
          grade: data.grade,
        });
      }
    }

    if (!rows.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No prices extracted', sites: Object.keys(extracted.sites || {}).length }) };
    }

    // Upsert into market_prices
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/market_prices`, {
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
      throw new Error(`Supabase upsert error: ${err}`);
    }

    console.log(`Grain prices updated: ${date} — ${rows.length} site/commodity combinations across ${Object.keys(extracted.sites || {}).length} sites`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        date,
        sites_processed: Object.keys(extracted.sites || {}).length,
        rows_inserted: rows.length,
      }),
    };

  } catch (err) {
    console.error('push-grain-prices error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
