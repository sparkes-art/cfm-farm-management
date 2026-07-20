// netlify/functions/import-paddocks.js
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };

  let paddocks, farmId;
  try {
    ({ paddocks, farmId } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!paddocks?.length || !farmId) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Missing paddocks or farmId' }) };
  }

  const headers = {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates,return=representation',
  };

  // Batch insert all paddocks at once
  const paddockRows = paddocks.map(p => ({
    farm_id: farmId,
    external_id: p.externalId,
    name: p.name,
    area_ha: p.area,
    boundary: p.boundary,
    is_active: true,
  }));

  const res = await fetch(`${SUPABASE_URL}/rest/v1/paddocks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(paddockRows),
  });

  if (!res.ok) {
    const err = await res.text();
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Paddock insert failed', detail: err }) };
  }

  const inserted = await res.json();

  // Build map of external_id → paddock id for crop inserts
  const idMap = {};
  inserted.forEach(p => { if (p.external_id) idMap[p.external_id] = p.id; });

  // Batch insert crop records
  const cropRows = paddocks
    .filter(p => p.cropName && idMap[p.externalId])
    .map(p => ({
      paddock_id: idMap[p.externalId],
      season: p.seasonName,
      crop_name: p.cropName,
      variety_name: p.varietyName || null,
    }));

  if (cropRows.length) {
    await fetch(`${SUPABASE_URL}/rest/v1/paddock_crops`, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(cropRows),
    });
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success: inserted.length, crops: cropRows.length }),
  };
};
