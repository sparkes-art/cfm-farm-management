// modules/agronomy/agronomy.js
// CFM Agronomy Module — Paddocks, Map, Visits & Recommendations, Spray Records

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason } from '../../js/app-state.js';
import { toast, openModal, formatDate } from '../../js/ui.js';

// ── Constants ─────────────────────────────────────────────────

const CROP_COLOURS = {
  'Cotton Flood':   '#4A90D9',
  'Cotton Lateral': '#7B68EE',
  'Grain':          '#E6A817',
  'Fallow':         '#A8B89A',
  'Other':          '#9E9E9E',
};

const IRRIGATION_TYPES = ['Flood', 'Lateral Move', 'Drip/Trickle', 'Centre Pivot', 'Dryland'];
const SOIL_TYPES       = ['Heavy Clay', 'Clay Loam', 'Sandy Clay Loam', 'Sandy Loam', 'Loam', 'Sandy'];
const APP_TYPES        = ['herbicide','insecticide','fungicide','fertiliser','pgr','other'];
const COMMODITY_OPTIONS= ['Cotton','Grain','Sorghum','Wheat','Chickpea','Fallow','Other'];
const CROP_TYPE_OPTIONS= ['Cotton Flood','Cotton Lateral','Winter Cereal','Summer Cereal','Pulse','Other'];

// ── State ─────────────────────────────────────────────────────
let map               = null;
let paddockLayers     = {};
let activeTab         = 'map';
let allPaddocks       = [];
let allVisits         = [];
let allSprayRecords   = [];
let allPaddockSeasons = [];

// ── Mount ─────────────────────────────────────────────────────

export async function mountAgronomy(container) {
  container.innerHTML = buildShell();
  await loadLeaflet();
  await refreshAll();
  bindTabNav();
  switchTab('map');
}

export function unmountAgronomy() {
  if (map) { map.remove(); map = null; }
  paddockLayers = {};
}

function buildShell() {
  return `
    <div class="page-header">
      <div>
        <h1>Agronomy</h1>
        <p class="page-subtitle">Paddock registry, farm map, visits &amp; spray records</p>
      </div>
    </div>
    <div class="tab-nav" id="agronomy-tabs">
      <button class="tab-btn active" data-tab="map">🗺 Map</button>
      <button class="tab-btn" data-tab="paddocks">🟩 Paddocks</button>
      <button class="tab-btn" data-tab="visits">📋 Visits &amp; Recs</button>
      <button class="tab-btn" data-tab="spray">🧪 Spray Records</button>
    </div>
    <div id="agro-tab-map"      class="agro-tab"></div>
    <div id="agro-tab-paddocks" class="agro-tab" style="display:none"></div>
    <div id="agro-tab-visits"   class="agro-tab" style="display:none"></div>
    <div id="agro-tab-spray"    class="agro-tab" style="display:none"></div>
  `;
}

// ── Data ──────────────────────────────────────────────────────

async function refreshAll() {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;
  const season = getActiveSeason();

  const [p, ps, v, s] = await Promise.all([
    dbSelect('paddocks', 'farm_id=eq.' + farmId + '&active=eq.true&order=name'),
    dbSelect('paddock_seasons', 'farm_id=eq.' + farmId + '&season=eq.' + season),
    dbSelect('agronomy_visits', 'farm_id=eq.' + farmId + '&order=visit_date.desc'),
    dbSelect('spray_records', 'farm_id=eq.' + farmId + '&order=application_date.desc&select=*,paddocks(name)'),
  ]);

  allPaddocks       = p  || [];
  allPaddockSeasons = ps || [];
  allVisits         = v  || [];
  allSprayRecords   = s  || [];

  renderActiveTab();
}

// ── Tabs ──────────────────────────────────────────────────────

function bindTabNav() {
  document.getElementById('agronomy-tabs')?.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#agronomy-tabs .tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.agro-tab').forEach(el =>
    el.style.display = el.id === 'agro-tab-' + tab ? '' : 'none');
  renderActiveTab();
}

function renderActiveTab() {
  if (activeTab === 'map')      renderMap();
  if (activeTab === 'paddocks') renderPaddocksTab();
  if (activeTab === 'visits')   renderVisitsTab();
  if (activeTab === 'spray')    renderSprayTab();
}

// ══════════════════════════════════════════════════════════════
// MAP TAB
// ══════════════════════════════════════════════════════════════

function renderMap() {
  const container = document.getElementById('agro-tab-map');
  if (!container) return;

  if (!container.querySelector('#farm-map')) {
    container.innerHTML = `
      <div class="agro-map-wrap">
        <div id="farm-map"></div>
        <div id="map-sidebar" class="map-sidebar map-sidebar--closed">
          <div id="map-sidebar-content"></div>
        </div>
      </div>
      <div class="card mt-2">
        <div class="card-body py-2" style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
          ${Object.entries(CROP_COLOURS).map(([k,v]) =>
            '<span class="legend-item"><span class="legend-dot" style="background:' + v + '"></span>' + k + '</span>'
          ).join('')}
          <span class="legend-item"><span class="legend-dot" style="background:#ef4444;border:2px dashed #ef4444"></span>Active withholding</span>
        </div>
      </div>
    `;
  }

  initLeafletMap();
  drawPaddockPolygons();
}

function initLeafletMap() {
  if (map) return;
  if (!window.L) { console.error('Leaflet not loaded'); return; }

  map = L.map('farm-map').setView([-14.1, 131.7], 12);

  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 20
  });
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { attribution: 'Esri, Maxar', maxZoom: 20 }
  );
  osm.addTo(map);
  L.control.layers({ 'Map': osm, 'Satellite': satellite }, {}, { position: 'topright' }).addTo(map);

  // Draw control
  if (window.L.Control && window.L.Control.Draw) {
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    const drawControl = new L.Control.Draw({
      draw: {
        polygon: { shapeOptions: { color: '#22c55e' } },
        polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false
      },
      edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);
    map.on(L.Draw.Event.CREATED, e => {
      drawnItems.addLayer(e.layer);
      openNewPaddockModal(e.layer.toGeoJSON());
    });
  }
}

function drawPaddockPolygons() {
  if (!map) return;
  Object.values(paddockLayers).forEach(l => map.removeLayer(l));
  paddockLayers = {};

  const today = new Date().toISOString().slice(0, 10);

  allPaddocks.forEach(p => {
    if (!p.geometry) return;
    const ps       = allPaddockSeasons.find(s => s.paddock_id === p.id);
    const cropType = ps?.crop_type || 'Other';
    const colour   = CROP_COLOURS[cropType] || CROP_COLOURS['Other'];
    const hasWH    = allSprayRecords.some(s =>
      s.paddock_id === p.id && s.withholding_expires_date >= today);

    const geojson = typeof p.geometry === 'string' ? JSON.parse(p.geometry) : p.geometry;
    const layer = L.geoJSON(geojson, {
      style: {
        color: hasWH ? '#ef4444' : colour,
        fillColor: colour,
        fillOpacity: 0.35,
        weight: hasWH ? 3 : 2,
        dashArray: hasWH ? '6,4' : null,
      }
    });
    layer.bindTooltip(p.name, { permanent: true, direction: 'center', className: 'paddock-label' });
    layer.on('click', () => openMapSidebar(p));
    layer.addTo(map);
    paddockLayers[p.id] = layer;
  });

  const withGeo = allPaddocks.filter(p => p.geometry);
  if (withGeo.length) {
    const group = L.featureGroup(Object.values(paddockLayers));
    if (group.getLayers().length) map.fitBounds(group.getBounds(), { padding: [40, 40] });
  }
}

function openMapSidebar(paddock) {
  const sidebar = document.getElementById('map-sidebar');
  const content = document.getElementById('map-sidebar-content');
  if (!sidebar || !content) return;
  sidebar.classList.remove('map-sidebar--closed');

  const ps      = allPaddockSeasons.find(s => s.paddock_id === paddock.id);
  const lastVisit = allVisits.find(v => (v.paddock_ids || []).includes(paddock.id));
  const today   = new Date().toISOString().slice(0, 10);
  const activeWH = allSprayRecords.filter(s =>
    s.paddock_id === paddock.id && s.withholding_expires_date && s.withholding_expires_date >= today);
  const recent  = allSprayRecords.filter(s => s.paddock_id === paddock.id).slice(0, 5);

  content.innerHTML =
    '<div class="sidebar-header">' +
      '<h3>' + esc(paddock.name) + '</h3>' +
      '<button class="btn-icon" onclick="document.getElementById(\'map-sidebar\').classList.add(\'map-sidebar--closed\')">✕</button>' +
    '</div>' +
    '<div class="sidebar-section">' +
      '<div class="detail-grid">' +
        '<span class="detail-label">Area</span><span>' + (paddock.area_ha ? paddock.area_ha + ' ha' : '—') + '</span>' +
        '<span class="detail-label">Soil</span><span>' + (paddock.soil_type || '—') + '</span>' +
        '<span class="detail-label">Irrigation</span><span>' + (paddock.irrigation_type || '—') + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="sidebar-section">' +
      '<div class="sidebar-section-title">Season — ' + getActiveSeason() + '</div>' +
      (ps ?
        '<div class="detail-grid">' +
          '<span class="detail-label">Crop Type</span><span>' + (ps.crop_type || '—') + '</span>' +
          '<span class="detail-label">Variety</span><span>' + (ps.variety || '—') + '</span>' +
          '<span class="detail-label">Planted</span><span>' + (ps.planted_date ? formatDate(ps.planted_date) : '—') + '</span>' +
        '</div>'
        : '<p class="text-muted small">No crop recorded. <a href="#" onclick="window._cfmAgroEditSeason(\'' + paddock.id + '\');return false">Add →</a></p>') +
    '</div>' +
    (activeWH.length ?
      '<div class="sidebar-section">' +
        '<div class="sidebar-section-title" style="color:#ef4444">⚠ Active Withholding</div>' +
        activeWH.map(s =>
          '<div class="withholding-badge"><strong>' + esc(s.product_name) + '</strong><span>Exp. ' + formatDate(s.withholding_expires_date) + '</span></div>'
        ).join('') +
      '</div>' : '') +
    (lastVisit ?
      '<div class="sidebar-section">' +
        '<div class="sidebar-section-title">Last Visit — ' + formatDate(lastVisit.visit_date) + '</div>' +
        '<p class="small"><em>' + esc(lastVisit.agronomist_name) + '</em></p>' +
        '<p class="small">' + esc((lastVisit.recommendations || lastVisit.observations || '').slice(0, 200)) + '</p>' +
      '</div>' : '') +
    (recent.length ?
      '<div class="sidebar-section">' +
        '<div class="sidebar-section-title">Recent Sprays</div>' +
        '<table class="mini-table"><thead><tr><th>Date</th><th>Product</th><th>Rate</th></tr></thead><tbody>' +
        recent.map(s =>
          '<tr><td>' + formatDate(s.application_date) + '</td><td>' + esc(s.product_name) + '</td><td>' +
          (s.rate_per_ha ? s.rate_per_ha + ' ' + (s.rate_unit || 'L/ha') : '—') + '</td></tr>'
        ).join('') +
        '</tbody></table>' +
      '</div>' : '') +
    '<div class="sidebar-actions">' +
      '<button class="btn btn-sm btn-secondary" onclick="window._cfmAgroEditSeason(\'' + paddock.id + '\')">Edit Season</button>' +
      '<button class="btn btn-sm btn-primary" onclick="window._cfmAgroNewVisit(\'' + paddock.id + '\')">Log Visit</button>' +
      '<button class="btn btn-sm btn-secondary" onclick="window._cfmAgroNewSpray(\'' + paddock.id + '\')">Add Spray</button>' +
    '</div>';
}

function openNewPaddockModal(geometry) {
  openModal({
    title: 'New Paddock',
    bodyHTML: paddockFormHTML({}),
    confirmLabel: 'Save Paddock',
    onConfirm: async () => { await savePaddock(null, geometry); },
  });
}

// ══════════════════════════════════════════════════════════════
// PADDOCKS TAB
// ══════════════════════════════════════════════════════════════

function renderPaddocksTab() {
  const container = document.getElementById('agro-tab-paddocks');
  if (!container) return;
  const season = getActiveSeason();

  container.innerHTML =
    '<div class="card">' +
      '<div class="card-header">' +
        '<span>Paddock Registry</span>' +
        '<button class="btn btn-primary btn-sm" id="add-paddock-btn">+ Add Paddock</button>' +
      '</div>' +
      '<div class="table-responsive">' +
        '<table class="data-table" id="paddocks-table">' +
          '<thead><tr>' +
            '<th>Paddock</th><th>Area (ha)</th><th>Soil</th><th>Irrigation</th>' +
            '<th>' + season + ' Crop Type</th><th>' + season + ' Variety</th><th>' + season + ' Planted</th>' +
            '<th>Notes</th><th></th>' +
          '</tr></thead>' +
          '<tbody id="paddocks-tbody">' +
            (allPaddocks.length === 0
              ? '<tr><td colspan="9" class="empty-cell">No paddocks yet. Click "+ Add Paddock" to begin.</td></tr>'
              : allPaddocks.map(p => paddockRowHTML(p, false)).join('')) +
          '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';

  document.getElementById('add-paddock-btn')?.addEventListener('click', () => {
    openModal({
      title: 'New Paddock',
      bodyHTML: paddockFormHTML({}),
      confirmLabel: 'Save Paddock',
      onConfirm: async () => { await savePaddock(null, null); },
    });
  });

  bindPaddockRowEvents();
}

function paddockRowHTML(p, editing) {
  const ps = allPaddockSeasons.find(s => s.paddock_id === p.id);
  if (editing) {
    return '<tr data-id="' + p.id + '" class="editing-row">' +
      '<td><input class="inline-input" name="name" value="' + esc(p.name) + '" required></td>' +
      '<td><input class="inline-input" name="area_ha" type="number" step="0.01" value="' + (p.area_ha || '') + '"></td>' +
      '<td><select class="inline-input" name="soil_type"><option value="">—</option>' +
        SOIL_TYPES.map(s => '<option' + (p.soil_type === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select></td>' +
      '<td><select class="inline-input" name="irrigation_type"><option value="">—</option>' +
        IRRIGATION_TYPES.map(s => '<option' + (p.irrigation_type === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select></td>' +
      '<td><select class="inline-input" name="ps_crop_type"><option value="">—</option>' +
        CROP_TYPE_OPTIONS.map(s => '<option' + (ps?.crop_type === s ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select></td>' +
      '<td><input class="inline-input" name="ps_variety" value="' + esc(ps?.variety || '') + '"></td>' +
      '<td><input class="inline-input" name="ps_planted_date" type="date" value="' + (ps?.planted_date || '') + '"></td>' +
      '<td><input class="inline-input" name="notes" value="' + esc(p.notes || '') + '"></td>' +
      '<td class="row-actions">' +
        '<button class="btn-link save-paddock-btn" data-id="' + p.id + '">Save</button>' +
        '<button class="btn-link cancel-paddock-btn" data-id="' + p.id + '">Cancel</button>' +
      '</td>' +
    '</tr>';
  }
  return '<tr data-id="' + p.id + '">' +
    '<td>' + esc(p.name) + '</td>' +
    '<td>' + (p.area_ha ? p.area_ha + ' ha' : '—') + '</td>' +
    '<td>' + (p.soil_type || '—') + '</td>' +
    '<td>' + (p.irrigation_type || '—') + '</td>' +
    '<td>' + (ps?.crop_type || '—') + '</td>' +
    '<td>' + (ps?.variety || '—') + '</td>' +
    '<td>' + (ps?.planted_date ? formatDate(ps.planted_date) : '—') + '</td>' +
    '<td class="notes-cell">' + esc(p.notes || '') + '</td>' +
    '<td class="row-actions">' +
      '<button class="btn-link edit-paddock-btn" data-id="' + p.id + '">Edit</button>' +
      '<button class="btn-link danger delete-paddock-btn" data-id="' + p.id + '">Archive</button>' +
    '</td>' +
  '</tr>';
}

function bindPaddockRowEvents() {
  const tbody = document.getElementById('paddocks-tbody');
  if (!tbody) return;
  tbody.addEventListener('click', async e => {
    const id = e.target.dataset.id;
    if (!id) return;

    if (e.target.classList.contains('edit-paddock-btn')) {
      const p = allPaddocks.find(p => p.id === id);
      const row = tbody.querySelector('tr[data-id="' + id + '"]');
      if (row && p) { row.outerHTML = paddockRowHTML(p, true); bindPaddockRowEvents(); }
    }
    if (e.target.classList.contains('cancel-paddock-btn')) {
      const p = allPaddocks.find(p => p.id === id);
      const row = tbody.querySelector('tr[data-id="' + id + '"]');
      if (row && p) { row.outerHTML = paddockRowHTML(p, false); bindPaddockRowEvents(); }
    }
    if (e.target.classList.contains('save-paddock-btn')) {
      await saveInlinePaddock(id, tbody);
    }
    if (e.target.classList.contains('delete-paddock-btn')) {
      const p = allPaddocks.find(p => p.id === id);
      if (confirm('Archive paddock "' + (p?.name || '') + '"? Data is retained.')) {
        await dbUpdate('paddocks', id, { active: false });
        toast('Paddock archived', 'success');
        await refreshAll();
      }
    }
  });
}

async function saveInlinePaddock(id, tbody) {
  const row = tbody.querySelector('tr[data-id="' + id + '"]');
  if (!row) return;
  const g = n => { const el = row.querySelector('[name="' + n + '"]'); return el ? el.value.trim() || null : null; };
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;
  const season = getActiveSeason();

  const paddockData = {
    name:            g('name'),
    area_ha:         g('area_ha') ? parseFloat(g('area_ha')) : null,
    soil_type:       g('soil_type'),
    irrigation_type: g('irrigation_type'),
    notes:           g('notes'),
    updated_at:      new Date().toISOString(),
  };
  if (!paddockData.name) { toast('Paddock name is required', 'error'); return; }

  await dbUpdate('paddocks', id, paddockData);

  const cropType = g('ps_crop_type');
  const variety  = g('ps_variety');
  const planted  = g('ps_planted_date');
  const existing = allPaddockSeasons.find(ps => ps.paddock_id === id);

  if (cropType || variety || planted) {
    const psData = {
      paddock_id: id, farm_id: farmId, season,
      commodity:  resolveCommodity(cropType),
      crop_type:  cropType, variety, planted_date: planted,
      updated_at: new Date().toISOString(),
    };
    if (existing) {
      await dbUpdate('paddock_seasons', existing.id, psData);
    } else {
      await dbInsert('paddock_seasons', psData);
    }
  }

  toast('Paddock saved', 'success');
  await refreshAll();
}

function paddockFormHTML(d) {
  return '<div class="form-grid form-grid-2">' +
    '<div class="form-group"><label>Paddock Name *</label>' +
      '<input class="form-control" id="pf-name" value="' + esc(d.name || '') + '"></div>' +
    '<div class="form-group"><label>Area (ha)</label>' +
      '<input class="form-control" id="pf-area" type="number" step="0.01" value="' + (d.area_ha || '') + '"></div>' +
    '<div class="form-group"><label>Soil Type</label>' +
      '<select class="form-control" id="pf-soil"><option value="">—</option>' +
      SOIL_TYPES.map(s => '<option>' + s + '</option>').join('') + '</select></div>' +
    '<div class="form-group"><label>Irrigation</label>' +
      '<select class="form-control" id="pf-irrigation"><option value="">—</option>' +
      IRRIGATION_TYPES.map(s => '<option>' + s + '</option>').join('') + '</select></div>' +
    '<div class="form-group form-group--full"><label>Notes</label>' +
      '<textarea class="form-control" id="pf-notes" rows="2">' + esc(d.notes || '') + '</textarea></div>' +
  '</div>';
}

async function savePaddock(existingId, geometry) {
  const farm   = getActiveFarm();
  const farmId = farm?.id || farm;
  const data = {
    farm_id:         farmId,
    name:            document.getElementById('pf-name')?.value?.trim(),
    area_ha:         parseFloat(document.getElementById('pf-area')?.value) || null,
    soil_type:       document.getElementById('pf-soil')?.value || null,
    irrigation_type: document.getElementById('pf-irrigation')?.value || null,
    notes:           document.getElementById('pf-notes')?.value?.trim() || null,
    geometry:        geometry || null,
  };
  if (!data.name) throw new Error('Paddock name is required');
  if (existingId) {
    await dbUpdate('paddocks', existingId, data);
  } else {
    await dbInsert('paddocks', data);
  }
  toast('Paddock saved', 'success');
  await refreshAll();
}

// ══════════════════════════════════════════════════════════════
// VISITS TAB
// ══════════════════════════════════════════════════════════════

function renderVisitsTab() {
  const container = document.getElementById('agro-tab-visits');
  if (!container) return;

  const today   = new Date().toISOString().slice(0, 10);
  const overdue = allVisits.filter(v =>
    v.follow_up_required && !v.follow_up_completed && v.follow_up_date < today);

  container.innerHTML =
    (overdue.length ?
      '<div class="alert alert-warning mb-3">⚠ ' + overdue.length + ' follow-up' +
      (overdue.length > 1 ? 's' : '') + ' overdue</div>' : '') +
    '<div class="card">' +
      '<div class="card-header">' +
        '<span>Agronomist Visits &amp; Recommendations</span>' +
        '<button class="btn btn-primary btn-sm" id="add-visit-btn">+ Log Visit</button>' +
      '</div>' +
      '<div class="table-responsive">' +
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th>Date</th><th>Agronomist</th><th>Type</th><th>Paddocks</th>' +
            '<th>Observations</th><th>Recommendations</th><th>Follow-up</th><th></th>' +
          '</tr></thead>' +
          '<tbody>' +
            (allVisits.length === 0
              ? '<tr><td colspan="8" class="empty-cell">No visits recorded.</td></tr>'
              : allVisits.map(v => visitRowHTML(v)).join('')) +
          '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';

  document.getElementById('add-visit-btn')?.addEventListener('click', () => openVisitModal(null, null));

  container.querySelectorAll('.edit-visit-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const v = allVisits.find(v => v.id === btn.dataset.id);
      if (v) openVisitModal(v, null);
    })
  );
  container.querySelectorAll('.delete-visit-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (confirm('Delete this visit record?')) {
        await dbDelete('agronomy_visits', btn.dataset.id);
        toast('Visit deleted', 'success');
        await refreshAll();
      }
    })
  );
  container.querySelectorAll('.complete-followup-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      await dbUpdate('agronomy_visits', btn.dataset.id, { follow_up_completed: true });
      toast('Follow-up marked complete', 'success');
      await refreshAll();
    })
  );
}

function visitRowHTML(v) {
  const names = (v.paddock_ids || [])
    .map(id => allPaddocks.find(p => p.id === id)?.name || '?').join(', ');
  const today = new Date().toISOString().slice(0, 10);
  const overdue = v.follow_up_required && !v.follow_up_completed && v.follow_up_date < today;

  return '<tr>' +
    '<td>' + formatDate(v.visit_date) + '</td>' +
    '<td><strong>' + esc(v.agronomist_name) + '</strong>' +
      (v.agronomist_company ? '<br><small class="text-muted">' + esc(v.agronomist_company) + '</small>' : '') +
    '</td>' +
    '<td><span class="badge badge-' + v.agronomist_type + '">' + v.agronomist_type + '</span></td>' +
    '<td class="small">' + (names || '—') + '</td>' +
    '<td class="notes-cell small">' + esc((v.observations || '').slice(0, 100)) + '</td>' +
    '<td class="notes-cell small">' + esc((v.recommendations || '').slice(0, 100)) + '</td>' +
    '<td>' +
      (v.follow_up_required && !v.follow_up_completed
        ? '<span class="badge badge-' + (overdue ? 'danger' : 'warning') + '">' +
          (overdue ? '⚠ Overdue' : 'Due ' + formatDate(v.follow_up_date)) + '</span> ' +
          '<button class="btn-link small complete-followup-btn" data-id="' + v.id + '">Done</button>'
        : v.follow_up_completed ? '<span class="badge badge-success">Complete</span>' : '—') +
    '</td>' +
    '<td class="row-actions">' +
      '<button class="btn-link edit-visit-btn" data-id="' + v.id + '">Edit</button>' +
      '<button class="btn-link danger delete-visit-btn" data-id="' + v.id + '">Del</button>' +
    '</td>' +
  '</tr>';
}

function openVisitModal(existing, defaultPaddockId) {
  const v = existing || {};
  const preselect = defaultPaddockId || '';

  const bodyHTML =
    '<div class="form-grid form-grid-2">' +
    '<div class="form-group"><label>Visit Date *</label>' +
      '<input class="form-control" id="vf-date" type="date" value="' + (v.visit_date || todayStr()) + '"></div>' +
    '<div class="form-group"><label>Type *</label>' +
      '<select class="form-control" id="vf-type">' +
        '<option value="external"' + (v.agronomist_type === 'external' ? ' selected' : '') + '>External</option>' +
        '<option value="internal"' + (v.agronomist_type === 'internal' ? ' selected' : '') + '>Internal</option>' +
      '</select></div>' +
    '<div class="form-group"><label>Agronomist Name *</label>' +
      '<input class="form-control" id="vf-name" value="' + esc(v.agronomist_name || '') + '"></div>' +
    '<div class="form-group"><label>Company</label>' +
      '<input class="form-control" id="vf-company" value="' + esc(v.agronomist_company || '') + '"></div>' +
    '<div class="form-group form-group--full"><label>Paddocks Visited</label>' +
      '<div class="checkbox-group">' +
      allPaddocks.map(p =>
        '<label class="checkbox-label"><input type="checkbox" class="visit-paddock-cb" value="' + p.id + '"' +
        ((v.paddock_ids || []).includes(p.id) || preselect === p.id ? ' checked' : '') + '> ' + esc(p.name) + '</label>'
      ).join('') +
      '</div></div>' +
    '<div class="form-group form-group--full"><label>Observations</label>' +
      '<textarea class="form-control" id="vf-observations" rows="3">' + esc(v.observations || '') + '</textarea></div>' +
    '<div class="form-group form-group--full"><label>Recommendations</label>' +
      '<textarea class="form-control" id="vf-recommendations" rows="3">' + esc(v.recommendations || '') + '</textarea></div>' +
    '<div class="form-group"><label class="checkbox-label">' +
      '<input type="checkbox" id="vf-followup-req"' + (v.follow_up_required ? ' checked' : '') +
      ' onchange="document.getElementById(\'vf-followup-wrap\').style.display=this.checked?\'\':\' none\'"> Follow-up required</label></div>' +
    '<div class="form-group" id="vf-followup-wrap" style="' + (v.follow_up_required ? '' : 'display:none') + '">' +
      '<label>Follow-up Date</label>' +
      '<input class="form-control" id="vf-followup-date" type="date" value="' + (v.follow_up_date || '') + '"></div>' +
    '</div>';

  openModal({
    title: existing ? 'Edit Visit' : 'Log Agronomist Visit',
    bodyHTML,
    confirmLabel: 'Save',
    onConfirm: async () => {
      const farm   = getActiveFarm();
      const farmId = farm?.id || farm;
      const paddockIds = [...document.querySelectorAll('.visit-paddock-cb:checked')].map(el => el.value);
      const data = {
        farm_id:            farmId,
        visit_date:         document.getElementById('vf-date')?.value,
        agronomist_name:    document.getElementById('vf-name')?.value?.trim(),
        agronomist_type:    document.getElementById('vf-type')?.value,
        agronomist_company: document.getElementById('vf-company')?.value?.trim() || null,
        paddock_ids:        paddockIds,
        observations:       document.getElementById('vf-observations')?.value?.trim() || null,
        recommendations:    document.getElementById('vf-recommendations')?.value?.trim() || null,
        follow_up_required: document.getElementById('vf-followup-req')?.checked || false,
        follow_up_date:     document.getElementById('vf-followup-date')?.value || null,
        updated_at:         new Date().toISOString(),
      };
      if (!data.visit_date || !data.agronomist_name) throw new Error('Date and agronomist name are required');
      if (existing) {
        await dbUpdate('agronomy_visits', existing.id, data);
      } else {
        await dbInsert('agronomy_visits', data);
      }
      toast('Visit saved', 'success');
      await refreshAll();
    },
  });
}

// ══════════════════════════════════════════════════════════════
// SPRAY TAB
// ══════════════════════════════════════════════════════════════

function renderSprayTab() {
  const container = document.getElementById('agro-tab-spray');
  if (!container) return;

  const today    = new Date().toISOString().slice(0, 10);
  const activeWH = allSprayRecords.filter(s =>
    s.withholding_expires_date && s.withholding_expires_date >= today);

  container.innerHTML =
    (activeWH.length ?
      '<div class="alert alert-warning mb-3">⚠ <strong>' + activeWH.length +
      ' active withholding period' + (activeWH.length > 1 ? 's' : '') + '</strong> — ' +
      activeWH.map(s =>
        (allPaddocks.find(p => p.id === s.paddock_id)?.name || '?') +
        ': ' + esc(s.product_name) + ' (exp. ' + formatDate(s.withholding_expires_date) + ')'
      ).join(' | ') + '</div>' : '') +
    '<div class="card">' +
      '<div class="card-header">' +
        '<span>Spray Records</span>' +
        '<button class="btn btn-primary btn-sm" id="add-spray-btn">+ Add Record</button>' +
      '</div>' +
      '<div class="table-responsive">' +
        '<table class="data-table" id="spray-table">' +
          '<thead><tr>' +
            '<th>Date</th><th>Paddock</th><th>Product</th><th>Type</th>' +
            '<th>Rate</th><th>Area (ha)</th><th>Total Qty</th><th>Operator</th>' +
            '<th>WHP Expires</th><th></th>' +
          '</tr></thead>' +
          '<tbody id="spray-tbody">' +
            (allSprayRecords.length === 0
              ? '<tr><td colspan="10" class="empty-cell">No spray records.</td></tr>'
              : allSprayRecords.map(r => sprayRowHTML(r, false)).join('')) +
          '</tbody>' +
        '</table>' +
      '</div>' +
    '</div>';

  document.getElementById('add-spray-btn')?.addEventListener('click', () => openSprayModal(null, null));
  bindSprayRowEvents();
}

function sprayRowHTML(r, editing) {
  const paddockName = allPaddocks.find(p => p.id === r.paddock_id)?.name || r.paddocks?.name || '—';
  const today       = new Date().toISOString().slice(0, 10);
  const whActive    = r.withholding_expires_date && r.withholding_expires_date >= today;

  if (editing) {
    return '<tr data-id="' + r.id + '" class="editing-row">' +
      '<td><input class="inline-input" name="application_date" type="date" value="' + (r.application_date || '') + '"></td>' +
      '<td><select class="inline-input" name="paddock_id">' +
        allPaddocks.map(p => '<option value="' + p.id + '"' + (r.paddock_id === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
      '</select></td>' +
      '<td><input class="inline-input" name="product_name" value="' + esc(r.product_name || '') + '"></td>' +
      '<td><select class="inline-input" name="application_type">' +
        APP_TYPES.map(t => '<option value="' + t + '"' + (r.application_type === t ? ' selected' : '') + '>' + cap(t) + '</option>').join('') +
      '</select></td>' +
      '<td><input class="inline-input" style="width:70px" name="rate_per_ha" type="number" step="0.001" value="' + (r.rate_per_ha || '') + '"></td>' +
      '<td><input class="inline-input" name="total_area_ha" type="number" step="0.01" value="' + (r.total_area_ha || '') + '"></td>' +
      '<td><input class="inline-input" name="total_qty" type="number" step="0.001" value="' + (r.total_qty || '') + '"></td>' +
      '<td><input class="inline-input" name="operator" value="' + esc(r.operator || '') + '"></td>' +
      '<td><input class="inline-input" name="withholding_period_days" type="number" min="0" value="' + (r.withholding_period_days || '') + '"> days</td>' +
      '<td class="row-actions">' +
        '<button class="btn-link save-spray-btn" data-id="' + r.id + '">Save</button>' +
        '<button class="btn-link cancel-spray-btn" data-id="' + r.id + '">Cancel</button>' +
      '</td>' +
    '</tr>';
  }

  return '<tr data-id="' + r.id + '">' +
    '<td>' + formatDate(r.application_date) + '</td>' +
    '<td>' + esc(paddockName) + '</td>' +
    '<td><strong>' + esc(r.product_name) + '</strong>' +
      (r.active_ingredient ? '<br><small class="text-muted">' + esc(r.active_ingredient) + '</small>' : '') +
    '</td>' +
    '<td><span class="badge badge-' + (r.application_type || 'other') + '">' + cap(r.application_type || '') + '</span></td>' +
    '<td>' + (r.rate_per_ha ? r.rate_per_ha + ' ' + (r.rate_unit || 'L/ha') : '—') + '</td>' +
    '<td>' + (r.total_area_ha ? r.total_area_ha + ' ha' : '—') + '</td>' +
    '<td>' + (r.total_qty ? r.total_qty + ' ' + (r.qty_unit || 'L') : '—') + '</td>' +
    '<td>' + esc(r.operator || '—') + '</td>' +
    '<td>' + (r.withholding_expires_date
      ? '<span class="badge badge-' + (whActive ? 'danger' : 'muted') + '">' +
        (whActive ? '⚠ ' : '') + formatDate(r.withholding_expires_date) + '</span>'
      : '—') + '</td>' +
    '<td class="row-actions">' +
      '<button class="btn-link edit-spray-btn" data-id="' + r.id + '">Edit</button>' +
      '<button class="btn-link danger delete-spray-btn" data-id="' + r.id + '">Del</button>' +
    '</td>' +
  '</tr>';
}

function bindSprayRowEvents() {
  const tbody = document.getElementById('spray-tbody');
  if (!tbody) return;
  tbody.addEventListener('click', async e => {
    const id = e.target.dataset.id;
    if (!id) return;
    if (e.target.classList.contains('edit-spray-btn')) {
      const r = allSprayRecords.find(r => r.id === id);
      const row = tbody.querySelector('tr[data-id="' + id + '"]');
      if (row && r) { row.outerHTML = sprayRowHTML(r, true); bindSprayRowEvents(); }
    }
    if (e.target.classList.contains('cancel-spray-btn')) {
      const r = allSprayRecords.find(r => r.id === id);
      const row = tbody.querySelector('tr[data-id="' + id + '"]');
      if (row && r) { row.outerHTML = sprayRowHTML(r, false); bindSprayRowEvents(); }
    }
    if (e.target.classList.contains('save-spray-btn')) {
      await saveInlineSpray(id, tbody);
    }
    if (e.target.classList.contains('delete-spray-btn')) {
      if (confirm('Delete this spray record?')) {
        await dbDelete('spray_records', id);
        toast('Record deleted', 'success');
        await refreshAll();
      }
    }
  });
}

async function saveInlineSpray(id, tbody) {
  const row = tbody.querySelector('tr[data-id="' + id + '"]');
  if (!row) return;
  const g = n => { const el = row.querySelector('[name="' + n + '"]'); return el ? el.value.trim() || null : null; };
  const data = {
    application_date:        g('application_date'),
    paddock_id:              g('paddock_id'),
    product_name:            g('product_name'),
    application_type:        g('application_type'),
    rate_per_ha:             g('rate_per_ha') ? parseFloat(g('rate_per_ha')) : null,
    total_area_ha:           g('total_area_ha') ? parseFloat(g('total_area_ha')) : null,
    total_qty:               g('total_qty') ? parseFloat(g('total_qty')) : null,
    operator:                g('operator'),
    withholding_period_days: g('withholding_period_days') ? parseInt(g('withholding_period_days')) : null,
    updated_at:              new Date().toISOString(),
  };
  if (!data.application_date || !data.product_name) { toast('Date and product required', 'error'); return; }
  await dbUpdate('spray_records', id, data);
  toast('Spray record saved', 'success');
  await refreshAll();
}

function openSprayModal(existingId, defaultPaddockId) {
  const r = existingId ? allSprayRecords.find(s => s.id === existingId) : {};
  const pid = defaultPaddockId || r?.paddock_id || '';

  const bodyHTML =
    '<div class="form-grid form-grid-2">' +
    '<div class="form-group"><label>Date *</label>' +
      '<input class="form-control" id="sf-date" type="date" value="' + (r?.application_date || todayStr()) + '"></div>' +
    '<div class="form-group"><label>Paddock *</label>' +
      '<select class="form-control" id="sf-paddock"><option value="">— Select —</option>' +
      allPaddocks.map(p => '<option value="' + p.id + '"' + (pid === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') +
      '</select></div>' +
    '<div class="form-group"><label>Product Name *</label>' +
      '<input class="form-control" id="sf-product" value="' + esc(r?.product_name || '') + '"></div>' +
    '<div class="form-group"><label>Active Ingredient</label>' +
      '<input class="form-control" id="sf-ai" value="' + esc(r?.active_ingredient || '') + '"></div>' +
    '<div class="form-group"><label>Application Type</label>' +
      '<select class="form-control" id="sf-type"><option value="">—</option>' +
      APP_TYPES.map(t => '<option value="' + t + '"' + (r?.application_type === t ? ' selected' : '') + '>' + cap(t) + '</option>').join('') +
      '</select></div>' +
    '<div class="form-group"><label>Operator</label>' +
      '<input class="form-control" id="sf-operator" value="' + esc(r?.operator || '') + '"></div>' +
    '<div class="form-group"><label>Rate per Ha</label>' +
      '<div style="display:flex;gap:6px">' +
        '<input class="form-control" id="sf-rate" type="number" step="0.001" value="' + (r?.rate_per_ha || '') + '">' +
        '<input class="form-control" id="sf-rate-unit" value="' + esc(r?.rate_unit || 'L/ha') + '" style="max-width:70px">' +
      '</div></div>' +
    '<div class="form-group"><label>Total Area (ha)</label>' +
      '<input class="form-control" id="sf-area" type="number" step="0.01" value="' + (r?.total_area_ha || '') + '"></div>' +
    '<div class="form-group"><label>Total Quantity</label>' +
      '<div style="display:flex;gap:6px">' +
        '<input class="form-control" id="sf-qty" type="number" step="0.001" value="' + (r?.total_qty || '') + '">' +
        '<input class="form-control" id="sf-qty-unit" value="' + esc(r?.qty_unit || 'L') + '" style="max-width:60px">' +
      '</div></div>' +
    '<div class="form-group"><label>Withholding Period (days)</label>' +
      '<input class="form-control" id="sf-whp" type="number" min="0" value="' + (r?.withholding_period_days || '') + '"></div>' +
    '<div class="form-group"><label>Temp (°C)</label>' +
      '<input class="form-control" id="sf-temp" type="number" step="0.1" value="' + (r?.weather_temp_c || '') + '"></div>' +
    '<div class="form-group"><label>Wind (km/h)</label>' +
      '<input class="form-control" id="sf-wind" type="number" step="0.1" value="' + (r?.weather_wind_kmh || '') + '"></div>' +
    '<div class="form-group form-group--full"><label>Weather / Conditions</label>' +
      '<input class="form-control" id="sf-weather" value="' + esc(r?.weather_conditions || '') + '"></div>' +
    '<div class="form-group"><label>Application Method</label>' +
      '<input class="form-control" id="sf-method" value="' + esc(r?.application_method || '') + '"></div>' +
    '<div class="form-group form-group--full"><label>Notes</label>' +
      '<textarea class="form-control" id="sf-notes" rows="2">' + esc(r?.notes || '') + '</textarea></div>' +
    '</div>';

  openModal({
    title: existingId ? 'Edit Spray Record' : 'Add Spray Record',
    bodyHTML,
    confirmLabel: 'Save',
    onConfirm: async () => {
      const farm   = getActiveFarm();
      const farmId = farm?.id || farm;
      const season = getActiveSeason();
      const paddockId = document.getElementById('sf-paddock')?.value;
      const psRow = allPaddockSeasons.find(ps => ps.paddock_id === paddockId && ps.season === season);

      const data = {
        farm_id:                farmId,
        paddock_id:             paddockId,
        paddock_season_id:      psRow?.id || null,
        application_date:       document.getElementById('sf-date')?.value,
        product_name:           document.getElementById('sf-product')?.value?.trim(),
        active_ingredient:      document.getElementById('sf-ai')?.value?.trim() || null,
        application_type:       document.getElementById('sf-type')?.value || null,
        operator:               document.getElementById('sf-operator')?.value?.trim() || null,
        rate_per_ha:            parseFloat(document.getElementById('sf-rate')?.value) || null,
        rate_unit:              document.getElementById('sf-rate-unit')?.value || 'L/ha',
        total_area_ha:          parseFloat(document.getElementById('sf-area')?.value) || null,
        total_qty:              parseFloat(document.getElementById('sf-qty')?.value) || null,
        qty_unit:               document.getElementById('sf-qty-unit')?.value || 'L',
        withholding_period_days:parseInt(document.getElementById('sf-whp')?.value) || null,
        weather_temp_c:         parseFloat(document.getElementById('sf-temp')?.value) || null,
        weather_wind_kmh:       parseFloat(document.getElementById('sf-wind')?.value) || null,
        weather_conditions:     document.getElementById('sf-weather')?.value?.trim() || null,
        application_method:     document.getElementById('sf-method')?.value?.trim() || null,
        notes:                  document.getElementById('sf-notes')?.value?.trim() || null,
        updated_at:             new Date().toISOString(),
      };
      if (!data.application_date || !data.paddock_id || !data.product_name) {
        throw new Error('Date, paddock, and product name are required');
      }
      if (existingId) {
        await dbUpdate('spray_records', existingId, data);
      } else {
        await dbInsert('spray_records', data);
      }
      toast('Spray record saved', 'success');
      await refreshAll();
    },
  });
}

// ── Season Modal ──────────────────────────────────────────────

function openSeasonModal(paddockId) {
  const paddock = allPaddocks.find(p => p.id === paddockId);
  const season  = getActiveSeason();
  const ps      = allPaddockSeasons.find(s => s.paddock_id === paddockId);
  if (!paddock) return;

  openModal({
    title: esc(paddock.name) + ' — ' + season,
    bodyHTML:
      '<div class="form-grid form-grid-2">' +
      '<div class="form-group"><label>Commodity</label>' +
        '<select class="form-control" id="psf-commodity"><option value="">—</option>' +
        COMMODITY_OPTIONS.map(c => '<option' + (ps?.commodity === c ? ' selected' : '') + '>' + c + '</option>').join('') +
        '</select></div>' +
      '<div class="form-group"><label>Crop Type</label>' +
        '<select class="form-control" id="psf-crop-type"><option value="">—</option>' +
        CROP_TYPE_OPTIONS.map(c => '<option' + (ps?.crop_type === c ? ' selected' : '') + '>' + c + '</option>').join('') +
        '</select></div>' +
      '<div class="form-group"><label>Variety</label>' +
        '<input class="form-control" id="psf-variety" value="' + esc(ps?.variety || '') + '"></div>' +
      '<div class="form-group"><label>Planted Date</label>' +
        '<input class="form-control" id="psf-planted" type="date" value="' + (ps?.planted_date || '') + '"></div>' +
      '<div class="form-group"><label>Area Planted (ha)</label>' +
        '<input class="form-control" id="psf-area" type="number" step="0.01" value="' + (ps?.area_planted_ha || '') + '"></div>' +
      '<div class="form-group form-group--full"><label>Notes</label>' +
        '<textarea class="form-control" id="psf-notes" rows="2">' + esc(ps?.notes || '') + '</textarea></div>' +
      '</div>',
    confirmLabel: 'Save',
    onConfirm: async () => {
      const farm   = getActiveFarm();
      const farmId = farm?.id || farm;
      const data = {
        paddock_id:      paddockId,
        farm_id:         farmId,
        season,
        commodity:       document.getElementById('psf-commodity')?.value || null,
        crop_type:       document.getElementById('psf-crop-type')?.value || null,
        variety:         document.getElementById('psf-variety')?.value?.trim() || null,
        planted_date:    document.getElementById('psf-planted')?.value || null,
        area_planted_ha: parseFloat(document.getElementById('psf-area')?.value) || null,
        notes:           document.getElementById('psf-notes')?.value?.trim() || null,
        updated_at:      new Date().toISOString(),
      };
      if (ps) {
        await dbUpdate('paddock_seasons', ps.id, data);
      } else {
        await dbInsert('paddock_seasons', data);
      }
      toast('Season crop saved', 'success');
      await refreshAll();
    },
  });
}

// ── Leaflet loader ────────────────────────────────────────────

async function loadLeaflet() {
  if (window.L) return;
  await Promise.all([
    loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'),
    loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'),
  ]);
  await Promise.all([
    loadCSS('https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css'),
    loadScript('https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js'),
  ]);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadCSS(href) {
  return new Promise(resolve => {
    if (document.querySelector('link[href="' + href + '"]')) { resolve(); return; }
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.onload = resolve;
    document.head.appendChild(l);
    setTimeout(resolve, 2000);
  });
}

// ── Global hooks ──────────────────────────────────────────────
window._cfmAgroEditSeason = (id) => openSeasonModal(id);
window._cfmAgroNewVisit   = (id) => openVisitModal(null, id);
window._cfmAgroNewSpray   = (id) => openSprayModal(null, id);

// ── Helpers ───────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().slice(0, 10); }
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function resolveCommodity(cropType) {
  if (!cropType) return null;
  if (cropType.toLowerCase().includes('cotton')) return 'Cotton';
  if (['Winter Cereal','Summer Cereal'].includes(cropType)) return 'Grain';
  if (cropType === 'Pulse') return 'Chickpea';
  return cropType;
}