// netlify/functions/xero-account-txns.js
// Returns individual transactions for one Xero account within a date range.
//
// GET /api/xero-account-txns?farm_id=farm_blackbull&account_id=UUID&from=2026-07-01&to=2026-10-21
//   OR with code or name instead of UUID:
// GET /api/xero-account-txns?farm_id=farm_blackbull&account_code=410&from=2026-07-01&to=2026-10-21
//
// Strategy: uses Xero's Reports/AccountTransactions endpoint which filters server-side.
// If accountId (UUID) is not known, resolves it from the Accounts list (one fast call),
// then calls AccountTransactions with that UUID. Total: 1-2 API calls, not 10+.
// This avoids the 60-second timeout caused by bulk-fetching all transactions.
//
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

// ── Format Xero date ─────────────────────────────────────────────────────────
function parseXeroDate(val) {
  if (!val) return null;
  const ms = val.match(/\/Date\((\d+)/);
  if (ms) return new Date(parseInt(ms[1])).toISOString().slice(0, 10);
  const d = new Date(val);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return val;
}

// ── Xero API helper ──────────────────────────────────────────────────────────
async function xeroGet(url, accessToken, tenantId, retries = 3) {
  const res = await fetch(url, {
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept':         'application/json',
    },
  });
  if (res.status === 429 && retries > 0) {
    // Respect Retry-After header if present, otherwise back off 2s → 4s → 8s
    const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
    const delay = retryAfter > 0 ? retryAfter * 1000 : (4 - retries) * 2000;
    await new Promise(r => setTimeout(r, delay));
    return xeroGet(url, accessToken, tenantId, retries - 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Xero API error ${res.status}: ${text}`);
  }
  return res.json();
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
  let   accountId   = params.account_id   || '';
  const fromDate    = params.from;
  const toDate      = params.to;
  let   accountName = params.account_name || '';
  const accountCode = params.account_code || '';

  if (!farmId || !fromDate || !toDate || (!accountId && !accountName && !accountCode)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'farm_id, from, to, and either account_id, account_code, or account_name are required' }),
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'from and to must be YYYY-MM-DD' }) };
  }

  console.log(`[xero-account-txns] PARAMS: farm=${farmId} accountId="${accountId}" accountCode="${accountCode}" accountName="${accountName}" from=${fromDate} to=${toDate}`);

  try {
    const { accessToken, tenantId } = await getAccessToken(farmId);

    // ── Resolve accountID from name/code if needed ───────────────────────────
    // We need accountId (UUID) to use the AccountTransactions report.
    // If we only have accountCode, look it up from the Accounts list.
    // This is ONE fast call vs fetching all transactions and filtering client-side.
    if (!accountId) {
      const acctData = await xeroGet('https://api.xero.com/api.xro/2.0/Accounts', accessToken, tenantId);
      const norm     = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const accounts = acctData.Accounts || [];

      let match = null;
      if (accountCode) {
        match = accounts.find(a => (a.Code || '') === accountCode);
      }
      if (!match && accountName) {
        const namNorm = norm(accountName);
        match = accounts.find(a => norm(a.Name) === namNorm)
             || accounts.find(a => norm(a.Name).includes(namNorm) || namNorm.includes(norm(a.Name)));
      }
      if (match) {
        accountId   = match.AccountID;
        accountName = match.Name;
        console.log(`[xero-account-txns] resolved → accountID=${accountId} code=${match.Code} name="${match.Name}"`);
      } else {
        console.warn(`[xero-account-txns] could not resolve accountID for code="${accountCode}" name="${accountName}"`);
      }
    }

    // ── Fetch via AccountTransactions report — Xero filters server-side ──────
    // This is ONE API call returning only transactions for this account.
    // Much faster than fetching all invoices/bank-txns and filtering client-side.
    const transactions = [];

    if (accountId) {
      const rUrl = new URL('https://api.xero.com/api.xro/2.0/Reports/AccountTransactions');
      rUrl.searchParams.set('AccountID', accountId);
      rUrl.searchParams.set('FromDate',  fromDate);
      rUrl.searchParams.set('ToDate',    toDate);

      console.log(`[xero-account-txns] fetching AccountTransactions report for accountId=${accountId}`);
      const reportData = await xeroGet(rUrl.toString(), accessToken, tenantId);
      const report     = reportData?.Reports?.[0];

      // Report rows: each row has Cells with transaction details
      // Typical columns: Date, Source, Description, Reference, Debit, Credit, Balance
      // (column order varies — find by header)
      const headerRow = report?.Rows?.find(r => r.RowType === 'Header');
      const headers   = (headerRow?.Cells || []).map(c => (c.Value || '').toLowerCase());

      const iDate  = headers.indexOf('date');
      const iSrc   = headers.findIndex(h => h.includes('source') || h.includes('type'));
      const iDesc  = headers.findIndex(h => h.includes('description') || h.includes('reference') || h.includes('details'));
      const iRef   = headers.findIndex(h => h.includes('reference'));
      const iDebit = headers.findIndex(h => h.includes('debit'));
      const iCred  = headers.findIndex(h => h.includes('credit'));

      console.log(`[xero-account-txns] report headers: ${JSON.stringify(headers)}`);

      for (const section of (report?.Rows || [])) {
        if (section.RowType === 'Header' || section.RowType === 'SummaryRow') continue;
        const rows = section.RowType === 'Section' ? (section.Rows || []) : [section];
        for (const row of rows) {
          if (row.RowType === 'SummaryRow' || row.RowType === 'Header') continue;
          const cells = row.Cells || [];
          if (!cells.length) continue;

          const val = (i) => (i >= 0 && cells[i] ? (cells[i].Value || '') : '');
          const dateStr = val(iDate);
          if (!dateStr || dateStr.toLowerCase() === 'date') continue; // skip header repeats

          const parsedDate = (() => {
            // Xero dates in reports come as "22 Oct 2026" or "2026-10-22"
            const d = new Date(dateStr);
            if (!isNaN(d)) return d.toISOString().slice(0, 10);
            return null;
          })();

          const debitAmt  = parseFloat((val(iDebit) || '0').replace(/,/g, ''))  || 0;
          const creditAmt = parseFloat((val(iCred)  || '0').replace(/,/g, ''))  || 0;
          if (debitAmt === 0 && creditAmt === 0) continue;

          const amount = debitAmt > 0 ? debitAmt : -creditAmt;
          const src    = val(iSrc);
          const desc   = val(iDesc);
          const ref    = iRef >= 0 && iRef !== iDesc ? val(iRef) : '';

          // Derive a type label from the source column
          const typeMap = { 'Bill': 'ACCPAY', 'Invoice': 'ACCREC', 'Spend Money': 'SPEND', 'Receive Money': 'RECEIVE', 'Manual Journal': 'MANUALJOURNAL' };
          const txnType = typeMap[src] || src || 'TXN';

          transactions.push({
            date:        parsedDate,
            type:        txnType,
            contact:     '',
            reference:   ref,
            description: desc,
            debit:       debitAmt,
            credit:      creditAmt,
            amount,
          });
        }
      }

      console.log(`[xero-account-txns] AccountTransactions report: ${transactions.length} rows`);
    } else {
      console.warn(`[xero-account-txns] no accountId resolved — cannot fetch transactions`);
    }

    // Sort by date ascending
    transactions.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    console.log(`[xero-account-txns] farm=${farmId} account=${accountId} (${accountName}) ${fromDate}→${toDate} txns=${transactions.length}`);

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
