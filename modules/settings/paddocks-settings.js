// paddocks-settings.js
// Paddock list management — per farm, stored in Supabase paddocks table.
// Fields: name, map_area (ha), type (Crop / Fallow / Pasture / Other)

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js?v=1794541175400';
import { getActiveFarm } from '../../js/app-state.js?v=1794541175400';
import { toast, openModal } from '../../js/ui.js?v=1794541175400';

const PADDOCK_TYPES = ['Crop', 'Fallow', 'Pasture', 'Headland', 'Other'];

let _container = null;
let _paddocks   = [];

// ── Public entry point ──────────────────────────────────────────────────────

export async function mountPaddocksSettings(container) {
  _container = container;
  await _refresh();
}

// ── Data ────────────────────────────────────────────────────────────────────

async function _refresh() {
  const farm = getActiveFarm();
  if (!farm) {
    _container.innerHTML = '<p style="color:var(--hint);padding:20px">Select a farm to manage paddocks.</p>';
    return;
  }

  _paddocks = await dbSelect('paddocks', { farm_id: farm.id }, 'name');
  _render();
}

// ── Render ───────────────────────────────────────────────────────────────────

function _render() {
  _container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px">
      <div style="font-size:0.85rem;color:var(--hint)">${_paddocks.length} paddock${_paddocks.length !== 1 ? 's' : ''} for ${getActiveFarm()?.name || ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" id="pk-import-btn">⬆ Import CSV</button>
        <button class="btn btn-sm" id="pk-export-btn">⬇ Export CSV</button>
        <button class="btn btn-primary btn-sm" id="pk-add-btn">+ Add paddock</button>
      </div>
    </div>

    <div class="card" style="overflow:hidden">
      <table class="data-table" style="width:100%">
        <thead>
          <tr>
            <th>Name</th>
            <th>Map area (ha)</th>
            <th>Type</th>
            <th style="width:80px"></th>
          </tr>
        </thead>
        <tbody id="pk-tbody">
          ${_paddocks.length === 0
            ? `<tr><td colspan="4" style="color:var(--hint);text-align:center;padding:24px">
                No paddocks yet — add one or import a CSV.
               </td></tr>`
            : _paddocks.map(p => _rowHTML(p)).join('')}
        </tbody>
      </table>
    </div>

    <!-- Hidden file input for CSV import -->
    <input type="file" id="pk-file-input" accept=".csv" style="display:none">
  `;

  _container.querySelector('#pk-add-btn').addEventListener('click', () => _openEditModal(null));
  _container.querySelector('#pk-export-btn').addEventListener('click', _exportCSV);
  _container.querySelector('#pk-import-btn').addEventListener('click', () => {
    _container.querySelector('#pk-file-input').click();
  });
  _container.querySelector('#pk-file-input').addEventListener('change', _handleImport);

  _container.querySelectorAll('.pk-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _paddocks.find(x => x.id === btn.dataset.id);
      if (p) _openEditModal(p);
    });
  });

  _container.querySelectorAll('.pk-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => _confirmDelete(btn.dataset.id, btn.dataset.name));
  });
}

function _rowHTML(p) {
  return `
    <tr>
      <td style="font-weight:500">${_esc(p.name)}</td>
      <td>${p.map_area != null ? Number(p.map_area).toLocaleString('en-AU', {maximumFractionDigits:1}) : '—'}</td>
      <td>${_esc(p.type || '—')}</td>
      <td style="text-align:right">
        <button class="btn btn-xs pk-edit-btn" data-id="${p.id}" data-name="${_esc(p.name)}">Edit</button>
        <button class="btn btn-xs btn-danger pk-delete-btn" data-id="${p.id}" data-name="${_esc(p.name)}" style="margin-left:4px">✕</button>
      </td>
    </tr>
  `;
}

// ── Add / Edit modal ─────────────────────────────────────────────────────────

function _openEditModal(paddock) {
  const isNew = !paddock;
  const bodyHTML = `
    <div class="form-group">
      <label class="form-label">Paddock name <span style="color:var(--red)">*</span></label>
      <input class="form-input" id="pk-name" placeholder="e.g. Homestead North" value="${_esc(paddock?.name || '')}">
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Map area (ha)</label>
        <input class="form-input" id="pk-area" type="number" step="0.1" min="0" placeholder="0.0" value="${paddock?.map_area ?? ''}">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select class="form-select" id="pk-type">
          ${PADDOCK_TYPES.map(t => `<option value="${t}"${paddock?.type === t ? ' selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
    </div>
  `;

  openModal({
    title: isNew ? 'Add paddock' : `Edit — ${paddock.name}`,
    bodyHTML,
    confirmLabel: isNew ? 'Add paddock' : 'Save changes',
    onConfirm: async () => {
      const name = document.getElementById('pk-name')?.value.trim();
      const area = document.getElementById('pk-area')?.value;
      const type = document.getElementById('pk-type')?.value;

      if (!name) { toast('Paddock name is required', 'error'); throw new Error('validation'); }

      const farm = getActiveFarm();
      const row = {
        farm_id:  farm.id,
        name,
        map_area: area !== '' && area != null ? parseFloat(area) : null,
        type:     type || null,
      };

      if (isNew) {
        await dbInsert('paddocks', row);
        toast(`Paddock "${name}" added`);
      } else {
        await dbUpdate('paddocks', paddock.id, row);
        toast(`Paddock "${name}" updated`);
      }

      await _refresh();
    },
  });
}

// ── Delete ───────────────────────────────────────────────────────────────────

function _confirmDelete(id, name) {
  openModal({
    title: 'Delete paddock?',
    bodyHTML: `<p>Remove <strong>${_esc(name)}</strong> from the paddock list? This won't delete any scouting records linked to it.</p>`,
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger',
    onConfirm: async () => {
      await dbDelete('paddocks', id);
      toast(`Paddock "${name}" deleted`);
      await _refresh();
    },
  });
}

// ── CSV export ───────────────────────────────────────────────────────────────

function _exportCSV() {
  if (_paddocks.length === 0) { toast('No paddocks to export', 'warning'); return; }

  const farm = getActiveFarm();
  const rows = [
    ['Name', 'Map Area (ha)', 'Type'],
    ..._paddocks.map(p => [
      _csvCell(p.name),
      p.map_area != null ? p.map_area : '',
      _csvCell(p.type || ''),
    ]),
  ];
  const csv = rows.map(r => r.join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${(farm?.name || 'farm').replace(/\s+/g, '-').toLowerCase()}-paddocks.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${_paddocks.length} paddocks`);
}

// ── CSV import ───────────────────────────────────────────────────────────────

async function _handleImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be re-imported

  const text = await file.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) { toast('CSV appears empty', 'error'); return; }

  // Parse header row to find column positions (case-insensitive)
  const header = _parseCSVRow(lines[0]).map(h => h.toLowerCase().trim());
  const nameIdx = header.findIndex(h => h === 'name');
  const areaIdx = header.findIndex(h => h.includes('area') || h.includes('ha'));
  const typeIdx = header.findIndex(h => h === 'type');

  if (nameIdx === -1) { toast('CSV must have a "Name" column', 'error'); return; }

  const rows = lines.slice(1)
    .map(l => _parseCSVRow(l))
    .filter(r => r[nameIdx]?.trim());

  if (rows.length === 0) { toast('No data rows found in CSV', 'error'); return; }

  // Preview modal before commit
  openModal({
    title: 'Import paddocks',
    bodyHTML: `
      <p style="margin-bottom:12px">Found <strong>${rows.length} paddock${rows.length !== 1 ? 's' : ''}</strong> in the CSV. This will <strong>add</strong> them alongside existing paddocks (duplicates by name will be skipped).</p>
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
      </div>
    `,
    confirmLabel: `Import ${rows.length} paddock${rows.length !== 1 ? 's' : ''}`,
    onConfirm: async () => {
      const farm = getActiveFarm();
      const existingNames = new Set(_paddocks.map(p => p.name.toLowerCase()));
      let added = 0, skipped = 0;

      for (const r of rows) {
        const name = r[nameIdx]?.trim();
        if (!name) continue;
        if (existingNames.has(name.toLowerCase())) { skipped++; continue; }

        const area = areaIdx !== -1 ? parseFloat(r[areaIdx]) : null;
        const type = typeIdx !== -1 ? (r[typeIdx]?.trim() || null) : null;

        await dbInsert('paddocks', {
          farm_id:  farm.id,
          name,
          map_area: isNaN(area) ? null : area,
          type,
        });
        added++;
      }

      toast(`Imported ${added} paddock${added !== 1 ? 's' : ''}${skipped ? ` (${skipped} skipped — already exist)` : ''}`);
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
  const result = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}
