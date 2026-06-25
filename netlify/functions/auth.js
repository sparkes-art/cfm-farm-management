// netlify/functions/auth.js
// Handles email/password auth via Netlify function (avoids Supabase auth endpoint reliability issues)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action, email, password } = body;

  if (!action || !email || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }

  const endpoint = action === 'signup'
    ? `${SUPABASE_URL}/auth/v1/signup`
    : `${SUPABASE_URL}/auth/v1/token?grant_type=password`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers,
        body: JSON.stringify({ error: data.error_description || data.message || 'Auth failed' }),
      };
    }

    // For login, fetch the user profile too
    if (action === 'login' && data.access_token) {
      const profileRes = await fetch(
        `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${data.user.id}&select=*`,
        {
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${data.access_token}`,
          },
        }
      );
      const profiles = await profileRes.json();
      const profile = profiles[0] || null;

      // Check if user is deactivated
      if (profile && profile.is_active === false) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Your account has been deactivated. Please contact your administrator.' }),
        };
      }

      data.profile = profile;
    }

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    console.error('Auth function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
