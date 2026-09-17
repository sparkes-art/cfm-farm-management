// modules/settings/farm-settings.js
// Edit settings for the currently active farm

import { dbSelect, dbUpdate } from '../../js/supabase-client.js';
import { getActiveFarm, getFarms, setActiveFarm } from '../../js/app-state.js';
import { toast, qs, formatDate } from '../../js/ui.js';
const COTTON_REGIONS = [
  'Central QLD', 'Darling Downs', 'MacIntyre', 'Gwydir', 'LDC Moree',
  'Mungindi/St George', 'Namoi Valley', 'Macquarie Valley', 'Lachlan/Sth NSW', 'NT / WA'
];

// CropConnect sites — 142 sites confirmed from BID_PUBLIC API 17 Sep 2026
// Grouped by state for the dropdown
const CC_SITES = {
  'NSW': ['Ardlethan','Baradine','Barellan','Barmedman','Barnes Crossing','Bellata','Boggabilla',
    'Boggabri','Boree Creek','Bribbaree','Burren Junction','Calleen','Caroona','Coleambally',
    'Condobolin','Coolamon','Coonamble','Cootamundra','Croppa Creek','Curlewis','Delungra',
    'Dubbo','Dunedoo','Forbes','Gilgandra','Goolgowi','Grenfell','Gunnedah','Gurley','Gwabegar',
    'Inverell','Lake Cargelligo','Leeton','Manildra','Merrywinebone','Moree Sub','Moulamein',
    'Mullaley','Narrabri Sub','Narromine','Peak Hill','Pilliga','Rankins Springs','Quandialla',
    'Temora','Trangie','Tullamore','Ungarie','Walgett','Warialda','Wee Waa','West Wyalong',
    'Whitton','Wyalong'],
  'QLD': ['Biloela','Boggabilla','Brookstead','Bungunya','Capella','Cecil Plains','Cleve',
    'Condamine','Dalby','Dirranbandi','Goondiwindi','Inglewood','Millmerran','Miles','Moonie',
    'Oakey','Pittsworth','Roma','St George','Stanthorpe','Toowoomba','Toobeah','Wallumbilla','Warwick'],
  'VIC': ['Ardmore','Ballarat','Barnawartha','Berriwillock','Berrybank','Beulah','Boort',
    'Boree Creek','Carwarp','Charlton','Dimboola','Donald','Dunolly','Elmore','Hopetoun',
    'Horsham','Kaniva','Kerang','Lascelles','Manangatang','Mildura','Nullawil','Ouyen',
    'Rainbow','Sea Lake','Ultima','Woomelang','Woorinen'],
  'SA': ['Cleve','Keith','Loxton','Mallala','Murray Bridge','Port Pirie','Snowtown','Tailem Bend',
    'Wallaroo','Wudinna'],
  'WA': ['Albany','Esperance','Geraldton','Kwinana','Merredin','Moora','Northam'],
};
const CC_GRADES = {
  'Wheat':      ['APW1','APW','ASW1','ASW','H1','H2','AH','FEED','SFW1','SFW'],
  'Barley':     ['BAR1','BAR','F1BAR','FBAR','MALT1','MALT','FEED'],
  'Canola':     ['CAN1','CAN','CNTW','OPT'],
  'Chickpeas':  ['DESI1','DESI','KABULI','KAB1'],
  'Faba Beans': ['FAB1','FAB2','FAB','FBFEED'],
  'Lentils':    ['NIPT1','NIPT','LENTIL','LFEED'],
  'Sorghum':    ['SOR1','SOR','FEED'],
  'Oats':       ['OAT1','OAT','FEED'],
  'Durum':      ['DUR1','DUR','BISCUIT'],
  'Field Peas': ['FP1','FP','FPFEED'],
};

const GRAIN_COMMODITIES = ['Wheat', 'Barley', 'Canola', 'Faba Beans', 'Lentils', 'Sorghum'];

// MLA saleyards — confirmed from GET /saleyard 17 Sep 2026
const MLA_SALEYARDS = [
  { id: 'ARM', name: 'Armidale', state: 'NSW' },
  { id: 'CAS', name: 'Casino', state: 'NSW' },
  { id: 'COO', name: 'Coonamble', state: 'NSW' },
  { id: 'DUB', name: 'Dubbo', state: 'NSW' },
  { id: 'FOR', name: 'Forbes', state: 'NSW' },
  { id: 'GLE', name: 'Glen Innes', state: 'NSW' },
  { id: 'GOU', name: 'Goulburn', state: 'NSW' },
  { id: 'GRI', name: 'Griffith', state: 'NSW' },
  { id: 'GUN', name: 'Gunnedah', state: 'NSW' },
  { id: 'GUY', name: 'Guyra', state: 'NSW' },
  { id: 'INV', name: 'Inverell', state: 'NSW' },
  { id: 'SCO', name: 'Scone', state: 'NSW' },
  { id: 'TAM', name: 'Tamworth', state: 'NSW' },
  { id: 'TEN', name: 'Tenterfield', state: 'NSW' },
  { id: 'WAG', name: 'Wagga', state: 'NSW' },
  { id: 'WAL', name: 'Walcha', state: 'NSW' },
  { id: 'DAL', name: 'Dalby', state: 'QLD' },
  { id: 'ROM', name: 'Roma', state: 'QLD' },
  { id: 'CHA', name: 'Charters Towers', state: 'QLD' },
  { id: 'BAL', name: 'Ballarat', state: 'VIC' },
  { id: 'BAN', name: 'Barnawartha', state: 'VIC' },
  { id: 'ECH', name: 'Echuca', state: 'VIC' },
  { id: 'ELD', name: 'Elders Pakenham', state: 'VIC' },
  { id: 'SHE', name: 'Shepparton', state: 'VIC' },
  { id: 'WOD', name: 'Wodonga', state: 'VIC' },
  { id: 'ADP', name: 'SA Livestock Exchange', state: 'SA' },
  { id: 'MTE', name: 'Mt Gambier', state: 'SA' },
  { id: 'ASP', name: 'Alice Springs', state: 'NT' },
  { id: 'KAT', name: 'Katherine', state: 'NT' },
].sort((a, b) => a.name.localeCompare(b.name));

const MLA_INDICATORS = [
  'EYCI', 'NYCI', 'WYCI',
  'Heavy Steer', 'Feeder Steer', 'Feeder Heifer',
  'Restocker Yearling Steer', 'Restocker Yearling Heifer',
  'Processor Cow', 'Heavy Dairy Cow', 'Online Young Cattle',
  'Trade Lamb', 'Merino Lamb', 'Heavy Lamb', 'Light Lamb',
  'Restocker Lamb', 'Mutton', 'Online Lamb', 'Online Sheep',
];

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
          <label class="form-label">Grain delivery sites &amp; grades</label>
          <p class="form-helper" style="margin-bottom:14px">For each commodity, set up to three delivery sites in priority order, plus the primary grade to display. The system shows the primary site price first — falling back to secondary, then tertiary if no bids exist at the preferred site. Prices are pulled from GrainCorp CropConnect.</p>
          ${GRAIN_COMMODITIES.map(com => {
            const s = settings.grainSites?.[com] || {};
            // Support old string format (LDC) — treat as primary
            const pri = typeof s === 'string' ? s : (s.primary || '');
            const sec = typeof s === 'string' ? '' : (s.secondary || '');
            const ter = typeof s === 'string' ? '' : (s.tertiary || '');
            const grade = typeof s === 'string' ? '' : (s.grade || '');
            const gradeOptions = (CC_GRADES[com] || []).map(g =>
              `<option value="${g}" ${grade === g ? 'selected' : ''}>${g}</option>`
            ).join('');
            const siteOptions = (priority) => {
              const current = priority === 'primary' ? pri : priority === 'secondary' ? sec : ter;
              return Object.entries(CC_SITES).map(([state, sites]) =>
                `<optgroup label="${state}">${sites.map(site =>
                  `<option value="${site}" ${current === site ? 'selected' : ''}>${site}</option>`
                ).join('')}</optgroup>`
              ).join('');
            };
            return `
            <div style="margin-bottom:16px;padding:12px;border:1px solid var(--border);border-radius:6px">
              <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:10px">${com}</div>
              <div style="display:grid;grid-template-columns:80px 1fr 80px 1fr;gap:8px;align-items:center;margin-bottom:8px">
                <label style="font-size:12px;color:var(--ink-mid)">Primary</label>
                <select class="form-select grain-site-select" data-commodity="${com}" data-priority="primary">
                  <option value="">— not grown —</option>${siteOptions('primary')}
                </select>
                <label style="font-size:12px;color:var(--ink-mid)">Grade</label>
                <select class="form-select grain-grade-select" data-commodity="${com}">
                  <option value="">— select —</option>${gradeOptions}
                </select>
              </div>
              <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;margin-bottom:6px">
                <label style="font-size:12px;color:var(--ink-mid)">Secondary</label>
                <select class="form-select grain-site-select" data-commodity="${com}" data-priority="secondary">
                  <option value="">— not set —</option>${siteOptions('secondary')}
                </select>
              </div>
              <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center">
                <label style="font-size:12px;color:var(--ink-mid)">Tertiary</label>
                <select class="form-select grain-site-select" data-commodity="${com}" data-priority="tertiary">
                  <option value="">— not set —</option>${siteOptions('tertiary')}
                </select>
              </div>
            </div>`;
          }).join('')}
        </div>

        <div style="display:flex;gap:10px;margin-top:20px">
          <button class="btn btn-primary" id="fs-save">Save changes</button>
          <button class="btn btn-secondary" id="fs-cancel">Cancel</button>
        </div>

        <hr class="divider">

        <div class="form-group">
          <label class="form-label">Livestock saleyards</label>
          <p class="form-helper" style="margin-bottom:12px">Set up to three saleyards in priority order. When displaying livestock prices, the system uses the primary saleyard first — falling back to secondary, then tertiary, then the national indicator if no sales are recorded at the chosen yards.</p>
          ${['primary', 'secondary', 'tertiary'].map(priority => `
            <div style="display:grid;grid-template-columns:90px 1fr;align-items:center;gap:12px;margin-bottom:10px">
              <label style="font-size:var(--text-sm);font-weight:500;color:var(--ink-mid);text-transform:capitalize">${priority}</label>
              <select class="form-select ls-saleyard-select" data-priority="${priority}" id="fs-saleyard-${priority}">
                <option value="">— not set —</option>
                ${['NSW','QLD','VIC','SA','NT'].map(state => `
                  <optgroup label="${state}">
                    ${MLA_SALEYARDS.filter(s => s.state === state).map(s =>
                      `<option value="${s.id}" ${settings.livestockSaleyards?.[priority] === s.id ? 'selected' : ''}>${s.name}</option>`
                    ).join('')}
                  </optgroup>
                `).join('')}
              </select>
            </div>
          `).join('')}
        </div>

        <hr class="divider">

        <div class="form-group">
          <label class="form-label">Livestock indicators to display</label>
          <p class="form-helper" style="margin-bottom:12px">Select the MLA indicators relevant to this farm's livestock enterprise. These appear in the farm gate prices panel on the manager view.</p>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">
            ${MLA_INDICATORS.map(ind => `
              <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;padding:4px 0">
                <input type="checkbox" class="ls-indicator-check" value="${ind}"
                  ${(settings.livestockIndicators || ['EYCI','Heavy Steer','Feeder Steer']).includes(ind) ? 'checked' : ''}>
                ${ind}
              </label>
            `).join('')}
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:20px">
          <button class="btn btn-primary" id="fs-save-bottom">Save changes</button>
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

      // Save grain delivery sites (primary/secondary/tertiary + grade per commodity)
      const grainSites = {};
      GRAIN_COMMODITIES.forEach(com => {
        const selects = container.querySelectorAll(`.grain-site-select[data-commodity="${com}"]`);
        const gradeEl = container.querySelector(`.grain-grade-select[data-commodity="${com}"]`);
        const entry = {};
        selects.forEach(sel => { if (sel.value) entry[sel.dataset.priority] = sel.value; });
        if (gradeEl?.value) entry.grade = gradeEl.value;
        if (Object.keys(entry).length) grainSites[com] = entry;
      });
      newSettings.grainSites = grainSites;

      // Save livestock saleyards
      const livestockSaleyards = {};
      container.querySelectorAll('.ls-saleyard-select').forEach(sel => {
        if (sel.value) livestockSaleyards[sel.dataset.priority] = sel.value;
      });
      newSettings.livestockSaleyards = Object.keys(livestockSaleyards).length ? livestockSaleyards : null;

      // Save livestock indicators
      const livestockIndicators = Array.from(container.querySelectorAll('.ls-indicator-check:checked')).map(el => el.value);
      newSettings.livestockIndicators = livestockIndicators.length ? livestockIndicators : null;

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

  qs('#fs-save-bottom', container)?.addEventListener('click', () => qs('#fs-save', container)?.click());

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