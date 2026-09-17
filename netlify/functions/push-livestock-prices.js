// netlify/functions/push-livestock-prices.js
// Fetches ALL MLA livestock indicator prices daily and stores globally
// No farm_id — master data table, farms filter by their settings.livestockIndicators
// API: https://api-mlastatistics.mla.com.au (no auth required)
// Updated by MLA at 12am AEST daily — we run at 8pm UTC = 6am AEST

export const config = { schedule: '0 20 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MLA_API = 'https://api-mlastatistics.mla.com.au';

// All 19 MLA indicators — confirmed from GET /indicator on 17 Sep 2026
const ALL_INDICATORS = [
  { id: 0,  name: 'EYCI',                       species: 'Cattle', unit: 'c/kg cwt' },
  { id: 1,  name: 'WYCI',                        species: 'Cattle', unit: 'c/kg cwt' },
  { id: 2,  name: 'Restocker Yearling Steer',    species: 'Cattle', unit: 'c/kg lwt' },
  { id: 3,  name: 'Feeder Steer',                species: 'Cattle', unit: 'c/kg lwt' },
  { id: 4,  name: 'Heavy Steer',                 species: 'Cattle', unit: 'c/kg lwt' },
  { id: 5,  name: 'Heavy Dairy Cow',             species: 'Cattle', unit: 'c/kg lwt' },
  { id: 6,  name: 'Light Lamb',                  species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 7,  name: 'Trade Lamb',                  species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 8,  name: 'Heavy Lamb',                  species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 9,  name: 'Merino Lamb',                 species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 10, name: 'Restocker Lamb',              species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 11, name: 'Mutton',                      species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 12, name: 'Restocker Yearling Heifer',   species: 'Cattle', unit: 'c/kg lwt' },
  { id: 13, name: 'Processor Cow',               species: 'Cattle', unit: 'c/kg lwt' },
  { id: 14, name: 'NYCI',                        species: 'Cattle', unit: 'c/kg lwt' },
  { id: 15, name: 'Online Young Cattle',         species: 'Cattle', unit: 'c/kg lwt' },
  { id: 16, name: 'Online Lamb',                 species: 'Sheep',  unit: '$/head'   },
  { id: 17, name: 'Feeder Heifer',               species: 'Cattle', unit: 'c/kg lwt' },
  { id: 18, name: 'Online Sheep',                species: 'Sheep',  unit: '$/head'   },
];

async function getOrCreateCommodityId(species) {
  const name = species === 'Sheep' ? 'Sheep Indicators' : 'Cattle Indicators';
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/commodities?name=eq.${encodeURIComponent(name)}&select=id`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const rows = await res.json();
  if (rows?.[0]?.id) return rows[0].id;

  const ins = await fetch(`${SUPABASE_URL}/rest/v1/commodities`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify({ name }),
  });
  return (await ins.json())?.[0]?.id;
}

async function fetchAndSave(indicator, fromDate, toDate, commodityId) {
  const url = `${MLA_API}/report/5?indicatorID=${indicator.id}&fromDate=${fromDate}&toDate=${toDate}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.data?.length) {
    console.log(`[${indicator.name}] No data returned`);
    return 0;
  }

  // Upsert all rows for this indicator in one batch
  const rows = data.data.map(r => ({
    commodity_id: commodityId,
    region: indicator.name,
    price_per_unit: Math.round(parseFloat(r.indicator_value) * 100) / 100,
    unit: indicator.unit,
    price_date: r.calendar_date,
  }));

  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/market_prices`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });

  if (!upsertRes.ok) throw new Error(`Supabase: ${await upsertRes.text()}`);
  console.log(`[${indicator.name}] Saved ${rows.length} days`);
  return rows.length;
}

export default async function handler(req) {
  // Allow manual trigger with backfill param: ?fromDate=2026-01-01
  const url = new URL(req?.url || 'http://localhost');
  const manualFrom = url.searchParams.get('fromDate');
  const manualTo   = url.searchParams.get('toDate');

  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const fromDate  = manualFrom || weekAgo;
  const toDate    = manualTo   || yesterday;

  console.log(`[push-livestock-prices] Fetching ${fromDate} → ${toDate}`);

  // Get/create commodity IDs
  const cattleId = await getOrCreateCommodityId('Cattle');
  const sheepId  = await getOrCreateCommodityId('Sheep');
  if (!cattleId || !sheepId) {
    return new Response(JSON.stringify({ error: 'Could not get commodity IDs' }), { status: 500 });
  }

  let totalSaved = 0;
  const errors = [];

  for (const indicator of ALL_INDICATORS) {
    const commodityId = indicator.species === 'Sheep' ? sheepId : cattleId;
    try {
      const saved = await fetchAndSave(indicator, fromDate, toDate, commodityId);
      totalSaved += saved;
    } catch (e) {
      console.error(`[${indicator.name}] Failed: ${e.message}`);
      errors.push({ name: indicator.name, error: e.message });
    }
  }

  console.log(`[push-livestock-prices] Done — ${totalSaved} rows saved, ${errors.length} errors`);
  return new Response(JSON.stringify({ saved: totalSaved, errors, fromDate, toDate }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
