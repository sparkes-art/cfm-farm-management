// netlify/functions/push-weather-data.js
// Fetches daily BOM observations for all farm weather stations
// Stores rainfall + temp in weather_observations table
// Also seeds 30-year climate averages from BOM stats page on first run
// Runs at 9pm UTC = 7am AEST

export const config = { schedule: '0 21 * * *' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOM_API = 'https://api.weather.bom.gov.au/v1';

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

// Get all farms with a BOM station configured
async function getFarmStations() {
  const farms = await db('farms?select=id,settings,name');
  const stations = [];
  for (const farm of farms || []) {
    const s = farm.settings?.weather;
    if (s?.bomGeohash && s?.bomStationId) {
      stations.push({
        farmId: farm.id,
        farmName: farm.name,
        geohash: s.bomGeohash,
        stationId: s.bomStationId,
        stationName: s.bomStationName,
        yearStartMonth: farm.settings?.yearStartMonth || 1,
        gddBase: s.gddBase || 10,
      });
    }
  }
  return stations;
}

// Fetch today's observations from BOM
async function fetchObservations(geohash6, signal) {
  // Try the BOM API - may be slow from server environments
  const url = `${BOM_API}/locations/${geohash6}/observations`;
  const res = await fetch(url, {
    signal,
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; CFM-FarmManagement/1.0)',
      'Origin': 'https://www.bom.gov.au',
      'Referer': 'https://www.bom.gov.au/',
    }
  });
  if (!res.ok) throw new Error(`BOM obs error: ${res.status}`);
  const data = await res.json();
  return data.data;
}

// Seed 30-year averages from BOM climate stats page (HTML scrape)
async function seedClimateAverages(stationId, geohash, farmId) {
  // Check if already seeded with complete data (including temp)
  const existing = await db(`weather_station_averages?station_id=eq.${stationId}&avg_temp_max=not.is.null&limit=1`);
  if (existing?.length) return;

  console.log(`[weather] Seeding climate averages for station ${stationId} via Open-Meteo historical`);

  // Fetch lat/lon for this station from the farm settings
  // Use Open-Meteo archive to get 10 years of daily data and average by month
  // First get farm coordinates
  const farms = await db(`farms?settings->>bomStationId=eq.${stationId}&select=settings&limit=1`);
  const settings = farms?.[0]?.settings;
  const lat = settings?.latitude;
  const lon = settings?.longitude;

  if (!lat || !lon) {
    console.warn(`[weather] No coordinates for station ${stationId} — skipping temp averages`);
    // Still try to get rainfall from BOM stats page
    await seedRainfallOnly(stationId);
    return;
  }

  // Fetch 10 years of historical data from Open-Meteo
  const endYear = new Date().getFullYear() - 1;
  const startYear = endYear - 9;
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startYear}-01-01&end_date=${endYear}-12-31&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&timezone=Australia%2FSydney`;
  
  const res = await fetch(url, { headers: { 'User-Agent': 'CFM-FarmManagement/1.0' } });
  if (!res.ok) {
    console.warn(`[weather] Open-Meteo historical failed: ${res.status}`);
    await seedRainfallOnly(stationId);
    return;
  }

  const data = await res.json();
  const { time, precipitation_sum, temperature_2m_max, temperature_2m_min } = data.daily;

  // Aggregate by month
  const monthly = Array.from({length: 12}, () => ({ rain: [], tmax: [], tmin: [] }));
  time.forEach((d, i) => {
    const month = new Date(d).getMonth(); // 0-based
    if (precipitation_sum?.[i] != null) monthly[month].rain.push(precipitation_sum[i]);
    if (temperature_2m_max?.[i] != null) monthly[month].tmax.push(temperature_2m_max[i]);
    if (temperature_2m_min?.[i] != null) monthly[month].tmin.push(temperature_2m_min[i]);
  });

  const avg = arr => arr.length ? Math.round((arr.reduce((s,v)=>s+v,0)/arr.length) * 10) / 10 : null;
  const sumAvg = arr => arr.length ? Math.round((arr.reduce((s,v)=>s+v,0)/(endYear-startYear+1)) * 10) / 10 : null;

  const rows = monthly.map((m, i) => ({
    station_id: stationId,
    month: i + 1,
    avg_rainfall_mm: sumAvg(m.rain.reduce((acc, v, idx) => {
      // Group by year-month for monthly totals
      return acc;
    }, [])) || avg(m.rain), // fallback to daily avg × days
    avg_temp_max: avg(m.tmax),
    avg_temp_min: avg(m.tmin),
    years_of_data: endYear - startYear + 1,
  }));

  // Calculate proper monthly rainfall averages (sum per month per year, then average across years)
  const monthlyRainByYear = {};
  time.forEach((d, i) => {
    if (precipitation_sum?.[i] == null) return;
    const date = new Date(d);
    const yr = date.getFullYear();
    const mo = date.getMonth();
    if (!monthlyRainByYear[yr]) monthlyRainByYear[yr] = Array(12).fill(0);
    monthlyRainByYear[yr][mo] += precipitation_sum[i];
  });

  const years = Object.values(monthlyRainByYear);
  rows.forEach((row, i) => {
    const monthTotals = years.map(y => y[i]).filter(v => v != null);
    row.avg_rainfall_mm = monthTotals.length
      ? Math.round((monthTotals.reduce((s,v)=>s+v,0) / monthTotals.length) * 10) / 10
      : null;
  });

  await db('weather_station_averages?on_conflict=station_id,month', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

  console.log(`[weather] Seeded ${rows.length} months of averages for ${stationId} (${startYear}-${endYear})`);
  console.log(`[weather] Sample: Jan avg max=${rows[0].avg_temp_max}°C, rain=${rows[0].avg_rainfall_mm}mm`);
}

async function seedRainfallOnly(stationId) {
  // Fallback: get rainfall only from BOM stats page
  const url = `http://www.bom.gov.au/climate/averages/tables/cw_${stationId}.shtml`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CFM/1.0)' } });
  if (!res.ok) { console.warn(`Could not fetch BOM stats for ${stationId}`); return; }
  const html = await res.text();

  const extractRow = (label) => {
    const labelIdx = html.indexOf(label);
    if (labelIdx === -1) return null;
    const afterLabel = html.slice(labelIdx + label.length, labelIdx + 2000);
    const afterCell = afterLabel.slice(afterLabel.indexOf('</td>') + 5);
    const matches = [...afterCell.matchAll(/<td[^>]*>\s*([\d]+(?:\.[0-9]+)?)\s*<\/td>/g)];
    return matches.slice(0, 12).map(m => parseFloat(m[1]));
  };

  const rainfalls = extractRow('Mean rainfall');
  if (!rainfalls?.length) return;

  const rows = rainfalls.map((v, i) => ({
    station_id: stationId,
    month: i + 1,
    avg_rainfall_mm: v,
    avg_temp_max: null,
    avg_temp_min: null,
  }));

  await db('weather_station_averages?on_conflict=station_id,month', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  console.log(`[weather] Seeded rainfall-only averages for ${stationId} from BOM`);
}

export default async function handler(req) {
  const url = new URL(req?.url || 'http://localhost');
  const targetDate = url.searchParams.get('date') || new Date().toISOString().split('T')[0];

  console.log(`[push-weather-data] Running for ${targetDate}`);

  const stations = await getFarmStations();
  console.log(`[push-weather-data] ${stations.length} farm(s) with BOM station configured`);

  let saved = 0;
  const errors = [];

  // Auto-seed climate averages for any station not yet seeded (runs once per station, fast thereafter)
  const forceSeed = url.searchParams.get('seed') === '1';
  const seededStations = new Set();
  for (const farm of stations) {
    if (seededStations.has(farm.stationId)) continue;
    seededStations.add(farm.stationId);
    try {
      const existing = await db(`weather_station_averages?station_id=eq.${farm.stationId}&limit=1`);
      if (forceSeed || !existing?.length) {
        await seedClimateAverages(farm.stationId, farm.geohash, farm.farmId);
      }
    } catch(e) {
      console.warn(`[weather] Seed check failed for ${farm.stationId}: ${e.message}`);
    }
  }

  for (const farm of stations) {
    try {
      // Skip seed check — averages seeded separately via ?seed=1 param

      // Fetch current observations with timeout
      const obsController = new AbortController();
      const obsTimeout = setTimeout(() => obsController.abort(), 25000);
      const obs = await fetchObservations(farm.geohash.slice(0, 6), obsController.signal).finally(() => clearTimeout(obsTimeout));
      if (!obs) { errors.push({ farm: farm.farmName, error: 'No obs data' }); continue; }

      // Build row
      const row = {
        farm_id: farm.farmId,
        station_id: farm.stationId,
        obs_date: targetDate,
        rainfall_mm: obs.rain_since_9am ?? null,
        temp_max: obs.max_temp?.value ?? obs.temp ?? null,
        temp_min: obs.min_temp?.value ?? null,
        source: 'BOM',
      };

      await db('weather_observations?on_conflict=farm_id,station_id,obs_date', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([row]),
      });

      console.log(`[${farm.farmName}] Saved: ${row.rainfall_mm}mm rain, ${row.temp_max}°C max`);
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