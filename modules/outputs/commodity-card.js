// modules/outputs/commodity-card.js
// Sales dashboard — Option A: Revenue scorecard
// Season totals as hero, tight crop table below, summer/winter split

import { dbSelect } from '../../js/supabase-client.js';
import { getActiveFarm } from '../../js/app-state.js';
import { formatCurrency, formatNumber } from '../../js/ui.js';
import { getCommodities } from '../../js/commodities.js';

// ── Crop season classification ─────────────────────────────────
const SUMMER_CROPS = ['cotton lint', 'cotton', 'cotton seed', 'sweet corn', 'maize', 'sorghum', 'sunflower', 'mung bean', 'cowpea', 'soybean'];
const WINTER_CROPS = ['wheat', 'barley', 'chickpea', 'chickpeas', 'durum', 'canola', 'oats', 'lentil', 'field pea', 'faba bean', 'lupins'];
const PERMANENT_CROPS = ['almonds', 'pistachios', 'olives', 'grapes', 'citrus'];
const LIVESTOCK = ['wool', 'sheep', 'cattle', 'lamb', 'beef', 'merino', 'prime lamb', 'bobby', 'pig', 'goat'];

function getCropSeason(name) {
  const n = (name || '').toLowerCase();
  if (SUMMER_CROPS.some(c => n.includes(c) || c.includes(n))) return 'summer';
  if (WINTER_CROPS.some(c => n.includes(c) || c.includes(n))) return 'winter';
  if (PERMANENT_CROPS.some(c => n.includes(c) || c.includes(n))) return 'permanent';
  if (LIVESTOCK.some(c => n.includes(c) || c.includes(n))) return 'livestock';
  return 'other';
}

const fC = (n, dp = 0) => n != null ? formatCurrency(n, dp) : '—';
const fN = (n, dp = 0) => n != null && n !== 0 ? formatNumber(n, dp) : '—';
const fM = (n) => {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000000) return (n < 0 ? '-' : '') + '$' + (abs / 1000000).toFixed(1) + 'm';
  if (abs >= 1000) return (n < 0 ? '-' : '') + '$' + Math.round(abs / 1000) + 'k';
  return fC(n);
};
const varColor = (v) => v == null ? 'var(--hint)' : v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--muted)';
const varSign = (v) => v > 0 ? '+' : '';

// ── Main export ────────────────────────────────────────────────
export async function buildCommodityCards(season) {
  const farm = getActiveFarm();
  if (!farm) return { html: _empty('No farm selected.'), commodityMap: {} };

  let commodityStatuses = {};
  try {
    const statuses = await dbSelect('commodity_status', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*');
    statuses.forEach(s => { commodityStatuses[s.commodity_id] = s.status; });
  } catch {}

  const [contracts, invoices, budgets, forecasts, harvests] = await Promise.all([
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.desc'),
    dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    dbSelect('forecasts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*&order=forecast_date.asc'),
    dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
  ]);

  const masterCommodities = getCommodities();
  const idToName = {};
  masterCommodities.forEach(c => { idToName[c.id] = c.name; });

  const commodityMap = {};
  const nameToKey = {};

  const addCommodity = (id, name) => {
    if (!id && !name) return null;
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

  contracts.forEach(c => { const k = addCommodity(c.commodity_id, c.commodity); if (k) commodityMap[k].contracts.push(c); });
  budgets.forEach(b => { const k = addCommodity(b.commodity_id, b.commodity); if (k) commodityMap[k].budgets.push(b); });
  invoices.forEach(i => {
    if (i.batches && (typeof i.batches === 'string' ? JSON.parse(i.batches) : i.batches).length) {
      const b = typeof i.batches === 'string' ? JSON.parse(i.batches) : i.batches;
      const seen = new Set();
      b.forEach(batch => {
        (batch.lines || []).filter(l => l.type === 'income' && l.line_type !== 'qa').forEach(l => {
          const desc = l.description?.trim();
          if (!desc) return;
          const k = addCommodity(null, desc);
          if (k && !seen.has(k)) { commodityMap[k].invoices.push({ ...i, _batch: batch }); seen.add(k); }
        });
      });
    } else if (i.commodity_type && (!i.season || i.season === season)) {
      const k = addCommodity(null, i.commodity_type);
      if (k) commodityMap[k].invoices.push(i);
    }
  });
  forecasts.forEach(f => { addCommodity(f.commodity_id, f.commodity); });
  harvests.forEach(h => { addCommodity(h.commodity_id, null); });

  // Market prices
  const commodityList = getCommodities();
  const farmSettings = farm.settings || {};
  const grainSites = farmSettings.grainSites || {};
  await Promise.all(Object.entries(commodityMap).map(async ([key, com]) => {
    if (!com.id) return;
    try {
      const commodityObj = commodityList.find(c => c.id === com.id);
      const commodityName = commodityObj?.name || com.name || '';
      const deliverySite = grainSites[commodityName] || null;
      let q = 'commodity_id=eq.' + com.id + '&select=price_per_unit,price_date&order=price_date.desc&limit=1';
      if (deliverySite) q += '&region=eq.' + encodeURIComponent(deliverySite);
      const prices = await dbSelect('market_prices', q);
      com.latestPrice = prices[0] || null;
    } catch { com.latestPrice = null; }
  }));

  const cards = Object.values(commodityMap);
  if (!cards.length) return { html: _empty('No commodity data for ' + season + ' yet.<br>Add contracts or budgets to see the position dashboard.'), commodityMap: {} };

  // Build computed stats per commodity
  const computed = cards.map(com => _computeCom(com, forecasts, harvests, season, commodityStatuses));

  // Group by season
  const groups = { summer: [], winter: [], permanent: [], livestock: [], other: [] };
  computed.forEach(c => { const s = getCropSeason(c.name); groups[s].push(c); });

  // Build HTML
  let html = '<div style="display:flex;flex-direction:column;gap:16px">';

  ['summer', 'winter', 'permanent', 'livestock', 'other'].forEach(grp => {
    const items = groups[grp];
    if (!items.length) return;

    const label = { summer: 'Summer crops', winter: 'Winter crops', permanent: 'Permanent crops', livestock: 'Livestock', other: 'Other' }[grp];
    const cropNames = items.map(c => c.name).join(' · ');

    // Season totals
    const budgetRev = items.reduce((s, c) => s + (c.budgetProd && c.budgetPrice ? c.budgetProd * c.budgetPrice : 0), 0);
    const soldRev = items.reduce((s, c) => s + c.soldRevenue, 0);
    const unsoldRev = items.reduce((s, c) => s + Math.max(0, (c.unsoldQty || 0) * (c.budgetPrice || 0)), 0);
    const priceVar = items.reduce((s, c) => s + (c.priceVariance || 0), 0);
    const priceVarPct = soldRev > 0 && budgetRev > 0 ? ((soldRev - (budgetRev - unsoldRev)) / (budgetRev - unsoldRev) * 100) : null;

    html += `
    <div class="card" style="overflow:hidden">

      <!-- Section header -->
      <div style="padding:8px 16px;background:#1a2535;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;font-weight:600;color:white;text-transform:uppercase;letter-spacing:.08em">${label}</span>
        <span style="font-size:10px;color:rgba(255,255,255,.4)">${cropNames}</span>
      </div>

      <!-- Hero totals -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;border-bottom:1px solid var(--border)">
        <div style="padding:16px 18px;border-right:1px solid var(--border)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:6px">Budget revenue</div>
          <div style="font-size:28px;font-weight:600;color:var(--ink);letter-spacing:-.02em">${fM(budgetRev)}</div>
        </div>
        <div style="padding:16px 18px;border-right:1px solid var(--border)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:6px">Sold revenue</div>
          <div style="font-size:28px;font-weight:600;color:var(--green);letter-spacing:-.02em">${fM(soldRev)}</div>
          <div style="font-size:10px;color:var(--hint);margin-top:4px">${budgetRev > 0 ? Math.round(soldRev / budgetRev * 100) + '% of budget' : ''}</div>
        </div>
        <div style="padding:16px 18px;border-right:1px solid var(--border)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:6px">Unsold at budget price</div>
          <div style="font-size:28px;font-weight:600;color:var(--blue);letter-spacing:-.02em">${fM(unsoldRev)}</div>
          <div style="font-size:10px;color:var(--hint);margin-top:4px">Remaining to sell</div>
        </div>
        <div style="padding:16px 18px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:6px">Price variance on sold</div>
          <div style="font-size:28px;font-weight:600;letter-spacing:-.02em;color:${varColor(priceVar)}">${priceVar > 0 ? '+' : ''}${fM(priceVar)}</div>
          <div style="font-size:10px;margin-top:4px;color:${varColor(priceVar)}">${priceVar > 0 ? 'Above' : priceVar < 0 ? 'Below' : 'On'} budget price</div>
        </div>
      </div>

      <!-- Column headers -->
      <div style="display:grid;grid-template-columns:150px 80px 70px 70px 55px 70px 80px 80px 65px;gap:0;padding:5px 14px;background:var(--page-bg);border-bottom:1px solid var(--border)">
        ${['Crop', 'Est prod', 'Bud price', 'Sold', '% sold', 'Unsold', 'Avg sold $', 'vs budget', 'Mkt price']
          .map((h, i) => `<div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;${i > 0 ? 'text-align:right' : ''}">${h}</div>`)
          .join('')}
      </div>

      <!-- Crop rows -->
      ${items.map((c, idx) => _buildRow(c, idx % 2 === 1)).join('')}
    </div>`;
  });

  html += '</div>';
  return { html, commodityMap };
}

// ── Compute per-commodity stats ────────────────────────────────
function _computeCom(com, allForecasts, allHarvests, season, commodityStatuses) {
  const name = com.name || 'Unknown';
  const contracts = com.contracts || [];
  const invoices = com.invoices || [];
  const budgets = com.budgets || [];

  // Budget
  const budgetProd = budgets.reduce((s, b) => s + (parseFloat(b.budgeted_production) || ((parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0))), 0) || null;
  const budgetsWithPrice = budgets.filter(b => b.price);
  const budgetPrice = budgetsWithPrice.length ? budgetsWithPrice.reduce((s, b) => s + parseFloat(b.price), 0) / budgetsWithPrice.length : null;

  // Forecast
  const comForecasts = allForecasts.filter(f => f.commodity_id === com.id || f.commodity?.toLowerCase() === com.name?.toLowerCase());
  const latestPerBudget = {};
  comForecasts.forEach(f => { const k = f.budget_id || 'def'; if (!latestPerBudget[k] || f.forecast_date > latestPerBudget[k].forecast_date) latestPerBudget[k] = f; });
  const latestForecasts = Object.values(latestPerBudget);
  const forecastProd = latestForecasts.length ? latestForecasts.reduce((s, f) => s + (parseFloat(f.forecast_production) || (parseFloat(f.area_ha)||0) * (parseFloat(f.yield_per_ha)||0)), 0) : null;

  // Harvest
  const comHarvests = allHarvests.filter(h => h.commodity_id === com.id);
  const totalHarvest = comHarvests.reduce((s, h) => s + (parseFloat(h.actual_production) || 0), 0);

  // Sold qty + revenue from invoices
  let soldQty = 0, soldRevenue = 0;
  invoices.forEach(i => {
    if (i._batch) {
      const batch = i._batch;
      const saleLine = (batch.lines || []).find(l => l.type === 'income' && l.line_type !== 'qa');
      soldQty += parseFloat(batch.qty) || 0;
      soldRevenue += (parseFloat(batch.qty) || 0) * (parseFloat(saleLine?.eff_per_unit) || 0) || parseFloat(saleLine?.amount) || 0;
    } else {
      soldQty += parseFloat(i.total_qty) || parseFloat(i.master_qty) || 0;
      soldRevenue += (parseFloat(i.gross_amount) || 0) + (parseFloat(i.total_quality_adj) || 0);
    }
  });

  const avgSoldPrice = soldQty > 0 ? soldRevenue / soldQty : null;
  const estProd = forecastProd || budgetProd;
  const unsoldQty = estProd != null ? Math.max(0, estProd - soldQty) : null;
  const pctSold = estProd ? Math.round(soldQty / estProd * 100) : null;
  const priceVariance = avgSoldPrice && budgetPrice && soldQty ? (avgSoldPrice - budgetPrice) * soldQty : null;
  const vsbudgetPct = avgSoldPrice && budgetPrice ? Math.round((avgSoldPrice - budgetPrice) / budgetPrice * 100) : null;

  const unit = contracts[0]?.unit || budgets[0]?.unit || invoices[0]?.master_unit || 'unit';
  const marketPrice = com.latestPrice ? parseFloat(com.latestPrice.price_per_unit) : null;

  return { name, budgetProd, budgetPrice, soldQty, soldRevenue, avgSoldPrice, unsoldQty, pctSold, priceVariance, vsbudgetPct, marketPrice, unit };
}

// ── Single crop row ────────────────────────────────────────────
function _buildRow(c, alt) {
  const arrow = (v) => {
    if (v == null) return '';
    if (v > 2) return '<span style="display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid var(--green);vertical-align:middle;margin-right:3px"></span>';
    if (v < -2) return '<span style="display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:7px solid var(--red);vertical-align:middle;margin-right:3px"></span>';
    return '<span style="display:inline-block;width:9px;height:3px;background:var(--amber);vertical-align:middle;margin-right:3px;border-radius:1px"></span>';
  };

  const col = `font-size:11px;text-align:right;font-variant-numeric:tabular-nums;padding:9px 14px`;
  const pctColor = c.pctSold == null ? 'var(--hint)' : c.pctSold >= 100 ? 'var(--green)' : c.pctSold >= 80 ? 'var(--ink-mid)' : 'var(--blue)';

  return `
  <div style="display:grid;grid-template-columns:150px 80px 70px 70px 55px 70px 80px 80px 65px;gap:0;align-items:center;border-bottom:1px solid var(--border-light);${alt ? 'background:var(--page-bg)' : ''}"
    onmouseenter="this.style.background='var(--blue-light)'" onmouseleave="this.style.background='${alt ? 'var(--page-bg)' : ''}'">
    <div style="padding:9px 14px;font-size:12px;font-weight:600;color:var(--ink)">
      ${c.name}
      <span style="font-size:10px;font-weight:400;color:var(--hint);margin-left:4px">${c.unit}</span>
    </div>
    <div style="${col};color:var(--ink-mid)">${c.budgetProd ? fN(c.budgetProd) : '—'}</div>
    <div style="${col};color:var(--ink-mid)">${c.budgetPrice ? fC(c.budgetPrice) : '—'}</div>
    <div style="${col};font-weight:600;color:var(--ink)">${c.soldQty ? fN(c.soldQty) : '—'}</div>
    <div style="${col};color:${pctColor};font-weight:500">${c.pctSold != null ? c.pctSold + '%' : '—'}</div>
    <div style="${col};color:var(--blue)">${c.unsoldQty != null && c.unsoldQty > 0 ? fN(c.unsoldQty) : c.unsoldQty === 0 ? '<span style=\'color:var(--hint)\'>—</span>' : '—'}</div>
    <div style="${col};font-weight:600;color:var(--ink)">${c.avgSoldPrice ? fC(c.avgSoldPrice) : '—'}</div>
    <div style="${col}">
      ${c.vsbudgetPct != null ? arrow(c.vsbudgetPct) + '<span style="color:' + varColor(c.vsbudgetPct) + ';font-weight:600">' + varSign(c.vsbudgetPct) + c.vsbudgetPct + '%</span>' : '—'}
    </div>
    <div style="${col};color:var(--ink-mid)">${c.marketPrice ? fC(c.marketPrice) : '—'}</div>
  </div>`;
}

function _empty(msg) {
  return '<div class="card"><div class="card-body"><div class="empty-state"><div class="empty-icon">📦</div><p>' + msg + '</p></div></div></div>';
}

// ── Mini charts (preserved exactly) ───────────────────────────
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