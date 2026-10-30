// netlify/functions/reset-password.js
// Handles password reset flow:
//   action=request  → sends a reset email via Supabase
//   action=update   → sets new password using the recovery token

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_URL = process.env.URL || 'https://cfm-farm.netlify.app';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    };
  }

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

  const { action, email, access_token, new_password } = body;

  // ── Request reset email ─────────────────────────────────────────────────────
  if (action === 'request') {
    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          email,
          redirect_to: `${SITE_URL}/?reset=1`,
        }),
      });

      // Supabase returns 200 even if email not found (security best practice)
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true }),
      };
    } catch (err) {
      console.error('Reset request error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  // ── Update password using recovery token ────────────────────────────────────
  if (action === 'update') {
    if (!access_token || !new_password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token or password' }) };
    }
    if (new_password.length < 8) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
    }

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${access_token}`,
        },
        body: JSON.stringify({ password: new_password }),
      });

      const data = await res.json();

      if (!res.ok) {
        return {
          statusCode: res.status,
          headers,
          body: JSON.stringify({ error: data.message || 'Failed to update password' }),
        };
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      console.error('Reset update error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
};
