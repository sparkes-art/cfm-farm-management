// modules/stocktake/livestock.js
// Livestock stocktake — mob ledger, movement entry, opening balances

import { dbSelect, dbInsert, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, canWrite } from '../../js/app-state.js';
import { toast, openModal, qs } from '../../js/ui.js';

export async function mountLivestock(container, initialPeriod) {
  const farm = getActiveFarm();
  container.innerHTML = `<div style="padding:20px 24px;max-width:1100px;margin:0 auto" id="ls-wrap">
    <div style="padding:40px;text-align:center;color:var(--hint)">Loading livestock…</div>
  </div>`;

  // Load all periods for this farm, sorted chronologically
  const allPeriods = await dbSelect('stock_periods',
    `farm_id=eq.${farm.id}&order=period_start.asc`
  );

  // Default to the passed period, or the latest open, or the most recent
  const defaultPeriod = initialPeriod
    || allPeriods.find(p => p.status === 'open')
    || allPeriods[allPeriods.length - 1]
    || null;

  await _render(container, farm, defaultPeriod, allPeriods);
}

async function _render(container, farm, period, allPeriods = []) {
  const wrap = qs('#ls-wrap', container);

  const [items, movements, pendingInvoices] = await Promise.all([
    dbSelect('stock_items', `farm_id=eq.${farm.id}&category=eq.livestock&active=eq.true&order=subgroup,name`),
    dbSelect('stock_movements', `farm_id=eq.${farm.id}&select=id,item_id,movement_type,signed_qty,qty,unit,occurred_on,note,source_ref,source_system&order=occurred_on.desc`),
    // Livestock invoices in this period that have unallocated lines
    period ? dbSelect('invoices',
      `farm_id=eq.${farm.id}&master_unit=eq.head&invoice_date=gte.${period.period_start}&invoice_date=lte.${period.period_end}&select=id,buyer,invoice_date,left_farm_date,livestock_lines,agent_name,rcti_files`
    ) : Promise.resolve([]),
  ]);

  // ── Period timeline ─────────────────────────────────────────
  const timelineHtml = allPeriods.length > 1 ? (() => {
    const months = allPeriods.map(p => {
      const d = new Date(p.period_start);
      const label = d.toLocaleDateString('en-AU', {month:'short', year:'2-digit'});
      const isActive = period && p.id === period.id;
      const statusDot = p.status === 'locked' ? '🔒' : p.status === 'review' ? '🔶' : '●';
      const dotColor = p.status === 'locked' ? 'var(--hint)' : p.status === 'review' ? 'var(--amber)' : 'var(--green)';
      return `<button class="ls-period-btn" data-period-id="${p.id}"
        style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 14px;border:none;border-radius:8px;cursor:pointer;background:${isActive?'var(--blue)':'transparent'};transition:background .15s;flex-shrink:0">
        <span style="font-size:11px;font-weight:${isActive?700:500};color:${isActive?'white':'var(--ink-mid)'}">${label}</span>
        <span style="font-size:9px;color:${isActive?'rgba(255,255,255,.7)':dotColor}">${statusDot} ${p.status}</span>
      </button>`;
    });
    return `<div style="display:flex;align-items:center;gap:2px;overflow-x:auto;padding:4px 0;margin-bottom:16px;border-bottom:1px solid var(--border-light);padding-bottom:12px">
      ${months.join('')}
    </div>`;
  })() : '';

  if (!items.length) {
    wrap.innerHTML = timelineHtml + `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h2 style="font-size:18px;font-weight:700;color:var(--ink)">Livestock</h2>
          <p style="font-size:13px;color:var(--hint);margin-top:4px">${farm.name}</p>
        </div>
      </div>
      <div style="padding:40px;text-align:center;color:var(--hint);background:white;border-radius:10px;border:1px solid var(--border)">
        <div style="font-size:32px;margin-bottom:12px">🐄</div>
        <p style="font-size:15px;font-weight:500;color:var(--ink);margin-bottom:6px">No livestock mobs set up</p>
        <p style="font-size:13px">Livestock items need to be seeded for this farm before stocktake can begin.</p>
      </div>`;
    return;
  }

  // Compute running balance per item
  const balances = {};
  items.forEach(i => { balances[i.id] = 0; });
  movements.forEach(m => {
    if (balances[m.item_id] !== undefined) {
      balances[m.item_id] += parseFloat(m.signed_qty) || 0;
    }
  });

  // Period movements — strictly within this period's dates
  const periodStart = period?.period_start;
  const periodEnd   = period?.period_end;
  const periodMovements = periodStart
    ? movements.filter(m => m.occurred_on >= periodStart && m.occurred_on <= periodEnd)
    : movements;

  // Period movements by item
  const periodByItem = {};
  items.forEach(i => { periodByItem[i.id] = []; });
  periodMovements.forEach(m => {
    if (periodByItem[m.item_id] !== undefined) periodByItem[m.item_id].push(m);
  });

  // Opening balance = all movements BEFORE this period's start date
  const openingBalance = {};
  items.forEach(i => {
    const pre = periodStart
      ? movements.filter(m => m.item_id === i.id && m.occurred_on < periodStart)
      : [];
    openingBalance[i.id] = pre.reduce((s, m) => s + (parseFloat(m.signed_qty)||0), 0);
  });

  // Closing balance = opening + period movements
  const closingBalance = {};
  items.forEach(i => {
    closingBalance[i.id] = openingBalance[i.id] + periodByItem[i.id].reduce((s,m) => s+(parseFloat(m.signed_qty)||0), 0);
  });

  // Group by subgroup (breed)
  const groups = {};
  items.forEach(i => {
    const g = i.subgroup || 'Other';
    if (!groups[g]) groups[g] = [];
    groups[g].push(i);
  });

  const fN = (n) => n == null ? '—' : Math.round(n).toLocaleString();
  const MOVE_TYPES = {
    natural_increase: { label: 'Natural increase', sign: 1, color: 'var(--green)' },
    purchase: { label: 'Purchase', sign: 1, color: 'var(--blue)' },
    transfer_in: { label: 'Transfer in', sign: 1, color: 'var(--blue)' },
    reclass_in: { label: 'Reclass in', sign: 1, color: 'var(--blue)' },
    sale: { label: 'Sale', sign: -1, color: 'var(--amber)' },
    death: { label: 'Death', sign: -1, color: 'var(--red)' },
    transfer_out: { label: 'Transfer out', sign: -1, color: 'var(--hint)' },
    reclass_out: { label: 'Reclass out', sign: -1, color: 'var(--hint)' },
    adjustment: { label: 'Adjustment', sign: 0, color: 'var(--hint)' },
  };

  // Summary totals — use closing balance for current period view
  const totalHead = Object.values(closingBalance).reduce((s, v) => s + v, 0);
  const totalOpening = Object.values(openingBalance).reduce((s, v) => s + v, 0);

  // ── Unallocated sales panel ─────────────────────────────────
  const unallocatedHtml = _buildUnallocatedPanel(pendingInvoices, items, movements);


  const groupHtml = Object.entries(groups).map(([group, groupItems]) => {
    const groupBalance = groupItems.reduce((s, i) => s + (closingBalance[i.id]||0), 0);
    const rowHtml = groupItems.map(item => {
      const opening = openingBalance[item.id] || 0;
      const closing = closingBalance[item.id] || 0;
      const periodMoves = periodByItem[item.id] || [];
      const attrs = item.attributes || {};
      const classLabel = attrs.class ? attrs.class.charAt(0).toUpperCase() + attrs.class.slice(1) : '';
      const birthYr = attrs.birth_year || '';
      const sex = attrs.sex || '';

      // Period movement summary
      const moveIn  = periodMoves.filter(m => (parseFloat(m.signed_qty)||0) > 0).reduce((s,m) => s+(parseFloat(m.signed_qty)||0), 0);
      const moveOut = periodMoves.filter(m => (parseFloat(m.signed_qty)||0) < 0).reduce((s,m) => s+(parseFloat(m.signed_qty)||0), 0);

      return `
      <tr style="border-bottom:1px solid var(--border-light)">
        <td style="padding:10px 14px">
          <div style="font-size:13px;font-weight:500;color:var(--ink)">${item.name}</div>
          <div style="font-size:11px;color:var(--hint);margin-top:1px">${[classLabel, birthYr ? 'b.'+birthYr : '', sex].filter(Boolean).join(' · ')}</div>
        </td>
        <td style="padding:10px 14px;text-align:center;font-size:13px;color:var(--hint)">${opening ? fN(opening) : '—'}</td>
        <td style="padding:10px 14px;text-align:center;font-size:13px;color:var(--green)">${moveIn ? '+'+fN(moveIn) : '—'}</td>
        <td style="padding:10px 14px;text-align:center;font-size:13px;color:var(--red)">${moveOut ? fN(moveOut) : '—'}</td>
        <td style="padding:10px 14px;text-align:center;font-size:15px;font-weight:700;color:var(--ink)">${fN(closing)}</td>
        <td style="padding:10px 14px;text-align:center">
          ${canWrite() ? `<button class="btn btn-ghost btn-sm ls-add-move" data-item-id="${item.id}" data-item-name="${item.name}" style="font-size:11px">+ Movement</button>` : ''}
          ${!opening && canWrite() ? `<button class="btn btn-ghost btn-sm ls-set-opening" data-item-id="${item.id}" data-item-name="${item.name}" style="font-size:11px;color:var(--blue)">Set opening</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    return `
    <div style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#1a2535;border-radius:8px 8px 0 0">
        <span style="font-size:13px;font-weight:600;color:white">${group}</span>
        <span style="font-size:12px;color:rgba(255,255,255,.6)">${fN(groupBalance)} head</span>
      </div>
      <div class="card" style="border-radius:0 0 8px 8px;overflow:hidden;padding:0">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
              <th style="padding:8px 14px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Mob</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Opening</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--green);font-weight:600">In</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--red);font-weight:600">Out</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Closing</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;font-weight:600"></th>
            </tr>
          </thead>
          <tbody>${rowHtml}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');


  // ── Period movements table ────────────────────────────────
  // Fetch invoice lines for weight/price reference
  const invoiceMap = {};
  pendingInvoices.forEach(inv => {
    (inv.livestock_lines || []).forEach((line, idx) => {
      invoiceMap[inv.id + ':' + idx] = line;
    });
  });

  const movementRows = periodMovements.slice(0, 20).map(m => {
    const item = items.find(i => i.id === m.item_id);
    const mt = MOVE_TYPES[m.movement_type] || { label: m.movement_type, color: 'var(--hint)' };
    const qty = parseFloat(m.signed_qty) || 0;
    // Get weight/price from linked invoice line or movement attributes
    const invLine = m.source_ref ? invoiceMap[m.source_ref] : null;
    const attrs = m.attributes ? (typeof m.attributes === 'string' ? JSON.parse(m.attributes) : m.attributes) : null;
    const avgWt = attrs?.avg_weight_kg || invLine?.avg_weight_kg || null;
    const price = invLine?.price || null;
    const priceBasis = invLine?.price_basis || 'per_kg';
    const showWtPrice = ['sale', 'purchase', 'transfer_in', 'transfer_out'].includes(m.movement_type);

    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:8px 14px;color:var(--hint)">${m.occurred_on}</td>
      <td style="padding:8px 14px;font-weight:500;color:var(--ink)">${item?.name || '—'}</td>
      <td style="padding:8px 14px;color:${mt.color}">${mt.label}</td>
      <td style="padding:8px 14px;text-align:right;font-weight:600;color:${qty > 0 ? 'var(--green)' : 'var(--red)'}">${qty > 0 ? '+' : ''}${fN(qty)}</td>
      <td style="padding:8px 14px;text-align:right;color:var(--hint)">${showWtPrice && avgWt ? fN(avgWt) + ' kg' : '—'}</td>
      <td style="padding:8px 14px;text-align:right;color:var(--hint)">${showWtPrice && price ? '$' + price + (priceBasis === 'per_kg' ? '/kg' : '/hd') : '—'}</td>
      <td style="padding:8px 14px;color:var(--hint)">${m.note || ''}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = timelineHtml + unallocatedHtml + `
    <!-- Header -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <div>
        <h2 style="font-size:18px;font-weight:700;color:var(--ink)">Livestock</h2>
        <p style="font-size:13px;color:var(--hint);margin-top:4px">${farm.name} · ${period ? new Date(period.period_start).toLocaleDateString('en-AU',{month:'long',year:'numeric'}) : 'All time'}</p>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div style="background:white;border:1px solid var(--border);border-radius:8px;padding:10px 16px;text-align:center">
          <div style="font-size:10px;color:var(--hint);text-transform:uppercase;letter-spacing:.07em;margin-bottom:2px">Total on hand</div>
          <div style="font-size:20px;font-weight:700;color:var(--ink)">${fN(totalHead)} head</div>
        </div>
        ${canWrite() ? `<button class="btn btn-secondary btn-sm" id="ls-add-mob" style="white-space:nowrap">+ Add mob</button>` : ''}
      </div>
    </div>


    <!-- Period movements -->
    ${periodMovements.length ? `
    <div class="card" style="margin-bottom:16px;overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--page-bg)">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Period movements</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Date</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Mob</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Type</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:right">Head</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:right">Avg kg</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:right">Price</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Note</th>
          </tr>
        </thead>
        <tbody>${movementRows}</tbody>
      </table>
    </div>` : ''}

    <!-- Mob grids -->
    ${groupHtml}`;

  // Wire period timeline buttons
  wrap.querySelectorAll('.ls-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = allPeriods.find(x => x.id === btn.dataset.periodId);
      if (p) _render(container, farm, p, allPeriods);
    });
  });

  // Wire unallocated sale allocation
  wrap.querySelectorAll('.ls-alloc-mob').forEach(sel => {
    sel.addEventListener('change', () => {
      const btn = wrap.querySelector(`.ls-alloc-btn[data-invoice-id="${sel.dataset.invoiceId}"][data-line-idx="${sel.dataset.lineIdx}"]`);
      if (btn) {
        const hasVal = !!sel.value;
        btn.style.opacity = hasVal ? '1' : '.4';
        btn.style.pointerEvents = hasVal ? '' : 'none';
      }
    });
  });

  wrap.querySelectorAll('.ls-alloc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sel = wrap.querySelector(`.ls-alloc-mob[data-invoice-id="${btn.dataset.invoiceId}"][data-line-idx="${btn.dataset.lineIdx}"]`);
      const mobId = sel?.value;
      if (!mobId) return;
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const qtyVal = parseInt(btn.dataset.head, 10);
        if (!qtyVal || isNaN(qtyVal)) throw new Error('Invalid head count');

        // Get estimated weight if this was a no-weight invoice line
        const allocRow = btn.closest('div[style*="grid"]') || btn.parentElement?.parentElement;
        const estWeightEl = allocRow?.querySelector('.ls-alloc-weight');
        const estWeight = estWeightEl ? parseFloat(estWeightEl.value) || null : null;

        // Check if the invoice date falls in a locked period
        const invoiceDate = btn.dataset.date;
        const targetPeriod = allPeriods.find(p => invoiceDate >= p.period_start && invoiceDate <= p.period_end);
        const openPeriod = allPeriods.find(p => p.status === 'open');

        let postDate = invoiceDate;
        if (targetPeriod && targetPeriod.status === 'locked') {
          if (openPeriod) {
            const useOpen = confirm(
              `The period for ${invoiceDate} is locked.\n\n` +
              `Post this movement to the current open period (${openPeriod.period_start}) instead?\n\n` +
              `Click Cancel to unlock the locked period first.`
            );
            if (!useOpen) {
              toast('Unlock the period in Supabase then try again', 'info');
              btn.disabled = false; btn.textContent = 'Allocate →';
              return;
            }
            postDate = openPeriod.period_start;
          } else {
            throw new Error(`Period for ${invoiceDate} is locked and no open period exists. Unlock the period first.`);
          }
        }
        await dbInsert('stock_movements', {
          farm_id: farm.id,
          item_id: mobId,
          location_id: null,
          movement_type: 'sale',
          qty: qtyVal,
          unit: 'head',
          occurred_on: postDate,
          source_system: 'invoices',
          source_ref: btn.dataset.invoiceId + ':' + btn.dataset.lineIdx,
          note: btn.dataset.note,
          attributes: estWeight ? JSON.stringify({ avg_weight_kg: estWeight, weight_estimated: true }) : null,
        });
        toast('Allocated to mob', 'success');
        await _render(container, farm, period, allPeriods);
      } catch(e) {
        toast('Allocation failed: ' + e.message, 'error');
        btn.disabled = false; btn.textContent = 'Allocate →';
      }
    });
  });

  // Wire re-allocation (edit) buttons
  wrap.querySelectorAll('.ls-realloc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Build a quick mob picker modal
      const mobOpts = items.map(i => `<option value="${i.id}">${i.name}</option>`).join('');
      openModal({
        title: 'Edit mob allocation',
        bodyHTML: `
          <div style="display:flex;flex-direction:column;gap:12px">
            <p style="font-size:13px;color:var(--hint)">Select the correct mob for this sale line.</p>
            <div class="form-group">
              <label class="form-label">Mob</label>
              <select class="form-select" id="realloc-mob">
                <option value="">Select mob…</option>
                ${mobOpts}
              </select>
            </div>
          </div>`,
        confirmLabel: 'Update allocation',
        onConfirm: async (modal) => {
          const newMobId = modal.querySelector('#realloc-mob')?.value;
          if (!newMobId) { toast('Select a mob', 'error'); return false; }
          const qtyVal = parseInt(btn.dataset.head, 10);
          // Delete old movement if it exists
          if (btn.dataset.movementId) {
            try { await dbDelete('stock_movements', btn.dataset.movementId); }
            catch(e) { console.warn('Could not delete old movement:', e); }
          }
          // Insert new movement
          const targetPeriod = allPeriods.find(p => btn.dataset.date >= p.period_start && btn.dataset.date <= p.period_end);
          const postDate = (targetPeriod && targetPeriod.status !== 'locked') ? btn.dataset.date
            : (allPeriods.find(p => p.status === 'open')?.period_start || btn.dataset.date);
          await dbInsert('stock_movements', {
            farm_id: farm.id,
            item_id: newMobId,
            location_id: null,
            movement_type: 'sale',
            qty: qtyVal,
            unit: 'head',
            occurred_on: postDate,
            source_system: 'invoices',
            source_ref: btn.dataset.invoiceId + ':' + btn.dataset.lineIdx,
            note: btn.dataset.note,
          });
          toast('Allocation updated', 'success');
          await _render(container, farm, period, allPeriods);
        }
      });
    });
  });

  // Wire add mob button
  wrap.querySelector('#ls-add-mob')?.addEventListener('click', () => _showAddMobForm(container, farm, period, allPeriods));

  // Wire mob buttons
  wrap.querySelectorAll('.ls-add-move').forEach(btn => {
    btn.addEventListener('click', () => _showMovementForm(container, farm, items, btn.dataset.itemId, btn.dataset.itemName, period, allPeriods));
  });
  wrap.querySelectorAll('.ls-set-opening').forEach(btn => {
    btn.addEventListener('click', () => _showOpeningForm(container, farm, btn.dataset.itemId, btn.dataset.itemName, period, allPeriods));
  });
}

async function _showOpeningForm(container, farm, itemId, itemName, period, allPeriods = []) {
  const date = period ? period.period_start : new Date().toISOString().slice(0,10);
  // Use the day before period start as the opening balance date
  const openingDate = period
    ? new Date(new Date(period.period_start).getTime() - 86400000).toISOString().slice(0,10)
    : new Date(new Date().getFullYear(), 0, 0).toISOString().slice(0,10); // Dec 31 prior year

  openModal({
    title: `Opening balance — ${itemName}`,
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <p style="font-size:13px;color:var(--hint)">Enter the number of head on hand at the start of this period. This becomes the opening balance for the ledger.</p>
        <div class="form-group">
          <label class="form-label">Head count <span style="color:var(--red)">*</span></label>
          <input class="form-input" type="number" id="ob-qty" min="0" step="1" placeholder="0" style="font-size:18px;font-weight:600">
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" type="date" id="ob-date" value="${openingDate}">
        </div>
        <div class="form-group">
          <label class="form-label">Note</label>
          <input class="form-input" type="text" id="ob-note" value="Opening balance" placeholder="e.g. Opening balance from August 2026 workbook">
        </div>
      </div>`,
    confirmLabel: 'Set opening balance',
    onConfirm: async (modal) => {
      const qty = parseInt(modal.querySelector('#ob-qty')?.value);
      const dt  = modal.querySelector('#ob-date')?.value;
      const note = modal.querySelector('#ob-note')?.value?.trim() || 'Opening balance';
      if (!qty || !dt) { toast('Head count and date are required', 'error'); return false; }
      await dbInsert('stock_movements', {
        farm_id: farm.id,
        item_id: itemId,
        location_id: null,
        movement_type: 'adjustment',
        qty: qty,
        direction: 1,
        unit: 'head',
        occurred_on: dt,
        reason_code: 'opening_balance',
        note: note,
      });
      toast('Opening balance set', 'success');
      await _render(container, farm, period, allPeriods);
    }
  });
}

async function _showMovementForm(container, farm, items, preItemId, preItemName, period, allPeriods = []) {
  const today = new Date().toISOString().slice(0,10);
  const lsItems = items; // already filtered to livestock

  openModal({
    title: 'Record livestock movement',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Movement type <span style="color:var(--red)">*</span></label>
          <select class="form-select" id="lm-type">
            <option value="natural_increase">Natural increase (calves born)</option>
            <option value="purchase">Purchase</option>
            <option value="transfer_in">Transfer in</option>
            <option value="sale">Sale</option>
            <option value="death">Death / loss</option>
            <option value="transfer_out">Transfer out</option>
            <option value="adjustment">Adjustment</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Mob <span style="color:var(--red)">*</span></label>
          <select class="form-select" id="lm-item">
            <option value="">Select mob…</option>
            ${lsItems.map(i=>`<option value="${i.id}"${i.id===preItemId?' selected':''}>${i.name}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Head count <span style="color:var(--red)">*</span></label>
          <input class="form-input" type="number" id="lm-qty" min="1" step="1" placeholder="0" style="font-size:16px">
        </div>
        <div class="form-group">
          <label class="form-label">Date <span style="color:var(--red)">*</span></label>
          <input class="form-input" type="date" id="lm-date" value="${today}">
        </div>
        <div class="form-group">
          <label class="form-label">Note</label>
          <input class="form-input" type="text" id="lm-note" placeholder="e.g. Sale to JBS Dinmore · agent fee TBC">
        </div>
        <div id="lm-reclass-wrap" style="display:none;background:var(--page-bg);border-radius:8px;padding:12px;border:1px solid var(--border)">
          <label class="form-label" style="margin-bottom:8px">Reclassify to (destination mob)</label>
          <select class="form-select" id="lm-reclass-dest">
            <option value="">Select destination mob…</option>
            ${lsItems.map(i=>`<option value="${i.id}">${i.name}</option>`).join('')}
          </select>
          <div style="font-size:11px;color:var(--hint);margin-top:6px">Use this when animals mature to a new class — e.g. heifers becoming cows.</div>
        </div>
      </div>`,
    confirmLabel: 'Record movement',
    onConfirm: async (modal) => {
      const type    = modal.querySelector('#lm-type')?.value;
      const itemId  = modal.querySelector('#lm-item')?.value;
      const qty     = parseInt(modal.querySelector('#lm-qty')?.value);
      const date    = modal.querySelector('#lm-date')?.value;
      const note    = modal.querySelector('#lm-note')?.value?.trim();
      const reclassDest = modal.querySelector('#lm-reclass-dest')?.value;

      if (!itemId || !qty || !date) { toast('Mob, quantity and date are required', 'error'); return false; }
      if (type === 'adjustment' && !note) { toast('A note is required for adjustments', 'error'); return false; }

      if (type === 'reclass_out') {
        // Paired reclass — need both legs
        if (!reclassDest) { toast('Select the destination mob for reclassification', 'error'); return false; }
        const transferId = crypto.randomUUID();
        await dbInsert('stock_movements', {
          farm_id: farm.id, item_id: itemId, location_id: null,
          movement_type: 'reclass_out', qty, unit:'head', occurred_on: date,
          transfer_id: transferId, note: note||null,
        });
        await dbInsert('stock_movements', {
          farm_id: farm.id, item_id: reclassDest, location_id: null,
          movement_type: 'reclass_in', qty, unit:'head', occurred_on: date,
          transfer_id: transferId, note: note||null,
        });
      } else {
        const movType = type === 'purchase' ? 'transfer_in' : type;
        await dbInsert('stock_movements', {
          farm_id: farm.id, item_id: itemId, location_id: null,
          movement_type: movType, qty, unit:'head', occurred_on: date,
          note: note||null,
        });
      }
      toast('Movement recorded', 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  // Wire reclass toggle
  setTimeout(() => {
    const typeEl = document.getElementById('lm-type');
    const reclassWrap = document.getElementById('lm-reclass-wrap');
    typeEl?.addEventListener('change', () => {
      if (reclassWrap) reclassWrap.style.display = typeEl.value === 'reclass_out' ? '' : 'none';
    });
  }, 50);
}
// ── Unallocated sales panel builder ──────────────────────────
function _buildUnallocatedPanel(pendingInvoices, items, movements) {
  // movements that came from invoices — keyed by "invoiceId:lineIdx"
  const allocatedByKey = {};
  movements.filter(m => m.source_system === 'invoices' && m.source_ref).forEach(m => {
    allocatedByKey[m.source_ref] = m;
  });

  const unallocated = [];
  const allocated = [];
  pendingInvoices.forEach(inv => {
    if (!inv.livestock_lines?.length) return;
    inv.livestock_lines.forEach((line, idx) => {
      if (!line.head) return;
      const key = inv.id + ':' + idx;
      const movement = allocatedByKey[key] || null;
      if (movement) {
        allocated.push({ inv, line, idx, movement });
      } else {
        unallocated.push({ inv, line, idx });
      }
    });
  });
  if (!unallocated.length && !allocated.length) return '';

  const mobOpts = items.map(si =>
    `<option value="${si.id}">${si.name}</option>`
  ).join('');

  const rows = unallocated.map(({ inv, line, idx }) => {
    const buyer = (inv.buyer || inv.agent_name || '—').replace(/"/g, '');
    const docLink = inv.rcti_files?.length
      ? `<a href="${inv.rcti_files[0].url}" target="_blank" style="font-size:10px;color:var(--blue);text-decoration:none">📄 View statement</a>`
      : '';
    const weightStr = line.no_weight
      ? `<span style="color:var(--amber);font-size:11px">Est. needed</span>`
      : line.avg_weight_kg ? line.avg_weight_kg + 'kg' : '—';
    const priceStr = line.price ? '$' + line.price + (line.price_basis === 'per_kg' ? '/kg' : '/hd') : '—';

    return [
      `<div style="display:grid;grid-template-columns:90px 1fr 60px 80px 80px 1fr 120px;`,
      `gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-light);align-items:center;font-size:12px">`,
      `<div style="color:var(--hint)">${inv.invoice_date}</div>`,
      `<div><div style="font-weight:500;color:var(--ink)">${line.description || '—'}</div>`,
      `<div style="font-size:10px;color:var(--hint)">${buyer}</div>${docLink}</div>`,
      `<div style="font-weight:600;color:var(--ink)">${line.head} hd</div>`,
      `<div style="color:var(--hint)">${weightStr}</div>`,
      `<div style="color:var(--hint)">${priceStr}</div>`,
      `<div><select class="form-select ls-alloc-mob" `,
      `data-invoice-id="${inv.id}" data-line-idx="${idx}" `,
      `data-head="${line.head}" data-date="${inv.left_farm_date || inv.invoice_date}" data-note="Sale to ${buyer}" `,
      `data-no-weight="${line.no_weight ? '1' : ''}" `,
      `style="font-size:11px"><option value="">Select mob…</option>${mobOpts}</select>`,
      line.no_weight ? `<input type="number" class="form-input ls-alloc-weight" step="0.1" placeholder="Avg kg (est.)" style="font-size:11px;margin-top:4px;padding:4px 8px">` : '',
      `</div>`,
      `<div><button class="btn btn-sm btn-primary ls-alloc-btn" `,
      `data-invoice-id="${inv.id}" data-line-idx="${idx}" `,
      `data-head="${line.head}" data-date="${inv.left_farm_date || inv.invoice_date}" data-note="Sale to ${buyer}" `,
      `style="font-size:11px;opacity:.4;pointer-events:none">Allocate →</button></div>`,
      `</div>`,
    ].join('');
  }).join('');

  const pendingCard = unallocated.length ? [
    `<div class="card" style="margin-bottom:12px;overflow:hidden;border:2px solid var(--amber)">`,
    `<div style="padding:10px 14px;border-bottom:1px solid var(--border);background:#fffbeb;`,
    `display:flex;align-items:center;justify-content:space-between">`,
    `<span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#92400e">`,
    `⚡ ${unallocated.length} sale line${unallocated.length !== 1 ? 's' : ''} awaiting mob allocation</span>`,
    `<span style="font-size:11px;color:#92400e">Assign each to a mob to update the ledger</span>`,
    `</div>`,
    rows,
    `</div>`,
  ].join('') : '';

  // Allocated / archive section
  const idToName = {};
  // items already in scope
  const archiveRows = allocated.map(({ inv, line, idx, movement }) => {
    const buyer = (inv.buyer || inv.agent_name || '—').replace(/"/g, '');
    const mobName = movement ? (items.find(i => i.id === movement.item_id)?.name || movement.item_id) : '—';
    const docLink = inv.rcti_files?.length
      ? `<a href="${inv.rcti_files[0].url}" target="_blank" style="font-size:10px;color:var(--blue);text-decoration:none">📄</a>`
      : '';
    return [
      `<div style="display:grid;grid-template-columns:90px 1fr 60px 1fr 100px;`,
      `gap:8px;padding:9px 14px;border-bottom:1px solid var(--border-light);align-items:center;font-size:12px">`,
      `<div style="color:var(--hint)">${inv.invoice_date}</div>`,
      `<div><span style="color:var(--ink)">${line.description||'—'}</span> `,
      `<span style="color:var(--hint);font-size:11px">${buyer}</span> ${docLink}</div>`,
      `<div style="font-weight:600">${line.head} hd</div>`,
      `<div style="color:var(--green);font-weight:500">→ ${mobName}</div>`,
      `<div><button class="btn btn-ghost btn-sm ls-realloc-btn" `,
      `data-movement-id="${movement?.id||''}" `,
      `data-invoice-id="${inv.id}" data-line-idx="${idx}" `,
      `data-head="${line.head}" data-date="${inv.left_farm_date || inv.invoice_date}" data-note="Sale to ${buyer}" `,
      `style="font-size:11px;color:var(--amber)">✎ Edit</button></div>`,
      `</div>`,
    ].join('');
  }).join('');

  const archiveCard = allocated.length ? [
    `<div class="card" style="margin-bottom:12px;overflow:hidden">`,
    `<div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--page-bg);`,
    `display:flex;align-items:center;justify-content:space-between;cursor:pointer" `,
    `onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'':'none'">`,
    `<span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">`,
    `✓ ${allocated.length} allocated sale${allocated.length!==1?'s':''}</span>`,
    `<span style="font-size:11px;color:var(--hint)">▾ show/hide</span>`,
    `</div>`,
    `<div style="display:none">`,
    archiveRows,
    `</div>`,
    `</div>`,
  ].join('') : '';

  return pendingCard + archiveCard;
}

// ── Add mob form ──────────────────────────────────────────────
async function _showAddMobForm(container, farm, period, allPeriods) {
  const CATTLE_CLASSES = ['Calf','Weaner','Heifer','Steer','Cow','Bull'];
  const SHEEP_CLASSES  = ['Lamb','Weaner','Ewe Lamb','Wether Lamb','Ewe','Wether','Ram'];
  const currentYear = new Date().getFullYear();
  const years = Array.from({length:15}, (_,i) => currentYear - i);

  openModal({
    title: 'Add livestock mob',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Species <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="am-species">
              <option value="cattle">Cattle</option>
              <option value="sheep">Sheep</option>
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Breed / type <span style="color:var(--red)">*</span></label>
            <input class="form-input" id="am-breed" type="text" placeholder="e.g. Angus, Wagyu X">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Class <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="am-class">
              ${CATTLE_CLASSES.map(c=>`<option value="${c.toLowerCase()}">${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Sex</label>
            <select class="form-select" id="am-sex">
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="mixed">Mixed</option>
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Birth year</label>
            <select class="form-select" id="am-year">
              <option value="">M/A (mixed age)</option>
              ${years.map(y=>`<option value="${y}">${y}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Mob name <span style="color:var(--red)">*</span></label>
          <input class="form-input" id="am-name" type="text" placeholder="e.g. Angus Heifers 2024">
          <div style="font-size:11px;color:var(--hint);margin-top:3px">Auto-filled from selections above — edit if needed</div>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Opening head count</label>
          <input class="form-input" id="am-opening" type="number" min="0" step="1" placeholder="0 — enter if known">
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Notes</label>
          <input class="form-input" id="am-notes" type="text" placeholder="Optional">
        </div>
      </div>`,
    confirmLabel: 'Add mob',
    onConfirm: async (modal) => {
      const breed  = modal.querySelector('#am-breed')?.value?.trim();
      const cls    = modal.querySelector('#am-class')?.value;
      const sex    = modal.querySelector('#am-sex')?.value;
      const year   = modal.querySelector('#am-year')?.value;
      const name   = modal.querySelector('#am-name')?.value?.trim();
      const opening = parseInt(modal.querySelector('#am-opening')?.value) || 0;
      const notes  = modal.querySelector('#am-notes')?.value?.trim() || null;

      if (!breed) { toast('Breed is required', 'error'); return false; }
      if (!name)  { toast('Mob name is required', 'error'); return false; }

      const attrs = { breed, class: cls, sex };
      if (year) attrs.birth_year = parseInt(year);

      await dbInsert('stock_items', {
        farm_id: farm.id,
        category: 'livestock',
        name,
        subgroup: breed,
        default_unit: 'head',
        attributes: attrs,
        active: true,
        notes,
      });

      // Post opening balance if provided
      if (opening > 0 && period) {
        const openingDate = new Date(new Date(period.period_start).getTime() - 86400000).toISOString().slice(0,10);
        // Get the new item id
        const newItems = await dbSelect('stock_items', `farm_id=eq.${farm.id}&name=eq.${encodeURIComponent(name)}&order=created_at.desc&limit=1`);
        if (newItems[0]) {
          await dbInsert('stock_movements', {
            farm_id: farm.id,
            item_id: newItems[0].id,
            location_id: null,
            movement_type: 'adjustment',
            qty: opening,
            direction: 1,
            unit: 'head',
            occurred_on: openingDate,
            reason_code: 'opening_balance',
            note: 'Opening balance',
          });
        }
      }

      toast(`${name} added`, 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  // Wire auto-name generation
  setTimeout(() => {
    const speciesEl = document.getElementById('am-species');
    const breedEl   = document.getElementById('am-breed');
    const classEl   = document.getElementById('am-class');
    const sexEl     = document.getElementById('am-sex');
    const yearEl    = document.getElementById('am-year');
    const nameEl    = document.getElementById('am-name');

    // Update class options when species changes
    speciesEl?.addEventListener('change', () => {
      const classes = speciesEl.value === 'sheep' ? SHEEP_CLASSES : CATTLE_CLASSES;
      if (classEl) classEl.innerHTML = classes.map(c=>`<option value="${c.toLowerCase()}">${c}</option>`).join('');
      autoName();
    });

    const autoName = () => {
      if (!nameEl || nameEl._manuallyEdited) return;
      const parts = [breedEl?.value?.trim(), classEl?.options[classEl?.selectedIndex]?.text, yearEl?.value].filter(Boolean);
      nameEl.value = parts.join(' ');
    };

    [breedEl, classEl, sexEl, yearEl].forEach(el => el?.addEventListener('input', autoName));
    [breedEl, classEl, sexEl, yearEl].forEach(el => el?.addEventListener('change', autoName));
    nameEl?.addEventListener('input', () => { nameEl._manuallyEdited = true; });
  }, 50);
}
