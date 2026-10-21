// modules/management-report/management-report.js
// Management Report — CFM-native income actuals vs budget, season-scoped
// Revenue actuals from CFM invoices; cost budgets from budget_costs table.
// Fixed cost actuals pulled from Xero P&L when the farm has a Xero connection.

import { dbSelect, dbInsert } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js';
import { formatCurrency, formatNumber, formatDate, qs, toast } from '../../js/ui.js';

export function unmountManagementReport() {}

export async function mountManagementReport(container) {
  container.innerHTML = `
    <div style="padding:20px 24px;max-width:1200px;margin:0 auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <div id="mgmt-title" style="font-size:20px;font-weight:700;color:var(--ink)"></div>
          <div id="mgmt-sub" style="font-size:12px;color:var(--hint);margin-top:3px"></div>
        </div>
        ${canWrite() ? '<button class="btn btn-ghost btn-sm" id="mgmt-comment-btn">+ Add comment</button>' : ''}
      </div>
      <div id="mgmt-body">
        <div style="padding:60px;text-align:center;color:var(--hint)">Loading...</div>
      </div>
    </div>
  `;
  qs('#mgmt-comment-btn', container)?.addEventListener('click', () => _addComment(container));
  await _render(container);
}

async function _render(container) {
  const farm   = getActiveFarm();
  const season = getActiveSeason();
  if (!farm || !season) return;

  const seasonYear = parseInt(season.split('-')[0]);
  const now        = new Date();
  // Season start month from farm settings (1-based); default July for most farms, Oct for Blackbull
  const yearStartMonth      = farm.settings?.yearStartMonth || 7;
  const seasonStartMonthIdx = yearStartMonth - 1; // 0-based for Date comparison
  // Months elapsed since start of this season — count the current partial month as 1
  // e.g. for an October-start farm in October: 0 complete months + we're in month 1 → show 1/12
  let monthsElapsed = (now.getFullYear() - seasonYear) * 12 + (now.getMonth() - seasonStartMonthIdx);
  if (monthsElapsed < 0)  monthsElapsed = 0;
  if (monthsElapsed > 12) monthsElapsed = 12;
  // Add 1 so the current (partial) month is included in the pro-rata
  const ytdMonths   = Math.min(monthsElapsed + 1, 12);
  const ytdFraction = ytdMonths / 12;

  qs('#mgmt-title', container).textContent = `${farm.name} — Management Report`;
  qs('#mgmt-sub', container).textContent   =
    `Season ${season} · YTD to ${now.toLocaleString('en-AU',{month:'long',year:'numeric'})} · As at ${formatDate(now.toISOString().slice(0,10))}`;

  const body = qs('#mgmt-body', container);
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--hint)">Loading...</div>';

  console.log('[MgmtReport] Loading data for farm:', farm.id, 'season:', season);
  const [contracts, allInvoices, budgets, budgetCosts, comments] = await Promise.all([
    dbSelect('forward_contracts', `farm_id=eq.${farm.id}&crop_year=eq.${season}&select=*`),
    dbSelect('invoices', `farm_id=eq.${farm.id}&select=*&order=invoice_date.asc`),
    dbSelect('budgets', `farm_id=eq.${farm.id}&season=eq.${season}&select=*`),
    dbSelect('budget_costs', `farm_id=eq.${farm.id}&financial_year=eq.${season}&select=*`).catch(()=>[]),
    dbSelect('management_comments', `farm_id=eq.${farm.id}&season=eq.${season}&select=*,user_profiles(full_name)&order=created_at.desc`).catch(()=>[]),
  ]);
  console.log('[MgmtReport] budgets rows:', budgets.length, '| budgetCosts rows:', budgetCosts.length);

  // ── Xero fixed-cost actuals (non-blocking — shows — if Xero not connected) ─
  // Pulls YTD expense totals from Xero P&L via /.netlify/functions/xero-pull
  let xeroActuals  = null; // { labour, overhead, rm, fund_mgmt } or null
  let xeroAccounts = null; // raw account array for line-level matching
  let xeroYtdLabel = null;
  try {
    const xeroRes = await fetch(`/.netlify/functions/xero-pull?farm_id=${farm.id}&season=${encodeURIComponent(season)}`);
    if (xeroRes.ok) {
      const xeroData = await xeroRes.json();
      if (xeroData.ok) {
        xeroActuals  = xeroData.categories;
        xeroAccounts = xeroData.accounts || [];
        xeroYtdLabel = xeroData.ytd_to;
        console.log('[MgmtReport] Xero actuals loaded:', xeroActuals, 'accounts:', xeroAccounts.length, 'to:', xeroYtdLabel);
      }
    }
  } catch (xeroErr) {
    console.log('[MgmtReport] Xero not available (farm may not be connected):', xeroErr.message);
  }

  // ── Xero line-level matcher ────────────────────────────────────────────────
  // Match a budget line description to a Xero account name.
  // Uses normalised substring matching — strips punctuation and compares words.
  // Returns the matched Xero account's amount, or null if no match.
  const xeroLineActual = xeroAccounts ? (() => {
    // Pre-normalise all Xero account names once
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const xeroNorm = xeroAccounts.map(a => ({ ...a, _norm: norm(a.name) }));

    return (description) => {
      const dNorm = norm(description);
      // 1. Exact normalised match
      let hit = xeroNorm.find(a => a._norm === dNorm);
      if (hit) return hit.amount;

      // 2. One contains the other
      hit = xeroNorm.find(a => a._norm.includes(dNorm) || dNorm.includes(a._norm));
      if (hit) return hit.amount;

      // 3. Word overlap — at least half the budget description words appear in the Xero name
      const dWords = dNorm.split(' ').filter(w => w.length > 2);
      if (dWords.length) {
        hit = xeroNorm.find(a => {
          const matches = dWords.filter(w => a._norm.includes(w));
          return matches.length >= Math.ceil(dWords.length / 2);
        });
        if (hit) return hit.amount;
      }

      return null;
    };
  })() : () => null;

  // ── Season-scoped invoices ──────────────────────────────────────────────────
  // Prior-year-flagged invoices are handled separately below — exclude them here
  // so they don't double-count in normal income rows.
  const isPriorYearInv = inv => {
    if (!inv.batches) return false;
    const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
    return b.some(batch => batch.prior_year_income);
  };

  const seasonInvoices = allInvoices.filter(inv => {
    if (isPriorYearInv(inv)) return false; // handled in carry-over section
    if (inv.season === season) return true;
    if (inv.batches) {
      const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
      if (b.some(batch => batch.crop_year === season)) return true;
    }
    const linked = contracts.find(c => c.id === inv.forward_contract_id);
    if (linked?.crop_year === season) return true;
    return false;
  });

  // Prior-year receipts: all invoices flagged with prior_year_income=true for this farm.
  // They show in whatever season report the user is currently viewing — the user
  // explicitly tagged them, so no date filtering needed.
  const priorYearInvoices = allInvoices.filter(isPriorYearInv);

  const fC  = n  => n != null ? formatCurrency(n, 0) : '—';
  const fN  = (n, dp=0) => n != null && n !== 0 ? formatNumber(n, dp) : '—';
  const varAmt = (actual, budget) => {
    if (budget == null || actual == null) return '<span style="color:var(--hint)">—</span>';
    const v = actual - budget;
    const pct = budget !== 0 ? (v / budget * 100) : null;
    const color = v >= 0 ? 'var(--green)' : 'var(--red)';
    const pctStr = pct != null ? ` <span style="font-size:10px;opacity:.8">(${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)</span>` : '';
    return `<span style="color:${color};font-weight:600">${v >= 0 ? '+' : ''}${fC(v)}${pctStr}</span>`;
  };

  // ── Invoice totals for a commodity ─────────────────────────────────────────
  const invTotals = (invList, commName) => {
    let qty = 0, income = 0, qa = 0, costs = 0;
    const matchedInvs = [];
    const targetKey = commName ? commName.trim().toUpperCase().replace(/\s+/g,' ') : null;
    const targetIsLivestock = targetKey && /cattle|livestock/i.test(targetKey);
    invList.forEach(inv => {
      const linked = contracts.find(c => c.id === inv.forward_contract_id);
      const batchComm = (() => { if (!inv.batches) return ''; const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches; return b.flatMap(x=>x.lines||[]).find(l=>l.type==='income'&&l.description)?.description||''; })();
      const iComm  = linked?.commodity || batchComm || (inv.line_items||[])[0]?.commodity || '';
      const iCommKey = iComm.trim().toUpperCase().replace(/\s+/g,' ');
      // Livestock invoices use commodity_type='livestock' but budget may be stored as 'CATTLE' etc.
      // Allow any livestock synonym to match any livestock budget group.
      if (targetKey) {
        const invoiceIsLivestock = /cattle|livestock/i.test(iComm);
        if (targetIsLivestock && invoiceIsLivestock) { /* match */ }
        else if (iCommKey !== targetKey) return;
      }
      matchedInvs.push(inv);
      if (inv.batches) {
        const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        qty += b.filter(x => (x.lines||[]).some(l => l.type==='income' && l.line_type!=='qa'))
                .reduce((s, x) => s + (parseFloat(x.qty)||0), 0);
      } else {
        qty += parseFloat(inv.total_qty) || 0;
      }
      income += parseFloat(inv.gross_amount)      || 0;
      qa     += parseFloat(inv.total_quality_adj) || 0;
      costs  += parseFloat(inv.total_deductions)  || 0;
    });
    return { qty, income, qa, totalIncome: income + qa, costs, avgPrice: qty ? (income+qa)/qty : null, invoices: matchedInvs };
  };

  // ── Build commodity groups from budgets table ──────────────────────────────
  const groups = {};
  budgets.forEach(b => {
    if (!b.commodity) return;
    const key = b.commodity.trim().toUpperCase().replace(/\s+/g,' ');
    if (!groups[key]) groups[key] = { name: b.commodity.trim(), budgets: [] };
    groups[key].budgets.push(b);
  });

  // ── Add groups from prior-year receipts (no budget row needed) ────────────
  priorYearInvoices.forEach(inv => {
    const batches = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
    const commName = batches.flatMap(b=>b.lines||[]).find(l=>l.type==='income'&&l.description)?.description
      || (inv.line_items||[])[0]?.commodity
      || null;
    if (!commName) return;
    const key = commName.trim().toUpperCase().replace(/\s+/g,' ');
    if (!groups[key]) groups[key] = { name: commName.trim(), budgets: [] };
  });

  // ── Budget for a commodity group ───────────────────────────────────────────
  // Helper: read a budget field that may be stored under two naming conventions.
  // Budget-module rows use plain names (yield_per_ha, price); imported rows use budgeted_ prefix.
  const bField = (b, plain, prefixed) => parseFloat(b[prefixed] ?? b[plain]) || 0;

  const budgetForGroup = (g, opts = {}) => {
    if (!g.budgets.length) return { bIncome: null, bYTD: null, bArea: null, bYield: null, bPrice: null, bProd: null };
    if (opts.carryOver) {
      const bIncome = g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue)||bField(b,'price','budgeted_price') * (parseFloat(b.budgeted_production)||bField(b,'yield_per_ha','budgeted_yield_per_ha') * (parseFloat(b.area_ha)||0))||0), 0) || null;
      const bYTD    = bIncome != null ? bIncome * ytdFraction : null;
      return { bIncome, bYTD, bArea: null, bYield: null, bProd: null, bPrice: null };
    }
    const bArea   = g.budgets.reduce((s, b) => s + (parseFloat(b.area_ha)||0), 0);
    const bYield  = bArea
      ? g.budgets.reduce((s, b) => s + bField(b,'yield_per_ha','budgeted_yield_per_ha') * (parseFloat(b.area_ha)||0), 0) / bArea
      : 0;
    const bProd   = bArea && bYield ? Math.round(bArea * bYield) : g.budgets.reduce((s,b)=>s+(parseFloat(b.budgeted_production)||0),0)||null;
    const bPrice  = g.budgets.reduce((s, b) => s + bField(b,'price','budgeted_price'), 0) / g.budgets.length;
    const bIncome = (bProd && bPrice)
      ? bProd * bPrice
      : g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue)||0), 0) || null;
    const bYTD    = bIncome != null ? bIncome * ytdFraction : null;
    return { bIncome, bYTD, bArea, bYield, bProd, bPrice };
  };

  // Table styles (5 columns: Description | Actual YTD | Budget YTD | Full yr budget | Variance)
  const th  = `padding:7px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);border-bottom:2px solid var(--border);white-space:nowrap`;
  const thR = th + ';text-align:right';
  const td  = `padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border-light)`;
  const tdR = td + ';text-align:right;font-variant-numeric:tabular-nums';
  const secRow  = label => `<tr style="background:#1e3a5f"><td colspan="5" style="padding:7px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:white">${label}</td></tr>`;
  const commRow = label => `<tr style="background:#e8f0fe"><td colspan="5" style="padding:5px 12px;font-size:11px;font-weight:600;color:#1e3a5f">${label}</td></tr>`;

  let grandBudget = 0, grandBudgetYTD = 0, grandActual = 0;

  // ── Single commodity row ───────────────────────────────────────────────────
  const isCattle    = (name) => /cattle|livestock/i.test(name);
  const isOther     = (name) => !isCattle(name) && /agistment|interest received|rent|lease|royalt/i.test(name);
  const isCarryOver = (name) => !isCattle(name) && !isOther(name) && name !== name.toUpperCase();

  const buildCommRow = (g, opts = {}) => {
    const { bIncome, bYTD, bArea, bYield, bProd, bPrice } = budgetForGroup(g, { carryOver: opts.carryOver });
    // Carry-over rows: use prior-year receipts list (invoice_date this season, prior_year_income flag)
    const invSource = opts.carryOver ? priorYearInvoices : seasonInvoices;
    const inv  = invTotals(invSource, g.name);
    const unit = g.budgets[0]?.unit || contracts.find(c => c.commodity?.toUpperCase() === g.name.toUpperCase())?.unit || 't';
    const isLs = isCattle(g.name);

    let lsHead = 0, lsKg = 0, lsIncome = 0;
    if (isLs) {
      inv.invoices.forEach(i => {
        lsHead   += parseFloat(i.total_head)   || 0;
        lsKg     += parseFloat(i.total_weight) || 0;
        lsIncome += (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0);
      });
    }

    const modalData = {
      name: g.name, unit, isLs, carryOver: !!opts.carryOver,
      bIncome, bYTD, bArea, bYield, bProd, bPrice,
      lsHead, lsKg, lsIncome,
      invoices: inv.invoices.map(i => {
        let qty = 0;
        if (i.batches) {
          const b = typeof i.batches==='string'?JSON.parse(i.batches):i.batches;
          qty = b.filter(x=>(x.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa'))
                 .reduce((s,x)=>s+(parseFloat(x.qty)||0),0);
        } else { qty = parseFloat(i.total_qty)||0; }
        const inc = (parseFloat(i.gross_amount)||0)+(parseFloat(i.total_quality_adj)||0);
        return {
          id: i.id,
          date: i.invoice_date?.slice(0,10),
          buyer: i.buyer,
          qty,
          inc,
          price: (qty && inc) ? inc / qty : null,
        };
      }),
    };
    const dataAttr = JSON.stringify(modalData).replace(/"/g,'&quot;');

    const html = `
      <tr style="cursor:pointer;transition:background .1s" onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background=''"
          onclick="window._mgmtOpenModal(JSON.parse(this.dataset.modal))" data-modal="${dataAttr}">
        <td style="${td};font-weight:500;padding-left:16px;color:var(--ink)">
          ${g.name}
          ${inv.invoices.length ? `<span style="font-size:10px;color:var(--hint);margin-left:8px;font-weight:400">${inv.invoices.length} invoice${inv.invoices.length!==1?'s':''}</span>` : ''}
          <span style="font-size:10px;color:var(--hint);margin-left:4px">↗</span>
        </td>
        <td style="${tdR};color:${inv.totalIncome ? 'var(--green)' : 'var(--hint)'};font-weight:600">${inv.totalIncome ? fC(inv.totalIncome) : '—'}</td>
        <td style="${tdR}">${inv.totalIncome && bYTD != null ? fC(bYTD) : '—'}</td>
        <td style="${tdR}">${bIncome != null ? fC(bIncome) : '—'}</td>
        <td style="${tdR}">${inv.totalIncome ? varAmt(inv.totalIncome, bYTD) : '<span style="color:var(--hint)">—</span>'}</td>
      </tr>
    `;
    return { html, bIncome: bIncome || 0, bYTD: bYTD || 0, actual: inv.totalIncome };
  };

  // ── Section builder ────────────────────────────────────────────────────────
  const buildSection = (label, gList, opts = {}) => {
    if (!gList.length) return '';
    let secBudget = 0, secBudgetYTD = 0, secActual = 0;
    const rowsHtml = gList.map(g => {
      const r = buildCommRow(g, { carryOver: opts.carryOver });
      secBudget    += r.bIncome;
      secBudgetYTD += r.bYTD;
      secActual    += r.actual;
      return r.html;
    }).join('');
    grandBudget    += secBudget;
    grandBudgetYTD += secBudgetYTD;
    grandActual    += secActual;
    const subtotal = `
      <tr style="background:#f0f4f8">
        <td style="${td};font-weight:600;font-size:11px;padding-left:16px;color:var(--hint)">${label} total</td>
        <td style="${tdR};color:var(--green);font-weight:600">${secActual ? fC(secActual) : '—'}</td>
        <td style="${tdR};font-weight:600">${secActual && secBudgetYTD ? fC(secBudgetYTD) : '—'}</td>
        <td style="${tdR};font-weight:600">${secBudget ? fC(secBudget) : '—'}</td>
        <td style="${tdR}">${secActual ? varAmt(secActual, secBudgetYTD) : '<span style="color:var(--hint)">—</span>'}</td>
      </tr>`;
    return secRow(label) + rowsHtml + subtotal;
  };

  const sortedGroups    = Object.values(groups).sort((a, b) => a.name.toUpperCase().localeCompare(b.name.toUpperCase()));
  const farmingGroups   = sortedGroups.filter(g => !isCattle(g.name) && !isOther(g.name) && !isCarryOver(g.name));
  const livestockGroups = sortedGroups.filter(g => isCattle(g.name));
  const otherGroups     = sortedGroups.filter(g => isOther(g.name));
  const carryOverGroups = sortedGroups.filter(g => isCarryOver(g.name));

  const incomeRows = [
    buildSection('Farming income',    [...farmingGroups, ...livestockGroups]),
    buildSection('Other income',      otherGroups),
    buildSection('Carry-over income', carryOverGroups, { carryOver: true }),
  ].join('');

  // ── Fixed costs from budget_costs ──────────────────────────────────────────
  const fixedCats = [
    { key: 'labour',    label: 'Labour & Farm Management' },
    { key: 'overhead',  label: 'Overheads' },
    { key: 'rm',        label: 'Repairs & Maintenance' },
    { key: 'fund_mgmt', label: 'Fund Management' },
  ];

  let totalFixedBudget  = 0;
  let totalFixedActual  = 0;  // sum of Xero actuals across all fixed categories
  const fixedRows = fixedCats.map(cat => {
    const lines = budgetCosts.filter(c => c.category === cat.key);
    if (!lines.length) return '';
    const catTotal = lines.reduce((s, c) => s + (parseFloat(c.budget_amount)||0), 0);
    totalFixedBudget += catTotal;

    // Xero actual for this category (positive = spend, display as cost)
    const catActual   = xeroActuals ? (xeroActuals[cat.key] || 0) : null;
    if (catActual !== null) totalFixedActual += catActual;

    // Variance: positive = under budget (good), negative = over budget (bad)
    const catVariance = (catActual !== null) ? (catTotal * ytdFraction) - catActual : null;
    const varStyle    = catVariance !== null
      ? (catVariance >= 0 ? 'color:var(--green)' : 'color:var(--red)')
      : '';

    return `
      ${commRow(cat.label)}
      ${lines.map(c => {
        const amt      = parseFloat(c.budget_amount) || 0;
        const amtYTD   = amt * ytdFraction;
        const lineAct  = xeroLineActual(c.description);
        const lineVar  = lineAct !== null ? (amtYTD - lineAct) : null;
        const lineVarStyle = lineVar !== null
          ? (lineVar >= 0 ? 'color:var(--green)' : 'color:var(--red)')
          : '';
        return `
        <tr>
          <td style="${td};padding-left:28px;font-size:11px;color:var(--hint)">${c.description}</td>
          <td style="${tdR};color:var(--red);font-size:11px">${lineAct !== null ? '-' + fC(lineAct) : '—'}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amtYTD)}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amt)}</td>
          <td style="${tdR};font-size:11px">${lineVar !== null ? `<span style="${lineVarStyle};font-weight:600">${lineVar >= 0 ? '+' : ''}${fC(lineVar)}</span>` : '—'}</td>
        </tr>`;
      }).join('')}
      <tr style="background:var(--page-bg)">
        <td style="${td};padding-left:20px;font-weight:600;font-size:12px">${cat.label} total</td>
        <td style="${tdR};color:var(--red);font-weight:600">${catActual !== null ? '-' + fC(catActual) : '—'}</td>
        <td style="${tdR};color:var(--red);font-weight:600">-${fC(catTotal * ytdFraction)}</td>
        <td style="${tdR};color:var(--red);font-weight:600">-${fC(catTotal)}</td>
        <td style="${tdR};font-weight:600">${catVariance !== null ? `<span style="${varStyle};font-weight:600">${catVariance >= 0 ? '+' : ''}${fC(catVariance)}</span>` : '—'}</td>
      </tr>`;
  }).join('');

  // ── CAPEX from budget_costs (category='capex') ────────────────────────────
  const capexCosts = budgetCosts.filter(c => c.category === 'capex');

  // Group by budget_code to show code-level rows (clickable for drilldown)
  const capexByCode = new Map();
  for (const c of capexCosts) {
    const code = c.budget_code || 'UNALLOCATED';
    if (!capexByCode.has(code)) {
      capexByCode.set(code, { code, subcategory: c.subcategory, items: [], total: 0 });
    }
    const entry = capexByCode.get(code);
    entry.items.push(c);
    entry.total += parseFloat(c.budget_amount) || 0;
  }

  let totalCapexBudget = 0;
  const capexRows = [...capexByCode.values()].map(entry => {
    const amt = Math.abs(entry.total);
    const isSale = entry.total < 0;
    totalCapexBudget += entry.total;

    // Encode line items for the drilldown modal — use data attribute to avoid quote-escaping issues
    const modalData = JSON.stringify({
      code: entry.code,
      subcategory: entry.subcategory || 'Capital Expenditure',
      items: entry.items.map(i => ({ desc: i.description, amt: parseFloat(i.budget_amount)||0, notes: i.notes })),
    }).replace(/"/g, '&quot;');

    return `
      <tr style="cursor:pointer" data-capex-modal="${modalData}" title="Click to see budget items">
        <td style="${td};padding-left:28px">
          <span style="font-size:12px;color:var(--ink)">${entry.code}</span>
          <span style="font-size:10px;color:var(--hint);margin-left:6px">${entry.subcategory || ''}</span>
          <span style="font-size:10px;color:var(--blue);margin-left:6px">↗ ${entry.items.length} item${entry.items.length!==1?'s':''}</span>
        </td>
        <td style="${tdR};color:var(--hint)">—</td>
        <td style="${tdR};font-size:12px;color:${isSale ? 'var(--green)' : 'var(--red)'}">
          ${isSale ? '+' : '-'}${fC(amt * ytdFraction)}
        </td>
        <td style="${tdR};font-size:12px;color:${isSale ? 'var(--green)' : 'var(--red)'}">
          ${isSale ? '+' : '-'}${fC(amt)}
        </td>
        <td style="${tdR}">—</td>
      </tr>`;
  }).join('');

  // ── Comments ───────────────────────────────────────────────────────────────
  const commentRows = comments.length
    ? comments.map(c => `
        <tr>
          <td style="${td};color:var(--hint);font-size:11px;white-space:nowrap;width:90px">${formatDate(c.created_at?.slice(0,10))}</td>
          <td style="${td};font-size:11px;color:var(--hint);white-space:nowrap;width:130px">${c.user_profiles?.full_name||'User'}</td>
          <td style="${td};font-size:12px" colspan="3">${c.comment}</td>
        </tr>`).join('')
    : `<tr><td colspan="5" style="${td};color:var(--hint);font-style:italic">No comments yet</td></tr>`;

  body.innerHTML = `
    <!-- Summary tiles -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px">
      ${[
        ['Actual YTD income',  fC(grandActual),      'var(--green)'],
        ['Budget YTD income',  fC(grandBudgetYTD),   'var(--ink)'],
        ['Full year budget',   fC(grandBudget),      'var(--blue)'],
        ['YTD variance',       (() => { const v = grandActual - grandBudgetYTD; const pct = grandBudgetYTD ? v/grandBudgetYTD*100 : null; return (v>=0?'+':'')+fC(v)+(pct!=null?` (${pct>=0?'+':''}${pct.toFixed(0)}%)`:''); })(),
                               grandActual - grandBudgetYTD >= 0 ? 'var(--green)' : 'var(--red)'],
      ].map(([l,v,c]) => `
        <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${l}</div>
          <div style="font-size:20px;font-weight:700;color:${c}">${v}</div>
        </div>`).join('')}
    </div>

    <!-- Info note -->
    <div style="font-size:11px;color:var(--hint);margin-bottom:12px;font-style:italic">
      ℹ Budget YTD is pro-rated (${ytdMonths} of 12 months from ${new Date(seasonYear, seasonStartMonthIdx).toLocaleString('en-AU',{month:'long'})}).
      Click any income row ↗ for detail.
      ${xeroActuals ? `· Fixed cost actuals from Xero to ${formatDate(xeroYtdLabel)}.` : '· Fixed cost actuals not yet available (connect Xero in Farm Settings to enable).'}
    </div>

    <!-- Main table -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:800px">
          <thead>
            <tr>
              <th style="${th};text-align:left;min-width:220px"></th>
              <th style="${thR}">Actual YTD</th>
              <th style="${thR}">Budget YTD</th>
              <th style="${thR}">Full yr budget</th>
              <th style="${thR}">Variance</th>
            </tr>
          </thead>
          <tbody>
            ${incomeRows || `<tr><td colspan="5" style="${td};color:var(--hint);font-style:italic;padding-left:20px">No income budgets or invoices for this season</td></tr>`}

            <!-- Income total -->
            <tr style="background:#f0fdf4;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700">Total income</td>
              <td style="${tdR};color:var(--green);font-weight:700;font-size:13px">${fC(grandActual)}</td>
              <td style="${tdR};font-weight:700">${fC(grandBudgetYTD)}</td>
              <td style="${tdR};font-weight:700">${fC(grandBudget)}</td>
              <td style="${tdR}">${varAmt(grandActual, grandBudgetYTD)}</td>
            </tr>

            ${budgetCosts.length ? `
              ${fixedRows.trim() ? `
                ${secRow('Fixed costs')}
                ${fixedRows}
                <tr style="background:#fff5f5;border-top:2px solid var(--border)">
                  <td style="${td};font-weight:700">Total fixed costs${xeroActuals ? ` <span style="font-size:10px;font-weight:400;color:var(--hint)">(Xero actuals)</span>` : ''}</td>
                  <td style="${tdR};color:var(--red);font-weight:700">${xeroActuals ? '-' + fC(totalFixedActual) : '—'}</td>
                  <td style="${tdR};color:var(--red);font-weight:700">-${fC(totalFixedBudget * ytdFraction)}</td>
                  <td style="${tdR};color:var(--red);font-weight:700">-${fC(totalFixedBudget)}</td>
                  <td style="${tdR};font-weight:700">${xeroActuals ? (() => { const v = (totalFixedBudget * ytdFraction) - totalFixedActual; return `<span style="color:${v>=0?'var(--green)':'var(--red)'};font-weight:700">${v>=0?'+':''}${fC(v)}</span>`; })() : '—'}</td>
                </tr>` : ''}

              ${capexRows.trim() ? `
                ${secRow('Capital expenditure')}
                ${capexRows}
                <tr style="background:#fff5f5;border-top:2px solid var(--border)">
                  <td style="${td};font-weight:700">Total capex</td>
                  <td style="${tdR};color:var(--hint)">—</td>
                  <td style="${tdR};color:var(--red);font-weight:700">-${fC(Math.abs(totalCapexBudget) * ytdFraction)}</td>
                  <td style="${tdR};color:var(--red);font-weight:700">-${fC(Math.abs(totalCapexBudget))}</td>
                  <td style="${tdR};color:var(--hint)">—</td>
                </tr>` : ''}

              <!-- Net income -->
              ${(() => {
                const budgetNetYTD = grandBudgetYTD - totalFixedBudget * ytdFraction - Math.abs(totalCapexBudget) * ytdFraction;
                const budgetNetFY  = grandBudget - totalFixedBudget - Math.abs(totalCapexBudget);
                // If Xero actuals available, compute actual net: income - fixed costs (CAPEX actuals not yet available)
                const actualNet    = xeroActuals ? grandActual - totalFixedActual : null;
                const netVariance  = actualNet !== null ? actualNet - budgetNetYTD : null;
                const netLabel     = xeroActuals ? 'Net income (Xero costs YTD)' : 'Net income (budget)';
                return `<tr style="background:#eff6ff;border-top:2px solid var(--border)">
                  <td style="${td};font-weight:700;font-size:13px;color:var(--blue)">${netLabel}</td>
                  <td style="${tdR};font-weight:700;color:var(--blue)">${actualNet !== null ? fC(actualNet) : '—'}</td>
                  <td style="${tdR};font-weight:700;color:var(--blue)">${fC(budgetNetYTD)}</td>
                  <td style="${tdR};font-weight:700;color:var(--blue)">${fC(budgetNetFY)}</td>
                  <td style="${tdR};font-weight:700">${netVariance !== null ? `<span style="color:${netVariance>=0?'var(--green)':'var(--red)'};font-weight:700">${netVariance>=0?'+':''}${fC(netVariance)}</span>` : '—'}</td>
                </tr>`;
              })()}
            ` : `
              <!-- Net income — income only -->
              <tr style="background:#eff6ff;border-top:2px solid var(--border)">
                <td style="${td};font-weight:700;font-size:13px;color:var(--blue)">Net income (income only)</td>
                <td style="${tdR};color:var(--blue);font-weight:700;font-size:13px">${fC(grandActual)}</td>
                <td style="${tdR};font-weight:700">${fC(grandBudgetYTD)}</td>
                <td style="${tdR};font-weight:700">${fC(grandBudget)}</td>
                <td style="${tdR}">${varAmt(grandActual, grandBudgetYTD)}</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Comments -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <div style="padding:10px 16px;background:var(--page-bg);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;font-weight:600">Comments and notes</span>
        <span style="font-size:11px;color:var(--hint)">${comments.length} comment${comments.length!==1?'s':''}</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${commentRows}</tbody>
      </table>
    </div>
  `;

  // Delegated click handler for CAPEX drilldown rows (data-capex-modal attribute)
  body.addEventListener('click', e => {
    const row = e.target.closest('[data-capex-modal]');
    if (row) window._mgmtOpenCapexModal(row.dataset.capexModal);
  });
}

// ── Commodity detail modal ────────────────────────────────────────────────────
window._mgmtOpenModal = function(d) {
  const fC = v => v == null ? '—' : v.toLocaleString('en-AU', { style:'currency', currency:'AUD', minimumFractionDigits:0, maximumFractionDigits:0 });
  const fN = (v, dp=0) => v == null ? '—' : v.toLocaleString('en-AU', { minimumFractionDigits:dp, maximumFractionDigits:dp });

  const stat = (label, value, sub='', color='var(--ink)') => `
    <div style="padding:12px 16px;border-right:0.5px solid var(--border-light)">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color}">${value}</div>
      ${sub ? `<div style="font-size:10px;color:var(--hint);margin-top:2px">${sub}</div>` : ''}
    </div>`;

  const sectionHdr = label => `<div style="padding:8px 18px;background:var(--page-bg);border-bottom:1px solid var(--border);border-top:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">${label}</div>`;

  // For carry-over income: show actual qty sold + avg price (area/yield not relevant)
  const totalQty   = d.invoices.reduce((s,i) => s + (i.qty||0), 0);
  const totalInc   = d.invoices.reduce((s,i) => s + (i.inc||0), 0);
  const avgPrice   = (totalQty && totalInc) ? totalInc / totalQty : null;

  const budgetSection = d.isLs ? '' : d.carryOver ? `
    ${sectionHdr('Actual')}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border)">
      ${stat('Qty sold',  totalQty  ? fN(totalQty,2)+' '+d.unit : '—')}
      ${stat('Avg price', avgPrice  ? '$'+fN(avgPrice,2)+'/'+d.unit : '—')}
      ${stat('Total',     totalInc  ? fC(totalInc) : '—', '', '#16a34a')}
    </div>` : `
    ${sectionHdr('Budget')}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--border)">
      ${stat('Area',       d.bArea  != null ? fN(d.bArea,1)+' ha'              : '—')}
      ${stat('Production', d.bProd  != null ? fN(d.bProd)+' '+d.unit           : '—')}
      ${stat('Yield',      d.bYield != null && d.bYield ? fN(d.bYield,2)+' '+d.unit+'/ha' : '—')}
      ${stat('Price',      d.bPrice != null && d.bPrice ? '$'+fN(d.bPrice,2)+'/'+d.unit   : '—')}
    </div>`;

  const lsSection = !d.isLs ? '' : `
    ${sectionHdr('Livestock actuals')}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--border)">
      ${stat('Head sold',     d.lsHead ? fN(d.lsHead,0)+' hd'                          : '—')}
      ${stat('Total weight',  d.lsKg   ? fN(d.lsKg,0)+' kg'                            : '—')}
      ${stat('Avg weight/hd', d.lsKg && d.lsHead   ? fN(d.lsKg/d.lsHead,0)+' kg'      : '—')}
      ${stat('Price/kg',      d.lsKg && d.lsIncome ? '$'+fN(d.lsIncome/d.lsKg,2)+'/kg': '—', '', '#16a34a')}
    </div>`;

  const invoiceTable = d.invoices.length ? `
    ${sectionHdr('Invoices')}
    <div style="padding:0 18px 12px">
      <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:12px">
        <thead><tr style="border-bottom:1px solid var(--border)">
          <th style="text-align:left;padding:4px 8px;color:var(--hint);font-weight:500">Date · Buyer</th>
          <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Qty</th>
          <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Price</th>
          <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Amount</th>
          <th style="padding:4px 8px;color:var(--hint);font-weight:500"></th>
        </tr></thead>
        <tbody>
          ${d.invoices.map(i => `<tr style="border-bottom:0.5px solid var(--border-light)">
            <td style="padding:5px 8px;color:var(--ink)">${i.date ? new Date(i.date).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}) : '—'}${i.buyer ? ' · '+i.buyer : ''}</td>
            <td style="padding:5px 8px;text-align:right;color:var(--hint)">${i.qty ? fN(i.qty,2)+' '+d.unit : '—'}</td>
            <td style="padding:5px 8px;text-align:right;color:var(--hint)">${i.price ? '$'+fN(i.price,2)+'/'+d.unit : '—'}</td>
            <td style="padding:5px 8px;text-align:right;color:#16a34a;font-weight:600">${fC(i.inc)}</td>
            <td style="padding:5px 8px;text-align:center">
              <button onclick="window._mgmtOpenInvoice('${i.id}')" title="Open invoice"
                style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer;color:var(--blue);line-height:1.4">↗</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : `${sectionHdr('Invoices')}<div style="padding:12px 18px;font-size:11px;color:var(--hint);font-style:italic">No invoices this season</div>`;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:680px;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:1">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">${d.name}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${d.carryOver ? 'Carry-over income' : d.isLs ? 'Livestock' : 'Farming income'} · Full yr budget: ${fC(d.bIncome)}</div>
        </div>
        <button id="mgmt-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hint)">✕</button>
      </div>
      ${budgetSection}
      ${lsSection}
      ${invoiceTable}
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#mgmt-modal-close').onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
};

// ── CAPEX drilldown modal ─────────────────────────────────────────────────────
window._mgmtOpenCapexModal = function(dataStr) {
  const fC = v => v == null ? '—' : Math.abs(v).toLocaleString('en-AU', { style:'currency', currency:'AUD', minimumFractionDigits:0, maximumFractionDigits:0 });

  let d;
  try { d = JSON.parse(dataStr); } catch(e) { console.error('[CAPEX modal] parse error:', e, dataStr); return; }

  const totalAmt = d.items.reduce((s, i) => s + (i.amt || 0), 0);
  const isSale   = totalAmt < 0;

  const rows = d.items.map(item => {
    const itemIsSale = item.amt < 0;
    return `
      <tr style="border-bottom:0.5px solid var(--border-light,#eee)">
        <td style="padding:8px 18px;font-size:12px;color:var(--ink)">${item.desc}</td>
        <td style="padding:8px 18px;text-align:right;font-size:12px;font-weight:600;color:${itemIsSale ? '#16a34a' : 'var(--red,#dc2626)'}">
          ${itemIsSale ? '+' : '-'}${fC(item.amt)}
        </td>
        <td style="padding:8px 18px;font-size:11px;color:var(--hint)">${item.notes||''}</td>
      </tr>`;
  }).join('');

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:600px;max-height:85vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:1">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">${d.code}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${d.subcategory} · Total: ${isSale ? '+' : '-'}${fC(totalAmt)}</div>
        </div>
        <button id="capex-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hint)">✕</button>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="border-bottom:1px solid var(--border);background:var(--page-bg,#f8fafc)">
            <th style="padding:8px 18px;text-align:left;font-size:11px;color:var(--hint);font-weight:500">Item</th>
            <th style="padding:8px 18px;text-align:right;font-size:11px;color:var(--hint);font-weight:500">Budget</th>
            <th style="padding:8px 18px;font-size:11px;color:var(--hint);font-weight:500">Source</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="border-top:2px solid var(--border);background:var(--page-bg,#f8fafc)">
            <td style="padding:10px 18px;font-weight:700;font-size:13px">Total</td>
            <td style="padding:10px 18px;text-align:right;font-weight:700;font-size:13px;color:${isSale ? '#16a34a' : 'var(--red,#dc2626)'}">
              ${isSale ? '+' : '-'}${fC(totalAmt)}
            </td>
            <td></td>
          </tr>
        </tfoot>
      </table>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#capex-modal-close').onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
};

// Navigate to Outputs and open invoice edit form
window._mgmtOpenInvoice = async function(invoiceId) {
  // Close any open modal
  document.querySelectorAll('[style*="position:fixed"]').forEach(el => {
    if (el.style.zIndex >= 9999) el.remove();
  });
  // Switch to outputs module
  const { dbSelect } = await import('../../js/supabase-client.js');
  const { openInvoiceForm } = await import('../outputs/invoices.js');
  // Navigate to outputs tab
  document.querySelector('#sidebar a[data-module="outputs"]')?.click();
  // Wait briefly for module to mount, then open the invoice
  setTimeout(async () => {
    try {
      const rows = await dbSelect('invoices', `id=eq.${invoiceId}&select=*`);
      const inv = rows?.[0];
      if (!inv) return;
      const container = document.getElementById('main');
      if (container) openInvoiceForm(container, inv);
    } catch(e) { console.error('Could not open invoice:', e); }
  }, 600);
};

async function _addComment(container) {
  const farm    = getActiveFarm();
  const season  = getActiveSeason();
  const session = getSession();
  if (!farm || !season) return;
  const text = prompt('Add a comment or note:');
  if (!text?.trim()) return;
  try {
    await dbInsert('management_comments', {
      farm_id: farm.id, season,
      comment: text.trim(),
      created_by: session?.user?.id,
    });
    toast('Comment saved', 'success');
    _render(container);
  } catch(e) {
    toast('Could not save comment', 'error');
    console.error(e);
  }
}
