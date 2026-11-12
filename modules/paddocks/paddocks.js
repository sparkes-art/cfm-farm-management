// modules/paddocks/paddocks.js
// Paddock list — inline-editable table, saves on blur/change.
// Fields: name, map_area (ha), type (select + custom)

import { dbSelect, dbInsert, dbUpdate, dbDelete, getSession } from '../../js/supabase-client.js?v=1794523141775';
import { getActiveFarm } from '../../js/app-state.js?v=1794523141775';
import { toast, openModal } from '../../js/ui.js?v=1794523141775';

const PADDOCK_TYPES = [
  'Pasture',
  'Grazing/Bush',
  'Dryland',
  'Irrigated - Overhead Pivot',
  'Irrigated - Overhead Lateral',
  'Irrigated - Furrow',
  'Permanent Crop',
];

// Colour palette for each type — used in summary tiles and row badges
const TYPE_COLOURS = {
  'Pasture':                    { bg: '#d1fae5', text: '#065f46', dot: '#10b981' },
  'Grazing/Bush':               { bg: '#dcfce7', text: '#14532d', dot: '#22c55e' },
  'Dryland':                    { bg: '#fef9c3', text: '#713f12', dot: '#eab308' },
  'Irrigated - Overhead Pivot': { bg: '#dbeafe', text: '#1e3a8a', dot: '#3b82f6' },
  'Irrigated - Overhead Lateral':{ bg: '#e0f2fe', text: '#0c4a6e', dot: '#0ea5e9' },
  'Irrigated - Furrow':         { bg: '#ede9fe', text: '#3b0764', dot: '#8b5cf6' },
  'Permanent Crop':             { bg: '#ffe4e6', text: '#881337', dot: '#f43f5e' },
};
const CUSTOM_COLOUR = { bg: '#f3f4f6', text: '#374151', dot: '#9ca3af' };

function _typeColour(type) {
  return TYPE_COLOURS[type] || CUSTOM_COLOUR;
}

let _container    = null;
let _paddocks     = [];
let _saving       = new Set();
let _activeFilter = 'All';
let _history      = {};   // keyed by paddock_id → array of history entries
let _historyOpen  = new Set(); // paddock IDs with expanded history panel

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
  _history      = {};
  _historyOpen.clear();
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
  _paddocks = await dbSelect('paddocks', 'farm_id=eq.' + farm.id + '&select=*&order=name.asc') || [];
  await _loadHistory(farm.id);
  _render();
}

async function _loadHistory(farmId) {
  try {
    const rows = await dbSelect('paddock_history', 'farm_id=eq.' + farmId + '&select=*&order=changed_at.desc') || [];
    _history = {};
    for (const row of rows) {
      if (!_history[row.paddock_id]) _history[row.paddock_id] = [];
      _history[row.paddock_id].push(row);
    }
  } catch (err) {
    console.warn('[CFM] paddock_history load failed (table may not exist yet):', err.message);
    _history = {};
  }
}

// ── All distinct types in the data (for filter chips) ───────────────────────
function _allTypes() {
  const set = new Set(_paddocks.map(p => p.type).filter(Boolean));
  // Show standard types first (in order), then any custom ones alphabetically
  const standard = PADDOCK_TYPES.filter(t => set.has(t));
  const custom   = [...set].filter(t => !PADDOCK_TYPES.includes(t)).sort();
  return [...standard, ...custom];
}

// ── Combined filter + summary sidebar panel ───────────────────────────────────

function _sidePanelHTML(types) {
  const fmt    = ha => ha > 0 ? Number(ha).toLocaleString('en-AU', { maximumFractionDigits: 1 }) + ' ha' : '—';
  const totalHa = _paddocks.reduce((s, p) => s + (parseFloat(p.map_area) || 0), 0);
  const totalCount = _paddocks.length;

  const allActive = _activeFilter === 'All';

  const typeRows = types.map(t => {
    const count  = _paddocks.filter(p => p.type === t).length;
    const ha     = _paddocks.filter(p => p.type === t).reduce((s, p) => s + (parseFloat(p.map_area) || 0), 0);
    const active = _activeFilter === t;
    const c      = _typeColour(t);
    return `
      <button class="pk-filter-btn${active ? ' pk-filter-active' : ''}" data-filter="${_esc(t)}"
        style="width:100%;display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:6px;text-align:left;border:none;background:${active ? c.bg : 'transparent'};cursor:pointer;transition:background 100ms">
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${c.dot}"></span>
        <span style="flex:1;font-size:0.78rem;font-weight:500;color:${active ? c.text : 'var(--ink)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(t)}</span>
        <span style="font-size:0.72rem;color:${active ? c.text : 'var(--hint)'};flex-shrink:0;min-width:46px;text-align:right">${fmt(ha)}</span>
      </button>`;
  }).join('');

  return `
    <div id="pk-side-panel" style="width:260px;flex-shrink:0;border:1px solid var(--border);border-radius:8px;background:var(--surface);padding:8px;display:flex;flex-direction:column;gap:1px;align-self:flex-start">
      <button class="pk-filter-btn${allActive ? ' pk-filter-active' : ''}" data-filter="All"
        style="width:100%;display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:6px;text-align:left;border:none;background:${allActive ? 'var(--blue-light)' : 'transparent'};cursor:pointer;margin-bottom:4px;transition:background 100ms">
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--blue)"></span>
        <span style="flex:1;font-size:0.78rem;font-weight:600;color:var(--ink)">All paddocks</span>
        <span style="font-size:0.72rem;color:var(--hint);flex-shrink:0;min-width:46px;text-align:right">${fmt(totalHa)}</span>
      </button>
      <div style="height:1px;background:var(--border);margin:2px 0 4px"></div>
      ${typeRows}
      <div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);font-size:0.68rem;color:var(--hint);text-align:center">Changes save automatically</div>
    </div>`;
}

// ── Render ───────────────────────────────────────────────────────────────────

function _render() {
  const farm  = getActiveFarm();
  const types = _allTypes();

  _container.innerHTML = `
    <div class="page-header" style="margin-bottom:10px">
      <div>
        <h1>Paddocks</h1>
        <p class="page-subtitle">${_esc(farm?.name || '')} — Paddock names are fixed reference data. Season records store the name at time of entry and are not affected if paddocks change.</p>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <button class="btn btn-sm" id="pk-import-btn">⬆ Import CSV</button>
        <button class="btn btn-sm" id="pk-export-btn">⬇ Export CSV</button>
        <button class="btn btn-primary" id="pk-add-btn">+ Add paddock</button>
      </div>
    </div>

    <div style="display:flex;gap:12px;align-items:flex-start">
      ${_sidePanelHTML(types)}

      <div class="pk-table-wrap" style="flex:1;min-width:0">
        <table class="data-table pk-table">
          <thead>
            <tr>
              <th style="width:38%">Name</th>
              <th style="width:14%">Map area (ha)</th>
              <th style="width:34%">Type</th>
              <th style="width:14%"></th>
            </tr>
          </thead>
          <tbody id="pk-tbody">
            ${_filteredRows()}
          </tbody>
        </table>
      </div>
    </div>

    <input type="file" id="pk-file-input" accept=".csv" style="display:none">
  `;

  _bindEvents();
}

// ── Filtered rows HTML ───────────────────────────────────────────────────────

function _filteredRows() {
  const visible = _activeFilter === 'All'
    ? _paddocks
    : _paddocks.filter(p => p.type === _activeFilter);
  if (visible.length === 0) {
    const msg = _paddocks.length === 0
      ? 'No paddocks yet — add one or import a CSV.<br><small>CSV columns: Name, Map Area (ha), Type</small>'
      : `No paddocks with type <strong>${_esc(_activeFilter)}</strong>.`;
    return `<tr><td colspan="4" style="color:var(--hint);text-align:center;padding:32px">${msg}</td></tr>`;
  }
  return visible.map(p => _rowHTML(p)).join('');
}

// ── Row HTML ─────────────────────────────────────────────────────────────────
// Type cell: <select> with standard options + "Custom…" trigger,
// plus a hidden text input that appears when a custom value is active.

function _rowHTML(p) {
  const isCustom   = p.type && !PADDOCK_TYPES.includes(p.type);
  const selectVal  = isCustom ? '__custom__' : (p.type || '');
  const customVal  = isCustom ? p.type : '';
  const histCount  = (_history[p.id] || []).length;
  const isOpen     = _historyOpen.has(p.id);

  const typeOpts = [
    `<option value="">— select type —</option>`,
    ...PADDOCK_TYPES.map(t =>
      `<option value="${_esc(t)}"${selectVal === t ? ' selected' : ''}>${_esc(t)}</option>`),
    `<option value="__custom__"${isCustom ? ' selected' : ''}>Custom…</option>`,
  ].join('');

  const histPanel = isOpen ? _historyPanelHTML(p) : '';

  return `
    <tr data-id="${p.id}" class="pk-row">
      <td>
        <input class="pk-cell-input" value="${_esc(p.name)}"
          placeholder="Paddock name" data-field="name" data-id="${p.id}">
      </td>
      <td>
        <input class="pk-cell-input" type="number" step="0.1" min="0"
          value="${p.map_area ?? ''}" placeholder="—"
          data-field="map_area" data-id="${p.id}">
      </td>
      <td>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="pk-type-dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${_typeColour(p.type).dot}"></span>
          <select class="pk-cell-select pk-type-select" data-field="type" data-id="${p.id}" style="flex:1;min-width:0">
            ${typeOpts}
          </select>
          <input class="pk-cell-input pk-type-custom" data-field="type" data-id="${p.id}"
            placeholder="Custom type" value="${_esc(customVal)}"
            style="flex:1;min-width:0;${isCustom ? '' : 'display:none'}">
        </div>
      </td>
      <td style="text-align:right;white-space:nowrap">
        <span class="pk-save-indicator" id="pk-ind-${p.id}" style="font-size:0.72rem;color:var(--hint);margin-right:4px"></span>
        <button class="btn btn-xs pk-history-btn" data-id="${p.id}"
          title="Paddock history"
          style="margin-right:4px;opacity:${histCount > 0 ? 1 : 0.4}">
          ${isOpen ? '▾' : '▸'} History${histCount > 0 ? ` (${histCount})` : ''}
        </button>
        <button class="btn btn-xs btn-danger pk-delete-btn" data-id="${p.id}" data-name="${_esc(p.name)}">✕</button>
      </td>
    </tr>
    ${histPanel}
  `;
}

// ── History panel HTML ───────────────────────────────────────────────────────

function _historyPanelHTML(p) {
  const entries = _history[p.id] || [];
  const farm = getActiveFarm();

  const timelineRows = entries.length === 0
    ? `<p style="color:var(--hint);font-size:0.8rem;margin:0">No history recorded yet.</p>`
    : entries.map(e => {
        const dt  = new Date(e.changed_at);
        const dateStr = dt.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' });
        const timeStr = dt.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit' });
        const who = e.changed_by ? e.changed_by.replace(/@.*$/, '') : '—';
        let change = '';
        if (e.field) {
          const label = e.field === 'map_area' ? 'Area' : e.field === 'type' ? 'Type' : _esc(e.field);
          const oldV  = e.old_value != null ? _esc(String(e.old_value)) : '<em style="color:var(--hint)">—</em>';
          const newV  = e.new_value != null ? _esc(String(e.new_value)) : '<em style="color:var(--hint)">—</em>';
          change = `<span style="font-size:0.78rem"><strong>${label}:</strong> ${oldV} → ${newV}</span>`;
        }
        const noteEl = e.notes
          ? `<span class="pk-hist-note" style="font-size:0.78rem;color:var(--ink);font-style:italic">${_esc(e.notes)}</span>
             <button class="btn btn-xs pk-edit-note-btn" data-hist-id="${e.id}" data-paddock-id="${p.id}"
               style="font-size:0.68rem;padding:1px 5px;opacity:0.5">edit note</button>`
          : `<button class="btn btn-xs pk-edit-note-btn" data-hist-id="${e.id}" data-paddock-id="${p.id}"
               style="font-size:0.68rem;padding:1px 5px;opacity:0.5">+ add note</button>`;
        return `
          <div class="pk-hist-entry" data-hist-id="${e.id}" style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
            <div style="flex-shrink:0;text-align:right;min-width:88px">
              <div style="font-size:0.72rem;color:var(--hint)">${dateStr}</div>
              <div style="font-size:0.68rem;color:var(--hint)">${timeStr}</div>
              <div style="font-size:0.68rem;color:var(--hint);margin-top:1px">${_esc(who)}</div>
            </div>
            <div style="flex:1;display:flex;flex-direction:column;gap:3px;padding-top:1px">
              ${change}
              <div class="pk-hist-note-row" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                ${noteEl}
              </div>
            </div>
          </div>`;
      }).join('');

  return `
    <tr class="pk-history-row" data-history-for="${p.id}">
      <td colspan="4" style="padding:0;border-top:none">
        <div style="background:var(--bg,#f9fafb);border:1px solid var(--border);border-top:none;border-radius:0 0 6px 6px;padding:10px 12px">
          <div style="margin-bottom:8px">
            <span style="font-size:0.75rem;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:0.04em">History — ${_esc(p.name)}</span>
          </div>
          <div style="max-height:240px;overflow-y:auto">
            ${timelineRows}
          </div>
        </div>
      </td>
    </tr>`;
}

// ── Event wiring ─────────────────────────────────────────────────────────────

function _bindFilterClicks() {
  _container.querySelectorAll('.pk-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeFilter = btn.dataset.filter;
      // Re-render side panel to show new active state
      _refreshSidePanel();
      // Re-render table rows
      _container.querySelector('#pk-tbody').innerHTML = _filteredRows();
      _bindTableEvents();
    });
  });
}

function _bindEvents() {
  _bindFilterClicks();
  _bindTableEvents();

  _container.querySelector('#pk-add-btn').addEventListener('click', _addNewRow);
  _container.querySelector('#pk-export-btn').addEventListener('click', _exportCSV);
  _container.querySelector('#pk-import-btn').addEventListener('click', () =>
    _container.querySelector('#pk-file-input').click());
  _container.querySelector('#pk-file-input').addEventListener('change', _handleImport);
}

function _bindTableEvents() {
  const tbody = _container.querySelector('#pk-tbody');
  if (!tbody) return;

  // Clone to remove old listeners
  const fresh = tbody.cloneNode(true);
  tbody.parentNode.replaceChild(fresh, tbody);
  const tb = _container.querySelector('#pk-tbody');

  // Text/number inputs — save on blur
  tb.addEventListener('blur', async (e) => {
    const el = e.target.closest('.pk-cell-input');
    if (!el || el.classList.contains('pk-type-custom')) return;
    await _saveField(el.dataset.id, el.dataset.field, el.value.trim());
  }, true);

  // Custom type input — save on blur
  tb.addEventListener('blur', async (e) => {
    const el = e.target.closest('.pk-type-custom');
    if (!el) return;
    const val = el.value.trim();
    if (val) await _saveField(el.dataset.id, 'type', val);
  }, true);

  // Type select — handle Custom… specially, save otherwise
  tb.addEventListener('change', async (e) => {
    const sel = e.target.closest('.pk-type-select');
    if (!sel) return;
    const row     = sel.closest('tr');
    const customInput = row?.querySelector('.pk-type-custom');
    if (sel.value === '__custom__') {
      // Show custom text field
      if (customInput) {
        customInput.style.display = '';
        customInput.value = '';
        customInput.focus();
      }
    } else {
      // Hide custom field, save selected value
      if (customInput) customInput.style.display = 'none';
      await _saveField(sel.dataset.id, 'type', sel.value || null);
    }
  });

  // History toggle
  tb.addEventListener('click', (e) => {
    const btn = e.target.closest('.pk-history-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    const p  = _paddocks.find(x => x.id === id);
    if (!p) return;
    if (_historyOpen.has(id)) {
      _historyOpen.delete(id);
      // Remove the history row
      _container.querySelector(`tr.pk-history-row[data-history-for="${id}"]`)?.remove();
      const c0 = (_history[id] || []).length;
      btn.textContent = `▸ History${c0 > 0 ? ` (${c0})` : ''}`;
    } else {
      _historyOpen.add(id);
      // Insert history row after the paddock row
      const paddockRow = _container.querySelector(`tr[data-id="${id}"]`);
      if (paddockRow) {
        const tmp = document.createElement('tbody');
        tmp.innerHTML = _historyPanelHTML(p);
        paddockRow.after(tmp.firstElementChild);
      }
      const c1 = (_history[id] || []).length;
      btn.textContent = `▾ History${c1 > 0 ? ` (${c1})` : ''}`;
    }
  });

  // Inline note on individual history entry
  tb.addEventListener('click', (e) => {
    const btn = e.target.closest('.pk-edit-note-btn');
    if (!btn) return;
    _inlineEditNote(btn);
  });

  // Delete
  tb.addEventListener('click', (e) => {
    const btn = e.target.closest('.pk-delete-btn');
    if (!btn) return;
    _confirmDelete(btn.dataset.id, btn.dataset.name);
  });
}

// ── Save field ───────────────────────────────────────────────────────────────

async function _saveField(id, field, rawValue) {
  const key = id + field;
  if (_saving.has(key)) return;
  _saving.add(key);

  const paddock = _paddocks.find(p => p.id === id);
  if (!paddock) { _saving.delete(key); return; }

  let value;
  if (field === 'map_area') {
    value = rawValue === '' || rawValue == null ? null : parseFloat(rawValue);
    if (isNaN(value)) value = null;
  } else {
    value = rawValue === '' || rawValue == null ? null : rawValue;
  }

  if (paddock[field] === value || (paddock[field] == null && value == null)) {
    _saving.delete(key); return;
  }

  if (field === 'name' && !value) {
    toast('Paddock name cannot be empty', 'error');
    const inp = _container.querySelector(`[data-id="${id}"][data-field="name"].pk-cell-input`);
    if (inp) inp.value = paddock.name;
    _saving.delete(key); return;
  }

  _setIndicator(id, '…');

  try {
    const oldValue = paddock[field];
    await dbUpdate('paddocks', id, { [field]: value });
    paddock[field] = value;
    if (field === 'name') {
      const btn = _container.querySelector(`.pk-delete-btn[data-id="${id}"]`);
      if (btn) btn.dataset.name = value;
    }
    // Update dot colour when type changes
    if (field === 'type') {
      const dot = _container.querySelector(`tr[data-id="${id}"] .pk-type-dot`);
      if (dot) dot.style.background = _typeColour(value).dot;
      _refreshFilterCounts(); // also calls _refreshSummary
    }
    // Refresh summary totals when area changes
    if (field === 'map_area') _refreshSummary();
    _setIndicator(id, '✓', 1400);

    // Log to history (best-effort — don't fail save if history write fails)
    _logHistory(id, field, oldValue, value).catch(err => {
      console.warn('[CFM] paddock_history insert failed:', err.message);
    });
  } catch (err) {
    toast('Save failed — ' + (err.message || 'error'), 'error');
    _setIndicator(id, '!');
  }

  _saving.delete(key);
}

function _setIndicator(id, text, clearAfterMs = 0) {
  const el = _container.querySelector(`#pk-ind-${id}`);
  if (!el) return;
  el.textContent = text;
  el.style.color = text === '✓' ? 'var(--green,#16a34a)' : text === '!' ? 'var(--red,#dc2626)' : 'var(--hint)';
  if (clearAfterMs) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, clearAfterMs);
}

async function _logHistory(paddockId, field, oldValue, newValue, notes = null) {
  const farm = getActiveFarm();
  if (!farm) return;
  const user = getSession()?.user?.email || null;
  const entry = {
    paddock_id: paddockId,
    farm_id:    farm.id,
    field,
    old_value:  oldValue != null ? String(oldValue) : null,
    new_value:  newValue != null ? String(newValue) : null,
    changed_by: user,
    notes,
  };
  const result = await dbInsert('paddock_history', entry);
  const saved  = Array.isArray(result) ? result[0] : result;
  if (saved) {
    if (!_history[paddockId]) _history[paddockId] = [];
    _history[paddockId].unshift(saved);
    // If history panel is open, refresh it
    if (_historyOpen.has(paddockId)) {
      _refreshHistoryPanel(paddockId);
    } else {
      // Update the count badge on the toggle button
      const btn = _container.querySelector(`.pk-history-btn[data-id="${paddockId}"]`);
      if (btn) {
        const count = _history[paddockId].length;
        btn.style.opacity = '1';
        btn.textContent = `▸ History (${count})`;
      }
    }
  }
}

function _refreshHistoryPanel(paddockId) {
  const p = _paddocks.find(x => x.id === paddockId);
  if (!p) return;
  const existing = _container.querySelector(`tr.pk-history-row[data-history-for="${paddockId}"]`);
  if (existing) {
    const tmp = document.createElement('tbody');
    tmp.innerHTML = _historyPanelHTML(p);
    existing.replaceWith(tmp.firstElementChild);
  }
}

function _refreshFilterCounts() {
  _refreshSidePanel();
}

function _refreshSummary() {
  _refreshSidePanel();
}

function _refreshSidePanel() {
  const el = _container.querySelector('#pk-side-panel');
  if (!el) return;
  const types = _allTypes();
  const tmp   = document.createElement('div');
  tmp.innerHTML = _sidePanelHTML(types);
  const fresh = tmp.firstElementChild;
  if (fresh) {
    el.replaceWith(fresh);
    // Re-bind filter clicks on the fresh panel
    _bindFilterClicks();
  }
}

// ── Add new row ──────────────────────────────────────────────────────────────

async function _addNewRow() {
  const farm = getActiveFarm();
  if (!farm) return;
  try {
    const result     = await dbInsert('paddocks', { farm_id: farm.id, name: 'New paddock', map_area: null, type: null });
    const newPaddock = Array.isArray(result) ? result[0] : result;
    if (!newPaddock) return;
    _paddocks.push(newPaddock);

    // Reset filter to All so the new row is visible
    _activeFilter = 'All';
    _container.querySelectorAll('.pk-filter-btn').forEach(b =>
      b.classList.toggle('pk-filter-active', b.dataset.filter === 'All'));

    const tbody = _container.querySelector('#pk-tbody');
    if (tbody.querySelector('td[colspan]')) tbody.innerHTML = '';
    tbody.insertAdjacentHTML('beforeend', _rowHTML(newPaddock));
    _bindTableEvents();
    _refreshFilterCounts();

    // Scroll to new row and select name
    const nameInput = tbody.querySelector(`[data-id="${newPaddock.id}"][data-field="name"]`);
    if (nameInput) {
      nameInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      nameInput.select();
    }
  } catch (err) {
    toast('Could not add paddock', 'error');
  }
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
      if (_paddocks.length === 0) {
        _container.querySelector('#pk-tbody').innerHTML =
          `<tr><td colspan="4" style="color:var(--hint);text-align:center;padding:32px">No paddocks yet.</td></tr>`;
      }
      _refreshFilterCounts();
      toast(`"${name}" deleted`);
    },
  });
}

// ── Inline note edit on a history entry ─────────────────────────────────────

function _inlineEditNote(btn) {
  const histId    = btn.dataset.histId;
  const paddockId = btn.dataset.paddockId;
  const entry     = (_history[paddockId] || []).find(e => e.id === histId);
  if (!entry) return;

  const noteRow = btn.closest('.pk-hist-note-row');
  if (!noteRow) return;

  // Replace button (and existing note text) with an inline input
  const current = entry.notes || '';
  noteRow.innerHTML = `
    <input class="pk-inline-note-input" type="text" value="${_esc(current)}"
      placeholder="Add a note…"
      style="flex:1;min-width:0;font-size:0.78rem;padding:2px 6px;border:1px solid var(--border);
      border-radius:4px;background:var(--surface);color:var(--ink);font-style:italic">
    <button class="btn btn-xs pk-inline-note-save" style="font-size:0.68rem;padding:1px 6px">Save</button>
    <button class="btn btn-xs pk-inline-note-cancel" style="font-size:0.68rem;padding:1px 5px;opacity:0.5">✕</button>`;

  const input  = noteRow.querySelector('.pk-inline-note-input');
  const save   = noteRow.querySelector('.pk-inline-note-save');
  const cancel = noteRow.querySelector('.pk-inline-note-cancel');

  input.focus();
  input.select();

  const doSave = async () => {
    const val = input.value.trim() || null;
    try {
      await _updateHistoryNote(histId, paddockId, val);
      // Refresh the whole history panel to reflect the change
      _refreshHistoryPanel(paddockId);
    } catch (err) {
      toast('Could not save note', 'error');
      _refreshHistoryPanel(paddockId);
    }
  };

  save.addEventListener('click', doSave);
  cancel.addEventListener('click', () => _refreshHistoryPanel(paddockId));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); _refreshHistoryPanel(paddockId); }
  });
}

async function _updateHistoryNote(histId, paddockId, notes) {
  await dbUpdate('paddock_history', histId, { notes });
  // Update in-memory entry
  const entry = (_history[paddockId] || []).find(e => e.id === histId);
  if (entry) entry.notes = notes;
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

  const existingCount = _paddocks.length;

  openModal({
    title: 'Import paddocks',
    bodyHTML: `
      <p style="margin-bottom:8px">Found <strong>${rows.length} paddock${rows.length !== 1 ? 's' : ''}</strong> in the CSV.</p>
      ${existingCount > 0
        ? `<p style="margin-bottom:12px;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:0.85rem;color:var(--ink)">
            ⚠️ This will <strong>replace all ${existingCount} existing paddock${existingCount !== 1 ? 's' : ''}</strong> for this farm with the CSV contents.
           </p>`
        : ''}
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
    confirmLabel: existingCount > 0
      ? `Replace all & import ${rows.length} paddock${rows.length !== 1 ? 's' : ''}`
      : `Import ${rows.length} paddock${rows.length !== 1 ? 's' : ''}`,
    confirmClass: existingCount > 0 ? 'btn-danger' : '',
    onConfirm: async () => {
      const farm = getActiveFarm();

      // Delete all existing paddocks for this farm first
      for (const p of _paddocks) {
        await dbDelete('paddocks', p.id);
      }

      // Insert all rows from CSV
      let added = 0;
      for (const r of rows) {
        const name = r[nameIdx]?.trim();
        if (!name) continue;
        const area = areaIdx !== -1 ? parseFloat(r[areaIdx]) : null;
        const type = typeIdx !== -1 ? (r[typeIdx]?.trim() || null) : null;
        await dbInsert('paddocks', { farm_id: farm.id, name, map_area: isNaN(area) ? null : area, type });
        added++;
      }
      toast(`Imported ${added} paddock${added !== 1 ? 's' : ''}`);
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
