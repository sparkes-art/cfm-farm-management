// modules/outputs/outputs.js
// Outputs module — invoice management, commodity-first flow
// Cotton / grain / pulse / livestock + forward contract auto-fill

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite } from '../../js/app-state.js';
import {
  toast, openModal, formatCurrency, formatDate,
  commodityBadge, statusBadge, qs, setContent, currentSeason
} from '../../js/ui.js';

let _invoices = [];
let _contracts = [];
let _unsub = null;

// ── Entry point ───────────────────────────────────────────────
export async function mountOutputs(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Outputs</h1>
        <p class="page-subtitle">Sales invoices and commodity income</p>
      </div>
      <div class="flex gap-2">
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

export function unmountOutputs() {
  if (_unsub) { _unsub(); _unsub = null; }
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

  // Row click → view detail
  wrap.querySelectorAll('tbody tr').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('edit-btn')) return;
      const inv = _invoices.find(i => i.id === row.dataset.id);
      if (inv) openInvoiceDetail(inv);
    });
  });

  // Edit buttons
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

      <hr class="divider">

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
    `,
    onConfirm: async (modal) => {
      const row = _gatherForm(modal, farm, existing);
      if (!row) return; // validation failed

      if (isEdit) {
        await dbUpdate('invoices', existing.id, row);
        toast('Invoice updated', 'success');
      } else {
        await dbInsert('invoices', row);
        toast('Invoice created', 'success');
      }
      // Realtime will update the list; if not connected, reload
      await _loadData(); _renderStats(); _renderTable();
    },
  });

  // Live gross calculation
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

  // Contract auto-fill price
  qs('#f-contract', overlay)?.addEventListener('change', (e) => {
    const opt = e.target.options[e.target.selectedIndex];
    const p = opt.dataset.price;
    if (p) { price.value = p; updateGross(); }
  });

  // Hide contract section for livestock
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
    cotton_region: commodityType === 'cotton' ? (farm.settings?.cottonRegion || null) : null,
    status: val('f-status'),
    created_by: getSession()?.user?.id,
  };
}

// ── Invoice detail view ───────────────────────────────────────
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
          <p class="text-xs text-muted" style="margin-bottom:2px">Farm</p>
          <p><strong>${getActiveFarm()?.name}</strong></p>
        </div>
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Status</p>
          <p>${statusBadge(inv.status)}</p>
        </div>
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Date</p>
          <p>${formatDate(inv.invoice_date)}</p>
        </div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Commodity</p>
          <p>${commodityBadge(inv.commodity_type)} ${inv.commodity_detail || ''}</p>
        </div>
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Buyer</p>
          <p><strong>${inv.buyer}</strong>${inv.buyer_abn ? `<span class="text-xs text-muted"> ABN ${inv.buyer_abn}</span>` : ''}</p>
        </div>
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Season</p>
          <p>${inv.season || '—'}</p>
        </div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Quantity</p>
          <p class="font-mono">${inv.quantity} ${inv.unit}</p>
        </div>
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Price per ${inv.unit}</p>
          <p class="font-mono">${formatCurrency(inv.price_per_unit, 4)}</p>
        </div>
        <div>
          <p class="text-xs text-muted" style="margin-bottom:2px">Gross</p>
          <p class="font-mono"><strong>${formatCurrency(inv.gross_amount)}</strong></p>
        </div>
      </div>
      ${inv.net_amount !== inv.gross_amount ? `
        <div class="mt-2">
          <p class="text-xs text-muted">Net (after deductions)</p>
          <p class="font-mono" style="font-size:var(--text-xl);color:var(--earth)"><strong>${formatCurrency(inv.net_amount)}</strong></p>
        </div>
      ` : ''}
      ${contract ? `
        <hr class="divider">
        <div class="mt-2">
          <p class="text-xs text-muted" style="margin-bottom:4px">Forward contract</p>
          <p>${contract.contract_number || 'Contract'} with ${contract.counterparty || '—'} @ ${formatCurrency(contract.price_per_unit, 4)}/${contract.unit}</p>
        </div>
      ` : ''}
      ${inv.xero_invoice_id ? `
        <hr class="divider">
        <div class="mt-2 text-xs text-muted">Xero ID: ${inv.xero_invoice_id}</div>
      ` : ''}
    `,
  });
}
