// netlify/functions/lookup-wal.js
// Fetches WAL licence details from the NSW Public Water Register
// Returns: water source, category, share component (ML), licence type

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

  // Normalise — strip leading 'WAL' and any spaces
  const walNum = walNumber.toString().replace(/^WAL/i, '').trim();

  try {
    // The main page uses an iframe — fetch the inner search JSP directly
    const baseUrl = 'https://waterregister.waternsw.com.au';
    const searchParams = new URLSearchParams({ WAL: `WAL${walNum}` });

    // Try the inner iframe search URL first
    const searchRes = await fetch(`${baseUrl}/search/SearchWizard.jsp?${searchParams}`, {
      headers: {
        'User-Agent': 'CFM-Farm-Management/1.0',
        'Accept': 'text/html',
        'Referer': 'https://waterregister.waternsw.com.au/water-register-frame',
      },
    });

    if (!searchRes.ok) throw new Error(`Register returned ${searchRes.status}`);
    const html = await searchRes.text();

    // Step 2: Parse the HTML for WAL details
    const result = parseWalHtml(html, `WAL${walNum}`);

    console.log('Search HTML length:', html.length);
    console.log('Full HTML:', html);
    console.log('Parse result:', JSON.stringify(result));
    console.log('Search HTML snippet:', html.slice(0, 300));
    if (!result.found) {
      // Try the direct WAL folio URL
      const folioUrl = `${baseUrl}/search/SearchWizard.jsp?WAL=WAL${walNum}&action=detail`;
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
  if (!html.toLowerCase().includes('water source') && !html.toLowerCase().includes('aquifer')) return result;

  result.found = true;

  // Extract all <td> text content in order — the register uses a simple table
  const tdMatches = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
  const cells = tdMatches.map(m => m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim()).filter(Boolean);
  console.log('Parsed cells:', JSON.stringify(cells));

  // The result table columns are:
  // Category[Subcategory] | Status | Water Source | Tenure Type | Management Zone | Share Components (units or ML) | IDEC
  // Find the row after the header by looking for known category values
  const categoryKeywords = ['Aquifer','Regulated River','Unregulated River','Groundwater','Domestic','Supplementary','High Security','General Security','Surface Water'];
  
  for (let i = 0; i < cells.length; i++) {
    const isCategory = categoryKeywords.some(k => cells[i].includes(k));
    if (isCategory) {
      result.category = cells[i];
      result.status = cells[i+1] || null;
      result.waterSource = cells[i+2] || null;
      result.tenure = cells[i+3] || null;
      result.managementZone = cells[i+4] || null;
      // Share components — parse out the number
      const shareCell = cells[i+5] || '';
      const shareNum = shareCell.replace(/,/g,'').match(/([\d]+\.?\d*)/);
      if (shareNum) result.shareML = parseFloat(shareNum[1]);
      break;
    }
  }

  return result;
}