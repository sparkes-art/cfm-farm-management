// modules/outputs/outputs.js
// Outputs module — Dashboard, Contracts, Market Prices, Invoices

import { dbSelect, dbInsert, dbUpdate, dbDelete, dbUpsert, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite, getActiveSeason } from '../../js/app-state.js';
import {
  toast, openModal, formatCurrency, formatDate,
  commodityBadge, statusBadge, qs, setContent, currentSeason, formatNumber
} from '../../js/ui.js';
import { mountContracts, unmountContracts } from './contracts.js';
import { mountInvoices, unmountInvoices, openInvoiceForm } from './invoices.js';
import { mountReconciliation, unmountReconciliation } from './reconciliation.js';
import { mountMarketPrices, unmountMarketPrices } from './market-prices.js';
import { buildCommodityCards, drawMiniCharts, buildContractPosition, buildOperationsSummary, buildLivestockPosition } from './commodity-card.js';
import { loadCommodities } from '../../js/commodities.js';

let _invoices = [];
let _contracts = [];
let _unsub = null;
let _activeTab = 'overview';

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
      <button class="tab-btn" data-tab="overview" style="font-weight:600">Dashboard</button>
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
  const onSeasonChange = () => { if (_activeTab === 'overview') _loadTab(); };
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
  if (_activeTab === 'overview') {
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

// ── Dashboard / Overview ──────────────────────────────────────
async function _mountOverview(container) {
  const farm = getActiveFarm();
  if (!farm) {
    container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span><p style="margin-top:12px">Loading farm data…</p></div>';
    return;
  }

  const season = getActiveSeason() || currentSeason();
  container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';

  try {
    await loadCommodities();

    const [contracts, invoices, budgets, harvests, lsInvoices] = await Promise.all([
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&master_unit=neq.head&select=id,gross_amount,total_quality_adj,total_qty,forward_contract_id,batches,season,status'),
      dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=area_ha,budgeted_production,budgeted_yield_per_ha,yield_per_ha'),
      dbSelect('harvest_entries', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=area_ha,actual_production'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&master_unit=eq.head&select=total_qty,gross_amount,season,livestock_lines'),
    ]);

    // ── Commodity metrics ────────────────────────────────────
    const totalContractedValue = contracts.reduce((s,c) => s + (parseFloat(c.quantity)||0)*(parseFloat(c.price_per_unit)||0), 0);
    let invoicedQty = 0, invoicedRev = 0;
    invoices.forEach(inv => {
      if (inv.batches) {
        const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
        b.forEach(bt => {
          const sl = (bt.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa');
          if (sl.length) invoicedQty += parseFloat(bt.qty)||0;
          invoicedRev += sl.reduce((s,l)=>s+(parseFloat(l.amount)||0),0);
        });
      } else {
        invoicedRev += (parseFloat(inv.gross_amount)||0)+(parseFloat(inv.total_quality_adj)||0);
      }
    });
    const pctInvoiced = totalContractedValue ? Math.round(invoicedRev/totalContractedValue*100) : 0;

    // ── Operations metrics ───────────────────────────────────
    const totalBudgetHa = budgets.reduce((s,b)=>s+(parseFloat(b.area_ha)||0),0);
    const hvstProd = harvests.reduce((s,h)=>s+(parseFloat(h.actual_production)||0),0);
    const hvstHa   = harvests.reduce((s,h)=>s+(parseFloat(h.area_ha)||0),0);
    const hvstYield = hvstHa ? hvstProd/hvstHa : null;
    const budYieldWt = budgets.reduce((s,b)=>s+(parseFloat(b.budgeted_yield_per_ha||b.yield_per_ha)||0)*(parseFloat(b.area_ha)||0),0);
    const budYield = totalBudgetHa ? budYieldWt/totalBudgetHa : null;

    // ── Livestock metrics ────────────────────────────────────
    const lsFiltered = lsInvoices.filter(i => !season || i.season === season);
    const lsHead  = lsFiltered.reduce((s,i)=>s+(parseFloat(i.total_qty)||0),0);
    const lsGross = lsFiltered.reduce((s,i)=>s+(parseFloat(i.gross_amount)||0),0);
    const lsAvg   = lsHead ? lsGross/lsHead : null;

    // ── Contracts metrics ────────────────────────────────────
    const totalContracts = contracts.length;
    const completeContracts = contracts.filter(c=>c.is_complete).length;
    const remainingValue = totalContractedValue - invoicedRev;

    const fM = (n) => n == null ? '—' : n >= 1e6 ? '$' + (n/1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n/1e3).toFixed(0) + 'k' : '$' + n.toFixed(0);
    const fN = (n,dp=0) => n == null ? '—' : formatNumber(n,dp);

    const cardStyle = 'background:white;border-radius:var(--radius-xl);padding:20px 24px;cursor:pointer;border:1px solid var(--border);transition:box-shadow .15s;position:relative;overflow:hidden';
    const hintStyle = 'font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:6px;font-weight:600';
    const bigStyle  = 'font-size:26px;font-weight:700;color:var(--ink);letter-spacing:-.02em;margin-bottom:4px';
    const subStyle  = 'font-size:12px;color:var(--hint)';

    const html = `
    <div style="margin-bottom:18px">
      <h2 style="font-size:var(--text-md);font-weight:600;color:var(--ink)">${season} — Farm overview</h2>
      <p style="font-size:12px;color:var(--hint);margin-top:2px">Click any card to view details</p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">

      <!-- Commodity sales -->
      <div style="${cardStyle}" data-nav="invoices"
        onmouseenter="this.style.boxShadow='0 4px 16px rgba(0,0,0,.1)'" onmouseleave="this.style.boxShadow=''">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:var(--blue)"></div>
        <div style="${hintStyle}">🌾 Commodity sales</div>
        <div style="${bigStyle}">${fM(invoicedRev)}</div>
        <div style="${subStyle}">
          <span style="color:var(--blue);font-weight:600">${fM(totalContractedValue)}</span> contracted
          · <span style="color:${pctInvoiced>=80?'var(--green)':'var(--ink)'};font-weight:600">${pctInvoiced}%</span> invoiced
        </div>
        <div style="margin-top:12px;height:4px;background:var(--border-light);border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${Math.min(100,pctInvoiced)}%;background:var(--green);border-radius:2px;transition:width .4s"></div>
        </div>
      </div>

      <!-- Contracts -->
      <div style="${cardStyle}" data-nav="contracts"
        onmouseenter="this.style.boxShadow='0 4px 16px rgba(0,0,0,.1)'" onmouseleave="this.style.boxShadow=''">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#6366f1"></div>
        <div style="${hintStyle}">📋 Contracts</div>
        <div style="${bigStyle}">${totalContracts} <span style="font-size:16px;font-weight:500;color:var(--hint)">contracts</span></div>
        <div style="${subStyle}">
          <span style="color:var(--green);font-weight:600">${completeContracts} complete</span>
          · <span style="color:var(--blue);font-weight:600">${fM(remainingValue)}</span> remaining
        </div>
        <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
          ${[...new Set(contracts.map(c=>c.commodity).filter(Boolean))].map(com => {
            const comContracts = contracts.filter(c=>c.commodity===com);
            const comComplete = comContracts.filter(c=>c.is_complete).length;
            return `<span style="font-size:10px;background:var(--page-bg);border:1px solid var(--border);border-radius:4px;padding:2px 8px;color:var(--ink-mid)">${com} ${comComplete}/${comContracts.length}</span>`;
          }).join('')}
        </div>
      </div>

      <!-- Operations -->
      <div style="${cardStyle}" data-nav="overview-ops"
        onmouseenter="this.style.boxShadow='0 4px 16px rgba(0,0,0,.1)'" onmouseleave="this.style.boxShadow=''">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#f59e0b"></div>
        <div style="${hintStyle}">🚜 Operations</div>
        <div style="${bigStyle}">${fN(totalBudgetHa)} <span style="font-size:16px;font-weight:500;color:var(--hint)">ha budgeted</span></div>
        <div style="${subStyle}">
          ${hvstHa ? `<span style="color:var(--green);font-weight:600">${fN(hvstHa)} ha harvested</span> · ` : ''}
          ${hvstYield ? `<span style="color:var(--green);font-weight:600">${fN(hvstYield,2)} t/ha</span> avg yield` : budYield ? `<span style="color:var(--hint)">${fN(budYield,2)} t/ha</span> budget yield` : 'No harvest data yet'}
        </div>
        ${hvstYield && budYield ? `
        <div style="margin-top:10px;font-size:11px">
          <span style="color:${hvstYield>=budYield?'var(--green)':'var(--red)'};font-weight:600">
            ${hvstYield>=budYield?'▲':'▼'} ${Math.abs(Math.round((hvstYield-budYield)/budYield*100))}% vs budget
          </span>
        </div>` : ''}
      </div>

      <!-- Livestock -->
      <div style="${cardStyle}" data-nav="overview-livestock"
        onmouseenter="this.style.boxShadow='0 4px 16px rgba(0,0,0,.1)'" onmouseleave="this.style.boxShadow=''">
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:#10b981"></div>
        <div style="${hintStyle}">🐄 Livestock</div>
        <div style="${bigStyle}">${lsHead ? fN(lsHead) + ' <span style="font-size:16px;font-weight:500;color:var(--hint)">head</span>' : '—'}</div>
        <div style="${subStyle}">
          ${lsGross ? `<span style="color:var(--green);font-weight:600">${fM(lsGross)}</span> gross` : 'No sales this season'}
          ${lsAvg ? ` · <span style="font-weight:600">$${Math.round(lsAvg)}/head</span> avg` : ''}
        </div>
      </div>

    </div>`;

    container.innerHTML = html;

    // Wire card clicks — navigate to tabs or scroll to sections
    container.querySelectorAll('[data-nav]').forEach(card => {
      card.addEventListener('click', () => {
        const nav = card.dataset.nav;
        if (nav === 'invoices') {
          document.querySelector('[data-tab="invoices"]')?.click();
        } else if (nav === 'contracts') {
          document.querySelector('[data-tab="contracts"]')?.click();
        } else if (nav === 'overview-ops' || nav === 'overview-livestock') {
          // Load expanded overview with full sections visible
          _mountOverviewDetail(container, season, nav);
        }
      });
    });

  } catch(err) {
    console.error('Overview error:', err);
    container.innerHTML = '<div class="empty-state"><p>Error loading overview</p></div>';
  }
}

// ── Expanded detail view for ops/livestock ────────────────────
async function _mountOverviewDetail(container, season, section) {
  container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';
  await loadCommodities();
  let html = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <button class="btn btn-ghost btn-sm" id="back-to-overview">← Overview</button>
      <h2 style="font-size:var(--text-md);font-weight:600">${section === 'overview-ops' ? 'Operations summary' : 'Livestock sales'} — ${season}</h2>
    </div>`;
  if (section === 'overview-ops') {
    const { buildOperationsSummary: bos } = await import('./commodity-card.js');
    html += await bos(season);
  } else {
    const { buildLivestockPosition: blp } = await import('./commodity-card.js');
    html += await blp(season);
  }
  container.innerHTML = html;
  container.querySelector('#back-to-overview')?.addEventListener('click', () => _mountOverview(container));
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