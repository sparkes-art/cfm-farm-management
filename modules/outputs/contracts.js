// modules/outputs/contracts.js
// Forward Contracts — list, add, edit, delete, PDF AI extraction

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatCurrency, formatDate, qs, setContent, currentSeason } from '../../js/ui.js';
import { loadCommodities, getCommodities, getCropTypes, commodityOptions, isLivestock, commoditySelectHTML, initCommoditySelect } from '../../js/commodities.js';

let _contracts = [];
let _unsub = null;

// ── Entry point ───────────────────────────────────────────────
export async function mountContracts(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Forward Contracts</h1>
        <p class="page-subtitle">Sales contracts by crop year and commodity</p>
      </div>
      <div class="flex gap-2">
        <select id="con-year-filter" class="form-select" style="width:120px">
          <option value="">All years</option>
        </select>
        <select id="con-commodity-filter" class="form-select" style="width:130px">
          <option value="">All commodities</option>
          ${getCommodities().map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
        ${canWrite() ? '<button class="btn btn-primary" id="btn-new-contract">＋ New contract</button>' : ''}
      </div>
    </div>

    <div class="stats-strip" id="con-stats"></div>

    <div class="card">
      <div class="card-header">
        <h2>Contracts</h2>
        <span id="con-count" class="text-muted text-sm"></span>
      </div>
      <div id="con-table-wrap">
        <div class="empty-state"><div class="empty-icon">📋</div><p>Loading contracts…</p></div>
      </div>
    </div>
  `;

  await loadCommodities();
  await _loadData();
  _renderStats();
  _renderTable();
  _bindFilters(container);
  _subscribeRealtime();

  if (canWrite()) {
    qs('#btn-new-contract', container)?.addEventListener('click', () => openContractModal());
  }
}

export function unmountContracts() {
  if (_unsub) { _unsub(); _unsub = null; }
  _contracts = [];
}

// ── Data ──────────────────────────────────────────────────────
async function _loadData() {
  const farm = getActiveFarm();
  if (!farm) { _contracts = []; return; }
  _contracts = await dbSelect('forward_contracts',
    `farm_id=eq.${farm.id}&select=*&order=sale_date.desc`);
  _populateYearFilter();
}

function _populateYearFilter() {
  const sel = qs('#con-year-filter');
  if (!sel) return;
  const years = [...new Set(_contracts.map(c => c.crop_year).filter(Boolean))].sort().reverse();
  // Clear existing options except first
  while (sel.options.length > 1) sel.remove(1);
  years.forEach(y => {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    sel.appendChild(opt);
  });
}

function _filtered() {
  const year = qs('#con-year-filter')?.value || '';
  const commodity = qs('#con-commodity-filter')?.value || '';
  return _contracts.filter(c =>
    (!year || c.crop_year === year) &&
    (!commodity || c.commodity === commodity)
  );
}

// ── Realtime ──────────────────────────────────────────────────
function _subscribeRealtime() {
  const farm = getActiveFarm();
  if (!farm) return;
  _unsub = subscribeTable('forward_contracts', farm.id, async (event, payload) => {
    if (event === 'INSERT') {
      if (!_contracts.find(c => c.id === payload.record.id)) _contracts.unshift(payload.record);
    }
    else if (event === 'UPDATE') {
      const i = _contracts.findIndex(c => c.id === payload.record.id);
      if (i >= 0) _contracts[i] = payload.record;
    } else if (event === 'DELETE') {
      _contracts = _contracts.filter(c => c.id !== payload.old_record.id);
    }
    _populateYearFilter();
    _renderStats();
    _renderTable();
  });
}

// ── Render stats ──────────────────────────────────────────────
function _renderStats() {
  const rows = _filtered();
  const totalUnits = rows.reduce((s, c) => s + (parseFloat(c.quantity) || 0), 0);
  const totalValue = rows.reduce((s, c) => s + ((parseFloat(c.quantity) || 0) * (parseFloat(c.price_per_unit) || 0)), 0);
  const commodities = [...new Set(rows.map(c => c.commodity).filter(Boolean))];

  setContent('#con-stats', `
    <div class="stat-card">
      <div class="stat-label">Total contracts</div>
      <div class="stat-value earth">${rows.length}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total units sold</div>
      <div class="stat-value">${totalUnits.toLocaleString('en-AU', {maximumFractionDigits: 1})}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total contract value</div>
      <div class="stat-value grass">${formatCurrency(totalValue, 0)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Commodities</div>
      <div class="stat-value">${commodities.length > 0 ? commodities.map(c => `<span class="badge badge-${c}">${_cap(c)}</span>`).join(' ') : '—'}</div>
    </div>
  `);
}

// ── Render table ──────────────────────────────────────────────
function _renderTable() {
  const rows = _filtered();
  const wrap = qs('#con-table-wrap');
  if (!wrap) return;

  setContent('#con-count', `${rows.length} contract${rows.length !== 1 ? 's' : ''}`);

  if (!rows.length) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <p>No contracts yet. Add your first contract or upload a PDF to extract details automatically.</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Contract #</th>
          <th>Crop year</th>
          <th>Commodity</th>
          <th>Buyer</th>
          <th>Grade / Spec</th>
          <th>Sale date</th>
          <th class="num">Units sold</th>
          <th class="num">Price / unit</th>
          <th class="num">Total value</th>
          <th>Delivery</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(c => {
          const value = (parseFloat(c.quantity) || 0) * (parseFloat(c.price_per_unit) || 0);
          const delivery = c.delivery_start
            ? `${formatDate(c.delivery_start)}${c.delivery_end ? ` – ${formatDate(c.delivery_end)}` : ''}`
            : '—';
          return `
            <tr data-id="${c.id}" style="cursor:pointer">
              <td><strong>${c.contract_number || '—'}</strong></td>
              <td class="muted">${c.crop_year || '—'}</td>
              <td><span class="badge badge-${c.commodity}">${_cap(c.commodity || 'other')}</span></td>
              <td>${c.counterparty || '—'}</td>
              <td class="muted">${c.grade_spec || '—'}</td>
              <td class="muted">${formatDate(c.sale_date)}</td>
              <td class="num">${c.quantity ? `${parseFloat(c.quantity).toLocaleString('en-AU')} ${c.unit || ''}` : '—'}</td>
              <td class="num">${c.price_per_unit ? formatCurrency(c.price_per_unit, 4) : '—'}</td>
              <td class="num"><strong>${value ? formatCurrency(value, 0) : '—'}</strong></td>
              <td class="muted" style="font-size:var(--text-xs)">${delivery}</td>
              ${canWrite() ? `
                <td>
                  <div class="flex gap-2">
                    <button class="btn btn-ghost btn-sm edit-btn" data-id="${c.id}">Edit</button>
                    <button class="btn btn-ghost btn-sm delete-btn" data-id="${c.id}" style="color:#DC2626">Delete</button>
                  </div>
                </td>` : ''}
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  // Row click → detail view
  wrap.querySelectorAll('tbody tr').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.edit-btn') || e.target.closest('.delete-btn')) return;
      const contract = _contracts.find(c => c.id === row.dataset.id);
      if (contract) _openDetailModal(contract);
    });
  });

  // Edit
  wrap.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contract = _contracts.find(c => c.id === btn.dataset.id);
      if (contract) openContractModal(contract);
    });
  });

  // Delete
  wrap.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const contract = _contracts.find(c => c.id === btn.dataset.id);
      if (contract) _confirmDelete(contract);
    });
  });
}

function _bindFilters(container) {
  ['#con-year-filter', '#con-commodity-filter'].forEach(sel => {
    qs(sel, container)?.addEventListener('change', () => {
      _renderStats();
      _renderTable();
    });
  });
}

// ── Contract modal (Add / Edit) ───────────────────────────────
export function openContractModal(existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;

  const { overlay } = openModal({
    title: isEdit ? `Edit Contract ${existing.contract_number || ''}` : 'New Forward Contract',
    confirmLabel: isEdit ? 'Save changes' : 'Add contract',
    bodyHTML: `
      <!-- PDF Upload section (new contracts only) -->
      ${!isEdit ? `
        <div class="card" style="margin-bottom:18px;border:2px dashed var(--rule);box-shadow:none">
          <div class="card-body" style="padding:14px">
            <p class="text-sm" style="font-weight:600;margin-bottom:6px">
              📄 Upload contract PDF
            </p>
            <p class="form-helper" style="margin-bottom:10px">
              Upload a PDF and AI will extract the contract details automatically. You can review and edit before saving.
            </p>
            <div class="flex gap-2 items-center">
              <input type="file" id="pdf-upload" accept=".pdf" style="font-size:var(--text-sm);flex:1">
              <button class="btn btn-secondary" id="btn-extract" type="button">Extract details</button>
            </div>
            <div id="extract-status" class="form-helper mt-1" style="min-height:18px"></div>
          </div>
        </div>
      ` : ''}

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Crop year </label>
          <input class="form-input" id="f-crop-year" type="text" value="${existing?.crop_year || currentSeason()}" placeholder="2024-25">
        </div>
        <div class="form-group">
          <label class="form-label">Commodity </label>
          <select class="form-select" id="f-commodity">
            <option value="">Select…</option>
            ${commodityOptions(existing?.commodity_id)}
          </select>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Contract number </label>
          <input class="form-input" id="f-contract-number" type="text" value="${existing?.contract_number || ''}" placeholder="e.g. AWB-2024-0042">
        </div>
        <div class="form-group">
          <label class="form-label">Buyer </label>
          <input class="form-input" id="f-buyer" type="text" value="${existing?.counterparty || ''}" placeholder="e.g. Olam Agri, AWB">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Grade / Spec</label>
          <input class="form-input" id="f-grade" type="text" value="${existing?.grade_spec || ''}" placeholder="e.g. SJ458, APW, Feed">
        </div>
        <div class="form-group">
          <label class="form-label">Sale date </label>
          <input class="form-input" id="f-sale-date" type="date" value="${existing?.sale_date || ''}">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Units sold </label>
          <input class="form-input num" id="f-quantity" type="number" step="0.001" value="${existing?.quantity || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Unit</label>
          <select class="form-select" id="f-unit">
            <option value="tonne" ${(existing?.unit || 'tonne') === 'tonne' ? 'selected' : ''}>tonne</option>
            <option value="bale"  ${existing?.unit === 'bale'  ? 'selected' : ''}>bale</option>
            <option value="kg"    ${existing?.unit === 'kg'    ? 'selected' : ''}>kg</option>
            <option value="head"  ${existing?.unit === 'head'  ? 'selected' : ''}>head</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Price per unit </label>
          <input class="form-input num" id="f-price" type="number" step="0.0001" value="${existing?.price_per_unit || ''}">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Total contract value</label>
        <div id="f-total-display" class="font-mono" style="font-size:var(--text-xl);color:var(--earth);padding:4px 0">—</div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Delivery start</label>
          <input class="form-input" id="f-delivery-start" type="date" value="${existing?.delivery_start || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Delivery end</label>
          <input class="form-input" id="f-delivery-end" type="date" value="${existing?.delivery_end || ''}">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="f-notes" rows="3" placeholder="Any additional contract terms or notes…">${existing?.notes || ''}</textarea>
      </div>

      ${existing?.pdf_filename ? `
        <div class="form-helper mt-2">
          📎 Attached: ${existing.pdf_filename}
        </div>
      ` : ''}
    `,
    onConfirm: async () => {
      const row = _gatherForm(farm, existing);
      if (!row) return;

      if (isEdit) {
        await dbUpdate('forward_contracts', existing.id, row);
        toast('Contract updated', 'success');
      } else {
        await dbInsert('forward_contracts', row);
        toast('Contract added', 'success');
      }
      await _loadData(); _renderStats(); _renderTable();
    },
  });

  // Init inline commodity select
  initCommoditySelect('f-commodity', (commodityId, commodity) => {
    // Could update UI based on commodity type here if needed
  });

  // Live total calculation
  const qty = qs('#f-quantity', overlay);
  const price = qs('#f-price', overlay);
  const totalDisplay = qs('#f-total-display', overlay);

  const updateTotal = () => {
    const t = (parseFloat(qty?.value || 0)) * (parseFloat(price?.value || 0));
    totalDisplay.textContent = t > 0 ? formatCurrency(t, 0) : '—';
  };
  qty?.addEventListener('input', updateTotal);
  price?.addEventListener('input', updateTotal);
  updateTotal();

  // PDF extraction
  qs('#btn-extract', overlay)?.addEventListener('click', () => _extractFromPDF(overlay));
}

// ── PDF AI Extraction ─────────────────────────────────────────
async function _extractFromPDF(overlay) {
  const fileInput = qs('#pdf-upload', overlay);
  const statusEl = qs('#extract-status', overlay);
  const file = fileInput?.files?.[0];

  if (!file) {
    statusEl.textContent = 'Please select a PDF file first.';
    statusEl.style.color = '#DC2626';
    return;
  }

  statusEl.textContent = 'Reading PDF…';
  statusEl.style.color = 'var(--muted)';
  qs('#btn-extract', overlay).disabled = true;

  try {
    // Convert PDF to base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    statusEl.textContent = 'Extracting contract details with AI…';

    // Call via Netlify function (API key stays server-side)
    const response = await fetch('/api/extract-contract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_base64: base64 }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${response.status}`);
    }

    const extracted = await response.json();

    // Populate the form fields
    const set = (id, val) => {
      const el = qs(`#${id}`, overlay);
      if (el && val != null) el.value = val;
    };

    set('f-contract-number', extracted.contract_number);
    set('f-buyer', extracted.counterparty);
    set('f-grade', extracted.grade_spec);
    set('f-sale-date', extracted.sale_date);
    set('f-quantity', extracted.quantity);
    set('f-price', extracted.price_per_unit);
    set('f-delivery-start', extracted.delivery_start);
    set('f-delivery-end', extracted.delivery_end);
    set('f-notes', extracted.notes);

    if (extracted.commodity) {
      const sel = qs('#f-commodity', overlay);
      if (sel) sel.value = extracted.commodity;
    }
    if (extracted.unit) {
      const sel = qs('#f-unit', overlay);
      if (sel) sel.value = extracted.unit;
    }

    // Trigger total recalculation
    qs('#f-quantity', overlay)?.dispatchEvent(new Event('input'));

    // Store filename for saving with record
    overlay._pdfFilename = file.name;

    statusEl.textContent = '✓ Details extracted — please review and adjust before saving.';
    statusEl.style.color = 'var(--grass)';

  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.color = '#DC2626';
  } finally {
    qs('#btn-extract', overlay).disabled = false;
  }
}

// ── Gather form data ──────────────────────────────────────────
function _gatherForm(farm, existing) {
  const v = (id) => qs(`#${id}`)?.value?.trim() || '';
  const n = (id) => parseFloat(qs(`#${id}`)?.value || 0) || null;

  const cropYear = v('f-crop-year');
  const commodityId = v('f-commodity');
  const contractNumber = v('f-contract-number');
  const buyer = v('f-buyer');
  const saleDate = v('f-sale-date');
  const quantity = n('f-quantity');
  const price = n('f-price');

  // Get commodity name for display
  const commodities = getCommodities();
  const commodity = commodities.find(c => c.id === commodityId);

  // No required fields — contracts can be entered with partial information

  return {
    farm_id: farm.id,
    crop_year: cropYear,
    commodity_id: commodityId,
    commodity: commodity?.name || null,
    contract_number: contractNumber,
    counterparty: buyer,
    grade_spec: v('f-grade') || null,
    sale_date: saleDate,
    quantity: quantity,
    unit: v('f-unit') || 'tonne',
    price_per_unit: price,
    delivery_start: v('f-delivery-start') || null,
    delivery_end: v('f-delivery-end') || null,
    notes: v('f-notes') || null,
    pdf_filename: document.querySelector('#pdf-upload')?.files?.[0]?.name || existing?.pdf_filename || null,
    created_by: getSession()?.user?.id,
  };
}

// ── Detail view ───────────────────────────────────────────────
function _openDetailModal(c) {
  const value = (parseFloat(c.quantity) || 0) * (parseFloat(c.price_per_unit) || 0);
  const delivery = c.delivery_start
    ? `${formatDate(c.delivery_start)}${c.delivery_end ? ` to ${formatDate(c.delivery_end)}` : ''}`
    : '—';

  openModal({
    title: `Contract ${c.contract_number || ''}`,
    confirmLabel: canWrite() ? 'Edit contract' : null,
    onConfirm: canWrite() ? async () => openContractModal(c) : null,
    confirmClass: 'btn-secondary',
    bodyHTML: `
      <div class="form-row">
        <div>
          <p class="text-xs text-muted">Crop year</p>
          <p><strong>${c.crop_year || '—'}</strong></p>
        </div>
        <div>
          <p class="text-xs text-muted">Commodity</p>
          <p><span class="badge badge-${c.commodity}">${_cap(c.commodity || 'other')}</span></p>
        </div>
        <div>
          <p class="text-xs text-muted">Sale date</p>
          <p>${formatDate(c.sale_date)}</p>
        </div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div>
          <p class="text-xs text-muted">Buyer</p>
          <p><strong>${c.counterparty || '—'}</strong></p>
        </div>
        <div>
          <p class="text-xs text-muted">Grade / Spec</p>
          <p>${c.grade_spec || '—'}</p>
        </div>
      </div>
      <hr class="divider">
      <div class="form-row mt-2">
        <div>
          <p class="text-xs text-muted">Units sold</p>
          <p class="font-mono">${c.quantity ? `${parseFloat(c.quantity).toLocaleString('en-AU')} ${c.unit}` : '—'}</p>
        </div>
        <div>
          <p class="text-xs text-muted">Price per ${c.unit || 'unit'}</p>
          <p class="font-mono">${formatCurrency(c.price_per_unit, 4)}</p>
        </div>
        <div>
          <p class="text-xs text-muted">Total value</p>
          <p class="font-mono" style="font-size:var(--text-xl);color:var(--earth)"><strong>${formatCurrency(value, 0)}</strong></p>
        </div>
      </div>
      <hr class="divider">
      <div class="mt-2">
        <p class="text-xs text-muted">Delivery period</p>
        <p>${delivery}</p>
      </div>
      ${c.notes ? `
        <div class="mt-2">
          <p class="text-xs text-muted">Notes</p>
          <p class="text-sm">${c.notes}</p>
        </div>
      ` : ''}
      ${c.pdf_filename ? `
        <hr class="divider">
        <p class="form-helper">📎 ${c.pdf_filename}</p>
      ` : ''}
    `,
  });
}

// ── Delete ────────────────────────────────────────────────────
function _confirmDelete(contract) {
  openModal({
    title: 'Delete contract',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger',
    bodyHTML: `
      <p>Are you sure you want to delete contract <strong>${contract.contract_number || contract.id}</strong>?</p>
      <p class="text-sm text-muted mt-2">This cannot be undone. Any invoices linked to this contract will lose the price reference.</p>
    `,
    onConfirm: async () => {
      await dbDelete('forward_contracts', contract.id);
      toast('Contract deleted', 'success');
      await _loadData(); _renderStats(); _renderTable();
    },
  });
}

function _cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
