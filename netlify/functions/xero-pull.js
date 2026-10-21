// netlify/functions/xero-pull.js
// Pulls YTD expense actuals from Xero P&L for a CFM farm + season.
//
// GET /api/xero-pull?farm_id=farm_auski&season=2026-27
//
// Returns:
// {
//   ok: true,
//   ytd_from: '2026-07-01',
//   ytd_to:   '2026-10-31',
//   categories: {
//     labour:    123456.78,   // total actual spend YTD, positive = cost
//     overhead:  23456.78,
//     rm:        5678.90,
//     fund_mgmt: 9876.54,
//   },
//   accounts: [             // raw account lines for debugging / future use
//     { code, name, category, amount }
//   ]
// }
//
// Requires: accounting.reports.read scope (add when re-authorising Xero).

const XERO_CLIENT_ID     = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const SUPABASE_URL       = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Supabase helpers ────────────────────────────────────────────────────────
const sbGet = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return res.json();
};

const sbPatch = async (path, body) => {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
};

// ── Token management (mirrors xero-push.js) ─────────────────────────────────
async function getAccessToken(farmId) {
  const rows = await sbGet(`xero_tokens?farm_id=eq.${farmId}&select=*`);
  const token = rows[0];
  if (!token) throw new Error('Xero not connected for this farm. Please connect in Farm Settings.');

  const expiresAt = new Date(token.expires_at);
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }).toString(),
    });
    if (!tokenRes.ok) throw new Error('Xero token expired. Please reconnect in Farm Settings.');
    const refreshed = await tokenRes.json();
    await sbPatch(`xero_tokens?farm_id=eq.${farmId}`, {
      access_token:  refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at:    new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      updated_at:    new Date().toISOString(),
    });
    return { accessToken: refreshed.access_token, tenantId: token.tenant_id };
  }

  return { accessToken: token.access_token, tenantId: token.tenant_id };
}

// ── Date helpers ─────────────────────────────────────────────────────────────
function seasonDateRange(season, yearStartMonth = 7) {
  // season = '2026-27'  yearStartMonth = 7 (July)
  const startYear = parseInt(season.split('-')[0], 10);

  // Season start: e.g. 1 July 2026
  const fromDate = new Date(Date.UTC(startYear, yearStartMonth - 1, 1));

  // YTD end: today, but capped at season end (June 30 of following year)
  const seasonEndDate = new Date(Date.UTC(startYear + 1, yearStartMonth - 1, 0)); // last day before next season start
  const today = new Date();
  const toDate = today < seasonEndDate ? today : seasonEndDate;

  // Format YYYY-MM-DD
  const fmt = d => d.toISOString().slice(0, 10);
  return { from: fmt(fromDate), to: fmt(toDate) };
}

// ── Account-to-category mapping ───────────────────────────────────────────────
// Maps Xero account codes/names to CFM fixed-cost categories.
// Keys are lowercase partial account name or exact account code.
// The mapping is intentionally broad — add more patterns as you see your Xero chart of accounts.
//
// Priority: account_code match first, then name keyword match.
const CATEGORY_RULES = [
  // Labour & Farm Management
  { category: 'labour',    patterns: ['labour', 'labor', 'wages', 'salary', 'salaries', 'payroll', 'farm management fee', 'management fee', 'superannuation', 'super', 'workers comp', 'workcover'] },
  // Repairs & Maintenance
  { category: 'rm',        patterns: ['repairs', 'maintenance', 'r&m', 'plant repairs', 'vehicle repairs', 'irrigation', 'fencing', 'building repairs'] },
  // Fund Management / Finance
  { category: 'fund_mgmt', patterns: ['fund management', 'asset management', 'management fee', 'administration fee', 'interest', 'bank charges', 'finance charges', 'loan'] },
  // Overheads (catch-all for expense accounts not matched above)
  { category: 'overhead',  patterns: ['insurance', 'rates', 'electricity', 'power', 'fuel', 'freight', 'chemicals', 'seeds', 'fertiliser', 'fertilizer', 'telephone', 'accounting', 'legal', 'consulting', 'vehicle', 'motor', 'travel', 'subscriptions', 'office', 'cleaning', 'protective', 'equipment hire', 'contract', 'lease', 'rent', 'water'] },
];

function categoriseAccount(code, name) {
  const lName = (name || '').toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const pat of rule.patterns) {
      if (lName.includes(pat)) return rule.category;
    }
  }
  // Default unmapped expense accounts to overhead
  return 'overhead';
}

// ── Xero P&L report fetcher ───────────────────────────────────────────────────
async function fetchProfitAndLoss(accessToken, tenantId, fromDate, toDate) {
  const url = new URL('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss');
  url.searchParams.set('fromDate', fromDate);
  url.searchParams.set('toDate',   toDate);
  // Payments basis = cash; Accrual = invoice date basis. Accrual is more typical.
  url.searchParams.set('standardLayout', 'true');

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization':   `Bearer ${accessToken}`,
      'Xero-Tenant-Id':  tenantId,
      'Accept':          'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Xero P&L API error ${res.status}: ${errText}`);
  }

  return res.json();
}

// ── Parse Xero P&L report rows ────────────────────────────────────────────────
// Xero report structure:
// Reports[0].Rows[] → sections (SECTION rows) containing Rows[] of DETAIL rows
// Each DETAIL row has Cells: [ {Value: "Account Name"}, {Value: "123.45"}, ... ]
// Expense sections: 'Less Operating Expenses', 'Cost of Sales', etc.
function parseExpenseAccounts(reportData) {
  const accounts = [];

  const report = reportData?.Reports?.[0];
  if (!report) return accounts;

  for (const section of (report.Rows || [])) {
    if (section.RowType !== 'Section') continue;

    // Only pull expense / cost sections (skip Revenue, Tax)
    const title = (section.Title || '').toLowerCase();
    const isExpenseSection = title.includes('expense') || title.includes('cost') ||
                              title.includes('overhead') || title.includes('operating') ||
                              title === '';  // Xero sometimes has blank-title expense sections

    if (!isExpenseSection) continue;

    for (const row of (section.Rows || [])) {
      if (row.RowType !== 'Row') continue;
      const cells = row.Cells || [];
      if (cells.length < 2) continue;

      const nameCell   = cells[0];
      const amountCell = cells[1]; // first value column = YTD when single period

      const name   = nameCell?.Value || '';
      const code   = nameCell?.Attributes?.find(a => a.Id === 'account')?.Value || '';
      const rawAmt = parseFloat(amountCell?.Value?.replace(/,/g, '') || '0');

      // Skip totals / blank rows
      if (!name || name.toLowerCase().includes('total')) continue;
      if (rawAmt === 0) continue;

      // In Xero P&L, expenses are returned as positive numbers (debit balances)
      accounts.push({
        code,
        name,
        amount:   rawAmt,   // positive = cost
        category: categoriseAccount(code, name),
      });
    }
  }

  return accounts;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };

  const params   = event.queryStringParameters || {};
  const farmId   = params.farm_id;
  const season   = params.season;   // e.g. '2026-27'

  if (!farmId || !season) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'farm_id and season are required' }) };
  }

  try {
    // Load farm settings to get yearStartMonth
    const farms = await sbGet(`farms?id=eq.${farmId}&select=settings`);
    const farm  = farms[0];
    const yearStartMonth = farm?.settings?.yearStartMonth ?? 7;

    // Compute YTD date range
    const { from: ytdFrom, to: ytdTo } = seasonDateRange(season, yearStartMonth);

    // Get Xero token
    const { accessToken, tenantId } = await getAccessToken(farmId);

    // Fetch P&L from Xero
    const reportData = await fetchProfitAndLoss(accessToken, tenantId, ytdFrom, ytdTo);

    // Parse out expense accounts
    const accounts = parseExpenseAccounts(reportData);

    // Aggregate by CFM category
    const categories = { labour: 0, overhead: 0, rm: 0, fund_mgmt: 0 };
    for (const acc of accounts) {
      if (categories.hasOwnProperty(acc.category)) {
        categories[acc.category] += acc.amount;
      }
    }

    console.log(`[xero-pull] farm=${farmId} season=${season} ytd=${ytdFrom}→${ytdTo} accounts=${accounts.length}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok:         true,
        ytd_from:   ytdFrom,
        ytd_to:     ytdTo,
        categories,
        accounts,
      }),
    };

  } catch (err) {
    console.error('[xero-pull] error:', err.message);
    return {
      statusCode: err.message.includes('not connected') ? 404 : 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
