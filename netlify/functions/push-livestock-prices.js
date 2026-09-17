// netlify/functions/push-livestock-prices.js
// Fetches MLA livestock indicator prices via the MLA Statistics API
// https://www.mla.com.au/prices-markets/statistics/api/
// Runs at 8pm UTC = 6am AEST / 7am AEDT

export const config = { schedule: '0 20 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// MLA Statistics API — public REST, no auth, 100 records per page
// Endpoint confirmed from https://www.mla.com.au/prices-markets/statistics/api/
const MLA_API_BASE = 'https://www.mla.com.au/api/v1';

// The indicators we want — these match the "Indicator" field names in the API response
const TARGET_INDICATORS = [
  { apiName: 'Eastern Young Cattle Indicator', storeName: 'EYCI',            unit: 'c/kg cwt' },
  { apiName: 'National Heavy Steer Indicator', storeName: 'Heavy Steer',     unit: 'c/kg lwt' },
  { apiName: 'National Feeder Steer Indicator',storeName: 'Feeder Steer',    unit: 'c/kg lwt' },
  { apiName: 'Restocker Yearling Heifer',       storeName: 'Restocker Heifer',unit: 'c/kg lwt' },
];

async function fetchLatestIndicators() {
  // Try several likely endpoint patterns — we'll confirm which works from the response
  const endpoints = [
    `${MLA_API_BASE}/livestock-indicators?country=Australia&page=1`,
    `${MLA_API_BASE}/prices/livestock-indicators?page=1`,
    `${MLA_API_BASE}/statistics/livestock-indicators?page=1`,
    `${MLA_API_BASE}/nlrs-indicators?page=1`,
    `https://www.mla.com.au/api/livestock-indicators?page=1`,
    `https://api.mla.com.au/v1/livestock-indicators?page=1`,
  ];

  for (const url of endpoints) {
    try {
      console.log(`[MLA] Trying: ${url}`);
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'CFM-FarmManagement/1.0 (insights@cfma.com.au)',
        },
      });
      console.log(`[MLA] ${url} → ${res.status} ${res.headers.get('content-type')}`);
      if (res.ok) {
        const data = await res.json();
        console.log(`[MLA] Success! Keys: ${Object.keys(data).join(', ')}, Sample: ${JSON.stringify(data).slice(0, 300)}`);
        return { url, data };
      }
    } catch (e) {
      console.log(`[MLA] ${url} → Error: ${e.message}`);
    }
  }
  return null;
}

async function getOrCreateCommodityId() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/commodities?name=eq.Cattle%20Indicators&select=id`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const data = await res.json();
  if (data?.[0]?.id) return data[0].id;

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/commodities`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ name: 'Cattle Indicators' }),
  });
  const insData = await ins.json();
  return insData?.[0]?.id;
}

async function saveIndicator(commodityId, name, price, unit, date) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/market_prices`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{
      commodity_id: commodityId,
      region: name,
      price_per_unit: price,
      unit,
      price_date: date,
    }]),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`[${name}] Save failed: ${err}`);
    return false;
  }
  console.log(`[${name}] Saved: ${price} ${unit} on ${date}`);
  return true;
}

export default async function handler() {
  console.log('[push-livestock-prices] Starting MLA Statistics API fetch...');

  const result = await fetchLatestIndicators();
  
  if (!result) {
    console.error('[push-livestock-prices] All API endpoints failed');
    return new Response(JSON.stringify({ error: 'All endpoints failed' }), { status: 500 });
  }

  const { url, data } = result;
  console.log(`[push-livestock-prices] Got data from: ${url}`);

  // Parse the response — handle different possible response shapes
  const records = data?.data || data?.records || data?.results || 
                  (Array.isArray(data) ? data : null);

  if (!records?.length) {
    console.log('[push-livestock-prices] No records found in response:', JSON.stringify(data).slice(0, 500));
    return new Response(JSON.stringify({ error: 'No records', response: data }), { status: 200 });
  }

  console.log(`[push-livestock-prices] Got ${records.length} records. First: ${JSON.stringify(records[0])}`);

  const commodityId = await getOrCreateCommodityId();
  if (!commodityId) {
    return new Response(JSON.stringify({ error: 'Could not get commodity ID' }), { status: 500 });
  }

  // Find the most recent date in the data
  const today = new Date().toISOString().split('T')[0];
  let saved = 0;

  for (const indicator of TARGET_INDICATORS) {
    // Find matching record — try several field name patterns
    const match = records.find(r =>
      r.Indicator === indicator.apiName ||
      r.indicator === indicator.apiName ||
      r.IndicatorName === indicator.apiName ||
      r.indicator_name === indicator.apiName ||
      r.name === indicator.apiName
    );

    if (!match) {
      console.log(`[${indicator.storeName}] Not found in response. Available: ${[...new Set(records.map(r => r.Indicator || r.indicator || r.name))].slice(0,5).join(', ')}`);
      continue;
    }

    // Extract price value — try several field name patterns
    const price = parseFloat(
      match['Indicator Value'] ?? match.IndicatorValue ?? match.indicator_value ??
      match.Price ?? match.price ?? match.value ?? match.Value ?? 0
    );

    // Extract date
    const dateStr = match.Date ?? match.date ?? match.WeekEnding ?? match.week_ending ?? today;
    const date = dateStr.includes('/') 
      ? dateStr.split('/').reverse().join('-')  // DD/MM/YYYY → YYYY-MM-DD
      : dateStr.split('T')[0];

    if (!price || isNaN(price)) {
      console.log(`[${indicator.storeName}] No valid price in record: ${JSON.stringify(match)}`);
      continue;
    }

    const ok = await saveIndicator(commodityId, indicator.storeName, price, indicator.unit, date);
    if (ok) saved++;
  }

  console.log(`[push-livestock-prices] Done — saved ${saved}/${TARGET_INDICATORS.length}`);
  return new Response(JSON.stringify({ saved, total: TARGET_INDICATORS.length, sourceUrl: url }), {
    headers: { 'Content-Type': 'application/json' },
  });
}