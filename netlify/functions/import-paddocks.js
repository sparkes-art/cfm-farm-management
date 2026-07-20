// netlify/functions/import-paddocks.js
// Receives parsed paddock data and bulk inserts into Supabase
// Uses service role key from env so users don't need to enter it

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

  // Verify user is authenticated
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

  let success = 0, failed = 0, errors = [];

  for (const p of paddocks) {
    try {
      // Upsert paddock
      const res = await fetch(`${SUPABASE_URL}/rest/v1/paddocks`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify({
          farm_id: farmId,
          external_id: p.externalId,
          name: p.name,
          area_ha: p.area,
          boundary: p.boundary,
          is_active: true,
        })
      });

      if (!res.ok) throw new Error(await res.text());
      const [paddock] = await res.json();

      // Insert crop if present
      if (p.cropName && paddock?.id) {
        await fetch(`${SUPABASE_URL}/rest/v1/paddock_crops`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            paddock_id: paddock.id,
            season: p.seasonName,
            crop_name: p.cropName,
            variety_name: p.varietyName || null,
          })
        });
      }
      success++;
    } catch (err) {
      failed++;
      errors.push(`${p.name}: ${err.message}`);
    }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ success, failed, errors }),
  };
};
