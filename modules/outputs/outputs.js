// modules/outputs/outputs.js
// Outputs module — Dashboard, Contracts, Market Prices, Invoices

import { dbSelect, dbInsert, dbUpdate, dbDelete, dbUpsert, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite, getActiveSeason, getRole } from '../../js/app-state.js';
import {
  toast, openModal, formatCurrency, formatDate,
  commodityBadge, statusBadge, qs, setContent, currentSeason, formatNumber
} from '../../js/ui.js';
import { mountContracts, unmountContracts } from './contracts.js';
import { mountInvoices, unmountInvoices, openInvoiceForm } from './invoices.js';
import { mountReconciliation, unmountReconciliation } from './reconciliation.js';
import { mountMarketPrices, unmountMarketPrices } from './market-prices.js';
import { buildCommodityCards, drawMiniCharts, buildContractPosition, buildOperationsSummary, buildLivestockPosition } from './commodity-card.js';
import { loadCommodities, getCommodities } from '../../js/commodities.js';

let _invoices = [];
let _contracts = [];
let _unsub = null;
let _activeTab = (() => {
  const role = getRole();
  if (role === 'investor') return 'investor';
  if (role === 'accounting') return 'admin';
  return 'overview';
})();

// ── Entry point ───────────────────────────────────────────────
export async function mountOutputs(container) {
  const farm = getActiveFarm();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Outputs</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid);margin-top:3px">${farm?.name || ''}</p>
      </div>
    </div>

    <div class="tab-strip">
      <button class="tab-btn" data-tab="investor">Investor view</button>
      <button class="tab-btn" data-tab="overview">Manager view</button>
      <button class="tab-btn" data-tab="admin">Admin</button>
      <button class="tab-btn" data-tab="contracts">Contracts</button>
      <button class="tab-btn" data-tab="prices">Market prices</button>
      <button class="tab-btn" data-tab="invoices">Invoices</button>
      <button class="tab-btn" data-tab="reconciliation">Reconciliation</button>
    </div>

    <div id="tab-content"></div>
  `;

  // Set initial active tab
  container.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === _activeTab);
  });

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === _activeTab);
      });
      _loadTab();
    });
  });

  // Listen for global season changes
  const onSeasonChange = () => { if (['overview','investor','admin'].includes(_activeTab)) _loadTab(); };
  window.addEventListener('cfm:seasonchange', onSeasonChange);
  container._offSeasonChange = () => window.removeEventListener('cfm:seasonchange', onSeasonChange);

  _loadTab();
}

export function unmountOutputs() {
  unmountContracts();
  unmountMarketPrices();
  unmountInvoices();
  unmountReconciliation();
  if (_unsub) { _unsub(); _unsub = null; }
  const main = document.getElementById('main');
  if (main?._offSeasonChange) { main._offSeasonChange(); delete main._offSeasonChange; }
  _invoices = [];
  _contracts = [];
}

function _seasonOptions(selected = null) {
  const current = currentSeason();
  const [y] = current.split('-').map(Number);
  // Use selected season if provided, otherwise current
  const active = selected || current;
  return Array.from({ length: 5 }, (_, i) => {
    const s = `${y + 1 - i}-${String(y + 2 - i).slice(2)}`;
    return `<option value="${s}" ${s === active ? 'selected' : ''}>${s}</option>`;
  }).join('');
}

async function _loadTab() {
  const content = qs('#tab-content');
  if (!content) return;
  unmountContracts();
  unmountMarketPrices();
  if (_activeTab === 'investor') {
    await _mountInvestorView(content);
  } else if (_activeTab === 'admin') {
    await _mountAdminView(content);
  } else if (_activeTab === 'overview') {
    await _mountOverview(content);
  } else if (_activeTab === 'contracts') {
    await mountContracts(content);
  } else if (_activeTab === 'prices') {
    await mountMarketPrices(content);
  } else if (_activeTab === 'reconciliation') {
    await mountReconciliation(content);
  } else {
    await mountInvoices(content);
  }
}

// ── Manager view ─────────────────────────────────────────────
async function _mountOverview(container) {
  const farm = getActiveFarm();
  if (!farm) { container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>'; return; }
  container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';

  try {
    await loadCommodities();
    const commodityList = getCommodities();
    const settings = farm.settings || {};
    const cottonRegion = settings.cottonRegion || '';
    const grainSites = settings.grainSites || {};

    // Get livestock commodity IDs for targeted price fetch
    const cattleComId = commodityList.find(c => c.name === 'Cattle Indicators')?.id || null;
    const sheepComId  = commodityList.find(c => c.name === 'Sheep Indicators')?.id  || null;

    // Fetch prices — filter grain by farm's catchment+watchlist to avoid row limit issues
    const grainCatchment = settings.grainCatchment || [];
    const grainWatchlist = settings.grainWatchlist || {};
    const watchedGrades = Object.values(grainWatchlist).flat();
    const catchmentRegions = grainCatchment.flatMap(site =>
      watchedGrades.map(grade => `${site}|${grade}`)
    );

    const [grainPrices, livestockPrices] = await Promise.all([
      catchmentRegions.length
        ? dbSelect('market_prices',
            'select=commodity_id,region,price_per_unit,price_date,unit&source_label=eq.CropConnect'
            + '&region=in.(' + catchmentRegions.map(r => encodeURIComponent(r)).join(',') + ')'
            + '&order=price_date.desc&limit=2000'
          ).catch(() => [])
        : Promise.resolve([]),
      dbSelect('market_prices',
        'select=commodity_id,region,price_per_unit,price_date,unit,attributes&order=price_date.desc&limit=500'
        + '&commodity_id=in.(' + [cattleComId, sheepComId].filter(Boolean).join(',') + ')'
      ).catch(() => []),
    ]);
    // Also fetch cotton/LDC prices (no source_label or non-CropConnect)
    const cottonPrices = cottonRegion ? await dbSelect('market_prices',
      'select=commodity_id,region,price_per_unit,price_date,unit&region=eq.' + encodeURIComponent(cottonRegion) + '&order=price_date.desc&limit=100'
    ).catch(() => []) : [];

    const allPrices = [...grainPrices, ...livestockPrices, ...cottonPrices];

    const fC = (n, dp=2) => n == null ? '—' : formatCurrency(n, dp);
    const fM = (n) => n == null ? '—' : n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'k' : '$' + Math.round(n).toLocaleString();
    const fN = (n, dp=0) => n == null ? '—' : Number(n).toLocaleString('en-AU', {minimumFractionDigits:dp, maximumFractionDigits:dp});
    const fPct = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

    // Farm's grain watchlist — commodity+grade pairs to show, best bid within catchment
    const farmSites = [];

    // New format: grainWatchlist = { Wheat: ['APW1','APW'], Barley: ['BAR1'] }
    // One entry per commodity — grades array is priority order, first with data wins
    Object.entries(grainWatchlist).forEach(([crop, grades]) => {
      if (grades.length) {
        farmSites.push({ crop, grades, type: 'cc', catchment: grainCatchment });
      }
    });

    // Old LDC/CropConnect per-commodity format fallback
    Object.entries(grainSites).forEach(([crop, setting]) => {
      if (!setting || grainWatchlist[crop]) return; // skip if already in new format
      if (typeof setting === 'string') {
        farmSites.push({ crop, site: setting, grade: null, type: 'ldc' });
      } else if (setting.primary) {
        const grade = setting.grade || null;
        farmSites.push({ crop, grade, type: 'cc',
          catchment: [setting.primary, setting.secondary, setting.tertiary].filter(Boolean) });
      }
    });

    if (cottonRegion) farmSites.push({ crop: 'Cotton Lint', site: cottonRegion, grade: null, type: 'cotton' });

    // Livestock indicators from farm settings — use master price data
    // Livestock indicators from farm settings — saleyard fallback logic
    const lsIndicatorNames = farm.settings?.livestockIndicators || [];
    const saleyards = farm.settings?.livestockSaleyards || {};
    const saleyardPriority = [saleyards.primary, saleyards.secondary, saleyards.tertiary].filter(Boolean);
    const SALEYARD_NAMES = { GUN:'Gunnedah', TAM:'Tamworth', ARM:'Armidale', INV:'Inverell', DUB:'Dubbo', SCO:'Scone', WAG:'Wagga', CAS:'Casino' };

    const lsCards = lsIndicatorNames.map(name => {
      // Try saleyards in priority order — skip if head_count is 0
      let history = [];
      let sourceLabel = 'National';

      for (const sy of saleyardPriority) {
        const syHistory = allPrices
          .filter(p => p.region === sy + ':' + name && (!p.attributes || p.attributes.head_count > 0))
          .sort((a, b) => b.price_date.localeCompare(a.price_date));
        if (syHistory.length) {
          history = syHistory;
          sourceLabel = SALEYARD_NAMES[sy] || sy;
          break;
        }
      }

      // Fall back to national
      if (!history.length) {
        history = allPrices.filter(p => p.region === name).sort((a, b) => b.price_date.localeCompare(a.price_date));
        sourceLabel = 'National';
      }

      if (!history.length) return '<div class="card" style="padding:16px 18px;margin-bottom:12px"><div style="font-size:13px;font-weight:700;color:var(--ink)">' + name + '</div><div style="font-size:12px;color:var(--hint);margin-top:8px">No data yet</div></div>';

      const latest = parseFloat(history[0].price_per_unit);
      const latestDate = history[0].price_date;
      const unit = history[0].unit || 'c/kg';
      const prev = history.length > 1 ? parseFloat(history[1].price_per_unit) : null;
      const dayMove = prev != null ? latest - prev : null;
      const dayMovePct = prev ? ((latest - prev) / prev * 100) : null;
      const moveColor = dayMove == null ? 'var(--hint)' : dayMove >= 0 ? '#16a34a' : '#dc2626';
      const moveArrow = dayMove == null ? '' : dayMove >= 0 ? '▲' : '▼';
      const cutoff = new Date(latestDate); cutoff.setDate(cutoff.getDate() - 14);
      const window14 = history.filter(p => p.price_date >= cutoff.toISOString().slice(0,10));
      const avg14 = window14.length ? window14.reduce((s,p)=>s+parseFloat(p.price_per_unit),0)/window14.length : null;
      const vsAvg = avg14 != null ? latest - avg14 : null;
      const vsAvgPct = avg14 ? ((latest-avg14)/avg14*100) : null;
      const avgColor = vsAvg == null ? 'var(--hint)' : vsAvg >= 0 ? '#16a34a' : '#dc2626';
      const bars = window14.length > 1 ? (() => {
        const vals = window14.map(p=>parseFloat(p.price_per_unit)).reverse();
        const min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;
        return '<div style="display:flex;align-items:flex-end;gap:2px;height:28px;margin-top:10px">' +
          vals.map(v=>'<div style="flex:1;height:'+Math.max(2,Math.round(((v-min)/range)*24))+'px;background:'+(v>=latest?'#16a34a':'#94a3b8')+';border-radius:1px;align-self:flex-end"></div>').join('') + '</div>';
      })() : '';

      return [
        '<div class="card" style="padding:12px 14px;margin-bottom:8px;cursor:pointer"',
        ' data-expand-crop="' + name + '"',
        ' data-expand-region="' + name + '"',
        ' data-expand-grade=""',
        ' data-expand-comid="' + (cattleComId || sheepComId || '') + '"',
        ' data-expand-livestock="1">',
        '<div style="display:flex;align-items:center;justify-content:space-between">',
        '<div>',
        '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px">',
        '<div style="font-size:11px;font-weight:600;color:var(--ink)">'+name+'</div>',
        '<div style="font-size:10px;color:var(--hint)">'+new Date(latestDate).toLocaleDateString('en-AU',{day:'numeric',month:'short'})+' · '+sourceLabel+' · '+unit+'</div>',
        '</div>',
        '<div style="display:flex;align-items:baseline;gap:5px">',
        '<span style="font-size:22px;font-weight:700;color:var(--ink)">'+latest.toFixed(2)+'</span>',
        '<span style="font-size:11px;color:var(--hint)">'+unit+'</span>',
        '</div></div>',
        '<div style="text-align:right;min-width:110px">',
        '<div style="font-size:14px;color:var(--hint);margin-bottom:4px" title="View chart">⤢</div>',
        dayMove!=null
          ? '<div style="font-size:12px;font-weight:600;color:'+moveColor+'">'+moveArrow+' '+Math.abs(dayMove).toFixed(2)+' <span style="font-size:10px;font-weight:400;color:'+moveColor+'">(24-hr '+fPct(dayMovePct)+')</span></div>'
          : '<div style="font-size:11px;color:var(--hint)">—</div>',
        avg14!=null
          ? '<div style="font-size:10px;color:var(--hint);margin-top:3px">14-day avg: '+avg14.toFixed(2)+' <span style="color:'+avgColor+'">'+(vsAvg>=0?'▲':'▼')+fPct(vsAvgPct)+'</span></div>'
          : '',
        '</div>',
        '</div></div>',
      ].join('');
    }).join('');

    // Build price cards — one per commodity, grade priority fallback
    const priceCards = farmSites.map(({ crop, site, catchment, grades, grade, type }) => {
      const com = commodityList.find(c => c.name === crop);
      if (!com) return '';

      let history = [];
      let sourceLabel = site || '';
      let resolvedGrade = grade || null;
      let resolvedRegion = '';

      if (type === 'cc' && catchment?.length) {
        // Try each grade in priority order until we find data in catchment
        const gradeList = grades || (grade ? [grade] : []);
        for (const g of gradeList) {
          const catchmentKeys = catchment.map(s => `${s}|${g}`);
          const catchmentPrices = allPrices
            .filter(p => p.commodity_id === com.id && catchmentKeys.includes(p.region))
            .sort((a, b) => b.price_date.localeCompare(a.price_date) || parseFloat(b.price_per_unit) - parseFloat(a.price_per_unit));
          if (catchmentPrices.length) {
            const latestDate = catchmentPrices[0].price_date;
            const todayPrices = catchmentPrices.filter(p => p.price_date === latestDate);
            const best = todayPrices.reduce((a, b) => parseFloat(a.price_per_unit) >= parseFloat(b.price_per_unit) ? a : b);
            sourceLabel = best.region.split('|')[0];
            resolvedGrade = g;
            resolvedRegion = best.region;
            history = allPrices
              .filter(p => p.commodity_id === com.id && p.region === best.region)
              .sort((a, b) => b.price_date.localeCompare(a.price_date));
            break;
          }
        }
      } else {
        // LDC or Cotton — simple region match
        resolvedRegion = site;
        history = allPrices.filter(p => p.commodity_id === com.id && p.region === site)
          .sort((a, b) => b.price_date.localeCompare(a.price_date));
      }

      const unit = resolvedGrade || 't';

      if (!history.length) return [
        '<div class="card" style="padding:12px 14px;margin-bottom:8px">',
        '<div style="font-size:11px;font-weight:600;color:var(--ink)">' + crop + '</div>',
        '<div style="font-size:10px;color:var(--hint);margin-bottom:4px">' + sourceLabel + (resolvedGrade ? ' · ' + resolvedGrade : '') + '</div>',
        '<div style="font-size:12px;color:var(--hint);margin-top:8px">No price data yet</div>',
        '</div>',
      ].join('');

      const latest = parseFloat(history[0].price_per_unit);
      const latestDate = history[0].price_date;
      const displayUnit = history[0].unit || 't';
      const prev = history.length > 1 ? parseFloat(history[1].price_per_unit) : null;

      // Daily movement
      const dayMove = prev != null ? latest - prev : null;
      const dayMovePct = prev ? ((latest - prev) / prev * 100) : null;
      const moveColor = dayMove == null ? 'var(--hint)' : dayMove >= 0 ? '#16a34a' : '#dc2626';
      const moveArrow = dayMove == null ? '' : dayMove >= 0 ? '▲' : '▼';

      // 14-day rolling average
      const cutoff = new Date(latestDate);
      cutoff.setDate(cutoff.getDate() - 14);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const window14 = history.filter(p => p.price_date >= cutoffStr);
      const avg14 = window14.length
        ? window14.reduce((s, p) => s + parseFloat(p.price_per_unit), 0) / window14.length
        : null;
      const vsAvg = avg14 != null ? latest - avg14 : null;
      const vsAvgPct = avg14 ? ((latest - avg14) / avg14 * 100) : null;
      const avgColor = vsAvg == null ? 'var(--hint)' : vsAvg >= 0 ? '#16a34a' : '#dc2626';

      return [
        '<div class="card" style="padding:12px 14px;margin-bottom:8px;cursor:pointer"',
        ' data-expand-crop="' + crop + '"',
        ' data-expand-region="' + resolvedRegion + '"',
        ' data-expand-grade="' + (resolvedGrade||'') + '"',
        ' data-expand-comid="' + com.id + '">',
        '<div style="display:flex;align-items:center;justify-content:space-between">',
        // Left — name + price
        '<div>',
        '<div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:2px">',
        '<div style="font-size:11px;font-weight:600;color:var(--ink)">' + crop + '</div>',
        '<div style="font-size:10px;color:var(--hint)">' + new Date(latestDate).toLocaleDateString('en-AU',{day:'numeric',month:'short'}) + ' · ' + sourceLabel + (resolvedGrade ? ' · ' + resolvedGrade : '') + '</div>',
        '</div>',
        '<div style="display:flex;align-items:baseline;gap:5px">',
        '<span style="font-size:22px;font-weight:700;color:var(--ink)">' + fC(latest) + '</span>',
        '<span style="font-size:11px;color:var(--hint)">/' + displayUnit + '</span>',
        '</div>',
        '</div>',
        // Right — expand icon + 24-hr + 14-day avg
        '<div style="text-align:right;min-width:110px">',
        '<div style="font-size:14px;color:var(--hint);margin-bottom:4px" title="View chart">⤢</div>',
        dayMove != null
          ? '<div style="font-size:12px;font-weight:600;color:' + moveColor + '">' + moveArrow + ' ' + fC(Math.abs(dayMove)) + ' <span style="font-size:10px;font-weight:400;color:' + moveColor + '">(24-hr ' + fPct(dayMovePct) + ')</span></div>'
          : '<div style="font-size:11px;color:var(--hint)">—</div>',
        avg14 != null
          ? '<div style="font-size:10px;color:var(--hint);margin-top:3px">14-day avg: ' + fC(avg14) + ' <span style="color:' + avgColor + '">' + (vsAvg >= 0 ? '▲' : '▼') + fPct(vsAvgPct) + '</span></div>'
          : '',
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    }).join('');

    // ── Commodity position ────────────────────────────────────
    const season = getActiveSeason() || currentSeason();
    const [contracts, invoices, lsInvoices, budgets, harvests, forecasts] = await Promise.all([
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&master_unit=neq.head&select=id,gross_amount,total_quality_adj,total_qty,forward_contract_id,batches,status'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&master_unit=eq.head&select=id,gross_amount,total_quality_adj,total_qty,status'),
      dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('forecasts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*&order=forecast_date.desc').catch(() => []),
    ]);

    await loadCommodities();
    const commodityList2 = getCommodities();
    const idToName = {}; commodityList2.forEach(c => { idToName[c.id] = c.name; });

    // Build commodity map from budgets
    const comMap = {};
    budgets.forEach(b => {
      const name = idToName[b.commodity_id] || b.commodity || 'Other';
      if (!comMap[name]) comMap[name] = {
        name, commodity_id: b.commodity_id,
        budProd: 0, budPrice: 0, unit: b.unit||'t',
        contracts: [], invoicedQty: 0, invoicedRev: 0, invoicedQA: 0,
        harvestedProd: 0, isLivestock: false, isHarvestComplete: false,
        fcstProd: 0,
      };
      comMap[name].budProd += parseFloat(b.budgeted_production)||((parseFloat(b.area_ha)||0)*(parseFloat(b.budgeted_yield_per_ha||b.yield_per_ha)||0));
      comMap[name].budPrice = parseFloat(b.price)||comMap[name].budPrice;
      if (b.is_harvest_complete) comMap[name].isHarvestComplete = true;
    });

    // Add latest forecast per commodity
    const fcstByBudget = {};
    forecasts.forEach(f => {
      const k = f.budget_id || f.commodity_id || 'x';
      if (!fcstByBudget[k] || f.forecast_date > fcstByBudget[k].forecast_date) fcstByBudget[k] = f;
    });
    Object.values(fcstByBudget).forEach(f => {
      const b = budgets.find(b => b.id === f.budget_id);
      if (!b) return;
      const name = idToName[b.commodity_id] || b.commodity || 'Other';
      if (comMap[name]) {
        comMap[name].fcstProd += parseFloat(f.forecast_production) || ((parseFloat(f.area_ha||b.area_ha||0)) * (parseFloat(f.yield_per_ha||0)));
      }
    });

    // Contracts
    contracts.forEach(c => {
      const name = idToName[c.commodity_id] || c.commodity || 'Other';
      if (comMap[name]) comMap[name].contracts.push(c);
    });

    // Harvest actuals
    harvests.forEach(h => {
      const name = idToName[h.commodity_id] || h.commodity || 'Other';
      if (comMap[name]) comMap[name].harvestedProd += parseFloat(h.actual_production)||0;
    });

    // Crop invoices
    invoices.forEach(inv => {
      const c = contracts.find(c => c.id === inv.forward_contract_id);
      if (!c) return;
      const name = idToName[c.commodity_id] || c.commodity || 'Other';
      if (!comMap[name]) return;
      let qty = 0, rev = 0, qa = 0;
      if (inv.batches) {
        const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
        b.forEach(bt => {
          const sl = (bt.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa');
          const ql = (bt.lines||[]).filter(l=>l.line_type==='qa');
          if (sl.length) { qty+=parseFloat(bt.qty)||0; rev+=sl.reduce((s,l)=>s+(parseFloat(l.amount)||0),0); }
          qa += ql.reduce((s,l)=>s+(parseFloat(l.amount)||0),0);
        });
      } else {
        qty = parseFloat(inv.total_qty)||0;
        rev = parseFloat(inv.gross_amount)||0;
        qa  = parseFloat(inv.total_quality_adj)||0;
      }
      comMap[name].invoicedQty += qty;
      comMap[name].invoicedRev += rev;
      comMap[name].invoicedQA  += qa;
    });

    // Livestock invoices — add as a pseudo-commodity if any exist
    if (lsInvoices.length) {
      const lsName = 'Livestock';
      if (!comMap[lsName]) comMap[lsName] = {
        name: lsName, commodity_id: null,
        budProd: 0, budPrice: 0, unit: 'head',
        contracts: [], invoicedQty: 0, invoicedRev: 0, invoicedQA: 0,
        harvestedProd: 0, isLivestock: true,
      };
      lsInvoices.forEach(inv => {
        comMap[lsName].invoicedQty += parseFloat(inv.total_qty)||0;
        comMap[lsName].invoicedRev += parseFloat(inv.gross_amount)||0;
        comMap[lsName].invoicedQA  += parseFloat(inv.total_quality_adj)||0;
      });
    }

    const comCards = Object.values(comMap).map(com => {
      const contractedQty = com.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0),0);
      const contractedVal = com.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0),0);
      const avgContractPrice = contractedQty ? contractedVal/contractedQty : null;

      const harvestPct   = com.budProd ? Math.min(100,(com.harvestedProd/com.budProd)*100) : 0;
      // Production hierarchy: harvest complete → harvest actual; else forecast if exists; else budget
      const hasForecast = com.fcstProd > 0;
      const forecastTotal = com.isHarvestComplete ? com.harvestedProd
                          : com.harvestedProd > 0 ? (hasForecast ? com.fcstProd : com.budProd)
                          : (hasForecast ? com.fcstProd : com.budProd);
      const stage = com.isHarvestComplete ? 'Harvested'
                  : com.harvestedProd > 0 && harvestPct >= 99 ? 'Harvested'
                  : com.harvestedProd > 0 ? 'In harvest'
                  : hasForecast ? 'Re-forecast'
                  : 'Budget';

      const soldPct = forecastTotal ? Math.min(999,(contractedQty/forecastTotal)*100) : null;
      const soldColor = soldPct == null ? 'var(--ink)'
        : soldPct >= 100 ? '#16a34a'
        : (harvestPct > 80 && soldPct < 60) ? '#dc2626'
        : (harvestPct > 50 && soldPct < 40) ? '#d97706'
        : 'var(--ink)';

      const priceVar    = avgContractPrice && com.budPrice ? avgContractPrice - com.budPrice : null;
      const priceVarPct = priceVar && com.budPrice ? (priceVar/com.budPrice)*100 : null;
      const priceVarColor = priceVar == null ? 'var(--hint)' : priceVar >= 0 ? '#16a34a' : '#dc2626';

      const qaPerUnit       = com.invoicedQty ? com.invoicedQA/com.invoicedQty : null;
      const invoicedAvgPrice = com.invoicedQty ? com.invoicedRev/com.invoicedQty : null;
      const invoicedTotal   = com.invoicedRev + com.invoicedQA;

      const stageColor = stage === 'Complete' ? '#16a34a' : stage === 'In harvest' ? '#d97706' : 'var(--hint)';

      return [
        '<div class="card" style="padding:10px 12px;margin-bottom:6px;cursor:pointer"',
        ' data-pos-commodity="' + com.name + '"',
        ' data-pos-comid="' + (com.commodity_id||'') + '">',

        // Row 1: name + key metrics + expand
        '<div style="display:flex;align-items:center;justify-content:space-between">',

        // Left: name + stage + production (big)
        '<div style="min-width:140px">',
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px">',
        '<span style="font-size:12px;font-weight:700;color:var(--ink)">' + com.name + '</span>',
        '<span style="font-size:9px;color:' + stageColor + ';font-weight:600">' + stage + '</span>',
        '</div>',
        forecastTotal ? '<div style="font-size:20px;font-weight:700;color:var(--ink);line-height:1">' + fN(forecastTotal) + ' <span style="font-size:11px;font-weight:400;color:var(--hint)">' + com.unit + '</span></div>' : '',
        '</div>',

        // Middle: key metrics
        '<div style="display:flex;align-items:center;gap:16px;flex:1;justify-content:center">',

        !com.isLivestock && soldPct != null ? [
          '<div style="text-align:center">',
          '<div style="font-size:16px;font-weight:700;color:' + soldColor + '">' + Math.round(soldPct) + '%</div>',
          '<div style="font-size:9px;color:var(--hint)">fwd. sold</div>',
          '</div>',
        ].join('') : '',

        !com.isLivestock && avgContractPrice ? [
          '<div style="text-align:center">',
          '<div style="font-size:16px;font-weight:700;color:var(--ink)">' + fC(avgContractPrice) + '</div>',
          '<div style="font-size:9px;color:var(--hint)">avg contract</div>',
          '</div>',
        ].join('') : '',

        !com.isLivestock && priceVar != null ? [
          '<div style="text-align:center">',
          '<div style="font-size:16px;font-weight:700;color:' + priceVarColor + '">' + (priceVar>=0?'▲':'▼') + fC(Math.abs(priceVar)) + '</div>',
          '<div style="font-size:9px;color:var(--hint)">vs budget</div>',
          '</div>',
        ].join('') : '',

        invoicedTotal ? [
          '<div style="text-align:center">',
          '<div style="font-size:16px;font-weight:700;color:#16a34a">' + fM(invoicedTotal) + '</div>',
          '<div style="font-size:9px;color:var(--hint)">invoiced</div>',
          '</div>',
        ].join('') : '',

        // Unsold — key figure for managers
        !com.isLivestock && forecastTotal ? [
          '<div style="text-align:center">',
          '<div style="font-size:16px;font-weight:700;color:' + (forecastTotal - contractedQty > 0 ? '#d97706' : '#16a34a') + '">' + fN(Math.max(0, forecastTotal - contractedQty)) + ' ' + com.unit + '</div>',
          '<div style="font-size:9px;color:var(--hint)">unsold</div>',
          '</div>',
        ].join('') : '',

        '</div>',

        // Right: expand
        '<div style="font-size:14px;color:var(--hint);padding-left:8px" title="View detail">⤢</div>',
        '</div>',

        // Row 2: secondary figures in muted smaller text
        '<div style="display:flex;align-items:center;gap:16px;margin-top:6px;padding-top:6px;border-top:0.5px solid var(--border-light);flex-wrap:wrap">',
        !com.isLivestock && com.budPrice ? '<span style="font-size:10px;color:var(--hint)">Budget ' + fC(com.budPrice) + '/' + com.unit + '</span>' : '',
        !com.isLivestock && hasForecast && com.fcstProd !== com.budProd ? '<span style="font-size:10px;color:var(--hint)">Forecast ' + fN(com.fcstProd) + ' ' + com.unit + '</span>' : '',
        com.harvestedProd > 0 && !com.isHarvestComplete ? '<span style="font-size:10px;color:var(--hint)">Harvested ' + fN(com.harvestedProd) + ' ' + com.unit + ' (' + Math.round(harvestPct) + '%)</span>' : '',
        !com.isLivestock && contractedQty ? '<span style="font-size:10px;color:var(--hint)">Contracted ' + fN(contractedQty) + ' ' + com.unit + '</span>' : '',
        com.invoicedQty ? '<span style="font-size:10px;color:var(--hint)">' + fN(com.invoicedQty) + ' ' + com.unit + ' paid' + (qaPerUnit ? ' · QA ' + (qaPerUnit>=0?'+':'') + fC(qaPerUnit) + '/' + com.unit : '') + '</span>' : '',
        com.isLivestock && com.invoicedQty ? '<span style="font-size:10px;color:var(--hint)">' + fN(com.invoicedQty) + ' head · ' + (com.invoicedQty ? fC(invoicedTotal/com.invoicedQty) + '/head' : '') + '</span>' : '',
        '</div>',

        '</div>',
      ].join('');
    }).join('');
    container.innerHTML = [
      '<div style="display:grid;grid-template-columns:440px 440px 1fr;gap:16px;align-items:start">',

      // LEFT — Farm gate prices
      '<div>',
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">',
      '<h2 style="font-size:14px;font-weight:600;color:var(--ink)">Farm gate prices</h2>',
      '<span style="font-size:11px;color:var(--hint)">' + farm.name + '</span>',
      '</div>',
      (farmSites.length || lsIndicatorNames.length)
        ? (priceCards + lsCards)
        : '<div class="card" style="padding:16px;color:var(--hint)">No prices configured — set up in Farm Settings.</div>',
      '</div>',

      // RIGHT — Commodity position
      '<div>',
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">',
      '<h2 style="font-size:14px;font-weight:600;color:var(--ink)">Commodity position</h2>',
      '<span style="font-size:11px;color:var(--hint)">' + season + '</span>',
      '</div>',
      Object.keys(comMap).length
        ? comCards
        : '<div class="card" style="padding:16px;color:var(--hint)">No budgets or contracts for this season.</div>',
      '</div>',

      // WEATHER column
      '<div>',
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">',
      '<h2 style="font-size:14px;font-weight:600;color:var(--ink)">Seasonal weather</h2>',
      '<span style="font-size:10px;color:var(--hint)" id="wx-station-label"></span>',
      '</div>',
      farm.settings?.weather?.bomStationName
        ? '<p style="font-size:10px;color:var(--hint);margin:0 0 10px">Season-to-date vs 30-year average</p>'
        : '',
      '<div id="wx-panel">',
      farm.settings?.weather?.bomStationId
        ? '<div style="font-size:11px;color:var(--hint);padding:12px 0">Loading weather data…</div>'
        : '<div class="card" style="padding:16px;color:var(--hint)">No weather station configured. Add one in Farm Settings.</div>',
      '</div>',
      '</div>',

      '</div>',
    ].join('');

    // Load weather panel if station configured
    if (farm.settings?.weather?.bomStationId) {
      _loadWeatherPanel(farm, season).catch(e => {
        const panel = document.getElementById('wx-panel');
        if (panel) panel.innerHTML = '<div style="font-size:11px;color:var(--hint)">Weather data unavailable</div>';
      });
    }

    // Wire expand on commodity position cards
    container.querySelectorAll('[data-pos-commodity]').forEach(card => {
      card.addEventListener('click', () => {
        const name = card.dataset.posCommodity;
        const com = Object.values(comMap).find(c => c.name === name);
        if (com) _openPositionModal(com, season, fN, fC, fM, fPct);
      });
    });

    // Wire expand buttons on grain/cotton price cards
    container.querySelectorAll('[data-expand-crop]').forEach(card => {
      card.addEventListener('click', () => {
        const { expandCrop: crop, expandRegion: region, expandGrade: grade, expandComid: comId, expandLivestock } = card.dataset;
        if (region && comId) _openPriceChart(farm, crop, region, grade, comId, season, !!expandLivestock);
      });
    });

  } catch(err) {
    console.error('Manager view error:', err);
    container.innerHTML = '<div class="empty-state"><p>Error: ' + err.message + '</p></div>';
  }
}









// ── Invoices tab ──────────────────────────────────────────────
async function _mountInvoices(container) {
  container.innerHTML = `
    <div class="flex gap-2" style="margin-bottom:16px">
      <select id="out-season-filter" class="form-select" style="width:120px">
        <option value="">All seasons</option>
      </select>
      <select id="out-commodity-filter" class="form-select" style="width:130px">
        <option value="">All commodities</option>
        <option value="cotton">Cotton</option>
        <option value="grain">Grain</option>
        <option value="pulse">Pulse</option>
        <option value="livestock">Livestock</option>
        <option value="other">Other</option>
      </select>
      ${canWrite() ? '<button class="btn btn-primary" id="btn-new-invoice">＋ New invoice</button>' : ''}
    </div>

    <div class="stats-strip" id="out-stats"></div>

    <div class="card">
      <div class="card-header">
        <h2>Invoices</h2>
        <span id="out-count" class="text-muted text-sm"></span>
      </div>
      <div id="out-table-wrap">
        <div class="empty-state"><span class="loading-spinner"></span></div>
      </div>
    </div>
  `;

  await _loadData();
  _renderStats();
  _renderTable();
  _bindFilters(container);
  _subscribeRealtime();

  if (canWrite()) {
    qs('#btn-new-invoice', container)?.addEventListener('click', () => openInvoiceForm(container));
  }
}

async function _loadData() {
  const farm = getActiveFarm();
  if (!farm) { _invoices = []; _contracts = []; return; }

  [_invoices, _contracts] = await Promise.all([
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.desc'),
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&select=*'),
  ]);

  _populateSeasonFilter();
}

function _populateSeasonFilter() {
  const sel = qs('#out-season-filter');
  if (!sel) return;
  const seasons = [...new Set(_invoices.map(i => i.season).filter(Boolean))].sort().reverse();
  while (sel.options.length > 1) sel.remove(1);
  seasons.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    sel.appendChild(opt);
  });
}

function _filtered() {
  const season = qs('#out-season-filter')?.value || '';
  const commodity = qs('#out-commodity-filter')?.value || '';
  return _invoices.filter(inv =>
    (!season || inv.season === season) &&
    (!commodity || inv.commodity_type === commodity)
  );
}

function _subscribeRealtime() {
  const farm = getActiveFarm();
  if (!farm) return;
  _unsub = subscribeTable('invoices', farm.id, async (event, payload) => {
    if (event === 'INSERT') {
      if (!_invoices.find(i => i.id === payload.record.id)) _invoices.unshift(payload.record);
    } else if (event === 'UPDATE') {
      const idx = _invoices.findIndex(i => i.id === payload.record.id);
      if (idx >= 0) _invoices[idx] = payload.record;
    } else if (event === 'DELETE') {
      _invoices = _invoices.filter(i => i.id !== payload.old_record.id);
    }
    _renderStats();
    _renderTable();
  });
}

function _renderStats() {
  const filtered = _filtered();
  const total = filtered.reduce((s, i) => s + (parseFloat(i.net_amount || i.gross_amount) || 0), 0);
  const paid  = filtered.filter(i => i.status === 'paid').reduce((s, i) => s + (parseFloat(i.net_amount || i.gross_amount) || 0), 0);
  const draft = filtered.filter(i => i.status === 'draft').length;
  const issued = filtered.filter(i => i.status === 'issued').length;

  setContent('#out-stats', `
    <div class="stat-card"><div class="stat-label">Total invoiced</div><div class="stat-value blue">${formatCurrency(total, 0)}</div></div>
    <div class="stat-card"><div class="stat-label">Paid</div><div class="stat-value green">${formatCurrency(paid, 0)}</div></div>
    <div class="stat-card"><div class="stat-label">Outstanding</div><div class="stat-value">${formatCurrency(total - paid, 0)}</div></div>
    <div class="stat-card"><div class="stat-label">Draft / Issued</div><div class="stat-value">${draft} / ${issued}</div></div>
  `);
}

function _renderTable() {
  const rows = _filtered();
  const wrap = qs('#out-table-wrap');
  if (!wrap) return;

  setContent('#out-count', rows.length + ' invoice' + (rows.length !== 1 ? 's' : ''));

  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div><p>No invoices yet.</p></div>';
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Invoice #</th><th>Date</th><th>Season</th><th>Commodity</th>
          <th>Buyer</th><th class="num">Qty</th><th class="num">Price</th>
          <th class="num">Net amount</th><th>Status</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(inv => `
          <tr data-id="${inv.id}" style="cursor:pointer">
            <td><strong>${inv.invoice_number}</strong></td>
            <td class="muted">${formatDate(inv.invoice_date)}</td>
            <td class="muted">${inv.season || '—'}</td>
            <td>${commodityBadge(inv.commodity_type)}${inv.commodity_detail ? '<span class="text-xs text-muted" style="margin-left:4px">' + inv.commodity_detail + '</span>' : ''}</td>
            <td>${inv.buyer}</td>
            <td class="num">${inv.quantity} ${inv.unit}</td>
            <td class="num">${formatCurrency(inv.price_per_unit, 4)}</td>
            <td class="num"><strong>${formatCurrency(inv.net_amount ?? inv.gross_amount)}</strong></td>
            <td>${statusBadge(inv.status)}</td>
            ${canWrite() ? '<td><button class="btn btn-ghost btn-sm edit-btn" data-id="' + inv.id + '">Edit</button></td>' : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('tbody tr').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('edit-btn')) return;
      const inv = _invoices.find(i => i.id === row.dataset.id);
      if (inv) _openInvoiceDetail(inv);
    });
  });

  wrap.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const inv = _invoices.find(i => i.id === btn.dataset.id);
      if (inv) openInvoiceForm(container, inv);
    });
  });
}

function _bindFilters(container) {
  ['#out-season-filter', '#out-commodity-filter'].forEach(sel => {
    qs(sel, container)?.addEventListener('change', () => { _renderStats(); _renderTable(); });
  });
}

// ── Invoice Modal ─────────────────────────────────────────────
export function openInvoiceModal(existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;

  const contractOptions = _contracts.map(c =>
    '<option value="' + c.id + '" data-price="' + c.price_per_unit + '" ' + (existing?.forward_contract_id === c.id ? 'selected' : '') + '>' +
    (c.contract_number || 'Contract') + ' — ' + (c.commodity || '') + ' @ ' + formatCurrency(c.price_per_unit, 4) + '/' + (c.unit || '') +
    '</option>'
  ).join('');

  const { overlay } = openModal({
    title: isEdit ? 'Edit Invoice ' + existing.invoice_number : 'New Invoice',
    confirmLabel: isEdit ? 'Save changes' : 'Create invoice',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Commodity type</label>
          <select class="form-select" id="f-commodity-type">
            <option value="">Select…</option>
            <option value="cotton" ${existing?.commodity_type === 'cotton' ? 'selected' : ''}>Cotton</option>
            <option value="grain" ${existing?.commodity_type === 'grain' ? 'selected' : ''}>Grain</option>
            <option value="pulse" ${existing?.commodity_type === 'pulse' ? 'selected' : ''}>Pulse</option>
            <option value="livestock" ${existing?.commodity_type === 'livestock' ? 'selected' : ''}>Livestock</option>
            <option value="other" ${existing?.commodity_type === 'other' ? 'selected' : ''}>Other</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Variety / Grade / Breed</label>
          <input class="form-input" id="f-commodity-detail" type="text" value="${existing?.commodity_detail || ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Invoice number</label>
          <input class="form-input" id="f-invoice-number" type="text" value="${existing?.invoice_number || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Invoice date</label>
          <input class="form-input" id="f-invoice-date" type="date" value="${existing?.invoice_date || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Season</label>
          <input class="form-input" id="f-season" type="text" value="${existing?.season || getActiveSeason() || currentSeason()}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Buyer</label>
          <input class="form-input" id="f-buyer" type="text" value="${existing?.buyer || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Buyer ABN</label>
          <input class="form-input" id="f-buyer-abn" type="text" value="${existing?.buyer_abn || ''}">
        </div>
      </div>
      <div id="contract-section" ${existing?.commodity_type === 'livestock' ? 'class="hidden"' : ''}>
        <div class="form-group">
          <label class="form-label">Forward contract (optional)</label>
          <select class="form-select" id="f-contract">
            <option value="">Cash sale — no contract</option>
            ${contractOptions}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Quantity</label>
          <input class="form-input num" id="f-quantity" type="number" step="0.001" value="${existing?.quantity || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="f-unit">
            <option value="tonne" ${(existing?.unit || 'tonne') === 'tonne' ? 'selected' : ''}>tonne</option>
            <option value="kg" ${existing?.unit === 'kg' ? 'selected' : ''}>kg</option>
            <option value="bale" ${existing?.unit === 'bale' ? 'selected' : ''}>bale</option>
            <option value="head" ${existing?.unit === 'head' ? 'selected' : ''}>head</option>
            <option value="each" ${existing?.unit === 'each' ? 'selected' : ''}>each</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Price per unit</label>
          <input class="form-input num" id="f-price" type="number" step="0.0001" value="${existing?.price_per_unit || ''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Gross amount</label>
        <div id="f-gross-display" class="font-mono" style="font-size:var(--text-xl);color:var(--blue);padding:4px 0">—</div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Sale type</label>
          <select class="form-select" id="f-sale-type">
            <option value="cash" ${(existing?.sale_type || 'cash') === 'cash' ? 'selected' : ''}>Cash sale</option>
            <option value="contract" ${existing?.sale_type === 'contract' ? 'selected' : ''}>Contract</option>
            <option value="pool" ${existing?.sale_type === 'pool' ? 'selected' : ''}>Pool</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="f-status">
            <option value="draft" ${(existing?.status || 'draft') === 'draft' ? 'selected' : ''}>Draft</option>
            <option value="issued" ${existing?.status === 'issued' ? 'selected' : ''}>Issued</option>
            <option value="paid" ${existing?.status === 'paid' ? 'selected' : ''}>Paid</option>
            <option value="void" ${existing?.status === 'void' ? 'selected' : ''}>Void</option>
          </select>
        </div>
      </div>
    `,
    onConfirm: async (modal) => {
      const val = (id) => qs('#' + id, modal)?.value?.trim() || '';
      const num = (id) => parseFloat(qs('#' + id, modal)?.value || 0);
      const quantity = num('f-quantity');
      const pricePerUnit = num('f-price');
      const contractId = val('f-contract') || null;
      const contract = contractId ? _contracts.find(c => c.id === contractId) : null;
      const gross = quantity * pricePerUnit;
      const deductions = existing?.deductions || [];
      const totalDeductions = deductions.reduce((s, d) => s + (d.amount || 0), 0);

      const row = {
        farm_id: farm.id,
        invoice_number: val('f-invoice-number'),
        invoice_date: val('f-invoice-date'),
        season: val('f-season') || getActiveSeason() || currentSeason(),
        commodity_type: val('f-commodity-type'),
        commodity_detail: val('f-commodity-detail') || null,
        buyer: val('f-buyer'),
        buyer_abn: val('f-buyer-abn') || null,
        forward_contract_id: contractId,
        contract_price: contract?.price_per_unit || null,
        price_per_unit: pricePerUnit,
        unit: val('f-unit'),
        quantity,
        net_amount: gross - totalDeductions,
        deductions,
        sale_type: val('f-sale-type'),
        status: val('f-status'),
        created_by: getSession()?.user?.id,
      };

      if (isEdit) {
        await dbUpdate('invoices', existing.id, row);
        toast('Invoice updated', 'success');
      } else {
        await dbInsert('invoices', row);
        toast('Invoice created', 'success');
      }
      await _loadData(); _renderStats(); _renderTable();
    },
  });

  const qty = qs('#f-quantity', overlay);
  const price = qs('#f-price', overlay);
  const gross = qs('#f-gross-display', overlay);
  const updateGross = () => {
    const g = parseFloat(qty?.value || 0) * parseFloat(price?.value || 0);
    gross.textContent = isNaN(g) || g === 0 ? '—' : formatCurrency(g);
  };
  qty?.addEventListener('input', updateGross);
  price?.addEventListener('input', updateGross);
  updateGross();

  qs('#f-contract', overlay)?.addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    if (opt.dataset.price) { price.value = opt.dataset.price; updateGross(); }
  });

  qs('#f-commodity-type', overlay)?.addEventListener('change', (e) => {
    const isLivestock = e.target.value === 'livestock';
    qs('#contract-section', overlay)?.classList.toggle('hidden', isLivestock);
  });
}

function _openInvoiceDetail(inv) {
  const contract = inv.forward_contract_id ? _contracts.find(c => c.id === inv.forward_contract_id) : null;
  openModal({
    title: 'Invoice ' + inv.invoice_number,
    confirmLabel: canWrite() ? 'Edit' : null,
    onConfirm: canWrite() ? async () => openInvoiceForm(container, inv) : null,
    confirmClass: 'btn-secondary',
    bodyHTML: `
      <div class="form-row">
        <div><p class="text-xs text-muted">Status</p><p>${statusBadge(inv.status)}</p></div>
        <div><p class="text-xs text-muted">Date</p><p>${formatDate(inv.invoice_date)}</p></div>
        <div><p class="text-xs text-muted">Season</p><p>${inv.season || '—'}</p></div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div><p class="text-xs text-muted">Commodity</p><p>${commodityBadge(inv.commodity_type)} ${inv.commodity_detail || ''}</p></div>
        <div><p class="text-xs text-muted">Buyer</p><p><strong>${inv.buyer}</strong></p></div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div><p class="text-xs text-muted">Quantity</p><p class="font-mono">${inv.quantity} ${inv.unit}</p></div>
        <div><p class="text-xs text-muted">Price / ${inv.unit}</p><p class="font-mono">${formatCurrency(inv.price_per_unit, 4)}</p></div>
        <div><p class="text-xs text-muted">Net amount</p><p class="font-mono" style="font-size:var(--text-xl);color:var(--blue)"><strong>${formatCurrency(inv.net_amount ?? inv.gross_amount)}</strong></p></div>
      </div>
      ${contract ? '<hr class="divider"><div class="mt-2"><p class="text-xs text-muted">Forward contract</p><p>' + (contract.contract_number || 'Contract') + ' — ' + formatCurrency(contract.price_per_unit, 4) + '/' + contract.unit + '</p></div>' : ''}
    `,
  });
}
// ── Investor view ─────────────────────────────────────────────
async function _mountInvestorView(container) {
  const farm = getActiveFarm();
  if (!farm) { container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>'; return; }

  const season = getActiveSeason() || currentSeason();
  container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';

  try {
    await loadCommodities();
    const commodityList = getCommodities();
    const idToName = {};
    commodityList.forEach(c => { idToName[c.id] = c.name; });

    const [contracts, invoices, budgets, forecasts, harvests, lsInvoices, stockItems, stockMoves] = await Promise.all([
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&master_unit=neq.head&select=id,gross_amount,total_quality_adj,total_qty,forward_contract_id,batches,season,status,buyer'),
      dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('forecasts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*&order=forecast_date.desc'),
      dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&master_unit=eq.head&season=eq.' + season + '&select=total_qty,gross_amount,livestock_lines'),
      dbSelect('stock_items', 'farm_id=eq.' + farm.id + '&category=eq.livestock&active=eq.true&select=id,name,attributes'),
      dbSelect('stock_movements', 'farm_id=eq.' + farm.id + '&select=item_id,signed_qty'),
    ]);

    const fM = (n) => n == null ? '—' : n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'k' : '$' + Math.round(n).toLocaleString();
    const fN = (n, dp=0) => n == null ? '—' : formatNumber(n, dp);
    const fC = (n) => n == null ? '—' : formatCurrency(n, 2);
    const pctBar = (pct, color) => `<div style="height:4px;background:var(--border-light);border-radius:2px;overflow:hidden;margin-top:4px"><div style="height:100%;width:${Math.min(100,pct)}%;background:${color};border-radius:2px"></div></div>`;
    const badge = (text, type) => {
      const styles = {
        green: 'background:#eaf3de;color:#3b6d11', amber: 'background:#faeeda;color:#854f0b',
        blue: 'background:#e6f1fb;color:#185fa5', red: 'background:#fcebeb;color:#a32d2d',
      };
      return `<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;${styles[type]||styles.blue}">${text}</span>`;
    };

    // ── Aggregate metrics ─────────────────────────────────────
    const totalBudgetRev = budgets.reduce((s,b) => s + (parseFloat(b.budgeted_gross_revenue)||(parseFloat(b.budgeted_production||0)*parseFloat(b.price||0))), 0);
    const totalContractedValue = contracts.reduce((s,c) => s + (parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0), 0);

    let invoicedRev = 0;
    invoices.forEach(inv => {
      if (inv.batches) {
        const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
        b.forEach(bt => { const sl=(bt.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa'); invoicedRev+=sl.reduce((s,l)=>s+(parseFloat(l.amount)||0),0); });
      } else { invoicedRev += (parseFloat(inv.gross_amount)||0)+(parseFloat(inv.total_quality_adj)||0); }
    });

    const openExposure = Math.max(0, totalBudgetRev - totalContractedValue);
    const pctContracted = totalBudgetRev ? Math.round(totalContractedValue/totalBudgetRev*100) : 0;
    const pctInvoiced = totalContractedValue ? Math.round(invoicedRev/totalContractedValue*100) : 0;

    // ── Enterprise coverage rows ──────────────────────────────
    const byCom = {};
    contracts.forEach(c => {
      const name = idToName[c.commodity_id] || c.commodity || 'Other';
      if (!byCom[name]) byCom[name] = { contracts:[], invoicedRev:0, budgetProd:0, budgetPrice:0 };
      byCom[name].contracts.push(c);
    });
    budgets.forEach(b => {
      const name = idToName[b.commodity_id] || b.commodity || 'Other';
      if (!byCom[name]) byCom[name] = { contracts:[], invoicedRev:0, budgetProd:0, budgetPrice:0 };
      byCom[name].budgetProd += parseFloat(b.budgeted_production)||0;
      byCom[name].budgetPrice = parseFloat(b.price)||byCom[name].budgetPrice;
    });
    invoices.forEach(inv => {
      const c = contracts.find(c=>c.id===inv.forward_contract_id);
      if (!c) return;
      const name = idToName[c.commodity_id] || c.commodity || 'Other';
      if (byCom[name]) byCom[name].invoicedRev += (parseFloat(inv.gross_amount)||0)+(parseFloat(inv.total_quality_adj)||0);
    });

    const enterpriseRows = Object.entries(byCom).map(([name, d]) => {
      const contractedQty = d.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0),0);
      const contractedVal = d.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0),0);
      const avgPrice = contractedQty ? contractedVal/contractedQty : null;
      const unit = d.contracts[0]?.unit || 't';
      const complete = d.contracts.length && d.contracts.every(c=>c.is_complete);
      const pct = d.budgetProd ? Math.round(contractedQty/d.budgetProd*100) : null;
      const coverageBadge = complete ? badge('Complete', 'green') : pct >= 100 ? badge('Fully covered', 'green') : pct >= 50 ? badge('Partial', 'amber') : badge('Open', 'red');
      return `
      <div style="display:grid;grid-template-columns:130px 1fr 90px 90px 90px;gap:0;padding:10px 18px;border-bottom:0.5px solid var(--border-light);align-items:center;font-size:12px">
        <div style="font-weight:600;color:var(--ink)">${name}</div>
        <div>
          ${pct != null ? `<div style="font-size:11px;color:var(--hint);margin-bottom:3px">${contractedQty.toLocaleString()} ${unit} contracted${d.budgetProd ? ' of ' + d.budgetProd.toLocaleString() + ' budgeted' : ''}</div>` : ''}
          <div style="height:5px;background:var(--border-light);border-radius:2px;overflow:hidden;max-width:200px">
            <div style="height:100%;width:${Math.min(100,pct||0)}%;background:${(pct||0)>=100?'var(--green)':'var(--blue)'};border-radius:2px"></div>
          </div>
          ${pct != null ? `<div style="font-size:10px;color:var(--hint);margin-top:2px">${pct}% contracted</div>` : ''}
        </div>
        <div style="text-align:right;font-weight:600;color:var(--blue)">${fM(contractedVal)}</div>
        <div style="text-align:right;color:var(--hint)">${avgPrice ? fC(avgPrice) + '/' + unit : '—'}</div>
        <div style="text-align:right">${coverageBadge}</div>
      </div>`;
    }).join('');

    // ── Yield vs budget ───────────────────────────────────────
    const budgetHa = budgets.reduce((s,b)=>s+(parseFloat(b.area_ha)||0),0);
    const hvstHa = harvests.reduce((s,h)=>s+(parseFloat(h.area_ha)||0),0);
    const hvstProd = harvests.reduce((s,h)=>s+(parseFloat(h.actual_production)||0),0);
    const hvstYield = hvstHa ? hvstProd/hvstHa : null;
    // Latest forecast per commodity
    const fcstMap = {};
    forecasts.forEach(f => { const k = f.budget_id||f.commodity_id||'x'; if (!fcstMap[k]||f.forecast_date>fcstMap[k].forecast_date) fcstMap[k]=f; });
    const fcstProd = Object.values(fcstMap).reduce((s,f)=>s+(parseFloat(f.forecast_production)||(parseFloat(f.area_ha||0)*parseFloat(f.yield_per_ha||0))),0);
    const budgetProd = budgets.reduce((s,b)=>s+(parseFloat(b.budgeted_production)||(parseFloat(b.area_ha||0)*parseFloat(b.budgeted_yield_per_ha||b.yield_per_ha||0))),0);

    // ── Livestock ─────────────────────────────────────────────
    const lsHead = lsInvoices.reduce((s,i)=>s+(parseFloat(i.total_qty)||0),0);
    const lsGross = lsInvoices.reduce((s,i)=>s+(parseFloat(i.gross_amount)||0),0);

    // ── Livestock ─────────────────────────────────────────────
    const invStockBalances = {};
    stockItems.forEach(i => { invStockBalances[i.id] = 0; });
    stockMoves.forEach(m => { if (invStockBalances[m.item_id] !== undefined) invStockBalances[m.item_id] += parseFloat(m.signed_qty)||0; });
    const invTotalHead = Object.values(invStockBalances).reduce((s,v)=>s+v,0);
    const invClassSummary = {};
    stockItems.forEach(i => {
      const cls = i.attributes?.class || 'other';
      if (!invClassSummary[cls]) invClassSummary[cls] = 0;
      invClassSummary[cls] += invStockBalances[i.id] || 0;
    });

    // ── Downside / risk ───────────────────────────────────────
    const uncontractedVal = openExposure;
    const contractComplete = contracts.filter(c=>c.is_complete).length;

    const html = `
    <div style="padding:16px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;padding:0 18px">
        <div>
          <h2 style="font-size:16px;font-weight:600;color:var(--ink)">${farm.name || 'Portfolio'} — ${season}</h2>
          <p style="font-size:12px;color:var(--hint);margin-top:2px">Asset and operational performance · Read only</p>
        </div>
        <div style="font-size:11px;color:var(--hint)">As at ${new Date().toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'})}</div>
      </div>

      <!-- Headline metrics -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);border-top:0.5px solid var(--border);border-bottom:0.5px solid var(--border);margin-bottom:16px">
        <div style="padding:14px 18px;border-right:0.5px solid var(--border)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Budgeted revenue</div>
          <div style="font-size:24px;font-weight:600;color:var(--ink)">${fM(totalBudgetRev)}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${season} full season</div>
        </div>
        <div style="padding:14px 18px;border-right:0.5px solid var(--border)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Contracted value</div>
          <div style="font-size:24px;font-weight:600;color:var(--blue)">${fM(totalContractedValue)}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${pctContracted}% of budget</div>
          ${pctBar(pctContracted, 'var(--blue)')}
        </div>
        <div style="padding:14px 18px;border-right:0.5px solid var(--border)">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Invoiced to date</div>
          <div style="font-size:24px;font-weight:600;color:var(--green)">${fM(invoicedRev)}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${pctInvoiced}% of contracted</div>
          ${pctBar(pctInvoiced, 'var(--green)')}
        </div>
        <div style="padding:14px 18px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Open exposure</div>
          <div style="font-size:24px;font-weight:600;color:${uncontractedVal > 0 ? 'var(--amber)' : 'var(--green)'}">${fM(uncontractedVal)}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">Uncontracted at market risk</div>
        </div>
      </div>

      <!-- Contract coverage -->
      <div style="margin-bottom:16px">
        <div style="padding:8px 18px;background:var(--page-bg);border-top:0.5px solid var(--border);border-bottom:0.5px solid var(--border)">
          <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Contract coverage by enterprise</span>
        </div>
        <div style="display:grid;grid-template-columns:130px 1fr 90px 90px 90px;gap:0;padding:6px 18px;background:var(--page-bg);border-bottom:0.5px solid var(--border)">
          ${['Enterprise','Coverage','Contracted value','Avg price','Status'].map((h,i)=>`<div style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);${i>1?'text-align:right':''}">${h}</div>`).join('')}
        </div>
        ${enterpriseRows || '<div style="padding:14px 18px;font-size:12px;color:var(--hint)">No contracts entered for this season.</div>'}
        ${invTotalHead > 0 || lsHead > 0 ? `
        <div style="display:grid;grid-template-columns:130px 1fr 90px 90px 90px;gap:0;padding:10px 18px;border-bottom:0.5px solid var(--border-light);align-items:center;font-size:12px">
          <div style="font-weight:600;color:var(--ink)">Livestock</div>
          <div>
            <div style="font-size:11px;color:var(--hint)">${fN(invTotalHead)} on hand · ${lsHead ? Math.round(lsHead) + ' sold YTD' : 'no sales'}</div>
            <div style="font-size:10px;color:var(--hint);margin-top:2px">${Object.entries(invClassSummary).filter(([,v])=>v>0).map(([k,v])=>v+' '+k+'s').join(' · ')}</div>
          </div>
          <div style="text-align:right;font-weight:600;color:var(--green)">${lsGross ? fM(lsGross) : '—'}</div>
          <div style="text-align:right;color:var(--hint)">${lsHead ? fC(lsGross/lsHead) + '/hd avg' : '—'}</div>
          <div style="text-align:right">${lsGross ? badge('Realised', 'green') : badge('No sales', 'blue')}</div>
        </div>` : ''}
      </div>

      <!-- Production and risk -->
      <div style="display:grid;grid-template-columns:1fr 1fr;border-top:0.5px solid var(--border)">
        <div style="padding:14px 18px;border-right:0.5px solid var(--border)">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:10px">Production vs budget</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--hint)">Budget area</span>
              <span style="font-weight:600;color:var(--ink)">${fN(budgetHa)} ha</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--hint)">Budget production</span>
              <span style="font-weight:600;color:var(--ink)">${fN(budgetProd)} t</span>
            </div>
            ${fcstProd ? `<div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--hint)">Latest forecast</span>
              <span style="font-weight:600;color:var(--amber)">${fN(fcstProd)} t</span>
            </div>` : ''}
            ${hvstProd ? `<div style="display:flex;justify-content:space-between;font-size:12px">
              <span style="color:var(--hint)">Actual harvest</span>
              <span style="font-weight:600;color:var(--green)">${fN(hvstProd)} t · ${fN(hvstYield,2)} t/ha</span>
            </div>` : ''}
            ${!fcstProd && !hvstProd ? `<div style="font-size:11px;color:var(--hint)">Season underway — no forecast or harvest yet.</div>` : ''}
          </div>
        </div>
        <div style="padding:14px 18px">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:10px">Risk summary</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
              <span style="color:var(--hint)">Uncontracted production</span>
              <span style="font-weight:600;color:${uncontractedVal>0?'var(--amber)':'var(--green)'}">
                ${uncontractedVal > 0 ? fM(uncontractedVal) + ' at market' : 'Fully covered'}
              </span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
              <span style="color:var(--hint)">Contracts complete</span>
              <span style="font-weight:600;color:var(--ink)">${contractComplete} of ${contracts.length}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
              <span style="color:var(--hint)">Livestock on hand</span>
              <span style="font-weight:600;color:var(--ink)">${invTotalHead ? fN(invTotalHead) + ' head' : 'None recorded'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">
              <span style="color:var(--hint)">Reporting basis</span>
              <span style="color:var(--hint)">Operational · asset level only</span>
            </div>
          </div>
        </div>
      </div>
    </div>`;

    container.innerHTML = html;
  } catch(err) {
    console.error('Investor view error:', err);
    container.innerHTML = '<div class="empty-state"><p>Error loading investor view.</p></div>';
  }
}
// ── Admin livestock pending panel ────────────────────────────
async function _buildAdminLivestockPanel(farm) {
  try {
    const pp = await dbSelect('stock_periods', 'farm_id=eq.' + farm.id + '&status=eq.open&select=period_start,period_end&limit=1');
    if (!pp.length) return '';
    const lsInvs = await dbSelect('invoices',
      'farm_id=eq.' + farm.id + '&master_unit=eq.head&invoice_date=gte.' + pp[0].period_start + '&invoice_date=lte.' + pp[0].period_end + '&select=id,livestock_lines,buyer'
    );
    const allMoves = await dbSelect('stock_movements', 'farm_id=eq.' + farm.id + '&source_system=eq.invoices&select=source_ref');
    const allocatedRefs = new Set(allMoves.map(m => m.source_ref));
    const pending = [];
    lsInvs.forEach(inv => {
      (inv.livestock_lines || []).forEach((line, idx) => {
        if (line.head && !allocatedRefs.has(inv.id + ':' + idx))
          pending.push({ buyer: inv.buyer, head: line.head, desc: line.description });
      });
    });
    if (!pending.length) return '';
    const rows = pending.slice(0, 3).map(p =>
      '<div style="padding:8px 16px;border-bottom:0.5px solid var(--border-light);font-size:12px;color:var(--ink-mid)">' +
      (p.buyer || 'Sale') + ' · ' + (p.desc || '') + ' · <strong>' + p.head + ' hd</strong></div>'
    ).join('');
    const more = pending.length > 3 ? '<div style="padding:8px 16px;font-size:11px;color:var(--hint)">+' + (pending.length - 3) + ' more</div>' : '';
    return '<div class="card" style="margin-bottom:16px;overflow:hidden;border:1.5px solid var(--amber)">' +
      '<div style="padding:10px 16px;border-bottom:0.5px solid var(--border);background:#fffbeb;display:flex;align-items:center;justify-content:space-between">' +
      '<span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#92400e">🐄 ' + pending.length + ' livestock sale' + (pending.length !== 1 ? 's' : '') + ' awaiting mob allocation</span>' +
      '<span style="font-size:11px;color:#92400e">Go to Stocktake → Livestock to allocate</span>' +
      '</div>' + rows + more + '</div>';
  } catch(e) { return ''; }
}

// ── Admin view ────────────────────────────────────────────────
async function _mountAdminView(container) {
  const farm = getActiveFarm();
  if (!farm) { container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>'; return; }
  const season = getActiveSeason() || currentSeason();
  container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';

  try {
    const [invoices, contracts] = await Promise.all([
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=id,buyer,invoice_date,gross_amount,total_quality_adj,status,xero_invoice_number,master_unit,total_qty&order=invoice_date.desc&limit=20'),
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=id,contract_number,commodity&limit=20'),
    ]);

    const fM = (n) => n == null ? '—' : n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'k' : '$' + Math.round(n).toLocaleString();
    const fC = (n) => n == null ? '—' : formatCurrency(n, 0);

    const pendingSync  = invoices.filter(i => !i.xero_invoice_number && i.status !== 'draft');
    const completeSync = invoices.filter(i => i.xero_invoice_number);
    const totalIncome  = invoices.reduce((s,i) => s + (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0), 0);

    const workItems = [
      ...pendingSync.map(i => ({
        level: 'amber',
        icon: '📄',
        title: `Push to Xero — ${i.buyer||'Invoice'} ${fM((parseFloat(i.gross_amount)||0)+(parseFloat(i.total_quality_adj)||0))}`,
        sub: `${i.invoice_date} · ${i.master_unit === 'head' ? (i.total_qty||'') + ' head' : 'RCTI'}`,
        action: 'Push now',
        id: i.id,
      })),
    ];

    const iconStyle = (level) => ({
      amber: 'background:#faeeda', red: 'background:#fcebeb', green: 'background:#eaf3de'
    }[level] || 'background:var(--page-bg)');

    const recentRows = invoices.slice(0, 8).map(i => {
      const income = (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0);
      const synced = !!i.xero_invoice_number;
      return `<div style="display:flex;align-items:center;padding:9px 16px;border-bottom:0.5px solid var(--border-light);font-size:12px;gap:10px">
        <div style="flex:1">
          <span style="font-weight:500;color:var(--ink)">${i.buyer||'—'}</span>
          <span style="color:var(--hint);margin-left:6px">${i.invoice_date||''}</span>
        </div>
        <span style="color:var(--ink);font-weight:500">${fM(income)}</span>
        <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;${synced?'background:#eaf3de;color:#3b6d11':'background:#faeeda;color:#854f0b'}">${synced ? 'Synced' : 'Pending'}</span>
      </div>`;
    }).join('');

    const _adminLivestockHtml = await _buildAdminLivestockPanel(farm);

    container.innerHTML = `
    <div style="margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">
      <h2 style="font-size:var(--text-md);font-weight:600">Admin — ${season}</h2>
      <div style="font-size:11px;color:var(--hint)">${new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long'})}</div>
    </div>

    <!-- Stat tiles -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
      <div class="card" style="padding:14px 16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Pending Xero sync</div>
        <div style="font-size:22px;font-weight:600;color:${pendingSync.length?'var(--amber)':'var(--green)'}">${pendingSync.length}</div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">${pendingSync.length ? 'Invoices ready to push' : 'All synced'}</div>
      </div>
      <div class="card" style="padding:14px 16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Invoices this season</div>
        <div style="font-size:22px;font-weight:600;color:var(--ink)">${invoices.length}</div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">${completeSync.length} synced to Xero</div>
      </div>
      <div class="card" style="padding:14px 16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Total income</div>
        <div style="font-size:22px;font-weight:600;color:var(--ink)">${fM(totalIncome)}</div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">Crop + livestock</div>
      </div>
      <div class="card" style="padding:14px 16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:5px">Xero connection</div>
        <div style="font-size:22px;font-weight:600;color:var(--green)">Live</div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">cfm-prod</div>
      </div>
    </div>

    <!-- Livestock pending allocations -->
    ${_adminLivestockHtml}

        <!-- Work queue -->
    ${workItems.length ? `
    <div class="card" style="margin-bottom:16px;overflow:hidden">
      <div style="padding:10px 16px;border-bottom:0.5px solid var(--border);background:var(--page-bg);display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Work queue — ${workItems.length} item${workItems.length!==1?'s':''}</span>
      </div>
      ${workItems.map(item => `
      <div style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:0.5px solid var(--border-light)">
        <div style="width:32px;height:32px;border-radius:7px;${iconStyle(item.level)};display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0">${item.icon}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:500;color:var(--ink)">${item.title}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${item.sub}</div>
        </div>
        <button class="btn btn-sm btn-secondary xero-push-btn" data-invoice-id="${item.id||''}" style="font-size:11px">${item.action}</button>
      </div>`).join('')}
    </div>` : `
    <div class="card" style="padding:16px;margin-bottom:16px;text-align:center">
      <div style="font-size:24px;margin-bottom:6px">✓</div>
      <div style="font-size:13px;font-weight:500;color:var(--ink)">All invoices synced to Xero</div>
      <div style="font-size:11px;color:var(--hint);margin-top:4px">Nothing in the queue</div>
    </div>`}

    <!-- Recent entries -->
    <div class="card" style="overflow:hidden;margin-bottom:12px">
      <div style="padding:10px 16px;border-bottom:0.5px solid var(--border);background:var(--page-bg)">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Recent entries</span>
      </div>
      ${recentRows || '<div style="padding:14px 16px;font-size:12px;color:var(--hint)">No invoices entered yet.</div>'}
    </div>

    <!-- Reconciliation link -->
    <div class="card" style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:13px;font-weight:500;color:var(--ink)">Xero reconciliation</div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">Match invoices to Xero transactions</div>
      </div>
      <button class="btn btn-secondary btn-sm" id="btn-go-reconciliation">Open →</button>
    </div>`;

    // Wire reconciliation button
    container.querySelector('#btn-go-reconciliation')?.addEventListener('click', () => {
      _activeTab = 'reconciliation';
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _loadTab();
    });

    // Wire Xero push buttons
    container.querySelectorAll('.xero-push-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.invoiceId;
        if (!id) return;
        btn.disabled = true; btn.textContent = 'Pushing…';
        try {
          const session = getSession();
          const res = await fetch('/api/xero-push', {
            method: 'POST', headers: {'Content-Type':'application/json','Authorization':`Bearer ${session?.access_token}`},
            body: JSON.stringify({ invoice_id: id }),
          });
          const data = await res.json();
          if (data.error) throw new Error(data.error);
          toast('Pushed to Xero', 'success');
          await _mountAdminView(container);
        } catch(e) {
          toast('Push failed: ' + e.message, 'error');
          btn.disabled = false; btn.textContent = 'Push now';
        }
      });
    });

  } catch(err) {
    console.error('Admin view error:', err);
    container.innerHTML = '<div class="empty-state"><p>Error loading admin view: ' + err.message + '</p></div>';
  }
}
// ── Price chart modal ─────────────────────────────────────────
async function _openPriceChart(farm, crop, region, resolvedGrade, commodityId, season, isLivestock = false) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#ffffff;border-radius:10px;width:100%;max-width:760px;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">${crop} · ${resolvedGrade || ''}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${region} · ${season}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary chart-range-btn active" data-months="6" style="font-size:11px;padding:4px 10px">6M</button>
            <button class="btn btn-secondary chart-range-btn" data-months="12" style="font-size:11px;padding:4px 10px">12M</button>
          </div>
          <button id="price-chart-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hint);padding:4px 8px">✕</button>
        </div>
      </div>
      <div style="padding:20px">
        <canvas id="price-chart-canvas" style="width:100%;height:300px"></canvas>
        <div id="price-chart-legend" style="margin-top:12px;display:flex;gap:16px;font-size:11px;color:var(--hint);flex-wrap:wrap">
          <span><span style="display:inline-block;width:20px;height:2px;background:#3b82f6;vertical-align:middle;margin-right:4px"></span>Market price</span>
          ${isLivestock ? '' : `
          <span><span style="display:inline-block;width:20px;height:2px;background:#9333ea;border-top:2px dashed #9333ea;vertical-align:middle;margin-right:4px"></span>Budget price</span>
          <span><span style="display:inline-block;width:8px;height:8px;background:#16a34a;border-radius:50%;vertical-align:middle;margin-right:4px"></span>Forward contract</span>
          <span><span style="display:inline-block;width:8px;height:8px;background:#f59e0b;border-radius:50%;vertical-align:middle;margin-right:4px"></span>Invoiced sale</span>
          `}
        </div>
        <div id="price-chart-loading" style="text-align:center;padding:40px;color:var(--hint)">Loading chart data…</div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.querySelector('#price-chart-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  let currentMonths = 6;

  async function loadChart(months) {
    const loading = modal.querySelector('#price-chart-loading');
    const canvas = modal.querySelector('#price-chart-canvas');
    loading.style.display = 'block';
    canvas.style.display = 'none';

    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - months);
    const cutoffStr = cutoff.toISOString().split('T')[0];

    const [prices, contracts, invoices, budgets] = await Promise.all([
      dbSelect('market_prices',
        `commodity_id=eq.${commodityId}&region=eq.${encodeURIComponent(region)}&price_date=gte.${cutoffStr}&order=price_date.asc&limit=500`
      ).catch(() => []),
      isLivestock ? Promise.resolve([]) : dbSelect('forward_contracts',
        `farm_id=eq.${farm.id}&commodity_id=eq.${commodityId}&crop_year=eq.${season}&select=price_per_unit,quantity,sale_date,delivery_start&order=sale_date.asc`
      ).catch(() => []),
      isLivestock ? Promise.resolve([]) : dbSelect('invoices',
        `farm_id=eq.${farm.id}&season=eq.${season}&master_unit=neq.head&select=invoice_date,gross_amount,total_quality_adj,total_qty,forward_contract_id&order=invoice_date.asc`
      ).catch(() => []),
      isLivestock ? Promise.resolve([]) : dbSelect('budgets',
        `farm_id=eq.${farm.id}&season=eq.${season}&commodity_id=eq.${commodityId}&select=price&limit=1`
      ).catch(() => []),
    ]);
    const budgetPrice = budgets?.[0]?.price ? parseFloat(budgets[0].price) : null;

    loading.style.display = 'none';
    canvas.style.display = 'block';

    // Filter invoices linked to this commodity via forward contracts
    const contractIds = new Set(contracts.map(c => c.id).filter(Boolean));
    const linkedInvoices = invoices.filter(inv => contractIds.has(inv.forward_contract_id));

    // Draw chart using canvas
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    // Wait one frame so the modal is laid out and canvas has a real offsetWidth
    await new Promise(r => requestAnimationFrame(r));
    const W = canvas.offsetWidth || 700;
    canvas.width = W * dpr;
    canvas.height = 300 * dpr;
    ctx.scale(dpr, dpr);
    const H = 300;
    const PAD = { top: 20, right: 20, bottom: 40, left: 55 };
    const cW = W - PAD.left - PAD.right;
    const cH = H - PAD.top - PAD.bottom;

    ctx.clearRect(0, 0, W, H);

    if (!prices.length) {
      ctx.fillStyle = 'var(--hint, #94a3b8)';
      ctx.font = '13px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('No price history available for this range', W/2, H/2);
      return;
    }

    // All price values for scale
    const allVals = [
      ...prices.map(p => parseFloat(p.price_per_unit)),
      ...(budgetPrice ? [budgetPrice] : []),
      ...contracts.filter(c => c.sale_date >= cutoffStr).map(c => parseFloat(c.price_per_unit)),
      ...linkedInvoices.map(inv => {
        const qty = parseFloat(inv.total_qty) || 1;
        return ((parseFloat(inv.gross_amount)||0) + (parseFloat(inv.total_quality_adj)||0)) / qty;
      }),
    ].filter(v => !isNaN(v) && v > 0);

    const minV = Math.min(...allVals) * 0.97;
    const maxV = Math.max(...allVals) * 1.03;
    const dateMin = new Date(cutoffStr).getTime();
    const dateMax = Date.now();

    const toX = (dateStr) => PAD.left + ((new Date(dateStr).getTime() - dateMin) / (dateMax - dateMin)) * cW;
    const toY = (val) => PAD.top + cH - ((val - minV) / (maxV - minV)) * cH;

    // Grid lines
    ctx.strokeStyle = 'rgba(148,163,184,0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.top + (cH / 4) * i;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
      const val = maxV - ((maxV - minV) / 4) * i;
      ctx.fillStyle = 'rgba(100,116,139,0.8)';
      ctx.font = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText('$' + Math.round(val), PAD.left - 6, y + 3);
    }

    // Month labels on x-axis
    ctx.fillStyle = 'rgba(100,116,139,0.8)';
    ctx.font = '10px system-ui';
    ctx.textAlign = 'center';
    const start = new Date(cutoffStr);
    for (let m = 0; m <= months; m++) {
      const d = new Date(start);
      d.setMonth(d.getMonth() + m);
      const x = toX(d.toISOString().split('T')[0]);
      if (x >= PAD.left && x <= PAD.left + cW) {
        ctx.fillText(d.toLocaleDateString('en-AU', {month:'short'}), x, H - 8);
      }
    }

    // Price line
    ctx.beginPath();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    prices.forEach((p, i) => {
      const x = toX(p.price_date), y = toY(parseFloat(p.price_per_unit));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Budget price — horizontal dashed purple line
    if (budgetPrice && budgetPrice > 0) {
      const by = toY(budgetPrice);
      ctx.beginPath();
      ctx.strokeStyle = '#9333ea';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.moveTo(PAD.left, by);
      ctx.lineTo(PAD.left + cW, by);
      ctx.stroke();
      ctx.setLineDash([]);
      // Label
      ctx.fillStyle = '#9333ea';
      ctx.font = 'bold 10px system-ui';
      ctx.textAlign = 'left';
      ctx.fillText('Budget $' + Math.round(budgetPrice), PAD.left + 4, by - 4);
    }

    // Contract dots (green)
    contracts.filter(c => c.sale_date >= cutoffStr && c.price_per_unit).forEach(c => {
      const x = toX(c.sale_date), y = toY(parseFloat(c.price_per_unit));
      ctx.beginPath();
      ctx.fillStyle = '#16a34a';
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // Invoice dots (amber)
    linkedInvoices.filter(inv => inv.invoice_date >= cutoffStr).forEach(inv => {
      const qty = parseFloat(inv.total_qty) || 1;
      const price = ((parseFloat(inv.gross_amount)||0) + (parseFloat(inv.total_quality_adj)||0)) / qty;
      if (!price || price < 10) return;
      const x = toX(inv.invoice_date), y = toY(price);
      ctx.beginPath();
      ctx.fillStyle = '#f59e0b';
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  // Range buttons
  modal.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.onclick = () => {
      modal.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMonths = parseInt(btn.dataset.months);
      loadChart(currentMonths);
    };
  });

  await loadChart(currentMonths);
}

// ── Commodity position detail modal ───────────────────────────
function _openPositionModal(com, season, fN, fC, fM, fPct) {
  const contractedQty = com.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0),0);
  const contractedVal = com.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0),0);
  const avgContractPrice = contractedQty ? contractedVal/contractedQty : null;
  const harvestPct = com.budProd ? Math.min(100,(com.harvestedProd/com.budProd)*100) : 0;
  const forecastTotal = com.isHarvestComplete ? com.harvestedProd : (com.budProd || com.harvestedProd);
  const soldPct = forecastTotal ? Math.min(999,(contractedQty/forecastTotal)*100) : null;
  const priceVar = avgContractPrice && com.budPrice ? avgContractPrice - com.budPrice : null;
  const priceVarPct = priceVar && com.budPrice ? (priceVar/com.budPrice)*100 : null;
  const priceVarColor = priceVar == null ? 'var(--hint)' : priceVar >= 0 ? '#16a34a' : '#dc2626';
  const qaPerUnit = com.invoicedQty ? com.invoicedQA/com.invoicedQty : null;
  const invoicedTotal = com.invoicedRev + com.invoicedQA;
  const uncontracted = Math.max(0, forecastTotal - contractedQty);

  const stat = (label, value, sub='', color='var(--ink)') => `
    <div style="padding:12px 16px;border-right:0.5px solid var(--border-light)">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${label}</div>
      <div style="font-size:20px;font-weight:700;color:${color}">${value}</div>
      ${sub ? `<div style="font-size:10px;color:var(--hint);margin-top:2px">${sub}</div>` : ''}
    </div>`;

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:680px;max-height:90vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">${com.name}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">${season} · ${com.isHarvestComplete ? 'Harvest complete' : com.harvestedProd > 0 ? 'In harvest' : 'Budget'}</div>
        </div>
        <button id="pos-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hint)">✕</button>
      </div>

      ${!com.isLivestock ? `
      <!-- Production -->
      <div style="padding:8px 18px;background:var(--page-bg);border-bottom:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Production</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border)">
        ${stat('Budget', com.budProd ? fN(com.budProd) + ' ' + com.unit : '—')}
        ${stat('Harvested', com.harvestedProd ? fN(com.harvestedProd) + ' ' + com.unit : '—', com.budProd ? Math.round(harvestPct) + '% of budget' : '')}
        ${stat('Budget price', com.budPrice ? fC(com.budPrice) + '/' + com.unit : '—')}
      </div>

      <!-- Contracts -->
      <div style="padding:8px 18px;background:var(--page-bg);border-bottom:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Forward contracts</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid var(--border)">
        ${stat('Contracted', contractedQty ? fN(contractedQty) + ' ' + com.unit : '—', soldPct != null ? Math.round(soldPct) + '% of ' + (com.isHarvestComplete ? 'harvest' : 'budget') : '')}
        ${stat('Avg price', avgContractPrice ? fC(avgContractPrice) + '/' + com.unit : '—', priceVar != null ? (priceVar>=0?'▲':'▼') + fC(Math.abs(priceVar)) + ' vs budget (' + (priceVarPct>=0?'+':'') + priceVarPct.toFixed(1) + '%)' : '', priceVarColor)}
        ${stat('Contract value', contractedVal ? fM(contractedVal) : '—', uncontracted > 0 ? fN(uncontracted) + ' ' + com.unit + ' uncontracted' : 'Fully contracted', uncontracted > 0 ? '#d97706' : '#16a34a')}
      </div>

      <!-- Individual contracts -->
      ${com.contracts.length ? `
      <div style="padding:0 18px 12px">
        <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:12px">
          <thead><tr style="border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 8px;color:var(--hint);font-weight:500">Contract</th>
            <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Qty</th>
            <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Price</th>
            <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Value</th>
            <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Delivery</th>
          </tr></thead>
          <tbody>
            ${com.contracts.map(c => `<tr style="border-bottom:0.5px solid var(--border-light)">
              <td style="padding:5px 8px;color:var(--ink);font-weight:500">${c.contract_number || c.buyer || '—'}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--hint)">${fN(parseFloat(c.quantity)||0)} ${com.unit}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--ink)">${fC(parseFloat(c.price_per_unit)||0)}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--ink)">${fM((parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0))}</td>
              <td style="padding:5px 8px;text-align:right;color:var(--hint)">${c.delivery_start ? new Date(c.delivery_start).toLocaleDateString('en-AU',{month:'short',year:'2-digit'}) : c.crop_year || '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div style="padding:12px 18px;font-size:11px;color:var(--hint)">No forward contracts for this season.</div>'}
      ` : ''}

      <!-- Invoiced / paid -->
      <div style="padding:8px 18px;background:var(--page-bg);border-bottom:1px solid var(--border);border-top:1px solid var(--border);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Invoiced / paid</div>
      <div style="display:grid;grid-template-columns:repeat(${com.isLivestock ? 3 : 4},1fr);border-bottom:1px solid var(--border)">
        ${stat('Total paid', invoicedTotal ? fM(invoicedTotal) : '—', '', invoicedTotal ? '#16a34a' : 'var(--hint)')}
        ${stat('Qty', com.invoicedQty ? fN(com.invoicedQty) + ' ' + com.unit : '—')}
        ${stat('Avg price', com.invoicedQty && com.invoicedRev ? fC(com.invoicedRev/com.invoicedQty) + '/' + com.unit : '—')}
        ${!com.isLivestock ? stat('Quality adj', qaPerUnit != null ? (qaPerUnit>=0?'+':'') + fC(qaPerUnit) + '/' + com.unit : '—', '', qaPerUnit >= 0 ? '#16a34a' : '#dc2626') : ''}
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#pos-modal-close').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}
// ── Weather panel ─────────────────────────────────────────────
async function _loadWeatherPanel(farm, season) {
  const panel = document.getElementById('wx-panel');
  const stationLabel = document.getElementById('wx-station-label');
  if (!panel) return;

  const wx = farm.settings.weather;
  const stationId = wx.bomStationId;
  const gddBase = wx.gddBase || 10;

  if (stationLabel) stationLabel.textContent = wx.bomStationName + ' · BOM';

  // Determine season start date
  const yearStart = farm.settings?.yearStartMonth || 1;
  const now = new Date();
  const seasonYear = yearStart === 1 ? now.getFullYear()
    : (now.getMonth() + 1 >= yearStart ? now.getFullYear() : now.getFullYear() - 1);
  const startDate = `${seasonYear}-${String(yearStart).padStart(2,'0')}-01`;

  // Fetch data in parallel
  const [obsRows, overrideRows, avgRows] = await Promise.all([
    dbSelect('weather_observations',
      `farm_id=eq.${farm.id}&station_id=eq.${stationId}&obs_date=gte.${startDate}&order=obs_date.asc&limit=400`
    ).catch(() => []),
    dbSelect('weather_monthly_overrides',
      `farm_id=eq.${farm.id}&year=gte.${seasonYear}&order=year.asc,month.asc`
    ).catch(() => []),
    dbSelect('weather_station_averages',
      `station_id=eq.${stationId}&order=month.asc`
    ).catch(() => []),
  ]);

  // Build monthly summaries
  const months = [];
  const today = new Date();
  let m = yearStart;
  let y = seasonYear;
  while (new Date(y, m - 1, 1) <= today) {
    const monthKey = `${y}-${String(m).padStart(2,'0')}`;
    const monthObs = obsRows.filter(r => r.obs_date.startsWith(monthKey));

    // Rainfall: check override first, then sum daily
    const override = overrideRows.find(r => r.year === y && r.month === m);
    const actualRain = override
      ? { value: parseFloat(override.rainfall_mm), source: 'gauge' }
      : { value: monthObs.reduce((s, r) => s + (parseFloat(r.rainfall_mm) || 0), 0), source: 'BOM' };

    // GDD: sum of (max+min)/2 - base, floored at 0
    const gdd = monthObs.reduce((s, r) => {
      const avg = ((parseFloat(r.temp_max) || 0) + (parseFloat(r.temp_min) || 0)) / 2;
      return s + Math.max(0, avg - gddBase);
    }, 0);

    // LTA
    const lta = avgRows.find(a => a.month === m);

    months.push({
      label: new Date(y, m - 1, 1).toLocaleDateString('en-AU', { month: 'short' }),
      month: m, year: y,
      rain: Math.round(actualRain.value * 10) / 10,
      rainSource: actualRain.source,
      gdd: Math.round(gdd),
      ltaRain: lta?.avg_rainfall_mm || null,
      hasData: monthObs.length > 0 || !!override,
    });

    m++;
    if (m > 12) { m = 1; y++; }
    if (months.length > 24) break; // safety
  }

  // Totals
  const totalRain = months.reduce((s, m) => s + (m.rain || 0), 0);
  const totalGDD = months.reduce((s, m) => s + (m.gdd || 0), 0);
  const ltaToDate = months.reduce((s, m) => s + (m.ltaRain || 0), 0);
  const rainVar = ltaToDate ? totalRain - ltaToDate : null;
  const rainVarColor = rainVar == null ? '#64748b' : rainVar >= 0 ? '#16a34a' : '#dc2626';

  const hasAnyData = months.some(m => m.hasData);

  // Build HTML
  const barMax = Math.max(...months.map(m => Math.max(m.rain || 0, m.ltaRain || 0)), 10);
  const barH = 48; // px height of bar area

  panel.innerHTML = `
    <div class="card" style="padding:12px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:2px">
        <span style="font-size:11px;color:var(--hint);text-transform:uppercase;letter-spacing:.06em">Rainfall YTD</span>
        ${ltaToDate ? `<span style="font-size:10px;color:var(--hint)">LTA to date: ${Math.round(ltaToDate)}mm</span>` : ''}
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
        <span style="font-size:22px;font-weight:700;color:var(--ink)">${Math.round(totalRain)}mm</span>
        ${rainVar != null ? `<span style="font-size:12px;font-weight:600;color:${rainVarColor}">${rainVar >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(rainVar))}mm vs avg</span>` : ''}
      </div>
      ${hasAnyData ? `
      <div style="display:flex;align-items:flex-end;gap:3px;height:${barH}px;margin-bottom:6px">
        ${months.map(m => {
          const rainH = m.ltaRain ? Math.max(2, Math.round((m.rain / barMax) * barH)) : Math.max(2, Math.round((m.rain / barMax) * barH));
          const ltaH  = m.ltaRain ? Math.max(1, Math.round((m.ltaRain / barMax) * barH)) : 0;
          return `<div style="flex:1;display:flex;align-items:flex-end;gap:1px;position:relative" title="${m.label}: ${m.rain}mm actual${m.ltaRain ? ', ' + m.ltaRain + 'mm avg' : ''}${m.rainSource==='gauge' ? ' (gauge)' : ''}">
            <div style="flex:1;height:${rainH}px;background:${m.rainSource==='gauge'?'#16a34a':'#2a78d6'};border-radius:2px 2px 0 0"></div>
            ${ltaH ? `<div style="flex:1;height:${ltaH}px;background:#d3d1c7;border-radius:2px 2px 0 0"></div>` : ''}
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;gap:10px;font-size:10px;color:var(--hint)">
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#2a78d6;margin-right:3px;vertical-align:middle"></span>BOM</span>
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#16a34a;margin-right:3px;vertical-align:middle"></span>Gauge</span>
          <span><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:#d3d1c7;margin-right:3px;vertical-align:middle"></span>30yr avg</span>
        </div>
        ${canWrite() ? `<button class="btn btn-secondary" id="wx-override-btn" style="font-size:10px;padding:3px 8px">✎ Override</button>` : ''}
      </div>` : `<div style="font-size:11px;color:var(--hint)">No data yet — function runs nightly</div>`}
    </div>

    <div class="card" style="padding:12px 14px;margin-bottom:8px">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:2px">
        <span style="font-size:11px;color:var(--hint);text-transform:uppercase;letter-spacing:.06em">Heat units (GDD)</span>
        <span style="font-size:10px;color:var(--hint)">Base ${gddBase}°C</span>
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px">
        <span style="font-size:22px;font-weight:700;color:var(--ink)">${totalGDD.toLocaleString()}</span>
        <span style="font-size:11px;color:var(--hint)">GDD accumulated</span>
      </div>
      ${hasAnyData ? (() => {
        // Cumulative GDD line
        let cum = 0;
        const cumPoints = months.map(m => { cum += m.gdd; return cum; });
        const maxGDD = Math.max(...cumPoints, 1);
        const pts = cumPoints.map((v, i) => `${Math.round((i / (cumPoints.length - 1 || 1)) * 100)},${Math.round((1 - v / maxGDD) * 40)}`).join(' ');
        return `<svg viewBox="0 0 100 44" style="width:100%;height:44px;overflow:visible">
          <polyline points="${pts}" fill="none" stroke="#eb6834" stroke-width="1.5" stroke-linejoin="round"/>
          ${cumPoints.map((v, i) => {
            const x = Math.round((i / (cumPoints.length - 1 || 1)) * 100);
            const y = Math.round((1 - v / maxGDD) * 40);
            return `<circle cx="${x}" cy="${y}" r="2" fill="#eb6834"/>
              <text x="${x}" y="44" font-size="6" text-anchor="middle" fill="#888781">${months[i].label}</text>`;
          }).join('')}
        </svg>`;
      })() : `<div style="font-size:11px;color:var(--hint)">No temperature data yet</div>`}
    </div>`;

  // Wire override button
  document.getElementById('wx-override-btn')?.addEventListener('click', () => {
    _openWeatherOverrideModal(farm, months, overrideRows, () => _loadWeatherPanel(farm, season));
  });
}

// ── Weather override modal ────────────────────────────────────
function _openWeatherOverrideModal(farm, months, existingOverrides, onSave) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px';
  modal.innerHTML = `
    <div style="background:#fff;border-radius:10px;width:100%;max-width:480px;max-height:85vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--ink)">Monthly rainfall overrides</div>
          <div style="font-size:11px;color:var(--hint);margin-top:2px">Enter farm gauge readings to replace BOM data for a month</div>
        </div>
        <button id="wx-modal-close" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--hint)">✕</button>
      </div>
      <div style="padding:16px 18px">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--border)">
              <th style="text-align:left;padding:6px 8px;color:var(--hint);font-weight:500">Month</th>
              <th style="text-align:right;padding:6px 8px;color:var(--hint);font-weight:500">BOM</th>
              <th style="text-align:right;padding:6px 8px;color:var(--hint);font-weight:500">Override (mm)</th>
              <th style="padding:6px 8px"></th>
            </tr>
          </thead>
          <tbody>
            ${months.map(m => {
              const ov = existingOverrides.find(r => r.year === m.year && r.month === m.month);
              return `<tr style="border-bottom:0.5px solid var(--border-light)">
                <td style="padding:6px 8px;font-weight:500;color:var(--ink)">${m.label} ${m.year}</td>
                <td style="padding:6px 8px;text-align:right;color:var(--hint)">${m.rain}mm</td>
                <td style="padding:6px 8px;text-align:right">
                  <input type="number" step="0.1" min="0" class="wx-override-input form-input"
                    data-month="${m.month}" data-year="${m.year}" data-override-id="${ov?.id||''}"
                    value="${ov ? ov.rainfall_mm : ''}" placeholder="—"
                    style="width:80px;font-size:12px;padding:4px 6px;text-align:right">
                </td>
                <td style="padding:6px 8px">
                  ${ov ? `<button class="wx-clear-btn" data-id="${ov.id}" style="background:none;border:none;color:var(--hint);cursor:pointer;font-size:11px">✕</button>` : ''}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div id="wx-override-feedback" style="margin-top:10px;font-size:11px;color:var(--hint)"></div>
        <div style="display:flex;gap:10px;margin-top:14px">
          <button class="btn btn-primary" id="wx-save-overrides">Save overrides</button>
          <button class="btn btn-secondary" id="wx-modal-cancel">Cancel</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#wx-modal-close').onclick = () => modal.remove();
  modal.querySelector('#wx-modal-cancel').onclick = () => modal.remove();
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  // Clear override
  modal.querySelectorAll('.wx-clear-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { id } = btn.dataset;
      btn.textContent = '…';
      await dbDelete('weather_monthly_overrides', id);
      modal.remove();
      await onSave();
    });
  });

  // Save
  modal.querySelector('#wx-save-overrides').addEventListener('click', async () => {
    const btn = modal.querySelector('#wx-save-overrides');
    const fb = modal.querySelector('#wx-override-feedback');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const inputs = modal.querySelectorAll('.wx-override-input');
      const saves = [];
      inputs.forEach(inp => {
        const val = inp.value.trim();
        if (!val) return;
        const month = parseInt(inp.dataset.month);
        const year  = parseInt(inp.dataset.year);
        const ovId  = inp.dataset.overrideId;
        saves.push({ id: ovId||undefined, farm_id: farm.id, year, month, rainfall_mm: parseFloat(val) });
      });
      if (saves.length) {
        await dbInsert('weather_monthly_overrides', saves.length === 1 ? saves[0] : saves);
      }
      fb.textContent = `${saves.length} override(s) saved`;
      fb.style.color = '#16a34a';
      setTimeout(() => { modal.remove(); onSave(); }, 800);
    } catch(e) {
      fb.textContent = 'Save failed: ' + e.message;
      fb.style.color = '#dc2626';
      btn.disabled = false; btn.textContent = 'Save overrides';
    }
  });
}
