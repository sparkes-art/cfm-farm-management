// netlify/functions/lookup-wal.js
// Proxies WAL number lookups to WaterInsights API
// Keeps the NSW Water API key server-side

const NSW_WATER_API_KEY = process.env.NSW_WATER_API_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  if (!NSW_WATER_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'NSW Water API key not configured' }) };
  }

  const wal = (event.queryStringParameters?.wal || '').trim().toUpperCase();
  if (!wal) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'WAL number required' }) };
  }

  // Normalise — strip spaces, ensure WAL prefix
  const walNormalised = wal.startsWith('WAL') ? wal : `WAL${wal}`;

  try {
    const response = await fetch(
      `https://waterinsights.waternsw.com.au/api/v1/licence?wal_number=${encodeURIComponent(walNormalised)}`,
      {
        headers: {
          'Authorization': NSW_WATER_API_KEY,
          'Accept': 'application/json',
        },
      }
    );

    if (response.status === 404) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: `WAL number ${walNormalised} not found` }) };
    }

    if (!response.ok) {
      const text = await response.text();
      console.error('WaterInsights error:', response.status, text);
      return { statusCode: response.status, headers: CORS, body: JSON.stringify({ error: 'WaterInsights API error', detail: text }) };
    }

    const data = await response.json();

    // Normalise response into a clean object for the UI
    // WaterInsights returns licence details — map to what we need
    const licence = data?.licence || data?.data || data;

    const result = {
      wal_number: walNormalised,
      source_name: licence?.water_source_name || licence?.waterSourceName || null,
      water_source_type: licence?.water_source_type || licence?.waterSourceType || null,
      ml_held: parseFloat(licence?.share_quantity || licence?.shareQuantity || licence?.volume_ml || 0) || null,
      licence_category: licence?.licence_category || licence?.licenceCategory || null,
      licence_purpose: licence?.licence_purpose || licence?.purpose || null,
      raw: data, // pass raw back so we can inspect during testing
    };

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };

  } catch (err) {
    console.error('lookup-wal error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};