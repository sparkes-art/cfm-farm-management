// modules/stocktake/livestock.js
// Livestock stocktake — mob ledger, movement entry, opening balances

import { dbSelect, dbInsert } from '../../js/supabase-client.js';
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

  const [items, movements] = await Promise.all([
    dbSelect('stock_items', `farm_id=eq.${farm.id}&category=eq.livestock&active=eq.true&order=subgroup,name`),
    dbSelect('stock_movements', `farm_id=eq.${farm.id}&select=item_id,movement_type,signed_qty,qty,unit,occurred_on,note&order=occurred_on.desc`),
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
      <tr style="border-bottom:1px solid var(--border-light)" 
        onmouseenter="this.style.background='var(--blue-light)'" 
        onmouseleave="this.style.background=''">
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

  wrap.innerHTML = timelineHtml + `
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
      </div>
    </div>

    <!-- Mob grids -->
    ${groupHtml}

    <!-- Recent movements -->
    ${periodMovements.length ? `
    <div class="card" style="margin-top:16px;overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--page-bg)">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Period movements</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        ${periodMovements.slice(0,20).map(m => {
          const item = items.find(i=>i.id===m.item_id);
          const mt = MOVE_TYPES[m.movement_type] || {label:m.movement_type,color:'var(--hint)'};
          const qty = parseFloat(m.signed_qty)||0;
          return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
            <td style="padding:8px 14px;color:var(--hint)">${m.occurred_on}</td>
            <td style="padding:8px 14px;font-weight:500;color:var(--ink)">${item?.name||'—'}</td>
            <td style="padding:8px 14px;color:${mt.color}">${mt.label}</td>
            <td style="padding:8px 14px;text-align:right;font-weight:600;color:${qty>0?'var(--green)':'var(--red)'}">${qty>0?'+':''}${fN(qty)}</td>
            <td style="padding:8px 14px;color:var(--hint)">${m.note||''}</td>
          </tr>`;
        }).join('')}
      </table>
    </div>` : ''}`;

  // Wire period timeline buttons
  wrap.querySelectorAll('.ls-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = allPeriods.find(x => x.id === btn.dataset.periodId);
      if (p) _render(container, farm, p, allPeriods);
    });
  });

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
    ? new Date(new Date(date).getTime() - 86400000).toISOString().slice(0,10)
    : date;

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