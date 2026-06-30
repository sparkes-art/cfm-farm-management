// netlify/functions/xero-auth.js
// Handles Xero OAuth 2.0 flow
// GET /api/xero-auth?action=connect&farm_id=xxx  → redirects to Xero
// GET /api/xero-auth?action=callback&code=xxx&state=xxx → exchanges code for tokens

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID || 'E4E1BDEA8DFF417C88007214BD95EA61';
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET || 'bj8psa31mt2LZzb5xoi0SO3xwE-S-Vithy7S1PSbEPzUbrzL';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_URL = 'https://profound-tiramisu-8b956e.netlify.app';
const REDIRECT_URI = `${BASE_URL}/xero/callback`;
const SCOPES = 'openid profile email accounting.transactions accounting.contacts offline_access';

const sb = async (method, path, body = null) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'resolution=merge-duplicates return=minimal' : '',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && method === 'GET') return res.json();
  return res;
};

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const action = params.action;

  // Step 1: Redirect user to Xero login
  if (action === 'connect') {
    const farmId = params.farm_id;
    if (!farmId) return { statusCode: 400, body: 'Missing farm_id' };

    const state = Buffer.from(JSON.stringify({ farm_id: farmId, ts: Date.now() })).toString('base64');
    const authUrl = new URL('https://login.xero.com/identity/connect/authorize');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', XERO_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', state);

    console.log('Xero auth URL:', authUrl.toString());
    console.log('Client ID:', XERO_CLIENT_ID ? XERO_CLIENT_ID.slice(0,8) + '...' : 'MISSING');
    console.log('Redirect URI:', REDIRECT_URI);
    return {
      statusCode: 302,
      headers: { Location: authUrl.toString() },
      body: '',
    };
  }

  // Step 2: Exchange code for tokens (called from callback page)
  if (action === 'callback') {
    const { code, state, error } = params;

    if (error) return { statusCode: 400, body: JSON.stringify({ error }) };
    if (!code || !state) return { statusCode: 400, body: JSON.stringify({ error: 'Missing code or state' }) };

    let stateData;
    try { stateData = JSON.parse(Buffer.from(state, 'base64').toString()); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid state' }) }; }

    const farmId = stateData.farm_id;

    // Exchange code for tokens
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Token exchange failed: ' + err }) };
    }

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    // Get tenant info (which Xero orgs this token has access to)
    const tenantsRes = await fetch('https://api.xero.com/connections', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });
    const tenants = await tenantsRes.json();
    const tenant = tenants[0]; // take first org — user picks later if multiple

    // Store tokens in Supabase
    await sb('POST', 'xero_tokens?on_conflict=farm_id', {
      farm_id: farmId,
      tenant_id: tenant?.tenantId,
      tenant_name: tenant?.tenantName,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

    // Redirect back to CFM settings
    return {
      statusCode: 302,
      headers: { Location: `${BASE_URL}/#settings?xero=connected&farm=${farmId}` },
      body: '',
    };
  }

  // Get connection status for a farm
  if (action === 'status') {
    const farmId = params.farm_id;
    const rows = await sb('GET', `xero_tokens?farm_id=eq.${farmId}&select=tenant_name,expires_at,updated_at`);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.isArray(rows) ? rows[0] || null : null),
    };
  }

  // Refresh token
  if (action === 'refresh') {
    const farmId = params.farm_id;
    const rows = await sb('GET', `xero_tokens?farm_id=eq.${farmId}&select=refresh_token`);
    const refreshToken = Array.isArray(rows) ? rows[0]?.refresh_token : null;
    if (!refreshToken) return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'No token found' }) };

    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
    });

    if (!tokenRes.ok) return { statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Refresh failed' }) };

    const tokens = await tokenRes.json();
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await sb('POST', 'xero_tokens?on_conflict=farm_id', {
      farm_id: farmId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true }),
    };
  }

  return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unknown action' }) };
};