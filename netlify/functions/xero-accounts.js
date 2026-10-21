// netlify/functions/xero-accounts.js
// Returns the Xero chart of accounts for a farm.
// Used to populate the Xero account mapping dropdowns in the management report.
//
// GET /api/xero-accounts?farm_id=farm_blackbull
//
// Returns:
// {
//   ok: true,
//   accounts: [
//     { AccountID, Code, Name, Type, Status }
//   ]
// }
//
// Only one Xero org per farm — token is keyed to farm_id.

const XERO_CLIENT_ID           = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET       = process.env.XERO_CLIENT_SECRET;
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

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'GET')     return { statusCode: 405, headers, body: JSON.stringify({ error: 'GET only' }) };

  const params = event.queryStringParameters || {};
  const farmId = params.farm_id;

  if (!farmId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'farm_id is required' }) };
  }

  try {
    const { accessToken, tenantId } = await getAccessToken(farmId);

    // Fetch chart of accounts
    const res = await fetch('https://api.xero.com/api.xro/2.0/Accounts', {
      headers: {
        'Authorization':  `Bearer ${accessToken}`,
        'Xero-Tenant-Id': tenantId,
        'Accept':         'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Xero Accounts API error ${res.status}: ${text}`);
    }

    const data     = await res.json();
    const accounts = (data.Accounts || [])
      // Only expense-type accounts are useful for cost line mapping
      .filter(a => a.Status === 'ACTIVE')
      .map(a => ({
        AccountID: a.AccountID,
        Code:      a.Code      || '',
        Name:      a.Name      || '',
        Type:      a.Type      || '',
        Class:     a.Class     || '',
      }))
      .sort((a, b) => {
        // Sort expenses first, then by code, then by name
        const classOrder = ['EXPENSE', 'REVENUE', 'ASSET', 'LIABILITY', 'EQUITY'];
        const ai = classOrder.indexOf(a.Class);
        const bi = classOrder.indexOf(b.Class);
        if (ai !== bi) return ai - bi;
        if (a.Code && b.Code) return a.Code.localeCompare(b.Code);
        return a.Name.localeCompare(b.Name);
      });

    console.log(`[xero-accounts] farm=${farmId} returned ${accounts.length} active accounts`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, accounts }),
    };

  } catch (err) {
    console.error('[xero-accounts] error:', err.message);
    return {
      statusCode: err.message.includes('not connected') ? 404 : 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};
