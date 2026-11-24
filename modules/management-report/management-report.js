// modules/management-report/management-report.js
// Management Report — card-based, three income sections
// Farming Income · Other Income · Carryover Income (below the line)
// All income configured manually via "Add" buttons — no budget import dependency.

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js';
import { formatCurrency, formatNumber, qs, toast } from '../../js/ui.js';
import {
  loadCommodities, getActiveCommodities, getCropTypes,
  getCommodityByName, addCommodity, addCropType,
  setCommodityVisible, isCommodityVisible,
  getCommodityNamesForGroup, getDisplayGroups,
} from '../../js/commodities.js?v=1795410299988';

// ── Module state ──────────────────────────────────────────────────────────────
let _subs   = [];
let _modal  = null;   // currently open modal element
let _activeTabs    = {}; // incomeId → active tab name
let _collapsedCards = {}; // cardId → true if collapsed

export function unmountManagementReport() {
  _subs.forEach(s => { try { s.unsubscribe(); } catch(e) {} });
  _subs = [];
  _modal?.remove();
  _modal = null;
  _activeTabs     = {};
  _collapsedCards = {};
}

export async function mountManagementReport(container) {
  container.innerHTML = `<div id="mgmt-wrap"><div class="mgmt-loading">Loading…</div></div>`;
  const farm = getActiveFarm();
  await loadCommodities(farm?.id);
  await _render(container);

  if (farm) {
    _subs.push(subscribeTable('mgmt_income',      farm.id, () => _render(container)));
    _subs.push(subscribeTable('mgmt_crop_types',  farm.id, () => _render(container)));
    _subs.push(subscribeTable('invoices',         farm.id, () => _render(container)));
    _subs.push(subscribeTable('harvest_records',  farm.id, () => _render(container)));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fC = (n, dp = 0) => n != null && !isNaN(n) ? formatCurrency(n, dp) : '—';
const fN = (n, dp = 0) => n != null && !isNaN(n) ? formatNumber(n, dp)   : '—';
const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const monthName = m => m ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1] : null;

// ── Main render ───────────────────────────────────────────────────────────────
async function _render(container) {
  const farm   = getActiveFarm();
  const season = getActiveSeason();
  const wrap   = qs('#mgmt-wrap', container) || container;

  if (!farm || !season) {
    wrap.innerHTML = `<div class="mgmt-loading">Select a farm and season to view the report.</div>`;
    return;
  }

  // ── Data fetch ──────────────────────────────────────────────────────────────
  const [incomeRows, cropTypeRows, invoices, harvestRows] = await Promise.all([
    dbSelect('mgmt_income',      `farm_id=eq.${farm.id}&season=eq.${season}&order=sort_order.asc,created_at.asc`).catch(() => []),
    dbSelect('mgmt_crop_types',  `farm_id=eq.${farm.id}&season=eq.${season}&order=sort_order.asc,created_at.asc`).catch(() => []),
    dbSelect('invoices',         `farm_id=eq.${farm.id}&select=*&order=invoice_date.asc`).catch(() => []),
    dbSelect('harvest_records',  `farm_id=eq.${farm.id}&season=eq.${season}`).catch(() => []),
  ]);

  // Attach crop types to their parent income row
  const incomeWithTypes = incomeRows.map(row => ({
    ...row,
    cropTypes: cropTypeRows.filter(ct => ct.income_id === row.id)
  }));

  const farmingRows   = incomeWithTypes.filter(r => r.section === 'farming');
  const otherRows     = incomeWithTypes.filter(r => r.section === 'other');
  const carryoverRows = incomeWithTypes.filter(r => r.section === 'carryover');

  // ── KPI summary (top strip) ─────────────────────────────────────────────────
  const farmingBudget = farmingRows.reduce((sum, r) => {
    const price = r.budget_price || 0;
    const prod  = r.cropTypes.reduce((s, ct) => {
      const p = ct.budget_production || (ct.area_ha && ct.budget_yield ? ct.area_ha * ct.budget_yield : 0);
      return s + p;
    }, 0);
    return sum + prod * price;
  }, 0);

  const otherBudget    = otherRows.reduce((s, r) => s + (r.budget_amount || 0), 0);
  const carryoverBudget = carryoverRows.reduce((sum, r) => {
    return sum + r.cropTypes.reduce((s, ct) => {
      const price = ct.price_override ?? r.budget_price ?? 0;
      return s + (ct.budget_units || 0) * price;
    }, 0);
  }, 0);

  const totalBudget = farmingBudget + otherBudget;

  const write = canWrite();
  const now   = new Date();

  wrap.innerHTML = `
    ${_css()}

    <!-- Top bar -->
    <div class="mgmt-topbar">
      <div>
        <div class="mgmt-topbar-title">${esc(farm.name)} — Management Report</div>
        <div class="mgmt-topbar-sub">Season ${esc(season)}</div>
      </div>
      <div class="mgmt-topbar-meta">
        <span class="mgmt-topbar-asof">As at ${now.toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'})}</span>
        <label class="mgmt-ytd-label">YTD to end of</label>
        <select class="mgmt-ytd-sel" id="mgmt-ytd-month">
          ${(() => {
            const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const SEASON = [7,8,9,10,11,12,1,2,3,4,5,6];
            const curM = now.getMonth() + 1;
            return SEASON.map(m => {
              const sel = m === curM ? ' selected' : '';
              return `<option value="${m}"${sel}>${MONTHS[m-1]}</option>`;
            }).join('');
          })()}
        </select>
      </div>
    </div>

    <!-- KPI strip -->
    <div class="mgmt-kpi-strip">
      ${_kpiTile('Farming Income (budget)', fC(farmingBudget), 'white')}
      ${_kpiTile('Other Income (budget)',   fC(otherBudget),   '#93c5fd')}
      ${_kpiTile('Total Revenue (budget)',  fC(totalBudget),   '#86efac')}
      ${_kpiTile('Carryover (below line)',  fC(carryoverBudget), '#fcd34d')}
    </div>

    <!-- Body -->
    <div class="mgmt-body">

      <!-- FARMING INCOME -->
      <div class="mgmt-section">
        <div class="mgmt-section-header">
          <span class="mgmt-section-label">Farming Income</span>
          ${write ? `<button class="mgmt-add-btn" data-section="farming">+ Add Commodity</button>` : ''}
        </div>
        ${farmingRows.length
          ? _renderFarmingGroups(farmingRows, invoices, harvestRows, season, farm)
          : _emptyState('No farming income added yet.', write, 'farming')}
      </div>

      <!-- OTHER INCOME -->
      <div class="mgmt-section">
        <div class="mgmt-section-header">
          <span class="mgmt-section-label">Other Income</span>
          ${write ? `<button class="mgmt-add-btn" data-section="other">+ Add Item</button>` : ''}
        </div>
        ${otherRows.length
          ? _otherTable(otherRows, write)
          : _emptyState('No other income added yet.', write, 'other')}
      </div>

      <!-- ON-HAND INVENTORY (carryover) -->
      <div class="mgmt-section mgmt-section--carryover">
        <div class="mgmt-section-header">
          <span class="mgmt-section-label">On-Hand Inventory <span class="mgmt-below-line">below the line</span></span>
          ${write ? `<button class="mgmt-add-btn mgmt-add-btn--amber" data-section="carryover">+ Add Item</button>` : ''}
        </div>
        <div class="mgmt-carryover-note">
          Prior season commodities on hand and sold in this season. These receipts are excluded from farming income KPIs.
        </div>
        ${carryoverRows.length
          ? carryoverRows.map(r => _carryoverCard(r, invoices, season)).join('')
          : _emptyState('No carryover income added yet.', write, 'carryover')}
      </div>

    </div>
  `;

  // ── Wire events ─────────────────────────────────────────────────────────────
  wrap.querySelectorAll('.mgmt-add-btn').forEach(btn => {
    btn.addEventListener('click', () => _openAddModal(btn.dataset.section, farm, season, container));
  });

  wrap.querySelectorAll('[data-edit-income]').forEach(btn => {
    const id = btn.dataset.editIncome;
    const row = incomeRows.find(r => r.id === id);
    if (row) btn.addEventListener('click', () => _openEditModal(row, farm, season, container));
  });

  wrap.querySelectorAll('[data-delete-income]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this income item and all its crop types?')) return;
      try {
        await dbDelete('mgmt_income', btn.dataset.deleteIncome);
        toast('Deleted', 'success');
      } catch(e) { toast('Delete failed', 'error'); }
    });
  });

  wrap.querySelectorAll('[data-add-crop-type]').forEach(btn => {
    const id = btn.dataset.addCropType;
    const row = incomeRows.find(r => r.id === id);
    if (row) btn.addEventListener('click', () => _openCropTypeModal(null, row, farm, season, container));
  });

  wrap.querySelectorAll('[data-edit-ct]').forEach(btn => {
    const ctId = btn.dataset.editCt;
    const incId = btn.dataset.incomeId;
    const ct  = cropTypeRows.find(c => c.id === ctId);
    const row = incomeRows.find(r => r.id === incId);
    if (ct && row) btn.addEventListener('click', () => _openCropTypeModal(ct, row, farm, season, container));
  });

  wrap.querySelectorAll('[data-delete-ct]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this crop type?')) return;
      try {
        await dbDelete('mgmt_crop_types', btn.dataset.deleteCt);
        toast('Deleted', 'success');
      } catch(e) { toast('Delete failed', 'error'); }
    });
  });

  // Collapse/expand clicks
  wrap.querySelectorAll('.mgmt-collapse-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const cardId     = btn.dataset.collapse;
      const card       = document.getElementById(cardId);
      if (!card) return;
      const body       = card.querySelector('.mgmt-card-collapsible');
      const isNowCollapsed = !body.hidden;
      body.hidden = isNowCollapsed;
      card.classList.toggle('mgmt-card--collapsed', isNowCollapsed);
      btn.textContent = isNowCollapsed ? '▼' : '▲';
      btn.title       = isNowCollapsed ? 'Expand' : 'Collapse';
      _collapsedCards[cardId] = isNowCollapsed;
    });
  });

  // Tab clicks
  wrap.querySelectorAll('.mgmt-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const card   = tab.closest('.mgmt-card');
      const tabKey = tab.dataset.tab;
      const incId  = tab.dataset.income;
      card.querySelectorAll('.mgmt-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      card.querySelectorAll('.mgmt-tab-panel').forEach(p => { p.hidden = p.dataset.tab !== tabKey; });
      if (incId) _activeTabs[incId] = tabKey;
      // Render YTD panel on first open
      if (tabKey === 'ytd') {
        const panel = card.querySelector('.mgmt-ytd-panel');
        if (panel && panel.querySelector('.mgmt-ytd-loading')) _renderYtdPanel(panel);
      }
    });
  });

  // ── YTD: wire master month selector ─────────────────────────────────────────
  const ytdSel = wrap.querySelector('#mgmt-ytd-month');
  function _getYtdMonth() {
    return ytdSel ? parseInt(ytdSel.value) : (new Date().getMonth() + 1);
  }

  // Compute YTD budget for a row given a month
  function _ytdBudget(budget, scheduleJson, toMonth) {
    if (!budget) return 0;
    let sched = null;
    try { sched = scheduleJson ? JSON.parse(scheduleJson) : null; } catch(e) {}
    if (!sched || !sched.length) {
      // Even distribution across 12 months; count season months up to toMonth
      const SEASON = [7,8,9,10,11,12,1,2,3,4,5,6];
      const idx = SEASON.indexOf(toMonth);
      return budget * ((idx + 1) / 12);
    }
    // Sum pct for all months ≤ toMonth in the season
    const SEASON = [7,8,9,10,11,12,1,2,3,4,5,6];
    const toIdx  = SEASON.indexOf(toMonth);
    let pctSum = 0;
    for (const entry of sched) {
      if (SEASON.indexOf(entry.month) <= toIdx) pctSum += (entry.pct || 0);
    }
    return budget * (pctSum / 100);
  }

  // Render a YTD panel given the panel element
  function _renderYtdPanel(panel) {
    const toMonth  = _getYtdMonth();
    const budget   = parseFloat(panel.dataset.budget) || 0;
    const actual   = parseFloat(panel.dataset.actual) || 0;
    const schedRaw = panel.dataset.schedule || '';
    let sched = null;
    try { sched = schedRaw ? JSON.parse(schedRaw) : null; } catch(e) {}

    const ytdBud = _ytdBudget(budget, schedRaw, toMonth);
    const ytdVar = actual - ytdBud;
    const pctBehind = ytdBud > 0 ? ((ytdBud - actual) / ytdBud) * 100 : 0;

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const SEASON = [7,8,9,10,11,12,1,2,3,4,5,6];
    const toIdx  = SEASON.indexOf(toMonth);

    // Build schedule rows
    let schedRows = '';
    if (!sched || !sched.length) {
      const evenPct = (100/12).toFixed(1);
      schedRows = SEASON.map((m, i) => {
        const isFuture  = i > toIdx;
        const isCurrent = i === toIdx;
        const rowBud    = budget / 12;
        const rowClass  = isFuture ? 'future' : (isCurrent ? 'current' : '');
        return `<tr class="${rowClass}">
          <td>${MONTHS[m-1]}</td>
          <td class="num">${evenPct}%</td>
          <td class="num">${fC(rowBud)}</td>
          <td class="num">${isFuture ? '—' : (m === toMonth ? fC(actual - _ytdBudget(budget, schedRaw, SEASON[i-1]||0)) : '—')}</td>
          <td class="num">${isFuture ? '—' : '—'}</td>
        </tr>`;
      }).join('');
    } else {
      // Map sched by month
      const schedMap = {};
      for (const e of sched) schedMap[e.month] = e.pct;
      schedRows = SEASON.map((m, i) => {
        const pct       = schedMap[m] || 0;
        const isFuture  = i > toIdx;
        const isCurrent = i === toIdx;
        const rowBud    = budget * (pct / 100);
        const rowClass  = isFuture ? 'future' : (isCurrent ? 'current' : '');
        return `<tr class="${rowClass}">
          <td>${MONTHS[m-1]}</td>
          <td class="num">${pct > 0 ? pct + '%' : '—'}</td>
          <td class="num">${pct > 0 ? fC(rowBud) : '—'}</td>
          <td class="num">—</td>
          <td class="num">—</td>
        </tr>`;
      }).join('');
    }

    const noSchedNote = (!sched || !sched.length) ? `
      <div class="mgmt-ytd-no-sched">No payment schedule set — showing even distribution across 12 months. Set a schedule via the commodity edit to track payment timing accurately.</div>` : '';

    panel.innerHTML = `
      ${noSchedNote}
      <div class="mgmt-ytd-kpis">
        <div class="mgmt-ytd-kpi">
          <div class="mgmt-ytd-kpi-label">YTD Budget (to ${MONTHS[toMonth-1]})</div>
          <div class="mgmt-ytd-kpi-val" style="color:var(--mgmt-blue)">${fC(ytdBud)}</div>
        </div>
        <div class="mgmt-ytd-kpi">
          <div class="mgmt-ytd-kpi-label">YTD Received</div>
          <div class="mgmt-ytd-kpi-val" style="color:var(--mgmt-green)">${fC(actual)}</div>
        </div>
        <div class="mgmt-ytd-kpi">
          <div class="mgmt-ytd-kpi-label">YTD Variance</div>
          <div class="mgmt-ytd-kpi-val" style="color:${ytdVar >= 0 ? 'var(--mgmt-green)' : 'var(--mgmt-red)'}">${ytdVar >= 0 ? '+' : ''}${fC(ytdVar)}</div>
        </div>
      </div>
      <table class="mgmt-ytd-table">
        <thead><tr>
          <th>Month</th>
          <th class="num">Sched %</th>
          <th class="num">Budget $</th>
          <th class="num">Received $</th>
          <th class="num">Variance</th>
        </tr></thead>
        <tbody>${schedRows}</tbody>
      </table>`;
  }

  // Update all YTD chips and open YTD panels when month changes
  function _refreshYtd() {
    const toMonth  = _getYtdMonth();
    const MONTHS   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    wrap.querySelectorAll('.mgmt-ytd-panel').forEach(panel => {
      const budget   = parseFloat(panel.dataset.budget) || 0;
      const actual   = parseFloat(panel.dataset.actual) || 0;
      const schedRaw = panel.dataset.schedule || '';
      const ytdBud   = _ytdBudget(budget, schedRaw, toMonth);
      const pctBehind = ytdBud > 0 ? ((ytdBud - actual) / ytdBud) * 100 : 0;
      // Update chip
      const incId = panel.dataset.ytdIncome;
      const chip  = wrap.querySelector(`.mgmt-ytd-chip[data-ytd-income="${incId}"]`);
      if (chip) {
        let cls = 'no-schedule', label = 'YTD';
        if (budget > 0) {
          if (pctBehind <= 10)      { cls = 'on-track'; label = `YTD ✓`; }
          else if (pctBehind <= 25) { cls = 'behind';   label = `YTD ${pctBehind.toFixed(0)}% behind`; }
          else                      { cls = 'at-risk';  label = `YTD ${pctBehind.toFixed(0)}% behind`; }
        }
        chip.className = `mgmt-ytd-chip ${cls}`;
        chip.textContent = label;
      }
      // Re-render panel if visible
      if (!panel.hidden) _renderYtdPanel(panel);
    });
  }

  if (ytdSel) ytdSel.addEventListener('change', _refreshYtd);
  // Run once on mount to set initial chip states
  setTimeout(_refreshYtd, 0);
}

// ── Farming income grouped renderer ──────────────────────────────────────────
// Renders each display group: single commodities get one card; grouped commodities
// (e.g. Cotton Lint + Cotton Seed under "Cotton") get a combined card.
function _renderFarmingGroups(farmingRows, invoices, harvestRows, season, farm) {
  const groups = getDisplayGroups(farm?.id);
  const rendered = [];

  for (const entry of groups) {
    if (entry.type === 'single') {
      const matchNames = [entry.commodity.name];
      const rows = farmingRows.filter(r => matchNames.includes(r.name));
      if (!rows.length) continue;
      rendered.push(rows.map(r => _farmingCard(r, invoices, harvestRows, season)).join(''));

    } else {
      const matchNames = getCommodityNamesForGroup(entry.groupName);
      const rows = farmingRows.filter(r => matchNames.includes(r.name));
      if (!rows.length) continue;
      if (rows.length === 1) {
        rendered.push(_farmingCard(rows[0], invoices, harvestRows, season));
      } else {
        rendered.push(_farmingGroupCard(entry.groupName, rows, invoices, harvestRows, season));
      }
    }
  }

  const allHandled = new Set(
    groups.flatMap(e =>
      e.type === 'single'
        ? [e.commodity.name]
        : getCommodityNamesForGroup(e.groupName)
    )
  );
  const unmatched = farmingRows.filter(r => !allHandled.has(r.name));
  if (unmatched.length) {
    rendered.push(unmatched.map(r => _farmingCard(r, invoices, harvestRows, season)).join(''));
  }

  return rendered.join('') || _emptyState('No farming income added yet.', canWrite(), 'farming');
}

// ── Sales pipeline tab builder (shared by _farmingCard and _farmingGroupCard) ──
// rows: array of mgmt_income rows (single-element for a solo card, multiple for group)
// allMatched: array of all matched invoices across all rows
// budgetByRow: array of {name, budgetProd, budgetIncome} per row
function _buildPipelineTab(row, matched, totalBudgetProd, budgetIncome) {
  // Aggregate invoiced qty and value from matched invoices
  const invoicedValue = matched.reduce((s, inv) =>
    s + (parseFloat(inv.gross_amount) || 0) + (parseFloat(inv.total_quality_adj) || 0), 0);
  const invoicedQty = matched.reduce((s, inv) => {
    // Try to sum quantity from batches or line_items
    if (inv.batches) {
      const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
      return s + b.reduce((bs, batch) =>
        bs + (batch.lines || []).filter(l => l.type === 'income').reduce((ls, l) => ls + (parseFloat(l.quantity) || 0), 0), 0);
    }
    return s + (parseFloat(inv.quantity) || 0);
  }, 0);

  const budgetQty = totalBudgetProd;
  const pctInvoiced = budgetQty > 0 ? Math.min(100, (invoicedQty / budgetQty) * 100) : 0;
  const pctUnpriced = 100 - pctInvoiced;
  const isPreHarvest = matched.length === 0;

  // Pipeline bar
  const pipelineBar = `
    <div style="margin:16px 18px 8px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--hint);margin-bottom:4px">
        <span>Invoiced</span><span>Unpriced / Outstanding</span>
      </div>
      <div style="height:16px;border-radius:8px;overflow:hidden;background:var(--mgmt-row-alt);display:flex">
        ${pctInvoiced > 0 ? `<div style="width:${pctInvoiced.toFixed(1)}%;background:var(--mgmt-green);transition:width 0.3s"></div>` : ''}
        <div style="flex:1;background:var(--mgmt-unpriced,#e0e0e0)"></div>
      </div>
      <div style="display:flex;gap:16px;margin-top:6px;font-size:12px">
        <span style="color:var(--mgmt-green)">●  ${pctInvoiced.toFixed(0)}% invoiced</span>
        <span style="color:var(--hint)">●  ${pctUnpriced.toFixed(0)}% unpriced</span>
      </div>
    </div>`;

  if (isPreHarvest) {
    return `
      ${pipelineBar}
      <div style="padding:0 18px 12px">
        <div style="background:var(--mgmt-row-alt);border-radius:8px;padding:12px 16px;color:var(--hint);font-size:13px;text-align:center">
          Pre-harvest — no invoices recorded yet
        </div>
        <table class="mgmt-table" style="margin-top:12px">
          <thead><tr>
            <th>Revenue line</th>
            <th class="num">Budget (${row.unit})</th>
            <th class="num">Budget ($)</th>
          </tr></thead>
          <tbody>
            <tr>
              <td>${esc(row.name)}</td>
              <td class="num">${fN(budgetQty, 1)}</td>
              <td class="num" style="color:var(--mgmt-green)">${fC(budgetIncome)}</td>
            </tr>
          </tbody>
        </table>
      </div>`;
  }

  // Build invoice rows
  const invoiceRows = matched.map(inv => {
    const val = (parseFloat(inv.gross_amount) || 0) + (parseFloat(inv.total_quality_adj) || 0);
    const date = inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'numeric'}) : '—';
    return `<tr>
      <td>${date}</td>
      <td>${esc(inv.invoice_number || '—')}</td>
      <td class="num" style="color:var(--mgmt-green)">${fC(val)}</td>
    </tr>`;
  }).join('');

  return `
    ${pipelineBar}
    <div style="padding:0 18px 14px">
      <table class="mgmt-table">
        <thead><tr>
          <th>Invoice date</th><th>Reference</th><th class="num">Amount</th>
        </tr></thead>
        <tbody>
          ${invoiceRows}
          <tr class="mgmt-table-total">
            <td colspan="2">Total invoiced</td>
            <td class="num" style="color:var(--mgmt-green)">${fC(invoicedValue)}</td>
          </tr>
          <tr>
            <td colspan="2" style="color:var(--hint)">Outstanding (budget − invoiced)</td>
            <td class="num" style="color:var(--hint)">${fC(budgetIncome - invoicedValue)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ── Combined group card (e.g. Cotton Lint + Cotton Seed rolled up as "Cotton") ─
// Single card with Economics, Sales Pipeline, and Crop Types tabs.
// Each revenue line (Lint / Seed) appears as a separate row in Economics.
function _farmingGroupCard(groupName, rows, invoices, harvestRows, season) {
  const write = canWrite();
  const groupId = `group-${groupName.replace(/\s+/g, '-').toLowerCase()}`;
  const activeTab = _activeTabs[groupId] || 'economics';

  // Per-row calculations
  const memberData = rows.map(row => {
    const totalBudgetProd = (row.cropTypes || []).reduce((s, ct) =>
      s + (ct.budget_production || (ct.area_ha && ct.budget_yield ? ct.area_ha * ct.budget_yield : 0)), 0);
    const totalArea = (row.cropTypes || []).reduce((s, ct) => s + (ct.area_ha || 0), 0);
    const budgetIncome = totalBudgetProd * (row.budget_price || 0);
    const matched = _matchInvoices(invoices, row.name, season);
    const actualIncome = matched.reduce((s, inv) =>
      s + (parseFloat(inv.gross_amount) || 0) + (parseFloat(inv.total_quality_adj) || 0), 0);
    return { row, totalBudgetProd, totalArea, budgetIncome, actualIncome, matched };
  });

  const totalBudget  = memberData.reduce((s, d) => s + d.budgetIncome, 0);
  const totalActual  = memberData.reduce((s, d) => s + d.actualIncome, 0);
  const totalVariance = totalActual - totalBudget;
  const totalArea    = memberData.reduce((s, d) => s + d.totalArea, 0);
  const allMatched   = memberData.flatMap(d => d.matched);

  // ── Economics tab: one row per member ────────────────────────────────────
  const econRows = memberData.map(d => `
    <tr>
      <td class="mgmt-table-label">${esc(d.row.name)}</td>
      <td class="num">${fN(d.totalBudgetProd, 0)} ${d.row.unit}</td>
      <td class="num">${d.row.budget_price ? fC(d.row.budget_price, 2) + '/' + d.row.unit : '—'}</td>
      <td class="num" style="color:var(--mgmt-green)">${fC(d.budgetIncome)}</td>
      <td class="num">${fC(d.actualIncome)}</td>
      <td class="num">${d.budgetIncome ? _varSpan(d.actualIncome - d.budgetIncome) : '—'}</td>
      ${write ? `<td class="num actions">
        <button class="mgmt-row-btn" data-edit-income="${d.row.id}">Edit</button>
        <button class="mgmt-row-btn mgmt-row-btn--red" data-delete-income="${d.row.id}">&times;</button>
      </td>` : ''}
    </tr>`).join('');

  const econTab = `
    <table class="mgmt-table">
      <thead><tr>
        <th>Revenue line</th>
        <th class="num">Production</th>
        <th class="num">$/unit</th>
        <th class="num">Budget</th>
        <th class="num">Actual</th>
        <th class="num">Variance</th>
        ${write ? '<th></th>' : ''}
      </tr></thead>
      <tbody>
        ${econRows}
        <tr class="mgmt-table-total">
          <td colspan="3">Gross income</td>
          <td class="num" style="color:var(--mgmt-green)">${fC(totalBudget)}</td>
          <td class="num">${fC(totalActual)}</td>
          <td class="num">${_varSpan(totalVariance)}</td>
          ${write ? '<td></td>' : ''}
        </tr>
      </tbody>
    </table>`;

  // ── Sales Pipeline tab: combined view ─────────────────────────────────────
  const totalBudgetProd = memberData.reduce((s, d) => s + d.totalBudgetProd, 0);
  const invoicedValue   = allMatched.reduce((s, inv) =>
    s + (parseFloat(inv.gross_amount) || 0) + (parseFloat(inv.total_quality_adj) || 0), 0);
  const pctInvoiced = totalBudget > 0 ? Math.min(100, (invoicedValue / totalBudget) * 100) : 0;
  const pctUnpriced = 100 - pctInvoiced;
  const isPreHarvest = allMatched.length === 0;

  const pipelineBar = `
    <div style="margin:16px 18px 8px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--hint);margin-bottom:4px">
        <span>Invoiced</span><span>Unpriced / Outstanding</span>
      </div>
      <div style="height:16px;border-radius:8px;overflow:hidden;background:var(--mgmt-row-alt);display:flex">
        ${pctInvoiced > 0 ? `<div style="width:${pctInvoiced.toFixed(1)}%;background:var(--mgmt-green);transition:width 0.3s"></div>` : ''}
        <div style="flex:1;background:var(--mgmt-unpriced,#e0e0e0)"></div>
      </div>
      <div style="display:flex;gap:16px;margin-top:6px;font-size:12px">
        <span style="color:var(--mgmt-green)">●  ${pctInvoiced.toFixed(0)}% invoiced</span>
        <span style="color:var(--hint)">●  ${pctUnpriced.toFixed(0)}% unpriced</span>
      </div>
    </div>`;

  const pipelineTab = isPreHarvest ? `
    ${pipelineBar}
    <div style="padding:0 18px 12px">
      <div style="background:var(--mgmt-row-alt);border-radius:8px;padding:12px 16px;color:var(--hint);font-size:13px;text-align:center">
        Pre-harvest — no invoices recorded yet
      </div>
      <table class="mgmt-table" style="margin-top:12px">
        <thead><tr>
          <th>Revenue line</th><th class="num">Budget production</th><th class="num">Budget ($)</th>
        </tr></thead>
        <tbody>
          ${memberData.map(d => `<tr>
            <td>${esc(d.row.name)}</td>
            <td class="num">${fN(d.totalBudgetProd, 0)} ${d.row.unit}</td>
            <td class="num" style="color:var(--mgmt-green)">${fC(d.budgetIncome)}</td>
          </tr>`).join('')}
          <tr class="mgmt-table-total">
            <td colspan="2">Total</td>
            <td class="num" style="color:var(--mgmt-green)">${fC(totalBudget)}</td>
          </tr>
        </tbody>
      </table>
    </div>` : `
    ${pipelineBar}
    <div style="padding:0 18px 14px">
      <table class="mgmt-table">
        <thead><tr><th>Invoice date</th><th>Reference</th><th>Commodity</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${allMatched.map(inv => {
            const val = (parseFloat(inv.gross_amount) || 0) + (parseFloat(inv.total_quality_adj) || 0);
            const date = inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-AU', {day:'numeric',month:'short',year:'numeric'}) : '—';
            const comm = (() => {
              if (inv.batches) {
                const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
                return b.flatMap(x => x.lines||[]).find(l => l.type==='income' && l.description)?.description || '';
              }
              return (inv.line_items||[])[0]?.commodity || '';
            })();
            return `<tr>
              <td>${date}</td>
              <td>${esc(inv.invoice_number || '—')}</td>
              <td>${esc(comm)}</td>
              <td class="num" style="color:var(--mgmt-green)">${fC(val)}</td>
            </tr>`;
          }).join('')}
          <tr class="mgmt-table-total">
            <td colspan="3">Total invoiced</td>
            <td class="num" style="color:var(--mgmt-green)">${fC(invoicedValue)}</td>
          </tr>
          <tr>
            <td colspan="3" style="color:var(--hint)">Outstanding (budget − invoiced)</td>
            <td class="num" style="color:var(--hint)">${fC(totalBudget - invoicedValue)}</td>
          </tr>
        </tbody>
      </table>
    </div>`;

  // ── Crop Types tab: combined across all member rows ────────────────────────
  const allCropTypes = memberData.flatMap(d => (d.row.cropTypes || []).map(ct => ({...ct, _rowName: d.row.name, _budgetPrice: d.row.budget_price, _unit: d.row.unit})));
  const ctTotalArea  = allCropTypes.reduce((s, ct) => s + (ct.area_ha || 0), 0);

  const cropTypesTab = `
    <table class="mgmt-table">
      <thead><tr>
        <th>Crop Type</th>
        <th class="num">Area (ha)</th>
        <th class="num">Yield</th>
        <th class="num">Production</th>
        <th class="num">Income ($)</th>
        ${write ? '<th></th>' : ''}
      </tr></thead>
      <tbody>
        ${allCropTypes.length ? allCropTypes.map(ct => {
          const prod = ct.budget_production || (ct.area_ha && ct.budget_yield ? ct.area_ha * ct.budget_yield : null);
          const inc  = prod && ct._budgetPrice ? prod * ct._budgetPrice : null;
          return `<tr>
            <td style="font-weight:600">${esc(ct.crop_type)}<span style="font-size:11px;color:var(--hint);font-weight:400;margin-left:6px">${ct._rowName}</span></td>
            <td class="num">${fN(ct.area_ha, 1)}</td>
            <td class="num">${fN(ct.budget_yield, 2)} ${ct._unit}/ha</td>
            <td class="num">${fN(prod, 1)} ${ct._unit}</td>
            <td class="num" style="color:var(--mgmt-green)">${fC(inc)}</td>
            ${write ? `<td class="num actions">
              <button class="mgmt-row-btn" data-edit-ct="${ct.id}" data-income-id="${ct.income_id}">Edit</button>
              <button class="mgmt-row-btn mgmt-row-btn--red" data-delete-ct="${ct.id}">&times;</button>
            </td>` : ''}
          </tr>`;
        }).join('') : `<tr><td colspan="${write ? 6 : 5}" style="color:var(--hint);padding:16px;text-align:center">No crop types added yet.</td></tr>`}
        ${allCropTypes.length ? `
        <tr class="mgmt-table-total">
          <td>Total</td>
          <td class="num">${fN(ctTotalArea, 1)} ha</td>
          <td class="num">—</td>
          <td class="num">—</td>
          <td class="num" style="color:var(--mgmt-green)">${fC(totalBudget)}</td>
          ${write ? '<td></td>' : ''}
        </tr>` : ''}
      </tbody>
    </table>
    ${write ? `<div style="padding:10px 18px 14px;display:flex;gap:8px;flex-wrap:wrap">
      ${rows.map(r => `<button class="mgmt-add-btn mgmt-add-btn--sm" data-add-crop-type="${r.id}">+ Add Crop Type (${r.name})</button>`).join('')}
    </div>` : ''}`;

  const headerSub = [
    totalArea ? `${fN(totalArea, 0)} ha` : '',
    rows.map(r => r.name).join(' + '),
  ].filter(Boolean).join(' · ');

  const isCollapsed = !!_collapsedCards[groupId];

  return `
    <div class="mgmt-card mgmt-card--group ${isCollapsed ? 'mgmt-card--collapsed' : ''}" id="${groupId}">
      <div class="mgmt-card-header">
        <div>
          <div class="mgmt-card-title">${esc(groupName)}</div>
          ${headerSub ? `<div class="mgmt-card-sub">${headerSub}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="mgmt-badge mgmt-badge-budget">${fC(totalBudget)} budgeted</span>
          ${totalActual > 0 ? `<span class="mgmt-badge mgmt-badge-actual">${fC(totalActual)} received</span>` : ''}
          <span class="mgmt-ytd-chip" data-ytd-income="${groupId}">YTD</span>
          <button class="mgmt-collapse-btn" data-collapse="${groupId}" title="${isCollapsed ? 'Expand' : 'Collapse'}">${isCollapsed ? '▼' : '▲'}</button>
        </div>
      </div>
      <div class="mgmt-card-collapsible" ${isCollapsed ? 'hidden' : ''}>
      <div class="mgmt-tabs">
        <div class="mgmt-tab ${activeTab==='economics' ? 'active' : ''}" data-tab="economics" data-income="${groupId}">Economics</div>
        <div class="mgmt-tab ${activeTab==='pipeline'  ? 'active' : ''}" data-tab="pipeline"  data-income="${groupId}">Sales Pipeline</div>
        <div class="mgmt-tab ${activeTab==='croptypes' ? 'active' : ''}" data-tab="croptypes" data-income="${groupId}">Crop Types</div>
        <div class="mgmt-tab ${activeTab==='ytd'       ? 'active' : ''}" data-tab="ytd"       data-income="${groupId}">YTD Budget vs Actual</div>
      </div>
      <div class="mgmt-tab-panel" data-tab="economics" ${activeTab!=='economics' ? 'hidden' : ''}>${econTab}</div>
      <div class="mgmt-tab-panel" data-tab="pipeline"  ${activeTab!=='pipeline'  ? 'hidden' : ''}>${pipelineTab}</div>
      <div class="mgmt-tab-panel" data-tab="croptypes" ${activeTab!=='croptypes' ? 'hidden' : ''}>${cropTypesTab}</div>
      <div class="mgmt-tab-panel mgmt-ytd-panel" data-tab="ytd" data-ytd-income="${groupId}" data-budget="${totalBudget}" data-schedule="" data-actual="${totalActual}" ${activeTab!=='ytd' ? 'hidden' : ''}>
        <div class="mgmt-ytd-loading">Loading YTD…</div>
      </div>
      </div>
    </div>`;
}

// ── Farming income card ───────────────────────────────────────────────────────
function _farmingCard(row, invoices, harvestRows, season) {
  const write    = canWrite();
  const activeTab = _activeTabs[row.id] || 'economics';

  // Commodity-level aggregates
  const totalBudgetProd = row.cropTypes.reduce((s, ct) => {
    return s + (ct.budget_production || (ct.area_ha && ct.budget_yield ? ct.area_ha * ct.budget_yield : 0));
  }, 0);
  const totalArea = row.cropTypes.reduce((s, ct) => s + (ct.area_ha || 0), 0);
  const budgetIncome = totalBudgetProd * (row.budget_price || 0);

  // Harvested tonnes — sum all crop types for this commodity/season
  const harvestForComm = (harvestRows || []).filter(h =>
    h.commodity.trim().toLowerCase() === row.name.trim().toLowerCase()
  );
  const totalHarvestedQty = harvestForComm.reduce((s, h) => s + (parseFloat(h.harvested_qty) || 0), 0);
  const harvestUnit = harvestForComm[0]?.unit || row.unit || 't';
  const hasHarvest = totalHarvestedQty > 0;

  // Invoiced actuals
  const matched = _matchInvoices(invoices, row.name, season);
  const invoicedQty   = matched.reduce((s, inv) => s + (parseFloat(inv.total_qty) || 0), 0);
  const actualIncome  = matched.reduce((s, inv) => s + (parseFloat(inv.gross_amount) || 0) + (parseFloat(inv.total_quality_adj) || 0), 0);
  const avgRealisedPrice = invoicedQty > 0 ? actualIncome / invoicedQty : null;

  const incomeVariance = budgetIncome ? actualIncome - budgetIncome : null;
  const prodVariance   = totalBudgetProd && hasHarvest ? totalHarvestedQty - totalBudgetProd : null;

  const headerSub = [
    totalArea ? `${fN(totalArea, 0)} ha total` : '',
    row.budget_price ? `${fC(row.budget_price, 2)}/${row.unit}` : '',
    totalBudgetProd ? `${fN(totalBudgetProd, 0)} ${row.unit} budgeted` : '',
  ].filter(Boolean).join(' · ');

  // ── Economics tab — 3 columns: Budget | Harvested | Invoiced ───────────────
  const econTab = `
    <table class="mgmt-table">
      <thead><tr>
        <th>Metric</th><th class="num">Budget</th><th class="num">Harvested</th><th class="num">Invoiced</th><th class="num">Variance</th>
      </tr></thead>
      <tbody>
        <tr class="mgmt-table-group"><td colspan="5">Production</td></tr>
        <tr>
          <td class="mgmt-table-label">Total production (${row.unit})</td>
          <td class="num">${totalBudgetProd ? fN(totalBudgetProd, 1) : '—'}</td>
          <td class="num" style="${hasHarvest ? 'font-weight:600' : 'color:var(--hint)'}">${hasHarvest ? fN(totalHarvestedQty, 1)+' '+harvestUnit : '—'}</td>
          <td class="num" style="color:var(--hint)">${invoicedQty ? fN(invoicedQty, 1)+' '+row.unit : '—'}</td>
          <td class="num">${prodVariance != null ? _varSpan(prodVariance) : '—'}</td>
        </tr>
        <tr class="mgmt-table-group"><td colspan="5">Revenue</td></tr>
        <tr>
          <td class="mgmt-table-label">Price (/${row.unit})</td>
          <td class="num">${fC(row.budget_price, 2)}</td>
          <td class="num">—</td>
          <td class="num" style="color:var(--hint)">${avgRealisedPrice ? fC(avgRealisedPrice, 2)+' avg realised' : '—'}</td>
          <td class="num">—</td>
        </tr>
        <tr class="mgmt-table-total">
          <td>Gross income</td>
          <td class="num">${fC(budgetIncome)}</td>
          <td class="num">—</td>
          <td class="num">${fC(actualIncome)}</td>
          <td class="num">${incomeVariance != null ? _varSpan(incomeVariance) : '—'}</td>
        </tr>
      </tbody>
    </table>`;

  // ── Sales Pipeline tab ─────────────────────────────────────────────────────
  const pipelineTab = _buildPipelineTab(row, matched, totalBudgetProd, budgetIncome);

  // ── Crop Types tab — includes harvested qty per crop type ──────────────────
  const cropTypesTab = `
    <table class="mgmt-table">
      <thead><tr>
        <th>Crop Type</th>
        <th class="num">Area (ha)</th>
        <th class="num">Yield (${row.unit}/ha)</th>
        <th class="num">Budget (${row.unit})</th>
        <th class="num">Harvested (${harvestUnit})</th>
        <th class="num">Income ($)</th>
        ${write ? '<th></th>' : ''}
      </tr></thead>
      <tbody>
        ${row.cropTypes.length ? row.cropTypes.map(ct => {
          const prod = ct.budget_production || (ct.area_ha && ct.budget_yield ? ct.area_ha * ct.budget_yield : null);
          const inc  = prod && row.budget_price ? prod * row.budget_price : null;
          const hr   = harvestForComm.find(h => h.crop_type.trim().toLowerCase() === ct.crop_type.trim().toLowerCase());
          const harvestedQty = hr ? parseFloat(hr.harvested_qty) : null;
          return `<tr>
            <td style="font-weight:600">${esc(ct.crop_type)}</td>
            <td class="num">${fN(ct.area_ha, 1)}</td>
            <td class="num">${fN(ct.budget_yield, 2)}</td>
            <td class="num">${fN(prod, 1)}</td>
            <td class="num" style="${harvestedQty != null ? 'font-weight:600' : 'color:var(--hint)'}">${harvestedQty != null ? fN(harvestedQty, 1) : '—'}</td>
            <td class="num" style="color:var(--mgmt-green)">${fC(inc)}</td>
            ${write ? `<td class="num actions">
              <button class="mgmt-row-btn" data-edit-ct="${ct.id}" data-income-id="${row.id}">Edit</button>
              <button class="mgmt-row-btn mgmt-row-btn--red" data-delete-ct="${ct.id}">&times;</button>
            </td>` : ''}
          </tr>`;
        }).join('') : `<tr><td colspan="${write ? 7 : 6}" style="color:var(--hint);padding:16px;text-align:center">No crop types added — click below to add.</td></tr>`}
        ${row.cropTypes.length ? `
        <tr class="mgmt-table-total">
          <td>Total</td>
          <td class="num">${fN(totalArea, 1)}</td>
          <td class="num">—</td>
          <td class="num">${fN(totalBudgetProd, 1)}</td>
          <td class="num" style="${hasHarvest ? 'font-weight:600' : ''}">${hasHarvest ? fN(totalHarvestedQty, 1) : '—'}</td>
          <td class="num" style="color:var(--mgmt-green)">${fC(budgetIncome)}</td>
          ${write ? '<td></td>' : ''}
        </tr>` : ''}
      </tbody>
    </table>
    ${write ? `<div style="padding:10px 18px 14px">
      <button class="mgmt-add-btn mgmt-add-btn--sm" data-add-crop-type="${row.id}">+ Add Crop Type</button>
    </div>` : ''}`;

  const cardCollapsed = !!_collapsedCards[`card-${row.id}`];

  return `
    <div class="mgmt-card ${cardCollapsed ? 'mgmt-card--collapsed' : ''}" id="card-${row.id}">
      <div class="mgmt-card-header">
        <div>
          <div class="mgmt-card-title">${esc(row.name)}</div>
          ${headerSub ? `<div class="mgmt-card-sub">${headerSub}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="mgmt-badge mgmt-badge-budget">${fC(budgetIncome)} budgeted</span>
          ${hasHarvest ? `<span class="mgmt-badge" style="background:#f0fdf4;color:#166534;border:1px solid #bbf7d0">${fN(totalHarvestedQty,1)} ${harvestUnit} harvested</span>` : ''}
          ${actualIncome > 0 ? `<span class="mgmt-badge mgmt-badge-actual">${fC(actualIncome)} received</span>` : ''}
          <span class="mgmt-ytd-chip" data-ytd-income="${row.id}">YTD</span>
          ${write ? `
            <button class="mgmt-icon-btn" data-edit-income="${row.id}" title="Edit commodity">Edit</button>
            <button class="mgmt-icon-btn mgmt-icon-btn--red" data-delete-income="${row.id}" title="Delete">&times;</button>
          ` : ''}
          <button class="mgmt-collapse-btn" data-collapse="card-${row.id}" title="${cardCollapsed ? 'Expand' : 'Collapse'}">${cardCollapsed ? '▼' : '▲'}</button>
        </div>
      </div>
      <div class="mgmt-card-collapsible" ${cardCollapsed ? 'hidden' : ''}>
      <div class="mgmt-tabs">
        <div class="mgmt-tab ${activeTab==='economics'  ? 'active' : ''}" data-tab="economics"  data-income="${row.id}">Economics</div>
        <div class="mgmt-tab ${activeTab==='pipeline'   ? 'active' : ''}" data-tab="pipeline"   data-income="${row.id}">Sales Pipeline</div>
        <div class="mgmt-tab ${activeTab==='croptypes'  ? 'active' : ''}" data-tab="croptypes"  data-income="${row.id}">Crop Types</div>
        <div class="mgmt-tab ${activeTab==='ytd'        ? 'active' : ''}" data-tab="ytd"        data-income="${row.id}">YTD Budget vs Actual</div>
      </div>
      <div class="mgmt-tab-panel" data-tab="economics" ${activeTab!=='economics' ? 'hidden' : ''}>${econTab}</div>
      <div class="mgmt-tab-panel" data-tab="pipeline"  ${activeTab!=='pipeline'  ? 'hidden' : ''}>${pipelineTab}</div>
      <div class="mgmt-tab-panel" data-tab="croptypes" ${activeTab!=='croptypes' ? 'hidden' : ''}>${cropTypesTab}</div>
      <div class="mgmt-tab-panel mgmt-ytd-panel" data-tab="ytd" data-ytd-income="${row.id}" data-budget="${budgetIncome}" data-schedule="${esc(JSON.stringify(row.payment_schedule||null))}" data-actual="${actualIncome}" ${activeTab!=='ytd' ? 'hidden' : ''}>
        <div class="mgmt-ytd-loading">Loading YTD…</div>
      </div>
      </div>
    </div>`;
}

// ── Other income table ────────────────────────────────────────────────────────
function _otherTable(rows, write) {
  const total = rows.reduce((s, r) => s + (r.budget_amount || 0), 0);
  return `
    <div class="mgmt-card">
      <table class="mgmt-table">
        <thead><tr>
          <th>Item</th>
          <th class="num">Budget ($)</th>
          <th>Expected</th>
          <th>Notes</th>
          ${write ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td style="font-weight:600">${esc(r.name)}</td>
            <td class="num">${fC(r.budget_amount)}</td>
            <td>${r.expected_month ? monthName(r.expected_month) : '—'}</td>
            <td style="color:var(--hint);font-size:11px">${esc(r.notes || '')}</td>
            ${write ? `<td class="actions">
              <button class="mgmt-row-btn" data-edit-income="${r.id}">Edit</button>
              <button class="mgmt-row-btn mgmt-row-btn--red" data-delete-income="${r.id}">&times;</button>
            </td>` : ''}
          </tr>`).join('')}
          <tr class="mgmt-table-total">
            <td>Total other income</td>
            <td class="num">${fC(total)}</td>
            <td colspan="${write ? 3 : 2}"></td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ── Carryover income card ─────────────────────────────────────────────────────
function _carryoverCard(row, invoices, season) {
  const write = canWrite();
  const activeTab = _activeTabs[row.id] || 'items';

  const totalUnits = row.cropTypes.reduce((s, ct) => s + (ct.budget_units || 0), 0);
  const totalIncome = row.cropTypes.reduce((s, ct) => {
    const price = ct.price_override ?? row.budget_price ?? 0;
    return s + (ct.budget_units || 0) * price;
  }, 0);

  const headerSub = [
    totalUnits ? `${fN(totalUnits, 1)} ${row.unit}` : '',
    totalIncome ? fC(totalIncome) : '',
  ].filter(Boolean).join(' · ');

  const lotsTab = `
    <table class="mgmt-table">
      <thead><tr>
        <th>Item / Description</th>
        <th class="num">Units (${row.unit})</th>
        <th class="num">Price (/${row.unit})</th>
        <th class="num">Income ($)</th>
        <th>Expected</th>
        ${write ? '<th></th>' : ''}
      </tr></thead>
      <tbody>
        ${row.cropTypes.length ? row.cropTypes.map(ct => {
          const price = ct.price_override ?? row.budget_price ?? null;
          const inc   = ct.budget_units && price ? ct.budget_units * price : null;
          return `<tr>
            <td style="font-weight:600">${esc(ct.crop_type)}</td>
            <td class="num">${fN(ct.budget_units, 1)}</td>
            <td class="num">${price ? fC(price, 2) : '—'}</td>
            <td class="num" style="color:var(--mgmt-amber)">${fC(inc)}</td>
            <td>${ct.expected_month ? monthName(ct.expected_month) : '—'}</td>
            ${write ? `<td class="actions">
              <button class="mgmt-row-btn" data-edit-ct="${ct.id}" data-income-id="${row.id}">Edit</button>
              <button class="mgmt-row-btn mgmt-row-btn--red" data-delete-ct="${ct.id}">&times;</button>
            </td>` : ''}
          </tr>`;
        }).join('') : `<tr><td colspan="${write ? 6 : 5}" style="color:var(--hint);padding:16px;text-align:center">No items added yet.</td></tr>`}
        ${row.cropTypes.length ? `
        <tr class="mgmt-table-total">
          <td>Total</td>
          <td class="num">${fN(totalUnits, 1)}</td>
          <td class="num">—</td>
          <td class="num" style="color:var(--mgmt-amber)">${fC(totalIncome)}</td>
          <td colspan="${write ? 2 : 1}"></td>
        </tr>` : ''}
      </tbody>
    </table>
    ${write ? `<div style="padding:10px 18px 14px">
      <button class="mgmt-add-btn mgmt-add-btn--sm mgmt-add-btn--amber" data-add-crop-type="${row.id}">+ Add Item</button>
    </div>` : ''}`;

  return `
    <div class="mgmt-card mgmt-card--carryover" id="card-${row.id}">
      <div class="mgmt-card-header">
        <div>
          <div class="mgmt-card-title">${esc(row.name)}</div>
          ${headerSub ? `<div class="mgmt-card-sub">${headerSub}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="mgmt-badge mgmt-badge-carryover">${fC(totalIncome)} budgeted</span>
          ${write ? `
            <button class="mgmt-icon-btn" data-edit-income="${row.id}" title="Edit">Edit</button>
            <button class="mgmt-icon-btn mgmt-icon-btn--red" data-delete-income="${row.id}" title="Delete">&times;</button>
          ` : ''}
        </div>
      </div>
      <div class="mgmt-tab-panel" data-tab="items">${lotsTab}</div>
    </div>`;
}

// ── Match invoices to a commodity by name ─────────────────────────────────────
function _matchInvoices(invoices, commName, season) {
  const key = commName.trim().toUpperCase();
  return invoices.filter(inv => {
    if (inv.season !== season) return false;
    const linked = inv.forward_contract_id;
    const batchComm = (() => {
      if (!inv.batches) return '';
      const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
      return b.flatMap(x => x.lines||[]).find(l => l.type==='income' && l.description)?.description || '';
    })();
    const iComm = batchComm || (inv.line_items||[])[0]?.commodity || '';
    return iComm.trim().toUpperCase() === key;
  });
}

// ── Variance span ─────────────────────────────────────────────────────────────
function _varSpan(v) {
  const good  = v >= 0;
  const color = good ? 'var(--mgmt-green)' : 'var(--mgmt-red)';
  const sign  = v >= 0 ? '+' : '';
  return `<span style="color:${color};font-weight:600">${sign}${fC(v)}</span>`;
}

// ── Empty state ───────────────────────────────────────────────────────────────
function _emptyState(msg, write, section) {
  return `
    <div class="mgmt-empty">
      <div class="mgmt-empty-msg">${msg}</div>
      ${write ? `<button class="mgmt-add-btn" data-section="${section}">+ Add</button>` : ''}
    </div>`;
}

// ── KPI tile ──────────────────────────────────────────────────────────────────
function _kpiTile(label, value, color) {
  return `
    <div class="mgmt-kpi">
      <div class="mgmt-kpi-label">${label}</div>
      <div class="mgmt-kpi-value" style="color:${color}">${value}</div>
    </div>`;
}

// ── Helpers for master commodity/crop type lists ──────────────────────────────
function _getMasterCropTypes(commodityName) {
  const all = getActiveCommodities();
  const comm = all.find(c => c.name.toLowerCase() === commodityName.toLowerCase());
  if (!comm) return [];
  return getCropTypes(comm.id);
}

// ── Modals ────────────────────────────────────────────────────────────────────

function _openAddModal(section, farm, season, container) {
  const isOther = section === 'other';
  const isCarry = section === 'carryover';

  // Build commodity options filtered to this farm
  const activeCommodities = getActiveCommodities(farm.id);

  const commoditySelectHTML = isOther ? '' : `
    <div class="mgmt-form-group">
      <label>${isCarry ? 'Commodity (prior season)' : 'Commodity'}</label>
      <select id="mi-commodity" class="mgmt-input">
        <option value="">— Select commodity —</option>
        ${activeCommodities.map(c => `<option value="${c.id}" data-unit="${_unitForCommodity(c)}">${c.name}</option>`).join('')}
        <option value="__new__" style="color:#1a5fb4;font-weight:600">＋ Add new commodity…</option>
      </select>
      <div id="mi-new-commodity-row" style="display:none;margin-top:6px;display:none">
        <input id="mi-new-commodity-name" type="text" class="mgmt-input" placeholder="New commodity name">
      </div>
    </div>`;

  const html = `
    <div class="mgmt-modal-backdrop">
      <div class="mgmt-modal">
        <div class="mgmt-modal-header">
          <div class="mgmt-modal-title">${
            isOther ? 'Add Other Income' :
            isCarry ? 'Add Carryover Income' :
                      'Add Farming Income Commodity'
          }</div>
          <button class="mgmt-modal-close">✕</button>
        </div>
        <div class="mgmt-modal-body">
          ${commoditySelectHTML}
          ${isOther ? `
          <div class="mgmt-form-group">
            <label>Name</label>
            <input id="mi-name" type="text" class="mgmt-input"
              placeholder="e.g. Agistment, Water entitlement sale" autocomplete="off">
          </div>` : ''}
          ${!isOther ? `
          <div class="mgmt-form-row">
            <div class="mgmt-form-group">
              <label>Unit</label>
              <select id="mi-unit" class="mgmt-input">
                <option value="t">Tonnes (t)</option>
                <option value="bales">Bales</option>
                <option value="hd">Head (hd)</option>
                <option value="kg">Kilograms (kg)</option>
                <option value="ML">Megalitres (ML)</option>
              </select>
            </div>
            <div class="mgmt-form-group">
              <label>Budget price ($/unit)</label>
              <input id="mi-price" type="number" step="0.01" class="mgmt-input" placeholder="e.g. 580.00">
            </div>
          </div>
          <div id="mi-tonne-converter" style="display:none;background:var(--mgmt-row-alt);border-radius:8px;padding:12px 14px;margin-bottom:8px">
            <div style="font-size:12px;font-weight:600;color:var(--hint);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">
              $/tonne → $/bale converter
            </div>
            <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
              <div class="mgmt-form-group" style="flex:1;min-width:110px;margin:0">
                <label style="font-size:12px">Price ($/t)</label>
                <input id="mi-price-per-tonne" type="number" step="0.01" class="mgmt-input" placeholder="e.g. 980.00">
              </div>
              <div class="mgmt-form-group" style="flex:1;min-width:110px;margin:0">
                <label style="font-size:12px">Bale weight (kg/bale)</label>
                <input id="mi-bale-weight" type="number" step="0.1" class="mgmt-input" value="227" placeholder="227">
              </div>
              <button type="button" id="mi-convert-btn" class="mgmt-btn mgmt-btn--ghost" style="flex-shrink:0;height:38px">
                Convert →
              </button>
            </div>
            <div id="mi-convert-result" style="font-size:12px;color:var(--hint);margin-top:6px"></div>
          </div>` : `
          <div class="mgmt-form-row">
            <div class="mgmt-form-group">
              <label>Budget amount ($)</label>
              <input id="mi-amount" type="number" step="1" class="mgmt-input" placeholder="e.g. 45000">
            </div>
            <div class="mgmt-form-group">
              <label>Expected month</label>
              <select id="mi-month" class="mgmt-input">
                <option value="">— Select —</option>
                ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m,i) =>
                  `<option value="${i+1}">${m}</option>`).join('')}
              </select>
            </div>
          </div>`}
          <div class="mgmt-form-group">
            <label>Notes (optional)</label>
            <input id="mi-notes" type="text" class="mgmt-input" placeholder="Optional notes">
          </div>
        </div>
        <div class="mgmt-modal-footer">
          <button class="mgmt-btn mgmt-btn--ghost" id="mi-cancel">Cancel</button>
          <button class="mgmt-btn mgmt-btn--primary" id="mi-save">Save</button>
        </div>
      </div>
    </div>`;

  _modal?.remove();
  _modal = document.createElement('div');
  _modal.innerHTML = html;
  document.body.appendChild(_modal);

  _modal.querySelector('#mi-cancel').onclick = () => { _modal?.remove(); _modal = null; };
  _modal.querySelector('.mgmt-modal-close').onclick = () => { _modal?.remove(); _modal = null; };

  // $/tonne → $/bale converter visibility
  const unitSel = _modal.querySelector('#mi-unit');
  const converterDiv = _modal.querySelector('#mi-tonne-converter');
  function _toggleConverter() {
    if (!converterDiv || !unitSel) return;
    converterDiv.style.display = unitSel.value === 'bales' ? 'block' : 'none';
  }
  if (unitSel) {
    unitSel.addEventListener('change', _toggleConverter);
    _toggleConverter(); // run on init
  }

  // Convert button
  const convertBtn = _modal.querySelector('#mi-convert-btn');
  if (convertBtn) {
    convertBtn.addEventListener('click', () => {
      const ppt = parseFloat(_modal.querySelector('#mi-price-per-tonne').value);
      const bwKg = parseFloat(_modal.querySelector('#mi-bale-weight').value) || 227;
      if (!ppt || isNaN(ppt)) return;
      const baleWeight_t = bwKg / 1000;
      const pricePBale = ppt * baleWeight_t;
      const priceInput = _modal.querySelector('#mi-price');
      if (priceInput) priceInput.value = pricePBale.toFixed(2);
      const resultDiv = _modal.querySelector('#mi-convert-result');
      if (resultDiv) resultDiv.textContent = `$${ppt}/t × ${bwKg}kg = $${pricePBale.toFixed(2)}/bale (filled above)`;
    });
  }

  // Commodity dropdown — auto-fill unit, show new-commodity input
  const commSel = _modal.querySelector('#mi-commodity');
  const newCommRow = _modal.querySelector('#mi-new-commodity-row');
  if (commSel) {
    commSel.addEventListener('change', () => {
      if (commSel.value === '__new__') {
        newCommRow.style.display = 'block';
        _modal.querySelector('#mi-new-commodity-name')?.focus();
        commSel.value = '';
      } else {
        newCommRow.style.display = 'none';
        // Auto-fill unit from commodity
        const opt = commSel.selectedOptions[0];
        const unit = opt?.dataset?.unit;
        if (unit && unitSel) {
          const match = [...unitSel.options].find(o => o.value === unit);
          if (match) {
            unitSel.value = unit;
            _toggleConverter();
          }
        }
      }
    });
  }

  _modal.querySelector('#mi-save').onclick = async () => {
    let name, unit;

    if (isOther) {
      name = _modal.querySelector('#mi-name').value.trim();
      unit = '$';
    } else {
      // Resolve commodity — existing or new
      const commSelVal = commSel?.value;
      const newName = _modal.querySelector('#mi-new-commodity-name')?.value.trim();

      if (newName) {
        // Create new commodity
        try {
          const newComm = await addCommodity(newName);
          name = newComm.name;
        } catch(e) {
          toast('Failed to create commodity', 'error'); return;
        }
      } else if (commSelVal) {
        const c = activeCommodities.find(x => x.id === commSelVal);
        name = c?.name;
      }

      unit = _modal.querySelector('#mi-unit')?.value || 't';
    }

    if (!name) { toast('Select or enter a commodity name', 'warning'); return; }

    const payload = {
      farm_id: farm.id,
      season,
      section,
      name,
      unit,
      budget_price: !isOther ? (parseFloat(_modal.querySelector('#mi-price')?.value) || null) : null,
      budget_amount: isOther ? (parseFloat(_modal.querySelector('#mi-amount')?.value) || null) : null,
      expected_month: isOther ? (parseInt(_modal.querySelector('#mi-month')?.value) || null) : null,
      notes: _modal.querySelector('#mi-notes').value.trim() || null,
      created_by: getSession()?.user?.id || null,
    };

    try {
      await dbInsert('mgmt_income', payload);
      toast('Saved', 'success');
      _modal?.remove(); _modal = null;
    } catch(e) {
      console.error(e);
      toast('Save failed — check console', 'error');
    }
  };
}

// Helper: pick the most likely unit for a commodity based on its name
function _unitForCommodity(c) {
  if (c.is_livestock) return 'hd';
  const n = c.name.toLowerCase();
  if (n.includes('cotton')) return 'bales';
  if (n.includes('water') || n.includes('ml')) return 'ML';
  return 't';
}

function _openEditModal(row, farm, season, container) {
  const isOther = row.section === 'other';
  const isCarry = row.section === 'carryover';

  const html = `
    <div class="mgmt-modal-backdrop">
      <div class="mgmt-modal">
        <div class="mgmt-modal-header">
          <div class="mgmt-modal-title">Edit — ${esc(row.name)}</div>
          <button class="mgmt-modal-close">✕</button>
        </div>
        <div class="mgmt-modal-body">
          <div class="mgmt-form-group">
            <label>Name</label>
            <input id="mi-name" type="text" class="mgmt-input" value="${esc(row.name)}">
          </div>
          ${!isOther ? `
          <div class="mgmt-form-row">
            <div class="mgmt-form-group">
              <label>Unit</label>
              <select id="mi-unit" class="mgmt-input">
                ${['t','bales','hd','kg','ML'].map(u =>
                  `<option value="${u}" ${row.unit===u?'selected':''}>${u}</option>`).join('')}
              </select>
            </div>
            <div class="mgmt-form-group">
              <label>Budget price ($/unit)</label>
              <input id="mi-price" type="number" step="0.01" class="mgmt-input" value="${row.budget_price || ''}">
            </div>
          </div>
          <div id="mi-tonne-converter" style="display:${row.unit==='bales'?'block':'none'};background:var(--mgmt-row-alt);border-radius:8px;padding:12px 14px;margin-bottom:8px">
            <div style="font-size:12px;font-weight:600;color:var(--hint);margin-bottom:8px;text-transform:uppercase;letter-spacing:.04em">
              $/tonne → $/bale converter
            </div>
            <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
              <div class="mgmt-form-group" style="flex:1;min-width:110px;margin:0">
                <label style="font-size:12px">Price ($/t)</label>
                <input id="mi-price-per-tonne" type="number" step="0.01" class="mgmt-input" placeholder="e.g. 980.00">
              </div>
              <div class="mgmt-form-group" style="flex:1;min-width:110px;margin:0">
                <label style="font-size:12px">Bale weight (kg/bale)</label>
                <input id="mi-bale-weight" type="number" step="0.1" class="mgmt-input" value="227" placeholder="227">
              </div>
              <button type="button" id="mi-convert-btn" class="mgmt-btn mgmt-btn--ghost" style="flex-shrink:0;height:38px">
                Convert →
              </button>
            </div>
            <div id="mi-convert-result" style="font-size:12px;color:var(--hint);margin-top:6px"></div>
          </div>` : `
          <div class="mgmt-form-row">
            <div class="mgmt-form-group">
              <label>Budget amount ($)</label>
              <input id="mi-amount" type="number" step="1" class="mgmt-input" value="${row.budget_amount || ''}">
            </div>
            <div class="mgmt-form-group">
              <label>Expected month</label>
              <select id="mi-month" class="mgmt-input">
                <option value="">— Select —</option>
                ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m,i) =>
                  `<option value="${i+1}" ${row.expected_month===i+1?'selected':''}>${m}</option>`).join('')}
              </select>
            </div>
          </div>`}
          <div class="mgmt-form-group">
            <label>Notes</label>
            <input id="mi-notes" type="text" class="mgmt-input" value="${esc(row.notes || '')}">
          </div>
        </div>
        <div class="mgmt-modal-footer">
          <button class="mgmt-btn mgmt-btn--ghost" id="mi-cancel">Cancel</button>
          <button class="mgmt-btn mgmt-btn--primary" id="mi-save">Save changes</button>
        </div>
      </div>
    </div>`;

  _modal?.remove();
  _modal = document.createElement('div');
  _modal.innerHTML = html;
  document.body.appendChild(_modal);

  _modal.querySelector('#mi-cancel').onclick = () => { _modal?.remove(); _modal = null; };
  _modal.querySelector('.mgmt-modal-close').onclick = () => { _modal?.remove(); _modal = null; };

  // $/tonne → $/bale converter for edit modal
  const editUnitSel = _modal.querySelector('#mi-unit');
  const editConverterDiv = _modal.querySelector('#mi-tonne-converter');
  if (editUnitSel && editConverterDiv) {
    editUnitSel.addEventListener('change', () => {
      editConverterDiv.style.display = editUnitSel.value === 'bales' ? 'block' : 'none';
    });
    const editConvertBtn = _modal.querySelector('#mi-convert-btn');
    if (editConvertBtn) {
      editConvertBtn.addEventListener('click', () => {
        const ppt = parseFloat(_modal.querySelector('#mi-price-per-tonne').value);
        const bwKg = parseFloat(_modal.querySelector('#mi-bale-weight').value) || 227;
        if (!ppt || isNaN(ppt)) return;
        const pricePBale = ppt * (bwKg / 1000);
        const priceInput = _modal.querySelector('#mi-price');
        if (priceInput) priceInput.value = pricePBale.toFixed(2);
        const resultDiv = _modal.querySelector('#mi-convert-result');
        if (resultDiv) resultDiv.textContent = `$${ppt}/t × ${bwKg}kg = $${pricePBale.toFixed(2)}/bale (filled above)`;
      });
    }
  }

  _modal.querySelector('#mi-save').onclick = async () => {
    const name = _modal.querySelector('#mi-name').value.trim();
    if (!name) { toast('Enter a name', 'warning'); return; }

    const patch = {
      name,
      unit: isOther ? '$' : (_modal.querySelector('#mi-unit')?.value || row.unit),
      budget_price: !isOther ? (parseFloat(_modal.querySelector('#mi-price')?.value) || null) : null,
      budget_amount: isOther ? (parseFloat(_modal.querySelector('#mi-amount')?.value) || null) : null,
      expected_month: isOther ? (parseInt(_modal.querySelector('#mi-month')?.value) || null) : null,
      notes: _modal.querySelector('#mi-notes').value.trim() || null,
      updated_at: new Date().toISOString(),
    };

    try {
      await dbUpdate('mgmt_income', row.id, patch);
      toast('Saved', 'success');
      _modal?.remove(); _modal = null;
    } catch(e) {
      console.error(e);
      toast('Save failed', 'error');
    }
  };
}

function _openCropTypeModal(ct, row, farm, season, container) {
  const isCarry = row.section === 'carryover';
  const isEdit  = !!ct;

  // Find the master commodity to get its crop types
  const masterCropTypes = !isCarry ? _getMasterCropTypes(row.name) : [];

  const cropTypeInput = isCarry ? `
    <div class="mgmt-form-group">
      <label>Item / Description</label>
      <input id="ct-name" type="text" class="mgmt-input"
        placeholder="e.g. Wheat Bin 3, Dec delivery"
        value="${esc(ct?.crop_type || '')}">
    </div>` : masterCropTypes.length ? `
    <div class="mgmt-form-group">
      <label>Crop Type</label>
      <select id="ct-name-sel" class="mgmt-input">
        <option value="">— Select crop type —</option>
        ${masterCropTypes.map(t => `<option value="${esc(t.name)}" ${ct?.crop_type === t.name ? 'selected' : ''}>${t.name}</option>`).join('')}
        <option value="__new__" style="color:#1a5fb4;font-weight:600">＋ Add new crop type…</option>
      </select>
      <input id="ct-name" type="text" class="mgmt-input" style="display:none;margin-top:6px"
        placeholder="New crop type name" value="">
    </div>` : `
    <div class="mgmt-form-group">
      <label>Crop Type</label>
      <input id="ct-name" type="text" class="mgmt-input"
        placeholder="e.g. Dryland, Irrigated, Main Season"
        value="${esc(ct?.crop_type || '')}">
    </div>`;

  const html = `
    <div class="mgmt-modal-backdrop">
      <div class="mgmt-modal">
        <div class="mgmt-modal-header">
          <div class="mgmt-modal-title">${isEdit ? 'Edit' : 'Add'} ${isCarry ? 'Item' : 'Crop Type'} — ${esc(row.name)}</div>
          <button class="mgmt-modal-close">✕</button>
        </div>
        <div class="mgmt-modal-body">
          ${cropTypeInput}
          ${isCarry ? `
          <div class="mgmt-form-row">
            <div class="mgmt-form-group">
              <label>Units (${row.unit})</label>
              <input id="ct-units" type="number" step="0.1" class="mgmt-input"
                value="${ct?.budget_units || ''}" placeholder="e.g. 1250">
            </div>
            <div class="mgmt-form-group">
              <label>Price ($/unit) <span style="color:var(--hint);font-size:10px">leave blank to use commodity price ${row.budget_price ? '($'+fC(row.budget_price,2)+')' : ''}</span></label>
              <input id="ct-price" type="number" step="0.01" class="mgmt-input"
                value="${ct?.price_override || ''}" placeholder="${row.budget_price || 'e.g. 320.00'}">
            </div>
          </div>
          <div class="mgmt-form-group">
            <label>Expected month</label>
            <select id="ct-month" class="mgmt-input">
              <option value="">— Select —</option>
              ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m,i) =>
                `<option value="${i+1}" ${ct?.expected_month===i+1?'selected':''}>${m}</option>`).join('')}
            </select>
          </div>` : `
          <div class="mgmt-form-row">
            <div class="mgmt-form-group">
              <label>Area (ha)</label>
              <input id="ct-area" type="number" step="0.1" class="mgmt-input"
                value="${ct?.area_ha || ''}" placeholder="e.g. 450">
            </div>
            <div class="mgmt-form-group">
              <label>Yield (${row.unit}/ha)</label>
              <input id="ct-yield" type="number" step="0.01" class="mgmt-input"
                value="${ct?.budget_yield || ''}" placeholder="e.g. 10.5">
            </div>
          </div>
          <div class="mgmt-form-group">
            <label>Production override (${row.unit}) <span style="color:var(--hint);font-size:10px">leave blank to calculate from area × yield</span></label>
            <input id="ct-prod" type="number" step="1" class="mgmt-input"
              value="${ct?.budget_production || ''}" placeholder="calculated automatically">
          </div>`}
          <div class="mgmt-form-group">
            <label>Notes (optional)</label>
            <input id="ct-notes" type="text" class="mgmt-input" value="${esc(ct?.notes || '')}">
          </div>
        </div>
        <div class="mgmt-modal-footer">
          <button class="mgmt-btn mgmt-btn--ghost" id="ct-cancel">Cancel</button>
          <button class="mgmt-btn mgmt-btn--primary" id="ct-save">${isEdit ? 'Save changes' : 'Add'}</button>
        </div>
      </div>
    </div>`;

  _modal?.remove();
  _modal = document.createElement('div');
  _modal.innerHTML = html;
  document.body.appendChild(_modal);

  _modal.querySelector('#ct-cancel').onclick = () => { _modal?.remove(); _modal = null; };
  _modal.querySelector('.mgmt-modal-close').onclick = () => { _modal?.remove(); _modal = null; };

  // Wire crop type select → show text input for "new"
  const ctSel = _modal.querySelector('#ct-name-sel');
  const ctInput = _modal.querySelector('#ct-name');
  if (ctSel && ctInput) {
    ctSel.addEventListener('change', () => {
      if (ctSel.value === '__new__') {
        ctInput.style.display = 'block';
        ctInput.focus();
        ctSel.value = '';
      } else {
        ctInput.style.display = 'none';
        ctInput.value = '';
      }
    });
  }

  _modal.querySelector('#ct-save').onclick = async () => {
    // Resolve name from select or text input
    let name;
    if (ctSel) {
      name = ctSel.value === '__new__' || !ctSel.value
        ? ctInput?.value.trim()
        : ctSel.value;
    } else {
      name = ctInput?.value.trim();
    }
    if (!name) { toast('Enter a name', 'warning'); return; }

    const payload = isCarry ? {
      income_id:    row.id,
      farm_id:      farm.id,
      season,
      crop_type:    name,
      budget_units: parseFloat(_modal.querySelector('#ct-units')?.value) || null,
      price_override: parseFloat(_modal.querySelector('#ct-price')?.value) || null,
      expected_month: parseInt(_modal.querySelector('#ct-month')?.value) || null,
      notes:        _modal.querySelector('#ct-notes').value.trim() || null,
    } : {
      income_id:    row.id,
      farm_id:      farm.id,
      season,
      crop_type:    name,
      area_ha:      parseFloat(_modal.querySelector('#ct-area')?.value) || null,
      budget_yield: parseFloat(_modal.querySelector('#ct-yield')?.value) || null,
      budget_production: parseFloat(_modal.querySelector('#ct-prod')?.value) || null,
      notes:        _modal.querySelector('#ct-notes').value.trim() || null,
    };

    try {
      if (isEdit) {
        await dbUpdate('mgmt_crop_types', ct.id, { ...payload, updated_at: new Date().toISOString() });
      } else {
        await dbInsert('mgmt_crop_types', payload);
      }
      toast('Saved', 'success');
      _modal?.remove(); _modal = null;
    } catch(e) {
      console.error(e);
      toast('Save failed', 'error');
    }
  };
}

// ── CSS ───────────────────────────────────────────────────────────────────────
function _css() {
  return `<style>
    :root {
      --mgmt-navy:     #1e3a5f;
      --mgmt-green:    #0a7c4e;
      --mgmt-amber:    #a05c00;
      --mgmt-red:      #c0392b;
      --mgmt-blue:     #1a5fb4;
      --mgmt-row-alt:  rgba(0,0,0,.04);
      --mgmt-unpriced: rgba(0,0,0,.08);
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
        --mgmt-row-alt:  rgba(255,255,255,.06);
        --mgmt-unpriced: rgba(255,255,255,.12);
      }
    }
    :root[data-theme="dark"] {
      --mgmt-row-alt:  rgba(255,255,255,.06);
      --mgmt-unpriced: rgba(255,255,255,.12);
    }

    /* Layout */
    #mgmt-wrap { display: flex; flex-direction: column; min-height: 100%; }
    .mgmt-loading { padding: 60px; text-align: center; color: var(--hint); }

    /* Top bar */
    .mgmt-topbar {
      background: var(--mgmt-navy);
      padding: 14px 24px;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px;
    }
    .mgmt-topbar-title { color: white; font-size: 15px; font-weight: 700; }
    .mgmt-topbar-sub   { color: rgba(255,255,255,.65); font-size: 12px; margin-top: 2px; }
    .mgmt-topbar-meta  { display: flex; align-items: center; gap: 12px; }
    .mgmt-topbar-asof  { color: rgba(255,255,255,.6); font-size: 11px; }

    /* KPI strip */
    .mgmt-kpi-strip {
      background: var(--mgmt-navy);
      padding: 0 24px 16px;
      display: flex; gap: 10px; flex-wrap: wrap;
    }
    .mgmt-kpi {
      flex: 1; min-width: 150px;
      background: rgba(255,255,255,.08);
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .mgmt-kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: rgba(255,255,255,.55); margin-bottom: 4px; }
    .mgmt-kpi-value { font-size: 22px; font-weight: 700; }

    /* Body */
    .mgmt-body { padding: 20px 24px; display: flex; flex-direction: column; gap: 24px; box-sizing: border-box; }

    /* Section */
    .mgmt-section { display: flex; flex-direction: column; gap: 12px; }
    .mgmt-section-header { display: flex; align-items: center; justify-content: space-between; }
    .mgmt-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--hint); font-weight: 700; }
    .mgmt-below-line { background: var(--mgmt-amber); color: white; border-radius: 4px; padding: 1px 6px; font-size: 9px; letter-spacing: .05em; margin-left: 6px; }
    .mgmt-carryover-note { font-size: 11px; color: var(--hint); padding: 4px 0 0; }
    .mgmt-section--carryover .mgmt-section-label { color: var(--mgmt-amber); }

    /* Card */
    .mgmt-card {
      background: white;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    }
    .mgmt-card--carryover { border-color: #f0d080; background: #fffdf5; }
    .mgmt-card-header {
      display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px;
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--border);
    }
    .mgmt-card--collapsed .mgmt-card-header { border-bottom: none; }
    .mgmt-collapse-btn {
      background: none; border: 1px solid var(--border); border-radius: 4px;
      color: var(--hint); font-size: 10px; cursor: pointer;
      padding: 2px 7px; line-height: 1.6; flex-shrink: 0;
      transition: background .15s;
    }
    .mgmt-collapse-btn:hover { background: var(--mgmt-row-alt); color: var(--mgmt-navy); }
    .mgmt-card-title { font-size: 15px; font-weight: 700; color: var(--mgmt-navy); }
    .mgmt-card-sub   { font-size: 11px; color: var(--hint); margin-top: 3px; }

    /* Badges */
    .mgmt-badge {
      display: inline-flex; align-items: center;
      padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 600;
    }
    .mgmt-badge-budget   { background: #e3f2fd; color: var(--mgmt-blue);  border: 1px solid #90caf9; }
    .mgmt-badge-actual   { background: #e8f5e9; color: var(--mgmt-green); border: 1px solid #a5d6a7; }
    .mgmt-badge-carryover { background: #fff8e1; color: var(--mgmt-amber); border: 1px solid #ffe082; }

    /* Tabs */
    .mgmt-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 18px; }
    .mgmt-tab {
      padding: 10px 14px; font-size: 12px; font-weight: 500; color: var(--hint);
      cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
    }
    .mgmt-tab:hover { color: var(--mgmt-navy); }
    .mgmt-tab.active { color: var(--mgmt-navy); border-bottom-color: var(--mgmt-navy); font-weight: 600; }
    .mgmt-tab-panel { padding: 0; }

    /* Tables */
    .mgmt-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .mgmt-table th {
      padding: 7px 12px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
      color: var(--hint); font-weight: 600; border-bottom: 2px solid var(--border);
      text-align: left;
    }
    .mgmt-table th.num { text-align: right; }
    .mgmt-table td {
      padding: 8px 12px; border-bottom: 1px solid var(--border-light);
      color: var(--ink);
    }
    .mgmt-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .mgmt-table td.actions { text-align: right; white-space: nowrap; }
    .mgmt-table tr:last-child td { border-bottom: none; }
    .mgmt-table-label { color: var(--hint) !important; padding-left: 20px !important; }
    .mgmt-table-group td { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--hint); font-weight: 700; background: var(--page-bg); padding: 6px 12px !important; }
    .mgmt-table-total td { font-weight: 700; border-top: 2px solid var(--border) !important; }

    /* Buttons */
    .mgmt-add-btn {
      background: var(--mgmt-navy); color: white;
      border: none; border-radius: 6px; padding: 6px 14px;
      font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .mgmt-add-btn:hover { opacity: .88; }
    .mgmt-add-btn--amber { background: var(--mgmt-amber); }
    .mgmt-add-btn--sm { background: var(--page-bg); color: var(--mgmt-navy); border: 1px solid var(--border); font-size: 11px; padding: 5px 12px; }
    .mgmt-add-btn--sm:hover { background: var(--border-light); }
    .mgmt-add-btn--sm.mgmt-add-btn--amber { background: #fff8e1; color: var(--mgmt-amber); border-color: #ffe082; }

    .mgmt-icon-btn {
      background: #fff; border: 1px solid #c8d0da; border-radius: 5px;
      padding: 3px 9px; font-size: 12px; cursor: pointer; color: #555e6d;
      font-weight: 500; line-height: 1.4; white-space: nowrap; display: inline-flex;
      align-items: center;
    }
    .mgmt-icon-btn:hover { background: #eef1f5; border-color: #a8b4c0; color: #2c3e50; }
    .mgmt-icon-btn--red { color: #c0392b; border-color: #e8b4b8; background: #fff5f5; }
    .mgmt-icon-btn--red:hover { background: #fce4ec; border-color: #c0392b; }

    .mgmt-row-btn {
      background: none; border: none; font-size: 11px; cursor: pointer;
      color: var(--mgmt-blue); padding: 2px 6px;
    }
    .mgmt-row-btn:hover { text-decoration: underline; }
    .mgmt-row-btn--red { color: var(--mgmt-red); }

    /* Empty state */
    .mgmt-empty {
      background: var(--page-bg); border: 1px dashed var(--border);
      border-radius: 10px; padding: 28px; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 10px;
    }
    .mgmt-empty-msg { font-size: 12px; color: var(--hint); }

    /* Modal */
    .mgmt-modal-backdrop {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center;
      padding: 16px;
    }
    .mgmt-modal {
      background: white; border-radius: 12px; width: 100%; max-width: 480px;
      box-shadow: 0 20px 60px rgba(0,0,0,.25);
      display: flex; flex-direction: column; max-height: 90vh;
    }
    .mgmt-modal-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 20px; border-bottom: 1px solid var(--border);
    }
    .mgmt-modal-title { font-size: 14px; font-weight: 700; color: var(--mgmt-navy); }
    .mgmt-modal-close { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--hint); padding: 4px 8px; }
    .mgmt-modal-body { padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px; }
    .mgmt-modal-footer { padding: 14px 20px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }

    .mgmt-form-group { display: flex; flex-direction: column; gap: 5px; }
    .mgmt-form-group label { font-size: 11px; font-weight: 600; color: var(--hint); text-transform: uppercase; letter-spacing: .05em; }
    .mgmt-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .mgmt-input {
      border: 1px solid var(--border); border-radius: 6px;
      padding: 7px 10px; font-size: 13px; color: var(--ink);
      background: white; width: 100%; box-sizing: border-box;
    }
    .mgmt-input:focus { outline: 2px solid var(--mgmt-navy); border-color: transparent; }

    .mgmt-btn {
      border-radius: 6px; padding: 7px 18px; font-size: 13px; font-weight: 600; cursor: pointer; border: none;
    }
    .mgmt-btn--primary { background: var(--mgmt-navy); color: white; }
    .mgmt-btn--primary:hover { opacity: .88; }
    .mgmt-btn--ghost { background: none; color: var(--hint); border: 1px solid var(--border); }
    .mgmt-btn--ghost:hover { background: var(--border-light); }

    /* Group card (e.g. Cotton = Lint + Seed) */
    .mgmt-card--group { border-color: #c5d8f0; }
    .mgmt-card--group .mgmt-card-header { background: #f0f6ff; }
    .mgmt-card-group-members {
      font-size: 11px; color: var(--hint); margin-left: 8px;
      font-weight: 400;
    }
    .mgmt-header-kpis { display: flex; gap: 20px; align-items: flex-end; }
    .mgmt-hkpi { text-align: right; }
    .mgmt-hkpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--hint); }
    .mgmt-hkpi-val { font-size: 14px; font-weight: 700; color: var(--mgmt-navy); margin-top: 2px; }
    .mgmt-group-members { display: flex; flex-direction: column; }
    .mgmt-group-member { border-top: 1px solid var(--border); }
    .mgmt-group-member-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
      color: var(--mgmt-blue); font-weight: 700;
      padding: 8px 18px 0;
    }
    /* Strip the outer card border/radius from nested farming cards inside a group */
    .mgmt-group-member .mgmt-card {
      border: none; border-radius: 0; box-shadow: none;
    }

    /* YTD month selector in topbar */
    .mgmt-ytd-label {
      color: rgba(255,255,255,.65); font-size: 11px;
    }
    .mgmt-ytd-sel {
      background: rgba(255,255,255,.15); color: white;
      border: 1px solid rgba(255,255,255,.25); border-radius: 6px;
      padding: 4px 8px; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .mgmt-ytd-sel option { background: #1e3a5f; color: white; }

    /* YTD status chip on card headers */
    .mgmt-ytd-chip {
      display: inline-flex; align-items: center;
      padding: 3px 9px; border-radius: 20px;
      font-size: 11px; font-weight: 700;
      background: rgba(0,0,0,.08); color: var(--hint);
      border: 1px solid var(--border); cursor: default;
    }
    .mgmt-ytd-chip.on-track  { background: #d4edda; color: #155724; border-color: #a5d6a7; }
    .mgmt-ytd-chip.behind    { background: #fff3cd; color: #856404; border-color: #ffc107; }
    .mgmt-ytd-chip.at-risk   { background: #f8d7da; color: #842029; border-color: #f5c6cb; }
    .mgmt-ytd-chip.no-schedule { background: rgba(0,0,0,.06); color: var(--hint); border-color: var(--border); }

    /* YTD panel */
    .mgmt-ytd-panel { padding: 14px 18px; }
    .mgmt-ytd-loading { color: var(--hint); font-size: 12px; padding: 20px; text-align: center; }
    .mgmt-ytd-kpis {
      display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px;
    }
    .mgmt-ytd-kpi {
      flex: 1; min-width: 120px;
      background: var(--mgmt-row-alt); border: 1px solid var(--border);
      border-radius: 8px; padding: 10px 12px;
    }
    .mgmt-ytd-kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: var(--hint); margin-bottom: 3px; }
    .mgmt-ytd-kpi-val   { font-size: 16px; font-weight: 700; }
    .mgmt-ytd-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
    .mgmt-ytd-table th {
      padding: 6px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
      color: var(--hint); font-weight: 600; border-bottom: 2px solid var(--border); text-align: left;
    }
    .mgmt-ytd-table th.num { text-align: right; }
    .mgmt-ytd-table td { padding: 7px 10px; border-bottom: 1px solid var(--border-light); }
    .mgmt-ytd-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .mgmt-ytd-table tr.future td { opacity: .45; font-style: italic; }
    .mgmt-ytd-table tr.current td { font-weight: 600; }
    .mgmt-ytd-no-sched {
      background: var(--mgmt-row-alt); border: 1px dashed var(--border);
      border-radius: 8px; padding: 14px 16px; font-size: 12px; color: var(--hint);
      margin-bottom: 10px;
    }

    @media (max-width: 600px) {
      .mgmt-body { padding: 14px 14px; }
      .mgmt-form-row { grid-template-columns: 1fr; }
      .mgmt-header-kpis { gap: 10px; }
    }
  </style>`;
}
