// modules/stocktake/seed.js
// Seed stocktake section
//
// Data model
// ──────────
// stock_items  (category='grain', is_seed=true)
//   subgroup         = "Cotton Seed" / "Grain Sorghum Seed" etc.
//   name             = "DP 1840 B3XF 2026"
//   attributes = {
//     variety:       "DP 1840 B3XF",
//     produced_year: "2026",
//     kg_per_bag:    20            -- for bag-based tracking
//   }
//
// stock_movements
//   movement_type = 'delivery'    -- seed purchase / delivery in
//   movement_type = 'usage'       -- linked to a closed planting session
//   movement_type = 'adjustment'  -- manual correction
//   source_system = 'operations'  -- on usage movements written by this module
//   source_ref    = session.id    -- UUID of the planting_session
//
// A usage movement is written automatically when a planting session closes
// (see the hook in operations.js → _writeSessionSeedUsage).
// This screen shows the balance and lets users:
//   1. Add seed items (variety × season)
//   2. Record manual deliveries
//   3. See which sessions consumed what, with a link back to operations

import { dbSelect, dbInsert, dbUpdate, dbDelete, dbDeleteWhere, getSession } from '../../js/supabase-client.js?v=1794900620160';
import { getActiveFarm, canWrite } from '../../js/app-state.js?v=1794900620160';
import { toast, openModal, qs } from '../../js/ui.js?v=1794900620160';
import { loadCommodities, getCommodities } from '../../js/commodities.js?v=1794900620160';

// ── Formatters ────────────────────────────────────────────────────────────
const fN = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-AU', { maximumFractionDigits: 1 });
const fKg = n => (n == null || isNaN(n)) ? '—' : n >= 1000
  ? `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')} t`
  : `${Math.round(n)} kg`;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Movement type display ──────────────────────────────────────────────────
const MOVE_LABELS = {
  delivery:   { label: 'Delivery',       color: 'var(--green)',   icon: '🚛' },
  usage:      { label: 'Planting use',   color: 'var(--blue)',    icon: '🌱' },
  adjustment: { label: 'Adjustment',     color: 'var(--amber)',   icon: '±'  },
  write_off:  { label: 'Write-off',      color: 'var(--red)',     icon: '⚠' },
  transfer_in:  { label: 'Transfer in',  color: 'var(--blue)',    icon: '→'  },
  transfer_out: { label: 'Transfer out', color: 'var(--hint)',    icon: '←'  },
};

// ── Entry point ────────────────────────────────────────────────────────────
export async function mountSeed(container, initialPeriod) {
  const farm = getActiveFarm();
  container.innerHTML = `
    <div style="padding:20px 24px;max-width:1200px;margin:0 auto" id="sd-wrap">
      <div style="padding:40px;text-align:center;color:var(--hint)">Loading seed…</div>
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
  const wrap = qs('#sd-wrap', container);

  const [items, locations, movements, pendingPlantingMovements] = await Promise.all([
    // Seed items only — is_seed=true
    dbSelect('stock_items',
      `farm_id=eq.${farm.id}&category=eq.grain&is_seed=eq.true&active=eq.true&order=subgroup,name`),
    dbSelect('stock_locations',
      `farm_id=eq.${farm.id}&active=eq.true&order=route_order,name`),
    dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&select=id,item_id,location_id,movement_type,signed_qty,qty,unit,kg_per_bag,occurred_on,note,source_ref,source_system,reason_code&order=occurred_on.desc`),
    // Unallocated usage stubs from operations (item_id IS NULL)
    dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&movement_type=eq.usage&source_system=eq.operations&item_id=is.null&select=id,movement_type,qty,unit,kg_per_bag,occurred_on,note,source_ref,source_system&order=occurred_on.desc`),
  ]);

  // Filter movements to seed items only
  const seedItemIds = new Set(items.map(i => i.id));
  const seedMovements = movements.filter(m => seedItemIds.has(m.item_id));
  const locById = Object.fromEntries(locations.map(l => [l.id, l]));

  // ── Period timeline ──────────────────────────────────────────────────────
  const timelineHtml = allPeriods.length > 1 ? `
    <div style="display:flex;align-items:center;gap:2px;overflow-x:auto;padding-bottom:12px;margin-bottom:16px;border-bottom:1px solid var(--border-light)">
      ${allPeriods.map(p => {
        const isActive = period && p.id === period.id;
        const label = new Date(p.period_start).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
        const dot = p.status === 'locked' ? '🔒' : p.status === 'review' ? '🔶' : '●';
        const dotColor = p.status === 'locked' ? 'var(--hint)' : p.status === 'review' ? 'var(--amber)' : 'var(--green)';
        return `<button class="sd-period-btn" data-period-id="${p.id}"
          style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 14px;border:none;border-radius:8px;cursor:pointer;background:${isActive ? 'var(--blue)' : 'transparent'}">
          <span style="font-size:11px;font-weight:${isActive ? 700 : 500};color:${isActive ? 'white' : 'var(--ink-mid)'}">${label}</span>
          <span style="font-size:9px;color:${isActive ? 'rgba(255,255,255,.7)' : dotColor}">${dot} ${p.status}</span>
        </button>`;
      }).join('')}
    </div>` : '';

  // ── Period window ────────────────────────────────────────────────────────
  const periodStart = period?.period_start;
  const periodEnd   = period?.period_end;
  const periodLabel = period
    ? new Date(period.period_start).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
    : 'All time';

  // ── Balance calculations ─────────────────────────────────────────────────
  const bKey = (itemId, locId) => `${itemId}||${locId || 'none'}`;

  const openingMap = {};
  seedMovements
    .filter(m => !periodStart || m.occurred_on < periodStart)
    .forEach(m => {
      const k = bKey(m.item_id, m.location_id);
      openingMap[k] = (openingMap[k] || 0) + (parseFloat(m.signed_qty) || 0);
    });

  const periodMoves = periodStart
    ? seedMovements.filter(m => m.occurred_on >= periodStart && m.occurred_on <= periodEnd)
    : seedMovements;

  const closingMap = { ...openingMap };
  periodMoves.forEach(m => {
    const k = bKey(m.item_id, m.location_id);
    closingMap[k] = (closingMap[k] || 0) + (parseFloat(m.signed_qty) || 0);
  });

  // ── Planting sessions linked to seed movements ───────────────────────────
  // Fetch sessions referenced in both allocated and pending usage movements
  const usageSessionIds = [...new Set([
    ...periodMoves
      .filter(m => m.movement_type === 'usage' && m.source_system === 'operations' && m.source_ref)
      .map(m => m.source_ref),
    ...pendingPlantingMovements
      .filter(m => m.source_ref)
      .map(m => m.source_ref),
  ])];

  let linkedSessions = [];
  if (usageSessionIds.length > 0) {
    try {
      linkedSessions = await dbSelect('planting_sessions',
        `id=in.(${usageSessionIds.join(',')})&select=id,field_name,sub_block,commodity,variety,seed_type,kg_per_bag,seed_in_bags,seed_in_kg,seed_out_bags,seed_out_kg,status,created_at`);
    } catch { /* graceful — session table may not be accessible */ }
  }
  const sessionById = Object.fromEntries(linkedSessions.map(s => [s.id, s]));

  // ── Header ───────────────────────────────────────────────────────────────
  const headerHtml = `
    <div class="page-header" style="margin-bottom:20px">
      <div>
        <h1>Seed</h1>
        <p class="page-subtitle">${farm.name} · ${periodLabel}</p>
      </div>
      ${canWrite() ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" id="sd-add-delivery">+ Delivery</button>
          <button class="btn btn-primary btn-sm" id="sd-add-item">+ Add variety</button>
        </div>` : ''}
    </div>`;

  // ── Summary tiles ────────────────────────────────────────────────────────
  const totalItems = items.length;
  const totalKgOnHand = Object.entries(closingMap)
    .filter(([k]) => seedItemIds.has(k.split('||')[0]))
    .reduce((s, [, v]) => s + v, 0);

  const periodUsageKg = periodMoves
    .filter(m => m.movement_type === 'usage')
    .reduce((s, m) => s + Math.abs(parseFloat(m.signed_qty) || 0), 0);

  // Convert bags to kg where we can
  const toKg = (m, item) => {
    const qty = Math.abs(parseFloat(m.signed_qty) || 0);
    if (m.unit === 'kg') return qty;
    if (m.unit === 't') return qty * 1000;
    // bags — use item's kg_per_bag from attributes
    const kpb = parseFloat(item?.attributes?.kg_per_bag) || null;
    return kpb ? qty * kpb : qty; // fallback: treat as kg if no kpb
  };

  const periodDeliveryKg = periodMoves
    .filter(m => m.movement_type === 'delivery')
    .reduce((s, m) => {
      const item = items.find(i => i.id === m.item_id);
      return s + toKg(m, item);
    }, 0);

  const tilesHtml = `
    <div class="stats-strip" style="margin-bottom:20px">
      <div class="stat-card">
        <div class="stat-label">Varieties tracked</div>
        <div class="stat-value blue">${totalItems}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">On hand</div>
        <div class="stat-value">${fKg(totalKgOnHand)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Used this period</div>
        <div class="stat-value red">${fKg(periodUsageKg)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Delivered this period</div>
        <div class="stat-value green">${fKg(periodDeliveryKg)}</div>
      </div>
    </div>`;

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!items.length) {
    const unallocatedHtmlEmpty = _buildUnallocatedPanel(pendingPlantingMovements, items, sessionById, locations);
    wrap.innerHTML = timelineHtml + headerHtml + tilesHtml + unallocatedHtmlEmpty + `
      <div class="card" style="padding:48px 24px;text-align:center">
        <div style="font-size:32px;margin-bottom:12px">🌱</div>
        <p style="font-size:15px;font-weight:600;color:var(--ink);margin-bottom:6px">No seed varieties set up</p>
        <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Add a seed variety to track on-hand stock and link it to planting sessions.</p>
        ${canWrite() ? `<button class="btn btn-primary" id="sd-add-item-empty">+ Add seed variety</button>` : ''}
      </div>`;
    _wireButtons(container, wrap, farm, items, locations, period, allPeriods, sessionById, pendingPlantingMovements);
    return;
  }

  // ── Seed item cards ──────────────────────────────────────────────────────
  // Group by subgroup (Cotton Seed, Grain Sorghum Seed, etc.)
  const subgroups = {};
  items.forEach(item => {
    const sg = item.subgroup || item.name;
    if (!subgroups[sg]) subgroups[sg] = [];
    subgroups[sg].push(item);
  });

  const renderItemCard = item => {
    const attrs    = item.attributes || {};
    const unit     = item.default_unit || 'bags';
    const kpb      = parseFloat(attrs.kg_per_bag) || null;

    // All location keys for this item
    const allKeys = [...new Set([
      ...Object.keys(openingMap).filter(k => k.startsWith(item.id + '||')),
      ...Object.keys(closingMap).filter(k => k.startsWith(item.id + '||')),
    ])];

    const totalClosing = allKeys.reduce((s, k) => s + (closingMap[k] || 0), 0);
    // Total kg: sum each movement's own kg_per_bag, fall back to item kpb for opening balance
    const totalKg = (() => {
      if (!kpb && !periodMoves.some(m => m.item_id === item.id && m.kg_per_bag)) return null;
      const openKg = allKeys.reduce((s, k) => s + (openingMap[k] || 0), 0) * (kpb || 0);
      const periodKg = periodMoves
        .filter(m => m.item_id === item.id)
        .reduce((s, m) => {
          const mKpb = parseFloat(m.kg_per_bag) || kpb || 0;
          return s + (parseFloat(m.signed_qty) || 0) * mKpb;
        }, 0);
      const v = openKg + periodKg;
      return v > 0 ? v : null;
    })();
    const kgStr = totalKg ? ` · ${fKg(totalKg)}` : '';

    // Chips
    const chips = [
      attrs.variety ? `<span class="sd-chip">${esc(attrs.variety)}</span>` : '',
      kpb           ? `<span class="sd-chip">${kpb} kg/bag</span>` : '',
    ].filter(Boolean).join('');

    // Linked planting session usage this period
    const itemUsageMoves = periodMoves.filter(m => m.item_id === item.id && m.movement_type === 'usage');
    const sessionRows = itemUsageMoves
      .filter(m => m.source_system === 'operations' && m.source_ref)
      .map(m => {
        const sess    = sessionById[m.source_ref];
        const qty     = Math.abs(parseFloat(m.signed_qty) || 0);
        const mKpb    = parseFloat(m.kg_per_bag) || kpb; // movement-level first, item fallback
        const sessLabel = sess
          ? `${sess.field_name}${sess.sub_block ? ` · ${sess.sub_block}` : ''}`
          : `Session ${m.source_ref.slice(0, 8)}…`;
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:7px 14px 7px 20px;border-bottom:1px solid var(--border-light);font-size:12px">
            <span style="font-size:14px">🌱</span>
            <div style="flex:1;min-width:0">
              <span style="font-weight:500;color:var(--ink)">${esc(sessLabel)}</span>
              ${sess ? `<span style="color:var(--hint);margin-left:6px">${esc(sess.crop_type || '')} ${esc(sess.variety || '')}</span>` : ''}
            </div>
            <div style="text-align:right;flex-shrink:0">
              <span style="font-weight:600;color:var(--red)">−${fN(qty)} ${esc(unit)}</span>
              ${mKpb ? `<span style="font-size:10px;color:var(--hint);display:block">${fKg(qty * mKpb)}</span>` : ''}
            </div>
            <span style="font-size:11px;color:var(--hint);flex-shrink:0">${m.occurred_on}</span>
            ${canWrite() ? `<button class="btn btn-ghost btn-sm sd-delete-move"
              data-move-id="${m.id}"
              data-label="${esc(sessLabel)}"
              title="Delete this usage movement"
              style="font-size:11px;color:var(--red);padding:2px 6px;flex-shrink:0">✕</button>` : ''}
          </div>`;
      }).join('');

    // Location balance rows
    const locRows = allKeys.length ? allKeys.map(k => {
      const locId   = k.split('||')[1];
      const locName = locId === 'none' ? '— unassigned' : (locById[locId]?.name || locId);
      const opening = openingMap[k] || 0;
      const closing = closingMap[k] || 0;
      // pIn/pOut in kg (canonical storage unit)
      const inMoves  = periodMoves.filter(m => m.item_id === item.id && (m.location_id || 'none') === locId && (parseFloat(m.signed_qty) || 0) > 0);
      const outMoves = periodMoves.filter(m => m.item_id === item.id && (m.location_id || 'none') === locId && (parseFloat(m.signed_qty) || 0) < 0);
      const pInKg    = inMoves.reduce((s, m) => s + (parseFloat(m.signed_qty) || 0), 0);
      const pOutKg   = Math.abs(outMoves.reduce((s, m) => s + (parseFloat(m.signed_qty) || 0), 0));

      // Convert kg movements to bags using per-movement kpb, falling back to item kpb
      const toBags = (moves, totalKg) => {
        if (!totalKg || !moves.length) return null;
        let bags = 0;
        for (const m of moves) {
          const mk = parseFloat(m.kg_per_bag) || kpb;
          if (!mk) return null; // can't convert without kpb
          bags += Math.abs(parseFloat(m.signed_qty) || 0) / mk;
        }
        return Math.round(bags);
      };
      const pInBags  = toBags(inMoves,  pInKg);
      const pOutBags = toBags(outMoves, pOutKg);

      // Display: bags primary (with kg hint) when bags known, else kg
      const fQtyCell = (kg, bags, sign, color) => {
        if (!kg) return '—';
        if (bags !== null) {
          const kgHint = `<span style="font-size:10px;color:var(--hint);display:block">${fKg(kg)}</span>`;
          return `<span style="font-weight:600;color:${color}">${sign}${fN(bags)} bags</span>${kgHint}`;
        }
        return `<span style="font-weight:600;color:${color}">${sign}${fKg(kg)}</span>`;
      };

      // closing is in kg. Convert to bags for display when kpb known.
      const closingBags = (kpb && closing) ? Math.round(closing / kpb) : null;
      const closingKgStr = closingBags ? `<span style="font-size:10px;color:var(--hint);display:block">${fKg(closing)}</span>` : '';
      const closingDisplay = closingBags !== null
        ? `<span style="font-size:var(--text-sm);font-weight:700;color:var(--ink)">${fN(closingBags)} bags</span>${closingKgStr}`
        : `<span style="font-size:var(--text-sm);font-weight:700;color:var(--ink)">${fKg(closing)}</span>`;

      // Opening display (also kg, convert to bags)
      const openingBags = (kpb && opening) ? Math.round(opening / kpb) : null;
      const openingDisplay = opening
        ? (openingBags !== null ? `${fN(openingBags)} bags` : fKg(opening))
        : '—';

      return `<tr style="border-bottom:1px solid var(--border-light)">
        <td style="padding:9px 14px 9px 16px;font-size:var(--text-sm);color:var(--ink)">${esc(locName)}</td>
        <td style="padding:9px 14px;text-align:center;font-size:var(--text-sm);color:var(--muted)">${openingDisplay}</td>
        <td style="padding:9px 14px;text-align:center;font-size:var(--text-sm)">${fQtyCell(pInKg, pInBags, '+', 'var(--green)')}</td>
        <td style="padding:9px 14px;text-align:center;font-size:var(--text-sm)">${fQtyCell(pOutKg, pOutBags, '−', 'var(--red)')}</td>
        <td style="padding:9px 14px;text-align:center">
          ${closingDisplay}
        </td>
        <td style="padding:9px 14px;text-align:right">
          ${canWrite() ? `<button class="btn btn-ghost btn-sm sd-add-move"
            data-item-id="${item.id}" data-item-name="${esc(item.name)}"
            data-loc-id="${locId === 'none' ? '' : locId}"
            data-loc-name="${esc(locName)}">+ Movement</button>` : ''}
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="padding:16px 20px;font-size:13px;color:var(--hint)">
      No movements yet.
      ${canWrite() ? `<button class="btn btn-ghost btn-sm sd-add-move" style="margin-left:6px;font-size:11px"
        data-item-id="${item.id}" data-item-name="${esc(item.name)}">+ Add first movement</button>` : ''}
    </td></tr>`;

    // Item name row + data rows (no card wrapper, no repeated header — shared table)
    const plantingSection = sessionRows ? `
      <tr><td colspan="6" style="padding:0;border-top:1px solid var(--border)">
        <div style="padding:5px 16px;font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--blue-text);background:var(--blue-light)">
          🌱 Planting session usage
        </div>
        <table style="width:100%;border-collapse:collapse">${sessionRows}</table>
      </td></tr>` : '';

    return `
      <tr style="border-top:2px solid var(--border);background:var(--page-bg)">
        <td colspan="6" style="padding:7px 16px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:13px;font-weight:600;color:var(--ink)">${esc(item.name)}</span>
            ${chips}
            <span style="font-size:12px;color:var(--muted)">${kpb ? `${fN(Math.round(totalClosing / kpb))} bags on hand · ${fKg(totalClosing)}` : `${fKg(totalClosing)} on hand`}</span>
            ${canWrite() ? `
              <div style="display:flex;gap:4px;margin-left:auto">
                <button class="btn btn-ghost btn-sm sd-edit-item"
                  data-item-id="${item.id}" style="font-size:11px">✎ Edit</button>
                <button class="btn btn-ghost btn-sm sd-record-delivery"
                  data-item-id="${item.id}" data-item-name="${esc(item.name)}"
                  data-unit="${esc(unit)}" data-kpb="${kpb || ''}" style="font-size:11px">+ Delivery</button>
                <button class="btn btn-ghost btn-sm sd-add-move"
                  data-item-id="${item.id}" data-item-name="${esc(item.name)}" style="font-size:11px">+ Movement</button>
              </div>` : ''}
          </div>
        </td>
      </tr>
      ${locRows}
      ${plantingSection}`;
  };

  const subgroupHtml = Object.entries(subgroups).map(([sgName, sgItems]) => {
    const sgClosing = sgItems.reduce((sum, item) => {
      const ks = Object.keys(closingMap).filter(k => k.startsWith(item.id + '||'));
      return sum + ks.reduce((s, k) => s + (closingMap[k] || 0), 0);
    }, 0);
    // sgClosing is in kg; convert to bags for display when kpb known
    const sgKpb  = parseFloat(sgItems[0]?.attributes?.kg_per_bag) || null;
    const sgTotalStr = sgKpb && sgClosing
      ? `${fN(Math.round(sgClosing / sgKpb))} bags · ${fKg(sgClosing)}`
      : fKg(sgClosing);

    return `
      <div class="card" style="margin-bottom:20px;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:var(--navy)">
          <span style="font-size:13px;font-weight:700;color:#fff;letter-spacing:.01em">${esc(sgName)}</span>
          <span style="font-size:12px;color:rgba(255,255,255,.55)">${sgTotalStr} total</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
              <th style="padding:7px 14px 7px 16px;font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:left">Location</th>
              <th style="padding:7px 14px;font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:center">Opening</th>
              <th style="padding:7px 14px;font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--green);text-align:center">In</th>
              <th style="padding:7px 14px;font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--red);text-align:center">Used</th>
              <th style="padding:7px 14px;font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:center">Closing</th>
              <th style="width:120px"></th>
            </tr>
          </thead>
          <tbody>${sgItems.map(renderItemCard).join('')}</tbody>
        </table>
      </div>`;
  }).join('');

  // ── Period movements log ─────────────────────────────────────────────────
  const logRows = periodMoves.slice(0, 40).map(m => {
    const item    = items.find(i => i.id === m.item_id);
    const mt      = MOVE_LABELS[m.movement_type] || { label: m.movement_type, color: 'var(--hint)', icon: '·' };
    const qty     = parseFloat(m.signed_qty) || 0;   // always kg
    const locName = m.location_id ? (locById[m.location_id]?.name || m.location_id) : '—';
    // Use movement-level kg_per_bag first, fall back to item attribute
    const mKpb   = parseFloat(m.kg_per_bag) || parseFloat(item?.attributes?.kg_per_bag) || null;
    const bags    = mKpb ? Math.round(Math.abs(qty) / mKpb) : null;
    // Qty cell: bags primary + kg secondary when bags known
    const qtyDisplay = bags !== null
      ? `${qty > 0 ? '+' : '−'}${fN(bags)} bags<br><span style="font-size:10px;color:var(--hint)">${fKg(Math.abs(qty))}</span>`
      : `${qty > 0 ? '+' : ''}${fKg(qty)}`;
    const refNote = m.source_system === 'operations' && m.source_ref
      ? `Planting: ${sessionById[m.source_ref]?.field_name || m.source_ref.slice(0, 8) + '…'}`
      : (m.note || '');

    const canDel = canWrite() && m.movement_type !== 'usage'; // usage deletions go via planting session
    const delLabel = `${mt.label} ${item?.name || ''} ${m.occurred_on}`;
    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:8px 14px;color:var(--hint)">${m.occurred_on}</td>
      <td style="padding:8px 14px;font-weight:500;color:var(--ink)">${item?.name || '—'}</td>
      <td style="padding:8px 14px;color:${mt.color}">${mt.icon} ${mt.label}</td>
      <td style="padding:8px 14px;color:var(--hint);font-size:11px">${locName}</td>
      <td style="padding:8px 14px;text-align:right;font-weight:600;color:${qty > 0 ? 'var(--green)' : 'var(--red)'}">
        ${qtyDisplay}
      </td>
      <td style="padding:8px 14px;color:var(--hint)">${esc(refNote)}</td>
      <td style="padding:8px 6px;text-align:right">
        ${canDel ? `<button class="btn btn-ghost btn-sm sd-delete-move"
          data-move-id="${m.id}" data-label="${esc(delLabel)}"
          title="Delete this movement"
          style="font-size:11px;color:var(--red);padding:2px 6px">✕</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  const unallocatedHtml = _buildUnallocatedPanel(pendingPlantingMovements, items, sessionById, locations);

  wrap.innerHTML = timelineHtml + headerHtml + tilesHtml + unallocatedHtml + subgroupHtml + (periodMoves.length ? `
    <div class="card" style="margin-top:8px;overflow:hidden">
      <div class="card-header">
        <h2>Period movements</h2>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
            ${['Date', 'Variety', 'Type', 'Location', 'Qty', 'Note', ''].map(h =>
              `<th style="padding:7px 14px;font-size:var(--text-xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);text-align:${h === 'Qty' ? 'right' : 'left'}">${h}</th>`
            ).join('')}
          </tr>
        </thead>
        <tbody>${logRows}</tbody>
      </table>
    </div>` : '');

  // Inject chip styles
  if (!document.getElementById('sd-chip-style')) {
    const s = document.createElement('style');
    s.id = 'sd-chip-style';
    s.textContent = `.sd-chip{display:inline-flex;align-items:center;font-size:11px;font-weight:500;padding:2px 8px;border-radius:10px;background:var(--blue-light);color:var(--blue-text);margin-right:3px}`;
    document.head.appendChild(s);
  }

  _wireButtons(container, wrap, farm, items, locations, period, allPeriods, sessionById, pendingPlantingMovements);
}

// ── Unallocated planting usages panel ─────────────────────────────────────
function _buildUnallocatedPanel(pendingMovements, items, sessionById, locations = []) {
  if (!pendingMovements || !pendingMovements.length) return '';

  const locOpts = locations.map(l =>
    `<option value="${l.id}">${esc(l.name)}</option>`
  ).join('');

  const fQty = (m) => {
    const q = parseFloat(m.qty) || 0;
    if (m.unit === 'bags') {
      const kgStr = m.kg_per_bag ? ` (${fN(q * m.kg_per_bag)} kg)` : '';
      return `${fN(q)} bags${kgStr}`;
    }
    if (m.unit === 'kg') return `${fN(q)} kg`;
    if (m.unit === 't') return `${fN(q)} t`;
    return `${fN(q)} ${m.unit || ''}`;
  };

  const rows = pendingMovements.map(m => {
    const session = sessionById[m.source_ref] || {};
    const field   = session.field_name ? `${esc(session.field_name)}${session.sub_block ? ' · ' + esc(session.sub_block) : ''}` : '—';
    const crop    = esc(session.commodity || '—');
    const variety = esc(session.variety || '—');
    // item_id is already set via seed_item_id on the planting rows — just need location
    const noteItem = items.find(i => m.note && m.note.includes(i.name));
    const varietyLabel = noteItem ? esc(noteItem.name) : (session.variety ? esc(session.variety) : '—');
    return [
      `<div style="display:grid;grid-template-columns:90px 1fr 80px 100px 1fr 110px;`,
      `gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-light);align-items:center;font-size:12px">`,
      `<div style="color:var(--hint)">${m.occurred_on || '—'}</div>`,
      `<div>`,
        `<div style="font-weight:600;color:var(--ink)">${field}</div>`,
        `<div style="font-size:11px;color:var(--hint)">${crop}${session.variety ? ' · ' + variety : ''}</div>`,
      `</div>`,
      `<div style="font-weight:600;color:var(--ink)">${fQty(m)}</div>`,
      `<div style="font-size:11px;color:var(--hint)">${varietyLabel}</div>`,
      locations.length
        ? `<div><select class="form-select sd-alloc-loc" data-movement-id="${m.id}" style="font-size:11px;width:100%"><option value="">Select location…</option>${locOpts}</select></div>`
        : `<div><span style="font-size:11px;color:var(--hint)">No locations set up</span></div>`,
      locations.length
        ? `<div><button class="btn btn-sm btn-primary sd-alloc-btn" data-movement-id="${m.id}" style="font-size:11px;opacity:.4;pointer-events:none;white-space:nowrap">Allocate →</button></div>`
        : `<div></div>`,
      `</div>`,
    ].join('');
  }).join('');

  return [
    `<div class="card" style="margin-bottom:16px;overflow:hidden;border:2px solid var(--amber)">`,
    `<div style="padding:10px 14px;border-bottom:1px solid var(--border);background:#fffbeb;`,
    `display:flex;align-items:center;justify-content:space-between">`,
    `<span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#92400e">`,
    `⚡ ${pendingMovements.length} planting session${pendingMovements.length !== 1 ? 's' : ''} awaiting seed allocation</span>`,
    `<span style="font-size:11px;color:#92400e">Assign each to a seed variety to update the stocktake</span>`,
    `</div>`,
    rows,
    `</div>`,
  ].join('');
}

// ── Wire event listeners ───────────────────────────────────────────────────
function _wireButtons(container, wrap, farm, items, locations, period, allPeriods, sessionById, pendingPlantingMovements) {
  wrap.querySelectorAll('.sd-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = allPeriods.find(x => x.id === btn.dataset.periodId);
      if (p) _render(container, farm, p, allPeriods);
    });
  });

  wrap.querySelector('#sd-add-item')?.addEventListener('click',
    () => _showAddVarietyForm(container, farm, items, period, allPeriods));
  wrap.querySelector('#sd-add-item-empty')?.addEventListener('click',
    () => _showAddVarietyForm(container, farm, items, period, allPeriods));
  wrap.querySelector('#sd-add-delivery')?.addEventListener('click',
    () => _showDeliveryForm(container, farm, items, locations, null, null, period, allPeriods));

  wrap.querySelectorAll('.sd-edit-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = items.find(i => i.id === btn.dataset.itemId);
      if (item) _showEditVarietyForm(container, farm, item, items, period, allPeriods);
    });
  });

  wrap.querySelectorAll('.sd-record-delivery').forEach(btn => {
    btn.addEventListener('click', () =>
      _showDeliveryForm(container, farm, items, locations,
        btn.dataset.itemId, btn.dataset.itemName, period, allPeriods));
  });

  wrap.querySelectorAll('.sd-add-move').forEach(btn => {
    btn.addEventListener('click', () =>
      _showMovementForm(container, farm, items, locations,
        btn.dataset.itemId, btn.dataset.itemName,
        btn.dataset.locId || null, period, allPeriods));
  });

  // Delete usage/delivery movement
  wrap.querySelectorAll('.sd-delete-move').forEach(btn => {
    btn.addEventListener('click', async () => {
      const moveId = btn.dataset.moveId;
      const label  = btn.dataset.label || 'this movement';
      if (!confirm(`Delete movement: ${label}?\n\nThis will also remove any linked cost records. This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        // Remove linked delivery_costs first (FK constraint)
        await dbDeleteWhere('delivery_costs', `movement_id=eq.${moveId}`).catch(() => {});
        await dbDelete('stock_movements', moveId);
        toast('Movement deleted', 'success');
        _render(container, farm, period, allPeriods);
      } catch (e) {
        toast('Failed to delete: ' + e.message, 'error');
        btn.disabled = false;
      }
    });
  });

  // Unallocated planting session allocation
  wrap.querySelectorAll('.sd-alloc-loc').forEach(sel => {
    sel.addEventListener('change', () => {
      const btn = wrap.querySelector(`.sd-alloc-btn[data-movement-id="${sel.dataset.movementId}"]`);
      if (!btn) return;
      btn.style.opacity      = sel.value ? '1'    : '.4';
      btn.style.pointerEvents = sel.value ? 'auto' : 'none';
    });
  });

  wrap.querySelectorAll('.sd-alloc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const movId   = btn.dataset.movementId;
      const locId   = wrap.querySelector(`.sd-alloc-loc[data-movement-id="${movId}"]`)?.value;
      if (!locId) return;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        // Derive item_id from the session's planting rows (seed_item_id)
        const mov = pendingPlantingMovements.find(m => m.id === movId);
        let itemId = null;
        if (mov?.source_ref) {
          const rows = await dbSelect('planting_rows',
            `session_id=eq.${mov.source_ref}&seed_item_id=not.is.null&select=seed_item_id&limit=1`
          ).catch(() => []);
          itemId = rows[0]?.seed_item_id || null;
        }
        // Fall back to matching by variety name in note if no rows have seed_item_id
        if (!itemId) {
          const matched = items.find(i => mov?.note?.includes(i.name));
          itemId = matched?.id || null;
        }
        if (!itemId) throw new Error('Could not determine seed variety — ensure planting rows have a variety selected.');
        await dbUpdate('stock_movements', movId, { item_id: itemId, location_id: locId });
        toast('Seed usage allocated', 'success');
        _render(container, farm, period, allPeriods);
      } catch (e) {
        toast('Failed to allocate: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Allocate →';
      }
    });
  });
}

// ── Add seed variety form ──────────────────────────────────────────────────
async function _showAddVarietyForm(container, farm, existingItems, period, allPeriods) {
  await loadCommodities(farm.id);
  const commodities = getCommodities();
  const cropOpts = commodities.map(c =>
    `<option value="${esc(c.name)}">${esc(c.name)}</option>`
  ).join('');

  openModal({
    title: 'Add seed variety',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Crop <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="sv-crop">
              <option value="">Select crop…</option>
              ${cropOpts}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Variety <span style="color:var(--red)">*</span></label>
            <input class="form-input" id="sv-variety" type="text"
              placeholder="e.g. DP 1840 B3XF, Pacific Vigour">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Unit <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="sv-unit">
              <option value="bags">Bags</option>
              <option value="kg">Kilograms</option>
              <option value="t">Tonnes</option>
            </select>
          </div>
          <div class="form-group" style="margin:0" id="sv-kpb-wrap">
            <label class="form-label">kg per bag</label>
            <input class="form-input" id="sv-kpb" type="number" min="1" step="0.1"
              placeholder="e.g. 20">
            <div style="font-size:10px;color:var(--hint);margin-top:2px">For kg ↔ bags conversion</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Supplier item description <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--hint)">— raw invoice text, for reference</span></label>
          <input class="form-input" id="sv-supplier-desc" type="text"
            placeholder="e.g. SEED COTTON SIC 711RRF V2C 20KG AGENCY CS">
        </div>
        <div class="form-group">
          <label class="form-label">Internal notes (optional)</label>
          <input class="form-input" id="sv-notes" type="text"
            placeholder="e.g. Treated with Gaucho, batch number">
        </div>
      </div>`,
    confirmLabel: 'Add variety',
    onConfirm: async (modal) => {
      const crop         = modal.querySelector('#sv-crop')?.value?.trim();
      const variety      = modal.querySelector('#sv-variety')?.value?.trim();
      const unit         = modal.querySelector('#sv-unit')?.value;
      const kpb          = parseFloat(modal.querySelector('#sv-kpb')?.value) || null;
      const supplierDesc = modal.querySelector('#sv-supplier-desc')?.value?.trim() || null;
      const notes        = modal.querySelector('#sv-notes')?.value?.trim() || null;

      if (!crop || !variety) {
        toast('Crop and variety are required', 'error');
        return false;
      }

      await dbInsert('stock_items', {
        farm_id:      farm.id,
        category:     'grain',
        is_seed:      true,
        name:         variety,
        subgroup:     crop,       // crop name used for grouping & filtering
        default_unit: unit,
        attributes:   { variety, supplier_description: supplierDesc, ...(kpb ? { kg_per_bag: kpb } : {}) },
        active:       true,
        notes,
      });
      toast(`${variety} added`, 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  setTimeout(() => {
    const unitEl  = document.getElementById('sv-unit');
    const kpbWrap = document.getElementById('sv-kpb-wrap');
    const toggle = () => {
      if (kpbWrap) kpbWrap.style.display = unitEl?.value === 'bags' ? '' : 'none';
    };
    unitEl?.addEventListener('change', toggle);
    toggle();
  }, 50);
}

// ── Edit seed variety form ────────────────────────────────────────────────
async function _showEditVarietyForm(container, farm, item, allItems, period, allPeriods) {
  await loadCommodities(farm.id);
  const commodities = getCommodities();
  const attrs = item.attributes || {};
  const currentCrop         = item.subgroup || '';
  const currentVariety      = attrs.variety || item.name;
  const currentUnit         = item.default_unit || 'bags';
  const currentKpb          = parseFloat(attrs.kg_per_bag) || '';
  const currentSupplierDesc = attrs.supplier_description || '';

  const cropOpts = commodities.map(c =>
    `<option value="${esc(c.name)}"${c.name === currentCrop ? ' selected' : ''}>${esc(c.name)}</option>`
  ).join('');

  openModal({
    title: 'Edit seed variety',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Crop <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="ev-crop">
              <option value="">Select crop…</option>
              ${cropOpts}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Variety <span style="color:var(--red)">*</span></label>
            <input class="form-input" id="ev-variety" type="text" value="${esc(currentVariety)}">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Unit <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="ev-unit">
              <option value="bags"${currentUnit==='bags'?' selected':''}>Bags</option>
              <option value="kg"${currentUnit==='kg'?' selected':''}>Kilograms</option>
              <option value="t"${currentUnit==='t'?' selected':''}>Tonnes</option>
            </select>
          </div>
          <div class="form-group" style="margin:0" id="ev-kpb-wrap">
            <label class="form-label">kg per bag</label>
            <input class="form-input" id="ev-kpb" type="number" min="1" step="0.1"
              value="${currentKpb}" placeholder="e.g. 20">
            <div style="font-size:10px;color:var(--hint);margin-top:2px">For kg ↔ bags conversion</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Supplier item description <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--hint)">— raw invoice text, for reference</span></label>
          <input class="form-input" id="ev-supplier-desc" type="text"
            value="${esc(currentSupplierDesc)}"
            placeholder="e.g. SEED COTTON SIC 711RRF V2C 20KG AGENCY CS">
        </div>
        <div class="form-group">
          <label class="form-label">Internal notes (optional)</label>
          <input class="form-input" id="ev-notes" type="text" value="${esc(item.notes || '')}">
        </div>
      </div>`,
    confirmLabel: 'Save changes',
    onConfirm: async (modal) => {
      const crop         = modal.querySelector('#ev-crop')?.value?.trim();
      const variety      = modal.querySelector('#ev-variety')?.value?.trim();
      const unit         = modal.querySelector('#ev-unit')?.value;
      const kpb          = parseFloat(modal.querySelector('#ev-kpb')?.value) || null;
      const supplierDesc = modal.querySelector('#ev-supplier-desc')?.value?.trim() || null;
      const notes        = modal.querySelector('#ev-notes')?.value?.trim() || null;

      if (!crop || !variety) {
        toast('Crop and variety are required', 'error');
        return false;
      }

      await dbUpdate('stock_items', item.id, {
        name:         variety,
        subgroup:     crop,
        default_unit: unit,
        attributes:   { ...attrs, variety, supplier_description: supplierDesc, ...(kpb ? { kg_per_bag: kpb } : { kg_per_bag: null }) },
        notes,
      });
      toast('Variety updated', 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  setTimeout(() => {
    const unitEl  = document.getElementById('ev-unit');
    const kpbWrap = document.getElementById('ev-kpb-wrap');
    const toggle = () => {
      if (kpbWrap) kpbWrap.style.display = unitEl?.value === 'bags' ? '' : 'none';
    };
    unitEl?.addEventListener('change', toggle);
    toggle();
  }, 50);
}

// ── Delivery form ──────────────────────────────────────────────────────────
async function _showDeliveryForm(container, farm, items, locations, preItemId, preItemName, period, allPeriods) {
  const today = new Date().toISOString().slice(0, 10);
  const itemOpts = items.map(i =>
    `<option value="${i.id}"${i.id === preItemId ? ' selected' : ''}>${esc(i.subgroup || '')} — ${esc(i.name)}</option>`).join('');
  const locOpts = locations.map(l =>
    `<option value="${l.id}">${esc(l.name)}</option>`).join('');

  // Crop options for the inline new-variety panel
  await loadCommodities(farm.id);
  const commodities = getCommodities();
  const cropOpts = commodities.map(c =>
    `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');

  openModal({
    title: 'Record seed delivery',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Seed variety <span style="color:var(--red)">*</span></label>
          <div style="display:flex;gap:8px;align-items:center">
            <select class="form-select" id="sdel-item" style="flex:1">
              <option value="">Select variety…</option>
              ${itemOpts}
              <option value="__new__" style="color:var(--blue);font-weight:500">＋ New variety…</option>
            </select>
          </div>
        </div>

        <!-- Inline new-variety panel (hidden until __new__ selected) -->
        <div id="sdel-new-variety-panel" style="display:none;background:var(--page-bg);border:1px solid var(--border);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:12px">
          <div style="font-size:12px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:.04em">New variety</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group" style="margin:0">
              <label class="form-label">Crop <span style="color:var(--red)">*</span></label>
              <select class="form-select" id="snv-crop">
                <option value="">Select crop…</option>${cropOpts}
              </select>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Variety name <span style="color:var(--red)">*</span></label>
              <input class="form-input" id="snv-variety" type="text" placeholder="e.g. DP 1840 B3XF">
            </div>
          </div>
        </div>

        <!-- Quantity — bags or direct kg -->
        <div>
          <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;font-weight:600;color:var(--ink-mid);margin-bottom:8px">
            <input type="checkbox" id="sdel-use-bags" style="accent-color:var(--blue);width:13px;height:13px">
            Delivery in bags
          </label>
        </div>
        <div id="sdel-bags-panel" style="display:none;background:var(--page-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group" style="margin:0">
              <label class="form-label">Number of bags <span style="color:var(--red)">*</span></label>
              <input class="form-input" type="number" id="sdel-bags" min="1" step="1" placeholder="e.g. 200">
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Avg kg / bag <span style="color:var(--red)">*</span></label>
              <input class="form-input" type="number" id="sdel-kpb" min="0.1" step="0.1" placeholder="e.g. 20">
            </div>
          </div>
          <div id="sdel-bags-preview" style="font-size:12px;color:var(--hint);margin-top:8px"></div>
        </div>
        <div class="form-group">
          <label class="form-label">Total weight (kg) <span style="color:var(--red)">*</span></label>
          <input class="form-input" type="number" id="sdel-qty" min="0.1" step="0.1" placeholder="0.0">
        </div>
        <div class="form-group">
          <label class="form-label">Storage location</label>
          <select class="form-select" id="sdel-location">
            <option value="">No specific location</option>${locOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Delivery Date <span style="color:var(--red)">*</span></label>
          <input class="form-input" type="date" id="sdel-date" value="${today}">
        </div>
        <div class="form-group">
          <label class="form-label">Supplier / docket</label>
          <input class="form-input" type="text" id="sdel-supplier" placeholder="Supplier name or docket number">
        </div>
        <div class="form-group">
          <label class="form-label">Internal note</label>
          <input class="form-input" type="text" id="sdel-note" placeholder="Optional">
        </div>

        <!-- Invoice section -->
        <div style="border-top:1px solid var(--border);padding-top:12px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:500;color:var(--ink-mid)">
            <input type="checkbox" id="sdel-has-invoice" style="accent-color:var(--blue);width:15px;height:15px">
            Invoice received with this delivery
          </label>
        </div>
        <div id="sdel-invoice-panel" style="display:none;background:var(--page-bg);border:1px solid var(--border);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:12px">
          <div style="font-size:12px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:.04em">Invoice details</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group" style="margin:0">
              <label class="form-label">Invoice number</label>
              <input class="form-input" id="sinv-number" type="text" placeholder="e.g. INV-00123">
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Invoice date</label>
              <input class="form-input" id="sinv-date" type="date" value="${today}">
            </div>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Invoice total (ex. GST) <span style="color:var(--red)">*</span></label>
            <input class="form-input num" id="sinv-total" type="number" step="0.01" placeholder="e.g. 4250.00">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Attach invoice <span style="font-size:10px;font-weight:400;color:var(--hint)">(PDF, JPG or PNG)</span></label>
            <input class="form-input" id="sinv-attachment" type="file" accept=".pdf,.jpg,.jpeg,.png" style="padding:6px 10px">
          </div>
          <div id="sinv-cost-preview" style="font-size:12px;color:var(--hint)"></div>
        </div>
      </div>`,
    confirmLabel: 'Record delivery',
    onConfirm: async (modal) => {
      const itemSel    = modal.querySelector('#sdel-item');
      let   itemId     = itemSel?.value;
      const locId      = modal.querySelector('#sdel-location')?.value || null;
      const qty        = parseFloat(modal.querySelector('#sdel-qty')?.value);
      const date       = modal.querySelector('#sdel-date')?.value;
      const supplier   = modal.querySelector('#sdel-supplier')?.value?.trim() || null;
      const note       = modal.querySelector('#sdel-note')?.value?.trim() || null;
      const hasInvoice = modal.querySelector('#sdel-has-invoice')?.checked;

      // Bags breakdown (optional — stored for reference)
      const useBags = modal.querySelector('#sdel-use-bags')?.checked;
      const bags    = useBags ? (parseFloat(modal.querySelector('#sdel-bags')?.value) || null) : null;
      const kpb     = useBags ? (parseFloat(modal.querySelector('#sdel-kpb')?.value) || null) : null;

      // Invoice fields
      const invNumber      = modal.querySelector('#sinv-number')?.value?.trim() || null;
      const invDate        = modal.querySelector('#sinv-date')?.value || date;
      const invTotalExGst  = parseFloat(modal.querySelector('#sinv-total')?.value) || null;
      const invAttachment  = modal.querySelector('#sinv-attachment')?.files?.[0] || null;

      // Derive unit cost from total ÷ qty
      const invUnitCost = (invTotalExGst && qty) ? parseFloat((invTotalExGst / qty).toFixed(4)) : null;

      if (hasInvoice && !invTotalExGst) {
        toast('Invoice total (ex. GST) is required', 'error');
        return false;
      }

      // If creating a new variety inline, insert it first
      if (itemId === '__new__') {
        const crop    = modal.querySelector('#snv-crop')?.value?.trim();
        const variety = modal.querySelector('#snv-variety')?.value?.trim();
        if (!crop || !variety) {
          toast('New variety requires crop and variety name', 'error');
          return false;
        }
        let newItem;
        try {
          newItem = await dbInsert('stock_items', {
            farm_id:      farm.id,
            category:     'grain',
            is_seed:      true,
            name:         variety,
            subgroup:     crop,
            default_unit: 'bags',
            attributes:   { variety },
            active:       true,
          });
        } catch (e) {
          // Duplicate name — look up the existing item and use it
          if (e.message?.includes('23505') || e.message?.includes('duplicate key')) {
            const existing = await dbSelect('stock_items',
              `farm_id=eq.${farm.id}&name=eq.${encodeURIComponent(variety)}&is_seed=eq.true&limit=1`
            ).catch(() => []);
            newItem = existing[0];
            if (newItem) toast(`Using existing variety: ${variety}`, 'info');
          }
          if (!newItem) throw e;
        }
        itemId = newItem?.id;
        if (!itemId) { toast('Failed to create variety', 'error'); return false; }
        if (!items.find(i => i.id === itemId)) items.push(newItem);
        toast(`${variety} added`, 'success');
      }

      if (!itemId || !qty || !date) {
        toast('Variety, quantity and date are required', 'error');
        return false;
      }
      const item = items.find(i => i.id === itemId);

      // Record the delivery movement
      const movement = await dbInsert('stock_movements', {
        farm_id:       farm.id,
        item_id:       itemId,
        location_id:   locId,
        movement_type: 'delivery',
        qty,
        unit:          'kg',
        kg_per_bag:    kpb || null,
        occurred_on:   date,
        counterparty:  supplier,
        source_ref:    invNumber || null,
        note:          note || (bags ? `${bags} bags @ ${kpb} kg/bag` : '') || (supplier ? `Delivery from ${supplier}` : 'Seed delivery'),
      });

      // If invoice was provided, create invoice → line → cost match atomically
      if (hasInvoice && movement?.id) {
        const session    = getSession();
        const userId     = session?.user?.id ?? null;
        const invoice = await dbInsert('procurement_invoices', {
          farm_id:        farm.id,
          supplier:       supplier || 'Unknown supplier',
          invoice_number: invNumber,
          invoice_date:   invDate,
          total_amount:   invTotalExGst,
          created_by:     userId,
        });

        if (invoice?.id) {
          const line = await dbInsert('procurement_lines', {
            procurement_invoice_id: invoice.id,
            farm_id:                farm.id,
            item_id:                itemId,
            description:            item?.name || 'Seed',
            unit_cost:              invUnitCost,
            unit:                   'kg',
            quantity_invoiced:      qty,
            line_total:             invTotalExGst,
            gst_rate:               0,
          });

          if (line?.id) {
            await dbInsert('delivery_costs', {
              farm_id:              farm.id,
              movement_id:          movement.id,
              procurement_line_id:  line.id,
              unit_cost:            invUnitCost,
              total_cost:           invTotalExGst,
            });
          }

          // Upload attachment to Supabase Storage if provided
          if (invAttachment && invoice.id) {
            const { supabase } = await import('../../js/supabase-client.js?v=1794900620160');
            const ext  = invAttachment.name.split('.').pop();
            const path = `invoices/${farm.id}/${invoice.id}.${ext}`;
            await supabase.storage.from('procurement-attachments').upload(path, invAttachment, { upsert: true }).catch(() => {});
            await dbUpdate('procurement_invoices', invoice.id, { attachment_path: path }).catch(() => {});
          }
        }
        toast('Delivery + invoice recorded — cost matched ✓', 'success');
      } else {
        toast('Delivery recorded', 'success');
      }

      await _render(container, farm, period, allPeriods);
    }
  });

  // Wire new-variety panel, bags calculator, invoice panel
  setTimeout(() => {
    const itemEl   = document.getElementById('sdel-item');
    const newPanel = document.getElementById('sdel-new-variety-panel');

    const updateFromItem = () => {
      const isNew = itemEl?.value === '__new__';
      if (newPanel) newPanel.style.display = isNew ? 'flex' : 'none';
    };

    itemEl?.addEventListener('change', updateFromItem);
    if (preItemId) updateFromItem();

    // Bags calculator
    const useBagsCb   = document.getElementById('sdel-use-bags');
    const bagsPanel   = document.getElementById('sdel-bags-panel');
    const bagsInput   = document.getElementById('sdel-bags');
    const kpbInput    = document.getElementById('sdel-kpb');
    const qtyInput    = document.getElementById('sdel-qty');
    const bagsPreview = document.getElementById('sdel-bags-preview');

    const calcFromBags = () => {
      const bags = parseFloat(bagsInput?.value || 0);
      const kpb  = parseFloat(kpbInput?.value || 0);
      if (bags && kpb) {
        const totalKg = parseFloat((bags * kpb).toFixed(1));
        if (qtyInput) qtyInput.value = totalKg;
        if (bagsPreview) bagsPreview.textContent = `${bags} bags × ${kpb} kg = ${totalKg} kg total`;
      } else {
        if (bagsPreview) bagsPreview.textContent = '';
      }
    };

    useBagsCb?.addEventListener('change', () => {
      if (bagsPanel) bagsPanel.style.display = useBagsCb.checked ? 'block' : 'none';
      if (useBagsCb.checked) bagsInput?.focus();
    });
    bagsInput?.addEventListener('input', calcFromBags);
    kpbInput?.addEventListener('input', calcFromBags);

    // Invoice panel toggle
    const hasInvCb    = document.getElementById('sdel-has-invoice');
    const invPanel    = document.getElementById('sdel-invoice-panel');
    const invTotal    = document.getElementById('sinv-total');
    const costPreview = document.getElementById('sinv-cost-preview');

    const updateCostPreview = () => {
      const total = parseFloat(invTotal?.value || 0);
      const q     = parseFloat(document.getElementById('sdel-qty')?.value || 0);
      if (total && q) {
        const unitCost = (total / q).toFixed(4);
        if (costPreview) costPreview.textContent = `$${total.toFixed(2)} ÷ ${q} kg = $${unitCost}/kg (ex. GST)`;
      } else {
        if (costPreview) costPreview.textContent = '';
      }
    };

    invTotal?.addEventListener('input', updateCostPreview);
    document.getElementById('sdel-qty')?.addEventListener('input', updateCostPreview);

    hasInvCb?.addEventListener('change', () => {
      if (invPanel) invPanel.style.display = hasInvCb.checked ? 'flex' : 'none';
      if (hasInvCb.checked) invTotal?.focus();
    });

  }, 60);
}

// ── Movement form ──────────────────────────────────────────────────────────
async function _showMovementForm(container, farm, items, locations, preItemId, preItemName, preLocId, period, allPeriods) {
  const today = new Date().toISOString().slice(0, 10);
  const itemOpts = items.map(i =>
    `<option value="${i.id}" data-unit="${esc(i.default_unit || 'bags')}"
      ${i.id === preItemId ? ' selected' : ''}>${esc(i.name)}</option>`).join('');
  const locOpts = locations.map(l =>
    `<option value="${l.id}"${l.id === preLocId ? ' selected' : ''}>${esc(l.name)}</option>`).join('');

  openModal({
    title: 'Record seed movement',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Movement type <span style="color:var(--red)">*</span></label>
          <select class="form-select" id="sm-type">
            <option value="adjustment">Adjustment (manual count / correction)</option>
            <option value="transfer_out">Transfer out</option>
            <option value="transfer_in">Transfer in</option>
            <option value="write_off">Write-off (damaged / expired)</option>
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Variety <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="sm-item">
              <option value="">Select…</option>${itemOpts}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Location</label>
            <select class="form-select" id="sm-location">
              <option value="">No location</option>${locOpts}
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Quantity <span style="color:var(--red)">*</span></label>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="form-input" type="number" id="sm-qty" min="1" step="1" placeholder="0">
              <span id="sm-unit-label" style="font-size:13px;color:var(--hint);white-space:nowrap">bags</span>
            </div>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Date <span style="color:var(--red)">*</span></label>
            <input class="form-input" type="date" id="sm-date" value="${today}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Note / reason <span id="sm-note-required" style="color:var(--red)">*</span></label>
          <input class="form-input" type="text" id="sm-note"
            placeholder="Required for adjustments and write-offs">
        </div>
      </div>`,
    confirmLabel: 'Record movement',
    onConfirm: async (modal) => {
      const type  = modal.querySelector('#sm-type')?.value;
      const itemId = modal.querySelector('#sm-item')?.value;
      const locId  = modal.querySelector('#sm-location')?.value || null;
      const qty    = parseFloat(modal.querySelector('#sm-qty')?.value);
      const date   = modal.querySelector('#sm-date')?.value;
      const note   = modal.querySelector('#sm-note')?.value?.trim() || null;

      if (!itemId || !qty || !date) {
        toast('Variety, quantity and date are required', 'error');
        return false;
      }
      if ((type === 'adjustment' || type === 'write_off') && !note) {
        toast('A reason is required for adjustments and write-offs', 'error');
        return false;
      }

      const item = items.find(i => i.id === itemId);
      await dbInsert('stock_movements', {
        farm_id:       farm.id,
        item_id:       itemId,
        location_id:   locId,
        movement_type: type,
        qty,
        unit:          item?.default_unit || 'bags',
        occurred_on:   date,
        note,
        ...(type === 'adjustment' ? { reason_code: 'other', direction: 1 } : {}),
      });
      toast('Movement recorded', 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  setTimeout(() => {
    const itemEl  = document.getElementById('sm-item');
    const unitLbl = document.getElementById('sm-unit-label');
    itemEl?.addEventListener('change', () => {
      const opt = itemEl.options[itemEl.selectedIndex];
      if (unitLbl) unitLbl.textContent = opt?.dataset?.unit || 'bags';
    });
  }, 50);
}

// ── Auto-write usage movement when a planting session closes ──────────────
// Called from operations.js after dbUpdate('planting_sessions', session.id, { status: 'closed', ... })
//
// Logic:
//   bags session:  qty = seed_in_bags − seed_out_bags  (net consumed)
//   bulk session:  qty = seed_in_kg   − seed_out_kg    (net consumed, stored as kg)
//
// If no matching stock item exists yet, the movement is skipped (no error) so
// closing a session never fails because seed stock isn't set up yet.
export async function writeSessionSeedUsage(farm, session) {
  // Writes a PENDING (item_id=null) stub movement when a planting session is closed.
  // An admin/manager then allocates it to a specific seed stock item in the
  // Seed Stocktake module (matching the livestock unallocated-sale pattern).
  if (!farm || !session || session.status !== 'closed') return;

  // Determine qty consumed
  const isBulk = session.seed_type === 'bulk';
  let qty, unit;

  if (isBulk) {
    const inKg  = parseFloat(session.seed_in_kg) || 0;
    const outKg = parseFloat(session.seed_out_kg) || 0;
    qty  = inKg - outKg;
    unit = 'kg';
  } else {
    const inBags  = parseFloat(session.seed_in_bags) || 0;
    const outBags = parseFloat(session.seed_out_bags) || 0;
    qty  = inBags - outBags;
    unit = 'bags';
  }

  if (!qty || qty <= 0) return; // nothing consumed — skip

  // Check if a pending or allocated movement for this session already exists (idempotent)
  let existing = [];
  try {
    existing = await dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&movement_type=eq.usage&source_system=eq.operations&source_ref=eq.${session.id}`);
  } catch { /* ignore */ }

  if (existing.length > 0) return; // already written (pending or allocated)

  const sessionDate = session.session_date || session.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const fieldLabel  = `${session.field_name}${session.sub_block ? ' · ' + session.sub_block : ''}`;
  const varLabel    = session.variety ? ` (${session.variety})` : '';

  try {
    await dbInsert('stock_movements', {
      farm_id:       farm.id,
      item_id:       null,         // ← pending; admin allocates in Seed Stocktake
      location_id:   null,
      movement_type: 'usage',
      qty,
      unit,
      kg_per_bag:    parseFloat(session.kg_per_bag) || null,
      occurred_on:   sessionDate,
      note:          `Planting — ${fieldLabel}${varLabel}`,
      source_system: 'operations',
      source_ref:    session.id,
    });
  } catch (e) {
    // Failure is non-fatal — we never want seed stock to block closing a session
    console.warn('[CFM] writeSessionSeedUsage failed (non-fatal):', e.message);
  }
}
