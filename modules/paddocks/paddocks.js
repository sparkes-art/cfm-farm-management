// modules/paddocks/paddocks.js
import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatNumber, qs } from '../../js/ui.js';

const MAPBOX_TOKEN = window.__CFM_MAPBOX_TOKEN || '';

let _paddocks = [];
let _plantings = [];
let _view = 'list'; // 'list' or 'map'
let _map = null;
let _filter = '';

export async function mountPaddocks(container) {
  const farm = getActiveFarm();
  if (!farm) {
    container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Paddocks</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid)">${farm.name}</p>
      </div>
      <div class="flex gap-2 items-center">
        <input class="form-input" id="paddock-search" placeholder="Search paddocks…" style="width:200px">
        <div style="display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden">
          <button id="btn-list-view" class="btn btn-sm ${_view==='list'?'btn-primary':'btn-ghost'}" style="border-radius:0;border:none">☰ List</button>
          <button id="btn-map-view" class="btn btn-sm ${_view==='map'?'btn-primary':'btn-ghost'}" style="border-radius:0;border:none;border-left:1px solid var(--border)">🗺 Map</button>
        </div>
        ${canWrite() ? '<button class="btn btn-secondary" id="btn-add-paddock">＋ Add paddock</button>' : ''}
        ${canWrite() ? '<button class="btn btn-ghost btn-sm" id="btn-import-kml">⬆ Import KML</button>' : ''}
      </div>
    </div>

    <div id="paddock-content"></div>
  `;

  // Wire search
  qs('#paddock-search', container)?.addEventListener('input', e => {
    _filter = e.target.value.toLowerCase();
    _renderView(container, farm);
  });

  // Wire view toggle
  qs('#btn-list-view', container)?.addEventListener('click', () => {
    _view = 'list';
    qs('#btn-list-view', container).className = 'btn btn-sm btn-primary';
    qs('#btn-map-view', container).className = 'btn btn-sm btn-ghost';
    _renderView(container, farm);
  });
  qs('#btn-map-view', container)?.addEventListener('click', () => {
    _view = 'map';
    qs('#btn-map-view', container).className = 'btn btn-sm btn-primary';
    qs('#btn-list-view', container).className = 'btn btn-sm btn-ghost';
    _renderView(container, farm);
  });

  qs('#btn-add-paddock', container)?.addEventListener('click', () => _paddockModal(container, farm));
  qs('#btn-import-kml', container)?.addEventListener('click', () => _importModal(container, farm));

  await _loadData(farm);
  _renderView(container, farm);
}

export function unmountPaddocks() {
  if (_map) { _map.remove(); _map = null; }
  _paddocks = [];
}

async function _loadData(farm) {
  [_paddocks] = await Promise.all([
    dbSelect('paddocks', 'farm_id=eq.' + farm.id + '&select=*&order=name.asc'),
  ]);
  // Load planting records for crop colours on map
  try {
    _plantings = await dbSelect('planting_records', 'farm_id=eq.' + farm.id + '&status=eq.planted&select=paddock_id,crop_type,variety,plant_date');
  } catch { _plantings = []; }
}

function _filtered() {
  if (!_filter) return _paddocks;
  return _paddocks.filter(p => p.name.toLowerCase().includes(_filter) || (p.paddock_type||'').toLowerCase().includes(_filter) || (p.group_name||'').toLowerCase().includes(_filter));
}

function _renderView(container, farm) {
  if (_view === 'list') _renderList(container, farm);
  else _renderMap(container, farm);
}

// ── List view ─────────────────────────────────────────────────
function _renderList(container, farm) {
  if (_map) { _map.remove(); _map = null; }
  const paddocks = _filtered();
  const totalArea = paddocks.reduce((s,p) => s + (parseFloat(p.area_ha)||0), 0);

  qs('#paddock-content', container).innerHTML = `
    <div style="display:flex;gap:12px;margin-bottom:16px">
      ${[
        ['Total paddocks', paddocks.length],
        ['Total area', formatNumber(totalArea,1) + ' ha'],
        ['Active', _paddocks.filter(p=>p.is_active!==false).length],
      ].map(([l,v]) => `
        <div class="card" style="padding:12px 16px;flex:1">
          <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${l}</p>
          <p style="font-size:20px;font-weight:600;font-variant-numeric:tabular-nums">${v}</p>
        </div>`).join('')}
    </div>

    <div class="card" style="overflow:hidden">
      ${paddocks.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Name</th>
          <th>Group / block</th>
          <th>Type</th>
          <th class="num">Area (ha)</th>
          <th>Status</th>
          <th>Notes</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${paddocks.map(p => `<tr>
            <td><strong>${p.name}</strong></td>
            <td class="muted">${p.group_name||'—'}</td>
            <td class="muted">${p.paddock_type||'—'}</td>
            <td class="num">${p.area_ha ? formatNumber(p.area_ha,1) : '—'}</td>
            <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${p.is_active!==false?'#d1fae5':'#f3f4f6'};color:${p.is_active!==false?'#065f46':'#6b7280'}">${p.is_active!==false?'Active':'Inactive'}</span></td>
            <td class="muted" style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.notes||''}</td>
            ${canWrite() ? `<td>
              <div class="flex gap-1">
                <button class="btn btn-ghost btn-sm edit-paddock-btn" data-id="${p.id}">Edit</button>
                <button class="btn btn-ghost btn-sm delete-paddock-btn" data-id="${p.id}" style="color:var(--red)">✕</button>
              </div>
            </td>` : ''}
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty-state" style="padding:40px"><p>No paddocks found${_filter ? ' matching "'+_filter+'"' : ' for '+farm.name}.</p></div>`}
    </div>
  `;

  // Wire edit/delete
  container.querySelectorAll('.edit-paddock-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _paddocks.find(p => p.id === btn.dataset.id);
      if (p) _paddockModal(container, farm, p);
    });
  });
  container.querySelectorAll('.delete-paddock-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this paddock?')) return;
      await dbDelete('paddocks', btn.dataset.id);
      _paddocks = _paddocks.filter(p => p.id !== btn.dataset.id);
      _renderList(container, farm);
      toast('Paddock deleted', 'success');
    });
  });
}

// ── Map view ──────────────────────────────────────────────────
function _renderMap(container, farm) {
  const content = qs('#paddock-content', container);
  content.innerHTML = `<div id="paddock-map" style="height:calc(100vh - 180px);border-radius:10px;overflow:hidden;border:1px solid var(--border)"></div>`;

  // Load Mapbox
  if (!document.getElementById('mapbox-css')) {
    const link = document.createElement('link');
    link.id = 'mapbox-css';
    link.rel = 'stylesheet';
    link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css';
    document.head.appendChild(link);
  }

  const script = document.createElement('script');
  script.src = 'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js';
  script.onload = () => _initMap(farm);
  document.head.appendChild(script);

  if (window.mapboxgl) _initMap(farm);
}

function _initMap(farm) {
  if (_map) { _map.remove(); _map = null; }

  window.mapboxgl.accessToken = MAPBOX_TOKEN;

  // Find centre of paddocks with boundaries
  const withBoundary = _paddocks.filter(p => p.boundary);
  let centre = [145.5, -33.5]; // Merrowie default
  if (withBoundary.length) {
    const allCoords = withBoundary.flatMap(p => p.boundary.coordinates[0]);
    const lngs = allCoords.map(c => c[0]);
    const lats = allCoords.map(c => c[1]);
    centre = [(Math.min(...lngs)+Math.max(...lngs))/2, (Math.min(...lats)+Math.max(...lats))/2];
  }

  _map = new window.mapboxgl.Map({
    container: 'paddock-map',
    style: 'mapbox://styles/mapbox/satellite-streets-v12',
    center: centre,
    zoom: 12,
  });

  _map.addControl(new window.mapboxgl.NavigationControl());
  _map.addControl(new window.mapboxgl.FullscreenControl());

  _map.on('load', () => {
    const features = _paddocks
      .filter(p => p.boundary)
      .map(p => ({
        type: 'Feature',
        properties: { id: p.id, name: p.name, area: p.area_ha, type: p.paddock_type||'', group: p.group_name||'' },
        geometry: p.boundary,
      }));

    _map.addSource('paddocks', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features }
    });

    // Fill
    _map.addLayer({
      id: 'paddock-fill',
      type: 'fill',
      source: 'paddocks',
      paint: {
        'fill-color': '#185FA5',
        'fill-opacity': 0.15,
      }
    });

    // Outline
    _map.addLayer({
      id: 'paddock-outline',
      type: 'line',
      source: 'paddocks',
      paint: {
        'line-color': '#185FA5',
        'line-width': 1.5,
      }
    });

    // Labels
    _map.addLayer({
      id: 'paddock-labels',
      type: 'symbol',
      source: 'paddocks',
      layout: {
        'text-field': ['get', 'name'],
        'text-size': 11,
        'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#000000',
        'text-halo-width': 1,
      }
    });

    // Popup on click
    _map.on('click', 'paddock-fill', e => {
      const props = e.features[0].properties;
      new window.mapboxgl.Popup()
        .setLngLat(e.lngLat)
        .setHTML(`
          <div style="font-family:system-ui;padding:4px">
            <p style="font-weight:600;margin-bottom:4px">${props.name}</p>
            ${props.area ? '<p style="font-size:12px;color:#6b7280">'+parseFloat(props.area).toFixed(1)+' ha</p>' : ''}
            ${props.type ? '<p style="font-size:12px;color:#6b7280">'+props.type+'</p>' : ''}
            ${props.group ? '<p style="font-size:12px;color:#6b7280">Block: '+props.group+'</p>' : ''}
          </div>`)
        .addTo(_map);
    });

    _map.on('mouseenter', 'paddock-fill', () => { _map.getCanvas().style.cursor = 'pointer'; });
    _map.on('mouseleave', 'paddock-fill', () => { _map.getCanvas().style.cursor = ''; });

    // Fit to paddocks
    if (features.length) {
      const allCoords = features.flatMap(f => f.geometry.coordinates[0]);
      const lngs = allCoords.map(c => c[0]);
      const lats = allCoords.map(c => c[1]);
      _map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 40 });
    }
  });
}

// ── Modals ────────────────────────────────────────────────────
function _paddockModal(container, farm, existing = null) {
  openModal({
    title: existing ? 'Edit paddock' : 'Add paddock',
    confirmLabel: existing ? 'Save changes' : 'Add paddock',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Paddock name</label>
          <input class="form-input" id="pad-name" value="${existing?.name||''}" placeholder="e.g. North Flat">
        </div>
        <div class="form-group">
          <label class="form-label">Area (ha)</label>
          <input class="form-input num" id="pad-area" type="number" step="0.1" value="${existing?.area_ha||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Group / block</label>
          <input class="form-input" id="pad-group" value="${existing?.group_name||''}" placeholder="e.g. River block">
        </div>
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="pad-type">
            <option value="">— select —</option>
            ${['Irrigation','Dryland','Grazing','Fallow','Other'].map(t => `<option value="${t}" ${existing?.paddock_type===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="pad-status">
            <option value="true" ${existing?.is_active!==false?'selected':''}>Active</option>
            <option value="false" ${existing?.is_active===false?'selected':''}>Inactive</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="pad-notes" rows="2">${existing?.notes||''}</textarea>
      </div>
    `,
    onConfirm: async (modal) => {
      const row = {
        farm_id: farm.id,
        name: qs('#pad-name', modal)?.value?.trim(),
        area_ha: parseFloat(qs('#pad-area', modal)?.value)||null,
        group_name: qs('#pad-group', modal)?.value?.trim()||null,
        paddock_type: qs('#pad-type', modal)?.value||null,
        is_active: qs('#pad-status', modal)?.value === 'true',
        notes: qs('#pad-notes', modal)?.value?.trim()||null,
      };
      if (!row.name) throw new Error('Paddock name is required');
      if (existing) {
        await dbUpdate('paddocks', existing.id, row);
        Object.assign(_paddocks.find(p => p.id === existing.id), row);
        toast('Paddock updated', 'success');
      } else {
        const saved = await dbInsert('paddocks', row);
        _paddocks.push(saved);
        toast('Paddock added', 'success');
      }
      _renderView(container, farm);
    },
  });
}

function _importModal(container, farm) {
  let parsedPaddocks = [];

  openModal({
    title: 'Import paddocks from KML',
    confirmLabel: null,
    bodyHTML: `
      <p style="font-size:13px;color:var(--hint);margin-bottom:16px">Export from Ag World → Geographical view → Download KML</p>

      <div id="imp-drop" style="border:2px dashed var(--border);border-radius:8px;padding:24px;text-align:center;cursor:pointer;margin-bottom:12px">
        <p style="font-size:20px">📁</p>
        <p style="font-size:13px;color:var(--hint);margin-top:4px"><strong>Drop KML file here</strong> or click to browse</p>
        <input type="file" id="imp-file" accept=".kml" style="display:none">
      </div>
      <div id="imp-preview" style="display:none">
        <div style="overflow:auto;max-height:220px;border:1px solid var(--border);border-radius:6px;margin-bottom:12px">
          <table class="data-table" style="font-size:11px">
            <thead><tr><th>Name</th><th class="num">Ha</th><th>Crop</th><th>Boundary</th></tr></thead>
            <tbody id="imp-body"></tbody>
          </table>
        </div>
        <div class="progress" id="imp-progress" style="display:none"><div id="imp-bar" style="height:6px;width:0%;background:var(--blue);border-radius:3px;transition:width .2s"></div></div>
        <p id="imp-status" style="font-size:12px;color:var(--hint);margin-top:4px"></p>
        <button class="btn btn-primary" id="imp-run-btn" style="margin-top:8px">Import ${0} paddocks</button>
      </div>
    `,
    onConfirm: null,
  });

  setTimeout(() => {
    const modal = document.querySelector('.modal-body') || document.querySelector('[role="dialog"]') || document.body;
    const drop = document.getElementById('imp-drop');
    const fileInput = document.getElementById('imp-file');

    drop?.addEventListener('click', () => fileInput?.click());
    drop?.addEventListener('dragover', e => { e.preventDefault(); if(drop) drop.style.borderColor='var(--blue)'; });
    drop?.addEventListener('dragleave', () => { if(drop) drop.style.borderColor='var(--border)'; });
    drop?.addEventListener('drop', e => { e.preventDefault(); if(drop) drop.style.borderColor='var(--border)'; handleFile(e.dataTransfer.files[0]); });
    fileInput?.addEventListener('change', () => handleFile(fileInput.files[0]));

    function handleFile(file) {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => parseAndPreview(e.target.result);
      reader.readAsText(file);
    }

    function parseAndPreview(kmlText) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(kmlText, 'text/xml');
      parsedPaddocks = [];
      doc.querySelectorAll('Placemark').forEach(pm => {
        const get = n => pm.querySelector('SimpleData[name="'+n+'"]')?.textContent?.trim()||'';
        const name = get('paddock_name') || pm.querySelector('n')?.textContent?.trim()||'';
        const area = parseFloat(get('area'))||null;
        const cropName = get('crop_name');
        const varietyName = get('variety_name');
        const seasonName = get('season_name');
        const externalId = get('paddock_id');
        let boundary = null;
        const coords = pm.querySelector('coordinates');
        if (coords) {
          const points = coords.textContent.trim().split(/\s+/).map(p => {
            const [lng,lat] = p.split(',').map(Number);
            return [lng,lat];
          }).filter(p => !isNaN(p[0])&&!isNaN(p[1]));
          if (points.length > 2) boundary = { type:'Polygon', coordinates:[points] };
        }
        if (name) parsedPaddocks.push({ name, area, cropName, varietyName, seasonName, externalId, boundary });
      });

      const tbody = document.getElementById('imp-body');
      if (tbody) tbody.innerHTML = parsedPaddocks.map(p =>
        '<tr><td><strong>'+p.name+'</strong></td><td class="num">'+(p.area?p.area.toFixed(1):'—')+'</td><td>'+(p.cropName||'—')+'</td><td>'+(p.boundary?'✓':'—')+'</td></tr>'
      ).join('');

      const preview = document.getElementById('imp-preview');
      if (preview) preview.style.display = '';
      const btn = document.getElementById('imp-run-btn');
      if (btn) {
        btn.textContent = 'Import '+parsedPaddocks.length+' paddocks';
        btn.onclick = runImport;
      }
    }

    async function runImport() {
      const btn = document.getElementById('imp-run-btn');
      const prog = document.getElementById('imp-progress');
      const status = document.getElementById('imp-status');
      const bar = document.getElementById('imp-bar');
      if (btn) btn.disabled = true;
      if (prog) prog.style.display = '';
      if (status) status.textContent = 'Sending ' + parsedPaddocks.length + ' paddocks to server...';
      if (bar) bar.style.width = '30%';
      try {
        const { getSession } = await import('../../js/supabase-client.js');
        const session = getSession();
        const res = await fetch('/api/import-paddocks', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + (session?.access_token || ''),
          },
          body: JSON.stringify({ farmId: farm.id, paddocks: parsedPaddocks }),
        });
        if (bar) bar.style.width = '90%';
        if (!res.ok) throw new Error(await res.text());
        const result = await res.json();
        if (bar) bar.style.width = '100%';
        if (status) status.textContent = 'Done — ' + result.success + ' imported' + (result.failed ? ' (' + result.failed + ' failed)' : '');
        await _loadData(farm);
        _renderView(container, farm);
        toast(result.success + ' paddocks imported', 'success');
      } catch (err) {
        if (status) status.textContent = 'Error: ' + err.message;
        if (btn) btn.disabled = false;
      }
    }
  }, 200);
}

// ── Farm Map (standalone view from nav) ───────────────────────
export async function mountFarmMap(container) {
  const farm = getActiveFarm();
  if (!farm) { container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>'; return; }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Farm Map</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid)">${farm.name}</p>
      </div>
      <div class="flex gap-2 items-center">
        <span style="font-size:12px;color:var(--hint)">Click a paddock to view or edit</span>
        ${canWrite() ? '<button class="btn btn-secondary btn-sm" id="btn-toggle-draw">✏️ Draw new paddock</button>' : ''}
      </div>
    </div>
    <div id="farm-map-container" style="height:calc(100vh - 160px);border-radius:10px;overflow:hidden;border:1px solid var(--border);position:relative">
      <div id="farm-map" style="width:100%;height:100%"></div>
      <div id="map-legend" style="position:absolute;bottom:30px;left:10px;background:white;border-radius:8px;padding:10px 14px;font-size:11px;box-shadow:0 2px 8px rgba(0,0,0,.15);z-index:10">
        <div style="display:flex;flex-direction:column;gap:4px">
          <div style="display:flex;align-items:center;gap:6px"><div style="width:12px;height:12px;border-radius:2px;background:#185FA5;opacity:.5"></div> Paddock boundary</div>
          <div style="display:flex;align-items:center;gap:6px"><div style="width:12px;height:12px;border-radius:2px;background:#3B6D11;opacity:.7"></div> Currently planted</div>
          <div style="display:flex;align-items:center;gap:6px"><div style="width:12px;height:12px;border-radius:2px;background:#6b7280;opacity:.4"></div> Fallow</div>
        </div>
      </div>
    </div>
  `;

  await _loadData(farm);
  _initFarmMap(container, farm);

  qs('#btn-toggle-draw', container)?.addEventListener('click', () => {
    toast('Draw mode coming soon — use Import KML for bulk boundary import', 'info');
  });
}

function _initFarmMap(container, farm) {
  if (_map) { _map.remove(); _map = null; }

  if (!document.getElementById('mapbox-css')) {
    const link = document.createElement('link');
    link.id = 'mapbox-css';
    link.rel = 'stylesheet';
    link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css';
    document.head.appendChild(link);
  }

  const loadMap = () => {
    window.mapboxgl.accessToken = MAPBOX_TOKEN;

    const withBoundary = _paddocks.filter(p => p.boundary);
    let centre = [145.5, -33.5];
    if (withBoundary.length) {
      const allCoords = withBoundary.flatMap(p => p.boundary.coordinates[0]);
      const lngs = allCoords.map(c => c[0]);
      const lats = allCoords.map(c => c[1]);
      centre = [(Math.min(...lngs)+Math.max(...lngs))/2, (Math.min(...lats)+Math.max(...lats))/2];
    }

    _map = new window.mapboxgl.Map({
      container: 'farm-map',
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: centre,
      zoom: 12,
    });

    _map.addControl(new window.mapboxgl.NavigationControl());
    _map.addControl(new window.mapboxgl.FullscreenControl());
    _map.addControl(new window.mapboxgl.ScaleControl({ unit: 'metric' }));

    _map.on('load', () => _renderMapLayers(container, farm));
  };

  if (window.mapboxgl) loadMap();
  else {
    const script = document.createElement('script');
    script.src = 'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js';
    script.onload = loadMap;
    document.head.appendChild(script);
  }
}

function _renderMapLayers(container, farm) {
  // Remove existing sources/layers if re-rendering
  ['paddock-fill','paddock-fill-planted','paddock-outline','paddock-outline-hover','paddock-labels'].forEach(id => {
    if (_map.getLayer(id)) _map.removeLayer(id);
  });
  if (_map.getSource('paddocks')) _map.removeSource('paddocks');

  // Build features with planting info
  const features = _paddocks.filter(p => p.boundary).map(p => {
    // Find latest planting
    const plantings = _plantings ? _plantings.filter(pl => pl.paddock_id === p.id && pl.status === 'planted') : [];
    const currentPlanting = plantings.sort((a,b) => (b.plant_date||'').localeCompare(a.plant_date||''))[0];
    return {
      type: 'Feature',
      properties: {
        id: p.id,
        name: p.name,
        area: p.area_ha,
        type: p.paddock_type||'',
        group: p.group_name||'',
        irrigation: p.irrigation_type||'',
        crop: currentPlanting?.crop_type || '',
        variety: currentPlanting?.variety || '',
        planted: currentPlanting ? true : false,
      },
      geometry: p.boundary,
    };
  });

  _map.addSource('paddocks', { type: 'geojson', data: { type: 'FeatureCollection', features } });

  // Fill — planted paddocks green, fallow blue
  _map.addLayer({
    id: 'paddock-fill',
    type: 'fill',
    source: 'paddocks',
    paint: {
      'fill-color': ['case', ['get','planted'], '#3B6D11', '#185FA5'],
      'fill-opacity': ['case', ['get','planted'], 0.25, 0.15],
    }
  });

  // Hover highlight
  _map.addLayer({
    id: 'paddock-outline-hover',
    type: 'fill',
    source: 'paddocks',
    paint: { 'fill-color': '#fff', 'fill-opacity': 0 },
  });

  _map.addLayer({
    id: 'paddock-outline',
    type: 'line',
    source: 'paddocks',
    paint: {
      'line-color': ['case', ['get','planted'], '#3B6D11', '#185FA5'],
      'line-width': 1.5,
    }
  });

  _map.addLayer({
    id: 'paddock-labels',
    type: 'symbol',
    source: 'paddocks',
    layout: {
      'text-field': ['concat', ['get','name'], ['case', ['get','planted'], ['concat', '\n', ['get','crop']], '']],
      'text-size': 10,
      'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
      'text-max-width': 8,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#000000',
      'text-halo-width': 1,
    }
  });

  // Click → edit popup
  _map.on('click', 'paddock-fill', e => {
    const props = e.features[0].properties;
    const paddock = _paddocks.find(p => p.id === props.id);
    if (!paddock) return;
    _showPaddockPopup(e.lngLat, paddock, container, farm);
  });

  _map.on('mouseenter', 'paddock-fill', () => { _map.getCanvas().style.cursor = 'pointer'; });
  _map.on('mouseleave', 'paddock-fill', () => { _map.getCanvas().style.cursor = ''; });

  // Fit bounds
  if (features.length) {
    const allCoords = features.flatMap(f => f.geometry.coordinates[0]);
    const lngs = allCoords.map(c => c[0]);
    const lats = allCoords.map(c => c[1]);
    _map.fitBounds([[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], { padding: 60 });
  }
}

function _showPaddockPopup(lngLat, paddock, container, farm) {
  // Remove existing popup
  document.querySelectorAll('.mapboxgl-popup').forEach(el => el.remove());

  const currentPlanting = _plantings ? _plantings.filter(p => p.paddock_id === paddock.id && p.status === 'planted')
    .sort((a,b) => (b.plant_date||'').localeCompare(a.plant_date||''))[0] : null;

  const popup = new window.mapboxgl.Popup({ maxWidth: '280px' })
    .setLngLat(lngLat)
    .setHTML(`
      <div style="font-family:system-ui;padding:4px">
        <p style="font-weight:600;font-size:14px;margin-bottom:8px">${paddock.name}</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px;margin-bottom:10px">
          <div><span style="color:#6b7280">Area</span><br><strong>${paddock.area_ha ? paddock.area_ha.toFixed(1)+' ha' : '—'}</strong></div>
          <div><span style="color:#6b7280">Type</span><br><strong>${paddock.paddock_type||'—'}</strong></div>
          <div><span style="color:#6b7280">Irrigation</span><br><strong>${paddock.irrigation_type||'—'}</strong></div>
          <div><span style="color:#6b7280">Current crop</span><br><strong style="color:${currentPlanting?'#065f46':'#6b7280'}">${currentPlanting?.crop_type||'Fallow'}</strong></div>
          ${currentPlanting?.variety ? '<div style="grid-column:span 2"><span style="color:#6b7280">Variety</span><br><strong>'+currentPlanting.variety+'</strong></div>' : ''}
        </div>
        ${canWrite() ? `<div style="display:flex;gap:6px">
          <button id="popup-edit-${paddock.id}" style="flex:1;padding:5px;border-radius:4px;border:1px solid #d1d5db;background:white;cursor:pointer;font-size:12px;font-weight:500">✏️ Edit paddock</button>
        </div>` : ''}
      </div>
    `)
    .addTo(_map);

  // Wire edit button after popup renders
  setTimeout(() => {
    document.getElementById('popup-edit-'+paddock.id)?.addEventListener('click', () => {
      popup.remove();
      _editPaddockFromMap(paddock, container, farm);
    });
  }, 100);
}

function _editPaddockFromMap(paddock, container, farm) {
  const TYPES = ['Irrigation', 'Dryland', 'Grazing', 'Fallow', 'Other'];
  const IRR_TYPES = ['Flood', 'Lateral move', 'Centre pivot', 'Drip', 'Dryland'];

  openModal({
    title: 'Edit — ' + paddock.name,
    confirmLabel: 'Save changes',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Paddock name</label>
          <input class="form-input" id="ep-name" value="${paddock.name||''}">
        </div>
        <div class="form-group">
          <label class="form-label">Area (ha)</label>
          <input class="form-input num" id="ep-area" type="number" step="0.1" value="${paddock.area_ha||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Paddock type</label>
          <select class="form-select" id="ep-type">
            <option value="">— select —</option>
            ${TYPES.map(t => `<option value="${t}" ${paddock.paddock_type===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Irrigation type</label>
          <select class="form-select" id="ep-irr">
            <option value="">— select —</option>
            ${IRR_TYPES.map(t => `<option value="${t}" ${paddock.irrigation_type===t?'selected':''}>${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Group / block</label>
          <input class="form-input" id="ep-group" value="${paddock.group_name||''}" placeholder="e.g. River block">
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="ep-status">
            <option value="true" ${paddock.is_active!==false?'selected':''}>Active</option>
            <option value="false" ${paddock.is_active===false?'selected':''}>Inactive</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="ep-notes" rows="2">${paddock.notes||''}</textarea>
      </div>
      <p style="font-size:11px;color:var(--hint);margin-top:8px">To edit the boundary polygon, use the Import KML function to re-import an updated KML file.</p>
    `,
    onConfirm: async (modal) => {
      const updates = {
        name: qs('#ep-name', modal)?.value?.trim(),
        area_ha: parseFloat(qs('#ep-area', modal)?.value)||null,
        paddock_type: qs('#ep-type', modal)?.value||null,
        irrigation_type: qs('#ep-irr', modal)?.value||null,
        group_name: qs('#ep-group', modal)?.value?.trim()||null,
        is_active: qs('#ep-status', modal)?.value === 'true',
        notes: qs('#ep-notes', modal)?.value?.trim()||null,
      };
      if (!updates.name) throw new Error('Paddock name is required');
      await dbUpdate('paddocks', paddock.id, updates);
      Object.assign(_paddocks.find(p => p.id === paddock.id), updates);
      toast('Paddock updated', 'success');
      _renderMapLayers(container, farm);
    },
  });
}
