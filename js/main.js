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
  stocktake: async () => {
    const m = await import('../modules/stocktake/stocktake-dashboard.js');
    return { mount: m.mountStocktakeDashboard, unmount: m.unmountStocktakeDashboard };
  },

  recommendations: async () => {
    const m = await import('../modules/agronomy/recommendations.js?v=1784683108967');
    return { mount: m.mountRecommendations, unmount: m.unmountRecommendations };
  },
  agronomy: async () => {
    const m = await import('../modules/agronomy/agronomy.js?v=1787538024870');
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
  'management-report': async () => {
    const m = await import('../modules/management-report/management-report.js');
    return { mount: m.mountManagementReport, unmount: m.unmountManagementReport };
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
    const isLawd = session.profile?.role === 'lawd';
    if (isLawd) {
      _applyLawdMode();
      _navigateTo('acquisitions');
    } else {
      _populateFarmSelector(getFarms());
      _updateUserDisplay(session);
      _navigateTo('outputs');
      setTimeout(async () => { await _populateSeasonSelector(); _updateXeroIndicator(); }, 500);
    }
    _updateUserDisplay(session);
  } else {
    show('#login-page');
    hide('#app');
  }
});

function _applyLawdMode() {
  // Hide everything except acquisitions in sidebar
  document.querySelectorAll('#sidebar a[data-module]').forEach(a => {
    a.style.display = a.dataset.module === 'acquisitions' ? '' : 'none';
  });
  // Hide all nav section labels
  document.querySelectorAll('#sidebar .nav-section-label').forEach(el => el.style.display = 'none');
  // Hide farm/season selectors and topbar controls
  const topbarSelects = document.querySelectorAll('#farm-select, #season-select, #btn-farm-settings, #xero-status-indicator');
  topbarSelects.forEach(el => { if (el) el.style.display = 'none'; });
  const farmWrap = document.querySelector('#farm-select')?.closest('.topbar-select-wrap');
  const seasonWrap = document.querySelector('#season-select')?.closest('.topbar-select-wrap');
  if (farmWrap) farmWrap.style.display = 'none';
  if (seasonWrap) seasonWrap.style.display = 'none';
}

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

document.getElementById('btn-add-farm')?.addEventListener('click', () => {
  _openAddFarmModal();
});

function _openAddFarmModal(existing = null) {
  const isEdit = !!existing;
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:600;display:flex;align-items:center;justify-content:center;padding:20px';

  const AUS_STATES = ['NSW','VIC','QLD','SA','WA','TAS','NT','ACT'];
  const GRAIN_CROPS = ['Wheat','Barley','Canola','Oats','Sorghum','Chickpeas'];

  const existingSettings = existing?.settings || {};
  const existingGrainSites = existingSettings.grainSites || {};
  const existingCottonRegion = existingSettings.cottonRegion || '';

  modal.innerHTML = `
    <div style="background:white;border-radius:var(--radius-xl);width:100%;max-width:520px;overflow:hidden">
      <div style="padding:14px 20px;border-bottom:1px solid var(--border-light);background:#fafbfc;display:flex;align-items:center;justify-content:space-between">
        <h2 style="font-size:15px;font-weight:600">${isEdit ? 'Edit farm' : 'Add new farm'}</h2>
        <button id="af-close" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--hint)">✕</button>
      </div>
      <div style="padding:20px;display:flex;flex-direction:column;gap:14px;max-height:80vh;overflow-y:auto">

        <div>
          <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:4px">Farm name <span style="color:var(--red)">*</span></label>
          <input id="af-name" class="form-input" type="text" value="${existing?.name||''}" placeholder="e.g. Merrowie">
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:4px">Location / region</label>
            <input id="af-location" class="form-input" type="text" value="${existing?.location||''}" placeholder="e.g. Forbes, NSW">
          </div>
          <div>
            <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:4px">State</label>
            <select id="af-state" class="form-select">
              <option value="">Select state</option>
              ${AUS_STATES.map(s => `<option value="${s}"${existing?.state===s?' selected':''}>${s}</option>`).join('')}
            </select>
          </div>
        </div>

        <div>
          <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:4px">Organisation</label>
          <input id="af-org" class="form-input" type="text" value="${existing?.org||''}" placeholder="e.g. CFM">
        </div>

        <div>
          <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:4px">Farm ID <span style="color:var(--red)">*</span></label>
          <input id="af-id" class="form-input" type="text" value="${existing?.id||''}" placeholder="e.g. farm_merrowie" ${isEdit?'disabled':''}>
          <div style="font-size:11px;color:var(--hint);margin-top:3px">Lowercase, underscores only, cannot be changed after creation</div>
        </div>

        <div style="border-top:1px solid var(--border-light);padding-top:14px">
          <div style="font-size:12px;font-weight:600;color:var(--ink);margin-bottom:10px">Market price settings</div>

          <div style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:4px">Year start month</label>
            <select id="af-year-start" class="form-select">
              <option value="1"${(existing?.settings?.yearStartMonth||7)===1?' selected':''}>January (calendar year)</option>
              <option value="7"${(existing?.settings?.yearStartMonth||7)===7?' selected':''}>July (financial year)</option>
              <option value="10"${(existing?.settings?.yearStartMonth||7)===10?' selected':''}>October (Oct–Sep)</option>
              <option value="4"${(existing?.settings?.yearStartMonth||7)===4?' selected':''}>April</option>
              <option value="2"${(existing?.settings?.yearStartMonth||7)===2?' selected':''}>February</option>
              <option value="3"${(existing?.settings?.yearStartMonth||7)===3?' selected':''}>March</option>
              <option value="5"${(existing?.settings?.yearStartMonth||7)===5?' selected':''}>May</option>
              <option value="6"${(existing?.settings?.yearStartMonth||7)===6?' selected':''}>June</option>
              <option value="8"${(existing?.settings?.yearStartMonth||7)===8?' selected':''}>August</option>
              <option value="9"${(existing?.settings?.yearStartMonth||7)===9?' selected':''}>September</option>
              <option value="11"${(existing?.settings?.yearStartMonth||7)===11?' selected':''}>November</option>
              <option value="12"${(existing?.settings?.yearStartMonth||7)===12?' selected':''}>December</option>
            </select>
            <div style="font-size:11px;color:var(--hint);margin-top:3px">Sets the reporting year and stocktake period convention for this farm</div>
          </div>

          <div style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:6px">Livestock indicators to display</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px" id="af-ls-indicators">
              ${[
                {name:'EYCI', label:'EYCI (c/kg cwt)'},
                {name:'NYCI', label:'NYCI (c/kg lwt)'},
                {name:'Heavy Steer', label:'Heavy Steer'},
                {name:'Feeder Steer', label:'Feeder Steer'},
                {name:'Feeder Heifer', label:'Feeder Heifer'},
                {name:'Restocker Yearling Steer', label:'Restocker Steer'},
                {name:'Restocker Yearling Heifer', label:'Restocker Heifer'},
                {name:'Processor Cow', label:'Processor Cow'},
                {name:'Trade Lamb', label:'Trade Lamb'},
                {name:'Merino Lamb', label:'Merino Lamb'},
                {name:'Heavy Lamb', label:'Heavy Lamb'},
                {name:'Mutton', label:'Mutton'},
              ].map(ind => {
                const checked = (existingSettings.livestockIndicators || ['EYCI','Heavy Steer','Feeder Steer']).includes(ind.name);
                return `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:3px 0">
                  <input type="checkbox" class="af-ls-ind" value="${ind.name}" ${checked ? 'checked' : ''}> ${ind.label}
                </label>`;
              }).join('')}
            </div>
            <div style="font-size:11px;color:var(--hint);margin-top:4px">These indicators will show in the farm gate prices panel</div>
          </div>

          <div style="margin-bottom:10px">
            <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:4px">Cotton region</label>
            <input id="af-cotton-region" class="form-input" type="text" value="${existingCottonRegion}" placeholder="e.g. Lachlan/Sth NSW">
          </div>

          <div>
            <label style="font-size:12px;font-weight:500;color:var(--ink);display:block;margin-bottom:6px">Grain delivery sites</label>
            <div style="display:flex;flex-direction:column;gap:6px" id="af-grain-sites">
              ${GRAIN_CROPS.map(crop => `
              <div style="display:grid;grid-template-columns:90px 1fr;gap:8px;align-items:center">
                <span style="font-size:12px;color:var(--ink-mid)">${crop}</span>
                <input class="form-input af-grain-site" data-crop="${crop}" type="text"
                  value="${existingGrainSites[crop]||''}" placeholder="e.g. GOOLGOWI LDC" style="font-size:12px;padding:5px 8px">
              </div>`).join('')}
            </div>
          </div>
        </div>

        <div style="display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--border-light);padding-top:14px">
          <button id="af-cancel" class="btn btn-ghost">Cancel</button>
          <button id="af-save" class="btn btn-primary">${isEdit ? '✓ Save changes' : '✓ Add farm'}</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('#af-close').addEventListener('click', close);
  modal.querySelector('#af-cancel').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  // Auto-generate farm ID from name
  if (!isEdit) {
    modal.querySelector('#af-name').addEventListener('input', function() {
      const idEl = modal.querySelector('#af-id');
      if (!idEl._manuallyEdited) {
        idEl.value = 'farm_' + this.value.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
      }
    });
    modal.querySelector('#af-id').addEventListener('input', function() {
      this._manuallyEdited = true;
    });
  }

  modal.querySelector('#af-save').addEventListener('click', async () => {
    const btn = modal.querySelector('#af-save');
    const name = modal.querySelector('#af-name').value.trim();
    const farmId = modal.querySelector('#af-id').value.trim();
    const location = modal.querySelector('#af-location').value.trim();
    const farmState = modal.querySelector('#af-state').value;
    const org = modal.querySelector('#af-org').value.trim();
    const cottonRegion = modal.querySelector('#af-cotton-region').value.trim();
    const yearStartMonth = parseInt(modal.querySelector('#af-year-start')?.value || '7');
    const livestockIndicators = Array.from(modal.querySelectorAll('.af-ls-ind:checked')).map(el => el.value);

    if (!name) { alert('Farm name is required'); return; }
    if (!farmId) { alert('Farm ID is required'); return; }
    if (!/^farm_[a-z0-9_]+$/.test(farmId)) { alert('Farm ID must start with farm_ and contain only lowercase letters, numbers and underscores'); return; }

    const grainSites = {};
    modal.querySelectorAll('.af-grain-site').forEach(inp => {
      if (inp.value.trim()) grainSites[inp.dataset.crop] = inp.value.trim();
    });

    const settings = {};
    if (cottonRegion) settings.cottonRegion = cottonRegion;
    if (Object.keys(grainSites).length) settings.grainSites = grainSites;
    settings.yearStartMonth = yearStartMonth;
    if (livestockIndicators.length) settings.livestockIndicators = livestockIndicators;

    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      const state = getState();
      const session = state.session;
      const SUPA_URL = 'https://nqvfuqvindsgnogejaei.supabase.co/rest/v1';
      const headers = {
        'apikey': window.__CFM_ANON_KEY,
        'Authorization': `Bearer ${session?.access_token}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      };

      const row = {
        id: farmId,
        name,
        location: location || null,
        state: farmState || null,
        org: org || null,
        settings: Object.keys(settings).length ? settings : null,
        owner_id: session?.user?.id || null,
      };

      const res = isEdit
        ? await fetch(`${SUPA_URL}/farms?id=eq.${farmId}`, { method:'PATCH', headers, body: JSON.stringify(row) })
        : await fetch(`${SUPA_URL}/farms`, { method:'POST', headers, body: JSON.stringify(row) });

      if (!res.ok) throw new Error(await res.text());

      close();
      window.location.reload();
    } catch(err) {
      alert('Save failed: ' + err.message);
      btn.disabled = false; btn.textContent = isEdit ? '✓ Save changes' : '✓ Add farm';
    }
  });
}

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

    // Skip farm wait for farm-independent modules
    const FARM_INDEPENDENT = ['acquisitions', 'settings'];
    if (!FARM_INDEPENDENT.includes(moduleKey)) {
      await _waitForFarm();
    }

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