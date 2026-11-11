// modules/paddocks/paddocks.js
// Paddock list — inline-editable table, saves on blur/change.
// Fields: name, map_area (ha), type (select)

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm } from '../../js/app-state.js';
import { toast, openModal } from '../../js/ui.js';

const PADDOCK_TYPES = ['Crop', 'Fallow', 'Pasture', 'Headland', 'Other'];

let _container    = null;
let _paddocks     = [];
let _saving       = new Set(); // ids currently being saved (debounce guard)
let _activeFilter = 'All';    // 'All' | one of PADDOCK_TYPES

// ── Public entry point ──────────────────────────────────────────────────────

export async function mountPaddocks(container) {
  _container = container;
  await _refresh();
}

export function unmountPaddocks() {
  _container    = null;
  _paddocks     = [];
  _activeFilter = 'All';
  _saving.clear();
}

// ── Data ────────────────────────────────────────────────────────────────────

async function _refresh() {
  const farm = getActiveFarm();
  if (!farm) {
    _container.innerHTML = `
      <div class="page-header"><div><h1>Paddocks</h1>
      <p class="page-subtitle">Farm paddock list &amp; configuration</p></div></div>
      <p style="color:var(--hint);padding:20px">Select a farm to manage paddocks.</p>`;
    return;
  }
  _paddocks = await dbSelect('paddocks', { farm_id: farm.id }, 'name') || [];
  _render();
}

// ── Render ───────────────────────────────────────────────────────────────────

function _render() {
  const farm = getActiveFarm();

  _container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Paddocks</h1>
        <p class="page-subtitle">${_esc(farm?.name || '')} — click any cell to edit</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-sm" id="pk-import-btn">⬆ Import CSV</button>
        <button class="btn btn-sm" id="pk-export-btn">⬇ Export CSV</button>
        <button class="btn btn-primary" id="pk-add-btn">+ Add paddock</button>
      </div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${['All', ...PADDOCK_TYPES].map(t => {
        const count = t === 'All' ? _paddocks.length : _paddocks.filter(p => p.type === t).length;
        const active = _activeFilter === t;
        return `<button class="pk-filter-btn${active ? ' pk-filter-active' : ''}" data-filter="${t}">
          ${t} <span class="pk-filter-count">${count}</span>
        </button>`;
      }).join('')}
      <span style="margin-left:auto;font-size:0.78rem;color:var(--hint)">Changes save automatically</span>
    </div>

    <div class="card" style="overflow:hidden;padding:0">
      <table class="data-table pk-table" style="width:100%;table-layout:fixed">
        <colgroup>
          <col style="width:40%">
          <col style="width:18%">
          <col style="width:22%">
          <col style="width:20%">
        </colgroup>
        <thead>
          <tr>
            <th>Name</th>
            <th>Map area (ha)</th>
            <th>Type</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="pk-tbody">
          ${_filteredRows()}
        </tbody>
      </table>
    </div>

    <input type="file" id="pk-file-input" accept=".csv" style="display:none">
  `;

  _bindTableEvents();

  _container.querySelectorAll('.pk-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeFilter = btn.dataset.filter;
      _container.querySelectorAll('.pk-filter-btn').forEach(b =>
        b.classList.toggle('pk-filter-active', b.dataset.filter === _activeFilter));
      _container.querySelector('#pk-tbody').innerHTML = _filteredRows();
      _bindTableEvents();
    });
  });

  _container.querySelector('#pk-add-btn').addEventListener('click', _addNewRow);
  _container.querySelector('#pk-export-btn').addEventListener('click', _exportCSV);
  _container.querySelector('#pk-import-btn').addEventListener('click', () =>
    _container.querySelector('#pk-file-input').click());
  _container.querySelector('#pk-file-input').addEventListener('change', _handleImport);
}

function _filteredRows() {
  const visible = _activeFilter === 'All'
    ? _paddocks
    : _paddocks.filter(p => p.type === _activeFilter);
  if (visible.length === 0) {
    const msg = _paddocks.length === 0
      ? 'No paddocks yet — add one or import a CSV.<br><small>CSV format: Name, Map Area (ha), Type</small>'
      : `No paddocks with type <strong>${_esc(_activeFilter)}</strong>.`;
    return `<tr><td colspan="4" style="color:var(--hint);text-align:center;padding:32px">${msg}</td></tr>`;
  }
  return visible.map(p => _rowHTML(p)).join('');
}

// Each row has inline inputs — name (text), map_area (number), type (select)
function _rowHTML(p) {
  const typeOpts = PADDOCK_TYPES.map(t =>
    `<option value="${t}"${p.type === t ? ' selected' : ''}>${t}</option>`
  ).join('');

  return `
    <tr data-id="${p.id}" class="pk-row">
      <td>
        <input class="pk-cell-input pk-name" value="${_esc(p.name)}"
          placeholder="Paddock name" data-field="name" data-id="${p.id}">
      </td>
      <td>
        <input class="pk-cell-input pk-area" type="number" step="0.1" min="0"
          value="${p.map_area ?? ''}" placeholder="—"
          data-field="map_area" data-id="${p.id}">
      </td>
      <td>
        <select class="pk-cell-select pk-type" data-field="type" data-id="${p.id}">
          <option value="">—</option>
          ${typeOpts}
        </select>
      </td>
      <td style="text-align:right">
        <span class="pk-save-indicator" id="pk-ind-${p.id}" style="font-size:0.75rem;color:var(--hint);margin-right:6px"></span>
        <button class="btn btn-xs btn-danger pk-delete-btn" data-id="${p.id}" data-name="${_esc(p.name)}">✕</button>
      </td>
    </tr>
  `;
}

// ── Inline edit events ───────────────────────────────────────────────────────

function _bindTableEvents() {
  const tbody = _container.querySelector('#pk-tbody');
  if (!tbody) return;

  // Text / number inputs — save on blur
  tbody.addEventListener('blur', async (e) => {
    const el = e.target.closest('.pk-cell-input');
    if (!el) return;
    await _saveField(el.dataset.id, el.dataset.field, el.value.trim());
  }, true); // capture so blur fires on inputs

  // Select — save immediately on change
  tbody.addEventListener('change', async (e) => {
    const el = e.target.closest('.pk-cell-select');
    if (!el) return;
    await _saveField(el.dataset.id, el.dataset.field, el.value || null);
  });

  // Delete buttons
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('.pk-delete-btn');
    if (!btn) return;
    _confirmDelete(btn.dataset.id, btn.dataset.name);
  });
}

async function _saveField(id, field, rawValue) {
  if (_saving.has(id + field)) return;
  _saving.add(id + field);

  const paddock = _paddocks.find(p => p.id === id);
  if (!paddock) { _saving.delete(id + field); return; }

  // Parse value
  let value;
  if (field === 'map_area') {
    value = rawValue === '' ? null : parseFloat(rawValue);
    if (isNaN(value)) value = null;
  } else {
    value = rawValue === '' ? null : rawValue;
  }

  // Skip if unchanged
  if (paddock[field] === value || (paddock[field] == null && value == null)) {
    _saving.delete(id + field);
    return;
  }

  // Validate name
  if (field === 'name' && !value) {
    toast('Paddock name cannot be empty', 'error');
    // Reset input to previous value
    const input = _container.querySelector(`[data-id="${id}"][data-field="name"]`);
    if (input) input.value = paddock.name;
    _saving.delete(id + field);
    return;
  }

  _setIndicator(id, '…');

  try {
    await dbUpdate('paddocks', id, { [field]: value });
    paddock[field] = value; // update local cache
    // Update delete button name if name changed
    if (field === 'name') {
      const btn = _container.querySelector(`.pk-delete-btn[data-id="${id}"]`);
      if (btn) btn.dataset.name = value;
    }
    _setIndicator(id, '✓', 1200);
  } catch (err) {
    toast('Save failed — ' + (err.message || 'unknown error'), 'error');
    _setIndicator(id, '!');
  }

  _saving.delete(id + field);
}

function _setIndicator(id, text, clearAfterMs = 0) {
  const el = _container.querySelector(`#pk-ind-${id}`);
  if (!el) return;
  el.textContent = text;
  el.style.color = text === '✓' ? 'var(--green,#16a34a)' : text === '!' ? 'var(--red,#dc2626)' : 'var(--hint)';
  if (clearAfterMs) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, clearAfterMs);
}

// ── Add new row ──────────────────────────────────────────────────────────────

async function _addNewRow() {
  const farm = getActiveFarm();
  if (!farm) return;

  try {
    const result = await dbInsert('paddocks', {
      farm_id: farm.id,
      name: 'New paddock',
      map_area: null,
      type: 'Crop',
    });
    // Insert returns the new row — add to local list and re-render
    const newPaddock = Array.isArray(result) ? result[0] : result;
    if (newPaddock) {
      _paddocks.push(newPaddock);
      // Append row to table instead of full re-render
      const tbody = _container.querySelector('#pk-tbody');
      // Clear empty state row if present
      if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
      const tr = document.createElement('tr');
      tr.outerHTML; // ignored — append via innerHTML trick
      tbody.insertAdjacentHTML('beforeend', _rowHTML(newPaddock));
      _bindTableEvents(); // rebind after DOM change
      // Update count
      const countEl = _container.querySelector('.page-subtitle + div, div[style*="paddock"]');
      // Focus the name field of the new row
      const nameInput = tbody.querySelector(`[data-id="${newPaddock.id}"][data-field="name"]`);
      if (nameInput) {
        nameInput.select();
        nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      // Update subtitle count
      _updateCount();
    }
  } catch (err) {
    toast('Could not add paddock', 'error');
  }
}

function _updateCount() {
  const sub = _container.querySelector('.page-subtitle');
  if (sub) return; // leave page-subtitle as farm name
  const countEl = _container.querySelector('[style*="paddock"]');
  if (countEl) countEl.textContent =
    `${_paddocks.length} paddock${_paddocks.length !== 1 ? 's' : ''} · Changes save automatically`;
}

// ── Delete ───────────────────────────────────────────────────────────────────

function _confirmDelete(id, name) {
  openModal({
    title: 'Delete paddock?',
    bodyHTML: `<p>Remove <strong>${_esc(name)}</strong>? This won't delete any scouting records linked to it.</p>`,
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      await dbDelete('paddocks', id);
      _paddocks = _paddocks.filter(p => p.id !== id);
      const row = _container.querySelector(`tr[data-id="${id}"]`);
      if (row) row.remove();
      // Show empty state if none left
      if (_paddocks.length === 0) {
        _container.querySelector('#pk-tbody').innerHTML =
          `<tr><td colspan="4" style="color:var(--hint);text-align:center;padding:32px">
            No paddocks yet — add one or import a CSV.
           </td></tr>`;
      }
      toast(`"${name}" deleted`);
    },
  });
}

// ── CSV export ───────────────────────────────────────────────────────────────

function _exportCSV() {
  if (_paddocks.length === 0) { toast('No paddocks to export', 'warning'); return; }
  const farm = getActiveFarm();
  const rows = [
    ['Name', 'Map Area (ha)', 'Type'],
    ..._paddocks.map(p => [_csvCell(p.name), p.map_area ?? '', _csvCell(p.type || '')]),
  ];
  const csv  = rows.map(r => r.join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `${(farm?.name || 'farm').replace(/\s+/g, '-').toLowerCase()}-paddocks.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${_paddocks.length} paddocks`);
}

// ── CSV import ───────────────────────────────────────────────────────────────

async function _handleImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';

  const text  = await file.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) { toast('CSV appears empty', 'error'); return; }

  const header  = _parseCSVRow(lines[0]).map(h => h.toLowerCase().trim());
  const nameIdx = header.findIndex(h => h === 'name');
  const areaIdx = header.findIndex(h => h.includes('area') || h.includes('ha'));
  const typeIdx = header.findIndex(h => h === 'type');

  if (nameIdx === -1) { toast('CSV must have a "Name" column', 'error'); return; }

  const rows = lines.slice(1).map(l => _parseCSVRow(l)).filter(r => r[nameIdx]?.trim());
  if (rows.length === 0) { toast('No data rows found', 'error'); return; }

  openModal({
    title: 'Import paddocks',
    bodyHTML: `
      <p style="margin-bottom:12px">Found <strong>${rows.length} paddock${rows.length !== 1 ? 's' : ''}</strong>. Duplicates by name will be skipped.</p>
      <div style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
        <table class="data-table" style="width:100%;font-size:0.8rem">
          <thead><tr><th>Name</th><th>Area</th><th>Type</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${_esc(r[nameIdx]?.trim() || '')}</td>
              <td>${areaIdx !== -1 ? _esc(r[areaIdx]?.trim() || '') : '—'}</td>
              <td>${typeIdx !== -1 ? _esc(r[typeIdx]?.trim() || '') : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`,
    confirmLabel: `Import ${rows.length} paddock${rows.length !== 1 ? 's' : ''}`,
    onConfirm: async () => {
      const farm = getActiveFarm();
      const existing = new Set(_paddocks.map(p => p.name.toLowerCase()));
      let added = 0, skipped = 0;
      for (const r of rows) {
        const name = r[nameIdx]?.trim();
        if (!name) continue;
        if (existing.has(name.toLowerCase())) { skipped++; continue; }
        const area = areaIdx !== -1 ? parseFloat(r[areaIdx]) : null;
        const type = typeIdx !== -1 ? (r[typeIdx]?.trim() || null) : null;
        await dbInsert('paddocks', {
          farm_id: farm.id, name,
          map_area: isNaN(area) ? null : area,
          type,
        });
        added++;
      }
      toast(`Imported ${added}${skipped ? ` (${skipped} skipped)` : ''}`);
      await _refresh();
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _csvCell(val) {
  const s = String(val ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
}
function _parseCSVRow(line) {
  const result = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}
