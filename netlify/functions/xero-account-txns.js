// netlify/functions/xero-account-txns.js
// Returns individual transactions for one Xero account within a date range.
//
// GET /api/xero-account-txns?farm_id=farm_blackbull&account_id=UUID&from=2026-07-01&to=2026-10-21
//   OR with name instead of UUID:
// GET /api/xero-account-txns?farm_id=farm_blackbull&account_name=Hire+of+Plant&from=2026-07-01&to=2026-10-21
//
// Strategy: uses accounting.invoices.read (bills = ACCPAY type) which is always in scope.
// Fetches all approved bills in the date range, then filters line items to those
// matching the target account by AccountID or account Code.
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

  if (!farmId || !fromDate || !toDate || (!accountId && !accountName)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'farm_id, from, to, and either account_id or account_name are required' }),
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'from and to must be YYYY-MM-DD' }) };
  }

  try {
    const { accessToken, tenantId } = await getAccessToken(farmId);

    // ── Resolve accountID and code from name if not provided ─────────────────
    let resolvedCode = accountCode;
    if (!accountId && accountName) {
      const acctData = await xeroGet('https://api.xero.com/api.xro/2.0/Accounts', accessToken, tenantId);
      const norm     = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const namNorm  = norm(accountName);
      const match    = (acctData.Accounts || []).find(a =>
        norm(a.Name) === namNorm ||
        norm(a.Name).includes(namNorm) ||
        namNorm.includes(norm(a.Name))
      );
      if (match) {
        accountId    = match.AccountID;
        accountName  = match.Name;
        resolvedCode = match.Code || '';
        console.log(`[xero-account-txns] resolved "${accountName}" → accountID=${accountId} code=${resolvedCode}`);
      } else {
        console.warn(`[xero-account-txns] could not resolve accountID for name="${accountName}"`);
      }
    }

    // ── Fetch transactions from multiple Xero sources ────────────────────────
    // Xero P&L expense figures can come from:
    //   1. Bills (ACCPAY invoices) — supplier invoices posted to expense accounts
    //   2. Bank transactions (BankTransactions type=SPEND) — direct spend money entries
    //   3. Sales invoices (ACCREC) — less common for expenses but possible
    // We fetch all three and filter line items by account UUID or code.
    const transactions = [];
    const seenKeys = new Set(); // deduplicate across sources

    // ── Source 1 & 3: Invoices (ACCPAY bills + ACCREC sales) ─────────────────
    for (const type of ['ACCPAY', 'ACCREC']) {
      let page = 1;
      while (true) {
        const url = new URL('https://api.xero.com/api.xro/2.0/Invoices');
        url.searchParams.set('Type',     type);
        url.searchParams.set('Statuses', 'AUTHORISED,PAID');
        url.searchParams.set('DateFrom', fromDate);
        url.searchParams.set('DateTo',   toDate);
        url.searchParams.set('page',     page);
        url.searchParams.set('unitdp',   '4');

        const data     = await xeroGet(url.toString(), accessToken, tenantId);
        const invoices = data?.Invoices || [];

        for (const inv of invoices) {
          const invDate = parseXeroDate(inv.Date);
          // Belt-and-braces date filter — Xero sometimes ignores DateFrom/DateTo
          if (invDate && (invDate < fromDate || invDate > toDate)) continue;

          const contact = inv.Contact?.Name || '';
          const ref     = inv.Reference || inv.InvoiceNumber || '';
          const invType = inv.Type;

          for (const line of (inv.LineItems || [])) {
            const lineAcctId   = line.AccountID   || '';
            const lineAcctCode = line.AccountCode || '';

            const matchedById   = accountId    && lineAcctId   === accountId;
            const matchedByCode = resolvedCode && lineAcctCode === resolvedCode;
            if (!matchedById && !matchedByCode) continue;

            const lineAmt = parseFloat(line.LineAmount) || 0;
            if (lineAmt === 0) continue;

            const dedupKey = inv.InvoiceID + '|' + (line.LineItemID || line.Description || '') + '|' + lineAmt;
            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);

            transactions.push({
              date:        invDate,
              type:        invType,
              contact,
              reference:   ref,
              description: line.Description || '',
              debit:       lineAmt > 0 ? lineAmt  : 0,
              credit:      lineAmt < 0 ? -lineAmt : 0,
              amount:      lineAmt,
            });
          }
        }

        if (invoices.length < 100) break;
        page++;
        if (page > 20) break;
      }
    }

    // ── Source 2: Bank transactions (SPEND / RECEIVE) ─────────────────────────
    // These are "Spend Money" / "Receive Money" entries in Xero bank accounts.
    // They often drive P&L expense accounts but are NOT returned by the Invoices API.
    try {
      let bankPage = 1;
      while (true) {
        const bUrl = new URL('https://api.xero.com/api.xro/2.0/BankTransactions');
        bUrl.searchParams.set('Statuses', 'AUTHORISED');
        bUrl.searchParams.set('DateFrom', fromDate);
        bUrl.searchParams.set('DateTo',   toDate);
        bUrl.searchParams.set('page',     bankPage);
        bUrl.searchParams.set('unitdp',   '4');

        const bData  = await xeroGet(bUrl.toString(), accessToken, tenantId);
        const bTxns  = bData?.BankTransactions || [];

        for (const bt of bTxns) {
          const btDate = parseXeroDate(bt.Date);
          if (btDate && (btDate < fromDate || btDate > toDate)) continue;

          const contact = bt.Contact?.Name || '';
          const ref     = bt.Reference || '';
          const btType  = bt.Type; // SPEND or RECEIVE

          for (const line of (bt.LineItems || [])) {
            const lineAcctId   = line.AccountID   || '';
            const lineAcctCode = line.AccountCode || '';

            const matchedById   = accountId    && lineAcctId   === accountId;
            const matchedByCode = resolvedCode && lineAcctCode === resolvedCode;
            if (!matchedById && !matchedByCode) continue;

            const lineAmt = parseFloat(line.LineAmount) || 0;
            if (lineAmt === 0) continue;

            const dedupKey = bt.BankTransactionID + '|' + (line.LineItemID || line.Description || '') + '|' + lineAmt;
            if (seenKeys.has(dedupKey)) continue;
            seenKeys.add(dedupKey);

            // SPEND = expense (positive amount), RECEIVE = income (show as negative)
            const signedAmt = btType === 'RECEIVE' ? -lineAmt : lineAmt;

            transactions.push({
              date:        btDate,
              type:        btType,
              contact,
              reference:   ref,
              description: line.Description || '',
              debit:       signedAmt > 0 ? signedAmt  : 0,
              credit:      signedAmt < 0 ? -signedAmt : 0,
              amount:      signedAmt,
            });
          }
        }

        if (bTxns.length < 100) break;
        bankPage++;
        if (bankPage > 20) break;
      }
    } catch (bankErr) {
      // BankTransactions may not be in scope — log and continue with invoice results
      console.warn('[xero-account-txns] BankTransactions fetch failed (may be out of scope):', bankErr.message);
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
        account_code: resolvedCode,
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
