// modules/management-report/mgmt-report.js
// Management Report — CFM-native income actuals vs budget, season-scoped
// Supports monthly view with month selector. 7-column table:
//   Description | Actual Month | Budget Month | Actual YTD | Budget YTD | Variance YTD | Full Yr Budget
// Revenue actuals from CFM invoices; cost actuals from Xero P&L.
// Line-level comments per row + month, tracked by user and timestamp.

import { dbSelect, dbInsert } from '../../js/supabase-client.js?v=1792559266387';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js?v=1792559266387';
import { formatCurrency, formatNumber, formatDate, qs, toast } from '../../js/ui.js?v=1792559266387';

// Module-level state — persists across re-renders within a session
let _selectedMonth = null; // 'YYYY-MM' or null = full YTD

export function unmountManagementReport() {
  _selectedMonth = null;
}

export async function mountManagementReport(container) {
  const farm   = getActiveFarm();
  const season = getActiveSeason();

  container.innerHTML = `
    <div style="padding:20px 24px;max-width:1200px;margin:0 auto">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px">
        <div>
          <div id="mgmt-title" style="font-size:20px;font-weight:700;color:var(--ink)"></div>
          <div id="mgmt-sub" style="font-size:12px;color:var(--hint);margin-top:3px"></div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:6px">
            <label for="mgmt-month-sel" style="font-size:12px;color:var(--hint);white-space:nowrap">Report month:</label>
            <select id="mgmt-month-sel" class="form-select" style="font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:white">
              <option value="">Full YTD</option>
            </select>
          </div>
          ${canWrite() ? '<button class="btn btn-ghost btn-sm" id="mgmt-comment-btn">+ Season note</button>' : ''}
        </div>
      </div>
      <div id="mgmt-body">
        <div style="padding:60px;text-align:center;color:var(--hint)">Loading...</div>
      </div>
    </div>
  `;

  // Populate month selector with months in this season
  if (farm && season) {
    _populateMonthSelector(container, farm, season);
  }

  const sel = qs('#mgmt-month-sel', container);
  if (sel) {
    sel.value = _selectedMonth || '';
    sel.addEventListener('change', () => {
      _selectedMonth = sel.value || null;
      _render(container);
    });
  }

  qs('#mgmt-comment-btn', container)?.addEventListener('click', () => _addSeasonComment(container));
  await _render(container);
}

// Build month options: season start to current month (or end of season)
function _populateMonthSelector(container, farm, season) {
  const sel = qs('#mgmt-month-sel', container);
  if (!sel) return;

  const yearStartMonth = farm.settings?.yearStartMonth || 7;
  const startYear = parseInt(season.split('-')[0]);
  const now = new Date();

  const months = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(startYear, yearStartMonth - 1 + i, 1));
    if (d > now) break; // don't show future months
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const label = d.toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    months.push({ value: y + '-' + m, label });
  }

  // Most recent first (descending)
  months.reverse().forEach(mo => {
    const opt = document.createElement('option');
    opt.value = mo.value;
    opt.textContent = mo.label;
    sel.appendChild(opt);
  });
}

async function _render(container) {
  const farm   = getActiveFarm();
  const season = getActiveSeason();
  if (!farm || !season) return;

  const yearStartMonth      = farm.settings?.yearStartMonth || 7;
  const seasonYear          = parseInt(season.split('-')[0]);
  const seasonStartMonthIdx = yearStartMonth - 1; // 0-based
  const now                 = new Date();

  // ── YTD fractions ──────────────────────────────────────────────────────────
  let monthsElapsed = (now.getFullYear() - seasonYear) * 12 + (now.getMonth() - seasonStartMonthIdx);
  if (monthsElapsed < 0)  monthsElapsed = 0;
  if (monthsElapsed > 12) monthsElapsed = 12;
  const ytdMonths   = Math.min(monthsElapsed + 1, 12);
  const ytdFraction = ytdMonths / 12;

  // ── Selected month fraction (for budget pro-rata to that month only) ───────
  let selectedMonthFraction = null; // e.g. 1/12 = 0.0833 for a full calendar month budget
  let selectedMonthLabel    = null; // human-readable e.g. 'September 2026'
  if (_selectedMonth) {
    const [sy, sm] = _selectedMonth.split('-').map(Number);
    selectedMonthFraction = 1 / 12;
    selectedMonthLabel    = new Date(Date.UTC(sy, sm - 1, 1))
      .toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  // ── Header ─────────────────────────────────────────────────────────────────
  const titleEl = qs('#mgmt-title', container);
  const subEl   = qs('#mgmt-sub',   container);
  if (titleEl) titleEl.textContent = farm.name + ' — Management Report';
  if (subEl) {
    subEl.textContent = _selectedMonth
      ? 'Season ' + season + ' · Monthly view: ' + selectedMonthLabel
      : 'Season ' + season + ' · YTD to ' + now.toLocaleString('en-AU', { month: 'long', year: 'numeric' }) + ' · As at ' + formatDate(now.toISOString().slice(0, 10));
  }

  // Update selector to reflect current state
  const sel = qs('#mgmt-month-sel', container);
  if (sel && sel.value !== (_selectedMonth || '')) sel.value = _selectedMonth || '';

  const body = qs('#mgmt-body', container);
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--hint)">Loading...</div>';

  // ── Data fetch ─────────────────────────────────────────────────────────────
  const monthFilter = _selectedMonth ? '&month=eq.' + _selectedMonth : '&month=is.null';
  const [contracts, allInvoices, budgets, budgetCosts, allComments] = await Promise.all([
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.asc'),
    dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    dbSelect('budget_costs', 'farm_id=eq.' + farm.id + '&financial_year=eq.' + season + '&select=*').catch(() => []),
    // Load ALL comments for this farm+season (both season-level and line-level, all months)
    dbSelect('management_comments', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*,user_profiles(full_name)&order=created_at.desc').catch(() => []),
  ]);

  // Partition comments
  const seasonComments = allComments.filter(c => !c.row_key); // no row_key = season-level note
  const lineComments   = allComments.filter(c => !!c.row_key);

  // Index line comments by row_key + month for O(1) lookup
  // key: 'rowKey|month' → array of comments
  const lineCommentMap = {};
  lineComments.forEach(c => {
    const k = (c.row_key || '') + '|' + (c.month || '');
    if (!lineCommentMap[k]) lineCommentMap[k] = [];
    lineCommentMap[k].push(c);
  });

  // ── Xero actuals ───────────────────────────────────────────────────────────
  let xeroActuals      = null; // YTD category totals { labour, overhead, rm, fund_mgmt }
  let xeroAccounts     = null; // YTD raw accounts for line-level matching
  let xeroYtdLabel     = null;
  let xeroYtdFrom      = null; // ISO date string e.g. '2026-07-01'
  let xeroYtdTo        = null; // ISO date string e.g. '2026-10-21'
  let xeroMonthActuals  = null; // Monthly category totals (null if no month selected)
  let xeroMonthAccounts = null; // Monthly raw accounts

  try {
    const xeroUrl = '/.netlify/functions/xero-pull?farm_id=' + farm.id + '&season=' + encodeURIComponent(season) +
      (_selectedMonth ? '&month=' + _selectedMonth : '');
    const xeroRes = await fetch(xeroUrl);
    if (xeroRes.ok) {
      const xeroData = await xeroRes.json();
      if (xeroData.ok) {
        xeroActuals  = xeroData.categories;
        xeroAccounts = xeroData.accounts || [];
        xeroYtdLabel = xeroData.ytd_to;
        xeroYtdFrom  = xeroData.ytd_from;
        xeroYtdTo    = xeroData.ytd_to;
        if (xeroData.month_data) {
          xeroMonthActuals  = xeroData.month_data.categories;
          xeroMonthAccounts = xeroData.month_data.accounts || [];
        }
      }
    }
  } catch (e) {
    console.log('[MgmtReport] Xero not available:', e.message);
  }

  // ── Xero line-level matcher factories ──────────────────────────────────────
  // Returns { amount, accountID, accountName } or null
  const makeLineMatcher = (accounts) => {
    if (!accounts) return () => null;
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const normAccounts = accounts.map(a => ({ ...a, _norm: norm(a.name) }));
    const mkResult = a => ({ amount: a.amount, accountID: a.accountID || '', accountName: a.name });
    return (description) => {
      const dNorm = norm(description);
      let hit = normAccounts.find(a => a._norm === dNorm);
      if (hit) return mkResult(hit);
      hit = normAccounts.find(a => a._norm.includes(dNorm) || dNorm.includes(a._norm));
      if (hit) return mkResult(hit);
      const dWords = dNorm.split(' ').filter(w => w.length > 2);
      if (dWords.length) {
        hit = normAccounts.find(a => {
          const matches = dWords.filter(w => a._norm.includes(w));
          return matches.length >= Math.ceil(dWords.length / 2);
        });
        if (hit) return mkResult(hit);
      }
      return null;
    };
  };

  const xeroLineActual      = makeLineMatcher(xeroAccounts);
  const xeroMonthLineActual = makeLineMatcher(xeroMonthAccounts);

  // ── Invoice helpers ────────────────────────────────────────────────────────
  const isPriorYearInv = inv => {
    if (!inv.batches) return false;
    const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
    return b.some(batch => batch.prior_year_income);
  };

  const seasonInvoices   = allInvoices.filter(inv => {
    if (isPriorYearInv(inv)) return false;
    if (inv.season === season) return true;
    if (inv.batches) {
      const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
      if (b.some(batch => batch.crop_year === season)) return true;
    }
    const linked = contracts.find(c => c.id === inv.forward_contract_id);
    if (linked?.crop_year === season) return true;
    return false;
  });

  const priorYearInvoices = allInvoices.filter(isPriorYearInv);

  // Filter invoices to selected month if applicable
  const monthInvoices = _selectedMonth
    ? seasonInvoices.filter(inv => {
        const d = inv.invoice_date?.slice(0, 7); // 'YYYY-MM'
        return d === _selectedMonth;
      })
    : [];

  // ── Formatters ─────────────────────────────────────────────────────────────
  const fC  = n => n != null ? formatCurrency(n, 0) : '—';
  const fN  = (n, dp = 0) => n != null && n !== 0 ? formatNumber(n, dp) : '—';

  const varCell = (actual, budget, extraStyle = '') => {
    if (budget == null || actual == null) return '<span style="color:var(--hint)">—</span>';
    const v     = actual - budget;
    const pct   = budget !== 0 ? (v / budget * 100) : null;
    const color = v >= 0 ? 'var(--green)' : 'var(--red)';
    const pctStr = pct != null ? ' <span style="font-size:10px;opacity:.8">(' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%)</span>' : '';
    return '<span style="color:' + color + ';font-weight:600' + (extraStyle ? ';' + extraStyle : '') + '">' + (v >= 0 ? '+' : '') + fC(v) + pctStr + '</span>';
  };

  // ── Invoice totals ─────────────────────────────────────────────────────────
  const invTotals = (invList, commName) => {
    let qty = 0, income = 0, qa = 0, costs = 0;
    const matchedInvs = [];
    const targetKey = commName ? commName.trim().toUpperCase().replace(/\s+/g, ' ') : null;
    const targetIsLivestock = targetKey && /cattle|livestock/i.test(targetKey);
    invList.forEach(inv => {
      const linked   = contracts.find(c => c.id === inv.forward_contract_id);
      const batchComm = (() => {
        if (!inv.batches) return '';
        const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        return b.flatMap(x => x.lines || []).find(l => l.type === 'income' && l.description)?.description || '';
      })();
      const iComm    = linked?.commodity || batchComm || (inv.line_items || [])[0]?.commodity || '';
      const iCommKey = iComm.trim().toUpperCase().replace(/\s+/g, ' ');
      if (targetKey) {
        const invoiceIsLivestock = /cattle|livestock/i.test(iComm);
        if (targetIsLivestock && invoiceIsLivestock) { /* match */ }
        else if (iCommKey !== targetKey) return;
      }
      matchedInvs.push(inv);
      if (inv.batches) {
        const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        qty += b.filter(x => (x.lines || []).some(l => l.type === 'income' && l.line_type !== 'qa'))
                 .reduce((s, x) => s + (parseFloat(x.qty) || 0), 0);
      } else {
        qty += parseFloat(inv.total_qty) || 0;
      }
      income += parseFloat(inv.gross_amount)      || 0;
      qa     += parseFloat(inv.total_quality_adj) || 0;
      costs  += parseFloat(inv.total_deductions)  || 0;
    });
    return { qty, income, qa, totalIncome: income + qa, costs, avgPrice: qty ? (income + qa) / qty : null, invoices: matchedInvs };
  };

  // ── Budget groups ──────────────────────────────────────────────────────────
  const groups = {};
  budgets.forEach(b => {
    if (!b.commodity) return;
    const key = b.commodity.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!groups[key]) groups[key] = { name: b.commodity.trim(), budgets: [] };
    groups[key].budgets.push(b);
  });
  priorYearInvoices.forEach(inv => {
    const batches  = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
    const commName = batches.flatMap(b => b.lines || []).find(l => l.type === 'income' && l.description)?.description
      || (inv.line_items || [])[0]?.commodity || null;
    if (!commName) return;
    const key = commName.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!groups[key]) groups[key] = { name: commName.trim(), budgets: [] };
  });

  const bField = (b, plain, prefixed) => parseFloat(b[prefixed] ?? b[plain]) || 0;

  const budgetForGroup = (g, opts = {}) => {
    if (!g.budgets.length) return { bIncome: null, bYTD: null, bMonth: null, bArea: null, bYield: null, bProd: null, bPrice: null };
    if (opts.carryOver) {
      const bIncome = g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue) || bField(b, 'price', 'budgeted_price') * (parseFloat(b.budgeted_production) || bField(b, 'yield_per_ha', 'budgeted_yield_per_ha') * (parseFloat(b.area_ha) || 0)) || 0), 0) || null;
      return { bIncome, bYTD: bIncome != null ? bIncome * ytdFraction : null, bMonth: bIncome != null ? bIncome / 12 : null, bArea: null, bYield: null, bProd: null, bPrice: null };
    }
    const bArea   = g.budgets.reduce((s, b) => s + (parseFloat(b.area_ha) || 0), 0);
    const bYield  = bArea
      ? g.budgets.reduce((s, b) => s + bField(b, 'yield_per_ha', 'budgeted_yield_per_ha') * (parseFloat(b.area_ha) || 0), 0) / bArea
      : 0;
    const bProd   = bArea && bYield ? Math.round(bArea * bYield) : g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_production) || 0), 0) || null;
    const bPrice  = g.budgets.reduce((s, b) => s + bField(b, 'price', 'budgeted_price'), 0) / g.budgets.length;
    const bIncome = (bProd && bPrice) ? bProd * bPrice : g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue) || 0), 0) || null;
    return {
      bIncome,
      bYTD:   bIncome != null ? bIncome * ytdFraction : null,
      bMonth: bIncome != null ? bIncome / 12 : null,
      bArea, bYield, bProd, bPrice,
    };
  };

  // ── Table styles (7 columns) ───────────────────────────────────────────────
  const COLS = _selectedMonth ? 7 : 5; // extra 2 cols when month selected
  const th   = 'padding:7px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);border-bottom:2px solid var(--border);white-space:nowrap';
  const thR  = th + ';text-align:right';
  const td   = 'padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border-light)';
  const tdR  = td + ';text-align:right;font-variant-numeric:tabular-nums';

  const secRow  = label => '<tr style="background:#1e3a5f"><td colspan="' + COLS + '" style="padding:7px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:white">' + label + '</td></tr>';
  const commRow = label => '<tr style="background:#e8f0fe"><td colspan="' + COLS + '" style="padding:5px 12px;font-size:11px;font-weight:600;color:#1e3a5f">' + label + '</td></tr>';

  // ── Line comment helpers ───────────────────────────────────────────────────
  // Get comments for a given row_key + current selected month
  const getLineComments = (rowKey) => {
    const k = rowKey + '|' + (_selectedMonth || '');
    return lineCommentMap[k] || [];
  };

  // Render inline comment bubble for a row (shown as a small chip after the description)
  const commentChip = (rowKey) => {
    if (!canWrite()) return '';
    const comments = getLineComments(rowKey);
    const count    = comments.length;
    const tip      = comments.length
      ? comments.map(c => (c.user_profiles?.full_name || 'User') + ' (' + formatDate(c.created_at?.slice(0, 10)) + '): ' + c.comment).join('\n')
      : 'Add comment for this line';
    const badge = count
      ? '<span style="background:#dbeafe;color:#1d4ed8;border-radius:10px;padding:1px 6px;font-size:10px;font-weight:600;cursor:pointer" title="' + tip.replace(/"/g, '&quot;') + '" onclick="event.stopPropagation();window._mgmtLineComment(\'' + rowKey.replace(/'/g, "\\'") + '\')">' + count + ' 💬</span>'
      : '<span style="background:none;border:1px solid var(--border);border-radius:10px;padding:1px 6px;font-size:10px;color:var(--hint);cursor:pointer;opacity:.5" title="Add comment" onclick="event.stopPropagation();window._mgmtLineComment(\'' + rowKey.replace(/'/g, "\\'") + '\')">+ 💬</span>';
    return ' ' + badge;
  };

  // ── Commodity row builder ──────────────────────────────────────────────────
  let grandBudget = 0, grandBudgetYTD = 0, grandActual = 0, grandActualMonth = 0, grandBudgetMonth = 0;

  const isCattle    = name => /cattle|livestock/i.test(name);
  const isOther     = name => !isCattle(name) && /agistment|interest received|rent|lease|royalt/i.test(name);
  const isCarryOver = name => !isCattle(name) && !isOther(name) && name !== name.toUpperCase();

  const buildCommRow = (g, opts = {}) => {
    const { bIncome, bYTD, bMonth, bArea, bYield, bProd, bPrice } = budgetForGroup(g, { carryOver: opts.carryOver });
    const invSource = opts.carryOver ? priorYearInvoices : seasonInvoices;
    const inv       = invTotals(invSource, g.name);
    const invMonth  = _selectedMonth ? invTotals(monthInvoices, g.name) : null;
    const unit      = g.budgets[0]?.unit || contracts.find(c => c.commodity?.toUpperCase() === g.name.toUpperCase())?.unit || 't';
    const isLs      = isCattle(g.name);

    let lsHead = 0, lsKg = 0, lsIncome = 0;
    if (isLs) {
      inv.invoices.forEach(i => {
        lsHead   += parseFloat(i.total_head)   || 0;
        lsKg     += parseFloat(i.total_weight) || 0;
        lsIncome += (parseFloat(i.gross_amount) || 0) + (parseFloat(i.total_quality_adj) || 0);
      });
    }

    const modalData = {
      name: g.name, unit, isLs, carryOver: !!opts.carryOver,
      bIncome, bYTD, bArea, bYield, bProd, bPrice,
      lsHead, lsKg, lsIncome,
      invoices: inv.invoices.map(i => {
        let qty = 0;
        if (i.batches) {
          const b = typeof i.batches === 'string' ? JSON.parse(i.batches) : i.batches;
          qty = b.filter(x => (x.lines || []).some(l => l.type === 'income' && l.line_type !== 'qa'))
                  .reduce((s, x) => s + (parseFloat(x.qty) || 0), 0);
        } else { qty = parseFloat(i.total_qty) || 0; }
        const inc = (parseFloat(i.gross_amount) || 0) + (parseFloat(i.total_quality_adj) || 0);
        return { id: i.id, date: i.invoice_date?.slice(0, 10), buyer: i.buyer, qty, inc, price: (qty && inc) ? inc / qty : null };
      }),
    };
    const dataAttr  = JSON.stringify(modalData).replace(/"/g, '&quot;');
    const rowKey    = 'income:' + g.name;

    const actualYTD   = inv.totalIncome;
    const actualMonth = invMonth ? invMonth.totalIncome : null;

    const monthCols = _selectedMonth ? `
        <td style="${tdR};color:${actualMonth ? 'var(--green)' : 'var(--hint)'};font-weight:600">${actualMonth ? fC(actualMonth) : '—'}</td>
        <td style="${tdR}">${bMonth != null ? fC(bMonth) : '—'}</td>` : '';

    const html = `
      <tr style="cursor:pointer;transition:background .1s" onmouseenter="this.style.background='#f8fafc'" onmouseleave="this.style.background=''"
          onclick="window._mgmtOpenModal(JSON.parse(this.dataset.modal))" data-modal="${dataAttr}">
        <td style="${td};font-weight:500;padding-left:16px;color:var(--ink)">
          ${g.name}
          ${inv.invoices.length ? '<span style="font-size:10px;color:var(--hint);margin-left:8px;font-weight:400">' + inv.invoices.length + ' invoice' + (inv.invoices.length !== 1 ? 's' : '') + '</span>' : ''}
          <span style="font-size:10px;color:var(--hint);margin-left:4px">↗</span>
          ${commentChip(rowKey)}
        </td>
        ${monthCols}
        <td style="${tdR};color:${actualYTD ? 'var(--green)' : 'var(--hint)'};font-weight:600">${actualYTD ? fC(actualYTD) : '—'}</td>
        <td style="${tdR}">${actualYTD && bYTD != null ? fC(bYTD) : '—'}</td>
        <td style="${tdR}">${actualYTD ? varCell(actualYTD, bYTD) : '<span style="color:var(--hint)">—</span>'}</td>
        <td style="${tdR}">${bIncome != null ? fC(bIncome) : '—'}</td>
      </tr>
    `;

    return { html, bIncome: bIncome || 0, bYTD: bYTD || 0, bMonth: bMonth || 0, actual: actualYTD, actualMonth: actualMonth || 0 };
  };

  // ── Section builder ────────────────────────────────────────────────────────
  const buildSection = (label, gList, opts = {}) => {
    if (!gList.length) return '';
    let secBudget = 0, secBudgetYTD = 0, secBudgetMonth = 0, secActual = 0, secActualMonth = 0;
    const rowsHtml = gList.map(g => {
      const r = buildCommRow(g, { carryOver: opts.carryOver });
      secBudget       += r.bIncome;
      secBudgetYTD    += r.bYTD;
      secBudgetMonth  += r.bMonth;
      secActual       += r.actual;
      secActualMonth  += r.actualMonth;
      return r.html;
    }).join('');
    grandBudget       += secBudget;
    grandBudgetYTD    += secBudgetYTD;
    grandBudgetMonth  += secBudgetMonth;
    grandActual       += secActual;
    grandActualMonth  += secActualMonth;

    const monthSubtotalCols = _selectedMonth ? `
        <td style="${tdR};color:var(--green);font-weight:600">${secActualMonth ? fC(secActualMonth) : '—'}</td>
        <td style="${tdR};font-weight:600">${secActualMonth && secBudgetMonth ? fC(secBudgetMonth) : '—'}</td>` : '';

    const subtotal = `
      <tr style="background:#f0f4f8">
        <td style="${td};font-weight:600;font-size:11px;padding-left:16px;color:var(--hint)">${label} total</td>
        ${monthSubtotalCols}
        <td style="${tdR};color:var(--green);font-weight:600">${secActual ? fC(secActual) : '—'}</td>
        <td style="${tdR};font-weight:600">${secActual && secBudgetYTD ? fC(secBudgetYTD) : '—'}</td>
        <td style="${tdR}">${secActual ? varCell(secActual, secBudgetYTD) : '<span style="color:var(--hint)">—</span>'}</td>
        <td style="${tdR};font-weight:600">${secBudget ? fC(secBudget) : '—'}</td>
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

  // ── Fixed costs ────────────────────────────────────────────────────────────
  const fixedCats = [
    { key: 'labour',    label: 'Labour & Farm Management' },
    { key: 'overhead',  label: 'Overheads' },
    { key: 'rm',        label: 'Repairs & Maintenance' },
    { key: 'fund_mgmt', label: 'Fund Management' },
  ];

  let totalFixedBudget = 0;
  let totalFixedActual = 0;       // YTD Xero actuals
  let totalFixedActualMonth = 0;  // Monthly Xero actuals

  const fixedRows = fixedCats.map(cat => {
    const lines = budgetCosts.filter(c => c.category === cat.key);
    if (!lines.length) return '';
    const catTotal  = lines.reduce((s, c) => s + (parseFloat(c.budget_amount) || 0), 0);
    totalFixedBudget += catTotal;

    const catActual      = xeroActuals  ? (xeroActuals[cat.key]  || 0) : null;
    const catActualMonth = xeroMonthActuals ? (xeroMonthActuals[cat.key] || 0) : null;
    if (catActual !== null) totalFixedActual += catActual;
    if (catActualMonth !== null) totalFixedActualMonth += catActualMonth;

    const catYTD      = catTotal * ytdFraction;
    const catVariance = catActual !== null ? catYTD - catActual : null;
    const varStyle    = catVariance !== null ? (catVariance >= 0 ? 'color:var(--green)' : 'color:var(--red)') : '';

    const lineRowsHtml = lines.map(c => {
      const amt            = parseFloat(c.budget_amount) || 0;
      const amtYTD         = amt * ytdFraction;
      const amtMonth       = amt / 12;
      const lineActMatch   = xeroLineActual(c.description);      // { amount, accountID, accountName } | null
      const lineActMoMatch = xeroMonthLineActual(c.description); // { amount, accountID, accountName } | null
      const lineAct        = lineActMatch?.amount   ?? null;
      const lineActMonth   = lineActMoMatch?.amount ?? null;
      const lineAccountID  = lineActMatch?.accountID   || lineActMoMatch?.accountID || '';
      const lineAcctName   = lineActMatch?.accountName || c.description;
      const lineVar      = lineAct !== null ? amtYTD - lineAct : null;
      const lineVarStyle = lineVar !== null ? (lineVar >= 0 ? 'color:var(--green)' : 'color:var(--red)') : '';
      const lineVarPct   = lineVar !== null && amtYTD ? lineVar / amtYTD * 100 : null;
      const lineVarLabel = lineVar !== null
        ? (lineVar >= 0 ? '+' : '') + fC(lineVar) + (lineVarPct !== null ? ' (' + (lineVarPct >= 0 ? '+' : '') + lineVarPct.toFixed(0) + '%)' : '')
        : '—';

      const rowKey        = 'cost:' + cat.key + ':' + c.description;
      // Show drilldown whenever we have a Xero actual — use accountID if available, fall back to name-based lookup
      const canDrill      = lineAct !== null;
      const drillClick    = canDrill
        ? 'onclick="window._mgmtXeroTxns(\'' + farm.id + '\',\'' + lineAccountID.replace(/'/g, '') + '\',\'' + lineAcctName.replace(/'/g, '') + '\',\'' + (xeroYtdFrom || '') + '\',\'' + (xeroYtdTo || '') + '\')"'
        : '';
      const drillTitle    = canDrill ? ' title="Click to see Xero transactions"' : '';

      const monthLineCols  = _selectedMonth ? `
          <td style="${tdR};color:var(--red);font-size:11px">${lineActMonth !== null ? '-' + fC(lineActMonth) : '—'}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amtMonth)}</td>` : '';

      return `
        <tr${drillTitle}>
          <td style="${td};padding-left:28px;font-size:11px;color:var(--hint)">
            ${c.description}${commentChip(rowKey)}
          </td>
          ${monthLineCols}
          <td style="${tdR};color:var(--red);font-size:11px">${canDrill ? '<span ' + drillClick + ' style="cursor:pointer;text-decoration:underline;text-underline-offset:2px">-' + fC(lineAct) + '</span>' : (lineAct !== null ? '-' + fC(lineAct) : '—')}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amtYTD)}</td>
          <td style="${tdR};font-size:11px">${lineVar !== null ? '<span style="' + lineVarStyle + ';font-weight:600">' + lineVarLabel + '</span>' : '—'}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amt)}</td>
        </tr>`;
    }).join('');

    const catYTDV        = catVariance;
    const catVarPct      = catYTDV !== null && catYTD ? catYTDV / catYTD * 100 : null;
    const catVarLabel    = catYTDV !== null
      ? (catYTDV >= 0 ? '+' : '') + fC(catYTDV) + (catVarPct !== null ? ' (' + (catVarPct >= 0 ? '+' : '') + catVarPct.toFixed(0) + '%)' : '')
      : '—';

    const catMonthCols = _selectedMonth ? `
          <td style="${tdR};color:var(--red);font-weight:600">${catActualMonth !== null ? '-' + fC(catActualMonth) : '—'}</td>
          <td style="${tdR};color:var(--red);font-weight:600">-${fC(catTotal / 12)}</td>` : '';

    const catTotalRow = `
      <tr style="background:var(--page-bg)">
        <td style="${td};padding-left:20px;font-weight:600;font-size:12px">${cat.label} total${commentChip('cat:' + cat.key)}</td>
        ${catMonthCols}
        <td style="${tdR};color:var(--red);font-weight:600">${catActual !== null ? '-' + fC(catActual) : '—'}</td>
        <td style="${tdR};color:var(--red);font-weight:600">-${fC(catYTD)}</td>
        <td style="${tdR};font-weight:600">${catVariance !== null ? '<span style="' + varStyle + ';font-weight:600">' + catVarLabel + '</span>' : '—'}</td>
        <td style="${tdR};color:var(--red);font-weight:600">-${fC(catTotal)}</td>
      </tr>`;

    return commRow(cat.label) + lineRowsHtml + catTotalRow;
  }).join('');

  // ── CAPEX ──────────────────────────────────────────────────────────────────
  const capexCosts = budgetCosts.filter(c => c.category === 'capex');
  const capexByCode = new Map();
  for (const c of capexCosts) {
    const subcat = (c.subcategory || '').trim();
    const code   = (c.budget_code  || '').trim();
    const key    = subcat || code || c.description || 'UNALLOCATED';
    if (!capexByCode.has(key)) capexByCode.set(key, { code: code || subcat || 'CAPEX', subcategory: subcat, items: [], total: 0 });
    const entry = capexByCode.get(key);
    entry.items.push(c);
    entry.total += parseFloat(c.budget_amount) || 0;
  }

  let totalCapexBudget = 0;
  const capexRows = [...capexByCode.values()].map(entry => {
    const amt    = Math.abs(entry.total);
    const isSale = entry.total < 0;
    totalCapexBudget += entry.total;
    const modalData = JSON.stringify({ code: entry.code, subcategory: entry.subcategory || 'Capital Expenditure', items: entry.items.map(i => ({ desc: i.description, amt: parseFloat(i.budget_amount) || 0, notes: i.notes })) }).replace(/"/g, '&quot;');
    const rowKey = 'capex:' + entry.code;

    const monthCapexCols = _selectedMonth ? `
        <td style="${tdR};color:var(--hint)">—</td>
        <td style="${tdR};font-size:12px;color:${isSale ? 'var(--green)' : 'var(--red)'}">
          ${isSale ? '+' : '-'}${fC(amt / 12)}
        </td>` : '';

    return `
      <tr style="cursor:pointer" data-capex-modal="${modalData}" title="Click to see budget items">
        <td style="${td};padding-left:28px">
          <span style="font-size:12px;color:var(--ink)">${entry.code}</span>
          <span style="font-size:10px;color:var(--hint);margin-left:6px">${entry.subcategory || ''}</span>
          <span style="font-size:10px;color:var(--blue);margin-left:6px">↗ ${entry.items.length} item${entry.items.length !== 1 ? 's' : ''}</span>
          ${commentChip(rowKey)}
        </td>
        ${monthCapexCols}
        <td style="${tdR};color:var(--hint)">—</td>
        <td style="${tdR};font-size:12px;color:${isSale ? 'var(--green)' : 'var(--red)'}">
          ${isSale ? '+' : '-'}${fC(amt * ytdFraction)}
        </td>
        <td style="${tdR}">—</td>
        <td style="${tdR};font-size:12px;color:${isSale ? 'var(--green)' : 'var(--red)'}">
          ${isSale ? '+' : '-'}${fC(amt)}
        </td>
      </tr>`;
  }).join('');

  // ── Pre-compute HTML blocks (avoid ESM nested-template-literal parse issues)
  const xeroActualsNote = xeroActuals
    ? '· Fixed cost actuals from Xero to ' + formatDate(xeroYtdLabel) + '.'
    : '· Fixed cost actuals not yet available (connect Xero in Farm Settings to enable).';

  // Fixed costs section
  let fixedCostsSectionHtml = '';
  if (fixedRows.trim()) {
    const fv     = (totalFixedBudget * ytdFraction) - totalFixedActual;
    const fpct   = totalFixedBudget * ytdFraction ? fv / (totalFixedBudget * ytdFraction) * 100 : null;
    const fpctStr = fpct != null ? ' (' + (fpct >= 0 ? '+' : '') + fpct.toFixed(0) + '%)' : '';
    const fvarHtml = xeroActuals
      ? '<span style="color:' + (fv >= 0 ? 'var(--green)' : 'var(--red)') + ';font-weight:700">' + (fv >= 0 ? '+' : '') + fC(fv) + fpctStr + '</span>'
      : '—';
    const xeroSpan  = xeroActuals ? ' <span style="font-size:10px;font-weight:400;color:var(--hint)">(Xero actuals)</span>' : '';
    const totalFixed = '<tr style="background:#fff5f5;border-top:2px solid var(--border)">' +
      '<td style="' + td + ';font-weight:700">Total fixed costs' + xeroSpan + '</td>' +
      (_selectedMonth ? '<td style="' + tdR + ';color:var(--red);font-weight:700">' + (xeroMonthActuals ? '-' + fC(totalFixedActualMonth) : '—') + '</td>' +
        '<td style="' + tdR + ';color:var(--red);font-weight:700">-' + fC(totalFixedBudget / 12) + '</td>' : '') +
      '<td style="' + tdR + ';color:var(--red);font-weight:700">' + (xeroActuals ? '-' + fC(totalFixedActual) : '—') + '</td>' +
      '<td style="' + tdR + ';color:var(--red);font-weight:700">-' + fC(totalFixedBudget * ytdFraction) + '</td>' +
      '<td style="' + tdR + ';font-weight:700">' + fvarHtml + '</td>' +
      '<td style="' + tdR + ';color:var(--red);font-weight:700">-' + fC(totalFixedBudget) + '</td>' +
      '</tr>';
    fixedCostsSectionHtml = secRow('Fixed costs') + fixedRows + totalFixed;
  }

  // CAPEX section
  let capexSectionHtml = '';
  if (capexRows.trim()) {
    const capexMonthTotals = _selectedMonth
      ? '<td style="' + tdR + ';color:var(--hint)">—</td><td style="' + tdR + ';color:var(--red);font-weight:700">-' + fC(Math.abs(totalCapexBudget) / 12) + '</td>'
      : '';
    capexSectionHtml = secRow('Capital expenditure') + capexRows +
      '<tr style="background:#fff5f5;border-top:2px solid var(--border)">' +
      '<td style="' + td + ';font-weight:700">Total capex</td>' +
      capexMonthTotals +
      '<td style="' + tdR + ';color:var(--hint)">—</td>' +
      '<td style="' + tdR + ';color:var(--red);font-weight:700">-' + fC(Math.abs(totalCapexBudget) * ytdFraction) + '</td>' +
      '<td style="' + tdR + ';color:var(--hint)">—</td>' +
      '<td style="' + tdR + ';color:var(--red);font-weight:700">-' + fC(Math.abs(totalCapexBudget)) + '</td>' +
      '</tr>';
  }

  // Net income row
  const budgetNetYTD  = grandBudgetYTD - totalFixedBudget * ytdFraction - Math.abs(totalCapexBudget) * ytdFraction;
  const budgetNetFY   = grandBudget    - totalFixedBudget                - Math.abs(totalCapexBudget);
  const budgetNetMonth = grandBudgetMonth - totalFixedBudget / 12        - Math.abs(totalCapexBudget) / 12;
  const actualNet     = xeroActuals ? grandActual - totalFixedActual : null;
  const actualNetMonth = xeroMonthActuals ? grandActualMonth - totalFixedActualMonth : null;
  const netVariance   = actualNet !== null ? actualNet - budgetNetYTD : null;
  const netLabel      = xeroActuals ? 'Net income (Xero costs YTD)' : 'Net income (budget)';

  let nvHtml = '—';
  if (netVariance !== null) {
    const nvpct   = budgetNetYTD ? netVariance / budgetNetYTD * 100 : null;
    const nvpctStr = nvpct != null ? ' (' + (nvpct >= 0 ? '+' : '') + nvpct.toFixed(0) + '%)' : '';
    nvHtml = '<span style="color:' + (netVariance >= 0 ? 'var(--green)' : 'var(--red)') + ';font-weight:700">' + (netVariance >= 0 ? '+' : '') + fC(netVariance) + nvpctStr + '</span>';
  }

  const netMonthCols = _selectedMonth
    ? '<td style="' + tdR + ';font-weight:700;color:var(--blue)">' + (actualNetMonth !== null ? fC(actualNetMonth) : '—') + '</td>' +
      '<td style="' + tdR + ';font-weight:700;color:var(--blue)">' + fC(budgetNetMonth) + '</td>'
    : '';

  const netIncomeRowWithCosts = '<tr style="background:#eff6ff;border-top:2px solid var(--border)">' +
    '<td style="' + td + ';font-weight:700;font-size:13px;color:var(--blue)">' + netLabel + '</td>' +
    netMonthCols +
    '<td style="' + tdR + ';font-weight:700;color:var(--blue)">' + (actualNet !== null ? fC(actualNet) : '—') + '</td>' +
    '<td style="' + tdR + ';font-weight:700;color:var(--blue)">' + fC(budgetNetYTD) + '</td>' +
    '<td style="' + tdR + ';font-weight:700">' + nvHtml + '</td>' +
    '<td style="' + tdR + ';font-weight:700;color:var(--blue)">' + fC(budgetNetFY) + '</td>' +
    '</tr>';

  const incomeOnlyMonthCols = _selectedMonth
    ? '<td style="' + tdR + ';color:var(--blue);font-weight:700;font-size:13px">' + fC(grandActualMonth) + '</td>' +
      '<td style="' + tdR + ';font-weight:700">' + fC(grandBudgetMonth) + '</td>'
    : '';
  const netIncomeRowIncomeOnly = '<tr style="background:#eff6ff;border-top:2px solid var(--border)">' +
    '<td style="' + td + ';font-weight:700;font-size:13px;color:var(--blue)">Net income (income only)</td>' +
    incomeOnlyMonthCols +
    '<td style="' + tdR + ';color:' + (grandActual ? 'var(--blue)' : 'var(--hint)') + ';font-weight:700;font-size:13px">' + (grandActual ? fC(grandActual) : '—') + '</td>' +
    '<td style="' + tdR + ';font-weight:700">' + fC(grandBudgetYTD) + '</td>' +
    '<td style="' + tdR + '">' + varCell(grandActual, grandBudgetYTD) + '</td>' +
    '<td style="' + tdR + ';font-weight:700">' + fC(grandBudget) + '</td>' +
    '</tr>';

  const costsAndNetHtml = budgetCosts.length
    ? fixedCostsSectionHtml + capexSectionHtml + netIncomeRowWithCosts
    : netIncomeRowIncomeOnly;

  // ── Income total row ───────────────────────────────────────────────────────
  const incomeTotalMonthCols = _selectedMonth
    ? '<td style="' + tdR + ';color:var(--green);font-weight:700;font-size:13px">' + fC(grandActualMonth) + '</td>' +
      '<td style="' + tdR + ';font-weight:700">' + fC(grandBudgetMonth) + '</td>'
    : '';

  // ── Summary tiles ──────────────────────────────────────────────────────────
  const tiles = _selectedMonth
    ? [
        ['Actual month income',  fC(grandActualMonth),  'var(--green)'],
        ['Budget month income',  fC(grandBudgetMonth),  'var(--ink)'],
        ['Actual YTD income',    fC(grandActual),       'var(--green)'],
        ['Budget YTD income',    fC(grandBudgetYTD),    'var(--ink)'],
        ['Full year budget',     fC(grandBudget),       'var(--blue)'],
        ['YTD variance', (() => {
          const v = grandActual - grandBudgetYTD;
          const pct = grandBudgetYTD ? v / grandBudgetYTD * 100 : null;
          return (v >= 0 ? '+' : '') + fC(v) + (pct != null ? ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%)' : '');
        })(), grandActual - grandBudgetYTD >= 0 ? 'var(--green)' : 'var(--red)'],
      ]
    : [
        ['Actual YTD income',  fC(grandActual),    'var(--green)'],
        ['Budget YTD income',  fC(grandBudgetYTD), 'var(--ink)'],
        ['Full year budget',   fC(grandBudget),    'var(--blue)'],
        ['YTD variance', (() => {
          const v = grandActual - grandBudgetYTD;
          const pct = grandBudgetYTD ? v / grandBudgetYTD * 100 : null;
          return (v >= 0 ? '+' : '') + fC(v) + (pct != null ? ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%)' : '');
        })(), grandActual - grandBudgetYTD >= 0 ? 'var(--green)' : 'var(--red)'],
      ];

  const tileGrid = tiles.map(([l, v, c]) =>
    '<div style="background:white;border:1px solid var(--border);border-radius:8px;padding:12px 14px">' +
    '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">' + l + '</div>' +
    '<div style="font-size:20px;font-weight:700;color:' + c + '">' + v + '</div>' +
    '</div>'
  ).join('');

  const tileCols = _selectedMonth ? 'repeat(3,1fr)' : 'repeat(4,1fr)';

  // ── Table headers ──────────────────────────────────────────────────────────
  const monthHeaders = _selectedMonth
    ? '<th style="' + thR + '">Actual ' + (selectedMonthLabel ? selectedMonthLabel.split(' ')[0] : 'Month') + '</th>' +
      '<th style="' + thR + '">Budget ' + (selectedMonthLabel ? selectedMonthLabel.split(' ')[0] : 'Month') + '</th>'
    : '';

  // ── Season-level comment rows ──────────────────────────────────────────────
  const commentRows = seasonComments.length
    ? seasonComments.map(c => `
        <tr>
          <td style="${td};color:var(--hint);font-size:11px;white-space:nowrap;width:90px">${formatDate(c.created_at?.slice(0, 10))}</td>
          <td style="${td};font-size:11px;color:var(--hint);white-space:nowrap;width:130px">${c.user_profiles?.full_name || 'User'}</td>
          <td style="${td};font-size:12px" colspan="3">${c.comment}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" style="' + td + ';color:var(--hint);font-style:italic">No season notes yet</td></tr>';

  // ── Render ─────────────────────────────────────────────────────────────────
  body.innerHTML = `
    <!-- Summary tiles -->
    <div style="display:grid;grid-template-columns:${tileCols};gap:8px;margin-bottom:20px">
      ${tileGrid}
    </div>

    <!-- Info note -->
    <div style="font-size:11px;color:var(--hint);margin-bottom:12px;font-style:italic">
      ℹ Budget YTD is pro-rated (${ytdMonths} of 12 months from ${new Date(seasonYear, seasonStartMonthIdx).toLocaleString('en-AU', { month: 'long' })}).
      ${_selectedMonth ? 'Monthly budget = 1/12 of annual. ' : ''}
      Click any income row ↗ for detail. Click 💬 to add or view line comments.
      ${xeroActualsNote}
    </div>

    <!-- Main table -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:${_selectedMonth ? '1050px' : '800px'}">
          <thead>
            <tr>
              <th style="${th};text-align:left;min-width:220px"></th>
              ${monthHeaders}
              <th style="${thR}">Actual YTD</th>
              <th style="${thR}">Budget YTD</th>
              <th style="${thR}">Variance YTD</th>
              <th style="${thR}">Full yr budget</th>
            </tr>
          </thead>
          <tbody>
            ${incomeRows || '<tr><td colspan="' + COLS + '" style="' + td + ';color:var(--hint);font-style:italic;padding-left:20px">No income budgets or invoices for this season</td></tr>'}

            <!-- Income total -->
            <tr style="background:#f0fdf4;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700">Total income</td>
              ${incomeTotalMonthCols}
              <td style="${tdR};color:${grandActual ? 'var(--green)' : 'var(--hint)'};font-weight:700;font-size:13px">${grandActual ? fC(grandActual) : '—'}</td>
              <td style="${tdR};font-weight:700">${fC(grandBudgetYTD)}</td>
              <td style="${tdR}">${varCell(grandActual, grandBudgetYTD)}</td>
              <td style="${tdR};font-weight:700">${fC(grandBudget)}</td>
            </tr>

            ${costsAndNetHtml}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Season notes (season-level comments, no row_key) -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <div style="padding:10px 16px;background:var(--page-bg);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;font-weight:600">Season notes</span>
        <span style="font-size:11px;color:var(--hint)">${seasonComments.length} note${seasonComments.length !== 1 ? 's' : ''}</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${commentRows}</tbody>
      </table>
    </div>
  `;

  // Delegated click handler for CAPEX drilldown rows
  body.addEventListener('click', e => {
    const row = e.target.closest('[data-capex-modal]');
    if (row) window._mgmtOpenCapexModal(row.dataset.capexModal);
  });
}

// ── Commodity detail modal ─────────────────────────────────────────────────────
window._mgmtOpenModal = function(d) {
  const fC = v => v == null ? '—' : v.toLocaleString('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const fN = (v, dp = 0) => v == null ? '—' : v.toLocaleString('en-AU', { minimumFractionDigits: dp, maximumFractionDigits: dp });

  const stat = (label, value, sub = '', color = 'var(--ink)') => `
    <div style="padding:12px 16px;border-right:0.5px solid var(--border-light)">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color}">${value}</div>
      ${sub ? '<div style="font-size:10px;color:var(--hint);margin-top:2px">' + sub + '</div>' : ''}
    </div>`;

  const sectionHdr = label => `<div style="padding:8px 18px;background:var(--page-bg);border-bottom:1px solid var(--border);border-top:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">${label}</div>`;

  const totalQty = d.invoices.reduce((s, i) => s + (i.qty || 0), 0);
  const totalInc = d.invoices.reduce((s, i) => s + (i.inc || 0), 0);
  const avgPrice = (totalQty && totalInc) ? totalInc / totalQty : null;

  const budgetSection = d.isLs ? '' : d.carryOver ? `
    ${sectionHdr('Actual')}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border)">
      ${stat('Qty sold',  totalQty ? fN(totalQty, 2) + ' ' + d.unit : '—')}
      ${stat('Avg price', avgPrice ? '$' + fN(avgPrice, 2) + '/' + d.unit : '—')}
      ${stat('Total',     totalInc ? fC(totalInc) : '—', '', '#16a34a')}
    </div>` : `
    ${sectionHdr('Budget')}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--border)">
      ${stat('Area',       d.bArea  != null ? fN(d.bArea, 1) + ' ha'                     : '—')}
      ${stat('Production', d.bProd  != null ? fN(d.bProd)   + ' ' + d.unit               : '—')}
      ${stat('Yield',      d.bYield != null && d.bYield ? fN(d.bYield, 2) + ' ' + d.unit + '/ha' : '—')}
      ${stat('Price',      d.bPrice != null && d.bPrice ? '$' + fN(d.bPrice, 2) + '/' + d.unit   : '—')}
    </div>`;

  const lsSection = !d.isLs ? '' : `
    ${sectionHdr('Livestock actuals')}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--border)">
      ${stat('Head sold',     d.lsHead ? fN(d.lsHead, 0)  + ' hd'                              : '—')}
      ${stat('Total weight',  d.lsKg   ? fN(d.lsKg, 0)   + ' kg'                              : '—')}
      ${stat('Avg weight/hd', d.lsKg && d.lsHead   ? fN(d.lsKg / d.lsHead, 0) + ' kg'         : '—')}
      ${stat('Price/kg',      d.lsKg && d.lsIncome ? '$' + fN(d.lsIncome / d.lsKg, 2) + '/kg' : '—', '', '#16a34a')}
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
          ${d.invoices.map(i => '<tr style="border-bottom:0.5px solid var(--border-light)">' +
            '<td style="padding:5px 8px;color:var(--ink)">' + (i.date ? new Date(i.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—') + (i.buyer ? ' · ' + i.buyer : '') + '</td>' +
            '<td style="padding:5px 8px;text-align:right;color:var(--hint)">' + (i.qty ? fN(i.qty, 2) + ' ' + d.unit : '—') + '</td>' +
            '<td style="padding:5px 8px;text-align:right;color:var(--hint)">' + (i.price ? '$' + fN(i.price, 2) + '/' + d.unit : '—') + '</td>' +
            '<td style="padding:5px 8px;text-align:right;color:#16a34a;font-weight:600">' + fC(i.inc) + '</td>' +
            '<td style="padding:5px 8px;text-align:center"><button onclick="window._mgmtOpenInvoice(\'' + i.id + '\')" title="Open invoice" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer;color:var(--blue);line-height:1.4">↗</button></td>' +
            '</tr>').join('')}
        </tbody>
      </table>
    </div>` : sectionHdr('Invoices') + '<div style="padding:12px 18px;font-size:11px;color:var(--hint);font-style:italic">No invoices this season</div>';

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

// ── CAPEX drilldown modal ──────────────────────────────────────────────────────
window._mgmtOpenCapexModal = function(dataStr) {
  const fC = v => v == null ? '—' : Math.abs(v).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  let d;
  try { d = JSON.parse(dataStr); } catch (e) { console.error('[CAPEX modal] parse error:', e, dataStr); return; }

  const totalAmt = d.items.reduce((s, i) => s + (i.amt || 0), 0);
  const isSale   = totalAmt < 0;
  const rows = d.items.map(item => {
    const itemIsSale = item.amt < 0;
    return '<tr style="border-bottom:0.5px solid var(--border-light,#eee)">' +
      '<td style="padding:8px 18px;font-size:12px;color:var(--ink)">' + item.desc + '</td>' +
      '<td style="padding:8px 18px;text-align:right;font-size:12px;font-weight:600;color:' + (itemIsSale ? '#16a34a' : 'var(--red,#dc2626)') + '">' + (itemIsSale ? '+' : '-') + fC(item.amt) + '</td>' +
      '<td style="padding:8px 18px;font-size:11px;color:var(--hint)">' + (item.notes || '') + '</td>' +
      '</tr>';
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

// ── Line-level comment modal ───────────────────────────────────────────────────
window._mgmtLineComment = async function(rowKey) {
  const farm    = getActiveFarm();
  const season  = getActiveSeason();
  const session = getSession();
  if (!farm || !season) return;

  // Load existing comments for this row_key + selected month
  let existing = [];
  try {
    const monthFilter = _selectedMonth ? '&month=eq.' + _selectedMonth : '&month=is.null';
    existing = await dbSelect(
      'management_comments',
      'farm_id=eq.' + farm.id + '&season=eq.' + season + '&row_key=eq.' + encodeURIComponent(rowKey) + monthFilter + '&select=*,user_profiles(full_name)&order=created_at.asc'
    );
  } catch (e) { console.error('[mgmt line comment] load:', e); }

  const rowLabel = rowKey.split(':').slice(1).join(' › ');
  const monthLabel = _selectedMonth
    ? new Date(_selectedMonth + '-01').toLocaleString('en-AU', { month: 'long', year: 'numeric' })
    : 'Season YTD';

  const existingHtml = existing.length
    ? existing.map(c =>
        '<div style="padding:10px 14px;border-bottom:1px solid var(--border-light)">' +
        '<div style="font-size:11px;color:var(--hint);margin-bottom:4px">' +
        (c.user_profiles?.full_name || 'User') + ' · ' + formatDate(c.created_at?.slice(0, 10)) +
        '</div>' +
        '<div style="font-size:12px;color:var(--ink)">' + c.comment + '</div>' +
        '</div>'
      ).join('')
    : '<div style="padding:12px 14px;font-size:11px;color:var(--hint);font-style:italic">No comments yet for this line and period.</div>';

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:520px;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:1">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--ink)">Comments — ${rowLabel}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${monthLabel}</div>
        </div>
        <button id="lc-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hint)">✕</button>
      </div>
      <div id="lc-existing">${existingHtml}</div>
      ${canWrite() ? `
        <div style="padding:12px 14px;border-top:1px solid var(--border);background:var(--page-bg)">
          <textarea id="lc-text" placeholder="Add a comment…" rows="3"
            style="width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--border);border-radius:6px;padding:8px;font-size:12px;font-family:inherit"></textarea>
          <div style="display:flex;justify-content:flex-end;margin-top:8px;gap:8px">
            <button id="lc-cancel" class="btn btn-ghost btn-sm">Cancel</button>
            <button id="lc-save"   class="btn btn-primary btn-sm">Save comment</button>
          </div>
        </div>` : ''}
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#lc-modal-close').onclick = () => modal.remove();
  modal.querySelector('#lc-cancel')?.addEventListener('click', () => modal.remove());
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const saveBtn = modal.querySelector('#lc-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const text = modal.querySelector('#lc-text')?.value?.trim();
      if (!text) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await dbInsert('management_comments', {
          farm_id:    farm.id,
          season,
          month:      _selectedMonth || null,
          row_key:    rowKey,
          comment:    text,
          created_by: session?.user?.id,
        });
        toast('Comment saved', 'success');
        modal.remove();
        // Re-render so comment badges update
        const appContainer = document.getElementById('main');
        if (appContainer) {
          const mgmtContainer = appContainer.querySelector('[id="mgmt-body"]')?.closest('div[style*="max-width:1200px"]')?.parentElement;
          if (mgmtContainer) _render(mgmtContainer.closest('[id]') || appContainer);
        }
      } catch (e) {
        toast('Could not save comment', 'error');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save comment';
        console.error(e);
      }
    });
  }
};

// ── Navigate to Outputs and open invoice edit form ─────────────────────────────
window._mgmtOpenInvoice = async function(invoiceId) {
  document.querySelectorAll('[style*="position:fixed"]').forEach(el => {
    if (el.style.zIndex >= 9999) el.remove();
  });
  const { openInvoiceForm } = await import('../outputs/invoices.js?v=1792559266387');
  document.querySelector('#sidebar a[data-module="outputs"]')?.click();
  setTimeout(async () => {
    try {
      const { dbSelect: ds } = await import('../../js/supabase-client.js?v=1792559266387');
      const rows = await ds('invoices', 'id=eq.' + invoiceId + '&select=*');
      const inv  = rows?.[0];
      if (!inv) return;
      const container = document.getElementById('main');
      if (container) openInvoiceForm(container, inv);
    } catch (e) { console.error('Could not open invoice:', e); }
  }, 600);
};

// ── Xero account transaction drilldown modal ───────────────────────────────────
window._mgmtXeroTxns = async function(farmId, accountId, accountName, fromDate, toDate) {
  // accountId may be empty — backend will resolve UUID from accountName via Xero Accounts API
  if (!fromDate || !toDate || (!accountId && !accountName)) {
    alert('Transaction data not available — no date range or account name found. Try refreshing the report.');
    return;
  }

  const fC = v => v == null ? '—' : Math.abs(v).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fD = s => {
    if (!s) return '—';
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  };

  // Build modal with loading state
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:700px;max-height:85vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:1">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">${accountName}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">Xero transactions · ${fD(fromDate)} – ${fD(toDate)}</div>
        </div>
        <button id="xtxn-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hint)">✕</button>
      </div>
      <div id="xtxn-body" style="padding:24px;text-align:center;color:var(--hint)">
        <div style="font-size:13px">Loading transactions from Xero…</div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#xtxn-close').onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const body = modal.querySelector('#xtxn-body');

  try {
    const url = '/.netlify/functions/xero-account-txns?farm_id=' + encodeURIComponent(farmId) +
      '&account_id=' + encodeURIComponent(accountId) +
      '&from='        + encodeURIComponent(fromDate) +
      '&to='          + encodeURIComponent(toDate) +
      '&account_name=' + encodeURIComponent(accountName);

    const res  = await fetch(url);
    const data = await res.json();

    if (!data.ok) {
      body.innerHTML = '<div style="color:var(--red);font-size:13px;padding:8px">Could not load transactions: ' + (data.error || 'Unknown error') + '</div>';
      return;
    }

    const txns = data.transactions || [];

    if (!txns.length) {
      body.innerHTML = '<div style="color:var(--hint);font-size:13px;font-style:italic;padding:8px">No transactions found for this account in the selected period.</div>';
      return;
    }

    const total = txns.reduce((s, t) => s + (t.amount || 0), 0);

    const typeLabel = t => {
      const map = { ACCPAY: 'Bill', ACCREC: 'Invoice', SPEND: 'Bank spend', RECEIVE: 'Bank receive', MANJOURNAL: 'Journal', CASHREC: 'Cash receipt', CASHPAID: 'Cash payment' };
      return map[t] || t || '—';
    };

    const rows = txns.map(t => {
      const isCredit = t.amount < 0;
      return '<tr style="border-bottom:0.5px solid var(--border-light,#eee)">' +
        '<td style="padding:6px 10px;font-size:11px;color:var(--hint);white-space:nowrap">' + fD(t.date) + '</td>' +
        '<td style="padding:6px 10px;font-size:11px;color:var(--hint)">' + typeLabel(t.type) + '</td>' +
        '<td style="padding:6px 10px;font-size:12px;color:var(--ink)">' + (t.contact || '—') + '</td>' +
        '<td style="padding:6px 10px;font-size:11px;color:var(--hint)">' + (t.reference || '—') + '</td>' +
        '<td style="padding:6px 10px;text-align:right;font-size:12px;font-weight:600;color:' + (isCredit ? 'var(--green)' : 'var(--red)') + '">' +
          (isCredit ? '+' : '-') + fC(t.amount) +
        '</td>' +
      '</tr>';
    }).join('');

    body.innerHTML = `
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="border-bottom:1px solid var(--border);background:var(--page-bg,#f8fafc)">
            <th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);white-space:nowrap">Date</th>
            <th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Type</th>
            <th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Contact / Description</th>
            <th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Reference</th>
            <th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="border-top:2px solid var(--border);background:var(--page-bg,#f8fafc)">
            <td colspan="4" style="padding:8px 10px;font-weight:700;font-size:12px">Total (${txns.length} transaction${txns.length !== 1 ? 's' : ''})</td>
            <td style="padding:8px 10px;text-align:right;font-weight:700;font-size:13px;color:var(--red)">-${fC(total)}</td>
          </tr>
        </tfoot>
      </table>`;
  } catch (e) {
    body.innerHTML = '<div style="color:var(--red);font-size:13px;padding:8px">Error loading transactions: ' + e.message + '</div>';
    console.error('[mgmt xero txns]', e);
  }
};

// ── Season-level note (no row_key) ─────────────────────────────────────────────
async function _addSeasonComment(container) {
  const farm    = getActiveFarm();
  const season  = getActiveSeason();
  const session = getSession();
  if (!farm || !season) return;
  const text = prompt('Add a season note:');
  if (!text?.trim()) return;
  try {
    await dbInsert('management_comments', {
      farm_id:    farm.id,
      season,
      month:      null,
      row_key:    null,
      comment:    text.trim(),
      created_by: session?.user?.id,
    });
    toast('Note saved', 'success');
    _render(container);
  } catch (e) {
    toast('Could not save note', 'error');
    console.error(e);
  }
}
