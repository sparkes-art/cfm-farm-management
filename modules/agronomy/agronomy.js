// modules/agronomy/agronomy.js
// CFM Agronomy Module — Paddock-based scouting visits
// Rebuilt 2026-11-11: paddock board → paddock detail → bulk visit entry

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason }         from '../../js/app-state.js';
import { toast, openModal, formatDate }            from '../../js/ui.js';

// ── State ──────────────────────────────────────────────────────────────────
let allReports  = [];   // agronomy_reports rows
let allEntries  = [];   // agronomy_paddock_entries rows
let activeTab   = 'board';
let activePaddock = null;  // paddock name currently expanded in detail view

// ── Constants ──────────────────────────────────────────────────────────────
const COMMODITIES = [
  'Cotton IRR', 'Cotton Dry', 'Corn IRR', 'Sorghum', 'Wheat',
  'Chickpea', 'Pigeon Pea', 'Setaria Hay', 'Fallow', 'Other',
];
const SOIL_TYPES       = ['CL', 'MAP', 'Sandy Loam', 'Clay Loam', 'Heavy Clay', 'Sandy Clay Loam'];
const PRIORITY_LABELS  = { none: '✓ On track', medium: '⚠ Upcoming', high: '🔴 Action needed' };
const PRIORITY_CLASSES = { none: 'badge-success', medium: 'badge-warning', high: 'badge-danger' };
const FALLOW_COMMODITIES = ['Fallow'];

// ── Mount / unmount ────────────────────────────────────────────────────────
export async function mountAgronomy(container) {
  container.innerHTML = buildShell();
  bindTabNav(container);
  await refreshAll();
}

export function unmountAgronomy() {
  activePaddock = null;
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
    <div class="tab-nav" id="agronomy-tabs">
      <button class="tab-btn active" data-tab="board">🟩 Paddock Board</button>
      <button class="tab-btn" data-tab="reports">📋 Reports</button>
    </div>
    <div id="agro-tab-board"   class="agro-tab"></div>
    <div id="agro-tab-reports" class="agro-tab" style="display:none"></div>
    <div id="agro-paddock-detail" style="display:none"></div>
  `;
}

// ── Data ───────────────────────────────────────────────────────────────────
async function refreshAll() {
  const farm    = getActiveFarm();
  const farmId  = farm?.id || farm;
  const season  = getActiveSeason();

  const [reports, entries] = await Promise.all([
    dbSelect('agronomy_reports',
      'farm_id=eq.' + farmId + '&season=eq.' + season + '&order=report_date.desc'),
    dbSelect('agronomy_paddock_entries',
      'farm_id=eq.' + farmId + '&order=paddock_name,created_at.desc'),
  ]);

  allReports = reports || [];
  allEntries = entries || [];

  // Filter entries to only those belonging to reports in this season
  const reportIds = new Set(allReports.map(r => r.id));
  allEntries = allEntries.filter(e => reportIds.has(e.report_id));

  renderActiveTab();
  document.getElementById('agro-log-visit-btn')
    ?.addEventListener('click', openLogVisitModal);
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
// Groups paddocks by name, shows latest entry data for each

function renderBoard() {
  const el = document.getElementById('agro-tab-board');
  if (!el) return;

  // Build paddock map — latest entry per paddock name
  const paddockMap = buildPaddockMap();
  const paddocks   = Object.values(paddockMap);

  if (paddocks.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <p>No scouting entries recorded this season.</p>
        <button class="btn btn-primary" onclick="document.getElementById('agro-log-visit-btn').click()">Log First Visit</button>
      </div>`;
    return;
  }

  // Summary strip
  const cottonPaddocks = paddocks.filter(p => !p.is_fallow && p.commodity);
  const fallowPaddocks = paddocks.filter(p => p.is_fallow);
  const highPri        = paddocks.filter(p => p.priority === 'high');
  const medPri         = paddocks.filter(p => p.priority === 'medium');
  const totalHaCotton  = cottonPaddocks.reduce((s, p) => s + (p.area_ha || 0), 0);
  const totalHaFallow  = fallowPaddocks.reduce((s, p) => s + (p.area_ha || 0), 0);
  const avgEst         = avgOf(cottonPaddocks, 'plant_est_pct');
  const latestReport   = allReports[0];

  el.innerHTML = `
    <div class="agro-summary-strip">
      <div class="agro-summary-item">
        <div class="agro-summary-val">${fmtHa(totalHaCotton)}</div>
        <div class="agro-summary-lbl">Crop ha</div>
      </div>
      <div class="agro-summary-item">
        <div class="agro-summary-val">${fmtHa(totalHaFallow)}</div>
        <div class="agro-summary-lbl">Fallow ha</div>
      </div>
      <div class="agro-summary-item">
        <div class="agro-summary-val">${avgEst !== null ? avgEst.toFixed(1) + '%' : '—'}</div>
        <div class="agro-summary-lbl">Avg establishment</div>
      </div>
      <div class="agro-summary-item">
        <div class="agro-summary-val ${highPri.length ? 'text-danger' : ''}">${highPri.length}</div>
        <div class="agro-summary-lbl">High priority</div>
      </div>
      <div class="agro-summary-item">
        <div class="agro-summary-val">${medPri.length}</div>
        <div class="agro-summary-lbl">Watch</div>
      </div>
      <div class="agro-summary-item">
        <div class="agro-summary-val">${latestReport ? formatDate(latestReport.report_date) : '—'}</div>
        <div class="agro-summary-lbl">Last report</div>
      </div>
    </div>

    <div class="agro-board-section-label">Crop Paddocks</div>
    <div class="agro-board-grid" id="agro-crop-grid">
      ${cottonPaddocks.length
        ? cottonPaddocks.map(p => paddockCardHTML(p)).join('')
        : '<p class="text-muted small">No crop paddocks this season.</p>'}
    </div>

    ${fallowPaddocks.length ? `
    <div class="agro-board-section-label" style="margin-top:24px">Fallow</div>
    <div class="agro-board-grid agro-board-grid--fallow">
      ${fallowPaddocks.map(p => paddockCardHTML(p)).join('')}
    </div>` : ''}
  `;

  el.querySelectorAll('.agro-paddock-card').forEach(card => {
    card.addEventListener('click', () => openPaddockDetail(card.dataset.paddock));
  });
}

function paddockCardHTML(p) {
  const priorityClass = PRIORITY_CLASSES[p.priority] || 'badge-success';
  const priorityLabel = PRIORITY_LABELS[p.priority]  || '✓ On track';
  const latestNodes   = p.nodes_3_count ?? p.nodes_2_count ?? p.nodes_1_count;
  const latestHeight  = p.height_cm_2 ?? p.height_cm_1;
  const isFallow      = p.is_fallow;
  const entryCount    = allEntries.filter(e => e.paddock_name === p.paddock_name).length;

  return `
    <div class="agro-paddock-card${isFallow ? ' agro-paddock-card--fallow' : ''}"
         data-paddock="${esc(p.paddock_name)}">
      <div class="agro-card-top">
        <div class="agro-card-name">${esc(p.paddock_name)}</div>
        ${!isFallow ? `<span class="badge ${priorityClass}">${priorityLabel}</span>` : ''}
      </div>
      <div class="agro-card-commodity">${esc(p.commodity || '—')}</div>
      ${p.variety ? `<div class="agro-card-variety">${esc(p.variety)}</div>` : ''}

      ${!isFallow ? `
      <div class="agro-card-metrics">
        <div class="agro-card-metric">
          <span class="agro-metric-val">${p.area_ha != null ? fmtHa(p.area_ha) : '—'}</span>
          <span class="agro-metric-lbl">ha</span>
        </div>
        <div class="agro-card-metric">
          <span class="agro-metric-val">${p.plant_est_pct != null ? p.plant_est_pct.toFixed(1) + '%' : '—'}</span>
          <span class="agro-metric-lbl">est.</span>
        </div>
        <div class="agro-card-metric">
          <span class="agro-metric-val">${latestNodes != null ? latestNodes : '—'}</span>
          <span class="agro-metric-lbl">nodes</span>
        </div>
        <div class="agro-card-metric">
          <span class="agro-metric-val">${latestHeight != null ? latestHeight + 'cm' : '—'}</span>
          <span class="agro-metric-lbl">ht</span>
        </div>
      </div>
      ` : `
      <div class="agro-card-metrics">
        <div class="agro-card-metric">
          <span class="agro-metric-val">${p.area_ha != null ? fmtHa(p.area_ha) : '—'}</span>
          <span class="agro-metric-lbl">ha</span>
        </div>
      </div>
      `}

      <div class="agro-card-footer">
        <span class="agro-card-visits">${entryCount} visit${entryCount !== 1 ? 's' : ''}</span>
        <span class="agro-card-last">${p.lastReportDate ? formatDate(p.lastReportDate) : 'No visits'}</span>
      </div>
    </div>
  `;
}

// ── PADDOCK DETAIL ─────────────────────────────────────────────────────────
function openPaddockDetail(paddockName) {
  activePaddock = paddockName;
  document.getElementById('agro-tab-board').style.display   = 'none';
  document.getElementById('agro-tab-reports').style.display = 'none';
  renderPaddockDetail(paddockName);
  document.getElementById('agro-paddock-detail').style.display = '';
  document.getElementById('agro-paddock-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPaddockDetail(paddockName) {
  const el = document.getElementById('agro-paddock-detail');
  if (!el) return;

  // All entries for this paddock, sorted oldest→newest
  const entries = allEntries
    .filter(e => e.paddock_name === paddockName)
    .sort((a, b) => {
      const ra = allReports.find(r => r.id === a.report_id);
      const rb = allReports.find(r => r.id === b.report_id);
      return new Date(ra?.report_date || 0) - new Date(rb?.report_date || 0);
    });

  const latest  = entries[entries.length - 1];
  const isFallow = latest?.is_fallow || false;

  el.innerHTML = `
    <div class="agro-detail-header">
      <button class="btn btn-sm" id="agro-back-btn">← Back to board</button>
      <h2 class="agro-detail-title">${esc(paddockName)}</h2>
      <div class="agro-detail-meta">
        ${latest ? esc(latest.commodity || '') + (latest.variety ? ' · ' + esc(latest.variety) : '') : ''}
        ${latest?.area_ha ? ' · ' + fmtHa(latest.area_ha) + ' ha' : ''}
      </div>
    </div>

    ${!isFallow && entries.length >= 2 ? renderProgressCharts(entries) : ''}

    <div class="agro-detail-section-label">Visit History</div>
    <div class="agro-visit-timeline">
      ${entries.length === 0
        ? '<p class="text-muted small">No visits recorded for this paddock.</p>'
        : entries.map((e, i) => visitTimelineCard(e, i === entries.length - 1)).join('')}
    </div>
  `;

  el.querySelector('#agro-back-btn')?.addEventListener('click', () => {
    activePaddock = null;
    el.style.display = 'none';
    document.getElementById('agro-tab-board').style.display = '';
    renderBoard();
  });

  // Wire edit/delete on visit cards
  el.querySelectorAll('.agro-edit-entry-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const entry = allEntries.find(en => en.id === btn.dataset.id);
      if (entry) openEditEntryModal(entry);
    });
  });
  el.querySelectorAll('.agro-delete-entry-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Delete this visit entry?')) return;
      await dbDelete('agronomy_paddock_entries', btn.dataset.id);
      // If report has no other entries, delete report too
      const orphanReport = allReports.find(r => r.id === btn.dataset.reportId);
      if (orphanReport) {
        const remaining = allEntries.filter(en =>
          en.report_id === orphanReport.id && en.id !== btn.dataset.id);
        if (remaining.length === 0) await dbDelete('agronomy_reports', orphanReport.id);
      }
      toast('Entry deleted', 'success');
      await refreshAll();
      if (activePaddock) renderPaddockDetail(activePaddock);
    });
  });
}

function renderProgressCharts(entries) {
  // Mini inline SVG sparkline for nodes and height progression
  const nodesData  = entries.map(e => e.nodes_3_count ?? e.nodes_2_count ?? e.nodes_1_count).filter(v => v != null);
  const heightData = entries.map(e => e.height_cm_2 ?? e.height_cm_1).filter(v => v != null);
  const estData    = entries.map(e => e.plant_est_pct).filter(v => v != null);

  if (nodesData.length < 2 && heightData.length < 2) return '';

  return `
    <div class="agro-progress-strip">
      ${nodesData.length >= 2 ? `
      <div class="agro-progress-item">
        <div class="agro-progress-label">Nodes progression</div>
        ${miniSparkline(nodesData, '#6a8faf')}
        <div class="agro-progress-range">${Math.min(...nodesData)} → ${Math.max(...nodesData)}</div>
      </div>` : ''}
      ${heightData.length >= 2 ? `
      <div class="agro-progress-item">
        <div class="agro-progress-label">Height (cm)</div>
        ${miniSparkline(heightData, '#7ba88c')}
        <div class="agro-progress-range">${Math.min(...heightData)} → ${Math.max(...heightData)} cm</div>
      </div>` : ''}
      ${estData.length >= 1 ? `
      <div class="agro-progress-item">
        <div class="agro-progress-label">Establishment</div>
        ${miniSparkline(estData, '#c08020')}
        <div class="agro-progress-range">${estData[estData.length - 1].toFixed(1)}%</div>
      </div>` : ''}
    </div>
  `;
}

function miniSparkline(data, colour) {
  const w = 120, h = 36, pad = 4;
  const mn = Math.min(...data), mx = Math.max(...data);
  const range = mx - mn || 1;
  const pts = data.map((v, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * (w - pad * 2);
    const y = h - pad - ((v - mn) / range) * (h - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block">
    <polyline points="${pts.join(' ')}" fill="none" stroke="${colour}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${pts[pts.length-1].split(',')[0]}" cy="${pts[pts.length-1].split(',')[1]}"
      r="3" fill="${colour}"/>
  </svg>`;
}

function visitTimelineCard(entry, isLatest) {
  const report = allReports.find(r => r.id === entry.report_id);
  const latestNodes  = entry.nodes_3_count ?? entry.nodes_2_count ?? entry.nodes_1_count;
  const latestHeight = entry.height_cm_2 ?? entry.height_cm_1;

  return `
    <div class="agro-timeline-card${isLatest ? ' agro-timeline-card--latest' : ''}">
      <div class="agro-timeline-date">
        ${report ? formatDate(report.report_date) : '—'}
        ${isLatest ? '<span class="badge badge-primary ml-1">Latest</span>' : ''}
        <div class="agro-timeline-agronomist">${report ? esc(report.agronomist_name) : ''}</div>
      </div>
      <div class="agro-timeline-body">
        ${!entry.is_fallow ? `
        <div class="agro-timeline-metrics">
          ${metricCell('Est.', entry.plant_est_pct != null ? entry.plant_est_pct.toFixed(1) + '%' : null)}
          ${metricCell('Plants/m²', entry.plants_per_m2)}
          ${metricCell('Height', latestHeight != null ? latestHeight + ' cm' : null)}
          ${metricCell('Nodes', latestNodes)}
          ${metricCell('Yield target', entry.yield_target_t != null ? entry.yield_target_t + ' t' : null)}
        </div>

        ${entry.incrop_sprays_notes || entry.incrop_fert_notes ? `
        <div class="agro-timeline-inputs">
          ${entry.incrop_sprays_notes ? `
          <div class="agro-input-block">
            <span class="agro-input-label">🧪 Sprays</span>
            <span class="agro-input-text">${esc(entry.incrop_sprays_notes)}</span>
          </div>` : ''}
          ${entry.incrop_fert_notes ? `
          <div class="agro-input-block">
            <span class="agro-input-label">💧 Fert/Irr</span>
            <span class="agro-input-text">${esc(entry.incrop_fert_notes)}</span>
          </div>` : ''}
        </div>` : ''}

        ${entry.comments ? `
        <div class="agro-timeline-comments">${esc(entry.comments)}</div>` : ''}

        ${entry.upcoming_jobs ? `
        <div class="agro-timeline-upcoming">
          <span class="badge ${PRIORITY_CLASSES[entry.priority] || 'badge-success'}">Upcoming</span>
          ${esc(entry.upcoming_jobs)}
        </div>` : ''}

        ${entry.n_deficit != null || entry.seasonal_urea_req != null ? `
        <div class="agro-timeline-n">
          <span class="agro-n-label">N deficit</span>
          <span class="agro-n-val">${entry.n_deficit != null ? entry.n_deficit + ' kg/ha' : '—'}</span>
          <span class="agro-n-label" style="margin-left:12px">Seasonal urea req</span>
          <span class="agro-n-val">${entry.seasonal_urea_req != null ? entry.seasonal_urea_req + ' kg/ha' : '—'}</span>
        </div>` : ''}
        ` : `<div class="text-muted small">Fallow paddock</div>`}
      </div>
      <div class="agro-timeline-actions">
        <button class="btn-link agro-edit-entry-btn" data-id="${entry.id}">Edit</button>
        <button class="btn-link danger agro-delete-entry-btn"
          data-id="${entry.id}" data-report-id="${entry.report_id}">Del</button>
      </div>
    </div>
  `;
}

function metricCell(label, value) {
  if (value == null) return '';
  return `<div class="agro-tl-metric"><span class="agro-tl-val">${value}</span><span class="agro-tl-lbl">${label}</span></div>`;
}

// ── REPORTS LIST ───────────────────────────────────────────────────────────
function renderReports() {
  const el = document.getElementById('agro-tab-reports');
  if (!el) return;

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span>Scouting Reports — ${getActiveSeason()}</span>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead><tr>
            <th>Date</th><th>Agronomist</th><th>Company</th>
            <th>Paddocks covered</th><th>High priority</th><th></th>
          </tr></thead>
          <tbody>
            ${allReports.length === 0
              ? '<tr><td colspan="6" class="empty-cell">No reports this season.</td></tr>'
              : allReports.map(r => reportRowHTML(r)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  el.querySelectorAll('.agro-delete-report-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this report and all its paddock entries?')) return;
      await dbDelete('agronomy_reports', btn.dataset.id);
      toast('Report deleted', 'success');
      await refreshAll();
    });
  });

  el.querySelectorAll('.agro-view-report-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab('board');
      // Could jump to a specific paddock — for now just goes to board
    });
  });
}

function reportRowHTML(r) {
  const entries  = allEntries.filter(e => e.report_id === r.id);
  const highPri  = entries.filter(e => e.priority === 'high').length;
  return `<tr>
    <td>${formatDate(r.report_date)}</td>
    <td><strong>${esc(r.agronomist_name)}</strong></td>
    <td>${esc(r.agronomist_company || '—')}</td>
    <td>${entries.length} paddock${entries.length !== 1 ? 's' : ''}</td>
    <td>${highPri ? '<span class="badge badge-danger">' + highPri + ' high</span>' : '—'}</td>
    <td class="row-actions">
      <button class="btn-link agro-view-report-btn" data-id="${r.id}">View</button>
      <button class="btn-link danger agro-delete-report-btn" data-id="${r.id}">Del</button>
    </td>
  </tr>`;
}

// ── LOG VISIT MODAL ────────────────────────────────────────────────────────
// Step 1: pick date + agronomist
// Step 2: paddock entry table with copy-across functionality

function openLogVisitModal() {
  const today = todayStr();

  const bodyHTML = `
    <div class="form-grid form-grid-2">
      <div class="form-group">
        <label>Visit Date *</label>
        <input class="form-control" id="lv-date" type="date" value="${today}">
      </div>
      <div class="form-group">
        <label>Type</label>
        <select class="form-control" id="lv-type">
          <option value="external">External agronomist</option>
          <option value="internal">Internal</option>
        </select>
      </div>
      <div class="form-group">
        <label>Agronomist Name *</label>
        <input class="form-control" id="lv-agronomist" placeholder="e.g. John Smith">
      </div>
      <div class="form-group">
        <label>Company</label>
        <input class="form-control" id="lv-company" placeholder="e.g. Delta Agri">
      </div>
    </div>
    <div style="margin-top:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <strong style="font-size:0.85rem">Paddock Entries</strong>
        <button type="button" class="btn btn-sm" id="lv-add-paddock-btn">+ Add Paddock</button>
      </div>
      <div id="lv-paddock-list"></div>
    </div>
  `;

  openModal({
    title: 'Log Scouting Visit',
    bodyHTML,
    confirmLabel: 'Save Visit',
    wide: true,
    onOpen: () => {
      document.getElementById('lv-add-paddock-btn')
        ?.addEventListener('click', () => addPaddockEntryRow());
      addPaddockEntryRow(); // start with one row
    },
    onConfirm: async () => {
      const farmId  = (() => { const f = getActiveFarm(); return f?.id || f; })();
      const season  = getActiveSeason();
      const date    = document.getElementById('lv-date')?.value;
      const name    = document.getElementById('lv-agronomist')?.value?.trim();
      const company = document.getElementById('lv-company')?.value?.trim() || null;
      const type    = document.getElementById('lv-type')?.value;

      if (!date || !name) throw new Error('Date and agronomist name are required');

      const rows = collectPaddockRows();
      if (rows.length === 0) throw new Error('Add at least one paddock entry');
      rows.forEach(r => { if (!r.paddock_name) throw new Error('Each paddock entry needs a paddock name'); });

      // Create report
      const [report] = await dbInsert('agronomy_reports', {
        farm_id: farmId, season, report_date: date,
        agronomist_name: name, agronomist_company: company,
        agronomist_type: type, updated_at: new Date().toISOString(),
      });

      // Insert all paddock entries
      await Promise.all(rows.map(row =>
        dbInsert('agronomy_paddock_entries', {
          ...row,
          report_id: report.id,
          farm_id:   farmId,
          updated_at: new Date().toISOString(),
        })
      ));

      toast('Visit saved — ' + rows.length + ' paddock' + (rows.length > 1 ? 's' : ''), 'success');
      await refreshAll();
      if (activePaddock) renderPaddockDetail(activePaddock);
    },
  });
}

let paddockRowCount = 0;
function addPaddockEntryRow(copyFrom = null) {
  paddockRowCount++;
  const id = 'pr-' + paddockRowCount;
  const list = document.getElementById('lv-paddock-list');
  if (!list) return;

  const div = document.createElement('div');
  div.className = 'agro-entry-paddock-block';
  div.id = id;

  // Determine if commodity makes it fallow
  const isFallow = copyFrom?.is_fallow || false;

  div.innerHTML = `
    <div class="agro-entry-paddock-header">
      <input class="form-control agro-ep-name" placeholder="Paddock name *"
        value="${esc(copyFrom?.paddock_name || '')}">
      <select class="form-control agro-ep-commodity" style="max-width:160px">
        ${COMMODITIES.map(c =>
          `<option value="${c}"${(copyFrom?.commodity || 'Cotton IRR') === c ? ' selected' : ''}>${c}</option>`
        ).join('')}
      </select>
      <input class="form-control agro-ep-variety" placeholder="Variety"
        style="max-width:120px" value="${esc(copyFrom?.variety || '')}">
      <input class="form-control agro-ep-area" type="number" step="0.01" placeholder="ha"
        style="max-width:80px" value="${copyFrom?.area_ha != null ? copyFrom.area_ha : ''}">
      <button type="button" class="btn-link danger agro-ep-remove" style="margin-left:4px">✕</button>
    </div>

    <div class="agro-entry-crop-fields" style="${isFallow ? 'display:none' : ''}">
      <div class="form-grid form-grid-3" style="margin-top:8px">
        <div class="form-group">
          <label>Seed/Wet Date</label>
          <input class="form-control agro-ep-wet-date" type="date"
            value="${copyFrom?.seed_wet_date || ''}">
        </div>
        <div class="form-group">
          <label>Yield Target (t)</label>
          <input class="form-control agro-ep-yield" type="number" step="0.1"
            placeholder="Total tonnes" value="${copyFrom?.yield_target_t != null ? copyFrom.yield_target_t : ''}">
        </div>
        <div class="form-group">
          <label>Soil Type</label>
          <select class="form-control agro-ep-soil">
            <option value="">—</option>
            ${SOIL_TYPES.map(s =>
              `<option value="${s}"${copyFrom?.soil_type === s ? ' selected' : ''}>${s}</option>`
            ).join('')}
          </select>
        </div>
      </div>

      <div class="form-grid form-grid-4" style="margin-top:0">
        <div class="form-group">
          <label>Plant Est. %</label>
          <input class="form-control agro-ep-est" type="number" step="0.1"
            placeholder="%" value="${copyFrom?.plant_est_pct != null ? copyFrom.plant_est_pct : ''}">
        </div>
        <div class="form-group">
          <label>Plants/m²</label>
          <input class="form-control agro-ep-plants" type="number" step="0.1"
            value="${copyFrom?.plants_per_m2 != null ? copyFrom.plants_per_m2 : ''}">
        </div>
        <div class="form-group">
          <label>Height (cm)</label>
          <input class="form-control agro-ep-height" type="number" step="0.5"
            value="${copyFrom?.height_cm_2 ?? copyFrom?.height_cm_1 ?? ''}">
        </div>
        <div class="form-group">
          <label>Nodes</label>
          <input class="form-control agro-ep-nodes" type="number" step="0.25"
            value="${copyFrom?.nodes_3_count ?? copyFrom?.nodes_2_count ?? copyFrom?.nodes_1_count ?? ''}">
        </div>
      </div>

      <div class="form-grid form-grid-3" style="margin-top:0">
        <div class="form-group">
          <label>N Deficit (kg/ha)</label>
          <input class="form-control agro-ep-ndeficit" type="number" step="1"
            value="${copyFrom?.n_deficit != null ? copyFrom.n_deficit : ''}">
        </div>
        <div class="form-group">
          <label>Seasonal Urea Req (kg/ha)</label>
          <input class="form-control agro-ep-urea-req" type="number" step="1"
            value="${copyFrom?.seasonal_urea_req != null ? copyFrom.seasonal_urea_req : ''}">
        </div>
        <div class="form-group">
          <label>1st In-Crop IRR Date</label>
          <input class="form-control agro-ep-irr-date" type="date"
            value="${copyFrom?.first_incrop_irr_date || ''}">
        </div>
      </div>

      <div class="form-group" style="margin-top:0">
        <label>In-Crop Sprays (products, rates, dates)</label>
        <textarea class="form-control agro-ep-sprays" rows="2"
          placeholder="e.g. 2.2L DST 180g Butroxydim 21-10-26 · 3.75L Biffo 6-11-26">${esc(copyFrom?.incrop_sprays_notes || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Fertiliser / Irrigation Notes</label>
        <textarea class="form-control agro-ep-fert" rows="2"
          placeholder="e.g. 100kg urea 22-10-26, water 75kg 6-11-26">${esc(copyFrom?.incrop_fert_notes || '')}</textarea>
      </div>
    </div>

    <div class="form-grid form-grid-2" style="margin-top:4px">
      <div class="form-group">
        <label>Comments</label>
        <textarea class="form-control agro-ep-comments" rows="2"
          placeholder="Observations from this visit">${esc(copyFrom?.comments || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Upcoming Jobs</label>
        <textarea class="form-control agro-ep-jobs" rows="2"
          placeholder="Actions required before next visit">${esc(copyFrom?.upcoming_jobs || '')}</textarea>
      </div>
    </div>
    <div class="form-group" style="margin-top:0;display:flex;align-items:center;gap:12px">
      <label style="margin:0;font-size:0.8rem">Priority:</label>
      <label class="radio-label"><input type="radio" name="pri-${id}" class="agro-ep-priority" value="none"${!copyFrom?.priority || copyFrom?.priority === 'none' ? ' checked' : ''}> On track</label>
      <label class="radio-label"><input type="radio" name="pri-${id}" class="agro-ep-priority" value="medium"${copyFrom?.priority === 'medium' ? ' checked' : ''}> Watch</label>
      <label class="radio-label"><input type="radio" name="pri-${id}" class="agro-ep-priority" value="high"${copyFrom?.priority === 'high' ? ' checked' : ''}> High priority</label>
      <button type="button" class="btn btn-sm agro-ep-copy-btn" style="margin-left:auto">
        Copy to other paddocks →
      </button>
    </div>
  `;

  list.appendChild(div);

  // Hide crop fields for fallow
  div.querySelector('.agro-ep-commodity')?.addEventListener('change', function() {
    const fallow = FALLOW_COMMODITIES.includes(this.value);
    div.querySelector('.agro-entry-crop-fields').style.display = fallow ? 'none' : '';
  });

  div.querySelector('.agro-ep-remove')?.addEventListener('click', () => div.remove());

  div.querySelector('.agro-ep-copy-btn')?.addEventListener('click', () => {
    openCopyModal(id);
  });
}

function openCopyModal(sourceId) {
  const sourceBlock = document.getElementById(sourceId);
  if (!sourceBlock) return;

  // Collect all existing paddock row blocks
  const allBlocks = [...document.querySelectorAll('.agro-entry-paddock-block')];
  const otherBlocks = allBlocks.filter(b => b.id !== sourceId);

  if (otherBlocks.length === 0) {
    toast('No other paddock rows to copy to — add more paddocks first', 'warning');
    return;
  }

  // Which fields can be copied
  const fields = [
    { key: 'sprays',   label: 'Spray records',         cls: '.agro-ep-sprays' },
    { key: 'fert',     label: 'Fert/irrigation notes',  cls: '.agro-ep-fert' },
    { key: 'height',   label: 'Height',                 cls: '.agro-ep-height' },
    { key: 'nodes',    label: 'Nodes',                  cls: '.agro-ep-nodes' },
    { key: 'ndeficit', label: 'N deficit',              cls: '.agro-ep-ndeficit' },
    { key: 'urearq',   label: 'Seasonal urea req',      cls: '.agro-ep-urea-req' },
    { key: 'irrdate',  label: 'IRR date',               cls: '.agro-ep-irr-date' },
    { key: 'jobs',     label: 'Upcoming jobs',          cls: '.agro-ep-jobs' },
    { key: 'priority', label: 'Priority',               cls: '.agro-ep-priority' },
  ];

  const bodyHTML = `
    <p class="small text-muted" style="margin-bottom:12px">
      Choose which fields to copy from <strong>${sourceBlock.querySelector('.agro-ep-name')?.value || 'this paddock'}</strong>
      to the paddocks you select below.
    </p>
    <div style="margin-bottom:14px">
      <strong style="font-size:0.8rem">Fields to copy:</strong>
      <div class="checkbox-group" style="margin-top:6px;display:flex;flex-wrap:wrap;gap:8px">
        ${fields.map(f => `
          <label class="checkbox-label">
            <input type="checkbox" class="copy-field-cb" value="${f.key}" checked> ${f.label}
          </label>`).join('')}
      </div>
    </div>
    <div>
      <strong style="font-size:0.8rem">Copy to:</strong>
      <div class="checkbox-group" style="margin-top:6px">
        ${otherBlocks.map(b => {
          const pName = b.querySelector('.agro-ep-name')?.value || b.id;
          return `<label class="checkbox-label">
            <input type="checkbox" class="copy-target-cb" value="${b.id}" checked> ${esc(pName)}
          </label>`;
        }).join('')}
      </div>
    </div>
  `;

  openModal({
    title: 'Copy fields to other paddocks',
    bodyHTML,
    confirmLabel: 'Copy',
    onConfirm: async () => {
      const selectedFields  = [...document.querySelectorAll('.copy-field-cb:checked')].map(el => el.value);
      const selectedTargets = [...document.querySelectorAll('.copy-target-cb:checked')].map(el => el.value);

      selectedTargets.forEach(targetId => {
        const target = document.getElementById(targetId);
        if (!target) return;
        fields
          .filter(f => selectedFields.includes(f.key))
          .forEach(f => {
            if (f.key === 'priority') {
              const srcVal = sourceBlock.querySelector('.agro-ep-priority:checked')?.value;
              const tgtRadio = target.querySelector(`.agro-ep-priority[value="${srcVal}"]`);
              if (tgtRadio) tgtRadio.checked = true;
            } else {
              const srcEl = sourceBlock.querySelector(f.cls);
              const tgtEl = target.querySelector(f.cls);
              if (srcEl && tgtEl) tgtEl.value = srcEl.value;
            }
          });
      });

      toast('Copied to ' + selectedTargets.length + ' paddock' + (selectedTargets.length !== 1 ? 's' : ''), 'success');
    },
  });
}

function collectPaddockRows() {
  return [...document.querySelectorAll('.agro-entry-paddock-block')].map(block => {
    const commodity = block.querySelector('.agro-ep-commodity')?.value || '';
    const isFallow  = FALLOW_COMMODITIES.includes(commodity);
    const priority  = block.querySelector('.agro-ep-priority:checked')?.value || 'none';

    const row = {
      paddock_name: block.querySelector('.agro-ep-name')?.value?.trim() || '',
      commodity,
      variety:      block.querySelector('.agro-ep-variety')?.value?.trim() || null,
      area_ha:      numOrNull(block.querySelector('.agro-ep-area')?.value),
      is_fallow:    isFallow,
      comments:     block.querySelector('.agro-ep-comments')?.value?.trim() || null,
      upcoming_jobs:block.querySelector('.agro-ep-jobs')?.value?.trim() || null,
      priority,
    };

    if (!isFallow) {
      Object.assign(row, {
        seed_wet_date:       block.querySelector('.agro-ep-wet-date')?.value || null,
        yield_target_t:      numOrNull(block.querySelector('.agro-ep-yield')?.value),
        soil_type:           block.querySelector('.agro-ep-soil')?.value || null,
        plant_est_pct:       numOrNull(block.querySelector('.agro-ep-est')?.value),
        plants_per_m2:       numOrNull(block.querySelector('.agro-ep-plants')?.value),
        height_cm_2:         numOrNull(block.querySelector('.agro-ep-height')?.value),
        nodes_3_count:       numOrNull(block.querySelector('.agro-ep-nodes')?.value),
        n_deficit:           numOrNull(block.querySelector('.agro-ep-ndeficit')?.value),
        seasonal_urea_req:   numOrNull(block.querySelector('.agro-ep-urea-req')?.value),
        first_incrop_irr_date: block.querySelector('.agro-ep-irr-date')?.value || null,
        incrop_sprays_notes: block.querySelector('.agro-ep-sprays')?.value?.trim() || null,
        incrop_fert_notes:   block.querySelector('.agro-ep-fert')?.value?.trim() || null,
      });
    }

    return row;
  });
}

// ── EDIT ENTRY MODAL ───────────────────────────────────────────────────────
function openEditEntryModal(entry) {
  const bodyHTML = `<div id="lv-paddock-list"></div>`;

  openModal({
    title: 'Edit Paddock Entry — ' + esc(entry.paddock_name),
    bodyHTML,
    confirmLabel: 'Save',
    wide: true,
    onOpen: () => {
      paddockRowCount = 0;
      addPaddockEntryRow(entry);
      // Hide the remove and copy buttons in edit mode
      document.querySelector('.agro-ep-remove')?.remove();
      document.querySelector('.agro-ep-copy-btn')
        && (document.querySelector('.agro-ep-copy-btn').style.display = 'none');
    },
    onConfirm: async () => {
      const rows = collectPaddockRows();
      if (!rows[0]) return;
      await dbUpdate('agronomy_paddock_entries', entry.id, {
        ...rows[0],
        updated_at: new Date().toISOString(),
      });
      toast('Entry updated', 'success');
      await refreshAll();
      if (activePaddock) renderPaddockDetail(activePaddock);
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function buildPaddockMap() {
  // For each paddock name, aggregate the latest entry data
  const map = {};
  // Sort entries by report date asc so latest wins
  const sorted = [...allEntries].sort((a, b) => {
    const ra = allReports.find(r => r.id === a.report_id)?.report_date || '';
    const rb = allReports.find(r => r.id === b.report_id)?.report_date || '';
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });

  sorted.forEach(e => {
    const report = allReports.find(r => r.id === e.report_id);
    map[e.paddock_name] = {
      ...e,
      lastReportDate: report?.report_date,
    };
  });
  return map;
}

function avgOf(arr, key) {
  const vals = arr.map(o => o[key]).filter(v => v != null);
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function fmtHa(v) { return v != null ? parseFloat(v).toFixed(1) + ' ha' : '—'; }
function numOrNull(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function todayStr() { return new Date().toISOString().slice(0, 10); }
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
