// modules/outputs/invoices.js
// Full invoice management — contract sales, cash sales, line items, deductions

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js?v=1783290066771';
import { getActiveFarm, getSession, canWrite, getActiveSeason } from '../../js/app-state.js?v=1783290066771';
import { toast, openModal, formatCurrency, formatDate, commodityBadge, statusBadge, qs, currentSeason, formatNumber } from '../../js/ui.js?v=1783290066771';
import { getCommodities, loadCommodities } from '../../js/commodities.js?v=1783290066771';

let _invoices = [];
let _contracts = [];
let _userProfiles = {};
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
  const [invoices, contracts, profiles] = await Promise.all([
    dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.desc'),
    dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&select=*&order=sale_date.desc'),
    dbSelect('user_profiles', 'select=id,full_name,email&limit=200').catch(() => []),
  ]);
  _invoices = invoices;
  _contracts = contracts;
  _userProfiles = {};
  (profiles || []).forEach(p => { _userProfiles[p.id] = p; });
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
    // Season match: check invoice.season field, line_items, batch crop_year, OR linked contract's crop_year
    const linkedContract = i.forward_contract_id ? _contracts.find(c => c.id === i.forward_contract_id) : null;
    const batchSeasonMatch = (() => {
      if (!i.batches) return false;
      const b = typeof i.batches === 'string' ? JSON.parse(i.batches) : i.batches;
      return b.some(batch => batch.crop_year === season);
    })();
    const seasonMatch = i.season === season
      || batchSeasonMatch
      || (linkedContract && linkedContract.crop_year === season);
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
  // Rebuild month filter — only show months from season-filtered invoices
  const _monthSel = document.getElementById('inv-filter-month');
  if (_monthSel) {
    const _mv = _monthSel.value;
    const _seasonInvoices = _filtered();
    const months = [...new Set(_seasonInvoices.map(i => i.invoice_date?.slice(0,7)).filter(Boolean))].sort().reverse();
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

  // Rebuild contract filter — season-scoped
  const _csel = document.getElementById('inv-filter-contract');
  if (_csel) {
    const _cv = _csel.value;
    const _activeSeason = getActiveSeason();
    const _seasonContracts = _contracts.filter(c => !_activeSeason || !c.crop_year || c.crop_year === _activeSeason);
    _csel.innerHTML = '<option value="">All contracts</option><option value="cash">Cash sales only</option>' +
      _seasonContracts.map(c => `<option value="${c.id}" ${_cv===c.id?'selected':''}>${c.contract_number||'Contract'} — ${c.commodity||''}</option>`).join('');
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

  const totalGross = rows.reduce((s, i) => s + (parseFloat(i.gross_amount)||0), 0);
  const totalQA = rows.reduce((s, i) => s + (parseFloat(i.total_quality_adj)||0), 0);
  const totalIncome = totalGross + totalQA;

  const totalPending = rows.filter(i => i.status === 'pending').reduce((s, i) => s + (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0), 0);
  const totalComplete = rows.filter(i => i.status === 'complete').reduce((s, i) => s + (parseFloat(i.gross_amount)||0) + (parseFloat(i.total_quality_adj)||0), 0);

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
              <td class="muted" style="font-size:11px;white-space:nowrap">
                ${inv.invoice_date ? new Date(inv.invoice_date+'T00:00:00').toLocaleDateString('en-AU',{day:'2-digit',month:'numeric',year:'2-digit'}) : '—'}
                ${inv.season && inv.season !== (getActiveSeason()||'') ? `<span style="font-size:9px;background:var(--blue-light);color:var(--blue-text);border-radius:3px;padding:1px 4px;margin-left:3px">${inv.season}</span>` : ''}
              </td>
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
            <div style="display:flex;justify-content:space-between;font-weight:700;font-size:var(--text-md)"><span>Total income</span><span style="color:var(--blue)">${formatCurrency((parseFloat(inv.gross_amount)||0)+(parseFloat(inv.total_quality_adj)||0), 2)}</span></div>
          </div>
        </div>
      </div>

      ${inv.xero_invoice_number ? `<div style="margin-top:10px;font-size:var(--text-sm);color:var(--muted)">Xero ref: <strong style="color:var(--ink)">${inv.xero_invoice_number}</strong></div>` : ''}

      <div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border-light);font-size:11px;color:var(--hint);display:flex;justify-content:space-between;align-items:center">
        <span>
          ${inv.created_at ? 'Entered ' + new Date(inv.created_at).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}) + ' at ' + new Date(inv.created_at).toLocaleTimeString('en-AU',{hour:'2-digit',minute:'2-digit'}) : ''}
          ${inv.created_by && _userProfiles[inv.created_by] ? ' · ' + (_userProfiles[inv.created_by].full_name || _userProfiles[inv.created_by].email || '') : ''}
        </span>
        ${inv.updated_at && inv.updated_at !== inv.created_at ? '<span>Last edited ' + new Date(inv.updated_at).toLocaleDateString('en-AU',{day:'numeric',month:'short',year:'numeric'}) + '</span>' : ''}
      </div>
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

// ── RCTI / Gin receipt extraction ────────────────────────────

async function _callExtractAPI(file, farm, documentType) {
  // Netlify function body limit is ~6MB; base64 adds ~33% overhead
  if (file.size > 4 * 1024 * 1024) {
    throw new Error(`File too large (${(file.size/1024/1024).toFixed(1)}MB). Please use a PDF under 4MB.`);
  }

  // Try to extract text client-side using PDF.js — much faster than sending binary
  let pdf_text = null;
  try {
    if (file.type === 'application/pdf' || file.name.endsWith('.pdf')) {
      // Load PDF.js if not already loaded
      if (!window.pdfjsLib) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
          s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const pages = [];
      for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map(item => item.str).join(' '));
      }
      pdf_text = pages.join('\n\n');
    }
  } catch(e) {
    console.warn('PDF.js text extraction failed, falling back to binary:', e.message);
    pdf_text = null;
  }

  // Build request body — prefer text over binary
  const body = { farm_id: farm.id, document_type: documentType };
  if (pdf_text && pdf_text.trim().length > 50) {
    console.log('[RCTI] Sending extracted text:', pdf_text.length, 'chars');
    body.pdf_text = pdf_text;
  } else {
    console.log('[RCTI] Text extraction failed or empty, sending binary PDF');
    // Fallback to base64 for image-based PDFs or if text extraction failed
    body.pdf_base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  const res = await fetch('/api/extract-rcti', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Guard against HTML error pages from Netlify (timeout, 404, oversized body)
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Server error (${res.status}) — ${text.slice(0,80)}`);
  }
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error || 'Extraction failed');
  return json;
}

async function _extractFromGinReceipt(batchDiv, file, modal, addBatchLine, recalcBatch) {
  const farm = getActiveFarm();
  const btn = batchDiv.querySelector('.b-extract-gin');
  const origText = btn?.textContent;
  if (btn) { btn.textContent = 'Extracting...'; btn.disabled = true; }
  try {
    const { extracted } = await _callExtractAPI(file, farm, 'gin_receipt');
    if (!extracted) throw new Error('No data returned');
    batchDiv._expenseFiles = batchDiv._expenseFiles || [];
    batchDiv._expenseFiles.push(file);
    const list = batchDiv.querySelector('.b-expense-file-list');
    if (list) {
      const pill = document.createElement('span');
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--page-bg);border:1px solid var(--border-light);border-radius:12px;padding:2px 8px;font-size:10px;color:var(--ink)';
      pill.textContent = 'PDF: ' + file.name.slice(0, 25);
      list.appendChild(pill);
    }
    const docketInput = batchDiv.querySelector('.b-expense-docket');
    if (docketInput && extracted.receipt_number && !docketInput.value) docketInput.value = extracted.receipt_number;
    const expLines = batchDiv.querySelector('.b-expense-lines');
    if (expLines) {
      const rows = expLines.querySelectorAll('tr');
      if (rows.length === 1 && !rows[0].querySelector('.bl-desc')?.value && !rows[0].querySelector('.bl-amount')?.value) rows[0].remove();
    }
    const charges = extracted.charges || [];
    if (!charges.length) { toast('No charge lines found in document', 'error'); return; }
    charges.forEach(c => {
      if (!c.description || c.total_amount == null) return;
      addBatchLine(batchDiv, { description: c.description, amount: -Math.abs(c.total_amount), type: 'expense' }, 'expense');
    });
    recalcBatch(batchDiv);
    toast(charges.length + ' expense line' + (charges.length !== 1 ? 's' : '') + ' extracted', 'success');
  } catch(e) {
    console.error('Gin extraction error:', e);
    toast('Extraction failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

async function _extractFromRCTI(batchDiv, file, modal, addBatchLine, recalcBatch) {
  const farm = getActiveFarm();
  const btn = batchDiv.querySelector('.b-extract-rcti');
  const origText = btn?.textContent;
  if (btn) { btn.textContent = 'Extracting...'; btn.disabled = true; }
  try {
    const { extracted, extraction_id, examples_used } = await _callExtractAPI(file, farm, 'rcti');
    if (!extracted) throw new Error('No data returned');
    batchDiv._incomeFiles = batchDiv._incomeFiles || [];
    batchDiv._incomeFiles.push(file);
    const list = batchDiv.querySelector('.b-income-file-list');
    if (list) {
      const pill = document.createElement('span');
      pill.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--page-bg);border:1px solid var(--border-light);border-radius:12px;padding:2px 8px;font-size:10px;color:var(--ink)';
      pill.textContent = 'PDF: ' + file.name.slice(0, 25);
      list.appendChild(pill);
    }
    _showRCTIReview(extracted, extraction_id, examples_used || 0, batchDiv, modal, farm, addBatchLine, recalcBatch);
  } catch(e) {
    console.error('RCTI extraction error:', e);
    toast('Extraction failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.textContent = origText; btn.disabled = false; }
  }
}

function _showRCTIReview(data, extractionId, examplesUsed, batchDiv, parentModal, farm, addBatchLine, recalcBatch) {
  const issues = (data._confidence_issues?.length || 0) + (data._unfound_fields?.length || 0);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2000;overflow-y:auto;padding:20px';
  const fieldDefs = [
    ['RCTI number','rcti_number'],['Gin / buyer','gin_name'],['Invoice date','invoice_date'],
    ['Crop year','crop_year'],['Bale count','bale_count'],
    ['Gross proceeds','gross_proceeds'],['Net payment','net_payment'],['Notes','notes']
  ];
  let html = '<div style="background:white;border-radius:12px;max-width:680px;margin:0 auto">';
  html += '<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">';
  html += '<div><div style="font-size:15px;font-weight:700">RCTI extraction results</div>';
  html += '<div style="font-size:11px;color:var(--hint);margin-top:2px">' + (examplesUsed ? 'Accuracy improving — ' + examplesUsed + ' past corrections used' : 'First extraction from this document type') + '</div></div>';
  html += '<div style="display:flex;gap:8px"><button id="rcti-cancel" class="btn btn-ghost btn-sm">Cancel</button><button id="rcti-apply" class="btn btn-primary btn-sm">Apply</button></div></div>';
  if (issues) {
    html += '<div style="margin:12px 16px;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px 12px;font-size:12px;color:#92400e"><strong>Flagged:</strong>';
    if (data._confidence_issues?.length) html += '<div>Low confidence: ' + data._confidence_issues.join(', ') + '</div>';
    if (data._unfound_fields?.length) html += '<div>Not found: ' + data._unfound_fields.join(', ') + '</div>';
    html += '</div>';
  }
  html += '<div style="padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:10px">';
  fieldDefs.forEach(function(fd) {
    var label = fd[0]; var key = fd[1];
    var val = data[key];
    if (Array.isArray(val)) val = val.join(', ');
    if (val == null) val = '';
    // Round bale_count to 2 decimal places
    if (key === 'bale_count' && val !== '') val = (Math.round(parseFloat(val)*100)/100).toFixed(2);
    html += '<div class="form-group" style="margin:0"><label class="form-label" style="font-size:10px">' + label + '</label>';
    html += '<input class="form-input rcti-field" data-key="' + key + '" type="text" value="' + String(val).replace(/"/g, '&quot;') + '" style="font-size:12px"></div>';
  });
  html += '</div></div>';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  overlay.querySelector('#rcti-cancel')?.addEventListener('click', () => overlay.remove());
  overlay.querySelector('#rcti-apply')?.addEventListener('click', () => {
    const corrected = Object.assign({}, data);
    overlay.querySelectorAll('.rcti-field').forEach(inp => { corrected[inp.dataset.key] = inp.value; });
    const docketInput = batchDiv.querySelector('.b-income-docket');
    if (docketInput && corrected.docket_numbers && !docketInput.value)
      docketInput.value = Array.isArray(corrected.docket_numbers) ? corrected.docket_numbers.join(', ') : corrected.docket_numbers;
    const masterQtyInput = parentModal.querySelector('#f-master-qty');
    if (masterQtyInput && corrected.bale_count && !masterQtyInput.value) masterQtyInput.value = corrected.bale_count;
    const dateInput = parentModal.querySelector('#f-date');
    if (dateInput && !dateInput.value && corrected.invoice_date) dateInput.value = corrected.invoice_date;
    const buyerInput = parentModal.querySelector('#f-buyer');
    if (buyerInput && !buyerInput.value && corrected.gin_name) buyerInput.value = corrected.gin_name;
    if (corrected.gross_proceeds) {
      const incLines = batchDiv.querySelector('.b-income-lines');
      if (incLines) {
        const rows = incLines.querySelectorAll('tr');
        if (rows.length === 1 && !rows[0].querySelector('.bl-amount')?.value) rows[0].remove();
      }
      const contractSel = parentModal.querySelector('#f-contract');
      const cMatch = _contracts.find(c => c.id === contractSel?.value);
      addBatchLine(batchDiv, { description: cMatch?.commodity || 'Cotton Lint', amount: parseFloat(corrected.gross_proceeds)||0, type: 'income', line_type: 'sale' }, 'income');
    }
    if (data.quality_premiums_discounts && data.quality_premiums_discounts.length) {
      const totalQA = data.quality_premiums_discounts.reduce((s, q) => s + (q.total_amount || 0), 0);
      if (totalQA !== 0) addBatchLine(batchDiv, { description: 'Quality adjustment', amount: totalQA, type: 'income', line_type: 'qa' }, 'income');
    }
    if (extractionId) fetch('/api/extract-rcti', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ farm_id: farm.id, save_example: true, extraction_id: extractionId, correction: corrected }) }).catch(() => {});
    recalcBatch(batchDiv);
    overlay.remove();
    toast('RCTI data applied - please review', 'success');
  });
}

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
  const activeSeason = getActiveSeason() || '';

  const formEl = document.createElement('div');
  formEl.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:500;overflow-y:auto;padding:20px';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:var(--white);border-radius:var(--radius-xl);max-width:760px;margin:0 auto;display:flex;flex-direction:column;overflow:hidden';

  // Existing data
  const existingBatch = existing?.batches?.[0] || null;
  const existingLines = existingBatch?.lines || existing?.line_items || [];
  const existingSaleLine = existingLines.find(l => l.type === 'income' && l.line_type !== 'qa');
  const existingQALine = existingLines.find(l => l.type === 'income' && l.line_type === 'qa');
  const existingGross = existingSaleLine?.amount ?? existing?.gross_amount ?? '';
  const existingQA = existingQALine?.amount ?? existing?.total_quality_adj ?? '';
  const existingQty = existingBatch?.qty ?? existing?.total_qty ?? '';
  const existingDocket = existingBatch?.income_docket || '';
  const existingRctiFiles = existing?.rcti_files || (existingBatch?.income_files) || [];

  modal.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border-light);background:#fafbfc">
      <h2 style="font-size:var(--text-md);font-weight:600">${isEdit ? 'Edit invoice' : 'New invoice'}</h2>
      <button id="inv-close" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--hint);padding:2px 6px;border-radius:4px">✕</button>
    </div>
    <div style="padding:20px;overflow-y:auto;flex:1" id="inv-form-body">

      <!-- RCTI Upload -->
      <div style="border:2px dashed var(--border);border-radius:var(--radius-md);padding:16px;margin-bottom:20px;background:var(--page-bg)">
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">📄 RCTI / Invoice</div>
        <div style="font-size:11px;color:var(--hint);margin-bottom:12px">Upload an RCTI PDF and AI will extract the details. Or enter manually below.</div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <input type="file" id="rcti-pdf-upload" accept=".pdf,image/*" style="font-size:12px;flex:1;min-width:180px">
          <button class="btn btn-secondary btn-sm" id="btn-extract-rcti" type="button">✨ Extract details</button>
        </div>
        <div id="rcti-extract-status" style="min-height:16px;margin-top:8px;font-size:11px"></div>
        ${existingRctiFiles.length ? `
          <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">
            ${existingRctiFiles.map(f => `<a href="${f.url}" target="_blank" style="font-size:10px;color:var(--blue);text-decoration:none;background:var(--blue-light);border-radius:4px;padding:2px 8px">📄 ${f.filename||'RCTI'}</a>`).join('')}
          </div>` : ''}
        <div id="rcti-file-list" style="margin-top:6px"></div>
      </div>

      <!-- Sale type -->
      <div style="display:flex;gap:10px;margin-bottom:16px">
        <div id="inv-opt-contract" style="flex:1;border:2px solid var(--blue);border-radius:var(--radius-md);padding:10px 14px;cursor:pointer;background:var(--blue-light)">
          <p style="font-size:13px;font-weight:600;color:var(--blue-text)">Contract sale</p>
          <p style="font-size:11px;color:var(--blue);margin-top:2px">Against a forward contract</p>
        </div>
        <div id="inv-opt-cash" style="flex:1;border:1px solid var(--border);border-radius:var(--radius-md);padding:10px 14px;cursor:pointer">
          <p style="font-size:13px;font-weight:600;color:var(--ink-mid)">Cash sale</p>
          <p style="font-size:11px;color:var(--hint);margin-top:2px">Price set at time of sale</p>
        </div>
      </div>

      <!-- Contract selector -->
      <div id="f-contract-section" style="margin-bottom:16px">
        <label class="form-label">Forward contract</label>
        <div style="position:relative" id="f-contract-wrap">
          <input type="text" id="f-contract-search" class="form-input" placeholder="Search contracts…" autocomplete="off"
            value="${existing?.forward_contract_id ? (() => { const c = _contracts.find(x=>x.id===existing.forward_contract_id); return c ? (c.contract_number||'')+'  —  '+(c.commodity||'')+' — '+formatNumber(c.quantity,0)+' '+(c.unit||'')+' @ '+formatCurrency(c.price_per_unit,2) : ''; })() : ''}"
            style="width:100%">
          <input type="hidden" id="f-contract" value="${existing?.forward_contract_id||''}">
          <div id="f-contract-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:200;background:white;border:1px solid var(--border);border-radius:var(--radius-md);margin-top:2px;max-height:220px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1)">
            <div id="f-contract-opts"></div>
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

      <!-- Core fields -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Buyer <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="f-buyer" type="text" value="${existing?.buyer||''}" placeholder="Gin or buyer name">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Date <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="f-date" type="date" value="${existing?.invoice_date||new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Unit</label>
          <select class="form-select" id="f-master-unit">
            ${['bale','t','kg','head','each'].map(u=>`<option${u===(existing?.master_unit||'bale')?' selected':''}>${u}</option>`).join('')}
          </select>
        </div>
      </div>

      <!-- Quantities and amounts -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div class="form-group" style="margin:0">
          <label class="form-label">Quantity <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="f-qty" type="number" step="any" min="0" value="${existingQty ? parseFloat(existingQty) : ''}" placeholder="0.00">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Gross proceeds <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="f-gross" type="number" step="0.01" value="${existingGross||''}" placeholder="0.00">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Quality adjustment</label>
          <input class="form-input" id="f-qa" type="number" step="0.01" value="${existingQA||''}" placeholder="0.00 (negative = discount)">
        </div>
      </div>

      <!-- Totals display -->
      <div style="background:var(--page-bg);border-radius:var(--radius-md);padding:12px 16px;margin-bottom:16px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Gross proceeds</div>
          <div id="t-gross" style="font-size:16px;font-weight:600;color:var(--ink)">—</div>
        </div>
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Quality adj</div>
          <div id="t-qa" style="font-size:16px;font-weight:600;color:var(--ink)">—</div>
        </div>
        <div style="border-left:2px solid var(--border);padding-left:12px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Total income</div>
          <div id="t-total" style="font-size:20px;font-weight:700;color:var(--blue)">—</div>
        </div>
      </div>

      <!-- Notes -->
      <div class="form-group" style="margin-bottom:16px">
        <label class="form-label">Notes</label>
        <textarea class="form-input" id="f-notes" rows="2" placeholder="Optional notes">${existing?.notes||''}</textarea>
      </div>

      <!-- Actions -->
      <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:8px;border-top:1px solid var(--border-light)">
        <button class="btn btn-ghost" id="f-cancel">Cancel</button>
        <button class="btn btn-primary" id="f-save">✓ Save invoice</button>
      </div>
    </div>
  `;

  formEl.appendChild(modal);
  document.body.appendChild(formEl);

  function close() { formEl.remove(); }
  modal.querySelector('#inv-close')?.addEventListener('click', close);
  modal.querySelector('#f-cancel')?.addEventListener('click', close);
  formEl.addEventListener('click', e => { if (e.target === formEl) close(); });

  // ── RCTI extraction ──────────────────────────────────────────
  let _rctiFiles = [...existingRctiFiles];

  modal.querySelector('#rcti-pdf-upload')?.addEventListener('change', function() {
    if (this.files[0]) {
      const list = modal.querySelector('#rcti-file-list');
      if (list) list.innerHTML = `<span style="font-size:10px;color:var(--blue)">📄 ${this.files[0].name}</span>`;
    }
  });

  modal.querySelector('#btn-extract-rcti')?.addEventListener('click', async () => {
    const fileInput = modal.querySelector('#rcti-pdf-upload');
    const statusEl = modal.querySelector('#rcti-extract-status');
    const file = fileInput?.files?.[0];
    if (!file) { statusEl.textContent = 'Please select a PDF first.'; statusEl.style.color = 'var(--red)'; return; }
    const btn = modal.querySelector('#btn-extract-rcti');
    btn.disabled = true; btn.textContent = 'Extracting…';
    statusEl.textContent = 'Reading PDF…'; statusEl.style.color = 'var(--hint)';
    try {
      const { extracted, extraction_id, examples_used } = await _callExtractAPI(file, farm, 'rcti');
      if (!extracted) throw new Error('No data returned');
      _rctiFiles.push(file);

      // Populate fields
      const setField = (id, val, _unused) => {
        const el = modal.querySelector('#' + id);
        if (!el || val == null || val === '') return;
        el.value = val;
        el.style.borderColor = ''; el.style.background = '';
        el.dispatchEvent(new Event('input'));
      };
      if (!modal.querySelector('#f-buyer').value) setField('f-buyer', extracted.gin_name);
      if (!modal.querySelector('#f-date').value) setField('f-date', extracted.invoice_date);
      setField('f-qty', extracted.bale_count, false);
      setField('f-gross', extracted.gross_proceeds, true);
      // QA: sum all quality_premiums_discounts
      const qaTotal = (extracted.quality_premiums_discounts||[]).reduce((s,q)=>s+(parseFloat(q.total_amount)||0),0);
      if (qaTotal !== 0) setField('f-qa', qaTotal, false);

      // Save file reference for upload on save
      const list = modal.querySelector('#rcti-file-list');
      if (list) list.innerHTML = `<span style="font-size:10px;color:var(--blue)">📄 ${file.name}</span>`;

      recalcTotals();

      // Flag missing required fields
      const missing = [];
      ['f-buyer','f-date','f-qty','f-gross'].forEach(id => {
        const el = modal.querySelector('#' + id);
        if (el && !el.value) {
          el.style.borderColor = 'var(--red)'; el.style.background = '#fff5f5';
          missing.push(id.replace('f-',''));
          el.addEventListener('input', () => { el.style.borderColor=''; el.style.background=''; }, { once: true });
        }
      });

      // Save correction for continuous learning — store extraction_id for later
      modal._extractionId = extraction_id;
      modal._extracted = extracted;

      statusEl.textContent = missing.length
        ? '⚠ Extracted — check highlighted fields: ' + missing.join(', ')
        : `✓ Extracted${examples_used ? ' (using '+examples_used+' past examples)' : ''}. Review and save.`;
      statusEl.style.color = missing.length ? 'var(--amber)' : 'var(--green)';

    } catch(e) {
      statusEl.textContent = 'Extraction failed: ' + e.message;
      statusEl.style.color = 'var(--red)';
    } finally {
      btn.disabled = false; btn.textContent = '✨ Extract details';
    }
  });

  // ── Sale type toggle ─────────────────────────────────────────
  let saleType = existing?.sale_type === 'against_contract' ? 'contract' : (existing?.sale_type || 'contract');
  function setSaleType(t) {
    saleType = t;
    const contractEl = modal.querySelector('#inv-opt-contract');
    const cashEl = modal.querySelector('#inv-opt-cash');
    const contractSection = modal.querySelector('#f-contract-section');
    contractEl.style.border = t==='contract' ? '2px solid var(--blue)' : '1px solid var(--border)';
    contractEl.style.background = t==='contract' ? 'var(--blue-light)' : '';
    contractEl.querySelector('p').style.color = t==='contract' ? 'var(--blue-text)' : 'var(--ink-mid)';
    cashEl.style.border = t==='cash' ? '2px solid var(--blue)' : '1px solid var(--border)';
    cashEl.style.background = t==='cash' ? 'var(--blue-light)' : '';
    contractSection.style.display = t==='contract' ? '' : 'none';
  }
  modal.querySelector('#inv-opt-contract').addEventListener('click', () => setSaleType('contract'));
  modal.querySelector('#inv-opt-cash').addEventListener('click', () => setSaleType('cash'));
  setSaleType(saleType);

  // ── Contract selector ────────────────────────────────────────
  const contractSearch = modal.querySelector('#f-contract-search');
  const contractHidden = modal.querySelector('#f-contract');
  const contractDropdown = modal.querySelector('#f-contract-dropdown');
  const contractOpts = modal.querySelector('#f-contract-opts');
  const contractSummary = modal.querySelector('#f-contract-summary');

  async function updateContractSummary() {
    const cId = contractHidden?.value;
    if (!cId) { contractSummary.style.display = 'none'; return; }
    const c = _contracts.find(x => x.id === cId);
    if (!c) return;
    contractSummary.style.display = 'grid';
    const qty = parseFloat(c.quantity) || 0;
    const unit = c.unit || '';
    modal.querySelector('#cs-qty').textContent = formatNumber(qty, 0) + ' ' + unit;
    modal.querySelector('#cs-price').textContent = formatCurrency(c.price_per_unit, 2);
    // Load invoiced qty
    try {
      const invs = _invoices.filter(i => i.forward_contract_id === cId && i.id !== existing?.id);
      let invoicedQty = 0;
      invs.forEach(i => {
        if (i.batches) {
          const b = typeof i.batches==='string'?JSON.parse(i.batches):i.batches;
          invoicedQty += b.filter(bt=>(bt.lines||[]).some(l=>l.type==='income'&&l.line_type!=='qa')).reduce((s,bt)=>s+(parseFloat(bt.qty)||0),0);
        } else { invoicedQty += parseFloat(i.total_qty)||0; }
      });
      const remaining = Math.max(0, qty - invoicedQty);
      const avgPaid = invoicedQty > 0 ? invs.reduce((s,i)=>(s+(parseFloat(i.gross_amount)||0)+(parseFloat(i.total_quality_adj)||0)),0)/invoicedQty : 0;
      modal.querySelector('#cs-invoiced').textContent = formatNumber(invoicedQty, 0) + ' ' + unit;
      modal.querySelector('#cs-remaining').textContent = formatNumber(remaining, 0) + ' ' + unit;
      modal.querySelector('#cs-avg').textContent = avgPaid ? formatCurrency(avgPaid, 2) : '—';
    } catch(e) {}
  }

  const renderContractOpts = (filter='') => {
    const season = getActiveSeason();
    const lower = filter.toLowerCase();
    const matches = _contracts.filter(c => {
      if (season && c.crop_year && c.crop_year !== season) return false;
      return !lower || (c.contract_number||'').toLowerCase().includes(lower) ||
        (c.counterparty||c.buyer||'').toLowerCase().includes(lower) ||
        (c.commodity||'').toLowerCase().includes(lower);
    });
    contractOpts.innerHTML = matches.length
      ? matches.map(c => `<div class="con-opt" data-id="${c.id}" style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border-light);font-size:13px"
          onmouseenter="this.style.background='var(--page-bg)'" onmouseleave="this.style.background=''">
          <strong>${c.contract_number||'—'}</strong> — ${c.commodity||''} — ${formatNumber(c.quantity,0)} ${c.unit||''} @ ${formatCurrency(c.price_per_unit,2)}
        </div>`).join('')
      : '<div style="padding:10px 14px;color:var(--hint);font-size:13px">No contracts found</div>';
    contractOpts.querySelectorAll('.con-opt').forEach(opt => {
      opt.addEventListener('mousedown', e => {
        e.preventDefault();
        const c = _contracts.find(x => x.id === opt.dataset.id);
        contractHidden.value = opt.dataset.id;
        contractSearch.value = (c?.contract_number||'') + '  —  ' + (c?.commodity||'') + ' — ' + formatNumber(c?.quantity,0) + ' ' + (c?.unit||'') + ' @ ' + formatCurrency(c?.price_per_unit,2);
        contractDropdown.style.display = 'none';
        // Pre-fill buyer from contract if empty
        const buyerEl = modal.querySelector('#f-buyer');
        if (buyerEl && !buyerEl.value) buyerEl.value = c?.counterparty || c?.buyer || '';
        updateContractSummary();
      });
    });
  };

  contractSearch.addEventListener('focus', () => { renderContractOpts(contractSearch.value); contractDropdown.style.display=''; });
  contractSearch.addEventListener('input', () => { renderContractOpts(contractSearch.value); contractDropdown.style.display=''; });
  contractSearch.addEventListener('blur', () => setTimeout(() => { contractDropdown.style.display='none'; }, 150));
  if (existing?.forward_contract_id) updateContractSummary();

  // ── Totals recalc ────────────────────────────────────────────
  function recalcTotals() {
    const gross = parseFloat(modal.querySelector('#f-gross')?.value) || 0;
    const qa = parseFloat(modal.querySelector('#f-qa')?.value) || 0;
    const total = gross + qa;
    const tg = modal.querySelector('#t-gross');
    const tqa = modal.querySelector('#t-qa');
    const tt = modal.querySelector('#t-total');
    if (tg) tg.textContent = gross ? formatCurrency(gross, 2) : '—';
    if (tqa) tqa.textContent = qa ? (qa>0?'+':'')+formatCurrency(qa,2) : '—';
    if (tt) { tt.textContent = total ? formatCurrency(total, 2) : '—'; tt.style.color = total < 0 ? 'var(--red)' : 'var(--blue)'; }
  }
  modal.querySelector('#f-gross').addEventListener('input', recalcTotals);
  modal.querySelector('#f-qa').addEventListener('input', recalcTotals);
  recalcTotals();

  // ── Save ─────────────────────────────────────────────────────
  modal.querySelector('#f-save').addEventListener('click', async () => {
    const btn = modal.querySelector('#f-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const session = getSession();

      const buyer = modal.querySelector('#f-buyer')?.value?.trim();
      const date = modal.querySelector('#f-date')?.value;
      const qty = parseFloat(modal.querySelector('#f-qty')?.value || 0) || 0;
      const gross = parseFloat(modal.querySelector('#f-gross')?.value) || 0;
      const qa = parseFloat(modal.querySelector('#f-qa')?.value) || 0;
      const masterUnit = modal.querySelector('#f-master-unit')?.value || 'bale';
      const contractId = contractHidden?.value || null;
      const selectedContract = _contracts.find(c => c.id === contractId);
      const notes = modal.querySelector('#f-notes')?.value?.trim() || '';

      if (!date) throw new Error('Please enter a date');
      if (!buyer) throw new Error('Please enter a buyer');
      if (!qty) throw new Error('Please enter a quantity');
      if (!gross) throw new Error('Please enter gross proceeds');

      // Upload RCTI file
      const uploadFile = async (file, prefix) => {
        const path = `invoices/${farm.id}/${Date.now()}_${prefix}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const ct = file.type || (file.name.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream');
        const res = await fetch(`https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/cfm-documents/${path}`, {
          method:'POST', headers:{ 'apikey':window.__CFM_ANON_KEY, 'Authorization':`Bearer ${session?.access_token}`, 'Content-Type':ct, 'x-upsert':'true' }, body:file,
        });
        if (!res.ok) throw new Error(`Upload failed: ${await res.text()}`);
        return { url:`https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/public/cfm-documents/${path}`, filename:file.name };
      };

      // Upload new RCTI file if one was selected
      const fileInput = modal.querySelector('#rcti-pdf-upload');
      const newFile = fileInput?.files?.[0];
      let rctiFiles = [...existingRctiFiles];
      if (newFile) {
        const uploaded = await uploadFile(newFile, 'rcti');
        rctiFiles = [...rctiFiles, uploaded];
      }

      // Build batch structure
      const lines = [];
      const commodity = selectedContract?.commodity || 'Sale';
      if (gross) lines.push({ type:'income', line_type:'sale', description:commodity, amount:gross, eff_per_unit: qty ? Math.round(gross/qty*10000)/10000 : null });
      if (qa) lines.push({ type:'income', line_type:'qa', description:'Quality adjustment', amount:qa, eff_per_unit: qty ? Math.round(qa/qty*10000)/10000 : null });

      const cropYear = selectedContract?.crop_year || activeSeason;
      const batch = { qty, crop_year:cropYear, income_files:rctiFiles, lines };

      const row = {
        farm_id: farm.id,
        buyer,
        invoice_date: date,
        forward_contract_id: contractId,
        sale_type: contractId ? 'against_contract' : 'cash',
        gst_type: 'ex',
        master_unit: masterUnit,
        season: cropYear,
        batches: [batch],
        total_qty: qty,
        gross_amount: gross,
        total_quality_adj: qa || 0,
        notes,
        rcti_files: rctiFiles,
        rcti_url: rctiFiles[0]?.url || null,
        rcti_filename: rctiFiles[0]?.filename || null,
        gin_files: [], gin_url: null, gin_filename: null, other_files: [],
        status: existing?.xero_invoice_number ? 'complete' : (existing?.status || 'pending'),
        // Legacy line_items for compatibility
        line_items: [
          ...(gross ? [{ type:'income', line_type:'sale', commodity: commodity, docket:'', qty, unit:masterUnit, season:cropYear, total:gross, price:qty?gross/qty:0 }] : []),
          ...(qa ? [{ type:'income', line_type:'qa', commodity: commodity, docket:'', qty, unit:masterUnit, season:cropYear, total:qa, price:qty?qa/qty:0 }] : []),
        ],
      };

      if (existing?.xero_invoice_number) { row.xero_invoice_number = existing.xero_invoice_number; row.xero_invoice_id = existing.xero_invoice_id; row.xero_invoice_url = existing.xero_invoice_url; }

      // Save extraction correction with actual user-entered values (not original AI values)
      // This is what teaches the system to do better next time
      if (modal._extractionId && modal._extracted) {
        const corrected = Object.assign({}, modal._extracted, {
          buyer_name: buyer,
          gin_name: buyer,  // keep for backward compat
          invoice_date: date,
          bale_count: qty,
          gross_proceeds: gross,
          net_payment: gross + (qa||0),
        });
        fetch('/api/extract-rcti', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ farm_id: farm.id, save_example: true, extraction_id: modal._extractionId, correction: corrected })
        }).catch(()=>{});
      }

      if (existing?.id) {
        await dbUpdate('invoices', existing.id, row);
        toast('Invoice updated', 'success');
      } else {
        await dbInsert('invoices', row);
        toast('Invoice saved', 'success');
      }
      close();
      await _loadData();
      _renderTable(container);
    } catch(err) {
      toast(err.message || 'Save failed', 'error');
      console.error('Save error:', err);
    }
    btn.disabled = false; btn.textContent = '✓ Save invoice';
  });
}
