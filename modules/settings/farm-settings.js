// modules/settings/farm-settings.js
// Edit settings for the currently active farm

import { dbSelect, dbUpdate } from '../../js/supabase-client.js';
import { getActiveFarm, getFarms, setActiveFarm } from '../../js/app-state.js';
import { toast, qs, formatDate } from '../../js/ui.js';
const COTTON_REGIONS = [
  'Central QLD', 'Darling Downs', 'MacIntyre', 'Gwydir', 'LDC Moree',
  'Mungindi/St George', 'Namoi Valley', 'Macquarie Valley', 'Lachlan/Sth NSW', 'NT / WA'
];

// LDC Grains SE sites — full names matching CSV site code lookup
const GRAIN_SITES = [
  'ARDLETHAN LDC',
  'COOLAMON LDC',
  'ELMORE LDC',
  'GOOLGOWI LDC',
  'KYALITE LDC',
  'MOREE LDC',
  'NULLAWIL LDC',
  'TELFORD LDC',
  'THE ROCK LDC',
  'WOORINEN LDC',
].sort();

const GRAIN_COMMODITIES = ['Wheat', 'Barley', 'Canola', 'Faba Beans', 'Lentils'];

export async function mountFarmSettings(container, onSave) {
  const farm = getActiveFarm();
  if (!farm) {
    container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>';
    return;
  }

  const settings = farm.settings || {};

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Farm settings</h1>
        <p class="page-subtitle">${farm.name}</p>
      </div>
    </div>

    <div class="card" style="max-width:640px">
      <div class="card-header">
        <h2>Farm details</h2>
      </div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Farm name</label>
            <input class="form-input" id="fs-name" type="text" value="${farm.name || ''}">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Location / district</label>
            <input class="form-input" id="fs-location" type="text" value="${farm.location || ''}" placeholder="e.g. Douglas Daly">
          </div>
          <div class="form-group">
            <label class="form-label">State</label>
            <select class="form-select" id="fs-state">
              <option value="">Select…</option>
              ${['QLD','NSW','VIC','SA','WA','NT','TAS','ACT'].map(s =>
                `<option value="${s}" ${farm.state === s ? 'selected' : ''}>${s}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <hr class="divider">

        <div class="form-group">
          <label class="form-label">Cotton pricing region</label>
          <select class="form-select" id="fs-cotton-region" style="max-width:280px">
            <option value="">Not a cotton farm</option>
            ${COTTON_REGIONS.map(r =>
              `<option value="${r}" ${settings.cottonRegion === r ? 'selected' : ''}>${r}</option>`
            ).join('')}
          </select>
          <p class="form-helper">Used to show the farm gate cotton price from the LDC daily price feed.</p>
        </div>

        <hr class="divider">

        <div class="form-group">
          <label class="form-label">Grain delivery sites</label>
          <p class="form-helper" style="margin-bottom:12px">Select the delivery site for each grain commodity — used to show relevant site prices from the LDC daily grain price feed.</p>
          ${GRAIN_COMMODITIES.map(com => `
            <div style="display:grid;grid-template-columns:120px 1fr;align-items:center;gap:12px;margin-bottom:10px">
              <label style="font-size:var(--text-sm);font-weight:500;color:var(--ink-mid)">${com}</label>
              <select class="form-select grain-site-select" data-commodity="${com}" id="fs-grain-${com.replace(/\s/g, '-')}">
                <option value="">Not grown / not applicable</option>
                ${GRAIN_SITES.map(s => `<option value="${s}" ${settings.grainSites?.[com] === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
          `).join('')}
        </div>

        <div style="display:flex;gap:10px;margin-top:20px">
          <button class="btn btn-primary" id="fs-save">Save changes</button>
          <button class="btn btn-secondary" id="fs-cancel">Cancel</button>
        </div>
        <div id="fs-feedback" style="margin-top:10px;font-size:var(--text-sm)"></div>
      </div>
    </div>
  `;

  qs('#fs-save', container)?.addEventListener('click', async () => {
    const btn = qs('#fs-save', container);
    const feedback = qs('#fs-feedback', container);
    btn.disabled = true;
    btn.textContent = 'Saving…';
    feedback.textContent = '';

    try {
      const name = qs('#fs-name', container)?.value?.trim();
      const location = qs('#fs-location', container)?.value?.trim() || null;
      const state = qs('#fs-state', container)?.value || null;
      const cottonRegion = qs('#fs-cotton-region', container)?.value || null;

      if (!name) throw new Error('Farm name is required');

      const newSettings = { ...settings };
      if (cottonRegion) newSettings.cottonRegion = cottonRegion;
      else delete newSettings.cottonRegion;

      // Save grain delivery sites
      const grainSites = {};
      document.querySelectorAll('.grain-site-select').forEach(sel => {
        if (sel.value) grainSites[sel.dataset.commodity] = sel.value;
      });
      newSettings.grainSites = grainSites;

      await dbUpdate('farms', farm.id, {
        name,
        location,
        state,
        settings: newSettings,
      });

      // Update local farm object
      farm.name = name;
      farm.location = location;
      farm.state = state;
      farm.settings = newSettings;

      // Update farm selector dropdown text
      const farmSel = document.getElementById('farm-select');
      if (farmSel) {
        const opt = farmSel.querySelector(`option[value="${farm.id}"]`);
        if (opt) opt.textContent = name + (state ? ` (${state})` : '');
      }

      feedback.style.color = 'var(--green)';
      feedback.textContent = '✓ Settings saved successfully';
      toast('Farm settings saved', 'success');

      if (onSave) onSave(farm);
    } catch (err) {
      feedback.style.color = 'var(--red)';
      feedback.textContent = err.message || 'Failed to save';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save changes';
    }
  });

  qs('#fs-cancel', container)?.addEventListener('click', () => {
    if (onSave) onSave(null);
  });

  // Xero connection section
  const xeroSection = document.createElement('div');
  xeroSection.className = 'card';
  xeroSection.style.marginTop = '16px';
  xeroSection.innerHTML = `
    <div class="card-header"><h3 style="font-size:var(--text-sm);font-weight:600;margin:0">Xero connection</h3></div>
    <div class="card-body" id="xero-status-wrap">
      <div class="empty-state"><span class="loading-spinner"></span></div>
    </div>
  `;
  container.appendChild(xeroSection);
  _loadXeroStatus(farm);
}

async function _loadXeroStatus(farm) {
  const wrap = document.getElementById('xero-status-wrap');
  if (!wrap) return;
  try {
    const rows = await dbSelect('xero_tokens', 'farm_id=eq.' + farm.id + '&select=tenant_name,expires_at,updated_at');
    const data = rows[0] || null;
    if (data && data.tenant_name) {
      const isExpired = new Date(data.expires_at) < new Date();
      wrap.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;padding:4px 0">
          <span style="font-size:20px">✅</span>
          <div>
            <p style="font-size:var(--text-sm);font-weight:600;color:var(--ink)">${data.tenant_name}</p>
            <p style="font-size:var(--text-xs);color:var(--muted)">${isExpired ? 'Token expired — reconnect below' : 'Connected · Last updated ' + new Date(data.updated_at).toLocaleDateString('en-AU')}</p>
          </div>
          <a href="/api/xero-auth?action=connect&farm_id=${farm.id}" class="btn btn-secondary btn-sm" style="margin-left:auto">Reconnect</a>
        </div>`;
    } else {
      wrap.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;padding:4px 0">
          <span style="font-size:20px">🔗</span>
          <div>
            <p style="font-size:var(--text-sm);color:var(--muted)">Not connected to Xero</p>
            <p style="font-size:var(--text-xs);color:var(--hint)">Connect to push invoices directly from CFM</p>
          </div>
          <a href="/api/xero-auth?action=connect&farm_id=${farm.id}" class="btn btn-primary btn-sm" style="margin-left:auto">Connect Xero</a>
        </div>`;
    }
  } catch {
    wrap.innerHTML = '<p style="font-size:var(--text-sm);color:var(--muted);padding:8px 0">Could not load Xero status</p>';
  }
}