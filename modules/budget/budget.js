// modules/outputs/budget.js
// Budget, reforecast, harvest and market price management

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite } from '../../js/app-state.js';
import { loadCommodities, getCommodities, getCropTypes, commodityOptions, cropTypeOptions, commoditySelectHTML, initCommoditySelect, cropTypeSelectHTML, initCropTypeSelect, refreshCropTypeSelect } from '../../js/commodities.js';
import { toast, openModal, formatCurrency, formatNumber, formatDate, qs, setContent, currentSeason } from '../../js/ui.js';

let _budgets = [];
let _forecasts = [];
let _harvests = [];
let _season = currentSeason();

export function unmountBudget() {
  _budgets = [];
  _forecasts = [];
  _harvests = [];
}

export async function mountBudget(container) {
  await loadCommodities();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Budget & Position</h1>
        <p class="page-subtitle">Season budgets, reforecasts and harvest entries</p>
      </div>
      <div class="flex gap-2">
        <select id="bud-season" class="form-select" style="width:120px">
          ${_seasonOptions()}
        </select>
        ${canWrite() ? '<button class="btn btn-primary" id="btn-add-budget">＋ Add budget</button>' : ''}
      </div>
    </div>

    <div id="budget-list">
      <div class="empty-state"><span class="loading-spinner"></span></div>
    </div>
  `;

  qs('#bud-season', container)?.addEventListener('change', async (e) => {
    _season = e.target.value;
    await _loadData();
    _render(container);
  });

  if (canWrite()) {
    qs('#btn-add-budget', container)?.addEventListener('click', () => _budgetModal(container));
  }

  await _loadData();
  _render(container);
}

async function _loadData() {
  const farm = getActiveFarm();
  if (!farm) return;

  [_budgets, _forecasts, _harvests] = await Promise.all([
    dbSelect('budgets', `farm_id=eq.${farm.id}&season=eq.${_season}&select=*`),
    dbSelect('forecasts', `farm_id=eq.${farm.id}&season=eq.${_season}&select=*&order=forecast_date.asc`),
    dbSelect('harvest_entries', `farm_id=eq.${farm.id}&season=eq.${_season}&select=*`),
  ]);
}

function _render(container) {
  const list = qs('#budget-list', container);
  if (!list) return;

  if (!_budgets.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📊</div>
        <p>No budgets for ${_season}. Click "Add budget" to set up your first crop type budget.</p>
      </div>`;
    return;
  }

  // Group budgets by commodity
  const commodities = getCommodities();
  const byCommodity = {};
  _budgets.forEach(b => {
    if (!byCommodity[b.commodity_id]) byCommodity[b.commodity_id] = [];
    byCommodity[b.commodity_id].push(b);
  });

  list.innerHTML = Object.entries(byCommodity).map(([commodityId, budgets]) => {
    const commodity = commodities.find(c => c.id === commodityId);
    if (!commodity) return '';

    return budgets.map(b => {
      const cropTypes = getCropTypes(b.commodity_id);
      const cropType = cropTypes.find(ct => ct.id === b.crop_type_id);
      const forecasts = _forecasts.filter(f => f.budget_id === b.id);
      const harvests = _harvests.filter(h => h.commodity_id === b.commodity_id && h.crop_type_id === b.crop_type_id);
      const latestForecast = forecasts[forecasts.length - 1];
      const totalHarvest = harvests.reduce((s, h) => s + (parseFloat(h.actual_production) || 0), 0);
      const budgetedProd = parseFloat(b.budgeted_production) || 0;
      const forecastProd = parseFloat(latestForecast?.forecast_production) || budgetedProd;
      const vsbudgetPct = budgetedProd ? Math.round((forecastProd / budgetedProd) * 100) : null;

      return `
        <div class="card" style="margin-bottom:16px">
          <div class="card-header">
            <div class="flex items-center gap-2">
              <h2>${commodity.name}${cropType ? ` — ${cropType.name}` : ''}</h2>
              ${totalHarvest > 0
                ? '<span class="badge badge-paid">Harvested</span>'
                : '<span class="badge badge-issued">Growing</span>'
              }
            </div>
            ${canWrite() ? `
              <div class="flex gap-2">
                <button class="btn btn-secondary btn-sm" onclick="window.__cfmAddForecast('${b.id}')">＋ Reforecast</button>
                <button class="btn btn-secondary btn-sm" onclick="window.__cfmAddHarvest('${b.id}', '${b.commodity_id}', '${b.crop_type_id || ''}')">＋ Harvest</button>
                <button class="btn btn-ghost btn-sm" onclick="window.__cfmEditBudget('${b.id}')">Edit</button>
                <button class="btn btn-ghost btn-sm" style="color:#DC2626" onclick="window.__cfmDeleteBudget('${b.id}')">Delete</button>
              </div>
            ` : ''}
          </div>
          <div class="card-body">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">

              <!-- Left: Position & Yield -->
              <div>
                <p class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin-bottom:10px">Yield</p>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px">
                  <div>
                    <p class="text-xs text-muted">Budget</p>
                    <p class="font-mono" style="font-size:var(--text-md);font-weight:600">${formatNumber(b.yield_per_ha, 2)}</p>
                    <p class="text-xs text-muted">${formatNumber(b.area_ha, 0)} ha</p>
                  </div>
                  <div>
                    <p class="text-xs text-muted">Forecast</p>
                    <p class="font-mono" style="font-size:var(--text-md);font-weight:600;color:var(--sky-mid)">${latestForecast ? formatNumber(latestForecast.yield_per_ha, 2) : '—'}</p>
                    <p class="text-xs text-muted">${latestForecast ? `${formatNumber(latestForecast.area_ha, 0)} ha` : '—'}</p>
                  </div>
                  <div>
                    <p class="text-xs text-muted">Actual</p>
                    <p class="font-mono" style="font-size:var(--text-md);font-weight:600;color:var(--grass)">${totalHarvest > 0 ? formatNumber(totalHarvest / (b.area_ha || 1), 2) : '—'}</p>
                    <p class="text-xs text-muted">${totalHarvest > 0 ? `${formatNumber(totalHarvest, 0)} total` : '—'}</p>
                  </div>
                </div>

                <p class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin-bottom:10px">Production</p>
                <div style="margin-bottom:6px">
                  <div class="flex items-center gap-2" style="margin-bottom:4px">
                    <span class="text-xs text-muted" style="width:64px">Budget</span>
                    <div style="flex:1;background:var(--rule);border-radius:4px;height:8px">
                      <div style="width:100%;background:var(--sky-mid);border-radius:4px;height:8px"></div>
                    </div>
                    <span class="font-mono text-xs" style="width:80px;text-align:right">${formatNumber(budgetedProd, 0)}</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-muted" style="width:64px">Forecast</span>
                    <div style="flex:1;background:var(--rule);border-radius:4px;height:8px">
                      <div style="width:${budgetedProd ? Math.min(100, (forecastProd/budgetedProd)*100) : 0}%;background:var(--earth);border-radius:4px;height:8px"></div>
                    </div>
                    <span class="font-mono text-xs" style="width:80px;text-align:right">
                      ${formatNumber(forecastProd, 0)}
                      ${vsbudgetPct !== null ? `<span style="color:${vsbudgetPct < 100 ? '#DC2626' : 'var(--grass)'}"> ${vsbudgetPct < 100 ? '▼' : '▲'}${Math.abs(100-vsbudgetPct)}%</span>` : ''}
                    </span>
                  </div>
                  ${totalHarvest > 0 ? `
                  <div class="flex items-center gap-2" style="margin-top:4px">
                    <span class="text-xs text-muted" style="width:64px">Actual</span>
                    <div style="flex:1;background:var(--rule);border-radius:4px;height:8px">
                      <div style="width:${budgetedProd ? Math.min(100, (totalHarvest/budgetedProd)*100) : 0}%;background:var(--grass);border-radius:4px;height:8px"></div>
                    </div>
                    <span class="font-mono text-xs" style="width:80px;text-align:right">${formatNumber(totalHarvest, 0)}</span>
                  </div>
                  ` : ''}
                </div>

                <p class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin:16px 0 10px">Prices</p>
                <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
                  <div>
                    <p class="text-xs text-muted">Budget price</p>
                    <p class="font-mono" style="font-size:var(--text-md);font-weight:600">${b.price ? formatCurrency(b.price, 2) : '—'}</p>
                  </div>
                  <div>
                    <p class="text-xs text-muted">Forecast price</p>
                    <p class="font-mono" style="font-size:var(--text-md);font-weight:600;color:var(--sky-mid)">${latestForecast?.price ? formatCurrency(latestForecast.price, 2) : '—'}</p>
                  </div>
                </div>
              </div>

              <!-- Right: Reforecast history -->
              <div>
                <p class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin-bottom:10px">Reforecast history</p>
                ${forecasts.length ? `
                  <table class="data-table" style="font-size:var(--text-xs)">
                    <thead>
                      <tr>
                        <th>Label</th>
                        <th>Date</th>
                        <th class="num">Area</th>
                        <th class="num">Yield</th>
                        <th class="num">Production</th>
                        ${canWrite() ? '<th></th>' : ''}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td><strong>Budget</strong></td>
                        <td class="muted">Original</td>
                        <td class="num">${formatNumber(b.area_ha, 0)} ha</td>
                        <td class="num">${formatNumber(b.yield_per_ha, 2)}</td>
                        <td class="num">${formatNumber(budgetedProd, 0)}</td>
                        ${canWrite() ? '<td></td>' : ''}
                      </tr>
                      ${forecasts.map(f => `
                        <tr>
                          <td>${f.label}</td>
                          <td class="muted">${formatDate(f.forecast_date)}</td>
                          <td class="num">${formatNumber(f.area_ha, 0)} ha</td>
                          <td class="num">${formatNumber(f.yield_per_ha, 2)}</td>
                          <td class="num">${formatNumber(f.forecast_production, 0)}</td>
                          ${canWrite() ? `<td><button class="btn btn-ghost btn-sm" style="color:#DC2626" onclick="window.__cfmDeleteForecast('${f.id}')">✕</button></td>` : ''}
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                ` : '<p class="text-sm text-muted">No reforecasts yet.</p>'}

                ${harvests.length ? `
                  <p class="text-xs text-muted" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600;margin:16px 0 10px">Harvest entries</p>
                  <table class="data-table" style="font-size:var(--text-xs)">
                    <thead>
                      <tr>
                        <th>Paddock</th>
                        <th>Date</th>
                        <th class="num">Production</th>
                        ${canWrite() ? '<th></th>' : ''}
                      </tr>
                    </thead>
                    <tbody>
                      ${harvests.map(h => `
                        <tr>
                          <td>${h.paddock_name || '—'}</td>
                          <td class="muted">${formatDate(h.harvest_date)}</td>
                          <td class="num">${formatNumber(h.actual_production, 0)} ${h.unit}</td>
                          ${canWrite() ? `<td><button class="btn btn-ghost btn-sm" style="color:#DC2626" onclick="window.__cfmDeleteHarvest('${h.id}')">✕</button></td>` : ''}
                        </tr>
                      `).join('')}
                      <tr style="font-weight:600;border-top:2px solid var(--rule)">
                        <td colspan="2">Total</td>
                        <td class="num">${formatNumber(totalHarvest, 0)}</td>
                        ${canWrite() ? '<td></td>' : ''}
                      </tr>
                    </tbody>
                  </table>
                ` : ''}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }).join('');
}

// ── Season options ────────────────────────────────────────────
function _seasonOptions() {
  const current = currentSeason();
  const seasons = [];
  const [startYear] = current.split('-').map(Number);
  for (let y = startYear + 1; y >= startYear - 3; y--) {
    const s = `${y}-${String(y + 1).slice(2)}`;
    seasons.push(`<option value="${s}" ${s === current ? 'selected' : ''}>${s}</option>`);
  }
  return seasons.join('');
}

// ── Budget modal ──────────────────────────────────────────────
function _budgetModal(container, existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;
  let selectedCommodityId = existing?.commodity_id || '';

  const { overlay } = openModal({
    title: isEdit ? 'Edit budget' : 'Add budget',
    confirmLabel: isEdit ? 'Save changes' : 'Add budget',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Commodity</label>
          ${commoditySelectHTML('b-commodity', existing?.commodity_id)}
        </div>
        <div class="form-group">
          <label class="form-label">Crop type</label>
          ${cropTypeSelectHTML('b-crop-type', existing?.commodity_id, existing?.crop_type_id)}
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Area (ha)</label>
          <input class="form-input num" id="b-area" type="number" step="0.1" value="${existing?.area_ha || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Yield per ha</label>
          <input class="form-input num" id="b-yield" type="number" step="0.001" value="${existing?.yield_per_ha || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Budget price</label>
          <input class="form-input num" id="b-price" type="number" step="0.01" value="${existing?.price || ''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Budgeted production</label>
        <div id="b-production" class="font-mono" style="font-size:var(--text-xl);color:var(--earth);padding:4px 0">—</div>
      </div>
    `,
    onConfirm: async () => {
      const commodityId = qs('#b-commodity', overlay)?.value;
      const cropTypeId = qs('#b-crop-type', overlay)?.value || null;
      const area = parseFloat(qs('#b-area', overlay)?.value || 0) || null;
      const yield_ = parseFloat(qs('#b-yield', overlay)?.value || 0) || null;
      const price = parseFloat(qs('#b-price', overlay)?.value || 0) || null;
      const commodities = getCommodities();
      const commodity = commodities.find(c => c.id === commodityId);

      const row = {
        farm_id: farm.id,
        season: _season,
        commodity_id: commodityId || null,
        commodity: commodity?.name || null,
        crop_type_id: cropTypeId,
        area_ha: area,
        yield_per_ha: yield_,
        price: price,
        created_by: getSession()?.user?.id,
      };

      if (isEdit) {
        await dbUpdate('budgets', existing.id, row);
        toast('Budget updated', 'success');
      } else {
        await dbInsert('budgets', row);
        toast('Budget added', 'success');
      }
      await _loadData();
      _render(container);
    },
  });

  // Init commodity select with inline add
  initCommoditySelect('b-commodity', (commodityId) => {
    selectedCommodityId = commodityId;
    refreshCropTypeSelect('b-crop-type', commodityId);
    initCropTypeSelect('b-crop-type', () => selectedCommodityId);
  });

  // Init crop type select with inline add
  initCropTypeSelect('b-crop-type', () => selectedCommodityId);

  // Live production calc
  const updateProd = () => {
    const a = parseFloat(qs('#b-area', overlay)?.value || 0);
    const y = parseFloat(qs('#b-yield', overlay)?.value || 0);
    const prod = qs('#b-production', overlay);
    if (prod) prod.textContent = a && y ? `${formatNumber(a * y, 0)} units` : '—';
  };
  qs('#b-area', overlay)?.addEventListener('input', updateProd);
  qs('#b-yield', overlay)?.addEventListener('input', updateProd);
}

// ── Reforecast modal ──────────────────────────────────────────
window.__cfmAddForecast = (budgetId) => {
  const budget = _budgets.find(b => b.id === budgetId);
  if (!budget) return;
  const farm = getActiveFarm();

  openModal({
    title: 'Add reforecast',
    confirmLabel: 'Save reforecast',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Label</label>
          <input class="form-input" id="f-label" type="text" placeholder="e.g. Post-planting, Pre-harvest">
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" id="f-date" type="date" value="${new Date().toISOString().slice(0,10)}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Area (ha)</label>
          <input class="form-input num" id="f-area" type="number" step="0.1" value="${budget.area_ha || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Yield per ha</label>
          <input class="form-input num" id="f-yield" type="number" step="0.001" value="${budget.yield_per_ha || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Price</label>
          <input class="form-input num" id="f-price" type="number" step="0.01" value="${budget.price || ''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Forecast production</label>
        <div id="f-prod" class="font-mono" style="font-size:var(--text-xl);color:var(--earth);padding:4px 0">—</div>
      </div>
    `,
    onConfirm: async (modal) => {
      const label = qs('#f-label', modal)?.value?.trim();
      if (!label) throw new Error('Please enter a label for this reforecast');
      await dbInsert('forecasts', {
        budget_id: budgetId,
        farm_id: farm.id,
        season: _season,
        commodity_id: budget.commodity_id,
        crop_type_id: budget.crop_type_id || null,
        label,
        forecast_date: qs('#f-date', modal)?.value,
        area_ha: parseFloat(qs('#f-area', modal)?.value || 0) || null,
        yield_per_ha: parseFloat(qs('#f-yield', modal)?.value || 0) || null,
        price: parseFloat(qs('#f-price', modal)?.value || 0) || null,
        created_by: getSession()?.user?.id,
      });
      toast('Reforecast added', 'success');
      const container = document.getElementById('main');
      await _loadData();
      _render(container);
    },
  });

  setTimeout(() => {
    const updateProd = () => {
      const a = parseFloat(qs('#f-area')?.value || 0);
      const y = parseFloat(qs('#f-yield')?.value || 0);
      const el = qs('#f-prod');
      if (el) el.textContent = a && y ? `${formatNumber(a * y, 0)} units` : '—';
    };
    qs('#f-area')?.addEventListener('input', updateProd);
    qs('#f-yield')?.addEventListener('input', updateProd);
    updateProd();
  }, 100);
};

// ── Harvest modal ─────────────────────────────────────────────
window.__cfmAddHarvest = (budgetId, commodityId, cropTypeId) => {
  const budget = _budgets.find(b => b.id === budgetId);
  const farm = getActiveFarm();

  openModal({
    title: 'Add harvest entry',
    confirmLabel: 'Save harvest',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Paddock name</label>
          <input class="form-input" id="h-paddock" type="text" placeholder="e.g. North paddock">
        </div>
        <div class="form-group">
          <label class="form-label">Harvest date</label>
          <input class="form-input" id="h-date" type="date">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Production</label>
          <input class="form-input num" id="h-production" type="number" step="0.1">
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="h-unit">
            <option value="bale">bale</option>
            <option value="tonne">tonne</option>
            <option value="kg">kg</option>
            <option value="head">head</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="h-notes" rows="2"></textarea>
      </div>
    `,
    onConfirm: async (modal) => {
      const production = parseFloat(qs('#h-production', modal)?.value || 0);
      if (!production) throw new Error('Please enter production quantity');
      await dbInsert('harvest_entries', {
        farm_id: farm.id,
        season: _season,
        commodity_id: commodityId,
        crop_type_id: cropTypeId || null,
        paddock_name: qs('#h-paddock', modal)?.value?.trim() || null,
        harvest_date: qs('#h-date', modal)?.value || null,
        actual_production: production,
        unit: qs('#h-unit', modal)?.value || 'bale',
        notes: qs('#h-notes', modal)?.value?.trim() || null,
        created_by: getSession()?.user?.id,
      });
      toast('Harvest entry added', 'success');
      const container = document.getElementById('main');
      await _loadData();
      _render(container);
    },
  });
};

// ── Edit budget ───────────────────────────────────────────────
window.__cfmEditBudget = (id) => {
  const budget = _budgets.find(b => b.id === id);
  const container = document.getElementById('main');
  if (budget) _budgetModal(container, budget);
};

// ── Delete handlers ───────────────────────────────────────────
window.__cfmDeleteBudget = (id) => {
  openModal({
    title: 'Delete budget',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger',
    bodyHTML: '<p>Delete this budget entry? Reforecasts linked to it will also be deleted.</p>',
    onConfirm: async () => {
      await dbDelete('budgets', id);
      toast('Budget deleted');
      const container = document.getElementById('main');
      await _loadData();
      _render(container);
    },
  });
};

window.__cfmDeleteForecast = (id) => {
  openModal({
    title: 'Remove reforecast',
    confirmLabel: 'Remove',
    confirmClass: 'btn-danger',
    bodyHTML: '<p>Remove this reforecast entry?</p>',
    onConfirm: async () => {
      await dbDelete('forecasts', id);
      toast('Reforecast removed');
      const container = document.getElementById('main');
      await _loadData();
      _render(container);
    },
  });
};

window.__cfmDeleteHarvest = (id) => {
  openModal({
    title: 'Remove harvest entry',
    confirmLabel: 'Remove',
    confirmClass: 'btn-danger',
    bodyHTML: '<p>Remove this harvest entry?</p>',
    onConfirm: async () => {
      await dbDelete('harvest_entries', id);
      toast('Harvest entry removed');
      const container = document.getElementById('main');
      await _loadData();
      _render(container);
    },
  });
};
