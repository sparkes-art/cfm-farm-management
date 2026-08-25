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

        <select id="inv-filter-month" class="form-select" style="width:130px">
          <option value="">All months</option>
        </select>
        <select id="inv-filter-commodity" class="form-select" style="width:160px">
          <option value="">All commodities</option>
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
  const commodity = document.getElementById('inv-filter-commodity')?.value || '';
  const contract = document.getElementById('inv-filter-contract')?.value || '';
  const month = document.getElementById('inv-filter-month')?.value || '';
  return _invoices.filter(i => {
    const commodityMatch = !commodity || 
      (i.line_items||[]).some(l => l.commodity === commodity) ||
      (() => {
        if (!i.batches) return false;
        const b = typeof i.batches==='string'?JSON.parse(i.batches):i.batches;
        return b.some(batch => (batch.lines||[]).some(l => l.description === commodity));
      })() ||
      _contracts.find(c => c.id === i.forward_contract_id)?.commodity === commodity;
    const monthMatch = !month || (i.invoice_date && i.invoice_date.slice(0,7) === month);
    const contractMatch = !contract
      ? true
      : contract === 'cash'
        ? !i.forward_contract_id
        : i.forward_contract_id === contract;
    if (!season) return commodityMatch && contractMatch && monthMatch;
    const seasonMatch = i.season === season || (i.line_items || []).some(l => l.season === season);
    return seasonMatch && commodityMatch && contractMatch && monthMatch;
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
  // Rebuild month filter
  const _monthSel = document.getElementById('inv-filter-month');
  if (_monthSel) {
    const _mv = _monthSel.value;
    const months = [...new Set(_invoices.map(i => i.invoice_date?.slice(0,7)).filter(Boolean))].sort().reverse();
    _monthSel.innerHTML = '<option value="">All months</option>' +
      months.map(m => {
        const [y,mo] = m.split('-');
        const label = new Date(y, mo-1).toLocaleDateString('en-AU',{month:'short',year:'numeric'});
        return `<option value="${m}" ${_mv===m?'selected':''}>${label}</option>`;
      }).join('');
    if (!_monthSel.dataset.wired) { _monthSel.dataset.wired = '1'; _monthSel.addEventListener('change', () => _renderTable(container)); }
  }

  // Rebuild commodity filter with live data
  const _commodSel = document.getElementById('inv-filter-commodity');
  if (_commodSel) {
    const _cv2 = _commodSel.value;
    const commodities = [...new Set([
      ..._invoices.map(i => _contracts.find(c => c.id === i.forward_contract_id)?.commodity).filter(Boolean),
      ..._invoices.flatMap(i => (i.line_items||[]).map(l => l.commodity).filter(Boolean)),
      ..._invoices.flatMap(i => {
        if (!i.batches) return [];
        const b = typeof i.batches==='string' ? JSON.parse(i.batches) : i.batches;
        return b.flatMap(batch => (batch.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa').map(l=>l.description).filter(Boolean));
      }),
      ..._contracts.map(c => c.commodity).filter(Boolean),
    ])].sort();
    _commodSel.innerHTML = '<option value="">All commodities</option>' +
      commodities.map(c => `<option value="${c}" ${_cv2===c?'selected':''}>${c}</option>`).join('');
    if (!_commodSel.dataset.wired) { _commodSel.dataset.wired = '1'; _commodSel.addEventListener('change', () => _renderTable(container)); }
  }

  // Rebuild contract filter with live data
  const _csel = document.getElementById('inv-filter-contract');
  if (_csel && _contracts.length) {
    const _cv = _csel.value;
    _csel.innerHTML = '<option value="">All contracts</option><option value="cash">Cash sales only</option>' +
      _contracts.map(c => `<option value="${c.id}" ${_cv===c.id?'selected':''}>${c.contract_number||'Contract'} — ${c.commodity||''}</option>`).join('');
    if (!_csel.dataset.wired) {
      _csel.dataset.wired = '1';
      _csel.addEventListener('change', () => _renderTable(container));
    }
  }
  const rows = _filtered().sort((a,b) => {
    if (a.status === 'pending' && b.status !== 'pending') return -1;
    if (a.status !== 'pending' && b.status === 'pending') return 1;
    return 0;
  });

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
    <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:0;border-bottom:1px solid var(--border-light)">
      <div style="padding:12px 16px;border-right:1px solid var(--border-light)">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Total qty</div>
        <div style="font-size:18px;font-weight:600;color:var(--ink)">${(() => {
          const qty = rows.reduce((s,i) => {
            if (i.batches) { const b = typeof i.batches==='string'?JSON.parse(i.batches):i.batches; return s+b.filter(x=>(x.lines||[]).some(l=>l.type==='income')).reduce((ss,x)=>ss+(parseFloat(x.qty)||0),0); }
            return s+(parseFloat(i.total_qty)||0);
          }, 0);
          const units = [...new Set(rows.map(i=>i.master_unit).filter(Boolean))];
          return formatNumber(qty,0) + (units.length===1?' '+units[0]:'');
        })()}</div>
      </div>
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
          <!-- Season hidden -->
          <th>Type</th>
          <th>Buyer</th>
          <th>Commodities</th>
          <th class="num">Qty</th>
          <th class="num">Gross</th>
          <th class="num">Quality adj</th>
          <th class="num">Total income</th>
          <th class="num">Selling costs</th>
          <th class="num">Net</th>
          <th>Documents</th>
          <th style="min-width:70px;max-width:90px">Xero ref</th>
          <th>Status</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.map(inv => {
          const lines = inv.line_items || [];
          // For batch invoices get commodity from linked contract
          const contractCommodity = _contracts.find(c => c.id === inv.forward_contract_id)?.commodity;
          const commodities = contractCommodity || 
            [...new Set(lines.map(l => l.commodity).filter(Boolean))].join(', ') || 
            (() => {
              if (!inv.batches) return null;
              const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
              const descs = [...new Set(b.flatMap(batch => (batch.lines||[]).filter(l=>l.type==='income'&&l.line_type!=='qa').map(l=>l.description).filter(Boolean)))];
              return descs.join(', ');
            })() || inv.commodity_type || '—';
          return `
            <tr style="cursor:pointer" data-id="${inv.id}">
              <td class="muted" style="font-size:11px;white-space:nowrap">${inv.invoice_date ? new Date(inv.invoice_date+'T00:00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'numeric',year:'2-digit'}) : '—'}</td>
              <td><span class="badge ${inv.sale_type === 'against_contract' ? 'badge-issued' : 'badge-draft'}">${inv.sale_type === 'against_contract' ? 'Contract' : 'Cash'}</span></td>
              <td><strong>${inv.buyer || '—'}</strong></td>
              <td class="muted text-sm">${commodities}</td>
              <td class="num text-sm">${(() => {
                if (inv.batches && inv.batches.length) {
                  const b = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
                  const qty = b.filter(x => (x.lines||[]).some(l => l.type==='income')).reduce((s,x) => s+(parseFloat(x.qty)||0), 0);
                  const unit = inv.master_unit || '';
                  return qty ? formatNumber(qty,2)+' '+unit : '—';
                }
                return inv.total_qty ? formatNumber(inv.total_qty,2)+' '+(inv.master_unit||'') : '—';
              })()}</td>
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
                ${canWrite() ? `<input class="xero-ref-input" data-id="${inv.id}" value="${inv.xero_invoice_number || ''}" style="border:none;background:transparent;width:65px;font-size:11px;color:var(--hint)" placeholder="—">` : inv.xero_invoice_number || '—'}
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
                    <button class="btn btn-ghost btn-sm del-inv-btn" data-id="${inv.id}" style="color:var(--red)">Delete</button>
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

  // Delete button
  wrap.querySelectorAll('.del-inv-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      e.preventDefault();
      const inv = _invoices.find(i => i.id === btn.dataset.id);
      if (!inv) return;
      openModal({
        title: 'Delete invoice',
        bodyHTML: '<p style="font-size:14px">Delete invoice for <strong>' + (inv.buyer || 'this buyer') + '</strong>' + (inv.invoice_date ? ' dated ' + formatDate(inv.invoice_date) : '') + '?</p>' + (inv.xero_invoice_number ? '<p style="color:var(--amber);font-size:13px;margin-top:6px">⚠️ This invoice has been pushed to Xero as <strong>' + inv.xero_invoice_number + '</strong>. Deleting here will not remove it from Xero.</p>' : '') + '<p style="color:var(--red);font-size:13px;margin-top:8px">This cannot be undone.</p>',
        confirmLabel: 'Delete',
        confirmClass: 'btn-danger',
        onConfirm: async () => {
          try {
            await dbDelete('invoices', inv.id);
            _invoices = _invoices.filter(i => i.id !== inv.id);
            toast('Invoice deleted', 'success');
            _renderTable(container);
          } catch(err) {
            toast('Delete failed: ' + err.message, 'error');
          }
        }
      });
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
// Get past line descriptions scoped to current farm+season
function _getPastDescriptions(type) {
  const season = getActiveSeason();
  const descs = new Set();
  _invoices.forEach(inv => {
    if (season && inv.season && inv.season !== season) return;
    if (inv.batches) {
      const b = typeof inv.batches==='string'?JSON.parse(inv.batches):inv.batches;
      b.forEach(batch => (batch.lines||[]).forEach(l => {
        if (l.type === type && l.description?.trim()) descs.add(l.description.trim());
      }));
    }
    (inv.line_items||[]).forEach(l => {
      if (l.type === type && l.description?.trim()) descs.add(l.description.trim());
    });
  });
  return [...descs].sort();
}

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
          <div style="position:relative" id="f-contract-wrap">
            <input type="text" id="f-contract-search" class="form-input" placeholder="Search contracts..." autocomplete="off"
              value="${existing?.forward_contract_id ? (() => { const c = _contracts.find(x=>x.id===existing.forward_contract_id); return c ? (c.contract_number||'Contract')+' — '+(c.commodity||'')+' — '+formatNumber(c.quantity,0)+' '+(c.unit||'')+' @ '+formatCurrency(c.price_per_unit,2) : ''; })() : ''}"
              style="width:100%">
            <input type="hidden" id="f-contract" value="${existing?.forward_contract_id||''}">
            <div id="f-contract-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:200;background:white;border:1px solid var(--border);border-radius:var(--radius-md);margin-top:2px;max-height:220px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1)">
              <div id="f-contract-opts"></div>
            </div>
          </div>
        </div>
        <div id="f-contract-summary" style="display:none;grid-template-columns:repeat(4,1fr) 1.2fr;gap:10px;background:var(--blue-light);border-radius:var(--radius-sm);padding:12px;margin-top:8px">
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Contract qty</p><p id="cs-qty" style="font-weight:600;color:var(--blue-text)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Already invoiced</p><p id="cs-invoiced" style="font-weight:600;color:var(--blue-text)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Remaining</p><p id="cs-remaining" style="font-weight:600;color:var(--blue)">—</p></div>
          <div><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Avg price to date</p><p id="cs-avg" style="font-weight:600;color:var(--blue-text)">—</p></div>
          <div style="border-left:2px solid var(--blue);padding-left:10px"><p style="font-size:10px;color:var(--blue-text);text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">Contract price</p><p id="cs-price" style="font-size:18px;font-weight:700;color:var(--blue)">—</p></div>
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

      <!-- Other documents (for items not tied to a specific batch) -->
      <div style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border:1px solid var(--border);border-radius:8px;background:var(--page-bg)">
          <span style="font-size:11px;font-weight:600;color:var(--hint)">📎 Other documents</span>
          <button id="f-other-attach" class="btn btn-ghost btn-sm" style="font-size:11px">Attach</button>
          <input type="file" id="f-file-input" multiple accept=".pdf,image/*" style="display:none">
          <div id="f-file-list" style="display:flex;flex-wrap:wrap;gap:4px;flex:1">
            ${(existing?.other_files||[]).map(f=>`<a href="${f.url}" target="_blank" style="display:inline-flex;align-items:center;gap:4px;background:white;border:1px solid var(--border-light);border-radius:12px;padding:2px 8px;font-size:10px;text-decoration:none;color:var(--blue)">📎 ${(f.filename||'file').slice(0,20)}</a>`).join('')}
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
      if (i.batches && i.batches.length) {
        const b = typeof i.batches==='string'?JSON.parse(i.batches):i.batches;
        return s + b.filter(batch=>(batch.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa')).reduce((ss,batch)=>ss+(parseFloat(batch.qty)||0),0);
      }
      const lines = (i.line_items||[]).filter(l=>l.type!=='expense'&&l.line_type!=='qa');
      const seen = new Set();
      return s + lines.reduce((ss,l)=>{
        const key=l.docket||l.commodity||JSON.stringify(l);
        if(seen.has(key))return ss; seen.add(key);
        return ss+(parseFloat(l.qty)||0);
      },0);
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
    const cp = modal.querySelector('#cs-price');
    if (cp) cp.textContent = c.price_per_unit ? formatCurrency(c.price_per_unit, 2) + ' / ' + (c.unit||'unit') : '—';
    // Auto-fill buyer
    const buyerField = modal.querySelector('#f-buyer');
    const opt = contractSel.options[contractSel.selectedIndex];
    if (buyerField && opt?.dataset?.buyer) buyerField.value = opt.dataset.buyer;

    // Pre-fill income line descriptions with commodity name when contract changes
    if (opt?.dataset?.commodity) {
      const batchesWrap = modal.querySelector('#f-batches-wrap');
      batchesWrap?.querySelectorAll('[data-batch-id]').forEach(bDiv => {
        bDiv.querySelectorAll('.b-income-lines tr').forEach((tr, idx) => {
          const descInput = tr.querySelector('.bl-desc');
          if (descInput && (!descInput.value || descInput.value === descInput.dataset.prevCommodity)) {
            descInput.value = opt.dataset.commodity;
            descInput.dataset.prevCommodity = opt.dataset.commodity;
          }
        });
      });
    }
  }
  // Searchable contract dropdown
  const searchInput = modal.querySelector('#f-contract-search');
  const hiddenInput = modal.querySelector('#f-contract');
  const dropdown = modal.querySelector('#f-contract-dropdown');
  const optsWrap = modal.querySelector('#f-contract-opts');

  const renderOpts = (filter='') => {
    const lower = filter.toLowerCase();
    const filtered = _contracts.filter(c =>
      !lower ||
      (c.contract_number||'').toLowerCase().includes(lower) ||
      (c.commodity||'').toLowerCase().includes(lower) ||
      (c.counterparty||c.buyer||'').toLowerCase().includes(lower)
    );
    optsWrap.innerHTML = filtered.length
      ? filtered.map(c => {
          const label = `${c.contract_number||'Contract'} — ${c.commodity||''} — ${formatNumber(c.quantity,0)} ${c.unit||''} @ ${formatCurrency(c.price_per_unit,2)}`;
          const isSelected = hiddenInput.value === c.id;
          return `<div class="f-contract-opt" data-id="${c.id}" data-price="${c.price_per_unit}" data-unit="${c.unit||'t'}" data-qty="${c.quantity||0}" data-buyer="${c.counterparty||c.buyer||''}" data-commodity="${c.commodity||''}"
            style="padding:8px 12px;cursor:pointer;font-size:13px;color:var(--ink);${isSelected?'background:var(--blue-light);font-weight:600':''}">${label}</div>`;
        }).join('')
      : '<div style="padding:10px 12px;font-size:13px;color:var(--hint)">No contracts found</div>';

    optsWrap.querySelectorAll('.f-contract-opt').forEach(opt => {
      opt.addEventListener('mouseenter', () => opt.style.background='var(--page-bg)');
      opt.addEventListener('mouseleave', () => opt.style.background = hiddenInput.value===opt.dataset.id?'var(--blue-light)':'');
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        hiddenInput.value = opt.dataset.id;
        searchInput.value = opt.textContent.trim();
        dropdown.style.display = 'none';
        // Trigger contract summary update
        const fakeOpt = { dataset: opt.dataset, value: opt.dataset.id };
        updateContractSummaryFromOpt(fakeOpt);
      });
    });
  };

  searchInput?.addEventListener('focus', () => { renderOpts(searchInput.value); dropdown.style.display='block'; });
  searchInput?.addEventListener('input', () => { hiddenInput.value=''; renderOpts(searchInput.value); dropdown.style.display='block'; });
  searchInput?.addEventListener('blur', () => setTimeout(()=>{ dropdown.style.display='none'; }, 150));
  document.addEventListener('keydown', e => { if(e.key==='Escape') dropdown.style.display='none'; });

  // Rewrite updateContractSummary to accept an opt object
  const updateContractSummaryFromOpt = (opt) => {
    const cId = opt?.dataset?.id || opt?.value || hiddenInput.value;
    if (!cId) { contractSummary.style.display='none'; return; }
    contractSummary.style.display='grid';
    const qty = parseFloat(opt?.dataset?.qty||0);
    const price = parseFloat(opt?.dataset?.price||0);
    const unit = opt?.dataset?.unit||'unit';
    const buyer = opt?.dataset?.buyer||'';
    const commodity = opt?.dataset?.commodity||'';
    const contractInvoices = _invoices.filter(i => i.forward_contract_id===cId && i.id!==existing?.id);
    const invoicedQty = contractInvoices.reduce((s,i)=>{
      if(i.batches){const b=typeof i.batches==='string'?JSON.parse(i.batches):i.batches;return s+b.filter(x=>(x.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa')).reduce((ss,x)=>ss+(parseFloat(x.qty)||0),0);}
      const lines=(i.line_items||[]).filter(l=>l.type!=='expense'&&l.line_type!=='qa');const seen=new Set();
      return s+lines.reduce((ss,l)=>{const k=l.docket||l.commodity||JSON.stringify(l);if(seen.has(k))return ss;seen.add(k);return ss+(parseFloat(l.qty)||0);},0);
    },0);
    const invoicedValue = contractInvoices.reduce((s,i)=>s+(parseFloat(i.gross_amount)||0)+(parseFloat(i.total_quality_adj)||0),0);
    const remaining = Math.max(0, qty - invoicedQty);
    modal.querySelector('#cs-qty').textContent = formatNumber(qty,0)+' '+unit;
    modal.querySelector('#cs-invoiced').textContent = formatNumber(invoicedQty,2)+' '+unit;
    modal.querySelector('#cs-remaining').textContent = formatNumber(remaining,2)+' '+unit;
    modal.querySelector('#cs-avg').textContent = invoicedQty ? formatCurrency(invoicedValue/invoicedQty,2) : '—';
    modal.querySelector('#cs-price').textContent = formatCurrency(price,2)+' / '+unit;
    const buyerField = modal.querySelector('#f-buyer');
    if (buyerField && buyer) buyerField.value = buyer;
    // Pre-fill income descriptions
    if (commodity) {
      modal.querySelector('#f-batches-wrap')?.querySelectorAll('.b-income-lines tr').forEach(tr => {
        const d = tr.querySelector('.bl-desc');
        if (d && (!d.value || d.value===d.dataset.prevCommodity)) { d.value=commodity; d.dataset.prevCommodity=commodity; }
      });
    }
  };

  contractSel?.addEventListener('change', updateContractSummary);
  if (hiddenInput?.value) updateContractSummaryFromOpt({dataset:{id:hiddenInput.value,...(() => { const c=_contracts.find(x=>x.id===hiddenInput.value); return c?{qty:c.quantity||0,price:c.price_per_unit||0,unit:c.unit||'t',buyer:c.counterparty||c.buyer||'',commodity:c.commodity||''}:{}; })()}});

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

    const thStyle = 'padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:500';
    div.innerHTML = `
      <!-- Batch header -->
      <div style="display:flex;align-items:center;gap:12px;padding:10px 12px;background:#f8f9fa;border-bottom:1px solid var(--border)">
        <span style="font-size:12px;font-weight:600;color:var(--hint)">BATCH ${bId}</span>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:11px;color:var(--hint)">Qty</label>
          <input type="number" class="form-input num b-qty" step="0.001" style="width:100px" value="${data.qty||''}" placeholder="0">
          <span class="b-unit-label" style="font-size:12px;color:var(--hint)">${unit}</span>
        </div>
        <div style="flex:1"></div>
        <button class="btn-remove-batch btn btn-ghost btn-sm" style="color:var(--red);font-size:13px" title="Remove batch">✕</button>
      </div>

      <!-- Income section -->
      <div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border-light)">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#166534;min-width:60px">Income</span>
        <input type="text" class="b-income-docket form-input" style="width:130px;font-size:12px;padding:3px 8px" placeholder="Docket / ID" value="${data.income_docket||''}">
        <div class="b-income-files-wrap b-files-wrap" style="display:flex;align-items:center;gap:6px;flex:1;border:1.5px dashed var(--border);border-radius:6px;padding:4px 8px;min-height:32px;cursor:pointer" title="Drop files here or click Attach">
          <button class="b-income-attach btn btn-ghost btn-sm" style="font-size:11px;white-space:nowrap">📄 Attach</button>
          <input type="file" class="b-income-file-input" multiple accept=".pdf,image/*" style="display:none">
          <button class="b-extract-rcti btn btn-ghost btn-sm" style="font-size:11px;white-space:nowrap;color:var(--blue)">✨ Extract RCTI</button>
          <div class="b-income-file-list" style="display:flex;flex-wrap:wrap;gap:4px;flex:1"></div>
          <span style="font-size:10px;color:var(--hint);white-space:nowrap">Drop files here</span>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--border-light);background:#fafafa">
            <th style="${thStyle};text-align:left;min-width:90px">Type</th>
            <th style="${thStyle};text-align:left;min-width:160px">Description</th>
            <th style="${thStyle};text-align:right;min-width:130px">Amount ($)</th>
            <th style="${thStyle};text-align:right;min-width:100px">Eff. $/unit</th>
            <th style="${thStyle};text-align:left;min-width:150px">Notes</th>
            <th style="width:30px"></th>
          </tr></thead>
          <tbody class="b-income-lines"></tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:var(--page-bg);border-bottom:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm b-add-income" style="font-size:12px;color:#166534">＋ Add income line</button>
        <div style="display:flex;gap:16px;align-items:center;font-size:12px">
          <span style="color:#166534;font-weight:600">Total income: <strong class="b-total-income" style="color:#166534">$0.00</strong></span>
        </div>
      </div>

      <!-- Expenses section -->
      <div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-bottom:1px solid var(--border-light)">
        <span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#9a3412;min-width:60px">Expenses</span>
        <input type="text" class="b-expense-docket form-input" style="width:130px;font-size:12px;padding:3px 8px" placeholder="Docket / ID" value="${data.expense_docket||''}">
        <div class="b-expense-files-wrap b-files-wrap" style="display:flex;align-items:center;gap:6px;flex:1;border:1.5px dashed var(--border);border-radius:6px;padding:4px 8px;min-height:32px;cursor:pointer" title="Drop files here or click Attach">
          <button class="b-expense-attach btn btn-ghost btn-sm" style="font-size:11px;white-space:nowrap">🧾 Attach</button>
          <input type="file" class="b-expense-file-input" multiple accept=".pdf,image/*" style="display:none">
          <button class="b-extract-gin btn btn-ghost btn-sm" style="font-size:11px;white-space:nowrap;color:var(--red)">✨ Extract gin receipt</button>
          <div class="b-expense-file-list" style="display:flex;flex-wrap:wrap;gap:4px;flex:1"></div>
          <span style="font-size:10px;color:var(--hint);white-space:nowrap">Drop files here</span>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--border-light);background:#fafafa">
            <th style="${thStyle};text-align:left;min-width:180px">Description</th>
            <th style="${thStyle};text-align:right;min-width:130px">Amount ($)</th>
            <th style="${thStyle};text-align:right;min-width:100px">Eff. $/unit</th>
            <th style="${thStyle};text-align:left;min-width:150px">Notes</th>
            <th style="width:30px"></th>
          </tr></thead>
          <tbody class="b-expense-lines"></tbody>
        </table>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:var(--page-bg);border-bottom:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm b-add-expense" style="font-size:12px;color:#9a3412">＋ Add expense line</button>
        <div style="font-size:12px;color:#9a3412">
          Total expenses: <strong class="b-expenses" style="color:#9a3412">$0.00</strong>
          <span style="color:var(--border);margin:0 6px">|</span>
          <span class="b-expenses-unit" style="color:#9a3412;font-weight:600">—</span>
        </div>
      </div>

      <!-- Net -->
      <div style="display:flex;justify-content:flex-end;align-items:center;gap:16px;padding:8px 12px;background:#f8fafc">
        <span style="font-size:12px;color:var(--hint)">Net:</span>
        <strong class="b-net" style="font-size:14px;color:var(--ink)">$0.00</strong>
        <span style="color:var(--border)">|</span>
        <span class="b-net-unit" style="font-size:13px;font-weight:600;color:var(--blue)">—</span>
      </div>
    `;

    batchesWrap.appendChild(div);

    // Wire remove batch
    div.querySelector('.btn-remove-batch').addEventListener('click', () => {
      if (batchesWrap.children.length > 1 || confirm('Remove this batch?')) div.remove();
      recalcTotals();
    });

    // Wire qty change
    div.querySelector('.b-qty').addEventListener('input', () => { recalcBatch(div); recalcTotals(); });

    // Wire add income/expense buttons
    div.querySelector('.b-add-income').addEventListener('click', () => {
      const contractSel = modal.querySelector('#f-contract');
      const cId = contractSel?.value;
      const cMatch = _contracts.find(c => c.id === cId);
      const defaultDesc = cMatch?.commodity || contractSel?.options[contractSel?.selectedIndex]?.dataset?.commodity || '';
      addBatchLine(div, { description: defaultDesc }, 'income');
    });
    div.querySelector('.b-add-expense').addEventListener('click', () => addBatchLine(div, {}, 'expense'));

    // Wire attach buttons
    function wireAttach(btnCls, inputCls, listCls, filesArr) {
      const btn = div.querySelector(btnCls);
      const inp = div.querySelector(inputCls);
      const list = div.querySelector(listCls);
      const wrap = btn?.closest('.b-files-wrap');

      function addFiles(fileList) {
        [...fileList].forEach(f => {
          filesArr.push(f);
          const pill = document.createElement('span');
          pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--page-bg);border:1px solid var(--border-light);border-radius:12px;padding:2px 8px;font-size:10px';
          pill.innerHTML = '📎 ' + f.name.slice(0,24) + (f.name.length>24?'…':'') + ' <span style="cursor:pointer;color:var(--hint)" onclick="this.closest(&quot;span&quot;).remove()">×</span>';
          list?.appendChild(pill);
        });
      }

      btn?.addEventListener('click', e => { e.stopPropagation(); inp?.click(); });
      inp?.addEventListener('change', () => { addFiles(inp.files); inp.value = ''; });

      if (wrap) {
        wrap.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); wrap.style.borderColor = 'var(--blue)'; wrap.style.background = '#eff6ff'; });
        wrap.addEventListener('dragleave', e => { wrap.style.borderColor = ''; wrap.style.background = ''; });
        wrap.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); wrap.style.borderColor = ''; wrap.style.background = ''; addFiles(e.dataTransfer.files); });
      }
    }
    // Each batch has its own file arrays (only NEW files to upload)
    div._incomeFiles = [];
    div._expenseFiles = [];

    // Gin receipt extraction button
    div.querySelector('.b-extract-gin')?.addEventListener('click', async () => {
      const tempInput = document.createElement('input');
      tempInput.type = 'file'; tempInput.accept = '.pdf'; tempInput.style.display = 'none';
      document.body.appendChild(tempInput);
      tempInput.addEventListener('change', async () => {
        if (tempInput.files[0]) await _extractFromGinReceipt(div, tempInput.files[0], modal);
        tempInput.remove();
      });
      tempInput.click();
    });

    // RCTI extraction button
    div.querySelector('.b-extract-rcti')?.addEventListener('click', async () => {
      const fileInput = div.querySelector('.b-income-file-input');
      // Check if files already attached, or prompt user to select
      if (div._incomeFiles?.length) {
        await _extractFromRCTI(div, div._incomeFiles[0], modal);
      } else {
        // Trigger file picker then extract
        const tempInput = document.createElement('input');
        tempInput.type = 'file'; tempInput.accept = '.pdf'; tempInput.style.display = 'none';
        document.body.appendChild(tempInput);
        tempInput.addEventListener('change', async () => {
          if (tempInput.files[0]) await _extractFromRCTI(div, tempInput.files[0], modal);
          tempInput.remove();
        });
        tempInput.click();
      }
    });

    // Datalists for description autocomplete (farm+season scoped)
    const _dlIncome = document.createElement('datalist');
    _dlIncome.id = `bl-inc-desc-${bId}`;
    _getPastDescriptions('income').forEach(d => { const o = document.createElement('option'); o.value = d; _dlIncome.appendChild(o); });
    div.appendChild(_dlIncome);
    const _dlExpense = document.createElement('datalist');
    _dlExpense.id = `bl-exp-desc-${bId}`;
    _getPastDescriptions('expense').forEach(d => { const o = document.createElement('option'); o.value = d; _dlExpense.appendChild(o); });
    div.appendChild(_dlExpense);
    wireAttach('.b-income-attach', '.b-income-file-input', '.b-income-file-list', div._incomeFiles);
    wireAttach('.b-expense-attach', '.b-expense-file-input', '.b-expense-file-list', div._expenseFiles);

    // Show existing files
    ['income','expense'].forEach(sec => {
      const existing = data[sec+'_files'] || [];
      const list = div.querySelector('.b-'+sec+'-file-list');
      existing.forEach(f => {
        const pill = document.createElement('a');
        pill.href = f.url; pill.target = '_blank';
        pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--page-bg);border:1px solid var(--border-light);border-radius:12px;padding:2px 8px;font-size:10px;text-decoration:none;color:var(--blue)';
        pill.textContent = '📎 ' + (f.filename||'file').slice(0,20);
        list?.appendChild(pill);
      });
    });

    // Wire unit label update
    masterUnitSel?.addEventListener('change', () => {
      div.querySelector('.b-unit-label').textContent = getUnit();
    });

    // Load existing lines
    (data.lines || []).forEach(l => addBatchLine(div, l, l.type === 'expense' ? 'expense' : 'income'));
    if (!(data.lines||[]).length) {
      const contractSel = modal.querySelector('#f-contract');
      const cId = contractSel?.value;
      const cMatch = _contracts.find(c => c.id === cId);
      const defaultDesc = cMatch?.commodity || contractSel?.options[contractSel?.selectedIndex]?.dataset?.commodity || '';
      addBatchLine(div, { description: defaultDesc }, 'income');
      addBatchLine(div, {}, 'expense');
    }

    recalcBatch(div);
  }

  function addBatchLine(batchDiv, data = {}, section = 'income') {
    const tbody = batchDiv.querySelector(section === 'income' ? '.b-income-lines' : '.b-expense-lines');
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-light)';
    const inS = 'border:none;border-bottom:1px solid var(--border-light);border-radius:0;padding:5px 6px;font-size:12px;background:white;width:100%';
    const numS = inS + ';text-align:right';
    // For expenses, store absolute value and make negative on save
    const displayAmount = data.amount != null ? data.amount : '';

    const incomeTypeHtml = section === 'income'
      ? `<td style="padding:3px 6px;min-width:90px"><select class="bl-type" style="${inS}">
          <option value="sale"${(data.line_type||'sale')==='sale'?' selected':''}>Sale</option>
          <option value="qa"${(data.line_type)==='qa'?' selected':''}>Quality adj</option>
        </select></td>`
      : '';
    tr.innerHTML = incomeTypeHtml + `
      <td style="padding:3px 6px;min-width:160px"><input type="text" class="bl-desc" style="${inS}" value="${data.description||''}" placeholder="${section==='income'?'e.g. Cotton Lint':'e.g. Ginning, CA Levy'}"></td>
      <td style="padding:3px 6px;min-width:130px"><input type="number" class="bl-amount" style="${numS}" step="0.01" value="${displayAmount}" placeholder="0.00"></td>
      <td style="padding:3px 6px;min-width:100px"><input type="number" class="bl-eff" style="${numS};color:var(--hint)" step="0.0001" value="${data.eff_per_unit!=null?Math.abs(data.eff_per_unit):''}" placeholder="0.00"></td>
      <td style="padding:3px 6px;min-width:150px"><input type="text" class="bl-notes" style="${inS}" value="${data.notes||''}" placeholder="Notes…"></td>
      <td style="padding:3px 6px;text-align:center"><button style="background:none;border:none;cursor:pointer;color:var(--hint);font-size:13px" onclick="this.closest('tr').remove();recalcBatch(this.closest('[data-batch-id]'));recalcTotals()">✕</button></td>
    `;
    tr.dataset.section = section;
    tbody.appendChild(tr);
    const amountInp = tr.querySelector('.bl-amount');
    const effInp = tr.querySelector('.bl-eff');
    amountInp.addEventListener('input', () => { tr.dataset.lastEdited = 'amount'; recalcBatch(batchDiv); recalcTotals(); });
    effInp.addEventListener('input', () => { tr.dataset.lastEdited = 'eff'; recalcBatch(batchDiv); recalcTotals(); });
    recalcBatch(batchDiv);
  }

  function recalcBatch(batchDiv) {
    const qty = parseFloat(batchDiv.querySelector('.b-qty')?.value) || 0;
    let gross = 0, qa = 0, expenses = 0;

    function calcRow(tr, isExpense) {
      const amountInp = tr.querySelector('.bl-amount');
      const effInp = tr.querySelector('.bl-eff');
      if (!amountInp || !effInp) return 0;
      const lastEdited = tr.dataset.lastEdited || 'amount';
      let amount = parseFloat(amountInp.value) || 0;
      let eff = parseFloat(effInp.value) || 0;
      if (lastEdited === 'eff' && eff && qty) {
        // Eff edited → calculate amount
        amount = Math.round(eff * qty * 100) / 100;
        amountInp.value = amount;
      } else if (lastEdited === 'amount' && amount && qty) {
        // Amount edited → calculate eff
        eff = Math.round((amount / qty) * 10000) / 10000;
        effInp.value = eff;
      }
      effInp.style.color = isExpense ? '#9a3412' : '#166534';
      return amount;
    }

    // Income lines — split sale vs QA
    batchDiv.querySelectorAll('.b-income-lines tr').forEach(tr => {
      const amount = calcRow(tr, false);
      const lineType = tr.querySelector('.bl-type')?.value || 'sale';
      if (lineType === 'qa') qa += amount;
      else gross += amount;
    });

    // Expense lines
    batchDiv.querySelectorAll('.b-expense-lines tr').forEach(tr => {
      const amount = calcRow(tr, true);
      expenses += amount;
    });

    const net = gross + qa - expenses;

    // Update subtotals
    const totalIncome = gross + qa;
    const setEl = (cls, val) => { const el = batchDiv.querySelector(cls); if (el) el.textContent = val; };
    setEl('.b-gross', formatCurrency(gross, 2));
    setEl('.b-gross-unit', qty ? formatCurrency(gross/qty, 2) + ' / ' + getUnit() : '—');
    setEl('.b-qa', qa ? (qa>0?'+':'')+formatCurrency(qa,2) : '—');
    setEl('.b-total-income', formatCurrency(gross+qa, 2));
    setEl('.b-qa-unit', qa && qty ? (qa>0?'+':'')+formatCurrency(qa/qty,2)+' / '+getUnit() : '');
    setEl('.b-expenses', formatCurrency(expenses, 2));
    setEl('.b-expenses-unit', qty ? '-' + formatCurrency(expenses/qty, 2) + ' / ' + getUnit() : '—');
    setEl('.b-net', formatCurrency(net, 2));
    setEl('.b-net-unit', qty ? formatCurrency(net/qty, 2) + ' / ' + getUnit() : '—');

    const netEl = batchDiv.querySelector('.b-net');
    if (netEl) netEl.style.color = net < 0 ? 'var(--red)' : 'var(--ink)';
  }

  function recalcTotals() {
    let gross = 0, qa = 0, expenses = 0;
    batchesWrap.querySelectorAll('[data-batch-id]').forEach(bDiv => {
      bDiv.querySelectorAll('.b-income-lines tr').forEach(tr => {
        const _a = parseFloat(tr.querySelector('.bl-amount')?.value) || 0;
        if ((tr.querySelector('.bl-type')?.value||'sale') === 'qa') qa += _a; else gross += _a;
      });
      bDiv.querySelectorAll('.b-expense-lines tr').forEach(tr => {
        expenses += parseFloat(tr.querySelector('.bl-amount')?.value) || 0;
      });
    });
    const net = gross + qa - expenses;
    const tg = modal.querySelector('#t-gross');
    const td = modal.querySelector('#t-ded');
    const tn = modal.querySelector('#t-net');
    const tt = modal.querySelector('#t-total');
    if (tg) tg.textContent = formatCurrency(gross, 2);
    const tqa = modal.querySelector('#t-qa');
    if (tqa) tqa.textContent = qa ? (qa>0?'+':'')+formatCurrency(qa,2) : '—';
    if (td) td.textContent = expenses ? '-' + formatCurrency(expenses, 2) : '—';
    if (tn) tn.textContent = formatCurrency(net, 2);
    if (tt) tt.textContent = formatCurrency(net, 2);
  }

  // Add batch button
  modal.querySelector('#f-add-batch')?.addEventListener('click', () => addBatch());

  // Load existing batches or start with one empty
  const existingBatches = existing?.batches
    ? (typeof existing.batches === 'string' ? JSON.parse(existing.batches) : existing.batches)
    : null;
  if (existingBatches?.length) {
    try {
      existingBatches.forEach(b => addBatch(b));
    } catch(e) {
      console.error('Error loading batches:', e);
      addBatch();
    }
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

  // Wire other documents
  const otherAttachBtn = modal.querySelector('#f-other-attach');
  const fileInput = modal.querySelector('#f-file-input');
  const fileList = modal.querySelector('#f-file-list');
  function addOtherFiles(fileList_) {
    [...fileList_].forEach(f => {
      attachments.push(f);
      const pill = document.createElement('span');
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:white;border:1px solid var(--border-light);border-radius:12px;padding:2px 8px;font-size:10px';
      pill.innerHTML = '📎 ' + f.name.slice(0,24) + (f.name.length>24?'…':'') + ' <span style="cursor:pointer;color:var(--hint)" onclick="this.closest(&quot;span&quot;).remove()">×</span>';
      fileList?.appendChild(pill);
    });
  }
  otherAttachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', () => { addOtherFiles(fileInput.files); fileInput.value = ''; });
  const otherWrap = otherAttachBtn?.closest('div');
  if (otherWrap) {
    otherWrap.addEventListener('dragover', e => { e.preventDefault(); otherWrap.style.outline = '2px dashed var(--blue)'; otherWrap.style.borderRadius = '6px'; });
    otherWrap.addEventListener('dragleave', () => { otherWrap.style.outline = ''; });
    otherWrap.addEventListener('drop', e => { e.preventDefault(); otherWrap.style.outline = ''; addOtherFiles(e.dataTransfer.files); });
  }


  modal.querySelector('#f-save').addEventListener('click', async () => {
    const btn = modal.querySelector('#f-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const farm = getActiveFarm();
      const session = getSession();

      // Collect batches
      const batches = [];
      let grossTotal = 0, qaTotal = 0, expensesTotal = 0;

      // Upload batch files
      const uploadFile2 = async (file, prefix) => {
        const path = `invoices/${farm.id}/${Date.now()}_${prefix}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const contentType = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
        const res = await fetch(`https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/cfm-documents/${path}`, {
          method: 'POST',
          headers: { 'apikey': window.__CFM_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': contentType, 'x-upsert': 'true' },
          body: file,
        });
        if (!res.ok) { const e = await res.text(); throw new Error(`Upload failed (${res.status}): ${e}`); }
        return { url: `https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/public/cfm-documents/${path}`, filename: file.name };
      };

      for (const bDiv of batchesWrap.querySelectorAll('[data-batch-id]')) {
        const qty = parseFloat(bDiv.querySelector('.b-qty')?.value) || 0;
        const cropYear = getActiveSeason() || '';
        const incomeDocket = bDiv.querySelector('.b-income-docket')?.value?.trim() || '';
        const expenseDocket = bDiv.querySelector('.b-expense-docket')?.value?.trim() || '';
        const lines = [];

        // Upload income files
        const existingIncomeFiles = (existing?.batches||[]).find((_,i)=>i===Array.from(batchesWrap.querySelectorAll('[data-batch-id]')).indexOf(bDiv))?.income_files || [];
        const newIncomeUploads = await Promise.all((bDiv._incomeFiles||[]).map(f => uploadFile2(f, 'rcti')));
        const allIncomeFiles = [...existingIncomeFiles, ...newIncomeUploads];

        // Upload expense files
        const existingExpenseFiles = (existing?.batches||[]).find((_,i)=>i===Array.from(batchesWrap.querySelectorAll('[data-batch-id]')).indexOf(bDiv))?.expense_files || [];
        const newExpenseUploads = await Promise.all((bDiv._expenseFiles||[]).map(f => uploadFile2(f, 'gin')));
        const allExpenseFiles = [...existingExpenseFiles, ...newExpenseUploads];

        // Income lines
        bDiv.querySelectorAll('.b-income-lines tr').forEach(tr => {
          const amount = parseFloat(tr.querySelector('.bl-amount')?.value);
          if (!amount) return;
          const lineType = tr.querySelector('.bl-type')?.value || 'sale';
          lines.push({
            description: tr.querySelector('.bl-desc')?.value?.trim() || '',
            docket: incomeDocket,
            amount: amount,
            notes: tr.querySelector('.bl-notes')?.value?.trim() || '',
            eff_per_unit: parseFloat(tr.querySelector('.bl-eff')?.value) || (qty ? Math.round((absAmount/qty)*10000)/10000 : null),
            type: 'income',
            line_type: lineType,
          });
          if (lineType === 'qa') qaTotal += amount;
          else grossTotal += amount;
        });

        // Expense lines
        bDiv.querySelectorAll('.b-expense-lines tr').forEach(tr => {
          const amount = parseFloat(tr.querySelector('.bl-amount')?.value);
          if (!amount) return;
          lines.push({
            description: tr.querySelector('.bl-desc')?.value?.trim() || '',
            docket: expenseDocket,
            amount: amount,
            notes: tr.querySelector('.bl-notes')?.value?.trim() || '',
            eff_per_unit: -(parseFloat(tr.querySelector('.bl-eff')?.value) || (qty ? Math.round((Math.abs(amount)/qty)*10000)/10000 : null)),
            type: 'expense',
          });
          expensesTotal += amount;
        });

        if (lines.length) batches.push({ qty, crop_year: cropYear, income_docket: incomeDocket, expense_docket: expenseDocket, income_files: allIncomeFiles, expense_files: allExpenseFiles, lines });
      }

      const netAmount = grossTotal + expensesTotal;
      const masterUnit = modal.querySelector('#f-master-unit')?.value || 'bale';


      // Get commodity from selected contract
      const contractId = modal.querySelector('#f-contract')?.value;
      const selectedContract = _contracts.find(c => c.id === contractId);
      const contractCommodity = selectedContract?.commodity || null;

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
        // Commodity comes from the contract, not the description
        line_items: batches.flatMap(b => b.lines.filter(l => l.amount >= 0).map(l => ({
          commodity: contractCommodity || l.description, docket: l.docket, qty: b.qty, unit: masterUnit,
          season: b.crop_year, total: l.amount, price: b.qty ? l.amount/b.qty : 0, notes: l.notes,
        }))),
        deductions: batches.flatMap(b => b.lines.filter(l => l.amount < 0).map(l => ({
          description: l.description, docket: l.docket, qty: b.qty, unit: masterUnit,
          season: b.crop_year, value: Math.abs(l.amount), rate: b.qty ? Math.abs(l.amount)/b.qty : 0, notes: l.notes,
        }))),
        total_qty: batches.filter(b => b.lines.some(l => l.type === 'income')).reduce((s,b) => s+(parseFloat(b.qty)||0), 0),
        gross_amount: grossTotal,
        total_quality_adj: qaTotal || 0,
        total_deductions: Math.abs(expensesTotal),
        net_amount: netAmount,
        status: existing?.xero_invoice_number ? 'complete' : (existing?.status || 'pending'),
        notes: modal.querySelector('#f-notes')?.value?.trim() || '',
      };

      if (!row.invoice_date) throw new Error('Please enter a date');
      if (!batches.length) throw new Error('Please add at least one batch');

      // Collect all files from batches for legacy fields
      const allRctiFiles = batches.flatMap(b => b.income_files || []);
      const allGinFiles = batches.flatMap(b => b.expense_files || []);
      const otherUploads = await Promise.all(attachments.map(f => uploadFile2(f, 'other')));
      const allOtherFiles = [...(existing?.other_files||[]), ...otherUploads];

      // Preserve Xero ref on edit
      if (existing?.xero_invoice_number) row.xero_invoice_number = existing.xero_invoice_number;
      if (existing?.xero_invoice_id) row.xero_invoice_id = existing.xero_invoice_id;
      if (existing?.xero_invoice_url) row.xero_invoice_url = existing.xero_invoice_url;
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