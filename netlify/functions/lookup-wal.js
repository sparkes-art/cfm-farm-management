// netlify/functions/lookup-wal.js
<<<<<<< HEAD
// Fetches WAL licence details from the NSW Public Water Register
// Returns: water source, category, share component (ML), licence type
=======
// Proxies WAL number lookups to WaterInsights API

const NSW_WATER_API_KEY = process.env.NSW_WATER_API_KEY;
>>>>>>> 78a4e09288b04c853311a8b51c806e4c119229bd

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

<<<<<<< HEAD
  // Normalise — strip leading 'WAL' and any spaces
  const walNum = walNumber.toString().replace(/^WAL/i, '').trim();

  try {
    // Step 1: Submit the search form on the NSW Public Water Register
    const searchUrl = 'https://waterregister.waternsw.com.au/water-register-frame';
    const searchParams = new URLSearchParams({
      PageID: 'WALSearch',
      WAL: `WAL${walNum}`,
    });

    const searchRes = await fetch(`${searchUrl}?${searchParams}`, {
      headers: {
        'User-Agent': 'CFM-Farm-Management/1.0',
        'Accept': 'text/html',
      },
    });

    if (!searchRes.ok) throw new Error(`Register returned ${searchRes.status}`);
    const html = await searchRes.text();

    // Step 2: Parse the HTML for WAL details
    const result = parseWalHtml(html, `WAL${walNum}`);

    if (!result.found) {
      // Try the direct WAL folio URL
      const folioUrl = `https://waterregister.waternsw.com.au/water-register-frame?PageID=WALDetail&WAL=WAL${walNum}`;
      const folioRes = await fetch(folioUrl, {
        headers: { 'User-Agent': 'CFM-Farm-Management/1.0', 'Accept': 'text/html' },
      });
      if (folioRes.ok) {
        const folioHtml = await folioRes.text();
        const folioResult = parseWalHtml(folioHtml, `WAL${walNum}`);
        if (folioResult.found) {
          return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(folioResult) };
        }
      }
      return {
        statusCode: 404,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'WAL not found', walNumber: `WAL${walNum}` }),
      };
    }

    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(result) };

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
  if (html.includes('No results found') || html.includes('no results')) return result;
  if (!html.toLowerCase().includes('wal') && !html.toLowerCase().includes('water source')) return result;

  result.found = true;

  // Extract water source
  const waterSourcePatterns = [
    /water\s+source[:\s]+([A-Za-z\s\-\/&]+(?:Water\s+Source|River|Aquifer|Groundwater)[A-Za-z\s\-]*)/i,
    /(?:water\s+source|wsource)[^>]*>([^<]+)</i,
    /source[:\s]*<[^>]*>([^<]+)/i,
  ];
  for (const pat of waterSourcePatterns) {
    const m = html.match(pat);
    if (m) { result.waterSource = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  // Extract category
  const categoryPatterns = [
    /category[:\s]*<[^>]*>([^<]+)/i,
    /(?:licence\s+)?category[:\s]+([A-Za-z\s]+Security[A-Za-z\s]*)/i,
    /(High Security|General Security|Supplementary|Specific Purpose|Domestic and Stock|Local Water Utility)/i,
  ];
  for (const pat of categoryPatterns) {
    const m = html.match(pat);
    if (m) { result.category = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  // Extract share component / ML
  const sharePatterns = [
    /share\s+component[:\s]*<[^>]*>([\d,\.]+)\s*(?:ML|megalitres?)/i,
    /share\s+component[:\s]+([\d,\.]+)/i,
    /([\d,\.]+)\s+megalitres?\s+(?:of\s+)?(?:available\s+)?water/i,
    /volume[:\s]*([\d,\.]+)\s*(?:ML|megalitres?)/i,
    /entitlement[:\s]*([\d,\.]+)\s*(?:ML|megalitres?)/i,
    /([\d,]+\.?\d*)\s+ML/i,
  ];
  for (const pat of sharePatterns) {
    const m = html.match(pat);
    if (m) { result.shareML = parseFloat(m[1].replace(/,/g, '')); break; }
  }

  // Extract tenure
  const tenurePatterns = [
    /tenure[:\s]*<[^>]*>([^<]+)/i,
    /tenure[:\s]+(Continuing|Specific\s+Purpose)/i,
    /(Continuing|Specific\s+Purpose)\s+(?:licence|WAL)/i,
  ];
  for (const pat of tenurePatterns) {
    const m = html.match(pat);
    if (m) { result.tenure = m[1].trim(); break; }
  }

  // Extract holder name
  const holderPatterns = [
    /holder[:\s]*<[^>]*>([^<]+)/i,
    /licence\s+holder[:\s]+([A-Za-z\s]+)/i,
  ];
  for (const pat of holderPatterns) {
    const m = html.match(pat);
    if (m && m[1].trim().length > 2) { result.holder = m[1].trim(); break; }
  }

  return result;
}
=======
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
>>>>>>> 78a4e09288b04c853311a8b51c806e4c119229bd
