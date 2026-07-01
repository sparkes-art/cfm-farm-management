// modules/budget/budget.js
// Budget & Forecast — inline editable table per crop type per season

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite, getFarms } from '../../js/app-state.js';
import { loadCommodities, getCommodities, getCropTypes, commoditySelectHTML, initCommoditySelect, cropTypeSelectHTML, initCropTypeSelect, refreshCropTypeSelect } from '../../js/commodities.js';
import { toast, openModal, formatNumber, formatCurrency, qs, currentSeason } from '../../js/ui.js';

let _budgets = [];
let _forecasts = [];
let _harvests = [];
let _season = currentSeason();

let _activeTab = 'budget';

export async function mountBudget(container) {
  await loadCommodities();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Data Entry</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid)">${getActiveFarm()?.name || ''}</p>
      </div>
      <div class="flex gap-2 items-center">
        <label style="font-size:var(--text-sm);color:var(--muted)">Crop year</label>
        <select id="bud-season" class="form-select" style="width:110px">
          ${_seasonOptions()}
        </select>
      </div>
    </div>

    <div class="tab-strip" style="margin-bottom:16px">
      <button class="tab-btn ${_activeTab === 'budget' ? 'active' : ''}" data-tab="budget">Budget & Forecast</button>
      <button class="tab-btn ${_activeTab === 'harvest' ? 'active' : ''}" data-tab="harvest">Harvest Records</button>
    </div>

    <div id="bud-tab-content"></div>
  `;

  // Tab switching
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _renderTabContent(container);
    });
  });

  qs('#bud-season', container)?.addEventListener('change', async (e) => {
    _season = e.target.value;
    await _loadData();
    _renderTabContent(container);
  });

  await _loadData();
  _renderTabContent(container);
}

function _renderTabContent(container) {
  const content = qs('#bud-tab-content', container);
  if (!content) return;

  if (_activeTab === 'budget') {
    content.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        ${canWrite() ? '<button class="btn btn-secondary" id="btn-add-row">＋ Add crop type</button>' : ''}
      </div>
      <div class="card">
        <div id="budget-table-wrap">
          <div class="empty-state"><span class="loading-spinner"></span></div>
        </div>
      </div>
    `;
    if (canWrite()) qs('#btn-add-row', content)?.addEventListener('click', () => _addRowModal(container));
    _renderTable(container);
  } else {
    content.innerHTML = `
      <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
        ${canWrite() ? '<button class="btn btn-secondary" id="btn-add-harvest">＋ Add harvest</button>' : ''}
      </div>
      <div class="card">
        <div id="harvest-table-wrap">
          <div class="empty-state"><span class="loading-spinner"></span></div>
        </div>
      </div>
    `;
    if (canWrite()) qs('#btn-add-harvest', content)?.addEventListener('click', () => _harvestModal(container));
    _renderHarvest(container);
  }
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

  // Build summary by commodity + crop type
  const commSummary = {};
  _harvests.forEach(h => {
    const comm = commodities.find(c => c.id === h.commodity_id);
    const ct = cropTypes.find(ct => ct.id === h.crop_type_id);
    const key = (comm?.name || 'Unknown') + '||' + (ct?.name || '');
    if (!commSummary[key]) commSummary[key] = { commodity: comm?.name || 'Unknown', cropType: ct?.name || '', commodityId: h.commodity_id || '', cropTypeId: h.crop_type_id || '', commCropKey: (h.commodity_id||'') + '||' + (h.crop_type_id||''), unit: h.unit || 't', area: 0, production: 0, weight: 0, varieties: {} };
    const s = commSummary[key];
    s.area += parseFloat(h.area_ha) || 0;
    s.production += parseFloat(h.actual_production) || 0;
    s.weight += parseFloat(h.ginned_weight) || 0;
    const v = h.variety || 'Unspecified';
    if (!s.varieties[v]) s.varieties[v] = { area: 0, production: 0, weight: 0 };
    s.varieties[v].area += parseFloat(h.area_ha) || 0;
    s.varieties[v].production += parseFloat(h.actual_production) || 0;
    s.varieties[v].weight += parseFloat(h.ginned_weight) || 0;
  });

  const summaryRows = Object.values(commSummary);

  // Get forecast data for % complete calculation
  const forecastByCommCropType = {};
  _forecasts.forEach(f => {
    const b = _budgets.find(b => b.id === f.budget_id);
    if (!b) return;
    const key = (b.commodity_id || b.commodity) + '||' + (b.crop_type_id || '');
    if (!forecastByCommCropType[key]) forecastByCommCropType[key] = 0;
    forecastByCommCropType[key] += parseFloat(f.area_ha) || parseFloat(b.area_ha) || 0;
  });
  // Also use budget area as fallback
  _budgets.forEach(b => {
    const key = (b.commodity_id || b.commodity) + '||' + (b.crop_type_id || '');
    if (!forecastByCommCropType[key]) forecastByCommCropType[key] = parseFloat(b.area_ha) || 0;
  });

  wrap.innerHTML = `
    <div style="padding:16px;border-bottom:1px solid var(--border-light)">
      <p style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--hint);font-weight:600;margin-bottom:12px">Harvest summary — ${_season}</p>
      ${summaryRows.map(s => {
        const yieldHa = s.area ? s.production / s.area : null;
        const turnout = s.weight ? (s.production * 227 / s.weight) * 100 : null;
        const varieties = Object.entries(s.varieties);
        const showVarieties = varieties.length > 1 || (varieties.length === 1 && varieties[0][0] !== 'Unspecified');
        // Get forecast area for % complete
        const commId = Object.keys(forecastByCommCropType).find(k => k.startsWith(s.commodityId + '||'));
        const fcastArea = forecastByCommCropType[s.commCropKey] || 0;
        const pctComplete = fcastArea && s.area ? Math.round((s.area / fcastArea) * 100) : null;

        return `
          <div style="margin-bottom:16px;padding-bottom:16px;border-bottom:0.5px solid var(--border-light)">
            <p style="font-size:13px;font-weight:700;color:var(--ink);margin:0 0 10px">${s.commodity}${s.cropType ? ' · ' + s.cropType : ''}</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start">
              <!-- Left: stat cards -->
              <div style="display:flex;gap:0;border:1px solid var(--border-light);border-radius:8px;overflow:hidden">
                ${[
                  ['Area harvested', s.area ? formatNumber(s.area,1)+' ha' : '—', 'var(--ink)'],
                  ['% Complete', pctComplete != null ? pctComplete+'%' : '—', pctComplete >= 100 ? 'var(--green)' : pctComplete >= 75 ? 'var(--blue)' : 'var(--amber)'],
                  ['Production', s.production ? formatNumber(s.production,0)+' '+s.unit : '—', 'var(--ink)'],
                  ['Yield / ha', yieldHa ? formatNumber(yieldHa,2) : '—', 'var(--ink)'],
                  ['Turnout', turnout ? formatNumber(turnout,1)+'%' : '—', 'var(--ink)'],
                ].map(([l,v,c],i) =>
                  '<div style="padding:8px 12px;' + (i>0?'border-left:1px solid var(--border-light)':'') + '">' +
                  '<p style="font-size:10px;color:var(--hint);margin:0 0 3px;white-space:nowrap">' + l + '</p>' +
                  '<p style="font-size:15px;font-weight:700;color:' + c + ';margin:0">' + v + '</p>' +
                  '</div>'
                ).join('')}
              </div>

              <!-- Right: by variety -->
              ${showVarieties ? (
                '<div>' +
                '<p style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin:0 0 6px">By variety</p>' +
                '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
                '<thead><tr style="border-bottom:1px solid var(--border-light)">' +
                '<th style="text-align:left;padding:4px 8px;color:var(--hint);font-weight:500;font-size:10px">Variety</th>' +
                '<th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500;font-size:10px">Area</th>' +
                '<th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500;font-size:10px">Production</th>' +
                '<th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500;font-size:10px">Yield</th>' +
                '<th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500;font-size:10px">Turnout</th>' +
                '</tr></thead><tbody>' +
                varieties.map(([v,d]) => {
                  const vy = d.area ? d.production/d.area : null;
                  const vt = d.weight ? (d.production*227/d.weight)*100 : null;
                  return '<tr style="border-bottom:0.5px solid var(--border-light)">' +
                    '<td style="padding:5px 8px;font-weight:600;color:var(--ink)">' + v + '</td>' +
                    '<td style="padding:5px 8px;text-align:right;color:var(--muted)">' + (d.area?formatNumber(d.area,1)+' ha':'—') + '</td>' +
                    '<td style="padding:5px 8px;text-align:right;color:var(--muted)">' + (d.production?formatNumber(d.production,0):'—') + '</td>' +
                    '<td style="padding:5px 8px;text-align:right;color:var(--muted)">' + (vy?formatNumber(vy,2):'—') + '</td>' +
                    '<td style="padding:5px 8px;text-align:right;color:var(--muted)">' + (vt?formatNumber(vt,1)+'%':'—') + '</td>' +
                    '</tr>';
                }).join('') +
                '</tbody></table></div>'
              ) : '<div></div>'}
            </div>
          </div>`;
      }).join('')}
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Paddock / block</th>
          <th>Commodity</th>
          <th>Crop type</th>
          <th>Variety</th>
          <th>Harvest date</th>
          <th class="num">Area (ha)</th>
          <th class="num">Production</th>
          <th class="num">Yield/ha</th>
          <th class="num">Total weight (kg)</th>
          <th class="num">Turnout %</th>
          <th>Notes</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${_harvests.map(h => {
          const commodity = commodities.find(c => c.id === h.commodity_id);
          const cropType = cropTypes.find(ct => ct.id === h.crop_type_id);
          return `
            <tr data-id="${h.id}">
              ${canWrite() ? `
              <td><input class="harvest-inline" data-id="${h.id}" data-field="paddock_name" type="text" value="${h.paddock_name || ''}" placeholder="—" style="width:100%;border:none;background:transparent;font-size:var(--text-sm);padding:0"></td>
              <td>
                <select class="harvest-inline" data-id="${h.id}" data-field="commodity_id" style="border:none;background:transparent;font-size:var(--text-sm);width:100%;padding:0">
                  <option value="">—</option>
                  ${getCommodities().map(c => `<option value="${c.id}" ${c.id === h.commodity_id ? 'selected' : ''}>${c.name}</option>`).join('')}
                </select>
              </td>
              <td>
                <select class="harvest-inline" data-id="${h.id}" data-field="crop_type_id" style="border:none;background:transparent;font-size:var(--text-sm);width:100%;padding:0">
                  <option value="">—</option>
                  ${getCropTypes().map(ct => `<option value="${ct.id}" ${ct.id === h.crop_type_id ? 'selected' : ''}>${ct.name}</option>`).join('')}
                </select>
              </td>
              <td><input class="harvest-inline" data-id="${h.id}" data-field="variety" type="text" value="${h.variety || ''}" placeholder="—" style="width:100%;border:none;background:transparent;font-size:var(--text-sm);padding:0"></td>
              <td><input class="harvest-inline" data-id="${h.id}" data-field="harvest_date" type="date" value="${h.harvest_date || ''}" style="width:100%;border:none;background:transparent;font-size:var(--text-sm);padding:0"></td>
              <td><input class="harvest-inline num" data-id="${h.id}" data-field="area_ha" type="number" step="0.1" value="${h.area_ha || ''}" placeholder="—" style="width:100%;border:none;background:transparent;font-size:var(--text-sm);text-align:right;padding:0"></td>
              <td><input class="harvest-inline num" data-id="${h.id}" data-field="actual_production" type="number" step="0.1" value="${h.actual_production || ''}" placeholder="—" style="width:80px;border:none;background:transparent;font-size:var(--text-sm);font-weight:600;text-align:right;padding:0">
                <select class="harvest-inline" data-id="${h.id}" data-field="unit" style="border:none;background:transparent;font-size:10px;padding:0;width:40px">
                  ${['bale','t','kg','head'].map(u => `<option ${h.unit===u?'selected':''}>${u}</option>`).join('')}
                </select>
              </td>
              <td class="num yield-display-${h.id}">${h.area_ha && h.actual_production ? formatNumber(parseFloat(h.actual_production)/parseFloat(h.area_ha),2) : '—'}</td>
              <td><input class="harvest-inline num" data-id="${h.id}" data-field="ginned_weight" type="number" step="0.1" value="${h.ginned_weight || ''}" placeholder="—" style="width:100%;border:none;background:transparent;font-size:var(--text-sm);text-align:right;padding:0"></td>
              <td class="num turnout-display-${h.id}">${(() => {
                if (!h.ginned_weight || !h.actual_production) return '—';
                const turnout = (parseFloat(h.actual_production) * 227) / parseFloat(h.ginned_weight) * 100;
                return formatNumber(turnout, 1) + '%';
              })()}</td>
              <td><input class="harvest-inline" data-id="${h.id}" data-field="notes" type="text" value="${h.notes || ''}" placeholder="—" style="width:100%;border:none;background:transparent;font-size:var(--text-sm);padding:0"></td>
              <td><button class="btn btn-ghost btn-sm delete-harvest-btn" data-id="${h.id}" style="color:var(--red)">✕</button></td>
              ` : `
              <td>${h.paddock_name || '—'}</td>
              <td>${commodity?.name || '—'}</td>
              <td class="muted">${cropType?.name || '—'}</td>
              <td class="muted text-sm">${h.variety || '—'}</td>
              <td class="muted">${h.harvest_date ? new Date(h.harvest_date).toLocaleDateString('en-AU', {day:'2-digit',month:'short',year:'numeric'}) : '—'}</td>
              <td class="num">${h.area_ha ? formatNumber(h.area_ha,1) : '—'}</td>
              <td class="num"><strong>${formatNumber(h.actual_production,0)} ${h.unit||''}</strong></td>
              <td class="num">${h.area_ha && h.actual_production ? formatNumber(parseFloat(h.actual_production)/parseFloat(h.area_ha),2) : '—'}</td>
              <td class="num">${h.ginned_weight ? formatNumber(h.ginned_weight,0) : '—'}</td>
              <td class="num">${(() => { if(!h.ginned_weight||!h.actual_production)return '—'; return formatNumber((parseFloat(h.actual_production)*227/parseFloat(h.ginned_weight))*100,1)+'%'; })()}</td>
              <td class="muted text-sm">${h.notes||''}</td>
              `}
            </tr>
          `;
        }).join('')}
        <tr style="font-weight:600;border-top:2px solid var(--border)">
          <td colspan="5">Total</td>
          <td class="num">${formatNumber(_harvests.reduce((s,h) => s + (parseFloat(h.area_ha)||0), 0), 1)} ha</td>
          <td class="num">${formatNumber(total, 0)}</td>
          <td class="num">${(() => { const ta = _harvests.reduce((s,h)=>s+(parseFloat(h.area_ha)||0),0); return ta ? formatNumber(total/ta,2) : '—'; })()}</td>
          <td class="num">${formatNumber(_harvests.reduce((s,h)=>s+(parseFloat(h.ginned_weight)||0),0),1)}</td>
          <td class="num">${(() => {
            const totalWeight = _harvests.reduce((s,h)=>s+(parseFloat(h.ginned_weight)||0),0);
            const totalBaleWt = _harvests.reduce((s,h)=>s+((parseFloat(h.actual_production)||0)*227),0);
            return totalWeight ? formatNumber((totalBaleWt/totalWeight)*100,1)+'%' : '—';
          })()}</td>
          <td colspan="${canWrite() ? 2 : 1}"></td>
        </tr>
      </tbody>
    </table>
  `;

  // Inline edit save on blur/change
  wrap.querySelectorAll('.harvest-inline').forEach(inp => {
    const save = async () => {
      const id = inp.dataset.id;
      const field = inp.dataset.field;
      let val = inp.value;
      if (inp.type === 'number') val = parseFloat(val) || null;
      else if (!val.trim()) val = null;

      try {
        await dbUpdate('harvest_entries', id, { [field]: val });
        const idx = _harvests.findIndex(h => h.id === id);
        if (idx >= 0) _harvests[idx][field] = val;
        _renderHarvest(container);
      } catch (err) { toast('Save failed: ' + err.message, 'error'); }
    };
    if (inp.tagName === 'SELECT') inp.addEventListener('change', save);
    else {
      inp.addEventListener('focus', () => { inp.style.background='var(--blue-light)'; inp.style.border='1px solid var(--blue)'; inp.style.borderRadius='3px'; inp.style.padding='1px 4px'; });
      inp.addEventListener('blur', () => { inp.style.background='transparent'; inp.style.border='none'; inp.style.padding='0'; save(); });
      inp.addEventListener('keydown', e => { if(e.key==='Enter') inp.blur(); if(e.key==='Escape') { inp.blur(); } });
    }
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
  const farm = getActiveFarm();

  const comms = getCommodities();
  const commOpts = '<option value="">— select —</option>' + comms.map(c =>
    `<option value="${c.id}" ${c.id === existing?.commodity_id ? 'selected' : ''}>${c.name}</option>`
  ).join('');
  const cts = getCropTypes();
  const ctOpts = '<option value="">— select —</option>' + cts.map(ct =>
    `<option value="${ct.id}" ${ct.id === existing?.crop_type_id ? 'selected' : ''}>${ct.name}</option>`
  ).join('');

  const harvestBodyHTML = [
    '<div class="form-row">',
      '<div class="form-group">',
        '<label class="form-label">Commodity</label>',
        '<select class="form-select" id="hv-commodity">' + commOpts + '</select>',
      '</div>',
      '<div class="form-group">',
        '<label class="form-label">Crop type</label>',
        '<select class="form-select" id="hv-crop-type">' + ctOpts + '</select>',
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
        commodity_id: qs('#hv-commodity', modal)?.value || null,
        crop_type_id: qs('#hv-crop-type', modal)?.value || null,
        paddock_name: qs('#hv-paddock', modal)?.value?.trim() || null,
        area_ha: parseFloat(qs('#hv-area', modal)?.value || 0) || null,
        harvest_date: qs('#hv-date', modal)?.value || null,
        actual_production: production,
        variety: qs('#hv-variety', modal)?.value?.trim() || null,
        ginned_weight: parseFloat(qs('#hv-ginned', modal)?.value || 0) || null,
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

}