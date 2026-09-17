// netlify/functions/push-livestock-prices.js
// Fetches MLA livestock indicator prices daily via Power BI embed tokens
// Runs at 6am AEST (20:00 UTC)

export const config = { schedule: '0 20 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// MLA indicators to fetch — slug maps to getembedinfo endpoint
// Confirmed working slugs from browser inspection 17 Sep 2026
const INDICATORS = [
  { slug: 'eyci',        name: 'EYCI',         label: 'Eastern Young Cattle Indicator', unit: 'c/kg cwt', pageSlug: 'eycireport' },
  { slug: 'heavysteer',  name: 'Heavy Steer',  label: 'Heavy Steer Indicator',          unit: 'c/kg lwt', pageSlug: 'heavysteer' },
  { slug: 'feedersteer', name: 'Feeder Steer', label: 'Feeder Steer Indicator',         unit: 'c/kg lwt', pageSlug: 'feedersteer' },
  { slug: 'restockeryearlingheifer', name: 'Restocker Heifer', label: 'Restocker Yearling Heifer', unit: 'c/kg lwt', pageSlug: 'restockeryearlingheifer' },
];

// Power BI DAX query to get the latest price and date from the dataset
// The table/column names are inferred from standard MLA indicator report structure
const buildDaxQuery = (reportId) => ({
  queries: [{
    query: `
      EVALUATE
      TOPN(
        1,
        SELECTCOLUMNS(
          'Indicator',
          "Date", 'Indicator'[Date],
          "Price", 'Indicator'[Price]
        ),
        'Indicator'[Date], DESC
      )
    `
  }],
  serializerSettings: { includeNulls: true },
});

async function fetchIndicator(indicator) {
  try {
    // Step 1: Get Power BI embed token (no auth required)
    const embedRes = await fetch(
      `https://app.nlrsreports.mla.com.au/indicators/${indicator.slug}/getembedinfo`,
      { headers: { 'User-Agent': 'CFM-FarmManagement/1.0 (samuel@cfm.com.au)' } }
    );
    if (!embedRes.ok) throw new Error(`getembedinfo ${embedRes.status}`);
    const embedData = await embedRes.json();

    const accessToken = embedData.accessToken;
    const reportConfig = embedData.reportConfig?.[0];
    const datasetId = reportConfig?.datasetId;
    const groupId = embedData.groupId;

    if (!accessToken) throw new Error('No access token in embed response');

    // Step 2: If we have a datasetId, query it directly
    // Otherwise fall back to scraping the HTML page for the latest value
    if (datasetId && groupId) {
      const queryUrl = `https://api.powerbi.com/v1.0/myorg/groups/${groupId}/datasets/${datasetId}/executeQueries`;
      const queryRes = await fetch(queryUrl, {
        method: 'POST',
        headers: {
          'Authorization': `EmbedToken ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildDaxQuery(datasetId)),
      });

      if (queryRes.ok) {
        const data = await queryRes.json();
        const rows = data?.results?.[0]?.tables?.[0]?.rows;
        if (rows?.length) {
          return {
            indicator: indicator.name,
            label: indicator.label,
            unit: indicator.unit,
            price: parseFloat(rows[0]['[Price]']),
            date: rows[0]['[Date]']?.split('T')[0] || new Date().toISOString().split('T')[0],
          };
        }
      }
    }

    // Step 3: Fallback — scrape the indicator page HTML for the current value
    // MLA URLs: https://www.mla.com.au/prices-markets/cattle/{pageSlug}/
    const mlaUrl = `https://www.mla.com.au/prices-markets/cattle/${indicator.pageSlug}/`;
    const pageRes = await fetch(mlaUrl, {
      headers: { 'User-Agent': 'CFM-FarmManagement/1.0 (samuel@cfm.com.au)' }
    });
    if (!pageRes.ok) throw new Error(`Page fetch ${pageRes.status} for ${mlaUrl}`);
    const html = await pageRes.text();

    // Log a snippet to help debug if extraction fails
    const snippet = html.slice(0, 3000);
    console.log(`[${indicator.name}] Page fetched (${html.length} chars), snippet:`, snippet);

    // Try multiple extraction patterns
    // Cattle indicators are typically 200-800 c/kg — avoid matching years like 2026
    const priceMatch =
      html.match(/(\d{3}(?:\.\d+)?)\s*(?:c\/kg|¢\/kg|cents per kg)/i) ||
      html.match(/data-value="(\d{3}(?:\.\d+)?)"/i) ||
      html.match(/"currentValue"\s*:\s*(\d{3}(?:\.\d+)?)/i) ||
      html.match(/class="[^"]*(?:indicator-value|current-price|price-value)[^"]*"[^>]*>\s*(\d{3}(?:\.\d+)?)/i) ||
      html.match(/<strong[^>]*>\s*(\d{3}(?:\.\d+)?)\s*<\/strong>/i);

    if (priceMatch) {
      const price = parseFloat(priceMatch[1]);
      // Sanity check — cattle indicators should be 100-1500 c/kg
      if (price < 100 || price > 1500) {
        console.error(`[${indicator.name}] Price ${price} out of expected range (100-1500), likely a parsing error`);
      } else {
        return {
          indicator: indicator.name,
          label: indicator.label,
          unit: indicator.unit,
          price,
          date: new Date().toISOString().split('T')[0],
          source: 'html_scrape',
        };
      }
    }

    // The price is embedded in a Power BI iframe — we need a different approach
    // Log a targeted search of the HTML for debugging
    const powerBiMatch = html.match(/powerbi\.com[^"']*/i);
    console.error(`[${indicator.name}] Could not extract price from HTML. PowerBI ref: ${powerBiMatch?.[0]||'none'}`);
    console.error(`[${indicator.name}] HTML excerpt around 'indicator':`, html.match(/.{0,200}indicator.{0,200}/i)?.[0]);
    throw new Error('Could not extract price from page — data may be in Power BI iframe');

  } catch (err) {
    console.error(`[${indicator.name}] Failed:`, err.message);
    return null;
  }
}

async function upsertPrice(result) {
  if (!result?.price || isNaN(result.price)) return;

  // Find the commodity for cattle indicators (must exist in DB)
  const comRes = await fetch(
    `${SUPABASE_URL}/rest/v1/commodities?name=eq.Cattle%20Indicators&select=id`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  const coms = await comRes.json();
  let commodityId = coms?.[0]?.id;

  if (!commodityId) {
    // Try inserting without is_livestock column
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/commodities`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ name: 'Cattle Indicators' }),
    });
    if (!insertRes.ok) {
      const err = await insertRes.text();
      console.error('Could not create Cattle Indicators commodity:', err);
      return;
    }
    const inserted = await insertRes.json();
    commodityId = inserted?.[0]?.id;
  }

  if (!commodityId) { console.error('Could not get/create Cattle Indicators commodity'); return; }

  // Upsert into market_prices using region = indicator name
  const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/market_prices`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({
      commodity_id: commodityId,
      region: result.indicator,
      price_per_unit: result.price,
      unit: result.unit,
      price_date: result.date,
      source_label: result.label,
    }),
  });

  if (!upsertRes.ok) {
    const err = await upsertRes.text();
    console.error(`Upsert failed for ${result.indicator}:`, err);
  } else {
    console.log(`[${result.indicator}] Saved: ${result.price} ${result.unit} on ${result.date}`);
  }
}

export default async function handler() {
  console.log('[push-livestock-prices] Starting MLA indicator fetch...');

  const results = await Promise.all(INDICATORS.map(fetchIndicator));
  const valid = results.filter(Boolean);

  console.log(`[push-livestock-prices] Got ${valid.length}/${INDICATORS.length} indicators`);

  await Promise.all(valid.map(upsertPrice));

  console.log('[push-livestock-prices] Done');
  return new Response(JSON.stringify({ fetched: valid.length, total: INDICATORS.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
}