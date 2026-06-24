// modules/outputs/commodity-card.js
// Commodity position card — matches the data card design from old system
// Shows budget vs forecast vs actual, hedging position, price summary

import { dbSelect } from '../../js/supabase-client.js';
import { getActiveFarm } from '../../js/app-state.js';
import { formatCurrency, formatNumber, formatDate } from '../../js/ui.js';

export async function buildCommodityCards(season) {
  const farm = getActiveFarm();
  if (!farm) return '<div class="empty-state"><p>No farm selected.</p></div>';

  // Load all data in parallel
  const [contracts, invoices, budgets, forecasts, harvests] = await Promise.all([
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    dbSelect('forecasts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*&order=forecast_date.asc'),
    dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
  ]);

  // Get all unique commodities across contracts, budgets and invoices
  // Use commodity_id as primary key when available, fall back to name
  const commodityMap = {};
  const nameToKey = {}; // map commodity name -> key for merging

  const addCommodity = (id, name) => {
    if (!id && !name) return null;
    // If we have an id, use it as the key
    // If we only have a name, check if we've seen this name already under an id
    let key = id || nameToKey[name?.toLowerCase()] || name;
    if (!commodityMap[key]) {
      commodityMap[key] = { id: id || null, name: name || key, contracts: [], invoices: [], budgets: [], forecasts: [], harvests: [] };
    }
    // Record name->key mapping so name-only entries can find id-based entries
    if (name && id) nameToKey[name.toLowerCase()] = key;
    // Update id if we now have one
    if (id && !commodityMap[key].id) commodityMap[key].id = id;
    if (name && !commodityMap[key].name) commodityMap[key].name = name;
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
    const key = addCommodity(null, i.commodity_type);
    if (key) commodityMap[key].invoices.push(i);
  });
  forecasts.forEach(f => { addCommodity(f.commodity_id, f.commodity); });
  harvests.forEach(h => { addCommodity(h.commodity_id, null); });

  // Also get latest market price for each commodity
  const pricePromises = Object.entries(commodityMap).map(async ([key, com]) => {
    if (!com.id) return;
    try {
      const prices = await dbSelect('market_prices',
        'commodity_id=eq.' + com.id + '&select=price_per_unit,price_date&order=price_date.desc&limit=1'
      );
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
    html: cards.map(com => _buildCard(com, forecasts, harvests, season)).join(''),
    commodityMap
  };
}

function _buildCard(com, allForecasts, allHarvests, season) {
  const name = com.name || 'Unknown';
  const contracts = com.contracts || [];
  const invoices = com.invoices || [];
  const budgets = com.budgets || [];

  // Budget totals (sum across crop types)
  const totalBudgetProd = budgets.reduce((s, b) => s + (parseFloat(b.budgeted_production) || ((parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0))), 0);
  const totalBudgetArea = budgets.reduce((s, b) => s + (parseFloat(b.area_ha) || 0), 0);
  const budgetYield = totalBudgetArea ? totalBudgetProd / totalBudgetArea : null;
  const budgetPrice = budgets.length ? budgets.reduce((s, b) => s + (parseFloat(b.price) || 0), 0) / budgets.filter(b => b.price).length : null;

  // Latest forecast — only use if one actually exists
  const comForecasts = allForecasts.filter(f => f.commodity_id === com.id || f.commodity?.toLowerCase() === com.name?.toLowerCase());
  const latestForecast = comForecasts[comForecasts.length - 1] || null;
  const forecastProd = latestForecast
    ? (parseFloat(latestForecast.forecast_production) || (parseFloat(latestForecast.area_ha)||0) * (parseFloat(latestForecast.yield_per_ha)||0))
    : null; // null = no forecast entered yet
  const forecastArea = latestForecast ? parseFloat(latestForecast.area_ha) : null;
  const forecastYield = forecastArea ? forecastProd / forecastArea : null;

  // Harvest
  const comHarvests = allHarvests.filter(h => h.commodity_id === com.id);
  const totalHarvest = comHarvests.reduce((s, h) => s + (parseFloat(h.actual_production) || 0), 0);
  const isHarvested = totalHarvest > 0;

  // Contracts / hedging position
  const totalContracted = contracts.reduce((s, c) => s + (parseFloat(c.quantity) || 0), 0);
  const totalContractValue = contracts.reduce((s, c) => s + ((parseFloat(c.quantity)||0) * (parseFloat(c.price_per_unit)||0)), 0);
  const avgFwdPrice = totalContracted ? totalContractValue / totalContracted : null;
  const denominator = isHarvested ? totalHarvest : (forecastProd !== null ? forecastProd : totalBudgetProd);
  const pctHedged = denominator && totalContracted ? Math.round((totalContracted / denominator) * 100) : 0;
  const unhedged = Math.max(0, (denominator || 0) - totalContracted);

  // Invoices / paid
  const totalPaid = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (parseFloat(i.net_amount || i.gross_amount) || 0), 0);
  const paidAvg = invoices.filter(i => i.status === 'paid').length
    ? invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (parseFloat(i.price_per_unit) || 0), 0) / invoices.filter(i => i.status === 'paid').length
    : null;

  // Market price
  const marketPrice = com.latestPrice ? parseFloat(com.latestPrice.price_per_unit) : null;
  const marketVsBudget = marketPrice && budgetPrice ? ((marketPrice - budgetPrice) / budgetPrice * 100) : null;
  const fwdVsBudget = avgFwdPrice && budgetPrice ? ((avgFwdPrice - budgetPrice) / budgetPrice * 100) : null;

  // Status — budget only if no forecast or harvest yet
  const status = isHarvested ? 'harvested' : latestForecast ? 'growing' : 'budget';

  // Production bar width
  const budgetBarW = 100;
  const forecastBarW = (forecastProd !== null && totalBudgetProd) ? Math.min(100, (forecastProd / totalBudgetProd) * 100) : 0;
  const harvestBarW = totalBudgetProd ? Math.min(100, (totalHarvest / totalBudgetProd) * 100) : 0;
  const forecastVsBudget = (forecastProd !== null && totalBudgetProd) ? Math.round((forecastProd / totalBudgetProd) * 100) : null;

  // Unit
  const unit = contracts[0]?.unit || budgets[0]?.unit || 'bale';

  return `
    <div class="card" style="margin-bottom:16px">

      <!-- Card top bar -->
      <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border-light);background:#fafbfc;border-radius:var(--radius-lg) var(--radius-lg) 0 0">
        <span style="font-size:var(--text-md);font-weight:600;color:var(--ink)">${name}</span>
        <span class="badge badge-${status === 'budget' ? 'draft' : status === 'harvested' ? 'paid' : 'issued'}">${status === 'harvested' ? 'Harvested' : status === 'budget' ? 'Budget' : 'Growing'}</span>

        ${denominator ? `
          <div style="flex:1;margin:0 12px">
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px">
              <span style="color:var(--blue);font-weight:500">${formatNumber(totalContracted, 0)} ${unit} fwd contracted</span>
              <span style="color:var(--hint)">${formatNumber(unhedged, 0)} ${unit} unhedged</span>
            </div>
            <div style="height:7px;background:var(--border);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${pctHedged}%;background:var(--blue);border-radius:4px;transition:width .3s"></div>
            </div>
          </div>
          <span style="font-size:var(--text-sm);font-weight:600;color:var(--blue);white-space:nowrap">${pctHedged}% hedged</span>
        ` : ''}
      </div>

      <!-- Card body: left data + right (future chart placeholder) -->
      <div style="display:grid;grid-template-columns:340px 1fr;min-height:220px">

        <!-- Left panel -->
        <div style="padding:16px;border-right:1px solid var(--border-light);display:flex;flex-direction:column;gap:16px">

          <!-- Yield -->
          ${totalBudgetArea || forecastArea ? `
            <div>
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--hint);margin-bottom:8px">Yield</p>
              <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
                <div>
                  <p style="font-size:10px;color:var(--hint);margin-bottom:2px">Budget</p>
                  <p style="font-size:15px;font-weight:600;font-variant-numeric:tabular-nums">${budgetYield ? formatNumber(budgetYield, 2) : '—'}</p>
                  <p style="font-size:11px;color:var(--hint)">${totalBudgetArea ? formatNumber(totalBudgetArea, 0) + ' ha' : ''}</p>
                </div>
                <div>
                  <p style="font-size:10px;color:var(--hint);margin-bottom:2px">Forecast</p>
                  ${latestForecast
                    ? '<p style="font-size:15px;font-weight:600;color:var(--blue);font-variant-numeric:tabular-nums">' + (forecastYield ? formatNumber(forecastYield, 2) : '—') + '</p><p style="font-size:11px;color:var(--hint)">' + (forecastArea ? formatNumber(forecastArea, 0) + ' ha' : '') + '</p>'
                    : '<p style="font-size:13px;color:var(--hint)">None entered</p>'
                  }
                </div>
                <div>
                  <p style="font-size:10px;color:var(--hint);margin-bottom:2px">Actual</p>
                  <p style="font-size:15px;font-weight:600;color:var(--green);font-variant-numeric:tabular-nums">${isHarvested && totalBudgetArea ? formatNumber(totalHarvest / totalBudgetArea, 2) : '—'}</p>
                </div>
                <div>
                  <p style="font-size:10px;color:var(--hint);margin-bottom:2px">vs budget</p>
                  ${forecastVsBudget !== null ? `
                    <p style="font-size:12px;font-weight:600;color:${forecastVsBudget >= 100 ? 'var(--green)' : 'var(--red)'}">
                      ${forecastVsBudget >= 100 ? '▲' : '▼'}${Math.abs(100 - forecastVsBudget)}%
                    </p>
                    <p style="font-size:10px;color:var(--hint)">fcast</p>
                  ` : '<p style="color:var(--hint)">—</p>'}
                </div>
              </div>
            </div>
          ` : ''}

          <!-- Production bars -->
          ${totalBudgetProd || forecastProd ? `
            <div>
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--hint);margin-bottom:8px">Production</p>
              <div style="display:flex;flex-direction:column;gap:6px">
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:11px;color:var(--muted);width:58px;flex-shrink:0">Budget</span>
                  <div style="flex:1;height:7px;background:var(--border);border-radius:4px"><div style="height:100%;width:100%;background:var(--blue);border-radius:4px"></div></div>
                  <span style="font-size:11px;font-variant-numeric:tabular-nums;width:80px;text-align:right">${formatNumber(totalBudgetProd, 0)} ${unit}</span>
                </div>
                ${latestForecast ? '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:11px;color:var(--muted);width:58px;flex-shrink:0">Forecast</span><div style="flex:1;height:7px;background:var(--border);border-radius:4px"><div style="height:100%;width:' + forecastBarW + '%;background:' + (forecastBarW < 80 ? 'var(--red)' : 'var(--blue)') + ';border-radius:4px"></div></div><span style="font-size:11px;font-variant-numeric:tabular-nums;width:80px;text-align:right">' + formatNumber(forecastProd, 0) + (forecastVsBudget && forecastVsBudget < 100 ? ' <span style="font-size:10px;color:var(--red)">▼' + Math.abs(100-forecastVsBudget) + '%</span>' : '') + '</span></div>' : ''}
                ${isHarvested ? `
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style="font-size:11px;color:var(--muted);width:58px;flex-shrink:0">Actual</span>
                    <div style="flex:1;height:7px;background:var(--border);border-radius:4px"><div style="height:100%;width:${harvestBarW}%;background:var(--green);border-radius:4px"></div></div>
                    <span style="font-size:11px;font-variant-numeric:tabular-nums;width:80px;text-align:right">${formatNumber(totalHarvest, 0)} ${unit}</span>
                  </div>
                ` : ''}
              </div>
            </div>
          ` : ''}

          <!-- Prices -->
          <div>
            <p style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:600;color:var(--hint);margin-bottom:8px">Prices</p>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:var(--page-bg);border-radius:var(--radius-md);padding:10px">
              <div>
                <p style="font-size:10px;color:var(--hint);margin-bottom:2px">Paid avg</p>
                <p style="font-size:13px;font-weight:600">${paidAvg ? formatCurrency(paidAvg, 0) : '—'}</p>
              </div>
              <div>
                <p style="font-size:10px;color:var(--hint);margin-bottom:2px">Fwd avg</p>
                <p style="font-size:13px;font-weight:600;color:var(--blue)">${avgFwdPrice ? formatCurrency(avgFwdPrice, 0) : '—'}</p>
                ${fwdVsBudget !== null ? `<p style="font-size:10px;color:${fwdVsBudget >= 0 ? 'var(--green)' : 'var(--red)'}">
                  ${fwdVsBudget >= 0 ? '▲' : '▼'}${Math.abs(fwdVsBudget).toFixed(1)}%
                </p>` : ''}
              </div>
              <div>
                <p style="font-size:10px;color:var(--hint);margin-bottom:2px">Budget</p>
                <p style="font-size:13px;font-weight:600">${budgetPrice ? formatCurrency(budgetPrice, 0) : '—'}</p>
                <p style="font-size:10px;color:var(--hint)">budget</p>
              </div>
              <div>
                <p style="font-size:10px;color:var(--hint);margin-bottom:2px">Market</p>
                <p style="font-size:13px;font-weight:600">${marketPrice ? formatCurrency(marketPrice, 0) : '—'}</p>
                ${marketVsBudget !== null ? `<p style="font-size:10px;color:${marketVsBudget >= 0 ? 'var(--green)' : 'var(--red)'}">
                  ${marketVsBudget >= 0 ? '▲' : '▼'}${Math.abs(marketVsBudget).toFixed(1)}%
                </p>` : ''}
              </div>
            </div>
            ${totalContractValue ? `
              <div style="margin-top:8px;display:flex;gap:8px;font-size:11px">
                ${fwdVsBudget !== null ? `<span style="background:${fwdVsBudget >= 0 ? 'var(--green-light)' : 'var(--red-light)'};color:${fwdVsBudget >= 0 ? 'var(--green-text)' : 'var(--red-text)'};padding:2px 7px;border-radius:4px">
                  ${fwdVsBudget >= 0 ? '▲' : '▼'}${Math.abs(fwdVsBudget).toFixed(1)}% vs budget
                </span>` : ''}
                <span style="color:var(--hint)">· ${formatCurrency(totalContractValue, 0)} contracted</span>
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Right panel: price chart -->
        <div style="padding:16px;display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div style="display:flex;gap:3px">
              <button class="mini-range-btn active" data-months="6" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:var(--blue);color:white;cursor:pointer">6m</button>
              <button class="mini-range-btn" data-months="12" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:var(--white);color:var(--muted);cursor:pointer">12m</button>
              <button class="mini-range-btn" data-months="24" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:var(--white);color:var(--muted);cursor:pointer">24m</button>
              <button class="mini-range-btn" data-months="999" data-chart="${com.id}" style="padding:2px 8px;font-size:10px;border-radius:4px;border:1px solid var(--border);background:var(--white);color:var(--muted);cursor:pointer">All</button>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="document.querySelector('[data-tab=prices]')?.click()" style="font-size:11px">Full chart →</button>
          </div>
          <div style="display:flex;gap:10px;align-items:center">
            <div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><div style="width:16px;height:2px;background:var(--blue)"></div>Market</div>
            ${avgFwdPrice ? '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><div style="width:16px;height:0;border-top:2px dashed #b86e00"></div>Fwd avg</div>' : ''}
            ${contracts.length ? '<div style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--muted)"><div style="width:8px;height:8px;border-radius:50%;background:var(--green)"></div>Fwd sale</div>' : ''}
          </div>
          <div id="card-chart-${com.id || name.replace(/\s/g,'-')}" style="flex:1;min-height:150px;display:flex;align-items:center;justify-content:center">
            <p style="font-size:12px;color:var(--hint)">Price chart loading…</p>
          </div>
        </div>

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

      const prices = await dbSelect('market_prices',
        'commodity_id=eq.' + com.id + '&price_date=gte.' + cutoffStr + '&select=price_date,price_per_unit&order=price_date.asc'
      );

      allPrices[com.id] = prices;

      if (!prices.length) {
        canvasContainer.innerHTML = '<p style="font-size:12px;color:var(--hint)">No price data available</p>';
        continue;
      }

      const contracts = com.contracts || [];
      const totalContracted = contracts.reduce((s, c) => s + (parseFloat(c.quantity)||0), 0);
      const totalValue = contracts.reduce((s, c) => s + (parseFloat(c.quantity)||0) * (parseFloat(c.price_per_unit)||0), 0);
      const avgFwd = totalContracted ? totalValue / totalContracted : null;

      _drawMiniChart(canvasContainer, prices, contracts, avgFwd, 6);

      // Wire range buttons for this commodity
      document.querySelectorAll('.mini-range-btn[data-chart="' + com.id + '"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const months = parseInt(btn.dataset.months);
          document.querySelectorAll('.mini-range-btn[data-chart="' + com.id + '"]').forEach(b => {
            const active = b.dataset.months === btn.dataset.months;
            b.style.background = active ? 'var(--blue)' : 'var(--white)';
            b.style.color = active ? 'white' : 'var(--muted)';
          });
          _drawMiniChart(canvasContainer, allPrices[com.id] || [], contracts, avgFwd, months);
        });
      });

    } catch (e) {
      canvasContainer.innerHTML = '<p style="font-size:11px;color:var(--hint)">Chart unavailable</p>';
      console.error('Mini chart error:', e);
    }
  }
}

function _drawMiniChart(container, allPrices, contracts, avgFwd, months) {
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
    }
  };

  const months_label = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  container._chart = new window.Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    plugins: avgFwd ? [avgLabelPlugin] : [],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: avgFwd ? 40 : 8 } },
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
