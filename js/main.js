// js/main.js
// App bootstrap — auth, navigation, module loading
// No localStorage. No caching. Pure Supabase.

import { login, logout, onSessionChange } from './supabase-client.js?v=1783290066771';
import { on, setActiveFarm, setActiveModule, getFarms, getState, getActiveFarm, getActiveSeason, setActiveSeason } from './app-state.js?v=1783290066771';
import { toast, show, hide, qs } from './ui.js?v=1783290066771';

// Module loaders (lazy — only imported when navigated to)
const MODULE_LOADERS = {
  outputs: async () => {
    const m = await import('../modules/outputs/outputs.js?v=1783290066771');
    return { mount: m.mountOutputs, unmount: m.unmountOutputs };
  },
  inputs: async () => {
    const m = await import('../modules/inputs/inputs.js?v=1784683108967');
    return { mount: m.mountInputs, unmount: m.unmountInputs };
  },
  water: async () => {
    const m = await import('../modules/water/water.js?v=1784683108967');
    return { mount: m.mountWater, unmount: m.unmountWater };
  },
  'meter-readings': async () => {
    const m = await import('../modules/meter-readings/meter-readings.js?v=1784683108967');
    return { mount: m.mountMeterReadings, unmount: m.unmountMeterReadings };
  },
  'gross-margin': async () => {
    const m = await import('../modules/gross-margin/gross-margin.js?v=1783290066771');
    return { mount: m.mountGrossMargin };
  },
  'farm-map': async () => {
    const m = await import('../modules/paddocks/paddocks.js?v=1784683108967');
    return {
      mount: (container) => m.mountFarmMap(container),
      unmount: () => m.unmountPaddocks()
    };
  },
  stocktake: async () => ({
    mount: (container) => {
      container.innerHTML = '<div class="page-header"><h1>Stocktake</h1></div><div class="card" style="padding:40px;text-align:center"><p style="color:var(--hint)">Stocktake module coming soon.</p></div>';
    },
    unmount: () => {}
  }),

  recommendations: async () => {
    const m = await import('../modules/agronomy/recommendations.js?v=1784683108967');
    return { mount: m.mountRecommendations, unmount: m.unmountRecommendations };
  },
  agronomy: async () => {
    const m = await import('../modules/agronomy/agronomy.js?v=1783290066771');
    return { mount: m.mountAgronomy };
  },
  weather: async () => {
    const m = await import('../modules/weather/weather.js?v=1783290066771');
    return { mount: m.mountWeather };
  },
  budget: async () => {
    const m = await import('../modules/budget/budget.js?v=1783290066771');
    return { mount: m.mountBudget, unmount: m.unmountBudget };
  },
  acquisitions: async () => {
    const m = await import('../modules/acquisitions/acquisitions.js?v=1784683108967');
    return { mount: m.mountAcquisitions, unmount: m.unmountAcquisitions };
  },
  paddocks: async () => {
    const m = await import('../modules/paddocks/paddocks.js?v=1784683108967');
    return { mount: m.mountPaddocks, unmount: m.unmountPaddocks };
  },
  settings: async () => {
    const m = await import('../modules/settings/settings.js?v=1783290066771');
    return { mount: m.mountSettings };
  },
};

let _activeModuleInstance = null;
const _main = () => document.getElementById('main');

// ── Auth gate ─────────────────────────────────────────────────
onSessionChange((session) => {
  if (session) {
    hide('#login-page');
    show('#app');
    _populateFarmSelector(getFarms());
    _updateUserDisplay(session);
    _navigateTo('outputs');
    setTimeout(async () => { await _populateSeasonSelector(); _updateXeroIndicator(); }, 500);
  } else {
    show('#login-page');
    hide('#app');
  }
});

// ── Login form ────────────────────────────────────────────────
qs('#btn-login')?.addEventListener('click', async () => {
  const email = qs('#login-email')?.value?.trim();
  const password = qs('#login-password')?.value;
  const btn = qs('#btn-login');
  const errEl = qs('#login-error');

  errEl?.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    await login(email, password);
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || 'Login failed — please check your credentials.';
      errEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

// Allow Enter key on password field
qs('#login-password')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') qs('#btn-login')?.click();
});

// ── Sign out ──────────────────────────────────────────────────
qs('#btn-logout')?.addEventListener('click', () => {
  if (_activeModuleInstance?.unmount) _activeModuleInstance.unmount();
  logout();
  toast('Signed out');
});

// Farm settings pencil button — navigate to settings with farm tab active
document.getElementById('btn-farm-settings')?.addEventListener('click', () => {
  _navigateTo('settings');
});

// ── Farm selector ─────────────────────────────────────────────
on('farms', (farms) => _populateFarmSelector(farms));
on('activeFarm', () => {
  // Unmount current module to clear its cached data, then remount for new farm
  if (_activeModuleInstance?.unmount) {
    _activeModuleInstance.unmount();
    _activeModuleInstance = null;
  }
  const state = getState();
  if (state.activeModule) _navigateTo(state.activeModule);
});

function _populateFarmSelector(farms) {
  const sel = qs('#farm-select');
  if (!sel) return;
  sel.innerHTML = farms.map(f =>
    `<option value="${f.id}">${f.name}${f.state ? ` (${f.state})` : ''}</option>`
  ).join('');
}

qs('#farm-select')?.addEventListener('change', (e) => {
  setActiveFarm(e.target.value);
  _updateXeroIndicator();
  _populateSeasonSelector();
});

// ── Season selector ───────────────────────────────────────────
async function _populateSeasonSelector() {
  const sel = document.getElementById('season-select');
  if (!sel) return;

  const now = new Date();
  const y = now.getFullYear();
  const seasons = Array.from({length: 6}, (_, i) => {
    const sy = y + 1 - i;
    return `${sy}-${String(sy+1).slice(2)}`;
  });

  let defaultSeason = seasons[1];
  try {
    const farm = getActiveFarm();
    if (farm) {
      const { dbSelect } = await import('./supabase-client.js?v=1783290066771');
      const rows = await dbSelect('budgets', 'farm_id=eq.' + farm.id + '&select=season&order=season.desc&limit=1');
      if (rows[0]?.season) defaultSeason = rows[0].season;
    }
  } catch {}

  const current = getActiveSeason() || defaultSeason;
  sel.innerHTML = seasons.map(s =>
    `<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`
  ).join('');

  if (!getActiveSeason()) setActiveSeason(sel.value);

  if (!sel.dataset.wired) {
    sel.dataset.wired = '1';
    sel.addEventListener('change', () => {
      setActiveSeason(sel.value);
      const activeLink = document.querySelector('#sidebar a.active, #mobile-nav a.active');
      const mod = activeLink?.dataset?.module || 'outputs';
      _navigateTo(mod);
    });
  }
}

window._updateXeroIndicator = async function _updateXeroIndicator() {
  const el = document.getElementById('xero-status-indicator');
  if (!el) return;
  const farm = getActiveFarm();
  if (!farm) { el.style.display = 'none'; return; }
  try {
    const { dbSelect } = await import('./supabase-client.js?v=1783290066771');
    const rows = await dbSelect('xero_tokens', 'farm_id=eq.' + farm.id + '&select=tenant_name,expires_at');
    const token = rows[0];
    el.style.display = 'flex';
    if (token) {
      // Show green if connected — access token auto-refreshes, only goes red if no token at all
      el.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;padding:3px 9px;border-radius:20px;cursor:pointer;background:rgba(50,180,80,0.15);border:0.5px solid rgba(50,200,80,0.35);color:#80ffaa';
      el.innerHTML = '<span>🟢</span> Xero';
      el.title = 'Connected to ' + (token.tenant_name || 'Xero');
    } else {
      el.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:11px;padding:3px 9px;border-radius:20px;cursor:pointer;background:rgba(180,50,50,0.15);border:0.5px solid rgba(220,80,80,0.35);color:#ff9090';
      el.innerHTML = '<span>🔴</span> Xero';
      el.title = 'Xero not connected — click to connect in Settings';
    }
  } catch { el.style.display = 'none'; }
};

// ── Navigation ────────────────────────────────────────────────
document.getElementById('sidebar')?.querySelectorAll('a[data-module]').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    _navigateTo(link.dataset.module);
  });
});

async function _waitForFarm(timeout = 5000) {
  if (getActiveFarm()) return getActiveFarm();
  return new Promise((resolve) => {
    const start = Date.now();
    const check = setInterval(() => {
      const farm = getActiveFarm();
      if (farm || Date.now() - start > timeout) {
        clearInterval(check);
        resolve(farm);
      }
    }, 50);
  });
}

async function _navigateTo(moduleKey) {
  // Unmount previous
  if (_activeModuleInstance?.unmount) {
    _activeModuleInstance.unmount();
    _activeModuleInstance = null;
  }

  // Update nav active state
  document.querySelectorAll('#sidebar a[data-module]').forEach(a => {
    a.classList.toggle('active', a.dataset.module === moduleKey);
  });

  setActiveModule(moduleKey);

  // Show loading state
  _main().innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;padding:40px;color:var(--muted)">
      <span class="loading-spinner"></span>
      <span>Loading ${moduleKey}…</span>
    </div>
  `;

  try {
    const loader = MODULE_LOADERS[moduleKey];
    if (!loader) {
      _main().innerHTML = `<div class="empty-state"><p>Module "${moduleKey}" not yet available.</p></div>`;
      return;
    }

    // Wait for farm to be loaded before mounting (fixes startup blank screen)
    await _waitForFarm();

    const moduleExports = await loader();
    _activeModuleInstance = moduleExports;
    await moduleExports.mount(_main());
  } catch (err) {
    console.error(`Module load error (${moduleKey}):`, err);
    _main().innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <p>Failed to load ${moduleKey}. Check the console for details.</p>
      </div>
    `;
  }
}

function _updateUserDisplay(session) {
  const el = qs('#user-info-display');
  if (!el) return;
  const profile = session.profile;
  el.innerHTML = `
    <strong>${profile?.full_name || session.user?.email}</strong>
    ${profile?.role ? profile.role.charAt(0).toUpperCase() + profile.role.slice(1) : ''}
  `;
}