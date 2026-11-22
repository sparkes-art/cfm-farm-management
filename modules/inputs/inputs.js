/**
 * Inputs & Consumables module
 *
 * Displays a dashboard of collapsible, tabbed cards for:
 *   Variable: Fertiliser | Chemicals | Seed & Seed Dressing |
 *             Fuel & Lubricants | Contract Services | Selling/Storage/Other
 *   Fixed:    Farm Labour | Fund Management
 *
 * Each variable card has tabs: Summary | Products & Rates | On Hand / To Order
 * Fixed-cost cards show a Budget vs Actual table (R&M-style).
 *
 * Data sources
 *   • input_purchases  — actual spend (category, line_key, total_cost, season)
 *   • input_budgets    — annual budget per line_key per farm/season
 *   • input_forecasts  — forecast overrides per line_key (falls back to budget)
 *   • stock_items / stock_movements — on-hand quantities (read-only here)
 *
 * No localStorage — all state lives in Supabase.
 */

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatCurrency, formatDate, qs, setContent } from '../../js/ui.js';

// ─── Module state ─────────────────────────────────────────────────────────────
let _container = null;
let _unsubs    = [];
let _purchases = [];   // input_purchases rows for active farm/season
let _budgets   = [];   // input_budgets rows
let _forecasts = [];   // input_forecasts rows
let _stockItems= [];   // stock_items for on-hand tab
let _movements = [];   // stock_movements for on-hand

// Card definitions — drives render order and config
const VARIABLE_CARDS = [
  { key: 'fertiliser',  label: 'Fertiliser',               icon: '🌱' },
  { key: 'chemical',    label: 'Chemicals',                 icon: '🧪' },
  { key: 'seed',        label: 'Seed & Seed Dressing',      icon: '🌾' },
  { key: 'fuel',        label: 'Fuel & Lubricants',         icon: '⛽' },
  { key: 'contract',    label: 'Contract Services',         icon: '🚜' },
  { key: 'selling',     label: 'Selling / Storage / Other', icon: '📦' },
];

const FIXED_CARDS = [
  { key: 'labour',    label: 'Farm Labour' },
  { key: 'fund_mgmt', label: 'Fund Management' },
];

// ─── Mount / unmount ──────────────────────────────────────────────────────────

export async function mountInputs(container) {
  _container = container;
  setContent(container, `<div class="module-loading">Loading inputs…</div>`);

  await _loadAll();
  _render();
  _subscribe();
}

export function unmountInputs() {
  _unsubs.forEach(fn => fn());
  _unsubs = [];
  _container = null;
}

// ─── Data loading ──────────────────────────────────────────────────────────────

async function _loadAll() {
  const farmId   = getActiveFarm();
  const seasonId = getActiveSeason();

  const [purchases, budgets, forecasts, stockItems, movements] = await Promise.all([
    dbSelect('input_purchases',  { farm_id: farmId, season: seasonId }),
    dbSelect('input_budgets',    { farm_id: farmId, season_id: seasonId }),
    dbSelect('input_forecasts',  { farm_id: farmId, season_id: seasonId }),
    dbSelect('stock_items',      { farm_id: farmId }),
    dbSelect('stock_movements',  { farm_id: farmId }),
  ]);

  _purchases  = purchases  || [];
  _budgets    = budgets    || [];
  _forecasts  = forecasts  || [];
  _stockItems = stockItems || [];
  _movements  = movements  || [];
}

// ─── Realtime subscriptions ───────────────────────────────────────────────────

function _subscribe() {
  const farmId   = getActiveFarm();
  const seasonId = getActiveSeason();

  _unsubs.push(subscribeTable('input_purchases', farmId, rows => {
    _purchases = rows.filter(r => r.season === seasonId);
    _render();
  }));

  _unsubs.push(subscribeTable('input_budgets', farmId, rows => {
    _budgets = rows.filter(r => r.season_id === seasonId);
    _render();
  }));

  _unsubs.push(subscribeTable('input_forecasts', farmId, rows => {
    _forecasts = rows.filter(r => r.season_id === seasonId);
    _render();
  }));
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

function _actual(cardKey, lineKey) {
  return _purchases
    .filter(p => lineKey
      ? p.line_key === lineKey
      : (p.line_key || '').startsWith(cardKey + '.') || p.category === cardKey)
    .reduce((s, p) => s + (Number(p.total_cost) || 0), 0);
}

function _budget(cardKey, lineKey) {
  if (lineKey) {
    const row = _budgets.find(b => b.line_key === lineKey);
    return row ? Number(row.budget_amt) : 0;
  }
  return _budgets
    .filter(b => b.card_key === cardKey)
    .reduce((s, b) => s + Number(b.budget_amt), 0);
}

function _forecast(cardKey, lineKey) {
  if (lineKey) {
    const fRow = _forecasts.find(f => f.line_key === lineKey);
    if (fRow) return Number(fRow.forecast_amt);
    return _budget(cardKey, lineKey);
  }
  return _budgets
    .filter(b => b.card_key === cardKey)
    .reduce((s, b) => s + _forecast(cardKey, b.line_key), 0);
}

function _variance(actual, forecast) { return forecast - actual; }

function _lines(cardKey) {
  return _budgets
    .filter(b => b.card_key === cardKey)
    .sort((a, b) => a.sort_order - b.sort_order);
}

// ─── Main render ──────────────────────────────────────────────────────────────

function _render() {
  if (!_container) return;
  const write = canWrite();

  const html = `
    <div class="module-content" style="max-width:960px;margin:0 auto;padding:20px 0 40px;">
      ${_renderHeader(write)}
      ${VARIABLE_CARDS.map(c => _renderVariableCard(c, write)).join('')}
      <div style="margin-top:24px;margin-bottom:8px;">
        <h3 style="font-size:var(--text-sm);font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);">Fixed Costs</h3>
      </div>
      ${FIXED_CARDS.map(c => _renderFixedCard(c, write)).join('')}
    </div>`;

  setContent(_container, html);
  _bindEvents();
}

// ─── Header ───────────────────────────────────────────────────────────────────

function _renderHeader(write) {
  const totalActual   = [...VARIABLE_CARDS, ...FIXED_CARDS].reduce((s, c) => s + _actual(c.key), 0);
  const totalBudget   = [...VARIABLE_CARDS, ...FIXED_CARDS].reduce((s, c) => s + _budget(c.key), 0);
  const totalForecast = [...VARIABLE_CARDS, ...FIXED_CARDS].reduce((s, c) => s + _forecast(c.key), 0);
  const totalVar      = _variance(totalActual, totalForecast);
  const varClass      = totalVar >= 0 ? '' : 'over';

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <h1 style="font-size:var(--text-xl);font-weight:700;color:var(--ink);">Inputs &amp; Consumables</h1>
      ${write ? `<button class="btn btn-sm btn-secondary" data-action="manage-budgets">⚙ Manage Budgets</button>` : ''}
    </div>
    <div class="card-summary-strip" style="margin-bottom:24px;">
      <div class="summ-cell">
        <span class="sc-label">YTD Actual</span>
        <span class="sc-value">${formatCurrency(totalActual)}</span>
      </div>
      <div class="summ-cell">
        <span class="sc-label">Budget</span>
        <span class="sc-value">${formatCurrency(totalBudget)}</span>
      </div>
      <div class="summ-cell">
        <span class="sc-label">Forecast</span>
        <span class="sc-value">${formatCurrency(totalForecast)}</span>
      </div>
      <div class="summ-cell sc-variance">
        <span class="sc-label">Var to Forecast</span>
        <span class="sc-value ${varClass}">${totalVar >= 0 ? '' : '▲ '}${formatCurrency(Math.abs(totalVar))}</span>
      </div>
    </div>`;
}

// ─── Variable card ────────────────────────────────────────────────────────────

function _renderVariableCard(card, write) {
  const actual   = _actual(card.key);
  const id       = `inp-card-${card.key}`;

  return `
    <div class="inp-card" id="${id}">
      <div class="inp-header" data-toggle="${id}">
        <span class="inp-name">${card.icon} ${card.label}</span>
        <span class="inp-header-right">
          <span class="inp-ytd-pill">${formatCurrency(actual)} YTD</span>
          <span class="inp-toggle">▼</span>
        </span>
      </div>
      <div class="inp-body">
        <div class="card-tabs">
          <button class="card-tab active" data-tab="${id}-summary">Summary</button>
          <button class="card-tab" data-tab="${id}-products">Products &amp; Rates</button>
          <button class="card-tab" data-tab="${id}-onhand">On Hand / To Order</button>
        </div>
        <div class="card-tab-panel active" id="${id}-summary">
          ${_renderVariableSummaryTab(card, write)}
        </div>
        <div class="card-tab-panel" id="${id}-products">
          ${_renderProductsTab(card, write)}
        </div>
        <div class="card-tab-panel" id="${id}-onhand">
          ${_renderOnHandTab(card)}
        </div>
      </div>
    </div>`;
}

function _renderVariableSummaryTab(card, write) {
  const actual   = _actual(card.key);
  const budget   = _budget(card.key);
  const forecast = _forecast(card.key);
  const variance = _variance(actual, forecast);
  const varClass = variance >= 0 ? '' : 'over';
  const lines    = _lines(card.key);

  const stripHtml = `
    <div class="card-summary-strip">
      <div class="summ-cell">
        <span class="sc-label">YTD Actual</span>
        <span class="sc-value">${formatCurrency(actual)}</span>
      </div>
      <div class="summ-cell">
        <span class="sc-label">Budget</span>
        <span class="sc-value">${formatCurrency(budget)}</span>
      </div>
      <div class="summ-cell">
        <span class="sc-label">Forecast</span>
        <span class="sc-value">${formatCurrency(forecast)}</span>
      </div>
      <div class="summ-cell sc-variance">
        <span class="sc-label">Var to Forecast</span>
        <span class="sc-value ${varClass}">${variance >= 0 ? '' : '▲ '}${formatCurrency(Math.abs(variance))}</span>
      </div>
    </div>`;

  if (!lines.length) {
    return stripHtml + `<p class="inp-empty">No budget lines configured for this category.</p>`;
  }

  const rowsHtml = lines.map(line => {
    const la = _actual(card.key, line.line_key);
    const lb = _budget(card.key, line.line_key);
    const lf = _forecast(card.key, line.line_key);
    const lv = _variance(la, lf);
    const cls = lv >= 0 ? 'var-pos' : 'var-neg';
    return `<tr>
      <td>${line.label}</td>
      <td class="num">${formatCurrency(la)}</td>
      <td class="num">${formatCurrency(lb)}</td>
      <td class="num">${formatCurrency(lf)}</td>
      <td class="num ${cls}">${lv >= 0 ? '' : '▲ '}${formatCurrency(Math.abs(lv))}</td>
      ${write ? `<td><button class="inp-edit-btn" data-action="edit-forecast"
          data-line="${line.line_key}" data-card="${card.key}"
          data-label="${line.label}" data-forecast="${lf}">Edit fcst</button></td>` : ''}
    </tr>`;
  }).join('');

  const ta = lines.reduce((s, l) => s + _actual(card.key, l.line_key), 0);
  const tb = lines.reduce((s, l) => s + _budget(card.key, l.line_key), 0);
  const tf = lines.reduce((s, l) => s + _forecast(card.key, l.line_key), 0);
  const tv = _variance(ta, tf);

  return stripHtml + `
    <table class="inp-summary-table">
      <thead>
        <tr>
          <th>Line item</th>
          <th class="num">Actual</th>
          <th class="num">Budget</th>
          <th class="num">Forecast</th>
          <th class="num">Var to Fcst</th>
          ${write ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr>
          <td><strong>Total</strong></td>
          <td class="num">${formatCurrency(ta)}</td>
          <td class="num">${formatCurrency(tb)}</td>
          <td class="num">${formatCurrency(tf)}</td>
          <td class="num ${tv >= 0 ? 'var-pos' : 'var-neg'}">${tv >= 0 ? '' : '▲ '}${formatCurrency(Math.abs(tv))}</td>
          ${write ? '<td></td>' : ''}
        </tr>
      </tfoot>
    </table>`;
}

function _renderProductsTab(card, write) {
  const rows = _purchases
    .filter(p => {
      const lk = p.line_key || '';
      return lk.startsWith(card.key + '.') || p.category === card.key;
    })
    .sort((a, b) => new Date(b.purchase_date) - new Date(a.purchase_date));

  const addBtn = write
    ? `<button class="btn btn-sm btn-primary" data-action="add-purchase" data-card="${card.key}">+ Add Purchase</button>`
    : '';

  if (!rows.length) {
    return `<div style="display:flex;justify-content:flex-end;margin-bottom:12px;">${addBtn}</div>
      <p class="inp-empty">No purchases recorded yet for this category.</p>`;
  }

  const rowsHtml = rows.map(r => `
    <tr>
      <td>${formatDate(r.purchase_date)}</td>
      <td>${r.product_name || '—'}</td>
      <td>${r.supplier || '—'}</td>
      <td class="num">${r.quantity ? `${r.quantity} ${r.unit || ''}` : '—'}</td>
      <td class="num">${r.unit_cost ? formatCurrency(r.unit_cost) : '—'}</td>
      <td class="num">${formatCurrency(r.total_cost)}</td>
      <td>${r.invoice_reference || '—'}</td>
      ${write ? `<td><button class="inp-edit-btn" data-action="edit-purchase" data-id="${r.id}">Edit</button></td>` : ''}
    </tr>`).join('');

  return `
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">${addBtn}</div>
    <div style="overflow-x:auto;">
      <table class="inp-products-table">
        <thead>
          <tr>
            <th>Date</th><th>Product</th><th>Supplier</th>
            <th class="num">Qty / Unit</th><th class="num">Unit cost</th>
            <th class="num">Total</th><th>Invoice ref</th>
            ${write ? '<th></th>' : ''}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

function _renderOnHandTab(card) {
  const catMap = { fertiliser: 'fertiliser', chemical: 'chemical', seed: 'seed', fuel: 'fuel' };
  const stockCat = catMap[card.key];

  if (!stockCat) {
    return `<p class="inp-empty">On-hand tracking is not applicable for this category.</p>`;
  }

  const items = _stockItems.filter(i => i.category === stockCat);
  if (!items.length) {
    return `<p class="inp-empty">No stock items configured for ${card.label}.<br>Add items in the Stocktake module.</p>`;
  }

  // On-hand = sum(qty × direction) per item
  const onHand = {};
  _movements.forEach(m => {
    if (!items.find(i => i.id === m.item_id)) return;
    onHand[m.item_id] = (onHand[m.item_id] || 0) + (Number(m.qty) * (m.direction || 0));
  });

  const rowsHtml = items.map(item => {
    const qty = onHand[item.id] || 0;
    const atReorder = qty <= (item.reorder_level || 0);
    return `<tr>
      <td>${item.name}</td>
      <td class="num ${qty <= 0 ? 'var-neg' : ''}">${qty.toFixed(2)} ${item.default_unit || ''}</td>
      <td>${item.supplier || '—'}</td>
      <td class="num">${item.reorder_level ? `${item.reorder_level} ${item.default_unit || ''}` : '—'}</td>
      <td>${atReorder
        ? '<span style="color:var(--amber,#a05c00)">⚠ Reorder</span>'
        : '<span style="color:var(--green,#0a7c4e)">✓ OK</span>'}</td>
    </tr>`;
  }).join('');

  return `
    <div style="overflow-x:auto;">
      <table class="inp-products-table">
        <thead>
          <tr>
            <th>Item</th><th class="num">On hand</th><th>Supplier</th>
            <th class="num">Reorder level</th><th>Status</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <p style="margin-top:12px;font-size:var(--text-xs);color:var(--muted);">
      Quantities sourced from Stocktake module. Use Stocktake to record deliveries and applications.
    </p>`;
}

// ─── Fixed cost card ──────────────────────────────────────────────────────────

function _renderFixedCard(card, write) {
  const actual = _actual(card.key);
  const budget = _budget(card.key);
  const id     = `inp-card-${card.key}`;
  const pct    = budget > 0 ? Math.round((actual / budget) * 100) : 0;

  return `
    <div class="inp-card card-fixed" id="${id}">
      <div class="inp-header" data-toggle="${id}">
        <span class="inp-name">${card.label}</span>
        <span class="inp-header-right">
          <span class="inp-ytd-pill ${pct > 100 ? 'var-neg' : ''}">
            ${formatCurrency(actual)} / ${formatCurrency(budget)} (${pct}%)
          </span>
          <span class="inp-toggle">▼</span>
        </span>
      </div>
      <div class="inp-body">
        <div style="padding:16px;">
          ${_renderFixedTable(card, write)}
        </div>
      </div>
    </div>`;
}

function _renderFixedTable(card, write) {
  const lines = _lines(card.key);
  if (!lines.length) return `<p class="inp-empty">No budget lines configured.</p>`;

  const rowsHtml = lines.map(line => {
    const la  = _actual(card.key, line.line_key);
    const lb  = _budget(card.key, line.line_key);
    const lv  = lb - la;
    const pct = lb > 0 ? Math.round((la / lb) * 100) : 0;
    return `<tr>
      <td>${line.label}</td>
      <td class="num">${formatCurrency(la)}</td>
      <td class="num">${formatCurrency(lb)}</td>
      <td class="num ${lv >= 0 ? 'var-pos' : 'var-neg'}">${formatCurrency(Math.abs(lv))} ${lv >= 0 ? 'under' : 'OVER'}</td>
      <td class="num">${pct}%</td>
      ${write ? `<td><button class="inp-edit-btn" data-action="edit-budget"
          data-line="${line.line_key}" data-card="${card.key}"
          data-label="${line.label}" data-budget="${lb}">Edit</button></td>` : ''}
    </tr>`;
  }).join('');

  const ta = lines.reduce((s, l) => s + _actual(card.key, l.line_key), 0);
  const tb = lines.reduce((s, l) => s + _budget(card.key, l.line_key), 0);
  const tv = tb - ta;

  return `
    <table class="inp-summary-table">
      <thead>
        <tr>
          <th>Line item</th><th class="num">Actual</th><th class="num">Budget</th>
          <th class="num">Variance</th><th class="num">% Used</th>
          ${write ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>
        <tr>
          <td><strong>Total</strong></td>
          <td class="num">${formatCurrency(ta)}</td>
          <td class="num">${formatCurrency(tb)}</td>
          <td class="num ${tv >= 0 ? 'var-pos' : 'var-neg'}">${formatCurrency(Math.abs(tv))} ${tv >= 0 ? 'under' : 'OVER'}</td>
          <td class="num">${tb > 0 ? Math.round((ta / tb) * 100) : 0}%</td>
          ${write ? '<td></td>' : ''}
        </tr>
      </tfoot>
    </table>`;
}

// ─── Event binding ────────────────────────────────────────────────────────────

function _bindEvents() {
  if (!_container) return;

  _container.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('click', e => {
      e.stopPropagation();
      const card = document.getElementById(el.dataset.toggle);
      if (card) card.classList.toggle('collapsed');
    });
  });

  _container.querySelectorAll('.card-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn));
  });

  _container.querySelectorAll('[data-action="add-purchase"]').forEach(btn => {
    btn.addEventListener('click', () => _openAddPurchaseModal(btn.dataset.card));
  });

  _container.querySelectorAll('[data-action="edit-purchase"]').forEach(btn => {
    btn.addEventListener('click', () => _openEditPurchaseModal(btn.dataset.id));
  });

  _container.querySelectorAll('[data-action="edit-forecast"]').forEach(btn => {
    btn.addEventListener('click', () => _openForecastModal(btn.dataset));
  });

  _container.querySelectorAll('[data-action="edit-budget"]').forEach(btn => {
    btn.addEventListener('click', () => _openBudgetModal(btn.dataset));
  });

  _container.querySelectorAll('[data-action="manage-budgets"]').forEach(btn => {
    btn.addEventListener('click', _openManageBudgetsModal);
  });
}

function _switchTab(btn) {
  const panelId = btn.dataset.tab;
  const inpCard = btn.closest('.inp-card');
  if (!inpCard) return;
  inpCard.querySelectorAll('.card-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  inpCard.querySelectorAll('.card-tab-panel').forEach(p => p.classList.remove('active'));
  const panel = document.getElementById(panelId);
  if (panel) panel.classList.add('active');
}

// ─── Modals ───────────────────────────────────────────────────────────────────

function _openAddPurchaseModal(cardKey) {
  if (!canWrite()) return;
  const farmId   = getActiveFarm();
  const seasonId = getActiveSeason();
  const catLabel = [...VARIABLE_CARDS, ...FIXED_CARDS].find(c => c.key === cardKey)?.label || cardKey;
  const lines    = _lines(cardKey);
  const lineOptions = lines.map(l =>
    `<option value="${l.line_key}">${l.label}</option>`).join('');

  openModal({
    title: `Add Purchase — ${catLabel}`,
    body: `
      <form id="add-purchase-form" class="modal-form">
        <label>Date<br><input type="date" name="purchase_date" required
          value="${new Date().toISOString().slice(0,10)}" class="form-control"></label>
        <label>Product / Description<br><input type="text" name="product_name"
          class="form-control" required placeholder="e.g. Urea 46%"></label>
        <label>Supplier<br><input type="text" name="supplier" class="form-control"></label>
        ${lineOptions ? `<label>Line item<br><select name="line_key" class="form-control">${lineOptions}</select></label>` : ''}
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <label>Quantity<br><input type="number" name="quantity" class="form-control" step="0.01" min="0"></label>
          <label>Unit<br><input type="text" name="unit" class="form-control" placeholder="t, L, kg…"></label>
          <label>Unit cost ($)<br><input type="number" name="unit_cost" class="form-control" step="0.01" min="0"></label>
        </div>
        <label>Total cost ($)<br><input type="number" name="total_cost" class="form-control"
          step="0.01" min="0" required></label>
        <label>Invoice reference<br><input type="text" name="invoice_reference" class="form-control" placeholder="INV-001"></label>
        <label>Notes<br><input type="text" name="notes" class="form-control"></label>
      </form>`,
    buttons: [{
      label: 'Save Purchase',
      primary: true,
      onClick: async () => {
        const form = document.getElementById('add-purchase-form');
        if (!form.checkValidity()) { form.reportValidity(); return false; }
        const fd = new FormData(form);
        const qty = fd.get('quantity') ? Number(fd.get('quantity')) : null;
        const uc  = fd.get('unit_cost') ? Number(fd.get('unit_cost')) : null;
        let   tc  = Number(fd.get('total_cost'));
        if (!tc && qty && uc) tc = qty * uc;
        await dbInsert('input_purchases', {
          farm_id:           farmId,
          season:            seasonId,
          category:          cardKey,
          line_key:          fd.get('line_key') || cardKey,
          product_name:      fd.get('product_name'),
          supplier:          fd.get('supplier') || null,
          purchase_date:     fd.get('purchase_date'),
          quantity:          qty,
          unit:              fd.get('unit') || null,
          unit_cost:         uc,
          total_cost:        tc,
          invoice_reference: fd.get('invoice_reference') || null,
          notes:             fd.get('notes') || null,
        });
        toast('Purchase saved');
      },
    }],
  });

  // Auto-calc total when qty × unit_cost typed
  setTimeout(() => {
    const form = document.getElementById('add-purchase-form');
    if (!form) return;
    const tcEl = form.querySelector('[name=total_cost]');
    const calc = () => {
      const q = Number(form.querySelector('[name=quantity]').value);
      const u = Number(form.querySelector('[name=unit_cost]').value);
      if (q > 0 && u > 0 && !tcEl._manual) tcEl.value = (q * u).toFixed(2);
    };
    form.querySelector('[name=quantity]').addEventListener('input', calc);
    form.querySelector('[name=unit_cost]').addEventListener('input', calc);
    tcEl.addEventListener('input', () => { tcEl._manual = true; });
  }, 100);
}

function _openEditPurchaseModal(purchaseId) {
  if (!canWrite()) return;
  const row = _purchases.find(p => p.id === purchaseId);
  if (!row) return;

  openModal({
    title: 'Edit Purchase',
    body: `
      <form id="edit-purchase-form" class="modal-form">
        <label>Date<br><input type="date" name="purchase_date" required
          value="${row.purchase_date || ''}" class="form-control"></label>
        <label>Product / Description<br><input type="text" name="product_name"
          class="form-control" required value="${row.product_name || ''}"></label>
        <label>Supplier<br><input type="text" name="supplier" class="form-control"
          value="${row.supplier || ''}"></label>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
          <label>Quantity<br><input type="number" name="quantity" class="form-control"
            step="0.01" min="0" value="${row.quantity || ''}"></label>
          <label>Unit<br><input type="text" name="unit" class="form-control"
            value="${row.unit || ''}"></label>
          <label>Unit cost ($)<br><input type="number" name="unit_cost" class="form-control"
            step="0.01" min="0" value="${row.unit_cost || ''}"></label>
        </div>
        <label>Total cost ($)<br><input type="number" name="total_cost" class="form-control"
          step="0.01" min="0" required value="${row.total_cost || ''}"></label>
        <label>Invoice reference<br><input type="text" name="invoice_reference"
          class="form-control" value="${row.invoice_reference || ''}"></label>
        <label>Notes<br><input type="text" name="notes" class="form-control"
          value="${row.notes || ''}"></label>
      </form>`,
    buttons: [
      {
        label: 'Save',
        primary: true,
        onClick: async () => {
          const form = document.getElementById('edit-purchase-form');
          if (!form.checkValidity()) { form.reportValidity(); return false; }
          const fd = new FormData(form);
          await dbUpdate('input_purchases', purchaseId, {
            purchase_date:     fd.get('purchase_date'),
            product_name:      fd.get('product_name'),
            supplier:          fd.get('supplier') || null,
            quantity:          fd.get('quantity') ? Number(fd.get('quantity')) : null,
            unit:              fd.get('unit') || null,
            unit_cost:         fd.get('unit_cost') ? Number(fd.get('unit_cost')) : null,
            total_cost:        Number(fd.get('total_cost')),
            invoice_reference: fd.get('invoice_reference') || null,
            notes:             fd.get('notes') || null,
          });
          toast('Purchase updated');
        },
      },
      {
        label: 'Delete',
        danger: true,
        onClick: async () => {
          await dbDelete('input_purchases', purchaseId);
          toast('Purchase deleted');
        },
      },
    ],
  });
}

function _openForecastModal(ds) {
  if (!canWrite()) return;
  const { line: lineKey, card: cardKey, label, forecast: currentForecast } = ds;

  openModal({
    title: `Edit Forecast — ${label}`,
    body: `
      <form id="forecast-form" class="modal-form">
        <p style="font-size:var(--text-sm);color:var(--muted);margin-bottom:16px;">
          Forecast = expected full-season spend. Leave equal to budget if no known deviation.
        </p>
        <label>Forecast amount ($)<br>
          <input type="number" name="forecast_amt" class="form-control"
            step="0.01" min="0" value="${currentForecast}" required>
        </label>
        <label>Note (optional)<br>
          <input type="text" name="note" class="form-control"
            placeholder="Reason for deviation from budget">
        </label>
      </form>`,
    buttons: [{
      label: 'Save Forecast',
      primary: true,
      onClick: async () => {
        const form = document.getElementById('forecast-form');
        if (!form.checkValidity()) { form.reportValidity(); return false; }
        const fd      = new FormData(form);
        const farmId  = getActiveFarm();
        const seasId  = getActiveSeason();
        const sess    = getSession();
        const existing = _forecasts.find(f => f.line_key === lineKey);
        if (existing) {
          await dbUpdate('input_forecasts', existing.id, {
            forecast_amt: Number(fd.get('forecast_amt')),
            note:         fd.get('note') || null,
            updated_by:   sess?.user?.email || null,
          });
        } else {
          await dbInsert('input_forecasts', {
            farm_id:      farmId,
            season_id:    seasId,
            line_key:     lineKey,
            forecast_amt: Number(fd.get('forecast_amt')),
            note:         fd.get('note') || null,
            updated_by:   sess?.user?.email || null,
          });
        }
        toast('Forecast updated');
      },
    }],
  });
}

function _openBudgetModal(ds) {
  if (!canWrite()) return;
  const { line: lineKey, label, budget: currentBudget } = ds;

  openModal({
    title: `Edit Budget — ${label}`,
    body: `
      <form id="budget-form" class="modal-form">
        <label>Annual budget ($)<br>
          <input type="number" name="budget_amt" class="form-control"
            step="0.01" min="0" value="${currentBudget}" required>
        </label>
      </form>`,
    buttons: [{
      label: 'Save Budget',
      primary: true,
      onClick: async () => {
        const form = document.getElementById('budget-form');
        if (!form.checkValidity()) { form.reportValidity(); return false; }
        const fd = new FormData(form);
        const existing = _budgets.find(b => b.line_key === lineKey);
        if (existing) {
          await dbUpdate('input_budgets', existing.id, {
            budget_amt: Number(fd.get('budget_amt')),
          });
          toast('Budget updated');
        }
      },
    }],
  });
}

function _openManageBudgetsModal() {
  if (!canWrite()) return;
  const allCards = [...VARIABLE_CARDS, ...FIXED_CARDS];

  const sectionsHtml = allCards.map(card => {
    const lines = _lines(card.key);
    if (!lines.length) return '';
    const rowsHtml = lines.map(line => {
      const lb = _budget(card.key, line.line_key);
      return `<tr>
        <td style="padding:6px 8px 6px 0;">${line.label}</td>
        <td style="padding:6px 0;">
          <input type="number" class="form-control" style="width:130px;text-align:right;"
            data-line="${line.line_key}" step="0.01" min="0" value="${lb}">
        </td>
      </tr>`;
    }).join('');
    return `
      <h4 style="font-size:var(--text-sm);font-weight:700;margin:16px 0 6px;color:var(--navy,#1e3a5f);">${card.label}</h4>
      <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm);">
        <thead><tr>
          <th style="text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--border);">Line item</th>
          <th style="text-align:right;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);padding:4px 0;border-bottom:1px solid var(--border);">Budget ($)</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>`;
  }).join('');

  openModal({
    title: 'Manage All Budgets',
    wide: true,
    body: `<div id="mgr-body" style="max-height:60vh;overflow-y:auto;padding-right:4px;">${sectionsHtml}</div>`,
    buttons: [{
      label: 'Save All',
      primary: true,
      onClick: async () => {
        const inputs  = document.querySelectorAll('#mgr-body input[data-line]');
        const updates = [];
        inputs.forEach(el => {
          const lineKey  = el.dataset.line;
          const val      = Number(el.value);
          const existing = _budgets.find(b => b.line_key === lineKey);
          if (existing && Number(existing.budget_amt) !== val) {
            updates.push(dbUpdate('input_budgets', existing.id, { budget_amt: val }));
          }
        });
        if (updates.length) {
          await Promise.all(updates);
          toast(`${updates.length} budget line${updates.length !== 1 ? 's' : ''} updated`);
        } else {
          toast('No changes to save');
        }
      },
    }],
  });
}
