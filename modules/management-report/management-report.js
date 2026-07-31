// modules/management-report/management-report.js
// Management P&L — Option A: flat rows, season-to-date vs full year budget

import { dbSelect, dbInsert } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js';
import { formatCurrency, formatNumber, formatDate, qs, toast } from '../../js/ui.js';

export function unmountManagementReport() {}

export async function mountManagementReport(container) {
  container.innerHTML = `
    <div style="padding:20px 24px;max-width:1100px;margin:0 auto">
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
  const farm = getActiveFarm();
  const season = getActiveSeason();
  if (!farm || !season) return;

  const seasonYear = parseInt(season.split('-')[0]);

  qs('#mgmt-title', container).textContent = `${farm.name} — Management Report`;
  qs('#mgmt-sub', container).textContent = `Season ${season} · Season to date · As at ${formatDate(new Date().toISOString().slice(0,10))}`;

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

  // Season-to-date invoices (all of season)
  const seasonInvoices = allInvoices.filter(i => {
    const m = i.invoice_date?.slice(0,7);
    return m && m >= `${seasonYear}-07`;
  });

  const fC = (n) => n ? formatCurrency(n, 0) : '—';
  const fN = (n, dp=0) => n != null && n !== 0 ? formatNumber(n, dp) : '—';
  const pct = (actual, budget) => {
    if (!budget || actual == null) return '<span style="color:var(--hint)">—</span>';
    const v = Math.round((actual - budget) / Math.abs(budget) * 100);
    return `<span style="color:${v >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:600">${v > 0 ? '+' : ''}${v}%</span>`;
  };

  // Invoice totals for a commodity
  const invTotals = (invList, commName) => {
    let qty = 0, income = 0, qa = 0, costs = 0;
    invList.forEach(inv => {
      const c = contracts.find(x => x.id === inv.forward_contract_id);
      const iComm = c?.commodity || inv.commodity_type || (inv.line_items||[])[0]?.commodity;
      if (commName && iComm !== commName) return;
      if (inv.batches) {
        const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
        qty += b.filter(x=>(x.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa'))
                .reduce((s,x)=>s+(parseFloat(x.qty)||0),0);
      } else {
        qty += parseFloat(inv.total_qty)||0;
      }
      income += parseFloat(inv.gross_amount)||0;
      qa += parseFloat(inv.total_quality_adj)||0;
      costs += parseFloat(inv.total_deductions)||0;
    });
    const totalIncome = income + qa;
    return { qty, income, qa, totalIncome, costs, avgPrice: qty ? totalIncome/qty : null };
  };

  // Build commodity groups by name
  const groups = {};
  const upsert = (name, id) => {
    if (!name) return null;
    if (!groups[name]) groups[name] = { name, id, budgets:[], harvests:[] };
    return groups[name];
  };
  budgets.forEach(b => upsert(b.commodity, b.commodity_id)?.budgets.push(b));
  harvests.forEach(h => {
    const key = Object.keys(groups).find(k =>
      (h.commodity_id && groups[k].id === h.commodity_id) ||
      k === (h.commodity||h.commodity_name||'').trim()
    );
    if (key) groups[key].harvests.push(h);
    else upsert(h.commodity||h.commodity_name, h.commodity_id)?.harvests.push(h);
  });
  contracts.forEach(c => upsert(c.commodity, c.commodity_id));
  seasonInvoices.forEach(inv => {
    const c = contracts.find(x => x.id === inv.forward_contract_id);
    if (c) upsert(c.commodity, c.commodity_id);
  });

  // Table styles
  const th = `padding:7px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);border-bottom:2px solid var(--border);white-space:nowrap`;
  const thR = th + ';text-align:right';
  const td = `padding:6px 10px;font-size:12px;border-bottom:1px solid var(--border-light)`;
  const tdR = td + ';text-align:right;font-variant-numeric:tabular-nums';
  const secRow = (label) =>
    `<tr style="background:#1e3a5f"><td colspan="6" style="padding:7px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:white">${label}</td></tr>`;
  const commRow = (label) =>
    `<tr style="background:#e8f0fe"><td colspan="6" style="padding:5px 12px;font-size:11px;font-weight:600;color:#1e3a5f">${label}</td></tr>`;

  let totalHarvested = 0, totalInvoiced = 0, totalActual = 0, totalBudget = 0, totalCosts = 0;

  const incomeRows = Object.values(groups)
    .filter(g => g.name && (g.budgets.length || g.harvests.length ||
      seasonInvoices.some(i => contracts.find(c=>c.id===i.forward_contract_id)?.commodity===g.name)))
    .sort((a,b) => a.name.localeCompare(b.name))
    .map(g => {
      const unit = g.budgets[0]?.unit || contracts.find(c=>c.commodity===g.name)?.unit || 'unit';

      // Budget
      const bArea = g.budgets.reduce((s,b)=>s+(parseFloat(b.area_ha)||0),0);
      const bYield = bArea ? g.budgets.reduce((s,b)=>s+(parseFloat(b.yield_per_ha)||0)*(parseFloat(b.area_ha)||0),0)/bArea : 0;
      const bProd = bArea && bYield ? Math.round(bArea * bYield) : null;
      const bPrice = g.budgets.length ? g.budgets.reduce((s,b)=>s+(parseFloat(b.price)||0),0)/g.budgets.length : null;
      const bIncome = bProd && bPrice ? bProd * bPrice : null;

      // Fallback to contracts for Cotton Seed
      const ctrQty = !bProd ? contracts.filter(c=>c.commodity===g.name).reduce((s,c)=>s+(parseFloat(c.quantity)||0),0) : null;
      const ctrPrice = !bPrice ? (()=>{
        const cs = contracts.filter(c=>c.commodity===g.name);
        return cs.length ? cs.reduce((s,c)=>s+(parseFloat(c.price_per_unit)||0),0)/cs.length : null;
      })() : null;
      const effProd = bProd || ctrQty || null;
      const effPrice = bPrice || ctrPrice || null;
      const effIncome = bIncome || (effProd && effPrice ? effProd * effPrice : null);

      // Actual
      const harvested = g.harvests.reduce((s,h)=>s+
        (parseFloat(h.actual_production)||parseFloat(h.harvested_qty)||parseFloat(h.production)||0),0);
      const inv = invTotals(seasonInvoices, g.name);

      totalHarvested += harvested;
      totalInvoiced += inv.qty;
      totalActual += inv.totalIncome;
      totalBudget += effIncome || 0;
      totalCosts += inv.costs;

      return `
        ${commRow(g.name)}
        <tr>
          <td style="${td};padding-left:20px;color:var(--hint)">Yield (${unit})</td>
          <td style="${tdR}">${harvested ? fN(harvested)+' '+unit : '—'}</td>
          <td style="${tdR}">${inv.qty ? fN(inv.qty, 2)+' '+unit : '—'}</td>
          <td style="${tdR}">—</td>
          <td style="${tdR}">${effProd ? fN(effProd)+' '+unit : '—'}</td>
          <td style="${tdR}">${pct(harvested, effProd)}</td>
        </tr>
        <tr style="background:var(--page-bg)">
          <td style="${td};padding-left:20px;color:var(--hint)">Price ($/unit)</td>
          <td style="${tdR}">—</td>
          <td style="${tdR}">${inv.avgPrice ? fC(inv.avgPrice) : '—'}</td>
          <td style="${tdR}">—</td>
          <td style="${tdR}">${effPrice ? fC(effPrice) : '—'}</td>
          <td style="${tdR}">${pct(inv.avgPrice, effPrice)}</td>
        </tr>
        <tr style="border-top:1px solid var(--border)">
          <td style="${td};padding-left:20px;font-weight:600">Income</td>
          <td style="${tdR}">—</td>
          <td style="${tdR}">—</td>
          <td style="${tdR};color:${inv.totalIncome?'var(--green)':'var(--hint)'};font-weight:600">${fC(inv.totalIncome)}</td>
          <td style="${tdR}">${fC(effIncome)}</td>
          <td style="${tdR}">${pct(inv.totalIncome, effIncome)}</td>
        </tr>
        ${inv.costs ? `
        <tr>
          <td style="${td};padding-left:28px;color:var(--hint);font-size:11px">↳ Selling costs</td>
          <td colspan="2" style="${tdR}"></td>
          <td style="${tdR};color:var(--red);font-size:11px">-${fC(inv.costs)}</td>
          <td colspan="2" style="${tdR}"></td>
        </tr>` : ''}
      `;
    }).join('');

  // Comments
  const commentRows = comments.length
    ? comments.map(c=>`
        <tr>
          <td style="${td};color:var(--hint);font-size:11px;white-space:nowrap;width:90px">${formatDate(c.created_at?.slice(0,10))}</td>
          <td style="${td};font-size:11px;color:var(--hint);white-space:nowrap;width:130px">${c.user_profiles?.full_name||'User'}</td>
          <td style="${td};font-size:12px">${c.comment}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="${td};color:var(--hint);font-style:italic">No comments yet</td></tr>`;

  body.innerHTML = `
    <!-- Summary strip -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:20px">
      ${[
        ['Harvested', fN(totalHarvested), 'var(--ink)'],
        ['Invoiced', fN(totalInvoiced, 2), 'var(--ink)'],
        ['Total income', fC(totalActual), 'var(--green)'],
        ['Net income', fC(totalActual - totalCosts), 'var(--blue)'],
      ].map(([l,v,c])=>`
        <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${l}</div>
          <div style="font-size:20px;font-weight:700;color:${c}">${v}</div>
        </div>`).join('')}
    </div>

    <!-- Main table -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:700px">
          <thead>
            <tr>
              <th style="${th};text-align:left;min-width:200px"></th>
              <th style="${thR}">Harvested</th>
              <th style="${thR}">Invoiced</th>
              <th style="${thR}">Actual</th>
              <th style="${thR}">Full year budget</th>
              <th style="${thR}">Var %</th>
            </tr>
          </thead>
          <tbody>
            ${secRow('Income')}
            ${incomeRows}

            <!-- Income total -->
            <tr style="background:#f0fdf4;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700">Total income</td>
              <td style="${tdR}">—</td>
              <td style="${tdR}">—</td>
              <td style="${tdR};color:var(--green);font-weight:700;font-size:13px">${fC(totalActual)}</td>
              <td style="${tdR};font-weight:700">${fC(totalBudget)}</td>
              <td style="${tdR}">${pct(totalActual, totalBudget)}</td>
            </tr>

            ${secRow('Direct costs')}
            <tr>
              <td style="${td};padding-left:20px">Selling costs (ginning, levies)</td>
              <td colspan="2" style="${tdR}"></td>
              <td style="${tdR};color:var(--red)">${totalCosts ? '-'+fC(totalCosts) : '—'}</td>
              <td style="${tdR}">—</td>
              <td style="${tdR}">—</td>
            </tr>
            <tr style="background:var(--page-bg)">
              <td style="${td};padding-left:20px;color:var(--hint);font-style:italic">Fertiliser, chemicals, water, fuel</td>
              <td colspan="5" style="${td};color:var(--hint);font-style:italic;font-size:11px">Available when cost modules are built</td>
            </tr>

            <!-- Net -->
            <tr style="background:#eff6ff;border-top:2px solid var(--border)">
              <td style="${td};font-weight:700;font-size:13px;color:var(--blue)">Net income</td>
              <td colspan="2" style="${tdR}"></td>
              <td style="${tdR};color:var(--blue);font-weight:700;font-size:13px">${fC(totalActual - totalCosts)}</td>
              <td style="${tdR}">—</td>
              <td style="${tdR}">—</td>
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
  const farm = getActiveFarm();
  const season = getActiveSeason();
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