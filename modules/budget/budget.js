// modules/budget/budget.js
// Budget & Forecast — inline editable table per crop type per season

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite } from '../../js/app-state.js';
import { loadCommodities, getCommodities, getCropTypes, commoditySelectHTML, initCommoditySelect, cropTypeSelectHTML, initCropTypeSelect, refreshCropTypeSelect } from '../../js/commodities.js';
import { toast, openModal, formatNumber, formatCurrency, qs, currentSeason } from '../../js/ui.js';

let _budgets = [];
let _forecasts = [];
let _harvests = [];
let _season = currentSeason();

export async function mountBudget(container) {
  await loadCommodities();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Budget & Production</h1>
        <p class="page-subtitle">Set estimated production and budget price per crop type for each season</p>
      </div>
      <div class="flex gap-2 items-center">
        <label style="font-size:var(--text-sm);color:var(--muted)">Crop year</label>
        <select id="bud-season" class="form-select" style="width:110px">
          ${_seasonOptions()}
        </select>
        ${canWrite() ? '<button class="btn btn-secondary" id="btn-add-row">＋ Add crop type</button>' : ''}
      </div>
    </div>

    <div class="card">
      <div id="budget-table-wrap">
        <div class="empty-state"><span class="loading-spinner"></span></div>
      </div>
    </div>

    <!-- Harvest section -->
    <div style="margin-top:20px">
      <div class="page-header" style="margin-bottom:12px">
        <h2 style="font-size:var(--text-md);font-weight:600">Harvest entries</h2>
        ${canWrite() ? '<button class="btn btn-secondary btn-sm" id="btn-add-harvest">＋ Add harvest</button>' : ''}
      </div>
      <div class="card">
        <div id="harvest-table-wrap">
          <div class="empty-state"><span class="loading-spinner"></span></div>
        </div>
      </div>
    </div>
  `;

  qs('#bud-season', container)?.addEventListener('change', async (e) => {
    _season = e.target.value;
    await _loadData();
    _renderTable(container);
    _renderHarvest(container);
  });

  if (canWrite()) {
    qs('#btn-add-row', container)?.addEventListener('click', () => _addRowModal(container));
    qs('#btn-add-harvest', container)?.addEventListener('click', () => _harvestModal(container));
  }

  await _loadData();
  _renderTable(container);
  _renderHarvest(container);
}

export function unmountBudget() {
  _budgets = [];
  _forecasts = [];
  _harvests = [];
}

function _seasonOptions() {
  const current = currentSeason();
  const [y] = current.split('-').map(Number);
  return Array.from({ length: 6 }, (_, i) => {
    const s = `${y + 1 - i}-${String(y + 2 - i).slice(2)}`;
    return `<option value="${s}" ${s === _season ? 'selected' : ''}>${s}</option>`;
  }).join('');
}

async function _loadData() {
  const farm = getActiveFarm();
  if (!farm) return;
  [_budgets, _forecasts, _harvests] = await Promise.all([
    dbSelect('budgets', `farm_id=eq.${farm.id}&season=eq.${_season}&select=*&order=created_at.asc`),
    dbSelect('forecasts', `farm_id=eq.${farm.id}&season=eq.${_season}&select=*&order=forecast_date.asc`),
    dbSelect('harvest_entries', `farm_id=eq.${farm.id}&season=eq.${_season}&select=*&order=created_at.asc`),
  ]);
}

// ── Budget table ──────────────────────────────────────────────
function _renderTable(container) {
  const wrap = qs('#budget-table-wrap', container);
  if (!wrap) return;

  const commodities = getCommodities();
  const cropTypes = getCropTypes();

  if (!_budgets.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>No budget entries for ${_season}.</p>
        <p>Click "＋ Add crop type" to set your first budget.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div style="overflow-x:auto">
      <table class="data-table" style="min-width:900px">
        <thead>
          <tr>
            <th style="min-width:120px">Crop type</th>
            <th style="min-width:110px">Commodity</th>
            <th style="min-width:55px">Unit</th>
            <th class="num" style="min-width:80px;border-left:2px solid var(--blue-light)">Bud area (ha)</th>
            <th class="num" style="min-width:90px">Bud yld/ha</th>
            <th class="num" style="min-width:80px;color:var(--blue)">Bud prod</th>
            <th class="num" style="min-width:80px">Bud price</th>
            <th class="num" style="min-width:80px;border-left:2px solid #0f766e33">Fcast area (ha)</th>
            <th class="num" style="min-width:90px">Fcast yld/ha</th>
            <th class="num" style="min-width:80px;color:#0f766e">Fcast prod</th>
            ${canWrite() ? '<th style="min-width:60px"></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${_budgets.map(b => {
            const commodity = commodities.find(c => c.id === b.commodity_id);
            const cropType = cropTypes.find(ct => ct.id === b.crop_type_id);
            const budProd = (parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0);

            // Latest forecast for this budget
            const forecasts = _forecasts.filter(f => f.budget_id === b.id);
            const latestF = forecasts[forecasts.length - 1] || null;
            const fcastProd = latestF ? (parseFloat(latestF.forecast_production) || (parseFloat(latestF.area_ha)||0) * (parseFloat(latestF.yield_per_ha)||0)) : null;

            return `
              <tr data-budget-id="${b.id}">
                <td><strong>${cropType?.name || b.crop_type || '—'}</strong></td>
                <td>${commodity?.name || b.commodity || '—'}</td>
                <td class="muted">${b.unit || 't'}</td>
                <td class="num" style="border-left:2px solid var(--blue-light)">
                  <input type="number" class="budget-inline-input" data-field="area_ha" data-id="${b.id}"
                    value="${b.area_ha || ''}" step="0.1"
                    style="width:70px;text-align:right;border:1px solid transparent;border-radius:4px;padding:2px 4px;font-size:var(--text-sm);font-family:var(--font-data)">
                </td>
                <td class="num">
                  <input type="number" class="budget-inline-input" data-field="yield_per_ha" data-id="${b.id}"
                    value="${b.yield_per_ha || ''}" step="0.001"
                    style="width:70px;text-align:right;border:1px solid transparent;border-radius:4px;padding:2px 4px;font-size:var(--text-sm);font-family:var(--font-data)">
                </td>
                <td class="num" style="color:var(--blue);font-weight:600">
                  <span class="bud-prod-display" data-id="${b.id}">${budProd ? formatNumber(budProd, 0) : '—'}</span>
                </td>
                <td class="num">
                  <input type="number" class="budget-inline-input" data-field="price" data-id="${b.id}"
                    value="${b.price || ''}" step="0.01"
                    style="width:70px;text-align:right;border:1px solid transparent;border-radius:4px;padding:2px 4px;font-size:var(--text-sm);font-family:var(--font-data)">
                </td>
                <td class="num" style="border-left:2px solid #0f766e22">
                  <input type="number" class="forecast-inline-input" data-field="area_ha" data-budget-id="${b.id}"
                    value="${latestF?.area_ha || ''}" step="0.1"
                    style="width:70px;text-align:right;border:1px solid transparent;border-radius:4px;padding:2px 4px;font-size:var(--text-sm);font-family:var(--font-data)">
                </td>
                <td class="num">
                  <input type="number" class="forecast-inline-input" data-field="yield_per_ha" data-budget-id="${b.id}"
                    value="${latestF?.yield_per_ha || ''}" step="0.001"
                    style="width:70px;text-align:right;border:1px solid transparent;border-radius:4px;padding:2px 4px;font-size:var(--text-sm);font-family:var(--font-data)">
                </td>
                <td class="num" style="color:#0f766e;font-weight:600">
                  <span class="fcast-prod-display" data-id="${b.id}">${fcastProd ? formatNumber(fcastProd, 0) : '—'}</span>
                </td>
                ${canWrite() ? `
                  <td>
                    <button class="btn btn-ghost btn-sm delete-budget-btn" data-id="${b.id}" style="color:var(--red)">✕</button>
                  </td>
                ` : ''}
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  // Inline input styling on focus
  wrap.querySelectorAll('.budget-inline-input, .forecast-inline-input').forEach(input => {
    input.addEventListener('focus', () => {
      input.style.border = '1px solid var(--blue)';
      input.style.background = 'white';
      input.style.boxShadow = '0 0 0 2px rgba(30,111,168,0.12)';
    });
    input.addEventListener('blur', () => {
      input.style.border = '1px solid transparent';
      input.style.background = 'transparent';
      input.style.boxShadow = 'none';
    });
  });

  // Budget inline save on blur
  wrap.querySelectorAll('.budget-inline-input').forEach(input => {
    input.addEventListener('change', async () => {
      const id = input.dataset.id;
      const field = input.dataset.field;
      const value = parseFloat(input.value) || null;
      const budget = _budgets.find(b => b.id === id);
      if (!budget) return;

      // Update local
      budget[field] = value;

      // Recalculate and show budget production
      const area = parseFloat(budget.area_ha) || 0;
      const yld = parseFloat(budget.yield_per_ha) || 0;
      const prod = area * yld;
      const prodDisplay = wrap.querySelector('.bud-prod-display[data-id="' + id + '"]');
      if (prodDisplay) prodDisplay.textContent = prod ? formatNumber(prod, 0) : '—';

      try {
        await dbUpdate('budgets', id, { [field]: value });
        input.style.background = '#f0fdf4';
        setTimeout(() => { input.style.background = 'transparent'; }, 800);
      } catch (err) {
        toast('Failed to save: ' + err.message, 'error');
      }
    });
  });

  // Forecast inline save on blur
  wrap.querySelectorAll('.forecast-inline-input').forEach(input => {
    input.addEventListener('change', async () => {
      const budgetId = input.dataset.budgetId;
      const field = input.dataset.field;
      const value = parseFloat(input.value) || null;
      const budget = _budgets.find(b => b.id === budgetId);
      if (!budget) return;

      // Find or create forecast for today
      let forecast = _forecasts.filter(f => f.budget_id === budgetId).slice(-1)[0];
      const farm = getActiveFarm();

      // Get all forecast inputs for this row to save together
      const rowInputs = wrap.querySelectorAll('.forecast-inline-input[data-budget-id="' + budgetId + '"]');
      const area = parseFloat(rowInputs[0]?.value || forecast?.area_ha || 0) || null;
      const yld = parseFloat(rowInputs[1]?.value || forecast?.yield_per_ha || 0) || null;
      const fcastProd = area && yld ? area * yld : null;

      // Update fcast prod display
      const prodDisplay = wrap.querySelector('.fcast-prod-display[data-id="' + budgetId + '"]');
      if (prodDisplay) prodDisplay.textContent = fcastProd ? formatNumber(fcastProd, 0) : '—';

      try {
        if (forecast) {
          await dbUpdate('forecasts', forecast.id, { [field]: value });
          forecast[field] = value;
          forecast.forecast_production = fcastProd;
        } else {
          // Create new forecast entry
          const newF = await dbInsert('forecasts', {
            budget_id: budgetId,
            farm_id: farm.id,
            season: _season,
            commodity_id: budget.commodity_id,
            crop_type_id: budget.crop_type_id || null,
            label: 'Inline update',
            forecast_date: new Date().toISOString().slice(0, 10),
            area_ha: area,
            yield_per_ha: yld,

            created_by: getSession()?.user?.id,
          });
          _forecasts.push(newF);
        }
        input.style.background = '#f0fdf4';
        setTimeout(() => { input.style.background = 'transparent'; }, 800);
      } catch (err) {
        toast('Failed to save forecast: ' + err.message, 'error');
      }
    });
  });

  // Delete budget row
  wrap.querySelectorAll('.delete-budget-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openModal({
        title: 'Remove budget row',
        confirmLabel: 'Remove',
        confirmClass: 'btn-danger',
        bodyHTML: '<p>Remove this crop type from the budget? Forecasts linked to it will also be removed.</p>',
        onConfirm: async () => {
          await dbDelete('budgets', btn.dataset.id);
          _budgets = _budgets.filter(b => b.id !== btn.dataset.id);
          _forecasts = _forecasts.filter(f => f.budget_id !== btn.dataset.id);
          toast('Row removed');
          _renderTable(container);
        },
      });
    });
  });
}

// ── Add row modal ─────────────────────────────────────────────
function _addRowModal(container) {
  const farm = getActiveFarm();
  let selectedCommodityId = '';

  openModal({
    title: 'Add crop type to budget',
    confirmLabel: 'Add row',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Commodity</label>
          ${commoditySelectHTML('br-commodity')}
        </div>
        <div class="form-group">
          <label class="form-label">Crop type</label>
          ${cropTypeSelectHTML('br-crop-type')}
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="br-unit">
            <option value="t">t (tonne)</option>
            <option value="bale">bale</option>
            <option value="kg">kg</option>
            <option value="head">head</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Budget area (ha)</label>
          <input class="form-input num" id="br-area" type="number" step="0.1">
        </div>
        <div class="form-group">
          <label class="form-label">Budget yield / ha</label>
          <input class="form-input num" id="br-yield" type="number" step="0.001">
        </div>
        <div class="form-group">
          <label class="form-label">Budget price</label>
          <input class="form-input num" id="br-price" type="number" step="0.01">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Budgeted production</label>
        <div id="br-prod" class="font-mono" style="font-size:var(--text-xl);color:var(--blue);padding:4px 0">—</div>
      </div>
    `,
    onConfirm: async (modal) => {
      const commodityId = qs('#br-commodity', modal)?.value;
      const cropTypeId = qs('#br-crop-type', modal)?.value || null;
      const unit = qs('#br-unit', modal)?.value || 't';
      const area = parseFloat(qs('#br-area', modal)?.value || 0) || null;
      const yld = parseFloat(qs('#br-yield', modal)?.value || 0) || null;
      const price = parseFloat(qs('#br-price', modal)?.value || 0) || null;
      const commodities = getCommodities();
      const commodity = commodities.find(c => c.id === commodityId);

      const row = await dbInsert('budgets', {
        farm_id: farm.id,
        season: _season,
        commodity_id: commodityId || null,
        commodity: commodity?.name || null,
        crop_type_id: cropTypeId,
        unit,
        area_ha: area,
        yield_per_ha: yld,
        price,
        created_by: getSession()?.user?.id,
      });

      _budgets.push(row);
      toast('Crop type added', 'success');
      _renderTable(container);
    },
  });

  // Init selects
  setTimeout(() => {
    initCommoditySelect('br-commodity', (id) => {
      selectedCommodityId = id;
      refreshCropTypeSelect('br-crop-type', id);
      initCropTypeSelect('br-crop-type', () => selectedCommodityId);
    });
    initCropTypeSelect('br-crop-type', () => selectedCommodityId);

    // Live production calc
    const updateProd = () => {
      const a = parseFloat(qs('#br-area')?.value || 0);
      const y = parseFloat(qs('#br-yield')?.value || 0);
      const el = qs('#br-prod');
      if (el) el.textContent = a && y ? formatNumber(a * y, 0) : '—';
    };
    qs('#br-area')?.addEventListener('input', updateProd);
    qs('#br-yield')?.addEventListener('input', updateProd);
  }, 100);
}

// ── Harvest table ─────────────────────────────────────────────
function _renderHarvest(container) {
  const wrap = qs('#harvest-table-wrap', container);
  if (!wrap) return;

  const commodities = getCommodities();
  const cropTypes = getCropTypes();

  if (!_harvests.length) {
    wrap.innerHTML = `<div class="empty-state"><p>No harvest entries for ${_season} yet.</p></div>`;
    return;
  }

  const total = _harvests.reduce((s, h) => s + (parseFloat(h.actual_production) || 0), 0);

  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Paddock / block</th>
          <th>Commodity</th>
          <th>Crop type</th>
          <th>Harvest date</th>
          <th class="num">Area (ha)</th>
          <th class="num">Production</th>
          <th class="num">Yield/ha</th>
          <th>Notes</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${_harvests.map(h => {
          const commodity = commodities.find(c => c.id === h.commodity_id);
          const cropType = cropTypes.find(ct => ct.id === h.crop_type_id);
          return `
            <tr>
              <td>${h.paddock_name || '—'}</td>
              <td>${commodity?.name || '—'}</td>
              <td class="muted">${cropType?.name || '—'}</td>
              <td class="muted">${h.harvest_date ? new Date(h.harvest_date).toLocaleDateString('en-AU', {day:'2-digit',month:'short',year:'numeric'}) : '—'}</td>
              <td class="num">${h.area_ha ? formatNumber(h.area_ha, 1) : '—'}</td>
              <td class="num"><strong>${formatNumber(h.actual_production, 0)} ${h.unit || ''}</strong></td>
              <td class="num">${h.area_ha && h.actual_production ? formatNumber(parseFloat(h.actual_production) / parseFloat(h.area_ha), 2) : '—'}</td>
              <td class="muted text-sm">${h.notes || ''}</td>
              ${canWrite() ? `<td>
                <div class="flex gap-1">
                  <button class="btn btn-ghost btn-sm edit-harvest-btn" data-id="${h.id}">Edit</button>
                  <button class="btn btn-ghost btn-sm delete-harvest-btn" data-id="${h.id}" style="color:var(--red)">✕</button>
                </div>
              </td>` : ''}
            </tr>
          `;
        }).join('')}
        <tr style="font-weight:600;border-top:2px solid var(--border)">
          <td colspan="4">Total</td>
          <td class="num">${formatNumber(_harvests.reduce((s,h) => s + (parseFloat(h.area_ha)||0), 0), 1)} ha</td>
          <td class="num">${formatNumber(total, 0)}</td>
          <td class="num">${(() => { const ta = _harvests.reduce((s,h)=>s+(parseFloat(h.area_ha)||0),0); return ta ? formatNumber(total/ta,2) : '—'; })()}</td>
          <td colspan="${canWrite() ? 2 : 1}"></td>
        </tr>
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('.edit-harvest-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const harvest = _harvests.find(h => h.id === btn.dataset.id);
      if (harvest) _harvestModal(container, harvest);
    });
  });

  wrap.querySelectorAll('.delete-harvest-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openModal({
        title: 'Remove harvest entry',
        confirmLabel: 'Remove',
        confirmClass: 'btn-danger',
        bodyHTML: '<p>Remove this harvest entry?</p>',
        onConfirm: async () => {
          await dbDelete('harvest_entries', btn.dataset.id);
          _harvests = _harvests.filter(h => h.id !== btn.dataset.id);
          toast('Harvest entry removed');
          _renderHarvest(container);
        },
      });
    });
  });
}

// ── Harvest modal ─────────────────────────────────────────────
function _harvestModal(container, existing = null) {
  const isEdit = !!existing;
  let selectedCommodityId = existing?.commodity_id || null;

  const harvestBodyHTML = [
    '<div class="form-row">',
      '<div class="form-group">',
        '<label class="form-label">Commodity</label>',
        commoditySelectHTML('hv-commodity'),
      '</div>',
      '<div class="form-group">',
        '<label class="form-label">Crop type</label>',
        cropTypeSelectHTML('hv-crop-type'),
      '</div>',
    '</div>',
    '<div class="form-row">',
      '<div class="form-group">',
        '<label class="form-label">Paddock / block name</label>',
        '<input class="form-input" id="hv-paddock" type="text" placeholder="e.g. North paddock" value="' + (existing?.paddock_name || '') + '">',
      '</div>',
      '<div class="form-group">',
        '<label class="form-label">Harvest date</label>',
        '<input class="form-input" id="hv-date" type="date" value="' + (existing?.harvest_date || '') + '">',
      '</div>',
    '</div>',
    '<div class="form-row">',
      '<div class="form-group">',
        '<label class="form-label">Area harvested (ha)</label>',
        '<input class="form-input num" id="hv-area" type="number" step="0.1" placeholder="e.g. 450" value="' + (existing?.area_ha || '') + '">',
      '</div>',
      '<div class="form-group">',
        '<label class="form-label">Production</label>',
        '<input class="form-input num" id="hv-production" type="number" step="0.1" value="' + (existing?.actual_production || '') + '">',
      '</div>',
      '<div class="form-group">',
        '<label class="form-label">Unit</label>',
        '<select class="form-select" id="hv-unit">',
          '<option value="bale"' + (existing?.unit === 'bale' ? ' selected' : '') + '>bale</option>',
          '<option value="t"' + (existing?.unit === 't' ? ' selected' : '') + '>tonne</option>',
          '<option value="kg"' + (existing?.unit === 'kg' ? ' selected' : '') + '>kg</option>',
          '<option value="head"' + (existing?.unit === 'head' ? ' selected' : '') + '>head</option>',
        '</select>',
      '</div>',
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Notes</label>',
      '<textarea class="form-textarea" id="hv-notes" rows="2">' + (existing?.notes || '') + '</textarea>',
    '</div>',
  ].join('');

  openModal({
    title: isEdit ? 'Edit harvest entry' : 'Add harvest entry',
    confirmLabel: isEdit ? 'Save changes' : 'Save harvest',
    bodyHTML: harvestBodyHTML,
    onConfirm: async (modal) => {
      const production = parseFloat(qs('#hv-production', modal)?.value || 0);
      if (!production) throw new Error('Please enter a production quantity');

      const row = {
        farm_id: farm.id,
        season: _season,
        commodity_id: selectedCommodityId || null,
        crop_type_id: qs('#hv-crop-type', modal)?.value || null,
        paddock_name: qs('#hv-paddock', modal)?.value?.trim() || null,
        area_ha: parseFloat(qs('#hv-area', modal)?.value || 0) || null,
        harvest_date: qs('#hv-date', modal)?.value || null,
        actual_production: production,
        unit: qs('#hv-unit', modal)?.value || 'bale',
        notes: qs('#hv-notes', modal)?.value?.trim() || null,
      };

      if (isEdit) {
        await dbUpdate('harvest_entries', existing.id, row);
        const idx = _harvests.findIndex(h => h.id === existing.id);
        if (idx >= 0) _harvests[idx] = { ..._harvests[idx], ...row };
        toast('Harvest entry updated', 'success');
      } else {
        row.created_by = getSession()?.user?.id;
        const saved = await dbInsert('harvest_entries', row);
        _harvests.push(saved);
        toast('Harvest entry added', 'success');
      }
      _renderHarvest(container);
    },
  });

  setTimeout(() => {
    initCommoditySelect('hv-commodity', (id) => {
      selectedCommodityId = id;
      refreshCropTypeSelect('hv-crop-type', id);
      initCropTypeSelect('hv-crop-type', () => selectedCommodityId);
    });
    initCropTypeSelect('hv-crop-type', () => selectedCommodityId);

    // Pre-fill commodity and crop type for edit
    if (isEdit && existing.commodity_id) {
      const commSel = document.querySelector('#hv-commodity select');
      if (commSel) {
        commSel.value = existing.commodity_id;
        commSel.dispatchEvent(new Event('change'));
        setTimeout(() => {
          const ctSel = document.querySelector('#hv-crop-type select');
          if (ctSel && existing.crop_type_id) ctSel.value = existing.crop_type_id;
        }, 200);
      }
    }
  }, 100);
}