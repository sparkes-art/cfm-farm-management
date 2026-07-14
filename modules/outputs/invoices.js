// modules/outputs/invoices.js
// Full invoice management — contract sales, cash sales, line items, deductions

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js?v=1783290066771';
import { getActiveFarm, getSession, canWrite, getActiveSeason } from '../../js/app-state.js?v=1783290066771';
import { toast, openModal, formatCurrency, formatDate, commodityBadge, statusBadge, qs, currentSeason, formatNumber } from '../../js/ui.js?v=1783290066771';
import { getCommodities, loadCommodities } from '../../js/commodities.js?v=1783290066771';

let _invoices = [];
let _contracts = [];
let _unsub = null;

export async function mountInvoices(container) {
  const farm = getActiveFarm();
  if (!farm) return;
  await loadCommodities();

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
      <div style="display:flex;gap:8px">
        <select id="inv-filter-season" class="form-select" style="width:120px">
          <option value="">All seasons</option>
        </select>
        <select id="inv-filter-status" class="form-select" style="width:130px">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="complete">Complete</option>
        </select>
      </div>
      ${canWrite() ? '<button class="btn btn-primary" id="btn-new-invoice">＋ New invoice</button>' : ''}
    </div>

    <div class="card" id="inv-table-wrap">
      <div class="empty-state"><span class="loading-spinner"></span></div>
    </div>
  `;

  await _loadData();
  _renderTable(container);
  _subscribeRealtime();

  qs('#btn-new-invoice', container)?.addEventListener('click', () => openInvoiceForm(container));
  ['#inv-filter-season', '#inv-filter-status'].forEach(sel => {
    qs(sel, container)?.addEventListener('change', () => _renderTable(container));
  });
}

export function unmountInvoices() {
  if (_unsub) { _unsub(); _unsub = null; }
  _invoices = [];
  _contracts = [];
}

async function _loadData() {
  const farm = getActiveFarm();
  if (!farm) return;
  [_invoices, _contracts] = await Promise.all([
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.desc'),
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&select=*&order=sale_date.desc'),
  ]);
  // Populate season filter
  const sel = qs('#inv-filter-season');
  if (sel) {
    // Seasons from line items since season is stored at line item level
  const allSeasons = new Set();
  _invoices.forEach(i => {
    if (i.season) allSeasons.add(i.season);
    (i.line_items || []).forEach(l => { if (l.season) allSeasons.add(l.season); });
  });
  const seasons = [...allSeasons].sort().reverse();
    while (sel.options.length > 1) sel.remove(1);
    seasons.forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
  }
}

function _filtered() {
  const season = qs('#inv-filter-season')?.value || '';
  const status = qs('#inv-filter-status')?.value || '';
  return _invoices.filter(i => {
    const statusMatch = !status || i.status === status;
    if (!season) return statusMatch;
    // Check invoice season or any line item season
    const seasonMatch = i.season === season || (i.line_items || []).some(l => l.season === season);
    return seasonMatch && statusMatch;
  });
}

function _subscribeRealtime() {
  const farm = getActiveFarm();
  if (!farm) return;
  _unsub = subscribeTable('invoices', farm.id, async (event, payload) => {
    if (event === 'INSERT') { if (!_invoices.find(i => i.id === payload.record.id)) _invoices.unshift(payload.record); }
    else if (event === 'UPDATE') { const idx = _invoices.findIndex(i => i.id === payload.record.id); if (idx >= 0) _invoices[idx] = payload.record; }
    else if (event === 'DELETE') { _invoices = _invoices.filter(i => i.id !== payload.old_record.id); }
    _renderTable(document.getElementById('inv-table-wrap')?.closest('[id]'));
  });
}

function _renderTable(container) {
  const wrap = qs('#inv-table-wrap', container || document);
  if (!wrap) return;
  const rows = _filtered();

  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div><p>No invoices yet.</p><p>Click "＋ New invoice" to record your first sale.</p></div>';
    return;
  }

  const totalNet = rows.reduce((s, i) => s + (parseFloat(i.net_amount)||0), 0);
  const totalPending = rows.filter(i => i.status === 'pending').reduce((s, i) => s + (parseFloat(i.net_amount)||0), 0);
  const totalComplete = rows.filter(i => i.status === 'complete').reduce((s, i) => s + (parseFloat(i.net_amount)||0), 0);

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:0;border-bottom:1px solid var(--border-light)">
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Total invoiced</div>
        <div style="font-size:20px;font-weight:600;color:var(--ink)">${formatCurrency(totalNet, 0)}</div>
      </div>
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Pending</div>
        <div style="font-size:20px;font-weight:600;color:var(--amber)">${formatCurrency(totalPending, 0)}</div>
      </div>
      <div style="padding:12px 16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Complete</div>
        <div style="font-size:20px;font-weight:600;color:var(--green)">${formatCurrency(totalComplete, 0)}</div>
      </div>
    </div>
    <table class="data-table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Season</th>
          <th>Type</th>
          <th>Buyer</th>
          <th>Commodities</th>
          <th class="num">Gross</th>
          <th class="num">Net amount</th>
          <th>Xero ref</th>
          <th>Status</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(inv => {
          const lines = inv.line_items || [];
          const commodities = [...new Set(lines.map(l => l.commodity))].join(', ') || inv.commodity_type || '—';
          return `
            <tr style="cursor:pointer" data-id="${inv.id}">
              <td class="muted">${formatDate(inv.invoice_date)}</td>
              <td class="muted">${(() => {
                const seasons = [...new Set((inv.line_items||[]).map(l=>l.season).filter(Boolean))];
                return seasons.length ? seasons.join(', ') : (inv.season || '—');
              })()}</td>
              <td><span class="badge ${inv.sale_type === 'against_contract' ? 'badge-issued' : 'badge-draft'}">${inv.sale_type === 'against_contract' ? 'Contract' : 'Cash'}</span></td>
              <td><strong>${inv.buyer || '—'}</strong></td>
              <td class="muted text-sm">${commodities}</td>
              <td class="num">${formatCurrency(inv.gross_amount, 0)}</td>
              <td class="num"><strong>${formatCurrency(inv.net_amount, 0)}</strong></td>
              <td class="muted text-sm">
                ${canWrite() ? `<input class="xero-ref-input" data-id="${inv.id}" 
                  value="${inv.xero_invoice_number || ''}" 
                  placeholder="—"
                  style="border:none;background:transparent;color:var(--muted);font-size:var(--text-sm);width:100%;cursor:text;padding:0"
                  onfocus="this.style.background='var(--white)';this.style.border='1px solid var(--blue)';this.style.borderRadius='4px';this.style.padding='2px 6px'"
                  onblur="this.style.background='transparent';this.style.border='none';this.style.padding='0'"
                >` : inv.xero_invoice_number || '—'}
              </td>
              <td>
                <span class="badge ${inv.status === 'complete' ? 'badge-paid' : 'badge-amber'}" style="${inv.status !== 'complete' ? 'background:var(--amber-light);color:var(--amber-text)' : ''}">
                  ${inv.status === 'complete' ? 'Complete' : 'Pending'}
                </span>
              </td>
              ${canWrite() ? `
                <td>
                  <div class="flex gap-2">
                    <button class="btn btn-ghost btn-sm edit-inv-btn" data-id="${inv.id}">Edit</button>
                    ${inv.status === 'pending' && !inv.xero_invoice_number ? `
                      <button class="btn btn-ghost btn-sm push-xero-btn" data-id="${inv.id}" style="color:var(--blue)">Push to Xero</button>
                      <button class="btn btn-ghost btn-sm xero-btn" data-id="${inv.id}" style="color:var(--muted)">+ Xero ref</button>
                    ` : ''}
                  </div>
                </td>
              ` : ''}
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;

  // Row click → detail view
  wrap.querySelectorAll('tbody tr').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const inv = _invoices.find(i => i.id === row.dataset.id);
      if (inv) _openDetail(inv, container);
    });
  });

  // Edit button
  wrap.querySelectorAll('.edit-inv-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inv = _invoices.find(i => i.id === btn.dataset.id);
      if (inv) openInvoiceForm(container, inv);
    });
  });

  // Push to Xero
  wrap.querySelectorAll('.push-xero-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const inv = _invoices.find(i => i.id === btn.dataset.id);
      if (!inv) return;
      btn.textContent = 'Pushing...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/xero-push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invoice_id: inv.id, farm_id: inv.farm_id }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to push to Xero');
        toast('Pushed to Xero — ' + (data.xero_invoice_number || 'Draft created'), 'success');
        await _loadData();
        _renderTable(container);
      } catch (err) {
        toast(err.message, 'error');
        btn.textContent = 'Push to Xero';
        btn.disabled = false;
      }
    });
  });

  // Editable Xero ref
  wrap.querySelectorAll('.xero-ref-input').forEach(inp => {
    const save = async () => {
      const val = inp.value.trim();
      const inv = _invoices.find(i => i.id === inp.dataset.id);
      if (!inv || val === (inv.xero_invoice_number || '')) return;
      try {
        await dbUpdate('invoices', inp.dataset.id, {
          xero_invoice_number: val || null,
          status: val ? 'complete' : 'pending',
        });
        const idx = _invoices.findIndex(i => i.id === inp.dataset.id);
        if (idx >= 0) { _invoices[idx].xero_invoice_number = val || null; _invoices[idx].status = val ? 'complete' : 'pending'; }
        _renderTable(container);
      } catch (err) { toast('Failed to save: ' + err.message, 'error'); }
    };
    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });

  // Xero ref button
  wrap.querySelectorAll('.xero-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const inv = _invoices.find(i => i.id === btn.dataset.id);
      if (inv) _xeroRefModal(inv, container);
    });
  });
}

function _openDetail(inv, container) {
  const lines = inv.line_items || [];
  const deductions = inv.deductions || [];
  const contract = inv.forward_contract_id ? _contracts.find(c => c.id === inv.forward_contract_id) : null;
  // Get season from first line item that has one
  const season = lines.find(l => l.season)?.season || inv.season || '—';

  openModal({
    title: (inv.sale_type === 'against_contract' ? 'Contract sale' : 'Cash sale') + ' — ' + (inv.buyer || ''),
    confirmLabel: canWrite() ? 'Edit' : null,
    confirmClass: 'btn-secondary',
    onConfirm: canWrite() ? async () => { openInvoiceForm(container, inv); } : null,
    bodyHTML: `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
        <div><p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:3px">Date</p><p style="font-size:var(--text-sm);font-weight:500">${formatDate(inv.invoice_date)}</p></div>
        <div><p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:3px">Season</p><p style="font-size:var(--text-sm);font-weight:500">${season}</p></div>
        <div><p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:3px">Buyer</p><p style="font-size:var(--text-sm);font-weight:600">${inv.buyer || '—'}</p></div>
      </div>

      ${contract ? `<div style="background:var(--blue-light);border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:var(--text-sm)">
        <strong>Contract:</strong> ${contract.contract_number || 'Contract'} — ${contract.commodity || ''} @ ${formatCurrency(contract.price_per_unit, 2)}/${contract.unit || ''}
      </div>` : ''}

      <p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:600;margin-bottom:6px">Income — Line Items</p>
      <table class="data-table" style="margin-bottom:16px">
        <thead><tr>
          <th>Commodity</th><th>Docket</th><th class="num">Qty</th><th>Unit</th>
          <th class="num">Price/unit ($)</th><th class="num">Quality adj ($)</th><th class="num">Line total ($)</th>
        </tr></thead>
        <tbody>
          ${lines.map(l => `<tr>
            <td>${l.commodity || '—'}</td>
            <td class="muted">${l.docket || '—'}</td>
            <td class="num">${formatNumber(l.qty, 0)}</td>
            <td class="muted">${l.unit || '—'}</td>
            <td class="num">${formatCurrency(l.price, 2)}</td>
            <td class="num" style="color:${(l.quality_adj||0) > 0 ? 'var(--green)' : (l.quality_adj||0) < 0 ? 'var(--red)' : 'inherit'}">${l.quality_adj ? formatCurrency(l.quality_adj, 2) : '—'}</td>
            <td class="num"><strong>${formatCurrency(l.total, 2)}</strong></td>
          </tr>`).join('')}
        </tbody>
      </table>

      ${deductions.length ? `
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:600;margin-bottom:6px">Sale Expenses — Line Items</p>
        <table class="data-table" style="margin-bottom:16px">
          <thead><tr>
            <th>Description</th><th>Docket</th><th>Season</th>
            <th class="num">Qty</th><th>Unit</th><th class="num">Rate/unit ($)</th><th class="num">Amount ($)</th>
          </tr></thead>
          <tbody>${deductions.map(d => `<tr>
            <td>${d.description||'—'}</td>
            <td class="muted">${d.docket||'—'}</td>
            <td class="muted">${d.season||'—'}</td>
            <td class="num">${d.qty||'—'}</td>
            <td class="muted">${d.unit||'—'}</td>
            <td class="num">${d.rate ? formatCurrency(d.rate, 2) : '—'}</td>
            <td class="num" style="color:var(--red)">-${formatCurrency(d.value, 2)}</td>
          </tr>`).join('')}</tbody>
        </table>
      ` : ''}

      ${inv.notes ? `<div style="background:var(--page-bg);border-radius:6px;padding:8px 12px;margin-bottom:14px">
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:4px">Notes</p>
        <p style="font-size:var(--text-sm)">${inv.notes}</p>
      </div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div></div>
        <div style="background:var(--page-bg);border-radius:6px;padding:12px">
          <p style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:600;margin-bottom:8px">Invoice Summary</p>
          <div style="display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;justify-content:space-between;font-size:var(--text-sm)"><span style="color:var(--muted)">Gross</span><span>${formatCurrency(inv.gross_amount, 2)}</span></div>
            ${inv.total_quality_adj ? `<div style="display:flex;justify-content:space-between;font-size:var(--text-sm)"><span style="color:var(--muted)">Quality adj</span><span style="color:${inv.total_quality_adj > 0 ? 'var(--green)' : 'var(--red)'}">${inv.total_quality_adj > 0 ? '+' : ''}${formatCurrency(inv.total_quality_adj, 2)}</span></div>` : ''}
            ${inv.total_deductions ? `<div style="display:flex;justify-content:space-between;font-size:var(--text-sm)"><span style="color:var(--muted)">Sale Expenses</span><span style="color:var(--red)">-${formatCurrency(inv.total_deductions, 2)}</span></div>` : ''}
            <div style="display:flex;justify-content:space-between;font-weight:600;border-top:1px solid var(--border-light);padding-top:6px;margin-top:2px;font-size:var(--text-sm)"><span>Net amount</span><span style="color:var(--blue)">${formatCurrency(inv.net_amount, 2)}</span></div>
            <div style="display:flex;justify-content:space-between;font-weight:700;font-size:var(--text-md)"><span>Total payable</span><span style="color:var(--blue)">${formatCurrency(inv.total_payable || inv.net_amount, 2)}</span></div>
          </div>
        </div>
      </div>

      ${inv.xero_invoice_number ? `<div style="margin-top:10px;font-size:var(--text-sm);color:var(--muted)">Xero ref: <strong style="color:var(--ink)">${inv.xero_invoice_number}</strong></div>` : ''}
    `,
  });
}

function _xeroRefModal(inv, container) {
  openModal({
    title: 'Enter Xero invoice number',
    confirmLabel: 'Save & mark complete',
    bodyHTML: `
      <p style="font-size:var(--text-sm);color:var(--muted);margin-bottom:12px">Once you enter the Xero invoice number the sale will be marked as complete.</p>
      <div class="form-group">
        <label class="form-label">Xero invoice number</label>
        <input class="form-input" id="xero-ref" type="text" placeholder="e.g. INV-0042" autofocus>
      </div>
    `,
    onConfirm: async (modal) => {
      const ref = qs('#xero-ref', modal)?.value?.trim();
      if (!ref) throw new Error('Please enter the Xero invoice number');
      await dbUpdate('invoices', inv.id, { xero_invoice_number: ref, status: 'complete' });
      const idx = _invoices.findIndex(i => i.id === inv.id);
      if (idx >= 0) { _invoices[idx].xero_invoice_number = ref; _invoices[idx].status = 'complete'; }
      toast('Invoice marked complete', 'success');
      _renderTable(container);
    },
  });
}

// ── Invoice form ──────────────────────────────────────────────
export function openInvoiceForm(container, existing = null) {
  const farm = getActiveFarm();
  const isEdit = !!existing;
  let saleType = existing?.sale_type === 'against_contract' ? 'contract' : (existing?.sale_type || 'contract');
  let lines = existing?.line_items ? JSON.parse(JSON.stringify(existing.line_items)) : [];
  let deductions = existing?.deductions ? JSON.parse(JSON.stringify(existing.deductions)) : [];
  let lastEdited = {}; // per line: 'price' or 'total'
  let attachments = [];

  const formEl = document.createElement('div');
  formEl.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:500;overflow-y:auto;padding:20px';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--white);border-radius:var(--radius-xl);max-width:900px;margin:0 auto;display:flex;flex-direction:column;overflow:hidden';

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border-light);background:#fafbfc">
      <h2 style="font-size:var(--text-md);font-weight:600">${isEdit ? 'Edit invoice' : 'New invoice'}</h2>
      <button id="inv-close" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--hint);padding:2px 6px;border-radius:4px">✕</button>
    </div>
    <div style="padding:20px;overflow-y:auto;flex:1" id="inv-form-body">

      <!-- Sale type -->
      <div style="display:flex;gap:10px;margin-bottom:16px">
        <div id="inv-opt-contract" style="flex:1;border:2px solid var(--blue);border-radius:var(--radius-md);padding:10px 14px;cursor:pointer;background:var(--blue-light)">
          <p style="font-size:var(--text-sm);font-weight:600;color:var(--blue-text)">Contract sale</p>
          <p style="font-size:var(--text-xs);color:var(--blue);margin-top:2px">Against a forward contract</p>
        </div>
        <div id="inv-opt-cash" style="flex:1;border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;cursor:pointer">
          <p style="font-size:var(--text-sm);font-weight:600;color:var(--ink-mid)">Cash sale</p>
          <p style="font-size:var(--text-xs);color:var(--muted);margin-top:2px">Price set at time of sale</p>
        </div>
      </div>

      <!-- Contract selector — immediately after sale type -->
      <!-- Buyer field always visible -->
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Buyer</label>
        <input class="form-input" id="f-buyer" type="text" value="${existing?.buyer || ''}" placeholder="Buyer name">
      </div>

      <div id="f-contract-section" style="margin-bottom:16px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Forward contract</label>
          <select class="form-select" id="f-contract">
            <option value="">— select a contract —</option>
            ${_contracts.map(c => `<option value="${c.id}" data-price="${c.price_per_unit}" data-unit="${c.unit||'t'}" data-qty="${c.quantity||0}" data-buyer="${c.counterparty||c.buyer||''}" ${existing?.forward_contract_id===c.id?'selected':''}>${c.contract_number||'Contract'} — ${c.commodity||''} — ${formatNumber(c.quantity,0)} ${c.unit||''} @ ${formatCurrency(c.price_per_unit,2)}</option>`).join('')}
          </select>
        </div>
        <div id="f-contract-summary" style="display:none;grid-template-columns:repeat(4,1fr);gap:10px;background:var(--blue-light);border-radius:var(--radius-sm);padding:12px;margin-bottom:10px">
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Contract qty</p><p id="cs-qty" style="font-weight:600;color:var(--blue-text)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Already invoiced</p><p id="cs-invoiced" style="font-weight:600;color:var(--blue-text)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Remaining</p><p id="cs-remaining" style="font-weight:600;color:var(--blue)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Avg price to date</p><p id="cs-avg" style="font-weight:600;color:var(--blue-text)">—</p></div>
        </div>
      </div>

      <!-- Header fields -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Date</label>
          <input class="form-input" id="f-date" type="date" value="${existing?.invoice_date || new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">GST treatment</label>
          <div style="padding:8px 10px;background:#f0f9f4;border:1px solid #b7e4cc;border-radius:var(--radius-sm);font-size:var(--text-sm);color:#1a6b3c">
            All amounts entered Ex-GST — GST calculated in Xero
          </div>
          <input type="hidden" id="f-gst" value="ex">
        </div>
      </div>

      <!-- Line items -->
      <div style="margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <p style="font-size:var(--text-sm);font-weight:600">Income — Line Items</p>
          <button class="btn btn-secondary btn-sm" id="f-add-line">＋ Add line</button>
        </div>
        <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:white">
          <table style="width:100%;border-collapse:collapse;min-width:780px" id="f-lines-table">
            <thead>
              <tr style="background:#f8f9fa;border-bottom:1px solid var(--border)">
                ${[
                  ['Commodity','left','130px'],
                  ['Docket / ID','left','100px'],
                  ['Crop year','left','85px'],
                  ['Qty','right','70px'],
                  ['Unit','left','65px'],
                  ['Price / unit','right','90px'],
                  ['Quality adj ($)<br><span style="font-size:9px;font-weight:400;letter-spacing:0">(neg. or pos.)</span>','right','95px'],
                  ['Line total ($)','right','95px'],
                  ['Eff. $/unit','right','90px'],
                  ['','left','30px'],
                ].map(([l,a,w],i) => `<th ${i===7?'id="th-qa"':''} ${i===9?'id="th-eff"':''} style="padding:7px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:500;text-align:${a};min-width:${w};white-space:nowrap">${l}</th>`).join('')}
              </tr>
            </thead>
            <tbody id="f-lines-body"></tbody>
          </table>
          <p style="font-size:11px;color:var(--hint);padding:6px 10px">Enter price/unit OR line total — the other updates automatically</p>
        </div>
      </div>

      <!-- Sale Expenses -->
      <div style="margin-bottom:16px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <p style="font-size:var(--text-sm);font-weight:600">Sale Expenses — Line Items</p>
          <button class="btn btn-secondary btn-sm" id="f-add-ded">＋ Add expense</button>
        </div>
        <div style="overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:white">
          <table style="width:100%;border-collapse:collapse;min-width:700px" id="f-ded-table">
            <thead>
              <tr style="background:#f8f9fa;border-bottom:1px solid var(--border)">
                ${[
                  ['Description','left','150px'],
                  ['Docket / ID','left','100px'],
                  ['Crop year','left','85px'],
                  ['Qty','right','70px'],
                  ['Unit','left','65px'],
                  ['Rate / unit','right','90px'],
                  ['Amount ($)','right','95px'],
                  ['','left','30px'],
                ].map(([l,a,w]) => `<th style="padding:7px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:500;text-align:${a};min-width:${w}">${l}</th>`).join('')}
              </tr>
            </thead>
            <tbody id="f-ded-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Attachments -->
      <div style="margin-bottom:16px">
        <p style="font-size:var(--text-sm);font-weight:600;margin-bottom:8px">Attachments</p>
        <div id="f-drop-zone" style="border:1.5px dashed var(--border);border-radius:var(--radius-md);padding:18px;text-align:center;cursor:pointer;background:var(--page-bg)">
          <p style="color:var(--muted);font-size:var(--text-sm)">Drop dockets, remittances or PDFs here, or click to browse</p>
        </div>
        <input type="file" id="f-file-input" multiple accept=".pdf,image/*" style="display:none">
        <div id="f-file-list" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px"></div>
      </div>

      <!-- Notes -->
      <div class="form-group" style="margin-bottom:16px">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="f-notes" rows="3" placeholder="Internal notes, gin reference, pool details, delivery information…">${existing?.notes || ''}</textarea>
      </div>

      <!-- Invoice summary only -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
        <div></div>
        <div style="background:var(--page-bg);border-radius:var(--radius-md);padding:14px">
          <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:10px">Invoice Summary</p>
          <div style="display:flex;flex-direction:column;gap:5px">
            <div style="display:flex;justify-content:space-between;font-size:var(--text-sm);color:var(--muted)"><span>Gross</span><span id="t-gross" style="font-family:var(--font-data)">$0.00</span></div>
            <div id="t-qa-row" style="display:flex;justify-content:space-between;font-size:var(--text-sm);color:var(--muted)"><span>Quality adj</span><span id="t-qa" style="font-family:var(--font-data)">—</span></div>
            <div style="display:flex;justify-content:space-between;font-size:var(--text-sm);color:var(--muted)"><span>Sale Expenses</span><span id="t-ded" style="font-family:var(--font-data);color:var(--red)">—</span></div>
            <div style="display:flex;justify-content:space-between;font-size:var(--text-sm);font-weight:600;color:var(--ink);border-top:1px solid var(--border-light);padding-top:6px;margin-top:2px"><span>Net amount</span><span id="t-net" style="font-family:var(--font-data)">$0.00</span></div>
            <div style="display:flex;justify-content:space-between;font-size:var(--text-md);font-weight:600;color:var(--blue)"><span>Total payable</span><span id="t-total" style="font-family:var(--font-data)">$0.00</span></div>
          </div>
        </div>
      </div>

    </div>

    <!-- Footer -->
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 20px;border-top:1px solid var(--border-light);background:#fafbfc">
      <button class="btn btn-secondary" id="f-cancel">Cancel</button>
      <button class="btn btn-primary" id="f-save"><i style="margin-right:4px">✓</i> Save — pending</button>
    </div>
  `;

  formEl.appendChild(modal);
  document.body.appendChild(formEl);

  // ── Wire up interactions ───────────────────────────────────

  // Close
  const close = () => formEl.remove();
  modal.querySelector('#inv-close')?.addEventListener('click', close);
  modal.querySelector('#f-cancel')?.addEventListener('click', close);
  formEl.addEventListener('click', e => { if (e.target === formEl) close(); });

  // Sale type toggle
  function setSaleType(t) {
    saleType = t;
    const con = modal.querySelector('#inv-opt-contract');
    const cas = modal.querySelector('#inv-opt-cash');
    con.style.border = t==='contract' ? '2px solid var(--blue)' : '1px solid var(--border)';
    con.style.background = t==='contract' ? 'var(--blue-light)' : '';
    con.querySelector('p').style.color = t==='contract' ? 'var(--blue-text)' : 'var(--ink-mid)';
    cas.style.border = t==='cash' ? '2px solid var(--blue)' : '1px solid var(--border)';
    cas.style.background = t==='cash' ? 'var(--blue-light)' : '';
    cas.querySelector('p').style.color = t==='cash' ? 'var(--blue-text)' : 'var(--ink-mid)';
    modal.querySelector('#f-contract-section').style.display = t==='contract' ? 'block' : 'none';
    modal.querySelector('#th-qa').style.display = t==='contract' ? '' : 'none';
    modal.querySelector('#th-eff').style.display = t==='contract' ? '' : 'none';
    modal.querySelector('#t-qa-row').style.display = t==='contract' ? '' : 'none';
    modal.querySelectorAll('.f-qa-cell,.f-eff-cell').forEach(c => c.style.display = t==='contract' ? '' : 'none');
    recalc();
  }
  modal.querySelector('#inv-opt-contract').addEventListener('click', () => setSaleType('contract'));
  modal.querySelector('#inv-opt-cash').addEventListener('click', () => setSaleType('cash'));

  // Contract selector
  async function updateContractSummary() {
    const sel = modal.querySelector('#f-contract');
    const opt = sel.options[sel.selectedIndex];
    const sum = modal.querySelector('#f-contract-summary');
    if (!opt.value) { sum.style.display='none'; return; }
    sum.style.display='grid';
    const price = parseFloat(opt.dataset.price)||0;
    const qty = parseFloat(opt.dataset.qty)||0;
    const unit = opt.dataset.unit || 't';

    // Fetch already invoiced against this contract
    try {
      const existing_invs = await dbSelect('invoices', 'forward_contract_id=eq.' + opt.value + '&select=net_amount,line_items');
      const invoicedQty = existing_invs.reduce((s, i) => s + (i.line_items||[]).reduce((ss, l) => ss + (parseFloat(l.qty)||0), 0), 0);
      const invoicedVal = existing_invs.reduce((s, i) => s + (i.line_items||[]).reduce((ss, l) => ss + (parseFloat(l.total)||0), 0), 0);
      modal.querySelector('#cs-qty').textContent = formatNumber(qty, 0) + ' ' + unit;
      modal.querySelector('#cs-invoiced').textContent = formatNumber(invoicedQty, 0) + ' ' + unit;
      modal.querySelector('#cs-remaining').textContent = formatNumber(qty - invoicedQty, 0) + ' ' + unit;
      modal.querySelector('#cs-avg').textContent = invoicedQty ? formatCurrency(invoicedVal / invoicedQty, 2) : '—';
    } catch { modal.querySelector('#cs-qty').textContent = formatNumber(qty,0)+' '+unit; }

    modal.querySelector('#pc-contract').textContent = formatCurrency(price, 2);
    // Autofill buyer from contract
    const buyerField = modal.querySelector('#f-buyer');
    const selectedOpt = modal.querySelector('#f-contract option:checked');
    if (buyerField && selectedOpt?.dataset?.buyer && !buyerField.value) {
      buyerField.value = selectedOpt.dataset.buyer;
    }
    // Set price on all lines
    modal.querySelectorAll('.f-line-price').forEach(inp => { inp.value = price.toFixed(2); });
    recalc();
  }
  // Load budget price for the active season/commodity
  (async () => {
    try {
      const farm = getActiveFarm();
      const season = getActiveSeason() || currentSeason();
      const budgets = await dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=price,commodity,commodity_id&order=price.desc&limit=1');
      const budgetPrice = budgets[0]?.price;
      const el = modal.querySelector('#pc-budget');
      if (el) el.textContent = budgetPrice ? formatCurrency(parseFloat(budgetPrice), 2) : '—';
    } catch {}
  })();

  modal.querySelector('#f-contract')?.addEventListener('change', () => {
    updateContractSummary();
    // Always autofill buyer when contract changes
    const buyerField = modal.querySelector('#f-buyer');
    const selectedOpt = modal.querySelector('#f-contract option:checked');
    if (buyerField && selectedOpt?.dataset?.buyer) buyerField.value = selectedOpt.dataset.buyer;
  });

  // Add line
  let _lineCounter = 0;
  function addLine(data = {}) {
    const tbody = modal.querySelector('#f-lines-body');
    const id = 'line-' + (++_lineCounter);
    lastEdited[id] = data.lastEdited || 'price';
    const tr = document.createElement('tr');
    tr.dataset.id = id;
    tr.style.borderBottom = '1px solid var(--border-light)';
    const tdStyle = 'padding:3px 5px;vertical-align:middle;';
    const inStyle = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;background:white;color:var(--ink);font-size:13px;width:100%;font-family:inherit';
    const numStyle = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;background:white;color:var(--ink);font-size:13px;width:100%;text-align:right;font-family:var(--font-data)';
    const commOptions = '<option value="">— select —</option>' + getCommodities().map(c => `<option value="${c.name}" ${c.name===(data.commodity||'')?'selected':''}>${c.name}</option>`).join('');
    tr.innerHTML = `
      <td style="${tdStyle}min-width:110px"><select class="f-line-comm" style="${inStyle}">${commOptions}</select></td>
      <td style="${tdStyle}min-width:85px"><input type="text" class="f-line-docket" style="${inStyle}" placeholder="D-1042" value="${data.docket||''}"></td>
      <td style="${tdStyle}min-width:70px;max-width:80px"><select class="f-line-season" style="${inStyle}">
        ${['2023-24','2024-25','2025-26','2026-27','2027-28'].map(s=>`<option value="${s}" ${s===(data.season||getActiveSeason()||currentSeason())?'selected':''}>${s}</option>`).join('')}
      </select></td>
      <td style="${tdStyle}min-width:55px"><input type="number" class="f-line-qty" style="${numStyle}" placeholder="0" value="${data.qty||''}" step="0.001"></td>
      <td style="${tdStyle}min-width:50px"><select class="f-line-unit" style="${inStyle}">
        ${['bale','t','kg','head','each'].map(u=>`<option${u===(data.unit||'t')?' selected':''}>${u}</option>`).join('')}
      </select></td>

      <td style="${tdStyle}min-width:80px;max-width:90px"><input type="number" class="f-line-price" style="${numStyle}" placeholder="0.00" value="${data.price||''}" step="0.01"></td>
      <td class="f-qa-cell" style="${tdStyle}min-width:90px;${saleType!=='contract'?'display:none':''}"><input type="number" class="f-line-qa" style="${numStyle};color:${(data.quality_adj||0)>0?'var(--green)':(data.quality_adj||0)<0?'var(--red)':'var(--ink)'}" placeholder="0.00" value="${data.quality_adj||''}" step="0.01"
        oninput="this.style.color=parseFloat(this.value)>0?'var(--green)':parseFloat(this.value)<0?'var(--red)':'var(--ink)'"></td>
      <td style="${tdStyle}min-width:90px"><input type="number" class="f-line-total" style="${numStyle};background:var(--blue-light);color:var(--blue-text)" placeholder="0.00" value="${data.total||''}" step="0.01"></td>
      <td class="f-eff-cell" style="${tdStyle}min-width:90px;${saleType!=='contract'?'display:none':''}"><input type="text" class="f-line-eff" readonly style="${numStyle};background:var(--page-bg);color:var(--blue);border:none;cursor:default" value="${data.eff||''}"></td>
      <td style="padding:4px;text-align:center"><button style="background:none;border:none;cursor:pointer;color:var(--hint);font-size:16px;padding:2px 4px" class="del-line">✕</button></td>
    `;
    tbody.appendChild(tr);

    // Wire inputs
    const qtyInp = tr.querySelector('.f-line-qty');
    const priceInp = tr.querySelector('.f-line-price');
    const qaInp = tr.querySelector('.f-line-qa');
    const totalInp = tr.querySelector('.f-line-total');
    const effInp = tr.querySelector('.f-line-eff');

    const updateEff = () => {
      const qty = parseFloat(qtyInp.value)||0;
      const total = parseFloat(totalInp.value)||0;
      if (effInp) effInp.value = qty && total ? formatCurrency(total/qty, 2) : '';
    };

    priceInp.addEventListener('input', () => {
      lastEdited[id] = 'price';
      const qty = parseFloat(qtyInp.value)||0;
      const price = parseFloat(priceInp.value)||0;
      const qa = parseFloat(qaInp?.value)||0;
      if (qty) totalInp.value = (qty * price + qa).toFixed(2);
      updateEff(); recalc();
    });

    totalInp.addEventListener('blur', () => {
      const v = parseFloat(totalInp.value);
      if (!isNaN(v)) totalInp.value = v.toFixed(2);
    });

    totalInp.addEventListener('input', () => {
      lastEdited[id] = 'total';
      const qty = parseFloat(qtyInp.value)||0;
      const total = parseFloat(totalInp.value)||0;
      const qa = parseFloat(qaInp?.value)||0;
      if (qty) priceInp.value = ((total - qa) / qty).toFixed(2);
      updateEff(); recalc();
    });

    qtyInp.addEventListener('input', () => {
      const qty = parseFloat(qtyInp.value)||0;
      const qa = parseFloat(qaInp?.value)||0;
      if (lastEdited[id] === 'price') {
        const price = parseFloat(priceInp.value)||0;
        if (qty) totalInp.value = (qty * price + qa).toFixed(2);
      } else {
        const total = parseFloat(totalInp.value)||0;
        if (qty) priceInp.value = ((total - qa) / qty).toFixed(2);
      }
      updateEff(); recalc();
    });

    if (qaInp) qaInp.addEventListener('input', () => {
      const qty = parseFloat(qtyInp.value)||0;
      const price = parseFloat(priceInp.value)||0;
      const qa = parseFloat(qaInp.value)||0;
      if (qty && lastEdited[id] === 'price') totalInp.value = (qty * price + qa).toFixed(2);
      updateEff(); recalc();
    });

    tr.querySelector('.del-line').addEventListener('click', () => { tr.remove(); recalc(); });

    // Focus style
    [qtyInp, priceInp, totalInp, qaInp].filter(Boolean).forEach(inp => {
      inp.addEventListener('focus', () => { inp.style.border='0.5px solid var(--blue)'; inp.style.background='var(--white)'; inp.style.boxShadow='0 0 0 2px rgba(30,111,168,.1)'; });
      inp.addEventListener('blur', () => { inp.style.border='0.5px solid transparent'; inp.style.background='transparent'; inp.style.boxShadow='none'; });
    });

    updateEff();
    if (data.commodity) tr.querySelector('.f-line-comm').value = data.commodity;

    recalc();
  }

  // Add deduction
  function addDeduction(data = {}) {
    const tbody = modal.querySelector('#f-ded-body');
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-light)';
    const tdStyle = 'padding:3px 5px;vertical-align:middle;';
    const inStyle = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;background:white;color:var(--ink);font-size:13px;width:100%;font-family:inherit';
    const numStyle = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;background:white;color:var(--ink);font-size:13px;width:100%;text-align:right;font-family:var(--font-data)';
    const seasonOpts = ['2023-24','2024-25','2025-26','2026-27','2027-28'].map(s =>
      `<option value="${s}" ${s===(data.season||getActiveSeason()||currentSeason())?'selected':''}>${s}</option>`
    ).join('');
    tr.innerHTML = `
      <td style="${tdStyle}"><input type="text" class="f-ded-desc" style="${inStyle}" placeholder="e.g. Selling commission" value="${data.description||''}"></td>
      <td style="${tdStyle}"><input type="text" class="f-ded-docket" style="${inStyle}" placeholder="Docket" value="${data.docket||''}"></td>
      <td style="${tdStyle}"><select class="f-ded-season" style="${inStyle};font-size:11px">${seasonOpts}</select></td>
      <td style="${tdStyle}"><input type="number" class="f-ded-qty" style="${numStyle}" placeholder="0" value="${data.qty||''}" step="0.01"></td>
      <td style="${tdStyle}min-width:50px"><select class="f-ded-unit" style="${inStyle}">
        ${['bale','t','kg','head','each','%','flat'].map(u=>`<option${u===(data.unit||'t')?' selected':''}>${u}</option>`).join('')}
      </select></td>

      <td style="${tdStyle}"><input type="number" class="f-ded-rate" style="${numStyle}" placeholder="0.00" value="${data.rate||''}" step="0.0001"></td>
      <td style="${tdStyle}"><input type="number" class="f-ded-value" style="${numStyle};color:var(--red)" placeholder="0.00" value="${data.value||''}" step="0.01"></td>
      <td style="padding:4px;text-align:center"><button style="background:none;border:none;cursor:pointer;color:var(--hint);font-size:16px;padding:2px 4px" class="del-ded">✕</button></td>
    `;
    tbody.appendChild(tr);

    const dedQty = tr.querySelector('.f-ded-qty');
    const dedRate = tr.querySelector('.f-ded-rate');
    const dedValue = tr.querySelector('.f-ded-value');

    // Auto-calc value from qty * rate
    const calcDedValue = () => {
      const qty = parseFloat(dedQty.value) || 0;
      const rate = parseFloat(dedRate.value) || 0;
      if (qty && rate) dedValue.value = (qty * rate).toFixed(2);
      recalc();
    };

    dedQty.addEventListener('input', calcDedValue);
    dedRate.addEventListener('input', calcDedValue);
    dedValue.addEventListener('input', recalc);
    tr.querySelector('.del-ded').addEventListener('click', () => { tr.remove(); recalc(); });
  }

  // Recalc totals
  function recalc() {
    let gross = 0, totalQA = 0, totalQty = 0;
    modal.querySelectorAll('#f-lines-body tr').forEach(tr => {
      const qty = parseFloat(tr.querySelector('.f-line-qty')?.value)||0;
      const total = parseFloat(tr.querySelector('.f-line-total')?.value)||0;
      const qa = saleType==='contract' ? (parseFloat(tr.querySelector('.f-line-qa')?.value)||0) : 0;
      gross += total ? total - qa : 0;
      totalQA += qa;
      totalQty += qty;
    });

    const grossPlusQA = gross + totalQA;
    let totalDed = 0;
    modal.querySelectorAll('#f-ded-body tr').forEach(tr => {
      const val = parseFloat(tr.querySelector('.f-ded-value')?.value)||0;
      totalDed += val;
    });

    const net = grossPlusQA - totalDed;
    const gstType = modal.querySelector('#f-gst')?.value;
    const gstAmt = gstType==='inc' ? net * 0.1 : 0;
    const total = net + gstAmt;

    const fmt = n => formatCurrency(n, 2);
    if (modal.querySelector('#t-gross')) modal.querySelector('#t-gross').textContent = fmt(gross);
    const tQa = modal.querySelector('#t-qa');
    if (tQa) { tQa.textContent = totalQA ? (totalQA < 0 ? '-' : '+') + fmt(Math.abs(totalQA)) : '—'; tQa.style.color = totalQA < 0 ? 'var(--red)' : 'var(--green)'; }
    const tDed = modal.querySelector('#t-ded');
    if (tDed) tDed.textContent = totalDed ? '-' + fmt(totalDed) : '—';
    const tNet = modal.querySelector('#t-net');
    if (tNet) tNet.textContent = fmt(net);
    const tTotal = modal.querySelector('#t-total');
    if (tTotal) tTotal.textContent = fmt(total);

    // Price comparison removed from form — no longer needed
  }

  // File attachment
  const dropZone = modal.querySelector('#f-drop-zone');
  const fileInput = modal.querySelector('#f-file-input');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'var(--blue)'; });
  dropZone.addEventListener('dragleave', () => dropZone.style.borderColor = '');
  dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.style.borderColor = ''; addFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', () => addFiles(fileInput.files));

  function addFiles(fileList) {
    [...fileList].forEach(f => {
      attachments.push(f);
      const pill = document.createElement('span');
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:5px;background:var(--blue-light);border:1px solid var(--blue);border-radius:20px;padding:3px 10px;font-size:11px;color:var(--blue-text)';
      pill.innerHTML = `📎 ${f.name} <span style="cursor:pointer;font-size:13px;margin-left:2px" onclick="this.closest('span').remove()">×</span>`;
      modal.querySelector('#f-file-list').appendChild(pill);
    });
  }



  // Add/del buttons
  modal.querySelector('#f-add-line').addEventListener('click', () => addLine());
  modal.querySelector('#f-add-ded').addEventListener('click', () => addDeduction());

  // Load existing data
  setSaleType(saleType);
  if (existing?.line_items?.length) {
    existing.line_items.forEach(l => addLine(l));
  } else {
    addLine();
  }
  if (existing?.deductions?.length) {
    existing.deductions.forEach(d => addDeduction(d));
  } else {
    addDeduction(); // default empty row
  }
  if (existing?.forward_contract_id) {
    setTimeout(() => updateContractSummary(), 100);
  }

  // Save
  modal.querySelector('#f-save').addEventListener('click', async () => {
    const btn = modal.querySelector('#f-save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const lineRows = [...modal.querySelectorAll('#f-lines-body tr')].map(tr => ({
        commodity: tr.querySelector('.f-line-comm')?.value || '',
        docket: tr.querySelector('.f-line-docket')?.value || '',
        season: tr.querySelector('.f-line-season')?.value || getActiveSeason() || currentSeason(),

        qty: parseFloat(tr.querySelector('.f-line-qty')?.value)||0,
        unit: tr.querySelector('.f-line-unit')?.value || 't',
        price: parseFloat(tr.querySelector('.f-line-price')?.value)||0,
        quality_adj: parseFloat(tr.querySelector('.f-line-qa')?.value)||0,
        total: parseFloat(tr.querySelector('.f-line-total')?.value)||0,
        eff: tr.querySelector('.f-line-eff')?.value || '',
      })).filter(l => l.qty > 0 || l.total > 0);

      const dedRows = [...modal.querySelectorAll('#f-ded-body tr')].map(tr => {
        const type = tr.querySelector('.f-ded-type')?.value;
        const rate = parseFloat(tr.querySelector('.f-ded-rate')?.value)||0;
        const grossPlusQA = lineRows.reduce((s,l) => s + (l.total||0), 0);
        const value = parseFloat(tr.querySelector('.f-ded-value')?.value)||0;
        return { description: tr.querySelector('.f-ded-desc')?.value || '', type, rate, value };
      }).filter(d => d.rate > 0);

      const gross = lineRows.reduce((s,l) => s + ((l.total||0) - (saleType==='contract' ? (l.quality_adj||0) : 0)), 0);
      const totalQA = saleType==='contract' ? lineRows.reduce((s,l) => s + (l.quality_adj||0), 0) : 0;
      const grossPlusQA = gross + totalQA;
      const totalDed = dedRows.reduce((s,d) => s + (d.value||0), 0);
      const net = grossPlusQA - totalDed;
      const dedGST2 = dedRows.reduce((s,d) => s + (d.gst==='inc' ? (d.value||0)*0.1 : 0), 0);
      const gstAmt = dedGST2;
      const total = net + gstAmt;
      const totalQty = lineRows.reduce((s,l) => s + (l.qty||0), 0);
      const contractSel = modal.querySelector('#f-contract');
      const contractId = contractSel?.value || null;

      const row = {
        farm_id: farm.id,
        invoice_date: modal.querySelector('#f-date')?.value,
        season: null, // Season is at line item level
        buyer: modal.querySelector('#f-buyer')?.value?.trim() || '',
        sale_type: saleType === 'contract' ? 'against_contract' : 'cash',
        forward_contract_id: saleType === 'contract' ? contractId : null,
        line_items: lineRows,
        deductions: dedRows,
        gross_amount: gross,
        total_quality_adj: totalQA,
        total_deductions: totalDed,
        net_amount: net,
        gst_type: 'ex',
        gst_amount: 0,
        total_payable: total,
        total_qty: totalQty,
        notes: modal.querySelector('#f-notes')?.value?.trim() || null,
        status: existing?.status || 'pending',
        created_by: getSession()?.user?.id,
      };

      if (isEdit) {
        await dbUpdate('invoices', existing.id, row);
        const idx = _invoices.findIndex(i => i.id === existing.id);
        if (idx >= 0) _invoices[idx] = { ..._invoices[idx], ...row };
        toast('Invoice updated', 'success');
      } else {
        const saved = await dbInsert('invoices', row);
        if (!_invoices.find(i => i.id === saved.id)) _invoices.unshift(saved);
        toast('Invoice saved — pending', 'success');
      }

      close();
      _renderTable(container);
    } catch (err) {
      toast(err.message || 'Failed to save', 'error');
      btn.disabled = false;
      btn.textContent = '✓ Save — pending';
    }
  });

  recalc();
}