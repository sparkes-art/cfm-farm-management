// netlify/functions/push-livestock-prices.js
// Fetches MLA livestock indicator prices — national + saleyard level
// API: https://api-mlastatistics.mla.com.au (no auth required)
// Runs at 8pm UTC = 6am AEST

export const config = { schedule: '0 20 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MLA_API = 'https://api-mlastatistics.mla.com.au';

// All MLA livestock indicators — confirmed from GET /indicator 17 Sep 2026
const ALL_INDICATORS = [
  { id: 0,  name: 'EYCI',                     species: 'Cattle', unit: 'c/kg cwt' },
  { id: 1,  name: 'WYCI',                      species: 'Cattle', unit: 'c/kg cwt' },
  { id: 2,  name: 'Restocker Yearling Steer',  species: 'Cattle', unit: 'c/kg lwt' },
  { id: 3,  name: 'Feeder Steer',              species: 'Cattle', unit: 'c/kg lwt' },
  { id: 4,  name: 'Heavy Steer',               species: 'Cattle', unit: 'c/kg lwt' },
  { id: 5,  name: 'Heavy Dairy Cow',           species: 'Cattle', unit: 'c/kg lwt' },
  { id: 6,  name: 'Light Lamb',                species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 7,  name: 'Trade Lamb',                species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 8,  name: 'Heavy Lamb',                species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 9,  name: 'Merino Lamb',               species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 10, name: 'Restocker Lamb',            species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 11, name: 'Mutton',                    species: 'Sheep',  unit: 'c/kg cwt' },
  { id: 12, name: 'Restocker Yearling Heifer', species: 'Cattle', unit: 'c/kg lwt' },
  { id: 13, name: 'Processor Cow',             species: 'Cattle', unit: 'c/kg lwt' },
  { id: 14, name: 'NYCI',                      species: 'Cattle', unit: 'c/kg lwt' },
  { id: 15, name: 'Online Young Cattle',        species: 'Cattle', unit: 'c/kg lwt' },
  { id: 16, name: 'Online Lamb',               species: 'Sheep',  unit: '$/head'   },
  { id: 17, name: 'Feeder Heifer',             species: 'Cattle', unit: 'c/kg lwt' },
  { id: 18, name: 'Online Sheep',              species: 'Sheep',  unit: '$/head'   },
];

// Saleyards to fetch — pulled from all farms' settings at runtime
// Hardcoding common ones here as a baseline; function also reads from Supabase farms
const BASELINE_SALEYARDS = ['GUN', 'TAM', 'ARM', 'INV', 'DUB', 'SCO'];

async function getAllFarmSaleyards() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/farms?select=settings`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const farms = await res.json();
  const saleyards = new Set(BASELINE_SALEYARDS);
  farms.forEach(f => {
    const ls = f.settings?.livestockSaleyards;
    if (ls?.primary) saleyards.add(ls.primary);
    if (ls?.secondary) saleyards.add(ls.secondary);
    if (ls?.tertiary) saleyards.add(ls.tertiary);
  });
  return [...saleyards];
}

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
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ name }),
  });
  return (await ins.json())?.[0]?.id;
}

async function upsertRows(rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/market_prices`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`Supabase: ${await res.text()}`);
}

async function fetchReport(endpoint, commodityId, regionFn) {
  const res = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.data?.length) return 0;

  const rows = data.data.map(r => ({
    commodity_id: commodityId,
    region: regionFn(r),
    price_per_unit: Math.round(parseFloat(r.indicator_value) * 100) / 100,
    unit: ALL_INDICATORS.find(i => i.id === r.indicator_id)?.unit || 'c/kg lwt',
    price_date: r.calendar_date,
    // Store head_count in attributes for fallback logic
    attributes: r.head_count != null ? { head_count: r.head_count } : null,
  }));

  await upsertRows(rows);
  return rows.length;
}

export default async function handler(req) {
  const url = new URL(req?.url || 'http://localhost');
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const weekAgo   = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const fromDate  = url.searchParams.get('fromDate') || weekAgo;
  const toDate    = url.searchParams.get('toDate')   || yesterday;

  console.log(`[push-livestock-prices] ${fromDate} → ${toDate}`);

  const cattleId = await getOrCreateCommodityId('Cattle');
  const sheepId  = await getOrCreateCommodityId('Sheep');
  const saleyards = await getAllFarmSaleyards();

  console.log(`[push-livestock-prices] Saleyards: ${saleyards.join(', ')}`);

  let totalSaved = 0;
  const errors = [];

  // 1. Fetch national indicators (report/5)
  for (const ind of ALL_INDICATORS) {
    const comId = ind.species === 'Sheep' ? sheepId : cattleId;
    try {
      const endpoint = `${MLA_API}/report/5?indicatorID=${ind.id}&fromDate=${fromDate}&toDate=${toDate}`;
      const saved = await fetchReport(endpoint, comId, r => ind.name);
      totalSaved += saved;
      if (saved) console.log(`[National:${ind.name}] ${saved} rows`);
    } catch(e) {
      errors.push({ type: 'national', name: ind.name, error: e.message });
      console.error(`[National:${ind.name}] ${e.message}`);
    }
  }

  // 2. Fetch saleyard-level data for cattle indicators only (report/6)
  const cattleIndicators = ALL_INDICATORS.filter(i => i.species === 'Cattle');
  for (const ind of cattleIndicators) {
    for (const saleyardId of saleyards) {
      try {
        const endpoint = `${MLA_API}/report/6?indicatorID=${ind.id}&saleyardID=${saleyardId}&fromDate=${fromDate}&toDate=${toDate}`;
        // Region stored as "SALEYARDID:IndicatorName" e.g. "GUN:Heavy Steer"
        const saved = await fetchReport(endpoint, cattleId, r => `${saleyardId}:${ind.name}`);
        totalSaved += saved;
      } catch(e) {
        // Many saleyard/indicator combos have no data — suppress noise
        if (!e.message.includes('HTTP 4')) {
          errors.push({ type: 'saleyard', name: `${saleyardId}:${ind.name}`, error: e.message });
        }
      }
    }
  }

  console.log(`[push-livestock-prices] Done — ${totalSaved} rows, ${errors.length} errors`);
  return new Response(JSON.stringify({ saved: totalSaved, errors: errors.slice(0,10), fromDate, toDate }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
