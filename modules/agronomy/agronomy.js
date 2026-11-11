// modules/agronomy/agronomy.js
// CFM Agronomy Module — Paddock-based scouting visits
// Rebuilt 2026-11-11

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason }         from '../../js/app-state.js';
import { toast, openModal, formatDate }            from '../../js/ui.js';

// ── State ──────────────────────────────────────────────────────────────────
let allReports    = [];
let allEntries    = [];
let activeTab     = 'board';
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

// ── Mount / unmount ────────────────────────────────────────────────────────
export async function mountAgronomy(container) {
  container.innerHTML = buildShell();
  bindTabNav(container);
  await refreshAll();
}

export function unmountAgronomy() {
  activePaddock = null;
  activeTab = 'board';
}

function buildShell() {
  return `
    <div class="page-header">
      <div>
        <h1>Agronomy</h1>
        <p class="page-subtitle">Paddock scouting, crop metrics &amp; visit history</p>
      </div>
      <button class="btn btn-primary" id="agro-log-visit-btn">+ Log Visit</button>
    </div>
    <nav class="tab-nav" id="agronomy-tabs">
      <button class="tab-btn active" data-tab="board">Paddock Board</button>
      <button class="tab-btn" data-tab="reports">Reports</button>
    </nav>
    <div id="agro-tab-board"></div>
    <div id="agro-tab-reports" style="display:none"></div>
    <div id="agro-paddock-detail" style="display:none"></div>
  `;
}

// ── Data ───────────────────────────────────────────────────────────────────
async function refreshAll() {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;
  const season = getActiveSeason();

  const [reports, entries] = await Promise.all([
    dbSelect('agronomy_reports',
      'farm_id=eq.' + farmId + '&season=eq.' + season + '&order=report_date.desc'),
    dbSelect('agronomy_paddock_entries',
      'farm_id=eq.' + farmId + '&order=paddock_name,created_at.desc'),
  ]);

  allReports = reports || [];
  allEntries = (entries || []).filter(e =>
    allReports.some(r => r.id === e.report_id)
  );

  // Wire log visit button once
  const btn = document.getElementById('agro-log-visit-btn');
  if (btn && !btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', openLogVisitModal);
  }

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
  document.getElementById('agro-tab-board').style.display   = tab === 'board'   ? '' : 'none';
  document.getElementById('agro-tab-reports').style.display = tab === 'reports' ? '' : 'none';
  renderActiveTab();
}

function renderActiveTab() {
  if (activeTab === 'board')   renderBoard();
  if (activeTab === 'reports') renderReports();
}

// ── BOARD VIEW ─────────────────────────────────────────────────────────────
function renderBoard() {
  const el = document.getElementById('agro-tab-board');
  if (!el) return;

  const paddockMap = buildPaddockMap();
  const paddocks   = Object.values(paddockMap);

  if (paddocks.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌱</div>
        <p>No scouting visits recorded this season.</p>
        <button class="btn btn-primary" id="agro-empty-log-btn">Log First Visit</button>
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
        ${metricPill(fmtHa(p.area_ha), 'ha')}
        ${metricPill(p.plant_est_pct != null ? p.plant_est_pct + '%' : null, 'est.')}
        ${metricPill(latestNodes, 'nodes')}
        ${metricPill(latestHeight != null ? latestHeight + 'cm' : null, 'ht')}
      </div>` : `
      <div style="display:flex;gap:12px;margin:10px 0 8px">
        ${metricPill(fmtHa(p.area_ha), 'ha')}
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
  document.getElementById('agro-tab-board').style.display   = 'none';
  document.getElementById('agro-tab-reports').style.display = 'none';
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

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <button class="btn btn-secondary btn-sm" id="agro-back-btn">← Board</button>
      <div>
        <h2 style="margin:0;font-size:1.2rem">${esc(paddockName)}</h2>
        <div style="font-size:0.82rem;color:var(--hint)">
          ${latest ? esc(latest.commodity || '') + (latest.variety ? ' · ' + esc(latest.variety) : '') + (latest.area_ha ? ' · ' + fmtHa(latest.area_ha) : '') : ''}
        </div>
      </div>
    </div>

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
    document.getElementById('agro-tab-board').style.display = '';
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

// ── REPORTS LIST ───────────────────────────────────────────────────────────
function renderReports() {
  const el = document.getElementById('agro-tab-reports');
  if (!el) return;

  el.innerHTML = `
    <div class="card">
      <div class="card-header">Scouting Reports — ${getActiveSeason()}</div>
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr>
            <th>Date</th><th>Agronomist</th><th>Company</th>
            <th>Paddocks</th><th>High priority</th><th></th>
          </tr></thead>
          <tbody>
            ${allReports.length === 0
              ? '<tr><td colspan="6" class="empty-cell">No reports this season.</td></tr>'
              : allReports.map(r => {
                  const ents    = allEntries.filter(e => e.report_id === r.id);
                  const highPri = ents.filter(e => e.priority === 'high').length;
                  return `<tr>
                    <td>${formatDate(r.report_date)}</td>
                    <td><strong>${esc(r.agronomist_name)}</strong></td>
                    <td>${esc(r.agronomist_company || '—')}</td>
                    <td>${ents.length}</td>
                    <td>${highPri ? `<span class="badge badge-danger">${highPri} high</span>` : '—'}</td>
                    <td class="row-actions">
                      <button class="btn-link danger agro-del-report-btn" data-id="${r.id}">Delete</button>
                    </td>
                  </tr>`;
                }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  el.querySelectorAll('.agro-del-report-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this entire report and all its paddock entries?')) return;
      await dbDelete('agronomy_reports', btn.dataset.id);
      toast('Report deleted', 'success');
      await refreshAll();
    });
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
      <input class="form-input agro-ep-name" placeholder="Paddock name *"
        style="max-width:180px" value="${esc(copyFrom?.paddock_name || '')}">
      <select class="form-select agro-ep-commodity" style="max-width:160px">
        ${COMMODITIES.map(c =>
          `<option value="${c}"${commodity === c ? ' selected' : ''}>${c}</option>`
        ).join('')}
      </select>
      <input class="form-input agro-ep-variety" placeholder="Variety"
        style="max-width:120px" value="${esc(copyFrom?.variety || '')}">
      <input class="form-input agro-ep-area" type="number" step="0.01" placeholder="ha"
        style="max-width:80px" value="${copyFrom?.area_ha != null ? copyFrom.area_ha : ''}">
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

  // Toggle fallow
  div.querySelector('.agro-ep-commodity')?.addEventListener('change', function () {
    div.querySelector('.agro-ep-crop-fields').style.display =
      FALLOW_COMMODITIES.has(this.value) ? 'none' : '';
  });

  div.querySelector('.agro-ep-remove')?.addEventListener('click', () => div.remove());

  div.querySelector('.agro-ep-copy-btn')?.addEventListener('click', () => {
    openCopyModal(div, list);
  });
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
            const srcVal = sourceDiv.querySelector('.agro-ep-priority:checked')?.value;
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
