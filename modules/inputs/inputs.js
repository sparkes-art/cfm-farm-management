// modules/inputs/inputs.js
// Inputs module — fertiliser, chemical, seed, fuel, labour, other
// Fertiliser is a featured section within this module.

import { dbSelect, dbInsert, dbUpdate, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite } from '../../js/app-state.js';
import {
  toast, openModal, formatCurrency, formatDate,
  qs, setContent, currentSeason
} from '../../js/ui.js';

let _inputs = [];
let _unsub = null;

const CATEGORIES = ['fertiliser', 'chemical', 'seed', 'fuel', 'labour', 'other'];
const CAT_ICONS  = { fertiliser: '🌱', chemical: '🧪', seed: '🌾', fuel: '⛽', labour: '👷', other: '📦' };

export async function mountInputs(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Inputs</h1>
        <p class="page-subtitle">Fertiliser, chemical, seed, fuel and labour costs</p>
      </div>
      <div class="flex gap-2">
        <select id="inp-category-filter" class="form-select" style="width:140px">
          <option value="">All categories</option>
          ${CATEGORIES.map(c => `<option value="${c}">${CAT_ICONS[c]} ${_cap(c)}</option>`).join('')}
        </select>
        ${canWrite() ? '<button class="btn btn-primary" id="btn-new-input">＋ New purchase</button>' : ''}
      </div>
    </div>

    <div class="stats-strip" id="inp-stats"></div>

    <div class="card">
      <div class="card-header">
        <h2>Input purchases</h2>
        <span id="inp-count" class="text-muted text-sm"></span>
      </div>
      <div id="inp-table-wrap">
        <div class="empty-state"><div class="empty-icon">🌱</div><p>Loading…</p></div>
      </div>
    </div>
  `;

  await _loadData();
  _renderStats();
  _renderTable();

  qs('#inp-category-filter', container)?.addEventListener('change', () => {
    _renderStats(); _renderTable();
  });

  if (canWrite()) {
    qs('#btn-new-input', container)?.addEventListener('click', () => openInputModal());
  }

  _subscribeRealtime();
}

export function unmountInputs() {
  if (_unsub) { _unsub(); _unsub = null; }
  _inputs = [];
}

async function _loadData() {
  const farm = getActiveFarm();
  if (!farm) return;
  _inputs = await dbSelect('input_purchases',
    `farm_id=eq.${farm.id}&select=*&order=purchase_date.desc`);
}

function _subscribeRealtime() {
  const farm = getActiveFarm();
  if (!farm) return;
  _unsub = subscribeTable('input_purchases', farm.id, async (event, payload) => {
    if (event === 'INSERT') {
      if (!_inputs.find(r => r.id === payload.record.id)) _inputs.unshift(payload.record);
    }
    else if (event === 'UPDATE') {
      const i = _inputs.findIndex(r => r.id === payload.record.id);
      if (i >= 0) _inputs[i] = payload.record;
    } else if (event === 'DELETE') {
      _inputs = _inputs.filter(r => r.id !== payload.old_record.id);
    }
    _renderStats(); _renderTable();
  });
}

function _filtered() {
  const cat = qs('#inp-category-filter')?.value || '';
  return _inputs.filter(r => !cat || r.category === cat);
}

function _renderStats() {
  const rows = _filtered();
  const total = rows.reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0);
  const byCategory = CATEGORIES.map(c => ({
    c, total: rows.filter(r => r.category === c).reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0)
  })).filter(x => x.total > 0);

  setContent('#inp-stats', `
    <div class="stat-card">
      <div class="stat-label">Total input spend</div>
      <div class="stat-value earth">${formatCurrency(total, 0)}</div>
    </div>
    ${byCategory.map(x => `
      <div class="stat-card">
        <div class="stat-label">${CAT_ICONS[x.c]} ${_cap(x.c)}</div>
        <div class="stat-value">${formatCurrency(x.total, 0)}</div>
      </div>
    `).join('')}
  `);
}

function _renderTable() {
  const rows = _filtered();
  const wrap = qs('#inp-table-wrap');
  if (!wrap) return;

  setContent('#inp-count', `${rows.length} purchase${rows.length !== 1 ? 's' : ''}`);

  if (!rows.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">🌱</div><p>No input purchases recorded yet.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Category</th>
          <th>Product</th>
          <th>Supplier</th>
          <th>Date</th>
          <th>Season</th>
          <th class="num">Qty</th>
          <th class="num">Unit cost</th>
          <th class="num">Total cost</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${CAT_ICONS[r.category]} <span class="badge badge-draft">${_cap(r.category)}</span></td>
            <td><strong>${r.product_name}</strong></td>
            <td class="muted">${r.supplier || '—'}</td>
            <td class="muted">${formatDate(r.purchase_date)}</td>
            <td class="muted">${r.season || '—'}</td>
            <td class="num">${r.quantity ? `${r.quantity} ${r.unit || ''}` : '—'}</td>
            <td class="num">${r.unit_cost ? formatCurrency(r.unit_cost, 4) : '—'}</td>
            <td class="num"><strong>${formatCurrency(r.total_cost)}</strong></td>
            ${canWrite() ? `<td><button class="btn btn-ghost btn-sm" onclick="window.__cfmEditInput('${r.id}')">Edit</button></td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

// Attach edit handler to window for table onclick use
window.__cfmEditInput = (id) => {
  const row = _inputs.find(r => r.id === id);
  if (row) openInputModal(row);
};

function openInputModal(existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;

  openModal({
    title: isEdit ? 'Edit input purchase' : 'Record input purchase',
    confirmLabel: isEdit ? 'Save changes' : 'Record purchase',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Category <span class="required">*</span></label>
          <select class="form-select" id="i-category" required>
            ${CATEGORIES.map(c => `<option value="${c}" ${(existing?.category || 'fertiliser') === c ? 'selected' : ''}>${CAT_ICONS[c]} ${_cap(c)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Season</label>
          <input class="form-input" id="i-season" type="text" value="${existing?.season || currentSeason()}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Product name <span class="required">*</span></label>
          <input class="form-input" id="i-product" type="text" value="${existing?.product_name || ''}" placeholder="e.g. Urea 46%, Glyphosate 450, Bollgard 3" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Supplier</label>
          <input class="form-input" id="i-supplier" type="text" value="${existing?.supplier || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Purchase date <span class="required">*</span></label>
          <input class="form-input" id="i-date" type="date" value="${existing?.purchase_date || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Supplier invoice ref</label>
          <input class="form-input" id="i-ref" type="text" value="${existing?.invoice_reference || ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Quantity</label>
          <input class="form-input num" id="i-qty" type="number" step="0.001" value="${existing?.quantity || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="i-unit">
            ${['tonne','kg','L','mL','bag','drum','ha','each'].map(u =>
              `<option ${(existing?.unit || 'tonne') === u ? 'selected' : ''}>${u}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Unit cost</label>
          <input class="form-input num" id="i-unit-cost" type="number" step="0.0001" value="${existing?.unit_cost || ''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Total cost <span class="required">*</span></label>
        <input class="form-input num" id="i-total" type="number" step="0.01" value="${existing?.total_cost || ''}" required>
        <p class="form-helper">Enter total directly, or it can be auto-calculated from qty × unit cost.</p>
      </div>
    `,
    onConfirm: async () => {
      const v = (id) => qs(`#${id}`)?.value?.trim() || '';
      const n = (id) => parseFloat(qs(`#${id}`)?.value || 0) || null;
      const productName = v('i-product');
      const purchaseDate = v('i-date');
      const totalCost = n('i-total');

      if (!productName || !purchaseDate || !totalCost) {
        throw new Error('Please fill in all required fields');
      }

      const row = {
        farm_id: farm.id,
        category: v('i-category'),
        product_name: productName,
        supplier: v('i-supplier') || null,
        purchase_date: purchaseDate,
        season: v('i-season') || currentSeason(),
        invoice_reference: v('i-ref') || null,
        quantity: n('i-qty'),
        unit: v('i-unit') || null,
        unit_cost: n('i-unit-cost'),
        total_cost: totalCost,
        created_by: getSession()?.user?.id,
      };

      if (isEdit) {
        await dbUpdate('input_purchases', existing.id, row);
        toast('Purchase updated', 'success');
      } else {
        await dbInsert('input_purchases', row);
        toast('Purchase recorded', 'success');
      }
      await _loadData(); _renderStats(); _renderTable();
    },
  });

  // Auto-calc total from qty × unit cost
  const calcTotal = () => {
    const qty = parseFloat(qs('#i-qty')?.value || 0);
    const uc = parseFloat(qs('#i-unit-cost')?.value || 0);
    if (qty && uc) {
      const t = qs('#i-total');
      if (t && !t.value) t.value = (qty * uc).toFixed(2);
    }
  };
  setTimeout(() => {
    qs('#i-qty')?.addEventListener('change', calcTotal);
    qs('#i-unit-cost')?.addEventListener('change', calcTotal);
  }, 100);
}

function _cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
