// netlify/functions/push-grain-prices.js
// Receives daily LDC Grains CSV from Power Automate
// Parses CSV directly — no AI needed

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GRAIN_PRICES_API_KEY = process.env.GRAIN_PRICES_API_KEY;

const PRIMARY_GRADES = {
  'Wheat': 'APW1',
  'Barley': 'BAR1',
  'Canola': 'CAN1',
  'Faba Beans': 'FAB2',
  'Lentils': 'NIPT1',
};

const SITE_NAMES = {
  'ELM':  'ELMORE LDC',
  'COL':  'COOLAMON LDC',
  'ROC':  'THE ROCK LDC',
  'ARDL': 'ARDLETHAN LDC',
  'NUL':  'NULLAWIL LDC',
  'WOO':  'WOORINEN LDC',
  'KYL':  'KYALITE LDC',
  'GOO':  'GOOLGOWI LDC',
  'TEL':  'TELFORD LDC',
  'MOR':  'MOREE LDC',
  'MBL':  'MERBEIN LDC',
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const apiKey = event.headers['x-api-key'] || event.headers['X-Api-Key'] || event.headers['authorization'] || event.headers['Authorization'];
  if (!GRAIN_PRICES_API_KEY || apiKey !== GRAIN_PRICES_API_KEY) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { csv, date } = body;
  if (!csv || !date) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing csv or date' }) };
  }

  try {
    // Parse CSV
    const lines = csv.trim().split('\n');
    const csvHeaders = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

    const siteIdx      = csvHeaders.indexOf('Site');
    const gradeIdx     = csvHeaders.indexOf('Grade');
    const priceIdx     = csvHeaders.indexOf('Cash Price');
    const commodityIdx = csvHeaders.indexOf('Commodity');
    const typeIdx      = csvHeaders.indexOf('Type');

    if (siteIdx === -1 || gradeIdx === -1 || priceIdx === -1 || commodityIdx === -1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'CSV format not recognised' }) };
    }

    // Fetch commodity IDs — single fast query
    const commRes = await fetch(`${SUPABASE_URL}/rest/v1/commodities?select=id,name`, {
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      }
    });
    const commodities = await commRes.json();
    const commMap = {};
    commodities.forEach(c => { commMap[c.name.toLowerCase()] = c.id; });
    console.log('Commodities found:', commodities.length, 'Keys:', Object.keys(commMap));
    console.log('CSV rows to process:', lines.length - 1);

    // Parse rows
    const rows = [];
    const seen = new Set();

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));

      const site      = cols[siteIdx];
      const grade     = cols[gradeIdx];
      const price     = parseFloat(cols[priceIdx]);
      const commodity = cols[commodityIdx];
      const type      = cols[typeIdx] || 'DC';

      if (!site || !grade || isNaN(price) || !commodity) continue;

      const primaryGrade = PRIMARY_GRADES[commodity];
      if (!primaryGrade || grade !== primaryGrade) continue;

      const siteName = SITE_NAMES[site] || site;
      const key = siteName + ':' + commodity;

      if (seen.has(key) && type !== 'DC') continue;
      if (seen.has(key)) {
        const existingIdx = rows.findIndex(r => r.region === siteName && r.commodity === commodity);
        if (existingIdx >= 0 && type === 'DC') rows.splice(existingIdx, 1);
        else continue;
      }
      seen.add(key);

      const commodityId = commMap[commodity.toLowerCase()];
      if (!commodityId) continue;

      rows.push({
        price_date: date,
        commodity_id: commodityId,
        commodity,
        price_per_unit: price,
        unit: 't',
        source: 'LDC Grains SE',
        region: siteName,
        grade,
      });
    }

    if (!rows.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, message: 'No matching grades found', date }) };
    }

    // Single bulk upsert
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
      throw new Error('Supabase error: ' + err);
    }

    console.log('Grain prices updated:', date, rows.length, 'rows');
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        date,
        rows_inserted: rows.length,
        commodities: [...new Set(rows.map(r => r.commodity))],
        sites: [...new Set(rows.map(r => r.region))].length,
      }),
    };

  } catch (err) {
    console.error('push-grain-prices error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};