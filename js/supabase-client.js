// js/supabase-client.js
// Single source of truth for all Supabase interaction.
// NO localStorage. All state lives in Supabase or in-memory session only.

const SUPABASE_URL = 'https://nqvfuqvindsgnogejaei.supabase.co';
const SUPABASE_ANON_KEY = window.__CFM_ANON_KEY || '';  // injected at build or set via meta tag

// ── Session (in-memory only) ────────────────────────────────────────────────
let _session = null;        // { access_token, user, profile }
const _subscribers = [];    // session change listeners

export function getSession() { return _session; }

export function onSessionChange(fn) {
  _subscribers.push(fn);
  return () => _subscribers.splice(_subscribers.indexOf(fn), 1);
}

function _emit(session) {
  _session = session;
  _subscribers.forEach(fn => fn(session));
}

// ── Auth ────────────────────────────────────────────────────────────────────
export async function login(email, password) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'login', email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  _emit({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user, profile: data.profile });
  _scheduleRefresh(data.expires_in || 3600);
  return _session;
}

let _refreshTimer = null;
function _scheduleRefresh(expiresIn) {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  // Refresh 5 minutes before expiry
  const delay = Math.max((expiresIn - 300) * 1000, 30000);
  _refreshTimer = setTimeout(_refreshSession, delay);
}

async function _refreshSession() {
  if (!_session?.refresh_token) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: _session.refresh_token }),
    });
    if (!res.ok) { _emit(null); return; }
    const data = await res.json();
    _emit({ ..._session, access_token: data.access_token, refresh_token: data.refresh_token });
    _scheduleRefresh(data.expires_in || 3600);
  } catch {
    // Session expired — will prompt re-login on next request
  }
}

export function logout() {
  _emit(null);
}

// ── Generic REST helpers ─────────────────────────────────────────────────────
function _headers(extra = {}) {
  if (!_session) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${_session.access_token}`,
    'Prefer': 'return=representation',
    ...extra,
  };
}

export async function dbSelect(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: _headers(),
  });
  if (!res.ok) throw new Error(`GET ${table} failed: ${await res.text()}`);
  return res.json();
}

export async function dbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`INSERT ${table} failed: ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function dbUpdate(table, id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: _headers(),
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`UPDATE ${table} failed: ${await res.text()}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function dbUpsert(table, rows, onConflict = null) {
  const url = onConflict
    ? `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`
    : `${SUPABASE_URL}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ..._headers(),
      'Prefer': 'resolution=merge-duplicates return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`UPSERT ${table} failed: ${await res.text()}`);
}

export async function uploadFile(bucket, path, file) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${_session?.access_token || SUPABASE_ANON_KEY}`,
      'Content-Type': file.type,
      'x-upsert': 'true',
    },
    body: file,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Upload failed: ${err}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

export async function dbDelete(table, id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'DELETE',
    headers: _headers({ 'Prefer': 'return=minimal' }),
  });
  if (!res.ok) throw new Error(`DELETE ${table} failed: ${await res.text()}`);
}

// ── Realtime ─────────────────────────────────────────────────────────────────
// Lightweight WebSocket wrapper around Supabase Realtime.
// Each subscription returns an unsubscribe function.

const _realtimeChannels = new Map();

export function subscribeTable(table, farmId, onEvent) {
  if (!_session) throw new Error('Not authenticated');

  const channelKey = `${table}:${farmId}`;
  if (_realtimeChannels.has(channelKey)) {
    _realtimeChannels.get(channelKey).callbacks.push(onEvent);
    return () => _removeCallback(channelKey, onEvent);
  }

  const wsUrl = SUPABASE_URL
    .replace('https://', 'wss://')
    .replace('http://', 'ws://');

  const ws = new WebSocket(
    `${wsUrl}/realtime/v1/websocket?apikey=${SUPABASE_ANON_KEY}&vsn=1.0.0`
  );

  const channel = { ws, callbacks: [onEvent], joined: false };
  _realtimeChannels.set(channelKey, channel);

  ws.onopen = () => {
    // Join the channel for this table filtered by farm_id
    ws.send(JSON.stringify({
      topic: `realtime:public:${table}:farm_id=eq.${farmId}`,
      event: 'phx_join',
      payload: { user_token: _session.access_token },
      ref: '1',
    }));
  };

  ws.onmessage = (msg) => {
    try {
      const payload = JSON.parse(msg.data);
      if (payload.event === 'phx_reply' && payload.payload?.status === 'ok') {
        channel.joined = true;
      }
      if (['INSERT', 'UPDATE', 'DELETE'].includes(payload.event)) {
        channel.callbacks.forEach(cb => cb(payload.event, payload.payload));
      }
    } catch { /* ignore parse errors */ }
  };

  ws.onerror = (e) => console.warn(`Realtime error on ${channelKey}:`, e);
  ws.onclose = () => {
    _realtimeChannels.delete(channelKey);
    // Reconnect after 3s if session still active
    if (_session) setTimeout(() => subscribeTable(table, farmId, onEvent), 3000);
  };

  return () => _removeCallback(channelKey, onEvent);
}

function _removeCallback(channelKey, cb) {
  const channel = _realtimeChannels.get(channelKey);
  if (!channel) return;
  channel.callbacks = channel.callbacks.filter(fn => fn !== cb);
  if (channel.callbacks.length === 0) {
    channel.ws.close();
    _realtimeChannels.delete(channelKey);
  }
}

export function closeAllSubscriptions() {
  _realtimeChannels.forEach(ch => ch.ws.close());
  _realtimeChannels.clear();
}