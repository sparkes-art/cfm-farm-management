// js/main.js
// App bootstrap — auth, navigation, module loading
// No localStorage. No caching. Pure Supabase.

import { initSupabase, getSupabase } from './supabase-client.js';
import { setActiveFarm, getActiveFarm, setActiveSeason, getActiveSeason, loadFarms, getFarms } from './app-state.js';

// ── Module loader map ─────────────────────────────────────────────────────────
// Each entry is a lazy import — only loaded when that module is first navigated to.

const MODULE_LOADERS = {
  outputs: async () => {
    const m = await import('../modules/outputs/outputs.js');
    return { mount: m.mountOutputs };
  },
  inputs: async () => {
    const m = await import('../modules/inputs/inputs.js');
    return { mount: m.mountInputs };
  },
  budget: async () => {
    const m = await import('../modules/budget/budget.js');
    return { mount: m.mountBudget };
  },
  'gross-margin': async () => {
    const m = await import('../modules/gross-margin/gross-margin.js');
    return { mount: m.mountGrossMargin };
  },
  agronomy: async () => {
    const m = await import('../modules/agronomy/agronomy.js');
    return { mount: m.mountAgronomy };
  },
  weather: async () => {
    const m = await import('../modules/weather/weather.js');
    return { mount: m.mountWeather };
  },
  settings: async () => {
    const m = await import('../modules/settings/commodities-settings.js');
    return { mount: m.mountCommoditySettings };
  },
};

// ── Cached module instances ───────────────────────────────────────────────────
const _moduleCache = {};
let _currentModule = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Auth flow ─────────────────────────────────────────────────────────────────

async function _tryLogin(email, password) {
  const res = await fetch('/.netlify/functions/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data; // { access_token, user }
}

function _storeSession(token, user) {
  // Session kept only in memory — no localStorage
  window.__cfmSession = { token, user };
  getSupabase().auth.setSession({ access_token: token, refresh_token: token });
}

function _getSession() {
  return window.__cfmSession || null;
}

function _clearSession() {
  window.__cfmSession = null;
}

// ── Navigation ────────────────────────────────────────────────────────────────

async function _navigateTo(moduleName) {
  const main = $('main-content') || $('main');
  if (!main) return;

  // Update active nav state
  document.querySelectorAll('[data-module]').forEach(el => {
    el.classList.toggle('active', el.dataset.module === moduleName);
  });

  main.innerHTML = `<div class="loading-state">Loading…</div>`;

  try {
    // Load module if not cached
    if (!_moduleCache[moduleName]) {
      const loader = MODULE_LOADERS[moduleName];
      if (!loader) {
        main.innerHTML = `<div class="empty-state"><p>Module "${moduleName}" not found.</p></div>`;
        return;
      }
      _moduleCache[moduleName] = await loader();
    }

    _currentModule = moduleName;
    main.innerHTML = '';
    await _moduleCache[moduleName].mount(main);

  } catch (err) {
    console.error(`Module load error (${moduleName}):`, err);
    main.innerHTML = `
      <div class="card">
        <div class="card-body">
          <div class="empty-state">
            <p>Failed to load ${moduleName} module.</p>
            <p class="text-muted small">${err.message}</p>
          </div>
        </div>
      </div>`;
  }
}

// ── Season selector ───────────────────────────────────────────────────────────

function _buildSeasonOptions() {
  const currentYear = new Date().getFullYear();
  const seasons = [];
  for (let y = currentYear + 1; y >= currentYear - 4; y--) {
    seasons.push(`${y-1}-${String(y).slice(2)}`);
  }
  return seasons;
}

function _initSeasonSelector() {
  const sel = $('season-select');
  if (!sel) return;

  const seasons = _buildSeasonOptions();
  sel.innerHTML = seasons.map(s =>
    `<option value="${s}" ${s === getActiveSeason() ? 'selected' : ''}>${s}</option>`
  ).join('');

  sel.addEventListener('change', () => {
    setActiveSeason(sel.value);
    // Reload current module to reflect new season
    if (_currentModule) {
      delete _moduleCache[_currentModule];
      _navigateTo(_currentModule);
    }
  });
}

// ── Farm selector ─────────────────────────────────────────────────────────────

function _initFarmSelector(farms) {
  const sel = $('farm-select');
  if (!sel || !farms?.length) return;

  sel.innerHTML = farms.map(f =>
    `<option value="${f.id}" ${f.id === getActiveFarm() ? 'selected' : ''}>${f.name}</option>`
  ).join('');

  sel.addEventListener('change', () => {
    setActiveFarm(sel.value);
    // Clear module cache — new farm context
    Object.keys(_moduleCache).forEach(k => delete _moduleCache[k]);
    if (_currentModule) _navigateTo(_currentModule);
  });
}

// ── Sidebar nav ───────────────────────────────────────────────────────────────

function _initNav() {
  document.querySelectorAll('[data-module]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      const mod = el.dataset.module;
      if (mod) _navigateTo(mod);

      // Close mobile drawer if open
      const drawer  = $('mobile-drawer');
      const overlay = $('mobile-overlay');
      drawer?.classList.remove('open');
      overlay?.classList.remove('open');

      // Update active on all nav links
      document.querySelectorAll('[data-module]').forEach(a =>
        a.classList.toggle('active', a.dataset.module === mod));
    });
  });
}

// ── Mobile nav ────────────────────────────────────────────────────────────────

function _initMobileNav() {
  const hamburger = $('mobile-hamburger');
  const drawer    = $('mobile-drawer');
  const overlay   = $('mobile-overlay');

  hamburger?.addEventListener('click', () => {
    drawer?.classList.toggle('open');
    overlay?.classList.toggle('open');
  });

  overlay?.addEventListener('click', () => {
    drawer?.classList.remove('open');
    overlay?.classList.remove('open');
  });

  // Wire up drawer nav links
  drawer?.querySelectorAll('[data-module]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      drawer.classList.remove('open');
      overlay?.classList.remove('open');
      _navigateTo(el.dataset.module);
      document.querySelectorAll('[data-module]').forEach(a =>
        a.classList.toggle('active', a.dataset.module === el.dataset.module));
    });
  });
}

// ── App init ──────────────────────────────────────────────────────────────────

async function _initApp(user) {
  // Show app shell
  $('login-page')?.classList.add('hidden');
  $('app')?.classList.remove('hidden');

  // Show user info
  const userDisplay = $('user-info-display');
  if (userDisplay) userDisplay.textContent = user.email;

  // Load farms
  try {
    const farms = await loadFarms(user);
    _initFarmSelector(farms);
  } catch (err) {
    console.error('Failed to load farms:', err);
  }

  // Season selector
  _initSeasonSelector();

  // Nav
  _initNav();
  _initMobileNav();

  // Logout
  $('btn-logout')?.addEventListener('click', () => {
    _clearSession();
    location.reload();
  });

  // Default module
  _navigateTo('outputs');
}

// ── Login page ────────────────────────────────────────────────────────────────

function _initLoginPage() {
  const btn   = $('btn-login');
  const email = $('login-email');
  const pass  = $('login-password');
  const err   = $('login-error');

  async function attemptLogin() {
    if (!email.value || !pass.value) return;
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    if (err) err.classList.add('hidden');

    try {
      const data = await _tryLogin(email.value.trim(), pass.value);
      _storeSession(data.access_token, data.user);
      await _initApp(data.user);
    } catch (e) {
      if (err) {
        err.textContent = e.message;
        err.classList.remove('hidden');
      }
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  }

  btn?.addEventListener('click', attemptLogin);
  pass?.addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

(async function bootstrap() {
  await initSupabase();

  // Check for existing in-memory session (page refresh loses it — by design)
  const session = _getSession();
  if (session) {
    await _initApp(session.user);
  } else {
    $('app')?.classList.add('hidden');
    $('login-page')?.classList.remove('hidden');
    _initLoginPage();
  }
})();