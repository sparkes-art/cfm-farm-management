// modules/stocktake/grain.js
// Grain & hay stocktake
//
// Data model
// ──────────
// stock_items  (one row per commodity × season × quality grade)
//   subgroup        = "Hay"           — groups items in the UI
//   name            = "Hay 2026"      — displayed label (subgroup + year)
//   attributes = {
//     variety:       "Cavalcade",
//     produced_year: "2026",
//     bale_type:     "round" | "square",
//     kg_per_bale:   500
//   }
//
// stock_movements.source_ref  →  budget row id  (harvest_inload seeded from carry-over budget)
// stock_movements.source_ref  →  invoice id     (sale linked to Outputs invoices)
//
// UI hierarchy:
//   Hay                       ← subgroup header
//     └─ Cavalcade 2026       ← stock_item
//          ├─ Paddock 12      ← location
//          └─ Shed 3

import { dbSelect, dbInsert, dbDelete } from '../../js/supabase-client.js?v=1792733687202';
import { getActiveFarm, canWrite } from '../../js/app-state.js?v=1792733687202';
import { toast, openModal, qs } from '../../js/ui.js?v=1792733687202';

// ── Formatters ────────────────────────────────────────────────────────────
const fN = n => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString();
// Escape a string for use inside an HTML attribute value (data-* etc.)
const escJ = s => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
const fD = n => (n == null || isNaN(n)) ? '—' : n.toFixed(1).replace(/\.0$/, '');

// ── Movement type catalogue ────────────────────────────────────────────────
const MOVE_TYPES = {
  harvest_inload: { label: 'Harvest inload',     dir: 1,  color: 'var(--green)',   icon: '🌾' },
  delivery:       { label: 'Purchase / delivery', dir: 1,  color: 'var(--blue)',    icon: '🚛' },
  transfer_in:    { label: 'Transfer in',         dir: 1,  color: 'var(--blue)',    icon: '→'  },
  transfer_out:   { label: 'Transfer out',        dir: -1, color: 'var(--hint)',    icon: '←'  },
  sale:           { label: 'Sale',                dir: -1, color: 'var(--amber)',   icon: '💰' },
  usage:          { label: 'Fed out',             dir: -1, color: 'var(--ink-mid)', icon: '🐄' },
  write_off:      { label: 'Waste / shrinkage',   dir: -1, color: 'var(--red)',     icon: '⚠'  },
  adjustment:     { label: 'Adjustment',          dir: 0,  color: 'var(--hint)',    icon: '±'  },
};

// ── Entry point ────────────────────────────────────────────────────────────
export async function mountGrain(container, initialPeriod) {
  const farm = getActiveFarm();
  container.innerHTML = `<div style="padding:20px 24px;max-width:1200px;margin:0 auto" id="gr-wrap">
    <div style="padding:40px;text-align:center;color:var(--hint)">Loading grain & hay…</div>
  </div>`;

  const allPeriods = await dbSelect('stock_periods',
    `farm_id=eq.${farm.id}&order=period_start.asc`);
  const defaultPeriod = initialPeriod
    || allPeriods.find(p => p.status === 'open')
    || allPeriods[allPeriods.length - 1]
    || null;

  await _render(container, farm, defaultPeriod, allPeriods);
}

// ── Main render ────────────────────────────────────────────────────────────
async function _render(container, farm, period, allPeriods = []) {
  const wrap = qs('#gr-wrap', container);

  const [items, locations, movements, periodInvoices] = await Promise.all([
    dbSelect('stock_items',
      `farm_id=eq.${farm.id}&category=eq.grain&active=eq.true&order=subgroup,name`),
    dbSelect('stock_locations',
      `farm_id=eq.${farm.id}&active=eq.true&order=route_order,name`),
    dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&select=id,item_id,location_id,movement_type,signed_qty,qty,unit,occurred_on,note,source_ref,source_system,reason_code&order=occurred_on.desc`),
    // Crop/grain/hay sale invoices in this period (not livestock)
    period ? dbSelect('invoices',
      `farm_id=eq.${farm.id}&master_unit=neq.head&invoice_date=gte.${period.period_start}&invoice_date=lte.${period.period_end}&select=id,buyer,invoice_date,total_qty,master_unit,gross_amount,line_items`
    ) : Promise.resolve([]),
  ]);

  const itemIds = new Set(items.map(i => i.id));
  const grainMovements = movements.filter(m => itemIds.has(m.item_id));
  const locById = Object.fromEntries(locations.map(l => [l.id, l]));

  // ── Period timeline ────────────────────────────────────────────────────
  const timelineHtml = allPeriods.length > 1 ? `
    <div style="display:flex;align-items:center;gap:2px;overflow-x:auto;padding-bottom:12px;margin-bottom:16px;border-bottom:1px solid var(--border-light)">
      ${allPeriods.map(p => {
        const isActive = period && p.id === period.id;
        const label = new Date(p.period_start).toLocaleDateString('en-AU', {month:'short', year:'2-digit'});
        const dot = p.status === 'locked' ? '🔒' : p.status === 'review' ? '🔶' : '●';
        const dotColor = p.status === 'locked' ? 'var(--hint)' : p.status === 'review' ? 'var(--amber)' : 'var(--green)';
        return `<button class="gr-period-btn" data-period-id="${p.id}"
          style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 14px;border:none;border-radius:8px;cursor:pointer;background:${isActive ? 'var(--blue)' : 'transparent'}">
          <span style="font-size:11px;font-weight:${isActive ? 700 : 500};color:${isActive ? 'white' : 'var(--ink-mid)'}">${label}</span>
          <span style="font-size:9px;color:${isActive ? 'rgba(255,255,255,.7)' : dotColor}">${dot} ${p.status}</span>
        </button>`;
      }).join('')}
    </div>` : '';

  // ── Header ─────────────────────────────────────────────────────────────
  const periodLabel = period
    ? new Date(period.period_start).toLocaleDateString('en-AU', {month:'long', year:'numeric'})
    : 'All time';

  const headerHtml = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <div>
        <h2 style="font-size:18px;font-weight:700;color:var(--ink)">Grain & Hay</h2>
        <p style="font-size:13px;color:var(--hint);margin-top:4px">${farm.name} · ${periodLabel}</p>
      </div>
      ${canWrite() ? `<button class="btn btn-secondary btn-sm" id="gr-add-item" style="white-space:nowrap">+ Add commodity / season</button>` : ''}
    </div>`;

  // ── Empty state ────────────────────────────────────────────────────────
  if (!items.length) {
    wrap.innerHTML = timelineHtml + headerHtml + `
      <div style="padding:40px;text-align:center;color:var(--hint);background:white;border-radius:10px;border:1px solid var(--border)">
        <div style="font-size:32px;margin-bottom:12px">🌾</div>
        <p style="font-size:15px;font-weight:500;color:var(--ink);margin-bottom:6px">No grain or hay commodities set up</p>
        <p style="font-size:13px;margin-bottom:16px">Add a commodity and season to start tracking stock on hand.</p>
        ${canWrite() ? `<button class="btn btn-primary" id="gr-add-item-empty">+ Add commodity / season</button>` : ''}
      </div>`;
    _wireButtons(container, wrap, farm, items, locations, period, allPeriods);
    return;
  }

  // ── Balances ───────────────────────────────────────────────────────────
  const periodStart = period?.period_start;
  const periodEnd   = period?.period_end;

  const bKey = (itemId, locId) => `${itemId}||${locId || 'none'}`;

  const openingMap = {};
  grainMovements
    .filter(m => !periodStart || m.occurred_on < periodStart)
    .forEach(m => {
      const k = bKey(m.item_id, m.location_id);
      openingMap[k] = (openingMap[k] || 0) + (parseFloat(m.signed_qty) || 0);
    });

  const periodMoves = periodStart
    ? grainMovements.filter(m => m.occurred_on >= periodStart && m.occurred_on <= periodEnd)
    : grainMovements;

  const closingMap = { ...openingMap };
  periodMoves.forEach(m => {
    const k = bKey(m.item_id, m.location_id);
    closingMap[k] = (closingMap[k] || 0) + (parseFloat(m.signed_qty) || 0);
  });

  // ── Budget carry-over openings ─────────────────────────────────────────
  const budgetOpen = await _getBudgetOpenings(farm, period);

  // ── Group items by subgroup → season ──────────────────────────────────
  // Season label from produced_year: "2026" → "2025/26" (harvested in
  // the second calendar year of the season). Falls back to item name.
  const seasonLabel = item => {
    const yr = item.attributes?.produced_year;
    if (!yr) return null; // no season label — won't show sub-header
    const y = parseInt(yr, 10);
    if (isNaN(y)) return String(yr);
    return `${y - 1}/${String(y).slice(-2)}`;
  };
  const seasonSortKey = item => {
    const yr = item.attributes?.produced_year;
    return yr ? parseInt(yr, 10) : 9999;
  };

  const subgroups = {};
  items.forEach(item => {
    const sg = item.subgroup || item.name;
    if (!subgroups[sg]) subgroups[sg] = [];
    subgroups[sg].push(item);
  });
  // Sort items within each subgroup by season (oldest first)
  Object.values(subgroups).forEach(arr =>
    arr.sort((a, b) => seasonSortKey(a) - seasonSortKey(b))
  );

  // ── Format helpers ─────────────────────────────────────────────────────
  // fN / fD are module-level helpers

  // ── Build subgroup sections ────────────────────────────────────────────
  const subgroupHtml = Object.entries(subgroups).map(([sgName, sgItems]) => {

    // Group by season — show season sub-headers when there are multiple seasons
    const bySeasonMap = new Map(); // seasonLabel string | null → items[]
    sgItems.forEach(item => {
      const sl = seasonLabel(item);
      if (!bySeasonMap.has(sl)) bySeasonMap.set(sl, []);
      bySeasonMap.get(sl).push(item);
    });
    const multiSeason = bySeasonMap.size > 1;

    const renderItemCard = item => {
      const attrs = item.attributes || {};
      const unit  = item.default_unit || 'bales';
      const kgPerBale = attrs.kg_per_bale || null;

      // Metadata chips
      const chips = [
        attrs.variety       ? `<span class="gr-chip">${attrs.variety}</span>` : '',
        attrs.produced_year ? `<span class="gr-chip">${attrs.produced_year}</span>` : '',
        attrs.bale_type     ? `<span class="gr-chip">${attrs.bale_type} bales</span>` : '',
        kgPerBale           ? `<span class="gr-chip">${kgPerBale} kg/bale</span>` : '',
      ].filter(Boolean).join('');

      // All location keys for this item
      const allKeys = [...new Set([
        ...Object.keys(openingMap).filter(k => k.startsWith(item.id + '||')),
        ...Object.keys(closingMap).filter(k => k.startsWith(item.id + '||')),
      ])];

      const totalClosing = allKeys.reduce((s, k) => s + (closingMap[k] || 0), 0);
      const totalTonnes  = kgPerBale && totalClosing ? ` · ${fD(totalClosing * kgPerBale / 1000)} t` : '';

      const hasAnyMovement = grainMovements.some(m => m.item_id === item.id);
      const budgetRow = budgetOpen.find(b =>
        b.commodity.toUpperCase() === (attrs.variety || item.name).toUpperCase() ||
        b.commodity.toUpperCase() === item.name.toUpperCase() ||
        b.commodity.toUpperCase() === sgName.toUpperCase()
      );
      const showSeedBtn = !hasAnyMovement && budgetRow && canWrite();

      // Location rows
      const locRows = allKeys.length ? allKeys.map(k => {
        const locId   = k.split('||')[1];
        const locName = locId === 'none' ? '— unassigned' : (locById[locId]?.name || locId);
        const opening = openingMap[k] || 0;
        const closing = closingMap[k] || 0;
        const pIn  = periodMoves
          .filter(m => m.item_id === item.id && (m.location_id || 'none') === locId && (parseFloat(m.signed_qty)||0) > 0)
          .reduce((s, m) => s + (parseFloat(m.signed_qty)||0), 0);
        const outMoves = periodMoves
          .filter(m => m.item_id === item.id && (m.location_id || 'none') === locId && (parseFloat(m.signed_qty)||0) < 0);
        const pOut = outMoves.reduce((s, m) => s + (parseFloat(m.signed_qty)||0), 0);
        const outMovesJson = JSON.stringify(outMoves.map(m => ({
          id: m.id, movement_type: m.movement_type, occurred_on: m.occurred_on,
          signed_qty: m.signed_qty, qty: m.qty, unit: m.unit,
          note: m.note, source_system: m.source_system, source_ref: m.source_ref,
        })));
        const closingTonnes = kgPerBale && closing
          ? `<span style="font-size:10px;color:var(--hint);margin-left:4px">${fD(closing * kgPerBale / 1000)} t</span>`
          : '';

        return `<tr style="border-bottom:1px solid var(--border-light)">
          <td style="padding:9px 14px 9px 20px;font-size:13px;color:var(--ink)">${locName}</td>
          <td style="padding:9px 14px;text-align:center;font-size:13px;color:var(--hint)">${opening ? fN(opening) : '—'}</td>
          <td style="padding:9px 14px;text-align:center;font-size:13px;color:var(--green)">${pIn ? '+'+fN(pIn) : '—'}</td>
          <td style="padding:9px 14px;text-align:center;font-size:13px;color:var(--red)">
            ${pOut
              ? `<button class="gr-out-link" style="background:none;border:none;padding:0;font-size:13px;color:var(--red);cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px"
                  data-item-id="${item.id}" data-item-name="${escJ(item.name)}"
                  data-loc-id="${locId}" data-loc-name="${escJ(locName)}"
                  data-out-moves="${escJ(outMovesJson)}">${fN(pOut)}</button>`
              : '—'}
          </td>
          <td style="padding:9px 14px;text-align:center">
            <span style="font-weight:700;color:var(--ink)">${fN(closing)}</span>${closingTonnes}
          </td>
          <td style="padding:9px 14px;text-align:right">
            ${canWrite() ? `<button class="btn btn-ghost btn-sm gr-add-move" style="font-size:11px"
              data-item-id="${item.id}" data-item-name="${item.name}"
              data-loc-id="${locId === 'none' ? '' : locId}"
              data-loc-name="${locName}">+ Movement</button>` : ''}
          </td>
        </tr>`;
      }).join('') : `<tr><td colspan="6" style="padding:16px 20px;font-size:13px;color:var(--hint)">
        No movements yet.
        ${canWrite() ? `<button class="btn btn-ghost btn-sm gr-add-move" style="margin-left:6px;font-size:11px"
          data-item-id="${item.id}" data-item-name="${item.name}">+ Add first movement</button>` : ''}
      </td></tr>`;

      return `
        <!-- Item: ${item.name} -->
        <div style="margin-bottom:12px">
          <!-- Item header bar -->
          <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:var(--page-bg);border:1px solid var(--border);border-bottom:none;border-radius:8px 8px 0 0;flex-wrap:wrap;gap:6px">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span style="font-size:13px;font-weight:600;color:var(--ink)">${item.name}</span>
              ${chips}
              <span style="font-size:12px;color:var(--hint)">${fN(totalClosing)} ${unit} on hand${totalTonnes}</span>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${showSeedBtn ? `<button class="btn btn-sm gr-seed-opening" style="font-size:11px;background:#f59e0b;color:white;border:none"
                data-item-id="${item.id}" data-item-name="${item.name}"
                data-qty="${budgetRow.qty}" data-unit="${unit}"
                data-budget-id="${budgetRow.id || ''}">
                ⤵ Seed opening (${fN(budgetRow.qty)} ${unit} from budget)</button>` : ''}
              ${canWrite() ? `<button class="btn btn-ghost btn-sm gr-add-move" style="font-size:11px"
                data-item-id="${item.id}" data-item-name="${item.name}">+ Movement</button>` : ''}
            </div>
          </div>
          <!-- Location table -->
          <div style="border:1px solid var(--border);border-radius:0 0 8px 8px;overflow:hidden">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr style="background:#f8f9fa;border-bottom:1px solid var(--border)">
                  <th style="padding:6px 14px 6px 20px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Location</th>
                  <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:center">Opening</th>
                  <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--green);text-align:center">In</th>
                  <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--red);text-align:center">Out</th>
                  <th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:center">Closing</th>
                  <th style="width:130px"></th>
                </tr>
              </thead>
              <tbody>${locRows}</tbody>
            </table>
          </div>
        </div>`;
    }; // end renderItemCard

    // ── Season grouping ────────────────────────────────────────────────────
    // When multiple seasons exist, wrap each group in a season sub-header.
    // Season closing = sum of all items in that season group.
    const itemCards = multiSeason
      ? [...bySeasonMap.entries()].map(([sl, seasonItems]) => {
          const slLabel = sl ? `${sgName} ${sl}` : sgName;
          const seasonClosing = seasonItems.reduce((sum, item) => {
            const ks = Object.keys(closingMap).filter(k => k.startsWith(item.id + '||'));
            return sum + ks.reduce((s, k) => s + (closingMap[k] || 0), 0);
          }, 0);
          const sUnit    = seasonItems[0]?.default_unit || 'bales';
          const sKgBale  = seasonItems[0]?.attributes?.kg_per_bale || null;
          const sTonnes  = sKgBale && seasonClosing ? ` · ${fD(seasonClosing * sKgBale / 1000)} t` : '';
          return `
            <div style="margin-bottom:16px">
              <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 12px;background:#2d3f55;border-radius:6px;margin-bottom:6px">
                <span style="font-size:13px;font-weight:600;color:white">${slLabel}</span>
                <span style="font-size:11px;color:rgba(255,255,255,.65)">${fN(seasonClosing)} ${sUnit} on hand${sTonnes}</span>
              </div>
              ${seasonItems.map(renderItemCard).join('')}
            </div>`;
        }).join('')
      : sgItems.map(renderItemCard).join('');

    // Subgroup total
    const sgClosing = sgItems.reduce((sum, item) => {
      const allKeys = Object.keys(closingMap).filter(k => k.startsWith(item.id + '||'));
      return sum + allKeys.reduce((s, k) => s + (closingMap[k] || 0), 0);
    }, 0);
    const sgUnit = sgItems[0]?.default_unit || 'bales';
    const sgKgBale = sgItems[0]?.attributes?.kg_per_bale || null;
    const sgTonnes = sgKgBale && sgClosing ? ` · ${fD(sgClosing * sgKgBale / 1000)} t` : '';

    return `
      <!-- Subgroup: ${sgName} -->
      <div style="margin-bottom:24px">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#1a2535;border-radius:8px;margin-bottom:8px">
          <span style="font-size:14px;font-weight:700;color:white">${sgName}</span>
          <span style="font-size:12px;color:rgba(255,255,255,.6)">${fN(sgClosing)} ${sgUnit} total${sgTonnes}</span>
        </div>
        ${itemCards}
      </div>`;
  }).join('');

  // ── Sales panel (invoices → stock movements, livestock-style) ─────────────
  const salesPanelHtml = _buildSalesPanel(periodInvoices, items, movements);

  // ── Period movements log ───────────────────────────────────────────────
  const logRows = periodMoves.slice(0, 30).map(m => {
    const item  = items.find(i => i.id === m.item_id);
    const mt    = MOVE_TYPES[m.movement_type] || { label: m.movement_type, color: 'var(--hint)', icon: '·' };
    const qty   = parseFloat(m.signed_qty) || 0;
    const locName = m.location_id ? (locById[m.location_id]?.name || m.location_id) : '—';
    const kgPerBale = item?.attributes?.kg_per_bale;
    const tonnesStr = kgPerBale ? ` (${fD(Math.abs(qty) * kgPerBale / 1000)} t)` : '';
    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:8px 14px;color:var(--hint)">${m.occurred_on}</td>
      <td style="padding:8px 14px;font-weight:500;color:var(--ink)">${item?.name || '—'}</td>
      <td style="padding:8px 14px;color:${mt.color}">${mt.icon} ${mt.label}</td>
      <td style="padding:8px 14px;color:var(--hint);font-size:11px">${locName}</td>
      <td style="padding:8px 14px;text-align:right;font-weight:600;color:${qty>0?'var(--green)':'var(--red)'}">
        ${qty > 0 ? '+' : ''}${fN(qty)} ${item?.default_unit || ''}${tonnesStr}
      </td>
      <td style="padding:8px 14px;color:var(--hint)">${m.note || (m.source_ref ? `ref: ${m.source_ref}` : '')}</td>
    </tr>`;
  }).join('');

  // ── Budget carry-over banner ───────────────────────────────────────────
  const seedable = budgetOpen.filter(b => {
    const item = items.find(i =>
      i.name.toUpperCase() === b.commodity.toUpperCase() ||
      (i.subgroup || '').toUpperCase() === b.commodity.toUpperCase() ||
      (i.attributes?.variety || '').toUpperCase() === b.commodity.toUpperCase()
    );
    return item && !grainMovements.some(m => m.item_id === item.id);
  });
  const seedBannerHtml = seedable.length ? `
    <div style="background:#fffbeb;border:2px solid #f59e0b;border-radius:10px;padding:14px 18px;margin-bottom:16px">
      <div style="font-size:13px;font-weight:600;color:#92400e">⤵ Budget carry-over opening available</div>
      <div style="font-size:12px;color:#92400e;margin-top:4px">
        ${seedable.map(b => `${b.commodity}: ${Math.round(b.qty).toLocaleString()} bales`).join(' · ')}
        — click "Seed opening" on the matching commodity to set its opening balance from the budget
      </div>
    </div>` : '';

  wrap.innerHTML = timelineHtml + salesPanelHtml + seedBannerHtml + headerHtml + subgroupHtml + (periodMoves.length ? `
    <div class="card" style="margin-top:16px;overflow:hidden">
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--page-bg)">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">Period movements</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
            ${['Date','Commodity','Type','Location','Qty','Note'].map(h =>
              `<th style="padding:6px 14px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:${h==='Qty'?'right':'left'}">${h}</th>`
            ).join('')}
          </tr>
        </thead>
        <tbody>${logRows}</tbody>
      </table>
    </div>` : '');

  // ── Wire chips CSS (injected once) ─────────────────────────────────────
  if (!document.getElementById('gr-chip-style')) {
    const s = document.createElement('style');
    s.id = 'gr-chip-style';
    s.textContent = `.gr-chip{display:inline-block;font-size:10px;padding:2px 7px;border-radius:10px;background:var(--border-light,#e8ecf0);color:var(--hint);margin-right:3px}`;
    document.head.appendChild(s);
  }

  _wireButtons(container, wrap, farm, items, locations, period, allPeriods);
}

// ── Wire all event listeners ───────────────────────────────────────────────
function _wireButtons(container, wrap, farm, items, locations, period, allPeriods) {
  wrap.querySelectorAll('.gr-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = allPeriods.find(x => x.id === btn.dataset.periodId);
      if (p) _render(container, farm, p, allPeriods);
    });
  });

  wrap.querySelector('#gr-add-item')?.addEventListener('click',
    () => _showAddItemForm(container, farm, items, period, allPeriods));
  wrap.querySelector('#gr-add-item-empty')?.addEventListener('click',
    () => _showAddItemForm(container, farm, items, period, allPeriods));

  wrap.querySelectorAll('.gr-add-move').forEach(btn => {
    btn.addEventListener('click', () =>
      _showMovementForm(container, farm, items, locations,
        btn.dataset.itemId, btn.dataset.itemName,
        btn.dataset.locId || null, period, allPeriods));
  });

  wrap.querySelectorAll('.gr-seed-opening').forEach(btn => {
    btn.addEventListener('click', () =>
      _seedOpeningFromBudget(container, farm,
        btn.dataset.itemId, btn.dataset.itemName,
        parseFloat(btn.dataset.qty), btn.dataset.unit,
        btn.dataset.budgetId || null, period, allPeriods));
  });

  // Allocate all invoices in a commodity group
  wrap.querySelectorAll('.gr-alloc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key    = btn.dataset.commodityKey;
      const sel    = wrap.querySelector(`.gr-alloc-item[data-commodity-key="${key}"]`);
      const itemId = sel?.value;
      if (!itemId) { toast('Select a stock item first', 'error'); return; }
      const item   = items.find(i => i.id === itemId);
      const invIds = JSON.parse(btn.dataset.invoiceIds || '[]');

      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        // Find detail rows for this commodity group; deduplicate by invoice ID
        const detailRows = wrap.querySelectorAll(`.gr-inv-detail[data-commodity-key="${key}"]`);
        const seen = new Set();
        for (const row of detailRows) {
          const { invoiceId, qty, unit, date, buyer } = row.dataset;
          if (seen.has(invoiceId)) continue; // multi-commodity invoice already inserted
          seen.add(invoiceId);
          await dbInsert('stock_movements', {
            farm_id:       farm.id,
            item_id:       itemId,
            location_id:   null,
            movement_type: 'sale',
            qty:           parseFloat(qty),
            unit:          item?.default_unit || unit || 'bales',
            occurred_on:   date,
            note:          `Sale to ${buyer || 'buyer'} — from invoice`,
            source_system: 'invoices',
            source_ref:    invoiceId,
          });
        }
        toast(`${seen.size} sale${seen.size !== 1 ? 's' : ''} allocated`, 'success');
        await _render(container, farm, period, allPeriods);
      } catch(e) {
        toast('Failed: ' + e.message, 'error');
        btn.disabled = false; btn.textContent = 'Allocate All →';
      }
    });
  });

  // Enable/disable allocate button based on item select
  wrap.querySelectorAll('.gr-alloc-item').forEach(sel => {
    const btn = wrap.querySelector(`.gr-alloc-btn[data-commodity-key="${sel.dataset.commodityKey}"]`);
    if (!btn) return;
    const update = () => {
      btn.style.opacity = sel.value ? '1' : '.4';
      btn.style.pointerEvents = sel.value ? 'auto' : 'none';
    };
    sel.addEventListener('change', update);
    update();
  });

  // Re-allocate (edit) button
  wrap.querySelectorAll('.gr-realloc-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      _reallocateSale(container, farm, items, btn.dataset, period, allPeriods));
  });

  // Out quantity → show movement detail modal
  wrap.querySelectorAll('.gr-out-link').forEach(btn => {
    btn.addEventListener('click', () => {
      const outMoves = JSON.parse(btn.dataset.outMoves || '[]');
      _showOutMovementsModal(outMoves, btn.dataset.itemName, btn.dataset.locName, items);
    });
  });
}

// ── Fetch budget carry-over openings ──────────────────────────────────────
async function _getBudgetOpenings(farm, period) {
  if (!period) return [];
  try {
    const rows = await dbSelect('budgets',
      `farm_id=eq.${farm.id}&section=eq.carry_over&select=id,commodity,budgeted_yield_per_ha,notes`);
    return rows
      .filter(r => r.budgeted_yield_per_ha != null && r.budgeted_yield_per_ha > 0)
      .map(r => ({ id: r.id, commodity: r.commodity, qty: r.budgeted_yield_per_ha }));
  } catch { return []; }
}

// ── Sales panel — invoice lines → stock movements (grouped by commodity) ─────
function _buildSalesPanel(invoices, items, movements) {
  // Map already-allocated invoice IDs to their movement
  const allocatedByRef = {};
  movements.filter(m => m.source_system === 'invoices' && m.source_ref)
    .forEach(m => { allocatedByRef[m.source_ref] = m; });

  const pending  = [];
  const allocated = [];
  invoices.forEach(inv => {
    const qty = parseFloat(inv.total_qty) || 0;
    if (!qty) return;
    const movement = allocatedByRef[inv.id] || null;
    if (movement) allocated.push({ inv, movement });
    else          pending.push(inv);
  });

  if (!pending.length && !allocated.length) return '';

  const fmtAud = n => n != null ? '$' + parseFloat(n).toLocaleString('en-AU',{maximumFractionDigits:0}) : '';

  // Auto-match commodity label → stock item
  const autoMatch = (commodity) => {
    if (!commodity) return null;
    const ct = commodity.toLowerCase();
    return items.find(i =>
      ct.includes((i.subgroup||i.name).toLowerCase()) ||
      (i.subgroup||i.name).toLowerCase().includes(ct)
    ) || null;
  };

  const itemOpts = (preId) => items.map(i =>
    `<option value="${i.id}"${i.id === preId ? ' selected' : ''}>${i.name}</option>`
  ).join('');

  // ── Group pending by individual commodity (from line_items) ──
  // Each line_item entry has: commodity, qty, gross, unit
  // An invoice with lines [{commodity:'Cavalcade',qty:200},{commodity:'Jarrah',qty:88}]
  // contributes to TWO groups, not one combined "Cavalcade, Jarrah" group.
  // The movement uses total_qty/master_unit from the invoice (one movement per invoice).
  const pendingGroups = {}; // commodity → { invs: [{inv, lineQty, lineGross}], unit }
  pending.forEach(inv => {
    const saleLines = (inv.line_items || []).filter(l => l.line_type === 'sale' || !l.line_type);
    const unit = inv.master_unit || 'bales';
    if (saleLines.length === 0) {
      // No line_items — fall back to invoice-level total
      const key = '(unknown commodity)';
      if (!pendingGroups[key]) pendingGroups[key] = { invs: [], unit };
      pendingGroups[key].invs.push({ inv, lineQty: parseFloat(inv.total_qty)||0, lineGross: parseFloat(inv.gross_amount)||0 });
      return;
    }
    // When all lines are the same commodity, use total_qty for accuracy
    const uniqueComms = [...new Set(saleLines.map(l => l.commodity).filter(Boolean))];
    if (uniqueComms.length === 1) {
      const key = uniqueComms[0];
      if (!pendingGroups[key]) pendingGroups[key] = { invs: [], unit };
      pendingGroups[key].invs.push({ inv, lineQty: parseFloat(inv.total_qty)||0, lineGross: parseFloat(inv.gross_amount)||0 });
    } else {
      // Multi-commodity invoice — split by line, apportion gross proportionally
      const totalLineQty = saleLines.reduce((s, l) => s + (parseFloat(l.qty)||0), 0);
      const totalInvGross = parseFloat(inv.gross_amount) || 0;
      saleLines.forEach(l => {
        const comm = l.commodity || '(unknown commodity)';
        const lQty = parseFloat(l.qty) || 0;
        const lGross = totalLineQty ? totalInvGross * (lQty / totalLineQty) : (parseFloat(l.gross)||0);
        if (!pendingGroups[comm]) pendingGroups[comm] = { invs: [], unit };
        // Store a synthetic entry: same invoice but only this line's qty/gross
        pendingGroups[comm].invs.push({ inv, lineQty: lQty, lineGross: lGross, lineOnly: true });
      });
    }
  });

  const pendingGroupHtml = Object.entries(pendingGroups).map(([key, { invs: grpInvs, unit }]) => {
    const totalQty = grpInvs.reduce((s, e) => s + e.lineQty, 0);
    const totalVal = grpInvs.reduce((s, e) => s + e.lineGross, 0);
    const matched  = autoMatch(key);
    const uid      = key.replace(/[^a-z0-9]/gi, '_');

    // Deduplicate invoices for display (multi-commodity invoices appear in multiple groups)
    const seenInvIds = new Set();
    const detailRows = grpInvs.map(({ inv, lineQty, lineGross }) => {
      const buyer = (inv.buyer || '—').replace(/"/g, '&quot;');
      return `<div class="gr-inv-detail" data-commodity-key="${uid}"
        data-invoice-id="${inv.id}" data-qty="${parseFloat(inv.total_qty)||lineQty}" data-unit="${unit}"
        data-date="${inv.invoice_date}" data-buyer="${buyer}"
        style="display:grid;grid-template-columns:90px 1fr 80px 80px;gap:8px;
        padding:7px 14px 7px 32px;border-bottom:1px solid var(--border-light);
        align-items:center;font-size:11px;color:var(--hint);background:#fafafa">
        <div>${inv.invoice_date}</div>
        <div>${buyer}</div>
        <div>${fN(lineQty)} ${unit}</div>
        <div>${lineGross ? fmtAud(lineGross) : ''}</div>
      </div>`;
    }).join('');

    const invCount = grpInvs.length;
    return `
      <div style="border-bottom:1px solid var(--border-light)">
        <div style="display:grid;grid-template-columns:1fr 110px 90px 1fr 130px;
          gap:8px;padding:10px 14px;align-items:center;font-size:12px">
          <div>
            <span style="font-weight:600;color:var(--ink)">${key}</span>
            <button onclick="var d=this.closest('div').nextElementSibling;d.style.display=d.style.display==='none'?'block':'none';this.textContent=d.style.display==='none'?'▸ ${invCount} invoice${invCount!==1?'s':''}':'▾ ${invCount} invoice${invCount!==1?'s':''}';"
              style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--hint);margin-left:8px;padding:0">
              ▸ ${invCount} invoice${invCount!==1?'s':''}
            </button>
          </div>
          <div style="font-weight:600;color:var(--ink)">${fN(totalQty)} ${unit}</div>
          <div style="color:var(--hint)">${totalVal ? fmtAud(totalVal) : ''}</div>
          <div>
            <select class="form-select gr-alloc-item" data-commodity-key="${uid}"
              style="font-size:11px">
              <option value="">Select stock item…</option>${itemOpts(matched?.id||'')}
            </select>
          </div>
          <div>
            <button class="btn btn-sm btn-primary gr-alloc-btn"
              data-commodity-key="${uid}"
              style="font-size:11px;opacity:.4;pointer-events:none;width:100%">
              Allocate All →
            </button>
          </div>
        </div>
        <div style="display:none">${detailRows}</div>
      </div>`;
  }).join('');

  const totalPendingInvoices = pending.length; // unique invoice count
  const pendingCard = pending.length ? [
    `<div class="card" style="margin-bottom:12px;overflow:hidden;border:2px solid var(--amber)">`,
    `<div style="padding:10px 14px;border-bottom:1px solid var(--border);background:#fffbeb;`,
    `display:flex;align-items:center;justify-content:space-between">`,
    `<span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:#92400e">`,
    `⚡ ${totalPendingInvoices} sale invoice${totalPendingInvoices!==1?'s':''} awaiting allocation — ${Object.keys(pendingGroups).length} commodity group${Object.keys(pendingGroups).length!==1?'s':''}</span>`,
    `<span style="font-size:11px;color:#92400e">Select stock item then Allocate All →</span>`,
    `</div>`,
    `<div style="display:grid;grid-template-columns:1fr 110px 90px 1fr 130px;gap:8px;padding:6px 14px;`,
    `background:#fafafa;border-bottom:1px solid var(--border-light)">`,
    `${['Commodity','Total Qty','Value','Stock Item',''].map(h =>
      `<div style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">${h}</div>`
    ).join('')}`,
    `</div>`,
    pendingGroupHtml,
    `</div>`,
  ].join('') : '';

  // ── Group allocated by commodity + stock item ──
  const allocGroups = {};
  allocated.forEach(({ inv, movement }) => {
    const item = items.find(i => i.id === movement.item_id);
    const key  = item?.name || movement.item_id;
    if (!allocGroups[key]) allocGroups[key] = { item, invs: [] };
    allocGroups[key].invs.push({ inv, movement });
  });

  const archiveGroupHtml = Object.entries(allocGroups).map(([key, { item, invs: aInvs }]) => {
    const totalQty = aInvs.reduce((s, { inv }) => s + (parseFloat(inv.total_qty)||0), 0);
    const totalVal = aInvs.reduce((s, { inv }) => s + (parseFloat(inv.gross_amount)||0), 0);
    const unit     = aInvs[0].inv.master_unit || 'bales';

    const detailRows = aInvs.map(({ inv, movement }) => {
      const buyer = (inv.buyer || '—').replace(/"/g, '&quot;');
      const qty   = parseFloat(inv.total_qty) || 0;
      return `<div style="display:grid;grid-template-columns:90px 1fr 80px 70px 100px;gap:8px;
        padding:7px 14px 7px 32px;border-bottom:1px solid var(--border-light);
        align-items:center;font-size:11px;color:var(--hint);background:#fafafa">
        <div>${inv.invoice_date}</div>
        <div>${buyer}</div>
        <div>${fN(qty)} ${inv.master_unit||unit}</div>
        <div>${inv.gross_amount ? fmtAud(inv.gross_amount) : ''}</div>
        <div><button class="btn btn-ghost btn-sm gr-realloc-btn"
          data-movement-id="${movement.id}" data-invoice-id="${inv.id}"
          data-qty="${qty}" data-unit="${inv.master_unit||unit}"
          data-date="${inv.invoice_date}" data-buyer="${buyer}"
          style="font-size:10px;color:var(--amber);padding:2px 6px">✎ Edit</button></div>
      </div>`;
    }).join('');

    return `
      <div style="border-bottom:1px solid var(--border-light)">
        <div style="display:grid;grid-template-columns:1fr 110px 90px;
          gap:8px;padding:10px 14px;align-items:center;font-size:12px">
          <div>
            <span style="font-weight:600;color:var(--ink)">${key}</span>
            <button onclick="var d=this.closest('[style]').nextElementSibling;d.style.display=d.style.display==='none'?'block':'none';this.textContent=d.style.display==='none'?'▸ ${aInvs.length} invoice${aInvs.length!==1?'s':''}':'▾ ${aInvs.length} invoice${aInvs.length!==1?'s':''}';"
              style="background:none;border:none;cursor:pointer;font-size:10px;color:var(--hint);margin-left:8px;padding:0">
              ▸ ${aInvs.length} invoice${aInvs.length!==1?'s':''}
            </button>
          </div>
          <div style="font-weight:600">${fN(totalQty)} ${unit}</div>
          <div style="color:var(--hint)">${totalVal ? fmtAud(totalVal) : ''}</div>
        </div>
        <div style="display:none">${detailRows}</div>
      </div>`;
  }).join('');

  const archiveCard = allocated.length ? [
    `<div class="card" style="margin-bottom:12px;overflow:hidden">`,
    `<div style="padding:10px 14px;border-bottom:1px solid var(--border);background:var(--page-bg);`,
    `display:flex;align-items:center;justify-content:space-between;cursor:pointer"`,
    ` onclick="var b=this.nextElementSibling;b.style.display=b.style.display==='none'?'':'none'">`,
    `<span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint)">`,
    `✓ ${allocated.length} allocated sale${allocated.length!==1?'s':''} — ${Object.keys(allocGroups).length} commodity group${Object.keys(allocGroups).length!==1?'s':''}</span>`,
    `<span style="font-size:11px;color:var(--hint)">▾ show/hide</span>`,
    `</div>`,
    `<div style="display:none">`,
    archiveGroupHtml,
    `</div>`,
    `</div>`,
  ].join('') : '';

  return pendingCard + archiveCard;
}

// ── Show out movements detail modal ───────────────────────────────────────
function _showOutMovementsModal(outMoves, itemName, locName, items) {
  const MOVE_LABEL = {
    sale: 'Sale', transfer_out: 'Transfer out', usage: 'Usage',
    adjustment: 'Adjustment', harvest_inload: 'Inload',
  };
  const fmtDate = d => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' }) : '—';

  const rows = outMoves.map(m => {
    const qty   = Math.abs(parseFloat(m.signed_qty) || 0);
    const unit  = m.unit || '';
    const type  = MOVE_LABEL[m.movement_type] || m.movement_type || '—';
    const note  = m.note || '—';
    return `<tr style="border-bottom:1px solid var(--border-light)">
      <td style="padding:8px 12px;font-size:13px;white-space:nowrap">${fmtDate(m.occurred_on)}</td>
      <td style="padding:8px 12px;font-size:13px">${type}</td>
      <td style="padding:8px 12px;font-size:13px;text-align:right;color:var(--red)">${fN(qty)} ${unit}</td>
      <td style="padding:8px 12px;font-size:13px;color:var(--hint);max-width:240px">${note}</td>
    </tr>`;
  }).join('');

  const locLabel = locName && locName !== '— unassigned' ? ` · ${locName}` : '';
  const total = outMoves.reduce((s, m) => s + Math.abs(parseFloat(m.signed_qty)||0), 0);
  const unit  = outMoves[0]?.unit || '';

  openModal(`
    <div style="padding:24px;min-width:480px;max-width:680px">
      <h3 style="margin:0 0 4px;font-size:16px;font-weight:700;color:var(--ink)">Out movements</h3>
      <p style="margin:0 0 16px;font-size:13px;color:var(--hint)">${itemName}${locLabel}</p>
      ${outMoves.length ? `
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-family:inherit">
            <thead>
              <tr style="background:var(--page-bg);border-bottom:2px solid var(--border)">
                <th style="padding:6px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Date</th>
                <th style="padding:6px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Type</th>
                <th style="padding:6px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:right">Qty</th>
                <th style="padding:6px 12px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Note</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
              <tr style="background:var(--page-bg)">
                <td colspan="2" style="padding:8px 12px;font-size:13px;font-weight:600;color:var(--ink)">Total</td>
                <td style="padding:8px 12px;font-size:13px;font-weight:700;text-align:right;color:var(--red)">${fN(total)} ${unit}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      ` : '<p style="font-size:13px;color:var(--hint)">No out movements in this period.</p>'}
    </div>
  `);
}

// ── Re-allocate (edit) a sale movement ────────────────────────────────────
async function _reallocateSale(container, farm, items, data, period, allPeriods) {
  const itemOpts = items.map(i =>
    `<option value="${i.id}">${i.name}</option>`).join('');

  openModal({
    title: 'Edit sale allocation',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="background:var(--page-bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:12px">
          <span style="font-weight:600">${data.buyer||'Sale'}</span>
          <span style="color:var(--hint);margin-left:8px">${data.date} · ${fN(parseFloat(data.qty)||0)} ${data.unit||''}</span>
        </div>
        <div class="form-group">
          <label class="form-label">Commodity (stock item)</label>
          <select class="form-select" id="ra-item">
            <option value="">Select…</option>${itemOpts}
          </select>
        </div>
      </div>`,
    confirmLabel: 'Update',
    onConfirm: async (modal) => {
      const itemId = modal.querySelector('#ra-item')?.value;
      if (!itemId) { toast('Select a commodity', 'error'); return false; }
      const item = items.find(i => i.id === itemId);
      // Delete old movement and insert new one
      await dbDelete('stock_movements', `id=eq.${data.movementId}`);
      await dbInsert('stock_movements', {
        farm_id:       farm.id,
        item_id:       itemId,
        location_id:   null,
        movement_type: 'sale',
        qty:           parseFloat(data.qty),
        unit:          item?.default_unit || data.unit || 'bales',
        occurred_on:   data.date,
        note:          `Sale to ${data.buyer||'buyer'} — from invoice`,
        source_system: 'invoices',
        source_ref:    data.invoiceId,
      });
      toast('Allocation updated', 'success');
      await _render(container, farm, period, allPeriods);
    },
  });
}

// ── Seed opening balance from budget carry-over ────────────────────────────
async function _seedOpeningFromBudget(container, farm, itemId, itemName, qty, unit, budgetId, period, allPeriods) {
  if (!period) { toast('No active period — open a period first', 'error'); return; }
  const openingDate = new Date(new Date(period.period_start).getTime() - 86400000).toISOString().slice(0,10);

  openModal({
    title: `Set opening balance — ${itemName}`,
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:12px;font-size:13px;color:#92400e">
          This sets the quantity on hand at the start of the season, seeded from the budget carry-over entry for <strong>${itemName}</strong>.
        </div>
        <div class="form-group">
          <label class="form-label">Opening quantity</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input class="form-input" type="number" id="gs-qty" min="0" step="1" value="${Math.round(qty)}" style="font-size:18px;font-weight:600;max-width:160px">
            <span style="font-size:14px;color:var(--hint)">${unit}</span>
          </div>
          <div style="font-size:11px;color:var(--hint);margin-top:3px">Budget carry-over: ${Math.round(qty).toLocaleString()} ${unit}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Location (optional)</label>
          <select class="form-select" id="gs-loc">
            <option value="">No specific location</option>
          </select>
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
      const locId = modal.querySelector('#gs-loc')?.value || null;
      const note = modal.querySelector('#gs-note')?.value?.trim() || 'Opening balance';
      if (!q || !dt) { toast('Quantity and date are required', 'error'); return false; }

      await dbInsert('stock_movements', {
        farm_id:       farm.id,
        item_id:       itemId,
        location_id:   locId || null,
        movement_type: 'adjustment',
        qty:           q,
        direction:     1,
        unit,
        occurred_on:   dt,
        reason_code:   'opening_balance',
        note,
        source_system: 'budgets',
        source_ref:    budgetId || null,
      });
      toast(`Opening balance set — ${Math.round(q).toLocaleString()} ${unit}`, 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  // Populate location select after modal is open
  setTimeout(async () => {
    const sel = document.getElementById('gs-loc');
    if (!sel) return;
    const locs = await dbSelect('stock_locations', `farm_id=eq.${farm.id}&active=eq.true&order=route_order,name`);
    locs.forEach(l => {
      const opt = document.createElement('option');
      opt.value = l.id; opt.textContent = l.name;
      sel.appendChild(opt);
    });
  }, 80);
}


// ── Movement form ──────────────────────────────────────────────────────────
async function _showMovementForm(container, farm, items, locations, preItemId, preItemName, preLocId, period, allPeriods) {
  const today = new Date().toISOString().slice(0,10);
  const locOpts = locations.map(l =>
    `<option value="${l.id}"${l.id === preLocId ? ' selected' : ''}>${l.name}</option>`).join('');
  const itemOpts = items.map(i =>
    `<option value="${i.id}"${i.id === preItemId ? ' selected' : ''}>${i.name} (${i.subgroup || i.name})</option>`).join('');

  openModal({
    title: 'Record grain / hay movement',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Movement type <span style="color:var(--red)">*</span></label>
          <select class="form-select" id="gm-type">
            ${Object.entries(MOVE_TYPES).map(([k, v]) =>
              `<option value="${k}">${v.icon} ${v.label}</option>`).join('')}
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
              <option value="">No location</option>
              ${locOpts}
            </select>
          </div>
        </div>
        <div id="gm-transfer-dest" style="display:none" class="form-group">
          <label class="form-label">Destination location (transfer) <span style="color:var(--red)">*</span></label>
          <select class="form-select" id="gm-dest-loc">
            <option value="">Select destination…</option>
            ${locOpts}
          </select>
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
        <div class="form-group">
          <label class="form-label">Note</label>
          <input class="form-input" type="text" id="gm-note" placeholder="e.g. Baled paddock 12, contractor pickup">
        </div>
      </div>`,
    confirmLabel: 'Record movement',
    onConfirm: async (modal) => {
      const type    = modal.querySelector('#gm-type')?.value;
      const itemId  = modal.querySelector('#gm-item')?.value;
      const locId   = modal.querySelector('#gm-location')?.value || null;
      const destLocId = modal.querySelector('#gm-dest-loc')?.value || null;
      const qty     = parseFloat(modal.querySelector('#gm-qty')?.value);
      const date    = modal.querySelector('#gm-date')?.value;
      const note    = modal.querySelector('#gm-note')?.value?.trim() || null;

      if (!itemId || !qty || !date) { toast('Commodity, quantity and date are required', 'error'); return false; }
      if (type === 'adjustment' && !note) { toast('A note is required for adjustments', 'error'); return false; }
      if (type === 'transfer_out' && !destLocId) { toast('Select a destination location for the transfer', 'error'); return false; }

      const item = items.find(i => i.id === itemId);
      const unit = item?.default_unit || 'bales';

      if (type === 'transfer_out' && destLocId) {
        // Paired transfer — both legs together
        const transferId = crypto.randomUUID();
        await Promise.all([
          dbInsert('stock_movements', { farm_id: farm.id, item_id: itemId, location_id: locId,     movement_type: 'transfer_out', qty, unit, occurred_on: date, transfer_id: transferId, note }),
          dbInsert('stock_movements', { farm_id: farm.id, item_id: itemId, location_id: destLocId, movement_type: 'transfer_in',  qty, unit, occurred_on: date, transfer_id: transferId, note }),
        ]);
      } else {
        await dbInsert('stock_movements', {
          farm_id: farm.id, item_id: itemId, location_id: locId,
          movement_type: type, qty, unit, occurred_on: date, note,
          ...(type === 'adjustment' ? { reason_code: 'other', direction: 1 } : {}),
        });
      }

      toast('Movement recorded', 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

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

// ── Add commodity / season form ────────────────────────────────────────────
async function _showAddItemForm(container, farm, existingItems, period, allPeriods) {
  // Suggest subgroups already in use
  const knownSubgroups = [...new Set(existingItems.map(i => i.subgroup || i.name).filter(Boolean))];
  const sgSuggestions = knownSubgroups.length
    ? `<datalist id="sg-list">${knownSubgroups.map(s => `<option value="${s}">`).join('')}</datalist>`
    : '';

  const currentYear = new Date().getFullYear();

  openModal({
    title: 'Add commodity / season',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <p style="font-size:12px;color:var(--hint);margin:0">
          Each row is one <strong>commodity × season × grade</strong>. For example:
          <em>Hay</em> / Cavalcade / 2026 and <em>Hay</em> / Cavalcade / 2025 are tracked separately.
        </p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Commodity (type) <span style="color:var(--red)">*</span></label>
            <input class="form-input" id="ai-subgroup" type="text" list="sg-list" placeholder="e.g. Hay, Wheat, Sorghum">
            ${sgSuggestions}
            <div style="font-size:10px;color:var(--hint);margin-top:2px">Groups items together in the grid</div>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Variety / description</label>
            <input class="form-input" id="ai-variety" type="text" placeholder="e.g. Cavalcade, Grazing King">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Season / year <span style="color:var(--red)">*</span></label>
            <input class="form-input" id="ai-year" type="number" min="2000" max="2099" value="${currentYear}" placeholder="${currentYear}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Unit <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="ai-unit">
              <option value="bales">Bales</option>
              <option value="t">Tonnes</option>
              <option value="kg">Kilograms</option>
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
            <div style="font-size:10px;color:var(--hint);margin-top:2px">Converts bales → tonnes in the grid</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Notes</label>
          <input class="form-input" id="ai-notes" type="text" placeholder="Optional — quality grade, treatments, etc.">
        </div>
      </div>`,
    confirmLabel: 'Add commodity',
    onConfirm: async (modal) => {
      const subgroup = modal.querySelector('#ai-subgroup')?.value?.trim();
      const variety  = modal.querySelector('#ai-variety')?.value?.trim() || null;
      const year     = modal.querySelector('#ai-year')?.value?.trim();
      const unit     = modal.querySelector('#ai-unit')?.value;
      const baleType = modal.querySelector('#ai-bale-type')?.value;
      const kgBale   = parseFloat(modal.querySelector('#ai-kg-bale')?.value) || null;
      const notes    = modal.querySelector('#ai-notes')?.value?.trim() || null;

      if (!subgroup || !year) { toast('Commodity type and season year are required', 'error'); return false; }

      // Name = "Variety Year" or "Subgroup Year"
      const name = [variety || subgroup, year].join(' ');

      const attrs = {
        produced_year: year,
        ...(variety    ? { variety }    : {}),
        ...(unit === 'bales' && baleType ? { bale_type: baleType } : {}),
        ...(unit === 'bales' && kgBale   ? { kg_per_bale: kgBale } : {}),
      };

      await dbInsert('stock_items', {
        farm_id:      farm.id,
        category:     'grain',
        name,
        subgroup,
        default_unit: unit,
        attributes:   attrs,
        active:       true,
        notes,
      });
      toast(`${name} added`, 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  setTimeout(() => {
    const unitEl = document.getElementById('ai-unit');
    const baleSection = document.getElementById('ai-bale-section');
    unitEl?.addEventListener('change', () => {
      if (baleSection) baleSection.style.display = unitEl.value === 'bales' ? '' : 'none';
    });
  }, 50);
}
