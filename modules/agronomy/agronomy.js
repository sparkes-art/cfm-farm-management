// modules/agronomy/agronomy.js
// CFM Agronomy Module — Scouting visits & Crop Plan
// Updated 2026-11-12

import { dbSelect, dbInsert, dbUpdate, dbDelete, dbUpsert } from '../../js/supabase-client.js?v=1794546671365';
import { getActiveFarm, getActiveSeason }         from '../../js/app-state.js?v=1794546671365';
import { toast, openModal, formatDate }            from '../../js/ui.js?v=1794546671365';
import { loadCommodities, getCropTypes }           from '../../js/commodities.js?v=1794546671365';

// Deduplicated crop type names across all commodities — for the crop plan dropdown.
// Cotton Irrigated appears once even though it may exist under both Cotton Lint and Cotton Seed.
// If the active farm has a cropTypes whitelist in settings, only those names are shown.
function _planCropTypes() {
  const seen = new Set();
  const all = getCropTypes()
    .map(ct => ct.name)
    .filter(n => { if (seen.has(n)) return false; seen.add(n); return true; })
    .sort((a, b) => a.localeCompare(b));
  const whitelist = getActiveFarm()?.settings?.cropTypes;
  if (!whitelist?.length) return all;
  return all.filter(n => whitelist.includes(n));
}

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

// Commodity colour map — distinct colours per crop so cells are distinguishable at a glance
const CP_COMMODITY_COLORS = {
  // Cotton — blues
  'Cotton Irrigated':{ bg: '#dbeafe', text: '#1e3a8a', dot: '#3b82f6' },
  'Cotton Dryland':  { bg: '#bfdbfe', text: '#1e40af', dot: '#2563eb' },
  'Cotton':          { bg: '#dbeafe', text: '#1e3a8a', dot: '#3b82f6' }, // legacy fallback
  // Cereals / row crops — yellows & oranges
  'Corn':            { bg: '#fef9c3', text: '#713f12', dot: '#eab308' },
  'Corn Hay':        { bg: '#fef3c7', text: '#78350f', dot: '#f59e0b' },
  'Sorghum':         { bg: '#ffedd5', text: '#7c2d12', dot: '#f97316' },
  'Wheat':           { bg: '#fce7f3', text: '#831843', dot: '#ec4899' },
  // Legumes — purples
  'Chickpea':        { bg: '#ede9fe', text: '#3b0764', dot: '#8b5cf6' },
  'Pigeon Pea':      { bg: '#f3e8ff', text: '#581c87', dot: '#a855f7' },
  // Hays / pastures — clearly distinct greens & teals
  'Rhodes Hay':      { bg: '#ccfbf1', text: '#134e4a', dot: '#14b8a6' }, // teal
  'Jarrah Hay':      { bg: '#d1fae5', text: '#065f46', dot: '#10b981' }, // emerald
  'Jarrah Dryland':  { bg: '#d1fae5', text: '#065f46', dot: '#10b981' }, // emerald (alias)
  'Cavalcade Hay':   { bg: '#fef08a', text: '#713f12', dot: '#ca8a04' }, // amber-yellow — clearly distinct from greens
  'Cavalcade Dryland':{ bg: '#fef08a', text: '#713f12', dot: '#ca8a04' }, // amber-yellow (alias)
  'Setaria Hay':     { bg: '#bbf7d0', text: '#14532d', dot: '#16a34a' }, // lighter green
  // Fallow
  'Fallow':          { bg: '#f1f5f9', text: '#64748b', dot: '#94a3b8' },
};

// ── Mount / unmount ────────────────────────────────────────────────────────
export async function mountAgronomy(container) {
  container.innerHTML = buildShell();
  bindTabNav(container);
  _bindPaddocksNav(container);
  // When the global season changes, refresh data and reset crop plan season
  window.addEventListener('cfm:seasonchange', _onSeasonChange);
  await refreshAll();
}

function _onSeasonChange() {
  const cpEl = document.getElementById('agro-tab-cropplan');
  if (cpEl) delete cpEl.dataset.cpSeason;
  refreshAll();
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
  window.removeEventListener('cfm:seasonchange', _onSeasonChange);
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

  await loadCommodities();

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
  // Reset crop plan season when switching to it, so it re-reads the global season
  if (tab === 'cropplan') {
    const cpEl = document.getElementById('agro-tab-cropplan');
    if (cpEl) delete cpEl.dataset.cpSeason;
  }
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

// Inline-edit state
let _cpEditCell   = null;   // { td, entryId, field, originalValue }
let _cpSaving     = false;
let _cpTypeFilter    = null;   // null = show all; string = filter by commodity
let _cpPaddockFilter = null;   // null = show all; string = filter by paddock type
let _cpSearch        = '';     // paddock name search string
let _cpActiveSeason  = null;   // which season gets 2-column treatment; null = auto (latest)
let _cpSeasonFilter  = {};    // { [seasonLabel]: commodityName } — filter paddock rows by what they grew in that season

// Active season label (full label like "Summer 2026-27") — set each render
let _currentSeasonLabel = null;
const isCurrentSeasonLabel = s => !!_currentSeasonLabel && s === _currentSeasonLabel;

// Best ha for a single entry — harvested > planted > planned (module-scope so cpMatrixCell can use it)
// Only treats planted_ha as actual if status is planted/growing/harvested (not intent/budget)
const ACTUAL_STATUSES = new Set(['planted', 'growing', 'harvested']);
const _bestHa = c => {
  if (c.status === 'harvested') {
    const harv = (parseFloat(c.planted_ha) || 0) - (parseFloat(c.area_loss_ha) || 0);
    return { ha: harv, label: 'Harvested' };
  }
  if (ACTUAL_STATUSES.has(c.status) && c.planted_ha != null && !isNaN(parseFloat(c.planted_ha))) {
    return { ha: parseFloat(c.planted_ha), label: 'Planted' };
  }
  if (c.planned_ha != null && !isNaN(parseFloat(c.planned_ha))) return { ha: parseFloat(c.planned_ha), label: 'Planned' };
  return { ha: null, label: null };
};

// Paddock type colour palette — mirrors paddocks.js
const PADDOCK_TYPE_COLORS = {
  'Pasture':                     { bg: '#d1fae5', text: '#065f46', dot: '#10b981' },
  'Grazing/Bush':                { bg: '#dcfce7', text: '#14532d', dot: '#22c55e' },
  'Dryland':                     { bg: '#fef9c3', text: '#713f12', dot: '#eab308' },
  'Irrigated - Overhead Pivot':  { bg: '#dbeafe', text: '#1e3a8a', dot: '#3b82f6' },
  'Irrigated - Overhead Lateral':{ bg: '#e0f2fe', text: '#0c4a6e', dot: '#0ea5e9' },
  'Irrigated - Furrow':          { bg: '#ede9fe', text: '#3b0764', dot: '#8b5cf6' },
  'Permanent Crop':              { bg: '#fce7f3', text: '#831843', dot: '#ec4899' },
};

// Inject chip styles once
if (!document.getElementById('cp-chip-styles')) {
  const s = document.createElement('style');
  s.id = 'cp-chip-styles';
  s.textContent = `
    .cp-type-chip { display:inline-flex;align-items:center;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;border:1px solid var(--border);background:var(--surface);color:var(--hint);cursor:pointer;transition:all 0.12s;white-space:nowrap }
    .cp-type-chip:hover { border-color:currentColor;opacity:0.85 }
    .cp-type-chip--active { opacity:1 }
    .cp-type-chip.cp-crop-chip:hover  { color:var(--blue) }
    .cp-type-chip.cp-crop-chip.cp-type-chip--active { background:var(--blue);border-color:var(--blue);color:#fff }
  `;
  document.head.appendChild(s);
}

// Column definitions for the spreadsheet
const CP_COLUMNS = [
  { key: 'paddock_name',  label: 'Paddock',     type: 'text',    width: '160px', bold: true },
  { key: 'sub_block',     label: 'Sub-block',   type: 'text',    width: '110px' },
  { key: 'commodity',     label: 'Crop type',   type: 'select',  width: '130px', options: () => _planCropTypes() },
  { key: 'variety',       label: 'Variety',     type: 'text',    width: '110px' },
  { key: 'planned_ha',    label: 'Planned ha',  type: 'number',  width: '90px',  align: 'right' },
  { key: 'planted_ha',    label: 'Planted ha',  type: 'number',  width: '90px',  align: 'right' },
  { key: 'area_loss_ha',  label: 'Loss ha',     type: 'number',  width: '80px',  align: 'right', red: true },
  { key: '_active_ha',    label: 'Active ha',   type: 'computed',width: '85px',  align: 'right', bold: true },
  { key: 'status',        label: 'Status',      type: 'select',  width: '110px', options: () => CP_STATUSES, labelMap: CP_STATUS_LABELS, badgeMap: CP_STATUS_CLASSES },
  { key: 'wet_date',      label: 'Wet date',    type: 'date',    width: '110px' },
  { key: 'notes',         label: 'Notes',       type: 'text',    width: '180px', hint: true },
];


// Blackbull 2025-26 seed data
const BB_2526_SEED = [
  // Cotton — Summer 2025-26 (harvested)
  { paddock_name:'Pivot 1',               sub_block:null, commodity:'Cotton Irrigated', variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:52.3,  planted_ha:51.1,  area_loss_ha:1.2  },
  { paddock_name:'Pivot 2',               sub_block:null, commodity:'Cotton Irrigated', variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:53.5,  planted_ha:49.9,  area_loss_ha:3.6  },
  { paddock_name:'Pivot Dryland/Bradens', sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:46.8,  planted_ha:31.5,  area_loss_ha:15.3 },
  { paddock_name:'House Mahogany',        sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:267.2, planted_ha:195.3, area_loss_ha:71.9 },
  { paddock_name:'Sabi & Airstrip',       sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:250.0, planted_ha:244.0, area_loss_ha:6.0  },
  { paddock_name:'Yard East Buffel',      sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:112.4, planted_ha:92.8,  area_loss_ha:19.6 },
  { paddock_name:'Black Bull 5',          sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:125.8, planted_ha:94.7,  area_loss_ha:31.1 },
  { paddock_name:'Black Bull 1',          sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:43.3,  planted_ha:36.2,  area_loss_ha:7.1  },
  { paddock_name:'Black Bull 2',          sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:89.1,  planted_ha:75.0,  area_loss_ha:14.1 },
  { paddock_name:'Black Bull 3',          sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:152.4, planted_ha:140.3, area_loss_ha:12.1 },
  { paddock_name:'Black Bull 4',          sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:112.0, planted_ha:82.1,  area_loss_ha:29.9 },
  { paddock_name:'Tree Trial',            sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:17.6,  planted_ha:17.6,  area_loss_ha:0.0  },
  { paddock_name:'Leuceana',              sub_block:null, commodity:'Cotton Dryland',   variety:'253B3XF', season_label:'Summer 2025-26', season_type:'Summer', status:'harvested', planned_ha:20.2,  planted_ha:19.7,  area_loss_ha:0.5  },
  // Hay / Pasture — Annual 2025-26
  { paddock_name:'Pivot 3',               sub_block:null, commodity:'Rhodes Hay',    variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:38.0,  planted_ha:40.4,  area_loss_ha:null },
  { paddock_name:'Pivot 4',               sub_block:null, commodity:'Rhodes Hay',    variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:50.0,  planted_ha:51.8,  area_loss_ha:null },
  { paddock_name:'Braedons',              sub_block:null, commodity:'Jarrah Hay',    variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:17.8,  planted_ha:17.8,  area_loss_ha:null },
  { paddock_name:'Billabong',             sub_block:null, commodity:'Cavalcade Hay', variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'growing',   planned_ha:116.1, planted_ha:null,  area_loss_ha:null, notes:'Not harvested — cattle feed' },
  { paddock_name:'Boghole 1',             sub_block:null, commodity:'Cavalcade Hay', variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:101.2, planted_ha:85.0,  area_loss_ha:null },
  { paddock_name:'Boghole 2',             sub_block:null, commodity:'Cavalcade Hay', variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:404.9, planted_ha:335.0, area_loss_ha:null },
  { paddock_name:'Boghole 3',             sub_block:null, commodity:'Cavalcade Hay', variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:165.3, planted_ha:137.0, area_loss_ha:null },
  { paddock_name:'Broken Windmill',       sub_block:null, commodity:'Cavalcade Hay', variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:234.4, planted_ha:213.0, area_loss_ha:null },
  { paddock_name:'House Buffel',          sub_block:null, commodity:'Corn Hay',      variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:75.0,  planted_ha:60.0,  area_loss_ha:null },
  { paddock_name:'Cadell',                sub_block:null, commodity:'Jarrah Hay',    variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:269.5, planted_ha:250.0, area_loss_ha:null },
  { paddock_name:'Black Bull North Top',  sub_block:null, commodity:'Jarrah Hay',    variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:152.3, planted_ha:140.0, area_loss_ha:null },
  { paddock_name:'Black Bull North Middle',sub_block:null,commodity:'Jarrah Hay',    variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:128.0, planted_ha:190.0, area_loss_ha:null },
  { paddock_name:'Black Bull South Top',  sub_block:null, commodity:'Jarrah Hay',    variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'growing',   planned_ha:103.2, planted_ha:null,  area_loss_ha:null, notes:'Not harvested — cattle feed' },
  { paddock_name:'Black Bull South Bottom',sub_block:null,commodity:'Sorghum',       variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:170.7, planted_ha:170.0, area_loss_ha:null },
  { paddock_name:'Quarry Hay',            sub_block:null, commodity:'Cavalcade Hay', variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'growing',   planned_ha:25.0,  planted_ha:null,  area_loss_ha:null, notes:'Not harvested — cattle feed' },
  { paddock_name:'Yard East Jarrah',      sub_block:null, commodity:'Cavalcade Hay', variety:null, season_label:'Annual 2025-26', season_type:'Annual', status:'harvested', planned_ha:217.4, planted_ha:217.9, area_loss_ha:null },
];

// ── Crop plan: sorted season list ──────────────────────────────────────────
// Seasons sort chronologically: extract year pairs and type for ordering.
// "Summer 2025-26" → type Summer, year 2025; "Annual 2025-26" → Annual, 2025.
// Order: by start year ASC, then Summer < Annual < Winter within a year.
function sortSeasons(seasons) {
  const typeOrder = { Summer: 0, Annual: 1, Winter: 2 };
  return [...seasons].sort((a, b) => {
    const pa = _parseSeason(a), pb = _parseSeason(b);
    if (pa.year !== pb.year) return pa.year - pb.year;
    return (typeOrder[pa.type] ?? 9) - (typeOrder[pb.type] ?? 9);
  });
}
function _parseSeason(label) {
  const m = label.match(/(\d{4})/);
  const year = m ? parseInt(m[1]) : 9999;
  const type = label.startsWith('Summer') ? 'Summer'
             : label.startsWith('Annual') ? 'Annual'
             : label.startsWith('Winter') ? 'Winter' : 'Other';
  return { year, type };
}

function renderCropPlan() {
  const el = document.getElementById('agro-tab-cropplan');
  if (!el) return;

  // All unique seasons, chronologically sorted
  const allSeasons = sortSeasons(
    [...new Set(allCropPlan.map(c => c.season_label).filter(Boolean))]
  );

  // "Current" season for 2-column treatment = latest season in the crop plan data.
  // We do NOT use getActiveSeason() (the global budget-module picker) because it
  // defaults to the most recent *budget* season which may differ from the latest
  // season in the crop plan.
  const latestSeason = allSeasons[allSeasons.length - 1] || null;
  _currentSeasonLabel = latestSeason;
  // Local inline check — bypasses any closure/timing issue with the module-level variable
  const isCurSeason = s => !!latestSeason && s === latestSeason;


  // ── Build the paddock × season matrix ──────────────────────────────────
  // Rows: all unique paddock+sub_block combos across ALL seasons (so blank cells
  // appear for seasons where a paddock had nothing — planning rows can be added).
  // Columns: paddock name | sub-block | ...one column per season...
  // Each season cell shows: commodity (small, coloured) / planned ha / planted ha

  // All unique commodities in use for the CURRENT season only (for Crop filter chips)
  const usedCropTypes = [...new Set(
    allCropPlan.filter(c => c.season_label === latestSeason).map(c => c.commodity).filter(Boolean)
  )].sort();

  // All unique paddock types from the paddock list (for filter chips)
  const usedPaddockTypes = [...new Set(allPaddocks.map(p => p.type).filter(Boolean))].sort();

  // Paddock names matching the paddock-type filter
  const filteredPaddockSet = _cpPaddockFilter
    ? new Set(allPaddocks.filter(p => p.type === _cpPaddockFilter).map(p => p.name))
    : null;

  // Index entries: paddockKey → seasonLabel → entry (built first so season filters can use it)
  const idx = {};
  allCropPlan.forEach(c => {
    const pk = c.paddock_name + '|' + (c.sub_block || '');
    if (!idx[pk]) idx[pk] = {};
    idx[pk][c.season_label] = c;
  });

  // Collect all paddock keys (paddock_name + sub_block)
  // Rows with any planned or planted data float to top; rest alphabetical below
  const paddockKeys = [];
  const seen = new Set();
  const cropTypeFilteredKeys = _cpTypeFilter
    ? new Set(allCropPlan.filter(c => c.commodity === _cpTypeFilter).map(c => c.paddock_name + '|' + (c.sub_block || '')))
    : null;
  // hasEntry: set of keys that have at least one entry with planned_ha or planted_ha
  const hasEntrySet = new Set(
    allCropPlan
      .filter(c => (parseFloat(c.planned_ha) || 0) > 0 || (parseFloat(c.planted_ha) || 0) > 0)
      .map(c => c.paddock_name + '|' + (c.sub_block || ''))
  );
  [...allCropPlan]
    .sort((a, b) => {
      const aKey = a.paddock_name + '|' + (a.sub_block || '');
      const bKey = b.paddock_name + '|' + (b.sub_block || '');
      const aHas = hasEntrySet.has(aKey) ? 0 : 1;
      const bHas = hasEntrySet.has(bKey) ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return a.paddock_name.localeCompare(b.paddock_name) ||
             (a.sub_block || '').localeCompare(b.sub_block || '');
    })
    .forEach(c => {
      const key = c.paddock_name + '|' + (c.sub_block || '');
      const passesCropType    = !cropTypeFilteredKeys || cropTypeFilteredKeys.has(key);
      const passesPaddockType = !filteredPaddockSet   || filteredPaddockSet.has(c.paddock_name);
      const searchLower = _cpSearch.trim().toLowerCase();
      const passesSearch = !searchLower || c.paddock_name.toLowerCase().includes(searchLower);
      // Per-season commodity filters: paddock must have the specified commodity in that season
      const passesSeasonFilters = Object.entries(_cpSeasonFilter).every(([seasonLabel, commodity]) => {
        if (!commodity) return true;
        const e = idx[key]?.[seasonLabel];
        return e?.commodity === commodity;
      });
      if (!seen.has(key) && passesCropType && passesPaddockType && passesSearch && passesSeasonFilters) {
        seen.add(key);
        paddockKeys.push({ paddock_name: c.paddock_name, sub_block: c.sub_block || null });
      }
    });

  // Totals per season (single best-ha number, top-level rows only)
  const seasonTotals = {};
  // Commodities per season (for column filter dropdowns)
  const seasonCommodities = {};
  allSeasons.forEach(s => {
    const rows = allCropPlan.filter(c => c.season_label === s && !c.sub_block);
    seasonTotals[s] = rows.reduce((t, c) => t + (_bestHa(c).ha || 0), 0);
    seasonCommodities[s] = [...new Set(rows.map(c => c.commodity).filter(Boolean))].sort();
  });

  // Summary by commodity + variety — entries matching the global season picker
  // The global picker returns e.g. "2026-27"; crop plan labels may be "Summer 2026-27" or "2026-27"
  const activeSeason = getActiveSeason() || '';
  const summarySeasonEntries = allCropPlan.filter(c =>
    c.season_label && (c.season_label === activeSeason || c.season_label.endsWith(activeSeason))
  );
  const commoditySummary = {};
  summarySeasonEntries.forEach(c => {
    if (!c.commodity) return;
    if (!commoditySummary[c.commodity]) commoditySummary[c.commodity] = { planned: 0, actual: 0, varieties: {} };
    const plannedN = parseFloat(c.planned_ha) || 0;
    commoditySummary[c.commodity].planned += plannedN;
    // Only count as actual if the entry has a real planted/harvested status — not budget/intent/planned
    const isActual = ACTUAL_STATUSES.has(c.status);
    const { ha: actualHa } = _bestHa(c);
    if (isActual && actualHa != null) commoditySummary[c.commodity].actual += actualHa;
    const vKey = c.variety || '(no variety)';
    if (!commoditySummary[c.commodity].varieties[vKey])
      commoditySummary[c.commodity].varieties[vKey] = { planned: 0, actual: 0 };
    commoditySummary[c.commodity].varieties[vKey].planned += plannedN;
    if (isActual && actualHa != null) commoditySummary[c.commodity].varieties[vKey].actual += actualHa;
  });
  const summaryEntries = Object.entries(commoditySummary).sort((a, b) => (b[1].actual || b[1].planned) - (a[1].actual || a[1].planned));

  const hasData = paddockKeys.length > 0;

  el.innerHTML = `
    <div class="page-header" style="margin-bottom:12px">
      <div>
        <h2 style="font-size:var(--text-md);font-weight:600;margin:0">Crop Plan</h2>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-secondary" id="cp-bulk-assign-btn">☑ Bulk assign</button>
        <button class="btn btn-secondary" id="cp-plan-season-btn">+ Plan season</button>
        <button class="btn btn-secondary" id="cp-add-paddock-btn">+ Add paddock</button>
      </div>
    </div>
    <div style="margin-bottom:10px">
      <input type="search" id="cp-search" class="form-input" placeholder="Search paddocks…"
        value="${esc(_cpSearch)}"
        style="max-width:260px;font-size:0.82rem;padding:5px 10px">
    </div>

    ${(usedCropTypes.length > 0 || usedPaddockTypes.length > 0) ? `
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
      ${usedPaddockTypes.length > 0 ? `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint);width:72px;flex-shrink:0">Paddock:</span>
        <button class="cp-type-chip cp-paddock-chip${!_cpPaddockFilter ? ' cp-type-chip--active' : ''}"
          data-type="" style="${!_cpPaddockFilter ? 'background:var(--surface);border-color:var(--fg);color:var(--fg)' : ''}">All</button>
        ${usedPaddockTypes.map(t => {
          const c = PADDOCK_TYPE_COLORS[t] || { bg: 'var(--surface)', text: 'var(--hint)', dot: 'var(--border)' };
          const isActive = _cpPaddockFilter === t;
          const style = isActive
            ? `background:${c.bg};border-color:${c.dot};color:${c.text}`
            : ``;
          return `<button class="cp-type-chip cp-paddock-chip${isActive ? ' cp-type-chip--active' : ''}"
            data-type="${esc(t)}"
            style="${style}"
            onmouseover="if(!this.classList.contains('cp-type-chip--active')){this.style.background='${c.bg}';this.style.borderColor='${c.dot}';this.style.color='${c.text}'}"
            onmouseout="if(!this.classList.contains('cp-type-chip--active')){this.style.background='';this.style.borderColor='';this.style.color=''}"
          ><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c.dot};margin-right:5px;flex-shrink:0"></span>${esc(t)}</button>`;
        }).join('')}
      </div>` : ''}
      ${usedCropTypes.length > 0 ? `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint);width:72px;flex-shrink:0">Crop:</span>
        <button class="cp-type-chip cp-crop-chip${!_cpTypeFilter ? ' cp-type-chip--active' : ''}" data-type="">All</button>
        ${usedCropTypes.map(t => `<button class="cp-type-chip cp-crop-chip${_cpTypeFilter === t ? ' cp-type-chip--active' : ''}" data-type="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>` : ''}
    </div>
    ` : ''}

    ${summaryEntries.length > 0 ? `
    <div style="margin-bottom:16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;max-width:480px">
      <table style="border-collapse:collapse;width:100%;font-size:0.82rem">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:7px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint)">Crop</th>
            <th style="text-align:right;padding:7px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint)">Planned</th>
            <th style="text-align:right;padding:7px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint)">Planted / Actual</th>
            <th style="width:28px;padding:7px 8px"></th>
          </tr>
        </thead>
        <tbody id="cp-summary-body">
          ${summaryEntries.map(([commodity, tots]) => {
            const varRows = Object.entries(tots.varieties)
              .sort((a, b) => (b[1].actual || b[1].planned) - (a[1].actual || a[1].planned))
              .map(([v, vt]) => `
                <tr class="cp-summary-var-row" data-commodity="${esc(commodity)}" style="display:none;background:color-mix(in srgb,var(--blue) 3%,var(--surface))">
                  <td style="padding:5px 12px 5px 24px;color:var(--hint);font-size:0.76rem">${esc(v)}</td>
                  <td style="text-align:right;padding:5px 12px;font-family:'DM Mono',monospace;font-size:0.76rem;color:var(--hint)">${vt.planned > 0 ? vt.planned.toFixed(0) : '—'}</td>
                  <td style="text-align:right;padding:5px 12px;font-family:'DM Mono',monospace;font-size:0.76rem;color:${vt.actual > 0 ? 'var(--green,#22c55e)' : 'var(--hint)'}">${vt.actual > 0 ? vt.actual.toFixed(0) : '—'}</td>
                  <td></td>
                </tr>`).join('');
            const hasVarieties = Object.keys(tots.varieties).length > 1 ||
              (Object.keys(tots.varieties).length === 1 && !Object.keys(tots.varieties)[0].startsWith('(no'));
            return `
              <tr class="cp-summary-row" data-commodity="${esc(commodity)}" style="border-top:1px solid var(--border);cursor:${hasVarieties ? 'pointer' : 'default'}">
                <td style="padding:8px 12px;font-weight:600;color:var(--fg)">${esc(commodity)}</td>
                <td style="text-align:right;padding:8px 12px;font-family:'DM Mono',monospace;font-weight:600;color:var(--fg)">${tots.planned > 0 ? tots.planned.toFixed(0) + ' ha' : '—'}</td>
                <td style="text-align:right;padding:8px 12px;font-family:'DM Mono',monospace;font-weight:600;color:${tots.actual > 0 ? 'var(--green,#22c55e)' : 'var(--hint)'}">${tots.actual > 0 ? tots.actual.toFixed(0) + ' ha' : '—'}</td>
                <td style="text-align:center;padding:8px 8px;color:var(--hint);font-size:0.7rem">${hasVarieties ? '▾' : ''}</td>
              </tr>
              ${varRows}`;
          }).join('')}
        </tbody>
      </table>
    </div>` : ''}

    ${!hasData ? `
      <div class="empty-state" style="padding:48px 20px">
        <div class="empty-icon">🌾</div>
        <p>No crop plan entries yet.</p>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn btn-primary" id="cp-empty-add-btn">+ Add paddock</button>
        </div>
      </div>
    ` : `
      <!-- Matrix table -->
      <div class="card" style="padding:0;overflow:hidden">
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
          <table id="cp-matrix" style="border-collapse:collapse;width:100%;min-width:${160 + allSeasons.reduce((w, s) => w + (isCurSeason(s) ? 300 : 143), 0)}px">
            <thead>
              <!-- Row 1: season labels -->
              <tr style="background:var(--surface)">
                <th style="${TH_FIXED}border-bottom:2px solid var(--border);padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint);white-space:nowrap;min-width:160px" rowspan="2">
                  Paddock
                </th>
                ${allSeasons.map(s => {
                  const tot = seasonTotals[s];
                  const isCur = isCurSeason(s);
                  // Non-current seasons span both thead rows (rowspan=2) since they have
                  // no Planned/Planted sub-header in row 2. Without rowspan=2 the table
                  // is malformed and browsers lay out columns incorrectly.
                  const sfVal = _cpSeasonFilter[s] || '';
                  const sfOpts = (seasonCommodities[s] || []).map(c =>
                    `<option value="${esc(c)}"${sfVal === c ? ' selected' : ''}>${esc(c)}</option>`).join('');
                  const filterDrop = sfOpts ? `
                    <select class="cp-season-filter-sel" data-season="${esc(s)}"
                      style="margin-top:4px;font-size:9px;padding:1px 3px;border:1px solid var(--border);border-radius:4px;
                        background:var(--bg);color:var(--hint);max-width:88px;cursor:pointer"
                      title="Filter rows by crop in ${esc(s)}">
                      <option value="">All crops</option>
                      ${sfOpts}
                    </select>` : '';
                  return `<th ${isCur ? 'colspan="2"' : 'rowspan="2"'}
                    style="padding:8px 10px;font-size:12px;font-weight:700;text-align:center;
                      border-left:2px solid var(--border);border-bottom:2px solid var(--border);
                      background:${isCur ? 'color-mix(in srgb,var(--blue) 8%,var(--surface))' : 'var(--surface)'};
                      color:${isCur ? 'var(--blue)' : 'var(--fg)'};
                      ${isCur ? 'white-space:nowrap;' : 'width:143px;max-width:143px;'}min-width:${isCur ? '300' : '143'}px">
                    ${esc(s)}
                    ${tot > 0 ? `<span style="display:block;font-size:10px;font-weight:400;color:var(--hint);margin-top:1px">${tot.toFixed(0)} ha</span>` : ''}
                    ${filterDrop}
                  </th>`;
                }).join('')}
                <th style="width:32px;border-bottom:2px solid var(--border);background:var(--surface)" rowspan="2"></th>
              </tr>
              <!-- Row 2: Planned / Planted sub-headers for current season only -->
              <tr style="background:var(--surface);border-bottom:2px solid var(--border)">
                ${allSeasons.map(s => {
                  if (!isCurSeason(s)) return '';
                  return `
                    <th style="padding:4px 8px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--hint);border-left:2px solid var(--border);text-align:right;width:143px;background:color-mix(in srgb,var(--blue) 8%,var(--surface))">Planned</th>
                    <th style="padding:4px 8px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--hint);text-align:right;width:143px;background:color-mix(in srgb,var(--blue) 8%,var(--surface))">Planted</th>`;
                }).join('')}
              </tr>
            </thead>
            <tbody id="cp-matrix-body">
              ${paddockKeys.map((pk, i) => cpMatrixRowHTML(pk, allSeasons, idx, i, latestSeason)).join('')}
            </tbody>
            <!-- Season totals footer -->
            <tfoot>
              <tr style="background:var(--surface);border-top:2px solid var(--border)">
                <td style="${TH_FIXED}padding:8px 12px;font-size:11px;font-weight:700;color:var(--hint)">TOTAL</td>
                ${allSeasons.map(s => {
                  const tot = seasonTotals[s];
                  if (isCurSeason(s)) {
                    // Two cells for current season: planned total | planted total
                    const rows = allCropPlan.filter(c => c.season_label === s && !c.sub_block);
                    const plannedTot = rows.reduce((t, c) => t + (parseFloat(c.planned_ha) || 0), 0);
                    const plantedTot = rows.reduce((t, c) => t + (parseFloat(c.planted_ha) || 0), 0);
                    return `
                      <td style="padding:8px 10px;border-left:2px solid var(--border);text-align:right;font-family:'DM Mono',monospace;font-size:12px;font-weight:700;background:color-mix(in srgb,var(--blue) 5%,var(--surface))">
                        ${plannedTot > 0 ? plannedTot.toFixed(1) : '—'}
                      </td>
                      <td style="padding:8px 10px;text-align:right;font-family:'DM Mono',monospace;font-size:12px;font-weight:700;color:${plantedTot > 0 ? 'var(--green,#22c55e)' : 'var(--hint)'};background:color-mix(in srgb,var(--blue) 5%,var(--surface))">
                        ${plantedTot > 0 ? plantedTot.toFixed(1) : '—'}
                      </td>`;
                  }
                  return `
                    <td style="padding:8px 10px;border-left:2px solid var(--border);text-align:center;font-family:'DM Mono',monospace;font-size:12px;font-weight:700">
                      ${tot > 0 ? tot.toFixed(1) : '—'}
                    </td>`;
                }).join('')}
                <td style="background:var(--surface)"></td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style="border-top:1px solid var(--border);padding:8px 14px;display:flex;align-items:center;gap:16px">
          <button class="btn-link" id="cp-add-row-btn" style="font-size:0.82rem">+ Add paddock row</button>
          <button class="btn-link" id="cp-add-season-btn" style="font-size:0.82rem;color:var(--hint)">+ Add season column</button>
          <span style="font-size:11px;color:var(--hint);margin-left:auto">Click a cell to edit · Tab moves right · Enter saves · Esc cancels</span>
        </div>
      </div>
    `}
  `;

  // ── DOM post-render diagnostic ───────────────────────────────────────────
  // Read back the actual colspans from the rendered thead to confirm what landed in DOM
  const _tbl = el.querySelector('#cp-matrix');
  if (_tbl) {
    const _ths = [..._tbl.querySelectorAll('thead tr:first-child th[border-left],' +
      'thead tr:first-child th')].filter(th => th.textContent.trim().match(/\d{4}/));
    console.log('[CropPlan] DOM colspans:', _ths.map(th => th.textContent.trim().split('\n')[0].trim() + ':colspan=' + (th.colSpan || th.getAttribute('colspan') || 1)));
    const _rows = [..._tbl.querySelectorAll('tbody tr.cp-matrix-row')];
    if (_rows[0]) {
      console.log('[CropPlan] DOM first-row cells:', _rows[0].cells.length, 'cells');
    }
  }

  // ── Wire filter chips ────────────────────────────────────────────────────
  el.querySelectorAll('.cp-paddock-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _cpPaddockFilter = btn.dataset.type || null;
      renderCropPlan();
    });
  });
  el.querySelectorAll('.cp-crop-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      _cpTypeFilter = btn.dataset.type || null;
      renderCropPlan();
    });
  });

  // Season column crop filters
  el.querySelectorAll('.cp-season-filter-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const season = sel.dataset.season;
      if (sel.value) _cpSeasonFilter[season] = sel.value;
      else delete _cpSeasonFilter[season];
      renderCropPlan();
    });
  });

  // Search input
  el.querySelector('#cp-search')?.addEventListener('input', e => {
    _cpSearch = e.target.value;
    renderCropPlan();
  });

  // ── Wire buttons ─────────────────────────────────────────────────────────
  const addPaddock = () => openAddPaddockModal(allSeasons, latestSeason);
  el.querySelector('#cp-add-paddock-btn')?.addEventListener('click', addPaddock);
  el.querySelector('#cp-empty-add-btn')?.addEventListener('click', addPaddock);
  el.querySelector('#cp-add-row-btn')?.addEventListener('click', addPaddock);

  el.querySelector('#cp-plan-season-btn')?.addEventListener('click', () => openPlanSeasonModal(allSeasons, latestSeason));
  el.querySelector('#cp-add-season-btn')?.addEventListener('click', () => openPlanSeasonModal(allSeasons, latestSeason));
  el.querySelector('#cp-bulk-assign-btn')?.addEventListener('click', () => openBulkAssignModal(allSeasons, latestSeason));

  // Delete row wiring
  el.querySelectorAll('.cp-del-row-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const paddock  = btn.dataset.paddock;
      const subBlock = btn.dataset.subblock || null;
      const toDelete = allCropPlan.filter(c =>
        c.paddock_name === paddock && (c.sub_block || null) === subBlock
      );
      if (!toDelete.length) return;
      if (!confirm(`Delete all ${toDelete.length} season entries for ${paddock}${subBlock ? ' / ' + subBlock : ''}?`)) return;
      await Promise.all(toDelete.map(c => dbDelete('crop_plan_entries', c.id)));
      toast('Paddock removed from plan', 'success');
      await refreshAll();
    });
  });

  // Summary table: expand/collapse variety rows
  el.querySelectorAll('.cp-summary-row').forEach(row => {
    row.addEventListener('click', () => {
      const commodity = row.dataset.commodity;
      const varRows = el.querySelectorAll(`.cp-summary-var-row[data-commodity="${CSS.escape(commodity)}"]`);
      if (!varRows.length) return;
      const isOpen = varRows[0].style.display !== 'none';
      varRows.forEach(r => { r.style.display = isOpen ? 'none' : ''; });
      const arrow = row.querySelector('td:last-child');
      if (arrow) arrow.textContent = isOpen ? '▾' : '▴';
    });
  });

  // Inline edit wiring on the matrix
  bindMatrixEdit(el);
}

const TH_FIXED = 'position:sticky;left:0;z-index:2;background:var(--surface);';

function cpMatrixRowHTML(pk, seasons, idx, rowIndex, currentSeason) {
  const { paddock_name, sub_block } = pk;
  const key      = paddock_name + '|' + (sub_block || '');
  const isSubRow = !!sub_block;
  const rowBg    = isSubRow ? 'background:color-mix(in srgb,var(--surface) 60%,var(--bg));' : '';

  const paddockMeta = !isSubRow ? allPaddocks.find(p => p.name === paddock_name) : null;
  const paddockType = paddockMeta?.type || null;
  const paddockArea = paddockMeta?.area_ha ? parseFloat(paddockMeta.area_ha) : null;

  const paddockCell = `
    <td style="${TH_FIXED}${rowBg}padding:8px 10px;border-bottom:1px solid var(--border);vertical-align:middle;cursor:default;min-width:120px;max-width:160px">
      <div style="display:flex;align-items:center;gap:6px">
        <div style="min-width:0">
          <div style="font-weight:${isSubRow ? '400' : '600'};font-size:0.85rem;${isSubRow ? 'padding-left:12px;color:var(--hint);' : ''}white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(isSubRow ? sub_block : paddock_name)}">
            ${isSubRow ? '↳ ' + esc(sub_block) : esc(paddock_name)}
          </div>
          ${!isSubRow ? (() => {
            const c = paddockType ? PADDOCK_TYPE_COLORS[paddockType] : null;
            const typeBadge = c
              ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 5px;border-radius:8px;background:${c.bg};color:${c.text};font-weight:600"><span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:${c.dot};flex-shrink:0"></span>${esc(paddockType)}</span>`
              : paddockType ? `<span style="color:var(--hint)">${esc(paddockType)}</span>` : '';
            const areaTag = paddockArea != null
              ? `<span style="color:var(--hint);font-family:'DM Mono',monospace;font-size:0.68rem">${paddockArea.toFixed(1)} ha</span>`
              : '';
            return (typeBadge || areaTag)
              ? `<div style="font-size:0.72rem;margin-top:3px;display:flex;align-items:center;gap:5px;flex-wrap:wrap">${typeBadge}${areaTag}</div>`
              : '';
          })() : ''}
        </div>
        <div style="display:flex;gap:3px;flex-shrink:0">
          ${!isSubRow ? `<button class="cp-add-subblock-btn btn-link" data-paddock="${esc(paddock_name)}"
            style="opacity:0;font-size:0.7rem;color:var(--hint);padding:1px 5px;border:1px dashed var(--border);border-radius:3px;white-space:nowrap;transition:opacity 0.1s"
            title="Add sub-block">+ sub</button>` : ''}
          <button class="cp-expand-btn btn-link" data-paddock="${esc(paddock_name)}" data-subblock="${esc(sub_block || '')}"
            style="opacity:0;font-size:0.75rem;color:var(--hint);padding:1px 5px;border:1px solid var(--border);border-radius:3px;transition:opacity 0.1s;line-height:1"
            title="Show detail">···</button>
        </div>
      </div>
    </td>`;

  const seasonCells = seasons.map(s => {
    const entry = idx[key]?.[s] || null;
    return cpMatrixCell(entry, paddock_name, sub_block, s, !!currentSeason && s === currentSeason);
  }).join('');

  const delBtn = !isSubRow ? `
    <td style="padding:4px 6px;border-bottom:1px solid var(--border);text-align:center;${rowBg}">
      <button class="cp-del-row-btn btn-link danger" data-paddock="${esc(paddock_name)}" data-subblock="${esc(sub_block || '')}"
        style="opacity:0;font-size:0.75rem;padding:2px 4px" title="Remove from plan">✕</button>
    </td>` : `<td style="border-bottom:1px solid var(--border);${rowBg}"></td>`;

  return `<tr class="cp-matrix-row" data-paddock="${esc(paddock_name)}" data-subblock="${esc(sub_block || '')}"
    style="transition:background 0.1s">${paddockCell}${seasonCells}${delBtn}</tr>`;
}

function cpMatrixCell(entry, paddockName, subBlock, seasonLabel, isCurrent) {
  const borderL   = 'border-left:2px solid var(--border);';
  const baseStyle = `padding:7px 8px;border-bottom:1px solid var(--border);text-align:center;vertical-align:middle;cursor:pointer;`;

  // Commodity chip (shared)
  const commColor     = entry?.commodity ? (CP_COMMODITY_COLORS[entry.commodity] || { bg: '#e0f2fe', text: '#0c4a6e' }) : null;
  const commodityLine = entry?.commodity
    ? `<div style="font-size:11px;font-weight:700;text-align:center;white-space:normal;word-break:break-word;padding:2px 5px;border-radius:4px;background:${commColor.bg};color:${commColor.text};margin-bottom:3px;line-height:1.3">${esc(entry.commodity)}</div>`
    : '';
  const statusDot   = entry ? _statusDot(entry.status) : '';
  const statusLabel = entry?.status ? `<span style="font-size:9px;text-transform:uppercase;letter-spacing:0.04em;color:var(--hint)">${CP_STATUS_LABELS[entry.status] || entry.status}</span>` : '';
  const topInfo     = `${commodityLine}<div style="display:flex;align-items:center;justify-content:center;gap:3px;margin-bottom:3px">${statusDot}${statusLabel}</div>`;

  if (isCurrent) {
    // Current season: two columns — Planned | Planted (same as original design)
    if (!entry) {
      return `
        <td class="cp-matrix-cell cp-matrix-cell--empty" data-paddock="${esc(paddockName)}" data-subblock="${esc(subBlock||'')}"
          data-season="${esc(seasonLabel)}" data-field="planned_ha"
          style="${baseStyle}${borderL}min-width:143px;color:var(--border);font-size:0.78rem" title="Click to add planned ha">—</td>
        <td class="cp-matrix-cell cp-matrix-cell--empty" data-paddock="${esc(paddockName)}" data-subblock="${esc(subBlock||'')}"
          data-season="${esc(seasonLabel)}" data-field="planted_ha"
          style="${baseStyle}min-width:143px;color:var(--border);font-size:0.78rem" title="Click to add planted ha">—</td>`;
    }
    const id = entry.id;
    const plannedN = parseFloat(entry.planned_ha);
    const plantedN = parseFloat(entry.planted_ha);
    const harvestedN = entry.status === 'harvested'
      ? (parseFloat(entry.planted_ha) || 0) - (parseFloat(entry.area_loss_ha) || 0)
      : null;
    const plannedDisp = !isNaN(plannedN)
      ? `<span style="font-family:'DM Mono',monospace;font-size:0.85rem">${plannedN.toFixed(1)}</span>`
      : `<span style="color:var(--hint)">—</span>`;
    const plantedDisp = harvestedN != null
      ? `<span style="font-family:'DM Mono',monospace;font-size:0.85rem;color:var(--hint)">${harvestedN.toFixed(1)}</span><span style="font-size:9px;color:var(--hint);margin-left:2px">hvst</span>`
      : !isNaN(plantedN)
        ? `<span style="font-family:'DM Mono',monospace;font-size:0.85rem;color:var(--green,#22c55e)">${plantedN.toFixed(1)}</span>`
        : `<span style="color:var(--hint)">—</span>`;
    return `
      <td class="cp-matrix-cell" data-id="${id}" data-field="planned_ha" data-type="number"
        style="${baseStyle}${borderL}min-width:143px;text-align:right" title="Planned ha — click to edit">
        ${commodityLine}
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:3px;margin-bottom:2px">${statusDot}${statusLabel}</div>
        ${plannedDisp}
      </td>
      <td class="cp-matrix-cell" data-id="${id}" data-field="${entry.status === 'harvested' ? 'area_loss_ha' : 'planted_ha'}" data-type="number"
        style="${baseStyle}min-width:143px;text-align:right;border-left:1px dashed var(--border)" title="${entry.status === 'harvested' ? 'Loss ha — click to edit (harvested = planted − loss)' : 'Planted ha — click to edit'}">
        ${plantedDisp}
      </td>`;
  }

  // Other seasons: single smart column — same width as one current-season column
  if (!entry) {
    return `<td class="cp-matrix-cell cp-matrix-cell--empty" data-paddock="${esc(paddockName)}" data-subblock="${esc(subBlock||'')}"
        data-season="${esc(seasonLabel)}" data-field="planned_ha"
        style="${baseStyle}${borderL}min-width:143px;color:var(--border);font-size:0.78rem" title="Click to add">—</td>`;
  }

  const id = entry.id;
  const { ha, label: haLabel } = _bestHa(entry);
  const haColor = entry.status === 'harvested' ? 'var(--hint)'
    : (entry.planted_ha != null && !isNaN(parseFloat(entry.planted_ha))) ? 'var(--green,#22c55e)'
    : 'var(--fg)';
  const haDisp = ha != null
    ? `<span style="font-family:'DM Mono',monospace;font-size:0.88rem;font-weight:600;color:${haColor}">${ha.toFixed(1)}</span><span style="font-size:9px;color:var(--hint);margin-left:2px">ha</span>`
    : `<span style="color:var(--hint)">—</span>`;
  const editField = entry.status === 'harvested' ? 'area_loss_ha'
    : (entry.planted_ha != null && !isNaN(parseFloat(entry.planted_ha))) ? 'planted_ha'
    : 'planned_ha';

  return `
    <td class="cp-matrix-cell" data-id="${id}" data-field="${editField}" data-type="number"
      style="${baseStyle}${borderL}min-width:143px" title="Click to edit — ${haLabel || 'planned'} ha">
      ${topInfo}${haDisp}
    </td>`;
}

function _statusDot(status) {
  const colors = { intent:'var(--hint)', budget:'var(--warning,#f59e0b)', planted:'var(--blue)', growing:'var(--green,#22c55e)', harvested:'var(--hint)' };
  const c = colors[status] || 'var(--hint)';
  return `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${c};margin-right:4px;vertical-align:middle" title="${status}"></span>`;
}

function bindMatrixEdit(container) {
  const table = container.querySelector('#cp-matrix');
  if (!table) return;

  // Hover: show del + sub-block buttons, highlight row
  const _setRowHover = (row, on) => {
    if (!row) return;
    row.style.background = on ? 'color-mix(in srgb, var(--blue) 4%, transparent)' : '';
    row.querySelector('.cp-del-row-btn')?.style      && (row.querySelector('.cp-del-row-btn').style.opacity      = on ? '1' : '0');
    row.querySelector('.cp-add-subblock-btn')?.style && (row.querySelector('.cp-add-subblock-btn').style.opacity = on ? '1' : '0');
    row.querySelector('.cp-expand-btn')?.style       && (row.querySelector('.cp-expand-btn').style.opacity       = on ? '1' : '0');
  };
  table.addEventListener('mouseover', e => _setRowHover(e.target.closest('tr.cp-matrix-row'), true));
  table.addEventListener('mouseout',  e => _setRowHover(e.target.closest('tr.cp-matrix-row'), false));

  // Add sub-block
  table.addEventListener('click', e => {
    const btn = e.target.closest('.cp-add-subblock-btn');
    if (!btn) return;
    e.stopPropagation();
    const paddockName = btn.dataset.paddock;
    const allSeasons  = sortSeasons([...new Set(allCropPlan.map(c => c.season_label).filter(Boolean))]);
    _openAddSubBlockModal(paddockName, allSeasons);
  });

  // Expand row detail
  table.addEventListener('click', e => {
    const btn = e.target.closest('.cp-expand-btn');
    if (!btn) return;
    e.stopPropagation();
    const paddock  = btn.dataset.paddock;
    const subblock = btn.dataset.subblock || '';
    const rowKey   = paddock + '\x00' + subblock;
    const tr       = btn.closest('tr.cp-matrix-row');
    if (!tr) return;

    // Toggle existing detail row
    const existingDetail = tr.nextElementSibling;
    if (existingDetail && existingDetail.classList.contains('cp-detail-row') &&
        existingDetail.dataset.key === rowKey) {
      existingDetail.remove();
      btn.textContent = '···';
      btn.title = 'Show detail';
      return;
    }
    // Remove any other open detail rows
    table.querySelectorAll('tr.cp-detail-row').forEach(r => r.remove());
    table.querySelectorAll('.cp-expand-btn').forEach(b => { b.textContent = '···'; b.title = 'Show detail'; });

    // Build detail row from entries for this paddock/subblock
    const entries = allCropPlan.filter(c =>
      c.paddock_name === paddock && (c.sub_block || '') === subblock
    );
    const seasons = sortSeasons([...new Set(allCropPlan.map(c => c.season_label).filter(Boolean))]);
    const colCount = 2 + seasons.length; // paddock col + seasons

    const detailRow = document.createElement('tr');
    detailRow.className = 'cp-detail-row';
    detailRow.dataset.key = rowKey;
    detailRow.style.cssText = 'background:color-mix(in srgb, var(--blue) 3%, var(--surface))';

    // Label cell (sticky)
    const labelTd = document.createElement('td');
    labelTd.colSpan = 2;
    labelTd.style.cssText = `position:sticky;left:0;z-index:2;background:color-mix(in srgb, var(--blue) 3%, var(--surface));
      padding:6px 8px;border-top:1px dashed var(--border);font-size:0.7rem;color:var(--hint);font-style:italic;white-space:nowrap`;
    labelTd.textContent = 'Detail';
    detailRow.appendChild(labelTd);

    // One td per season
    seasons.forEach(season => {
      const entry = entries.find(c => c.season_label === season);
      const td = document.createElement('td');
      td.style.cssText = 'border-top:1px dashed var(--border);padding:6px 8px;vertical-align:top;min-width:110px';

      if (entry) {
        const rows = [
          entry.variety   ? `<div><span style="color:var(--hint);font-size:0.68rem">Variety</span> <span style="font-size:0.72rem">${esc(entry.variety)}</span></div>` : '',
          entry.status    ? `<div><span style="color:var(--hint);font-size:0.68rem">Status</span> <span style="font-size:0.72rem">${esc(CP_STATUS_LABELS[entry.status] || entry.status)}</span></div>` : '',
          entry.wet_date  ? `<div><span style="color:var(--hint);font-size:0.68rem">Wet date</span> <span style="font-size:0.72rem">${esc(entry.wet_date)}</span></div>` : '',
          entry.yield_target_t_ha != null ? `<div><span style="color:var(--hint);font-size:0.68rem">Yield target</span> <span style="font-size:0.72rem">${entry.yield_target_t_ha} t/ha</span></div>` : '',
          entry.notes     ? `<div style="margin-top:3px;font-size:0.7rem;color:var(--hint);font-style:italic">${esc(entry.notes)}</div>` : '',
        ].filter(Boolean).join('');
        td.innerHTML = rows || '<span style="color:var(--hint);font-size:0.68rem">—</span>';
      } else {
        td.innerHTML = '<span style="color:var(--border);font-size:0.68rem">—</span>';
      }
      detailRow.appendChild(td);
    });

    tr.insertAdjacentElement('afterend', detailRow);
    btn.textContent = '▴';
    btn.title = 'Hide detail';
  });

  // Click a cell — open popover for the entry
  table.addEventListener('click', async e => {
    const td = e.target.closest('td.cp-matrix-cell');
    if (!td) return;
    if (e.target.closest('.cp-cell-popover')) return; // click inside popover itself

    _closeCellPopover();

    // Empty cell — create entry first, then open popover
    if (td.classList.contains('cp-matrix-cell--empty')) {
      await _createEntryForCell(td);
      return;
    }

    const entryId = td.dataset.id;
    const entry   = allCropPlan.find(c => c.id === entryId);
    if (entry) _openCellPopover(td, entry);
  });

  // Close popover on outside click
  document.addEventListener('click', e => {
    if (!e.target.closest('.cp-cell-popover') && !e.target.closest('td.cp-matrix-cell')) {
      _closeCellPopover();
    }
  }, { capture: true });
}

// ── Cell popover ───────────────────────────────────────────────────────────
let _activePopover = null;

function _closeCellPopover() {
  if (_activePopover) {
    _activePopover.remove();
    _activePopover = null;
  }
}

function _openCellPopover(td, entry) {
  _closeCellPopover();

  // Paddock metadata
  const paddockMeta = allPaddocks.find(p => p.name === entry.paddock_name);
  const mapArea = paddockMeta?.area_ha ? parseFloat(paddockMeta.area_ha) : null;

  // History: all OTHER seasons for this paddock/subblock, sorted newest first
  const history = allCropPlan
    .filter(c => c.paddock_name === entry.paddock_name &&
                 (c.sub_block || '') === (entry.sub_block || '') &&
                 c.id !== entry.id)
    .sort((a, b) => {
      const pa = _parseSeason(a.season_label), pb = _parseSeason(b.season_label);
      if (pa.year !== pb.year) return pb.year - pa.year;
      return (pa.type === 'Summer' ? 0 : pa.type === 'Annual' ? 1 : 2) -
             (pb.type === 'Summer' ? 0 : pb.type === 'Annual' ? 1 : 2);
    });

  const historyHTML = history.length > 0 ? `
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
      <div style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint);margin-bottom:6px">Prior seasons</div>
      <table style="border-collapse:collapse;width:100%;font-size:0.72rem">
        <thead>
          <tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:3px 4px;color:var(--hint);font-weight:600">Season</th>
            <th style="text-align:left;padding:3px 4px;color:var(--hint);font-weight:600">Crop</th>
            <th style="text-align:right;padding:3px 4px;color:var(--hint);font-weight:600">Ha</th>
            <th style="text-align:left;padding:3px 4px;color:var(--hint);font-weight:600">Status</th>
          </tr>
        </thead>
        <tbody>
          ${history.map(h => {
            const { ha: hBest, label: hLabel } = _bestHa(h);
            const hColor = h.status === 'harvested' ? 'var(--hint)'
              : (h.planted_ha != null && !isNaN(parseFloat(h.planted_ha))) ? 'var(--green,#22c55e)'
              : 'var(--fg)';
            return `
            <tr style="border-bottom:1px solid color-mix(in srgb,var(--border) 50%,transparent)">
              <td style="padding:3px 4px;white-space:nowrap;color:var(--hint)">${esc(h.season_label)}</td>
              <td style="padding:3px 4px;font-weight:600;color:var(--fg)">${esc(h.commodity || '—')}</td>
              <td style="padding:3px 4px;text-align:right;font-family:'DM Mono',monospace;color:${hColor}" title="${hLabel || ''}">${hBest != null ? hBest.toFixed(1) : '—'}</td>
              <td style="padding:3px 4px;color:var(--hint)">${h.status ? (CP_STATUS_LABELS[h.status] || h.status) : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : '';

  const pop = document.createElement('div');
  pop.className = 'cp-cell-popover';
  pop.style.cssText = `
    position:fixed;z-index:200;
    background:var(--surface);border:1px solid var(--border);
    border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.18);
    padding:14px 16px;min-width:300px;max-width:380px;
    max-height:85vh;overflow-y:auto;
  `;

  pop.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">
      <div style="font-size:0.82rem;font-weight:700;color:var(--fg)">${esc(entry.paddock_name)}${entry.sub_block ? ' · ' + esc(entry.sub_block) : ''}</div>
      <div style="font-size:0.75rem;color:var(--hint)">${esc(entry.season_label)}</div>
    </div>
    ${mapArea != null ? `<div style="font-size:0.72rem;color:var(--hint);margin-bottom:12px">Map area: <span style="font-family:'DM Mono',monospace;color:var(--fg);font-weight:600">${mapArea.toFixed(1)} ha</span></div>` : '<div style="margin-bottom:12px"></div>'}

    <div class="form-group" style="margin-bottom:10px">
      <label class="form-label" style="font-size:0.72rem">Crop type</label>
      <select class="form-select" id="cpop-commodity" style="font-size:0.82rem;padding:5px 8px">
        <option value="">—</option>
        ${_planCropTypes().map(n => `<option value="${n}"${entry.commodity === n ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div class="form-group">
        <label class="form-label" style="font-size:0.72rem">Status</label>
        <select class="form-select" id="cpop-status" style="font-size:0.82rem;padding:5px 8px">
          ${CP_STATUSES.map(s => `<option value="${s}"${entry.status === s ? ' selected' : ''}>${CP_STATUS_LABELS[s]}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:0.72rem">Planned ha${mapArea != null ? ` <span style="color:var(--hint);font-weight:400">(map: ${mapArea.toFixed(1)})</span>` : ''}</label>
        <input class="form-input" id="cpop-planned" type="number" step="0.1" min="0"
          value="${entry.planned_ha ?? ''}" style="font-size:0.82rem;padding:5px 8px;text-align:right;font-family:'DM Mono',monospace">
      </div>
      <div class="form-group">
        <label class="form-label" style="font-size:0.72rem">Planted ha</label>
        <input class="form-input" id="cpop-planted" type="number" step="0.1" min="0"
          value="${entry.planted_ha ?? ''}" style="font-size:0.82rem;padding:5px 8px;text-align:right;font-family:'DM Mono',monospace">
      </div>
    </div>

    <div class="form-group" style="margin-bottom:12px">
      <label class="form-label" style="font-size:0.72rem">Variety</label>
      <input class="form-input" id="cpop-variety" type="text"
        value="${esc(entry.variety || '')}" placeholder="—" style="font-size:0.82rem;padding:5px 8px">
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button class="btn btn-secondary" id="cpop-cancel" style="font-size:0.8rem;padding:5px 12px">Cancel</button>
      <button class="btn btn-primary"   id="cpop-save"   style="font-size:0.8rem;padding:5px 12px">Save</button>
    </div>

    ${historyHTML}
  `;

  document.body.appendChild(pop);
  _activePopover = pop;

  // Position anchored to the td — allow taller popover for history
  const rect = td.getBoundingClientRect();
  const popW = 380, popH = Math.min(600, window.innerHeight * 0.85);
  let top  = rect.bottom + 4;
  let left = rect.left;
  if (top + popH > window.innerHeight - 8) top = Math.max(8, rect.top - popH - 4);
  if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
  pop.style.top  = top  + 'px';
  pop.style.left = left + 'px';

  pop.querySelector('#cpop-cancel').addEventListener('click', _closeCellPopover);

  pop.querySelector('#cpop-save').addEventListener('click', async () => {
    const updates = {
      commodity:  document.getElementById('cpop-commodity')?.value || null,
      status:     document.getElementById('cpop-status')?.value    || 'intent',
      variety:    document.getElementById('cpop-variety')?.value?.trim() || null,
      planned_ha: numOrNull(document.getElementById('cpop-planned')?.value),
      planted_ha: numOrNull(document.getElementById('cpop-planted')?.value),
      updated_at: new Date().toISOString(),
    };
    _closeCellPopover();
    try {
      await dbUpdate('crop_plan_entries', entry.id, updates);
      Object.assign(entry, updates); // optimistic update in memory
      toast('Saved', 'success');
      renderCropPlan(); // re-render matrix to show updated cell
    } catch (err) {
      toast('Save failed — ' + (err.message || err), 'error');
    }
  });

  // Focus commodity on open
  setTimeout(() => pop.querySelector('#cpop-commodity')?.focus(), 50);
}

function _openAddSubBlockModal(paddockName, allSeasons) {
  const farm    = getActiveFarm();
  const farmId  = farm?.id || farm;
  const seasonOpts = allSeasons.map(s =>
    `<option value="${esc(s)}">${esc(s)}</option>`
  ).join('');

  openModal({
    title: `Add sub-block — ${paddockName}`,
    wide: true,
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Sub-block name *</label>
          <input class="form-input" id="sb-name" placeholder="e.g. North, A, Irrigated">
        </div>
        <div class="form-group">
          <label class="form-label">Crop type</label>
          <select class="form-select" id="sb-commodity">
            <option value="">—</option>
            ${_planCropTypes().map(n => `<option value="${n}">${n}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Planned ha</label>
          <input class="form-input" id="sb-planned" type="number" step="0.1" min="0" placeholder="ha">
        </div>
        <div class="form-group">
          <label class="form-label">Add to seasons</label>
          <select class="form-select" id="sb-seasons" multiple size="4" style="height:auto">
            ${seasonOpts}
          </select>
          <p style="font-size:0.75rem;color:var(--hint);margin-top:4px">Hold Ctrl/Cmd to select multiple</p>
        </div>
      </div>`,
    confirmLabel: 'Add sub-block',
    onMounted: overlay => {
      // Pre-select all seasons by default
      overlay.querySelectorAll('#sb-seasons option').forEach(o => o.selected = true);
    },
    onConfirm: async () => {
      const subBlock  = document.getElementById('sb-name')?.value?.trim();
      if (!subBlock) throw new Error('Sub-block name required');
      const commodity = document.getElementById('sb-commodity')?.value || null;
      const plannedHa = numOrNull(document.getElementById('sb-planned')?.value);
      const seasons   = [...document.getElementById('sb-seasons').selectedOptions].map(o => o.value);
      if (!seasons.length) throw new Error('Select at least one season');

      const rows = seasons.map(s => ({
        farm_id:      farmId,
        paddock_name: paddockName,
        sub_block:    subBlock,
        season_label: s,
        season_type:  s.startsWith('Summer') ? 'Summer' : s.startsWith('Winter') ? 'Winter' : 'Annual',
        status:       'intent',
        commodity,
        planned_ha:   plannedHa,
        planted_ha:   null,
        area_loss_ha: null,
        updated_at:   new Date().toISOString(),
      }));

      await dbInsert('crop_plan_entries', rows.length === 1 ? rows[0] : rows);
      toast(`Sub-block "${subBlock}" added to ${seasons.length} season${seasons.length > 1 ? 's' : ''}`, 'success');
      await refreshAll();
    },
  });
}

async function _createEntryForCell(td) {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;
  const paddockName = td.dataset.paddock;
  const subBlock    = td.dataset.subblock || null;
  const seasonLabel = td.dataset.season;
  const field       = td.dataset.field;

  const [newEntry] = await dbInsert('crop_plan_entries', {
    farm_id:      farmId,
    paddock_name: paddockName,
    sub_block:    subBlock || null,
    season_label: seasonLabel,
    season_type:  seasonLabel.startsWith('Summer') ? 'Summer' : seasonLabel.startsWith('Winter') ? 'Winter' : 'Annual',
    status:       'intent',
    updated_at:   new Date().toISOString(),
  });

  if (!newEntry) { toast('Failed to create entry', 'error'); return; }
  await refreshAll();

  // Pre-fill commodity from most recent plan entry for this paddock
  const recent = allCropPlan
    .filter(e => e.paddock_name === paddockName && e.commodity && e.id !== newEntry.id)
    .sort((a, b) => (b.season_label || '').localeCompare(a.season_label || ''));
  if (recent.length && !newEntry.commodity) {
    newEntry.commodity = recent[0].commodity;
  }

  // After re-render, open the cell popover so user can fill in commodity etc.
  const el = document.getElementById('agro-tab-cropplan');
  setTimeout(() => {
    const newTd = el?.querySelector(`td.cp-matrix-cell[data-id="${newEntry.id}"][data-field="planned_ha"]`);
    if (newTd) _openCellPopover(newTd, newEntry);
  }, 60);
}

function openAddPaddockModal(allSeasons, currentSeason) {
  const seasonOpts = allSeasons.map(s =>
    `<option value="${esc(s)}"${s === currentSeason ? ' selected' : ''}>${esc(s)}</option>`
  ).join('');
  const paddockOpts = allPaddocks.length
    ? `<select class="form-select" id="ap-paddock"><option value="">— Select paddock —</option>` +
      allPaddocks.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('') + `</select>`
    : `<input class="form-input" id="ap-paddock" placeholder="Paddock name">`;

  openModal({
    title: 'Add paddock to plan',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Paddock *</label>
          ${paddockOpts}
        </div>
        <div class="form-group">
          <label class="form-label">Sub-block</label>
          <input class="form-input" id="ap-subblock" placeholder="optional">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Season *</label>
          <select class="form-select" id="ap-season">
            ${seasonOpts}
            <option value="_new">+ New season…</option>
          </select>
        </div>
        <div class="form-group" id="ap-new-ssn-wrap" style="display:none">
          <label class="form-label">Season label</label>
          <input class="form-input" id="ap-new-ssn" placeholder="e.g. Summer 2026-27">
        </div>
        <div class="form-group">
          <label class="form-label">Crop type</label>
          <select class="form-select" id="ap-commodity">
            <option value="">—</option>
            ${_planCropTypes().map(n => `<option value="${n}">${n}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Planned ha</label>
          <input class="form-input" id="ap-planned" type="number" step="0.1" min="0" placeholder="ha">
        </div>
        <div class="form-group">
          <label class="form-label">Planted ha</label>
          <input class="form-input" id="ap-planted" type="number" step="0.1" min="0" placeholder="ha">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="ap-status">
            ${CP_STATUSES.map(s => `<option value="${s}"${s === 'intent' ? ' selected' : ''}>${CP_STATUS_LABELS[s]}</option>`).join('')}
          </select>
        </div>
      </div>`,
    confirmLabel: 'Add to plan',
    wide: true,
    onMounted: overlay => {
      overlay.querySelector('#ap-season')?.addEventListener('change', function () {
        overlay.querySelector('#ap-new-ssn-wrap').style.display = this.value === '_new' ? '' : 'none';
      });

      // When paddock changes, pre-fill crop type from most recent plan entry + area from paddocks table
      const paddockEl = overlay.querySelector('#ap-paddock');
      const prefill = (name) => {
        if (!name) return;
        // Area from paddocks table
        const pd = allPaddocks.find(p => p.name === name);
        if (pd?.area_ha != null) {
          const plannedEl = overlay.querySelector('#ap-planned');
          if (plannedEl && !plannedEl.value) plannedEl.value = pd.area_ha;
        }
        // Crop type from most recent plan entry for this paddock
        const recent = allCropPlan
          .filter(e => e.paddock_name === name && e.commodity)
          .sort((a, b) => (b.season_label || '').localeCompare(a.season_label || ''));
        if (recent.length) {
          const cropEl = overlay.querySelector('#ap-commodity');
          if (cropEl && !cropEl.value) cropEl.value = recent[0].commodity;
        }
      };
      paddockEl?.addEventListener('change', e => prefill(e.target.value?.trim()));
    },
    onConfirm: async () => {
      const farm    = getActiveFarm();
      const farmId  = farm?.id || farm;
      const paddock = document.getElementById('ap-paddock')?.value?.trim();
      let season    = document.getElementById('ap-season')?.value;
      if (season === '_new') season = document.getElementById('ap-new-ssn')?.value?.trim();
      if (!paddock) throw new Error('Paddock required');
      if (!season)  throw new Error('Season required');

      await dbInsert('crop_plan_entries', {
        farm_id:      farmId,
        paddock_name: paddock,
        sub_block:    document.getElementById('ap-subblock')?.value?.trim() || null,
        season_label: season,
        season_type:  season.startsWith('Summer') ? 'Summer' : season.startsWith('Winter') ? 'Winter' : 'Annual',
        status:       document.getElementById('ap-status')?.value || 'intent',
        commodity:    document.getElementById('ap-commodity')?.value || null,
        planned_ha:   numOrNull(document.getElementById('ap-planned')?.value),
        planted_ha:   numOrNull(document.getElementById('ap-planted')?.value),
        updated_at:   new Date().toISOString(),
      });
      toast('Added to plan', 'success');
      await refreshAll();
    },
  });
}

// ── Bulk Assign Modal ──────────────────────────────────────────────────────
function openBulkAssignModal(allSeasons, currentSeason) {
  const farm      = getActiveFarm();
  const farmId    = farm?.id || farm;
  const cropTypes = _planCropTypes();
  const statuses  = CP_STATUSES;

  // Build paddock list from allPaddocks (with type info) + any crop plan names not in paddocks
  const paddockObjs = allPaddocks
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Extra names from crop plan that may not be in allPaddocks
  const knownNames = new Set(allPaddocks.map(p => p.name));
  const extraNames = [...new Set(allCropPlan.map(e => e.paddock_name))]
    .filter(n => n && !knownNames.has(n))
    .sort();

  if (!paddockObjs.length && !extraNames.length) {
    toast('No paddocks found — add paddocks first', 'warning');
    return;
  }

  // Unique paddock types for filter
  const paddockTypes = [...new Set(allPaddocks.map(p => p.type).filter(Boolean))].sort();

  const seasonOpts = allSeasons.map(s =>
    `<option value="${esc(s)}"${s === currentSeason ? ' selected' : ''}>${esc(s)}</option>`
  ).join('');

  const cropOpts = cropTypes.map(c =>
    `<option value="${esc(c)}">${esc(c)}</option>`
  ).join('');

  const statusOpts = statuses.map(s =>
    `<option value="${esc(s)}"${s === 'intent' ? ' selected' : ''}>${esc(CP_STATUS_LABELS[s])}</option>`
  ).join('');

  openModal({
    title: 'Bulk assign crop type',
    wide: true,
    confirmLabel: 'Apply',
    bodyHTML: `
      <p style="font-size:var(--text-sm);color:var(--hint);margin-bottom:16px">
        Select paddocks, choose a crop type and season, then apply. Existing entries for the selected season will be overwritten.
      </p>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
        <div>
          <label class="form-label">Crop type</label>
          <select class="form-select" id="ba-crop">${cropOpts}</select>
        </div>
        <div>
          <label class="form-label">Season</label>
          <select class="form-select" id="ba-season">${seasonOpts}</select>
        </div>
        <div>
          <label class="form-label">Status</label>
          <select class="form-select" id="ba-status">${statusOpts}</select>
        </div>
      </div>

      ${paddockTypes.length ? `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--hint);width:72px;flex-shrink:0">Type:</span>
        ${paddockTypes.map(t => {
          const c = PADDOCK_TYPE_COLORS[t] || { bg: 'var(--surface)', text: 'var(--hint)', dot: 'var(--border)' };
          return `<button type="button" class="cp-type-chip ba-type-chip" data-type="${esc(t)}"
            onmouseover="if(!this.classList.contains('cp-type-chip--active')){this.style.background='${c.bg}';this.style.borderColor='${c.dot}';this.style.color='${c.text}'}"
            onmouseout="if(!this.classList.contains('cp-type-chip--active')){this.style.background='';this.style.borderColor='';this.style.color=''}"
          ><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${c.dot};margin-right:5px;flex-shrink:0"></span>${esc(t)}</button>`;
        }).join('')}
      </div>` : ''}
      <div style="display:flex;align-items:center;gap:0;margin-bottom:6px">
        <label class="form-label" style="margin:0">Select paddocks</label>
        <button type="button" id="ba-select-all" style="margin-left:12px;font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline">Select all</button>
        <button type="button" id="ba-select-none" style="margin-left:8px;font-size:11px;color:var(--hint);background:none;border:none;cursor:pointer;padding:0;text-decoration:underline">None</button>
      </div>
      <div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:10px 12px" id="ba-paddock-list">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px" id="ba-paddock-grid">
          ${[...paddockObjs.map(p => ({ name: p.name, type: p.type || '', ha: p.area_ha ?? null })), ...extraNames.map(n => ({ name: n, type: '', ha: null }))]
            .map(p => {
              const haStr = p.ha != null ? ` · ${parseFloat(p.ha).toLocaleString('en-AU', { maximumFractionDigits: 1 })} ha` : '';
              const typeStr = p.type ? ` (${esc(p.type)})` : '';
              return `<label class="ba-paddock-row" data-type="${esc(p.type)}" style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;padding:3px 0">
              <input type="checkbox" class="ba-paddock-check" value="${esc(p.name)}">
              <span>${esc(p.name)}${typeStr ? `<span style="font-size:10px;color:var(--hint)">${typeStr}</span>` : ''}<span style="font-size:10px;color:var(--hint)">${haStr}</span></span>
            </label>`;
            }).join('')}
        </div>
      </div>
      <div id="ba-result" style="margin-top:10px;font-size:var(--text-sm);color:var(--hint)"></div>
    `,
    onMounted: (overlay) => {
      function getVisibleRows() {
        return [...overlay.querySelectorAll('.ba-paddock-row')].filter(r => r.style.display !== 'none');
      }
      overlay.querySelector('#ba-select-all')?.addEventListener('click', () => {
        getVisibleRows().forEach(row => {
          const cb = row.querySelector('.ba-paddock-check');
          if (cb) cb.checked = true;
        });
      });
      overlay.querySelector('#ba-select-none')?.addEventListener('click', () => {
        getVisibleRows().forEach(row => {
          const cb = row.querySelector('.ba-paddock-check');
          if (cb) cb.checked = false;
        });
      });
      // Multi-select type chips — toggle active state, filter paddock rows
      const activeTypes = new Set();
      overlay.querySelectorAll('.ba-type-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const t = chip.dataset.type;
          const c = PADDOCK_TYPE_COLORS[t] || { bg: 'var(--surface)', text: 'var(--hint)', dot: 'var(--border)' };
          if (activeTypes.has(t)) {
            activeTypes.delete(t);
            chip.classList.remove('cp-type-chip--active');
            chip.style.background = '';
            chip.style.borderColor = '';
            chip.style.color = '';
          } else {
            activeTypes.add(t);
            chip.classList.add('cp-type-chip--active');
            chip.style.background = c.bg;
            chip.style.borderColor = c.dot;
            chip.style.color = c.text;
          }
          // Show/hide paddock rows; uncheck hidden ones
          overlay.querySelectorAll('.ba-paddock-row').forEach(row => {
            const hide = activeTypes.size > 0 && !activeTypes.has(row.dataset.type);
            row.style.display = hide ? 'none' : '';
            if (hide) {
              const cb = row.querySelector('.ba-paddock-check');
              if (cb) cb.checked = false;
            }
          });
        });
      });
    },
    onConfirm: async (overlay) => {
      const crop    = overlay.querySelector('#ba-crop')?.value;
      const season  = overlay.querySelector('#ba-season')?.value;
      const status  = overlay.querySelector('#ba-status')?.value;
      const checked = [...overlay.querySelectorAll('.ba-paddock-check:checked')].map(el => el.value);
      const result  = overlay.querySelector('#ba-result');

      if (!crop)           { result.style.color='var(--red)'; result.textContent='Please select a crop type.'; throw new Error(''); }
      if (!season)         { result.style.color='var(--red)'; result.textContent='Please select a season.'; throw new Error(''); }
      if (!checked.length) { result.style.color='var(--red)'; result.textContent='Please select at least one paddock.'; throw new Error(''); }

      // Bulk assign always overwrites — it's a planning tool, not a planting record.
      // For paddocks that already have an entry for this season, upsert updates them.
      // For paddocks with no entry, upsert creates one.
      const rows = checked.map(name => {
        const pd = allPaddocks.find(p => p.name === name);
        const ha = pd?.area_ha != null ? parseFloat(pd.area_ha) : null;
        const row = {
          farm_id:      farmId,
          paddock_name: name,
          sub_block:    null,
          season_label: season,
          commodity:    crop,
          status,
        };
        // Only include planned_ha when the paddock has an area — avoids
        // overwriting an existing planned_ha with null on merge-duplicates.
        if (ha != null && !isNaN(ha)) row.planned_ha = ha;
        return row;
      });

      const failed = [];
      for (const row of rows) {
        try {
          // Upsert: creates new entry or updates existing one for this paddock+season
          await dbUpsert('crop_plan_entries', row, 'farm_id,paddock_name,season_label,sub_block');
        } catch (err) {
          console.error('[CFM] Bulk assign row failed:', row.paddock_name, err.message || err);
          failed.push(row.paddock_name);
        }
      }

      if (failed.length === rows.length) {
        result.style.color = 'var(--red)';
        result.textContent = `All saves failed — check browser console for details.`;
        throw new Error('All rows failed');
      }

      if (failed.length) {
        await refreshAll();
        toast(`${rows.length - failed.length} assigned · ${failed.length} failed: ${failed.join(', ')}`, 'warning', 6000);
        return;
      }

      toast(`${rows.length} paddock${rows.length > 1 ? 's' : ''} assigned`, 'success');
      refreshAll();
    },
  });
}

function openPlanSeasonModal(allSeasons, currentSeason) {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;

  // Build copy-from options (existing seasons that have data)
  const copyFromOpts = allSeasons.map(s =>
    `<option value="${esc(s)}">${esc(s)}</option>`
  ).join('');

  // Guess current year range for default
  const now = new Date();
  const yr1 = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  const defaultYearRange = `${yr1}-${String(yr1 + 1).slice(2)}`;

  openModal({
    title: 'Plan a season',
    wide: true,
    bodyHTML: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="form-group">
          <label class="form-label">Season type *</label>
          <select class="form-select" id="ps-type">
            <option value="Summer">Summer</option>
            <option value="Annual">Annual</option>
            <option value="Winter">Winter</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Year *</label>
          <input class="form-input" id="ps-year" placeholder="e.g. ${defaultYearRange}" value="${defaultYearRange}"
            style="font-family:'DM Mono',monospace">
        </div>
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label class="form-label" style="color:var(--hint);font-size:0.78rem">Season label (auto-generated)</label>
        <div id="ps-label-preview" style="font-weight:600;font-size:0.95rem;color:var(--blue);padding:6px 10px;background:color-mix(in srgb,var(--blue) 8%,var(--surface));border-radius:6px;border:1px solid color-mix(in srgb,var(--blue) 20%,var(--border))">
          Summer ${defaultYearRange}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Start from</label>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:6px">
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
            <input type="radio" name="ps-source" value="paddocks" checked style="margin-top:3px">
            <div>
              <div style="font-weight:600;font-size:0.88rem">Base paddock list</div>
              <div style="font-size:0.78rem;color:var(--hint)">
                One blank row per paddock (${allPaddocks.length} paddocks) — commodity and ha to be filled in
              </div>
            </div>
          </label>
          ${allSeasons.length ? `
          <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
            <input type="radio" name="ps-source" value="copy" style="margin-top:3px">
            <div>
              <div style="font-weight:600;font-size:0.88rem">Copy from previous season</div>
              <div style="font-size:0.78rem;color:var(--hint)">Copies paddock, sub-block, commodity, crop type and planned ha — resets planted ha and status to Intent</div>
              <select class="form-select" id="ps-copy-from" style="margin-top:8px;max-width:260px" disabled>
                ${copyFromOpts}
              </select>
            </div>
          </label>` : ''}
        </div>
      </div>`,
    confirmLabel: 'Create season plan',
    onMounted: overlay => {
      // Live-update the label preview
      const updatePreview = () => {
        const type = overlay.querySelector('#ps-type')?.value || 'Summer';
        const year = overlay.querySelector('#ps-year')?.value?.trim() || '';
        const preview = overlay.querySelector('#ps-label-preview');
        if (preview) preview.textContent = year ? `${type} ${year}` : `${type} …`;
      };
      overlay.querySelector('#ps-type')?.addEventListener('change', updatePreview);
      overlay.querySelector('#ps-year')?.addEventListener('input', updatePreview);

      // Enable/disable the copy-from dropdown based on radio
      overlay.querySelectorAll('input[name="ps-source"]').forEach(radio => {
        radio.addEventListener('change', () => {
          if (overlay.querySelector('#ps-copy-from'))
            overlay.querySelector('#ps-copy-from').disabled =
              overlay.querySelector('input[name="ps-source"]:checked')?.value !== 'copy';
        });
      });
    },
    onConfirm: async () => {
      const seasonType = document.getElementById('ps-type')?.value || 'Summer';
      const year       = document.getElementById('ps-year')?.value?.trim();
      if (!year) throw new Error('Year is required (e.g. 2026-27)');
      const label = `${seasonType} ${year}`;

      // Check season doesn't already exist
      const existing = allCropPlan.filter(c => c.season_label === label);
      if (existing.length) throw new Error(`Season "${label}" already has ${existing.length} entries — delete them first or choose a different label`);

      const copyFrom = document.getElementById('ps-copy-from')?.value;
      const source   = document.querySelector('input[name="ps-source"]:checked')?.value || 'paddocks';

      let rows = [];

      if (source === 'copy' && copyFrom) {
        // Copy from an existing season
        const srcEntries = allCropPlan.filter(c => c.season_label === copyFrom);
        if (!srcEntries.length) throw new Error(`No entries found for ${copyFrom}`);
        rows = srcEntries.map(e => ({
          farm_id:      farmId,
          paddock_name: e.paddock_name,
          sub_block:    e.sub_block || null,
          season_label: label,
          season_type:  seasonType,
          status:       'intent',
          commodity:    e.commodity || null,
          variety:      e.variety || null,
          planned_ha:   e.planned_ha || null,
          planted_ha:   null,
          area_loss_ha: null,
          wet_date:     null,
          notes:        null,
          updated_at:   new Date().toISOString(),
        }));
      } else {
        // Base paddock list
        if (!allPaddocks.length) throw new Error('No paddocks found — add paddocks in the Paddocks tab first');
        rows = allPaddocks.map(p => ({
          farm_id:      farmId,
          paddock_name: p.name,
          sub_block:    null,
          season_label: label,
          season_type:  seasonType,
          status:       'intent',
          commodity:    null,
          variety:      null,
          planned_ha:   p.area_ha || null,
          planted_ha:   null,
          area_loss_ha: null,
          wet_date:     null,
          notes:        null,
          updated_at:   new Date().toISOString(),
        }));
      }

      // Bulk insert
      await dbInsert('crop_plan_entries', rows);
      toast(`${rows.length} paddocks added to ${label}`, 'success');
      await refreshAll();
    },
  });
}

function _startEdit(td) {
  const entryId = td.dataset.id;
  const field   = td.dataset.field;
  const type    = td.dataset.type;
  const entry   = allCropPlan.find(c => c.id === entryId);
  if (!entry) return;

  const originalValue = entry[field];
  _cpEditCell = { td, entryId, field, originalValue };

  td.style.background = 'color-mix(in srgb, var(--blue) 8%, var(--bg))';
  td.style.outline = '2px solid var(--blue)';
  td.style.outlineOffset = '-2px';

  let input;

  if (type === 'select') {
    const col = CP_COLUMNS.find(c => c.key === field);
    const opts = col.options ? col.options() : [];
    input = document.createElement('select');
    input.className = 'form-select';
    input.style.cssText = 'min-width:90px;padding:3px 6px;font-size:0.82rem;height:auto';
    // Allow blank for nullable fields
    input.innerHTML = `<option value="">—</option>` +
      opts.map(o => {
        const val = o;
        const lbl = col.labelMap ? (col.labelMap[o] || o) : o;
        return `<option value="${esc(val)}"${originalValue === val ? ' selected' : ''}>${esc(lbl)}</option>`;
      }).join('');
    // For status: save immediately on change (feels natural for a dropdown)
    input.addEventListener('change', () => _commitEdit(_cpEditCell));
  } else if (type === 'date') {
    input = document.createElement('input');
    input.type = 'date';
    input.className = 'form-input';
    input.style.cssText = 'min-width:130px;padding:3px 6px;font-size:0.82rem;height:auto';
    input.value = originalValue || '';
  } else if (type === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    input.step = '0.1';
    input.min = '0';
    input.className = 'form-input';
    input.style.cssText = 'min-width:70px;text-align:right;padding:3px 6px;font-size:0.82rem;height:auto;font-family:\'DM Mono\',monospace';
    input.value = originalValue != null ? originalValue : '';
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-input';
    input.style.cssText = 'min-width:100px;padding:3px 6px;font-size:0.82rem;height:auto';
    input.value = originalValue || '';
  }

  // Keyboard handling
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      _commitEdit(_cpEditCell);
      if (e.key === 'Tab') {
        // Move to next editable cell in the row (works for both sheet and matrix)
        const row   = td.closest('tr');
        const cells = [...row.querySelectorAll('td.cp-cell, td.cp-matrix-cell:not(.cp-matrix-cell--empty)')];
        const idx   = cells.indexOf(td);
        const next  = e.shiftKey ? cells[idx - 1] : cells[idx + 1];
        if (next) setTimeout(() => _startEdit(next), 10);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      _cancelEdit(_cpEditCell);
    }
  });

  input.addEventListener('blur', () => {
    // Small delay so Tab/Enter handlers run first
    setTimeout(() => {
      if (_cpEditCell?.td === td) _commitEdit(_cpEditCell);
    }, 120);
  });

  td.innerHTML = '';
  td.appendChild(input);
  input.focus();
  if (input.select) input.select();
}

async function _commitEdit(editState) {
  if (!editState || _cpSaving) return;
  const { td, entryId, field, originalValue } = editState;
  _cpEditCell = null;

  // Reset cell style
  td.style.background = '';
  td.style.outline = '';

  const input = td.querySelector('input, select');
  if (!input) return;

  const rawVal = input.value.trim();
  let newValue;

  const col = CP_COLUMNS.find(c => c.key === field);
  if (col?.type === 'number') {
    newValue = rawVal === '' ? null : parseFloat(rawVal);
    if (rawVal !== '' && isNaN(newValue)) {
      toast('Invalid number', 'error');
      newValue = originalValue;
    }
  } else if (col?.type === 'date') {
    newValue = rawVal || null;
  } else {
    newValue = rawVal || null;
  }

  // Re-render cell content (even if unchanged, to remove input element)
  const entry = allCropPlan.find(c => c.id === entryId);
  if (entry) entry[field] = newValue; // optimistic update

  _rerenderCell(td, field, newValue, entry);

  if (newValue === originalValue || (newValue == null && originalValue == null)) return;

  // Persist to Supabase
  _cpSaving = true;
  try {
    await dbUpdate('crop_plan_entries', entryId, {
      [field]: newValue,
      updated_at: new Date().toISOString(),
    });
    // Update allCropPlan in memory (already done optimistically above)
    // Rerender active_ha cell if ha field changed
    if (['planted_ha', 'planned_ha', 'area_loss_ha'].includes(field)) {
      const row       = td.closest('tr');
      const activeCol = CP_COLUMNS.findIndex(c => c.key === '_active_ha');
      if (row && activeCol >= 0) {
        const cells    = row.querySelectorAll('td');
        const activeTd = cells[activeCol];
        if (activeTd) {
          const updEntry = allCropPlan.find(c => c.id === entryId);
          const aHa = Math.max(0,
            (parseFloat(updEntry?.planted_ha || updEntry?.planned_ha) || 0) -
            (parseFloat(updEntry?.area_loss_ha) || 0)
          );
          activeTd.innerHTML = aHa > 0
            ? `<span style="font-family:'DM Mono',monospace;font-weight:600">${aHa.toFixed(1)}</span>`
            : '<span style="color:var(--hint)">—</span>';
        }
      }
      // Update stats bar
      _refreshCpStats();
    }
  } catch (err) {
    toast('Save failed — ' + (err.message || err), 'error');
    if (entry) entry[field] = originalValue; // revert
    _rerenderCell(td, field, originalValue, entry);
  } finally {
    _cpSaving = false;
  }
}

function _cancelEdit(editState) {
  if (!editState) return;
  const { td, field, originalValue, entryId } = editState;
  _cpEditCell = null;
  td.style.background = '';
  td.style.outline = '';
  const entry = allCropPlan.find(c => c.id === entryId);
  _rerenderCell(td, field, originalValue, entry);
}

function _rerenderCell(td, field, value, entry) {
  const col = CP_COLUMNS.find(c => c.key === field);
  if (!col) return;

  const isSubBlock = entry?.sub_block != null;

  if (col.type === 'number') {
    const n = parseFloat(value);
    const color = col.red && n > 0 ? 'color:var(--red)' : '';
    td.innerHTML = !isNaN(n)
      ? `<span style="font-family:'DM Mono',monospace;${color}">${n.toFixed(1)}</span>`
      : '<span style="color:var(--hint)">—</span>';
  } else if (col.type === 'select' && col.badgeMap) {
    const cls = col.badgeMap[value] || 'badge-secondary';
    const lbl = col.labelMap ? (col.labelMap[value] || value || '—') : (value || '—');
    td.innerHTML = `<span class="badge ${cls}">${esc(lbl)}</span>`;
  } else if (col.type === 'date') {
    td.innerHTML = value ? `<span>${formatDate(value)}</span>` : '<span style="color:var(--hint)">—</span>';
  } else {
    const style = `font-weight:${col.bold && !isSubBlock ? '600' : '400'};${col.hint ? 'color:var(--hint);font-size:0.8rem' : ''}`;
    td.innerHTML = value
      ? `<span style="${style}">${esc(value)}</span>`
      : '<span style="color:var(--hint)">—</span>';
  }
}

function _refreshCpStats() {
  const el = document.getElementById('agro-tab-cropplan');
  if (!el) return;
  // Matrix view has no cpSeason selector — skip stats refresh (totals update via refreshAll)
  if (!el.dataset.cpSeason) return;
  const activeCPSeason = el.dataset.cpSeason;
  const topRows = allCropPlan.filter(c => c.season_label === activeCPSeason && !c.sub_block);
  const tots = {
    planned: topRows.reduce((s, c) => s + (parseFloat(c.planned_ha) || 0), 0),
    planted: topRows.filter(c => c.planted_ha).reduce((s, c) => s + (parseFloat(c.planted_ha) || 0), 0),
    loss:    topRows.filter(c => c.area_loss_ha).reduce((s, c) => s + (parseFloat(c.area_loss_ha) || 0), 0),
    active:  topRows.reduce((s, c) => {
      return s + Math.max(0, (parseFloat(c.planted_ha || c.planned_ha) || 0) - (parseFloat(c.area_loss_ha) || 0));
    }, 0),
  };
  const cards = el.querySelectorAll('.stat-row .stat-card');
  if (cards.length >= 5) {
    cards[0].querySelector('.stat-value').textContent = topRows.length || '—';
    cards[1].querySelector('.stat-value').textContent = tots.planned > 0 ? tots.planned.toFixed(1) : '—';
    cards[2].querySelector('.stat-value').textContent = tots.planted > 0 ? tots.planted.toFixed(1) : '—';
    cards[3].querySelector('.stat-value').textContent = tots.loss > 0 ? tots.loss.toFixed(1) : '—';
    cards[4].querySelector('.stat-value').textContent = tots.active > 0 ? tots.active.toFixed(1) : '—';
  }
}

async function addBlankRow(seasonLabel) {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;

  const [newRow] = await dbInsert('crop_plan_entries', {
    farm_id:      farmId,
    paddock_name: 'New paddock',
    season_label: seasonLabel,
    season_type:  seasonLabel.startsWith('Summer') ? 'Summer' : seasonLabel.startsWith('Winter') ? 'Winter' : 'Annual',
    status:       'intent',
    commodity:    'Cotton',
    updated_at:   new Date().toISOString(),
  });

  if (!newRow) { toast('Failed to add row', 'error'); return; }
  toast('Row added — click to edit', 'success');
  await refreshAll();

  // Scroll to and open the paddock_name cell of the new row
  const el = document.getElementById('agro-tab-cropplan');
  setTimeout(() => {
    const newTr   = el?.querySelector(`tr[data-id="${newRow.id}"]`);
    const firstTd = newTr?.querySelector('td.cp-cell');
    if (firstTd) {
      newTr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      _startEdit(firstTd);
    }
  }, 60);
}

async function loadActuals() {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;
  if (!farmId) { toast('No farm selected', 'error'); return; }

  // Check which seasons aren't already loaded
  const existingSeasons = new Set(allCropPlan.map(c => c.season_label));
  const toInsert = BB_2526_SEED.filter(r => !existingSeasons.has(r.season_label));

  if (toInsert.length === 0) {
    toast('2025-26 actuals already loaded', 'info');
    return;
  }

  // Show confirmation
  const summerCount = toInsert.filter(r => r.season_label === 'Summer 2025-26').length;
  const annualCount = toInsert.filter(r => r.season_label === 'Annual 2025-26').length;
  const msg = [
    summerCount ? `${summerCount} cotton paddocks (Summer 2025-26)` : '',
    annualCount ? `${annualCount} hay/pasture paddocks (Annual 2025-26)` : '',
  ].filter(Boolean).join(' + ');

  if (!confirm(`Load Blackbull 2025-26 actuals?\n${msg}\n\nAll will be marked as harvested/growing as per the harvest summary.`)) return;

  toast('Loading actuals…', 'info');

  try {
    // Insert in batches of 10 to avoid payload limits
    const rows = toInsert.map(r => ({
      farm_id:      farmId,
      paddock_name: r.paddock_name,
      sub_block:    r.sub_block || null,
      season_label: r.season_label,
      season_type:  r.season_type,
      status:       r.status,
      commodity:    r.commodity,
      variety:      r.variety || null,
      planned_ha:   r.planned_ha ?? null,
      planted_ha:   r.planted_ha ?? null,
      area_loss_ha: r.area_loss_ha ?? null,
      notes:        r.notes || null,
      updated_at:   new Date().toISOString(),
    }));

    for (let i = 0; i < rows.length; i += 10) {
      const batch = rows.slice(i, i + 10);
      await Promise.all(batch.map(r => dbInsert('crop_plan_entries', r)));
    }

    toast(`Loaded ${rows.length} paddocks`, 'success');
    const el = document.getElementById('agro-tab-cropplan');
    if (el) el.dataset.cpSeason = 'Summer 2025-26';
    await refreshAll();
  } catch (err) {
    toast('Load failed: ' + (err.message || err), 'error');
  }
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
        <label class="form-label">Crop type *</label>
        <select class="form-select" id="cp-commodity">
          <option value="">—</option>
          ${_planCropTypes().map(n =>
            `<option value="${n}"${entry?.commodity === n ? ' selected' : ''}>${n}</option>`
          ).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Variety</label>
        <input class="form-input" id="cp-variety" placeholder="e.g. Sicot 714"
          value="${esc(entry?.variety || '')}">
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
      if (!commodity)   throw new Error('Crop type is required');

      const row = {
        farm_id:           farmId,
        paddock_name:      paddock,
        sub_block:         document.getElementById('cp-subblock')?.value?.trim() || null,
        season_label:      seasonLabel,
        season_type:       document.getElementById('cp-season-type')?.value,
        status:            document.getElementById('cp-status')?.value || 'intent',
        commodity,
        variety:           document.getElementById('cp-variety')?.value?.trim() || null,
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
