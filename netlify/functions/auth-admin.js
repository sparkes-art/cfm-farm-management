// netlify/functions/auth-admin.js
// Admin auth operations — password reset
// Only callable from authenticated admin sessions

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, user_id, password } = body;

  const serviceHeaders = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  };

  // Create user + profile in one call
  if (action === 'create_user') {
    const { email, password, full_name, role, farm_access } = body;
    if (!email || !password) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing email or password' }) };

    // Create auth user via admin API
    const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: serviceHeaders,
      body: JSON.stringify({ email, password, email_confirm: true }),
    });

    const authData = await authRes.json();
    if (!authRes.ok) {
      return { statusCode: authRes.status, headers, body: JSON.stringify({ error: authData.message || 'Failed to create user' }) };
    }

    const userId = authData.id;

    // Create profile using service role (bypasses RLS)
    const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/user_profiles`, {
      method: 'POST',
      headers: { ...serviceHeaders, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        id: userId,
        full_name: full_name || null,
        role: role || 'operational',
        farm_access: farm_access || [],
        is_active: true,
      }),
    });

    if (!profileRes.ok) {
      const err = await profileRes.text();
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'User created but profile failed: ' + err }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, user_id: userId }) };
  }

  if (action === 'reset_password') {
    if (!user_id || !password) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing user_id or password' }) };

    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, {
      method: 'PUT',
      headers: serviceHeaders,
      body: JSON.stringify({ password }),
    });

    if (!res.ok) {
      const err = await res.json();
      return { statusCode: res.status, headers, body: JSON.stringify({ error: err.message || 'Failed to reset password' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
