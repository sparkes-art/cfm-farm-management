// modules/agronomy/agronomy.js
// CFM Agronomy Module — Paddocks, Map, Visits & Recommendations, Spray Records
// Depends on: js/supabase-client.js, js/app-state.js, js/ui.js
// Map: Leaflet.js (loaded dynamically, no API key required)

import { supabase } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason } from '../../js/app-state.js';
import { showToast, showModal, closeModal, confirm } from '../../js/ui.js';

// ── Constants ─────────────────────────────────────────────────────────────────

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

// ── State ─────────────────────────────────────────────────────────────────────
let map             = null;   // Leaflet map instance
let paddockLayers   = {};     // { paddockId: L.layer }
let drawLayer       = null;
let selectedPaddock = null;
let activeTab       = 'map';
let allPaddocks     = [];
let allVisits       = [];
let allSprayRecords = [];
let allPaddockSeasons = [];
let realtimeSubs    = [];
let editingPaddockId = null;  // inline edit state

// ── Mount ─────────────────────────────────────────────────────────────────────

export async function mountAgronomy(container) {
  container.innerHTML = buildShell();
  await loadLeaflet();
  await refreshAll();
  setupRealtime();
  bindTabNav();
  switchTab('map');
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

    <div id="agro-tab-map"   class="agro-tab"></div>
    <div id="agro-tab-paddocks" class="agro-tab" style="display:none"></div>
    <div id="agro-tab-visits"   class="agro-tab" style="display:none"></div>
    <div id="agro-tab-spray"    class="agro-tab" style="display:none"></div>
  `;
}

// ── Data Loading ─────────────────────────────────────────────────────────────

async function refreshAll() {
  const farmId = getActiveFarm();
  const season = getActiveSeason();

  const [p, ps, v, s] = await Promise.all([
    supabase.from('paddocks').select('*').eq('farm_id', farmId).eq('active', true).order('name'),
    supabase.from('paddock_seasons').select('*').eq('farm_id', farmId).eq('season', season),
    supabase.from('agronomy_visits').select('*').eq('farm_id', farmId).order('visit_date', { ascending: false }),
    supabase.from('spray_records').select('*, paddocks(name)').eq('farm_id', farmId).order('application_date', { ascending: false }),
  ]);

  if (p.error)  console.error('paddocks:', p.error);
  if (ps.error) console.error('paddock_seasons:', ps.error);
  if (v.error)  console.error('visits:', v.error);
  if (s.error)  console.error('spray:', s.error);

  allPaddocks       = p.data  || [];
  allPaddockSeasons = ps.data || [];
  allVisits         = v.data  || [];
  allSprayRecords   = s.data  || [];

  renderActiveTab();
}

// ── Realtime ─────────────────────────────────────────────────────────────────

function setupRealtime() {
  const farmId = getActiveFarm();
  const tables = ['paddocks','paddock_seasons','agronomy_visits','spray_records'];
  realtimeSubs.forEach(s => s.unsubscribe());
  realtimeSubs = tables.map(t =>
    supabase.channel(`agro_${t}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: t,
          filter: `farm_id=eq.${farmId}` }, () => refreshAll())
      .subscribe()
  );
}

// ── Tab Navigation ────────────────────────────────────────────────────────────

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
    el.style.display = el.id === `agro-tab-${tab}` ? '' : 'none');
  renderActiveTab();
}

function renderActiveTab() {
  if (activeTab === 'map')      renderMap();
  if (activeTab === 'paddocks') renderPaddocksTab();
  if (activeTab === 'visits')   renderVisitsTab();
  if (activeTab === 'spray')    renderSprayTab();
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: MAP
// ══════════════════════════════════════════════════════════════════════════════

async function renderMap() {
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
      <div class="map-legend card mt-2">
        <div class="card-body py-2 flex gap-4 flex-wrap">
          ${Object.entries(CROP_COLOURS).map(([k,v]) =>
            `<span class="legend-item"><span class="legend-dot" style="background:${v}"></span>${k}</span>`
          ).join('')}
          <span class="legend-item"><span class="legend-dot legend-dot--warning"></span>Active withholding</span>
        </div>
      </div>
    `;
  }

  initLeafletMap();
  drawPaddockPolygons();
}

function initLeafletMap() {
  if (map) return; // already initialised
  if (!window.L) { console.error('Leaflet not loaded'); return; }

  // Default centre: Douglas Daly, NT (Blackbull Station area)
  map = L.map('farm-map', { zoomControl: true }).setView([-14.1, 131.7], 12);

  // Base layers
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 20
  });
  const satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, Maxar, GeoEye', maxZoom: 20
  });
  osm.addTo(map);
  L.control.layers({ 'Map': osm, 'Satellite': satellite }, {}, { position: 'topright' }).addTo(map);

  // Draw control for new paddocks
  if (window.L.Control && window.L.Control.Draw) {
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    drawLayer = drawnItems;
    const drawControl = new L.Control.Draw({
      draw: { polygon: { shapeOptions: { color: '#22c55e' } }, polyline: false,
               rectangle: false, circle: false, marker: false, circlemarker: false },
      edit: { featureGroup: drawnItems }
    });
    map.addControl(drawControl);
    map.on(L.Draw.Event.CREATED, e => {
      drawnItems.addLayer(e.layer);
      promptNewPaddockFromDraw(e.layer.toGeoJSON());
    });
  }
}

function drawPaddockPolygons() {
  if (!map) return;
  // Remove existing paddock layers
  Object.values(paddockLayers).forEach(l => map.removeLayer(l));
  paddockLayers = {};

  const season = getActiveSeason();
  const today = new Date().toISOString().slice(0,10);

  allPaddocks.forEach(p => {
    if (!p.geometry) return;

    const season_row = allPaddockSeasons.find(ps => ps.paddock_id === p.id);
    const cropType   = season_row?.crop_type || 'Other';
    const colour     = CROP_COLOURS[cropType] || CROP_COLOURS['Other'];

    // Check active withholding
    const hasWithholding = allSprayRecords.some(s =>
      s.paddock_id === p.id && s.withholding_expires_date && s.withholding_expires_date >= today);

    const geojson = typeof p.geometry === 'string' ? JSON.parse(p.geometry) : p.geometry;
    const layer = L.geoJSON(geojson, {
      style: {
        color:       hasWithholding ? '#ef4444' : colour,
        fillColor:   colour,
        fillOpacity: 0.35,
        weight:      hasWithholding ? 3 : 2,
        dashArray:   hasWithholding ? '6,4' : null,
      }
    });

    // Label
    layer.bindTooltip(p.name, { permanent: true, direction: 'center',
      className: 'paddock-label' });

    layer.on('click', () => openMapSidebar(p));
    layer.addTo(map);
    paddockLayers[p.id] = layer;
  });

  // Fit bounds if paddocks exist
  const withGeo = allPaddocks.filter(p => p.geometry);
  if (withGeo.length) {
    const group = L.featureGroup(Object.values(paddockLayers));
    if (group.getLayers().length) map.fitBounds(group.getBounds(), { padding: [40,40] });
  }
}

function openMapSidebar(paddock) {
  selectedPaddock = paddock;
  const sidebar = document.getElementById('map-sidebar');
  const content = document.getElementById('map-sidebar-content');
  if (!sidebar || !content) return;

  sidebar.classList.remove('map-sidebar--closed');

  const season_row   = allPaddockSeasons.find(ps => ps.paddock_id === paddock.id);
  const lastVisit    = allVisits.find(v => v.paddock_ids?.includes(paddock.id));
  const today        = new Date().toISOString().slice(0,10);
  const activeWH     = allSprayRecords.filter(s =>
    s.paddock_id === paddock.id && s.withholding_expires_date && s.withholding_expires_date >= today);
  const sprayHistory = allSprayRecords.filter(s => s.paddock_id === paddock.id).slice(0, 5);

  content.innerHTML = `
    <div class="sidebar-header">
      <h3>${paddock.name}</h3>
      <button class="btn-icon" onclick="document.getElementById('map-sidebar').classList.add('map-sidebar--closed')">✕</button>
    </div>

    <div class="sidebar-section">
      <div class="detail-grid">
        <span class="detail-label">Area</span><span>${paddock.area_ha ? paddock.area_ha + ' ha' : '—'}</span>
        <span class="detail-label">Soil</span><span>${paddock.soil_type || '—'}</span>
        <span class="detail-label">Irrigation</span><span>${paddock.irrigation_type || '—'}</span>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-title">Current Season — ${getActiveSeason()}</div>
      ${season_row ? `
        <div class="detail-grid">
          <span class="detail-label">Commodity</span><span>${season_row.commodity || '—'}</span>
          <span class="detail-label">Crop Type</span><span>${season_row.crop_type || '—'}</span>
          <span class="detail-label">Variety</span><span>${season_row.variety || '—'}</span>
          <span class="detail-label">Planted</span><span>${season_row.planted_date || '—'}</span>
          <span class="detail-label">Area</span><span>${season_row.area_planted_ha ? season_row.area_planted_ha + ' ha' : '—'}</span>
        </div>
      ` : `<p class="text-muted small">No crop recorded for this season.
        <a href="#" onclick="window.cfmAgroEditSeason('${paddock.id}'); return false">Add crop →</a></p>`}
    </div>

    ${activeWH.length ? `
    <div class="sidebar-section">
      <div class="sidebar-section-title withholding-title">⚠ Active Withholding Periods</div>
      ${activeWH.map(s => `
        <div class="withholding-badge">
          <strong>${s.product_name}</strong>
          <span>Expires ${fmtDate(s.withholding_expires_date)}</span>
        </div>
      `).join('')}
    </div>
    ` : ''}

    ${lastVisit ? `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Last Visit — ${fmtDate(lastVisit.visit_date)}</div>
      <p class="small"><em>${lastVisit.agronomist_name}</em></p>
      <p class="small">${lastVisit.recommendations?.slice(0,200) || lastVisit.observations?.slice(0,200) || '—'}
        ${(lastVisit.recommendations?.length || 0) > 200 ? '…' : ''}</p>
    </div>
    ` : ''}

    ${sprayHistory.length ? `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Recent Spray Records</div>
      <table class="mini-table">
        <thead><tr><th>Date</th><th>Product</th><th>Rate</th></tr></thead>
        <tbody>
          ${sprayHistory.map(s => `
            <tr>
              <td>${fmtDate(s.application_date)}</td>
              <td>${s.product_name}</td>
              <td>${s.rate_per_ha ? s.rate_per_ha + ' ' + (s.rate_unit||'L/ha') : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <div class="sidebar-actions">
      <button class="btn btn-sm btn-secondary" onclick="window.cfmAgroEditSeason('${paddock.id}')">Edit Season</button>
      <button class="btn btn-sm btn-primary" onclick="window.cfmAgroNewVisit('${paddock.id}')">Log Visit</button>
      <button class="btn btn-sm btn-secondary" onclick="window.cfmAgroNewSpray('${paddock.id}')">Add Spray</button>
    </div>
  `;
}

function promptNewPaddockFromDraw(geojson) {
  showModal('New Paddock', buildPaddockForm({ geometry: geojson }), async () => {
    await savePaddockFromForm(null, geojson);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: PADDOCKS REGISTRY
// ══════════════════════════════════════════════════════════════════════════════

function renderPaddocksTab() {
  const container = document.getElementById('agro-tab-paddocks');
  if (!container) return;

  const season = getActiveSeason();

  container.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span>Paddock Registry</span>
        <button class="btn btn-primary btn-sm" id="add-paddock-btn">+ Add Paddock</button>
      </div>
      <div class="table-wrap">
        <table class="data-table" id="paddocks-table">
          <thead>
            <tr>
              <th>Paddock</th>
              <th>Area (ha)</th>
              <th>Soil Type</th>
              <th>Irrigation</th>
              <th>${season} Crop</th>
              <th>${season} Variety</th>
              <th>${season} Planted</th>
              <th>Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="paddocks-tbody">
            ${allPaddocks.length === 0
              ? `<tr><td colspan="9" class="empty-cell">No paddocks recorded. Click "+ Add Paddock" to begin.</td></tr>`
              : allPaddocks.map(p => renderPaddockRow(p, false)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('add-paddock-btn')?.addEventListener('click', () => {
    showModal('New Paddock', buildPaddockForm({}), () => savePaddockFromForm(null, null));
  });

  bindPaddockRowEvents();
}

function renderPaddockRow(p, editing) {
  const season_row = allPaddockSeasons.find(ps => ps.paddock_id === p.id);

  if (editing) {
    return `
      <tr data-id="${p.id}" class="editing-row">
        <td><input class="inline-input" name="name" value="${esc(p.name)}" required></td>
        <td><input class="inline-input" name="area_ha" type="number" step="0.01" value="${p.area_ha||''}"></td>
        <td>
          <select class="inline-input" name="soil_type">
            <option value="">—</option>
            ${SOIL_TYPES.map(s => `<option ${p.soil_type===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="inline-input" name="irrigation_type">
            <option value="">—</option>
            ${IRRIGATION_TYPES.map(s => `<option ${p.irrigation_type===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </td>
        <td>
          <select class="inline-input" name="ps_crop_type">
            <option value="">—</option>
            ${CROP_TYPE_OPTIONS.map(s => `<option ${season_row?.crop_type===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </td>
        <td><input class="inline-input" name="ps_variety" value="${esc(season_row?.variety||'')}"></td>
        <td><input class="inline-input" name="ps_planted_date" type="date" value="${season_row?.planted_date||''}"></td>
        <td><input class="inline-input" name="notes" value="${esc(p.notes||'')}"></td>
        <td class="row-actions">
          <button class="btn-link save-paddock-btn" data-id="${p.id}">Save</button>
          <button class="btn-link cancel-paddock-btn" data-id="${p.id}">Cancel</button>
        </td>
      </tr>
    `;
  }

  return `
    <tr data-id="${p.id}">
      <td>${esc(p.name)}</td>
      <td>${p.area_ha ? p.area_ha + ' ha' : '—'}</td>
      <td>${p.soil_type || '—'}</td>
      <td>${p.irrigation_type || '—'}</td>
      <td>${season_row?.crop_type || '—'}</td>
      <td>${season_row?.variety || '—'}</td>
      <td>${season_row?.planted_date ? fmtDate(season_row.planted_date) : '—'}</td>
      <td class="notes-cell">${esc(p.notes||'')}</td>
      <td class="row-actions">
        <button class="btn-link edit-paddock-btn" data-id="${p.id}">Edit</button>
        <button class="btn-link danger delete-paddock-btn" data-id="${p.id}">Archive</button>
      </td>
    </tr>
  `;
}

function bindPaddockRowEvents() {
  const tbody = document.getElementById('paddocks-tbody');
  if (!tbody) return;

  tbody.addEventListener('click', async e => {
    const id = e.target.dataset.id;
    if (!id) return;

    if (e.target.classList.contains('edit-paddock-btn')) {
      editingPaddockId = id;
      const row = tbody.querySelector(`tr[data-id="${id}"]`);
      const p   = allPaddocks.find(p => p.id === id);
      if (row && p) row.outerHTML = renderPaddockRow(p, true);
      bindPaddockRowEvents();
    }

    if (e.target.classList.contains('cancel-paddock-btn')) {
      editingPaddockId = null;
      const p = allPaddocks.find(p => p.id === id);
      const row = tbody.querySelector(`tr[data-id="${id}"]`);
      if (row && p) row.outerHTML = renderPaddockRow(p, false);
      bindPaddockRowEvents();
    }

    if (e.target.classList.contains('save-paddock-btn')) {
      await saveInlinePaddock(id, tbody);
    }

    if (e.target.classList.contains('delete-paddock-btn')) {
      const p = allPaddocks.find(p => p.id === id);
      if (await confirm(`Archive paddock "${p?.name}"? It will be hidden but data retained.`)) {
        const { error } = await supabase.from('paddocks').update({ active: false }).eq('id', id);
        if (error) showToast('Error archiving paddock', 'error');
        else { showToast('Paddock archived'); await refreshAll(); }
      }
    }
  });
}

async function saveInlinePaddock(id, tbody) {
  const row  = tbody.querySelector(`tr[data-id="${id}"]`);
  if (!row) return;

  const g = n => row.querySelector(`[name="${n}"]`)?.value?.trim() || null;
  const season = getActiveSeason();
  const farmId = getActiveFarm();

  const paddockData = {
    name:            g('name'),
    area_ha:         g('area_ha') ? parseFloat(g('area_ha')) : null,
    soil_type:       g('soil_type'),
    irrigation_type: g('irrigation_type'),
    notes:           g('notes'),
    updated_at:      new Date().toISOString(),
  };
  const cropType  = g('ps_crop_type');
  const variety   = g('ps_variety');
  const planted   = g('ps_planted_date');

  if (!paddockData.name) { showToast('Paddock name is required', 'error'); return; }

  const { error: pe } = await supabase.from('paddocks').update(paddockData).eq('id', id);
  if (pe) { showToast('Error saving paddock: ' + pe.message, 'error'); return; }

  // Upsert paddock_season
  const existingSeason = allPaddockSeasons.find(ps => ps.paddock_id === id);
  if (cropType || variety || planted) {
    const psData = { paddock_id: id, farm_id: farmId, season, commodity: resolveCommodity(cropType),
                     crop_type: cropType, variety, planted_date: planted, updated_at: new Date().toISOString() };
    if (existingSeason) {
      await supabase.from('paddock_seasons').update(psData).eq('id', existingSeason.id);
    } else {
      await supabase.from('paddock_seasons').insert({ ...psData });
    }
  }

  editingPaddockId = null;
  showToast('Paddock saved');
  await refreshAll();
}

function buildPaddockForm(defaults = {}) {
  return `
    <div class="form-grid form-grid-2">
      <div class="form-group">
        <label>Paddock Name *</label>
        <input class="form-control" id="pf-name" value="${esc(defaults.name||'')}">
      </div>
      <div class="form-group">
        <label>Area (ha)</label>
        <input class="form-control" id="pf-area" type="number" step="0.01" value="${defaults.area_ha||''}">
      </div>
      <div class="form-group">
        <label>Soil Type</label>
        <select class="form-control" id="pf-soil">
          <option value="">—</option>
          ${SOIL_TYPES.map(s => `<option>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Irrigation Type</label>
        <select class="form-control" id="pf-irrigation">
          <option value="">—</option>
          ${IRRIGATION_TYPES.map(s => `<option>${s}</option>`).join('')}
        </select>
      </div>
      <div class="form-group form-group--full">
        <label>Notes</label>
        <textarea class="form-control" id="pf-notes" rows="2">${esc(defaults.notes||'')}</textarea>
      </div>
    </div>
  `;
}

async function savePaddockFromForm(existingId, geometry) {
  const farmId = getActiveFarm();
  const data = {
    farm_id:         farmId,
    name:            document.getElementById('pf-name')?.value?.trim(),
    area_ha:         parseFloat(document.getElementById('pf-area')?.value) || null,
    soil_type:       document.getElementById('pf-soil')?.value || null,
    irrigation_type: document.getElementById('pf-irrigation')?.value || null,
    notes:           document.getElementById('pf-notes')?.value?.trim() || null,
    geometry:        geometry || null,
  };
  if (!data.name) { showToast('Paddock name is required', 'error'); return; }
  const { error } = existingId
    ? await supabase.from('paddocks').update(data).eq('id', existingId)
    : await supabase.from('paddocks').insert(data);
  if (error) showToast('Error saving: ' + error.message, 'error');
  else { showToast('Paddock saved'); closeModal(); await refreshAll(); }
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: VISITS & RECOMMENDATIONS
// ══════════════════════════════════════════════════════════════════════════════

function renderVisitsTab() {
  const container = document.getElementById('agro-tab-visits');
  if (!container) return;

  // Build paddock filter options
  const paddockFilter = document.getElementById('visit-filter-paddock')?.value || '';
  const followupOnly  = document.getElementById('visit-filter-followup')?.checked || false;

  let visits = allVisits;
  if (paddockFilter) visits = visits.filter(v => v.paddock_ids?.includes(paddockFilter));
  if (followupOnly)  visits = visits.filter(v => v.follow_up_required && !v.follow_up_completed);

  const today = new Date().toISOString().slice(0,10);
  const overdue = allVisits.filter(v => v.follow_up_required && !v.follow_up_completed && v.follow_up_date < today);

  container.innerHTML = `
    ${overdue.length ? `
      <div class="alert alert-warning mb-3">
        ⚠ ${overdue.length} follow-up${overdue.length>1?'s':''} overdue —
        ${overdue.map(v => `<strong>${v.agronomist_name}</strong> (${fmtDate(v.visit_date)})`).join(', ')}
      </div>` : ''}

    <div class="card">
      <div class="card-header">
        <div class="flex gap-2 flex-wrap">
          <select class="form-control form-control--sm" id="visit-filter-paddock" onchange="window.cfmAgroRenderVisits()">
            <option value="">All paddocks</option>
            ${allPaddocks.map(p => `<option value="${p.id}" ${paddockFilter===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
          </select>
          <label class="checkbox-label">
            <input type="checkbox" id="visit-filter-followup" ${followupOnly?'checked':''} onchange="window.cfmAgroRenderVisits()">
            Follow-ups pending
          </label>
        </div>
        <button class="btn btn-primary btn-sm" id="add-visit-btn">+ Log Visit</button>
      </div>

      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Agronomist</th>
              <th>Type</th>
              <th>Paddocks</th>
              <th>Observations</th>
              <th>Recommendations</th>
              <th>Follow-up</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${visits.length === 0
              ? `<tr><td colspan="8" class="empty-cell">No visits recorded.</td></tr>`
              : visits.map(v => renderVisitRow(v)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('add-visit-btn')?.addEventListener('click', () => openVisitModal(null));

  document.querySelectorAll('.edit-visit-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const visit = allVisits.find(v => v.id === btn.dataset.id);
      if (visit) openVisitModal(visit);
    })
  );

  document.querySelectorAll('.delete-visit-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      if (await confirm('Delete this visit record?')) {
        await supabase.from('agronomy_visits').delete().eq('id', btn.dataset.id);
        showToast('Visit deleted');
        await refreshAll();
      }
    })
  );

  document.querySelectorAll('.complete-followup-btn').forEach(btn =>
    btn.addEventListener('click', async () => {
      await supabase.from('agronomy_visits')
        .update({ follow_up_completed: true, updated_at: new Date().toISOString() })
        .eq('id', btn.dataset.id);
      showToast('Follow-up marked complete');
      await refreshAll();
    })
  );
}

function renderVisitRow(v) {
  const paddockNames = (v.paddock_ids || [])
    .map(id => allPaddocks.find(p => p.id === id)?.name || '?')
    .join(', ');
  const today = new Date().toISOString().slice(0,10);
  const followupOverdue = v.follow_up_required && !v.follow_up_completed && v.follow_up_date < today;

  return `
    <tr>
      <td>${fmtDate(v.visit_date)}</td>
      <td>
        <strong>${esc(v.agronomist_name)}</strong>
        ${v.agronomist_company ? `<br><small class="text-muted">${esc(v.agronomist_company)}</small>` : ''}
      </td>
      <td><span class="badge badge--${v.agronomist_type}">${v.agronomist_type}</span></td>
      <td class="small">${paddockNames || '—'}</td>
      <td class="notes-cell small">${esc((v.observations||'').slice(0,100))}${(v.observations||'').length>100?'…':''}</td>
      <td class="notes-cell small">${esc((v.recommendations||'').slice(0,100))}${(v.recommendations||'').length>100?'…':''}</td>
      <td>
        ${v.follow_up_required && !v.follow_up_completed
          ? `<span class="badge badge--${followupOverdue ? 'danger' : 'warning'}">
               ${followupOverdue ? '⚠ Overdue' : 'Due ' + fmtDate(v.follow_up_date)}
             </span>
             <button class="btn-link small complete-followup-btn" data-id="${v.id}">Done</button>`
          : v.follow_up_completed
          ? '<span class="badge badge--success">Complete</span>'
          : '—'}
      </td>
      <td class="row-actions">
        <button class="btn-link edit-visit-btn" data-id="${v.id}">Edit</button>
        <button class="btn-link danger delete-visit-btn" data-id="${v.id}">Del</button>
      </td>
    </tr>
  `;
}

function openVisitModal(existing) {
  const isEdit = !!existing;
  const v = existing || {};

  const paddockCheckboxes = allPaddocks.map(p => `
    <label class="checkbox-label">
      <input type="checkbox" class="visit-paddock-cb" value="${p.id}"
        ${(v.paddock_ids||[]).includes(p.id) ? 'checked' : ''}>
      ${esc(p.name)}
    </label>
  `).join('');

  const html = `
    <div class="form-grid form-grid-2">
      <div class="form-group">
        <label>Visit Date *</label>
        <input class="form-control" id="vf-date" type="date" value="${v.visit_date || today()}">
      </div>
      <div class="form-group">
        <label>Agronomist Type *</label>
        <select class="form-control" id="vf-type">
          <option value="external" ${v.agronomist_type==='external'?'selected':''}>External</option>
          <option value="internal" ${v.agronomist_type==='internal'?'selected':''}>Internal</option>
        </select>
      </div>
      <div class="form-group">
        <label>Agronomist Name *</label>
        <input class="form-control" id="vf-name" value="${esc(v.agronomist_name||'')}">
      </div>
      <div class="form-group">
        <label>Company / Employer</label>
        <input class="form-control" id="vf-company" value="${esc(v.agronomist_company||'')}">
      </div>
      <div class="form-group form-group--full">
        <label>Paddocks Visited</label>
        <div class="checkbox-group">${paddockCheckboxes || '<em class="text-muted">No paddocks registered yet.</em>'}</div>
      </div>
      <div class="form-group form-group--full">
        <label>Observations</label>
        <textarea class="form-control" id="vf-observations" rows="3">${esc(v.observations||'')}</textarea>
      </div>
      <div class="form-group form-group--full">
        <label>Recommendations</label>
        <textarea class="form-control" id="vf-recommendations" rows="3">${esc(v.recommendations||'')}</textarea>
      </div>
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="vf-followup-req" ${v.follow_up_required?'checked':''}
            onchange="document.getElementById('vf-followup-date-wrap').style.display=this.checked?'':'none'">
          Follow-up required
        </label>
      </div>
      <div class="form-group" id="vf-followup-date-wrap" style="${v.follow_up_required?'':'display:none'}">
        <label>Follow-up Date</label>
        <input class="form-control" id="vf-followup-date" type="date" value="${v.follow_up_date||''}">
      </div>
    </div>
  `;

  showModal(isEdit ? 'Edit Visit' : 'Log Agronomist Visit', html, async () => {
    const farmId = getActiveFarm();
    const paddockIds = [...document.querySelectorAll('.visit-paddock-cb:checked')].map(el => el.value);
    const data = {
      farm_id:             farmId,
      visit_date:          document.getElementById('vf-date')?.value,
      agronomist_name:     document.getElementById('vf-name')?.value?.trim(),
      agronomist_type:     document.getElementById('vf-type')?.value,
      agronomist_company:  document.getElementById('vf-company')?.value?.trim() || null,
      paddock_ids:         paddockIds,
      observations:        document.getElementById('vf-observations')?.value?.trim() || null,
      recommendations:     document.getElementById('vf-recommendations')?.value?.trim() || null,
      follow_up_required:  document.getElementById('vf-followup-req')?.checked || false,
      follow_up_date:      document.getElementById('vf-followup-date')?.value || null,
      updated_at:          new Date().toISOString(),
    };
    if (!data.visit_date || !data.agronomist_name) {
      showToast('Date and agronomist name are required', 'error'); return;
    }
    const { error } = isEdit
      ? await supabase.from('agronomy_visits').update(data).eq('id', existing.id)
      : await supabase.from('agronomy_visits').insert(data);
    if (error) showToast('Error saving: ' + error.message, 'error');
    else { showToast('Visit saved'); closeModal(); await refreshAll(); }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// TAB: SPRAY RECORDS
// ══════════════════════════════════════════════════════════════════════════════

function renderSprayTab() {
  const container = document.getElementById('agro-tab-spray');
  if (!container) return;

  const today = new Date().toISOString().slice(0,10);
  const activeWH = allSprayRecords.filter(s =>
    s.withholding_expires_date && s.withholding_expires_date >= today);

  const filterPaddock = document.getElementById('spray-filter-paddock')?.value || '';
  const filterType    = document.getElementById('spray-filter-type')?.value || '';
  const filterWH      = document.getElementById('spray-filter-wh')?.checked || false;

  let records = allSprayRecords;
  if (filterPaddock) records = records.filter(r => r.paddock_id === filterPaddock);
  if (filterType)    records = records.filter(r => r.application_type === filterType);
  if (filterWH)      records = records.filter(r => r.withholding_expires_date >= today);

  container.innerHTML = `
    ${activeWH.length ? `
      <div class="alert alert-warning mb-3">
        ⚠ <strong>${activeWH.length} active withholding period${activeWH.length>1?'s':''}</strong> —
        ${activeWH.map(s => `${allPaddocks.find(p=>p.id===s.paddock_id)?.name||'?'}: ${s.product_name} (exp. ${fmtDate(s.withholding_expires_date)})`).join(' | ')}
      </div>` : ''}

    <div class="card">
      <div class="card-header">
        <div class="flex gap-2 flex-wrap">
          <select class="form-control form-control--sm" id="spray-filter-paddock" onchange="window.cfmAgroRenderSpray()">
            <option value="">All paddocks</option>
            ${allPaddocks.map(p => `<option value="${p.id}" ${filterPaddock===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
          </select>
          <select class="form-control form-control--sm" id="spray-filter-type" onchange="window.cfmAgroRenderSpray()">
            <option value="">All types</option>
            ${APP_TYPES.map(t => `<option value="${t}" ${filterType===t?'selected':''}>${cap(t)}</option>`).join('')}
          </select>
          <label class="checkbox-label">
            <input type="checkbox" id="spray-filter-wh" ${filterWH?'checked':''} onchange="window.cfmAgroRenderSpray()">
            Active withholding only
          </label>
        </div>
        <button class="btn btn-primary btn-sm" id="add-spray-btn">+ Add Record</button>
      </div>

      <div class="table-wrap">
        <table class="data-table" id="spray-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Paddock</th>
              <th>Product</th>
              <th>Type</th>
              <th>Rate</th>
              <th>Area (ha)</th>
              <th>Total Qty</th>
              <th>Operator</th>
              <th>WHP Expires</th>
              <th>Weather</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="spray-tbody">
            ${records.length === 0
              ? `<tr><td colspan="11" class="empty-cell">No spray records found.</td></tr>`
              : records.map(r => renderSprayRow(r, false)).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('add-spray-btn')?.addEventListener('click', () => openSprayModal(null, null));
  bindSprayRowEvents();
}

function renderSprayRow(r, editing) {
  const paddockName = allPaddocks.find(p => p.id === r.paddock_id)?.name || r.paddocks?.name || '—';
  const today = new Date().toISOString().slice(0,10);
  const whExpired  = r.withholding_expires_date && r.withholding_expires_date < today;
  const whActive   = r.withholding_expires_date && r.withholding_expires_date >= today;

  if (editing) {
    return `
      <tr data-id="${r.id}" class="editing-row">
        <td><input class="inline-input" name="application_date" type="date" value="${r.application_date||''}"></td>
        <td>
          <select class="inline-input" name="paddock_id">
            ${allPaddocks.map(p => `<option value="${p.id}" ${r.paddock_id===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
          </select>
        </td>
        <td><input class="inline-input" name="product_name" value="${esc(r.product_name||'')}"></td>
        <td>
          <select class="inline-input" name="application_type">
            ${APP_TYPES.map(t => `<option value="${t}" ${r.application_type===t?'selected':''}>${cap(t)}</option>`).join('')}
          </select>
        </td>
        <td>
          <div class="flex gap-1">
            <input class="inline-input" style="width:60px" name="rate_per_ha" type="number" step="0.001" value="${r.rate_per_ha||''}">
            <input class="inline-input" style="width:55px" name="rate_unit" value="${esc(r.rate_unit||'L/ha')}">
          </div>
        </td>
        <td><input class="inline-input" name="total_area_ha" type="number" step="0.01" value="${r.total_area_ha||''}"></td>
        <td>
          <div class="flex gap-1">
            <input class="inline-input" style="width:65px" name="total_qty" type="number" step="0.001" value="${r.total_qty||''}">
            <input class="inline-input" style="width:45px" name="qty_unit" value="${esc(r.qty_unit||'L')}">
          </div>
        </td>
        <td><input class="inline-input" name="operator" value="${esc(r.operator||'')}"></td>
        <td><input class="inline-input" name="withholding_period_days" type="number" min="0" value="${r.withholding_period_days||''}"> days</td>
        <td><input class="inline-input" name="weather_conditions" value="${esc(r.weather_conditions||'')}"></td>
        <td class="row-actions">
          <button class="btn-link save-spray-btn" data-id="${r.id}">Save</button>
          <button class="btn-link cancel-spray-btn" data-id="${r.id}">Cancel</button>
        </td>
      </tr>
    `;
  }

  return `
    <tr data-id="${r.id}">
      <td>${fmtDate(r.application_date)}</td>
      <td>${esc(paddockName)}</td>
      <td>
        <strong>${esc(r.product_name)}</strong>
        ${r.active_ingredient ? `<br><small class="text-muted">${esc(r.active_ingredient)}</small>` : ''}
      </td>
      <td><span class="badge badge--${r.application_type}">${cap(r.application_type||'')}</span></td>
      <td>${r.rate_per_ha ? r.rate_per_ha + ' ' + (r.rate_unit||'L/ha') : '—'}</td>
      <td>${r.total_area_ha ? r.total_area_ha + ' ha' : '—'}</td>
      <td>${r.total_qty ? r.total_qty + ' ' + (r.qty_unit||'L') : '—'}</td>
      <td>${esc(r.operator||'—')}</td>
      <td>
        ${r.withholding_expires_date
          ? `<span class="badge badge--${whActive ? 'danger' : whExpired ? 'muted' : 'muted'}">
               ${whActive ? '⚠ ' : ''}${fmtDate(r.withholding_expires_date)}
             </span>`
          : '—'}
      </td>
      <td class="small">${esc(r.weather_conditions||'—')}</td>
      <td class="row-actions">
        <button class="btn-link edit-spray-btn" data-id="${r.id}">Edit</button>
        <button class="btn-link danger delete-spray-btn" data-id="${r.id}">Del</button>
      </td>
    </tr>
  `;
}

function bindSprayRowEvents() {
  const tbody = document.getElementById('spray-tbody');
  if (!tbody) return;

  tbody.addEventListener('click', async e => {
    const id = e.target.dataset.id;
    if (!id) return;

    if (e.target.classList.contains('edit-spray-btn')) {
      const r = allSprayRecords.find(r => r.id === id);
      const row = tbody.querySelector(`tr[data-id="${id}"]`);
      if (row && r) row.outerHTML = renderSprayRow(r, true);
      bindSprayRowEvents();
    }

    if (e.target.classList.contains('cancel-spray-btn')) {
      const r = allSprayRecords.find(r => r.id === id);
      const row = tbody.querySelector(`tr[data-id="${id}"]`);
      if (row && r) row.outerHTML = renderSprayRow(r, false);
      bindSprayRowEvents();
    }

    if (e.target.classList.contains('save-spray-btn')) {
      await saveInlineSpray(id, tbody);
    }

    if (e.target.classList.contains('delete-spray-btn')) {
      if (await confirm('Delete this spray record?')) {
        await supabase.from('spray_records').delete().eq('id', id);
        showToast('Record deleted');
        await refreshAll();
      }
    }
  });
}

async function saveInlineSpray(id, tbody) {
  const row = tbody.querySelector(`tr[data-id="${id}"]`);
  if (!row) return;
  const g = n => row.querySelector(`[name="${n}"]`)?.value?.trim() || null;

  const data = {
    application_date:       g('application_date'),
    paddock_id:             g('paddock_id'),
    product_name:           g('product_name'),
    application_type:       g('application_type'),
    rate_per_ha:            g('rate_per_ha') ? parseFloat(g('rate_per_ha')) : null,
    rate_unit:              g('rate_unit') || 'L/ha',
    total_area_ha:          g('total_area_ha') ? parseFloat(g('total_area_ha')) : null,
    total_qty:              g('total_qty') ? parseFloat(g('total_qty')) : null,
    qty_unit:               g('qty_unit') || 'L',
    operator:               g('operator'),
    withholding_period_days:g('withholding_period_days') ? parseInt(g('withholding_period_days')) : null,
    weather_conditions:     g('weather_conditions'),
    updated_at:             new Date().toISOString(),
  };

  if (!data.application_date || !data.product_name) {
    showToast('Date and product name are required', 'error'); return;
  }

  const { error } = await supabase.from('spray_records').update(data).eq('id', id);
  if (error) showToast('Error saving: ' + error.message, 'error');
  else { showToast('Spray record saved'); await refreshAll(); }
}

function openSprayModal(existingId, defaultPaddockId) {
  const r = existingId ? allSprayRecords.find(s => s.id === existingId) : {};
  const paddockId = defaultPaddockId || r?.paddock_id || '';

  const html = `
    <div class="form-grid form-grid-2">
      <div class="form-group">
        <label>Application Date *</label>
        <input class="form-control" id="sf-date" type="date" value="${r?.application_date || today()}">
      </div>
      <div class="form-group">
        <label>Paddock *</label>
        <select class="form-control" id="sf-paddock">
          <option value="">— Select —</option>
          ${allPaddocks.map(p => `<option value="${p.id}" ${paddockId===p.id?'selected':''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Product Name *</label>
        <input class="form-control" id="sf-product" value="${esc(r?.product_name||'')}">
      </div>
      <div class="form-group">
        <label>Active Ingredient</label>
        <input class="form-control" id="sf-ai" value="${esc(r?.active_ingredient||'')}">
      </div>
      <div class="form-group">
        <label>Application Type</label>
        <select class="form-control" id="sf-type">
          <option value="">—</option>
          ${APP_TYPES.map(t => `<option value="${t}" ${r?.application_type===t?'selected':''}>${cap(t)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Operator</label>
        <input class="form-control" id="sf-operator" value="${esc(r?.operator||'')}">
      </div>
      <div class="form-group">
        <label>Rate per Ha</label>
        <div class="input-group">
          <input class="form-control" id="sf-rate" type="number" step="0.001" value="${r?.rate_per_ha||''}">
          <input class="form-control input-unit" id="sf-rate-unit" value="${r?.rate_unit||'L/ha'}" placeholder="unit">
        </div>
      </div>
      <div class="form-group">
        <label>Total Area (ha)</label>
        <input class="form-control" id="sf-area" type="number" step="0.01" value="${r?.total_area_ha||''}">
      </div>
      <div class="form-group">
        <label>Total Quantity</label>
        <div class="input-group">
          <input class="form-control" id="sf-qty" type="number" step="0.001" value="${r?.total_qty||''}">
          <input class="form-control input-unit" id="sf-qty-unit" value="${r?.qty_unit||'L'}" placeholder="unit">
        </div>
      </div>
      <div class="form-group">
        <label>Withholding Period (days)</label>
        <input class="form-control" id="sf-whp" type="number" min="0" value="${r?.withholding_period_days||''}">
      </div>
      <div class="form-group">
        <label>Temp (°C)</label>
        <input class="form-control" id="sf-temp" type="number" step="0.1" value="${r?.weather_temp_c||''}">
      </div>
      <div class="form-group">
        <label>Wind (km/h)</label>
        <input class="form-control" id="sf-wind" type="number" step="0.1" value="${r?.weather_wind_kmh||''}">
      </div>
      <div class="form-group form-group--full">
        <label>Weather / Conditions</label>
        <input class="form-control" id="sf-weather" value="${esc(r?.weather_conditions||'')}">
      </div>
      <div class="form-group">
        <label>Application Method</label>
        <input class="form-control" id="sf-method" value="${esc(r?.application_method||'')}">
      </div>
      <div class="form-group form-group--full">
        <label>Notes</label>
        <textarea class="form-control" id="sf-notes" rows="2">${esc(r?.notes||'')}</textarea>
      </div>
    </div>
  `;

  showModal(existingId ? 'Edit Spray Record' : 'Add Spray Record', html, async () => {
    const farmId    = getActiveFarm();
    const paddockId = document.getElementById('sf-paddock')?.value;
    const season    = getActiveSeason();
    const psRow     = allPaddockSeasons.find(ps => ps.paddock_id === paddockId && ps.season === season);

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
      showToast('Date, paddock, and product name are required', 'error'); return;
    }
    const { error } = existingId
      ? await supabase.from('spray_records').update(data).eq('id', existingId)
      : await supabase.from('spray_records').insert(data);
    if (error) showToast('Error saving: ' + error.message, 'error');
    else { showToast('Spray record saved'); closeModal(); await refreshAll(); }
  });
}

// ── Season Edit Modal ─────────────────────────────────────────────────────────

function openSeasonModal(paddockId) {
  const paddock = allPaddocks.find(p => p.id === paddockId);
  const season  = getActiveSeason();
  const ps      = allPaddockSeasons.find(s => s.paddock_id === paddockId);

  if (!paddock) return;

  const html = `
    <h4 style="margin-top:0">${esc(paddock.name)} — ${season}</h4>
    <div class="form-grid form-grid-2">
      <div class="form-group">
        <label>Commodity</label>
        <select class="form-control" id="psf-commodity">
          <option value="">—</option>
          ${COMMODITY_OPTIONS.map(c => `<option ${ps?.commodity===c?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Crop Type</label>
        <select class="form-control" id="psf-crop-type">
          <option value="">—</option>
          ${CROP_TYPE_OPTIONS.map(c => `<option ${ps?.crop_type===c?'selected':''}>${c}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Variety</label>
        <input class="form-control" id="psf-variety" value="${esc(ps?.variety||'')}">
      </div>
      <div class="form-group">
        <label>Planted Date</label>
        <input class="form-control" id="psf-planted" type="date" value="${ps?.planted_date||''}">
      </div>
      <div class="form-group">
        <label>Area Planted (ha)</label>
        <input class="form-control" id="psf-area" type="number" step="0.01" value="${ps?.area_planted_ha||''}">
      </div>
      <div class="form-group form-group--full">
        <label>Notes</label>
        <textarea class="form-control" id="psf-notes" rows="2">${esc(ps?.notes||'')}</textarea>
      </div>
    </div>
  `;

  showModal('Edit Season Crop', html, async () => {
    const farmId = getActiveFarm();
    const data = {
      paddock_id:       paddockId,
      farm_id:          farmId,
      season,
      commodity:        document.getElementById('psf-commodity')?.value || null,
      crop_type:        document.getElementById('psf-crop-type')?.value || null,
      variety:          document.getElementById('psf-variety')?.value?.trim() || null,
      planted_date:     document.getElementById('psf-planted')?.value || null,
      area_planted_ha:  parseFloat(document.getElementById('psf-area')?.value) || null,
      notes:            document.getElementById('psf-notes')?.value?.trim() || null,
      updated_at:       new Date().toISOString(),
    };
    const { error } = ps
      ? await supabase.from('paddock_seasons').update(data).eq('id', ps.id)
      : await supabase.from('paddock_seasons').insert(data);
    if (error) showToast('Error saving: ' + error.message, 'error');
    else { showToast('Season crop saved'); closeModal(); await refreshAll(); }
  });
}

// ── Leaflet Dynamic Load ──────────────────────────────────────────────────────

async function loadLeaflet() {
  if (window.L) return;
  await Promise.all([
    loadCSS('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'),
    loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'),
  ]);
  // Leaflet Draw (polygon drawing tool)
  await Promise.all([
    loadCSS('https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.css'),
    loadScript('https://unpkg.com/leaflet-draw@1.0.4/dist/leaflet.draw.js'),
  ]);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

function loadCSS(href) {
  return new Promise(resolve => {
    if (document.querySelector(`link[href="${href}"]`)) { resolve(); return; }
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.onload = resolve;
    document.head.appendChild(l);
    setTimeout(resolve, 2000); // fallback
  });
}

// ── Global Hooks (called from inline HTML onclick) ────────────────────────────

window.cfmAgroEditSeason  = (paddockId) => openSeasonModal(paddockId);
window.cfmAgroNewVisit    = (paddockId) => openVisitModal(null, paddockId);
window.cfmAgroNewSpray    = (paddockId) => openSprayModal(null, paddockId);
window.cfmAgroRenderVisits= () => renderVisitsTab();
window.cfmAgroRenderSpray = () => renderSprayTab();

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' });
}

function today() {
  return new Date().toISOString().slice(0,10);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function cap(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

function resolveCommodity(cropType) {
  if (!cropType) return null;
  if (cropType.toLowerCase().includes('cotton')) return 'Cotton';
  if (['Winter Cereal','Summer Cereal'].includes(cropType)) return 'Grain';
  if (cropType === 'Pulse') return 'Chickpea';
  return cropType;
}
