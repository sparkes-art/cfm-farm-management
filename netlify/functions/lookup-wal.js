// netlify/functions/lookup-wal.js
// Proxies WAL number lookups to WaterInsights API

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

  const walNormalised = wal.startsWith('WAL') ? wal : `WAL${wal}`;

  // Try multiple URL patterns since we're not sure of the exact endpoint
  const urlsToTry = [
    `https://waterinsights.waternsw.com.au/api/v1/licence?wal_number=${encodeURIComponent(walNormalised)}`,
    `https://waterinsights.waternsw.com.au/api/v2/licence?wal_number=${encodeURIComponent(walNormalised)}`,
    `https://waterinsights.waternsw.com.au/api/v1/licences/${encodeURIComponent(walNormalised)}`,
  ];

  for (const url of urlsToTry) {
    console.log('Trying URL:', url);
    const response = await fetch(url, {
      headers: {
        'Authorization': NSW_WATER_API_KEY,
        'Accept': 'application/json',
      },
    });

    const contentType = response.headers.get('content-type') || '';
    const bodyText = await response.text();
    console.log('Status:', response.status, 'Content-Type:', contentType);
    console.log('Body (first 500 chars):', bodyText.slice(0, 500));

    if (contentType.includes('application/json') && response.ok) {
      const data = JSON.parse(bodyText);
      const licence = data?.licence || data?.data || data;
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          wal_number: walNormalised,
          source_name: licence?.water_source_name || licence?.waterSourceName || null,
          water_source_type: licence?.water_source_type || licence?.waterSourceType || null,
          ml_held: parseFloat(licence?.share_quantity || licence?.shareQuantity || licence?.volume_ml || 0) || null,
          licence_category: licence?.licence_category || licence?.licenceCategory || null,
          licence_purpose: licence?.licence_purpose || licence?.purpose || null,
          raw: data,
        }),
      };
    }
  }

  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: 'Could not reach WaterInsights API — check Netlify function logs for details' }),
  };
};
