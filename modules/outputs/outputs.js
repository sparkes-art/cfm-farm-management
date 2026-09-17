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

    // Fetch 14 days of prices for rolling average + movement
    const allPrices = await dbSelect('market_prices',
      'select=commodity_id,region,price_per_unit,price_date,unit&order=price_date.desc&limit=1000'
    );

    const fC = (n, dp=2) => n == null ? '—' : formatCurrency(n, dp);
    const fM = (n) => n == null ? '—' : n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'k' : '$' + Math.round(n).toLocaleString();
    const fN = (n, dp=0) => n == null ? '—' : Number(n).toLocaleString('en-AU', {minimumFractionDigits:dp, maximumFractionDigits:dp});
    const fPct = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

    // Farm's preferred sites
    const farmSites = [
      ...Object.entries(grainSites).map(([crop, site]) => ({ crop, site })),
      ...(cottonRegion ? [{ crop: 'Cotton Lint', site: cottonRegion }] : []),
    ];

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
        '<div class="card" style="padding:12px 14px;margin-bottom:8px">',
        '<div style="display:flex;align-items:center;justify-content:space-between">',
        '<div>',
        '<div style="font-size:11px;font-weight:600;color:var(--ink)">'+name+'</div>',
        '<div style="font-size:10px;color:var(--hint);margin-bottom:4px">'+sourceLabel+' · '+unit+'</div>',
        '<div style="display:flex;align-items:baseline;gap:5px">',
        '<span style="font-size:22px;font-weight:700;color:var(--ink)">'+latest.toFixed(2)+'</span>',
        '<span style="font-size:11px;color:var(--hint)">'+unit+'</span>',
        '</div></div>',
        '<div style="text-align:right;min-width:90px">',
        '<div style="font-size:10px;color:var(--hint);margin-bottom:2px">'+new Date(latestDate).toLocaleDateString('en-AU',{day:'numeric',month:'short'})+'</div>',
        dayMove!=null
          ? '<div style="font-size:12px;font-weight:600;color:'+moveColor+'">'+moveArrow+' '+Math.abs(dayMove).toFixed(2)+' <span style="font-size:10px;font-weight:400">('+fPct(dayMovePct)+')</span></div>'
          : '<div style="font-size:11px;color:var(--hint)">—</div>',
        avg14!=null
          ? '<div style="font-size:10px;color:var(--hint);margin-top:3px">14d '+avg14.toFixed(2)+' <span style="color:'+avgColor+'">'+(vsAvg>=0?'▲':'▼')+fPct(vsAvgPct)+'</span></div>'
          : '',
        '</div>',
        '</div></div>',
      ].join('');
    }).join('');

    // Build price cards
    const priceCards = farmSites.map(({ crop, site }) => {
      const com = commodityList.find(c => c.name === crop);
      if (!com) return '';

      // All history for this commodity + site, sorted newest first
      const history = allPrices
        .filter(p => p.commodity_id === com.id && p.region === site)
        .sort((a, b) => b.price_date.localeCompare(a.price_date));

      if (!history.length) return [
        '<div class="card" style="padding:16px 18px;margin-bottom:12px">',
        '<div style="font-size:13px;font-weight:600;color:var(--ink)">' + crop + '</div>',
        '<div style="font-size:11px;color:var(--hint);margin-top:2px">' + site + '</div>',
        '<div style="font-size:12px;color:var(--hint);margin-top:8px">No price data</div>',
        '</div>',
      ].join('');

      const latest = parseFloat(history[0].price_per_unit);
      const latestDate = history[0].price_date;
      const unit = history[0].unit || 't';
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
        '<div class="card" style="padding:12px 14px;margin-bottom:8px">',
        '<div style="display:flex;align-items:center;justify-content:space-between">',
        // Left — name + price
        '<div>',
        '<div style="font-size:11px;font-weight:600;color:var(--ink)">' + crop + '</div>',
        '<div style="font-size:10px;color:var(--hint);margin-bottom:4px">' + site + '</div>',
        '<div style="display:flex;align-items:baseline;gap:5px">',
        '<span style="font-size:22px;font-weight:700;color:var(--ink)">' + fC(latest) + '</span>',
        '<span style="font-size:11px;color:var(--hint)">/' + unit + '</span>',
        '</div>',
        '</div>',
        // Right — day + 14d avg
        '<div style="text-align:right;min-width:90px">',
        '<div style="font-size:10px;color:var(--hint);margin-bottom:2px">' + new Date(latestDate).toLocaleDateString('en-AU',{day:'numeric',month:'short'}) + '</div>',
        dayMove != null
          ? '<div style="font-size:12px;font-weight:600;color:' + moveColor + '">' + moveArrow + ' ' + fC(Math.abs(dayMove)) + ' <span style="font-size:10px;font-weight:400">(' + fPct(dayMovePct) + ')</span></div>'
          : '<div style="font-size:11px;color:var(--hint)">—</div>',
        avg14 != null
          ? '<div style="font-size:10px;color:var(--hint);margin-top:3px">14d ' + fC(avg14) + ' <span style="color:' + avgColor + '">' + (vsAvg >= 0 ? '▲' : '▼') + fPct(vsAvgPct) + '</span></div>'
          : '',
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    }).join('');

    // ── Commodity position ────────────────────────────────────
    const season = getActiveSeason() || currentSeason();
    const [contracts, invoices, budgets, harvests] = await Promise.all([
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&master_unit=neq.head&select=id,gross_amount,total_quality_adj,total_qty,forward_contract_id,batches,status'),
      dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    ]);

    await loadCommodities();
    const commodityList2 = getCommodities();
    const idToName = {}; commodityList2.forEach(c => { idToName[c.id] = c.name; });

    // Group budgets by commodity
    const comMap = {};
    budgets.forEach(b => {
      const name = idToName[b.commodity_id] || b.commodity || 'Other';
      if (!comMap[name]) comMap[name] = { name, commodity_id: b.commodity_id, budArea:0, budProd:0, budPrice:0, unit: b.unit||'t', contracts:[], invoicedQty:0, invoicedRev:0, harvestedProd:0 };
      comMap[name].budArea += parseFloat(b.area_ha)||0;
      comMap[name].budProd += parseFloat(b.budgeted_production)||((parseFloat(b.area_ha)||0)*(parseFloat(b.budgeted_yield_per_ha||b.yield_per_ha)||0));
      comMap[name].budPrice = parseFloat(b.price)||comMap[name].budPrice;
    });

    // Add contracts
    contracts.forEach(c => {
      const name = idToName[c.commodity_id] || c.commodity || 'Other';
      if (comMap[name]) comMap[name].contracts.push(c);
    });

    // Add harvest actuals
    harvests.forEach(h => {
      const name = idToName[h.commodity_id] || h.commodity || 'Other';
      if (comMap[name]) comMap[name].harvestedProd += parseFloat(h.actual_production)||0;
    });

    // Add invoiced revenue
    invoices.forEach(inv => {
      const c = contracts.find(c => c.id === inv.forward_contract_id);
      if (!c) return;
      const name = idToName[c.commodity_id] || c.commodity || 'Other';
      if (!comMap[name]) return;
      let qty = 0, rev = 0;
      if (inv.batches) {
        const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
        b.forEach(bt => { const sl=(bt.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa'); if(sl.length){qty+=parseFloat(bt.qty)||0;rev+=sl.reduce((s,l)=>s+(parseFloat(l.amount)||0),0);}});
      } else { qty+=parseFloat(inv.total_qty)||0; rev+=(parseFloat(inv.gross_amount)||0)+(parseFloat(inv.total_quality_adj)||0); }
      comMap[name].invoicedQty += qty;
      comMap[name].invoicedRev += rev;
    });

    const comCards = Object.values(comMap).map(com => {
      const contractedQty = com.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0),0);
      const contractedVal = com.contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0),0);
      const avgContractPrice = contractedQty ? contractedVal/contractedQty : null;
      // Production figure — harvested > budget forecast
      const production = com.harvestedProd || com.budProd;
      const prodLabel = com.harvestedProd ? 'Harvested' : com.budProd ? 'Budget' : null;
      const pctContracted = production ? Math.min(100, Math.round(contractedQty/production*100)) : null;
      const pctInvoiced = contractedQty ? Math.min(100, Math.round(com.invoicedQty/contractedQty*100)) : null;
      const uncontracted = Math.max(0, production - contractedQty);

      return [
        '<div class="card" style="padding:0;overflow:hidden;margin-bottom:10px">',
        // Header
        '<div style="padding:8px 14px;background:#1a2535;display:flex;align-items:center;justify-content:space-between">',
        '<span style="font-size:12px;font-weight:600;color:white">' + com.name + '</span>',
        prodLabel ? '<span style="font-size:10px;color:rgba(255,255,255,.5)">' + prodLabel + ' ' + fN(production) + ' ' + com.unit + '</span>' : '',
        '</div>',
        // Stats row
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:0.5px solid var(--border-light)">',
        // Contracted
        '<div style="padding:10px 12px;border-right:0.5px solid var(--border-light)">',
        '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:3px">Contracted</div>',
        '<div style="font-size:16px;font-weight:700;color:var(--ink)">' + fN(contractedQty) + ' ' + com.unit + '</div>',
        '<div style="font-size:10px;color:var(--hint);margin-top:1px">' + fC(avgContractPrice) + '/' + com.unit + ' avg</div>',
        pctContracted != null ? '<div style="height:3px;background:var(--border-light);border-radius:2px;margin-top:5px;overflow:hidden"><div style="height:100%;width:'+pctContracted+'%;background:#3b82f6;border-radius:2px"></div></div>' : '',
        pctContracted != null ? '<div style="font-size:9px;color:var(--hint);margin-top:2px">'+pctContracted+'% of '+prodLabel+'</div>' : '',
        '</div>',
        // Total contracted value
        '<div style="padding:10px 12px;border-right:0.5px solid var(--border-light)">',
        '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:3px">Contract value</div>',
        '<div style="font-size:16px;font-weight:700;color:var(--ink)">' + fM(contractedVal) + '</div>',
        uncontracted > 0 ? '<div style="font-size:10px;color:#d97706;margin-top:1px">'+fN(uncontracted)+' '+com.unit+' open</div>' : '<div style="font-size:10px;color:#16a34a;margin-top:1px">Fully contracted ✓</div>',
        '</div>',
        // Invoiced / paid
        '<div style="padding:10px 12px">',
        '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:3px">Invoiced</div>',
        '<div style="font-size:16px;font-weight:700;color:' + (com.invoicedRev > 0 ? '#16a34a' : 'var(--ink)') + '">' + fM(com.invoicedRev) + '</div>',
        '<div style="font-size:10px;color:var(--hint);margin-top:1px">' + fN(com.invoicedQty) + ' ' + com.unit + (pctInvoiced != null ? ' · ' + pctInvoiced + '%' : '') + '</div>',
        pctInvoiced != null ? '<div style="height:3px;background:var(--border-light);border-radius:2px;margin-top:5px;overflow:hidden"><div style="height:100%;width:'+pctInvoiced+'%;background:#16a34a;border-radius:2px"></div></div>' : '',
        '</div>',
        '</div>',
        '</div>',
      ].join('');
    }).join('');

    container.innerHTML = [
      '<div style="display:grid;grid-template-columns:380px 1fr;gap:16px;align-items:start">',

      // LEFT — Farm gate prices
      '<div>',
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">',
      '<h2 style="font-size:14px;font-weight:600;color:var(--ink)">Farm gate prices</h2>',
      '<span style="font-size:11px;color:var(--hint)">' + farm.name + '</span>',
      '</div>',
      farmSites.length
        ? priceCards || '<div class="card" style="padding:16px;color:var(--hint)">No market price data available.</div>'
        : '<div class="card" style="padding:16px;color:var(--hint)">No delivery sites configured.</div>',
      lsIndicatorNames.length ? '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin:14px 0 8px">Livestock indicators</div>' + lsCards : '',
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

      '</div>',
    ].join('');

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