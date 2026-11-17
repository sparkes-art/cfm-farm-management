// modules/inputs/inputs.js
// Inputs module — two tabs:
//   Procurement: supplier invoices → matched to stock delivery movements → WAC
//   Purchases:   simple cost entry for items not going through stocktake

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js?v=1794895290371';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js?v=1794895290371';
import { toast, openModal, formatCurrency, formatDate, qs, setContent } from '../../js/ui.js?v=1794895290371';

// ── module state ──────────────────────────────────────────────────────────────
let _tab        = 'procurement';   // 'procurement' | 'purchases'
let _invoices   = [];              // procurement_invoices rows
let _lines      = [];              // procurement_lines for the selected invoice
let _deliveries = [];              // unmatched delivery movements (stock_movements)
let _seedItems  = [];              // stock_items where is_seed=true
let _inputs     = [];              // input_purchases rows
let _unsubs     = [];

const CATEGORIES = ['fertiliser', 'chemical', 'seed', 'fuel', 'labour', 'other'];
const CAT_ICONS  = { fertiliser: '🌱', chemical: '🧪', seed: '🌾', fuel: '⛽', labour: '👷', other: '📦' };

// ── mount / unmount ───────────────────────────────────────────────────────────
export async function mountInputs(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Inputs</h1>
        <p class="page-subtitle">Supplier invoices, cost matching and input purchases</p>
      </div>
    </div>

    <div class="tab-bar" id="inp-tabs">
      <button class="tab-btn active" data-tab="procurement">🧾 Procurement</button>
      <button class="tab-btn" data-tab="purchases">📦 Purchases</button>
    </div>

    <div id="inp-body"></div>
  `;

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _tab = btn.dataset.tab;
      _renderTab();
    });
  });

  await _loadAll();
  _renderTab();
  _subscribeRealtime();
}

export function unmountInputs() {
  _unsubs.forEach(u => u && u());
  _unsubs = [];
  _invoices = []; _lines = []; _deliveries = []; _seedItems = []; _inputs = [];
}

// ── data loading ──────────────────────────────────────────────────────────────
async function _loadAll() {
  const farm = getActiveFarm();
  if (!farm) return;
  const season = getActiveSeason();

  [_invoices, _deliveries, _seedItems, _inputs] = await Promise.all([
    dbSelect('procurement_invoices',
      `farm_id=eq.${farm.id}&order=invoice_date.desc`),
    // Unmatched delivery movements for seed items this season
    dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&movement_type=eq.delivery&direction=eq.1` +
      `&select=id,occurred_on,qty,unit,note,source_ref,item_id,location_id,` +
      `stock_items(id,name,category,is_seed),delivery_costs(id)` +
      `&order=occurred_on.desc`),
    dbSelect('stock_items',
      `farm_id=eq.${farm.id}&is_seed=eq.true&active=eq.true&select=id,name,subgroup,default_unit&order=name`),
    dbSelect('input_purchases',
      `farm_id=eq.${farm.id}&order=purchase_date.desc`),
  ]);
}

async function _loadInvoiceLines(invoiceId) {
  _lines = await dbSelect('procurement_lines',
    `procurement_invoice_id=eq.${invoiceId}&select=*,delivery_costs(id,movement_id,total_cost,matched_at)`);
}

// ── tab router ────────────────────────────────────────────────────────────────
function _renderTab() {
  const body = qs('#inp-body');
  if (!body) return;
  if (_tab === 'procurement') _renderProcurement(body);
  else _renderPurchases(body);
}

// ══════════════════════════════════════════════════════════════════════════════
// PROCUREMENT TAB
// ══════════════════════════════════════════════════════════════════════════════
function _renderProcurement(body) {
  const unmatched = _invoices.filter(i => i.status === 'unmatched' || i.status === 'partial');
  const matched   = _invoices.filter(i => i.status === 'matched' || i.status === 'approved');

  // Unmatched deliveries (seed only for now)
  const unmatchedDels = _deliveries.filter(m =>
    m.stock_items?.is_seed && (!m.delivery_costs || m.delivery_costs.length === 0)
  );

  body.innerHTML = `
    ${unmatchedDels.length ? `
    <div class="alert alert-warning" style="margin-bottom:16px">
      ⚠️ <strong>${unmatchedDels.length} seed deliver${unmatchedDels.length === 1 ? 'y' : 'ies'}</strong>
      not yet matched to a supplier invoice — WAC cannot be calculated until matched.
    </div>` : ''}

    <div class="card" style="margin-bottom:16px">
      <div class="card-header">
        <h2>Supplier invoices</h2>
        <div class="flex gap-2">
          ${canWrite() ? '<button class="btn btn-primary btn-sm" id="btn-new-invoice">＋ New invoice</button>' : ''}
        </div>
      </div>

      ${!_invoices.length ? `
        <div class="empty-state">
          <div class="empty-icon">🧾</div>
          <p>No supplier invoices recorded yet.</p>
          ${canWrite() ? '<p class="text-muted text-sm">Add a supplier invoice, then match it to deliveries recorded in Stocktake.</p>' : ''}
        </div>
      ` : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Supplier</th>
              <th>Invoice #</th>
              <th>Date</th>
              <th class="num">Amount</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${_invoices.map(inv => `
              <tr>
                <td><strong>${inv.supplier}</strong></td>
                <td class="muted">${inv.invoice_number || '—'}</td>
                <td class="muted">${formatDate(inv.invoice_date)}</td>
                <td class="num">${inv.total_amount ? formatCurrency(inv.total_amount) : '—'}</td>
                <td>${_statusBadge(inv.status)}</td>
                <td>
                  <button class="btn btn-ghost btn-sm" onclick="window.__cfmOpenInvoice('${inv.id}')">
                    ${inv.status === 'matched' || inv.status === 'approved' ? 'View' : 'Match →'}
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>

    <div class="card" id="invoice-detail-panel" hidden></div>

    ${unmatchedDels.length ? `
    <div class="card">
      <div class="card-header">
        <h2>Unmatched seed deliveries</h2>
        <span class="text-muted text-sm">${unmatchedDels.length} awaiting invoice</span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Item</th>
            <th class="num">Qty</th>
            <th>Ref / Note</th>
          </tr>
        </thead>
        <tbody>
          ${unmatchedDels.map(m => `
            <tr>
              <td>${formatDate(m.occurred_on)}</td>
              <td><strong>${m.stock_items?.name || '—'}</strong></td>
              <td class="num">${m.qty} ${m.unit || ''}</td>
              <td class="muted">${m.source_ref || m.note || '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>` : ''}
  `;

  if (canWrite()) {
    qs('#btn-new-invoice')?.addEventListener('click', () => _openInvoiceModal());
  }

  window.__cfmOpenInvoice = (id) => _openInvoiceDetail(id);
}

function _statusBadge(status) {
  const map = {
    unmatched: ['badge-draft',   '⚪ Unmatched'],
    partial:   ['badge-warning', '🟡 Partial'],
    matched:   ['badge-active',  '🟢 Matched'],
    approved:  ['badge-active',  '✅ Approved'],
  };
  const [cls, label] = map[status] || ['badge-draft', status];
  return `<span class="badge ${cls}">${label}</span>`;
}

async function _openInvoiceDetail(invoiceId) {
  const inv = _invoices.find(i => i.id === invoiceId);
  if (!inv) return;

  await _loadInvoiceLines(invoiceId);

  const panel = qs('#invoice-detail-panel');
  if (!panel) return;
  panel.hidden = false;
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Deliveries not yet matched to any line on THIS invoice
  const availableDels = _deliveries.filter(m =>
    m.stock_items?.is_seed &&
    (!m.delivery_costs || m.delivery_costs.length === 0)
  );

  panel.innerHTML = `
    <div class="card-header">
      <h2>🧾 ${inv.supplier} — ${inv.invoice_number || formatDate(inv.invoice_date)}</h2>
      <div class="flex gap-2">
        ${canWrite() ? `<button class="btn btn-ghost btn-sm" id="btn-add-line">＋ Add line</button>` : ''}
        <button class="btn btn-ghost btn-sm" id="btn-close-detail">✕ Close</button>
      </div>
    </div>

    <div style="padding:16px">
      ${!_lines.length ? `
        <div class="empty-state" style="padding:24px">
          <p>No lines yet. Add a line for each product on this invoice.</p>
        </div>
      ` : `
        <table class="data-table" style="margin-bottom:16px">
          <thead>
            <tr>
              <th>Product</th>
              <th class="num">Qty invoiced</th>
              <th class="num">Unit cost</th>
              <th class="num">Line total</th>
              <th>Deliveries matched</th>
              ${canWrite() ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${_lines.map(line => {
              const matched = line.delivery_costs || [];
              const matchedTotal = matched.reduce((s, dc) => s + (parseFloat(dc.total_cost) || 0), 0);
              return `
                <tr>
                  <td><strong>${line.description}</strong></td>
                  <td class="num">${line.quantity_invoiced ? `${line.quantity_invoiced} ${line.unit || ''}` : '—'}</td>
                  <td class="num">${formatCurrency(line.unit_cost, 4)}</td>
                  <td class="num">${line.line_total ? formatCurrency(line.line_total) : '—'}</td>
                  <td>
                    ${matched.length
                      ? `<span class="badge badge-active">${matched.length} delivery${matched.length !== 1 ? 'ies' : ''} — ${formatCurrency(matchedTotal)}</span>`
                      : `<span class="badge badge-draft">None</span>`}
                    ${canWrite() && availableDels.length ? `
                      <button class="btn btn-ghost btn-sm" style="margin-left:8px"
                        onclick="window.__cfmMatchDelivery('${line.id}', '${line.unit_cost}')">
                        Match delivery
                      </button>` : ''}
                  </td>
                  ${canWrite() ? `<td><button class="btn btn-ghost btn-sm" onclick="window.__cfmEditLine('${line.id}')">Edit</button></td>` : ''}
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;

  qs('#btn-close-detail')?.addEventListener('click', () => {
    panel.hidden = true;
    panel.innerHTML = '';
  });

  if (canWrite()) {
    qs('#btn-add-line')?.addEventListener('click', () => _openLineModal(inv));
    window.__cfmMatchDelivery = (lineId, unitCost) => _openMatchModal(lineId, parseFloat(unitCost), availableDels);
    window.__cfmEditLine = (lineId) => {
      const line = _lines.find(l => l.id === lineId);
      if (line) _openLineModal(inv, line);
    };
  }
}

function _openInvoiceModal(existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;

  openModal({
    title: isEdit ? 'Edit supplier invoice' : 'New supplier invoice',
    confirmLabel: isEdit ? 'Save changes' : 'Add invoice',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Supplier <span class="required">*</span></label>
          <input class="form-input" id="pi-supplier" type="text"
            value="${existing?.supplier || ''}" placeholder="e.g. Seednet, Landmark, Elders" required>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Invoice number</label>
          <input class="form-input" id="pi-invno" type="text" value="${existing?.invoice_number || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Invoice date <span class="required">*</span></label>
          <input class="form-input" id="pi-date" type="date" value="${existing?.invoice_date || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Due date</label>
          <input class="form-input" id="pi-due" type="date" value="${existing?.due_date || ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Total amount (incl. GST)</label>
          <input class="form-input num" id="pi-total" type="number" step="0.01"
            value="${existing?.total_amount || ''}" placeholder="0.00">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-input" id="pi-notes" rows="2">${existing?.notes || ''}</textarea>
      </div>
    `,
    onConfirm: async () => {
      const v = id => qs(`#${id}`)?.value?.trim() || '';
      const supplier = v('pi-supplier');
      const invoiceDate = v('pi-date');
      if (!supplier || !invoiceDate) throw new Error('Supplier and invoice date are required');

      const row = {
        farm_id: farm.id,
        supplier,
        invoice_number: v('pi-invno') || null,
        invoice_date: invoiceDate,
        due_date: v('pi-due') || null,
        total_amount: parseFloat(v('pi-total')) || null,
        notes: v('pi-notes') || null,
        created_by: getSession()?.user?.id,
      };

      if (isEdit) {
        await dbUpdate('procurement_invoices', existing.id, row);
        toast('Invoice updated', 'success');
      } else {
        await dbInsert('procurement_invoices', row);
        toast('Invoice added', 'success');
      }
      await _loadAll();
      _renderTab();
    },
  });
}

function _openLineModal(invoice, existing = null) {
  const isEdit = !!existing;

  openModal({
    title: isEdit ? 'Edit invoice line' : 'Add invoice line',
    confirmLabel: isEdit ? 'Save' : 'Add line',
    bodyHTML: `
      <div class="form-group">
        <label class="form-label">Product / description <span class="required">*</span></label>
        <input class="form-input" id="pl-desc" type="text"
          value="${existing?.description || ''}" placeholder="e.g. Sicot 711 TI BG3 — 50kg bags" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Link to stock item</label>
          <select class="form-select" id="pl-item">
            <option value="">— not linked —</option>
            ${_seedItems.map(si =>
              `<option value="${si.id}" ${existing?.item_id === si.id ? 'selected' : ''}>${si.name}</option>`
            ).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Unit cost ($ per unit) <span class="required">*</span></label>
          <input class="form-input num" id="pl-ucost" type="number" step="0.0001"
            value="${existing?.unit_cost || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="pl-unit">
            ${['kg','tonne','bag','each','L'].map(u =>
              `<option ${(existing?.unit || 'kg') === u ? 'selected' : ''}>${u}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Qty invoiced</label>
          <input class="form-input num" id="pl-qty" type="number" step="0.001"
            value="${existing?.quantity_invoiced || ''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Line total (auto-calculated)</label>
        <input class="form-input num" id="pl-total" type="number" step="0.01"
          value="${existing?.line_total || ''}" placeholder="qty × unit cost">
      </div>
    `,
    onConfirm: async () => {
      const v = id => qs(`#${id}`)?.value?.trim() || '';
      const n = id => parseFloat(qs(`#${id}`)?.value || '') || null;
      const desc = v('pl-desc');
      const unitCost = n('pl-ucost');
      if (!desc || unitCost === null) throw new Error('Description and unit cost are required');

      const qty = n('pl-qty');
      const row = {
        procurement_invoice_id: invoice.id,
        farm_id: invoice.farm_id,
        item_id: v('pl-item') || null,
        description: desc,
        unit_cost: unitCost,
        unit: v('pl-unit') || null,
        quantity_invoiced: qty,
        line_total: qty && unitCost ? parseFloat((qty * unitCost).toFixed(2)) : n('pl-total'),
        gst_rate: 0.10,
      };

      if (isEdit) {
        await dbUpdate('procurement_lines', existing.id, row);
        toast('Line updated', 'success');
      } else {
        await dbInsert('procurement_lines', row);
        toast('Line added', 'success');
      }
      await _loadAll();
      await _loadInvoiceLines(invoice.id);
      _renderTab();
      // Re-open the detail panel
      setTimeout(() => _openInvoiceDetail(invoice.id), 50);
    },
  });

  // Auto-calc line total
  setTimeout(() => {
    const calcTotal = () => {
      const qty = parseFloat(qs('#pl-qty')?.value || 0);
      const uc  = parseFloat(qs('#pl-ucost')?.value || 0);
      if (qty && uc) {
        const t = qs('#pl-total');
        if (t) t.value = (qty * uc).toFixed(2);
      }
    };
    qs('#pl-qty')?.addEventListener('input', calcTotal);
    qs('#pl-ucost')?.addEventListener('input', calcTotal);
  }, 100);
}

function _openMatchModal(lineId, unitCost, availableDels) {
  const line = _lines.find(l => l.id === lineId);
  if (!line) return;

  openModal({
    title: 'Match delivery to invoice line',
    confirmLabel: 'Confirm match',
    bodyHTML: `
      <p class="text-muted text-sm" style="margin-bottom:12px">
        Select the delivery movement that corresponds to this invoice line.
        Unit cost <strong>${formatCurrency(unitCost, 4)}/kg</strong> will be applied.
      </p>
      <div class="form-group">
        <label class="form-label">Delivery movement <span class="required">*</span></label>
        <select class="form-select" id="pm-delivery" required>
          <option value="">— select delivery —</option>
          ${availableDels.map(m => `
            <option value="${m.id}" data-qty="${m.qty}">
              ${formatDate(m.occurred_on)} · ${m.stock_items?.name || '?'} · ${m.qty} ${m.unit || 'kg'}
              ${m.source_ref ? ` · ref: ${m.source_ref}` : ''}
            </option>
          `).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Qty matched (defaults to delivery qty)</label>
        <input class="form-input num" id="pm-qty" type="number" step="0.001" placeholder="auto">
        <p class="form-helper">Leave blank to use the full delivery quantity.</p>
      </div>
      <div id="pm-calc" class="form-helper" style="margin-top:8px"></div>
    `,
    onConfirm: async () => {
      const sel = qs('#pm-delivery');
      const movementId = sel?.value;
      if (!movementId) throw new Error('Please select a delivery');

      const selectedOpt = sel.options[sel.selectedIndex];
      const deliveryQty = parseFloat(selectedOpt.dataset.qty || 0);
      const matchQty    = parseFloat(qs('#pm-qty')?.value || 0) || deliveryQty;
      const totalCost   = parseFloat((matchQty * unitCost).toFixed(2));

      const farm = getActiveFarm();
      await dbInsert('delivery_costs', {
        farm_id: farm.id,
        movement_id: movementId,
        procurement_line_id: lineId,
        unit_cost: unitCost,
        total_cost: totalCost,
        matched_by: getSession()?.user?.id,
      });

      toast(`Matched — ${formatCurrency(totalCost)} cost applied`, 'success');
      await _loadAll();
      await _loadInvoiceLines(line.procurement_invoice_id);
      _renderTab();
      setTimeout(() => _openInvoiceDetail(line.procurement_invoice_id), 50);
    },
  });

  // Show calc preview
  setTimeout(() => {
    const updateCalc = () => {
      const sel = qs('#pm-delivery');
      const selectedOpt = sel?.options[sel?.selectedIndex];
      const dQty = parseFloat(selectedOpt?.dataset?.qty || 0);
      const mQty = parseFloat(qs('#pm-qty')?.value || 0) || dQty;
      const calc = qs('#pm-calc');
      if (calc && mQty && unitCost) {
        calc.textContent = `${mQty} × ${formatCurrency(unitCost, 4)} = ${formatCurrency(mQty * unitCost)} total cost`;
      }
    };
    qs('#pm-delivery')?.addEventListener('change', updateCalc);
    qs('#pm-qty')?.addEventListener('input', updateCalc);
  }, 100);
}

// ══════════════════════════════════════════════════════════════════════════════
// PURCHASES TAB (existing simple entry)
// ══════════════════════════════════════════════════════════════════════════════
function _renderPurchases(body) {
  const cat = qs('#inp-cat-filter')?.value || '';
  const rows = cat ? _inputs.filter(r => r.category === cat) : _inputs;
  const total = rows.reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0);

  body.innerHTML = `
    <div class="stats-strip" style="margin-bottom:16px">
      <div class="stat-card">
        <div class="stat-label">Total spend</div>
        <div class="stat-value earth">${formatCurrency(total, 0)}</div>
      </div>
      ${CATEGORIES.map(c => {
        const t = _inputs.filter(r => r.category === c).reduce((s, r) => s + (parseFloat(r.total_cost) || 0), 0);
        return t > 0 ? `<div class="stat-card"><div class="stat-label">${CAT_ICONS[c]} ${_cap(c)}</div><div class="stat-value">${formatCurrency(t, 0)}</div></div>` : '';
      }).join('')}
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Input purchases</h2>
        <div class="flex gap-2">
          <select id="inp-cat-filter" class="form-select" style="width:140px">
            <option value="">All categories</option>
            ${CATEGORIES.map(c => `<option value="${c}" ${cat === c ? 'selected' : ''}>${CAT_ICONS[c]} ${_cap(c)}</option>`).join('')}
          </select>
          ${canWrite() ? '<button class="btn btn-primary btn-sm" id="btn-new-purchase">＋ New purchase</button>' : ''}
        </div>
      </div>

      ${!rows.length ? `
        <div class="empty-state">
          <div class="empty-icon">📦</div>
          <p>No purchases recorded yet.</p>
        </div>
      ` : `
        <table class="data-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Product</th>
              <th>Supplier</th>
              <th>Date</th>
              <th class="num">Qty</th>
              <th class="num">Unit cost</th>
              <th class="num">Total</th>
              ${canWrite() ? '<th></th>' : ''}
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${CAT_ICONS[r.category]} <span class="badge badge-draft">${_cap(r.category)}</span></td>
                <td><strong>${r.product_name}</strong></td>
                <td class="muted">${r.supplier || '—'}</td>
                <td class="muted">${formatDate(r.purchase_date)}</td>
                <td class="num">${r.quantity ? `${r.quantity} ${r.unit || ''}` : '—'}</td>
                <td class="num">${r.unit_cost ? formatCurrency(r.unit_cost, 4) : '—'}</td>
                <td class="num"><strong>${formatCurrency(r.total_cost)}</strong></td>
                ${canWrite() ? `<td><button class="btn btn-ghost btn-sm" onclick="window.__cfmEditInput('${r.id}')">Edit</button></td>` : ''}
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  `;

  qs('#inp-cat-filter')?.addEventListener('change', () => _renderTab());

  if (canWrite()) {
    qs('#btn-new-purchase')?.addEventListener('click', () => _openPurchaseModal());
    window.__cfmEditInput = (id) => {
      const row = _inputs.find(r => r.id === id);
      if (row) _openPurchaseModal(row);
    };
  }
}

function _openPurchaseModal(existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;

  openModal({
    title: isEdit ? 'Edit purchase' : 'Record input purchase',
    confirmLabel: isEdit ? 'Save changes' : 'Record purchase',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Category <span class="required">*</span></label>
          <select class="form-select" id="i-category" required>
            ${CATEGORIES.map(c => `<option value="${c}" ${(existing?.category || 'fertiliser') === c ? 'selected' : ''}>${CAT_ICONS[c]} ${_cap(c)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Season</label>
          <input class="form-input" id="i-season" type="text" value="${existing?.season || getActiveSeason() || ''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Product name <span class="required">*</span></label>
        <input class="form-input" id="i-product" type="text" value="${existing?.product_name || ''}"
          placeholder="e.g. Urea 46%, Glyphosate 450" required>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Supplier</label>
          <input class="form-input" id="i-supplier" type="text" value="${existing?.supplier || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Date <span class="required">*</span></label>
          <input class="form-input" id="i-date" type="date" value="${existing?.purchase_date || ''}" required>
        </div>
        <div class="form-group">
          <label class="form-label">Invoice ref</label>
          <input class="form-input" id="i-ref" type="text" value="${existing?.invoice_reference || ''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Qty</label>
          <input class="form-input num" id="i-qty" type="number" step="0.001" value="${existing?.quantity || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="i-unit">
            ${['tonne','kg','L','mL','bag','drum','ha','each'].map(u =>
              `<option ${(existing?.unit || 'tonne') === u ? 'selected' : ''}>${u}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Unit cost</label>
          <input class="form-input num" id="i-unit-cost" type="number" step="0.0001" value="${existing?.unit_cost || ''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Total cost <span class="required">*</span></label>
        <input class="form-input num" id="i-total" type="number" step="0.01" value="${existing?.total_cost || ''}" required>
      </div>
    `,
    onConfirm: async () => {
      const v = id => qs(`#${id}`)?.value?.trim() || '';
      const n = id => parseFloat(qs(`#${id}`)?.value || 0) || null;
      const productName = v('i-product');
      const purchaseDate = v('i-date');
      const totalCost = n('i-total');
      if (!productName || !purchaseDate || !totalCost) throw new Error('Please fill in required fields');

      const row = {
        farm_id: farm.id,
        category: v('i-category'),
        product_name: productName,
        supplier: v('i-supplier') || null,
        purchase_date: purchaseDate,
        season: v('i-season') || getActiveSeason() || null,
        invoice_reference: v('i-ref') || null,
        quantity: n('i-qty'),
        unit: v('i-unit') || null,
        unit_cost: n('i-unit-cost'),
        total_cost: totalCost,
        created_by: getSession()?.user?.id,
      };

      if (isEdit) {
        await dbUpdate('input_purchases', existing.id, row);
        toast('Purchase updated', 'success');
      } else {
        await dbInsert('input_purchases', row);
        toast('Purchase recorded', 'success');
      }
      await _loadAll();
      _renderTab();
    },
  });

  setTimeout(() => {
    const calcTotal = () => {
      const qty = parseFloat(qs('#i-qty')?.value || 0);
      const uc  = parseFloat(qs('#i-unit-cost')?.value || 0);
      if (qty && uc) {
        const t = qs('#i-total');
        if (t && !t.value) t.value = (qty * uc).toFixed(2);
      }
    };
    qs('#i-qty')?.addEventListener('change', calcTotal);
    qs('#i-unit-cost')?.addEventListener('change', calcTotal);
  }, 100);
}

// ── realtime ──────────────────────────────────────────────────────────────────
function _subscribeRealtime() {
  const farm = getActiveFarm();
  if (!farm) return;

  _unsubs.push(subscribeTable('procurement_invoices', farm.id, async () => {
    await _loadAll();
    _renderTab();
  }));

  _unsubs.push(subscribeTable('input_purchases', farm.id, async () => {
    await _loadAll();
    _renderTab();
  }));
}

function _cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
