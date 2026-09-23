// netlify/functions/push-weather-data.js
// Fetches daily weather data from Open-Meteo for all configured farms
// Also seeds 10-year historical averages on first run per farm location
// Runs at 9pm UTC = 7am AEST
// Override system: farm managers can enter gauge readings via the weather panel
//   which stores to weather_monthly_overrides and takes precedence over Open-Meteo data

export const config = { schedule: '0 21 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OM_API = 'https://api.open-meteo.com/v1/forecast';
const OM_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

async function db(path, opts = {}) {
  const { headers: extraHeaders, ...restOpts } = opts;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...restOpts,
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(extraHeaders || {}),
    },
  });
  if (!res.ok) throw new Error(`DB error: ${await res.text()}`);
  return res.json().catch(() => null);
}

// Get all farms with coordinates configured
async function getFarms() {
  const farms = await db('farms?select=id,name,settings');
  return (farms || []).filter(f => f.settings?.latitude && f.settings?.longitude).map(f => ({
    farmId: f.id,
    farmName: f.name,
    lat: f.settings.latitude,
    lon: f.settings.longitude,
    locationLabel: f.settings.weather?.locationLabel || f.name,
    stationId: f.settings.weather?.bomStationId || f.id, // use farm ID as station key if no BOM ID
    gddBase: f.settings.weather?.gddBase || 10,
    yearStart: f.settings.yearStartMonth || 1,
  }));
}

// Fetch yesterday's confirmed data from Open-Meteo archive (not forecast)
// Archive data is finalised — no forecast uncertainty
async function fetchToday(lat, lon) {
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const url = `${OM_ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${yesterday}&end_date=${yesterday}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=Australia%2FSydney`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CFM-FarmManagement/1.0' } });
  if (!res.ok) throw new Error(`Open-Meteo archive error: ${res.status}`);
  const data = await res.json();
  return {
    date: data.daily.time[0],
    rainfall: data.daily.precipitation_sum[0],
    tempMax: data.daily.temperature_2m_max[0],
    tempMin: data.daily.temperature_2m_min[0],
  };
}

// Seed 10-year historical monthly averages from Open-Meteo archive
async function seedAverages(farmId, stationId, lat, lon) {
  // Check if already seeded with complete data
  const existing = await db(`weather_station_averages?station_id=eq.${encodeURIComponent(stationId)}&avg_temp_max=not.is.null&limit=1`);
  if (existing?.length) return;

  console.log(`[weather] Seeding 10yr averages for ${stationId} at ${lat},${lon}`);

  const endYear = new Date().getFullYear() - 1;
  const startYear = endYear - 9;
  const url = `${OM_ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${startYear}-01-01&end_date=${endYear}-12-31&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=Australia%2FSydney`;

  const res = await fetch(url, { headers: { 'User-Agent': 'CFM-FarmManagement/1.0' } });
  if (!res.ok) { console.warn(`[weather] Archive fetch failed: ${res.status}`); return; }

  const data = await res.json();
  const { time, precipitation_sum, temperature_2m_max, temperature_2m_min } = data.daily;

  // Monthly totals per year for rainfall, daily avg for temps
  const monthlyByYear = {};
  time.forEach((d, i) => {
    const date = new Date(d);
    const yr = date.getFullYear();
    const mo = date.getMonth(); // 0-based
    if (!monthlyByYear[yr]) monthlyByYear[yr] = Array.from({length:12}, () => ({rain:0, tmax:[], tmin:[]}));
    if (precipitation_sum?.[i] != null) monthlyByYear[yr][mo].rain += precipitation_sum[i];
    if (temperature_2m_max?.[i] != null) monthlyByYear[yr][mo].tmax.push(temperature_2m_max[i]);
    if (temperature_2m_min?.[i] != null) monthlyByYear[yr][mo].tmin.push(temperature_2m_min[i]);
  });

  const years = Object.values(monthlyByYear);
  const avg = arr => arr.length ? Math.round(arr.reduce((s,v)=>s+v,0)/arr.length*10)/10 : null;

  const rows = Array.from({length:12}, (_, mo) => ({
    station_id: stationId,
    month: mo + 1,
    avg_rainfall_mm: avg(years.map(y => y[mo].rain)),
    avg_temp_max: avg(years.flatMap(y => y[mo].tmax)),
    avg_temp_min: avg(years.flatMap(y => y[mo].tmin)),
    years_of_data: years.length,
  }));

  await db(`weather_station_averages?on_conflict=station_id,month`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

  console.log(`[weather] Seeded averages: Jan max=${rows[0].avg_temp_max}°C, rain=${rows[0].avg_rainfall_mm}mm`);
}

export default async function handler(req) {
  const url = new URL(req?.url || 'http://localhost');
  const targetDate = url.searchParams.get('date') || new Date().toISOString().split('T')[0];
  const forceSeed = url.searchParams.get('seed') === '1';

  console.log(`[push-weather-data] Running for ${targetDate}`);

  const farms = await getFarms();
  console.log(`[push-weather-data] ${farms.length} farm(s) with coordinates configured`);

  let saved = 0;
  const errors = [];
  const seededStations = new Set();

  for (const farm of farms) {
    try {
      // Seed averages for new stations (once per station ID, skipped if already complete)
      if (!seededStations.has(farm.stationId)) {
        seededStations.add(farm.stationId);
        if (forceSeed) {
          // Force re-seed: delete existing first
          await db(`weather_station_averages?station_id=eq.${encodeURIComponent(farm.stationId)}`, { method: 'DELETE' });
        }
        await seedAverages(farm.farmId, farm.stationId, farm.lat, farm.lon);
      }

      // Fetch today's data
      const today = await fetchToday(farm.lat, farm.lon);

      const row = {
        farm_id: farm.farmId,
        station_id: farm.stationId,
        obs_date: today.date,
        rainfall_mm: today.rainfall,
        temp_max: today.tempMax,
        temp_min: today.tempMin,
        source: 'Open-Meteo',
      };

      await db(`weather_observations?on_conflict=farm_id,station_id,obs_date`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([row]),
      });

      console.log(`[${farm.farmName}] Saved: ${today.rainfall}mm rain, ${today.tempMax}°C max`);
      saved++;
    } catch(e) {
      console.error(`[${farm.farmName}] Failed: ${e.message}`);
      errors.push({ farm: farm.farmName, error: e.message });
    }
  }

  return new Response(JSON.stringify({ saved, errors, date: targetDate }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
