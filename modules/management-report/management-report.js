// modules/management-report/management-report.js
// Management P&L — Option B: Units-first layout

import { dbSelect, dbInsert } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js';
import { formatCurrency, formatNumber, formatDate, qs, toast } from '../../js/ui.js';

export function unmountManagementReport() {}

export async function mountManagementReport(container) {
  container.innerHTML = `
    <div style="padding:20px 24px;max-width:1200px;margin:0 auto">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap">
        <select id="mgmt-month" class="form-select" style="width:170px">
          <option value="">Select month...</option>
        </select>
        <span id="mgmt-ytd-label" style="font-size:12px;color:var(--hint)"></span>
        <div style="flex:1"></div>
        ${canWrite() ? '<button class="btn btn-ghost btn-sm" id="mgmt-comment-btn">💬 Add comment</button>' : ''}
      </div>
      <div id="mgmt-body">
        <div style="padding:60px;text-align:center;color:var(--hint)">Select a month to view the report</div>
      </div>
    </div>
  `;

  await _populateMonths(container);
  qs('#mgmt-month', container)?.addEventListener('change', () => _render(container));
  qs('#mgmt-comment-btn', container)?.addEventListener('click', () => _addComment(container));
}

async function _populateMonths(container) {
  const farm = getActiveFarm();
  if (!farm) return;
  const invoices = await dbSelect('invoices', `farm_id=eq.${farm.id}&select=invoice_date`);
  const months = [...new Set(invoices.map(i => i.invoice_date?.slice(0,7)).filter(Boolean))].sort().reverse();
  const sel = qs('#mgmt-month', container);
  months.forEach(m => {
    const [y, mo] = m.split('-');
    sel.innerHTML += `<option value="${m}">${new Date(y, mo-1).toLocaleDateString('en-AU',{month:'long',year:'numeric'})}</option>`;
  });
  if (months.length) { sel.value = months[0]; _render(container); }
}

async function _render(container) {
  const farm = getActiveFarm();
  const season = getActiveSeason();
  const selectedMonth = qs('#mgmt-month', container)?.value;
  if (!farm || !season || !selectedMonth) return;

  const [y, mo] = selectedMonth.split('-');
  const monthLabel = new Date(y, mo-1).toLocaleDateString('en-AU', {month:'long', year:'numeric'});
  const seasonYear = parseInt(season.split('-')[0]);
  const ytdStart = `${seasonYear}-07`;

  qs('#mgmt-ytd-label', container).textContent = `YTD: Jul ${seasonYear} – ${monthLabel}`;

  const body = qs('#mgmt-body', container);
  body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--hint)">Loading...</div>';

  const [contracts, allInvoices, budgets, cropTypes, harvests, comments] = await Promise.all([
    dbSelect('forward_contracts', `farm_id=eq.${farm.id}&crop_year=eq.${season}&select=*`),
    dbSelect('invoices', `farm_id=eq.${farm.id}&select=*&order=invoice_date.asc`),
    dbSelect('budgets', `farm_id=eq.${farm.id}&season=eq.${season}&select=*`),
    dbSelect('crop_types', `select=id,name`),
    dbSelect('harvest_entries', `farm_id=eq.${farm.id}&season=eq.${season}&select=*`),
    dbSelect('management_comments', `farm_id=eq.${farm.id}&season=eq.${season}&select=*,user_profiles(full_name)&order=created_at.desc`).catch(()=>[]),
  ]);

  // Period filters
  const monthInv = allInvoices.filter(i => i.invoice_date?.slice(0,7) === selectedMonth);
  const ytdInv = allInvoices.filter(i => {
    const m = i.invoice_date?.slice(0,7);
    return m && m >= ytdStart && m <= selectedMonth;
  });

  // Months elapsed for YTD budget proration
  // Months elapsed since July start of season
  const monthsElapsed = Math.max(1, ((parseInt(y) - seasonYear) * 12 + (parseInt(mo) - 7)) + 1);

  // Helpers
  const fC = (n, dp=0) => n != null && !isNaN(n) && n !== 0 ? formatCurrency(n, dp) : '—';
  const fN = (n, dp=0) => n != null && !isNaN(n) && n !== 0 ? formatNumber(n, dp) : '—';
  const varPct = (actual, budget) => {
    if (!budget || !actual) return '<span style="color:var(--hint)">—</span>';
    const pct = Math.round((actual - budget) / Math.abs(budget) * 100);
    const color = pct >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${color};font-weight:600">${pct > 0 ? '+' : ''}${pct}%</span>`;
  };
  const varAmt = (actual, budget) => {
    if (!budget || actual == null) return '—';
    const v = actual - budget;
    const color = v >= 0 ? 'var(--green)' : 'var(--red)';
    return `<span style="color:${color}">${v > 0 ? '+' : ''}${fC(v)}</span>`;
  };

  // Invoice totals helper
  const invTotals = (invList, commName) => {
    let qty = 0, income = 0, qa = 0, costs = 0;
    invList.forEach(inv => {
      const c = contracts.find(x => x.id === inv.forward_contract_id);
      const invComm = c?.commodity || inv.commodity_type || (inv.line_items||[])[0]?.commodity;
      if (commName && invComm !== commName) return;
      if (inv.batches) {
        const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
        qty += b.filter(x=>(x.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa')).reduce((s,x)=>s+(parseFloat(x.qty)||0),0);
      } else {
        qty += parseFloat(inv.total_qty)||0;
      }
      income += parseFloat(inv.gross_amount)||0;
      qa += parseFloat(inv.total_quality_adj)||0;
      costs += parseFloat(inv.total_deductions)||0;
    });
    return { qty, income, qa, totalIncome: income+qa, costs, net: income+qa-costs,
             avgPrice: qty ? (income+qa)/qty : null };
  };

  // Build commodity groups
  const normName = n => (n||'').trim();
  const groups = {};
  const getOrCreate = (commName, commId, cropTypeId) => {
    const key = normName(commName);
    if (!groups[key]) groups[key] = { commName: key, commId, cropTypeId, budgets:[], harvests:[] };
    return groups[key];
  };

  budgets.forEach(b => getOrCreate(b.commodity, b.commodity_id, b.crop_type_id).budgets.push(b));
  harvests.forEach(h => getOrCreate(h.commodity, h.commodity_id, h.crop_type_id).harvests.push(h));
  contracts.forEach(c => getOrCreate(c.commodity, c.commodity_id, null));
  allInvoices.forEach(inv => {
    const c = contracts.find(x => x.id === inv.forward_contract_id);
    if (c) getOrCreate(c.commodity, c.commodity_id, null);
  });

  // Table styles
  const th = `padding:7px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);border-bottom:2px solid var(--border)`;
  const td = `padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border-light)`;
  const tdr = td + ';text-align:right;font-variant-numeric:tabular-nums';
  const secHdr = (label) => `<tr style="background:#1a3a5c"><td colspan="10" style="padding:7px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:white">${label}</td></tr>`;
  const totHdr = (label) => `<tr style="background:#1a3a5c"><td colspan="10" style="padding:7px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:white">${label}</td></tr>`;

  let grandMonthIncome = 0, grandYtdIncome = 0, grandBudget = 0;
  let grandMonthCosts = 0, grandYtdCosts = 0;

  const commodityBlocks = Object.values(groups)
    .filter(g => g.commName && (g.budgets.length || g.harvests.length ||
      allInvoices.some(i => contracts.find(c=>c.id===i.forward_contract_id)?.commodity === g.commName)))
    .sort((a,b) => a.commName.localeCompare(b.commName))
    .map(g => {
      const unit = g.budgets[0]?.unit || contracts.find(c=>c.commodity===g.commName)?.unit || 'bale';

      // Budget — sum all budgets for this commodity
      const bArea = g.budgets.reduce((s,b)=>s+(parseFloat(b.area_ha)||0),0);
      const bYield = bArea ? g.budgets.reduce((s,b)=>s+(parseFloat(b.yield_per_ha)||0)*(parseFloat(b.area_ha)||0),0)/bArea : 0;
      const bProd = bArea && bYield ? Math.round(bArea * bYield) : null;
      const bPrice = g.budgets.length ? g.budgets.reduce((s,b)=>s+(parseFloat(b.price)||0),0)/g.budgets.length : null;
      // Fallback: derive budget from contracts if no budget entries
      const contractBudgetQty = !bProd ? contracts.filter(c=>c.commodity===g.commName).reduce((s,c)=>s+(parseFloat(c.quantity)||0),0) : null;
      const contractBudgetPrice = !bPrice ? contracts.filter(c=>c.commodity===g.commName).reduce((s,c)=>s+(parseFloat(c.price_per_unit)||0),0)/(contracts.filter(c=>c.commodity===g.commName).length||1) : null;
      const effProd = bProd || contractBudgetQty || null;
      const effPrice = bPrice || contractBudgetPrice || null;
      const bIncome = effProd && effPrice ? effProd * effPrice : null;
      const bIncomeYtd = bIncome ? bIncome * (monthsElapsed/12) : null;
      const bIncomeMonth = bIncome ? bIncome / 12 : null;

      // Harvest
      const harvested = g.harvests.reduce((s,h)=>s+(parseFloat(h.actual_production)||0),0);

      // Invoiced
      const month = invTotals(monthInv, g.commName);
      const ytd = invTotals(ytdInv, g.commName);

      grandMonthIncome += month.totalIncome;
      grandYtdIncome += ytd.totalIncome;
      grandBudget += bIncome || 0;
      grandMonthCosts += month.costs;
      grandYtdCosts += ytd.costs;

      return `
        <tr style="background:#e8f0fe">
          <td colspan="10" style="${td};font-weight:600;color:#1a3a5c;background:#e8f0fe">${g.commName}</td>
        </tr>

        <tr>
          <td style="${td};padding-left:20px;color:var(--hint)">Harvested (${unit})</td>
          <td style="${tdr}">${fN(harvested)}</td>
          <td style="${tdr};color:var(--blue)">—</td>
          <td style="${tdr}">—</td>
          <td style="${tdr}">${effProd ? fN(effProd)+' '+unit : '—'}</td>
          <td style="${tdr}">${fN(ytd.qty,2) !== '—' ? fN(ytd.qty,2)+' '+unit : '—'}</td>
          <td style="${tdr};color:var(--blue)">—</td>
          <td style="${tdr}">${effProd ? fN(effProd)+' '+unit : '—'}</td>
          <td style="${tdr}">${varPct(ytd.qty, effProd)}</td>
          <td style="${tdr}">${effProd ? fN(effProd)+' '+unit : '—'}</td>
        </tr>

        <tr style="background:var(--page-bg)">
          <td style="${td};padding-left:20px;color:var(--hint)">Price ($/unit)</td>
          <td style="${tdr}">—</td>
          <td style="${tdr};color:var(--blue)">${month.avgPrice ? fC(month.avgPrice,2) : '—'}</td>
          <td style="${tdr}">${bPrice ? fC(bPrice,2) : '—'}</td>
          <td style="${tdr}">${varAmt(month.avgPrice, effPrice)}</td>
          <td style="${tdr}">${ytd.avgPrice ? fC(ytd.avgPrice,2) : '—'}</td>
          <td style="${tdr};color:var(--blue)">—</td>
          <td style="${tdr}">${bPrice ? fC(bPrice,2) : '—'}</td>
          <td style="${tdr}">${varPct(ytd.avgPrice, effPrice)}</td>
          <td style="${tdr}">${bPrice ? fC(bPrice,2) : '—'}</td>
        </tr>

        <tr style="border-top:1px solid var(--border)">
          <td style="${td};padding-left:20px;font-weight:600;color:var(--ink)">Income</td>
          <td style="${tdr}">—</td>
          <td style="${tdr};color:${month.totalIncome?'var(--green)':'var(--hint)'};font-weight:600">${fC(month.totalIncome)}</td>
          <td style="${tdr}">${fC(bIncomeMonth)}</td>
          <td style="${tdr}">${varAmt(month.totalIncome, bIncomeMonth)}</td>
          <td style="${tdr}">—</td>
          <td style="${tdr};color:${ytd.totalIncome?'var(--green)':'var(--hint)'};font-weight:600">${fC(ytd.totalIncome)}</td>
          <td style="${tdr}">${fC(bIncomeYtd)}</td>
          <td style="${tdr}">${varPct(ytd.totalIncome, bIncomeYtd)}</td>
          <td style="${tdr};font-weight:600">${fC(bIncome)}</td>
        </tr>

        ${month.costs || ytd.costs ? `
        <tr>
          <td style="${td};padding-left:28px;color:var(--hint);font-size:11px">↳ Selling costs</td>
          <td style="${tdr}">—</td>
          <td style="${tdr};color:var(--red)">${month.costs ? '-'+fC(month.costs) : '—'}</td>
          <td colspan="2" style="${tdr}"></td>
          <td style="${tdr}">—</td>
          <td style="${tdr};color:var(--red)">${ytd.costs ? '-'+fC(ytd.costs) : '—'}</td>
          <td colspan="2" style="${tdr}"></td>
          <td style="${tdr}"></td>
        </tr>` : ''}
      `;
    }).join('');

  // Comments section
  const commentRows = comments.length
    ? comments.map(c => `
        <tr>
          <td style="${td};color:var(--hint);font-size:11px;white-space:nowrap;width:90px">${formatDate(c.created_at?.slice(0,10))}</td>
          <td style="${td};font-size:11px;color:var(--hint);white-space:nowrap;width:120px">${c.user_profiles?.full_name||'User'}</td>
          <td style="${td};font-size:11px;color:var(--hint);white-space:nowrap;width:80px">${c.month ? new Date(c.month+'-01').toLocaleDateString('en-AU',{month:'short',year:'numeric'}) : '—'}</td>
          <td style="${td};font-size:12px">${c.comment}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="${td};color:var(--hint);font-style:italic">No comments yet — add one above</td></tr>`;

  body.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:16px">
      <div>
        <div style="font-size:20px;font-weight:700;color:var(--ink)">${farm.name} — Management Report</div>
        <div style="font-size:12px;color:var(--hint);margin-top:3px">Season ${season} · Production-based income · As at ${formatDate(new Date().toISOString().slice(0,10))}</div>
      </div>
    </div>

    <!-- Summary strip -->
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:20px">
      ${[
        ['Month income', grandMonthIncome, 'var(--green)'],
        ['Month selling costs', grandMonthCosts, 'var(--red)'],
        ['Month net', grandMonthIncome-grandMonthCosts, 'var(--blue)'],
        ['YTD income', grandYtdIncome, 'var(--green)'],
        ['YTD net income', grandYtdIncome-grandYtdCosts, 'var(--blue)'],
      ].map(([label,val,color])=>`
        <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${label}</div>
          <div style="font-size:18px;font-weight:700;color:${color}">${formatCurrency(val||0,0)}</div>
        </div>`).join('')}
    </div>

    <!-- Main table -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:950px">
          <thead>
            <tr style="background:var(--page-bg)">
              <th style="${th};text-align:left;min-width:180px" rowspan="2">Item</th>
              <th style="${th};text-align:right;min-width:90px" rowspan="2">Harvested</th>
              <th colspan="3" style="${th};text-align:center;background:#eff6ff;color:var(--blue);border-left:2px solid var(--blue)">${monthLabel}</th>
              <th style="${th};text-align:right;min-width:90px;border-left:2px solid var(--border)" rowspan="2">YTD harvested</th>
              <th colspan="3" style="${th};text-align:center;background:#f0fdf4;color:var(--green);border-left:2px solid var(--green)">Year to date</th>
              <th style="${th};text-align:right;min-width:100px;border-left:2px solid var(--border)" rowspan="2">Full year budget</th>
            </tr>
            <tr style="background:var(--page-bg)">
              <th style="${th};text-align:right;background:#eff6ff;border-left:2px solid var(--blue)">Actual</th>
              <th style="${th};text-align:right;background:#eff6ff">Budget</th>
              <th style="${th};text-align:right;background:#eff6ff">Var</th>
              <th style="${th};text-align:right;background:#f0fdf4;border-left:2px solid var(--green)">Actual</th>
              <th style="${th};text-align:right;background:#f0fdf4">Budget YTD</th>
              <th style="${th};text-align:right;background:#f0fdf4">Var %</th>
            </tr>
          </thead>
          <tbody>
            ${secHdr('CROP & LIVESTOCK INCOME')}
            ${commodityBlocks}

            <!-- Income total -->
            <tr style="background:#f0fdf4;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700;font-size:13px">Total income</td>
              <td style="${tdr}">—</td>
              <td style="${tdr};color:var(--green);font-weight:700;font-size:13px;border-left:2px solid var(--blue)">${fC(grandMonthIncome)}</td>
              <td style="${tdr}">${fC(grandBudget/12)}</td>
              <td style="${tdr}">${varAmt(grandMonthIncome, grandBudget/12)}</td>
              <td style="${tdr};border-left:2px solid var(--border)">—</td>
              <td style="${tdr};color:var(--green);font-weight:700;font-size:13px;border-left:2px solid var(--green)">${fC(grandYtdIncome)}</td>
              <td style="${tdr}">${fC(grandBudget*monthsElapsed/12)}</td>
              <td style="${tdr}">${varPct(grandYtdIncome, grandBudget*monthsElapsed/12)}</td>
              <td style="${tdr};font-weight:700;border-left:2px solid var(--border)">${fC(grandBudget)}</td>
            </tr>

            ${secHdr('DIRECT COSTS')}
            <tr>
              <td style="${td};padding-left:20px">Selling costs (ginning, levies)</td>
              <td style="${tdr}">—</td>
              <td style="${tdr};color:var(--red);border-left:2px solid var(--blue)">${grandMonthCosts?'-'+fC(grandMonthCosts):'—'}</td>
              <td style="${tdr}">—</td>
              <td style="${tdr}">—</td>
              <td style="${tdr};border-left:2px solid var(--border)">—</td>
              <td style="${tdr};color:var(--red);border-left:2px solid var(--green)">${grandYtdCosts?'-'+fC(grandYtdCosts):'—'}</td>
              <td style="${tdr}">—</td>
              <td style="${tdr}">—</td>
              <td style="${tdr};border-left:2px solid var(--border)">—</td>
            </tr>
            <tr style="background:var(--page-bg)">
              <td style="${td};padding-left:20px;color:var(--hint);font-style:italic">Fertiliser, chemicals, water, fuel</td>
              <td colspan="9" style="${td};color:var(--hint);font-style:italic;font-size:11px">Available when cost modules are built</td>
            </tr>

            <!-- Net income -->
            <tr style="background:#eff6ff;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700;font-size:13px;color:var(--blue)">Net income</td>
              <td style="${tdr}">—</td>
              <td style="${tdr};color:var(--blue);font-weight:700;font-size:13px;border-left:2px solid var(--blue)">${fC(grandMonthIncome-grandMonthCosts)}</td>
              <td style="${tdr}">—</td>
              <td style="${tdr}">—</td>
              <td style="${tdr};border-left:2px solid var(--border)">—</td>
              <td style="${tdr};color:var(--blue);font-weight:700;font-size:13px;border-left:2px solid var(--green)">${fC(grandYtdIncome-grandYtdCosts)}</td>
              <td style="${tdr}">—</td>
              <td style="${tdr}">—</td>
              <td style="${tdr};font-weight:700;border-left:2px solid var(--border)">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Comments -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <div style="padding:10px 16px;background:var(--page-bg);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:12px;font-weight:600;color:var(--ink)">Comments & notes</span>
        <span style="font-size:11px;color:var(--hint)">${comments.length} comment${comments.length!==1?'s':''}</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${commentRows}</tbody>
      </table>
    </div>
  `;
}

async function _addComment(container) {
  const farm = getActiveFarm();
  const season = getActiveSeason();
  const month = qs('#mgmt-month', container)?.value;
  const session = getSession();
  if (!farm || !season) return;

  const text = prompt('Add a comment or note:');
  if (!text?.trim()) return;

  try {
    await dbInsert('management_comments', {
      farm_id: farm.id,
      season,
      month,
      comment: text.trim(),
      created_by: session?.user?.id,
    });
    toast('Comment saved', 'success');
    _render(container);
  } catch(e) {
    toast('Could not save — run SQL to create comments table first', 'error');
    console.error(e);
  }
}