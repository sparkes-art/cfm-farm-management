// modules/operations/operations.js
// Operations module — Planting Records (tab 1); Fertiliser, Deliveries to follow.
// Data: planting_sessions + planting_rows tables in Supabase.
// Chemicals stored as JSONB array [{name, litres}] on each row — free-text, autocompleted from history.
// Crop plan link: informational only — no auto-write back to crop_plan_entries.

import { dbSelect, dbInsert, dbUpdate, dbDelete, getSession } from '../../js/supabase-client.js?v=1794541976220';
import { getActiveFarm, getActiveSeason, canWrite } from '../../js/app-state.js?v=1794541976220';
import { toast, openModal, formatDate } from '../../js/ui.js?v=1794541976220';
import { loadCommodities, getCommodities } from '../../js/commodities.js?v=1794541976220';

// ── Module state ──────────────────────────────────────────────────────────────
let _container       = null;
let _sessions        = [];    // planting_sessions for active farm+season
let _allRows         = {};    // { [sessionId]: planting_rows[] }
let _paddocks        = [];    // from paddocks table
let _cropPlan        = [];    // from crop_plan_entries for active farm+season
let _knownChems      = [];    // distinct chemical names from all rows — for autocomplete
let _activeSessionId = null;  // which session is open in detail view
let _view            = 'list'; // 'list' | 'detail'

// ── Mount ─────────────────────────────────────────────────────────────────────
export async function mount(container) {
  _container = container;
  _container.innerHTML = `<div style="padding:24px;color:var(--hint);font-size:14px">Loading operations…</div>`;
  await _loadAll();
  _render();
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function _loadAll() {
  const farmId = getActiveFarm()?.id;
  const season = getActiveSeason();
  if (!farmId) return;

  await loadCommodities().catch(() => {});

  const [sessions, paddocks, cropPlan] = await Promise.all([
    dbSelect('planting_sessions',
      `farm_id=eq.${farmId}&season_label=eq.${encodeURIComponent(season)}&order=created_at.desc`
    ).catch(() => []),
    dbSelect('paddocks', `farm_id=eq.${farmId}&order=name.asc`).catch(() => []),
    dbSelect('crop_plan_entries', `farm_id=eq.${farmId}&order=paddock_name.asc`).catch(() => []),
  ]);

  _sessions  = sessions;
  _paddocks  = paddocks;
  _cropPlan  = cropPlan;

  // Load rows for all sessions in parallel
  _allRows = {};
  if (sessions.length) {
    const rowSets = await Promise.all(
      sessions.map(s =>
        dbSelect('planting_rows',
          `session_id=eq.${s.id}&order=created_at.asc`
        ).catch(() => [])
      )
    );
    sessions.forEach((s, i) => { _allRows[s.id] = rowSets[i]; });
  }

  // Build known chemical names for autocomplete
  _buildKnownChems();
}

function _buildKnownChems() {
  const names = new Set();
  Object.values(_allRows).forEach(rows => {
    rows.forEach(row => {
      (row.chemicals || []).forEach(c => { if (c.name) names.add(c.name); });
    });
  });
  _knownChems = [...names].sort();
  // Always include common defaults if not already present
  ['Telstar', 'Fipronil', 'Zinc', 'Water'].forEach(n => { if (!names.has(n)) _knownChems.push(n); });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _sessionRows(sessionId) { return _allRows[sessionId] || []; }

function _sessionTotalHa(sessionId) {
  return (_allRows[sessionId] || []).reduce((t, r) => t + (parseFloat(r.hectares) || 0), 0);
}

function _sessionTotalBags(sessionId) {
  return (_allRows[sessionId] || []).reduce((t, r) => t + (parseInt(r.cotton_bags) || 0), 0);
}

function _sessionTotalKg(sessionId, session) {
  const kgPerBag = parseFloat(session?.kg_per_bag) || 20;
  return (_allRows[sessionId] || []).reduce((t, r) => {
    const bagKg  = (parseInt(r.cotton_bags) || 0) * kgPerBag;
    const bulkKg = parseFloat(r.bulk_kg) || 0;
    return t + bagKg + bulkKg;
  }, 0);
}

// Find a matching crop plan entry for a given field/sub_block/season
function _findCropPlan(fieldName, subBlock, seasonLabel) {
  return _cropPlan.find(c =>
    c.paddock_name === fieldName &&
    (c.sub_block || '') === (subBlock || '') &&
    (c.season_label === seasonLabel ||
     (seasonLabel && c.season_label && c.season_label.endsWith(seasonLabel)))
  ) || null;
}

// Most recent row date across all sessions
function _lastRowDate(sessionId) {
  const rows = _allRows[sessionId] || [];
  if (!rows.length) return null;
  return rows[rows.length - 1].row_date;
}

function _fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function _todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function _nowHHMM() {
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}

// ── Top-level render ──────────────────────────────────────────────────────────
function _render() {
  if (!_container) return;
  _container.innerHTML = _view === 'list' ? _renderList() : _renderDetail();
  _wireEvents();
}

// ── LIST VIEW ─────────────────────────────────────────────────────────────────
function _renderList() {
  const farmId = getActiveFarm()?.id;
  const season = getActiveSeason();

  // Summary stats
  const totalHa    = _sessions.reduce((t, s) => t + _sessionTotalHa(s.id), 0);
  const openCount  = _sessions.filter(s => s.status === 'open').length;

  // Crop plan total ha for active season
  const cpSeason = _cropPlan.filter(c =>
    c.season_label === season || (season && c.season_label && c.season_label.endsWith(season))
  );
  const cpTotalHa = cpSeason.reduce((t, c) => t + (parseFloat(c.planned_ha) || 0), 0);
  const pctDone   = cpTotalHa > 0 ? Math.round((totalHa / cpTotalHa) * 100) : null;

  const statsHtml = `
    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px;flex:1;min-width:120px">
        <div style="font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Total Planted</div>
        <div style="font-family:var(--font-head,sans-serif);font-size:22px;font-weight:700;font-variant-numeric:tabular-nums">${totalHa.toFixed(1)} <span style="font-size:14px;color:var(--hint)">ha</span></div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">${_sessions.length} session${_sessions.length !== 1 ? 's' : ''} · ${esc(season)}</div>
      </div>
      ${cpTotalHa > 0 ? `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px;flex:1;min-width:120px">
        <div style="font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">vs Crop Plan</div>
        <div style="font-family:var(--font-head,sans-serif);font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--green)">${totalHa.toFixed(1)} / ${cpTotalHa.toFixed(0)} <span style="font-size:12px;color:var(--hint)">ha</span></div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">${pctDone}% complete</div>
      </div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 18px;flex:1;min-width:120px">
        <div style="font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Open Sessions</div>
        <div style="font-family:var(--font-head,sans-serif);font-size:22px;font-weight:700;color:${openCount > 0 ? 'var(--amber)' : 'var(--hint)'}">${openCount}</div>
        <div style="font-size:11px;color:var(--hint);margin-top:2px">${openCount > 0 ? 'In progress' : 'All closed'}</div>
      </div>
    </div>`;

  const sessionCards = _sessions.length === 0
    ? `<div style="text-align:center;padding:48px 24px;color:var(--hint)">
         <div style="font-size:32px;margin-bottom:12px">🌱</div>
         <div style="font-size:15px;font-weight:600;margin-bottom:4px">No planting sessions yet</div>
         <div style="font-size:13px">Start a new session when planting begins for a paddock.</div>
       </div>`
    : _sessions.map(s => {
        const rows    = _sessionRows(s.id);
        const totalHa = _sessionTotalHa(s.id);
        const cp      = s.crop_plan_entry_id
          ? _cropPlan.find(c => c.id === s.crop_plan_entry_id)
          : _findCropPlan(s.field_name, s.sub_block, s.season_label);
        const cpHa    = cp ? (parseFloat(cp.planned_ha) || 0) : 0;
        const remaining = cpHa > 0 ? cpHa - totalHa : null;
        const isOpen  = s.status === 'open';

        return `
        <div class="ops-session-card" data-session-id="${esc(s.id)}"
          style="background:var(--surface);border:1px solid var(--border);border-radius:8px;
            margin-bottom:10px;cursor:pointer;overflow:hidden;
            box-shadow:0 1px 3px rgba(0,0,0,.07)">
          <div style="display:flex;align-items:center;gap:12px;padding:14px 16px">
            <div style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${isOpen ? 'var(--green)' : 'var(--hint)'}"></div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:700;font-size:15px">
                ${esc(s.field_name)}${s.sub_block ? ` <span style="font-size:12px;color:var(--hint);font-weight:400">· ${esc(s.sub_block)}</span>` : ''}
              </div>
              <div style="font-size:12px;color:var(--fg2);margin-top:2px">
                ${[s.commodity, s.variety && `Var: ${s.variety}`, s.auslot_default && `Lot: ${s.auslot_default}`, s.operator_default].filter(Boolean).join(' · ')}
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:5px">
                <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;background:${isOpen ? 'var(--green-bg)' : 'var(--surface2)'};color:${isOpen ? 'var(--green)' : 'var(--hint)'}">
                  ${isOpen ? '● Open' : 'Closed'}
                </span>
                ${s.is_replant ? `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)">↩ Replant</span>` : ''}
                ${cp ? `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;background:var(--blue-bg);color:var(--blue)">Linked to crop plan</span>` : ''}
                ${remaining !== null && remaining > 0 && isOpen ? `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)">⚠ ${remaining.toFixed(1)} ha remaining</span>` : ''}
                ${remaining !== null && remaining < 0 ? `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:20px;background:var(--red-bg);color:var(--red)">⚠ ${Math.abs(remaining).toFixed(1)} ha over plan</span>` : ''}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:18px;font-weight:700;font-variant-numeric:tabular-nums">${totalHa.toFixed(1)}</div>
              <div style="font-size:11px;color:var(--hint)">ha entered</div>
              <div style="font-size:11px;color:var(--hint);margin-top:1px">${rows.length} row${rows.length !== 1 ? 's' : ''}</div>
            </div>
          </div>
        </div>`;
      }).join('');

  return `
    <div style="padding:24px;max-width:900px">
      <div style="display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:24px">
        <div style="padding:8px 16px;font-size:13px;font-weight:700;color:var(--blue);border-bottom:2px solid var(--blue);margin-bottom:-2px">Planting</div>
        <div style="padding:8px 16px;font-size:13px;font-weight:600;color:var(--hint)">Fertiliser <span style="font-size:10px;padding:1px 5px;background:var(--border);border-radius:20px;margin-left:4px">coming soon</span></div>
        <div style="padding:8px 16px;font-size:13px;font-weight:600;color:var(--hint)">Deliveries <span style="font-size:10px;padding:1px 5px;background:var(--border);border-radius:20px;margin-left:4px">coming soon</span></div>
      </div>

      ${statsHtml}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h2 style="margin:0;font-size:18px;font-weight:700">Planting Sessions</h2>
        ${canWrite() ? `<button id="ops-new-session-btn" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;font-size:13px;font-weight:600;background:var(--blue);color:#fff;border:none;border-radius:8px;cursor:pointer">
          <span style="font-size:16px;line-height:1">+</span> New Session
        </button>` : ''}
      </div>

      ${sessionCards}
    </div>`;
}

// ── DETAIL VIEW ───────────────────────────────────────────────────────────────
function _renderDetail() {
  const session = _sessions.find(s => s.id === _activeSessionId);
  if (!session) return `<div style="padding:24px;color:var(--hint)">Session not found.</div>`;

  const rows    = _sessionRows(session.id);
  const totalHa = _sessionTotalHa(session.id);
  const totalBags = _sessionTotalBags(session.id);
  const isOpen  = session.status === 'open';

  // Crop plan link
  const cp = session.crop_plan_entry_id
    ? _cropPlan.find(c => c.id === session.crop_plan_entry_id)
    : _findCropPlan(session.field_name, session.sub_block, session.season_label);
  const cpHa = cp ? (parseFloat(cp.planned_ha) || 0) : 0;
  const remaining = cpHa > 0 ? cpHa - totalHa : null;
  const pct = cpHa > 0 ? Math.min(100, (totalHa / cpHa) * 100) : null;

  // Date change warning
  const lastDate = _lastRowDate(session.id);
  const today    = _todayISO();
  const dateChanged = lastDate && lastDate !== today;

  // Crop plan banner
  const cpBanner = cp ? `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:8px;margin-bottom:12px;background:var(--blue-bg);font-size:13px;line-height:1.4">
      <div style="font-size:15px;flex-shrink:0;margin-top:1px">📋</div>
      <div>
        <div style="font-weight:700;color:var(--blue);margin-bottom:2px">Crop Plan: ${esc(session.field_name)}${session.sub_block ? ` · ${esc(session.sub_block)}` : ''} · ${esc(session.season_label)}</div>
        <div style="color:var(--blue)">Planned <strong>${cpHa.toFixed(1)} ha</strong>${cp.commodity ? ` ${esc(cp.commodity)}` : ''}${cp.variety ? ` · Variety ${esc(cp.variety)}` : ''} · Status: <strong>${esc(cp.status || '—')}</strong></div>
      </div>
    </div>` : '';

  // Date changed banner
  const dateBanner = dateChanged ? `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:8px;margin-bottom:12px;background:var(--amber-bg);border:1px solid var(--amber-border);font-size:13px;line-height:1.4;color:var(--amber)">
      <div style="font-size:15px;flex-shrink:0;margin-top:1px">⚠</div>
      <div>
        <div style="font-weight:700;margin-bottom:2px">Date has changed from last row</div>
        <div>Last row: <strong>${_fmtDate(lastDate)}</strong>. Today: <strong>${_fmtDate(today)}</strong>. The Date field below is pre-filled with today — check it before adding a row.</div>
      </div>
    </div>` : '';

  // Over-plan banner
  const overBanner = remaining !== null && remaining < 0 ? `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:8px;margin-bottom:12px;background:var(--red-bg);border:1px solid var(--red);font-size:13px;line-height:1.4;color:var(--red)">
      <div style="font-size:15px;flex-shrink:0;margin-top:1px">⚠</div>
      <div>
        <div style="font-weight:700;margin-bottom:2px">${Math.abs(remaining).toFixed(1)} ha over crop plan</div>
        <div>Planted <strong>${totalHa.toFixed(1)} ha</strong> against a plan of <strong>${cpHa.toFixed(1)} ha</strong>. Confirm this is intentional.</div>
      </div>
    </div>` : '';

  // Progress bar
  const progressHtml = pct !== null ? `
    <div style="margin-top:12px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--fg2);margin-bottom:4px">
        <span>Planted: <strong>${totalHa.toFixed(1)} ha</strong></span>
        <span>Planned: ${cpHa.toFixed(1)} ha</span>
      </div>
      <div style="background:var(--border);border-radius:99px;height:6px;overflow:hidden">
        <div style="height:100%;border-radius:99px;background:${pct >= 100 ? 'var(--amber)' : 'var(--green)'};width:${Math.min(100, pct).toFixed(1)}%;transition:width .3s"></div>
      </div>
      <div style="font-size:11px;color:var(--hint);margin-top:3px">${pct.toFixed(0)}% complete${remaining > 0 ? ` · ${remaining.toFixed(1)} ha remaining` : remaining < 0 ? ` · ${Math.abs(remaining).toFixed(1)} ha over plan` : ' · Complete'}</div>
    </div>` : '';

  // Session header card
  const headerCard = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.07)">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px">
        <div>
          <div style="font-size:20px;font-weight:700">${esc(session.field_name)}${session.sub_block ? ` <span style="font-size:14px;color:var(--hint);font-weight:400">· ${esc(session.sub_block)}</span>` : ''}</div>
          ${session.previous_field ? `<div style="font-size:12px;color:var(--fg2);margin-top:2px">Previous field: ${esc(session.previous_field)} · ${esc(session.season_label)}</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:flex-start;flex-shrink:0">
          ${session.is_replant ? `<span style="font-size:12px;font-weight:600;padding:4px 10px;border-radius:20px;background:var(--amber-bg);color:var(--amber);border:1px solid var(--amber-border)">↩ Replant</span>` : ''}
          <span style="font-size:12px;font-weight:600;padding:4px 10px;border-radius:20px;background:${isOpen ? 'var(--green-bg)' : 'var(--surface2)'};color:${isOpen ? 'var(--green)' : 'var(--hint)'}">
            ${isOpen ? '● Open' : 'Closed'}
          </span>
          ${canWrite() && isOpen ? `<button id="ops-edit-header-btn" style="font-size:12px;font-weight:600;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--fg2);cursor:pointer">Edit header</button>` : ''}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px">
        ${[
          ['Commodity', session.commodity],
          ['Variety',   session.variety],
          ['Lot #',     session.auslot_default],
          ['Operator',  session.operator_default],
          ['Seed In',   session.seed_in_bags != null ? `${session.seed_in_bags} bags` : null],
          ['Water In',  session.water_in_litres != null ? `${session.water_in_litres} L` : null],
          ['Bag Weight', `${parseFloat(session.kg_per_bag) || 20} kg/bag`],
        ].filter(([,v]) => v).map(([l, v]) => `
          <div>
            <div style="font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px">${l}</div>
            <div style="font-size:14px;font-weight:500">${esc(v)}</div>
          </div>`).join('')}
      </div>
      ${progressHtml}
    </div>`;

  // Add row form (only when open)
  const addRowForm = isOpen && canWrite() ? _renderAddRowForm(session) : '';

  // Rows table
  const rowsHtml = rows.length === 0
    ? `<div style="text-align:center;padding:32px;color:var(--hint);font-size:13px">No rows yet — use the form above to add the first planter fill.</div>`
    : (() => {
        // Collect all chemical names used in this session for column display
        const chemNames = [...new Set(rows.flatMap(r => (r.chemicals || []).map(c => c.name).filter(Boolean)))];

        const kgPerBag = parseFloat(session.kg_per_bag) || 20;
        const rowHtmls = [...rows].reverse().map(row => {
          const operator = row.operator || session.operator_default;
          const auslot   = row.auslot_override || session.auslot_default;
          const bulkKg   = parseFloat(row.bulk_kg) || 0;
          const rowKg    = (parseInt(row.cotton_bags) || 0) * kgPerBag + bulkKg;
          return `<tr class="ops-row-tr" data-row-id="${esc(row.id)}">
            <td style="padding:10px 12px;white-space:nowrap">${_fmtDate(row.row_date)}</td>
            <td style="padding:10px 12px;color:var(--fg2)">${esc(row.row_time || '—')}</td>
            <td style="padding:10px 12px">${esc(operator || '—')}</td>
            <td style="padding:10px 12px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right">${row.hectares != null ? parseFloat(row.hectares).toFixed(2) : '—'}</td>
            <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums">${row.cotton_bags != null ? row.cotton_bags : '—'}</td>
            <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums;color:${bulkKg > 0 ? 'var(--fg)' : 'var(--hint)'}">${bulkKg > 0 ? bulkKg.toFixed(0) : '—'}</td>
            <td style="padding:10px 12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${rowKg > 0 ? rowKg.toFixed(0) : '—'}</td>
            <td style="padding:10px 12px;color:var(--hint);font-size:12px">${esc(auslot || '—')}</td>
            <td style="padding:10px 12px">
              ${(row.chemicals || []).map(c =>
                `<span style="display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:2px 7px;border-radius:20px;background:var(--blue-bg);color:var(--blue);margin:1px">${esc(c.name)} ${c.litres != null ? `${c.litres} L` : ''}</span>`
              ).join('') || '<span style="color:var(--hint)">—</span>'}
            </td>
            ${canWrite() && isOpen ? `<td style="padding:10px 12px"><button class="ops-edit-row-btn" data-row-id="${esc(row.id)}" style="font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--fg2);cursor:pointer">Edit</button></td>` : '<td></td>'}
          </tr>`;
        }).join('');

        return `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">
            <div style="padding:12px 16px;font-weight:700;font-size:13px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
              <span>Rows entered <span style="font-size:12px;color:var(--hint);font-weight:400">· ${rows.length} row${rows.length !== 1 ? 's' : ''} · most recent first</span></span>
            </div>
            <div style="overflow-x:auto">
              <table style="width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums">
                <thead>
                  <tr style="background:var(--surface2)">
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)">Date</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)">Time</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)">Operator</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:right;white-space:nowrap;border-bottom:1px solid var(--border)">Ha</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:right;white-space:nowrap;border-bottom:1px solid var(--border)">Bags</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:right;white-space:nowrap;border-bottom:1px solid var(--border)">Bulk kg</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:right;white-space:nowrap;border-bottom:1px solid var(--border)">Total kg</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;white-space:nowrap;border-bottom:1px solid var(--border)">AusLot</th>
                    <th style="padding:8px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);text-align:left;border-bottom:1px solid var(--border)">Chemicals</th>
                    <th style="border-bottom:1px solid var(--border)"></th>
                  </tr>
                </thead>
                <tbody id="ops-rows-body">
                  ${rowHtmls}
                  <tr style="background:var(--surface2)">
                    <td colspan="3" style="padding:10px 12px;font-weight:700;border-top:2px solid var(--border)">Total</td>
                    <td style="padding:10px 12px;font-weight:700;text-align:right;border-top:2px solid var(--border);font-variant-numeric:tabular-nums">${totalHa.toFixed(2)}</td>
                    <td style="padding:10px 12px;font-weight:700;text-align:right;border-top:2px solid var(--border);font-variant-numeric:tabular-nums">${totalBags}</td>
                    <td style="padding:10px 12px;font-weight:700;text-align:right;border-top:2px solid var(--border);font-variant-numeric:tabular-nums">${rows.reduce((t,r) => t + (parseFloat(r.bulk_kg)||0), 0).toFixed(0)}</td>
                    <td style="padding:10px 12px;font-weight:700;text-align:right;border-top:2px solid var(--border);font-variant-numeric:tabular-nums">${_sessionTotalKg(session.id, session).toFixed(0)} kg</td>
                    <td colspan="2" style="border-top:2px solid var(--border)"></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>`;
      })();

  const footerBtns = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px">
      ${canWrite() ? `<button id="ops-delete-session-btn" style="font-size:12px;font-weight:600;padding:7px 14px;border-radius:8px;border:1px solid var(--red);background:transparent;color:var(--red);cursor:pointer">Delete session</button>` : '<div></div>'}
      ${isOpen && canWrite()
        ? `<button id="ops-close-session-btn" style="font-size:13px;font-weight:600;padding:8px 18px;border-radius:8px;border:none;background:var(--green);color:#fff;cursor:pointer">Close Session ✓</button>`
        : ''}
    </div>`;

  return `
    <div style="padding:24px;max-width:900px">
      <button id="ops-back-btn" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600;color:var(--blue);background:none;border:none;cursor:pointer;padding:0;margin-bottom:16px">
        ← Back to Planting
      </button>
      ${cpBanner}
      ${dateBanner}
      ${overBanner}
      ${headerCard}
      ${addRowForm}
      ${rowsHtml}
      ${footerBtns}
    </div>`;
}

// ── Add Row Form ──────────────────────────────────────────────────────────────
function _renderAddRowForm(session) {
  const today = _todayISO();
  const now   = _nowHHMM();

  const suggestionsHtml = _knownChems.map(n =>
    `<div class="ops-chem-sug" data-name="${esc(n)}" style="padding:7px 10px;font-size:13px;cursor:pointer"
      onmousedown="event.preventDefault()">${esc(n)}</div>`
  ).join('');

  return `
    <div id="ops-add-row-form" style="background:var(--surface);border:2px solid var(--blue);border-radius:8px;padding:20px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.07)">
      <div style="font-size:14px;font-weight:700;color:var(--blue);margin-bottom:16px;display:flex;align-items:center;gap:6px">
        + Add Row
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px;margin-bottom:16px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);display:flex;align-items:center;gap:4px;margin-bottom:4px">
            Date <span style="font-size:10px;color:var(--blue);font-weight:600">pre-filled</span>
          </label>
          <input id="ops-row-date" type="date" value="${today}"
            style="padding:8px 10px;border:1px solid var(--blue);border-radius:6px;background:var(--blue-bg);color:var(--fg);font-size:14px;font-family:inherit;width:100%;box-sizing:border-box;outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);display:flex;align-items:center;gap:4px;margin-bottom:4px">
            Time <span style="font-size:10px;color:var(--blue);font-weight:600">pre-filled</span>
          </label>
          <input id="ops-row-time" type="text" value="${now}" placeholder="HH:MM"
            style="padding:8px 10px;border:1px solid var(--blue);border-radius:6px;background:var(--blue-bg);color:var(--fg);font-size:14px;font-family:inherit;width:100%;box-sizing:border-box;outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);display:flex;align-items:center;gap:4px;margin-bottom:4px">
            Operator <span style="font-size:10px;color:var(--blue);font-weight:600">pre-filled</span>
          </label>
          <input id="ops-row-operator" type="text" value="${esc(session.operator_default || '')}" placeholder="Operator"
            style="padding:8px 10px;border:1px solid var(--blue);border-radius:6px;background:var(--blue-bg);color:var(--fg);font-size:14px;font-family:inherit;width:100%;box-sizing:border-box;outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);display:flex;align-items:center;gap:4px;margin-bottom:4px">
            AusLot # <span style="font-size:10px;color:var(--blue);font-weight:600">pre-filled</span>
          </label>
          <input id="ops-row-auslot" type="text" value="${esc(session.auslot_default || '')}" placeholder="Lot #"
            style="padding:8px 10px;border:1px solid var(--blue);border-radius:6px;background:var(--blue-bg);color:var(--fg);font-size:14px;font-family:inherit;width:100%;box-sizing:border-box;outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:4px;display:block">
            Hectares
          </label>
          <input id="ops-row-ha" type="number" step="0.01" min="0" placeholder="0.0"
            style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:16px;font-weight:700;font-family:inherit;width:100%;box-sizing:border-box;outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:4px;display:block">
            Bags
          </label>
          <input id="ops-row-bags" type="number" min="0" placeholder="0"
            style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;width:100%;box-sizing:border-box;outline:none">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:4px;display:block">
            Bulk kg <span style="font-size:10px;color:var(--hint);text-transform:none;letter-spacing:0;font-weight:400">silo/truck fill</span>
          </label>
          <input id="ops-row-bulk-kg" type="number" step="0.1" min="0" placeholder="0"
            style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;width:100%;box-sizing:border-box;outline:none">
        </div>
      </div>

      <!-- Chemical rows -->
      <div style="margin-bottom:16px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:8px">
          Chemicals <span style="font-size:10px;color:var(--hint);text-transform:none;letter-spacing:0;font-weight:400">— add any treatment applied this fill</span>
        </div>
        <div id="ops-chem-rows"></div>
        <button id="ops-add-chem-btn" style="font-size:12px;font-weight:600;color:var(--blue);background:none;border:1px dashed var(--blue);border-radius:6px;padding:6px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;margin-top:8px">
          + Add chemical
        </button>
      </div>

      <!-- Hidden suggestions template -->
      <div id="ops-sug-template" style="display:none">${suggestionsHtml}</div>

      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="ops-row-clear-btn" style="font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--fg2);cursor:pointer">Clear</button>
        <button id="ops-row-save-btn" style="font-size:13px;font-weight:600;padding:8px 18px;border-radius:8px;border:none;background:var(--blue);color:#fff;cursor:pointer">Add Row →</button>
      </div>
    </div>`;
}

// ── Chemical row helper ───────────────────────────────────────────────────────
function _addChemRow(container, name = '', litres = '') {
  const row = document.createElement('div');
  row.className = 'ops-chem-row';
  row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:6px';

  const sugHtml = _knownChems.map(n =>
    `<div class="ops-chem-sug" data-name="${esc(n)}" style="padding:7px 10px;font-size:13px;cursor:pointer">${esc(n)}</div>`
  ).join('');

  row.innerHTML = `
    <div style="position:relative;flex:2">
      <input class="ops-chem-name" type="text" value="${esc(name)}" placeholder="Chemical name…"
        style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit;box-sizing:border-box;outline:none">
      <div class="ops-chem-sugs" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:10;background:var(--surface);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.12);overflow:hidden;margin-top:2px">
        ${sugHtml}
      </div>
    </div>
    <input class="ops-chem-litres" type="number" step="0.01" min="0" value="${esc(litres)}" placeholder="L"
      style="width:72px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit;font-variant-numeric:tabular-nums;outline:none">
    <button class="ops-chem-remove" style="background:none;border:none;color:var(--hint);cursor:pointer;font-size:18px;padding:4px;line-height:1" title="Remove">×</button>`;

  // Wire suggestions
  const inp  = row.querySelector('.ops-chem-name');
  const sugs = row.querySelector('.ops-chem-sugs');
  inp.addEventListener('focus', () => { sugs.style.display = 'block'; });
  inp.addEventListener('blur',  () => { setTimeout(() => { sugs.style.display = 'none'; }, 150); });
  inp.addEventListener('input', () => {
    const q = inp.value.toLowerCase();
    sugs.querySelectorAll('.ops-chem-sug').forEach(s => {
      s.style.display = s.dataset.name.toLowerCase().includes(q) ? '' : 'none';
    });
  });
  sugs.querySelectorAll('.ops-chem-sug').forEach(s => {
    s.addEventListener('mousedown', e => { e.preventDefault(); inp.value = s.dataset.name; sugs.style.display = 'none'; });
  });
  row.querySelector('.ops-chem-remove').addEventListener('click', () => row.remove());

  container.appendChild(row);
  inp.focus();
}

// ── Read form values ──────────────────────────────────────────────────────────
function _readRowForm() {
  const chemicals = [];
  _container.querySelectorAll('.ops-chem-row').forEach(row => {
    const name   = row.querySelector('.ops-chem-name')?.value?.trim();
    const litres = row.querySelector('.ops-chem-litres')?.value;
    if (name) chemicals.push({ name, litres: litres ? parseFloat(litres) : null });
  });
  return {
    row_date:        _container.querySelector('#ops-row-date')?.value || null,
    row_time:        _container.querySelector('#ops-row-time')?.value?.trim() || null,
    operator:        _container.querySelector('#ops-row-operator')?.value?.trim() || null,
    auslot_override: _container.querySelector('#ops-row-auslot')?.value?.trim() || null,
    hectares:        parseFloat(_container.querySelector('#ops-row-ha')?.value) || null,
    cotton_bags:     parseInt(_container.querySelector('#ops-row-bags')?.value) || null,
    bulk_kg:         parseFloat(_container.querySelector('#ops-row-bulk-kg')?.value) || null,
    chemicals,
  };
}

// ── Wire events ───────────────────────────────────────────────────────────────
function _wireEvents() {
  if (!_container) return;

  // Session card click → detail
  _container.querySelectorAll('.ops-session-card').forEach(card => {
    card.addEventListener('click', () => {
      _activeSessionId = card.dataset.sessionId;
      _view = 'detail';
      _render();
    });
  });

  // New session button
  const newBtn = _container.querySelector('#ops-new-session-btn');
  if (newBtn) newBtn.addEventListener('click', _showNewSessionModal);

  // Back button
  const backBtn = _container.querySelector('#ops-back-btn');
  if (backBtn) backBtn.addEventListener('click', () => { _view = 'list'; _render(); });

  // Add chemical button
  const addChemBtn = _container.querySelector('#ops-add-chem-btn');
  if (addChemBtn) {
    addChemBtn.addEventListener('click', () => {
      _addChemRow(_container.querySelector('#ops-chem-rows'));
    });
  }

  // Ha field focus (auto-select for quick entry)
  const haInput = _container.querySelector('#ops-row-ha');
  if (haInput) haInput.addEventListener('focus', () => haInput.select());

  // Clear form button
  const clearBtn = _container.querySelector('#ops-row-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    ['#ops-row-ha','#ops-row-bags'].forEach(sel => {
      const el = _container.querySelector(sel);
      if (el) el.value = '';
    });
    _container.querySelectorAll('.ops-chem-row').forEach(r => r.remove());
    _container.querySelector('#ops-row-ha')?.focus();
  });

  // Save row button
  const saveBtn = _container.querySelector('#ops-row-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', _saveRow);

  // Enter key on Ha/Bags saves row
  [_container.querySelector('#ops-row-ha'), _container.querySelector('#ops-row-bags')].forEach(el => {
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') _saveRow(); });
  });

  // Edit session header
  const editHdrBtn = _container.querySelector('#ops-edit-header-btn');
  if (editHdrBtn) editHdrBtn.addEventListener('click', () => {
    const s = _sessions.find(s => s.id === _activeSessionId);
    if (s) _showEditHeaderModal(s);
  });

  // Delete session button
  const deleteSessionBtn = _container.querySelector('#ops-delete-session-btn');
  if (deleteSessionBtn) deleteSessionBtn.addEventListener('click', () => {
    const s = _sessions.find(s => s.id === _activeSessionId);
    if (s) _confirmDeleteSession(s);
  });

  // Close session button
  const closeBtn = _container.querySelector('#ops-close-session-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    const s = _sessions.find(s => s.id === _activeSessionId);
    if (s) _showCloseSessionModal(s);
  });

  // Edit row buttons
  _container.querySelectorAll('.ops-edit-row-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const rowId = btn.dataset.rowId;
      const session = _sessions.find(s => s.id === _activeSessionId);
      const rows = _allRows[_activeSessionId] || [];
      const row = rows.find(r => r.id === rowId);
      if (row && session) _showEditRowModal(row, session);
    });
  });
}

// ── Save new row ──────────────────────────────────────────────────────────────
async function _saveRow() {
  const session = _sessions.find(s => s.id === _activeSessionId);
  if (!session) return;

  const data = _readRowForm();
  if (!data.hectares) { toast('Enter hectares before saving', 'error'); return; }

  const saveBtn = _container.querySelector('#ops-row-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    const inserted = await dbInsert('planting_rows', {
      session_id:      session.id,
      row_date:        data.row_date,
      row_time:        data.row_time,
      operator:        data.operator || null,
      hectares:        data.hectares,
      cotton_bags:     data.cotton_bags,
      bulk_kg:         data.bulk_kg,
      auslot_override: data.auslot_override || null,
      chemicals:       data.chemicals,
    });

    // Update in-memory state
    if (!_allRows[session.id]) _allRows[session.id] = [];
    _allRows[session.id].push(Array.isArray(inserted) ? inserted[0] : inserted);
    _buildKnownChems();

    toast('Row added', 'success');
    _render();

    // Re-focus Ha for next row
    setTimeout(() => { _container.querySelector('#ops-row-ha')?.focus(); }, 50);
  } catch (err) {
    toast(err.message || 'Failed to save row', 'error');
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Add Row →'; }
  }
}

// ── New session modal ─────────────────────────────────────────────────────────
function _showNewSessionModal() {
  const farmId = getActiveFarm()?.id;
  const season = getActiveSeason();

  const paddockOptions = _paddocks.map(p =>
    `<option value="${esc(p.name)}">${esc(p.name)}</option>`
  ).join('');

  openModal({
    title: 'New Planting Session',
    wide: true,
    bodyHTML: `
      <div style="font-size:12px;color:var(--fg2);margin-bottom:12px">One session per field planting run. Add rows as each planter fill is completed.</div>

      <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:8px;margin-bottom:14px;background:var(--blue-bg);font-size:12px;color:var(--blue)">
        <div>📋</div>
        <div><strong>${esc(getActiveFarm()?.name || '')} · ${esc(season)}</strong> — pre-filled from your active farm and season. Check before continuing.</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div style="grid-column:1/-1">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Field (Paddock)</label>
          <select id="ns-field" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit">
            <option value="">Select paddock…</option>
            ${paddockOptions}
          </select>
        </div>
        <div style="grid-column:1/-1">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">
            Sub-block <span style="font-size:10px;color:var(--hint);text-transform:none;letter-spacing:0;font-weight:400">— optional, if splitting field by variety</span>
          </label>
          <input id="ns-subblock" type="text" placeholder="e.g. E1-West, E1-East"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div id="ns-cp-banner" style="grid-column:1/-1;display:none"></div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Commodity</label>
          <select id="ns-commodity"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
            <option value="">Select commodity…</option>
            ${getCommodities().map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label id="ns-variety-label" style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Variety</label>
          <input id="ns-variety" type="text" placeholder="e.g. 606"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">AusLot #</label>
          <input id="ns-auslot" type="text" placeholder="e.g. N12/25/293"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Operator</label>
          <input id="ns-operator" type="text" placeholder="e.g. Bailey"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Seed Carried In (bags)</label>
          <input id="ns-seed-in" type="number" min="0" placeholder="0"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Water Carried In (L)</label>
          <input id="ns-water-in" type="number" min="0" placeholder="0"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Previous Field</label>
          <input id="ns-prev-field" type="text" placeholder="e.g. B3"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Bag Weight (kg)</label>
          <input id="ns-kg-per-bag" type="number" step="0.1" min="0" value="20" placeholder="20"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div style="display:flex;align-items:center">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 0">
            <input id="ns-is-replant" type="checkbox"
              style="width:18px;height:18px;accent-color:var(--amber);cursor:pointer;flex-shrink:0">
            <span>
              <span style="font-size:13px;font-weight:600;display:block">This is a replant session</span>
              <span style="font-size:11px;color:var(--hint)">Re-planting failed or damaged areas</span>
            </span>
          </label>
        </div>
        <div style="grid-column:1/-1">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Notes</label>
          <input id="ns-notes" type="text" placeholder="Optional"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
      </div>`,
    confirmLabel: 'Start Session →',
    onMounted: (modalEl) => {
      const fieldSel = modalEl.querySelector('#ns-field');
      const subBlk   = modalEl.querySelector('#ns-subblock');
      const cpBanner = modalEl.querySelector('#ns-cp-banner');

      function checkCropPlan() {
        const field = fieldSel.value;
        const sub   = subBlk.value.trim();
        const cp    = field ? _findCropPlan(field, sub, season) : null;
        if (cp) {
          cpBanner.style.display = 'block';
          cpBanner.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:8px;background:var(--amber-bg);border:1px solid var(--amber-border);font-size:12px;color:var(--amber)">
              <div>⚠</div>
              <div>
                <strong>Crop plan found:</strong> ${parseFloat(cp.planned_ha || 0).toFixed(1)} ha
                ${cp.commodity ? esc(cp.commodity) : ''}${cp.variety ? ` · Var ${esc(cp.variety)}` : ''} · Status: ${esc(cp.status || '—')}<br>
                <span style="color:var(--fg2)">Fields below pre-filled — verify before saving.</span>
              </div>
            </div>`;
          // Pre-fill variety & commodity
          const varEl  = modalEl.querySelector('#ns-variety');
          const comEl  = modalEl.querySelector('#ns-commodity');
          if (varEl && !varEl.value && cp.variety)   { varEl.value = cp.variety; varEl.style.background = 'var(--blue-bg)'; varEl.style.borderColor = 'var(--blue)'; }
          if (comEl && !comEl.value && cp.commodity) {
            // Try to select matching option in the dropdown
            const opt = [...comEl.options].find(o => o.value === cp.commodity);
            if (opt) { comEl.value = cp.commodity; comEl.style.background = 'var(--blue-bg)'; comEl.style.borderColor = 'var(--blue)'; }
          }
          modalEl.querySelector('#ns-variety-label').innerHTML =
            `Variety <span style="font-size:10px;color:var(--blue);font-weight:600">from crop plan</span>`;
        } else {
          cpBanner.style.display = 'none';
        }
      }

      fieldSel.addEventListener('change', checkCropPlan);
      subBlk.addEventListener('input',   checkCropPlan);
    },
    onConfirm: async (modalEl) => {
      const field = modalEl.querySelector('#ns-field')?.value;
      if (!field) { toast('Select a paddock', 'error'); throw new Error('no field'); }

      const sub     = modalEl.querySelector('#ns-subblock')?.value?.trim() || null;
      const cp      = _findCropPlan(field, sub, season);

      const payload = {
        farm_id:          farmId,
        season_label:     season,
        field_name:       field,
        sub_block:        sub,
        commodity:        modalEl.querySelector('#ns-commodity')?.value?.trim() || null,
        variety:          modalEl.querySelector('#ns-variety')?.value?.trim() || null,
        auslot_default:   modalEl.querySelector('#ns-auslot')?.value?.trim() || null,
        operator_default: modalEl.querySelector('#ns-operator')?.value?.trim() || null,
        seed_in_bags:     parseFloat(modalEl.querySelector('#ns-seed-in')?.value) || null,
        water_in_litres:  parseFloat(modalEl.querySelector('#ns-water-in')?.value) || null,
        previous_field:   modalEl.querySelector('#ns-prev-field')?.value?.trim() || null,
        notes:            modalEl.querySelector('#ns-notes')?.value?.trim() || null,
        kg_per_bag:       parseFloat(modalEl.querySelector('#ns-kg-per-bag')?.value) || 20,
        is_replant:       modalEl.querySelector('#ns-is-replant')?.checked || false,
        crop_plan_entry_id: cp?.id || null,
        status:           'open',
      };

      const inserted = await dbInsert('planting_sessions', payload);
      const newSession = Array.isArray(inserted) ? inserted[0] : inserted;
      _sessions.unshift(newSession);
      _allRows[newSession.id] = [];
      toast('Session created', 'success');
      _activeSessionId = newSession.id;
      _view = 'detail';
      _render();
    },
  });
}

// ── Edit header modal ─────────────────────────────────────────────────────────
function _showEditHeaderModal(session) {
  openModal({
    title: 'Edit Session Header',
    wide: true,
    bodyHTML: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Commodity</label>
          <select id="ns-commodity"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
            <option value="">Select commodity…</option>
            ${getCommodities().map(c => `<option value="${esc(c.name)}" ${c.name === session.commodity ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        ${[
          ['ns-variety',    'Variety',              session.variety,           'text', 'e.g. 606'],
          ['ns-auslot',     'Lot #',               session.auslot_default,    'text', ''],
          ['ns-operator',   'Operator',            session.operator_default,  'text', ''],
          ['ns-seed-in',    'Seed Carried In (bags)', session.seed_in_bags,   'number', '0'],
          ['ns-water-in',   'Water Carried In (L)', session.water_in_litres,  'number', '0'],
          ['ns-prev-field', 'Previous Field',      session.previous_field,    'text', ''],
          ['ns-kg-per-bag', 'Bag Weight (kg)',     session.kg_per_bag != null ? session.kg_per_bag : 20, 'number', '20'],
        ].map(([id, lbl, val, type, ph]) => `
          <div>
            <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">${lbl}</label>
            <input id="${id}" type="${type}" value="${esc(val || '')}" placeholder="${ph}"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
          </div>`).join('')}
        <div style="display:flex;align-items:center">
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:8px 0">
            <input id="ns-is-replant" type="checkbox" ${session.is_replant ? 'checked' : ''}
              style="width:18px;height:18px;accent-color:var(--amber);cursor:pointer;flex-shrink:0">
            <span>
              <span style="font-size:13px;font-weight:600;display:block">Replant session</span>
              <span style="font-size:11px;color:var(--hint)">Re-planting failed or damaged areas</span>
            </span>
          </label>
        </div>
        <div style="grid-column:1/-1">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Notes</label>
          <input id="ns-notes" type="text" value="${esc(session.notes || '')}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
      </div>`,
    confirmLabel: 'Save Changes',
    onConfirm: async (modalEl) => {
      const updates = {
        commodity:        modalEl.querySelector('#ns-commodity')?.value || null,
        variety:          modalEl.querySelector('#ns-variety')?.value?.trim() || null,
        auslot_default:   modalEl.querySelector('#ns-auslot')?.value?.trim() || null,
        operator_default: modalEl.querySelector('#ns-operator')?.value?.trim() || null,
        seed_in_bags:     parseFloat(modalEl.querySelector('#ns-seed-in')?.value) || null,
        water_in_litres:  parseFloat(modalEl.querySelector('#ns-water-in')?.value) || null,
        previous_field:   modalEl.querySelector('#ns-prev-field')?.value?.trim() || null,
        notes:            modalEl.querySelector('#ns-notes')?.value?.trim() || null,
        kg_per_bag:       parseFloat(modalEl.querySelector('#ns-kg-per-bag')?.value) || 20,
        is_replant:       modalEl.querySelector('#ns-is-replant')?.checked || false,
      };
      await dbUpdate('planting_sessions', session.id, updates);
      Object.assign(session, updates);
      toast('Header updated', 'success');
      _render();
    },
  });
}

// ── Edit row modal ────────────────────────────────────────────────────────────
function _showEditRowModal(row, session) {
  const chemRows = (row.chemicals || []).map(c =>
    `<div class="edit-chem-row" style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <input class="edit-chem-name" type="text" value="${esc(c.name || '')}" placeholder="Chemical"
        style="flex:2;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit">
      <input class="edit-chem-litres" type="number" step="0.01" value="${c.litres != null ? c.litres : ''}" placeholder="L"
        style="width:72px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit">
      <button onclick="this.closest('.edit-chem-row').remove()" style="background:none;border:none;color:var(--hint);cursor:pointer;font-size:18px;padding:4px">×</button>
    </div>`
  ).join('');

  openModal({
    title: 'Edit Row',
    wide: true,
    bodyHTML: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Date</label>
          <input id="er-date" type="date" value="${esc(row.row_date || '')}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Time</label>
          <input id="er-time" type="text" value="${esc(row.row_time || '')}" placeholder="HH:MM"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Operator</label>
          <input id="er-operator" type="text" value="${esc(row.operator || session.operator_default || '')}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">AusLot #</label>
          <input id="er-auslot" type="text" value="${esc(row.auslot_override || session.auslot_default || '')}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Hectares</label>
          <input id="er-ha" type="number" step="0.01" value="${row.hectares != null ? row.hectares : ''}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:16px;font-weight:700;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Bags</label>
          <input id="er-bags" type="number" value="${row.cotton_bags != null ? row.cotton_bags : ''}"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Bulk kg <span style="font-size:10px;color:var(--hint);text-transform:none;letter-spacing:0;font-weight:400">silo/truck fill</span></label>
          <input id="er-bulk-kg" type="number" step="0.1" value="${row.bulk_kg != null ? row.bulk_kg : ''}" placeholder="0"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
      </div>
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);margin-bottom:8px">Chemicals</div>
      <div id="edit-chem-rows">${chemRows}</div>
      <button onclick="
        const r=document.createElement('div');r.className='edit-chem-row';
        r.style.cssText='display:flex;gap:8px;align-items:center;margin-bottom:6px';
        r.innerHTML='<input class=\\'edit-chem-name\\' type=\\'text\\' placeholder=\\'Chemical\\' style=\\'flex:2;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit\\'><input class=\\'edit-chem-litres\\' type=\\'number\\' step=\\'0.01\\' placeholder=\\'L\\' style=\\'width:72px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:13px;font-family:inherit\\'><button onclick=\\'this.closest(\\'.edit-chem-row\\').remove()\\' style=\\'background:none;border:none;color:var(--hint);cursor:pointer;font-size:18px;padding:4px\\'>×</button>';
        document.getElementById('edit-chem-rows').appendChild(r)"
        style="font-size:12px;font-weight:600;color:var(--blue);background:none;border:1px dashed var(--blue);border-radius:6px;padding:5px 10px;cursor:pointer;margin-top:4px">+ Add chemical</button>
      <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
      <button id="er-delete-btn" style="font-size:12px;font-weight:600;color:var(--red);background:var(--red-bg);border:1px solid var(--red);border-radius:6px;padding:6px 12px;cursor:pointer">Delete row</button>`,
    confirmLabel: 'Save Changes',
    onMounted: (modalEl) => {
      modalEl.querySelector('#er-delete-btn')?.addEventListener('click', async () => {
        if (!confirm('Delete this row?')) return;
        await dbDelete('planting_rows', row.id);
        const rows = _allRows[session.id] || [];
        _allRows[session.id] = rows.filter(r => r.id !== row.id);
        toast('Row deleted', 'success');
        // close modal by clicking cancel
        modalEl.closest('.modal-overlay')?.querySelector('[data-action="cancel"]')?.click();
        _render();
      });
    },
    onConfirm: async (modalEl) => {
      const chemicals = [];
      modalEl.querySelectorAll('.edit-chem-row').forEach(r => {
        const name   = r.querySelector('.edit-chem-name')?.value?.trim();
        const litres = r.querySelector('.edit-chem-litres')?.value;
        if (name) chemicals.push({ name, litres: litres ? parseFloat(litres) : null });
      });
      const updates = {
        row_date:        modalEl.querySelector('#er-date')?.value || null,
        row_time:        modalEl.querySelector('#er-time')?.value?.trim() || null,
        operator:        modalEl.querySelector('#er-operator')?.value?.trim() || null,
        auslot_override: modalEl.querySelector('#er-auslot')?.value?.trim() || null,
        hectares:        parseFloat(modalEl.querySelector('#er-ha')?.value) || null,
        cotton_bags:     parseInt(modalEl.querySelector('#er-bags')?.value) || null,
        bulk_kg:         parseFloat(modalEl.querySelector('#er-bulk-kg')?.value) || null,
        chemicals,
      };
      await dbUpdate('planting_rows', row.id, updates);
      Object.assign(row, updates);
      _buildKnownChems();
      toast('Row updated', 'success');
      _render();
    },
  });
}

// ── Delete session ────────────────────────────────────────────────────────────
async function _confirmDeleteSession(session) {
  const rowCount = (_allRows[session.id] || []).length;
  const label = `${session.field_name}${session.sub_block ? ` · ${session.sub_block}` : ''}`;
  const msg = rowCount > 0
    ? `Delete "${label}"? This will also delete ${rowCount} row${rowCount !== 1 ? 's' : ''} of planting data. This cannot be undone.`
    : `Delete "${label}"? This cannot be undone.`;

  if (!confirm(msg)) return;

  try {
    // planting_rows cascade-delete via FK, so just delete the session
    await dbDelete('planting_sessions', session.id);
    _sessions = _sessions.filter(s => s.id !== session.id);
    delete _allRows[session.id];
    toast('Session deleted', 'success');
    _view = 'list';
    _render();
  } catch (err) {
    toast(err.message || 'Failed to delete session', 'error');
  }
}

// ── Close session modal ───────────────────────────────────────────────────────
function _showCloseSessionModal(session) {
  const totalHa   = _sessionTotalHa(session.id);
  const totalBags = _sessionTotalBags(session.id);
  const rows      = _sessionRows(session.id);

  openModal({
    title: `Close Session — ${session.field_name}${session.sub_block ? ` · ${session.sub_block}` : ''}`,
    bodyHTML: `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:8px;margin-bottom:14px;background:var(--green-bg);font-size:12px;color:var(--green)">
        <div>✓</div>
        <div><strong>Total planted: ${totalHa.toFixed(2)} ha</strong> across ${rows.length} row${rows.length !== 1 ? 's' : ''} · ${totalBags} bags · ${_sessionTotalKg(session.id, session).toFixed(0)} kg seed used.</div>
      </div>
      <div style="font-size:13px;color:var(--fg2);margin-bottom:14px">Record end-of-session details before marking complete. This locks the session against further row entry.</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Seed Carried Out (bags)</label>
          <input id="cs-seed-out" type="number" min="0" placeholder="0"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div>
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Water Carried Out (L)</label>
          <input id="cs-water-out" type="number" min="0" placeholder="0"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div style="grid-column:1/-1">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Next Field</label>
          <input id="cs-next-field" type="text" placeholder="e.g. DL"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
        <div style="grid-column:1/-1">
          <label style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--hint);display:block;margin-bottom:4px">Closing Notes</label>
          <input id="cs-notes" type="text" placeholder="Optional"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:14px;font-family:inherit;box-sizing:border-box">
        </div>
      </div>`,
    confirmLabel: 'Close Session ✓',
    confirmClass: 'btn-success',
    onConfirm: async (modalEl) => {
      const updates = {
        status:          'closed',
        seed_out_bags:   parseFloat(modalEl.querySelector('#cs-seed-out')?.value) || null,
        water_out_litres: parseFloat(modalEl.querySelector('#cs-water-out')?.value) || null,
        next_field:      modalEl.querySelector('#cs-next-field')?.value?.trim() || null,
        closing_notes:   modalEl.querySelector('#cs-notes')?.value?.trim() || null,
      };
      await dbUpdate('planting_sessions', session.id, updates);
      Object.assign(session, updates);
      toast('Session closed', 'success');
      _view = 'list';
      _render();
    },
  });
}
