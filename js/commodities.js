// js/commodities.js
// Shared commodity and crop type data layer
// Loads once per session, provides dynamic lists to all modules

import { dbSelect, dbInsert, dbDelete } from './supabase-client.js';

let _commodities = [];
let _cropTypes = [];
let _loaded = false;

// ── Load once ─────────────────────────────────────────────────
export async function loadCommodities() {
  if (_loaded) return;
  [_commodities, _cropTypes] = await Promise.all([
    dbSelect('commodities', 'select=*&order=name'),
    dbSelect('crop_types', 'select=*&order=name'),
  ]);
  _loaded = true;
}

export function getCommodities() { return _commodities; }
export function getCropTypes(commodityId = null) {
  if (!commodityId) return _cropTypes;
  return _cropTypes.filter(ct => ct.commodity_id === commodityId);
}

export function getCommodityById(id) {
  return _commodities.find(c => c.id === id) || null;
}

export function getCommodityByName(name) {
  return _commodities.find(c => c.name.toLowerCase() === name.toLowerCase()) || null;
}

export function isLivestock(commodityId) {
  return _commodities.find(c => c.id === commodityId)?.is_livestock || false;
}

// Force reload (after add/delete)
export function invalidateCache() { _loaded = false; }

// ── Add commodity ─────────────────────────────────────────────
export async function addCommodity(name, isLivestock = false) {
  const row = await dbInsert('commodities', { name, is_livestock: isLivestock });
  _commodities.push(row);
  _commodities.sort((a, b) => a.name.localeCompare(b.name));
  return row;
}

// ── Add crop type ─────────────────────────────────────────────
export async function addCropType(commodityId, name) {
  const row = await dbInsert('crop_types', { commodity_id: commodityId, name });
  _cropTypes.push(row);
  _cropTypes.sort((a, b) => a.name.localeCompare(b.name));
  return row;
}

// ── Delete ────────────────────────────────────────────────────
export async function deleteCommodity(id) {
  await dbDelete('commodities', id);
  _commodities = _commodities.filter(c => c.id !== id);
  _cropTypes = _cropTypes.filter(ct => ct.commodity_id !== id);
}

export async function deleteCropType(id) {
  await dbDelete('crop_types', id);
  _cropTypes = _cropTypes.filter(ct => ct.id !== id);
}

// ── Commodity select HTML helper ──────────────────────────────
// Returns <option> tags for a commodity dropdown
export function commodityOptions(selectedId = null) {
  return _commodities.map(c =>
    `<option value="${c.id}" data-livestock="${c.is_livestock}" ${c.id === selectedId ? 'selected' : ''}>${c.name}</option>`
  ).join('');
}

// ── Crop type select HTML helper ──────────────────────────────
// Returns <option> tags filtered by commodity
export function cropTypeOptions(commodityId = null, selectedId = null) {
  const types = commodityId
    ? _cropTypes.filter(ct => ct.commodity_id === commodityId)
    : _cropTypes;
  if (!types.length) return '<option value="">No crop types defined</option>';
  return types.map(ct =>
    `<option value="${ct.id}" ${ct.id === selectedId ? 'selected' : ''}>${ct.name}</option>`
  ).join('');
}

// ── Inline add select widgets ─────────────────────────────────
// Renders a commodity <select> with an inline "Add new" flow.
// Usage: insert the returned HTML, then call initCommoditySelect(selectEl)

export function commoditySelectHTML(id, selectedId = null) {
  return `
    <select class="form-select" id="${id}">
      <option value="">Select commodity…</option>
      ${commodityOptions(selectedId)}
      <option value="__add__" style="color:var(--earth);font-weight:600">＋ Add new commodity…</option>
    </select>
    <div id="${id}-add-row" style="display:none;margin-top:8px;display:none">
      <div style="display:flex;gap:8px;align-items:center">
        <input class="form-input" id="${id}-add-name" type="text" placeholder="New commodity name" style="flex:1">
        <label style="display:flex;align-items:center;gap:4px;font-size:var(--text-sm);white-space:nowrap;cursor:pointer">
          <input type="checkbox" id="${id}-add-livestock"> Livestock
        </label>
        <button class="btn btn-primary btn-sm" id="${id}-add-btn" type="button">Add</button>
        <button class="btn btn-secondary btn-sm" id="${id}-cancel-btn" type="button">Cancel</button>
      </div>
    </div>
  `;
}

// Call after inserting commoditySelectHTML into the DOM
// onSelect(commodityId, commodityObject) called when selection changes or new added
export function initCommoditySelect(containerId, onSelect = null) {
  const sel = document.getElementById(containerId);
  const addRow = document.getElementById(`${containerId}-add-row`);
  const addName = document.getElementById(`${containerId}-add-name`);
  const addLivestock = document.getElementById(`${containerId}-add-livestock`);
  const addBtn = document.getElementById(`${containerId}-add-btn`);
  const cancelBtn = document.getElementById(`${containerId}-cancel-btn`);

  if (!sel) return;

  sel.addEventListener('change', () => {
    if (sel.value === '__add__') {
      addRow.style.display = 'block';
      addName.focus();
      sel.value = '';
    } else {
      addRow.style.display = 'none';
      const commodity = _commodities.find(c => c.id === sel.value);
      if (onSelect) onSelect(sel.value, commodity);
    }
  });

  addBtn?.addEventListener('click', async () => {
    const name = addName.value.trim();
    if (!name) { addName.focus(); return; }
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    try {
      const commodity = await addCommodity(name, addLivestock.checked);
      // Add to select and choose it
      const opt = document.createElement('option');
      opt.value = commodity.id;
      opt.textContent = commodity.name;
      opt.dataset.livestock = commodity.is_livestock;
      // Insert before the __add__ option
      const addOpt = sel.querySelector('option[value="__add__"]');
      sel.insertBefore(opt, addOpt);
      sel.value = commodity.id;
      addRow.style.display = 'none';
      addName.value = '';
      addLivestock.checked = false;
      if (onSelect) onSelect(commodity.id, commodity);
    } catch (err) {
      alert(err.message || 'Failed to add commodity');
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  });

  addName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBtn?.click();
    if (e.key === 'Escape') cancelBtn?.click();
  });

  cancelBtn?.addEventListener('click', () => {
    addRow.style.display = 'none';
    addName.value = '';
    sel.value = '';
  });
}

// ── Crop type select with inline add ─────────────────────────
export function cropTypeSelectHTML(id, commodityId = null, selectedId = null) {
  const types = commodityId
    ? _cropTypes.filter(ct => ct.commodity_id === commodityId)
    : [];
  return `
    <select class="form-select" id="${id}">
      <option value="">No crop type (commodity level)</option>
      ${types.map(ct => `<option value="${ct.id}" ${ct.id === selectedId ? 'selected' : ''}>${ct.name}</option>`).join('')}
      ${commodityId ? '<option value="__add__" style="color:var(--earth);font-weight:600">＋ Add new crop type…</option>' : ''}
    </select>
    <div id="${id}-add-row" style="display:none;margin-top:8px">
      <div style="display:flex;gap:8px">
        <input class="form-input" id="${id}-add-name" type="text" placeholder="e.g. Cotton Irrigated" style="flex:1">
        <button class="btn btn-primary btn-sm" id="${id}-add-btn" type="button">Add</button>
        <button class="btn btn-secondary btn-sm" id="${id}-cancel-btn" type="button">Cancel</button>
      </div>
    </div>
  `;
}

// Refresh crop type select when commodity changes
export function refreshCropTypeSelect(selectId, commodityId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const types = commodityId ? _cropTypes.filter(ct => ct.commodity_id === commodityId) : [];
  sel.innerHTML = `
    <option value="">No crop type (commodity level)</option>
    ${types.map(ct => `<option value="${ct.id}">${ct.name}</option>`).join('')}
    ${commodityId ? '<option value="__add__" style="color:var(--earth);font-weight:600">＋ Add new crop type…</option>' : ''}
  `;
}

export function initCropTypeSelect(selectId, getCommodityId, onSelect = null) {
  const sel = document.getElementById(selectId);
  const addRow = document.getElementById(`${selectId}-add-row`);
  const addName = document.getElementById(`${selectId}-add-name`);
  const addBtn = document.getElementById(`${selectId}-add-btn`);
  const cancelBtn = document.getElementById(`${selectId}-cancel-btn`);

  if (!sel) return;

  sel.addEventListener('change', () => {
    if (sel.value === '__add__') {
      addRow.style.display = 'block';
      addName.focus();
      sel.value = '';
    } else {
      addRow.style.display = 'none';
      if (onSelect) onSelect(sel.value);
    }
  });

  addBtn?.addEventListener('click', async () => {
    const name = addName.value.trim();
    const commodityId = getCommodityId();
    if (!name || !commodityId) { addName.focus(); return; }
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    try {
      const cropType = await addCropType(commodityId, name);
      const opt = document.createElement('option');
      opt.value = cropType.id;
      opt.textContent = cropType.name;
      const addOpt = sel.querySelector('option[value="__add__"]');
      sel.insertBefore(opt, addOpt);
      sel.value = cropType.id;
      addRow.style.display = 'none';
      addName.value = '';
      if (onSelect) onSelect(cropType.id);
    } catch (err) {
      alert(err.message || 'Failed to add crop type');
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = 'Add';
    }
  });

  addName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBtn?.click();
    if (e.key === 'Escape') cancelBtn?.click();
  });

  cancelBtn?.addEventListener('click', () => {
    addRow.style.display = 'none';
    addName.value = '';
    sel.value = '';
  });
}
