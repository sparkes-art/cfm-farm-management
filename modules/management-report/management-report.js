// modules/outputs/management-report.js
// Management P&L — production-based, season-centric, no Xero dependency

import { dbSelect } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, canWrite } from '../../js/app-state.js';
import { formatCurrency, formatNumber, formatDate, qs } from '../../js/ui.js';

let _unsub = null;

export function unmountManagementReport() {
  _unsub?.();
  _unsub = null;
}

export async function mountManagementReport(container) {
  container.innerHTML = `
    <div style="padding:24px;max-width:1100px;margin:0 auto">
      <div id="mgmt-report-body">
        <div style="display:flex;align-items:center;justify-content:center;padding:60px;color:var(--hint)">
          Loading...
        </div>
      </div>
    </div>
  `;
  await _render(container);
}

async function _render(container) {
  const farm = getActiveFarm();
  const season = getActiveSeason();
  if (!farm || !season) return;

  const [contracts, invoices, budgets, forecasts, harvests, commodities] = await Promise.all([
    dbSelect('forward_contracts', `farm_id=eq.${farm.id}&crop_year=eq.${season}&select=*`),
    dbSelect('invoices', `farm_id=eq.${farm.id}&select=*`),
    dbSelect('budgets', `farm_id=eq.${farm.id}&season=eq.${season}&select=*`),
    dbSelect('forecasts', `farm_id=eq.${farm.id}&season=eq.${season}&select=*&order=forecast_date.desc`),
    dbSelect('harvest_entries', `farm_id=eq.${farm.id}&season=eq.${season}&select=*`),
    dbSelect('commodities', `select=id,name`),
  ]);

  // Filter invoices to this season
  const seasonInvoices = invoices.filter(i =>
    i.season === season ||
    (i.line_items||[]).some(l => l.season === season) ||
    (i.batches && (typeof i.batches === 'string' ? JSON.parse(i.batches) : i.batches).some(b => b.crop_year === season))
  );

  // Build commodity map
  const commMap = {};
  const addComm = (id, name) => {
    const key = id || name;
    if (!key) return;
    if (!commMap[key]) commMap[key] = { id, name: name || id, contracts: [], invoices: [], budgets: [], forecasts: [], harvests: [] };
  };

  commodities.forEach(c => addComm(c.id, c.name));
  contracts.forEach(c => { addComm(c.commodity_id, c.commodity); commMap[c.commodity_id||c.commodity]?.contracts.push(c); });
  budgets.forEach(b => { addComm(b.commodity_id, b.commodity); commMap[b.commodity_id||b.commodity]?.budgets.push(b); });
  harvests.forEach(h => { addComm(h.commodity_id, h.commodity); commMap[h.commodity_id||h.commodity]?.harvests.push(h); });
  forecasts.forEach(f => { addComm(f.commodity_id, f.commodity); commMap[f.commodity_id||f.commodity]?.forecasts.push(f); });
  seasonInvoices.forEach(i => {
    const commodity = i.commodity_type || (i.line_items||[])[0]?.commodity;
    if (commodity) { addComm(null, commodity); commMap[commodity]?.invoices.push(i); }
    else {
      const key = Object.keys(commMap).find(k => contracts.find(c => c.id === i.forward_contract_id && (c.commodity_id === k || c.commodity === commMap[k]?.name)));
      if (key) commMap[key].invoices.push(i);
    }
  });

  const thS = 'padding:8px 12px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;text-align:right;border-bottom:2px solid var(--border)';
  const thL = thS + ';text-align:left';

  const fmtN = (n, dp=0) => n != null && !isNaN(n) ? formatNumber(n, dp) : '—';
  const fmtC = (n, dp=0) => n != null && !isNaN(n) && n !== 0 ? formatCurrency(n, dp) : '—';
  const varColor = (v) => v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--hint)';
  const varArrow = (v) => v > 0 ? '▲' : v < 0 ? '▼' : '';

  let totalBudgetIncome = 0, totalForecastIncome = 0, totalActualIncome = 0;

  const commodityRows = Object.values(commMap)
    .filter(com => com.contracts.length || com.budgets.length || com.harvests.length || com.invoices.length)
    .map(com => {
      const unit = contracts.find(c => c.commodity_id === com.id || c.commodity === com.name)?.unit || budgets.find(b => b.commodity_id === com.id)?.unit || 'bale';

      // Budget
      const budgetArea = com.budgets.reduce((s,b) => s+(parseFloat(b.area_ha)||0), 0);
      const budgetYield = com.budgets.reduce((s,b) => s+(parseFloat(b.yield_per_ha)||0), 0) / (com.budgets.length||1);
      const budgetProd = com.budgets.reduce((s,b) => s+(parseFloat(b.budget_production)||0), 0);
      const budgetPrice = com.budgets.reduce((s,b) => s+(parseFloat(b.price_per_unit)||0), 0) / (com.budgets.length||1);
      const budgetIncome = budgetProd * budgetPrice;

      // Forecast (latest)
      const latestForecast = com.forecasts[0];
      const forecastProd = latestForecast ? parseFloat(latestForecast.forecast_production) || null : null;
      const forecastPrice = latestForecast ? parseFloat(latestForecast.forecast_price) || budgetPrice : budgetPrice;
      const forecastIncome = forecastProd ? forecastProd * forecastPrice : null;

      // Actual harvest
      const actualProd = com.harvests.reduce((s,h) => s+(parseFloat(h.actual_production)||0), 0);
      const actualArea = com.harvests.reduce((s,h) => s+(parseFloat(h.area_ha)||0), 0);
      const actualYield = actualArea ? actualProd / actualArea : null;

      // Invoiced (actual income)
      const invQty = com.invoices.reduce((s,i) => {
        if (i.batches) {
          const b = typeof i.batches==='string'?JSON.parse(i.batches):i.batches;
          return s + b.filter(x=>(x.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa')).reduce((ss,x)=>ss+(parseFloat(x.qty)||0),0);
        }
        return s + (parseFloat(i.total_qty)||0);
      }, 0);
      const invIncome = com.invoices.reduce((s,i) => s+(parseFloat(i.gross_amount)||0)+(parseFloat(i.total_quality_adj)||0), 0);
      const invAvgPrice = invQty ? invIncome / invQty : null;

      // Contracted
      const contracted = com.contracts.reduce((s,c) => s+(parseFloat(c.quantity)||0), 0);
      const avgContractPrice = contracted ? com.contracts.reduce((s,c) => s+(parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0),0) / contracted : null;

      // Variances
      const prodVar = forecastProd && budgetProd ? forecastProd - budgetProd : null;
      const priceVar = forecastPrice && budgetPrice ? forecastPrice - budgetPrice : null;
      const incomeVar = forecastIncome && budgetIncome ? forecastIncome - budgetIncome : null;

      totalBudgetIncome += budgetIncome || 0;
      totalForecastIncome += forecastIncome || 0;
      totalActualIncome += invIncome || 0;

      return `
        <!-- Commodity header -->
        <tr style="background:var(--page-bg)">
          <td colspan="8" style="padding:10px 12px 4px;font-size:13px;font-weight:700;color:var(--ink);border-top:2px solid var(--border)">${com.name}</td>
        </tr>

        <!-- Production row -->
        <tr>
          <td style="padding:6px 12px;font-size:12px;color:var(--hint);padding-left:20px">Production (${unit})</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px">${fmtN(budgetProd)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px;color:var(--blue)">${fmtN(forecastProd)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px;color:${varColor(prodVar)}">${prodVar != null ? varArrow(prodVar)+' '+fmtN(Math.abs(prodVar)) : '—'}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px;color:var(--green)">${fmtN(actualProd)}${actualProd && forecastProd ? ' <span style="font-size:10px;color:var(--hint)">('+Math.round(actualProd/forecastProd*100)+'%)</span>' : ''}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px">${fmtN(contracted)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px;color:var(--green)">${fmtN(invQty, 2)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px"></td>
        </tr>

        <!-- Price row -->
        <tr style="background:#fafafa">
          <td style="padding:6px 12px;font-size:12px;color:var(--hint);padding-left:20px">Price ($/unit)</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px">${fmtC(budgetPrice, 2)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px;color:var(--blue)">${fmtC(forecastPrice, 2)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px;color:${varColor(priceVar)}">${priceVar != null ? varArrow(priceVar)+' '+fmtC(Math.abs(priceVar),2) : '—'}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px"></td>
          <td style="padding:6px 12px;text-align:right;font-size:12px">${fmtC(avgContractPrice, 2)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px;color:var(--green)">${fmtC(invAvgPrice, 2)}</td>
          <td style="padding:6px 12px;text-align:right;font-size:12px"></td>
        </tr>

        <!-- Income row -->
        <tr>
          <td style="padding:6px 12px 10px;font-size:12px;font-weight:600;padding-left:20px">Total Income</td>
          <td style="padding:6px 12px 10px;text-align:right;font-size:12px;font-weight:600">${fmtC(budgetIncome)}</td>
          <td style="padding:6px 12px 10px;text-align:right;font-size:12px;font-weight:600;color:var(--blue)">${fmtC(forecastIncome)}</td>
          <td style="padding:6px 12px 10px;text-align:right;font-size:12px;font-weight:600;color:${varColor(incomeVar)}">${incomeVar != null ? varArrow(incomeVar)+' '+fmtC(Math.abs(incomeVar)) : '—'}</td>
          <td style="padding:6px 12px 10px;text-align:right;font-size:12px"></td>
          <td style="padding:6px 12px 10px;text-align:right;font-size:12px;font-weight:600">${fmtC(contracted * (avgContractPrice||0))}</td>
          <td style="padding:6px 12px 10px;text-align:right;font-size:12px;font-weight:600;color:var(--green)">${fmtC(invIncome)}</td>
          <td style="padding:6px 12px 10px;text-align:right;font-size:12px;color:var(--hint)">${invIncome && forecastIncome ? Math.round(invIncome/forecastIncome*100)+'%' : ''}</td>
        </tr>
      `;
    }).join('');

  const body = qs('#mgmt-report-body', container);
  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div>
        <h2 style="font-size:16px;font-weight:700;margin:0">${farm.name} — Management Report</h2>
        <p style="font-size:12px;color:var(--hint);margin:4px 0 0">Season ${season} · Production-based income</p>
      </div>
      <div style="font-size:11px;color:var(--hint)">As at ${formatDate(new Date().toISOString().slice(0,10))}</div>
    </div>

    <!-- Summary cards -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">
      <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Budget Income</div>
        <div style="font-size:22px;font-weight:700">${fmtC(totalBudgetIncome)}</div>
      </div>
      <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Forecast Income</div>
        <div style="font-size:22px;font-weight:700;color:var(--blue)">${fmtC(totalForecastIncome)}</div>
        ${totalForecastIncome && totalBudgetIncome ? `<div style="font-size:11px;color:${varColor(totalForecastIncome-totalBudgetIncome)};margin-top:3px">${varArrow(totalForecastIncome-totalBudgetIncome)} ${fmtC(Math.abs(totalForecastIncome-totalBudgetIncome))} vs budget</div>` : ''}
      </div>
      <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Invoiced to Date</div>
        <div style="font-size:22px;font-weight:700;color:var(--green)">${fmtC(totalActualIncome)}</div>
        ${totalActualIncome && totalForecastIncome ? `<div style="font-size:11px;color:var(--hint);margin-top:3px">${Math.round(totalActualIncome/totalForecastIncome*100)}% of forecast</div>` : ''}
      </div>
    </div>

    <!-- Detail table -->
    <div style="background:white;border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="${thL}">Income</th>
            <th style="${thS}">Budget</th>
            <th style="${thS}">Forecast</th>
            <th style="${thS}">Var vs Bud</th>
            <th style="${thS}">Actual (harvest)</th>
            <th style="${thS}">Contracted</th>
            <th style="${thS}">Invoiced</th>
            <th style="${thS}">% of fcst</th>
          </tr>
        </thead>
        <tbody>
          ${commodityRows}
          <!-- Totals -->
          <tr style="background:var(--page-bg);border-top:2px solid var(--border)">
            <td style="padding:10px 12px;font-size:13px;font-weight:700">Total Income</td>
            <td style="padding:10px 12px;text-align:right;font-size:13px;font-weight:700">${fmtC(totalBudgetIncome)}</td>
            <td style="padding:10px 12px;text-align:right;font-size:13px;font-weight:700;color:var(--blue)">${fmtC(totalForecastIncome)}</td>
            <td style="padding:10px 12px;text-align:right;font-size:13px;font-weight:700;color:${varColor(totalForecastIncome-totalBudgetIncome)}">${varArrow(totalForecastIncome-totalBudgetIncome)} ${fmtC(Math.abs(totalForecastIncome-totalBudgetIncome))}</td>
            <td style="padding:10px 12px;text-align:right;font-size:13px"></td>
            <td style="padding:10px 12px;text-align:right;font-size:13px"></td>
            <td style="padding:10px 12px;text-align:right;font-size:13px;font-weight:700;color:var(--green)">${fmtC(totalActualIncome)}</td>
            <td style="padding:10px 12px;text-align:right;font-size:13px;color:var(--hint)">${totalActualIncome && totalForecastIncome ? Math.round(totalActualIncome/totalForecastIncome*100)+'%' : ''}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p style="font-size:11px;color:var(--hint);margin-top:12px">
      Income is production-period based. Forecast uses latest agronomist forecast. Invoiced reflects gross income + quality adjustments from paid invoices. Costs not yet included.
    </p>
  `;
}