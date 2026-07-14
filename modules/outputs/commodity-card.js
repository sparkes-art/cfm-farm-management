// modules/outputs/commodity-card.js
// Commodity position card — matches the data card design from old system
// Shows budget vs forecast vs actual, hedging position, price summary

import { dbSelect } from '../../js/supabase-client.js?v=1783290066771';
import { getActiveFarm } from '../../js/app-state.js?v=1783290066771';
import { formatCurrency, formatNumber, formatDate } from '../../js/ui.js?v=1783290066771';
import { getCommodities, getCropTypes } from '../../js/commodities.js?v=1783290066771';

export async function buildCommodityCards(season) {
  const farm = getActiveFarm();
  if (!farm) return '<div class="empty-state"><p>No farm selected.</p></div>';

  // Load all data in parallel
  // Load commodity statuses (manual override: budget/growing/harvesting/harvested)
  let commodityStatuses = {};
  try {
    const statuses = await dbSelect('commodity_status', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*');
    statuses.forEach(s => { commodityStatuses[s.commodity_id] = s.status; });
  } catch { /* table may not exist yet */ }

  const [contracts, invoices, budgets, forecasts, harvests] = await Promise.all([
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.desc'),
    dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    dbSelect('forecasts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*&order=forecast_date.asc'),
    dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
  ]);

  // Get all unique commodities across contracts, budgets and invoices
  // Use commodity_id as primary key when available, fall back to name
  const commodityMap = {};
  const nameToKey = {}; // map commodity name -> key for merging

  // Build a lookup from commodity ID to name using the master list
  const masterCommodities = getCommodities();
  const idToName = {};
  masterCommodities.forEach(c => { idToName[c.id] = c.name; });

  const addCommodity = (id, name) => {
    if (!id && !name) return null;
    // Resolve name from master list if we only have an id
    const resolvedName = name || (id ? idToName[id] : null);
    let key = id || nameToKey[resolvedName?.toLowerCase()] || resolvedName;
    if (!commodityMap[key]) {
      commodityMap[key] = { id: id || null, name: resolvedName || key, contracts: [], invoices: [], budgets: [], forecasts: [], harvests: [] };
    }
    if (resolvedName && id) nameToKey[resolvedName.toLowerCase()] = key;
    if (id && !commodityMap[key].id) commodityMap[key].id = id;
    if (resolvedName && !commodityMap[key].name) commodityMap[key].name = resolvedName;
    return key;
  };

  contracts.forEach(c => {
    const key = addCommodity(c.commodity_id, c.commodity);
    if (key) commodityMap[key].contracts.push(c);
  });
  budgets.forEach(b => {
    const key = addCommodity(b.commodity_id, b.commodity);
    if (key) commodityMap[key].budgets.push(b);
  });
  invoices.forEach(i => {
    const lines = i.line_items || [];
    if (lines.length) {
      // Filter lines to those matching the selected season
      const seasonLines = lines.filter(l => !l.season || l.season === season);
      const seen = new Set();
      seasonLines.forEach(l => {
        if (!l.commodity) return;
        const k = addCommodity(null, l.commodity);
        if (k && !seen.has(k)) {
          // Store a season-filtered version of the invoice
          const filteredInvoice = { ...i, line_items: seasonLines };
          commodityMap[k].invoices.push(filteredInvoice);
          seen.add(k);
        }
      });
    } else if (i.commodity_type && (!i.season || i.season === season)) {
      // Old format fallback — filter by invoice season
      const key = addCommodity(null, i.commodity_type);
      if (key) commodityMap[key].invoices.push(i);
    }
  });
  forecasts.forEach(f => { addCommodity(f.commodity_id, f.commodity); });
  harvests.forEach(h => { addCommodity(h.commodity_id, null); });

  // Store budget price on each commodity entry
  Object.values(commodityMap).forEach(com => {
    const budgets = com.budgets || [];
    const pricesWithVal = budgets.filter(b => b.price);
    com.budgetPrice = pricesWithVal.length
      ? pricesWithVal.reduce((s, b) => s + parseFloat(b.price), 0) / pricesWithVal.length
      : null;
  });

  // Also get latest market price for each commodity
  // Get farm's grain site settings for price filtering
  const farmSettings = farm.settings || {};
  const grainSites = farmSettings.grainSites || {};
  const commodityList = getCommodities();

  const pricePromises = Object.entries(commodityMap).map(async ([key, com]) => {
    if (!com.id) return;
    try {
      // Find this commodity's name to look up its delivery site
      const commodityObj = commodityList.find(c => c.id === com.id);
      const commodityName = commodityObj?.name || com.name || '';
      const deliverySite = grainSites[commodityName] || null;

      // Build query — filter by delivery site if configured
      let query = 'commodity_id=eq.' + com.id + '&select=price_per_unit,price_date&order=price_date.desc&limit=1';
      if (deliverySite) query += '&region=eq.' + encodeURIComponent(deliverySite);

      const prices = await dbSelect('market_prices', query);
      com.latestPrice = prices[0] || null;
    } catch { com.latestPrice = null; }
  });
  await Promise.all(pricePromises);

  const cards = Object.values(commodityMap);
  if (!cards.length) return {
    html: '<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">📦</div><p>No commodity data for ' + season + ' yet.</p><p>Add contracts or budgets to see the position dashboard.</p></div></div></div>',
    commodityMap: {}
  };

  return {
    html: cards.map(com => _buildCard(com, forecasts, harvests, season, commodityStatuses)).join(''),
    commodityMap
  };
}

function _buildCard(com, allForecasts, allHarvests, season, commodityStatuses = {}) {
  const name = com.name || 'Unknown';
  const contracts = com.contracts || [];
  const invoices = com.invoices || [];
  const budgets = com.budgets || [];

  // Budget totals (sum across crop types)
  const totalBudgetProd = budgets.reduce((s, b) => s + (parseFloat(b.budgeted_production) || ((parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0))), 0);
  const totalBudgetArea = budgets.reduce((s, b) => s + (parseFloat(b.area_ha) || 0), 0);
  const budgetYield = (totalBudgetArea > 0 && totalBudgetProd > 0) ? totalBudgetProd / totalBudgetArea : null;
  const budgetsWithPrice = budgets.filter(b => b.price);
  const budgetPrice = budgetsWithPrice.length ? budgetsWithPrice.reduce((s, b) => s + parseFloat(b.price), 0) / budgetsWithPrice.length : null;

  // Forecasts — sum across ALL crop types for this commodity
  // Get the latest forecast per budget_id (one forecast per crop type row)
  const comForecasts = allForecasts.filter(f => f.commodity_id === com.id || f.commodity?.toLowerCase() === com.name?.toLowerCase());
  
  // Group by budget_id and take the latest per group
  const latestPerBudget = {};
  comForecasts.forEach(f => {
    const key = f.budget_id || f.crop_type_id || 'default';
    if (!latestPerBudget[key] || f.forecast_date > latestPerBudget[key].forecast_date) {
      latestPerBudget[key] = f;
    }
  });
  const latestForecasts = Object.values(latestPerBudget);
  const latestForecast = latestForecasts.length > 0 ? latestForecasts[0] : null; // for status check

  // Sum production and area across all crop type forecasts
  const forecastProd = latestForecasts.length > 0
    ? latestForecasts.reduce((s, f) => s + (parseFloat(f.forecast_production) || (parseFloat(f.area_ha)||0) * (parseFloat(f.yield_per_ha)||0)), 0)
    : null;
  const forecastArea = latestForecasts.length > 0
    ? latestForecasts.reduce((s, f) => s + (parseFloat(f.area_ha) || 0), 0)
    : null;
  const forecastYield = (forecastArea > 0 && forecastProd) ? forecastProd / forecastArea : null;

  // Harvest
  const comHarvests = allHarvests.filter(h => h.commodity_id === com.id);
  const totalHarvest = comHarvests.reduce((s, h) => s + (parseFloat(h.actual_production) || 0), 0);
  const isHarvested = totalHarvest > 0;

  // Paid average — gross amount + quality adj (not selling costs) divided by qty
  // This gives the effective commodity price before deductions
  const completeInvoices = invoices.filter(i => i.status === 'complete' || i.status === 'paid');
  const totalPaidQty = completeInvoices.reduce((s, i) => {
    const lines = (i.line_items || []).filter(l => !l.commodity || l.commodity === com.name);
    // If line items exist use qty from them, otherwise fall back to total_qty
    return s + (lines.length ? lines.reduce((ss, l) => ss + (parseFloat(l.qty)||0), 0) : (parseFloat(i.total_qty)||0));
  }, 0);
  // Paid avg = line total / qty (line total already includes quality adj)
  const totalPaidValue = completeInvoices.reduce((s, i) => {
    const lines = (i.line_items || []).filter(l => !l.commodity || l.commodity === com.name);
    if (lines.length) {
      return s + lines.reduce((ss, l) => ss + (parseFloat(l.total)||0), 0);
    }
    // Fallback: gross_amount + total_quality_adj
    return s + (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0);
  }, 0);
  const paidAvg = (totalPaidQty && totalPaidValue) ? totalPaidValue / totalPaidQty : null;
  const totalPaid = completeInvoices.reduce((s, i) => s + (parseFloat(i.net_amount)||0), 0);

  // Contracts / hedging position
  const totalContracted = contracts.reduce((s, c) => s + (parseFloat(c.quantity) || 0), 0);
  const totalContractValue = contracts.reduce((s, c) => s + ((parseFloat(c.quantity)||0) * (parseFloat(c.price_per_unit)||0)), 0);
  const avgFwdPrice = totalContracted ? totalContractValue / totalContracted : null;
  // Denominator is always forecast (or budget) — never harvest for hedging purposes
  const hedgeDenominator = forecastProd !== null ? forecastProd : totalBudgetProd;
  const denominator = isHarvested ? totalHarvest : hedgeDenominator;
  // Hedged = contracted + already sold (paid invoices)
  const totalHedged = Math.min(hedgeDenominator || 0, totalContracted + totalPaidQty);
  const pctHedged = hedgeDenominator && totalHedged ? Math.round((totalHedged / hedgeDenominator) * 100) : 0;
  const unhedged = Math.max(0, (hedgeDenominator || 0) - totalHedged);
  // Harvest progress as % of forecast (for bar only, doesn't affect hedging %)
  const harvestPct = hedgeDenominator && totalHarvest ? Math.min(100, Math.round((totalHarvest / hedgeDenominator) * 100)) : 0;

  // Market price
  const marketPrice = com.latestPrice ? parseFloat(com.latestPrice.price_per_unit) : null;
  const marketVsBudget = marketPrice && budgetPrice ? ((marketPrice - budgetPrice) / budgetPrice * 100) : null;
  const fwdVsBudget = avgFwdPrice && budgetPrice ? ((avgFwdPrice - budgetPrice) / budgetPrice * 100) : null;

  // Status — use manual override if set, otherwise auto-detect
  const manualStatus = com.id ? commodityStatuses[com.id] : null;
  const autoStatus = isHarvested ? 'harvested' : latestForecast ? 'growing' : 'budget';
  const status = manualStatus || autoStatus;

  // Production bar width
  const budgetBarW = 100;
  const forecastBarW = (forecastProd !== null && totalBudgetProd) ? Math.min(100, (forecastProd / totalBudgetProd) * 100) : 0;
  const harvestBarW = totalBudgetProd ? Math.min(100, (totalHarvest / totalBudgetProd) * 100) : 0;
  const forecastVsBudget = (forecastProd !== null && totalBudgetProd) ? Math.round((forecastProd / totalBudgetProd) * 100) : null;

  // Unit
  const unit = contracts[0]?.unit || budgets[0]?.unit || 'bale';
  // Harvest area
  const totalHarvestArea = comHarvests.reduce((s, h) => s + (parseFloat(h.area_ha)||0), 0);

  return `
    <div class="card" style="margin-bottom:16px">

      <!-- Card top bar -->
      <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border-light);background:#fafbfc;border-radius:var(--radius-lg) var(--radius-lg) 0 0">
        <span style="font-size:var(--text-md);font-weight:600;color:var(--ink)">${name}</span>
        <div class="status-toggle" style="display:flex;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;font-size:10px">
          ${['budget','growing','harvesting','harvested'].map(s => `
            <button class="status-opt-btn" data-commodity="${com.id}" data-season="${season}" data-status="${s}"
              style="padding:3px 8px;border:none;cursor:pointer;font-size:10px;font-weight:${status===s?'600':'400'};
              background:${status===s ? (s==='harvested'?'var(--green)':s==='harvesting'?'var(--amber)':s==='growing'?'var(--blue)':'var(--border)') : 'transparent'};
              color:${status===s ? (s==='budget'?'var(--ink)':'white') : 'var(--hint)'};
              transition:all .15s">
              ${s.charAt(0).toUpperCase()+s.slice(1)}
            </button>
          `).join('')}
        </div>

        ${denominator ? `
          <div style="flex:1;margin:0 12px">
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
              <div style="display:flex;gap:8px;flex-wrap:wrap">
                ${totalContracted ? '<span style="color:var(--blue);font-weight:500">' + formatNumber(totalContracted, 0) + ' ' + unit + ' contracted</span>' : ''}
                ${totalPaidQty ? '<span style="color:var(--green);font-weight:500">' + formatNumber(totalPaidQty, 0) + ' ' + unit + ' paid</span>' : ''}
                ${status === 'harvesting' && totalHarvest ? '<span style="color:var(--hint)">| ' + formatNumber(totalHarvest, 0) + ' ' + unit + ' harvested so far</span>' : ''}
              </div>
              <span style="color:var(--hint)">${formatNumber(unhedged, 0)} ${unit} open</span>
            </div>
            <div style="height:7px;background:var(--border);border-radius:4px;overflow:hidden;display:flex;position:relative">
              <div style="height:100%;width:${hedgeDenominator ? Math.min(100, Math.round((totalPaidQty/hedgeDenominator)*100)) : 0}%;background:var(--green);transition:width .3s;z-index:2"></div>
              <div style="height:100%;width:${hedgeDenominator ? Math.min(100 - Math.round((totalPaidQty/hedgeDenominator)*100), Math.round((totalContracted/hedgeDenominator)*100)) : 0}%;background:var(--blue);transition:width .3s;z-index:2"></div>
              ${status === 'harvesting' && harvestPct > 0 ? `<div style="position:absolute;left:0;top:0;height:100%;width:${harvestPct}%;border-right:2px dashed rgba(255,255,255,0.6);z-index:3;pointer-events:none" title="Harvested ${formatNumber(totalHarvest,0)} ${unit} (${harvestPct}% of forecast)"></div>` : ''}
            </div>
          </div>
          <span style="font-size:var(--text-sm);font-weight:600;color:var(--blue);white-space:nowrap">${pctHedged}% covered</span>
        ` : ''}
      </div>

      <!-- Card body: Production | Chart | Prices & Position -->
      <div class="commodity-card-body" style="display:grid;grid-template-columns:1fr 38% 28%;min-height:220px">

        <!-- Col 1: Production (yield + production merged) -->
        <div style="padding:14px 16px;border-right:1px solid var(--border-light);display:flex;flex-direction:column;gap:4px">
          <p style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--hint);margin:0 0 8px">Production</p>
          ${budgets.filter(b => !b.is_derived).map(b => {
            const budYield = b.area_ha && b.yield_per_ha ? parseFloat(b.yield_per_ha) : null;
            const lf = latestForecasts.find(f => f.budget_id === b.id);
            const fcastYield = lf && lf.yield_per_ha ? parseFloat(lf.yield_per_ha) : null;
            const allCropTypes = getCropTypes();
            const bCropType = allCropTypes.find(ct => ct.id === b.crop_type_id);
            const cropTypeLabel = bCropType?.name || b.crop_type || b.commodity || '';
            const ctHarvests = comHarvests.filter(h => h.crop_type_id === b.crop_type_id || (!h.crop_type_id && !b.crop_type_id));
            const ctHarvestProd = ctHarvests.reduce((s,h)=>s+(parseFloat(h.actual_production)||0),0);
            const ctHarvestArea = ctHarvests.reduce((s,h)=>s+(parseFloat(h.area_ha)||0),0);
            const actualYield = ctHarvestArea && ctHarvestProd ? ctHarvestProd/ctHarvestArea : null;
            const budProd = parseFloat(b.budgeted_production) || ((parseFloat(b.area_ha)||0)*(parseFloat(b.yield_per_ha)||0));
            const lfProd = lf ? (parseFloat(lf.forecast_production)||(parseFloat(lf.area_ha)||0)*(parseFloat(lf.yield_per_ha)||0)) : null;
            const fcastVsBud = lfProd && budProd ? Math.round((lfProd/budProd)*100) : null;
            const actVsBud = ctHarvestProd && budProd ? Math.round((ctHarvestProd/budProd)*100) : null;
            return '<div style="padding-bottom:10px;margin-bottom:10px;border-bottom:1px solid var(--border-light)">' +
              '<p style="font-size:11px;font-weight:600;color:var(--ink);margin:0 0 8px">' + cropTypeLabel + '</p>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:6px">' +
                '<div><p style="font-size:10px;color:var(--hint);margin:0 0 1px">Bud yld</p><p style="font-size:16px;font-weight:600;color:var(--ink);margin:0;line-height:1.1">' + (budYield ? formatNumber(budYield,2) : '—') + '</p><p style="font-size:10px;color:var(--hint);margin:1px 0 0">' + (b.area_ha ? formatNumber(b.area_ha,0)+' ha' : '') + '</p></div>' +
                '<div><p style="font-size:10px;color:var(--hint);margin:0 0 1px">Fcast yld</p><p style="font-size:16px;font-weight:600;color:var(--blue);margin:0;line-height:1.1">' + (fcastYield ? formatNumber(fcastYield,2) : '—') + '</p><p style="font-size:10px;color:var(--hint);margin:1px 0 0">' + (lf?.area_ha ? formatNumber(lf.area_ha,0)+' ha' : '') + '</p></div>' +
                '<div><p style="font-size:10px;color:var(--hint);margin:0 0 1px">Actual yld</p><p style="font-size:16px;font-weight:600;color:var(--green);margin:0;line-height:1.1">' + (actualYield ? formatNumber(actualYield,2) : '—') + '</p><p style="font-size:10px;color:var(--hint);margin:1px 0 0">' + (ctHarvestArea ? formatNumber(ctHarvestArea,0)+' ha' : '') + '</p></div>' +
              '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px">' +
                '<div><p style="font-size:10px;color:var(--hint);margin:0 0 1px">Bud prod</p><p style="font-size:13px;font-weight:600;color:var(--ink);margin:0;font-variant-numeric:tabular-nums">' + (budProd ? formatNumber(budProd,0) : '—') + '</p></div>' +
                '<div><p style="font-size:10px;color:var(--hint);margin:0 0 1px">Fcast prod</p><p style="font-size:13px;font-weight:600;color:var(--blue);margin:0;font-variant-numeric:tabular-nums">' + (lfProd ? formatNumber(lfProd,0) : '—') + '</p>' + (fcastVsBud !== null ? '<p style="font-size:9px;color:' + (fcastVsBud>=100?'var(--green)':'var(--red)') + ';margin:1px 0 0">' + (fcastVsBud>=100?'▲':'▼') + Math.abs(100-fcastVsBud) + '% vs bud</p>' : '') + '</div>' +
                '<div><p style="font-size:10px;color:var(--hint);margin:0 0 1px">Actual</p><p style="font-size:13px;font-weight:600;color:var(--green);margin:0;font-variant-numeric:tabular-nums">' + (ctHarvestProd ? formatNumber(ctHarvestProd,0) : '—') + '</p>' + (actVsBud !== null ? '<p style="font-size:9px;color:' + (actVsBud>=100?'var(--green)':'var(--red)') + ';margin:1px 0 0">' + (actVsBud>=100?'▲':'▼') + Math.abs(100-actVsBud) + '% vs bud</p>' : '') + '</div>' +
              '</div>' +
            '</div>';
          }).join('')}
        </div>

        <!-- Col 2: Price chart (38%) -->
        <div style="padding:14px 16px;border-right:1px solid var(--border-light);display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div style="display:flex;gap:3px">
              <button class="mini-range-btn active" data-months="6" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:var(--blue);color:white;cursor:pointer">6m</button>
              <button class="mini-range-btn" data-months="12" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">12m</button>
              <button class="mini-range-btn" data-months="24" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">24m</button>
              <button class="mini-range-btn" data-months="999" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer">All</button>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="document.querySelector('[data-tab=prices]')?.click()" style="font-size:11px">Full chart →</button>
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><div style="width:16px;height:2px;background:var(--blue)"></div>Market</div>
            ${avgFwdPrice ? '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><div style="width:16px;height:0;border-top:2px dashed #b86e00"></div>Fwd avg</div>' : ''}
            ${budgetPrice ? '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><div style="width:16px;height:0;border-top:2px dashed #0f766e"></div>Budget</div>' : ''}
            ${contracts.length ? '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><div style="width:8px;height:8px;border-radius:50%;background:var(--green)"></div>Fwd sale</div>' : ''}
          </div>
          <div id="card-chart-${com.id || name.replace(/\s/g,'-')}" style="flex:1;min-height:160px;display:flex;align-items:center;justify-content:center">
            <p style="font-size:12px;color:var(--hint)">Price chart loading…</p>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px">
            ${marketPrice ? '<div style="background:#fafbfc;border-radius:6px;padding:5px 10px"><p style="font-size:10px;color:var(--hint);margin-bottom:1px">Current market</p><p style="font-size:13px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums">' + formatCurrency(marketPrice,0) + '</p></div>' : ''}
            ${avgFwdPrice ? '<div style="background:#fafbfc;border-radius:6px;padding:5px 10px"><p style="font-size:10px;color:var(--hint);margin-bottom:1px">Fwd avg</p><p style="font-size:13px;font-weight:600;color:var(--blue);font-variant-numeric:tabular-nums">' + formatCurrency(avgFwdPrice,0) + '</p></div>' : ''}
          </div>
        </div>

        <!-- Col 3: Prices & Position (28%) -->
        ${(() => {
          const paidVsBudget = paidAvg && budgetPrice ? ((paidAvg - budgetPrice) / budgetPrice * 100) : null;
          const onHand = totalHarvest ? Math.max(0, totalHarvest - totalPaidQty) : null;
          const defaultValuePerUnit = marketPrice ? marketPrice * 0.95 : null;
          const valueOnHand = onHand && defaultValuePerUnit ? onHand * defaultValuePerUnit : null;
          const totalInvoicedDollars = completeInvoices.reduce((s,i) => s + (parseFloat(i.net_amount)||0), 0);
          const priceRow = (label, val, color='var(--ink)', sub='') =>
            '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--border-light)">' +
              '<span style="font-size:11px;color:var(--hint)">' + label + (sub ? '<br><span style="font-size:9px">' + sub + '</span>' : '') + '</span>' +
              '<span style="font-size:12px;font-weight:600;color:' + color + ';font-variant-numeric:tabular-nums">' + val + '</span>' +
            '</div>';
          return '<div style="padding:14px 16px;background:#fafbfc;display:flex;flex-direction:column">' +
            '<p style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--hint);margin:0 0 8px">Prices &amp; Position</p>' +
            priceRow('Budget', budgetPrice ? formatCurrency(budgetPrice,0) : '—') +
            priceRow('Market', marketPrice ? formatCurrency(marketPrice,0) : '—', marketVsBudget !== null ? (marketVsBudget >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--ink)') +
            priceRow('Fwd avg', avgFwdPrice ? formatCurrency(avgFwdPrice,0) : '—', 'var(--blue)') +
            priceRow('Paid avg', paidAvg ? formatCurrency(paidAvg,0) : '—', paidVsBudget !== null ? (paidVsBudget >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--ink)') +
            '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border-light)">' +
              '<span style="font-size:11px;color:var(--hint)">Value $/unit<br><span style="font-size:9px">mkt less 5%</span></span>' +
              '<input class="value-per-unit-input" data-commodity="' + com.id + '" data-default="' + (defaultValuePerUnit||'') + '" value="' + (defaultValuePerUnit ? formatCurrency(defaultValuePerUnit,0) : '—') + '"' +
              ' style="font-size:12px;font-weight:600;color:var(--blue);background:none;border:none;border-bottom:1px dashed var(--blue);width:70px;text-align:right;font-variant-numeric:tabular-nums;outline:none;padding:0;cursor:text">' +
            '</div>' +
            '<div style="height:1px;background:var(--border-light);margin:6px 0"></div>' +
            priceRow('Produced', totalHarvest ? formatNumber(totalHarvest,0)+' '+unit : '—') +
            priceRow('Invoiced qty', totalPaidQty ? formatNumber(totalPaidQty,0)+' '+unit : '—') +
            priceRow('Invoiced $', totalInvoicedDollars ? formatCurrency(totalInvoicedDollars,0) : '—', 'var(--green)') +
            priceRow('On hand', onHand !== null ? formatNumber(onHand,0)+' '+unit : '—', 'var(--blue)') +
            '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:4px 0">' +
              '<span style="font-size:11px;color:var(--hint)">Value on hand</span>' +
              '<span class="value-on-hand-display" data-commodity="' + com.id + '" style="font-size:12px;font-weight:600;color:var(--blue);font-variant-numeric:tabular-nums">' + (valueOnHand ? formatCurrency(valueOnHand,0) : '—') + '</span>' +
            '</div>' +
            '<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border-light);display:flex;justify-content:space-between">' +
              '<span style="font-size:10px;color:var(--hint)">Prior yr on hand</span>' +
              '<span style="font-size:10px;color:var(--hint)">—</span>' +
            '</div>' +
          '</div>';
        })()}

      </div>
    </div>`;
}

// Draw mini charts after cards are in DOM
export async function drawMiniCharts(commodityMap, season) {
  if (!window.Chart) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  // Store all prices per commodity for range switching
  const allPrices = {};

  for (const [key, com] of Object.entries(commodityMap)) {
    if (!com.id) continue;
    const canvasContainer = document.getElementById('card-chart-' + com.id);
    if (!canvasContainer) continue;

    try {
      // Load 3 years of prices
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 3);
      const cutoffStr = cutoff.toISOString().slice(0, 10);

      // Filter by farm's delivery site if configured
      const farm = getActiveFarm();
      const farmSettings = farm?.settings || {};
      const grainSites = farmSettings.grainSites || {};
      const commodityObj = getCommodities().find(c => c.id === com.id);
      const deliverySite = grainSites[commodityObj?.name || com.name || ''] || null;

      let priceQuery = 'commodity_id=eq.' + com.id + '&price_date=gte.' + cutoffStr + '&select=price_date,price_per_unit&order=price_date.asc';
      if (deliverySite) priceQuery += '&region=eq.' + encodeURIComponent(deliverySite);

      const prices = await dbSelect('market_prices', priceQuery);

      allPrices[com.id] = prices;

      if (!prices.length) {
        canvasContainer.innerHTML = '<p style="font-size:12px;color:var(--hint)">No price data available</p>';
        continue;
      }

      const contracts = com.contracts || [];
      const totalContracted = contracts.reduce((s, c) => s + (parseFloat(c.quantity)||0), 0);
      const totalValue = contracts.reduce((s, c) => s + (parseFloat(c.quantity)||0) * (parseFloat(c.price_per_unit)||0), 0);
      const avgFwd = totalContracted ? totalValue / totalContracted : null;

      _drawMiniChart(canvasContainer, prices, contracts, avgFwd, com.budgetPrice || null, 6);

      // Wire range buttons for this commodity
      document.querySelectorAll('.mini-range-btn[data-chart="' + com.id + '"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const months = parseInt(btn.dataset.months);
          document.querySelectorAll('.mini-range-btn[data-chart="' + com.id + '"]').forEach(b => {
            const active = b.dataset.months === btn.dataset.months;
            b.style.background = active ? 'var(--blue)' : 'var(--white)';
            b.style.color = active ? 'white' : 'var(--muted)';
          });
          _drawMiniChart(canvasContainer, allPrices[com.id] || [], contracts, avgFwd, com.budgetPrice || null, months);
        });
      });

    } catch (e) {
      canvasContainer.innerHTML = '<p style="font-size:11px;color:var(--hint)">Chart unavailable</p>';
      console.error('Mini chart error:', e);
    }
  }
}

function _drawMiniChart(container, allPrices, contracts, avgFwd, budgetPrice, months) {
  // Destroy existing chart
  if (container._chart) { container._chart.destroy(); container._chart = null; }

  // Filter by range
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const filtered = months >= 999 ? allPrices : allPrices.filter(p => new Date(p.price_date) >= cutoff);

  if (!filtered.length) {
    container.innerHTML = '<p style="font-size:12px;color:var(--hint)">No data for this period</p>';
    return;
  }

  container.innerHTML = '<canvas></canvas>';
  const canvas = container.querySelector('canvas');

  const labels = filtered.map(p => p.price_date);
  const data = filtered.map(p => parseFloat(p.price_per_unit));

  const datasets = [{
    label: 'Market',
    data,
    borderColor: '#1e6fa8',
    backgroundColor: 'rgba(30,111,168,0.06)',
    borderWidth: 1.5,
    pointRadius: 0,
    pointHoverRadius: 3,
    fill: true,
    tension: 0.2,
    order: 2,
  }];

  // Avg fwd price dashed line
  if (avgFwd) {
    datasets.push({
      label: 'Avg fwd',
      data: labels.map(() => avgFwd),
      borderColor: '#b86e00',
      borderWidth: 1.5,
      borderDash: [5, 4],
      pointRadius: 0,
      fill: false,
      order: 3,
    });
  }

  // Budget price dashed line
  if (budgetPrice) {
    datasets.push({
      label: 'Budget',
      data: labels.map(() => budgetPrice),
      borderColor: '#0f766e',
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      fill: false,
      order: 4,
    });
  }

  // Forward sale scatter dots
  const salePoints = contracts
    .filter(c => c.sale_date && c.price_per_unit)
    .map(c => {
      const saleDate = c.sale_date.slice(0, 10);
      let idx = labels.indexOf(saleDate);
      if (idx === -1) {
        const target = new Date(saleDate).getTime();
        let minDiff = Infinity;
        labels.forEach((l, i) => {
          const diff = Math.abs(new Date(l).getTime() - target);
          if (diff < minDiff) { minDiff = diff; idx = i; }
        });
      }
      if (idx === -1 || new Date(saleDate) < cutoff) return null;
      return { x: labels[idx], y: parseFloat(c.price_per_unit), label: c.contract_number || 'Contract' };
    })
    .filter(Boolean);

  if (salePoints.length) {
    datasets.push({
      label: 'Fwd sale',
      data: salePoints.map(s => ({ x: s.x, y: s.y })),
      type: 'scatter',
      backgroundColor: '#1a7a4a',
      borderColor: '#ffffff',
      borderWidth: 1.5,
      pointRadius: 6,
      pointHoverRadius: 8,
      order: 1,
    });
  }

  // Avg price end label plugin
  const avgLabelPlugin = {
    id: 'avgLabel',
    afterDatasetsDraw(chart) {
      const avgDs = chart.data.datasets.find(d => d.label === 'Avg fwd');
      if (!avgDs || !avgDs.data.length) return;
      const { ctx, chartArea, scales } = chart;
      const y = scales.y.getPixelForValue(avgDs.data[0]);
      ctx.save();
      ctx.fillStyle = '#b86e00';
      ctx.font = '500 10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('$' + Math.round(avgDs.data[0]), chartArea.right + 3, y);
      ctx.restore();

      // Budget price label
      const budDs = chart.data.datasets.find(d => d.label === 'Budget');
      if (budDs && budDs.data.length) {
        const yb = scales.y.getPixelForValue(budDs.data[0]);
        ctx.save();
        ctx.fillStyle = '#0f766e';
        ctx.font = '500 10px Inter, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('$' + Math.round(budDs.data[0]), chartArea.right + 3, yb);
        ctx.restore();
      }
    }
  };

  const months_label = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  container._chart = new window.Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    plugins: (avgFwd || budgetPrice) ? [avgLabelPlugin] : [],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: (avgFwd || budgetPrice) ? 40 : 8 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === 'Fwd sale') {
                const pt = salePoints[ctx.dataIndex];
                return pt ? pt.label + ': $' + ctx.parsed.y.toFixed(0) : '$' + ctx.parsed.y.toFixed(0);
              }
              if (ctx.dataset.label === 'Avg fwd') return 'Avg fwd: $' + ctx.parsed.y.toFixed(0);
              if (ctx.dataset.label === 'Budget') return 'Budget: $' + ctx.parsed.y.toFixed(0);
              return '$' + ctx.parsed.y.toFixed(0);
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            font: { size: 10 },
            color: '#9ca3af',
            maxTicksLimit: 5,
            callback: function(val) {
              const l = this.getLabelForValue(val);
              if (!l) return '';
              const [yr, mo] = l.split('-');
              return months_label[parseInt(mo)-1] + ' ' + yr.slice(2);
            }
          },
          grid: { color: 'rgba(0,0,0,0.04)' }
        },
        y: {
          ticks: { font: { size: 10 }, color: '#9ca3af', callback: v => '$' + Math.round(v) },
          grid: { color: 'rgba(0,0,0,0.04)' }
        }
      }
    }
  });
}
