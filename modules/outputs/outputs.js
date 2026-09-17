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
  const season = getActiveSeason() || currentSeason();
  container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';

  try {
    await loadCommodities();
    const commodityList = getCommodities();
    const idToName = {}; commodityList.forEach(c => { idToName[c.id] = c.name; });
    const settings = farm.settings || {};
    const cottonRegion = settings.cottonRegion || '';
    const grainSites = settings.grainSites || {};

    const [contracts, invoices, budgets, harvests, forecasts, allPrices,
           lsInvoices, stockItems, stockMovements] = await Promise.all([
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&master_unit=neq.head&select=id,gross_amount,total_quality_adj,total_qty,forward_contract_id,batches,status,buyer,invoice_date'),
      dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('forecasts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*&order=forecast_date.desc'),
      dbSelect('market_prices', 'select=commodity_id,region,price_per_unit,price_date,unit&order=price_date.desc&limit=200'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&master_unit=eq.head&season=eq.' + season + '&select=id,total_qty,gross_amount,livestock_lines,invoice_date,left_farm_date,buyer'),
      dbSelect('stock_items', 'farm_id=eq.' + farm.id + '&category=eq.livestock&active=eq.true&select=id,name,subgroup,attributes&order=subgroup,name'),
      dbSelect('stock_movements', 'farm_id=eq.' + farm.id + '&select=id,item_id,signed_qty,qty,movement_type,occurred_on,source_ref,source_system,note&order=occurred_on.desc'),
    ]);

    const fM  = (n) => n == null ? '—' : n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'k' : '$' + Math.round(n).toLocaleString();
    const fN  = (n,dp=0) => n == null ? '—' : formatNumber(n,dp);
    const fN2 = (n) => n == null ? '—' : formatNumber(n,2);
    const fC  = (n,dp=2) => n == null ? '—' : formatCurrency(n,dp);
    const pctBar = (pct, color, h='4px') => '<div style="height:'+h+';background:var(--border-light);border-radius:2px;overflow:hidden;margin-top:4px"><div style="height:100%;width:'+Math.min(100,pct||0)+'%;background:'+color+';border-radius:2px"></div></div>';

    // ── Contract / invoiced position ─────────────────────────
    const totalContractedVal = contracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0),0);
    let invoicedRev = 0, invoicedQty = 0;
    invoices.forEach(inv => {
      if (inv.batches) { const b=typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches; b.forEach(bt=>{const sl=(bt.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa');if(sl.length){invoicedRev+=sl.reduce((s,l)=>s+(parseFloat(l.amount)||0),0);invoicedQty+=parseFloat(bt.qty)||0;}}); }
      else { invoicedRev+=(parseFloat(inv.gross_amount)||0)+(parseFloat(inv.total_quality_adj)||0); }
    });
    const pctInvoiced = totalContractedVal ? Math.round(invoicedRev/totalContractedVal*100) : 0;
    const pendingInvoices = invoices.filter(i=>i.status==='pending');

    // ── Market prices (farm gate) ─────────────────────────────
    const priceMap = {};
    allPrices.forEach(p => {
      if (!priceMap[p.commodity_id]) priceMap[p.commodity_id] = {};
      if (!priceMap[p.commodity_id][p.region]) priceMap[p.commodity_id][p.region] = { price: parseFloat(p.price_per_unit), date: p.price_date, unit: p.unit };
    });
    const farmGatePrice = (comId, comName) => {
      const regions = priceMap[comId]; if (!regions) return null;
      const preferred = comName === 'Cotton Lint' ? cottonRegion : grainSites[comName];
      if (preferred && regions[preferred]) return { ...regions[preferred], region: preferred };
      const all = Object.entries(regions).map(([r,v])=>({...v,region:r})).sort((a,b)=>b.date.localeCompare(a.date));
      return all[0] || null;
    };

    // ── Cropping summary (budget vs actual) ──────────────────
    const cropRows = budgets.map(b => {
      const name = idToName[b.commodity_id] || b.commodity || 'Other';
      const budArea = parseFloat(b.area_ha)||0;
      const budYield = parseFloat(b.budgeted_yield_per_ha||b.yield_per_ha)||0;
      const budProd = parseFloat(b.budgeted_production)||(budArea*budYield);
      const budPrice = parseFloat(b.price)||0;
      // Harvest actuals
      const hvsts = harvests.filter(h=>h.budget_id===b.id || h.commodity_id===b.commodity_id);
      const hvstArea = hvsts.reduce((s,h)=>s+(parseFloat(h.area_ha)||0),0);
      const hvstProd = hvsts.reduce((s,h)=>s+(parseFloat(h.actual_production)||0),0);
      const hvstYield = hvstArea ? hvstProd/hvstArea : null;
      // Forecast
      const fcstMap2 = {};
      forecasts.filter(f=>f.budget_id===b.id||f.commodity_id===b.commodity_id).forEach(f=>{ if(!fcstMap2[b.id]||f.forecast_date>fcstMap2[b.id].forecast_date) fcstMap2[b.id]=f; });
      const fcst = fcstMap2[b.id];
      const fcstProd = fcst ? parseFloat(fcst.forecast_production)||(parseFloat(fcst.area_ha||budArea)*parseFloat(fcst.yield_per_ha||budYield)) : null;
      // Contracts for this commodity
      const comContracts = contracts.filter(c=>idToName[c.commodity_id]===name||c.commodity===name);
      const contractedQty = comContracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0),0);
      const contractedVal = comContracts.reduce((s,c)=>s+(parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0),0);
      const avgContractPrice = contractedQty ? contractedVal/contractedQty : null;
      // Market price
      const mkt = farmGatePrice(b.commodity_id, name);
      // Invoiced
      const comInvoicedRev = invoices.filter(i=>comContracts.some(c=>c.id===i.forward_contract_id)).reduce((s,i)=>{
        if(i.batches){const bs=typeof i.batches==='string'?JSON.parse(i.batches):i.batches;return s+bs.flatMap(bt=>(bt.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa')).reduce((ss,l)=>ss+(parseFloat(l.amount)||0),0);}
        return s+(parseFloat(i.gross_amount)||0)+(parseFloat(i.total_quality_adj)||0);
      },0);
      // Harvest complete flag (harvested area < budget area)
      const harvComplete = hvstArea > 0 && budArea > 0 && hvstArea < budArea * 0.98;
      return { name, budArea, budYield, budProd, budPrice, hvstArea, hvstProd, hvstYield, fcstProd, contractedQty, contractedVal, avgContractPrice, comInvoicedRev, mkt, unit: b.unit||'t', harvComplete };
    });

    // ── Livestock position ────────────────────────────────────
    const stockBalances = {};
    stockItems.forEach(i => { stockBalances[i.id] = 0; });
    stockMovements.forEach(m => { if (stockBalances[m.item_id] !== undefined) stockBalances[m.item_id] += parseFloat(m.signed_qty)||0; });

    // Year start for this farm
    const yearStartMonth = (farm.settings?.yearStartMonth || 7) - 1;
    const now = new Date();
    const yearStart = new Date(now.getMonth() >= yearStartMonth ? now.getFullYear() : now.getFullYear()-1, yearStartMonth, 1);
    const yearStartStr = yearStart.toISOString().slice(0,10);

    // YTD movements per item
    const ytdByItem = {};
    stockItems.forEach(i => { ytdByItem[i.id] = { in:0, out:0, sales:0, deaths:0, naturalIncrease:0, purchases:0 }; });
    stockMovements.filter(m => m.occurred_on >= yearStartStr).forEach(m => {
      if (!ytdByItem[m.item_id]) return;
      const qty = parseFloat(m.signed_qty)||0;
      const absQty = Math.abs(parseFloat(m.qty)||0);
      if (qty > 0) ytdByItem[m.item_id].in += qty;
      if (qty < 0) ytdByItem[m.item_id].out += Math.abs(qty);
      if (m.movement_type === 'sale') ytdByItem[m.item_id].sales += absQty;
      if (m.movement_type === 'death') ytdByItem[m.item_id].deaths += absQty;
      if (m.movement_type === 'natural_increase') ytdByItem[m.item_id].naturalIncrease += absQty;
      if (m.movement_type === 'transfer_in') ytdByItem[m.item_id].purchases += absQty;
    });

    // Opening balance per item (before yearStart)
    const openingByItem = {};
    stockItems.forEach(i => {
      openingByItem[i.id] = stockMovements.filter(m => m.item_id===i.id && m.occurred_on < yearStartStr).reduce((s,m)=>s+(parseFloat(m.signed_qty)||0),0);
    });

    // Sales revenue from livestock invoices
    const lsGross = lsInvoices.reduce((s,i)=>s+(parseFloat(i.gross_amount)||0),0);
    const lsHead  = lsInvoices.reduce((s,i)=>s+(parseFloat(i.total_qty)||0),0);
    const lsAvgPerHead = lsHead ? lsGross/lsHead : null;

    // Group by class for the mob table
    const classOrder = ['bull','cow','heifer','steer','weaner','calf','other'];
    const classLabel = { bull:'Bulls', cow:'Cows', heifer:'Heifers', steer:'Steers', weaner:'Weaners', calf:'Calves', other:'Other' };
    const mobsByClass = {};
    classOrder.forEach(cls => { mobsByClass[cls] = []; });
    stockItems.forEach(i => {
      const cls = i.attributes?.class || 'other';
      const bucket = mobsByClass[cls] || mobsByClass['other'];
      bucket.push(i);
    });

    const totalOnHand = Object.values(stockBalances).reduce((s,v)=>s+v,0);
    const totalOpening = Object.values(openingByItem).reduce((s,v)=>s+v,0);
    const totalSales = Object.values(ytdByItem).reduce((s,v)=>s+v.sales,0);
    const totalDeaths = Object.values(ytdByItem).reduce((s,v)=>s+v.deaths,0);
    const totalNI = Object.values(ytdByItem).reduce((s,v)=>s+v.naturalIncrease,0);
    const totalPurchases = Object.values(ytdByItem).reduce((s,v)=>s+v.purchases,0);

    // Pending livestock allocations
    const allocatedRefs = new Set(stockMovements.filter(m=>m.source_system==='invoices'&&m.source_ref).map(m=>m.source_ref));
    let pendingAllocations = 0;
    lsInvoices.forEach(inv => { (inv.livestock_lines||[]).forEach((_,idx) => { if(!allocatedRefs.has(inv.id+':'+idx)) pendingAllocations++; }); });

    // ── Build mob table rows ──────────────────────────────────
    const mobTableRows = classOrder.map(cls => {
      const mobs = mobsByClass[cls].filter(i => openingByItem[i.id] > 0 || stockBalances[i.id] > 0 || ytdByItem[i.id]?.in > 0);
      if (!mobs.length) return '';
      const clsOpening = mobs.reduce((s,i)=>s+openingByItem[i.id],0);
      const clsClosing = mobs.reduce((s,i)=>s+(stockBalances[i.id]||0),0);
      const clsNI = mobs.reduce((s,i)=>s+ytdByItem[i.id].naturalIncrease,0);
      const clsPurchases = mobs.reduce((s,i)=>s+ytdByItem[i.id].purchases,0);
      const clsSales = mobs.reduce((s,i)=>s+ytdByItem[i.id].sales,0);
      const clsDeaths = mobs.reduce((s,i)=>s+ytdByItem[i.id].deaths,0);
      const headerRow = '<tr style="background:#1a2535">' +
        '<td style="padding:6px 12px;font-size:11px;font-weight:600;color:white" colspan="7">' + classLabel[cls] + '</td></tr>';
      const mobRows = mobs.map(i => {
        const ytd = ytdByItem[i.id];
        const opening = openingByItem[i.id] || 0;
        const closing = stockBalances[i.id] || 0;
        const attrs = i.attributes || {};
        const detail = [attrs.birth_year ? 'b.' + attrs.birth_year : '', attrs.subgroup || ''].filter(Boolean).join(' · ');
        return '<tr style="border-bottom:0.5px solid var(--border-light)" onmouseenter="this.style.background='var(--blue-light)'" onmouseleave="this.style.background=''">' +
          '<td style="padding:8px 12px;font-size:12px;color:var(--ink)">' + i.name + (detail ? '<div style="font-size:10px;color:var(--hint)">' + detail + '</div>' : '') + '</td>' +
          '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--hint)">' + (opening||'—') + '</td>' +
          '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--green)">' + (ytd.naturalIncrease ? '+'+fN(ytd.naturalIncrease) : '—') + '</td>' +
          '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--blue)">' + (ytd.purchases ? '+'+fN(ytd.purchases) : '—') + '</td>' +
          '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--amber)">' + (ytd.sales ? '-'+fN(ytd.sales) : '—') + '</td>' +
          '<td style="padding:8px 12px;text-align:right;font-size:12px;color:var(--red)">' + (ytd.deaths ? '-'+fN(ytd.deaths) : '—') + '</td>' +
          '<td style="padding:8px 12px;text-align:right;font-size:13px;font-weight:700;color:var(--ink)">' + fN(closing) + '</td>' +
          '</tr>';
      }).join('');
      const subtotalRow = '<tr style="background:var(--page-bg);border-top:1px solid var(--border)">' +
        '<td style="padding:6px 12px;font-size:11px;font-weight:600;color:var(--ink)">' + classLabel[cls] + ' total</td>' +
        '<td style="padding:6px 12px;text-align:right;font-size:11px;font-weight:600;color:var(--hint)">' + fN(clsOpening) + '</td>' +
        '<td style="padding:6px 12px;text-align:right;font-size:11px;font-weight:600;color:var(--green)">' + (clsNI?'+'+fN(clsNI):'—') + '</td>' +
        '<td style="padding:6px 12px;text-align:right;font-size:11px;font-weight:600;color:var(--blue)">' + (clsPurchases?'+'+fN(clsPurchases):'—') + '</td>' +
        '<td style="padding:6px 12px;text-align:right;font-size:11px;font-weight:600;color:var(--amber)">' + (clsSales?'-'+fN(clsSales):'—') + '</td>' +
        '<td style="padding:6px 12px;text-align:right;font-size:11px;font-weight:600;color:var(--red)">' + (clsDeaths?'-'+fN(clsDeaths):'—') + '</td>' +
        '<td style="padding:6px 12px;text-align:right;font-size:13px;font-weight:700;color:var(--ink)">' + fN(clsClosing) + '</td>' +
        '</tr>';
      return headerRow + mobRows + subtotalRow;
    }).join('');

    // ── Needs attention ───────────────────────────────────────
    const attentionItems = [];
    if (pendingAllocations) attentionItems.push({ level:'amber', title: pendingAllocations + ' livestock sale' + (pendingAllocations!==1?'s':'') + ' awaiting mob allocation', sub:'Go to Stocktake → Livestock to allocate', badge:'Action required' });
    if (pendingInvoices.length) attentionItems.push({ level:'amber', title: pendingInvoices.length + ' invoice' + (pendingInvoices.length!==1?'s':'') + ' pending Xero sync', sub:pendingInvoices.slice(0,2).map(i=>(i.buyer||'Invoice')+' · '+fM((parseFloat(i.gross_amount)||0)+(parseFloat(i.total_quality_adj)||0))).join(' · '), badge:'Pending' });
    cropRows.filter(r=>r.harvComplete).forEach(r => attentionItems.push({ level:'amber', title: r.name + ' harvest area incomplete', sub: fN(r.hvstArea) + ' ha harvested of ' + fN(r.budArea) + ' ha budgeted — check if complete', badge:'Check' }));
    const dotColor = { red:'var(--red)', amber:'var(--amber)', green:'var(--green)' };
    const badgeStyle = { red:'background:#fcebeb;color:#a32d2d', amber:'background:#faeeda;color:#854f0b', green:'background:#eaf3de;color:#3b6d11' };

    // ── Farm gate prices for this farm ────────────────────────
    const farmSites = [
      ...Object.entries(grainSites).map(([crop,site])=>({ crop, site })),
      ...(cottonRegion ? [{ crop:'Cotton Lint', site:cottonRegion }] : []),
    ];

    container.innerHTML = [
      // Header
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">',
      '<h2 style="font-size:var(--text-md);font-weight:600">Manager view — ' + season + '</h2>',
      '<div style="font-size:11px;color:var(--hint)">' + new Date().toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long'}) + '</div>',
      '</div>',

      // Needs attention
      attentionItems.length ? '<div class="card" style="margin-bottom:16px;overflow:hidden">' +
        '<div style="padding:10px 16px;border-bottom:0.5px solid var(--border);background:var(--page-bg)"><span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">⚡ Needs attention</span></div>' +
        attentionItems.map(item=>'<div style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:0.5px solid var(--border-light)">' +
          '<div style="width:7px;height:7px;border-radius:50%;background:'+dotColor[item.level]+';flex-shrink:0"></div>' +
          '<div style="flex:1"><div style="font-size:13px;font-weight:500;color:var(--ink)">'+item.title+'</div><div style="font-size:11px;color:var(--hint);margin-top:2px">'+item.sub+'</div></div>' +
          '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;'+badgeStyle[item.level]+'">'+item.badge+'</span></div>').join('') +
        '</div>' : '',

      // Main grid — two columns
      '<div style="display:grid;grid-template-columns:1fr 320px;gap:14px;align-items:start">',
      '<div>',

      // ── Livestock mob table ──
      stockItems.length ? [
        '<div class="card" style="overflow:hidden;margin-bottom:14px">',
        '<div style="padding:10px 16px;background:#1a2535;display:flex;align-items:center;justify-content:space-between">',
        '<span style="font-size:13px;font-weight:600;color:white">🐄 Livestock — ' + season + '</span>',
        '<div style="display:flex;gap:14px;font-size:11px">',
        '<span style="color:rgba(255,255,255,.6)">Opening <strong style="color:white">'+fN(totalOpening)+' hd</strong></span>',
        totalNI ? '<span style="color:#86efac">NI +'+fN(totalNI)+'</span>' : '',
        totalPurchases ? '<span style="color:#93c5fd">Purchases +'+fN(totalPurchases)+'</span>' : '',
        totalSales ? '<span style="color:#fcd34d">Sales -'+fN(totalSales)+'</span>' : '',
        totalDeaths ? '<span style="color:#fca5a5">Deaths -'+fN(totalDeaths)+'</span>' : '',
        '<span style="color:rgba(255,255,255,.6)">Closing <strong style="color:white">'+fN(totalOnHand)+' hd</strong></span>',
        '</div></div>',
        '<table style="width:100%;border-collapse:collapse">',
        '<thead><tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">',
        ['Mob','Opening','Nat. inc.','Purchases','Sales','Deaths','Closing'].map((h,i) =>
          '<th style="padding:6px '+(i===0?'12':'8')+'px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:'+(i===0?'left':'right')+'">'+h+'</th>'
        ).join(''),
        '</tr></thead><tbody>',
        mobTableRows || '<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--hint)">No livestock data — enter opening balances in Stocktake</td></tr>',
        '</tbody>',
        // Grand total
        '<tfoot><tr style="background:var(--page-bg);border-top:2px solid var(--border)">',
        '<td style="padding:8px 12px;font-size:12px;font-weight:700;color:var(--ink)">Total</td>',
        '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:700">'+fN(totalOpening)+'</td>',
        '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--green)">'+(totalNI?'+'+fN(totalNI):'—')+'</td>',
        '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--blue)">'+(totalPurchases?'+'+fN(totalPurchases):'—')+'</td>',
        '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--amber)">'+(totalSales?'-'+fN(totalSales):'—')+'</td>',
        '<td style="padding:8px 12px;text-align:right;font-size:12px;font-weight:700;color:var(--red)">'+(totalDeaths?'-'+fN(totalDeaths):'—')+'</td>',
        '<td style="padding:8px 12px;text-align:right;font-size:14px;font-weight:700;color:var(--ink)">'+fN(totalOnHand)+'</td>',
        '</tr>',
        // Livestock sales summary if any
        lsGross ? '<tr style="background:#eaf3de"><td style="padding:6px 12px;font-size:11px;color:var(--green)" colspan="3">Livestock sales YTD: '+fM(lsGross)+' gross</td>' +
          '<td style="padding:6px 12px;text-align:right;font-size:11px;color:var(--green)" colspan="2">'+fN(lsHead)+' head sold</td>' +
          '<td style="padding:6px 12px;text-align:right;font-size:11px;color:var(--green)" colspan="2">'+fM(lsAvgPerHead)+'/hd avg</td></tr>' : '',
        '</tfoot></table></div>',
      ].join('') : '',

      // ── Cropping summary ──
      cropRows.length ? [
        '<div class="card" style="overflow:hidden;margin-bottom:14px">',
        '<div style="padding:10px 16px;background:var(--page-bg);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">',
        '<span style="font-size:13px;font-weight:600;color:var(--ink)">🌾 Cropping — ' + season + '</span>',
        '<span style="font-size:11px;color:var(--hint)">Budget vs actual</span></div>',
        '<table style="width:100%;border-collapse:collapse">',
        '<thead><tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">',
        ['Commodity','Bud. ha','Hvst. ha','Bud. yield','Act. yield','Contracted','Avg $','Invoiced','Market'].map((h,i)=>
          '<th style="padding:6px '+(i===0?'12':'8')+'px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:'+(i===0?'left':'right')+'">'+h+'</th>'
        ).join(''),
        '</tr></thead><tbody>',
        cropRows.map((r,i) => {
          const hvstPct = r.budArea ? Math.round(r.hvstArea/r.budArea*100) : null;
          const yieldVarPct = r.hvstYield && r.budYield ? Math.round((r.hvstYield-r.budYield)/r.budYield*100) : null;
          const incompleteFlag = r.harvComplete ? ' <span style="font-size:9px;padding:1px 5px;background:#faeeda;color:#854f0b;border-radius:4px;margin-left:4px">⚠ partial</span>' : '';
          return '<tr style="border-bottom:0.5px solid var(--border-light);'+(i%2===1?'background:var(--page-bg)':'')+'" onmouseenter="this.style.background='var(--blue-light)'" onmouseleave="this.style.background=''+(i%2===1?'var(--page-bg)':'')+''">' +
            '<td style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--ink)">'+r.name+incompleteFlag+'</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:var(--hint)">'+fN(r.budArea)+' ha</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:'+(r.hvstArea?'var(--green)':'var(--hint)')+'">'+
              (r.hvstArea ? fN(r.hvstArea)+' ha'+(hvstPct&&hvstPct<99?' <span style="font-size:10px;opacity:.7">'+hvstPct+'%</span>':'') : '—')+'</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:var(--hint)">'+fN2(r.budYield)+' '+r.unit+'/ha</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:'+(r.hvstYield?(yieldVarPct>=0?'var(--green)':'var(--red)'):'var(--hint)')+'">'+
              (r.hvstYield ? fN2(r.hvstYield)+' '+r.unit+'/ha'+(yieldVarPct!=null?' <span style="font-size:10px">'+(yieldVarPct>=0?'+':'')+yieldVarPct+'%</span>':'') : r.fcstProd ? '<span style="color:var(--amber)">fcst '+fN(r.fcstProd)+' '+r.unit+'</span>' : '—')+'</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:var(--blue)">'+fN(r.contractedQty)+' '+r.unit+'</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:var(--ink)">'+fC(r.avgContractPrice)+'</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:var(--green)">'+fM(r.comInvoicedRev)+'</td>' +
            '<td style="padding:8px 8px;text-align:right;font-size:12px;color:var(--hint)">'+
              (r.mkt ? fC(r.mkt.price)+'/'+r.unit : '—')+'</td>' +
            '</tr>';
        }).join(''),
        '</tbody></table></div>',
      ].join('') : '',

      // ── Contract status ──
      contracts.length ? [
        '<div class="card" style="overflow:hidden;margin-bottom:14px">',
        '<div style="padding:10px 16px;background:var(--page-bg);border-bottom:1px solid var(--border)">',
        '<span style="font-size:13px;font-weight:600;color:var(--ink)">📋 Contract status</span></div>',
        contracts.map(c => {
          const invQty = invoices.filter(i=>i.forward_contract_id===c.id).reduce((s,i)=>{
            if(i.batches){const b=typeof i.batches==='string'?JSON.parse(i.batches):i.batches;return s+b.filter(bt=>(bt.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa')).reduce((ss,bt)=>ss+(parseFloat(bt.qty)||0),0);}
            return s+(parseFloat(i.total_qty)||0);
          },0);
          const qty=parseFloat(c.quantity)||0; const pct=qty?Math.round(invQty/qty*100):0;
          const status=c.is_complete?'Complete':invQty===0?'Not started':'Filling';
          const sc=c.is_complete?'var(--green)':invQty===0?'var(--hint)':'var(--blue)';
          return '<div style="display:flex;align-items:center;padding:9px 14px;border-bottom:0.5px solid var(--border-light);font-size:12px;gap:10px">' +
            '<div style="flex:1"><span style="font-weight:600">'+c.contract_number+'</span> <span style="color:var(--hint)">'+idToName[c.commodity_id]+'</span></div>' +
            '<div style="color:var(--hint);min-width:120px">'+fN(invQty)+' / '+fN(qty)+' '+(c.unit||'')+'</div>' +
            '<div style="min-width:80px"><div style="height:4px;background:var(--border-light);border-radius:2px;overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+(c.is_complete?'var(--green)':'var(--blue)')+';border-radius:2px"></div></div><div style="font-size:10px;color:var(--hint);margin-top:2px">'+pct+'%</div></div>' +
            '<div style="color:'+sc+';font-weight:500;min-width:80px;text-align:right">'+status+'</div>' +
            '</div>';
        }).join('') +
        '</div>',
      ].join('') : '',

      '</div>', // end left column

      // ── Right sidebar — farm gate prices ──
      '<div>',
      farmSites.length ? [
        '<div class="card" style="overflow:hidden;margin-bottom:14px">',
        '<div style="padding:10px 14px;border-bottom:0.5px solid var(--border);background:var(--page-bg)">',
        '<span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Farm gate prices</span></div>',
        '<div style="padding:10px 12px">',
        farmSites.map(({crop, site}) => {
          const com = commodityList.find(c=>c.name===crop);
          if (!com) return '';
          const data = priceMap[com.id]?.[site];
          const prev = allPrices.filter(p=>p.commodity_id===com.id&&p.region===site);
          const move = prev.length>=2 ? data?.price - parseFloat(prev[1].price_per_unit) : null;
          return '<div style="padding:8px 10px;border-radius:6px;background:var(--blue-light);margin-bottom:6px">' +
            '<div style="font-size:12px;font-weight:600;color:var(--blue-text)">'+crop+'</div>' +
            '<div style="font-size:10px;color:var(--blue);margin-bottom:4px">'+site+'</div>' +
            '<div style="display:flex;align-items:center;justify-content:space-between">' +
            '<span style="font-size:16px;font-weight:700;color:var(--blue-text)">'+(data?fC(data.price)+'/'+(data.unit||'t'):'No price')+'</span>' +
            (move!=null?'<span style="font-size:11px;color:'+(move>=0?'var(--green)':'var(--red)')+'">'+( move>=0?'▲':'▼')+fC(Math.abs(move))+'</span>':'') +
            '</div>' +
            (data?'<div style="font-size:9px;color:var(--blue);margin-top:2px">'+data.date+'</div>':'') +
            '</div>';
        }).join('') +
        '</div></div>',
      ].join('') : '',
      '</div>', // end right column
      '</div>', // end grid
    ].join('');

  } catch(err) {
    console.error('Manager view error:', err);
    container.innerHTML = '<div class="empty-state"><p>Error loading manager view: ' + err.message + '</p></div>';
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
      <div style="display:grid;grid-template-columns:130px 1fr 90px 90px 90px;gap:0;padding:10px 18px;border-bottom:0.5px solid var(--border-light);align-items:center;font-size:12px"
        onmouseenter="this.style.background='var(--blue-light)'" onmouseleave="this.style.background=''">
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