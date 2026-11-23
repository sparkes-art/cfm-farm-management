// modules/stocktake/seed.js
// Seed stocktake section — rebuilt 2026-11 to match finalised mockup
//
// Layout (top → bottom):
//   1. Sticky page header: title + "Physical Stocktake" + "EOM Journals" buttons
//   2. Stat bar: Total on hand | Total value | Used this period | Varieties | Season
//   3. Physical stocktake alert (amber banner) — if no finalised count for period
//   4. Usage allocation section
//   5. Seed group cards (Cotton / Grass / Other)
//      └── Group header (name + kg + $ value)
//      └── Season context strip
//      └── Variety rows (name, unit cost pill, $ value pill, last moved pill, qty + bar)
//   6. Movements log
//
// Data model
// ──────────
// stock_items  (category='grain', is_seed=true)
//   subgroup         = "Cotton" / "Grass" / "Other"
//   name             = "DP 1840 B3XF 2026"
//   attributes = {
//     variety:       "DP 1840 B3XF",
//     produced_year: "2026",
//     kg_per_bag:    20,
//     unit_cost:     1.42        -- $/kg, populated from latest invoice
//   }
//
// stock_movements
//   movement_type = 'delivery'    -- seed purchase / delivery in
//   movement_type = 'usage'       -- linked to a closed planting session
//   movement_type = 'adjustment'  -- manual correction
//   source_system = 'operations'  -- on usage movements written by this module
//   source_ref    = session.id    -- UUID of the planting_session
//
// stocktake_sessions  (category='grain')
//   status: 'open' | 'submitted' | 'finalised'
//
// stocktake_counts
//   system_qty / physical_qty / variance (generated)

import { dbSelect, dbInsert, dbUpdate, dbDelete, dbDeleteWhere, getSession, dbStorageUpload } from '../../js/supabase-client.js?v=1794969436166';
import { getActiveFarm, canWrite } from '../../js/app-state.js?v=1794969436166';
import { toast, openModal, qs } from '../../js/ui.js?v=1794969436166';
import { loadCommodities, getCommodities } from '../../js/commodities.js?v=1794969436166';

// ── Formatters ────────────────────────────────────────────────────────────
const fN   = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-AU', { maximumFractionDigits: 1 });
const fKg  = n => (n == null || isNaN(n)) ? '—' : `${Math.round(n).toLocaleString('en-AU')} kg`;
const fAud = n => (n == null || isNaN(n)) ? '—' : `$${Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fRate= n => (n == null || isNaN(n)) ? '—' : `$${Number(n).toFixed(2)}/kg`;
const esc  = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ── Movement type display ──────────────────────────────────────────────────
const MOVE_LABELS = {
  delivery:    { label: 'Delivery',      color: 'var(--green)',  icon: '🚛' },
  usage:       { label: 'Planting use',  color: 'var(--blue)',   icon: '🌱' },
  adjustment:  { label: 'Adjustment',    color: 'var(--amber)',  icon: '±'  },
  write_off:   { label: 'Write-off',     color: 'var(--red)',    icon: '⚠'  },
  transfer_in: { label: 'Transfer in',   color: 'var(--blue)',   icon: '→'  },
  transfer_out:{ label: 'Transfer out',  color: 'var(--hint)',   icon: '←'  },
};

// ── Season context — hardcoded per commodity for now ──────────────────────
// Will eventually link to Agronomy / crop_calendar module
const SEASON_CONTEXT = {
  'Cotton':  'Cotton planting: Oct – Dec',
  'Grass':   'Sorghum / grass planting: Oct – Jan',
  'Other':   '',
};
const SEASON_ICON = {
  'Cotton': '🌸',
  'Grass':  '🌾',
  'Other':  '📦',
};

// ── Group colour accents ──────────────────────────────────────────────────
const GROUP_ACCENT = {
  'Cotton': { bg: '#4A6741', light: 'rgba(74,103,65,.12)', text: '#4A6741' },
  'Grass':  { bg: '#2E6B6B', light: 'rgba(46,107,107,.12)', text: '#2E6B6B' },
  'Other':  { bg: '#5B4E8A', light: 'rgba(91,78,138,.12)', text: '#5B4E8A' },
};
const groupAccent = g => GROUP_ACCENT[g] || GROUP_ACCENT['Other'];

// ── Inject module styles (once) ───────────────────────────────────────────
function _injectStyles() {
  if (document.getElementById('sd2-styles')) return;
  const s = document.createElement('style');
  s.id = 'sd2-styles';
  s.textContent = `
    .sd-pill {
      display:inline-flex;align-items:center;font-size:11px;font-weight:500;
      padding:2px 8px;border-radius:10px;gap:3px;
    }
    .sd-pill-blue  { background:var(--blue-light);  color:var(--blue-text);  }
    .sd-pill-green { background:#dcfce7; color:#15803d; }
    .sd-pill-amber { background:#fef9c3; color:#854d0e; }
    .sd-pill-hint  { background:var(--page-bg); color:var(--hint); border:1px solid var(--border-light); }
    .sd-var-row {
      display:flex;align-items:center;gap:10px;padding:10px 16px;
      border-bottom:1px solid var(--border-light);
    }
    .sd-var-row:last-child { border-bottom:none; }
    .sd-bar-track {
      height:5px;border-radius:3px;background:var(--border-light);
      flex:1;min-width:40px;overflow:hidden;
    }
    .sd-bar-fill { height:100%;border-radius:3px;transition:width .3s; }
    .sd-stat-band {
      display:flex;gap:0;border-bottom:1px solid var(--border-light);
      overflow-x:auto;
    }
    .sd-stat-cell {
      flex:1;min-width:120px;padding:14px 18px;
      border-right:1px solid var(--border-light);
    }
    .sd-stat-cell:last-child { border-right:none; }
    .sd-stat-label { font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:4px; }
    .sd-stat-value { font-size:20px;font-weight:700;color:var(--ink); }
    .sd-alert-banner {
      border-radius:10px;border:1px solid #d97706;background:#fffbeb;
      padding:14px 16px;display:flex;align-items:center;gap:12px;margin-bottom:16px;
    }
    @media (prefers-color-scheme:dark) {
      .sd-alert-banner { background:#292114;border-color:#92400e; }
      .sd-pill-green { background:#14432a; color:#4ade80; }
      .sd-pill-amber { background:#3b2a07; color:#fbbf24; }
    }
    :root[data-theme="dark"] .sd-alert-banner { background:#292114;border-color:#92400e; }
    :root[data-theme="dark"] .sd-pill-green   { background:#14432a; color:#4ade80; }
    :root[data-theme="dark"] .sd-pill-amber   { background:#3b2a07; color:#fbbf24; }
  `;
  document.head.appendChild(s);
}

// ── Entry point ────────────────────────────────────────────────────────────
export async function mountSeed(container, initialPeriod) {
  _injectStyles();
  const farm = getActiveFarm();
  container.innerHTML = `
    <div style="max-width:1200px;margin:0 auto;padding:0 0 40px" id="sd-wrap">
      <div style="padding:60px;text-align:center;color:var(--hint)">Loading seed…</div>
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
  if (!wrap) return;

  // ── Fetch data ───────────────────────────────────────────────────────────
  const [items, locations, movements, pendingPlantingMovements, procLines] = await Promise.all([
    dbSelect('stock_items',
      `farm_id=eq.${farm.id}&category=eq.grain&is_seed=eq.true&active=eq.true&order=subgroup,name`),
    dbSelect('stock_locations',
      `farm_id=eq.${farm.id}&active=eq.true&order=route_order,name`),
    dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&select=id,item_id,location_id,movement_type,signed_qty,qty,unit,kg_per_bag,occurred_on,note,source_ref,source_system,reason_code&order=occurred_on.desc`),
    dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&movement_type=eq.usage&source_system=eq.operations&item_id=is.null&select=id,movement_type,qty,unit,kg_per_bag,occurred_on,note,source_ref,source_system&order=occurred_on.desc`),
    dbSelect('procurement_lines',
      `farm_id=eq.${farm.id}&select=item_id,unit_cost,quantity_invoiced,line_total&order=created_at.desc`).catch(() => []),
  ]);

  const seedItemIds  = new Set(items.map(i => i.id));
  const seedMovements = movements.filter(m => seedItemIds.has(m.item_id));
  const locById       = Object.fromEntries(locations.map(l => [l.id, l]));

  // Build latest unit_cost per item_id from procurement_lines (most recent delivery cost)
  const procCostByItem = {};
  (procLines || []).forEach(pl => {
    if (!pl.item_id || !pl.unit_cost) return;
    if (!procCostByItem[pl.item_id]) procCostByItem[pl.item_id] = parseFloat(pl.unit_cost);
  });

  // Silently backfill item.attributes.unit_cost from procurement lines where missing
  items.forEach(item => {
    if (!item.attributes) item.attributes = {};
    if (!item.attributes.unit_cost && procCostByItem[item.id]) {
      item.attributes.unit_cost = procCostByItem[item.id];
    }
  });

  // ── Period window ────────────────────────────────────────────────────────
  const periodStart = period?.period_start;
  const periodEnd   = period?.period_end;
  const periodLabel = period
    ? new Date(period.period_start).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
    : 'All time';
  const periodMonth = period
    ? new Date(period.period_start).getMonth() + 1   // 1-12
    : new Date().getMonth() + 1;
  const periodYear  = period
    ? new Date(period.period_start).getFullYear()
    : new Date().getFullYear();

  // ── Balance calculations ─────────────────────────────────────────────────
  // All movements are stored in kg (signed_qty). Convert to bags for display.
  const closingKgByItem = {};
  const usageKgByItem   = {};
  const lastMovedByItem = {};

  items.forEach(i => { closingKgByItem[i.id] = 0; usageKgByItem[i.id] = 0; });

  seedMovements.forEach(m => {
    const qty = parseFloat(m.signed_qty) || 0;
    if (!closingKgByItem.hasOwnProperty(m.item_id)) return;
    closingKgByItem[m.item_id] = (closingKgByItem[m.item_id] || 0) + qty;
    if (!lastMovedByItem[m.item_id] || m.occurred_on > lastMovedByItem[m.item_id]) {
      lastMovedByItem[m.item_id] = m.occurred_on;
    }
  });

  const periodMoves = periodStart
    ? seedMovements.filter(m => m.occurred_on >= periodStart && m.occurred_on <= periodEnd)
    : seedMovements;

  periodMoves.forEach(m => {
    if (m.movement_type === 'usage') {
      usageKgByItem[m.item_id] = (usageKgByItem[m.item_id] || 0) + Math.abs(parseFloat(m.signed_qty) || 0);
    }
  });

  // ── Stocktake session check ──────────────────────────────────────────────
  let finalisedSession = null;
  let openSession      = null;
  try {
    const sessions = await dbSelect('stocktake_sessions',
      `farm_id=eq.${farm.id}&category=eq.grain&period_year=eq.${periodYear}&period_month=eq.${periodMonth}&order=created_at.desc&limit=5`);
    finalisedSession = sessions.find(s => s.status === 'finalised') || null;
    openSession      = sessions.find(s => s.status === 'open' || s.status === 'submitted') || null;
  } catch { /* table may not exist on older deploys */ }

  // ── Linked planting sessions ─────────────────────────────────────────────
  const usageSessionIds = [...new Set(
    periodMoves
      .filter(m => m.movement_type === 'usage' && m.source_system === 'operations' && m.source_ref)
      .map(m => m.source_ref)
  )];
  let linkedSessions = [];
  if (usageSessionIds.length > 0) {
    try {
      linkedSessions = await dbSelect('planting_sessions',
        `id=in.(${usageSessionIds.join(',')})&select=id,field_name,sub_block,commodity,variety,seed_type,kg_per_bag,seed_in_bags,seed_in_kg,seed_out_bags,seed_out_kg,status,created_at`);
    } catch { /* graceful */ }
  }
  const sessionById = Object.fromEntries(linkedSessions.map(s => [s.id, s]));

  // ── Totals ───────────────────────────────────────────────────────────────
  const totalKgOnHand   = Object.values(closingKgByItem).reduce((s, v) => s + (v > 0 ? v : 0), 0);
  const totalUsedKg     = Object.values(usageKgByItem).reduce((s, v) => s + v, 0);

  // Total value: sum across items using their latest unit_cost from delivery movement
  let totalValue = 0;
  items.forEach(item => {
    const kg = closingKgByItem[item.id] || 0;
    if (kg <= 0) return;
    const unitCost = _latestUnitCost(item, seedMovements);
    if (unitCost) totalValue += kg * unitCost;
  });

  // ── Group items by subgroup ──────────────────────────────────────────────
  const subgroups = {};
  items.forEach(item => {
    // Normalise subgroup — DB may store "Cotton Seed" or "Cotton"; unify to canonical key
    const sg = (item.subgroup || 'Other').replace(/\s+seed$/i, '').trim() || 'Other';
    if (!subgroups[sg]) subgroups[sg] = [];
    subgroups[sg].push(item);
  });

  // ── Render: page header ──────────────────────────────────────────────────
  const eomBlocked  = !finalisedSession;

  // Period selector options
  const periodOptions = allPeriods.map(p => {
    const label = new Date(p.period_start).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
    const selected = p.id === period?.id ? 'selected' : '';
    return `<option value="${esc(p.id)}" ${selected}>${esc(label)}</option>`;
  }).join('');

  const headerHtml  = `
    <div style="background:var(--navy);padding:14px 20px;display:flex;align-items:center;gap:12px;border-radius:10px 10px 0 0;margin-bottom:0;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="font-size:17px;font-weight:700;color:#fff">Seed Stocktake</div>
        <div style="font-size:12px;color:rgba(255,255,255,.55);margin-top:1px">${esc(farm.name)}</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <select id="sd-period-select" style="background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer">
          ${periodOptions || `<option value="">No periods</option>`}
        </select>
        ${canWrite() ? `
          <button class="btn btn-sm" id="sd-physical-btn"
            style="background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.25);font-size:12px">
            📋 Physical Stocktake${openSession ? ' (In progress)' : ''}
          </button>` : ''}
        <button class="btn btn-sm" id="sd-eom-btn"
          style="background:${eomBlocked ? 'rgba(255,255,255,.08)' : '#fff'};color:${eomBlocked ? 'rgba(255,255,255,.4)' : 'var(--navy)'};border:1px solid ${eomBlocked ? 'rgba(255,255,255,.12)' : '#fff'};font-size:12px;${eomBlocked ? 'cursor:not-allowed' : ''}"
          ${eomBlocked ? 'disabled title="Finalise a physical stocktake first"' : ''}>
          📄 EOM Journals
        </button>
        ${canWrite() ? `
          <button class="btn btn-sm" id="sd-add-delivery"
            style="background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.3);font-size:12px">
            + Delivery
          </button>
          <button class="btn btn-sm" id="sd-add-item"
            style="background:rgba(255,255,255,.25);color:#fff;border:1px solid rgba(255,255,255,.4);font-size:12px">
            + Add variety
          </button>` : ''}
      </div>
    </div>`;

  // ── Render: stat band ────────────────────────────────────────────────────
  const statBandHtml = `
    <div class="sd-stat-band" style="background:var(--surface);border:1px solid var(--border);border-top:none;margin-bottom:20px;border-radius:0 0 10px 10px">
      <div class="sd-stat-cell">
        <div class="sd-stat-label">Total on hand</div>
        <div class="sd-stat-value">${fKg(totalKgOnHand)}</div>
      </div>
      <div class="sd-stat-cell">
        <div class="sd-stat-label">Total value</div>
        <div class="sd-stat-value" style="color:var(--green)">${totalValue > 0 ? fAud(totalValue) : '—'}</div>
      </div>
      <div class="sd-stat-cell">
        <div class="sd-stat-label">Used this period</div>
        <div class="sd-stat-value" style="color:var(--red)">${fKg(totalUsedKg)}</div>
      </div>
      <div class="sd-stat-cell">
        <div class="sd-stat-label">Varieties</div>
        <div class="sd-stat-value" style="color:var(--blue)">${items.length}</div>
      </div>
      <div class="sd-stat-cell">
        <div class="sd-stat-label">Season</div>
        <div class="sd-stat-value" style="font-size:14px;padding-top:4px">
          ${_currentSeasonBadge(periodMonth)}
        </div>
      </div>
    </div>`;

  // ── Render: physical stocktake alert ─────────────────────────────────────
  let alertHtml = '';
  if (!finalisedSession && items.length > 0) {
    alertHtml = `
      <div class="sd-alert-banner" id="sd-stocktake-alert">
        <span style="font-size:20px;flex-shrink:0">⚠️</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:700;color:#92400e">No physical stocktake for ${esc(periodLabel)}</div>
          <div style="font-size:12px;color:#a16207;margin-top:2px">
            EOM Journals are blocked until a physical count is finalised for this period.
            ${openSession ? `A count is in progress — submit it to unblock.` : `Start a count to reconcile system quantities with what's on the ground.`}
          </div>
        </div>
        ${canWrite() ? `<button class="btn btn-sm btn-primary" id="sd-start-count-btn" style="flex-shrink:0;font-size:12px">
          ${openSession ? 'Continue Count →' : 'Start Count →'}
        </button>` : ''}
      </div>`;
  } else if (finalisedSession) {
    alertHtml = `
      <div style="border-radius:10px;border:1px solid #16a34a;background:#f0fdf4;padding:10px 16px;display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <span style="font-size:16px">✅</span>
        <div style="font-size:12px;color:#15803d;flex:1">
          Physical count finalised for ${esc(periodLabel)} — EOM Journals unlocked.
        </div>
      </div>`;
  }

  // ── Render: usage allocation section ─────────────────────────────────────
  const usageAllocHtml = _buildUsageAllocationSection(items, closingKgByItem, usageKgByItem, sessionById, periodMoves, finalisedSession);

  // ── Render: unallocated planting usages ──────────────────────────────────
  const unallocatedHtml = _buildUnallocatedPanel(pendingPlantingMovements, items, sessionById, locations);

  // ── Render: seed group cards ──────────────────────────────────────────────
  // Max kg on hand across all items (for bar scaling)
  const maxKgOnHand = Math.max(1, ...Object.values(closingKgByItem));

  const groupCardsHtml = Object.entries(subgroups).map(([sgName, sgItems]) => {
    // Normalise: items may have subgroup = "Cotton Seed" or "Cotton" — strip trailing " Seed"
    const sgKey      = sgName.replace(/\s+seed$/i, '').trim();
    const accent     = groupAccent(sgKey);
    const season     = SEASON_CONTEXT[sgKey] || '';

    // Group totals
    const sgKgOnHand = sgItems.reduce((s, i) => s + Math.max(0, closingKgByItem[i.id] || 0), 0);
    const sgUsedKg   = sgItems.reduce((s, i) => s + (usageKgByItem[i.id] || 0), 0);
    let   sgValue    = 0;
    sgItems.forEach(item => {
      const kg = closingKgByItem[item.id] || 0;
      const uc = _latestUnitCost(item, seedMovements);
      if (kg > 0 && uc) sgValue += kg * uc;
    });

    // Coverage estimate: total kg / avg seeding rate (40 kg/ha default)
    const avgSeedRate = 40;
    const coverageHa  = sgKgOnHand > 0 ? Math.round(sgKgOnHand / avgSeedRate) : null;

    // Season context pill row
    const seasonPills = season ? `
      <div style="padding:8px 16px;border-bottom:1px solid var(--border-light);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-right:2px">Season context</span>
        <span class="sd-pill sd-pill-hint">🕐 ${esc(season)}</span>
        ${coverageHa ? `<span class="sd-pill sd-pill-hint">▦ Stock covers est. ~${coverageHa} ha at ${avgSeedRate} kg/ha</span>` : ''}
        <span class="sd-pill sd-pill-hint">${sgUsedKg > 0 ? `${fKg(sgUsedKg)} used this season` : '0 kg used this season'}</span>
      </div>` : '';

    // Variety rows — sorted by kg on hand desc
    const sortedItems = [...sgItems].sort((a, b) =>
      (closingKgByItem[b.id] || 0) - (closingKgByItem[a.id] || 0));

    const varRowsHtml = sortedItems.map(item => {
      const kg       = Math.max(0, closingKgByItem[item.id] || 0);
      const kpb      = parseFloat(item.attributes?.kg_per_bag) || null;
      const unitCost = _latestUnitCost(item, seedMovements);
      const value    = unitCost && kg ? kg * unitCost : null;
      const lastMov  = lastMovedByItem[item.id] || null;
      // Scale bar within this group (not global) so small items are visible
      const sgMax    = Math.max(1, ...sortedItems.map(i => closingKgByItem[i.id] || 0));
      const barPct   = Math.round((kg / sgMax) * 100);
      const attrs    = item.attributes || {};

      // Clean display name: strip "Seed Cotton " / "Seed " prefix
      // Then strip trailing bag-size + supplier tokens like "20KG Agency CSD" / "20KS Bags"
      const rawName = item.name
        .replace(/^seed\s+cotton\s+/i, '')
        .replace(/^seed\s+/i, '')
        .trim();

      // Extract trailing "NNkg ..." or "NNks ..." token from name if no attrs.kg_per_bag
      // e.g. "SIOKRA 253B3XF V2C 20KG Agency CSD" → display "SIOKRA 253B3XF V2C", sub "20 kg bags · Agency CSD"
      let displayName = rawName;
      let nameSubParts = [];
      const bagMatch = rawName.match(/^(.*?)\s+(\d+)\s*k[gs]\b(.*)$/i);
      if (bagMatch && !attrs.kg_per_bag && !attrs.supplier) {
        displayName = bagMatch[1].trim();
        const bagKg  = parseInt(bagMatch[2]);
        const rest   = bagMatch[3].trim();
        if (bagKg)  nameSubParts.push(`${bagKg} kg bags`);
        if (rest)   nameSubParts.push(esc(rest));
      }

      // Sub-label: from attributes first, fall back to parsed name tokens
      const subParts = [];
      if (attrs.supplier)    subParts.push(esc(attrs.supplier));
      else if (nameSubParts.length) subParts.push(...nameSubParts);
      if (attrs.supplier && kpb) subParts.push(`${kpb} kg bags`); // only if supplier came from attrs
      if (attrs.source_note) subParts.push(esc(attrs.source_note));
      const subLabel = subParts.join(' · ');

      // Pills
      const costPill = unitCost
        ? `<span class="sd-pill sd-pill-blue">${fRate(unitCost)}</span>`
        : `<span class="sd-pill sd-pill-hint" style="color:var(--hint)">No cost</span>`;
      const valuePill = value
        ? `<span class="sd-pill sd-pill-green">${fAud(value)} value</span>`
        : '';
      const movedPill = lastMov
        ? `<span class="sd-pill sd-pill-hint">Last moved: ${_absDate(lastMov)}</span>`
        : `<span class="sd-pill sd-pill-hint">No movements</span>`;

      return `
        <div class="sd-var-row">
          <!-- Name + sub-label -->
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;color:var(--ink)">${esc(displayName)}</div>
            ${subLabel ? `<div style="font-size:11px;color:var(--hint);margin-top:2px">${subLabel}</div>` : ''}
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
              ${costPill}${valuePill}${movedPill}
            </div>
          </div>
          <!-- Bar + qty -->
          <div style="flex:0 0 220px;display:flex;align-items:center;gap:12px">
            <div class="sd-bar-track" style="flex:1">
              <div class="sd-bar-fill" style="width:${barPct}%;background:${accent.bg}"></div>
            </div>
            <div style="text-align:right;min-width:60px">
              <span style="font-size:16px;font-weight:700;color:var(--ink)">${Math.round(kg).toLocaleString('en-AU')}</span>
              <span style="font-size:12px;color:var(--hint)"> kg</span>
            </div>
          </div>
          <!-- Actions -->
          ${canWrite() ? `
            <div style="flex-shrink:0;display:flex;gap:4px;margin-left:8px">
              <button class="btn btn-ghost btn-sm sd-record-delivery"
                data-item-id="${item.id}" data-item-name="${esc(item.name)}"
                data-unit="${esc(item.default_unit || 'bags')}"
                data-kpb="${kpb || ''}"
                style="font-size:12px;color:var(--hint)" title="Record delivery">+</button>
              <button class="btn btn-ghost btn-sm sd-edit-item"
                data-item-id="${item.id}"
                style="font-size:12px;color:var(--hint)" title="Edit variety">✎</button>
            </div>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="card" style="margin-bottom:20px;overflow:hidden">
        <!-- Group header: light background, dot accent, qty right-aligned -->
        <div style="padding:14px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--border-light)">
          <span style="width:10px;height:10px;border-radius:50%;background:${accent.bg};flex-shrink:0;display:inline-block"></span>
          <div style="font-size:15px;font-weight:700;color:var(--ink);flex:1">${esc(sgKey)} Seed</div>
          <div style="text-align:right">
            <div>
              <span style="font-size:22px;font-weight:800;color:var(--ink)">${Math.round(sgKgOnHand).toLocaleString('en-AU')}</span>
              <span style="font-size:13px;color:${accent.text};font-weight:600"> kg on hand</span>
            </div>
            ${sgValue > 0
              ? `<div style="font-size:12px;color:var(--hint);margin-top:1px">${fAud(sgValue)} est. value</div>`
              : `<div style="font-size:12px;color:var(--hint);margin-top:1px">No cost data</div>`}
          </div>
        </div>
        <!-- Season context pills -->
        ${seasonPills}
        <!-- Variety rows -->
        <div>
          ${sgItems.length ? varRowsHtml : `
            <div style="padding:20px 16px;text-align:center;color:var(--hint);font-size:13px">
              No varieties — ${canWrite() ? `<button class="btn btn-ghost btn-sm sd-add-item" style="font-size:12px">+ Add variety</button>` : 'contact administrator to add varieties.'}
            </div>`}
        </div>
      </div>`;
  }).join('');

  // ── Render: movements log ─────────────────────────────────────────────────
  const logRows = periodMoves.slice(0, 50).map(m => {
    const item    = items.find(i => i.id === m.item_id);
    const mt      = MOVE_LABELS[m.movement_type] || { label: m.movement_type, color: 'var(--hint)', icon: '·' };
    const qty     = parseFloat(m.signed_qty) || 0;
    const kpb     = parseFloat(m.kg_per_bag) || parseFloat(item?.attributes?.kg_per_bag) || null;
    const bags    = kpb ? Math.round(Math.abs(qty) / kpb) : null;
    const qtyTxt  = bags !== null
      ? `${qty > 0 ? '+' : '−'}${fN(bags)} bags<br><span style="font-size:10px;color:var(--hint)">${fKg(Math.abs(qty))}</span>`
      : `${qty > 0 ? '+' : ''}${fKg(qty)}`;
    const refNote = m.source_system === 'operations' && m.source_ref
      ? `Planting: ${sessionById[m.source_ref]?.field_name || m.source_ref.slice(0, 8) + '…'}`
      : (m.note || '');
    const canDel  = canWrite() && m.movement_type !== 'usage';
    return `<tr style="border-bottom:1px solid var(--border-light);font-size:12px">
      <td style="padding:8px 12px;color:var(--hint);white-space:nowrap">${m.occurred_on}</td>
      <td style="padding:8px 12px;font-weight:500;color:var(--ink)">${item ? esc(item.name) : '—'}</td>
      <td style="padding:8px 12px;color:${mt.color};white-space:nowrap">${mt.icon} ${mt.label}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:600;color:${qty > 0 ? 'var(--green)' : 'var(--red)'}">
        ${qtyTxt}
      </td>
      <td style="padding:8px 12px;color:var(--hint);max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(refNote)}</td>
      <td style="padding:8px 4px;text-align:right">
        ${canDel ? `<button class="btn btn-ghost btn-sm sd-delete-move"
          data-move-id="${m.id}" data-label="${esc(`${mt.label} ${item?.name || ''} ${m.occurred_on}`)}"
          style="font-size:11px;color:var(--red);padding:2px 6px" title="Delete">✕</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  const movementsLogHtml = periodMoves.length ? `
    <div class="card" style="margin-top:8px;overflow:hidden">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <h2 style="margin:0">Movements — ${esc(periodLabel)}</h2>
        <span style="font-size:12px;color:var(--hint)">${periodMoves.length} movement${periodMoves.length !== 1 ? 's' : ''}</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
            ${['Date','Variety','Type','Qty','Note',''].map((h,i) =>
              `<th style="padding:7px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:${i===3?'right':'left'}">${h}</th>`
            ).join('')}
          </tr>
        </thead>
        <tbody>${logRows}</tbody>
      </table>
    </div>` : '';

  // ── Empty state ───────────────────────────────────────────────────────────
  const emptyHtml = !items.length ? `
    <div class="card" style="padding:48px 24px;text-align:center;margin-top:0">
      <div style="font-size:40px;margin-bottom:12px">🌱</div>
      <p style="font-size:15px;font-weight:600;color:var(--ink);margin-bottom:6px">No seed varieties set up</p>
      <p style="font-size:13px;color:var(--muted);margin-bottom:16px">Add a seed variety to track on-hand stock and link to planting sessions.</p>
      ${canWrite() ? `<button class="btn btn-primary" id="sd-add-item-empty">+ Add seed variety</button>` : ''}
    </div>` : '';

  // ── Assemble ──────────────────────────────────────────────────────────────
  wrap.innerHTML =
    headerHtml +
    statBandHtml +
    alertHtml +
    usageAllocHtml +
    unallocatedHtml +
    (items.length ? groupCardsHtml : emptyHtml) +
    movementsLogHtml;

  _wireButtons(container, wrap, farm, items, locations, period, allPeriods, sessionById, pendingPlantingMovements, openSession);
}

// ── Usage allocation section ───────────────────────────────────────────────
function _buildUsageAllocationSection(items, closingKgByItem, usageKgByItem, sessionById, periodMoves, finalisedSession) {
  // Build WAC-style rows: crop group → varieties with usage this period
  const usageRows = [];
  items.forEach(item => {
    const usedKg = usageKgByItem[item.id] || 0;
    if (usedKg <= 0) return;
    const unitCost   = _latestUnitCost(item, periodMoves.filter(m => m.item_id === item.id));
    const totalCost  = unitCost ? usedKg * unitCost : null;
    usageRows.push({ item, usedKg, unitCost, totalCost });
  });

  const hasUsage = usageRows.length > 0;

  const tableHtml = hasUsage ? `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead>
        <tr style="border-bottom:1px solid var(--border);background:var(--page-bg)">
          ${['Crop','Variety','Used (kg)','Rate ($/kg)','Total cost'].map(h =>
            `<th style="padding:7px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:${h==='Used (kg)'||h==='Rate ($/kg)'||h==='Total cost'?'right':'left'}">${h}</th>`
          ).join('')}
        </tr>
      </thead>
      <tbody>
        ${usageRows.map(r => `
          <tr style="border-bottom:1px solid var(--border-light)">
            <td style="padding:9px 14px;color:var(--hint)">${esc(r.item.subgroup || '—')}</td>
            <td style="padding:9px 14px;font-weight:500;color:var(--ink)">${esc(r.item.name)}</td>
            <td style="padding:9px 14px;text-align:right;font-weight:600;color:var(--red)">${fKg(r.usedKg)}</td>
            <td style="padding:9px 14px;text-align:right;color:var(--hint)">${r.unitCost ? fRate(r.unitCost) : '—'}</td>
            <td style="padding:9px 14px;text-align:right;font-weight:600;color:var(--ink)">${r.totalCost ? fAud(r.totalCost) : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>` : `
    <div style="padding:20px 16px;text-align:center;color:var(--hint);font-size:13px;opacity:.7">
      No seed usage recorded this period — usage will appear here as planting sessions are closed.
    </div>`;

  const totalCostAll = usageRows.reduce((s, r) => s + (r.totalCost || 0), 0);

  return `
    <div class="card" style="margin-bottom:16px;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border)">
        <div>
          <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-mid)">Usage Allocation</span>
          <span style="font-size:11px;color:var(--hint);margin-left:8px">Seed costs by crop this period</span>
        </div>
        ${totalCostAll > 0 ? `<span style="font-size:13px;font-weight:700;color:var(--ink)">${fAud(totalCostAll)} total</span>` : ''}
      </div>
      ${tableHtml}
      ${!finalisedSession ? `
        <div style="padding:8px 16px;border-top:1px solid var(--border-light);background:var(--page-bg);font-size:11px;color:var(--hint)">
          WAC (Weighted Average Cost) reconciliation will be enabled once a physical stocktake is finalised.
        </div>` : ''}
    </div>`;
}

// ── Unallocated planting usages panel ─────────────────────────────────────
function _buildUnallocatedPanel(pendingMovements, items, sessionById, locations = []) {
  if (!pendingMovements?.length) return '';

  const locOpts = locations.map(l =>
    `<option value="${l.id}">${esc(l.name)}</option>`).join('');

  const fQty = m => {
    const q = parseFloat(m.qty) || 0;
    if (m.unit === 'bags') return `${fN(q)} bags${m.kg_per_bag ? ` (${fN(q * m.kg_per_bag)} kg)` : ''}`;
    if (m.unit === 'kg')   return `${fN(q)} kg`;
    if (m.unit === 't')    return `${fN(q)} t`;
    return `${fN(q)} ${m.unit || ''}`;
  };

  const rows = pendingMovements.map(m => {
    const session = sessionById[m.source_ref] || {};
    const field   = session.field_name ? `${esc(session.field_name)}${session.sub_block ? ' · ' + esc(session.sub_block) : ''}` : '—';
    return `
      <div style="display:grid;grid-template-columns:90px 1fr 80px 1fr 110px;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border-light);align-items:center;font-size:12px">
        <div style="color:var(--hint)">${m.occurred_on || '—'}</div>
        <div>
          <div style="font-weight:600;color:var(--ink)">${field}</div>
          <div style="font-size:11px;color:var(--hint)">${esc(session.commodity || '—')}</div>
        </div>
        <div style="font-weight:600;color:var(--ink)">${fQty(m)}</div>
        ${locations.length
          ? `<div><select class="form-select sd-alloc-loc" data-movement-id="${m.id}" style="font-size:11px;width:100%">
               <option value="">Select location…</option>${locOpts}
             </select></div>
             <div><button class="btn btn-sm btn-primary sd-alloc-btn" data-movement-id="${m.id}"
               style="font-size:11px;opacity:.4;pointer-events:none;white-space:nowrap">Allocate →</button></div>`
          : `<div style="color:var(--hint);font-size:11px">No locations set up</div><div></div>`}
      </div>`;
  }).join('');

  return `
    <div class="card" style="margin-bottom:16px;overflow:hidden;border:2px solid var(--amber)">
      <div style="padding:10px 16px;border-bottom:1px solid var(--border);background:#fffbeb;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#92400e">
          ⚡ ${pendingMovements.length} planting session${pendingMovements.length !== 1 ? 's' : ''} awaiting seed allocation
        </span>
        <span style="font-size:11px;color:#92400e">Assign each to a seed variety to update the stocktake</span>
      </div>
      ${rows}
    </div>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Latest unit_cost from item attributes ($/kg), set when a delivery invoice is recorded */
function _latestUnitCost(item, _movements) {
  // unit_cost is stored in item.attributes when a delivery invoice is matched
  const attrs = item?.attributes || {};
  const attrCost = parseFloat(attrs.unit_cost);
  if (attrCost && !isNaN(attrCost)) return attrCost;
  return null;
}

/** Human-readable relative date */
/** Absolute date display: "1 Jul 2026" */
function _absDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function _relDate(dateStr) {
  if (!dateStr) return '—';
  const d    = new Date(dateStr);
  const now  = new Date();
  const days = Math.floor((now - d) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
}

/** Season badge based on current period month */
function _currentSeasonBadge(month) {
  if (month >= 10 || month <= 1) return '🌱 Planting';
  if (month >= 2 && month <= 4)  return '🌿 Growing';
  if (month >= 5 && month <= 7)  return '🌾 Harvest';
  return '📋 Off-season';
}

// ── Wire event listeners ───────────────────────────────────────────────────
function _wireButtons(container, wrap, farm, items, locations, period, allPeriods, sessionById, pendingPlantingMovements, openSession) {

  // Header buttons
  // Period selector
  wrap.querySelector('#sd-period-select')?.addEventListener('change', e => {
    const selectedId = e.target.value;
    const selectedPeriod = allPeriods.find(p => p.id === selectedId) || null;
    _render(container, farm, selectedPeriod, allPeriods);
  });

  wrap.querySelector('#sd-add-item')?.addEventListener('click',
    () => _showAddVarietyForm(container, farm, items, period, allPeriods));
  wrap.querySelector('#sd-add-item-empty')?.addEventListener('click',
    () => _showAddVarietyForm(container, farm, items, period, allPeriods));
  wrap.querySelector('#sd-add-delivery')?.addEventListener('click',
    () => _showDeliveryForm(container, farm, items, locations, null, null, period, allPeriods));

  wrap.querySelector('#sd-physical-btn')?.addEventListener('click',
    () => _openPhysicalStocktakeFlow(container, farm, items, period, allPeriods, openSession));

  wrap.querySelector('#sd-eom-btn')?.addEventListener('click', () => {
    // EOM Journals — placeholder until full Xero integration
    toast('EOM Journals: coming soon — will push manual journal entries to Xero.', 'info');
  });

  wrap.querySelector('#sd-start-count-btn')?.addEventListener('click',
    () => _openPhysicalStocktakeFlow(container, farm, items, period, allPeriods, openSession));

  // Variety row buttons
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

  // Delete movement
  wrap.querySelectorAll('.sd-delete-move').forEach(btn => {
    btn.addEventListener('click', async () => {
      const moveId = btn.dataset.moveId;
      const label  = btn.dataset.label || 'this movement';
      if (!confirm(`Delete movement: ${label}?\n\nThis cannot be undone.`)) return;
      btn.disabled = true;
      try {
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
      btn.style.opacity       = sel.value ? '1'    : '.4';
      btn.style.pointerEvents = sel.value ? 'auto' : 'none';
    });
  });

  wrap.querySelectorAll('.sd-alloc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const movId = btn.dataset.movementId;
      const locId = wrap.querySelector(`.sd-alloc-loc[data-movement-id="${movId}"]`)?.value;
      if (!locId) return;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        const mov = pendingPlantingMovements.find(m => m.id === movId);
        let itemId = null;
        if (mov?.source_ref) {
          const rows = await dbSelect('planting_rows',
            `session_id=eq.${mov.source_ref}&seed_item_id=not.is.null&select=seed_item_id&limit=1`
          ).catch(() => []);
          itemId = rows[0]?.seed_item_id || null;
        }
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

// ── Physical stocktake flow (Option C: hybrid blind count) ────────────────
async function _openPhysicalStocktakeFlow(container, farm, items, period, allPeriods, existingSession) {
  const periodYear  = period ? new Date(period.period_start).getFullYear() : new Date().getFullYear();
  const periodMonth = period ? new Date(period.period_start).getMonth() + 1 : new Date().getMonth() + 1;
  const periodLabel = period
    ? new Date(period.period_start).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })
    : new Date().toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });

  // If there's an open session, load its counts and show the count entry UI
  if (existingSession) {
    await _showCountEntryUI(container, farm, items, period, allPeriods, existingSession, periodLabel);
    return;
  }

  // No session — confirm start
  openModal({
    title: '📋 Start Physical Stocktake',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="background:var(--page-bg);border-radius:8px;padding:14px;border:1px solid var(--border)">
          <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:6px">How it works</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6">
            You'll see each seed variety and its location — but <strong>not the system quantity</strong>.<br>
            Enter the physical count you observe on the ground.<br>
            After submitting, the system will show variances and you can finalise the count.
          </div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--hint);margin-bottom:4px">Period</div>
          <div style="font-size:14px;font-weight:600;color:var(--ink)">${esc(periodLabel)}</div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--hint);margin-bottom:4px">Items to count</div>
          <div style="font-size:14px;font-weight:600;color:var(--ink)">${items.length} seed variet${items.length !== 1 ? 'ies' : 'y'}</div>
        </div>
        <div class="form-group" style="margin:0">
          <label class="form-label">Notes (optional)</label>
          <input class="form-input" id="st-notes" type="text" placeholder="e.g. Pre-harvest check, end of month count">
        </div>
      </div>`,
    confirmLabel: 'Start Count',
    onConfirm: async modal => {
      const notes = modal.querySelector('#st-notes')?.value?.trim() || null;
      const userSession = getSession();
      let session;
      try {
        session = await dbInsert('stocktake_sessions', {
          farm_id:      farm.id,
          period_year:  periodYear,
          period_month: periodMonth,
          category:     'grain',
          status:       'open',
          initiated_by: userSession?.user?.id || null,
          notes,
        });
      } catch (e) {
        toast('Failed to create count session: ' + e.message, 'error');
        return false;
      }

      // Snapshot system quantities into stocktake_counts
      const userSess = getSession();
      try {
        // Calculate current qty for each item (all movements up to now)
        const movements = await dbSelect('stock_movements',
          `farm_id=eq.${farm.id}&select=item_id,signed_qty,occurred_on&order=occurred_on.asc`);
        const qtyMap = {};
        movements.forEach(m => {
          if (!qtyMap[m.item_id]) qtyMap[m.item_id] = 0;
          qtyMap[m.item_id] += parseFloat(m.signed_qty) || 0;
        });

        for (const item of items) {
          const systemQty = Math.max(0, qtyMap[item.id] || 0);
          await dbInsert('stocktake_counts', {
            session_id:  session.id,
            item_id:     item.id,
            system_qty:  systemQty,
            unit:        'kg',
          });
        }
      } catch (e) {
        console.warn('[CFM] Failed to snapshot stocktake counts:', e.message);
      }

      toast('Physical count started — enter quantities below', 'success');
      await _render(container, farm, period, allPeriods);
      // Refresh and show the count UI
      const freshSessions = await dbSelect('stocktake_sessions',
        `farm_id=eq.${farm.id}&category=eq.grain&period_year=eq.${periodYear}&period_month=eq.${periodMonth}&order=created_at.desc&limit=1`
      ).catch(() => []);
      const freshSession = freshSessions[0] || session;
      await _showCountEntryUI(container, farm, items, period, allPeriods, freshSession, periodLabel);
    }
  });
}

// ── Count entry UI (Option C blind count) ─────────────────────────────────
async function _showCountEntryUI(container, farm, items, period, allPeriods, session, periodLabel) {
  // Load existing counts for this session
  let counts = [];
  try {
    counts = await dbSelect('stocktake_counts', `session_id=eq.${session.id}`);
  } catch (e) {
    toast('Failed to load count data: ' + e.message, 'error');
    return;
  }
  const countByItem = Object.fromEntries(counts.map(c => [c.item_id, c]));

  const isSubmitted = session.status === 'submitted';
  const isOpen      = session.status === 'open';

  const rowsHtml = items.map(item => {
    const count   = countByItem[item.id];
    const kpb     = parseFloat(item.attributes?.kg_per_bag) || null;
    const hasCount= count?.physical_qty != null;
    const variance= hasCount ? (count.physical_qty - count.system_qty) : null;

    // Show system qty only once submitted
    const systemDisplay = isSubmitted && count
      ? `<span style="font-size:12px;color:var(--hint)">${fKg(count.system_qty)}</span>`
      : `<span style="font-size:12px;color:var(--hint)">Hidden until submitted</span>`;

    const varianceDisplay = (isSubmitted && variance != null)
      ? `<span style="font-weight:600;color:${Math.abs(variance) < 1 ? 'var(--green)' : variance > 0 ? 'var(--blue)' : 'var(--red)'}">
           ${variance > 0 ? '+' : ''}${fKg(variance)}
         </span>`
      : '—';

    return `
      <tr style="border-bottom:1px solid var(--border-light)">
        <td style="padding:10px 14px">
          <div style="font-weight:600;font-size:13px;color:var(--ink)">${esc(item.name)}</div>
          <div style="font-size:11px;color:var(--hint)">${esc(item.subgroup || '')}${kpb ? ` · ${kpb} kg/bag` : ''}</div>
        </td>
        <td style="padding:10px 14px;text-align:center">${systemDisplay}</td>
        <td style="padding:10px 14px">
          ${isOpen ? `
            <div style="display:flex;gap:6px;align-items:center">
              <input class="form-input sd-count-input" type="number" min="0" step="1"
                data-item-id="${item.id}" data-count-id="${count?.id || ''}"
                value="${hasCount ? count.physical_qty : ''}"
                placeholder="Enter kg…"
                style="width:110px;font-size:13px;text-align:right">
              <span style="font-size:12px;color:var(--hint)">kg</span>
              ${kpb ? `<span style="font-size:11px;color:var(--hint)">(${kpb} kg/bag)</span>` : ''}
            </div>` : `
            <span style="font-size:13px;font-weight:600;color:var(--ink)">${hasCount ? fKg(count.physical_qty) : '—'}</span>`}
        </td>
        <td style="padding:10px 14px;text-align:center">${varianceDisplay}</td>
      </tr>`;
  }).join('');

  openModal({
    title: `📋 Physical Stocktake — ${periodLabel}`,
    wide: true,
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:0">
        ${isSubmitted ? `
          <div style="background:#fef3c7;border:1px solid #d97706;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:12px;color:#92400e">
            Count submitted. Review variances and finalise to unlock EOM Journals.
          </div>` : `
          <div style="background:var(--page-bg);border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:12px;color:var(--hint);border:1px solid var(--border)">
            Count mode — enter the quantity you physically observe for each variety. System quantities are hidden until you submit.
          </div>`}
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--page-bg);border-bottom:1px solid var(--border)">
              <th style="padding:8px 14px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Variety</th>
              <th style="padding:8px 14px;text-align:center;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">System qty</th>
              <th style="padding:8px 14px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Your count</th>
              <th style="padding:8px 14px;text-align:center;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint)">Variance</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>`,
    confirmLabel: isOpen ? 'Save & Submit Count' : 'Finalise & Unlock EOM Journals',
    cancelLabel: isOpen ? 'Save Draft' : 'Close',
    onConfirm: async modal => {
      if (isOpen) {
        // Save all counts then submit
        const inputs = modal.querySelectorAll('.sd-count-input');
        let allFilled = true;
        for (const input of inputs) {
          const itemId  = input.dataset.itemId;
          const countId = input.dataset.countId;
          const val     = input.value.trim();
          if (!val) { allFilled = false; continue; }
          const physicalQty = parseFloat(val);
          if (countId) {
            await dbUpdate('stocktake_counts', countId, {
              physical_qty: physicalQty,
              counted_at:   new Date().toISOString(),
            }).catch(e => console.warn('Count update failed:', e.message));
          }
        }
        if (!allFilled) {
          const proceed = confirm('Some varieties have no count entered. Submit anyway with those as blank?');
          if (!proceed) return false;
        }
        // Submit session
        await dbUpdate('stocktake_sessions', session.id, {
          status:       'submitted',
          submitted_at: new Date().toISOString(),
        });
        toast('Count submitted — review variances', 'success');
        await _render(container, farm, period, allPeriods);
        // Reopen for review
        const freshSessions = await dbSelect('stocktake_sessions',
          `id=eq.${session.id}&limit=1`).catch(() => []);
        if (freshSessions[0]) {
          await _showCountEntryUI(container, farm, items, period, allPeriods, freshSessions[0],
            period ? new Date(period.period_start).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }) : '');
        }
      } else if (isSubmitted) {
        // Finalise
        await dbUpdate('stocktake_sessions', session.id, {
          status:        'finalised',
          finalised_at:  new Date().toISOString(),
          finalised_by:  getSession()?.user?.id || null,
        });
        toast('Stocktake finalised — EOM Journals now available', 'success');
        await _render(container, farm, period, allPeriods);
      }
    },
  });
}

// ── Add seed variety form ──────────────────────────────────────────────────
async function _showAddVarietyForm(container, farm, existingItems, period, allPeriods) {
  await loadCommodities(farm.id);
  const commodities = getCommodities();
  const cropOpts = commodities.map(c =>
    `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');

  openModal({
    title: 'Add seed variety',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Crop <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="sv-crop">
              <option value="">Select crop…</option>${cropOpts}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Variety <span style="color:var(--red)">*</span></label>
            <input class="form-input" id="sv-variety" type="text" placeholder="e.g. DP 1840 B3XF">
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
            <input class="form-input" id="sv-kpb" type="number" min="1" step="0.1" placeholder="e.g. 20">
            <div style="font-size:10px;color:var(--hint);margin-top:2px">For kg ↔ bags conversion</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Supplier description <span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--hint)">— raw invoice text</span></label>
          <input class="form-input" id="sv-supplier-desc" type="text" placeholder="e.g. SEED COTTON SIC 711RRF V2C 20KG AGENCY CS">
        </div>
        <div class="form-group">
          <label class="form-label">Internal notes (optional)</label>
          <input class="form-input" id="sv-notes" type="text" placeholder="e.g. Treated with Gaucho, batch number">
        </div>
      </div>`,
    confirmLabel: 'Add variety',
    onConfirm: async modal => {
      const crop         = modal.querySelector('#sv-crop')?.value?.trim();
      const variety      = modal.querySelector('#sv-variety')?.value?.trim();
      const unit         = modal.querySelector('#sv-unit')?.value;
      const kpb          = parseFloat(modal.querySelector('#sv-kpb')?.value) || null;
      const supplierDesc = modal.querySelector('#sv-supplier-desc')?.value?.trim() || null;
      const notes        = modal.querySelector('#sv-notes')?.value?.trim() || null;
      if (!crop || !variety) { toast('Crop and variety are required', 'error'); return false; }
      await dbInsert('stock_items', {
        farm_id:      farm.id,
        category:     'grain',
        is_seed:      true,
        name:         variety,
        subgroup:     crop,
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
    const toggle  = () => { if (kpbWrap) kpbWrap.style.display = unitEl?.value === 'bags' ? '' : 'none'; };
    unitEl?.addEventListener('change', toggle);
    toggle();
  }, 50);
}

// ── Edit seed variety form ────────────────────────────────────────────────
async function _showEditVarietyForm(container, farm, item, allItems, period, allPeriods) {
  await loadCommodities(farm.id);
  const commodities   = getCommodities();
  const attrs         = item.attributes || {};
  const currentCrop   = item.subgroup || '';
  const currentVariety= attrs.variety || item.name;
  const currentUnit   = item.default_unit || 'bags';
  const currentKpb    = parseFloat(attrs.kg_per_bag) || '';

  const cropOpts = commodities.map(c =>
    `<option value="${esc(c.name)}"${c.name === currentCrop ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

  openModal({
    title: 'Edit seed variety',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Crop <span style="color:var(--red)">*</span></label>
            <select class="form-select" id="ev-crop"><option value="">Select crop…</option>${cropOpts}</select>
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
            <input class="form-input" id="ev-kpb" type="number" min="1" step="0.1" value="${currentKpb}" placeholder="e.g. 20">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Unit cost ($/kg)</label>
            <input class="form-input" id="ev-unit-cost" type="number" min="0" step="0.01"
              value="${esc(attrs.unit_cost || '')}" placeholder="e.g. 14.45">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Supplier description</label>
            <input class="form-input" id="ev-supplier-desc" type="text" value="${esc(attrs.supplier_description || '')}" placeholder="e.g. Agency CSD">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Internal notes (optional)</label>
          <input class="form-input" id="ev-notes" type="text" value="${esc(item.notes || '')}">
        </div>
      </div>`,
    confirmLabel: 'Save changes',
    onConfirm: async modal => {
      const crop         = modal.querySelector('#ev-crop')?.value?.trim();
      const variety      = modal.querySelector('#ev-variety')?.value?.trim();
      const unit         = modal.querySelector('#ev-unit')?.value;
      const kpb          = parseFloat(modal.querySelector('#ev-kpb')?.value) || null;
      const unitCostRaw  = modal.querySelector('#ev-unit-cost')?.value?.trim();
      const unitCost     = unitCostRaw ? parseFloat(unitCostRaw) : null;
      const supplierDesc = modal.querySelector('#ev-supplier-desc')?.value?.trim() || null;
      const notes        = modal.querySelector('#ev-notes')?.value?.trim() || null;
      if (!crop || !variety) { toast('Crop and variety are required', 'error'); return false; }
      await dbUpdate('stock_items', item.id, {
        name:         variety,
        subgroup:     crop,
        default_unit: unit,
        attributes:   { ...attrs, variety, supplier_description: supplierDesc, ...(kpb ? { kg_per_bag: kpb } : { kg_per_bag: null }), ...(unitCost ? { unit_cost: unitCost } : { unit_cost: null }) },
        notes,
      });
      toast('Variety updated', 'success');
      await _render(container, farm, period, allPeriods);
    }
  });

  setTimeout(() => {
    const unitEl  = document.getElementById('ev-unit');
    const kpbWrap = document.getElementById('ev-kpb-wrap');
    const toggle  = () => { if (kpbWrap) kpbWrap.style.display = unitEl?.value === 'bags' ? '' : 'none'; };
    unitEl?.addEventListener('change', toggle);
    toggle();
  }, 50);
}

// ── Delivery form ──────────────────────────────────────────────────────────
async function _showDeliveryForm(container, farm, items, locations, preItemId, preItemName, period, allPeriods) {
  const today   = new Date().toISOString().slice(0, 10);
  const itemOpts= items.map(i =>
    `<option value="${i.id}"${i.id === preItemId ? ' selected' : ''}>${esc(i.subgroup || '')} — ${esc(i.name)}</option>`).join('');
  const locOpts = locations.map(l =>
    `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  await loadCommodities(farm.id);
  const cropOpts = getCommodities().map(c =>
    `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');

  openModal({
    title: 'Record seed delivery',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Seed variety <span style="color:var(--red)">*</span></label>
          <select class="form-select" id="sdel-item">
            <option value="">Select variety…</option>${itemOpts}
            <option value="__new__" style="color:var(--blue);font-weight:500">＋ New variety…</option>
          </select>
        </div>
        <div id="sdel-new-variety-panel" style="display:none;background:var(--page-bg);border:1px solid var(--border);border-radius:8px;padding:14px;flex-direction:column;gap:12px">
          <div style="font-size:12px;font-weight:600;color:var(--blue);text-transform:uppercase;letter-spacing:.04em">New variety</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div class="form-group" style="margin:0">
              <label class="form-label">Crop <span style="color:var(--red)">*</span></label>
              <select class="form-select" id="snv-crop"><option value="">Select crop…</option>${cropOpts}</select>
            </div>
            <div class="form-group" style="margin:0">
              <label class="form-label">Variety name <span style="color:var(--red)">*</span></label>
              <input class="form-input" id="snv-variety" type="text" placeholder="e.g. DP 1840 B3XF">
            </div>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:7px;cursor:pointer;font-size:12px;font-weight:600;color:var(--ink-mid)">
          <input type="checkbox" id="sdel-use-bags" style="accent-color:var(--blue);width:13px;height:13px">
          Delivery in bags
        </label>
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
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Storage location</label>
            <select class="form-select" id="sdel-location">
              <option value="">No specific location</option>${locOpts}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Delivery date <span style="color:var(--red)">*</span></label>
            <input class="form-input" type="date" id="sdel-date" value="${today}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Supplier / docket</label>
          <input class="form-input" type="text" id="sdel-supplier" placeholder="Supplier name or docket number">
        </div>
        <div class="form-group">
          <label class="form-label">Internal note</label>
          <input class="form-input" type="text" id="sdel-note" placeholder="Optional">
        </div>
        <div style="border-top:1px solid var(--border);padding-top:12px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:500;color:var(--ink-mid)">
            <input type="checkbox" id="sdel-has-invoice" style="accent-color:var(--blue);width:15px;height:15px">
            Invoice received with this delivery
          </label>
        </div>
        <div id="sdel-invoice-panel" style="display:none;background:var(--page-bg);border:1px solid var(--border);border-radius:8px;padding:14px;flex-direction:column;gap:12px">
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
    onConfirm: async modal => {
      const itemSel    = modal.querySelector('#sdel-item');
      let   itemId     = itemSel?.value;
      const locId      = modal.querySelector('#sdel-location')?.value || null;
      const qty        = parseFloat(modal.querySelector('#sdel-qty')?.value);
      const date       = modal.querySelector('#sdel-date')?.value;
      const supplier   = modal.querySelector('#sdel-supplier')?.value?.trim() || null;
      const note       = modal.querySelector('#sdel-note')?.value?.trim() || null;
      const hasInvoice = modal.querySelector('#sdel-has-invoice')?.checked;
      const useBags    = modal.querySelector('#sdel-use-bags')?.checked;
      const bags       = useBags ? (parseFloat(modal.querySelector('#sdel-bags')?.value) || null) : null;
      const kpb        = useBags ? (parseFloat(modal.querySelector('#sdel-kpb')?.value) || null) : null;
      const invNumber     = modal.querySelector('#sinv-number')?.value?.trim() || null;
      const invDate       = modal.querySelector('#sinv-date')?.value || date;
      const invTotalExGst = parseFloat(modal.querySelector('#sinv-total')?.value) || null;
      const invAttachment = modal.querySelector('#sinv-attachment')?.files?.[0] || null;
      const invUnitCost   = (invTotalExGst && qty) ? parseFloat((invTotalExGst / qty).toFixed(4)) : null;

      if (hasInvoice && !invTotalExGst) { toast('Invoice total (ex. GST) is required', 'error'); return false; }

      if (itemId === '__new__') {
        const crop    = modal.querySelector('#snv-crop')?.value?.trim();
        const variety = modal.querySelector('#snv-variety')?.value?.trim();
        if (!crop || !variety) { toast('New variety requires crop and variety name', 'error'); return false; }
        let newItem;
        try {
          newItem = await dbInsert('stock_items', {
            farm_id: farm.id, category: 'grain', is_seed: true,
            name: variety, subgroup: crop, default_unit: 'bags',
            attributes: { variety }, active: true,
          });
        } catch (e) {
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

      if (!itemId || !qty || !date) { toast('Variety, quantity and date are required', 'error'); return false; }
      const item = items.find(i => i.id === itemId);

      const movement = await dbInsert('stock_movements', {
        farm_id:       farm.id,
        item_id:       itemId,
        location_id:   locId,
        movement_type: 'delivery',
        qty,
        unit:          'kg',
        kg_per_bag:    kpb || null,
        unit_cost:     invUnitCost,
        occurred_on:   date,
        counterparty:  supplier,
        source_ref:    invNumber || null,
        note:          note || (bags ? `${bags} bags @ ${kpb} kg/bag` : '') || (supplier ? `Delivery from ${supplier}` : 'Seed delivery'),
      });

      // Update item's stored unit_cost for future display
      if (invUnitCost) {
        await dbUpdate('stock_items', itemId, {
          attributes: { ...(item?.attributes || {}), unit_cost: invUnitCost },
        }).catch(() => {});
      }

      if (hasInvoice && movement?.id) {
        const userSess = getSession();
        const invoice  = await dbInsert('procurement_invoices', {
          farm_id: farm.id, supplier: supplier || 'Unknown supplier',
          invoice_number: invNumber, invoice_date: invDate,
          total_amount: invTotalExGst, created_by: userSess?.user?.id ?? null,
        });
        if (invoice?.id) {
          const line = await dbInsert('procurement_lines', {
            procurement_invoice_id: invoice.id, farm_id: farm.id,
            item_id: itemId, description: item?.name || 'Seed',
            unit_cost: invUnitCost, unit: 'kg',
            quantity_invoiced: qty, line_total: invTotalExGst, gst_rate: 0,
          });
          if (line?.id) {
            await dbInsert('delivery_costs', {
              farm_id: farm.id, movement_id: movement.id,
              procurement_line_id: line.id,
              unit_cost: invUnitCost, total_cost: invTotalExGst,
            });
          }
          if (invAttachment) {
            const ext  = invAttachment.name.split('.').pop();
            const path = `invoices/${farm.id}/${invoice.id}.${ext}`;
            await dbStorageUpload('procurement-attachments', path, invAttachment).catch(() => {});
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
    itemEl?.addEventListener('change', () => {
      if (newPanel) newPanel.style.display = itemEl.value === '__new__' ? 'flex' : 'none';
    });

    const useBagsCb   = document.getElementById('sdel-use-bags');
    const bagsPanel   = document.getElementById('sdel-bags-panel');
    const bagsInput   = document.getElementById('sdel-bags');
    const kpbInput    = document.getElementById('sdel-kpb');
    const qtyInput    = document.getElementById('sdel-qty');
    const bagsPreview = document.getElementById('sdel-bags-preview');

    const calcFromBags = () => {
      const b = parseFloat(bagsInput?.value || 0);
      const k = parseFloat(kpbInput?.value || 0);
      if (b && k) {
        const totalKg = parseFloat((b * k).toFixed(1));
        if (qtyInput) qtyInput.value = totalKg;
        if (bagsPreview) bagsPreview.textContent = `${b} bags × ${k} kg = ${totalKg} kg total`;
      } else { if (bagsPreview) bagsPreview.textContent = ''; }
    };
    useBagsCb?.addEventListener('change', () => {
      if (bagsPanel) bagsPanel.style.display = useBagsCb.checked ? 'block' : 'none';
      if (useBagsCb.checked) bagsInput?.focus();
    });
    bagsInput?.addEventListener('input', calcFromBags);
    kpbInput?.addEventListener('input', calcFromBags);

    const hasInvCb    = document.getElementById('sdel-has-invoice');
    const invPanel    = document.getElementById('sdel-invoice-panel');
    const invTotal    = document.getElementById('sinv-total');
    const costPreview = document.getElementById('sinv-cost-preview');
    const updateCostPreview = () => {
      const t = parseFloat(invTotal?.value || 0);
      const q = parseFloat(document.getElementById('sdel-qty')?.value || 0);
      if (t && q) {
        if (costPreview) costPreview.textContent = `$${t.toFixed(2)} ÷ ${q} kg = $${(t/q).toFixed(4)}/kg (ex. GST)`;
      } else { if (costPreview) costPreview.textContent = ''; }
    };
    invTotal?.addEventListener('input', updateCostPreview);
    document.getElementById('sdel-qty')?.addEventListener('input', updateCostPreview);
    hasInvCb?.addEventListener('change', () => {
      if (invPanel) invPanel.style.display = hasInvCb.checked ? 'flex' : 'none';
      if (hasInvCb.checked) invTotal?.focus();
    });
  }, 60);
}

// ── Auto-write usage movement when a planting session closes ──────────────
// Called from operations.js after a session is closed
export async function writeSessionSeedUsage(farm, session) {
  if (!farm || !session || session.status !== 'closed') return;

  const isBulk = session.seed_type === 'bulk';
  let qty, unit;
  if (isBulk) {
    qty  = (parseFloat(session.seed_in_kg) || 0) - (parseFloat(session.seed_out_kg) || 0);
    unit = 'kg';
  } else {
    qty  = (parseFloat(session.seed_in_bags) || 0) - (parseFloat(session.seed_out_bags) || 0);
    unit = 'bags';
  }

  if (!qty || qty <= 0) return;

  let existing = [];
  try {
    existing = await dbSelect('stock_movements',
      `farm_id=eq.${farm.id}&movement_type=eq.usage&source_system=eq.operations&source_ref=eq.${session.id}`);
  } catch { /* ignore */ }
  if (existing.length > 0) return;

  const sessionDate = session.session_date || session.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const fieldLabel  = `${session.field_name}${session.sub_block ? ' · ' + session.sub_block : ''}`;
  const varLabel    = session.variety ? ` (${session.variety})` : '';

  try {
    await dbInsert('stock_movements', {
      farm_id:       farm.id,
      item_id:       null,
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
    console.warn('[CFM] writeSessionSeedUsage failed (non-fatal):', e.message);
  }
}
