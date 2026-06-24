// js/main.js
// App bootstrap — auth, navigation, module loading
// No localStorage. No caching. Pure Supabase.

import { login, logout, onSessionChange } from './supabase-client.js';
import { on, setActiveFarm, setActiveModule, getFarms, getState, getActiveFarm } from './app-state.js';
import { toast, show, hide, qs } from './ui.js';

// Module loaders (lazy — only imported when navigated to)
const MODULE_LOADERS = {
  outputs: async () => {
    const m = await import('../modules/outputs/outputs.js');
    return { mount: m.mountOutputs, unmount: m.unmountOutputs };
  },
  inputs: async () => {
    const m = await import('../modules/inputs/inputs.js');
    return { mount: m.mountInputs, unmount: m.unmountInputs };
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
  budget: async () => {
    const m = await import('../modules/budget/budget.js');
    return { mount: m.mountBudget, unmount: m.unmountBudget };
  },
  settings: async () => {
    const m = await import('../modules/settings/settings.js');
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
});

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
