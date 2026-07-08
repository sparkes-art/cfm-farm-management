// modules/water/water.js
// Water entitlement and usage management

import { dbSelect, dbInsert, dbUpdate, dbDelete, subscribeTable } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite, getActiveSeason } from '../../js/app-state.js';
import { toast, openModal, formatCurrency, formatNumber, formatDate, qs, currentSeason } from '../../js/ui.js';

let _activeTab = 'dashboard';
let _sources = [];
let _entitlements = [];
let _accounts = [];
let _trades = [];
let _usage = [];
let _budgets = [];
let _announcements = [];
let _waterYear = null;
let _realtimeSub = null;

function currentWaterYear() {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  // Water year: 1 Jul – 30 Jun
  return m >= 7 ? `${y}-${String(y+1).slice(2)}` : `${y-1}-${String(y).slice(2)}`;
}

function waterYearOptions(selected) {
  const current = currentWaterYear();
  const [y] = current.split('-').map(Number);
  return Array.from({length: 5}, (_, i) => {
    const sy = y + 1 - i;
    const s = `${sy}-${String(sy+1).slice(2)}`;
    return `<option value="${s}" ${s === (selected||current) ? 'selected' : ''}>${s}</option>`;
  }).join('');
}

export async function mountWater(container) {
  const farm = getActiveFarm();
  if (!farm) {
    container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>';
    return;
  }

  _waterYear = _waterYear || currentWaterYear();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Water</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid)">${farm.name}</p>
      </div>
      <div class="flex gap-2 items-center">
        <label style="font-size:var(--text-sm);color:var(--muted)">Water year</label>
        <select id="water-year-select" class="form-select" style="width:110px">
          ${waterYearOptions(_waterYear)}
        </select>
      </div>
    </div>

    <div class="tab-strip" style="margin-bottom:16px">
      <button class="tab-btn ${_activeTab==='dashboard'?'active':''}" data-tab="dashboard">Dashboard</button>
      <button class="tab-btn ${_activeTab==='sources'?'active':''}" data-tab="sources">Entitlements</button>
      <button class="tab-btn ${_activeTab==='accounts'?'active':''}" data-tab="accounts">Allocations</button>
      <button class="tab-btn ${_activeTab==='trades'?'active':''}" data-tab="trades">Trades</button>
      <button class="tab-btn ${_activeTab==='usage'?'active':''}" data-tab="usage">Usage</button>
      <button class="tab-btn ${_activeTab==='budget'?'active':''}" data-tab="budget">Budget</button>
    </div>

    <div id="water-tab-content"></div>
  `;

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _renderTab(container, farm);
    });
  });

  qs('#water-year-select', container)?.addEventListener('change', async (e) => {
    _waterYear = e.target.value;
    await _loadData(farm);
    _renderTab(container, farm);
  });

  await _loadData(farm);
  _renderTab(container, farm);

  // Subscribe to announcement changes so dashboard updates without refresh
  _realtimeSub = subscribeTable('water_announcements', farm.id, async () => {
    _announcements = await dbSelect('water_announcements', 'farm_id=eq.' + farm.id + '&select=*&order=announcement_date.asc');
    _renderTab(container, farm);
  });
}

export function unmountWater() {
  _sources = []; _entitlements = []; _accounts = [];
  _trades = []; _usage = []; _budgets = []; _announcements = [];
  if (_realtimeSub) { _realtimeSub(); _realtimeSub = null; }
}

async function _loadData(farm) {
  try {
    [_sources, _entitlements, _accounts, _trades, _usage, _budgets, _announcements] = await Promise.all([
      dbSelect('water_sources', 'farm_id=eq.' + farm.id + '&select=*&order=name.asc'),
      dbSelect('water_entitlements', 'farm_id=eq.' + farm.id + '&select=*'),
      dbSelect('water_accounts', 'farm_id=eq.' + farm.id + '&water_year=eq.' + _waterYear + '&select=*'),
      dbSelect('water_trades', 'farm_id=eq.' + farm.id + '&water_year=eq.' + _waterYear + '&select=*&order=trade_date.desc'),
      dbSelect('water_usage', 'farm_id=eq.' + farm.id + '&water_year=eq.' + _waterYear + '&select=*&order=usage_date.desc'),
      dbSelect('water_budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + (getActiveSeason()||currentSeason()) + '&select=*'),
      dbSelect('water_announcements', 'farm_id=eq.' + farm.id + '&select=*&order=announcement_date.asc'),
    ]);
  } catch (err) {
    console.error('Water load error:', err);
  }
}

function _renderTab(container, farm) {
  const content = qs('#water-tab-content', container);
  if (!content) return;

  switch (_activeTab) {
    case 'dashboard':  _renderDashboard(content, farm); break;
    case 'sources':    _renderSources(content, farm); break;
    case 'accounts':   _renderAccounts(content, farm); break;
    case 'trades':     _renderTrades(content, farm); break;
    case 'usage':      _renderUsage(content, farm); break;
    case 'budget':     _renderBudget(content, farm); break;
  }
}

// ── Dashboard ─────────────────────────────────────────────────
let _dashMonth = 5; // 0=Jul,1=Aug,...,5=Dec,6=Jan,...,11=Jun — default June (month 11 of water year = index 11)

function _renderDashboard(content, farm, asAtMonthIndex) {
  // Month filter — water year months: Jul(0) Aug(1) Sep(2) Oct(3) Nov(4) Dec(5) Jan(6) Feb(7) Mar(8) Apr(9) May(10) Jun(11)
  // Default to June (index 11 = full year)
  if (asAtMonthIndex === undefined) asAtMonthIndex = _dashMonth;
  const monthNames = ['Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];

  // Determine cutoff date from month index and water year
  const [wyStartYr] = _waterYear.split('-').map(Number);
  const calMonths = [6,7,8,9,10,11,0,1,2,3,4,5]; // Jul=6, Aug=7,...Jun=5
  const calMonth = calMonths[asAtMonthIndex]; // 0-based calendar month
  const calYear = calMonth >= 6 ? wyStartYr : wyStartYr + 1;
  // Last day of chosen month
  const cutoffDate = new Date(calYear, calMonth + 1, 0); // last day of month
  const cutoffStr = cutoffDate.toISOString().slice(0,10);

  // Filter usage and trades up to cutoff
  const usageToDate = _usage.filter(u => u.usage_date <= cutoffStr);
  const tradesToDate = _trades.filter(t => !t.trade_date || t.trade_date <= cutoffStr);

  // Announcements up to cutoff
  const yearAnnouncementsToDate = _announcements.filter(a => a.water_year === _waterYear && a.announcement_date <= cutoffStr);

  const totalEntitlement = _entitlements.reduce((s, e) => s + (parseFloat(e.ml_held)||0), 0);

  const totalAnnouncedMl = _entitlements.filter(e => e.wal_number).reduce((sum, e) => {
    const walAnns = yearAnnouncementsToDate.filter(a => a.wal_number === e.wal_number);
    const mlPerShare = walAnns.reduce((s,a) => s+(parseFloat(a.ml_per_share)||0), 0);
    return sum + mlPerShare * (parseFloat(e.ml_held)||0);
  }, 0);
  const totalAllocation = totalAnnouncedMl || _accounts.reduce((s, a) => s + (parseFloat(a.opening_allocation_ml)||0), 0);
  const totalCarryover = _accounts.reduce((s, a) => {
    const gross = parseFloat(a.carryover_in_ml)||0;
    const loss = parseFloat(a.carryover_loss_pct)||0;
    return s + (gross * (1 - loss/100));
  }, 0);
  const totalTradesIn = tradesToDate.filter(t => t.trade_type==='buy').reduce((s,t) => s+(parseFloat(t.ml)||0), 0);
  const totalTradesOut = tradesToDate.filter(t => t.trade_type==='sell').reduce((s,t) => s+(parseFloat(t.ml)||0), 0);
  const totalUsed = usageToDate.reduce((s, u) => s + (parseFloat(u.ml_used)||0), 0);
  const totalAvailable = totalAllocation + totalCarryover + totalTradesIn - totalTradesOut;
  const totalRemaining = Math.max(0, totalAvailable - totalUsed);
  const usagePct = totalAvailable ? Math.round((totalUsed/totalAvailable)*100) : 0;
  const totalBudgeted = _budgets.reduce((s,b) => s + (parseFloat(b.budgeted_ml)||((parseFloat(b.ml_per_ha)||0)*(parseFloat(b.area_ha)||0))), 0);

  // Group entitlements by category for the breakdown table
  const categories = [...new Set(_entitlements.map(e => e.licence_category).filter(Boolean))];

  content.innerHTML = `
    <!-- Month filter -->
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
      <p style="font-size:var(--text-sm);color:var(--muted);white-space:nowrap">Position as at end of</p>
      <div style="display:flex;gap:4px;flex-wrap:wrap">
        ${monthNames.map((m, i) => `
          <button class="btn btn-sm dash-month-btn ${i===asAtMonthIndex?'btn-primary':'btn-ghost'}" data-month="${i}">${m}</button>
        `).join('')}
      </div>
    </div>

    <!-- Summary cards -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
      ${[
        ['Total Entitlement', formatNumber(totalEntitlement,1)+' ML', 'Permanent holdings', 'var(--ink)'],
        ['Announced to '+monthNames[asAtMonthIndex], formatNumber(totalAllocation,1)+' ML', 'Announced allocation to date', 'var(--blue)'],
        ['Used', formatNumber(totalUsed,1)+' ML', usagePct+'% of available', 'var(--green)'],
        ['Remaining', formatNumber(totalRemaining,1)+' ML', 'Available − used', totalRemaining < totalAvailable*0.2 ? 'var(--red)' : 'var(--ink)'],
      ].map(([l,v,s,c]) => `
        <div class="card" style="padding:14px">
          <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:6px">${l}</p>
          <p style="font-size:24px;font-weight:600;color:${c};margin-bottom:2px;font-variant-numeric:tabular-nums">${v}</p>
          <p style="font-size:11px;color:var(--hint)">${s}</p>
        </div>
      `).join('')}
    </div>

    <!-- Usage bar -->
    <div class="card" style="padding:16px;margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <p style="font-size:var(--text-sm);font-weight:600">Water usage — ${_waterYear} to end of ${monthNames[asAtMonthIndex]}</p>
        <p style="font-size:var(--text-sm);color:var(--hint)">${formatNumber(totalUsed,1)} of ${formatNumber(totalAvailable,1)} ML used</p>
      </div>
      <div style="height:10px;background:var(--border-light);border-radius:5px;overflow:hidden;margin-bottom:6px">
        <div style="height:100%;width:${Math.min(100,usagePct)}%;background:${usagePct>90?'var(--red)':usagePct>70?'var(--amber)':'var(--blue)'};border-radius:5px;transition:width .3s"></div>
      </div>
      ${totalBudgeted ? `
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--hint)">
        <span>Budget: ${formatNumber(totalBudgeted,1)} ML</span>
        <span>${Math.round((totalUsed/totalBudgeted)*100)}% of budget used</span>
      </div>` : ''}
    </div>

    <!-- By category breakdown -->
    ${categories.length ? `
    <div class="card" style="overflow:hidden">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border-light)">
        <p style="font-size:var(--text-sm);font-weight:600">By licence category</p>
      </div>
      <table class="data-table">
        <thead><tr>
          <th style="background:var(--surface-alt,#f9fafb)">Category</th>
          <th class="num" style="background:var(--surface-alt,#f9fafb)">Entitlement (ML)</th>
          <th class="num">Announced (ML)</th>
          <th class="num">Alloc %</th>
          <th class="num">Carryover (ML)</th>
          <th class="num">Trades (ML)</th>
          <th class="num">Available (ML)</th>
          <th class="num">Used (ML)</th>
          <th class="num">Remaining (ML)</th>
        </tr></thead>
        <tbody>
          ${categories.map(cat => {
            const catEnts = _entitlements.filter(e => e.licence_category === cat);
            const ent = catEnts.reduce((s,e) => s+(parseFloat(e.ml_held)||0), 0);
            const announced = catEnts.filter(e => e.wal_number).reduce((sum,e) => {
              const walAnns = yearAnnouncementsToDate.filter(a => a.wal_number === e.wal_number);
              const mlPerShare = walAnns.reduce((s,a) => s+(parseFloat(a.ml_per_share)||0), 0);
              return sum + mlPerShare * (parseFloat(e.ml_held)||0);
            }, 0);
            const catSourceIds = [...new Set(catEnts.map(e => e.source_id).filter(Boolean))];
            const carry = _accounts.filter(a => catSourceIds.includes(a.source_id)).reduce((s,a) => {
              const gross = parseFloat(a.carryover_in_ml)||0;
              const loss = parseFloat(a.carryover_loss_pct)||0;
              return s + gross*(1-loss/100);
            }, 0);
            const alloc = announced || _accounts.filter(a => catSourceIds.includes(a.source_id)).reduce((s,a) => s+(parseFloat(a.opening_allocation_ml)||0), 0);
            const allocPct = ent ? Math.round((alloc/ent)*100) : null;
            const tIn = tradesToDate.filter(t => catSourceIds.includes(t.source_id) && t.trade_type==='buy').reduce((s,t)=>s+(parseFloat(t.ml)||0),0);
            const tOut = tradesToDate.filter(t => catSourceIds.includes(t.source_id) && t.trade_type==='sell').reduce((s,t)=>s+(parseFloat(t.ml)||0),0);
            const avail = alloc + carry + tIn - tOut;
            const used = usageToDate.filter(u => catSourceIds.includes(u.source_id)).reduce((s,u)=>s+(parseFloat(u.ml_used)||0),0);
            const rem = Math.max(0, avail - used);
            return `<tr>
              <td style="background:var(--surface-alt,#f9fafb)"><strong>${cat}</strong></td>
              <td class="num" style="background:var(--surface-alt,#f9fafb)">${formatNumber(ent,1)}</td>
              <td class="num">${alloc ? formatNumber(alloc,1) : '—'}</td>
              <td class="num">${allocPct !== null ? '<span style="font-size:11px;color:var(--muted)">'+allocPct+'%</span>' : '—'}</td>
              <td class="num">${carry ? formatNumber(carry,1) : '—'}</td>
              <td class="num" style="color:${tIn-tOut>=0?'var(--green)':'var(--red)'}">${tIn||tOut?(tIn-tOut>=0?'+':'')+formatNumber(tIn-tOut,1):'—'}</td>
              <td class="num"><strong style="color:var(--blue)">${formatNumber(avail,1)}</strong></td>
              <td class="num">${used ? formatNumber(used,1) : '—'}</td>
              <td class="num" style="color:${rem<avail*0.2?'var(--red)':'var(--ink)'}"><strong>${avail ? formatNumber(rem,1) : '—'}</strong></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ` : `<div class="empty-state"><p>No entitlements with categories found.</p><p>Go to <strong>Entitlements</strong> to add your water entitlements.</p></div>`}
  `;

  // Wire month buttons
  content.querySelectorAll('.dash-month-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _dashMonth = parseInt(btn.dataset.month);
      _renderDashboard(content, farm, _dashMonth);
    });
  });
}

// ── Sources & Entitlements ────────────────────────────────────
function _renderSources(content, farm) {
  content.innerHTML = `
    <!-- Permanent Entitlements — primary section -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <p style="font-weight:600;font-size:var(--text-sm)">Permanent Entitlements</p>
      ${canWrite() ? '<button class="btn btn-secondary btn-sm" id="btn-add-entitlement">＋ Add entitlement</button>' : ''}
    </div>
    <div class="card" style="overflow:hidden;margin-bottom:24px">
      ${_entitlements.length ? `
      <table class="data-table">
        <thead><tr><th>WAL</th><th>Source</th><th>Category</th><th class="num">ML held</th><th>Purchased</th><th class="num">$/ML</th>${canWrite()?'<th></th>':''}</tr></thead>
        <tbody>
          ${_entitlements.filter(e => e.ml_held || e.wal_number || e.water_source_name).map(e => {
            const src = _sources.find(s => s.id === e.source_id);
            return `<tr>
              <td class="muted">${e.wal_number||'—'}</td>
              <td><strong>${e.water_source_name || src?.name||'—'}</strong></td>
              <td class="muted">${e.licence_category||'—'}</td>
              <td class="num"><strong>${formatNumber(e.ml_held,1)}</strong></td>
              <td class="muted">${e.purchase_date ? formatDate(e.purchase_date) : '—'}</td>
              <td class="num">${e.purchase_price_per_ml ? formatCurrency(e.purchase_price_per_ml,0) : '—'}</td>
              ${canWrite()?`<td><button class="btn btn-ghost btn-sm edit-entitlement-btn" data-id="${e.id}">Edit</button></td>`:''}
            </tr>`;
          }).join('')}
          <tr style="font-weight:600;border-top:2px solid var(--border)">
            <td colspan="3">Total</td>
            <td class="num">${formatNumber(_entitlements.reduce((s,e)=>s+(parseFloat(e.ml_held)||0),0),1)} ML</td>
            <td colspan="${canWrite()?3:2}"></td>
          </tr>
        </tbody>
      </table>` : '<div class="empty-state" style="padding:20px"><p>No entitlements recorded. Click ＋ Add entitlement to get started.</p></div>'}
    </div>

    <!-- Water Sources — secondary / reference -->
    <details>
      <summary style="cursor:pointer;font-weight:600;font-size:var(--text-sm);color:var(--muted);margin-bottom:10px;user-select:none">
        Water Sources (${_sources.length}) — reference data
      </summary>
      <div style="margin-top:10px">
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          ${canWrite() ? '<button class="btn btn-ghost btn-sm" id="btn-add-source">＋ Add source manually</button>' : ''}
        </div>
        <div class="card" style="overflow:hidden">
          ${_sources.length ? `
          <table class="data-table">
            <thead><tr><th>Name</th><th>Authority</th><th>Zone</th><th>Share class</th>${canWrite()?'<th></th>':''}</tr></thead>
            <tbody>
              ${_sources.map(s => `<tr>
                <td><strong>${s.name}</strong></td>
                <td class="muted">${s.authority||'—'}</td>
                <td class="muted">${s.zone||'—'}</td>
                <td class="muted">${s.share_class||'—'}</td>
                ${canWrite()?`<td><button class="btn btn-ghost btn-sm edit-source-btn" data-id="${s.id}">Edit</button></td>`:''}
              </tr>`).join('')}
            </tbody>
          </table>` : '<div class="empty-state" style="padding:20px"><p>Sources are created automatically when you add an entitlement via WAL lookup.</p></div>'}
        </div>
      </div>
    </details>
  `;

  // Wire buttons
  qs('#btn-add-source', content)?.addEventListener('click', () => _sourceModal(content, farm));
  qs('#btn-add-entitlement', content)?.addEventListener('click', () => _entitlementModal(content, farm));
  content.querySelectorAll('.edit-source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const src = _sources.find(s => s.id === btn.dataset.id);
      if (src) _sourceModal(content, farm, src);
    });
  });
  content.querySelectorAll('.edit-entitlement-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ent = _entitlements.find(e => e.id === btn.dataset.id);
      if (ent) _entitlementModal(content, farm, ent);
    });
  });
}

// ── Seasonal Accounts ─────────────────────────────────────────
function _renderAccounts(content, farm) {
  // Calculate announced allocation for current water year per entitlement
  const yearAnnouncements = _announcements.filter(a => a.water_year === _waterYear);

  // Group announcements by water_source for chart
  const announcementsBySource = {};
  for (const a of _announcements) {
    const key = a.water_source || 'Unknown';
    if (!announcementsBySource[key]) announcementsBySource[key] = [];
    announcementsBySource[key].push(a);
  }

  // Build chart data — cumulative ML per share by date, per year, for each source
  const chartSources = Object.keys(announcementsBySource);

  // For each entitlement, sum announced ML for current water year
  function announcedMlForEntitlement(ent) {
    const walAnnouncements = yearAnnouncements.filter(a => a.wal_number === ent.wal_number);
    const totalPerShare = walAnnouncements.reduce((s,a) => s + (parseFloat(a.ml_per_share)||0), 0);
    return totalPerShare * (parseFloat(ent.ml_held)||0);
  }

  content.innerHTML = `
    <!-- Announcement-driven allocation summary -->
    ${_entitlements.length && yearAnnouncements.length ? `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <p style="font-weight:600;font-size:var(--text-sm);margin-bottom:12px">Announced Allocation — ${_waterYear}</p>
      <table class="data-table">
        <thead><tr>
          <th style="background:var(--surface-alt,#f9fafb)">WAL</th>
          <th style="background:var(--surface-alt,#f9fafb)">Water Source</th>
          <th style="background:var(--surface-alt,#f9fafb)">Category</th>
          <th class="num" style="background:var(--surface-alt,#f9fafb)">Shares</th>
          <th class="num">ML/share announced</th>
          <th class="num">Alloc %</th>
          <th class="num">Total announced (ML)</th>
        </tr></thead>
        <tbody>
          ${_entitlements.filter(e => e.wal_number).map(e => {
            const walAnns = yearAnnouncements.filter(a => a.wal_number === e.wal_number);
            const mlPerShare = walAnns.reduce((s,a) => s+(parseFloat(a.ml_per_share)||0), 0);
            const totalMl = mlPerShare * (parseFloat(e.ml_held)||0);
            // Allocation % = ML/share announced / max possible (use licence conditions ml_per_unit if known, else 1.5 default for groundwater)
            const maxMlPerShare = 1.5; // will improve once we have licence condition data
            const allocPct = mlPerShare ? Math.round((mlPerShare/maxMlPerShare)*100) : null;
            return `<tr>
              <td class="muted" style="background:var(--surface-alt,#f9fafb)">${e.wal_number}</td>
              <td style="background:var(--surface-alt,#f9fafb)"><strong>${e.water_source_name || '—'}</strong></td>
              <td class="muted" style="background:var(--surface-alt,#f9fafb)">${e.licence_category||'—'}</td>
              <td class="num" style="background:var(--surface-alt,#f9fafb)">${formatNumber(e.ml_held,0)}</td>
              <td class="num">${formatNumber(mlPerShare,2)}</td>
              <td class="num"><span style="font-size:11px;color:var(--muted)">${allocPct !== null ? allocPct+'%' : '—'}</span></td>
              <td class="num"><strong style="color:var(--blue)">${formatNumber(totalMl,1)}</strong></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>` : ''}

    <!-- Allocation timeline chart -->
    ${_announcements.length ? `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <p style="font-weight:600;font-size:var(--text-sm)">Allocation Timeline — ML per share</p>
        <select id="chart-category-filter" class="form-select" style="width:200px;font-size:var(--text-sm)">
          ${[...new Set(_announcements.map(a => a.category).filter(Boolean))].sort().map(c =>
            '<option value="' + c + '">' + c + '</option>'
          ).join('')}
        </select>
      </div>
      <p class="muted" style="font-size:var(--text-xs);margin-bottom:12px">Cumulative announced ML/share through each water year</p>
      <canvas id="allocation-chart" style="width:100%;max-height:280px"></canvas>
    </div>` : ''}

    <!-- Seasonal accounts table -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <p style="font-weight:600;font-size:var(--text-sm)">Seasonal Accounts — ${_waterYear}</p>
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" id="btn-sync-announcements">↻ Sync announcements</button>
        ${canWrite() && _sources.length ? '<button class="btn btn-secondary btn-sm" id="btn-add-account">＋ Add / update account</button>' : ''}
      </div>
    </div>
    <div class="card" style="overflow:hidden">
      ${_accounts.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Source</th>
          <th>Category</th>
          <th class="num">Announced (ML)</th>
          <th class="num">Carryover in (ML)</th>
          <th class="num">Carryover loss %</th>
          <th class="num">Net carryover (ML)</th>
          <th class="num">Trades (ML)</th>
          <th class="num">Available (ML)</th>
          <th>Notes</th>
          ${canWrite()?'<th></th>':''}
        </tr></thead>
        <tbody>
          ${_accounts.map(a => {
            const src = _sources.find(s => s.id === a.source_id);
            // Find entitlements for this source
            const sourceEnts = _entitlements.filter(e => e.source_id === a.source_id && e.wal_number);
            const announcedMl = sourceEnts.reduce((sum, e) => {
              const walAnns = yearAnnouncements.filter(an => an.wal_number === e.wal_number);
              const mlPerShare = walAnns.reduce((s,an) => s+(parseFloat(an.ml_per_share)||0), 0);
              return sum + mlPerShare * (parseFloat(e.ml_held)||0);
            }, 0);
            // Fall back to manual opening_allocation_ml if no announcements
            const openingMl = announcedMl || (parseFloat(a.opening_allocation_ml)||0);
            const carryLoss = parseFloat(a.carryover_loss_pct)||0;
            const netCarry = (parseFloat(a.carryover_in_ml)||0) * (1-carryLoss/100);
            const tIn = _trades.filter(t=>t.source_id===a.source_id&&(t.trade_type==='buy')).reduce((s,t)=>s+(parseFloat(t.ml)||0),0);
            const tOut = _trades.filter(t=>t.source_id===a.source_id&&(t.trade_type==='sell')).reduce((s,t)=>s+(parseFloat(t.ml)||0),0);
            const avail = openingMl + netCarry + tIn - tOut;
            // Find category from entitlements for this source
            const srcEnt = _entitlements.find(e => e.source_id === a.source_id);
            return `<tr>
              <td><strong>${src?.name||'—'}</strong></td>
              <td class="muted">${srcEnt?.licence_category||'—'}</td>
              <td class="num">${announcedMl ? formatNumber(announcedMl,1) : formatNumber(a.opening_allocation_ml,1)}</td>
              <td class="num">${formatNumber(a.carryover_in_ml,1)||'—'}</td>
              <td class="num">${carryLoss ? carryLoss+'%' : '—'}</td>
              <td class="num">${netCarry ? formatNumber(netCarry,1) : '—'}</td>
              <td class="num" style="color:${tIn-tOut>=0?'var(--green)':'var(--red)'}">${tIn||tOut?(tIn-tOut>=0?'+':'')+formatNumber(tIn-tOut,1):'—'}</td>
              <td class="num"><strong style="color:var(--blue)">${formatNumber(avail,1)}</strong></td>
              <td class="muted text-sm">${a.notes||''}</td>
              ${canWrite()?`<td><button class="btn btn-ghost btn-sm edit-account-btn" data-id="${a.id}">Edit</button></td>`:''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `<div class="empty-state" style="padding:30px">
        <p>No seasonal accounts for ${_waterYear} yet.</p>
        ${canWrite()&&_sources.length?'<p>Add the opening allocation for each water source.</p>':''}
      </div>`}
    </div>
  `;

  // Wire buttons
  qs('#btn-add-account', content)?.addEventListener('click', () => _accountModal(content, farm));
  content.querySelectorAll('.edit-account-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const acc = _accounts.find(a => a.id === btn.dataset.id);
      if (acc) _accountModal(content, farm, acc);
    });
  });

  // Manual sync button
  qs('#btn-sync-announcements', content)?.addEventListener('click', async () => {
    const btn = qs('#btn-sync-announcements', content);
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const res = await fetch('/.netlify/functions/sync-water-announcements', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        toast('Announcements synced', 'success');
        await _loadData(farm);
        _renderAccounts(content, farm);
      } else {
        throw new Error(data.error || 'Sync failed');
      }
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = '↻ Sync announcements';
    }
  });

  // Draw allocation timeline chart
  if (_announcements.length) {
    const categories = [...new Set(_announcements.map(a => a.category).filter(Boolean))].sort();
    const defaultCat = categories[0] || null;
    _drawAllocationChart(content, defaultCat);

    qs('#chart-category-filter', content)?.addEventListener('change', (e) => {
      _drawAllocationChart(content, e.target.value);
    });
  }
}

function _drawAllocationChart(content, categoryFilter) {
  const canvas = qs('#allocation-chart', content);
  if (!canvas) return;

  // Filter by category
  const filtered = categoryFilter
    ? _announcements.filter(a => a.category === categoryFilter)
    : _announcements;

  const years = [...new Set(filtered.map(a => a.water_year))].sort();
  const wals = [...new Set(filtered.map(a => a.wal_number))].filter(Boolean);
  if (!wals.length || !years.length) return;

  // Use first WAL for chart
  const wal = wals[0];
  const walAnns = filtered
    .filter(a => a.wal_number === wal)
    .sort((a,b) => new Date(a.announcement_date) - new Date(b.announcement_date));

  // Show last 5 years max, current year always included
  const recentYears = years.slice(-5);
  if (!recentYears.includes(_waterYear) && years.includes(_waterYear)) {
    recentYears.pop();
    recentYears.push(_waterYear);
  }

  // Colour palette — current year solid blue, others muted
  const palette = ['#94a3b8','#64748b','#475569','#334155','#1e293b'];
  const currentColor = '#2563eb';

  // Build step-function datasets per year
  const datasets = recentYears.map((yr, i) => {
    const startYr = parseInt(yr.split('-')[0]);
    const wyStart = new Date(`${startYr}-07-01`);
    const yrAnns = walAnns.filter(a => a.water_year === yr);
    const isCurrent = yr === _waterYear;

    let cum = 0;
    const points = [{ x: 0, y: 0, label: null }];
    for (const a of yrAnns) {
      const dayOfYear = Math.round((new Date(a.announcement_date) - wyStart) / 86400000);
      cum += parseFloat(a.ml_per_share) || 0;
      points.push({ x: dayOfYear, y: parseFloat(cum.toFixed(3)), label: cum.toFixed(2), date: a.announcement_date });
    }
    // Extend to end of year
    if (points.length > 1) {
      const last = points[points.length - 1];
      if (last.x < 365) points.push({ x: 365, y: last.y, label: null });
    }

    return {
      label: yr,
      points,
      color: isCurrent ? currentColor : palette[i % palette.length],
      lineWidth: isCurrent ? 2.5 : 1,
      dash: isCurrent ? [] : [6, 3],
      alpha: isCurrent ? 1 : 0.4,
      isCurrent,
    };
  });

  // Canvas setup
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.parentElement.clientWidth - 32 || 600;
  const H = 260;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad = { top: 36, right: 24, bottom: 36, left: 52 };
  const cW = W - pad.left - pad.right;
  const cH = H - pad.top - pad.bottom;

  const allY = datasets.flatMap(d => d.points.map(p => p.y));
  const maxY = Math.max(...allY, 0.5);
  // Round maxY up to nearest 0.5
  const yMax = Math.ceil(maxY * 2) / 2;

  const toX = x => pad.left + (x / 365) * cW;
  const toY = y => pad.top + cH - (y / yMax) * cH;

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Horizontal grid lines
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const val = (yMax / ySteps) * i;
    const y = toY(val);
    ctx.strokeStyle = i === 0 ? '#cbd5e1' : '#f1f5f9';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + cW, y); ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px Inter,system-ui,sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(val < 1 ? 2 : 1), pad.left - 6, y + 3.5);
  }

  // Month vertical guides + labels
  const months = ['Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun'];
  const monthDays = [0,31,62,92,123,153,184,212,243,273,304,334];
  ctx.font = '10px Inter,system-ui,sans-serif';
  ctx.textAlign = 'center';
  monthDays.forEach((d, i) => {
    const x = toX(d);
    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + cH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(months[i], x, H - 6);
  });

  // Y axis label
  ctx.save();
  ctx.translate(11, pad.top + cH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px Inter,system-ui,sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('ML / share', 0, 0);
  ctx.restore();

  // Draw lines — non-current first so current renders on top
  const sorted = [...datasets].sort((a,b) => a.isCurrent ? 1 : -1);
  sorted.forEach(ds => {
    if (ds.points.length < 2) return;
    ctx.globalAlpha = ds.alpha;
    ctx.strokeStyle = ds.color;
    ctx.lineWidth = ds.lineWidth;
    ctx.setLineDash(ds.dash);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ds.points.forEach((p, i) => {
      if (i === 0) {
        ctx.moveTo(toX(p.x), toY(p.y));
      } else {
        // Step: go right first, then up
        ctx.lineTo(toX(p.x), toY(ds.points[i-1].y));
        ctx.lineTo(toX(p.x), toY(p.y));
      }
    });
    ctx.stroke();
    ctx.setLineDash([]);

    // Dots at announcement points
    ds.points.filter(p => p.label).forEach(p => {
      const x = toX(p.x);
      const y = toY(p.y);
      ctx.fillStyle = ds.color;
      ctx.globalAlpha = ds.isCurrent ? 1 : 0.5;
      ctx.beginPath();
      ctx.arc(x, y, ds.isCurrent ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Label only on current year
      if (ds.isCurrent) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#1e40af';
        ctx.font = 'bold 10px Inter,system-ui,sans-serif';
        ctx.textAlign = 'center';
        // Position label above dot, avoid top edge
        const labelY = y > pad.top + 18 ? y - 8 : y + 16;
        ctx.fillText(p.label + ' ML', x, labelY);
      }
    });

    ctx.globalAlpha = 1;
  });

  // Legend — top left, compact
  const legendYears = [...recentYears].reverse();
  let lx = pad.left;
  const ly = 14;
  ctx.font = '10px Inter,system-ui,sans-serif';
  legendYears.forEach(yr => {
    const ds = datasets.find(d => d.label === yr);
    if (!ds) return;
    ctx.globalAlpha = ds.alpha;
    ctx.strokeStyle = ds.color;
    ctx.lineWidth = ds.lineWidth;
    ctx.setLineDash(ds.dash);
    ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.fillStyle = ds.isCurrent ? '#1e3a8a' : '#64748b';
    ctx.font = ds.isCurrent ? 'bold 10px Inter,system-ui,sans-serif' : '10px Inter,system-ui,sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(yr, lx + 20, ly + 3.5);
    lx += ctx.measureText(yr).width + 36;
  });
}

// ── Trades ────────────────────────────────────────────────────
function _renderTrades(content, farm) {
  const tradeTypeLabel = { temp_in: 'Temp buy', temp_out: 'Temp sell', perm_in: 'Perm buy', perm_out: 'Perm sell' };
  const tradeTypeColor = { temp_in: 'var(--green)', temp_out: 'var(--red)', perm_in: 'var(--blue)', perm_out: 'var(--amber)' };

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <p style="font-weight:600;font-size:var(--text-sm)">Water Trades — ${_waterYear}</p>
      ${canWrite() && _sources.length ? '<button class="btn btn-secondary btn-sm" id="btn-add-trade">＋ Record trade</button>' : ''}
    </div>
    <div class="card" style="overflow:hidden">
      ${_trades.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Date</th><th>Source</th><th>Type</th>
          <th class="num">ML</th><th class="num">$/ML</th><th class="num">Total $</th>
          <th>Counterparty</th><th>Notes</th>
          ${canWrite()?'<th></th>':''}
        </tr></thead>
        <tbody>
          ${_trades.map(t => {
            const src = _sources.find(s => s.id === t.source_id);
            const total = (parseFloat(t.ml)||0) * (parseFloat(t.price_per_ml)||0);
            return `<tr>
              <td>${t.trade_date ? formatDate(t.trade_date) : '—'}</td>
              <td>${src?.name||'—'}</td>
              <td><span style="color:${tradeTypeColor[t.trade_type]||'var(--ink)'};font-weight:500">${tradeTypeLabel[t.trade_type]||t.trade_type}</span></td>
              <td class="num">${formatNumber(t.ml,1)}</td>
              <td class="num">${t.price_per_ml ? formatCurrency(t.price_per_ml,0) : '—'}</td>
              <td class="num">${total ? formatCurrency(total,0) : '—'}</td>
              <td class="muted">${t.counterparty||'—'}</td>
              <td class="muted text-sm">${t.notes||''}</td>
              ${canWrite()?`<td>
                <div class="flex gap-1">
                  <button class="btn btn-ghost btn-sm edit-trade-btn" data-id="${t.id}">Edit</button>
                  <button class="btn btn-ghost btn-sm delete-trade-btn" data-id="${t.id}" style="color:var(--red)">✕</button>
                </div>
              </td>`:''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `<div class="empty-state" style="padding:30px"><p>No trades recorded for ${_waterYear}.</p></div>`}
    </div>
  `;

  qs('#btn-add-trade', content)?.addEventListener('click', () => _tradeModal(content, farm));
  content.querySelectorAll('.edit-trade-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = _trades.find(t => t.id === btn.dataset.id);
      if (t) _tradeModal(content, farm, t);
    });
  });
  content.querySelectorAll('.delete-trade-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this trade?')) return;
      await dbDelete('water_trades', btn.dataset.id);
      _trades = _trades.filter(t => t.id !== btn.dataset.id);
      _renderTrades(content, farm);
    });
  });
}

// ── Usage ─────────────────────────────────────────────────────
function _renderUsage(content, farm) {
  const totalUsed = _usage.reduce((s,u) => s+(parseFloat(u.ml_used)||0), 0);

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>
        <p style="font-weight:600;font-size:var(--text-sm)">Water Usage — ${_waterYear}</p>
        <p style="font-size:11px;color:var(--hint)">Total used: <strong>${formatNumber(totalUsed,1)} ML</strong></p>
      </div>
      ${canWrite() && _sources.length ? '<button class="btn btn-secondary btn-sm" id="btn-add-usage">＋ Record usage</button>' : ''}
    </div>
    <div class="card" style="overflow:hidden">
      ${_usage.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Date</th><th>Source</th><th>Crop type</th><th>Paddock</th>
          <th class="num">ML used</th><th>Notes</th>
          ${canWrite()?'<th></th>':''}
        </tr></thead>
        <tbody>
          ${_usage.map(u => {
            const src = _sources.find(s => s.id === u.source_id);
            return `<tr>
              <td>${u.usage_date ? formatDate(u.usage_date) : '—'}</td>
              <td>${src?.name||'—'}</td>
              <td class="muted">${u.crop_type||'—'}</td>
              <td class="muted">${u.paddock_name||'—'}</td>
              <td class="num"><strong>${formatNumber(u.ml_used,2)}</strong></td>
              <td class="muted text-sm">${u.notes||''}</td>
              ${canWrite()?`<td>
                <div class="flex gap-1">
                  <button class="btn btn-ghost btn-sm edit-usage-btn" data-id="${u.id}">Edit</button>
                  <button class="btn btn-ghost btn-sm delete-usage-btn" data-id="${u.id}" style="color:var(--red)">✕</button>
                </div>
              </td>`:''}
            </tr>`;
          }).join('')}
          <tr style="font-weight:600;border-top:2px solid var(--border)">
            <td colspan="4">Total</td>
            <td class="num">${formatNumber(totalUsed,1)} ML</td>
            <td colspan="${canWrite()?2:1}"></td>
          </tr>
        </tbody>
      </table>` : `<div class="empty-state" style="padding:30px"><p>No usage recorded for ${_waterYear}.</p></div>`}
    </div>
  `;

  qs('#btn-add-usage', content)?.addEventListener('click', () => _usageModal(content, farm));
  content.querySelectorAll('.edit-usage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const u = _usage.find(u => u.id === btn.dataset.id);
      if (u) _usageModal(content, farm, u);
    });
  });
  content.querySelectorAll('.delete-usage-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this usage record?')) return;
      await dbDelete('water_usage', btn.dataset.id);
      _usage = _usage.filter(u => u.id !== btn.dataset.id);
      _renderUsage(content, farm);
    });
  });
}

// ── Budget ────────────────────────────────────────────────────
function _renderBudget(content, farm) {
  const season = getActiveSeason() || currentSeason();
  const totalBudgeted = _budgets.reduce((s,b) => s+(parseFloat(b.budgeted_ml)||((parseFloat(b.ml_per_ha)||0)*(parseFloat(b.area_ha)||0))),0);
  const totalUsed = _usage.reduce((s,u) => s+(parseFloat(u.ml_used)||0),0);

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div>
        <p style="font-weight:600;font-size:var(--text-sm)">Water Budget — ${season}</p>
        <p style="font-size:11px;color:var(--hint)">Budgeted: ${formatNumber(totalBudgeted,1)} ML · Used: ${formatNumber(totalUsed,1)} ML</p>
      </div>
      ${canWrite() ? '<button class="btn btn-secondary btn-sm" id="btn-add-budget">＋ Add crop budget</button>' : ''}
    </div>
    <div class="card" style="overflow:hidden">
      ${_budgets.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Crop type</th><th class="num">Area (ha)</th><th class="num">ML/ha</th>
          <th class="num">Budgeted ML</th><th class="num">Used ML</th><th class="num">Remaining ML</th><th class="num">% Used</th>
          ${canWrite()?'<th></th>':''}
        </tr></thead>
        <tbody>
          ${_budgets.map(b => {
            const budgetedML = parseFloat(b.budgeted_ml) || (parseFloat(b.ml_per_ha)||0)*(parseFloat(b.area_ha)||0);
            const usedML = _usage.filter(u => u.crop_type === b.crop_type).reduce((s,u)=>s+(parseFloat(u.ml_used)||0),0);
            const remaining = Math.max(0, budgetedML - usedML);
            const pct = budgetedML ? Math.round((usedML/budgetedML)*100) : 0;
            return `<tr>
              <td><strong>${b.crop_type||'—'}</strong></td>
              <td class="num">${b.area_ha ? formatNumber(b.area_ha,1) : '—'}</td>
              <td class="num">${b.ml_per_ha ? formatNumber(b.ml_per_ha,2) : '—'}</td>
              <td class="num">${formatNumber(budgetedML,1)}</td>
              <td class="num" style="color:var(--blue)">${formatNumber(usedML,1)||'—'}</td>
              <td class="num" style="color:${pct>100?'var(--red)':'var(--ink)'}">${formatNumber(remaining,1)}</td>
              <td class="num">
                <div style="display:flex;align-items:center;gap:6px">
                  <div style="flex:1;height:4px;background:var(--border-light);border-radius:2px;overflow:hidden;min-width:40px">
                    <div style="height:100%;width:${Math.min(100,pct)}%;background:${pct>100?'var(--red)':pct>80?'var(--amber)':'var(--blue)'};border-radius:2px"></div>
                  </div>
                  <span style="font-size:11px">${pct}%</span>
                </div>
              </td>
              ${canWrite()?`<td>
                <div class="flex gap-1">
                  <button class="btn btn-ghost btn-sm edit-budget-btn" data-id="${b.id}">Edit</button>
                  <button class="btn btn-ghost btn-sm delete-budget-btn" data-id="${b.id}" style="color:var(--red)">✕</button>
                </div>
              </td>`:''}
            </tr>`;
          }).join('')}
          <tr style="font-weight:600;border-top:2px solid var(--border)">
            <td colspan="3">Total</td>
            <td class="num">${formatNumber(totalBudgeted,1)} ML</td>
            <td class="num" style="color:var(--blue)">${formatNumber(totalUsed,1)} ML</td>
            <td class="num">${formatNumber(Math.max(0,totalBudgeted-totalUsed),1)} ML</td>
            <td class="num">${totalBudgeted ? Math.round((totalUsed/totalBudgeted)*100) : 0}%</td>
            ${canWrite()?'<td></td>':''}
          </tr>
        </tbody>
      </table>` : `<div class="empty-state" style="padding:30px"><p>No water budgets for ${season}.</p></div>`}
    </div>
  `;

  qs('#btn-add-budget', content)?.addEventListener('click', () => _budgetModal(content, farm, season));
  content.querySelectorAll('.edit-budget-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const b = _budgets.find(b => b.id === btn.dataset.id);
      if (b) _budgetModal(content, farm, season, b);
    });
  });
  content.querySelectorAll('.delete-budget-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this budget entry?')) return;
      await dbDelete('water_budgets', btn.dataset.id);
      _budgets = _budgets.filter(b => b.id !== btn.dataset.id);
      _renderBudget(content, farm);
    });
  });
}

// ── Modals ────────────────────────────────────────────────────
function _sourceModal(content, farm, existing = null) {
  openModal({
    title: existing ? 'Edit water source' : 'Add water source',
    confirmLabel: existing ? 'Save changes' : 'Add source',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Source name</label>
          <input class="form-input" id="ws-name" value="${existing?.name||''}" placeholder="e.g. Murray General Security"></div>
        <div class="form-group"><label class="form-label">Authority</label>
          <input class="form-input" id="ws-authority" value="${existing?.authority||''}" placeholder="e.g. Murray-Darling Basin Authority"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Zone / valley</label>
          <input class="form-input" id="ws-zone" value="${existing?.zone||''}" placeholder="e.g. Murray Valley"></div>
        <div class="form-group"><label class="form-label">Share class</label>
          <input class="form-input" id="ws-share-class" value="${existing?.share_class||''}" placeholder="e.g. General Security"></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea class="form-textarea" id="ws-notes" rows="2">${existing?.notes||''}</textarea></div>
    `,
    onConfirm: async (modal) => {
      const row = {
        farm_id: farm.id,
        name: qs('#ws-name', modal)?.value?.trim(),
        authority: qs('#ws-authority', modal)?.value?.trim() || null,
        zone: qs('#ws-zone', modal)?.value?.trim() || null,
        share_class: qs('#ws-share-class', modal)?.value?.trim() || null,
        notes: qs('#ws-notes', modal)?.value?.trim() || null,
      };
      if (!row.name) throw new Error('Source name is required');
      if (existing) {
        await dbUpdate('water_sources', existing.id, row);
        Object.assign(_sources.find(s => s.id === existing.id), row);
      } else {
        const saved = await dbInsert('water_sources', row);
        _sources.push(saved);
      }
      toast(existing ? 'Source updated' : 'Source added', 'success');
      _renderSources(content, farm);
    },
  });
}

function _entitlementModal(content, farm, existing = null) {
  const sourceOpts = _sources.map(s => `<option value="${s.id}" ${s.id===existing?.source_id?'selected':''}>${s.name}</option>`).join('');
  openModal({
    title: existing ? 'Edit entitlement' : 'Add entitlement',
    confirmLabel: existing ? 'Save changes' : 'Add entitlement',
    bodyHTML: `
      ${!existing ? `
      <div class="form-group" style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)">
        <label class="form-label">WAL Number <span class="text-muted">(optional — auto-fills details)</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <input class="form-input" id="we-wal" placeholder="e.g. WAL1234" style="max-width:180px" value="${existing?.wal_number||''}">
          <button type="button" class="btn btn-secondary btn-sm" id="we-wal-lookup">Look up</button>
          <span id="we-wal-status" style="font-size:var(--text-sm);color:var(--muted)"></span>
        </div>
      </div>` : `
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">WAL Number</label>
        <input class="form-input" id="we-wal" style="max-width:180px" value="${existing?.wal_number||''}">
      </div>`}
      <div class="form-row">
        <div class="form-group"><label class="form-label">Water source</label>
          <select class="form-select" id="we-source"><option value="">— select —</option>${sourceOpts}</select>
          <input class="form-input" id="we-source-name" placeholder="Or type source name" style="margin-top:6px" value="${existing?.water_source_name||''}">
          <p style="font-size:11px;color:var(--hint);margin-top:3px">Select existing source above, or type a new name</p>
        </div>
        <div class="form-group"><label class="form-label">ML held</label>
          <input class="form-input num" id="we-ml" type="number" step="0.1" value="${existing?.ml_held||''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Purchase date <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="we-date" type="date" value="${existing?.purchase_date||''}"></div>
        <div class="form-group"><label class="form-label">Purchase price ($/ML) <span class="text-muted">(optional)</span></label>
          <input class="form-input num" id="we-price" type="number" step="1" value="${existing?.purchase_price_per_ml||''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Licence category <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="we-category" value="${existing?.licence_category||''}" placeholder="e.g. General Security"></div>
        <div class="form-group"><label class="form-label">Licence purpose <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="we-purpose" value="${existing?.licence_purpose||''}" placeholder="e.g. Irrigation"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Nominated works approval <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="we-nominated-works" value="${existing?.nominated_works||''}"></div>
        <div class="form-group"><label class="form-label">Water sharing plan <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="we-plan" value="${existing?.water_sharing_plan||''}"></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea class="form-textarea" id="we-notes" rows="2">${existing?.notes||''}</textarea></div>
    `,
    onMounted: (modal) => {
      const lookupBtn = qs('#we-wal-lookup', modal);
      if (!lookupBtn) return;
      lookupBtn.addEventListener('click', async () => {
        const walRaw = qs('#we-wal', modal)?.value?.trim();
        if (!walRaw) { toast('Enter a WAL number first', 'warning'); return; }
        const status = qs('#we-wal-status', modal);
        status.textContent = 'Looking up…';
        lookupBtn.disabled = true;
        try {
          const res = await fetch('/.netlify/functions/lookup-wal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walNumber: walRaw }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Lookup failed');
          // Auto-fill fields from register response
          if (data.waterSource) qs('#we-source-name', modal).value = data.waterSource;
          if (data.shareML)     qs('#we-ml', modal).value = data.shareML;
          if (data.category)    qs('#we-category', modal).value = data.category;
          if (data.tenure)      qs('#we-purpose', modal).value = data.tenure;
          if (data.walNumber)   qs('#we-wal', modal).value = data.walNumber;
          if (data.nominatedWorks) qs('#we-nominated-works', modal).value = data.nominatedWorks;
          if (data.waterSharingPlan) qs('#we-plan', modal).value = data.waterSharingPlan;
          if (data.mlPerUnitShare) {
            const notes = [];
            notes.push('Max debit: ' + data.mlPerUnitShare + ' ML/unit share');
            if (data.carryoverMlPerUnitShare) notes.push('Max carryover: ' + data.carryoverMlPerUnitShare + ' ML/unit share');
            qs('#we-notes', modal).value = notes.join('. ');
          }
          status.textContent = '✓ Found';
          status.style.color = 'var(--success)';
        } catch (err) {
          status.textContent = err.message;
          status.style.color = 'var(--danger)';
        } finally {
          lookupBtn.disabled = false;
        }
      });
    },
    onConfirm: async (modal) => {
      const sourceName = qs('#we-source-name', modal)?.value?.trim();
      let sourceId = qs('#we-source', modal)?.value || null;

      // If they typed a new source name, create the source automatically
      if (!sourceId && sourceName) {
        const newSource = await dbInsert('water_sources', {
          farm_id: farm.id,
          name: sourceName,
        });
        _sources.push(newSource);
        sourceId = newSource.id;
      }

      const row = {
        farm_id: farm.id,
        source_id: sourceId,
        water_source_name: sourceName || null,
        wal_number: qs('#we-wal', modal)?.value?.trim() || null,
        ml_held: parseFloat(qs('#we-ml', modal)?.value)||0,
        purchase_date: qs('#we-date', modal)?.value || null,
        purchase_price_per_ml: parseFloat(qs('#we-price', modal)?.value)||null,
        licence_category: qs('#we-category', modal)?.value?.trim() || null,
        licence_purpose: qs('#we-purpose', modal)?.value?.trim() || null,
        nominated_works: qs('#we-nominated-works', modal)?.value?.trim() || null,
        water_sharing_plan: qs('#we-plan', modal)?.value?.trim() || null,
        notes: qs('#we-notes', modal)?.value?.trim()||null,
      };
      if (!row.source_id && !row.water_source_name) throw new Error('Please select or enter a water source');
      if (!row.ml_held) throw new Error('Please enter ML held');
      if (existing) {
        await dbUpdate('water_entitlements', existing.id, row);
        Object.assign(_entitlements.find(e => e.id === existing.id), row);
      } else {
        const saved = await dbInsert('water_entitlements', row);
        _entitlements.push(saved);
      }
      toast(existing ? 'Entitlement updated' : 'Entitlement added', 'success');
      _renderSources(content, farm);
    },
  });
}

function _accountModal(content, farm, existing = null) {
  const sourceOpts = _sources.map(s => `<option value="${s.id}" ${s.id===existing?.source_id?'selected':''}>${s.name}</option>`).join('');
  openModal({
    title: existing ? 'Edit seasonal account' : 'Add seasonal account',
    confirmLabel: existing ? 'Save changes' : 'Add account',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Water source</label>
          <select class="form-select" id="wa-source"><option value="">— select —</option>${sourceOpts}</select></div>
        <div class="form-group"><label class="form-label">Opening allocation (ML)</label>
          <input class="form-input num" id="wa-alloc" type="number" step="0.1" value="${existing?.opening_allocation_ml||''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Carryover from previous year (ML)</label>
          <input class="form-input num" id="wa-carry" type="number" step="0.1" value="${existing?.carryover_in_ml||''}"></div>
        <div class="form-group"><label class="form-label">Carryover loss %</label>
          <input class="form-input num" id="wa-loss" type="number" step="0.1" placeholder="0" value="${existing?.carryover_loss_pct||''}">
          <p style="font-size:11px;color:var(--hint);margin-top:3px">Evaporation/seepage loss on carried water</p>
        </div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea class="form-textarea" id="wa-notes" rows="2">${existing?.notes||''}</textarea></div>
    `,
    onConfirm: async (modal) => {
      const row = {
        farm_id: farm.id,
        source_id: qs('#wa-source', modal)?.value || null,
        water_year: _waterYear,
        opening_allocation_ml: parseFloat(qs('#wa-alloc', modal)?.value)||0,
        carryover_in_ml: parseFloat(qs('#wa-carry', modal)?.value)||0,
        carryover_loss_pct: parseFloat(qs('#wa-loss', modal)?.value)||0,
        notes: qs('#wa-notes', modal)?.value?.trim()||null,
      };
      if (!row.source_id) throw new Error('Please select a water source');
      if (existing) {
        await dbUpdate('water_accounts', existing.id, row);
        Object.assign(_accounts.find(a => a.id === existing.id), row);
      } else {
        const saved = await dbInsert('water_accounts', row);
        _accounts.push(saved);
      }
      toast(existing ? 'Account updated' : 'Account added', 'success');
      _renderAccounts(content, farm);
    },
  });
}

function _tradeModal(content, farm, existing = null) {
  const sourceOpts = _sources.map(s => `<option value="${s.id}" ${s.id===existing?.source_id?'selected':''}>${s.name}</option>`).join('');
  openModal({
    title: existing ? 'Edit trade' : 'Record water trade',
    confirmLabel: existing ? 'Save changes' : 'Save trade',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Water source</label>
          <select class="form-select" id="wt-source"><option value="">— select —</option>${sourceOpts}</select></div>
        <div class="form-group"><label class="form-label">Trade type</label>
          <select class="form-select" id="wt-type">
            <option value="temp_in" ${existing?.trade_type==='temp_in'?'selected':''}>Temporary buy</option>
            <option value="temp_out" ${existing?.trade_type==='temp_out'?'selected':''}>Temporary sell</option>
            <option value="perm_in" ${existing?.trade_type==='perm_in'?'selected':''}>Permanent buy</option>
            <option value="perm_out" ${existing?.trade_type==='perm_out'?'selected':''}>Permanent sell</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">ML</label>
          <input class="form-input num" id="wt-ml" type="number" step="0.1" value="${existing?.ml||''}"></div>
        <div class="form-group"><label class="form-label">Price ($/ML)</label>
          <input class="form-input num" id="wt-price" type="number" step="1" value="${existing?.price_per_ml||''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Trade date</label>
          <input class="form-input" id="wt-date" type="date" value="${existing?.trade_date||new Date().toISOString().slice(0,10)}"></div>
        <div class="form-group"><label class="form-label">Counterparty</label>
          <input class="form-input" id="wt-counterparty" value="${existing?.counterparty||''}" placeholder="e.g. Waterfind"></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea class="form-textarea" id="wt-notes" rows="2">${existing?.notes||''}</textarea></div>
    `,
    onConfirm: async (modal) => {
      const row = {
        farm_id: farm.id,
        source_id: qs('#wt-source', modal)?.value || null,
        water_year: _waterYear,
        trade_type: qs('#wt-type', modal)?.value,
        ml: parseFloat(qs('#wt-ml', modal)?.value)||0,
        price_per_ml: parseFloat(qs('#wt-price', modal)?.value)||null,
        trade_date: qs('#wt-date', modal)?.value||null,
        counterparty: qs('#wt-counterparty', modal)?.value?.trim()||null,
        notes: qs('#wt-notes', modal)?.value?.trim()||null,
      };
      if (!row.source_id) throw new Error('Please select a water source');
      if (!row.ml) throw new Error('Please enter ML amount');
      if (existing) {
        await dbUpdate('water_trades', existing.id, row);
        Object.assign(_trades.find(t => t.id === existing.id), row);
      } else {
        const saved = await dbInsert('water_trades', row);
        _trades.unshift(saved);
      }
      toast(existing ? 'Trade updated' : 'Trade recorded', 'success');
      _renderTrades(content, farm);
    },
  });
}

function _usageModal(content, farm, existing = null) {
  const sourceOpts = _sources.map(s => `<option value="${s.id}" ${s.id===existing?.source_id?'selected':''}>${s.name}</option>`).join('');
  openModal({
    title: existing ? 'Edit usage record' : 'Record water usage',
    confirmLabel: existing ? 'Save changes' : 'Save usage',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Water source</label>
          <select class="form-select" id="wu-source"><option value="">— select —</option>${sourceOpts}</select></div>
        <div class="form-group"><label class="form-label">Date</label>
          <input class="form-input" id="wu-date" type="date" value="${existing?.usage_date||new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">ML used</label>
          <input class="form-input num" id="wu-ml" type="number" step="0.01" value="${existing?.ml_used||''}"></div>
        <div class="form-group"><label class="form-label">Crop type <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="wu-crop" value="${existing?.crop_type||''}" placeholder="e.g. Cotton Flood"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Paddock <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="wu-paddock" value="${existing?.paddock_name||''}" placeholder="e.g. North paddock"></div>
        <div class="form-group"><label class="form-label">Notes</label>
          <input class="form-input" id="wu-notes" value="${existing?.notes||''}"></div>
      </div>
    `,
    onConfirm: async (modal) => {
      const row = {
        farm_id: farm.id,
        source_id: qs('#wu-source', modal)?.value || null,
        water_year: _waterYear,
        usage_date: qs('#wu-date', modal)?.value||null,
        ml_used: parseFloat(qs('#wu-ml', modal)?.value)||0,
        crop_type: qs('#wu-crop', modal)?.value?.trim()||null,
        paddock_name: qs('#wu-paddock', modal)?.value?.trim()||null,
        notes: qs('#wu-notes', modal)?.value?.trim()||null,
      };
      if (!row.source_id) throw new Error('Please select a water source');
      if (!row.ml_used) throw new Error('Please enter ML used');
      if (existing) {
        await dbUpdate('water_usage', existing.id, row);
        Object.assign(_usage.find(u => u.id === existing.id), row);
      } else {
        const saved = await dbInsert('water_usage', row);
        _usage.unshift(saved);
      }
      toast(existing ? 'Usage updated' : 'Usage recorded', 'success');
      _renderUsage(content, farm);
    },
  });
}

function _budgetModal(content, farm, season, existing = null) {
  openModal({
    title: existing ? 'Edit water budget' : 'Add water budget',
    confirmLabel: existing ? 'Save changes' : 'Add budget',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Crop type</label>
          <input class="form-input" id="wb-crop" value="${existing?.crop_type||''}" placeholder="e.g. Cotton Flood"></div>
        <div class="form-group"><label class="form-label">Area (ha)</label>
          <input class="form-input num" id="wb-area" type="number" step="0.1" value="${existing?.area_ha||''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">ML / ha</label>
          <input class="form-input num" id="wb-ml-ha" type="number" step="0.01" value="${existing?.ml_per_ha||''}"></div>
        <div class="form-group"><label class="form-label">Budgeted ML <span class="text-muted">(auto-calculated)</span></label>
          <input class="form-input num" id="wb-ml" type="number" step="0.1" value="${existing?.budgeted_ml||''}" placeholder="Auto from ML/ha × area"></div>
      </div>
    `,
    onConfirm: async (modal) => {
      const area = parseFloat(qs('#wb-area', modal)?.value)||null;
      const mlHa = parseFloat(qs('#wb-ml-ha', modal)?.value)||null;
      const row = {
        farm_id: farm.id,
        season,
        crop_type: qs('#wb-crop', modal)?.value?.trim()||null,
        area_ha: area,
        ml_per_ha: mlHa,
        budgeted_ml: parseFloat(qs('#wb-ml', modal)?.value)||(area&&mlHa?area*mlHa:null),
      };
      if (!row.crop_type) throw new Error('Please enter a crop type');
      if (existing) {
        await dbUpdate('water_budgets', existing.id, row);
        Object.assign(_budgets.find(b => b.id === existing.id), row);
      } else {
        const saved = await dbInsert('water_budgets', row);
        _budgets.push(saved);
      }
      toast(existing ? 'Budget updated' : 'Budget added', 'success');
      _renderBudget(content, farm);
    },
  });
}