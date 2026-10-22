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
async function getAccessToken(farmId, force = false) {
  const rows  = await sbGet(`xero_tokens?farm_id=eq.${farmId}&select=*`);
  const token = rows[0];
  if (!token) throw new Error('Xero not connected for this farm. Please connect in Farm Settings.');

  const expiresAt = new Date(token.expires_at);
  const needsRefresh = force || (expiresAt - Date.now() < 5 * 60 * 1000);

  if (needsRefresh) {
    console.log(`[xero-account-txns] refreshing token for farm=${farmId} force=${force}`);
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }).toString(),
    });
    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error(`[xero-account-txns] token refresh failed ${tokenRes.status}: ${errText}`);
      throw new Error('Xero token expired. Please reconnect in Farm Settings.');
    }
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
// onUnauthorized: optional async () => newAccessToken — called once on 401 to force-refresh
async function xeroGet(url, accessToken, tenantId, retries = 3, onUnauthorized = null) {
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
    return xeroGet(url, accessToken, tenantId, retries - 1, onUnauthorized);
  }
  if (res.status === 401 && onUnauthorized) {
    // Token was stale despite expires_at — force a refresh and retry once
    console.warn('[xero-account-txns] got 401 — forcing token refresh and retrying');
    const newToken = await onUnauthorized();
    return xeroGet(url, newToken, tenantId, 0, null); // no further 401 retry
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
    'Cache-Control':               'no-store, no-cache, must-revalidate',
    'Netlify-CDN-Cache-Control':   'no-store',
    'Surrogate-Control':           'no-store',
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
    let { accessToken, tenantId } = await getAccessToken(farmId);

    // Helper passed to xeroGet so it can force-refresh on 401 and retry
    const forceRefresh = async () => {
      const t = await getAccessToken(farmId, true);
      accessToken = t.accessToken;
      return accessToken;
    };

    // ── Resolve accountID from name/code if needed ───────────────────────────
    // We need accountId (UUID) to use the AccountTransactions report.
    // If we only have accountCode, look it up from the Accounts list.
    // This is ONE fast call vs fetching all transactions and filtering client-side.
    if (!accountId) {
      const acctData = await xeroGet('https://api.xero.com/api.xro/2.0/Accounts', accessToken, tenantId, 3, forceRefresh);
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

    // ── Fetch via Invoices + BankTransactions — covered by accounting.invoices.read ─
    // Both endpoints support date filtering and line-item account filtering.
    // We fetch bills (ACCPAY) and spend-money transactions for the account in range.
    const transactions = [];

    if (accountId) {
      console.log(`[xero-account-txns] fetching invoices+banktxns for accountId=${accountId} accountCode="${accountCode}" ${fromDate}→${toDate}`);

      // Helper: extract matching line items from a document
      // Strict date post-filter ensures Xero's server-side filtering hasn't leaked
      // records outside the requested range (can happen when PAID status is included).
      const extractLines = (doc, docType, dateField, contactField) => {
        const rawDate = doc[dateField] || '';
        const msMatch = rawDate.match(/\/Date\((\d+)/);
        const date    = msMatch
          ? new Date(parseInt(msMatch[1])).toISOString().slice(0, 10)
          : new Date(rawDate).toISOString().slice(0, 10);

        // Strict date guard — drop anything outside [fromDate, toDate]
        if (date < fromDate || date > toDate) return;

        const contact = doc[contactField]?.Name || doc[contactField] || '';
        const ref     = doc.Reference || doc.InvoiceNumber || '';

        for (const line of (doc.LineItems || [])) {
          // Match by AccountID (UUID) or AccountCode
          if (line.AccountID !== accountId && line.AccountCode !== accountCode) continue;
          const amount = parseFloat(line.LineAmount) || 0;
          if (amount === 0) continue;
          transactions.push({
            date,
            type:        docType,
            contact,
            reference:   ref,
            description: line.Description || '',
            debit:       amount > 0 ? amount : 0,
            credit:      amount < 0 ? -amount : 0,
            amount,
          });
        }
      };

      // 1. Bills (ACCPAY) — supplier bills / purchase invoices
      const invUrlPay = new URL('https://api.xero.com/api.xro/2.0/Invoices');
      invUrlPay.searchParams.set('Type',     'ACCPAY');
      invUrlPay.searchParams.set('Statuses', 'AUTHORISED,PAID');
      invUrlPay.searchParams.set('DateFrom', fromDate);
      invUrlPay.searchParams.set('DateTo',   toDate);
      invUrlPay.searchParams.set('unitdp',   '4');

      const invPayData = await xeroGet(invUrlPay.toString(), accessToken, tenantId, 3, forceRefresh);
      for (const inv of (invPayData?.Invoices || [])) extractLines(inv, 'ACCPAY', 'Date', 'Contact');
      console.log(`[xero-account-txns] ACCPAY invoices: ${invPayData?.Invoices?.length || 0}, matched lines so far: ${transactions.length}`);

      // 2. Sales invoices (ACCREC) — revenue or adjustments that credit expense accounts
      const invUrlRec = new URL('https://api.xero.com/api.xro/2.0/Invoices');
      invUrlRec.searchParams.set('Type',     'ACCREC');
      invUrlRec.searchParams.set('Statuses', 'AUTHORISED,PAID');
      invUrlRec.searchParams.set('DateFrom', fromDate);
      invUrlRec.searchParams.set('DateTo',   toDate);
      invUrlRec.searchParams.set('unitdp',   '4');

      const invRecData = await xeroGet(invUrlRec.toString(), accessToken, tenantId, 3, forceRefresh);
      for (const inv of (invRecData?.Invoices || [])) extractLines(inv, 'ACCREC', 'Date', 'Contact');
      console.log(`[xero-account-txns] ACCREC invoices: ${invRecData?.Invoices?.length || 0}, matched lines so far: ${transactions.length}`);

      // 3. Spend Money + Receive Money bank transactions
      // NOTE: BankTransactions endpoint uses 'dateFrom'/'dateTo' (not 'FromDate'/'ToDate' like Invoices)
      // We fetch both types in one call by omitting Type and filtering client-side, to avoid two round trips.
      // Alternatively pass Type=SPEND and Type=RECEIVE separately with correct param names.
      const btUrlSpend = new URL('https://api.xero.com/api.xro/2.0/BankTransactions');
      btUrlSpend.searchParams.set('Type',     'SPEND');
      btUrlSpend.searchParams.set('dateFrom', fromDate);
      btUrlSpend.searchParams.set('dateTo',   toDate);

      const btSpendData = await xeroGet(btUrlSpend.toString(), accessToken, tenantId, 3, forceRefresh);
      for (const bt of (btSpendData?.BankTransactions || [])) extractLines(bt, 'SPEND', 'Date', 'Contact');
      console.log(`[xero-account-txns] SPEND banktxns: ${btSpendData?.BankTransactions?.length || 0}, matched lines so far: ${transactions.length}`);

      // 4. Receive Money bank transactions — cash receipts that may hit expense accounts
      const btUrlRecv = new URL('https://api.xero.com/api.xro/2.0/BankTransactions');
      btUrlRecv.searchParams.set('Type',     'RECEIVE');
      btUrlRecv.searchParams.set('dateFrom', fromDate);
      btUrlRecv.searchParams.set('dateTo',   toDate);

      const btRecvData = await xeroGet(btUrlRecv.toString(), accessToken, tenantId, 3, forceRefresh);
      for (const bt of (btRecvData?.BankTransactions || [])) extractLines(bt, 'RECEIVE', 'Date', 'Contact');
      console.log(`[xero-account-txns] RECEIVE banktxns: ${btRecvData?.BankTransactions?.length || 0}, matched lines so far: ${transactions.length}`);

      console.log(`[xero-account-txns] total matched lines: ${transactions.length}`);

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
