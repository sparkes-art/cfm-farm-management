// netlify/functions/lookup-wal.js
// Fetches WAL licence details from the NSW Public Water Register

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: 'Method not allowed' };

  let walNumber;
  try {
    ({ walNumber } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!walNumber) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'WAL number required' }) };
  }

  // Strip 'WAL' prefix — the form just takes the number
  const walNum = walNumber.toString().replace(/^WAL/i, '').trim();

  try {
    // POST to AccessLicenceDetail with exact form fields from the register
    const formData = new URLSearchParams({
      pageCommand: 'search',
      resultType: 'modern',
      serType: 'html',
      wal: walNum,
    });
    const res = await fetch('https://waterregister.waternsw.com.au/AccessLicenceDetail', {
      method: 'POST',
      headers: {
        'User-Agent': 'CFM-Farm-Management/1.0',
        'Accept': 'text/html',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://waterregister.waternsw.com.au/water-register-frame',
      },
      body: formData.toString(),
    });

    if (!res.ok) throw new Error(`Register returned ${res.status}`);
    const html = await res.text();

    const result = parseWalHtml(html, `WAL${walNum}`);
    console.log('Parse result:', JSON.stringify(result));

    if (!result.found) {
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'WAL not found', walNumber: `WAL${walNum}` }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };

  } catch (err) {
    console.error('WAL lookup error:', err);
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Lookup failed', message: err.message }),
    };
  }
};

function parseWalHtml(html, walNumber) {
  const result = { found: false, walNumber };

  if (!html || html.length < 100) return result;
  if (!html.toLowerCase().includes('water source') && !html.toLowerCase().includes('aquifer')) return result;

  result.found = true;

  const clean = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

  // Extract td.search cells — columns: Category | Status | Water Source | Tenure | Zone | Share ML | IDEC
  const tdMatches = [...html.matchAll(/<td[^>]*class=["']search["'][^>]*>([\s\S]*?)<\/td>/gi)];
  const cells = tdMatches.map(m => clean(m[1])).filter(c => c.length > 0);

  if (cells.length >= 6) {
    result.category    = cells[0] || null;
    result.status      = cells[1] || null;
    result.waterSource = cells[2] || null;
    result.tenure      = cells[3] || null;
    // cells[4] = Management Zone (often empty)
    const shareNum = (cells[5] || '').replace(/,/g, '').match(/([\d]+\.?\d*)/);
    if (shareNum) result.shareML = parseFloat(shareNum[1]);
  }

  // Fallback for shareML — find any number near "Share Components" or large standalone number
  if (!result.shareML) {
    const shareMatch = html.match(/class=["']search["'][^>]*>\s*([\d,]+\.?\d*)\s*<\/td>/gi);
    if (shareMatch) {
      for (const m of shareMatch) {
        const numMatch = m.match(/([\d,]+\.?\d*)/);
        if (numMatch) {
          const val = parseFloat(numMatch[1].replace(/,/g, ''));
          if (val > 0) { result.shareML = val; break; }
        }
      }
    }
  }

  // Nominated Work Approvals — td.result cells
  const tdResultMatches = [...html.matchAll(/<td[^>]*class=["']result["'][^>]*>([\s\S]*?)<\/td>/gi)];
  const resultCells = tdResultMatches.map(m => clean(m[1])).filter(c => c.length > 0 && c !== '\u00a0');
  if (resultCells.length > 0) {
    result.nominatedWorks = resultCells[0] || null;
  }

  // Water sharing plan — find the th.result that contains the actual plan name (not the label)
  const thResultMatches = [...html.matchAll(/<th[^>]*class=["']result["'][^>]*>([\s\S]*?)<\/th>/gi)];
  const thCells = thResultMatches.map(m => clean(m[1])).filter(c => c.length > 0);
  // The plan name is the cell that is NOT "Water sharing plan" label but contains year or source name
  const planCell = thCells.find(c => 
    c.match(/\d{4}/) || // contains a year
    c.toLowerCase().includes('sources') || 
    c.toLowerCase().includes('river') ||
    c.toLowerCase().includes('alluvial') ||
    c.toLowerCase().includes('groundwater')
  );
  if (planCell) result.waterSharingPlan = planCell;

  // Plan conditions — extract take of water limit (ML/unit share)
  const takeMatch = html.match(/maximum water account debit[\s\S]*?([\d\.]+)\s*ML\/unit share/i);
  if (takeMatch) result.mlPerUnitShare = parseFloat(takeMatch[1]);

  const carryoverMatch = html.match(/carried over[\s\S]*?([\d\.]+)\s*ML\/unit share/i);
  if (carryoverMatch) result.carryoverMlPerUnitShare = parseFloat(carryoverMatch[1]);

  return result;
}