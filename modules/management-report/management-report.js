// modules/management-report/management-report.js
// Management Report — income actuals vs budget, season-scoped
// Actuals from CFM invoices (synced to Xero); costs section to follow

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
  const yearStartMonth  = farm.settings?.yearStartMonth || 7;  // 1-based (1=Jan, 7=Jul, 10=Oct)
  const seasonStartMonthIdx = yearStartMonth - 1;              // 0-based for Date comparison
  // Months elapsed since start of this season
  let monthsElapsed = (now.getFullYear() - seasonYear) * 12 + (now.getMonth() - seasonStartMonthIdx);
  if (monthsElapsed < 0) monthsElapsed = 0;
  if (monthsElapsed > 12) monthsElapsed = 12;
  const ytdFraction = monthsElapsed / 12;

  qs('#mgmt-title', container).textContent = `${farm.name} — Management Report`;
  qs('#mgmt-sub', container).textContent   =
    `Season ${season} · YTD to ${now.toLocaleString('en-AU',{month:'long',year:'numeric'})} · As at ${formatDate(now.toISOString().slice(0,10))}`;

  const body = qs('#mgmt-body', container);
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--hint)">Loading...</div>';

  const [contracts, allInvoices, budgets, budgetCosts, comments] = await Promise.all([
    dbSelect('forward_contracts', `farm_id=eq.${farm.id}&crop_year=eq.${season}&select=*`),
    dbSelect('invoices', `farm_id=eq.${farm.id}&select=*&order=invoice_date.asc`),
    dbSelect('budgets', `farm_id=eq.${farm.id}&season=eq.${season}&select=*`),
    dbSelect('budget_costs', `farm_id=eq.${farm.id}&financial_year=eq.${season}&select=*`).catch(()=>[]),
    dbSelect('management_comments', `farm_id=eq.${farm.id}&season=eq.${season}&select=*,user_profiles(full_name)&order=created_at.desc`).catch(()=>[]),
  ]);

  // ── Season-scoped invoices ──────────────────────────────────────────────────
  // Use invoice.season field (same logic as outputs module) — avoids prior-year bleed
  const seasonInvoices = allInvoices.filter(inv => {
    if (inv.season === season) return true;
    // Fallback: check batch crop_year for contract invoices that predate the season field
    if (inv.batches) {
      const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
      if (b.some(batch => batch.crop_year === season)) return true;
    }
    // Fallback: linked contract's crop_year
    const linked = contracts.find(c => c.id === inv.forward_contract_id);
    if (linked?.crop_year === season) return true;
    return false;
  });

  const fC  = n  => n != null ? formatCurrency(n, 0) : '—';
  const fN  = (n, dp=0) => n != null && n !== 0 ? formatNumber(n, dp) : '—';
  const pct = (actual, budget) => {
    if (budget == null || actual == null) return '<span style="color:var(--hint)">—</span>';
    const v = Math.round((actual - budget) / Math.abs(budget) * 100);
    const col = v >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${col};font-weight:600">${v > 0 ? '+' : ''}${v}%</span>`;
  };
  const varAmt = (actual, budget) => {
    if (budget == null || actual == null) return '<span style="color:var(--hint)">—</span>';
    const v = actual - budget;
    return `<span style="color:${v >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">${v >= 0 ? '+' : ''}${fC(v)}</span>`;
  };

  // ── Invoice totals for a commodity ─────────────────────────────────────────
  const invTotals = (invList, commName) => {
    let qty = 0, income = 0, qa = 0, costs = 0;
    const matchedInvs = [];
    const targetKey = commName ? commName.trim().toUpperCase().replace(/\s+/g,' ') : null;
    invList.forEach(inv => {
      const linked = contracts.find(c => c.id === inv.forward_contract_id);
      const iComm  = linked?.commodity || inv.commodity_type || (inv.line_items||[])[0]?.commodity || '';
      if (targetKey && iComm.trim().toUpperCase().replace(/\s+/g,' ') !== targetKey) return;
      matchedInvs.push(inv);
      if (inv.batches) {
        const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        qty += b.filter(x => (x.lines||[]).some(l => l.type==='income' && l.line_type!=='qa'))
                .reduce((s, x) => s + (parseFloat(x.qty)||0), 0);
      } else {
        qty += parseFloat(inv.total_qty) || 0;
      }
      income += parseFloat(inv.gross_amount)        || 0;
      qa     += parseFloat(inv.total_quality_adj)   || 0;
      costs  += parseFloat(inv.total_deductions)    || 0;
    });
    return { qty, income, qa, totalIncome: income + qa, costs, avgPrice: qty ? (income+qa)/qty : null, invoices: matchedInvs };
  };

  // ── Build commodity groups from budgets table only ─────────────────────────
  // budgets table has the authoritative commodity list for the season.
  // Contracts and invoices are matched to these groups by case-insensitive lookup
  // rather than being allowed to create new entries (which caused duplicates).
  const groups = {};
  budgets.forEach(b => {
    if (!b.commodity) return;
    const key = b.commodity.trim().toUpperCase().replace(/\s+/g,' ');
    if (!groups[key]) groups[key] = { name: b.commodity.trim(), budgets: [] };
    groups[key].budgets.push(b);
  });
  // Match helper — returns the group key for a commodity name, or null
  const findGroup = (commName) => {
    if (!commName) return null;
    const k = commName.trim().toUpperCase().replace(/\s+/g,' ');
    return groups[k] ? k : null;
  };

  // ── Budget from budgets table ───────────────────────────────────────────────
  const budgetForGroup = (g, opts = {}) => {
    if (!g.budgets.length) return { bIncome: null, bYTD: null, bArea: null, bYield: null, bPrice: null, bProd: null };
    // Carry-over: use only the stored gross revenue total — don't use area/yield/price
    // (GM sheet partial-match can bleed current-season metrics onto prior-year crop rows)
    if (opts.carryOver) {
      const bIncome = g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue)||0), 0) || null;
      const bYTD    = bIncome != null ? bIncome * ytdFraction : null;
      return { bIncome, bYTD, bArea: null, bYield: null, bProd: null, bPrice: null };
    }
    const bArea   = g.budgets.reduce((s, b) => s + (parseFloat(b.area_ha)||0), 0);
    const bYield  = bArea
      ? g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_yield_per_ha)||0) * (parseFloat(b.area_ha)||0), 0) / bArea
      : 0;
    const bProd   = bArea && bYield ? Math.round(bArea * bYield) : null;
    const bPrice  = g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_price)||0), 0) / g.budgets.length;
    const bIncome = bProd && bPrice ? bProd * bPrice : g.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_gross_revenue)||0), 0) || null;
    const bYTD    = bIncome != null ? bIncome * ytdFraction : null;
    return { bIncome, bYTD, bArea, bYield, bProd, bPrice };
  };

  // Table styles
  const th  = `padding:7px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);border-bottom:2px solid var(--border);white-space:nowrap`;
  const thR = th + ';text-align:right';
  const td  = `padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border-light)`;
  const tdR = td + ';text-align:right;font-variant-numeric:tabular-nums';
  const secRow  = label => `<tr style="background:#1e3a5f"><td colspan="7" style="padding:7px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:white">${label}</td></tr>`;
  const commRow = label => `<tr style="background:#e8f0fe"><td colspan="7" style="padding:5px 12px;font-size:11px;font-weight:600;color:#1e3a5f">${label}</td></tr>`;

  let grandBudget = 0, grandBudgetYTD = 0, grandActual = 0;

  // ── Single commodity row builder ───────────────────────────────────────────
  // Returns { html, bIncome, bYTD, actual } so callers can build subtotals
  const buildCommRow = (g, opts = {}) => {
    const { bIncome, bYTD, bArea, bProd } = budgetForGroup(g, { carryOver: opts.carryOver });
    const inv  = invTotals(seasonInvoices, g.name);
    const unit = g.budgets[0]?.unit || contracts.find(c => c.commodity?.toUpperCase() === g.name.toUpperCase())?.unit || 't';
    const hideAreaProd = opts.hideAreaProd;

    const detailId  = `inv-detail-${g.name.replace(/[^a-z0-9]/gi,'-')}`;
    const detailRows = inv.invoices.length
      ? inv.invoices.map(i => {
          const invDate  = formatDate(i.invoice_date?.slice(0,10));
          const invInc   = (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0);
          const invQty   = (() => {
            if (i.batches) {
              const b = typeof i.batches==='string'?JSON.parse(i.batches):i.batches;
              return b.filter(x=>(x.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa'))
                      .reduce((s,x)=>s+(parseFloat(x.qty)||0),0);
            }
            return parseFloat(i.total_qty)||0;
          })();
          return `<tr style="background:#fafbff">
            <td style="${td};padding-left:36px;font-size:11px;color:var(--hint)">${invDate}</td>
            <td style="${td};font-size:11px;color:var(--hint)">${i.buyer || '—'}</td>
            <td style="${tdR};font-size:11px;color:var(--hint)">${invQty ? fN(invQty,2)+' '+unit : '—'}</td>
            <td style="${tdR};font-size:11px;color:var(--hint)">${i.xero_invoice_number || i.id?.slice(0,8) || '—'}</td>
            <td style="${tdR};font-size:11px;color:var(--green)">${fC(invInc)}</td>
            <td colspan="2" style="${tdR}"></td>
          </tr>`;
        }).join('')
      : `<tr style="background:#fafbff"><td colspan="7" style="${td};padding-left:36px;font-size:11px;color:var(--hint);font-style:italic">No invoices this season</td></tr>`;

    const html = `
      ${commRow(g.name)}
      <tr style="cursor:pointer" onclick="
        const el=document.getElementById('${detailId}');
        if(el){el.style.display=el.style.display==='none'?'':'none';}
      ">
        <td style="${td};padding-left:20px;color:var(--hint)">
          Income
          <span style="font-size:10px;color:var(--hint);margin-left:6px">${inv.invoices.length ? `▸ ${inv.invoices.length} invoice${inv.invoices.length!==1?'s':''}` : ''}</span>
        </td>
        <td style="${tdR}">${!hideAreaProd && bArea ? fN(bArea,1)+' ha' : '—'}</td>
        <td style="${tdR}">${!hideAreaProd && bProd ? fN(bProd)+' '+unit : '—'}</td>
        <td style="${tdR};color:${inv.totalIncome ? 'var(--green)' : 'var(--hint)'};font-weight:600">${inv.totalIncome ? fC(inv.totalIncome) : '—'}</td>
        <td style="${tdR}">${bYTD != null ? fC(bYTD) : '—'}</td>
        <td style="${tdR}">${bIncome != null ? fC(bIncome) : '—'}</td>
        <td style="${tdR}">${varAmt(inv.totalIncome, bYTD)}</td>
      </tr>
      <tbody id="${detailId}" style="display:none">
        ${detailRows}
      </tbody>
    `;
    return { html, bIncome: bIncome || 0, bYTD: bYTD || 0, actual: inv.totalIncome };
  };

  // ── Section builder — renders rows + subtotal row, accumulates into grand totals ──
  const buildSection = (label, gList, opts = {}) => {
    if (!gList.length) return '';
    let secBudget = 0, secBudgetYTD = 0, secActual = 0;
    const rowsHtml = gList.map(g => {
      const r = buildCommRow(g, { hideAreaProd: opts.hideAreaProd, carryOver: opts.carryOver });
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
        <td colspan="2" style="${tdR}"></td>
        <td style="${tdR};color:var(--green);font-weight:600">${secActual ? fC(secActual) : '—'}</td>
        <td style="${tdR};font-weight:600">${secBudgetYTD ? fC(secBudgetYTD) : '—'}</td>
        <td style="${tdR};font-weight:600">${secBudget ? fC(secBudget) : '—'}</td>
        <td style="${tdR}">${varAmt(secActual, secBudgetYTD)}</td>
      </tr>`;
    return secRow(label) + rowsHtml + subtotal;
  };

  // ── Income rows — grouped by section matching budget import ───────────────
  // section not persisted to DB — infer from commodity name:
  //   ALL-CAPS = new season farming crop
  //   mixed-case = carry-over (prior season crop still being sold)
  //   cattle keyword = livestock section (own metrics)
  //   other keywords = other income
  const isCattle    = (name) => /cattle|livestock/i.test(name);
  const isOther     = (name) => !isCattle(name) && /agistment|interest received|rent|lease|royalt/i.test(name);
  const isCarryOver = (name) => !isCattle(name) && !isOther(name) && name !== name.toUpperCase();
  const isFarming   = (name) => !isCattle(name) && !isOther(name) && !isCarryOver(name);

  const sortedGroups = Object.values(groups).sort((a, b) =>
    a.name.toUpperCase().localeCompare(b.name.toUpperCase())
  );
  const farmingGroups   = sortedGroups.filter(g => isFarming(g.name));
  const cattleGroups    = sortedGroups.filter(g => isCattle(g.name));
  const otherGroups     = sortedGroups.filter(g => isOther(g.name));
  const carryOverGroups = sortedGroups.filter(g => isCarryOver(g.name));

  const incomeRows = [
    buildSection('Farming income',    farmingGroups),
    buildSection('Livestock income',  cattleGroups,    { hideAreaProd: true }),
    buildSection('Other income',      otherGroups,     { hideAreaProd: true }),
    buildSection('Carry-over income', carryOverGroups, { hideAreaProd: true, carryOver: true }),
  ].join('');

  // ── Fixed costs from budget_costs ──────────────────────────────────────────
  const fixedCats = [
    { key: 'labour',    label: 'Labour & Farm Management' },
    { key: 'overhead',  label: 'Overheads' },
    { key: 'rm',        label: 'Repairs & Maintenance' },
    { key: 'fund_mgmt', label: 'Fund Management' },
  ];
  let totalFixedBudget = 0;
  const fixedRows = fixedCats.map(cat => {
    const lines = budgetCosts.filter(c => c.category === cat.key);
    if (!lines.length) return '';
    const catTotal = lines.reduce((s, c) => s + (parseFloat(c.budget_amount)||0), 0);
    totalFixedBudget += catTotal;
    return `
      ${commRow(cat.label)}
      ${lines.map(c => `
        <tr>
          <td style="${td};padding-left:28px;font-size:11px;color:var(--hint)">${c.description}</td>
          <td colspan="3" style="${tdR}"></td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(parseFloat(c.budget_amount)||0)}</td>
          <td style="${tdR};font-size:11px;color:var(--red)">-${fC(parseFloat(c.budget_amount)||0)}</td>
          <td style="${tdR}">—</td>
        </tr>`).join('')}
      <tr style="background:var(--page-bg)">
        <td style="${td};padding-left:20px;font-weight:600;font-size:12px">${cat.label} total</td>
        <td colspan="3" style="${tdR}"></td>
        <td style="${tdR};color:var(--red);font-weight:600">-${fC(catTotal)}</td>
        <td style="${tdR};color:var(--red);font-weight:600">-${fC(catTotal)}</td>
        <td style="${tdR}">—</td>
      </tr>`;
  }).join('');

  // ── Comments ───────────────────────────────────────────────────────────────
  const commentRows = comments.length
    ? comments.map(c => `
        <tr>
          <td style="${td};color:var(--hint);font-size:11px;white-space:nowrap;width:90px">${formatDate(c.created_at?.slice(0,10))}</td>
          <td style="${td};font-size:11px;color:var(--hint);white-space:nowrap;width:130px">${c.user_profiles?.full_name||'User'}</td>
          <td style="${td};font-size:12px" colspan="5">${c.comment}</td>
        </tr>`).join('')
    : `<tr><td colspan="7" style="${td};color:var(--hint);font-style:italic">No comments yet</td></tr>`;

  body.innerHTML = `
    <!-- Summary tiles -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px">
      ${[
        ['Actual YTD income',   fC(grandActual),                          'var(--green)'],
        ['Budget YTD income',   fC(grandBudgetYTD),                       'var(--ink)'],
        ['Full year budget',    fC(grandBudget),                          'var(--blue)'],
        ['YTD variance',        (grandActual - grandBudgetYTD >= 0 ? '+' : '') + fC(grandActual - grandBudgetYTD),
                                grandActual - grandBudgetYTD >= 0 ? 'var(--green)' : 'var(--red)'],
      ].map(([l,v,c]) => `
        <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${l}</div>
          <div style="font-size:20px;font-weight:700;color:${c}">${v}</div>
        </div>`).join('')}
    </div>

    <!-- Note on budget YTD -->
    <div style="font-size:11px;color:var(--hint);margin-bottom:12px;font-style:italic">
      ℹ Budget YTD is pro-rated (${monthsElapsed} of 12 months elapsed from ${new Date(seasonYear, seasonStartMonthIdx).toLocaleString('en-AU',{month:'long'})}). Click any income row to see invoice detail.
    </div>

    <!-- Main table -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:800px">
          <thead>
            <tr>
              <th style="${th};text-align:left;min-width:200px"></th>
              <th style="${thR}">Area</th>
              <th style="${thR}">Budget prod.</th>
              <th style="${thR}">Actual YTD</th>
              <th style="${thR}">Budget YTD</th>
              <th style="${thR}">Full yr budget</th>
              <th style="${thR}">Variance</th>
            </tr>
          </thead>
          <tbody>
            ${incomeRows || `<tr><td colspan="7" style="${td};color:var(--hint);font-style:italic;padding-left:20px">No income budgets or invoices for this season</td></tr>`}

            <!-- Income total -->
            <tr style="background:#f0fdf4;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700">Total income</td>
              <td colspan="2" style="${tdR}"></td>
              <td style="${tdR};color:var(--green);font-weight:700;font-size:13px">${fC(grandActual)}</td>
              <td style="${tdR};font-weight:700">${fC(grandBudgetYTD)}</td>
              <td style="${tdR};font-weight:700">${fC(grandBudget)}</td>
              <td style="${tdR}">${varAmt(grandActual, grandBudgetYTD)}</td>
            </tr>

            ${budgetCosts.length ? `
              ${secRow('Fixed costs')}
              ${fixedRows}
              <tr style="background:#fff5f5;border-top:2px solid var(--border)">
                <td style="${td};font-weight:700">Total fixed costs</td>
                <td colspan="3" style="${tdR}"></td>
                <td style="${tdR};color:var(--red);font-weight:700">-${fC(totalFixedBudget)}</td>
                <td style="${tdR};color:var(--red);font-weight:700">-${fC(totalFixedBudget)}</td>
                <td style="${tdR}">—</td>
              </tr>
            ` : ''}

            <!-- Net -->
            <tr style="background:#eff6ff;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700;font-size:13px;color:var(--blue)">Net income (income only)</td>
              <td colspan="2" style="${tdR}"></td>
              <td style="${tdR};color:var(--blue);font-weight:700;font-size:13px">${fC(grandActual)}</td>
              <td colspan="2" style="${tdR}"></td>
              <td style="${tdR}">${varAmt(grandActual, grandBudgetYTD)}</td>
            </tr>
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
}

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
