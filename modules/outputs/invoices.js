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

        <select id="inv-filter-commodity" class="form-select" style="width:160px">
          <option value="">All commodities</option>
          ${[...new Set(_invoices.flatMap(i => (i.line_items||[]).map(l => l.commodity).filter(Boolean)))].sort().map(c => `<option value="${c}">${c}</option>`).join('')}
        </select>
        <select id="inv-filter-contract" class="form-select" style="width:180px">
          <option value="">All contracts</option>
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
  ['#inv-filter-commodity', '#inv-filter-contract'].forEach(sel => {
    qs(sel, container)?.addEventListener('change', () => _renderTable(container));
  });
  document.addEventListener('cfm:seasonchange', () => _renderTable(container));
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
}

function _filtered() {
  const season = getActiveSeason() || '';
  const commodity = qs('#inv-filter-commodity')?.value || '';
  const contract = qs('#inv-filter-contract')?.value || '';
  return _invoices.filter(i => {
    const commodityMatch = !commodity || (i.line_items||[]).some(l => l.commodity === commodity);
    const contractMatch = !contract
      ? true
      : contract === 'cash'
        ? !i.forward_contract_id
        : i.forward_contract_id === contract;
    if (!season) return commodityMatch && contractMatch;
    const seasonMatch = i.season === season || (i.line_items || []).some(l => l.season === season);
    return seasonMatch && commodityMatch && contractMatch;
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
  // Rebuild contract filter with live data
  const _csel = document.getElementById('inv-filter-contract');
  if (_csel && _contracts.length) {
    const _cv = _csel.value;
    _csel.innerHTML = '<option value="">All contracts</option><option value="cash">Cash sales only</option>' +
      _contracts.map(c => `<option value="${c.id}" ${_cv===c.id?'selected':''}>${c.contract_number||'Contract'} — ${c.commodity||''}</option>`).join('');
  }
  const rows = _filtered();

  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-state"><div class="empty-icon">📄</div><p>No invoices yet.</p><p>Click "＋ New invoice" to record your first sale.</p></div>';
    return;
  }

  const totalNet = rows.reduce((s, i) => s + (parseFloat(i.net_amount)||0), 0);
  const totalGross = rows.reduce((s, i) => s + (parseFloat(i.gross_amount)||0), 0);
  const totalQA = rows.reduce((s, i) => s + (parseFloat(i.total_quality_adj)||0), 0);
  const totalIncome = totalGross + totalQA;
  const totalDeductions = rows.reduce((s, i) => s + (parseFloat(i.total_deductions)||0), 0);
  const totalPending = rows.filter(i => i.status === 'pending').reduce((s, i) => s + (parseFloat(i.net_amount)||0), 0);
  const totalComplete = rows.filter(i => i.status === 'complete').reduce((s, i) => s + (parseFloat(i.net_amount)||0), 0);

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:0;border-bottom:1px solid var(--border-light)">
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Gross</div>
        <div style="font-size:18px;font-weight:600;color:var(--ink)">${formatCurrency(totalGross, 0)}</div>
      </div>
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Quality adj</div>
        <div style="font-size:18px;font-weight:600;color:${totalQA>=0?'var(--green)':'var(--red)'}">${totalQA?(totalQA>0?'+':'')+formatCurrency(totalQA,0):'—'}</div>
      </div>
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Total income</div>
        <div style="font-size:18px;font-weight:600;color:var(--ink)">${formatCurrency(totalIncome, 0)}</div>
      </div>
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Selling costs</div>
        <div style="font-size:18px;font-weight:600;color:var(--red)">${totalDeductions?'-'+formatCurrency(totalDeductions,0):'—'}</div>
      </div>
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Net total</div>
        <div style="font-size:18px;font-weight:700;color:var(--ink)">${formatCurrency(totalNet, 0)}</div>
      </div>
      <div style="padding:12px 16px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Pending / Complete</div>
        <div style="font-size:13px;font-weight:600;color:var(--amber)">${formatCurrency(totalPending, 0)}</div>
        <div style="font-size:13px;font-weight:600;color:var(--green)">${formatCurrency(totalComplete, 0)}</div>
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
          <th class="num">Quality adj</th>
          <th class="num">Total income</th>
          <th class="num">Selling costs</th>
          <th class="num">Net</th>
          <th>Documents</th>
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
              <td class="num" style="color:${(inv.total_quality_adj||0)>0?'var(--green)':(inv.total_quality_adj||0)<0?'var(--red)':'inherit'}">${inv.total_quality_adj ? ((inv.total_quality_adj>0?'+':'')+formatCurrency(inv.total_quality_adj,0)) : '—'}</td>
              <td class="num">${formatCurrency((parseFloat(inv.gross_amount)||0)+(parseFloat(inv.total_quality_adj)||0), 0)}</td>
              <td class="num" style="color:var(--red)">${inv.total_deductions ? '-'+formatCurrency(inv.total_deductions,0) : '—'}</td>
              <td class="num"><strong>${formatCurrency(inv.net_amount, 0)}</strong></td>
              <td style="white-space:nowrap;font-size:12px">
                ${(() => {
                  const rctiCount = (inv.rcti_files||[]).length || (inv.rcti_url ? 1 : 0);
                  const ginCount = (inv.gin_files||[]).length || (inv.gin_url ? 1 : 0);
                  const rctiUrl = (inv.rcti_files||[])[0]?.url || inv.rcti_url;
                  const ginUrl = (inv.gin_files||[])[0]?.url || inv.gin_url;
                  return (rctiUrl ? `<a href="${rctiUrl}" target="_blank" style="color:var(--blue);text-decoration:none;margin-right:6px" onclick="event.stopPropagation()" title="Merchant RCTI">📄 RCTI${rctiCount>1?' ('+rctiCount+')':''}</a>` : '') +
                    (ginUrl ? `<a href="${ginUrl}" target="_blank" style="color:var(--blue);text-decoration:none;margin-right:6px" onclick="event.stopPropagation()" title="Ginning Advice">🧾 Gin${ginCount>1?' ('+ginCount+')':''}</a>` : '') +
                    (inv.xero_invoice_url ? `<a href="${inv.xero_invoice_url}" target="_blank" style="color:var(--blue);text-decoration:none" onclick="event.stopPropagation()" title="Xero Invoice">📋 Xero</a>` : '') +
                    (!rctiUrl && !ginUrl && !inv.xero_invoice_url ? '<span style="color:var(--hint)">—</span>' : '');
                })()}
              </td>
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

      <!-- Contract selector -->
      <div id="f-contract-section" style="margin-bottom:16px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Forward contract</label>
          <select class="form-select" id="f-contract">
            <option value="">— select a contract —</option>
            ${_contracts.map(c => `<option value="${c.id}" data-price="${c.price_per_unit}" data-unit="${c.unit||'t'}" data-qty="${c.quantity||0}" data-buyer="${c.counterparty||c.buyer||''}" ${existing?.forward_contract_id===c.id?'selected':''}>${c.contract_number||'Contract'} — ${c.commodity||''} — ${formatNumber(c.quantity,0)} ${c.unit||''} @ ${formatCurrency(c.price_per_unit,2)}</option>`).join('')}
          </select>
        </div>
        <div id="f-contract-summary" style="display:none;grid-template-columns:repeat(4,1fr);gap:10px;background:var(--blue-light);border-radius:var(--radius-sm);padding:12px;margin-top:8px">
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Contract qty</p><p id="cs-qty" style="font-weight:600;color:var(--blue-text)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Already invoiced</p><p id="cs-invoiced" style="font-weight:600;color:var(--blue-text)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Remaining</p><p id="cs-remaining" style="font-weight:600;color:var(--blue)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Avg price to date</p><p id="cs-avg" style="font-weight:600;color:var(--blue-text)">—</p></div>
        </div>
      </div>

      <!-- Buyer + Date + Unit row -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Buyer</label>
          <input class="form-input" id="f-buyer" type="text" value="${existing?.buyer || ''}" placeholder="Buyer name">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Date</label>
          <input class="form-input" id="f-date" type="date" value="${existing?.invoice_date || new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Master unit</label>
          <select class="form-select" id="f-master-unit">
            ${['bale','t','kg','head','each'].map(u=>`<option${u===(existing?.master_unit||'bale')?' selected':''}>${u}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">GST treatment</label>
          <div style="padding:8px 10px;background:#f0f9f4;border:1px solid #b7e4cc;border-radius:var(--radius-sm);font-size:12px;color:#1a6b3c">
            Ex-GST — calculated in Xero
          </div>
          <input type="hidden" id="f-gst" value="ex">
        </div>
      </div>

      <!-- Batches -->
      <div id="f-batches-wrap" style="margin-bottom:16px"></div>
      <button class="btn btn-secondary btn-sm" id="f-add-batch" style="margin-bottom:16px">＋ Add batch</button>

      <!-- Attachments -->
      <div style="margin-bottom:16px">
        <p style="font-size:var(--text-sm);font-weight:600;margin-bottom:10px">Attachments</p>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">

          <!-- Merchant RCTI -->
          <div style="border:1px solid var(--border);border-radius:var(--radius-md);padding:10px">
            <p style="font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">📄 Merchant RCTI</p>
            <div id="f-rcti-existing" style="margin-bottom:6px">
              ${(existing?.rcti_files||[]).map((f,i)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--page-bg);border-radius:4px;font-size:11px;margin-bottom:3px">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${f.filename||'RCTI '+(i+1)}</span>
                <a href="${f.url}" target="_blank" class="btn btn-ghost btn-sm" style="font-size:10px;margin-left:4px">View</a>
              </div>`).join('')}
              ${existing?.rcti_url&&!(existing?.rcti_files||[]).length?`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--page-bg);border-radius:4px;font-size:11px;margin-bottom:3px"><span>${existing.rcti_filename||'RCTI'}</span><a href="${existing.rcti_url}" target="_blank" class="btn btn-ghost btn-sm" style="font-size:10px;margin-left:4px">View</a></div>`:''}
            </div>
            <div id="f-rcti-zone" style="border:1.5px dashed var(--border);border-radius:6px;padding:8px;text-align:center;cursor:pointer;background:var(--page-bg)">
              <p style="color:var(--muted);font-size:11px">Drop or click to add</p>
            </div>
            <input type="file" id="f-rcti-input" multiple accept=".pdf,image/*" style="display:none">
            <div id="f-rcti-list" style="margin-top:5px"></div>
          </div>

          <!-- Ginning Advice -->
          <div style="border:1px solid var(--border);border-radius:var(--radius-md);padding:10px">
            <p style="font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">🧾 Ginning Advice / Invoice</p>
            <div id="f-gin-existing" style="margin-bottom:6px">
              ${(existing?.gin_files||[]).map((f,i)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--page-bg);border-radius:4px;font-size:11px;margin-bottom:3px">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${f.filename||'Gin '+(i+1)}</span>
                <a href="${f.url}" target="_blank" class="btn btn-ghost btn-sm" style="font-size:10px;margin-left:4px">View</a>
              </div>`).join('')}
              ${existing?.gin_url&&!(existing?.gin_files||[]).length?`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--page-bg);border-radius:4px;font-size:11px;margin-bottom:3px"><span>${existing.gin_filename||'Gin Advice'}</span><a href="${existing.gin_url}" target="_blank" class="btn btn-ghost btn-sm" style="font-size:10px;margin-left:4px">View</a></div>`:''}
            </div>
            <div id="f-gin-zone" style="border:1.5px dashed var(--border);border-radius:6px;padding:8px;text-align:center;cursor:pointer;background:var(--page-bg)">
              <p style="color:var(--muted);font-size:11px">Drop or click to add</p>
            </div>
            <input type="file" id="f-gin-input" multiple accept=".pdf,image/*" style="display:none">
            <div id="f-gin-list" style="margin-top:5px"></div>
          </div>

          <!-- Other -->
          <div style="border:1px solid var(--border);border-radius:var(--radius-md);padding:10px">
            <p style="font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">📎 Other documents</p>
            <div id="f-other-existing" style="margin-bottom:6px">
              ${(existing?.other_files||[]).map((f,i)=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:var(--page-bg);border-radius:4px;font-size:11px;margin-bottom:3px">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${f.filename||'Doc '+(i+1)}</span>
                <a href="${f.url}" target="_blank" class="btn btn-ghost btn-sm" style="font-size:10px;margin-left:4px">View</a>
              </div>`).join('')}
            </div>
            <div id="f-drop-zone" style="border:1.5px dashed var(--border);border-radius:6px;padding:8px;text-align:center;cursor:pointer;background:var(--page-bg)">
              <p style="color:var(--muted);font-size:11px">Drop or click to add</p>
            </div>
            <input type="file" id="f-file-input" multiple accept=".pdf,image/*" style="display:none">
            <div id="f-file-list" style="margin-top:5px;display:flex;flex-wrap:wrap;gap:4px"></div>
          </div>

        </div>
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

  // Contract selector
  const contractSel = modal.querySelector('#f-contract');
  const contractSummary = modal.querySelector('#f-contract-summary');

  async function updateContractSummary() {
    const cId = contractSel?.value;
    if (!cId) { contractSummary.style.display = 'none'; return; }
    const c = _contracts.find(x => x.id === cId);
    if (!c) return;
    contractSummary.style.display = 'grid';
    const qty = parseFloat(c.quantity) || 0;
    const unit = c.unit || '';
    const existing_invs = _invoices.filter(i => i.forward_contract_id === cId && i.id !== existing?.id);
    const invoicedQty = existing_invs.reduce((s, i) => {
      const batches = i.batches || [];
      if (batches.length) return s + batches.reduce((ss, b) => ss + (parseFloat(b.qty)||0), 0);
      return s + (i.line_items||[]).reduce((ss, l) => ss + (parseFloat(l.qty)||0), 0);
    }, 0);
    const invoicedVal = existing_invs.reduce((s, i) => s + (parseFloat(i.gross_amount)||0), 0);
    const cs = modal.querySelector('#cs-qty');
    const ci = modal.querySelector('#cs-invoiced');
    const cr = modal.querySelector('#cs-remaining');
    const ca = modal.querySelector('#cs-avg');
    if (cs) cs.textContent = formatNumber(qty, 0) + ' ' + unit;
    if (ci) ci.textContent = formatNumber(invoicedQty, 0) + ' ' + unit;
    if (cr) cr.textContent = formatNumber(Math.max(0, qty - invoicedQty), 0) + ' ' + unit;
    if (ca) ca.textContent = invoicedQty ? formatCurrency(invoicedVal / invoicedQty, 2) : '—';
    // Auto-fill buyer
    const buyerField = modal.querySelector('#f-buyer');
    const opt = contractSel.options[contractSel.selectedIndex];
    if (buyerField && opt?.dataset?.buyer && !buyerField.value) buyerField.value = opt.dataset.buyer;
  }
  contractSel?.addEventListener('change', updateContractSummary);
  if (contractSel?.value) updateContractSummary();

  // ── Batch system ──────────────────────────────────────────
  let _batchCounter = 0;
  const batchesWrap = modal.querySelector('#f-batches-wrap');
  const masterUnitSel = modal.querySelector('#f-master-unit');

  const COMMODITIES = ['Cotton Lint','Cotton Seed','Wheat','Barley','Canola','Sorghum','Cattle','Other'];
  const CROP_YEARS = ['2025-26','2026-27','2024-25','2023-24','2022-23'];

  function getUnit() { return masterUnitSel?.value || 'bale'; }

  function addBatch(data = {}) {
    const bId = ++_batchCounter;
    const div = document.createElement('div');
    div.dataset.batchId = bId;
    div.style.cssText = 'border:1px solid var(--border);border-radius:8px;margin-bottom:12px;overflow:hidden';

    const unit = getUnit();
    const cropYears = CROP_YEARS;

    div.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#f8f9fa;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;font-weight:600;color:var(--hint)">BATCH ${bId}</span>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:var(--hint)">Qty</label>
          <input type="number" class="form-input num b-qty" step="0.001" style="width:100px" value="${data.qty||''}" placeholder="0">
          <span class="b-unit-label" style="font-size:12px;color:var(--hint)">${unit}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:var(--hint)">Crop year</label>
          <select class="form-select b-crop-year" style="width:100px">
            ${cropYears.map(y=>`<option${y===(data.crop_year||getActiveSeason()||'2025-26')?' selected':''}>${y}</option>`).join('')}
          </select>
        </div>
        <div style="flex:1"></div>
        <button class="btn-remove-batch btn btn-ghost btn-sm" style="color:var(--red);font-size:13px" title="Remove batch">✕</button>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:700px">
          <thead>
            <tr style="background:#fafafa;border-bottom:1px solid var(--border-light)">
              <th style="padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;min-width:160px">Description</th>
              <th style="padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;min-width:110px">Docket / ID</th>
              <th style="padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:right;min-width:110px">Amount ($)</th>
              <th style="padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:right;min-width:90px">Eff. $/unit</th>
              <th style="padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;min-width:150px">Notes</th>
              <th style="width:30px"></th>
            </tr>
          </thead>
          <tbody class="b-lines"></tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-top:1px solid var(--border-light);background:#fafafa">
        <button class="btn btn-ghost btn-sm b-add-line" style="font-size:12px">＋ Add line</button>
        <div style="font-size:12px;color:var(--hint)">Net: <strong class="b-net" style="color:var(--ink)">$0.00</strong></div>
      </div>
    `;

    batchesWrap.appendChild(div);

    // Wire remove batch
    div.querySelector('.btn-remove-batch').addEventListener('click', () => {
      if (batchesWrap.children.length > 1 || confirm('Remove this batch?')) div.remove();
      recalcTotals();
    });

    // Wire qty change → update eff $/unit
    div.querySelector('.b-qty').addEventListener('input', () => {
      recalcBatch(div);
      recalcTotals();
    });

    // Wire add line
    div.querySelector('.b-add-line').addEventListener('click', () => addBatchLine(div));

    // Wire unit label update
    masterUnitSel?.addEventListener('change', () => {
      div.querySelector('.b-unit-label').textContent = getUnit();
    });

    // Load existing lines
    (data.lines || []).forEach(l => addBatchLine(div, l));
    if (!(data.lines||[]).length) addBatchLine(div);

    recalcBatch(div);
  }

  function addBatchLine(batchDiv, data = {}) {
    const tbody = batchDiv.querySelector('.b-lines');
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-light)';
    const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:4px 6px;font-size:12px;background:white;width:100%';
    const numS = inS + ';text-align:right';
    const isExpense = data.type === 'expense' || (data.amount < 0);

    tr.innerHTML = `
      <td style="padding:4px 6px;min-width:160px">
        <input type="text" class="bl-desc" style="${inS}" value="${data.description||''}" placeholder="e.g. Cotton Lint, Ginning…">
      </td>
      <td style="padding:4px 6px;min-width:110px">
        <input type="text" class="bl-docket" style="${inS}" value="${data.docket||''}" placeholder="Docket">
      </td>
      <td style="padding:4px 6px;min-width:110px">
        <input type="number" class="bl-amount" style="${numS}" step="0.01" value="${data.amount!=null?data.amount:''}" placeholder="0.00">
      </td>
      <td style="padding:4px 6px;min-width:90px;text-align:right;font-size:12px;color:var(--hint);font-weight:500">
        <span class="bl-eff">—</span>
      </td>
      <td style="padding:4px 6px;min-width:150px">
        <input type="text" class="bl-notes" style="${inS}" value="${data.notes||''}" placeholder="Notes…">
      </td>
      <td style="padding:4px 6px;text-align:center">
        <button style="background:none;border:none;cursor:pointer;color:var(--hint);font-size:14px" onclick="this.closest('tr').remove();recalcBatch(this.closest('[data-batch-id]'));recalcTotals()">✕</button>
      </td>
    `;

    tbody.appendChild(tr);

    // Wire amount change
    tr.querySelector('.bl-amount').addEventListener('input', () => {
      recalcBatch(batchDiv);
      recalcTotals();
    });

    recalcBatch(batchDiv);
  }

  function recalcBatch(batchDiv) {
    const qty = parseFloat(batchDiv.querySelector('.b-qty')?.value) || 0;
    let net = 0;
    batchDiv.querySelectorAll('.b-lines tr').forEach(tr => {
      const amount = parseFloat(tr.querySelector('.bl-amount')?.value) || 0;
      net += amount;
      const effEl = tr.querySelector('.bl-eff');
      if (effEl) {
        if (qty && amount !== 0) {
          effEl.textContent = formatCurrency(amount / qty, 2);
          effEl.style.color = amount < 0 ? 'var(--red)' : 'var(--green)';
        } else {
          effEl.textContent = '—';
          effEl.style.color = 'var(--hint)';
        }
      }
    });
    const netEl = batchDiv.querySelector('.b-net');
    if (netEl) {
      netEl.textContent = formatCurrency(net, 2);
      netEl.style.color = net < 0 ? 'var(--red)' : 'var(--ink)';
    }
  }

  function recalcTotals() {
    let gross = 0, expenses = 0;
    batchesWrap.querySelectorAll('[data-batch-id]').forEach(bDiv => {
      bDiv.querySelectorAll('.b-lines tr').forEach(tr => {
        const amount = parseFloat(tr.querySelector('.bl-amount')?.value) || 0;
        if (amount >= 0) gross += amount;
        else expenses += amount;
      });
    });
    const net = gross + expenses;
    const tg = modal.querySelector('#t-gross');
    const td = modal.querySelector('#t-ded');
    const tn = modal.querySelector('#t-net');
    const tt = modal.querySelector('#t-total');
    if (tg) tg.textContent = formatCurrency(gross, 2);
    if (td) td.textContent = expenses ? formatCurrency(expenses, 2) : '—';
    if (tn) tn.textContent = formatCurrency(net, 2);
    if (tt) tt.textContent = formatCurrency(net, 2);
  }

  // Add batch button
  modal.querySelector('#f-add-batch')?.addEventListener('click', () => addBatch());

  // Load existing batches or start with one empty
  const existingBatches = existing?.batches;
  if (existingBatches?.length) {
    existingBatches.forEach(b => addBatch(b));
  } else {
    addBatch();
  }

  recalcTotals();

  // ── File attachments ──────────────────────────────────────
  let rctiFiles = [], ginFiles = [], attachments = [];

  function wireMultiZone(zoneId, inputId, fileArr, listId) {
    const zone = modal.querySelector('#'+zoneId);
    const inp = modal.querySelector('#'+inputId);
    if (!zone || !inp) return;
    zone.addEventListener('click', () => inp.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.style.borderColor='var(--blue)'; });
    zone.addEventListener('dragleave', () => zone.style.borderColor='');
    zone.addEventListener('drop', e => { e.preventDefault(); zone.style.borderColor=''; addToSection(e.dataTransfer.files, fileArr, listId); });
    inp.addEventListener('change', () => { addToSection(inp.files, fileArr, listId); inp.value=''; });
  }

  function addToSection(fileList, fileArr, listId) {
    const list = modal.querySelector('#'+listId);
    [...fileList].forEach(f => {
      fileArr.push(f);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:3px 8px;background:var(--page-bg);border-radius:4px;font-size:11px;margin-top:3px';
      row.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">📎 ${f.name}</span><span style="cursor:pointer;color:var(--hint);margin-left:6px;font-size:13px" onclick="this.closest('div').remove()">×</span>`;
      list?.appendChild(row);
    });
  }

  wireMultiZone('f-rcti-zone', 'f-rcti-input', rctiFiles, 'f-rcti-list');
  wireMultiZone('f-gin-zone', 'f-gin-input', ginFiles, 'f-gin-list');

  const dropZone = modal.querySelector('#f-drop-zone');
  const fileInput = modal.querySelector('#f-file-input');
  dropZone?.addEventListener('click', () => fileInput.click());
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor='var(--blue)'; });
  dropZone?.addEventListener('dragleave', () => dropZone.style.borderColor='');
  dropZone?.addEventListener('drop', e => { e.preventDefault(); dropZone.style.borderColor=''; addToSection(e.dataTransfer.files, attachments, 'f-file-list'); });
  fileInput?.addEventListener('change', () => { addToSection(fileInput.files, attachments, 'f-file-list'); fileInput.value=''; });


  modal.querySelector('#f-save').addEventListener('click', async () => {
    const btn = modal.querySelector('#f-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const farm = getActiveFarm();
      const session = getSession();

      // Collect batches
      const batches = [];
      let grossTotal = 0, expensesTotal = 0;

      batchesWrap.querySelectorAll('[data-batch-id]').forEach(bDiv => {
        const qty = parseFloat(bDiv.querySelector('.b-qty')?.value) || 0;
        const cropYear = bDiv.querySelector('.b-crop-year')?.value || '';
        const lines = [];
        bDiv.querySelectorAll('.b-lines tr').forEach(tr => {
          const amount = parseFloat(tr.querySelector('.bl-amount')?.value);
          if (!amount && amount !== 0) return;
          const line = {
            description: tr.querySelector('.bl-desc')?.value?.trim() || '',
            docket: tr.querySelector('.bl-docket')?.value?.trim() || '',
            amount,
            notes: tr.querySelector('.bl-notes')?.value?.trim() || '',
            eff_per_unit: qty ? Math.round((amount / qty) * 10000) / 10000 : null,
          };
          lines.push(line);
          if (amount >= 0) grossTotal += amount;
          else expensesTotal += amount;
        });
        if (lines.length) batches.push({ qty, crop_year: cropYear, lines });
      });

      const netAmount = grossTotal + expensesTotal;
      const masterUnit = modal.querySelector('#f-master-unit')?.value || 'bale';
      const totalQty = batches.reduce((s, b) => s + (b.qty || 0), 0);

      const row = {
        farm_id: farm.id,
        buyer: modal.querySelector('#f-buyer')?.value?.trim() || '',
        invoice_date: modal.querySelector('#f-date')?.value,
        forward_contract_id: modal.querySelector('#f-contract')?.value || null,
        sale_type: modal.querySelector('#f-contract')?.value ? 'against_contract' : 'cash',
        gst_type: modal.querySelector('#f-gst')?.value || 'ex',
        master_unit: masterUnit,
        batches,
        // Keep legacy fields for display + filter compatibility
        line_items: batches.flatMap(b => b.lines.filter(l => l.amount >= 0).map(l => ({
          commodity: l.description, docket: l.docket, qty: b.qty, unit: masterUnit,
          season: b.crop_year, total: l.amount, price: b.qty ? l.amount/b.qty : 0, notes: l.notes,
        }))),
        deductions: batches.flatMap(b => b.lines.filter(l => l.amount < 0).map(l => ({
          description: l.description, docket: l.docket, qty: b.qty, unit: masterUnit,
          season: b.crop_year, value: Math.abs(l.amount), rate: b.qty ? Math.abs(l.amount)/b.qty : 0, notes: l.notes,
        }))),
        total_qty: totalQty,
        gross_amount: grossTotal,
        total_deductions: Math.abs(expensesTotal),
        net_amount: netAmount,
        total_quality_adj: 0,
        status: 'pending',
        notes: modal.querySelector('#f-notes')?.value?.trim() || '',
      };

      if (!row.invoice_date) throw new Error('Please enter a date');
      if (!batches.length) throw new Error('Please add at least one batch');

      // Upload attachments
      const uploadFile2 = async (file, prefix) => {
        const path = `invoices/${farm.id}/${Date.now()}_${prefix}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const contentType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
        const res = await fetch(`https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/cfm-documents/${path}`, {
          method: 'POST',
          headers: { 'apikey': window.__CFM_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': contentType, 'x-upsert': 'true' },
          body: file,
        });
        if (!res.ok) {
          const errText = await res.text();
          console.error('Upload failed:', res.status, errText, 'Path:', path);
          throw new Error(`Upload failed (${res.status}): ${errText}`);
        }
        return { url: `https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/public/cfm-documents/${path}`, filename: file.name };
      };

      const existingRctiFiles = existing?.rcti_files || (existing?.rcti_url ? [{ url: existing.rcti_url, filename: existing.rcti_filename }] : []);
      const newRctiUploads = await Promise.all(rctiFiles.map(f => uploadFile2(f, 'rcti')));
      const allRctiFiles = [...existingRctiFiles, ...newRctiUploads];

      const existingGinFiles = existing?.gin_files || (existing?.gin_url ? [{ url: existing.gin_url, filename: existing.gin_filename }] : []);
      const newGinUploads = await Promise.all(ginFiles.map(f => uploadFile2(f, 'gin')));
      const allGinFiles = [...existingGinFiles, ...newGinUploads];

      const otherUploads = await Promise.all(attachments.map(f => uploadFile2(f, 'other')));
      const existingOtherFiles = existing?.other_files || [];
      const allOtherFiles = [...existingOtherFiles, ...otherUploads];

      row.rcti_files = allRctiFiles;
      row.gin_files = allGinFiles;
      row.other_files = allOtherFiles;
      row.rcti_url = allRctiFiles[0]?.url || null;
      row.rcti_filename = allRctiFiles[0]?.filename || null;
      row.gin_url = allGinFiles[0]?.url || null;
      row.gin_filename = allGinFiles[0]?.filename || null;

      if (existing?.id) {
        await dbUpdate('invoices', existing.id, row);
        toast('Invoice updated', 'success');
      } else {
        await dbInsert('invoices', row);
        toast('Invoice saved', 'success');
      }

      close();
      // Reload invoices
      await _loadData();
      _renderTable(container);

    } catch (err) {
      toast(err.message || 'Save failed', 'error');
      console.error('Save error:', err);
    }
    btn.disabled = false; btn.textContent = '✓ Save — pending';
  });

}