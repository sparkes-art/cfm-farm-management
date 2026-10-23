// modules/stocktake/grain.js
// Grain / hay stocktake — balance per commodity × location, full movement ledger
// Opening balance seeded from budget carry-over rows (budgeted_yield_per_ha)

import { dbSelect, dbInsert, dbUpdate } from '../../js/supabase-client.js?v=1792559266387';
import { getActiveFarm, canWrite } from '../../js/app-state.js?v=1792559266387';
import { toast, openModal, qs } from '../../js/ui.js?v=1792559266387';

// ── Movement type catalogue ────────────────────────────────────────────────
const MOVE_TYPES = {
  harvest_inload: { label: 'Harvest inload',    dir: 1,  color: 'var(--green)',  icon: '🌾' },
  delivery:       { label: 'Purchase / delivery', dir: 1,  color: 'var(--blue)',   icon: '🚛' },
  transfer_in:    { label: 'Transfer in',        dir: 1,  color: 'var(--blue)',   icon: '→' },
  transfer_out:   { label: 'Transfer out',       dir: -1, color: 'var(--hint)',   icon: '←' },
  sale:           { label: 'Sale',               dir: -1, color: 'var(--amber)',  icon: '💰' },
  usage:          { label: 'Fed out',            dir: -1, color: 'var(--ink-mid)', icon: '🐄' },
  write_off:      { label: 'Waste / shrinkage',  dir: -1, color: 'var(--red)',    icon: '⚠' },
  adjustment:     { label: 'Adjustment',         dir: 0,  color: 'var(--hint)',   icon: '±' },
};

export async function mountGrain(container, initialPeriod) {
  const farm = getActiveFarm();
  container.innerHTML = `<div style="padding:20px 24px;max-width:1200px;margin:0 auto" id="gr-wrap">
    <div style="padding:40px;text-align:center;color:var(--hint)">Loading grain & hay…</div>
  </div>`;

  const allPeriods = await dbSelect('stock_periods',
    `farm_id=eq.${farm.id}&order=period_start.asc`
  );

  const defaultPeriod = initialPeriod
    || allPeriods.find(p => p.status === 'open')
    || allPeriods[allPeriods.length - 1]
    || null;

  await _render(container, farm, defaultPeriod, allPeriods);
}

async function _render(container, farm, period, allPeriods = []) {
  const wrap = qs('#gr-wrap', container);

  const [items, locations, movements] = await Promise.all([
    dbSelect('stock_items',
      `farm_id=eq.${farm.id}&category=eq.grain&active=eq.true&order=subgroup,name`),
    dbSelect('stock_locations',
      `farm_id=eq.${farm.id}&active=eq.true&order=route_order,name`),
    dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&select=id,item_id,location_id,movement_type,signed_qty,qty,unit,occurred_on,note,source_ref,source_system,reason_code&order=occurred_on.desc`).then(rows =>
        // Only grain movements (filter by item_id membership)
        rows // full filter happens after items load
    ),
  ]);

  // Filter movements to only grain items
  const itemIds = new Set(items.map(i => i.id));
  const grainMovements = movements.filter(m => itemIds.has(m.item_id));

  // ── Period timeline ────────────────────────────────────────────
  const timelineHtml = allPeriods.length > 1 ? (() => {
    return `<div style="display:flex;align-items:center;gap:2px;overflow-x:auto;padding:4px 0;margin-bottom:16px;border-bottom:1px solid var(--border-light);padding-bottom:12px">
      ${allPeriods.map(p => {
        const d = new Date(p.period_start);
        const label = d.toLocaleDateString('en-AU', {month:'short', year:'2-digit'});
        const isActive = period && p.id === period.id;
        const dotColor = p.status === 'locked' ? 'var(--hint)' : p.status === 'review' ? 'var(--amber)' : 'var(--green)';
        const statusDot = p.status === 'locked' ? '🔒' : p.status === 'review' ? '🔶' : '●';
        return `<button class="gr-period-btn" data-period-id="${p.id}"
          style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 14px;border:none;border-radius:8px;cursor:pointer;background:${isActive?'var(--blue)':'transparent'};transition:background .15s;flex-shrink:0">
          <span style="font-size:11px;font-weight:${isActive?700:500};color:${isActive?'white':'var(--ink-mid)'}">${label}</span>
          <span style="font-size:9px;color:${isActive?'rgba(255,255,255,.7)':dotColor}">${statusDot} ${p.status}</span>
        </button>`;
      }).join('')}
    </div>`;
  })() : '';

  if (!items.length) {
    wrap.innerHTML = timelineHtml + `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h2 style="font-size:18px;font-weight:700;color:var(--ink)">Grain & Hay</h2>
          <p style="font-size:13px;color:var(--hint);margin-top:4px">${farm.name}</p>
        </div>
        ${canWrite() ? `<button class="btn btn-primary btn-sm" id="gr-add-item">+ Add commodity</button>` : ''}
      </div>
      <div style="padding:40px;text-align:center;color:var(--hint);background:white;border-radius:10px;border:1px solid var(--border)">
        <div style="font-size:32px;margin-bottom:12px">🌾</div>
        <p style="font-size:15px;font-weight:500;color:var(--ink);margin-bottom:6px">No grain or hay commodities set up</p>
        <p style="font-size:13px;margin-bottom:16px">Add a commodity to start tracking stock on hand.</p>
        ${canWrite() ? `<button class="btn btn-primary" id="gr-add-item-empty">+ Add commodity</button>` : ''}
      </div>`;
    wrap.querySelector('#gr-add-item')?.addEventListener('click',
      () => _showAddItemForm(container, farm, period, allPeriods));
    wrap.querySelector('#gr-add-item-empty')?.addEventListener('click',
      () => _showAddItemForm(container, farm, period, allPeriods));
    return;
  }

  // ── Build balances per item × location ────────────────────────
  const periodStart = period?.period_start;
  const periodEnd   = period?.period_end;

  const balanceKey = (itemId, locId) => `${itemId}||${locId || 'none'}`;

  // Opening balance = sum of all movements BEFORE this period
  const openingMap = {};
  grainMovements
    .filter(m => !periodStart || m.occurred_on < periodStart)
    .forEach(m => {
      const k = balanceKey(m.item_id, m.location_id);
      openingMap[k] = (openingMap[k] || 0) + (parseFloat(m.signed_qty) || 0);
    });

  // Period movements
  const periodMoves = periodStart
    ? grainMovements.filter(m => m.occurred_on >= periodStart && m.occurred_on <= periodEnd)
    : grainMovements;

  // Closing balance = opening + period movements
  const closingMap = { ...openingMap };
  periodMoves.forEach(m => {
    const k = balanceKey(m.item_id, m.location_id);
    closingMap[k] = (closingMap[k] || 0) + (parseFloat(m.signed_qty) || 0);
  });

  // ── Check for unseeded opening balances from budget carry-over ─
  const budgetOpen = await _getBudgetOpenings(farm, period);
  const missingOpenings = budgetOpen.filter(b => {
    // Find matching grain item by commodity name
    const item = items.find(i => i.name.toUpperCase() === b.commodity.toUpperCase());
    if (!item) return false;
    // Check if this item has any movement at all (opening already set)
    const hasAny = grainMovements.some(m => m.item_id === item.id);
    return !hasAny;
  });

  // ── Location lookup ────────────────────────────────────────────
  const locById = {};
  locations.forEach(l => { locById[l.id] = l; });

  // ── Summary totals per item ────────────────────────────────────
  const fN = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
  const fD = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1).replace(/\.0$/, '');

  // Build per-item summary
  const itemGroups = items.map(item => {
    const attrs = item.attributes || {};
    const unit = item.default_unit || 'bales';
    const kgPerBale = attrs.kg_per_bale || null;
    const baleType = attrs.bale_type || '';

    // All location keys for this item
    const locKeys = [...new Set([
      ...Object.keys(openingMap).filter(k => k.startsWith(item.id + '||')),
      ...Object.keys(closingMap).filter(k => k.startsWith(item.id + '||')),
    ])];

    const locationRows = locKeys.map(k => {
      const locId = k.split('||')[1];
      const locName = locId === 'none' ? '— no location' : (locById[locId]?.name || locId);
      const opening = openingMap[k] || 0;
      const closing = closingMap[k] || 0;
      const periodIn  = periodMoves.filter(m => m.item_id === item.id && m.location_id === (locId === 'none' ? null : locId) && (parseFloat(m.signed_qty)||0) > 0)
        .reduce((s,m) => s + (parseFloat(m.signed_qty)||0), 0);
      const periodOut = periodMoves.filter(m => m.item_id === item.id && m.location_id === (locId === 'none' ? null : locId) && (parseFloat(m.signed_qty)||0) < 0)
        .reduce((s,m) => s + (parseFloat(m.signed_qty)||0), 0);

      const tonnesStr = kgPerBale && closing
        ? `<span style="font-size:10px;color:var(--hint);margin-left:4px">${fD(closing * kgPerBale / 1000)} t</span>`
        : '';

      return `<tr style="border-bottom:1px solid var(--border-light)">
        <td style="padding:10px 14px 10px 24px;font-size:13px;color:var(--ink)">${locName}</td>
        <td style="padding:10px 14px;text-align:center;font-size:13px;color:var(--hint)">${opening ? fN(opening) : '—'}</td>
        <td style="padding:10px 14px;text-align:center;font-size:13px;color:var(--green)">${periodIn ? '+'+fN(periodIn) : '—'}</td>
        <td style="padding:10px 14px;text-align:center;font-size:13px;color:var(--red)">${periodOut ? fN(periodOut) : '—'}</td>
        <td style="padding:10px 14px;text-align:center">
          <span style="font-size:15px;font-weight:700;color:var(--ink)">${fN(closing)}</span>${tonnesStr}
        </td>
        <td style="padding:10px 14px;text-align:center">
          ${canWrite() ? `<button class="btn btn-ghost btn-sm gr-add-move"
            data-item-id="${item.id}" data-item-name="${item.name}"
            data-loc-id="${locId === 'none' ? '' : locId}"
            data-loc-name="${locName}"
            style="font-size:11px">+ Movement</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    // Totals row
    const totalClosing = locKeys.reduce((s, k) => s + (closingMap[k] || 0), 0);
    const totalTonnesStr = kgPerBale && totalClosing
      ? ` · ${fD(totalClosing * kgPerBale / 1000)} t`
      : '';

    const hasOpening = grainMovements.some(m => m.item_id === item.id);
    const budgetRow = budgetOpen.find(b => b.commodity.toUpperCase() === item.name.toUpperCase());

    return `<div style="margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#1a2535;border-radius:8px 8px 0 0">
        <div>
          <span style="font-size:13px;font-weight:600;color:white">${item.name}</span>
          <span style="font-size:11px;color:rgba(255,255,255,.5);margin-left:8px">${baleType ? baleType + ' bales' : unit}${kgPerBale ? ' · ' + kgPerBale + ' kg/bale' : ''}</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:12px;color:rgba(255,255,255,.6)">${fN(totalClosing)} ${unit} on hand${totalTonnesStr}</span>
          ${canWrite() ? `<button class="btn btn-sm gr-add-move-top" data-item-id="${item.id}" data-item-name="${item.name}"
            style="font-size:11px;background:rgba(255,255,255,.12);color:white;border:1px solid rgba(255,255,255,.2)">+ Movement</button>` : ''}
          ${!hasOpening && budgetRow && canWrite() ? `<button class="btn btn-sm gr-seed-opening"
            data-item-id="${item.id}" data-item-name="${item.name}"
            data-qty="${budgetRow.qty}" data-unit="${unit}"
            style="font-size:11px;background:#f59e0b;color:white;border:none">
            ⤵ Seed from budget (${fN(budgetRow.qty)} ${unit})</button>` : ''}
        </div>
      </div>
      <div class="card" style="border-radius:0 0 8px 8px;overflow:hidden;padding:0">
        ${locationRows ? `<table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
              <th style="padding:8px 14px 8px 24px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Location</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Opening</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--green);font-weight:600">In</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--red);font-weight:600">Out</th>
              <th style="padding:8px 14px;text-align:center;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Closing</th>
              <th style="padding:8px 14px;text-align:center;width:120px"></th>
            </tr>
          </thead>
          <tbody>${locationRows}</tbody>
        </table>` : `<div style="padding:20px;text-align:center;color:var(--hint);font-size:13px">
          No movements yet.
          ${canWrite() ? `<button class="btn btn-ghost btn-sm gr-add-move-top" data-item-id="${item.id}" data-item-name="${item.name}" style="margin-left:8px;font-size:11px">+ Add movement</button>` : ''}
        </div>`}
      </div>
    </div>`;
  }).join('');

  // ── Period movements log ───────────────────────────────────────
  const movementRows = periodMoves.slice(0, 30).map(m => {
    const item = items.find(i => i.id === m.item_id);
    const mt = MOVE_TYPES[m.movement_type] || { label: m.movement_type, color: 'var(--hint)', icon: '·' };
    const qty = parseFloat(m.signed_qty) || 0;
    const locName = m.location_id ? (locById[m.location_id]?.name || m.location_id) : '—';
    const kgPerBale = item?.attributes?.kg_per_bale;
    const tonnesStr = kgPerBale ? ` (${fD(Math.abs(qty) * kgPerBale / 1000)} t)` : '';
    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:8px 14px;color:var(--hint)">${m.occurred_on}</td>
      <td style="padding:8px 14px;font-weight:500;color:var(--ink)">${item?.name || '—'}</td>
      <td style="padding:8px 14px;color:${mt.color}">${mt.icon} ${mt.label}</td>
      <td style="padding:8px 14px;color:var(--hint);font-size:11px">${locName}</td>
      <td style="padding:8px 14px;text-align:right;font-weight:600;color:${qty > 0 ? 'var(--green)' : 'var(--red)'}">
        ${qty > 0 ? '+' : ''}${fN(qty)} ${item?.default_unit||''}${tonnesStr}
      </td>
      <td style="padding:8px 14px;color:var(--hint)">${m.note || ''}</td>
    </tr>`;
  }).join('');

  // ── Unseed opening banner ──────────────────────────────────────
  const openingBanner = missingOpenings.length ? `
    <div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <div style="font-size:13px;font-weight:600;color:#92400e">⤵ Budget carry-over opening available</div>
        <div style="font-size:12px;color:#92400e;margin-top:2px">
          ${missingOpenings.map(b => `${b.commodity}: ${fN(b.qty)} bales`).join(' · ')}
          — click "Seed from budget" on each commodity to set the opening balance
        </div>
      </div>
    </div>` : '';

  wrap.innerHTML = timelineHtml + openingBanner + `
    <!-- Header -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <div>
        <h2 style="font-size:18px;font-weight:700;color:var(--ink)">Grain & Hay</h2>
        <p style="font-size:13px;color:var(--hint);margin-top:4px">${farm.name} · ${period ? new Date(period.period_start).toLocaleDateString('en-AU',{month:'long',year:'numeric'}) : 'All time'}</p>
      </div>
      ${canWrite() ? `<button class="btn btn-secondary btn-sm" id="gr-add-item" style="white-space:nowrap">+ Add commodity</button>` : ''}
    </div>

    <!-- Commodity grids -->
    ${itemGroups}

    <!-- Period movements -->
    ${periodMoves.length ? `
    <div class="card" style="margin-top:24px;overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--page-bg)">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Period movements</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Date</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Commodity</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Type</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Location</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:right">Qty</th>
            <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Note</th>
          </tr>
        </thead>
        <tbody>${movementRows}</tbody>
      </table>
    </div>` : ''}`;

  // ── Wire events ────────────────────────────────────────────────
  wrap.querySelectorAll('.gr-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = allPeriods.find(x => x.id === btn.dataset.periodId);
      if (p) _render(container, farm, p, allPeriods);
    });
  });

  wrap.querySelector('#gr-add-item')?.addEventListener('click',
    () => _showAddItemForm(container, farm, period, allPeriods));

  wrap.querySelectorAll('.gr-add-move, .gr-add-move-top').forEach(btn => {
    btn.addEventListener('click', () =>
      _showMovementForm(container, farm, items, locations, btn.dataset.itemId, btn.dataset.itemName, btn.dataset.locId || null, period, allPeriods));
  });

  wrap.querySelectorAll('.gr-seed-opening').forEach(btn => {
    btn.addEventListener('click', () =>
      _seedOpeningFromBudget(container, farm, btn.dataset.itemId, btn.dataset.itemName,
        parseFloat(btn.dataset.qty), btn.dataset.unit, period, allPeriods));
  });
}

// ── Fetch budget carry-over openings for this farm/season ──────────────────
async function _getBudgetOpenings(farm, period) {
  if (!period) return [];
  // Pull carry_over budget rows — budgeted_yield_per_ha holds the units qty
  try {
    const rows = await dbSelect('budgets',
      `farm_id=eq.${farm.id}&section=eq.carry_over&select=commodity,budgeted_yield_per_ha,notes`
    );
    return rows
      .filter(r => r.budgeted_yield_per_ha != null && r.budgeted_yield_per_ha > 0)
      .map(r => ({
        commodity: r.commodity,
        qty: r.budgeted_yield_per_ha,
        unit: _unitFromNotes(r.notes),
      }));
  } catch { return []; }
}

function _unitFromNotes(notes) {
  if (!notes) return 'bales';
  const m = notes.match(/yield unit:\s*(\w+)/i);
  return m ? m[1] : 'bales';
}

// ── Seed opening balance from budget carry-over ────────────────────────────
async function _seedOpeningFromBudget(container, farm, itemId, itemName, qty, unit, period, allPeriods) {
  if (!period) { toast('No active period — open a period first', 'error'); return; }

  // Date = day before period start
  const openingDate = new Date(new Date(period.period_start).getTime() - 86400000).toISOString().slice(0,10);

  openModal({
    title: `Set opening balance — ${itemName}`,
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:12px;font-size:13px;color:#92400e">
          This opening balance comes from the budget carry-over row for <strong>${itemName}</strong>.
          It represents the quantity on hand at the start of the season, before any harvest or sales this period.
        </div>
        <div class="form-group">
          <label class="form-label">Opening quantity</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="form-input" type="number" id="gs-qty" min="0" step="1" value="${Math.round(qty)}" style="font-size:18px;font-weight:600;max-width:150px">
            <span style="font-size:14px;color:var(--hint)">${unit}</span>
          </div>
          <div style="font-size:11px;color:var(--hint);margin-top:4px">From budget carry-over: ${Math.round(qty)} ${unit}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" type="date" id="gs-date" value="${openingDate}">
        </div>
        <div class="form-group">
          <label class="form-label">Note</label>
          <input class="form-input" type="text" id="gs-note" value="Opening balance — seeded from budget carry-over">
        </div>
      </div>`,
    confirmLabel: 'Set opening balance',
    onConfirm: async (modal) => {
      const q    = parseFloat(modal.querySelector('#gs-qty')?.value);
      const dt   = modal.querySelector('#gs-date')?.value;
      const note = modal.querySelector('#gs-note')?.value?.trim() || 'Opening balance';
      if (!q || !dt) { toast('Quantity and date are required', 'error'); return false; }

      await dbInsert('stock_movements', {
        farm_id:       farm.id,
        item_id:       itemId,
        location_id:   null,
        movement_type: 'adjustment',
        qty:           q,
        direction:     1,
        unit:          unit,
        occurred_on:   dt,
        reason_code:   'opening_balance',
        note,
        source_system: 'budgets',
      });
      toast(`Opening balance set — ${Math.round(q)} ${unit}`, 'success');
      await _render(container, farm, period, allPeriods);
    }
  });
}

// ── Movement form ──────────────────────────────────────────────────────────
async function _showMovementForm(container, farm, items, locations, preItemId, preItemName, preLocId, period, allPeriods) {
  const today = new Date().toISOString().slice(0,10);
  const locOpts = locations.map(l =>
    `<option value="${l.id}"${l.id === preLocId ? ' selected' : ''}>${l.name}${l.sub_property ? ' · '+l.sub_property : ''}</option>`
  ).join('');
  const itemOpts = items.map(i =>
    `<option value="${i.id}"${i.id === preItemId ? ' selected' : ''}>${i.name}</option>`
  ).join('');

  openModal({
    title: 'Record grain / hay movement',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Movement type <span style="color:var(--red)">*</span></label>
          <select class="form-select" id="gm-type">
            ${Object.entries(MOVE_TYPES).map(([k, v]) =>
              `<option value="${k}">${v.icon} ${v.label}</option>`
            ).join('')}
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Commodity <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="gm-item">
              <option value="">Select…</option>
              ${itemOpts}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Location</label>
            <select class="form-select" id="gm-location">
              <option value="">No location / general</option>
              ${locOpts}
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Quantity <span style="color:var(--red)">*</span></label>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="form-input" type="number" id="gm-qty" min="1" step="1" placeholder="0">
              <span id="gm-unit-label" style="font-size:13px;color:var(--hint);white-space:nowrap">bales</span>
            </div>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Date <span style="color:var(--red)">*</span></label>
            <input class="form-input" type="date" id="gm-date" value="${today}">
          </div>
        </div>
        <div id="gm-transfer-dest" style="display:none" class="form-group">
          <label class="form-label">Destination location (transfer)</label>
          <select class="form-select" id="gm-dest-loc">
            <option value="">Select destination…</option>
            ${locOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Note</label>
          <input class="form-input" type="text" id="gm-note" placeholder="e.g. Baled paddock 12 — contractor pickup">
        </div>
      </div>`,
    confirmLabel: 'Record movement',
    onConfirm: async (modal) => {
      const type   = modal.querySelector('#gm-type')?.value;
      const itemId = modal.querySelector('#gm-item')?.value;
      const locId  = modal.querySelector('#gm-location')?.value || null;
      const destLocId = modal.querySelector('#gm-dest-loc')?.value || null;
      const qty    = parseFloat(modal.querySelector('#gm-qty')?.value);
      const date   = modal.querySelector('#gm-date')?.value;
      const note   = modal.querySelector('#gm-note')?.value?.trim() || null;

      if (!itemId || !qty || !date) { toast('Commodity, quantity and date are required', 'error'); return false; }
      if (type === 'adjustment' && !note) { toast('A note is required for adjustments', 'error'); return false; }

      const item = items.find(i => i.id === itemId);
      const unit = item?.default_unit || 'bales';
      const mt = MOVE_TYPES[type];

      if (type === 'transfer_out' && destLocId) {
        // Paired transfer — write both legs
        const transferId = crypto.randomUUID();
        await dbInsert('stock_movements', {
          farm_id: farm.id, item_id: itemId, location_id: locId,
          movement_type: 'transfer_out', qty, unit, occurred_on: date,
          transfer_id: transferId, note: note || null,
        });
        await dbInsert('stock_movements', {
          farm_id: farm.id, item_id: itemId, location_id: destLocId,
          movement_type: 'transfer_in', qty, unit, occurred_on: date,
          transfer_id: transferId, note: note || null,
        });
      } else {
        await dbInsert('stock_movements', {
          farm_id: farm.id,
          item_id: itemId,
          location_id: locId,
          movement_type: type,
          qty,
          unit,
          occurred_on: date,
          note,
          ...(type === 'adjustment' ? { reason_code: 'other', direction: qty >= 0 ? 1 : -1 } : {}),
        });
      }

      toast('Movement recorded', 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  // Wire transfer dest toggle and unit label
  setTimeout(() => {
    const typeEl = document.getElementById('gm-type');
    const destWrap = document.getElementById('gm-transfer-dest');
    const itemEl  = document.getElementById('gm-item');
    const unitLbl = document.getElementById('gm-unit-label');

    typeEl?.addEventListener('change', () => {
      if (destWrap) destWrap.style.display = typeEl.value === 'transfer_out' ? '' : 'none';
    });
    itemEl?.addEventListener('change', () => {
      const it = items.find(i => i.id === itemEl.value);
      if (unitLbl) unitLbl.textContent = it?.default_unit || 'bales';
    });
  }, 50);
}

// ── Add commodity form ─────────────────────────────────────────────────────
async function _showAddItemForm(container, farm, period, allPeriods) {
  openModal({
    title: 'Add grain / hay commodity',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Commodity name <span style="color:var(--red)">*</span></label>
            <input class="form-input" id="ai-name" type="text" placeholder="e.g. Hay, Wheat, Sorghum">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Unit <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="ai-unit">
              <option value="bales">Bales</option>
              <option value="t">Tonnes</option>
              <option value="kg">Kilograms</option>
              <option value="m3">Cubic metres (m³)</option>
            </select>
          </div>
        </div>
        <div id="ai-bale-section" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Bale type</label>
            <select class="form-select" id="ai-bale-type">
              <option value="round">Round</option>
              <option value="square">Square</option>
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Est. kg per bale</label>
            <input class="form-input" id="ai-kg-bale" type="number" min="1" step="1" placeholder="e.g. 500">
            <div style="font-size:11px;color:var(--hint);margin-top:3px">Used to show estimated tonnes</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Notes</label>
          <input class="form-input" id="ai-notes" type="text" placeholder="Optional">
        </div>
      </div>`,
    confirmLabel: 'Add commodity',
    onConfirm: async (modal) => {
      const name    = modal.querySelector('#ai-name')?.value?.trim();
      const unit    = modal.querySelector('#ai-unit')?.value;
      const baleType = modal.querySelector('#ai-bale-type')?.value;
      const kgBale  = parseFloat(modal.querySelector('#ai-kg-bale')?.value) || null;
      const notes   = modal.querySelector('#ai-notes')?.value?.trim() || null;

      if (!name) { toast('Commodity name is required', 'error'); return false; }

      const attrs = {};
      if (unit === 'bales') {
        attrs.bale_type = baleType;
        if (kgBale) attrs.kg_per_bale = kgBale;
      }

      await dbInsert('stock_items', {
        farm_id:      farm.id,
        category:     'grain',
        name,
        subgroup:     name,
        default_unit: unit,
        attributes:   Object.keys(attrs).length ? attrs : null,
        active:       true,
        notes,
      });
      toast(`${name} added`, 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  // Toggle bale section
  setTimeout(() => {
    const unitEl = document.getElementById('ai-unit');
    const baleSection = document.getElementById('ai-bale-section');
    unitEl?.addEventListener('change', () => {
      if (baleSection) baleSection.style.display = unitEl.value === 'bales' ? '' : 'none';
    });
  }, 50);
}
