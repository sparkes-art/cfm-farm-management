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

    console.log('Response status:', res.status, 'HTML length:', html.length);
    console.log('HTML sample:', html.slice(0, 500));
    const result = parseWalHtml(html, `WAL${walNum}`);

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
  const tdMatches = [...html.matchAll(/<td[^>]*class=.search.[^>]*>([\s\S]*?)<\/td>/gi)];
  const cells = tdMatches.map(m => clean(m[1])).filter(c => c.length > 0);

  if (cells.length >= 6) {
    result.category    = cells[0] || null;
    result.status      = cells[1] || null;
    result.waterSource = cells[2] || null;
    result.tenure      = cells[3] || null;
    const shareNum = (cells[5] || '').replace(/,/g, '').match(/([\d]+\.?\d*)/);
    if (shareNum) result.shareML = parseFloat(shareNum[1]);
  }

  // Water sharing plan
  const planMatch = html.match(/<th[^>]*class=.result.[^>]*>([\s\S]*?)<\/th>/gi);
  if (planMatch && planMatch[1]) {
    const planText = clean(planMatch[1]);
    if (planText.toLowerCase().includes('plan') || planText.toLowerCase().includes('sharing')) {
      result.waterSharingPlan = planText;
    }
  }

  return result;
}