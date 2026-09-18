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
async function seedClimateAverages(stationId) {
  // Check if already seeded
  const existing = await db(`weather_station_averages?station_id=eq.${stationId}&limit=1`);
  if (existing?.length) return;

  console.log(`[weather] Seeding climate averages for station ${stationId}`);
  const url = `http://www.bom.gov.au/climate/averages/tables/cw_${stationId}.shtml`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CFM-FarmManagement/1.0' } });
  if (!res.ok) { console.warn(`Could not fetch BOM stats for ${stationId}`); return; }
  const html = await res.text();

  // Extract monthly values from BOM climate stats HTML
  // Row structure: <td>label</a></td><td class="highest">Jan</td><td>Feb</td>...<td>Dec</td><td>Annual</td>...
  const extractMonthlyRow = (html, label) => {
    const labelIdx = html.indexOf(label);
    if (labelIdx === -1) return null;
    // Find closing </td> of the label cell, then extract next 12 numeric tds
    const afterLabel = html.slice(labelIdx + label.length, labelIdx + 2000);
    const afterCell = afterLabel.slice(afterLabel.indexOf('</td>') + 5);
    const matches = [...afterCell.matchAll(/<td[^>]*>\s*([\d]+(?:\.[0-9]+)?)\s*<\/td>/g)];
    const vals = matches.slice(0, 12).map(m => parseFloat(m[1]));
    return vals.length >= 12 ? vals : null;
  };

  const maxTemps  = extractMonthlyRow(html, 'Mean maximum temperature');
  const minTemps  = extractMonthlyRow(html, 'Mean minimum temperature');
  const rainfalls = extractMonthlyRow(html, 'Mean rainfall');

  if (!rainfalls) { console.warn(`Could not parse BOM stats for ${stationId}`); return; }
  console.log(`[weather] Parsed: maxTemps=${maxTemps?.[0]}, minTemps=${minTemps?.[0]}, rainfall=${rainfalls?.[0]}`);

  const rows = Array.from({length: 12}, (_, i) => ({
    station_id: stationId,
    month: i + 1,
    avg_rainfall_mm: rainfalls?.[i] || null,
    avg_temp_max: maxTemps?.[i] || null,
    avg_temp_min: minTemps?.[i] || null,
  }));

  await db('weather_station_averages', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

  console.log(`[weather] Seeded 12 months of averages for ${stationId}`);
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
        await seedClimateAverages(farm.stationId);
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