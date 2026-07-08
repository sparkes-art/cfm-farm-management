// netlify/functions/sync-water-announcements.js
// Scheduled function — runs daily
// Fetches allocation announcements for all WALs in water_entitlements
// and upserts into water_announcements

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Convert DD-MON-YYYY to YYYY-MM-DD
function parseRegisterDate(str) {
  if (!str) return null;
  const months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
  const m = str.trim().match(/(\d{2})-([A-Z]{3})-(\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${months[m[2].toUpperCase()]}-${m[1]}`;
}

// Determine water year from a date string (YYYY-MM-DD)
// Water year: 1 Jul – 30 Jun
function waterYearFromDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1; // 1-12
  const startYear = mo >= 7 ? y : y - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

// Parse ML per share from strings like "1ML per share", ".7ML per share", "0.3ML per share"
function parseMlPerShare(str) {
  if (!str) return null;
  const m = str.match(/([\d.]+)\s*ML/i);
  return m ? parseFloat(m[1]) : null;
}

// Clean HTML tags and whitespace
function clean(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

// Fetch announcement history for a single WAL from the register
async function fetchAnnouncements(walNum) {
  const formData = new URLSearchParams({
    pageCommand: 'search',
    resultType: 'modern',
    serType: 'html',
    wal: walNum,
  });

  const res = await fetch('https://waterregister.waternsw.com.au/DeterminationResult', {
    method: 'POST',
    headers: {
      'User-Agent': 'CFM-Farm-Management/1.0',
      'Accept': 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://waterregister.waternsw.com.au/water-register-frame',
    },
    body: formData.toString(),
  });

  if (!res.ok) throw new Error(`Register returned ${res.status} for WAL${walNum}`);
  const html = await res.text();

  // Parse rows from the results table
  // Columns: Announcement Date | Announcement Volume | Access Licence Category | Water Source | Water Management Zone
  const rows = [];
  const trMatches = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  for (const tr of trMatches) {
    const tdMatches = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    const cells = tdMatches.map(m => clean(m[1]));
    if (cells.length < 4) continue;

    const dateStr = parseRegisterDate(cells[0]);
    const mlPerShare = parseMlPerShare(cells[1]);
    const category = cells[2] || null;
    const waterSource = cells[3] || null;

    if (!dateStr || mlPerShare === null) continue;

    rows.push({
      announcement_date: dateStr,
      ml_per_share: mlPerShare,
      category,
      water_source: waterSource,
      water_year: waterYearFromDate(dateStr),
    });
  }

  return rows;
}

exports.handler = async (event) => {
  // Allow manual trigger via POST as well as scheduled
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS };

  try {
    // 1. Get all WALs from water_entitlements
    const entRes = await fetch(
      `${SUPABASE_URL}/rest/v1/water_entitlements?select=farm_id,wal_number&wal_number=not.is.null`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const entitlements = await entRes.json();
    if (!Array.isArray(entitlements) || entitlements.length === 0) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ message: 'No WALs found' }) };
    }

    // Deduplicate WAL numbers
    const seen = new Set();
    const uniqueWals = entitlements.filter(e => {
      if (!e.wal_number || seen.has(e.wal_number)) return false;
      seen.add(e.wal_number);
      return true;
    });

    console.log(`Syncing announcements for ${uniqueWals.length} WAL(s)`);

    let totalInserted = 0;
    const results = [];

    for (const ent of uniqueWals) {
      // Strip WAL prefix for the register call
      const walNum = ent.wal_number.replace(/^WAL/i, '').trim();

      try {
        const rows = await fetchAnnouncements(walNum);
        console.log(`WAL${walNum}: found ${rows.length} announcements`);

        if (rows.length === 0) {
          results.push({ wal: ent.wal_number, inserted: 0 });
          continue;
        }

        // Upsert into water_announcements
        const upsertRows = rows.map(r => ({
          farm_id: ent.farm_id,
          wal_number: ent.wal_number,
          water_source: r.water_source,
          category: r.category,
          water_year: r.water_year,
          announcement_date: r.announcement_date,
          ml_per_share: r.ml_per_share,
        }));

        const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/water_announcements`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal',
          },
          body: JSON.stringify(upsertRows),
        });

        if (!upsertRes.ok) {
          const err = await upsertRes.text();
          console.error(`Upsert failed for WAL${walNum}:`, err);
          results.push({ wal: ent.wal_number, error: err });
        } else {
          totalInserted += upsertRows.length;
          results.push({ wal: ent.wal_number, inserted: upsertRows.length });
        }

      } catch (err) {
        console.error(`Error for WAL${walNum}:`, err.message);
        results.push({ wal: ent.wal_number, error: err.message });
      }

      // Small delay to avoid hammering the register
      await new Promise(r => setTimeout(r, 500));
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ success: true, totalInserted, results }),
    };

  } catch (err) {
    console.error('sync-water-announcements error:', err);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};
