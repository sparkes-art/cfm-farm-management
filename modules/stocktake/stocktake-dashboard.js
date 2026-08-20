// modules/stocktake/stocktake-dashboard.js
// Period dashboard — the control centre for the monthly stocktake

import { dbSelect, dbInsert, dbUpdate } from '../../js/supabase-client.js';
import { getActiveFarm, canWrite } from '../../js/app-state.js';
import { formatDate, qs, toast, openModal } from '../../js/ui.js';

export function unmountStocktakeDashboard() {}

export async function mountStocktakeDashboard(container) {
  const farm = getActiveFarm();
  if (!farm) {
    container.innerHTML = `<div style="padding:40px;text-align:center;color:var(--hint)">Select a farm to view stocktake</div>`;
    return;
  }

  container.innerHTML = `<div style="padding:20px 24px;max-width:1100px;margin:0 auto" id="stk-dash"></div>`;
  await _render(container);
}

async function _render(container) {
  const farm = getActiveFarm();
  const dash = qs('#stk-dash', container);
  dash.innerHTML = `<div style="padding:40px;text-align:center;color:var(--hint)">Loading...</div>`;

  const [periods, items, locations, movements, readings, counts] = await Promise.all([
    dbSelect('stock_periods', `farm_id=eq.${farm.id}&order=period_start.desc&limit=6`),
    dbSelect('stock_items', `farm_id=eq.${farm.id}&active=eq.true&select=id,category,name,default_unit`),
    dbSelect('stock_locations', `farm_id=eq.${farm.id}&active=eq.true&select=id,name,kind,has_fuel_tank,has_water_meter,route_order`),
    dbSelect('stock_movements', `farm_id=eq.${farm.id}&select=id,item_id,location_id,movement_type,signed_qty,unit,occurred_on,created_at&order=created_at.desc&limit=20`),
    dbSelect('stock_readings', `farm_id=eq.${farm.id}&select=id,location_id,reading_type,value,unit,read_on,not_read&order=read_on.desc&limit=50`),
    dbSelect('stock_counts', `farm_id=eq.${farm.id}&select=id,period_id,item_id,location_id,counted_qty,expected_qty,variance,reason_code,counted_at&order=counted_at.desc&limit=100`),
  ]);

  // Current period — most recent open one, or create
  const openPeriod = periods.find(p => p.status === 'open') || periods.find(p => p.status === 'review');
  const now = new Date();
  const periodLabel = openPeriod
    ? new Date(openPeriod.period_start).toLocaleDateString('en-AU', {month:'long', year:'numeric'})
    : now.toLocaleDateString('en-AU', {month:'long', year:'numeric'});

  // Stats
  const fuelTanks = locations.filter(l => l.has_fuel_tank);
  const waterMeters = locations.filter(l => l.has_water_meter);
  const fuelItems = items.filter(i => i.category === 'fuel');
  const chemItems = items.filter(i => i.category === 'chemical');
  const fertItems = items.filter(i => i.category === 'fertiliser');

  // Recent readings — this month
  const thisMonth = now.toISOString().slice(0,7);
  const recentReadings = readings.filter(r => r.read_on?.slice(0,7) === thisMonth);
  const tanksRead = new Set(recentReadings.filter(r=>r.reading_type==='fuel_dip').map(r=>r.location_id));
  const tanksNotRead = fuelTanks.filter(l => !tanksRead.has(l.id));

  // Unresolved variances
  const periodCounts = openPeriod ? counts.filter(c => c.period_id === openPeriod.id) : [];
  const unresolvedVariances = periodCounts.filter(c => c.variance !== 0 && !c.reason_code);

  // Recent movements
  const recentMoves = movements.slice(0, 8);

  // Section completion
  const sections = [
    { id: 'fuel', label: 'Fuel dips', icon: '⛽', done: tanksRead.size, total: fuelTanks.length, href: 'fuel' },
    { id: 'chemical', label: 'Chemicals', icon: '🧪', done: periodCounts.filter(c=>items.find(i=>i.id===c.item_id)?.category==='chemical').length, total: chemItems.length, href: 'chemical' },
    { id: 'fertiliser', label: 'Fertiliser', icon: '🌱', done: periodCounts.filter(c=>items.find(i=>i.id===c.item_id)?.category==='fertiliser').length, total: fertItems.length, href: 'fertiliser' },
    { id: 'water', label: 'Bore meters', icon: '💧', done: new Set(recentReadings.filter(r=>r.reading_type==='water_meter').map(r=>r.location_id)).size, total: waterMeters.length, href: 'water' },
  ];

  const statusColor = openPeriod?.status === 'locked' ? 'var(--green)' : openPeriod?.status === 'review' ? 'var(--amber)' : 'var(--blue)';
  const statusLabel = openPeriod?.status === 'locked' ? 'Locked' : openPeriod?.status === 'review' ? 'Under review' : 'Open';

  dash.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:12px">
      <div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${farm.name} Stocktake</div>
        <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
          <span style="font-size:13px;color:var(--hint)">${periodLabel}</span>
          <span style="font-size:11px;font-weight:600;color:${statusColor};background:${statusColor}18;border-radius:20px;padding:2px 10px">${statusLabel}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${canWrite() ? `
          <button class="btn btn-ghost btn-sm" id="stk-new-delivery">+ Delivery</button>
          <button class="btn btn-ghost btn-sm" id="stk-new-movement">+ Movement</button>
          ${!openPeriod ? `<button class="btn btn-primary btn-sm" id="stk-open-period">Open ${periodLabel}</button>` : ''}
          ${openPeriod?.status === 'open' ? `<button class="btn btn-primary btn-sm" id="stk-submit-period">Submit for review</button>` : ''}
          ${openPeriod?.status === 'review' ? `<button class="btn btn-primary btn-sm" id="stk-lock-period">Lock period</button>` : ''}
        ` : ''}
      </div>
    </div>

    <!-- Alert: tanks not yet read -->
    ${tanksNotRead.length ? `
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
        <span style="font-size:20px">⚠️</span>
        <div>
          <div style="font-size:13px;font-weight:600;color:#92400e">${tanksNotRead.length} fuel tank${tanksNotRead.length!==1?'s':''} not yet dipped this month</div>
          <div style="font-size:11px;color:#b45309;margin-top:2px">${tanksNotRead.slice(0,3).map(l=>l.name).join(', ')}${tanksNotRead.length>3?` and ${tanksNotRead.length-3} more`:''}</div>
        </div>
        <button class="btn btn-sm" style="margin-left:auto;background:#fcd34d;border:none;color:#92400e;font-weight:600" id="stk-go-fuel">Dip now →</button>
      </div>
    ` : ''}

    <!-- Variance alert -->
    ${unresolvedVariances.length ? `
      <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
        <span style="font-size:20px">🔴</span>
        <div>
          <div style="font-size:13px;font-weight:600;color:#991b1b">${unresolvedVariances.length} unresolved variance${unresolvedVariances.length!==1?'s':''} — period cannot close</div>
          <div style="font-size:11px;color:#b91c1c;margin-top:2px">Explain each variance before submitting</div>
        </div>
        <button class="btn btn-sm" style="margin-left:auto;background:#fca5a5;border:none;color:#991b1b;font-weight:600" id="stk-go-review">Resolve →</button>
      </div>
    ` : ''}

    <!-- Section progress -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px">
      ${sections.map(s => {
        const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
        const complete = pct === 100;
        return `
          <div class="stk-section-card" data-href="${s.href}" style="background:white;border:1px solid ${complete?'var(--green)':'var(--border)'};border-radius:10px;padding:16px;cursor:pointer;transition:box-shadow .15s">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
              <div style="display:flex;align-items:center;gap:8px">
                <span style="font-size:20px">${s.icon}</span>
                <span style="font-size:13px;font-weight:600;color:var(--ink)">${s.label}</span>
              </div>
              <span style="font-size:11px;font-weight:600;color:${complete?'var(--green)':'var(--hint)'}">${complete?'✓ Done':s.done+'/'+s.total}</span>
            </div>
            <div style="height:4px;background:var(--border-light);border-radius:2px;overflow:hidden">
              <div style="height:100%;width:${pct}%;background:${complete?'var(--green)':'var(--blue)'};border-radius:2px;transition:width .3s"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <!-- Two column layout: summary stats + recent activity -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">

      <!-- On hand summary -->
      <div style="background:white;border:1px solid var(--border);border-radius:10px;overflow:hidden">
        <div style="padding:14px 16px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;font-weight:600;color:var(--ink)">On hand</span>
          <span style="font-size:11px;color:var(--hint)">Live position</span>
        </div>
        <div style="padding:4px 0">
          ${[
            { label: 'Fuel tanks', value: fuelTanks.length, unit: 'tanks', sub: `${tanksRead.size} dipped this month`, ok: tanksRead.size === fuelTanks.length },
            { label: 'Chemicals', value: chemItems.length, unit: 'products', sub: `${chemItems.filter(i=>i.category==='chemical').length} tracked`, ok: true },
            { label: 'Fertiliser', value: fertItems.length, unit: 'products', sub: `${fertItems.length} tracked`, ok: true },
            { label: 'Bore meters', value: waterMeters.length, unit: 'meters', sub: `${new Set(recentReadings.filter(r=>r.reading_type==='water_meter').map(r=>r.location_id)).size} read this month`, ok: true },
          ].map(row => `
            <div style="display:flex;align-items:center;padding:10px 16px;border-bottom:1px solid var(--border-light)">
              <div style="flex:1">
                <div style="font-size:12px;font-weight:500;color:var(--ink)">${row.label}</div>
                <div style="font-size:11px;color:var(--hint);margin-top:1px">${row.sub}</div>
              </div>
              <div style="text-align:right">
                <span style="font-size:16px;font-weight:700;color:var(--ink)">${row.value}</span>
                <span style="font-size:11px;color:var(--hint);margin-left:3px">${row.unit}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Recent activity -->
      <div style="background:white;border:1px solid var(--border);border-radius:10px;overflow:hidden">
        <div style="padding:14px 16px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:13px;font-weight:600;color:var(--ink)">Recent activity</span>
          <span style="font-size:11px;color:var(--hint)">Last 8 movements</span>
        </div>
        <div style="padding:4px 0">
          ${recentMoves.length ? recentMoves.map(m => {
            const item = items.find(i => i.id === m.item_id);
            const loc = locations.find(l => l.id === m.location_id);
            const typeColors = { delivery:'var(--green)', usage:'var(--hint)', transfer_in:'var(--blue)', transfer_out:'var(--blue)', adjustment:'var(--amber)', sale:'var(--green)' };
            const typeLabels = { delivery:'Delivery', usage:'Usage', transfer_in:'Transfer in', transfer_out:'Transfer out', adjustment:'Adjustment', sale:'Sale', write_off:'Write-off' };
            return `
              <div style="display:flex;align-items:center;padding:8px 16px;border-bottom:1px solid var(--border-light);gap:10px">
                <div style="flex:1;min-width:0">
                  <div style="font-size:12px;font-weight:500;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item?.name || 'Unknown'}</div>
                  <div style="font-size:11px;color:var(--hint);margin-top:1px">${loc?.name || ''} · ${formatDate(m.occurred_on)}</div>
                </div>
                <div style="text-align:right;flex-shrink:0">
                  <div style="font-size:12px;font-weight:600;color:${typeColors[m.movement_type]||'var(--hint)'}">${(m.signed_qty>0?'+':'')+m.signed_qty} ${m.unit||''}</div>
                  <div style="font-size:10px;color:var(--hint)">${typeLabels[m.movement_type]||m.movement_type}</div>
                </div>
              </div>
            `;
          }).join('') : `<div style="padding:20px 16px;text-align:center;color:var(--hint);font-size:12px">No movements recorded yet</div>`}
        </div>
      </div>
    </div>

    <!-- Period history -->
    ${periods.length > 0 ? `
      <div style="background:white;border:1px solid var(--border);border-radius:10px;overflow:hidden">
        <div style="padding:14px 16px;border-bottom:1px solid var(--border-light)">
          <span style="font-size:13px;font-weight:600;color:var(--ink)">Period history</span>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--page-bg)">
              <th style="padding:8px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:600;border-bottom:1px solid var(--border-light)">Period</th>
              <th style="padding:8px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:600;border-bottom:1px solid var(--border-light)">Status</th>
              <th style="padding:8px 16px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:600;border-bottom:1px solid var(--border-light)">Submitted</th>
              <th style="padding:8px 16px;text-align:right;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);font-weight:600;border-bottom:1px solid var(--border-light)"></th>
            </tr>
          </thead>
          <tbody>
            ${periods.map(p => {
              const pLabel = new Date(p.period_start).toLocaleDateString('en-AU',{month:'long',year:'numeric'});
              const sColor = p.status==='locked'?'var(--green)':p.status==='review'?'var(--amber)':'var(--blue)';
              const sLabel = p.status==='locked'?'Locked':p.status==='review'?'Under review':'Open';
              return `
                <tr style="border-bottom:1px solid var(--border-light)">
                  <td style="padding:10px 16px;font-size:13px;font-weight:500;color:var(--ink)">${pLabel}</td>
                  <td style="padding:10px 16px"><span style="font-size:11px;font-weight:600;color:${sColor};background:${sColor}18;border-radius:20px;padding:2px 10px">${sLabel}</span></td>
                  <td style="padding:10px 16px;font-size:12px;color:var(--hint)">${p.submitted_at ? formatDate(p.submitted_at.slice(0,10)) : '—'}</td>
                  <td style="padding:10px 16px;text-align:right"><button class="btn btn-ghost btn-sm stk-view-period" data-id="${p.id}">View</button></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    ` : `
      <div style="background:white;border:1px solid var(--border);border-radius:10px;padding:40px;text-align:center">
        <div style="font-size:32px;margin-bottom:12px">📋</div>
        <div style="font-size:15px;font-weight:600;color:var(--ink);margin-bottom:6px">No stocktake periods yet</div>
        <div style="font-size:13px;color:var(--hint);margin-bottom:20px">Open the first period to start recording fuel dips, deliveries and counts</div>
        ${canWrite() ? `<button class="btn btn-primary" id="stk-open-period-empty">Open ${periodLabel}</button>` : ''}
      </div>
    `}
  `;

  // Wire buttons
  qs('#stk-go-fuel', container)?.addEventListener('click', () => _navigateTo('fuel', container));
  qs('#stk-go-review', container)?.addEventListener('click', () => _navigateTo('review', container));
  qs('#stk-new-delivery', container)?.addEventListener('click', () => _showDeliveryForm(container, items, locations));
  qs('#stk-new-movement', container)?.addEventListener('click', () => _showMovementForm(container, items, locations));

  container.querySelectorAll('.stk-section-card').forEach(card => {
    card.addEventListener('mouseenter', () => card.style.boxShadow = '0 2px 8px rgba(0,0,0,.08)');
    card.addEventListener('mouseleave', () => card.style.boxShadow = '');
    card.addEventListener('click', () => _navigateTo(card.dataset.href, container));
  });

  qs('#stk-open-period', container)?.addEventListener('click', () => _openPeriod(container, farm));
  qs('#stk-open-period-empty', container)?.addEventListener('click', () => _openPeriod(container, farm));
  qs('#stk-submit-period', container)?.addEventListener('click', () => _submitPeriod(container, openPeriod, unresolvedVariances.length));
  qs('#stk-lock-period', container)?.addEventListener('click', () => _lockPeriod(container, openPeriod));
}

async function _openPeriod(container, farm) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
  const end = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);
  try {
    await dbInsert('stock_periods', { farm_id: farm.id, period_start: start, period_end: end, status: 'open' });
    toast('Period opened', 'success');
    _render(container);
  } catch(e) { toast('Could not open period: ' + e.message, 'error'); }
}

async function _submitPeriod(container, period, unresolvedCount) {
  if (unresolvedCount > 0) {
    toast(`Resolve ${unresolvedCount} variance${unresolvedCount!==1?'s':''} before submitting`, 'error');
    return;
  }
  try {
    await dbUpdate('stock_periods', period.id, { status: 'review', submitted_at: new Date().toISOString() });
    toast('Period submitted for review', 'success');
    _render(container);
  } catch(e) { toast('Could not submit: ' + e.message, 'error'); }
}

async function _lockPeriod(container, period) {
  openModal({
    title: 'Lock period',
    bodyHTML: '<p style="font-size:14px">Lock this period? No further changes can be made once locked.</p>',
    confirmLabel: 'Lock period',
    onConfirm: async () => {
      await dbUpdate('stock_periods', period.id, { status: 'locked', locked_at: new Date().toISOString() });
      toast('Period locked', 'success');
      _render(container);
    }
  });
}

function _navigateTo(section, container) {
  // Will route to sub-sections once built
  toast(`${section} section coming soon`, 'info');
}

async function _showDeliveryForm(container, items, locations) {
  const farm = getActiveFarm();
  const deliveryItems = items.filter(i => ['fertiliser','chemical','fuel'].includes(i.category));

  openModal({
    title: 'Record delivery',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Item</label>
          <select class="form-select" id="del-item">
            <option value="">Select item...</option>
            ${deliveryItems.map(i=>`<option value="${i.id}" data-unit="${i.default_unit}">${i.name} (${i.category})</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Location</label>
          <select class="form-select" id="del-location">
            <option value="">Select location...</option>
            ${locations.map(l=>`<option value="${l.id}">${l.name}</option>`).join('')}
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label class="form-label">Quantity</label>
            <input class="form-input" type="number" id="del-qty" step="0.001" min="0" placeholder="0">
          </div>
          <div class="form-group">
            <label class="form-label">Unit</label>
            <input class="form-input" type="text" id="del-unit" placeholder="L / t / kg">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" type="date" id="del-date" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Docket / reference</label>
          <input class="form-input" type="text" id="del-docket" placeholder="Supplier docket number">
        </div>
        <div class="form-group">
          <label class="form-label">Supplier</label>
          <input class="form-input" type="text" id="del-supplier" placeholder="Supplier name">
        </div>
        <div class="form-group">
          <label class="form-label">Note (optional)</label>
          <input class="form-input" type="text" id="del-note" placeholder="">
        </div>
      </div>
    `,
    confirmLabel: 'Record delivery',
    onConfirm: async (modal) => {
      const itemId = modal.querySelector('#del-item')?.value;
      const locationId = modal.querySelector('#del-location')?.value;
      const qty = parseFloat(modal.querySelector('#del-qty')?.value);
      const unit = modal.querySelector('#del-unit')?.value?.trim();
      const date = modal.querySelector('#del-date')?.value;
      const docket = modal.querySelector('#del-docket')?.value?.trim();
      const supplier = modal.querySelector('#del-supplier')?.value?.trim();
      const note = modal.querySelector('#del-note')?.value?.trim();

      if (!itemId || !locationId || !qty || !date) {
        toast('Item, location, quantity and date are required', 'error');
        return false; // keep modal open
      }

      await dbInsert('stock_movements', {
        farm_id: farm.id,
        item_id: itemId,
        location_id: locationId,
        movement_type: 'delivery',
        qty: qty,
        unit: unit || 'L',
        occurred_on: date,
        counterparty: supplier || null,
        source_ref: docket || null,
        note: note || null,
      });
      toast('Delivery recorded', 'success');
      _render(container);
    }
  });

  // Wire unit auto-fill from item
  setTimeout(() => {
    document.getElementById('del-item')?.addEventListener('change', e => {
      const opt = e.target.options[e.target.selectedIndex];
      const unit = opt?.dataset?.unit;
      if (unit) document.getElementById('del-unit').value = unit;
    });
  }, 100);
}

async function _showMovementForm(container, items, locations) {
  const farm = getActiveFarm();
  openModal({
    title: 'Record movement',
    bodyHTML: `
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="mov-type">
            <option value="usage">Usage</option>
            <option value="transfer_out">Transfer out</option>
            <option value="transfer_in">Transfer in</option>
            <option value="adjustment">Adjustment</option>
            <option value="write_off">Write-off</option>
            <option value="sale">Sale</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Item</label>
          <select class="form-select" id="mov-item">
            <option value="">Select item...</option>
            ${items.map(i=>`<option value="${i.id}" data-unit="${i.default_unit}">${i.name} (${i.category})</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Location</label>
          <select class="form-select" id="mov-location">
            <option value="">Select location...</option>
            ${locations.map(l=>`<option value="${l.id}">${l.name}</option>`).join('')}
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label class="form-label">Quantity</label>
            <input class="form-input" type="number" id="mov-qty" step="0.001" min="0" placeholder="0">
          </div>
          <div class="form-group">
            <label class="form-label">Unit</label>
            <input class="form-input" type="text" id="mov-unit" placeholder="L / t / kg">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" type="date" id="mov-date" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Reason / note</label>
          <input class="form-input" type="text" id="mov-note" placeholder="Required for adjustments and write-offs">
        </div>
      </div>
    `,
    confirmLabel: 'Record movement',
    onConfirm: async (modal) => {
      const type = modal.querySelector('#mov-type')?.value;
      const itemId = modal.querySelector('#mov-item')?.value;
      const locationId = modal.querySelector('#mov-location')?.value;
      const qty = parseFloat(modal.querySelector('#mov-qty')?.value);
      const unit = modal.querySelector('#mov-unit')?.value?.trim();
      const date = modal.querySelector('#mov-date')?.value;
      const note = modal.querySelector('#mov-note')?.value?.trim();

      if (!itemId || !locationId || !qty || !date) {
        toast('Item, location, quantity and date are required', 'error');
        return false;
      }
      if ((type === 'adjustment' || type === 'write_off') && !note) {
        toast('A reason is required for adjustments and write-offs', 'error');
        return false;
      }

      await dbInsert('stock_movements', {
        farm_id: farm.id,
        item_id: itemId,
        location_id: locationId,
        movement_type: type,
        qty: qty,
        unit: unit || 'L',
        occurred_on: date,
        note: note || null,
      });
      toast('Movement recorded', 'success');
      _render(container);
    }
  });
}
