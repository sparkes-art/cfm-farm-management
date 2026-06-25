// netlify/functions/push-cotton-prices.js
// Receives daily cotton price update from Power Automate
// Secured with COTTON_PRICES_API_KEY header

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const COTTON_PRICES_API_KEY = process.env.COTTON_PRICES_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  // Auth check
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

  const { date, source, audusd, regions, futures, marketUpdate } = body;

  if (!date || !regions) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing date or regions' }) };
  }

  const supabaseHeaders = {
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

    // Upsert cotton prices
    const pricesRes = await fetch(`${SUPABASE_URL}/rest/v1/cotton_prices`, {
      method: 'POST',
      headers: supabaseHeaders,
      body: JSON.stringify(rows),
    });

    if (!pricesRes.ok) {
      const err = await pricesRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Supabase error: ${err}` }) };
    }

    // Store futures if provided
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
        headers: supabaseHeaders,
        body: JSON.stringify(futureRows),
      });
    }

    // Store market update if provided
    if (marketUpdate) {
      await fetch(`${SUPABASE_URL}/rest/v1/cotton_market_updates`, {
        method: 'POST',
        headers: { ...supabaseHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify([{ price_date: date, source: source || 'LDC', update_text: marketUpdate }]),
      });
    }

    console.log(`Cotton prices updated: ${date} — ${rows.length} region/year combinations`);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, date, rows_inserted: rows.length }),
    };

  } catch (err) {
    console.error('push-cotton-prices error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};