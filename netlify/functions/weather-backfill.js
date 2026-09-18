// netlify/functions/weather-backfill.js
// ONE-TIME backfill of historical temperature + rainfall from Open-Meteo
// Triggered manually from browser: /.netlify/functions/weather-backfill?farm=farm_glenrowan
// Open-Meteo archive API is free, no auth, covers historical data back to 1940

export default async function handler(req) {
  const url = new URL(req.url);
  const farmId = url.searchParams.get('farm');
  const fromDate = url.searchParams.get('from') || '2026-01-01';
  const toDate = url.searchParams.get('to') || new Date(Date.now() - 86400000).toISOString().split('T')[0];

  if (!farmId) return new Response('Missing ?farm= param', { status: 400 });

  const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Get farm coordinates and station
  const farmRes = await fetch(`${SUPABASE_URL}/rest/v1/farms?id=eq.${farmId}&select=id,name,settings`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  const farms = await farmRes.json();
  const farm = farms?.[0];
  if (!farm) return new Response('Farm not found', { status: 404 });

  const lat = farm.settings?.latitude;
  const lon = farm.settings?.longitude;
  const stationId = farm.settings?.weather?.bomStationId;

  if (!lat || !lon) return new Response('Farm has no coordinates — add latitude/longitude to farm record', { status: 400 });
  if (!stationId) return new Response('Farm has no BOM station configured', { status: 400 });

  console.log(`[weather-backfill] ${farm.name} | ${lat},${lon} | ${fromDate} → ${toDate}`);

  // Fetch from Open-Meteo archive
  const omUrl = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${fromDate}&end_date=${toDate}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=Australia%2FSydney`;
  const omRes = await fetch(omUrl, { headers: { 'User-Agent': 'CFM-FarmManagement/1.0' } });
  if (!omRes.ok) {
    const err = await omRes.text();
    return new Response(`Open-Meteo error: ${omRes.status} — ${err}`, { status: 500 });
  }
  const omData = await omRes.json();
  const { time, precipitation_sum, temperature_2m_max, temperature_2m_min } = omData.daily;

  console.log(`[weather-backfill] Got ${time.length} days from Open-Meteo`);

  // Build rows — skip days where all values are null
  const rows = time.map((date, i) => ({
    farm_id: farmId,
    station_id: stationId,
    obs_date: date,
    rainfall_mm: precipitation_sum?.[i] ?? null,
    temp_max: temperature_2m_max?.[i] ?? null,
    temp_min: temperature_2m_min?.[i] ?? null,
    source: 'Open-Meteo',
  })).filter(r => r.rainfall_mm !== null || r.temp_max !== null);

  // Upsert in batches of 500
  let saved = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/weather_observations`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Batch ${i} failed: ${err}`);
    } else {
      saved += batch.length;
      console.log(`[weather-backfill] Saved ${saved}/${rows.length}`);
    }
  }

  return new Response(JSON.stringify({
    farm: farm.name, from: fromDate, to: toDate,
    days: time.length, saved, source: 'Open-Meteo',
  }), { headers: { 'Content-Type': 'application/json' } });
}