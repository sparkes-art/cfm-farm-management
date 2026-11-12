// modules/agronomy/agronomy.js
// CFM Agronomy Module — Scouting visits & Crop Plan
// Updated 2026-11-12

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason }         from '../../js/app-state.js';
import { toast, openModal, formatDate }            from '../../js/ui.js';

// ── State ──────────────────────────────────────────────────────────────────
let allReports    = [];
let allEntries    = [];
let allPaddocks   = [];   // from paddocks table
let allCropPlan   = [];   // from crop_plan_entries table
let activeTab     = 'scouting';
let activePaddock = null;

// ── Constants ──────────────────────────────────────────────────────────────
const COMMODITIES = [
  'Cotton IRR', 'Cotton Dry', 'Corn IRR', 'Sorghum', 'Wheat',
  'Chickpea', 'Pigeon Pea', 'Setaria Hay', 'Fallow', 'Other',
];
const SOIL_TYPES = ['CL', 'MAP', 'Sandy Loam', 'Clay Loam', 'Heavy Clay', 'Sandy Clay Loam'];
const PRIORITY_LABELS  = { none: 'On track', medium: 'Watch', high: 'Action needed' };
const PRIORITY_CLASSES = { none: 'badge-success', medium: 'badge-warning', high: 'badge-danger' };
const FALLOW_COMMODITIES = new Set(['Fallow']);

const CP_STATUSES = ['intent', 'budget', 'planted', 'growing', 'harvested'];
const CP_STATUS_LABELS = {
  intent:    'Intent',
  budget:    'Budget',
  planted:   'Planted',
  growing:   'Growing',
  harvested: 'Harvested',
};
const CP_STATUS_CLASSES = {
  intent:    'badge-secondary',
  budget:    'badge-warning',
  planted:   'badge-primary',
  growing:   'badge-success',
  harvested: 'badge-info',
};
const CP_SEASON_TYPES = ['Summer', 'Winter', 'Annual'];
const CP_WATER_TYPES  = ['IRR', 'Dryland'];

// ── Mount / unmount ────────────────────────────────────────────────────────
export async function mountAgronomy(container) {
  container.innerHTML = buildShell();
  bindTabNav(container);
  _bindPaddocksNav(container);
  await refreshAll();
}

function _bindPaddocksNav(container) {
  container.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-module="paddocks"]');
    if (!link) return;
    e.preventDefault();
    document.querySelector('#sidebar a[data-module="paddocks"]')?.click();
  });
}

export function unmountAgronomy() {
  activePaddock = null;
  activeTab = 'scouting';
}

function buildShell() {
  const farm = getActiveFarm();
  return `
    <div class="page-header">
      <div>
        <h1>Agronomy</h1>
        <p class="page-subtitle">${farm?.name || ''}</p>
      </div>
    </div>
    <div class="tab-strip" id="agronomy-tabs">
      <button class="tab-btn active" data-tab="scouting">Scouting</button>
      <button class="tab-btn" data-tab="cropplan">Crop Plan</button>
    </div>
    <div id="agro-tab-scouting"></div>
    <div id="agro-tab-cropplan" style="display:none"></div>
    <div id="agro-paddock-detail" style="display:none"></div>
  `;
}

// ── Data ───────────────────────────────────────────────────────────────────
async function refreshAll() {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;
  const season = getActiveSeason();

  const [reports, entries, paddocks, cropPlan] = await Promise.all([
    dbSelect('agronomy_reports',
      'farm_id=eq.' + farmId + '&season=eq.' + season + '&order=report_date.desc'),
    dbSelect('agronomy_paddock_entries',
      'farm_id=eq.' + farmId + '&order=paddock_name,created_at.desc'),
    dbSelect('paddocks', 'farm_id=eq.' + farmId + '&order=name.asc'),
    dbSelect('crop_plan_entries',
      'farm_id=eq.' + farmId + '&order=paddock_name,sub_block.asc').catch(() => []),
  ]);

  allPaddocks = paddocks || [];
  allReports  = reports  || [];
  allCropPlan = cropPlan || [];
  allEntries  = (entries || []).filter(e =>
    allReports.some(r => r.id === e.report_id)
  );

  renderActiveTab();
}

// ── Tab nav ────────────────────────────────────────────────────────────────
function bindTabNav(container) {
  container.querySelector('#agronomy-tabs')?.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  activeTab = tab;
  activePaddock = null;
  document.querySelectorAll('#agronomy-tabs .tab-btn')
    .forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('agro-paddock-detail').style.display = 'none';
  document.getElementById('agro-tab-scouting').style.display   = tab === 'scouting'  ? '' : 'none';
  document.getElementById('agro-tab-cropplan').style.display   = tab === 'cropplan'  ? '' : 'none';
  renderActiveTab();
}

function renderActiveTab() {
  if (activeTab === 'scouting') renderBoard();
  if (activeTab === 'cropplan') renderCropPlan();
}

// ── SCOUTING BOARD ─────────────────────────────────────────────────────────
function renderBoard() {
  const el = document.getElementById('agro-tab-scouting');
  if (!el) return;

  const paddockMap = buildPaddockMap();
  const paddocks   = Object.values(paddockMap);

  if (paddocks.length === 0) {
    el.innerHTML = `
      <div class="page-header" style="margin-bottom:12px">
        <div>
          <h2 style="font-size:var(--text-md);font-weight:600;margin:0">Scouting visits</h2>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <a href="#" data-module="paddocks" class="btn btn-secondary">🗺 Paddocks</a>
          <button class="btn btn-primary" id="agro-empty-log-btn">+ Log Visit</button>
        </div>
      </div>
      <div class="empty-state">
        <div class="empty-icon">🌱</div>
        <p>No scouting visits recorded this season.</p>
        <p style="font-size:0.82rem;color:var(--hint);margin-top:-8px">
          <a href="#" data-module="paddocks" style="color:var(--blue)">Set up paddocks</a> first to get a dropdown when logging visits.
        </p>
      </div>`;
    document.getElementById('agro-empty-log-btn')
      ?.addEventListener('click', openLogVisitModal);
    return;
  }

  const cropPaddocks   = paddocks.filter(p => !p.is_fallow);
  const fallowPaddocks = paddocks.filter(p => p.is_fallow);
  const highPri        = paddocks.filter(p => p.priority === 'high');
  const medPri         = paddocks.filter(p => p.priority === 'medium');
  const totalHaCrop    = cropPaddocks.reduce((s, p) => s + (parseFloat(p.area_ha) || 0), 0);
  const totalHaFallow  = fallowPaddocks.reduce((s, p) => s + (parseFloat(p.area_ha) || 0), 0);
  const avgEst         = avgOf(cropPaddocks, 'plant_est_pct');
  const latestReport   = allReports[0];

  el.innerHTML = `
    <div class="page-header" style="margin-bottom:12px">
      <div>
        <h2 style="font-size:var(--text-md);font-weight:600;margin:0">Scouting visits</h2>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <a href="#" data-module="paddocks" class="btn btn-secondary">🗺 Paddocks</a>
        <button class="btn btn-primary" id="agro-log-visit-btn">+ Log Visit</button>
      </div>
    </div>
    <div class="stat-row" style="margin-bottom:20px">
      <div class="stat-card"><div class="stat-label">Crop ha</div><div class="stat-value">${totalHaCrop > 0 ? totalHaCrop.toFixed(1) : '—'}</div></div>
      <div class="stat-card"><div class="stat-label">Fallow ha</div><div class="stat-value">${totalHaFallow > 0 ? totalHaFallow.toFixed(1) : '—'}</div></div>
      <div class="stat-card"><div class="stat-label">Avg establishment</div><div class="stat-value">${avgEst != null ? avgEst.toFixed(1) + '%' : '—'}</div></div>
      <div class="stat-card"><div class="stat-label">High priority</div><div class="stat-value ${highPri.length ? 'red' : ''}">${highPri.length}</div></div>
      <div class="stat-card"><div class="stat-label">Watch</div><div class="stat-value">${medPri.length}</div></div>
      <div class="stat-card"><div class="stat-label">Last report</div><div class="stat-value blue">${latestReport ? formatDate(latestReport.report_date) : '—'}</div></div>
    </div>

    ${cropPaddocks.length ? `
    <div class="section-label" style="margin-bottom:10px">Crop Paddocks</div>
    <div class="agro-board-grid">
      ${cropPaddocks.map(paddockCardHTML).join('')}
    </div>` : ''}

    ${fallowPaddocks.length ? `
    <div class="section-label" style="margin-top:24px;margin-bottom:10px">Fallow</div>
    <div class="agro-board-grid">
      ${fallowPaddocks.map(paddockCardHTML).join('')}
    </div>` : ''}
  `;

  el.querySelector('#agro-log-visit-btn')
    ?.addEventListener('click', openLogVisitModal);

  el.querySelectorAll('.agro-paddock-card').forEach(card => {
    card.addEventListener('click', () => openPaddockDetail(card.dataset.paddock));
  });
}

function paddockCardHTML(p) {
  const priClass     = PRIORITY_CLASSES[p.priority] || 'badge-success';
  const priLabel     = PRIORITY_LABELS[p.priority]  || 'On track';
  const latestNodes  = p.nodes_3_count ?? p.nodes_2_count ?? p.nodes_1_count;
  const latestHeight = p.height_cm_2 ?? p.height_cm_1;
  const isFallow     = p.is_fallow;
  const entryCount   = allEntries.filter(e => e.paddock_name === p.paddock_name).length;

  // Pull area from crop plan if available
  const cpEntry = allCropPlan.find(c =>
    c.paddock_name === p.paddock_name && !c.sub_block &&
    ['planted','growing'].includes(c.status)
  );
  const displayArea = cpEntry?.planted_ha ?? cpEntry?.planned_ha ?? p.area_ha;

  return `
    <div class="card agro-paddock-card${isFallow ? ' agro-paddock-card--fallow' : ''}"
         data-paddock="${esc(p.paddock_name)}" style="cursor:pointer">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:6px">
        <div style="font-weight:700;font-size:0.95rem">${esc(p.paddock_name)}</div>
        ${!isFallow ? `<span class="badge ${priClass}">${priLabel}</span>` : ''}
      </div>
      <div style="font-size:0.8rem;font-weight:600;color:var(--blue);margin-bottom:2px">${esc(p.commodity || '—')}</div>
      ${p.variety ? `<div style="font-size:0.75rem;color:var(--hint)">${esc(p.variety)}</div>` : ''}

      ${!isFallow ? `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:10px 0 8px">
        ${metricPill(fmtHa(displayArea), 'ha')}
        ${metricPill(p.plant_est_pct != null ? p.plant_est_pct + '%' : null, 'est.')}
        ${metricPill(latestNodes, 'nodes')}
        ${metricPill(latestHeight != null ? latestHeight + 'cm' : null, 'ht')}
      </div>` : `
      <div style="display:flex;gap:12px;margin:10px 0 8px">
        ${metricPill(fmtHa(displayArea), 'ha')}
      </div>`}

      <div style="display:flex;justify-content:space-between;padding-top:8px;border-top:1px solid var(--border);font-size:0.72rem;color:var(--hint)">
        <span>${entryCount} visit${entryCount !== 1 ? 's' : ''}</span>
        <span>${p.lastReportDate ? formatDate(p.lastReportDate) : 'No visits'}</span>
      </div>
    </div>
  `;
}

function metricPill(val, lbl) {
  if (val == null) return '';
  return `<div style="display:flex;flex-direction:column;align-items:center">
    <span style="font-family:'DM Mono',monospace;font-size:0.88rem;font-weight:600;color:var(--fg);line-height:1.1">${val}</span>
    <span style="font-size:0.65rem;color:var(--hint);text-transform:uppercase;letter-spacing:0.04em">${lbl}</span>
  </div>`;
}

// ── PADDOCK DETAIL ─────────────────────────────────────────────────────────
function openPaddockDetail(paddockName) {
  activePaddock = paddockName;
  document.getElementById('agro-tab-scouting').style.display  = 'none';
  document.getElementById('agro-tab-cropplan').style.display  = 'none';
  renderPaddockDetail(paddockName);
  document.getElementById('agro-paddock-detail').style.display = '';
}

function renderPaddockDetail(paddockName) {
  const el = document.getElementById('agro-paddock-detail');
  if (!el) return;

  const entries = allEntries
    .filter(e => e.paddock_name === paddockName)
    .sort((a, b) => {
      const ra = allReports.find(r => r.id === a.report_id)?.report_date || '';
      const rb = allReports.find(r => r.id === b.report_id)?.report_date || '';
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });

  const latest = entries[entries.length - 1];

  // Active crop plan entry for this paddock — used to show authoritative area
  const cpActive = allCropPlan.find(c =>
    c.paddock_name === paddockName && !c.sub_block &&
    ['planted','growing'].includes(c.status)
  );

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <button class="btn btn-secondary btn-sm" id="agro-back-btn">← Scouting</button>
      <div>
        <h2 style="margin:0;font-size:1.2rem">${esc(paddockName)}</h2>
        <div style="font-size:0.82rem;color:var(--hint)">
          ${latest ? esc(latest.commodity || '') + (latest.variety ? ' · ' + esc(latest.variety) : '') : ''}
          ${cpActive ? `<span style="margin-left:6px;font-weight:600;color:var(--blue)">${fmtHa(cpActive.planted_ha ?? cpActive.planned_ha)} (crop plan)</span>` : (latest?.area_ha ? ' · ' + fmtHa(latest.area_ha) : '')}
        </div>
      </div>
    </div>

    ${cpActive ? `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:16px;display:flex;gap:20px;flex-wrap:wrap;font-size:0.82rem">
      <div><span style="color:var(--hint)">Crop plan area: </span><strong>${fmtHa(cpActive.planted_ha ?? cpActive.planned_ha)}</strong></div>
      <div><span style="color:var(--hint)">Status: </span><span class="badge ${CP_STATUS_CLASSES[cpActive.status] || ''}">${CP_STATUS_LABELS[cpActive.status] || cpActive.status}</span></div>
      <div><span style="color:var(--hint)">Season: </span><strong>${esc(cpActive.season_label || cpActive.season_type || '')}</strong></div>
      ${cpActive.variety ? `<div><span style="color:var(--hint)">Variety: </span><strong>${esc(cpActive.variety)}</strong></div>` : ''}
      ${cpActive.area_loss_ha ? `<div style="color:var(--red)"><span>Area losses: </span><strong>${fmtHa(cpActive.area_loss_ha)}</strong></div>` : ''}
    </div>` : ''}

    <div class="card">
      <div class="card-header">Visit history — ${esc(paddockName)}</div>
      ${entries.length === 0
        ? '<div style="padding:16px;color:var(--hint);font-size:0.85rem">No visits recorded.</div>'
        : entries.map((e, i) => visitRowHTML(e, i === entries.length - 1)).join('')}
    </div>
  `;

  el.querySelector('#agro-back-btn')?.addEventListener('click', () => {
    activePaddock = null;
    el.style.display = 'none';
    document.getElementById('agro-tab-scouting').style.display = '';
    renderBoard();
  });

  el.querySelectorAll('.agro-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const entry = allEntries.find(en => en.id === btn.dataset.id);
      if (entry) openEditEntryModal(entry);
    });
  });

  el.querySelectorAll('.agro-del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete this visit entry?')) return;
      const entryId = btn.dataset.id;
      const rptId   = btn.dataset.reportId;
      await dbDelete('agronomy_paddock_entries', entryId);
      if (rptId) {
        const remaining = allEntries.filter(en => en.report_id === rptId && en.id !== entryId);
        if (remaining.length === 0) await dbDelete('agronomy_reports', rptId);
      }
      toast('Entry deleted', 'success');
      await refreshAll();
      if (activePaddock) renderPaddockDetail(activePaddock);
    });
  });
}

function visitRowHTML(e, isLatest) {
  const report       = allReports.find(r => r.id === e.report_id);
  const latestNodes  = e.nodes_3_count ?? e.nodes_2_count ?? e.nodes_1_count;
  const latestHeight = e.height_cm_2 ?? e.height_cm_1;

  return `
    <div style="padding:14px 18px;border-bottom:1px solid var(--border);${isLatest ? 'background:var(--bg)' : ''}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div>
          <div style="font-weight:600;font-size:0.85rem;margin-bottom:2px">
            ${report ? formatDate(report.report_date) : '—'}
            ${isLatest ? '<span class="badge badge-primary" style="margin-left:6px">Latest</span>' : ''}
          </div>
          <div style="font-size:0.78rem;color:var(--hint)">${report ? esc(report.agronomist_name) + (report.agronomist_company ? ' · ' + esc(report.agronomist_company) : '') : ''}</div>
        </div>
        <div style="display:flex;gap:8px;flex-shrink:0;align-items:center">
          ${e.priority && e.priority !== 'none' ? `<span class="badge ${PRIORITY_CLASSES[e.priority] || ''}">${PRIORITY_LABELS[e.priority] || ''}</span>` : ''}
          <button class="btn-link agro-edit-btn" data-id="${e.id}">Edit</button>
          <button class="btn-link danger agro-del-btn" data-id="${e.id}" data-report-id="${e.report_id}">Del</button>
        </div>
      </div>

      ${!e.is_fallow ? `
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin:10px 0 6px">
        ${inlineMetric('Est.', e.plant_est_pct != null ? e.plant_est_pct + '%' : null)}
        ${inlineMetric('Plants/m²', e.plants_per_m2)}
        ${inlineMetric('Height', latestHeight != null ? latestHeight + ' cm' : null)}
        ${inlineMetric('Nodes', latestNodes)}
        ${inlineMetric('Yield target', e.yield_target_t != null ? e.yield_target_t + ' t' : null)}
        ${inlineMetric('N deficit', e.n_deficit != null ? e.n_deficit + ' kg/ha' : null)}
        ${inlineMetric('Urea req', e.seasonal_urea_req != null ? e.seasonal_urea_req + ' kg/ha' : null)}
      </div>
      ${e.incrop_sprays_notes ? `<div style="font-size:0.8rem;margin-top:4px"><span style="font-weight:600;color:var(--hint);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em">Sprays </span>${esc(e.incrop_sprays_notes)}</div>` : ''}
      ${e.incrop_fert_notes   ? `<div style="font-size:0.8rem;margin-top:2px"><span style="font-weight:600;color:var(--hint);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em">Fert/Irr </span>${esc(e.incrop_fert_notes)}</div>` : ''}
      ${e.comments      ? `<div style="font-size:0.82rem;color:var(--hint);font-style:italic;margin-top:4px">${esc(e.comments)}</div>` : ''}
      ${e.upcoming_jobs ? `<div style="font-size:0.82rem;margin-top:4px"><span style="font-weight:600">Upcoming: </span>${esc(e.upcoming_jobs)}</div>` : ''}
      ` : '<div style="font-size:0.82rem;color:var(--hint)">Fallow paddock</div>'}
    </div>
  `;
}

function inlineMetric(lbl, val) {
  if (val == null) return '';
  return `<div style="display:flex;flex-direction:column;align-items:center">
    <span style="font-family:'DM Mono',monospace;font-size:0.88rem;font-weight:600">${val}</span>
    <span style="font-size:0.65rem;color:var(--hint);text-transform:uppercase;letter-spacing:0.04em">${lbl}</span>
  </div>`;
}

// ── CROP PLAN TAB ──────────────────────────────────────────────────────────
function renderCropPlan() {
  const el = document.getElementById('agro-tab-cropplan');
  if (!el) return;

  // Group entries by season label for display, sorted by season then paddock
  const seasons = [...new Set(allCropPlan.map(c => c.season_label || c.season_type || 'No season'))];
  const currentSeason = getActiveSeason();

  // Season filter — default to active season if any entries exist for it
  const activeCPSeason = el.dataset.cpSeason || currentSeason;

  // All unique seasons in plan
  const allSeasons = [...new Set(
    allCropPlan.map(c => c.season_label).filter(Boolean)
  )].sort().reverse();

  // Entries for the displayed season
  const displayed = allCropPlan.filter(c =>
    (c.season_label || '') === activeCPSeason || allSeasons.length === 0
  );

  // Summary stats
  const totalPlanned  = displayed.filter(c => !c.sub_block).reduce((s, c) => s + (parseFloat(c.planned_ha) || 0), 0);
  const totalPlanted  = displayed.filter(c => !c.sub_block && c.planted_ha).reduce((s, c) => s + (parseFloat(c.planted_ha) || 0), 0);
  const totalAdjusted = displayed.filter(c => !c.sub_block && c.area_loss_ha).reduce((s, c) => s + (parseFloat(c.area_loss_ha) || 0), 0);
  const byStatus      = CP_STATUSES.map(s => ({
    s, count: displayed.filter(c => c.status === s && !c.sub_block).length
  })).filter(x => x.count > 0);

  el.innerHTML = `
    <div class="page-header" style="margin-bottom:12px">
      <div>
        <h2 style="font-size:var(--text-md);font-weight:600;margin:0">Crop Plan</h2>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-primary" id="agro-new-plan-btn">+ Add Crop</button>
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:flex-start">

      <!-- Left filter panel -->
      <div style="width:200px;flex-shrink:0;border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:10px;display:flex;flex-direction:column;gap:8px;align-self:flex-start">
        <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint);margin-bottom:2px">Season</div>
        ${allSeasons.length === 0
          ? `<div style="font-size:0.8rem;color:var(--hint)">No seasons yet</div>`
          : allSeasons.map(s => `
              <button class="cp-season-btn" data-season="${esc(s)}"
                style="font-size:11px;padding:5px 10px;border-radius:4px;border:1px solid ${s === activeCPSeason ? 'var(--blue)' : 'var(--border)'};
                  background:${s === activeCPSeason ? 'var(--blue)' : 'transparent'};
                  color:${s === activeCPSeason ? 'white' : 'var(--fg)'};cursor:pointer;text-align:left;width:100%">
                ${esc(s)}
              </button>`).join('')
        }
        <button class="cp-season-btn" data-season="${esc(currentSeason)}"
          style="font-size:11px;padding:5px 10px;border-radius:4px;border:1px dashed var(--border);
            background:transparent;color:var(--hint);cursor:pointer;text-align:left;width:100%;margin-top:4px"
          title="Start planning for ${esc(currentSeason)}">
          + ${esc(currentSeason)}
        </button>

        <div style="border-top:1px solid var(--border);padding-top:8px;margin-top:4px">
          <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint);margin-bottom:6px">Status filter</div>
          <button class="cp-status-filter active" data-status=""
            style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--blue);background:var(--blue);color:white;cursor:pointer;width:100%;text-align:left;margin-bottom:3px">
            All
          </button>
          ${CP_STATUSES.map(s => `
            <button class="cp-status-filter" data-status="${s}"
              style="font-size:11px;padding:4px 10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--fg);cursor:pointer;width:100%;text-align:left;margin-bottom:3px">
              ${CP_STATUS_LABELS[s]}
            </button>`).join('')}
        </div>
      </div>

      <!-- Right content -->
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:12px">

        <!-- Summary strip -->
        <div class="stat-row">
          <div class="stat-card"><div class="stat-label">Planned ha</div><div class="stat-value">${totalPlanned > 0 ? totalPlanned.toFixed(1) : '—'}</div></div>
          <div class="stat-card"><div class="stat-label">Planted ha</div><div class="stat-value">${totalPlanted > 0 ? totalPlanted.toFixed(1) : '—'}</div></div>
          <div class="stat-card"><div class="stat-label">Area losses</div><div class="stat-value ${totalAdjusted > 0 ? 'red' : ''}">${totalAdjusted > 0 ? totalAdjusted.toFixed(1) : '—'}</div></div>
          ${byStatus.map(x => `<div class="stat-card"><div class="stat-label">${CP_STATUS_LABELS[x.s]}</div><div class="stat-value">${x.count}</div></div>`).join('')}
        </div>

        <!-- Plan table -->
        <div class="card">
          ${displayed.length === 0 ? `
            <div class="empty-state" style="padding:40px 20px">
              <div class="empty-icon">🌾</div>
              <p>No crops planned for this season yet.</p>
              <button class="btn btn-primary" id="cp-empty-add-btn">+ Add First Crop</button>
            </div>
          ` : `
            <div class="table-responsive">
              <table class="data-table" id="cp-table">
                <thead><tr>
                  <th>Paddock</th>
                  <th>Sub-block</th>
                  <th>Crop / Variety</th>
                  <th>Water</th>
                  <th>Season type</th>
                  <th style="text-align:right">Planned ha</th>
                  <th style="text-align:right">Planted ha</th>
                  <th style="text-align:right">Loss ha</th>
                  <th style="text-align:right">Active ha</th>
                  <th>Status</th>
                  <th>Wet date</th>
                  <th>Notes</th>
                  <th></th>
                </tr></thead>
                <tbody id="cp-tbody">
                  ${displayed.map(c => cpRowHTML(c)).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    </div>
  `;

  // Header button
  el.querySelector('#agro-new-plan-btn')
    ?.addEventListener('click', () => openCropPlanModal());

  // Season btn wiring
  el.querySelectorAll('.cp-season-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.dataset.cpSeason = btn.dataset.season;
      renderCropPlan();
    });
  });

  // Status filter wiring
  el.querySelectorAll('.cp-status-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.cp-status-filter').forEach(b => {
        b.style.background = 'transparent';
        b.style.color = 'var(--fg)';
        b.style.borderColor = 'var(--border)';
        b.classList.remove('active');
      });
      btn.style.background = 'var(--blue)';
      btn.style.color = 'white';
      btn.style.borderColor = 'var(--blue)';
      btn.classList.add('active');
      const status = btn.dataset.status;
      el.querySelectorAll('#cp-tbody tr').forEach(row => {
        row.style.display = (!status || row.dataset.status === status) ? '' : 'none';
      });
    });
  });

  // Row action wiring
  el.querySelectorAll('.cp-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const entry = allCropPlan.find(c => c.id === btn.dataset.id);
      if (entry) openCropPlanModal(entry);
    });
  });

  el.querySelectorAll('.cp-del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete this crop plan entry?')) return;
      await dbDelete('crop_plan_entries', btn.dataset.id);
      toast('Entry deleted', 'success');
      await refreshAll();
    });
  });

  // Status advance buttons
  el.querySelectorAll('.cp-advance-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const entry = allCropPlan.find(c => c.id === btn.dataset.id);
      if (!entry) return;
      const idx  = CP_STATUSES.indexOf(entry.status);
      const next = CP_STATUSES[idx + 1];
      if (!next) return;
      await dbUpdate('crop_plan_entries', entry.id, {
        status: next, updated_at: new Date().toISOString(),
      });
      toast(`Moved to ${CP_STATUS_LABELS[next]}`, 'success');
      await refreshAll();
    });
  });

  el.querySelector('#cp-empty-add-btn')?.addEventListener('click', () => openCropPlanModal());
}

function cpRowHTML(c) {
  const nextStatus = CP_STATUSES[CP_STATUSES.indexOf(c.status) + 1];
  const activHa    = (parseFloat(c.planted_ha || c.planned_ha) || 0) - (parseFloat(c.area_loss_ha) || 0);

  return `
    <tr data-status="${c.status}" data-id="${c.id}" style="${c.sub_block ? 'background:var(--surface)' : ''}">
      <td style="font-weight:${c.sub_block ? '400' : '600'}">
        ${c.sub_block ? '' : esc(c.paddock_name)}
      </td>
      <td style="color:var(--hint);font-size:0.82rem;padding-left:${c.sub_block ? '24px' : ''}">
        ${c.sub_block ? '↳ ' + esc(c.sub_block) : '—'}
      </td>
      <td>
        <div style="font-weight:600;font-size:0.85rem">${esc(c.commodity || '—')}</div>
        ${c.variety ? `<div style="font-size:0.75rem;color:var(--hint)">${esc(c.variety)}</div>` : ''}
      </td>
      <td><span style="font-size:0.8rem">${esc(c.water_type || '—')}</span></td>
      <td><span style="font-size:0.8rem">${esc(c.season_type || '—')}</span></td>
      <td style="text-align:right;font-family:'DM Mono',monospace;font-size:0.85rem">${c.planned_ha != null ? parseFloat(c.planned_ha).toFixed(1) : '—'}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;font-size:0.85rem">${c.planted_ha != null ? parseFloat(c.planted_ha).toFixed(1) : '—'}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;font-size:0.85rem;color:${c.area_loss_ha ? 'var(--red)' : 'var(--hint)'}">${c.area_loss_ha ? parseFloat(c.area_loss_ha).toFixed(1) : '—'}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;font-size:0.85rem;font-weight:600">${activHa > 0 ? activHa.toFixed(1) : '—'}</td>
      <td><span class="badge ${CP_STATUS_CLASSES[c.status] || 'badge-secondary'}">${CP_STATUS_LABELS[c.status] || c.status}</span></td>
      <td style="font-size:0.8rem">${c.wet_date ? formatDate(c.wet_date) : '—'}</td>
      <td style="font-size:0.78rem;color:var(--hint);max-width:160px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.notes || '')}</td>
      <td class="row-actions" style="white-space:nowrap">
        ${nextStatus ? `<button class="btn-link cp-advance-btn" data-id="${c.id}" title="Advance to ${CP_STATUS_LABELS[nextStatus]}">→ ${CP_STATUS_LABELS[nextStatus]}</button>` : ''}
        <button class="btn-link cp-edit-btn" data-id="${c.id}">Edit</button>
        <button class="btn-link danger cp-del-btn" data-id="${c.id}">Del</button>
      </td>
    </tr>
  `;
}

// ── CROP PLAN MODAL ────────────────────────────────────────────────────────
function openCropPlanModal(entry = null) {
  const isEdit     = !!entry;
  const today      = todayStr();
  const currentSsn = getActiveSeason();

  // Build paddock options
  const paddockOpts = allPaddocks.length
    ? allPaddocks.map(p =>
        `<option value="${esc(p.name)}"${entry?.paddock_name === p.name ? ' selected' : ''}>${esc(p.name)}</option>`
      ).join('')
    : `<option value="${esc(entry?.paddock_name || '')}">—</option>`;

  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Paddock *</label>
        ${allPaddocks.length
          ? `<select class="form-select" id="cp-paddock"><option value="">— Select —</option>${paddockOpts}</select>`
          : `<input class="form-input" id="cp-paddock" placeholder="Paddock name" value="${esc(entry?.paddock_name || '')}">`
        }
      </div>
      <div class="form-group">
        <label class="form-label">Sub-block <span style="color:var(--hint);font-weight:400">(optional)</span></label>
        <input class="form-input" id="cp-subblock" placeholder="e.g. North half, Refuge"
          value="${esc(entry?.sub_block || '')}">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Season label *</label>
        <input class="form-input" id="cp-season-label" placeholder="e.g. Summer 2026-27"
          value="${esc(entry?.season_label || currentSsn)}">
      </div>
      <div class="form-group">
        <label class="form-label">Season type</label>
        <select class="form-select" id="cp-season-type">
          ${CP_SEASON_TYPES.map(t =>
            `<option value="${t}"${entry?.season_type === t ? ' selected' : ''}>${t}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-select" id="cp-status">
          ${CP_STATUSES.map(s =>
            `<option value="${s}"${(entry?.status || 'intent') === s ? ' selected' : ''}>${CP_STATUS_LABELS[s]}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Commodity *</label>
        <select class="form-select" id="cp-commodity">
          ${COMMODITIES.map(c =>
            `<option value="${c}"${entry?.commodity === c ? ' selected' : ''}>${c}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Variety</label>
        <input class="form-input" id="cp-variety" placeholder="e.g. Sicot 714"
          value="${esc(entry?.variety || '')}">
      </div>
      <div class="form-group">
        <label class="form-label">Water type</label>
        <select class="form-select" id="cp-water">
          ${CP_WATER_TYPES.map(t =>
            `<option value="${t}"${entry?.water_type === t ? ' selected' : ''}>${t}</option>`
          ).join('')}
        </select>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Planned ha</label>
        <input class="form-input" id="cp-planned-ha" type="number" step="0.1" min="0"
          placeholder="ha" value="${entry?.planned_ha != null ? entry.planned_ha : ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Planted ha <span style="color:var(--hint);font-weight:400">(actual)</span></label>
        <input class="form-input" id="cp-planted-ha" type="number" step="0.1" min="0"
          placeholder="ha" value="${entry?.planted_ha != null ? entry.planted_ha : ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Area losses ha</label>
        <input class="form-input" id="cp-loss-ha" type="number" step="0.1" min="0"
          placeholder="flood, fire…" value="${entry?.area_loss_ha != null ? entry.area_loss_ha : ''}">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Wet / plant date</label>
        <input class="form-input" id="cp-wet-date" type="date"
          value="${entry?.wet_date || ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Target yield (t/ha)</label>
        <input class="form-input" id="cp-yield" type="number" step="0.1" min="0"
          placeholder="t/ha" value="${entry?.yield_target_t_ha != null ? entry.yield_target_t_ha : ''}">
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">Notes</label>
      <textarea class="form-input" id="cp-notes" rows="2"
        placeholder="Any planning notes or context">${esc(entry?.notes || '')}</textarea>
    </div>
  `;

  openModal({
    title: isEdit ? 'Edit Crop Plan — ' + esc(entry.paddock_name) : 'Add Crop to Plan',
    bodyHTML,
    confirmLabel: isEdit ? 'Save changes' : 'Add to plan',
    wide: true,
    onConfirm: async () => {
      const farmId      = (() => { const f = getActiveFarm(); return f?.id || f; })();
      const paddock     = document.getElementById('cp-paddock')?.value?.trim();
      const seasonLabel = document.getElementById('cp-season-label')?.value?.trim();
      const commodity   = document.getElementById('cp-commodity')?.value;

      if (!paddock)     throw new Error('Paddock is required');
      if (!seasonLabel) throw new Error('Season label is required');
      if (!commodity)   throw new Error('Commodity is required');

      const row = {
        farm_id:           farmId,
        paddock_name:      paddock,
        sub_block:         document.getElementById('cp-subblock')?.value?.trim() || null,
        season_label:      seasonLabel,
        season_type:       document.getElementById('cp-season-type')?.value,
        status:            document.getElementById('cp-status')?.value || 'intent',
        commodity,
        variety:           document.getElementById('cp-variety')?.value?.trim() || null,
        water_type:        document.getElementById('cp-water')?.value || null,
        planned_ha:        numOrNull(document.getElementById('cp-planned-ha')?.value),
        planted_ha:        numOrNull(document.getElementById('cp-planted-ha')?.value),
        area_loss_ha:      numOrNull(document.getElementById('cp-loss-ha')?.value),
        wet_date:          document.getElementById('cp-wet-date')?.value || null,
        yield_target_t_ha: numOrNull(document.getElementById('cp-yield')?.value),
        notes:             document.getElementById('cp-notes')?.value?.trim() || null,
        updated_at:        new Date().toISOString(),
      };

      if (isEdit) {
        await dbUpdate('crop_plan_entries', entry.id, row);
        toast('Crop plan updated', 'success');
      } else {
        await dbInsert('crop_plan_entries', row);
        toast('Added to crop plan', 'success');
      }
      await refreshAll();
    },
  });
}

// ── LOG VISIT MODAL ────────────────────────────────────────────────────────
function openLogVisitModal() {
  const today = todayStr();

  const bodyHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Visit Date *</label>
        <input class="form-input" id="lv-date" type="date" value="${today}">
      </div>
      <div class="form-group">
        <label class="form-label">Agronomist Name *</label>
        <input class="form-input" id="lv-agronomist" type="text" placeholder="e.g. John Smith">
      </div>
      <div class="form-group">
        <label class="form-label">Company</label>
        <input class="form-input" id="lv-company" type="text" placeholder="e.g. Delta Agri">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select class="form-select" id="lv-type">
          <option value="external">External agronomist</option>
          <option value="internal">Internal</option>
        </select>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 10px">
      <div style="font-weight:600;font-size:0.88rem">Paddock Entries</div>
      <button type="button" class="btn btn-secondary btn-sm" id="lv-add-paddock-btn">+ Add Paddock</button>
    </div>
    <div id="lv-paddock-list"></div>
  `;

  openModal({
    title: 'Log Scouting Visit',
    bodyHTML,
    confirmLabel: 'Save Visit',
    wide: true,
    onMounted: (overlay) => {
      _rowCounter = 0;
      overlay.querySelector('#lv-add-paddock-btn')
        ?.addEventListener('click', () => addPaddockRow(overlay));
      addPaddockRow(overlay); // start with one row
    },
    onConfirm: async () => {
      const farmId = (() => { const f = getActiveFarm(); return f?.id || f; })();
      const season = getActiveSeason();
      const date   = document.getElementById('lv-date')?.value;
      const name   = document.getElementById('lv-agronomist')?.value?.trim();
      const company= document.getElementById('lv-company')?.value?.trim() || null;
      const type   = document.getElementById('lv-type')?.value;

      if (!date || !name) throw new Error('Date and agronomist name are required');

      const rows = collectPaddockRows();
      if (rows.length === 0) throw new Error('Add at least one paddock entry');
      rows.forEach(r => { if (!r.paddock_name) throw new Error('Each paddock row needs a name'); });

      // Show area from crop plan for each paddock row
      rows.forEach(r => {
        const cp = allCropPlan.find(c =>
          c.paddock_name === r.paddock_name && !c.sub_block &&
          ['budget','planted','growing'].includes(c.status)
        );
        if (cp && r.area_ha == null) {
          r.area_ha = cp.planted_ha ?? cp.planned_ha ?? null;
        }
      });

      const [report] = await dbInsert('agronomy_reports', {
        farm_id: farmId, season, report_date: date,
        agronomist_name: name, agronomist_company: company,
        agronomist_type: type, updated_at: new Date().toISOString(),
      });
      if (!report?.id) throw new Error('Failed to create report');

      await Promise.all(rows.map(row =>
        dbInsert('agronomy_paddock_entries', {
          ...row, report_id: report.id, farm_id: farmId,
          updated_at: new Date().toISOString(),
        })
      ));

      toast('Visit saved — ' + rows.length + ' paddock' + (rows.length !== 1 ? 's' : ''), 'success');
      await refreshAll();
    },
  });
}

// ── Paddock row builder ────────────────────────────────────────────────────
let _rowCounter = 0;

function _paddockNameField(currentValue) {
  if (allPaddocks.length === 0) {
    return `<input class="form-input agro-ep-name" placeholder="Paddock name *"
      style="max-width:200px" value="${esc(currentValue)}"
      title="Add paddocks in the Paddocks module for a dropdown here">`;
  }
  const opts = allPaddocks.map(p =>
    `<option value="${esc(p.name)}"${p.name === currentValue ? ' selected' : ''}>${esc(p.name)}</option>`
  ).join('');
  return `<select class="form-select agro-ep-name" style="max-width:200px">
    <option value="">— Select paddock —</option>
    ${opts}
  </select>`;
}

// Build area hint from crop plan for the selected paddock
function _areaHint(paddockName) {
  if (!paddockName) return '';
  const cp = allCropPlan.find(c =>
    c.paddock_name === paddockName && !c.sub_block &&
    ['budget','planted','growing'].includes(c.status)
  );
  if (!cp) return '';
  const ha = cp.planted_ha ?? cp.planned_ha;
  if (ha == null) return '';
  return `<span style="font-size:0.75rem;color:var(--blue);margin-left:4px" title="From crop plan">${parseFloat(ha).toFixed(1)} ha (plan)</span>`;
}

function addPaddockRow(overlay, copyFrom = null) {
  _rowCounter++;
  const rid  = 'pr-' + _rowCounter;
  const list = overlay
    ? overlay.querySelector('#lv-paddock-list')
    : document.getElementById('lv-paddock-list');
  if (!list) return;

  const commodity = copyFrom?.commodity || 'Cotton IRR';
  const isFallow  = FALLOW_COMMODITIES.has(commodity);

  const div = document.createElement('div');
  div.className = 'agro-paddock-row';
  div.id = rid;
  div.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px">
      ${_paddockNameField(copyFrom?.paddock_name || '')}
      <select class="form-select agro-ep-commodity" style="max-width:160px">
        ${COMMODITIES.map(c =>
          `<option value="${c}"${commodity === c ? ' selected' : ''}>${c}</option>`
        ).join('')}
      </select>
      <input class="form-input agro-ep-variety" placeholder="Variety"
        style="max-width:120px" value="${esc(copyFrom?.variety || '')}">
      <div style="display:flex;align-items:center;gap:4px">
        <input class="form-input agro-ep-area" type="number" step="0.01" placeholder="ha"
          style="max-width:80px" value="${copyFrom?.area_ha != null ? copyFrom.area_ha : ''}">
        <span class="agro-ep-area-hint" style="font-size:0.75rem;color:var(--blue)">${_areaHint(copyFrom?.paddock_name || '')}</span>
      </div>
      <div style="display:flex;gap:6px;margin-left:auto">
        <button type="button" class="btn btn-secondary btn-sm agro-ep-copy-btn">Copy →</button>
        <button type="button" class="btn-link danger agro-ep-remove" style="font-size:1rem;padding:0 4px">✕</button>
      </div>
    </div>

    <div class="agro-ep-crop-fields"${isFallow ? ' style="display:none"' : ''}>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Plant Est. %</label>
          <input class="form-input agro-ep-est" type="number" step="0.1"
            placeholder="%" value="${copyFrom?.plant_est_pct != null ? copyFrom.plant_est_pct : ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Plants / m²</label>
          <input class="form-input agro-ep-plants" type="number" step="0.1"
            value="${copyFrom?.plants_per_m2 != null ? copyFrom.plants_per_m2 : ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Height (cm)</label>
          <input class="form-input agro-ep-height" type="number" step="0.5"
            value="${copyFrom?.height_cm_2 ?? copyFrom?.height_cm_1 ?? ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Nodes</label>
          <input class="form-input agro-ep-nodes" type="number" step="0.25"
            value="${copyFrom?.nodes_3_count ?? copyFrom?.nodes_2_count ?? copyFrom?.nodes_1_count ?? ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Yield Target (t)</label>
          <input class="form-input agro-ep-yield" type="number" step="0.1"
            value="${copyFrom?.yield_target_t != null ? copyFrom.yield_target_t : ''}">
        </div>
        <div class="form-group">
          <label class="form-label">N Deficit (kg/ha)</label>
          <input class="form-input agro-ep-ndeficit" type="number" step="1"
            value="${copyFrom?.n_deficit != null ? copyFrom.n_deficit : ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Seasonal Urea Req (kg/ha)</label>
          <input class="form-input agro-ep-urearq" type="number" step="1"
            value="${copyFrom?.seasonal_urea_req != null ? copyFrom.seasonal_urea_req : ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Soil Type</label>
          <select class="form-select agro-ep-soil">
            <option value="">—</option>
            ${SOIL_TYPES.map(s =>
              `<option value="${s}"${copyFrom?.soil_type === s ? ' selected' : ''}>${s}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Seed / Wet Date</label>
          <input class="form-input agro-ep-wetdate" type="date"
            value="${copyFrom?.seed_wet_date || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">1st In-Crop IRR Date</label>
          <input class="form-input agro-ep-irrdate" type="date"
            value="${copyFrom?.first_incrop_irr_date || ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label class="form-label">In-Crop Sprays</label>
          <textarea class="form-input agro-ep-sprays" rows="2"
            placeholder="e.g. 2.2L DST 180g Butroxydim 21-10-26">${esc(copyFrom?.incrop_sprays_notes || '')}</textarea>
        </div>
        <div class="form-group" style="flex:2">
          <label class="form-label">Fertiliser / Irrigation Notes</label>
          <textarea class="form-input agro-ep-fert" rows="2"
            placeholder="e.g. 100kg urea 22-10-26">${esc(copyFrom?.incrop_fert_notes || '')}</textarea>
        </div>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group" style="flex:2">
        <label class="form-label">Comments / Observations</label>
        <textarea class="form-input agro-ep-comments" rows="2"
          placeholder="Notes from this visit">${esc(copyFrom?.comments || '')}</textarea>
      </div>
      <div class="form-group" style="flex:2">
        <label class="form-label">Upcoming Jobs</label>
        <textarea class="form-input agro-ep-jobs" rows="2"
          placeholder="Actions before next visit">${esc(copyFrom?.upcoming_jobs || '')}</textarea>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:14px;padding-bottom:4px">
      <label class="form-label" style="margin:0">Priority:</label>
      <label style="display:inline-flex;align-items:center;gap:5px;font-size:0.82rem;cursor:pointer">
        <input type="radio" name="pri-${rid}" class="agro-ep-priority" value="none"${!copyFrom?.priority || copyFrom.priority === 'none' ? ' checked' : ''}> On track
      </label>
      <label style="display:inline-flex;align-items:center;gap:5px;font-size:0.82rem;cursor:pointer">
        <input type="radio" name="pri-${rid}" class="agro-ep-priority" value="medium"${copyFrom?.priority === 'medium' ? ' checked' : ''}> Watch
      </label>
      <label style="display:inline-flex;align-items:center;gap:5px;font-size:0.82rem;cursor:pointer">
        <input type="radio" name="pri-${rid}" class="agro-ep-priority" value="high"${copyFrom?.priority === 'high' ? ' checked' : ''}> High priority
      </label>
    </div>
  `;

  list.appendChild(div);

  // Update area hint when paddock selection changes
  const nameEl = div.querySelector('.agro-ep-name');
  const hintEl = div.querySelector('.agro-ep-area-hint');
  nameEl?.addEventListener('change', () => {
    if (hintEl) hintEl.innerHTML = _areaHint(nameEl.value);
  });

  div.querySelector('.agro-ep-commodity')?.addEventListener('change', function () {
    div.querySelector('.agro-ep-crop-fields').style.display =
      FALLOW_COMMODITIES.has(this.value) ? 'none' : '';
  });

  div.querySelector('.agro-ep-remove')?.addEventListener('click', () => div.remove());
  div.querySelector('.agro-ep-copy-btn')?.addEventListener('click', () => openCopyModal(div, list));
}

// ── Copy-to-paddocks modal ─────────────────────────────────────────────────
function openCopyModal(sourceDiv, list) {
  const otherDivs = [...list.querySelectorAll('.agro-paddock-row')].filter(d => d !== sourceDiv);
  if (otherDivs.length === 0) {
    toast('Add more paddock rows first, then use Copy', 'warning');
    return;
  }

  const fields = [
    { key: 'sprays',   label: 'Spray records',           cls: '.agro-ep-sprays'   },
    { key: 'fert',     label: 'Fert / irrigation notes',  cls: '.agro-ep-fert'     },
    { key: 'height',   label: 'Height',                   cls: '.agro-ep-height'   },
    { key: 'nodes',    label: 'Nodes',                    cls: '.agro-ep-nodes'    },
    { key: 'ndeficit', label: 'N deficit',                cls: '.agro-ep-ndeficit' },
    { key: 'urearq',   label: 'Seasonal urea req',        cls: '.agro-ep-urearq'   },
    { key: 'irrdate',  label: 'IRR date',                 cls: '.agro-ep-irrdate'  },
    { key: 'jobs',     label: 'Upcoming jobs',            cls: '.agro-ep-jobs'     },
    { key: 'priority', label: 'Priority',                 cls: '.agro-ep-priority' },
  ];

  const srcName = sourceDiv.querySelector('.agro-ep-name')?.value || 'this paddock';

  openModal({
    title: 'Copy fields to other paddocks',
    bodyHTML: `
      <p style="font-size:0.85rem;color:var(--hint);margin-bottom:14px">
        Copy from <strong>${esc(srcName)}</strong> to the paddocks you select below.
      </p>
      <div style="margin-bottom:16px">
        <div class="form-label" style="margin-bottom:8px">Fields to copy</div>
        <div style="display:flex;flex-wrap:wrap;gap:10px">
          ${fields.map(f => `
            <label style="display:inline-flex;align-items:center;gap:5px;font-size:0.82rem;cursor:pointer">
              <input type="checkbox" class="copy-field-cb" value="${f.key}" checked> ${f.label}
            </label>`).join('')}
        </div>
      </div>
      <div>
        <div class="form-label" style="margin-bottom:8px">Copy to</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${otherDivs.map(d => {
            const name = d.querySelector('.agro-ep-name')?.value || d.id;
            return `<label style="display:inline-flex;align-items:center;gap:6px;font-size:0.82rem;cursor:pointer">
              <input type="checkbox" class="copy-target-cb" value="${d.id}" checked> ${esc(name)}
            </label>`;
          }).join('')}
        </div>
      </div>
    `,
    confirmLabel: 'Copy',
    onConfirm: async () => {
      const selFields  = [...document.querySelectorAll('.copy-field-cb:checked')].map(el => el.value);
      const selTargets = [...document.querySelectorAll('.copy-target-cb:checked')].map(el => el.value);

      selTargets.forEach(tid => {
        const tgt = document.getElementById(tid);
        if (!tgt) return;
        fields.filter(f => selFields.includes(f.key)).forEach(f => {
          if (f.key === 'priority') {
            const srcVal   = sourceDiv.querySelector('.agro-ep-priority:checked')?.value;
            const tgtRadio = tgt.querySelector(`.agro-ep-priority[value="${srcVal}"]`);
            if (tgtRadio) tgtRadio.checked = true;
          } else {
            const src = sourceDiv.querySelector(f.cls);
            const dst = tgt.querySelector(f.cls);
            if (src && dst) dst.value = src.value;
          }
        });
      });

      toast('Copied to ' + selTargets.length + ' paddock' + (selTargets.length !== 1 ? 's' : ''), 'success');
    },
  });
}

// ── Collect paddock row data ───────────────────────────────────────────────
function collectPaddockRows() {
  return [...document.querySelectorAll('.agro-paddock-row')].map(block => {
    const commodity = block.querySelector('.agro-ep-commodity')?.value || '';
    const isFallow  = FALLOW_COMMODITIES.has(commodity);
    const priority  = block.querySelector('.agro-ep-priority:checked')?.value || 'none';

    const row = {
      paddock_name:  block.querySelector('.agro-ep-name')?.value?.trim() || '',
      commodity,
      variety:       block.querySelector('.agro-ep-variety')?.value?.trim() || null,
      area_ha:       numOrNull(block.querySelector('.agro-ep-area')?.value),
      is_fallow:     isFallow,
      comments:      block.querySelector('.agro-ep-comments')?.value?.trim() || null,
      upcoming_jobs: block.querySelector('.agro-ep-jobs')?.value?.trim() || null,
      priority,
    };

    if (!isFallow) {
      Object.assign(row, {
        seed_wet_date:         block.querySelector('.agro-ep-wetdate')?.value || null,
        first_incrop_irr_date: block.querySelector('.agro-ep-irrdate')?.value || null,
        yield_target_t:        numOrNull(block.querySelector('.agro-ep-yield')?.value),
        soil_type:             block.querySelector('.agro-ep-soil')?.value || null,
        plant_est_pct:         numOrNull(block.querySelector('.agro-ep-est')?.value),
        plants_per_m2:         numOrNull(block.querySelector('.agro-ep-plants')?.value),
        height_cm_2:           numOrNull(block.querySelector('.agro-ep-height')?.value),
        nodes_3_count:         numOrNull(block.querySelector('.agro-ep-nodes')?.value),
        n_deficit:             numOrNull(block.querySelector('.agro-ep-ndeficit')?.value),
        seasonal_urea_req:     numOrNull(block.querySelector('.agro-ep-urearq')?.value),
        incrop_sprays_notes:   block.querySelector('.agro-ep-sprays')?.value?.trim() || null,
        incrop_fert_notes:     block.querySelector('.agro-ep-fert')?.value?.trim() || null,
      });
    }
    return row;
  });
}

// ── EDIT ENTRY ─────────────────────────────────────────────────────────────
function openEditEntryModal(entry) {
  openModal({
    title: 'Edit — ' + esc(entry.paddock_name),
    bodyHTML: `<div id="lv-paddock-list"></div>`,
    confirmLabel: 'Save changes',
    wide: true,
    onMounted: (overlay) => {
      _rowCounter = 0;
      addPaddockRow(overlay, entry);
      overlay.querySelector('.agro-ep-copy-btn')?.remove();
      overlay.querySelector('.agro-ep-remove')?.remove();
    },
    onConfirm: async () => {
      const rows = collectPaddockRows();
      if (!rows[0]) return;
      await dbUpdate('agronomy_paddock_entries', entry.id, {
        ...rows[0], updated_at: new Date().toISOString(),
      });
      toast('Entry updated', 'success');
      await refreshAll();
      if (activePaddock) renderPaddockDetail(activePaddock);
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function buildPaddockMap() {
  const map = {};
  [...allEntries]
    .sort((a, b) => {
      const ra = allReports.find(r => r.id === a.report_id)?.report_date || '';
      const rb = allReports.find(r => r.id === b.report_id)?.report_date || '';
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    })
    .forEach(e => {
      const report = allReports.find(r => r.id === e.report_id);
      map[e.paddock_name] = { ...e, lastReportDate: report?.report_date };
    });
  return map;
}

function avgOf(arr, key) {
  const vals = arr.map(o => parseFloat(o[key])).filter(v => !isNaN(v));
  return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
}

function fmtHa(v) {
  const n = parseFloat(v);
  return !isNaN(n) ? n.toFixed(1) + ' ha' : null;
}

function numOrNull(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
