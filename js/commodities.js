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
