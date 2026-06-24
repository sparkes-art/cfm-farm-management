// modules/outputs/outputs.js
// Outputs module — tabbed: Contracts + Invoices
 
import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite } from '../../js/app-state.js';
import {
  toast, openModal, formatCurrency, formatDate,
  commodityBadge, statusBadge, qs, setContent, currentSeason
} from '../../js/ui.js';
import { mountContracts, unmountContracts } from './contracts.js';
import { mountMarketPrices } from './market-prices.js';
 
let _invoices = [];
let _contracts = [];
let _unsub = null;
let _activeTab = 'overview';
 
// ── Entry point ───────────────────────────────────────────────
export async function mountOutputs(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Outputs</h1>
        <p class="page-subtitle">Sales contracts and invoices</p>
      </div>
    </div>
 
    <div style="display:flex;gap:0;margin-bottom:20px;border-bottom:2px solid var(--rule)">
      <button class="tab-btn" data-tab="contracts" style="padding:8px 20px;background:none;border:none;border-bottom:2px solid var(--earth);margin-bottom:-2px;font-size:var(--text-sm);font-weight:600;color:var(--earth);cursor:pointer">
        Contracts
      </button>
<button class="tab-btn" data-tab="prices" style="padding:8px 20px;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;font-size:var(--text-sm);font-weight:500;color:var(--muted);cursor:pointer">
        Market Prices
      </button>
      <button class="tab-btn" data-tab="invoices" style="padding:8px 20px;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;font-size:var(--text-sm);font-weight:500;color:var(--muted);cursor:pointer">
        Invoices
      </button>
    </div>
 
    <div id="tab-content"></div>
  `;
 
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === _activeTab);
      });
      _loadTab();
    });
  });
 
  _loadTab();
}
 
export function unmountOutputs() {
  unmountContracts();
  if (_unsub) { _unsub(); _unsub = null; }
}
 
async function _loadTab() {
  const content = qs('#tab-content');
  if (!content) return;
  if (_activeTab === 'overview') {
    await _mountOverview(content);
  } else if (_activeTab === 'contracts') {
    await mountContracts(content);
  } else if (_activeTab === 'prices') {
    await mountMarketPrices(content);
  } else {
    await _mountInvoices(content);
  }
}
 
async function _mountOverview(container) {
  const farm = getActiveFarm();
  const season = qs('#out-season-select')?.value || currentSeason();
 
  container.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';
 
  try {
    const [contracts, invoices] = await Promise.all([
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
    ]);
 
    const totalContractValue = contracts.reduce((s, c) => s + ((parseFloat(c.quantity)||0) * (parseFloat(c.price_per_unit)||0)), 0);
    const totalInvoiced = invoices.reduce((s, i) => s + (parseFloat(i.net_amount || i.gross_amount)||0), 0);
    const totalPaid = invoices.filter(i => i.status === 'paid').reduce((s, i) => s + (parseFloat(i.net_amount || i.gross_amount)||0), 0);
    const contractCount = contracts.length;
 
    const byCommodity = {};
    contracts.forEach(c => {
      const key = c.commodity || 'Other';
      if (!byCommodity[key]) byCommodity[key] = { contracts: 0, quantity: 0, value: 0, unit: c.unit || 'tonne' };
      byCommodity[key].contracts++;
      byCommodity[key].quantity += parseFloat(c.quantity) || 0;
      byCommodity[key].value += (parseFloat(c.quantity)||0) * (parseFloat(c.price_per_unit)||0);
    });
 
    let html = '<div class="stats-strip" style="grid-template-columns:repeat(4,1fr)">';
    html += '<div class="stat-card"><div class="stat-label">Forward contracts</div><div class="stat-value">' + contractCount + '</div></div>';
    html += '<div class="stat-card"><div class="stat-label">Contract value</div><div class="stat-value blue">' + formatCurrency(totalContractValue, 0) + '</div></div>';
    html += '<div class="stat-card"><div class="stat-label">Total invoiced</div><div class="stat-value">' + formatCurrency(totalInvoiced, 0) + '</div></div>';
    html += '<div class="stat-card"><div class="stat-label">Paid to date</div><div class="stat-value green">' + formatCurrency(totalPaid, 0) + '</div></div>';
    html += '</div>';
 
    if (Object.keys(byCommodity).length) {
      html += '<div class="card" style="margin-bottom:16px">';
      html += '<div class="card-header"><h2>Commodity position \u2014 ' + season + '</h2><span class="text-hint text-sm">Full hedging position cards coming soon</span></div>';
      html += '<table class="data-table"><thead><tr>';
      html += '<th>Commodity</th><th class="num">Contracts</th><th class="num">Units contracted</th><th class="num">Contract value</th><th class="num">Avg price</th>';
      html += '</tr></thead><tbody>';
      Object.entries(byCommodity).forEach(([name, data]) => {
        html += '<tr>';
        html += '<td><strong>' + name + '</strong></td>';
        html += '<td class="num">' + data.contracts + '</td>';
        html += '<td class="num">' + formatNumber(data.quantity, 0) + ' ' + data.unit + '</td>';
        html += '<td class="num"><strong>' + formatCurrency(data.value, 0) + '</strong></td>';
        html += '<td class="num">' + (data.quantity ? formatCurrency(data.value / data.quantity, 2) : '\u2014') + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    } else {
      html += '<div class="card"><div class="card-body"><div class="empty-state">';
      html += '<div class="empty-icon">\ud83d\udce6</div>';
      html += '<p>No contracts recorded for ' + season + ' yet.</p>';
      html += '<p>Switch to the Contracts tab to add your first forward contract.</p>';
      html += '</div></div></div>';
    }
 
    if (invoices.length) {
      html += '<div class="card"><div class="card-header"><h2>Recent invoices</h2>';
      html += '<button class="btn btn-ghost btn-sm" onclick="document.querySelector(\'[data-tab=invoices]\')?.click()">View all \u2192</button></div>';
      html += '<table class="data-table"><thead><tr>';
      html += '<th>Invoice #</th><th>Commodity</th><th>Buyer</th><th>Date</th><th class="num">Amount</th><th>Status</th>';
      html += '</tr></thead><tbody>';
      invoices.slice(0, 5).forEach(inv => {
        html += '<tr>';
        html += '<td><strong>' + inv.invoice_number + '</strong></td>';
        html += '<td>' + commodityBadge(inv.commodity_type) + '</td>';
        html += '<td class="muted">' + (inv.buyer || '\u2014') + '</td>';
        html += '<td class="muted">' + formatDate(inv.invoice_date) + '</td>';
        html += '<td class="num"><strong>' + formatCurrency(inv.net_amount ?? inv.gross_amount) + '</strong></td>';
        html += '<td>' + statusBadge(inv.status) + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }
 
    container.innerHTML = html;
 
  } catch (err) {
    container.innerHTML = '<div class="empty-state"><p>Failed to load overview: ' + err.message + '</p></div>';
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
      ${canWrite() ? '<button class="btn btn-primary" id="btn-new-invoice">＋ New Invoice</button>' : ''}
    </div>
 
    <div class="stats-strip" id="out-stats"></div>
 
    <div class="card">
      <div class="card-header">
        <h2>Invoices</h2>
        <span id="out-count" class="text-muted text-sm"></span>
      </div>
      <div id="out-table-wrap">
        <div class="empty-state">
          <div class="empty-icon">📄</div>
          <p>Loading invoices…</p>
        </div>
      </div>
    </div>
  `;
 
  await _loadData();
  _renderStats();
  _renderTable();
  _bindFilters(container);
  _subscribeRealtime();
 
  if (canWrite()) {
    qs('#btn-new-invoice', container)?.addEventListener('click', () => openInvoiceModal());
  }
}
 
// ── Data loading ──────────────────────────────────────────────
async function _loadData() {
  const farm = getActiveFarm();
  if (!farm) return;
 
  [_invoices, _contracts] = await Promise.all([
    dbSelect('invoices', `farm_id=eq.${farm.id}&select=*&order=invoice_date.desc`),
    dbSelect('forward_contracts', `farm_id=eq.${farm.id}&select=*`),
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
 
// ── Realtime ──────────────────────────────────────────────────
function _subscribeRealtime() {
  const farm = getActiveFarm();
  if (!farm) return;
  _unsub = subscribeTable('invoices', farm.id, async (event, payload) => {
    if (event === 'INSERT') {
      _invoices.unshift(payload.record);
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
 
// ── Render ────────────────────────────────────────────────────
function _renderStats() {
  const filtered = _filtered();
  const total = filtered.reduce((s, i) => s + (parseFloat(i.net_amount || i.gross_amount) || 0), 0);
  const paid  = filtered.filter(i => i.status === 'paid').reduce((s, i) => s + (parseFloat(i.net_amount || i.gross_amount) || 0), 0);
  const draft = filtered.filter(i => i.status === 'draft').length;
  const issued = filtered.filter(i => i.status === 'issued').length;
 
  setContent('#out-stats', `
    <div class="stat-card">
      <div class="stat-label">Total invoiced</div>
      <div class="stat-value earth">${formatCurrency(total, 0)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Paid</div>
      <div class="stat-value grass">${formatCurrency(paid, 0)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Issued (unpaid)</div>
      <div class="stat-value">${formatCurrency(total - paid, 0)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Draft / Issued</div>
      <div class="stat-value">${draft} / ${issued}</div>
    </div>
  `);
}
 
function _renderTable() {
  const rows = _filtered();
  const wrap = qs('#out-table-wrap');
  if (!wrap) return;
 
  setContent('#out-count', `${rows.length} invoice${rows.length !== 1 ? 's' : ''}`);
 
  if (!rows.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌾</div>
        <p>No invoices yet. Create your first invoice to get started.</p>
      </div>`;
    return;
  }
 
  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Invoice #</th>
          <th>Date</th>
          <th>Season</th>
          <th>Commodity</th>
          <th>Buyer</th>
          <th class="num">Qty</th>
          <th class="num">Price / unit</th>
          <th class="num">Net amount</th>
          <th>Status</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(inv => `
          <tr data-id="${inv.id}" style="cursor:pointer">
            <td><strong>${inv.invoice_number}</strong></td>
            <td class="muted">${formatDate(inv.invoice_date)}</td>
            <td class="muted">${inv.season || '—'}</td>
            <td>${commodityBadge(inv.commodity_type)}${inv.commodity_detail ? `<span class="text-xs text-muted" style="margin-left:4px">${inv.commodity_detail}</span>` : ''}</td>
            <td>${inv.buyer}</td>
            <td class="num">${inv.quantity} ${inv.unit}</td>
            <td class="num">${formatCurrency(inv.price_per_unit, 4)}</td>
            <td class="num"><strong>${formatCurrency(inv.net_amount ?? inv.gross_amount)}</strong></td>
            <td>${statusBadge(inv.status)}</td>
            ${canWrite() ? `<td><button class="btn btn-ghost btn-sm edit-btn" data-id="${inv.id}">Edit</button></td>` : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
 
  wrap.querySelectorAll('tbody tr').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('edit-btn')) return;
      const inv = _invoices.find(i => i.id === row.dataset.id);
      if (inv) openInvoiceDetail(inv);
    });
  });
 
  wrap.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const inv = _invoices.find(i => i.id === btn.dataset.id);
      if (inv) openInvoiceModal(inv);
    });
  });
}
 
function _bindFilters(container) {
  ['#out-season-filter', '#out-commodity-filter'].forEach(sel => {
    qs(sel, container)?.addEventListener('change', () => {
      _renderStats();
      _renderTable();
    });
  });
}
 
// ── Invoice Modal (New / Edit) ────────────────────────────────
export function openInvoiceModal(existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;
 
  const contractOptions = _contracts
    .map(c => `<option value="${c.id}" data-price="${c.price_per_unit}" ${existing?.forward_contract_id === c.id ? 'selected' : ''}>
      ${c.contract_number || 'Contract'} — ${c.commodity} @ ${formatCurrency(c.price_per_unit, 4)}/${c.unit}
    </option>`)
    .join('');
 
  const { overlay } = openModal({
    title: isEdit ? `Edit Invoice ${existing.invoice_number}` : 'New Invoice',
    confirmLabel: isEdit ? 'Save changes' : 'Create invoice',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Commodity type <span class="required">*</span></label>
          <select class="form-select" id="f-commodity-type" required>
            <option value="">Select commodity…</option>
            <option value="cotton"    ${existing?.commodity_type === 'cotton'    ? 'selected' : ''}>Cotton</option>
            <option value="grain"     ${existing?.commodity_type === 'grain'     ? 'selected' : ''}>Grain</option>
            <option value="pulse"     ${existing?.commodity_type === 'pulse'     ? 'selected' : ''}>Pulse</option>
            <option value="livestock" ${existing?.commodity_type === 'livestock' ? 'selected' : ''}>Livestock</option>
            <option value="other"     ${existing?.commodity_type === 'other'     ? 'selected' : ''}>Other</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Variety / Grade / Breed</label>
          <input class="form-input" id="f-commodity-detail" type="text" value="${existing?.commodity_detail || ''}" placeholder="e.g. SJ458 / Feed Wheat / Angus">
        </div>
      </div>
 
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Invoice number <span class="required">*</span></label>
          <input class="form-input" id="f-invoice-number" type="text" value="${existing?.invoice_number || ''}" placeholder="INV-2024-001" required>
        </div>
        <div class="form-group">
          <label class="form-label">Invoice date <span class="required">*</span></label>
          <input class="form-input" id="f-invoice-date" type="date" value="${existing?.invoice_date || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Season</label>
          <input class="form-input" id="f-season" type="text" value="${existing?.season || currentSeason()}" placeholder="2024-25">
        </div>
      </div>
 
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Buyer <span class="required">*</span></label>
          <input class="form-input" id="f-buyer" type="text" value="${existing?.buyer || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Buyer ABN</label>
          <input class="form-input" id="f-buyer-abn" type="text" value="${existing?.buyer_abn || ''}">
        </div>
      </div>
 
      <div id="contract-section" class="${existing?.commodity_type === 'livestock' ? 'hidden' : ''}">
        <div class="form-group">
          <label class="form-label">Forward contract <span class="text-muted" style="font-weight:400;text-transform:none">(optional)</span></label>
          <select class="form-select" id="f-contract">
            <option value="">Cash sale — no contract</option>
            ${contractOptions}
          </select>
          <p class="form-helper">Selecting a contract auto-fills the price but it can be overridden below.</p>
        </div>
      </div>
 
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Quantity <span class="required">*</span></label>
          <input class="form-input num" id="f-quantity" type="number" step="0.001" value="${existing?.quantity || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="f-unit">
            <option value="tonne"  ${(existing?.unit || 'tonne') === 'tonne'  ? 'selected' : ''}>tonne</option>
            <option value="kg"     ${existing?.unit === 'kg'     ? 'selected' : ''}>kg</option>
            <option value="bale"   ${existing?.unit === 'bale'   ? 'selected' : ''}>bale</option>
            <option value="head"   ${existing?.unit === 'head'   ? 'selected' : ''}>head</option>
            <option value="each"   ${existing?.unit === 'each'   ? 'selected' : ''}>each</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Price per unit <span class="required">*</span></label>
          <input class="form-input num" id="f-price" type="number" step="0.0001" value="${existing?.price_per_unit || ''}" required>
        </div>
      </div>
 
      <div class="form-group">
        <label class="form-label">Gross amount</label>
        <div id="f-gross-display" class="font-mono" style="font-size: var(--text-xl); color: var(--earth); padding: 4px 0;">—</div>
      </div>
 
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Sale type</label>
          <select class="form-select" id="f-sale-type">
            <option value="cash"     ${(existing?.sale_type || 'cash') === 'cash'     ? 'selected' : ''}>Cash sale</option>
            <option value="contract" ${existing?.sale_type === 'contract' ? 'selected' : ''}>Contract</option>
            <option value="pool"     ${existing?.sale_type === 'pool'     ? 'selected' : ''}>Pool</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="f-status">
            <option value="draft"  ${(existing?.status || 'draft')  === 'draft'  ? 'selected' : ''}>Draft</option>
            <option value="issued" ${existing?.status === 'issued' ? 'selected' : ''}>Issued</option>
            <option value="paid"   ${existing?.status === 'paid'   ? 'selected' : ''}>Paid</option>
            <option value="void"   ${existing?.status === 'void'   ? 'selected' : ''}>Void</option>
          </select>
        </div>
      </div>
    `,
    onConfirm: async (modal) => {
      const row = _gatherForm(modal, farm, existing);
      if (!row) return;
 
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
  const grossDisplay = qs('#f-gross-display', overlay);
 
  const updateGross = () => {
    const g = parseFloat(qty?.value || 0) * parseFloat(price?.value || 0);
    grossDisplay.textContent = isNaN(g) || g === 0 ? '—' : formatCurrency(g);
  };
  qty?.addEventListener('input', updateGross);
  price?.addEventListener('input', updateGross);
  updateGross();
 
  qs('#f-contract', overlay)?.addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    const p = opt.dataset.price;
    if (p) { price.value = p; updateGross(); }
  });
 
  qs('#f-commodity-type', overlay)?.addEventListener('change', (e) => {
    const isLivestock = e.target.value === 'livestock';
    qs('#contract-section', overlay)?.classList.toggle('hidden', isLivestock);
    if (isLivestock) {
      qs('#f-sale-type', overlay).value = 'cash';
      qs('#f-contract', overlay).value = '';
    }
  });
}
 
function _gatherForm(modal, farm, existing) {
  const val = (id) => qs(`#${id}`, modal)?.value?.trim() || '';
  const num = (id) => parseFloat(qs(`#${id}`, modal)?.value || 0);
 
  const commodityType = val('f-commodity-type');
  const invoiceNumber = val('f-invoice-number');
  const invoiceDate = val('f-invoice-date');
  const buyer = val('f-buyer');
  const quantity = num('f-quantity');
  const pricePerUnit = num('f-price');
 
  if (!commodityType || !invoiceNumber || !invoiceDate || !buyer || !quantity || !pricePerUnit) {
    toast('Please fill in all required fields', 'error');
    return null;
  }
 
  const contractId = val('f-contract') || null;
  const contract = contractId ? _contracts.find(c => c.id === contractId) : null;
  const gross = quantity * pricePerUnit;
  const deductions = existing?.deductions || [];
  const totalDeductions = deductions.reduce((s, d) => s + (d.amount || 0), 0);
 
  return {
    farm_id: farm.id,
    invoice_number: invoiceNumber,
    invoice_date: invoiceDate,
    season: val('f-season') || currentSeason(),
    commodity_type: commodityType,
    commodity_detail: val('f-commodity-detail') || null,
    buyer: buyer,
    buyer_abn: val('f-buyer-abn') || null,
    forward_contract_id: contractId,
    contract_price: contract?.price_per_unit || null,
    price_per_unit: pricePerUnit,
    unit: val('f-unit'),
    quantity: quantity,
    net_amount: gross - totalDeductions,
    deductions: deductions,
    sale_type: val('f-sale-type'),
    cotton_region: commodityType === 'cotton' ? (getActiveFarm().settings?.cottonRegion || null) : null,
    status: val('f-status'),
    created_by: getSession()?.user?.id,
  };
}
 
function openInvoiceDetail(inv) {
  const contract = inv.forward_contract_id
    ? _contracts.find(c => c.id === inv.forward_contract_id)
    : null;
 
  openModal({
    title: `Invoice ${inv.invoice_number}`,
    confirmLabel: canWrite() ? 'Edit invoice' : null,
    onConfirm: canWrite() ? async () => { openInvoiceModal(inv); } : null,
    confirmClass: 'btn-secondary',
    bodyHTML: `
      <div class="form-row">
        <div>
          <p class="text-xs text-muted">Status</p>
          <p>${statusBadge(inv.status)}</p>
        </div>
        <div>
          <p class="text-xs text-muted">Date</p>
          <p>${formatDate(inv.invoice_date)}</p>
        </div>
        <div>
          <p class="text-xs text-muted">Season</p>
          <p>${inv.season || '—'}</p>
        </div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div>
          <p class="text-xs text-muted">Commodity</p>
          <p>${commodityBadge(inv.commodity_type)} ${inv.commodity_detail || ''}</p>
        </div>
        <div>
          <p class="text-xs text-muted">Buyer</p>
          <p><strong>${inv.buyer}</strong>${inv.buyer_abn ? `<span class="text-xs text-muted"> ABN ${inv.buyer_abn}</span>` : ''}</p>
        </div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div>
          <p class="text-xs text-muted">Quantity</p>
          <p class="font-mono">${inv.quantity} ${inv.unit}</p>
        </div>
        <div>
          <p class="text-xs text-muted">Price per ${inv.unit}</p>
          <p class="font-mono">${formatCurrency(inv.price_per_unit, 4)}</p>
        </div>
        <div>
          <p class="text-xs text-muted">Net amount</p>
          <p class="font-mono" style="font-size:var(--text-xl);color:var(--earth)"><strong>${formatCurrency(inv.net_amount ?? inv.gross_amount)}</strong></p>
        </div>
      </div>
      ${contract ? `
        <hr class="divider">
        <div class="mt-2">
          <p class="text-xs text-muted">Forward contract</p>
          <p>${contract.contract_number || 'Contract'} — ${formatCurrency(contract.price_per_unit, 4)}/${contract.unit}</p>
        </div>
      ` : ''}
    `,
  });
}