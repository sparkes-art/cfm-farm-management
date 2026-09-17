// netlify/functions/push-livestock-saleyards.js
// Fetches ALL saleyard-level MLA livestock indicator prices globally
// No farm dependency — stores everything, farms filter their view
// 8 API calls per day (one per cattle indicator), ~3 seconds
// Runs at 8:30pm UTC = 6:30am AEST, 30 mins after national indicators

export const config = { schedule: '30 20 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MLA_API = 'https://api-mlastatistics.mla.com.au';

// Cattle indicators with saleyard-level reporting confirmed from API 18 Sep 2026
// /report/6 without saleyardID returns all saleyards in one call
const CATTLE_INDICATORS = [
  { id: 0,  name: 'EYCI',                     unit: 'c/kg cwt' },
  { id: 2,  name: 'Restocker Yearling Steer',  unit: 'c/kg lwt' },
  { id: 3,  name: 'Feeder Steer',              unit: 'c/kg lwt' },
  { id: 4,  name: 'Heavy Steer',               unit: 'c/kg lwt' },
  { id: 5,  name: 'Heavy Dairy Cow',           unit: 'c/kg lwt' },
  { id: 12, name: 'Restocker Yearling Heifer', unit: 'c/kg lwt' },
  { id: 13, name: 'Processor Cow',             unit: 'c/kg lwt' },
  { id: 17, name: 'Feeder Heifer',             unit: 'c/kg lwt' },
];

async function getCattleId() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/commodities?name=eq.Cattle%20Indicators&select=id`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  return (await res.json())?.[0]?.id;
}

async function fetchAllSaleyards(indicatorId, fromDate, toDate) {
  // Fetch all pages for this indicator
  const rows = [];
  let page = 1;
  while (true) {
    const url = `${MLA_API}/report/6?indicatorID=${indicatorId}&fromDate=${fromDate}&toDate=${toDate}&page=${page}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) break;
    const data = await res.json();
    if (!data?.data?.length) break;
    rows.push(...data.data);
    if (data.data.length < 100) break;
    page++;
  }
  return rows;
}

export default async function handler(req) {
  const url = new URL(req?.url || 'http://localhost');
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const fromDate  = url.searchParams.get('fromDate') || yesterday;
  const toDate    = url.searchParams.get('toDate')   || yesterday;

  console.log(`[push-livestock-saleyards] ${fromDate} → ${toDate}`);

  const cattleId = await getCattleId();
  if (!cattleId) return new Response(JSON.stringify({ error: 'No cattle commodity ID' }), { status: 500 });

  let totalSaved = 0;

  // Fetch all indicators in parallel — only 8 calls
  const results = await Promise.all(
    CATTLE_INDICATORS.map(async ind => {
      const rows = await fetchAllSaleyards(ind.id, fromDate, toDate);
      console.log(`[${ind.name}] ${rows.length} saleyard rows`);

      if (!rows.length) return 0;

      // For each saleyard, keep only the most recent date with actual sales
      const bySaleyard = {};
      for (const r of rows) {
        if (!r.head_count || r.head_count === 0) continue;
        const key = r.saleyard_id;
        if (!bySaleyard[key] || r.calendar_date > bySaleyard[key].calendar_date) {
          bySaleyard[key] = r;
        }
      }

      const upsertRows = Object.values(bySaleyard).map(r => ({
        commodity_id: cattleId,
        region: `${r.saleyard_id}:${ind.name}`,
        price_per_unit: Math.round(parseFloat(r.indicator_value) * 100) / 100,
        unit: ind.unit,
        price_date: r.calendar_date,
        attributes: { head_count: r.head_count },
      }));

      if (!upsertRows.length) return 0;

      const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/market_prices`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(upsertRows),
      });

      if (!upsertRes.ok) {
        console.error(`[${ind.name}] Upsert failed: ${await upsertRes.text()}`);
        return 0;
      }

      return upsertRows.length;
    })
  );

  totalSaved = results.reduce((a, b) => a + b, 0);
  console.log(`[push-livestock-saleyards] Done — ${totalSaved} rows saved`);

  return new Response(JSON.stringify({ saved: totalSaved, fromDate, toDate }), {
    headers: { 'Content-Type': 'application/json' },
  });
}