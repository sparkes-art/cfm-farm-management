// modules/management-report/management-report.js
// Management Report — Mockup 2b card-based design
// Commodity cards with Economics / Sales Pipeline / Crop Types tabs
// Live data from invoices, forward_contracts, budgets, budget_costs

import { dbSelect, dbInsert, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js';
import { formatCurrency, formatNumber, formatDate, qs, toast } from '../../js/ui.js';

// ── Module state ──────────────────────────────────────────────────────────────
let _sub = null;   // realtime subscription
let _activeTabs = {};  // commodity key → active tab ('economics'|'pipeline'|'croptypes')

export function unmountManagementReport() {
  if (_sub) { try { _sub.unsubscribe(); } catch(e) {} _sub = null; }
  _activeTabs = {};
}

export async function mountManagementReport(container) {
  container.innerHTML = `<div id="mgmt-wrap"><div class="mgmt-loading">Loading…</div></div>`;
  await _render(container);

  // Realtime: re-render when invoices or contracts change
  _sub = subscribeTable('invoices', farm.id, () => _render(container));
}

// ── Main render ───────────────────────────────────────────────────────────────
async function _render(container) {
  const farm   = getActiveFarm();
  const season = getActiveSeason();
  if (!farm || !season) {
    container.innerHTML = `<div class="mgmt-loading">Select a farm and season to view the report.</div>`;
    return;
  }

  // ── Data fetch ──────────────────────────────────────────────────────────────
  const [contracts, allInvoices, budgets, budgetCosts] = await Promise.all([
    dbSelect('forward_contracts', `farm_id=eq.${farm.id}&crop_year=eq.${season}&select=*`).catch(() => []),
    dbSelect('invoices', `farm_id=eq.${farm.id}&select=*&order=invoice_date.asc`).catch(() => []),
    dbSelect('budgets', `farm_id=eq.${farm.id}&season=eq.${season}&select=*`).catch(() => []),
    dbSelect('budget_costs', `farm_id=eq.${farm.id}&financial_year=eq.${season}&select=*`).catch(() => []),
  ]);

  // ── Season timing ───────────────────────────────────────────────────────────
  const seasonYear        = parseInt(season.split('-')[0]);
  const now               = new Date();
  const yearStartMonth    = farm.settings?.yearStartMonth || 7;
  const seasonStartMonthIdx = yearStartMonth - 1;
  let monthsElapsed = (now.getFullYear() - seasonYear) * 12 + (now.getMonth() - seasonStartMonthIdx);
  if (monthsElapsed < 0)  monthsElapsed = 0;
  if (monthsElapsed > 12) monthsElapsed = 12;
  const ytdMonths   = Math.min(monthsElapsed + 1, 12);
  const ytdFraction = ytdMonths / 12;

  // ── Invoice helpers ─────────────────────────────────────────────────────────
  const isPriorYear = inv => {
    if (!inv.batches) return false;
    const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
    return b.some(batch => batch.prior_year_income);
  };

  const seasonInvoices = allInvoices.filter(inv => {
    if (isPriorYear(inv)) return false;
    if (inv.season === season) return true;
    if (inv.batches) {
      const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
      if (b.some(batch => batch.crop_year === season)) return true;
    }
    const linked = contracts.find(c => c.id === inv.forward_contract_id);
    if (linked?.crop_year === season) return true;
    return false;
  });

  const priorYearInvoices = allInvoices.filter(isPriorYear);

  // Get invoice totals for a commodity
  const invTotals = (invList, commName) => {
    let qty = 0, income = 0, qa = 0;
    const matched = [];
    const targetKey = commName ? commName.trim().toUpperCase() : null;
    invList.forEach(inv => {
      const linked  = contracts.find(c => c.id === inv.forward_contract_id);
      const batchComm = (() => {
        if (!inv.batches) return '';
        const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        return b.flatMap(x => x.lines||[]).find(l => l.type==='income' && l.description)?.description || '';
      })();
      const iComm    = linked?.commodity || batchComm || (inv.line_items||[])[0]?.commodity || '';
      const iCommKey = iComm.trim().toUpperCase();
      if (targetKey) {
        const invIsLs = /cattle|livestock/i.test(iComm);
        const tgtIsLs = /cattle|livestock/i.test(targetKey);
        if (tgtIsLs && invIsLs) { /* match */ }
        else if (iCommKey !== targetKey) return;
      }
      matched.push(inv);
      if (inv.batches) {
        const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        qty += b.filter(x => (x.lines||[]).some(l => l.type==='income' && l.line_type!=='qa'))
                .reduce((s, x) => s + (parseFloat(x.qty)||0), 0);
      } else {
        qty += parseFloat(inv.total_qty) || 0;
      }
      income += parseFloat(inv.gross_amount) || 0;
      qa     += parseFloat(inv.total_quality_adj) || 0;
    });
    const totalIncome = income + qa;
    return { qty, income, qa, totalIncome, avgPrice: qty ? totalIncome/qty : null, invoices: matched };
  };

  // ── Build commodity groups from budgets ─────────────────────────────────────
  const groups = {};
  budgets.forEach(b => {
    if (!b.commodity) return;
    const key = b.commodity.trim().toUpperCase();
    if (!groups[key]) groups[key] = { name: b.commodity.trim(), budgets: [] };
    groups[key].budgets.push(b);
  });

  // Add groups from actual invoices that have no budget row
  seasonInvoices.forEach(inv => {
    const linked = contracts.find(c => c.id === inv.forward_contract_id);
    const batchComm = (() => {
      if (!inv.batches) return '';
      const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
      return b.flatMap(x => x.lines||[]).find(l => l.type==='income' && l.description)?.description || '';
    })();
    const commName = linked?.commodity || batchComm || (inv.line_items||[])[0]?.commodity || '';
    if (!commName) return;
    const key = commName.trim().toUpperCase();
    if (!groups[key]) groups[key] = { name: commName.trim(), budgets: [] };
  });

  const bField = (b, plain, prefixed) => parseFloat(b[prefixed] ?? b[plain]) || 0;

  const budgetForGroup = g => {
    if (!g.budgets.length) return { bIncome: null, bYield: null, bPrice: null, bProd: null, bArea: null };
    const bArea  = g.budgets.reduce((s, b) => s + (parseFloat(b.area_ha)||0), 0);
    const bYield = bArea
      ? g.budgets.reduce((s, b) => s + bField(b,'yield_per_ha','budgeted_yield_per_ha') * (parseFloat(b.area_ha)||0), 0) / bArea
      : 0;
    const bProd  = bArea && bYield ? Math.round(bArea * bYield) : g.budgets.reduce((s,b) => s + (parseFloat(b.budgeted_production)||0), 0) || null;
    const bPrice = g.budgets.reduce((s, b) => s + bField(b,'price','budgeted_price'), 0) / g.budgets.length;
    const bIncome = (bProd && bPrice) ? bProd * bPrice
      : g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue)||0), 0) || null;
    return { bIncome, bYield, bPrice, bProd, bArea };
  };

  // Contracted but not yet invoiced: forward contracts with unfilled qty
  const getContracted = (commName) => {
    const targetKey = commName.trim().toUpperCase();
    const commContracts = contracts.filter(c => c.commodity?.toUpperCase() === targetKey);
    let contractedQty = 0, contractedValue = 0;
    commContracts.forEach(c => {
      const contracted = parseFloat(c.tonnes_contracted) || parseFloat(c.quantity) || 0;
      const invoiced   = parseFloat(c.tonnes_invoiced) || 0;
      const remaining  = Math.max(0, contracted - invoiced);
      const price      = parseFloat(c.price_per_tonne) || parseFloat(c.price) || 0;
      contractedQty   += remaining;
      contractedValue += remaining * price;
    });
    return { qty: contractedQty, value: contractedValue };
  };

  // ── Totals for KPI strip ────────────────────────────────────────────────────
  const sortedGroups  = Object.values(groups).sort((a,b) => a.name.localeCompare(b.name));
  const isCattle      = n => /cattle|livestock/i.test(n);
  const isCarryOver   = n => priorYearInvoices.some(inv => {
    const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches || '[]') : (inv.batches || []);
    return b.flatMap(x => x.lines||[]).find(l => l.type==='income' && l.description?.toUpperCase() === n.toUpperCase());
  });

  const farmGroups = sortedGroups.filter(g => !isCattle(g.name));
  const lsGroups   = sortedGroups.filter(g => isCattle(g.name));

  let totalRevenueYTD = 0, totalBudget = 0, totalContracted = 0;
  sortedGroups.forEach(g => {
    const inv = invTotals(seasonInvoices, g.name);
    const { bIncome } = budgetForGroup(g);
    const contracted = getContracted(g.name);
    totalRevenueYTD  += inv.totalIncome;
    totalBudget      += bIncome || 0;
    totalContracted  += contracted.value;
  });

  // Cost totals from budget
  const totalCostsBudget = budgetCosts.reduce((s, c) => s + (parseFloat(c.budget_amount)||0), 0);
  const forecastGM       = totalBudget - totalCostsBudget;
  const revenueStillToCome = Math.max(0, totalBudget - totalRevenueYTD - totalContracted);

  // ── Formatting helpers ──────────────────────────────────────────────────────
  const fC  = (n, dp=0) => n != null ? formatCurrency(n, dp) : '—';
  const fN  = (n, dp=0) => n != null && !isNaN(n) ? formatNumber(n, dp) : '—';
  const pct = (a, b) => (b && b !== 0) ? Math.round((a - b) / Math.abs(b) * 100) : null;
  const delta = (actual, budget, higherIsBetter = true) => {
    if (budget == null || actual == null) return '';
    const v = actual - budget;
    const p = pct(actual, budget);
    const good = higherIsBetter ? v >= 0 : v <= 0;
    const color = good ? 'var(--mgmt-green)' : 'var(--mgmt-red)';
    const sign  = v >= 0 ? '+' : '';
    return `<span class="mgmt-delta" style="color:${color}">${sign}${fC(v)}${p != null ? ` (${p >= 0 ? '+' : ''}${p}%)` : ''}</span>`;
  };

  // ── Build HTML ──────────────────────────────────────────────────────────────
  const kpiStrip = _buildKpiStrip({ totalRevenueYTD, revenueStillToCome, totalBudget, totalCostsBudget, forecastGM });
  const commodityCards = farmGroups.map(g => _buildCommodityCard(g, seasonInvoices, contracts, budgetForGroup, invTotals, getContracted, fC, fN, delta)).join('');
  const lsCards  = lsGroups.map(g => _buildCommodityCard(g, seasonInvoices, contracts, budgetForGroup, invTotals, getContracted, fC, fN, delta, true)).join('');
  const carryCard = _buildCarryoverCard(priorYearInvoices, invTotals, fC, fN);

  const wrap = qs('#mgmt-wrap', container) || container;
  wrap.innerHTML = `
    <style>
      :root {
        --mgmt-navy:  #1e3a5f;
        --mgmt-green: #0a7c4e;
        --mgmt-amber: #a05c00;
        --mgmt-red:   #c0392b;
        --mgmt-blue:  #1a5fb4;
        --mgmt-teal:  #0e7490;
      }

      .mgmt-loading { padding: 60px; text-align: center; color: var(--hint); }

      /* ── Top bar ── */
      .mgmt-topbar {
        background: var(--mgmt-navy);
        padding: 14px 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 10px;
      }
      .mgmt-topbar-title { color: white; font-size: 15px; font-weight: 700; }
      .mgmt-topbar-sub   { color: rgba(255,255,255,.65); font-size: 12px; margin-top: 2px; }
      .mgmt-topbar-meta  { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
      .mgmt-topbar-asof  { color: rgba(255,255,255,.7); font-size: 11px; }
      .mgmt-topbar-btn   {
        background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.2);
        color: white; border-radius: 6px; padding: 5px 12px; font-size: 11px; cursor: pointer;
      }
      .mgmt-topbar-btn:hover { background: rgba(255,255,255,.2); }

      /* ── KPI strip ── */
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
      .mgmt-kpi-label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: rgba(255,255,255,.6); margin-bottom: 4px; }
      .mgmt-kpi-value { font-size: 22px; font-weight: 700; color: white; }
      .mgmt-kpi-delta { font-size: 11px; margin-top: 3px; }
      .mgmt-delta     { font-weight: 600; font-size: 11px; }

      /* ── Body ── */
      .mgmt-body { padding: 20px 24px; max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }

      /* ── Section header ── */
      .mgmt-section-label {
        font-size: 10px; text-transform: uppercase; letter-spacing: .1em;
        color: var(--hint); font-weight: 600; margin-bottom: 8px; padding-left: 2px;
      }

      /* ── Commodity card ── */
      .mgmt-card {
        background: white;
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
      }
      .mgmt-card-header {
        display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 10px;
        padding: 14px 18px 12px;
        border-bottom: 1px solid var(--border);
      }
      .mgmt-card-title { font-size: 15px; font-weight: 700; color: var(--mgmt-navy); }
      .mgmt-card-sub   { font-size: 11px; color: var(--hint); margin-top: 2px; }
      .mgmt-badges     { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .mgmt-badge {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 9px; border-radius: 20px; font-size: 11px; font-weight: 600;
        white-space: nowrap;
      }
      .mgmt-badge-unpriced { background: #fff3e0; color: var(--mgmt-amber); border: 1px solid #ffd180; }
      .mgmt-badge-invoiced { background: #e8f5e9; color: var(--mgmt-green); border: 1px solid #a5d6a7; }
      .mgmt-badge-contracted { background: #e3f2fd; color: var(--mgmt-blue); border: 1px solid #90caf9; }
      .mgmt-badge-breakeven { background: #fce4ec; color: var(--mgmt-red); border: 1px solid #f48fb1; }

      /* ── Tabs ── */
      .mgmt-tabs { display: flex; border-bottom: 1px solid var(--border); padding: 0 18px; }
      .mgmt-tab {
        padding: 10px 14px; font-size: 12px; font-weight: 500; color: var(--hint);
        cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
        transition: color .15s;
      }
      .mgmt-tab:hover  { color: var(--mgmt-navy); }
      .mgmt-tab.active { color: var(--mgmt-navy); border-bottom-color: var(--mgmt-navy); font-weight: 600; }

      .mgmt-tab-content { padding: 16px 18px; }

      /* ── Economics grid ── */
      .mgmt-econ-grid {
        display: grid; grid-template-columns: 1fr 1fr; gap: 0;
        border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
      }
      .mgmt-econ-col { }
      .mgmt-econ-col-header {
        background: var(--page-bg); padding: 7px 12px;
        font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
        color: var(--hint); font-weight: 600; border-bottom: 1px solid var(--border);
      }
      .mgmt-econ-row {
        display: grid; grid-template-columns: auto 1fr 1fr 1fr;
        border-bottom: 1px solid var(--border-light);
      }
      .mgmt-econ-row:last-child { border-bottom: none; }
      .mgmt-econ-row.group-header {
        background: var(--page-bg);
      }
      .mgmt-econ-cell {
        padding: 7px 10px; font-size: 12px; color: var(--ink);
      }
      .mgmt-econ-cell.label { color: var(--hint); font-size: 11px; }
      .mgmt-econ-cell.num   { text-align: right; font-variant-numeric: tabular-nums; }
      .mgmt-econ-cell.good  { color: var(--mgmt-green); font-weight: 600; }
      .mgmt-econ-cell.bad   { color: var(--mgmt-red); font-weight: 600; }
      .mgmt-econ-cell.head  {
        font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
        color: var(--hint); font-weight: 600; padding: 6px 10px; border-bottom: 1px solid var(--border);
      }
      .mgmt-econ-table {
        width: 100%; border-collapse: collapse;
      }
      .mgmt-econ-table th {
        padding: 6px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
        color: var(--hint); font-weight: 600; border-bottom: 2px solid var(--border);
        text-align: right;
      }
      .mgmt-econ-table th:first-child { text-align: left; }
      .mgmt-econ-table td {
        padding: 7px 10px; font-size: 12px; border-bottom: 1px solid var(--border-light);
        font-variant-numeric: tabular-nums; text-align: right; color: var(--ink);
      }
      .mgmt-econ-table td:first-child { text-align: left; color: var(--hint); font-size: 11px; }
      .mgmt-econ-table tr:last-child td { border-bottom: none; }
      .mgmt-econ-table tr.group-row td { font-weight: 700; background: var(--page-bg); font-size: 11px; color: var(--hint); text-transform: uppercase; letter-spacing: .06em; }
      .mgmt-econ-table tr.total-row td { font-weight: 700; border-top: 2px solid var(--border); }

      /* ── Pipeline ── */
      .mgmt-pipeline-bar { margin-bottom: 16px; }
      .mgmt-pipeline-track {
        height: 20px; border-radius: 10px; background: var(--border-light);
        overflow: hidden; display: flex;
      }
      .mgmt-pipeline-seg { height: 100%; transition: width .3s; }
      .mgmt-pipeline-legend { display: flex; gap: 16px; margin-top: 8px; flex-wrap: wrap; }
      .mgmt-pipeline-legend-item { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--hint); }
      .mgmt-pipeline-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

      .mgmt-pipeline-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
      .mgmt-pipeline-table th {
        padding: 6px 10px; font-size: 10px; text-transform: uppercase; letter-spacing: .07em;
        color: var(--hint); font-weight: 600; border-bottom: 2px solid var(--border);
        text-align: right;
      }
      .mgmt-pipeline-table th:first-child { text-align: left; }
      .mgmt-pipeline-table td {
        padding: 8px 10px; font-size: 12px; border-bottom: 1px solid var(--border-light);
        font-variant-numeric: tabular-nums; text-align: right;
      }
      .mgmt-pipeline-table td:first-child { text-align: left; font-weight: 500; }
      .mgmt-pipeline-table tr:last-child td { border-bottom: none; font-weight: 700; }

      /* ── Carryover card ── */
      .mgmt-carryover-card {
        background: #fffbf2;
        border: 1px solid #f0d080;
        border-radius: 10px;
        overflow: hidden;
      }
      .mgmt-carryover-header {
        background: #fef3c7; border-bottom: 1px solid #f0d080;
        padding: 12px 18px;
        display: flex; align-items: center; gap: 10px;
      }
      .mgmt-carryover-title { font-size: 13px; font-weight: 700; color: var(--mgmt-amber); }
      .mgmt-carryover-sub   { font-size: 11px; color: #92400e; margin-top: 1px; }

      /* ── Recon footer ── */
      .mgmt-recon {
        background: var(--mgmt-navy);
        border-radius: 10px;
        padding: 16px 20px;
        display: flex; gap: 16px; flex-wrap: wrap; align-items: center;
      }
      .mgmt-recon-item { flex: 1; min-width: 140px; }
      .mgmt-recon-label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; color: rgba(255,255,255,.55); margin-bottom: 3px; }
      .mgmt-recon-value { font-size: 18px; font-weight: 700; color: white; }
      .mgmt-recon-op { color: rgba(255,255,255,.4); font-size: 20px; padding-top: 14px; flex: none; }
      .mgmt-recon-equals { font-size: 24px; color: rgba(255,255,255,.4); padding-top: 10px; flex: none; }
    </style>

    <!-- Top bar -->
    <div class="mgmt-topbar">
      <div>
        <div class="mgmt-topbar-title">${esc(farm.name)} — Management Report</div>
        <div class="mgmt-topbar-sub">Season ${season}</div>
      </div>
      <div class="mgmt-topbar-meta">
        <span class="mgmt-topbar-asof">As at ${now.toLocaleDateString('en-AU',{day:'numeric',month:'long',year:'numeric'})}</span>
        ${canWrite() ? `<button class="mgmt-topbar-btn" id="mgmt-add-note">+ Note</button>` : ''}
      </div>
    </div>

    <!-- KPI strip -->
    ${kpiStrip}

    <!-- Body -->
    <div class="mgmt-body">

      ${farmGroups.length ? `
        <div>
          <div class="mgmt-section-label">Cropping Income</div>
          ${commodityCards}
        </div>
      ` : ''}

      ${lsGroups.length ? `
        <div>
          <div class="mgmt-section-label">Livestock Income</div>
          ${lsCards}
        </div>
      ` : ''}

      ${carryCard ? `
        <div>
          <div class="mgmt-section-label">Carryover Grain</div>
          ${carryCard}
        </div>
      ` : ''}

      ${!farmGroups.length && !lsGroups.length ? `
        <div style="padding:40px;text-align:center;color:var(--hint)">
          <div style="font-size:40px;margin-bottom:12px">📋</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:6px">No data yet for ${season}</div>
          <div style="font-size:12px">Add budgets in the Budgeting module or enter invoices in Outputs to populate this report.</div>
        </div>
      ` : ''}

      <!-- Reconciliation footer -->
      <div class="mgmt-recon">
        <div class="mgmt-recon-item">
          <div class="mgmt-recon-label">Season GM (forecast)</div>
          <div class="mgmt-recon-value">${fC(forecastGM)}</div>
        </div>
        <div class="mgmt-recon-op">+</div>
        <div class="mgmt-recon-item">
          <div class="mgmt-recon-label">Carryover receipts</div>
          <div class="mgmt-recon-value">${fC(priorYearInvoices.reduce((s,i) => s + (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0), 0))}</div>
        </div>
        <div class="mgmt-recon-equals">=</div>
        <div class="mgmt-recon-item">
          <div class="mgmt-recon-label">Xero Cash Receipts (est.)</div>
          <div class="mgmt-recon-value">${fC(totalRevenueYTD)}</div>
        </div>
        <div style="flex:none;padding-top:12px">
          <span style="font-size:10px;color:rgba(255,255,255,.4)">Reconcile in Xero →</span>
        </div>
      </div>

    </div>
  `;

  // ── Wire up tab clicks ──────────────────────────────────────────────────────
  wrap.querySelectorAll('.mgmt-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const card   = tab.closest('.mgmt-card, .mgmt-carryover-card');
      const tabKey = tab.dataset.tab;
      const commKey = tab.dataset.comm;
      // Update active tab
      card.querySelectorAll('.mgmt-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      // Show/hide panels
      card.querySelectorAll('.mgmt-tab-content').forEach(panel => {
        panel.hidden = panel.dataset.tab !== tabKey;
      });
      if (commKey) _activeTabs[commKey] = tabKey;
    });
  });

  // ── Note button ────────────────────────────────────────────────────────────
  qs('#mgmt-add-note', wrap)?.addEventListener('click', async () => {
    const text = prompt('Add a season note:');
    if (!text?.trim()) return;
    const session = getSession();
    try {
      await dbInsert('management_comments', {
        farm_id: farm.id, season,
        comment: text.trim(),
        created_by: session?.user?.id,
      });
      toast('Note saved', 'success');
    } catch(e) {
      toast('Could not save note', 'error');
    }
  });
}

// ── KPI strip ─────────────────────────────────────────────────────────────────
function _buildKpiStrip({ totalRevenueYTD, revenueStillToCome, totalBudget, totalCostsBudget, forecastGM }) {
  const fC = (n) => n != null ? formatCurrency(n, 0) : '—';
  const tiles = [
    { label: 'Revenue YTD (actual)',    value: fC(totalRevenueYTD),     delta: null, color: 'white' },
    { label: 'Revenue still to come',   value: fC(revenueStillToCome),  delta: null, color: '#93c5fd' },
    { label: 'Forecast season revenue', value: fC(totalBudget),         delta: null, color: '#86efac' },
    { label: 'Total costs (budget)',     value: fC(totalCostsBudget),    delta: null, color: '#fca5a5' },
    { label: 'Forecast season GM',      value: fC(forecastGM),          delta: null,
      color: forecastGM >= 0 ? '#86efac' : '#fca5a5' },
  ];
  return `
    <div class="mgmt-kpi-strip">
      ${tiles.map(t => `
        <div class="mgmt-kpi">
          <div class="mgmt-kpi-label">${t.label}</div>
          <div class="mgmt-kpi-value" style="color:${t.color}">${t.value}</div>
        </div>`).join('')}
    </div>`;
}

// ── Commodity card ─────────────────────────────────────────────────────────────
function _buildCommodityCard(g, seasonInvoices, contracts, budgetForGroup, invTotals, getContracted, fC, fN, delta, isLivestock = false) {
  const commKey = g.name.toUpperCase().replace(/\s+/g, '_');
  const inv     = invTotals(seasonInvoices, g.name);
  const { bIncome, bYield, bPrice, bProd, bArea } = budgetForGroup(g);
  const contracted = getContracted(g.name);
  const unit = g.budgets[0]?.unit || contracts.find(c => c.commodity?.toUpperCase() === g.name.toUpperCase())?.unit || 't';

  // Production summary for header
  const area = bArea ? `${fN(bArea, 0)} ha` : '';
  const prod = bProd ? `${fN(bProd, 0)} ${unit}` : (inv.qty ? `${fN(inv.qty, 1)} ${unit} invoiced` : '');
  const headerSub = [area, prod].filter(Boolean).join(' · ');

  // Badges
  const unpriced = Math.max(0, (bProd || 0) - inv.qty - contracted.qty);
  const breakeven = bIncome && bArea && bYield ? (bIncome / bArea / bYield) : null;
  const badges = `
    ${inv.qty > 0  ? `<span class="mgmt-badge mgmt-badge-invoiced">✓ ${fN(inv.qty, 1)} ${unit} invoiced</span>` : ''}
    ${contracted.qty > 0 ? `<span class="mgmt-badge mgmt-badge-contracted">⚡ ${fN(contracted.qty, 1)} ${unit} contracted</span>` : ''}
    ${unpriced > 1 ? `<span class="mgmt-badge mgmt-badge-unpriced">? ${fN(unpriced, 0)} ${unit} unpriced</span>` : ''}
    ${breakeven ? `<span class="mgmt-badge mgmt-badge-breakeven">BE ${fC(breakeven)}/${unit}</span>` : ''}
  `;

  // Tabs
  const activeTab = _activeTabs[commKey] || 'economics';

  // ── Economics tab ──────────────────────────────────────────────────────────
  const econTab = (() => {
    const rows = [
      { group: 'Yield', metric: 'Area (ha)', actual: bArea ? fN(bArea) : '—', budget: bArea ? fN(bArea) : '—', var: '' },
      { group: 'Yield', metric: `Yield (${unit}/ha)`, actual: inv.qty && bArea ? fN(inv.qty/bArea, 2) : '—', budget: bYield ? fN(bYield, 2) : '—', var: inv.qty && bArea && bYield ? delta(inv.qty/bArea, bYield) : '' },
      { group: 'Yield', metric: `Total (${unit})`, actual: inv.qty ? fN(inv.qty, 1) : '—', budget: bProd ? fN(bProd) : '—', var: inv.qty && bProd ? delta(inv.qty, bProd) : '' },
      { group: 'Price', metric: `Avg price (/${unit})`, actual: inv.avgPrice ? fC(inv.avgPrice) : '—', budget: bPrice ? fC(bPrice) : '—', var: inv.avgPrice && bPrice ? delta(inv.avgPrice, bPrice) : '' },
      { group: 'Margin', metric: 'Gross revenue', actual: inv.totalIncome ? fC(inv.totalIncome) : '—', budget: bIncome ? fC(bIncome) : '—', var: inv.totalIncome && bIncome ? delta(inv.totalIncome, bIncome) : '' },
    ];

    let currentGroup = '';
    const tableRows = rows.map(r => {
      let groupRow = '';
      if (r.group !== currentGroup) {
        currentGroup = r.group;
        groupRow = `<tr class="group-row"><td colspan="4">${r.group}</td></tr>`;
      }
      return groupRow + `<tr>
        <td style="padding-left:20px">${r.metric}</td>
        <td>${r.actual}</td>
        <td>${r.budget}</td>
        <td>${r.var}</td>
      </tr>`;
    }).join('');

    return `
      <table class="mgmt-econ-table">
        <thead>
          <tr>
            <th style="text-align:left">Metric</th>
            <th>Actual</th>
            <th>Budget</th>
            <th>Variance</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>`;
  })();

  // ── Sales Pipeline tab ─────────────────────────────────────────────────────
  const pipelineTab = (() => {
    const totalBudget = bProd || 0;
    const invoicedQty  = inv.qty;
    const contractedQty = contracted.qty;
    const unpricedQty   = Math.max(0, totalBudget - invoicedQty - contractedQty);

    const pct = (n) => totalBudget > 0 ? Math.round(n / totalBudget * 100) : 0;
    const invPct  = pct(invoicedQty);
    const conPct  = pct(contractedQty);
    const unpPct  = Math.max(0, 100 - invPct - conPct);

    const bar = `
      <div class="mgmt-pipeline-bar">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--hint);margin-bottom:5px">
          <span>Sales position</span>
          <span>${invPct + conPct}% priced</span>
        </div>
        <div class="mgmt-pipeline-track">
          <div class="mgmt-pipeline-seg" style="background:var(--mgmt-green);width:${invPct}%"></div>
          <div class="mgmt-pipeline-seg" style="background:var(--mgmt-blue);width:${conPct}%"></div>
          <div class="mgmt-pipeline-seg" style="background:#e5e7eb;width:${unpPct}%"></div>
        </div>
        <div class="mgmt-pipeline-legend">
          <div class="mgmt-pipeline-legend-item"><div class="mgmt-pipeline-dot" style="background:var(--mgmt-green)"></div>Invoiced</div>
          <div class="mgmt-pipeline-legend-item"><div class="mgmt-pipeline-dot" style="background:var(--mgmt-blue)"></div>Contracted</div>
          <div class="mgmt-pipeline-legend-item"><div class="mgmt-pipeline-dot" style="background:#e5e7eb"></div>Unpriced</div>
        </div>
      </div>`;

    const rows = [
      { label: 'Invoiced',   qty: invoicedQty,   value: inv.totalIncome,  price: inv.avgPrice,        color: 'var(--mgmt-green)' },
      { label: 'Contracted', qty: contractedQty, value: contracted.value, price: contractedQty > 0 ? contracted.value / contractedQty : null, color: 'var(--mgmt-blue)' },
      { label: 'Unpriced',   qty: unpricedQty,   value: null,             price: null,                 color: 'var(--mgmt-amber)' },
      { label: 'Total budget', qty: totalBudget,  value: bIncome,          price: bPrice,               color: 'var(--ink)', bold: true },
    ];

    const table = `
      <table class="mgmt-pipeline-table">
        <thead><tr>
          <th style="text-align:left">Status</th>
          <th>${unit}</th>
          <th>Avg price</th>
          <th>Value</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `<tr ${r.bold ? 'style="font-weight:700;border-top:2px solid var(--border)"' : ''}>
            <td style="color:${r.color};font-weight:${r.bold ? 700 : 500}">${r.label}</td>
            <td>${r.qty > 0 ? fN(r.qty, 1) : '—'}</td>
            <td>${r.price ? fC(r.price) : '—'}</td>
            <td style="color:${r.value ? 'var(--mgmt-green)' : 'var(--hint)'}">${r.value ? fC(r.value) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    return bar + table;
  })();

  // ── Tabs HTML ──────────────────────────────────────────────────────────────
  return `
    <div class="mgmt-card">
      <div class="mgmt-card-header">
        <div>
          <div class="mgmt-card-title">${esc(g.name)}</div>
          ${headerSub ? `<div class="mgmt-card-sub">${headerSub}</div>` : ''}
        </div>
        <div class="mgmt-badges">${badges}</div>
      </div>
      <div class="mgmt-tabs">
        <div class="mgmt-tab ${activeTab === 'economics' ? 'active' : ''}" data-tab="economics" data-comm="${commKey}">Economics</div>
        <div class="mgmt-tab ${activeTab === 'pipeline'  ? 'active' : ''}" data-tab="pipeline"  data-comm="${commKey}">Sales Pipeline</div>
      </div>
      <div class="mgmt-tab-content" data-tab="economics" ${activeTab !== 'economics' ? 'hidden' : ''}>${econTab}</div>
      <div class="mgmt-tab-content" data-tab="pipeline"  ${activeTab !== 'pipeline'  ? 'hidden' : ''}>${pipelineTab}</div>
    </div>`;
}

// ── Carryover card ────────────────────────────────────────────────────────────
function _buildCarryoverCard(priorYearInvoices, invTotals, fC, fN) {
  if (!priorYearInvoices.length) return '';

  const total = priorYearInvoices.reduce((s, i) => {
    return s + (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0);
  }, 0);

  const rows = priorYearInvoices.map(inv => {
    const batches = typeof inv.batches === 'string' ? JSON.parse(inv.batches || '[]') : (inv.batches || []);
    const commName = batches.flatMap(b => b.lines||[]).find(l => l.type==='income' && l.description)?.description || 'Grain';
    const qty   = batches.filter(x => (x.lines||[]).some(l => l.type==='income' && l.line_type!=='qa'))
                        .reduce((s, x) => s + (parseFloat(x.qty)||0), 0) || parseFloat(inv.total_qty) || 0;
    const inc   = (parseFloat(inv.gross_amount)||0) + (parseFloat(inv.total_quality_adj)||0);
    const price = qty && inc ? inc / qty : null;
    return `<tr>
      <td>${esc(commName)}</td>
      <td>${inv.invoice_date ? new Date(inv.invoice_date).toLocaleDateString('en-AU',{day:'numeric',month:'short'}) : '—'}</td>
      <td>${esc(inv.buyer || '—')}</td>
      <td>${qty ? fN(qty, 1) + ' t' : '—'}</td>
      <td>${price ? fC(price) + '/t' : '—'}</td>
      <td style="color:var(--mgmt-green);font-weight:600">${inc ? fC(inc) : '—'}</td>
    </tr>`;
  }).join('');

  return `
    <div class="mgmt-carryover-card">
      <div class="mgmt-carryover-header">
        <div>
          <div class="mgmt-carryover-title">⚠ Prior Season Carryover</div>
          <div class="mgmt-carryover-sub">Grain from last season sold this season · Total received: ${fC(total)}</div>
        </div>
      </div>
      <div style="padding:14px 18px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:2px solid #f0d080">
              <th style="text-align:left;padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--mgmt-amber)">Commodity</th>
              <th style="text-align:left;padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--mgmt-amber)">Date</th>
              <th style="text-align:left;padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--mgmt-amber)">Buyer</th>
              <th style="text-align:right;padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--mgmt-amber)">Qty</th>
              <th style="text-align:right;padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--mgmt-amber)">Price</th>
              <th style="text-align:right;padding:5px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--mgmt-amber)">Amount</th>
            </tr>
          </thead>
          <tbody style="color:var(--ink)">${rows}</tbody>
        </table>
      </div>
    </div>`;
}

// ── Escape HTML ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
