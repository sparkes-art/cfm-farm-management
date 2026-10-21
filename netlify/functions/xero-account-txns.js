// netlify/functions/xero-account-txns.js
// Returns individual transactions for one Xero account within a date range.
//
// GET /api/xero-account-txns?farm_id=farm_blackbull&account_id=UUID&from=2026-07-01&to=2026-10-21
//
// Returns:
// {
//   ok: true,
//   account_name: 'Hire of Plant',
//   account_code: '630',
//   from: '2026-07-01',
//   to:   '2026-10-21',
//   transactions: [
//     { date, contact, description, reference, amount, type }
//   ]
// }
//
// Uses Xero Account Transactions report (accounting.reports.read scope).
// One Xero org per farm — token keyed to farm_id, no cross-farm access.

const XERO_CLIENT_ID          = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET      = process.env.XERO_CLIENT_SECRET;
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// ── Supabase helpers ────────────────────────────────────────────────────────
const sbGet = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey':        SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return res.json();
};

const sbPatch = async (path, body) => {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey':         SUPABASE_SERVICE_ROLE_KEY,
      'Authorization':  `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':   'application/json',
      'Prefer':         'return=minimal',
    },
    body: JSON.stringify(body),
  });
};

// ── Token management (mirrors xero-pull.js) ─────────────────────────────────
async function getAccessToken(farmId) {
  const rows  = await sbGet(`xero_tokens?farm_id=eq.${farmId}&select=*`);
  const token = rows[0];
  if (!token) throw new Error('Xero not connected for this farm. Please connect in Farm Settings.');

  const expiresAt = new Date(token.expires_at);
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
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

// ── Parse Xero Journals response ──────────────────────────────────────────────
// Uses GET /api.xro/2.0/Journals (accounting.manualjournals.read scope).
// Each journal has JournalLines[] — we filter to lines matching our accountID.
// Journal types: ACCPAY (bill), ACCREC (invoice), SPEND, RECEIVE, MANJOURNAL, etc.
function parseJournals(journalsData, accountId) {
  const txns = [];
  const journals = journalsData?.Journals || [];

  for (const j of journals) {
    const dateStr = j.JournalDate || '';
    const ref     = j.Reference   || '';
    const type    = j.SourceType  || '';

    for (const line of (j.JournalLines || [])) {
      if (line.AccountID !== accountId) continue;

      const net = parseFloat(line.NetAmount) || 0;
      if (net === 0) continue;

      // NetAmount: positive = debit (expense increase), negative = credit (reversal)
      txns.push({
        date:      dateStr,
        type,
        contact:   j.SourceType === 'ACCPAY' ? (line.Description || '') : (line.Description || ''),
        reference: ref,
        debit:     net > 0 ? net  : 0,
        credit:    net < 0 ? -net : 0,
        amount:    net,
        description: line.Description || '',
      });
    }
  }

  return txns;
}

// ── Format Xero date ─────────────────────────────────────────────────────────
// Xero returns dates as '/Date(1696118400000+0000)/' or 'DD MMM YYYY'
function parseXeroDate(val) {
  if (!val) return null;
  const ms = val.match(/\/Date\((\d+)/);
  if (ms) return new Date(parseInt(ms[1])).toISOString().slice(0, 10);
  // Try to parse 'DD MMM YYYY'
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return val;
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };

  const params      = event.queryStringParameters || {};
  const farmId      = params.farm_id;
  let   accountId   = params.account_id   || ''; // Xero UUID — may be empty, resolved below if so
  const fromDate    = params.from;                // YYYY-MM-DD
  const toDate      = params.to;                  // YYYY-MM-DD
  let   accountName = params.account_name || '';  // Xero account name — used to resolve UUID if needed
  const accountCode = params.account_code || '';

  if (!farmId || !fromDate || !toDate || (!accountId && !accountName)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'farm_id, from, to, and either account_id or account_name are required' }),
    };
  }

  // Basic date format check
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'from and to must be YYYY-MM-DD' }) };
  }

  try {
    const { accessToken, tenantId } = await getAccessToken(farmId);

    // ── Resolve accountID from name if not provided ──────────────────────────
    // Xero P&L reports don't always include accountID in cell attributes,
    // so we fall back to looking it up via the Accounts endpoint by name.
    if (!accountId && accountName) {
      const acctRes  = await fetch('https://api.xero.com/api.xro/2.0/Accounts', {
        headers: {
          'Authorization':  `Bearer ${accessToken}`,
          'Xero-Tenant-Id': tenantId,
          'Accept':         'application/json',
        },
      });
      if (acctRes.ok) {
        const acctData = await acctRes.json();
        const norm     = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const namNorm  = norm(accountName);
        const match    = (acctData.Accounts || []).find(a => norm(a.Name) === namNorm || norm(a.Name).includes(namNorm) || namNorm.includes(norm(a.Name)));
        if (match) {
          accountId   = match.AccountID;
          accountName = match.Name; // use canonical Xero name
          console.log(`[xero-account-txns] resolved "${accountName}" → accountID=${accountId}`);
        } else {
          console.warn(`[xero-account-txns] could not resolve accountID for name="${accountName}"`);
        }
      }
    }

    if (!accountId) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ ok: false, error: `Could not find a Xero account matching "${accountName}". Check your Xero chart of accounts.` }),
      };
    }

    // Fetch journals for the date range — accounting.manualjournals.read scope
    // Journals cover all account movements: bills (ACCPAY), spend money, manual journals, etc.
    // Xero returns max 100 journals per page; paginate with offset.
    let allJournals = [];
    let offset = 0;
    const pageSize = 100;
    while (true) {
      const url = new URL('https://api.xero.com/api.xro/2.0/Journals');
      url.searchParams.set('offset', offset);
      // Xero Journals API doesn't support date filtering natively — filter client-side
      const res = await fetch(url.toString(), {
        headers: {
          'Authorization':  `Bearer ${accessToken}`,
          'Xero-Tenant-Id': tenantId,
          'Accept':         'application/json',
          'If-Modified-Since': fromDate, // reduces payload — Xero uses this as a modified-since filter
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Xero Journals API error ${res.status}: ${errText}`);
      }

      const data     = await res.json();
      const page     = data?.Journals || [];
      allJournals    = allJournals.concat(page);
      if (page.length < pageSize) break;
      offset += pageSize;
      if (offset > 2000) break; // safety cap
    }

    // Filter journals to the requested date range
    const from = new Date(fromDate);
    const to   = new Date(toDate);
    to.setHours(23, 59, 59, 999);

    const filteredJournals = allJournals.filter(j => {
      const d = parseXeroDate(j.JournalDate);
      if (!d) return false;
      const jd = new Date(d);
      return jd >= from && jd <= to;
    });

    const rawTxns = parseJournals({ Journals: filteredJournals }, accountId);

    // Parse dates to ISO format
    const transactions = rawTxns.map(t => ({ ...t, date: parseXeroDate(t.date) }));

    console.log(`[xero-account-txns] farm=${farmId} account=${accountId} (${accountName}) ${fromDate}→${toDate} journals=${allJournals.length} filtered=${filteredJournals.length} txns=${transactions.length}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok:           true,
        account_id:   accountId,
        account_name: accountName,
        account_code: accountCode,
        from:         fromDate,
        to:           toDate,
        transactions,
      }),
    };

  } catch (err) {
    console.error('[xero-account-txns] error:', err.message);
    return {
      statusCode: err.message.includes('not connected') ? 404 : 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
