// netlify/functions/push-cropconnect-prices.js
// Fetches live grain bid prices from GrainCorp CropConnect public API
// Stores daily best price per site/commodity/grade in market_prices
// Runs alongside push-grain-prices.js (LDC) until confirmed working
// API: https://cropconnect.com.au/sap/opu/odata/SAP/BID_PUBLIC — no auth required
// Runs at 7pm UTC = 5am AEST (before LDC at 8pm UTC)

export const config = { schedule: '0 19 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CC_API = 'https://cropconnect.com.au/sap/opu/odata/SAP/BID_PUBLIC';
const CC_HEADERS = { Accept: 'application/json', 'User-Agent': 'CFM-FarmManagement/1.0 (insights@cfma.com.au)' };

// CropConnect commodity names → our commodity names
// Confirmed from GET /MATERIAL_PUBLIC/Commodity on 17 Sep 2026
const COMMODITY_MAP = {
  'Wheat':      'Wheat',
  'Barley':     'Barley',
  'Canola':     'Canola',
  'Chickpeas':  'Chickpeas',
  'Faba Beans': 'Faba Beans',
  'Lentils':    'Lentils',
  'Sorghum':    'Sorghum',
  'Oats':       'Oats',
  'Durum':      'Durum',
  'Field Peas': 'Field Peas',
};

// Grade priority per commodity — which grade to show as the primary price
// Configurable per farm in settings but these are the defaults
const DEFAULT_GRADES = {
  'Wheat':      ['APW1', 'APW', 'ASW1', 'ASW'],
  'Barley':     ['BAR1', 'BAR', 'F1BAR', 'FBAR'],
  'Canola':     ['CAN1', 'CAN', 'CNTW'],
  'Chickpeas':  ['DESI1', 'DESI', 'KABULI'],
  'Faba Beans': ['FAB1', 'FAB2', 'FAB'],
  'Lentils':    ['LEN1', 'LENTIL'],
  'Sorghum':    ['SOR1', 'SOR', 'SRG'],
  'Oats':       ['OAT1', 'OAT', 'FEED'],
  'Durum':      ['DUR1', 'DUR'],
  'Field Peas': ['FP1', 'FP'],
};

async function getAllBids() {
  // Step 1: hit BID_PUBLIC service root to establish SAP session
  const sessionRes = await fetch(
    'https://cropconnect.com.au/sap/opu/odata/SAP/BID_PUBLIC/?$format=json',
    { headers: { ...CC_HEADERS, 'x-csrf-token': 'Fetch' } }
  );
  const rawCookie = sessionRes.headers.get('set-cookie') || '';
  const sessionCookie = rawCookie.split(',').map(c => c.split(';')[0].trim()).join('; ');
  console.log(`[push-cropconnect-prices] Session: ${sessionRes.status}, cookie: ${sessionCookie ? 'yes' : 'none'}`);

  const bidHeaders = { ...CC_HEADERS, Accept: 'application/json' };
  if (sessionCookie) bidHeaders['Cookie'] = sessionCookie;

  // Step 2: page through all bids in batches of 100 using $skip
  const PAGE = 100;
  let allResults = [];
  let skip = 0;

  while (true) {
    const url = `https://cropconnect.com.au/sap/opu/odata/SAP/BID_PUBLIC/AllBidsSet?$top=${PAGE}&$skip=${skip}&$inlinecount=allpages&$format=json`;
    const res = await fetch(url, { headers: bidHeaders });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Page ${skip}-${skip+PAGE} error: ${res.status} — ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const results = data.d.results;
    const total = parseInt(data.d.__count || '0');
    allResults = allResults.concat(results);
    console.log(`[push-cropconnect-prices] Page ${skip}: got ${results.length} (total: ${total})`);
    if (allResults.length >= total || results.length < PAGE) break;
    skip += PAGE;
  }

  return allResults;
}

async function getOrCreateCommodityId(name) {
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

async function upsertPrices(rows) {
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
  if (!res.ok) throw new Error(`Supabase upsert failed: ${await res.text()}`);
}

export default async function handler(req) {
  const today = new Date().toISOString().split('T')[0];
  console.log(`[push-cropconnect-prices] Starting for ${today}`);

  // Fetch all bids
  let bids;
  try {
    bids = await getAllBids();
    console.log(`[push-cropconnect-prices] Got ${bids.length} bids`);
  } catch(e) {
    console.error('[push-cropconnect-prices] Failed to fetch bids:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }

  // Group bids by commodity → site → grade, keeping best price
  // Structure: { commodityDesc: { siteName: { grade: maxPrice } } }
  const grouped = {};
  for (const bid of bids) {
    const com = bid.CommodityDesc;
    if (!COMMODITY_MAP[com]) continue; // skip commodities we don't track
    const site = bid.SiteName;
    const grade = bid.Grade;
    const price = parseFloat(bid.Price);
    if (!site || !grade || isNaN(price) || price <= 0) continue;

    if (!grouped[com]) grouped[com] = {};
    if (!grouped[com][site]) grouped[com][site] = {};
    // Keep best (highest) price for this grade at this site
    if (!grouped[com][site][grade] || price > grouped[com][site][grade]) {
      grouped[com][site][grade] = price;
    }
  }

  // Build rows to upsert
  // Region format: "SITENAME|GRADE" e.g. "Goolgowi|APW1"
  // This lets farm settings pick site+grade combination
  const commodityIds = {};
  const upsertRows = [];

  for (const [comDesc, sites] of Object.entries(grouped)) {
    const comName = COMMODITY_MAP[comDesc];
    if (!commodityIds[comName]) {
      commodityIds[comName] = await getOrCreateCommodityId(comName);
    }
    const commodityId = commodityIds[comName];
    if (!commodityId) continue;

    for (const [siteName, grades] of Object.entries(sites)) {
      for (const [grade, price] of Object.entries(grades)) {
        upsertRows.push({
          commodity_id: commodityId,
          region: `${siteName}|${grade}`,  // "Goolgowi|APW1"
          price_per_unit: Math.round(price * 100) / 100,
          unit: 't',
          price_date: today,
          source_label: 'CropConnect',
        });
      }
    }
  }

  // Upsert in batches of 200
  const BATCH = 200;
  let saved = 0;
  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const batch = upsertRows.slice(i, i + BATCH);
    try {
      await upsertPrices(batch);
      saved += batch.length;
    } catch(e) {
      console.error(`[push-cropconnect-prices] Batch ${i}-${i+BATCH} failed:`, e.message);
    }
  }

  console.log(`[push-cropconnect-prices] Done — ${saved}/${upsertRows.length} rows saved`);
  return new Response(JSON.stringify({
    saved, total: upsertRows.length, date: today,
    commodities: Object.keys(grouped),
  }), { headers: { 'Content-Type': 'application/json' } });
}