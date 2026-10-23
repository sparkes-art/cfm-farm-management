// modules/management-report/mgmt-report.js
// Management Report — CFM-native income actuals vs budget, season-scoped
// Supports monthly view with month selector. 7-column table:
//   Description | Actual Month | Budget Month | Actual YTD | Budget YTD | Variance YTD | Full Yr Budget
// Revenue actuals from CFM invoices; cost actuals from Xero P&L.
// Line-level comments per row + month, tracked by user and timestamp.

import { dbSelect, dbInsert, dbUpsert, dbDeleteWhere } from '../../js/supabase-client.js?v=1792559266387';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js?v=1792559266387';
import { formatCurrency, formatNumber, formatDate, qs, toast } from '../../js/ui.js?v=1792559266387';

// Module-level state — persists across re-renders within a session
let _selectedMonth = null;   // 'YYYY-MM' or null = full YTD
let _lastContainer = null;   // last container passed to _render, for post-save re-render

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
          <button class="btn btn-ghost btn-sm" id="mgmt-xero-map-btn" title="Map budget cost lines to Xero accounts">⚙ Xero mapping</button>
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
      _render(container).catch(e => {
        console.error('[MgmtReport] render error on month change:', e);
        const body = qs('#mgmt-body', container);
        if (body) body.innerHTML = `<div style="color:var(--red);font-size:13px;padding:24px">Error loading: ${e.message}</div>`;
      });
    });
  }

  qs('#mgmt-comment-btn', container)?.addEventListener('click', () => _addSeasonComment(container));
  qs('#mgmt-xero-map-btn', container)?.addEventListener('click', () => {
    if (farm && season) window._mgmtXeroMapping(farm.id, season);
  });
  try {
    await _render(container);
  } catch (e) {
    console.error('[MgmtReport] render error:', e);
    const body = qs('#mgmt-body', container);
    if (body) body.innerHTML = `<div style="color:var(--red);font-size:13px;padding:24px">
      Error loading management report: ${e.message}<br>
      <span style="color:var(--hint);font-size:11px">Check browser console for details. Try refreshing the page.</span>
    </div>`;
  }
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
  if (container) _lastContainer = container;
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
  const [contracts, allInvoices, budgets, budgetCosts, allComments, xeroMappings] = await Promise.all([
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.asc'),
    dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    dbSelect('budget_costs', 'farm_id=eq.' + farm.id + '&financial_year=eq.' + season + '&select=*').catch(() => []),
    // Load ALL comments for this farm+season (both season-level and line-level, all months)
    dbSelect('management_comments', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*,user_profiles(full_name)&order=created_at.desc').catch(() => []),
    // Xero account mappings for this farm + season (explicit cost-line → Xero account UUID)
    dbSelect('xero_account_mappings', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*').catch(() => []),
  ]);

  // Index mappings by cfm_description for O(1) lookup
  // key: description → { xero_account_id, xero_account_name }
  const xeroMappingIndex = {};
  (xeroMappings || []).forEach(m => {
    xeroMappingIndex[m.cfm_description] = { xero_account_id: m.xero_account_id, xero_account_name: m.xero_account_name };
  });

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
  // Priority: explicit mapping (xero_account_mappings) → exact name → fuzzy name
  const makeLineMatcher = (accounts) => {
    if (!accounts) return () => null;
    const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const normAccounts = accounts.map(a => ({ ...a, _norm: norm(a.name) }));
    const mkResult = a => ({ amount: a.amount, accountID: a.accountID || '', accountName: a.name, accountCode: a.code || '' });
    return (description) => {
      // 1. Check explicit mapping first — use stored Xero account UUID to match
      const mapping = xeroMappingIndex[description];
      if (mapping) {
        // Find the account in Xero results by UUID
        const mapped = normAccounts.find(a => a.accountID === mapping.xero_account_id);
        if (mapped) return mkResult(mapped);
        // Mapping exists but no matching Xero account in this P&L — accumulate under the stored name
        // (this can happen if the account had zero spend; return null so it shows — from total only)
      }

      // 2. Fuzzy name match fallback
      // Generic words that appear in many account names and must NOT drive a match on their own.
      const STOP_WORDS = new Set(['fee', 'fees', 'cost', 'costs', 'general', 'and', 'the',
                                   'for', 'inc', 'gst', 'tax', 'other', 'misc', 'miscellaneous']);
      const dNorm = norm(description);
      let hit = normAccounts.find(a => a._norm === dNorm);
      if (hit) return mkResult(hit);
      hit = normAccounts.find(a => a._norm.includes(dNorm) || dNorm.includes(a._norm));
      if (hit) return mkResult(hit);
      // Word-based fuzzy: require at least 2 MEANINGFUL shared words (not stop words).
      // Using a minimum of 2 prevents single common words like "plant", "hire", "labour"
      // from matching unrelated accounts (e.g. "Hire of Plant" matching "R&M Plant, Vehicles").
      const dWords = dNorm.split(' ').filter(w => w.length > 2 && !STOP_WORDS.has(w));
      if (dWords.length >= 2) {
        hit = normAccounts.find(a => {
          const matches = dWords.filter(w => a._norm.includes(w));
          return matches.length >= 2;  // require at least 2 meaningful words in common
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

  // Season date window — matches invoices.js filter logic
  const mm = String(yearStartMonth).padStart(2, '0');
  const seasonDateStart = `${seasonYear}-${mm}-01`;
  const seasonDateEnd   = `${seasonYear + 1}-${mm}-01`;

  const seasonInvoices = allInvoices.filter(inv => {
    const d = inv.invoice_date?.slice(0, 10) || '';
    return d >= seasonDateStart && d < seasonDateEnd;
  });

  const priorYearInvoices = allInvoices.filter(isPriorYearInv);

  // The active season string (e.g. "2026-27") — used to split invoices by crop_year
  const activeSeason = `${seasonYear}-${String(seasonYear + 1).slice(-2)}`;

  // Helper: does an invoice's batch crop_year match the current season?
  const invIsCurrentSeason = inv => {
    if (!inv.batches) return true; // legacy — treat as current
    const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
    // An invoice belongs to the current season if ANY batch has a crop_year matching activeSeason
    // (or has no crop_year set — treat as current)
    return b.some(x => !x.crop_year || x.crop_year === activeSeason);
  };

  // Split season invoices: current-crop vs carry-over (prior crop_year paid this season)
  const currentCropInvoices   = seasonInvoices.filter(inv => invIsCurrentSeason(inv));
  const carryOverCropInvoices = seasonInvoices.filter(inv => !invIsCurrentSeason(inv));

  // Month splits — same logic
  const monthInvoices = _selectedMonth
    ? seasonInvoices.filter(inv => {
        const d = inv.invoice_date?.slice(0, 7); // 'YYYY-MM'
        return d === _selectedMonth;
      })
    : [];
  const currentCropMonthInvoices   = monthInvoices.filter(inv => invIsCurrentSeason(inv));
  const carryOverCropMonthInvoices = monthInvoices.filter(inv => !invIsCurrentSeason(inv));

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
  // Helper: does a commodity key fuzzy-match the target?
  const commMatches = (iCommKey, targetKey) => {
    if (!iCommKey || !targetKey) return false;
    if (iCommKey === targetKey) return true;
    return targetKey.includes(iCommKey) || iCommKey.includes(targetKey);
  };

  const invTotals = (invList, commName) => {
    let qty = 0, income = 0, qa = 0, costs = 0;
    const matchedInvs = [];
    const targetKey = commName ? commName.trim().toUpperCase().replace(/\s+/g, ' ') : null;
    const targetIsLivestock = targetKey && /cattle|livestock/i.test(targetKey);

    invList.forEach(inv => {
      const linked = contracts.find(c => c.id === inv.forward_contract_id);

      if (inv.batches) {
        // ── New batch format: match and sum at the BATCH level ──────────────
        const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        let batchQty = 0, batchIncome = 0, batchQA = 0;

        b.forEach(batch => {
          // Determine this batch's commodity
          const saleLine = (batch.lines || []).find(l => l.type === 'income' && l.line_type !== 'qa');
          const qaLine   = (batch.lines || []).find(l => l.type === 'income' && l.line_type === 'qa');
          const bComm = linked?.commodity || inv.commodity_type || batch.commodity || saleLine?.description || '';
          const bCommKey = bComm.trim().toUpperCase().replace(/\s+/g, ' ');

          // Check if this batch matches the target commodity
          if (targetKey) {
            const batchIsLivestock = /cattle|livestock/i.test(bComm);
            if (targetIsLivestock && batchIsLivestock) { /* match */ }
            else if (!commMatches(bCommKey, targetKey)) return; // skip this batch
          }

          batchQty    += parseFloat(batch.qty) || 0;
          batchIncome += parseFloat(saleLine?.amount) || 0;
          batchQA     += parseFloat(qaLine?.amount)   || 0;
        });

        if (!targetKey || batchQty || batchIncome || batchQA) {
          if (batchIncome || batchQA) matchedInvs.push(inv);
          qty    += batchQty;
          income += batchIncome;
          qa     += batchQA;
        }

      } else {
        // ── Legacy line_items format ─────────────────────────────────────────
        const legacyComm = linked?.commodity || inv.commodity_type || (inv.line_items || [])[0]?.commodity || '';
        const legacyKey  = legacyComm.trim().toUpperCase().replace(/\s+/g, ' ');
        if (targetKey) {
          const isLs = /cattle|livestock/i.test(legacyComm);
          if (!(targetIsLivestock && isLs) && !commMatches(legacyKey, targetKey)) return;
        }
        matchedInvs.push(inv);
        qty    += parseFloat(inv.total_qty)          || 0;
        income += parseFloat(inv.gross_amount)       || 0;
        qa     += parseFloat(inv.total_quality_adj)  || 0;
        costs  += parseFloat(inv.total_deductions)   || 0;
      }
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
    const batches  = inv.batches ? (typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches) : [];
    // Resolve commodity: check linked contract first (same logic as invTotals), then invoice fields, then batch lines
    const linked   = contracts.find(c => c.id === inv.forward_contract_id);
    const commName = linked?.commodity
      || inv.commodity_type
      || batches.map(b => b.commodity).find(Boolean)
      || batches.flatMap(b => b.lines || []).find(l => l.type === 'income' && l.description)?.description
      || (inv.line_items || [])[0]?.commodity || null;
    if (!commName) return;
    const key = commName.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!groups[key]) groups[key] = { name: commName.trim(), budgets: [] };
    // Mark the group as seeded from a prior-year invoice so it always routes to carry-over
    groups[key].fromPriorYear = true;
  });

  const bField = (b, plain, prefixed) => parseFloat(b[prefixed] ?? b[plain]) || 0;

  const budgetForGroup = (g, opts = {}) => {
    if (!g.budgets.length) return { bIncome: null, bYTD: null, bMonth: null, bArea: null, bYield: null, bProd: null, bPrice: null };
    if (opts.carryOver) {
      const bIncome = g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue) || 0), 0) || null;
      // For carryover rows imported from budget Excel, budgeted_yield_per_ha stores the total
      // production quantity (units sold) — identified by area_ha being null (no per-ha data).
      // Regular farming rows have area_ha set and budgeted_yield_per_ha = yield/ha (not total units).
      const carryBudgets = g.budgets.filter(b => b.area_ha == null || b.notes === 'carryover');
      const bProd  = carryBudgets.length
        ? carryBudgets.reduce((s, b) => s + (parseFloat(b.budgeted_yield_per_ha) || 0), 0) || null
        : null;
      // Always derive price as total revenue ÷ production units so it's consistent
      const bPrice = (bIncome && bProd) ? bIncome / bProd : null;
      return { bIncome, bYTD: bIncome != null ? bIncome * ytdFraction : null, bMonth: bIncome != null ? bIncome / 12 : null, bArea: null, bYield: null, bProd, bPrice };
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
  // A group is carry-over if:
  //   (a) it was seeded from a prior-year invoice (fromPriorYear flag set during group creation), OR
  //   (b) ALL of its budget rows are carry-over budget rows (notes='carryover' or area_ha is null),
  //       indicating the budget itself was imported as a carry-over line.
  // The old mixed-case name heuristic is removed — it caused false positives for crops like "Cotton".
  const isCarryOver = (name, g) => {
    if (isCattle(name) || isOther(name)) return false;
    if (g?.fromPriorYear) return true;
    if (!g?.budgets?.length) return false;
    return g.budgets.every(b => b.notes === 'carryover' || b.area_ha == null);
  };

  const buildCommRow = (g, opts = {}) => {
    const { bIncome, bYTD, bMonth, bArea, bYield, bProd, bPrice } = budgetForGroup(g, { carryOver: opts.carryOver });
    // Route invoices to the right pool:
    // - fromPriorYear groups: use the flag-based priorYearInvoices (no date restriction)
    // - other carry-over groups (budget-imported): use carryOverCropInvoices (date in season, crop_year mismatch)
    // - farming rows: use currentCropInvoices
    let invSource, invMonthSource;
    if (opts.carryOver && g.fromPriorYear) {
      invSource      = priorYearInvoices;
      invMonthSource = _selectedMonth
        ? priorYearInvoices.filter(inv => inv.invoice_date?.slice(0, 7) === _selectedMonth)
        : [];
    } else if (opts.carryOver) {
      invSource      = carryOverCropInvoices;
      invMonthSource = carryOverCropMonthInvoices;
    } else {
      invSource      = currentCropInvoices;
      invMonthSource = currentCropMonthInvoices;
    }
    const inv       = invTotals(invSource, g.name);
    const invMonth  = _selectedMonth ? invTotals(invMonthSource, g.name) : null;
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
      invoices: inv.invoices.flatMap(i => {
        const date  = i.invoice_date?.slice(0, 10);
        const buyer = i.buyer;
        const id    = i.id;
        const linked = contracts.find(c => c.id === i.forward_contract_id);
        if (i.batches) {
          const b = typeof i.batches === 'string' ? JSON.parse(i.batches) : i.batches;
          // One row per batch — filter to only batches matching this commodity row
          const targetKey = g.name.trim().toUpperCase().replace(/\s+/g, ' ');
          const targetIsLivestock = /cattle|livestock/i.test(g.name);
          const matchingBatches = b.filter(x => {
            const saleLine = (x.lines || []).find(l => l.type === 'income' && l.line_type !== 'qa');
            const bComm = linked?.commodity || x.commodity || saleLine?.description || '';
            const bKey = bComm.trim().toUpperCase().replace(/\s+/g, ' ');
            const bIsLivestock = /cattle|livestock/i.test(bComm);
            if (targetIsLivestock && bIsLivestock) return true;
            return commMatches(bKey, targetKey);
          });
          let firstShown = false;
          return matchingBatches.map((x, idx) => {
            const saleLine = (x.lines || []).find(l => l.type === 'income' && l.line_type !== 'qa');
            const qaLine   = (x.lines || []).find(l => l.type === 'income' && l.line_type === 'qa');
            const qty      = parseFloat(x.qty) || 0;
            const gross    = parseFloat(saleLine?.amount) || 0;
            const qa       = parseFloat(qaLine?.amount)   || 0;
            const inc      = gross + qa;
            const cropYear = x.crop_year || '';
            return {
              id,
              date,
              buyer,   // show date + buyer on every batch row
              qty,
              inc,
              gross,
              qa,
              unit: x.unit || unit,
              crop_year: cropYear,
              price: saleLine?.eff_per_unit || (qty && gross ? gross / qty : null),
              batchIdx: b.indexOf(x),
              batchCount: b.length,
            };
          });
        }
        // Legacy single-line invoice
        const qty = parseFloat(i.total_qty) || 0;
        const inc = (parseFloat(i.gross_amount) || 0) + (parseFloat(i.total_quality_adj) || 0);
        return [{ id, date, buyer, qty, inc, gross: parseFloat(i.gross_amount) || 0, qa: parseFloat(i.total_quality_adj) || 0, unit, crop_year: i.season || '', price: (qty && inc) ? inc / qty : null, batchIdx: 0, batchCount: 1 }];
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
        <td style="${tdR}">${bYTD != null ? fC(bYTD) : '—'}</td>
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
        <td style="${tdR};font-weight:600">${secBudgetYTD ? fC(secBudgetYTD) : '—'}</td>
        <td style="${tdR}">${secActual ? varCell(secActual, secBudgetYTD) : '<span style="color:var(--hint)">—</span>'}</td>
        <td style="${tdR};font-weight:600">${secBudget ? fC(secBudget) : '—'}</td>
      </tr>`;
    return secRow(label) + rowsHtml + subtotal;
  };

  const sortedGroups    = Object.values(groups).sort((a, b) => a.name.toUpperCase().localeCompare(b.name.toUpperCase()));
  const farmingGroups   = sortedGroups.filter(g => !isCattle(g.name) && !isOther(g.name) && !isCarryOver(g.name, g));
  const livestockGroups = sortedGroups.filter(g => isCattle(g.name));
  const otherGroups     = sortedGroups.filter(g => isOther(g.name));
  const carryOverGroups = sortedGroups.filter(g => isCarryOver(g.name, g));

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

    const catYTD      = catTotal * ytdFraction;

    // Accumulate line-level actuals into category total.
    // Using the raw Xero bucket (xeroActuals[cat.key]) causes the category total to
    // differ from the sum of line actuals because the bucket includes accounts that
    // have no matching budget line. We sum the line matches instead so the total
    // is always the sum of what's visible on screen.
    let catActual = null;
    let catActualMonth = null;

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
      const lineAcctCode   = lineActMatch?.accountCode || lineActMoMatch?.accountCode || '';

      // Accumulate into category totals (line-by-line, so total = sum of visible lines)
      if (lineAct !== null) {
        catActual = (catActual || 0) + lineAct;
      }
      if (lineActMonth !== null) {
        catActualMonth = (catActualMonth || 0) + lineActMonth;
      }

      const lineVar      = lineAct !== null ? amtYTD - lineAct : null;
      const lineVarStyle = lineVar !== null ? (lineVar >= 0 ? 'color:var(--green)' : 'color:var(--red)') : '';
      const lineVarPct   = lineVar !== null && amtYTD ? lineVar / amtYTD * 100 : null;
      const lineVarLabel = lineVar !== null
        ? (lineVar >= 0 ? '+' : '') + fC(lineVar) + (lineVarPct !== null ? ' (' + (lineVarPct >= 0 ? '+' : '') + lineVarPct.toFixed(0) + '%)' : '')
        : '—';

      const rowKey        = 'cost:' + cat.key + ':' + c.description;
      // Prefer explicit mapping's accountId for drilldown — it's the correct Xero UUID even if fuzzy matched to wrong account
      const explicitMapping = xeroMappingIndex[c.description];
      const drillAccountId  = explicitMapping?.xero_account_id || lineAccountID;
      const drillAcctName   = explicitMapping?.xero_account_name || lineAcctName;
      // Show drilldown whenever we have a Xero actual — use accountID if available, fall back to name-based lookup
      const canDrill      = lineAct !== null;
      const drillAcctCode  = explicitMapping?.xero_account_code || lineAcctCode;
      const drillClick    = canDrill
        ? 'onclick="window._mgmtXeroTxns(\'' + farm.id + '\',\'' + drillAccountId.replace(/'/g, '') + '\',\'' + drillAcctName.replace(/'/g, '') + '\',\'' + (xeroYtdFrom || '') + '\',\'' + (xeroYtdTo || '') + '\',\'' + drillAcctCode.replace(/'/g, '') + '\')"'
        : '';
      const drillTitle    = canDrill ? ' title="Click to see Xero transactions"' : '';

      const monthLineCols  = _selectedMonth ? `
          <td style="${tdR};color:var(--red);font-size:11px">${lineActMonth !== null ? '-' + fC(Math.abs(lineActMonth)) : '—'}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amtMonth)}</td>` : '';

      return `
        <tr${drillTitle}>
          <td style="${td};padding-left:28px;font-size:11px;color:var(--hint)">
            ${c.description}${commentChip(rowKey)}
          </td>
          ${monthLineCols}
          <td style="${tdR};color:var(--red);font-size:11px">${canDrill ? '<span ' + drillClick + ' style="cursor:pointer;text-decoration:underline;text-underline-offset:2px">-' + fC(Math.abs(lineAct)) + '</span>' : (lineAct !== null ? '-' + fC(Math.abs(lineAct)) : '—')}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amtYTD)}</td>
          <td style="${tdR};font-size:11px">${lineVar !== null ? '<span style="' + lineVarStyle + ';font-weight:600">' + lineVarLabel + '</span>' : '—'}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(amt)}</td>
        </tr>`;
    }).join('');

    // Accumulate into overall fixed cost totals (after lineRowsHtml so catActual is fully summed)
    if (catActual !== null) totalFixedActual += catActual;
    if (catActualMonth !== null) totalFixedActualMonth += catActualMonth;

    const catVariance = catActual !== null ? catYTD - catActual : null;
    const varStyle    = catVariance !== null ? (catVariance >= 0 ? 'color:var(--green)' : 'color:var(--red)') : '';
    const catVarPct   = catVariance !== null && catYTD ? catVariance / catYTD * 100 : null;
    const catVarLabel = catVariance !== null
      ? (catVariance >= 0 ? '+' : '') + fC(catVariance) + (catVarPct !== null ? ' (' + (catVarPct >= 0 ? '+' : '') + catVarPct.toFixed(0) + '%)' : '')
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
  // Each row in budget_costs for capex has:
  //   budget_code  = the code header  (e.g. "CAPEX PLANT & EQUIPMENT")
  //   description  = the line item    (e.g. "Bulk spreader") — or same as budget_code for cashflow rows
  // Group by budget_code; show code totals as flat rows.
  // For non-PC codes that have real line items (description ≠ budget_code),
  // the code label is underlined/clickable and opens a detail modal.
  const isPcCode = code => /^pc\s+/i.test(code.trim());

  const capexCosts = budgetCosts.filter(c => c.category === 'capex');
  const capexByCode = new Map();
  for (const c of capexCosts) {
    const codeKey = (c.budget_code || c.description || '').trim() || 'UNALLOCATED';
    if (!capexByCode.has(codeKey)) capexByCode.set(codeKey, { codeKey, items: [], total: 0 });
    const entry = capexByCode.get(codeKey);
    entry.items.push(c);
    entry.total += parseFloat(c.budget_amount) || 0;
  }

  // Build a data payload for the modal (keyed by code, stored in a JS object on the page)
  const capexItemData = {};
  for (const [codeKey, entry] of capexByCode.entries()) {
    if (isPcCode(codeKey)) continue;
    const lineItems = entry.items.filter(i => {
      const desc = (i.description || '').trim();
      return desc && desc !== codeKey;
    });
    if (lineItems.length > 0) {
      capexItemData[codeKey] = lineItems.map(i => ({
        desc: i.description || '',
        amt:  parseFloat(i.budget_amount) || 0,
      }));
    }
  }
  let totalCapexBudget = 0;
  const capexRows = [...capexByCode.entries()].map(([codeKey, entry]) => {
    const amt      = Math.abs(entry.total);
    const isSale   = entry.total < 0;
    totalCapexBudget += entry.total;
    const rowKey   = 'capex:' + codeKey;
    const colColor = isSale ? 'var(--green)' : 'var(--red)';
    // Only clickable if there are actual sub-items to show — cashflow-style budgets
    // have the code as the item itself (no sub-rows), so no modal to open.
    const isClickable = !isPcCode(codeKey) && !!capexItemData[codeKey];

    const monthCapexCols = _selectedMonth ? `
        <td style="${tdR};color:var(--hint)">—</td>
        <td style="${tdR};font-size:12px;color:${colColor}">
          ${isSale ? '+' : '-'}${fC(amt / 12)}
        </td>` : '';

    // Use a data attribute to avoid & and quote issues inside an HTML onclick attribute
    const safeKey   = codeKey.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const labelHtml = isClickable
      ? `<span data-capex-key="${safeKey}"
             style="font-size:12px;color:var(--ink);font-weight:500;text-decoration:underline;
                    text-underline-offset:2px;cursor:pointer">${codeKey}</span>`
      : `<span style="font-size:12px;color:var(--ink);font-weight:500">${codeKey}</span>`;

    return `
      <tr>
        <td style="${td};padding-left:28px">
          ${labelHtml}
          ${commentChip(rowKey)}
        </td>
        ${monthCapexCols}
        <td style="${tdR};color:var(--hint)">—</td>
        <td style="${tdR};font-size:12px;color:${colColor}">
          ${isSale ? '+' : '-'}${fC(amt * ytdFraction)}
        </td>
        <td style="${tdR}">—</td>
        <td style="${tdR};font-size:12px;color:${colColor}">
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
  // Expose CAPEX item data for the detail modal BEFORE setting innerHTML
  window.__cfmCapexItems = capexItemData;

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

  // Wire up CAPEX detail clicks via event delegation (avoids & encoding issues in onclick attributes)
  body.addEventListener('click', e => {
    const span = e.target.closest('[data-capex-key]');
    if (span) window._mgmtCapexDetail(span.dataset.capexKey);
  });

}

// ── CAPEX line-item detail modal ──────────────────────────────────────────────
window._mgmtCapexDetail = function(codeKey) {
  const fC = v => Math.abs(v).toLocaleString('en-AU', { style: 'currency', currency: 'AUD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const items = (window.__cfmCapexItems || {})[codeKey] || [];

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  const rows = items.length
    ? items.map(item => {
        const isSale = item.amt < 0;
        return `<tr style="border-bottom:0.5px solid #f0f0f0">
          <td style="padding:9px 16px;font-size:13px;color:#1a1a1a">${item.desc}</td>
          <td style="padding:9px 16px;text-align:right;font-size:13px;font-weight:600;color:${isSale ? '#16a34a' : '#dc2626'}">${isSale ? '+' : '-'}${fC(item.amt)}</td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="2" style="padding:20px 16px;text-align:center;font-size:13px;color:#999;font-style:italic">
        Budget entered as a lump sum — no individual line items recorded.
      </td></tr>`;

  const total = items.reduce((s, i) => s + i.amt, 0);
  const totalRow = items.length ? `
    <tr style="border-top:2px solid #e5e7eb;background:#fafafa">
      <td style="padding:10px 16px;font-size:13px;font-weight:700;color:#1a1a1a">Total</td>
      <td style="padding:10px 16px;text-align:right;font-size:13px;font-weight:700;color:${total < 0 ? '#16a34a' : '#dc2626'}">${total < 0 ? '+' : '-'}${fC(total)}</td>
    </tr>` : '';

  modal.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:520px;max-height:80vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.25)">
      <div style="padding:14px 18px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:1">
        <div style="font-size:15px;font-weight:700;color:#1a1a1a">${codeKey}</div>
        <button onclick="this.closest('[style*=fixed]').remove()"
                style="background:none;border:none;font-size:20px;cursor:pointer;color:#999;line-height:1;padding:0 4px">&times;</button>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:#fafafa;border-bottom:1px solid #e5e7eb">
            <th style="padding:8px 16px;text-align:left;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em">Item</th>
            <th style="padding:8px 16px;text-align:right;font-size:11px;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:.06em">Budget</th>
          </tr>
        </thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>`;

  document.body.appendChild(modal);
};

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
    ${(d.bProd != null || d.bPrice != null) ? `
    ${sectionHdr('Budget')}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border)">
      ${stat('Production', d.bProd  != null ? fN(d.bProd) + ' ' + d.unit                        : '—')}
      ${stat('Avg price',  d.bPrice != null ? '$' + fN(d.bPrice, 2) + '/' + d.unit              : '—')}
      ${stat('Budget',     d.bIncome != null ? fC(d.bIncome) : '—')}
    </div>` : ''}
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
          <th style="text-align:left;padding:4px 8px;color:var(--hint);font-weight:500">Season</th>
          <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Qty</th>
          <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Price</th>
          <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Gross</th>
          <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Adj</th>
          <th style="padding:4px 8px;color:var(--hint);font-weight:500"></th>
        </tr></thead>
        <tbody>
          ${d.invoices.map(i => {
            const isFirstBatch  = i.batchIdx === 0;
            const isLastBatch   = i.batchIdx === i.batchCount - 1;
            const rowBorder     = isLastBatch ? 'border-bottom:1px solid var(--border)' : 'border-bottom:0.5px dashed var(--border-light)';
            const dateStr       = i.date ? new Date(i.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
            const unitLabel     = i.unit || d.unit;
            return '<tr style="' + rowBorder + '">' +
              '<td style="padding:5px 8px;color:var(--ink)">' + dateStr + (i.buyer ? ' · <span style="color:var(--hint)">' + i.buyer + '</span>' : '') + '</td>' +
              '<td style="padding:5px 8px;color:var(--hint);font-size:10px">' + (i.crop_year || '—') + '</td>' +
              '<td style="padding:5px 8px;text-align:right;color:var(--hint)">' + (i.qty ? fN(i.qty, 2) + ' ' + unitLabel : '—') + '</td>' +
              '<td style="padding:5px 8px;text-align:right;color:var(--hint)">' + (i.price ? '$' + fN(i.price, 4) + '/' + unitLabel : '—') + '</td>' +
              '<td style="padding:5px 8px;text-align:right;color:#16a34a;font-weight:600">' + (i.gross ? fC(i.gross) : '—') + '</td>' +
              '<td style="padding:5px 8px;text-align:right;color:' + (i.qa < 0 ? 'var(--red)' : i.qa > 0 ? '#16a34a' : 'var(--hint)') + '">' + (i.qa ? (i.qa > 0 ? '+' : '') + fC(i.qa) : '—') + '</td>' +
              '<td style="padding:5px 8px;text-align:center">' + (isFirstBatch ? '<button onclick="window._mgmtOpenInvoice(\'' + i.id + '\')" title="Open invoice" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 7px;font-size:11px;cursor:pointer;color:var(--blue);line-height:1.4">↗</button>' : '') + '</td>' +
              '</tr>';
          }).join('')}
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
        if (_lastContainer) _render(_lastContainer);
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
window._mgmtXeroTxns = async function(farmId, accountId, accountName, fromDate, toDate, accountCode) {
  // accountId may be empty — backend can match by accountCode or accountName
  if (!fromDate || !toDate || (!accountId && !accountName && !accountCode)) {
    alert('Transaction data not available — no date range or account found. Try refreshing the report.');
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
      '&account_id='   + encodeURIComponent(accountId || '') +
      '&from='         + encodeURIComponent(fromDate) +
      '&to='           + encodeURIComponent(toDate) +
      '&account_name=' + encodeURIComponent(accountName || '') +
      '&account_code=' + encodeURIComponent(accountCode || '');

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
      const map = { ACCPAY: 'Bill', ACCREC: 'Invoice', SPEND: 'Bank spend', RECEIVE: 'Bank receive', CASHREC: 'Cash receipt', CASHPAID: 'Cash payment' };
      return map[t] || t || '—';
    };

    const rows = txns.map(t => {
      const isCredit = t.amount < 0;
      const desc = (t.description || '').trim();
      const descHtml = desc
        ? '<div style="font-size:10px;color:var(--hint);margin-top:2px;line-height:1.4">' + desc.replace(/</g, '&lt;') + '</div>'
        : '';
      return '<tr style="border-bottom:0.5px solid var(--border-light,#eee)">' +
        '<td style="padding:6px 10px;font-size:11px;color:var(--hint);white-space:nowrap;vertical-align:top">' + fD(t.date) + '</td>' +
        '<td style="padding:6px 10px;font-size:11px;color:var(--hint);white-space:nowrap;vertical-align:top">' + typeLabel(t.type) + '</td>' +
        '<td style="padding:6px 10px;font-size:12px;color:var(--ink);vertical-align:top">' + (t.contact || '—') + descHtml + '</td>' +
        '<td style="padding:6px 10px;font-size:11px;color:var(--hint);vertical-align:top">' + (t.reference || '—') + '</td>' +
        '<td style="padding:6px 10px;text-align:right;font-size:12px;font-weight:600;color:' + (isCredit ? 'var(--green)' : 'var(--red)') + ';vertical-align:top">' +
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
            <th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Ref</th>
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

// ── Xero account mapping modal ─────────────────────────────────────────────────
// Opens a modal listing all budget cost lines for the farm+season.
// For each line the user can pick the correct Xero account from a dropdown.
// Saves to xero_account_mappings table (farm_id + season + cfm_description → Xero UUID).
// Changes take effect on next report render.
window._mgmtXeroMapping = async function(farmId, season) {
  const fmtAccountOption = (a) =>
    `<option value="${a.AccountID}" data-name="${(a.Name || '').replace(/"/g, '&quot;')}">${a.Code ? a.Code + ' – ' : ''}${a.Name}${a.Class ? ' (' + a.Class + ')' : ''}</option>`;

  // Build modal with loading state
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;width:100%;max-width:780px;max-height:90vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.35)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:#fff;z-index:1">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">Xero Account Mapping</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">Season ${season} · Map each cost line to the correct Xero account</div>
        </div>
        <button id="xmap-close" style="background:none;border:none;font-size:22px;cursor:pointer;color:var(--hint);line-height:1">✕</button>
      </div>
      <div id="xmap-body" style="padding:24px">
        <div style="text-align:center;color:var(--hint);font-size:13px;padding:32px 0">Loading Xero accounts and budget lines…</div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#xmap-close').onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  const body = modal.querySelector('#xmap-body');

  try {
    // Fetch Xero chart of accounts + existing mappings + budget cost lines in parallel
    const [xeroRes, mappingsArr, costsArr] = await Promise.all([
      fetch('/.netlify/functions/xero-accounts?farm_id=' + encodeURIComponent(farmId)),
      dbSelect('xero_account_mappings', 'farm_id=eq.' + farmId + '&season=eq.' + encodeURIComponent(season) + '&select=*').catch(() => []),
      dbSelect('budget_costs', 'farm_id=eq.' + farmId + '&financial_year=eq.' + encodeURIComponent(season) + '&select=*').catch(() => []),
    ]);

    const xeroData = await xeroRes.json();

    if (!xeroData.ok) {
      body.innerHTML = `<div style="color:var(--red);font-size:13px;padding:16px">Could not load Xero accounts: ${xeroData.error || 'Unknown error'}<br><br><span style="color:var(--hint)">Ensure Xero is connected for this farm in Farm Settings.</span></div>`;
      return;
    }

    const xeroAccounts = xeroData.accounts || [];

    if (!xeroAccounts.length) {
      body.innerHTML = '<div style="color:var(--hint);font-size:13px;padding:16px;text-align:center">No Xero accounts found for this farm.</div>';
      return;
    }

    // Build existing mapping index: description → { xero_account_id, xero_account_name }
    const mappingIndex = {};
    (mappingsArr || []).forEach(m => {
      mappingIndex[m.cfm_description] = { xero_account_id: m.xero_account_id, xero_account_name: m.xero_account_name };
    });

    // Filter to non-capex cost lines (the ones shown in fixed costs section)
    const fixedCosts = (costsArr || []).filter(c => c.category !== 'capex');

    if (!fixedCosts.length) {
      body.innerHTML = '<div style="color:var(--hint);font-size:13px;padding:16px;text-align:center">No budget cost lines found for this farm and season.</div>';
      return;
    }

    // Fuzzy name matcher — same logic as makeLineMatcher in the report render,
    // used here to show which Xero account each line auto-resolves to.
    const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const normAccounts = xeroAccounts.map(a => ({ ...a, _norm: normStr(a.Name) }));
    const FUZZY_STOP_WORDS = new Set(['fee', 'fees', 'cost', 'costs', 'general', 'and', 'the',
                                       'for', 'inc', 'gst', 'tax', 'other', 'misc', 'miscellaneous']);
    const fuzzyMatch = (description) => {
      const dNorm = normStr(description);
      let hit = normAccounts.find(a => a._norm === dNorm);
      if (hit) return hit;
      hit = normAccounts.find(a => a._norm.includes(dNorm) || dNorm.includes(a._norm));
      if (hit) return hit;
      // Word-based fuzzy: require at least 2 meaningful shared words.
      // Prevents single common words like "plant" matching unrelated accounts.
      const dWords = dNorm.split(' ').filter(w => w.length > 2 && !FUZZY_STOP_WORDS.has(w));
      if (dWords.length >= 2) {
        hit = normAccounts.find(a => {
          const matches = dWords.filter(w => a._norm.includes(w));
          return matches.length >= 2;
        });
        if (hit) return hit;
      }
      return null;
    };

    // Group by category for display
    const catLabels = { labour: 'Labour & Farm Management', overhead: 'Overheads', rm: 'Repairs & Maintenance', fund_mgmt: 'Fund Management' };
    const byCategory = {};
    fixedCosts.forEach(c => {
      const cat = c.category || 'overhead';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(c);
    });

    // Render rows
    const catHtml = Object.entries(catLabels).map(([catKey, catLabel]) => {
      const lines = byCategory[catKey] || [];
      if (!lines.length) return '';
      const rowsHtml = lines.map((c, idx) => {
        const mapping    = mappingIndex[c.description];
        const selectedId = mapping?.xero_account_id || '';

        // Show what the fuzzy matcher would pick when no explicit mapping is saved
        const autoMatch  = fuzzyMatch(c.description);
        const blankLabel = autoMatch
          ? `— ${autoMatch.Name}${autoMatch.Code ? ' (' + autoMatch.Code + ')' : ''} (auto)`
          : '— no auto-match found —';
        const blankOpt = `<option value="">${blankLabel}</option>`;

        const statusText  = selectedId ? '✓ Mapped' : (autoMatch ? '~ Auto' : '✗ No match');
        const statusColor = selectedId ? 'var(--green)' : (autoMatch ? 'var(--hint)' : 'var(--red)');

        return `<tr style="border-bottom:1px solid var(--border,#e5e7eb)">
          <td style="padding:8px 12px;font-size:12px;color:var(--ink);min-width:180px;max-width:220px">${c.description}</td>
          <td style="padding:8px 12px">
            <select data-desc="${c.description.replace(/"/g, '&quot;')}" class="xmap-select form-select" style="width:100%;font-size:11px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:white;max-width:400px">
              ${blankOpt}
              ${xeroAccounts.map(a => `<option value="${a.AccountID}" data-name="${(a.Name || '').replace(/"/g, '&quot;')}"${a.AccountID === selectedId ? ' selected' : ''}>${a.Code ? a.Code + ' – ' : ''}${a.Name}</option>`).join('')}
            </select>
          </td>
          <td style="padding:8px 12px;font-size:11px;color:${statusColor};white-space:nowrap">
            ${statusText}
          </td>
        </tr>`;
      }).join('');

      return `
        <tr><td colspan="3" style="padding:10px 12px 4px;font-size:11px;font-weight:700;color:var(--hint);text-transform:uppercase;letter-spacing:.05em;background:var(--page-bg,#f8fafc)">${catLabel}</td></tr>
        ${rowsHtml}`;
    }).join('');

    body.innerHTML = `
      <p style="font-size:12px;color:var(--hint);margin:0 0 16px">
        Select a Xero account for each cost line. When mapped, the drilldown will pull transactions
        from that exact account rather than using automatic name matching.
        Changes apply from the next time you load the management report.
      </p>
      <table style="width:100%;border-collapse:collapse;border:1px solid var(--border,#e5e7eb);border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:var(--page-bg,#f8fafc);border-bottom:1px solid var(--border)">
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Budget line</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Xero account</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Status</th>
          </tr>
        </thead>
        <tbody>${catHtml}</tbody>
      </table>
      <div style="margin-top:16px;display:flex;align-items:center;justify-content:flex-end;gap:10px">
        <button id="xmap-cancel" class="btn btn-ghost btn-sm">Cancel</button>
        <button id="xmap-save"   class="btn btn-primary btn-sm">Save mappings</button>
      </div>
      <div id="xmap-msg" style="margin-top:8px;font-size:12px;text-align:right;min-height:16px"></div>`;

    modal.querySelector('#xmap-cancel').onclick = () => modal.remove();

    modal.querySelector('#xmap-save').onclick = async () => {
      const saveBtn = modal.querySelector('#xmap-save');
      const msgEl   = modal.querySelector('#xmap-msg');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      msgEl.style.color = 'var(--hint)';
      msgEl.textContent = '';

      const selects = modal.querySelectorAll('.xmap-select');
      const upserts = [];

      selects.forEach(sel => {
        const desc    = sel.dataset.desc;
        const acctId  = sel.value;
        const opt     = sel.options[sel.selectedIndex];
        const acctName = acctId ? (opt?.dataset?.name || opt?.textContent || '') : '';
        // Always upsert — even blank (clears the mapping)
        upserts.push({
          farm_id:            farmId,
          season,
          cfm_description:    desc,
          xero_account_id:    acctId || null,
          xero_account_name:  acctName || null,
          updated_at:         new Date().toISOString(),
        });
      });

      // Only save rows that have a selection (skip blanks that were never set)
      const toSave = upserts.filter(u => u.xero_account_id !== null);

      try {
        if (toSave.length) {
          await dbUpsert('xero_account_mappings', toSave, 'farm_id,season,cfm_description');
        }

        // Delete rows where the user cleared the selection
        const toClear = upserts.filter(u => u.xero_account_id === null).map(u => u.cfm_description);
        for (const desc of toClear) {
          await dbDeleteWhere('xero_account_mappings', 'farm_id=eq.' + farmId + '&season=eq.' + encodeURIComponent(season) + '&cfm_description=eq.' + encodeURIComponent(desc));
        }

        msgEl.style.color = 'var(--green)';
        msgEl.textContent = `✓ ${toSave.length} mapping${toSave.length !== 1 ? 's' : ''} saved. Reload the report to apply changes.`;
        saveBtn.textContent = 'Saved ✓';
        saveBtn.disabled = false;
      } catch (e) {
        msgEl.style.color   = 'var(--red)';
        msgEl.textContent   = 'Error: ' + e.message;
        saveBtn.textContent = 'Save mappings';
        saveBtn.disabled    = false;
        console.error('[xero-mapping]', e);
      }
    };

  } catch (e) {
    body.innerHTML = `<div style="color:var(--red);font-size:13px;padding:16px">Error loading mapping data: ${e.message}</div>`;
    console.error('[xero-mapping]', e);
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
