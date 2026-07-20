// modules/agronomy/recommendations.js
import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, getActiveSeason, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatCurrency, formatNumber, formatDate, qs, currentSeason } from '../../js/ui.js';

let _recs = [];
let _paddocks = [];
let _products = [];
let _plantings = [];
let _activeTab = 'recs';
let _filterStatus = '';
let _filterType = '';
let _plantFilter = '';

const REC_TYPES = ['Spray', 'Fertiliser', 'Planting', 'Irrigation', 'Other'];
const STATUS_COLOURS = {
  pending:  { bg: '#fef3c7', color: '#92400e' },
  actioned: { bg: '#d1fae5', color: '#065f46' },
  cancelled:{ bg: '#f3f4f6', color: '#6b7280' },
};

export async function mountRecommendations(container) {
  const farm = getActiveFarm();
  if (!farm) { container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>'; return; }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Recommendations</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid)">${farm.name}</p>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-secondary" id="btn-new-rec">＋ New recommendation</button>
      </div>
    </div>

    <div class="tab-strip" style="margin-bottom:16px">
      <button class="tab-btn ${_activeTab==='recs'?'active':''}" data-tab="recs">Recommendations</button>
      <button class="tab-btn ${_activeTab==='planting'?'active':''}" data-tab="planting">Planting records</button>
      <button class="tab-btn ${_activeTab==='products'?'active':''}" data-tab="products">Product library</button>
    </div>

    <div id="rec-tab-content"></div>
  `;

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _renderTab(container, farm);
    });
  });

  qs('#btn-new-rec', container)?.addEventListener('click', () => _recModal(container, farm));

  await _loadData(farm);
  _renderTab(container, farm);
}

export function unmountRecommendations() {
  _recs = []; _paddocks = []; _products = []; _plantings = [];
}

async function _loadData(farm) {
  [_recs, _paddocks, _products, _plantings] = await Promise.all([
    dbSelect('recommendations', 'farm_id=eq.' + farm.id + '&select=*&order=rec_date.desc,created_at.desc'),
    dbSelect('paddocks', 'farm_id=eq.' + farm.id + '&is_active=eq.true&select=id,name,area_ha,group_name&order=name.asc'),
    dbSelect('products', 'select=*&order=name.asc'),
    dbSelect('planting_records', 'farm_id=eq.' + farm.id + '&select=*&order=plant_date.desc'),
  ]);
}

function _renderTab(container, farm) {
  const content = qs('#rec-tab-content', container);
  if (_activeTab === 'recs') _renderRecs(content, farm);
  else if (_activeTab === 'planting') _renderPlanting(content, farm);
  else _renderProducts(content, farm);
}

// ── Recommendations list ──────────────────────────────────────
function _renderRecs(content, farm) {
  const season = getActiveSeason() || currentSeason();
  let recs = _recs;

  // Summary counts
  const pending = _recs.filter(r => r.status === 'pending').length;
  const actioned = _recs.filter(r => r.status === 'actioned').length;

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px">
      ${[
        ['Total', _recs.length, 'var(--ink)'],
        ['Pending', pending, '#92400e'],
        ['Actioned', actioned, '#065f46'],
      ].map(([l,v,c]) => `<div class="card" style="padding:12px 16px">
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">${l}</p>
        <p style="font-size:22px;font-weight:600;color:${c}">${v}</p>
      </div>`).join('')}
    </div>

    <!-- Filters -->
    <div class="flex gap-2" style="margin-bottom:12px">
      <select class="form-select" id="rec-filter-status" style="width:140px">
        <option value="">All statuses</option>
        <option value="pending" ${_filterStatus==='pending'?'selected':''}>Pending</option>
        <option value="actioned" ${_filterStatus==='actioned'?'selected':''}>Actioned</option>
        <option value="cancelled" ${_filterStatus==='cancelled'?'selected':''}>Cancelled</option>
      </select>
      <select class="form-select" id="rec-filter-type" style="width:140px">
        <option value="">All types</option>
        ${REC_TYPES.map(t => `<option value="${t}" ${_filterType===t?'selected':''}>${t}</option>`).join('')}
      </select>
    </div>

    <div class="card" style="overflow:hidden">
      ${_recs.length ? `
      <table class="data-table" id="recs-table">
        <thead><tr>
          <th>Date</th>
          <th>Type</th>
          <th>Subject</th>
          <th>Paddocks</th>
          <th>Raised by</th>
          <th>Status</th>
          <th>Products</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${_recs.map(r => {
            const paddockNames = (r.paddock_names || []).join(', ') || '—';
            const productCount = (r.products || []).length;
            const sc = STATUS_COLOURS[r.status] || STATUS_COLOURS.pending;
            return `<tr style="cursor:pointer" class="rec-row" data-id="${r.id}">
              <td style="white-space:nowrap">${r.rec_date ? formatDate(r.rec_date) : '—'}</td>
              <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#eff6ff;color:#1e40af">${r.rec_type||'—'}</span></td>
              <td><strong>${r.subject||'—'}</strong></td>
              <td style="font-size:11px;color:var(--hint);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${paddockNames}">${paddockNames}</td>
              <td class="muted">${r.raised_by||'—'}</td>
              <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${sc.bg};color:${sc.color};font-weight:500">${r.status||'pending'}</span></td>
              <td class="muted" style="font-size:11px">${productCount ? productCount+' product'+(productCount>1?'s':'') : '—'}</td>
              ${canWrite() ? `<td>
                <div class="flex gap-1">
                  ${r.status === 'pending' ? `<button class="btn btn-ghost btn-sm action-rec-btn" data-id="${r.id}" style="color:var(--green)">✓ Action</button>` : ''}
                  <button class="btn btn-ghost btn-sm edit-rec-btn" data-id="${r.id}">Edit</button>
                  <button class="btn btn-ghost btn-sm delete-rec-btn" data-id="${r.id}" style="color:var(--red)">✕</button>
                </div>
              </td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `<div class="empty-state" style="padding:40px"><p>No recommendations yet.</p></div>`}
    </div>
  `;

  // Filters
  qs('#rec-filter-status', content)?.addEventListener('change', e => {
    _filterStatus = e.target.value;
    _applyFilters(content);
  });
  qs('#rec-filter-type', content)?.addEventListener('change', e => {
    _filterType = e.target.value;
    _applyFilters(content);
  });
  _applyFilters(content);

  // Row click → detail view
  content.querySelectorAll('.rec-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const r = _recs.find(r => r.id === row.dataset.id);
      if (r) _openDetail(r, content, farm);
    });
  });

  // Action button
  content.querySelectorAll('.action-rec-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = _recs.find(r => r.id === btn.dataset.id);
      if (r) _actionModal(r, content, farm);
    });
  });

  // Edit button
  content.querySelectorAll('.edit-rec-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = _recs.find(r => r.id === btn.dataset.id);
      if (r) _recModal(content, farm, r);
    });
  });

  // Delete button
  content.querySelectorAll('.delete-rec-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this recommendation?')) return;
      await dbDelete('recommendations', btn.dataset.id);
      _recs = _recs.filter(r => r.id !== btn.dataset.id);
      _renderRecs(content, farm);
      toast('Recommendation deleted', 'success');
    });
  });
}

function _applyFilters(content) {
  content.querySelectorAll('.rec-row').forEach(row => {
    const r = _recs.find(r => r.id === row.dataset.id);
    if (!r) return;
    const statusMatch = !_filterStatus || r.status === _filterStatus;
    const typeMatch = !_filterType || r.rec_type === _filterType;
    row.style.display = statusMatch && typeMatch ? '' : 'none';
  });
}

// ── Rec detail view ───────────────────────────────────────────
function _openDetail(r, content, farm) {
  const products = r.products || [];
  const paddockNames = (r.paddock_names || []).join(', ') || '—';
  const sc = STATUS_COLOURS[r.status] || STATUS_COLOURS.pending;
  const totalCost = products.reduce((s,p) => s + (parseFloat(p.total_cost)||0), 0);

  openModal({
    title: r.subject || 'Recommendation',
    confirmLabel: r.status === 'pending' && canWrite() ? '✓ Mark as actioned' : null,
    confirmClass: 'btn-primary',
    onConfirm: r.status === 'pending' ? () => _actionModal(r, content, farm) : null,
    bodyHTML: `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:16px">
        <div><p style="font-size:10px;color:var(--hint);margin-bottom:2px">Date</p><p style="font-weight:500">${r.rec_date ? formatDate(r.rec_date) : '—'}</p></div>
        <div><p style="font-size:10px;color:var(--hint);margin-bottom:2px">Type</p><p style="font-weight:500">${r.rec_type||'—'}</p></div>
        <div><p style="font-size:10px;color:var(--hint);margin-bottom:2px">Raised by</p><p style="font-weight:500">${r.raised_by||'—'}</p></div>
        <div><p style="font-size:10px;color:var(--hint);margin-bottom:2px">Status</p><span style="font-size:12px;padding:2px 10px;border-radius:10px;background:${sc.bg};color:${sc.color};font-weight:500">${r.status||'pending'}</span></div>
      </div>

      <div style="margin-bottom:14px">
        <p style="font-size:10px;color:var(--hint);margin-bottom:4px">Paddocks <span style="color:var(--blue)">(${(r.paddock_ids||[]).length} selected · ${formatNumber(r.total_area_ha||0,1)} ha total)</span></p>
        <p style="font-size:13px">${paddockNames}</p>
      </div>

      ${r.crop_type ? `<div style="margin-bottom:14px"><p style="font-size:10px;color:var(--hint);margin-bottom:4px">Crop type</p><p style="font-size:13px">${r.crop_type}</p></div>` : ''}

      ${r.details ? `<div style="margin-bottom:14px;padding:10px 12px;background:var(--page-bg);border-radius:6px">
        <p style="font-size:10px;color:var(--hint);margin-bottom:4px">Details</p>
        <p style="font-size:13px;white-space:pre-wrap">${r.details}</p>
      </div>` : ''}

      ${products.length ? `
      <div style="margin-bottom:14px">
        <p style="font-size:10px;color:var(--hint);margin-bottom:8px;text-transform:uppercase;letter-spacing:.07em">Products</p>
        <table class="data-table" style="font-size:12px">
          <thead><tr><th>Product</th><th>Category</th><th class="num">Rate</th><th>Unit</th><th class="num">Total qty</th><th class="num">Cost/unit</th><th class="num">Total cost</th></tr></thead>
          <tbody>
            ${products.map(p => `<tr>
              <td><strong>${p.product_name||'—'}</strong></td>
              <td class="muted">${p.category||'—'}</td>
              <td class="num">${p.rate||'—'}</td>
              <td class="muted">${p.unit||'—'}</td>
              <td class="num">${p.total_qty ? formatNumber(p.total_qty,2) : '—'}</td>
              <td class="num">${p.cost_per_unit ? formatCurrency(p.cost_per_unit,2) : '—'}</td>
              <td class="num">${p.total_cost ? formatCurrency(p.total_cost,2) : '—'}</td>
            </tr>`).join('')}
            ${totalCost ? `<tr style="font-weight:600;border-top:2px solid var(--border)">
              <td colspan="6">Total cost</td>
              <td class="num">${formatCurrency(totalCost,2)}</td>
            </tr>` : ''}
          </tbody>
        </table>
      </div>` : ''}

      ${r.status === 'actioned' ? `
      <div style="padding:10px 12px;background:#d1fae5;border-radius:6px;margin-bottom:14px">
        <p style="font-size:10px;color:#065f46;margin-bottom:4px">Actioned ${r.actioned_date ? formatDate(r.actioned_date) : ''} by ${r.actioned_by||'—'}</p>
        ${r.action_notes ? '<p style="font-size:13px;color:#065f46">'+r.action_notes+'</p>' : ''}
      </div>` : ''}

      ${r.notes ? `<div><p style="font-size:10px;color:var(--hint);margin-bottom:4px">Notes</p><p style="font-size:13px">${r.notes}</p></div>` : ''}
    `,
  });
}

// ── Action modal ──────────────────────────────────────────────
function _actionModal(r, content, farm) {
  const session = getSession();
  openModal({
    title: 'Action recommendation',
    confirmLabel: 'Mark as actioned',
    confirmClass: 'btn-primary',
    bodyHTML: `
      <p style="font-size:13px;color:var(--hint);margin-bottom:16px"><strong>${r.subject}</strong> — ${(r.paddock_names||[]).join(', ')}</p>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Date actioned</label>
          <input class="form-input" id="act-date" type="date" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Actioned by</label>
          <input class="form-input" id="act-by" value="${session?.user?.email||''}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes <span style="color:var(--hint)">(what was actually applied vs recommended)</span></label>
        <textarea class="form-textarea" id="act-notes" rows="3" placeholder="e.g. Applied as per recommendation / Reduced rate by 20% due to conditions…"></textarea>
      </div>
    `,
    onConfirm: async (modal) => {
      const update = {
        status: 'actioned',
        actioned_date: qs('#act-date', modal)?.value || null,
        actioned_by: qs('#act-by', modal)?.value?.trim() || null,
        action_notes: qs('#act-notes', modal)?.value?.trim() || null,
      };
      await dbUpdate('recommendations', r.id, update);
      Object.assign(_recs.find(x => x.id === r.id), update);
      toast('Recommendation actioned', 'success');
      _renderRecs(content, farm);
    },
  });
}

// ── New/Edit rec modal ────────────────────────────────────────
function _recModal(container, farm, existing = null) {
  const session = getSession();
  const season = getActiveSeason() || currentSeason();
  let selectedPaddockIds = existing?.paddock_ids || [];
  let selectedPaddockNames = existing?.paddock_names || [];
  let recProducts = JSON.parse(JSON.stringify(existing?.products || []));

  const paddockListHTML = _paddocks.map(p => `
    <label style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:4px;cursor:pointer;font-size:13px;${selectedPaddockIds.includes(p.id)?'background:var(--blue-light)':''}">
      <input type="checkbox" class="pad-check" data-id="${p.id}" data-name="${p.name}" data-area="${p.area_ha||0}" ${selectedPaddockIds.includes(p.id)?'checked':''}>
      <span><strong>${p.name}</strong> ${p.area_ha ? '<span style="color:var(--hint);font-size:11px">'+formatNumber(p.area_ha,1)+' ha</span>' : ''}</span>
    </label>`).join('');

  openModal({
    title: existing ? 'Edit recommendation' : 'New recommendation',
    confirmLabel: existing ? 'Save changes' : 'Save recommendation',
    wide: true,
    bodyHTML: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <!-- Left column -->
        <div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Date</label>
              <input class="form-input" id="rec-date" type="date" value="${existing?.rec_date || new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-group">
              <label class="form-label">Type</label>
              <select class="form-select" id="rec-type">
                ${REC_TYPES.map(t => `<option value="${t}" ${existing?.rec_type===t?'selected':''}>${t}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Subject</label>
            <input class="form-input" id="rec-subject" value="${existing?.subject||''}" placeholder="e.g. Pre-emergent herbicide application">
          </div>

          <div class="form-group">
            <label class="form-label">Raised by</label>
            <input class="form-input" id="rec-raised-by" value="${existing?.raised_by || session?.user?.email || ''}">
          </div>

          <div class="form-group">
            <label class="form-label">Crop type</label>
            <input class="form-input" id="rec-crop" value="${existing?.crop_type||''}" placeholder="e.g. Cotton Flood, Wheat">
          </div>

          <div class="form-group">
            <label class="form-label">Details / instructions</label>
            <textarea class="form-textarea" id="rec-details" rows="4" placeholder="Full recommendation details…">${existing?.details||''}</textarea>
          </div>

          <div class="form-group">
            <label class="form-label">Notes</label>
            <textarea class="form-textarea" id="rec-notes" rows="2">${existing?.notes||''}</textarea>
          </div>
        </div>

        <!-- Right column -->
        <div>
          <!-- Paddock selection -->
          <div class="form-group">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <label class="form-label" style="margin:0">Paddocks <span id="pad-count" style="color:var(--blue)">(${selectedPaddockIds.length} selected · <span id="pad-area">${formatNumber(selectedPaddockIds.reduce((s,id) => s + (parseFloat(_paddocks.find(p=>p.id===id)?.area_ha)||0),0),1)}</span> ha)</span></label>
              <div class="flex gap-1">
                <button type="button" class="btn btn-ghost btn-sm" id="sel-all-pads">All</button>
                <button type="button" class="btn btn-ghost btn-sm" id="sel-none-pads">None</button>
              </div>
            </div>
            <div class="flex gap-2" style="margin-bottom:6px">
              <input class="form-input" id="pad-search" placeholder="Search paddocks…" style="flex:1">
              <select class="form-select" id="pad-crop-filter" style="width:160px">
                <option value="">All crops</option>
                ${[...new Set(_plantings.filter(p=>p.status==='planted').map(p=>p.crop_type).filter(Boolean))].sort().map(c=>`<option value="${c}">${c}</option>`).join('')}
                <option value="fallow">Fallow / unplanted</option>
              </select>
            </div>
            <div id="pad-list" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:4px">
              ${paddockListHTML}
            </div>
          </div>

          <!-- Products -->
          <div class="form-group">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <label class="form-label" style="margin:0">Products</label>
              <button type="button" class="btn btn-ghost btn-sm" id="add-product-btn">＋ Add product</button>
            </div>
            <div id="products-list">
              <!-- Products rendered here -->
            </div>
          </div>
        </div>
      </div>
    `,
    onConfirm: async (modal) => {
      // Gather paddocks
      const checkedPads = [...modal.querySelectorAll('.pad-check:checked')];
      const paddockIds = checkedPads.map(c => c.dataset.id);
      const paddockNames = checkedPads.map(c => c.dataset.name);
      const totalArea = checkedPads.reduce((s,c) => s + (parseFloat(c.dataset.area)||0), 0);

      if (!paddockIds.length) throw new Error('Please select at least one paddock');

      // Gather products
      const products = [...modal.querySelectorAll('.product-row')].map(row => {
        const productId = row.querySelector('.prod-select')?.value;
        const product = _products.find(p => p.id === productId);
        const rate = parseFloat(row.querySelector('.prod-rate')?.value)||0;
        const unit = row.querySelector('.prod-unit')?.value||'';
        const costPerUnit = parseFloat(row.querySelector('.prod-cost')?.value)||0;
        const totalQty = rate * totalArea;
        const totalCost = costPerUnit * totalQty;
        return {
          product_id: productId,
          product_name: product?.name || '',
          category: product?.category || '',
          rate, unit, total_qty: totalQty,
          cost_per_unit: costPerUnit,
          total_cost: totalCost,
        };
      }).filter(p => p.product_id);

      const row = {
        farm_id: farm.id,
        season,
        rec_date: qs('#rec-date', modal)?.value || null,
        rec_type: qs('#rec-type', modal)?.value || null,
        subject: qs('#rec-subject', modal)?.value?.trim() || null,
        raised_by: qs('#rec-raised-by', modal)?.value?.trim() || null,
        crop_type: qs('#rec-crop', modal)?.value?.trim() || null,
        details: qs('#rec-details', modal)?.value?.trim() || null,
        notes: qs('#rec-notes', modal)?.value?.trim() || null,
        paddock_ids: paddockIds,
        paddock_names: paddockNames,
        total_area_ha: totalArea,
        products,
        status: existing?.status || 'pending',
      };

      if (!row.subject) throw new Error('Please enter a subject');

      if (existing) {
        await dbUpdate('recommendations', existing.id, row);
        Object.assign(_recs.find(r => r.id === existing.id), row);
        toast('Recommendation updated', 'success');
      } else {
        const saved = await dbInsert('recommendations', row);
        _recs.unshift(saved);
        toast('Recommendation saved', 'success');
      }
      _renderTab(container, farm);
    },
  });

  // Wire up after modal renders
  setTimeout(() => {
    // Crop type filter for paddocks
    document.getElementById('pad-crop-filter')?.addEventListener('change', e => {
      const cropFilter = e.target.value;
      document.querySelectorAll('.pad-check').forEach(cb => {
        const label = cb.closest('label');
        if (!label) return;
        if (!cropFilter) { label.style.display = ''; return; }
        const paddockId = cb.dataset.id;
        const currentCrop = _plantings.find(p => p.paddock_id === paddockId && p.status === 'planted');
        if (cropFilter === 'fallow') {
          label.style.display = !currentCrop ? '' : 'none';
        } else {
          label.style.display = currentCrop?.crop_type === cropFilter ? '' : 'none';
        }
      });
    });

    // Paddock search
    document.getElementById('pad-search')?.addEventListener('input', e => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.pad-check').forEach(cb => {
        const label = cb.closest('label');
        if (label) label.style.display = cb.dataset.name.toLowerCase().includes(q) ? '' : 'none';
      });
    });

    // Select all / none
    document.getElementById('sel-all-pads')?.addEventListener('click', () => {
      document.querySelectorAll('.pad-check').forEach(cb => { cb.checked = true; updatePadCount(); });
    });
    document.getElementById('sel-none-pads')?.addEventListener('click', () => {
      document.querySelectorAll('.pad-check').forEach(cb => { cb.checked = false; updatePadCount(); });
    });

    // Update count when checkboxes change
    document.querySelectorAll('.pad-check').forEach(cb => {
      cb.addEventListener('change', updatePadCount);
    });

    function updatePadCount() {
      const checked = [...document.querySelectorAll('.pad-check:checked')];
      const area = checked.reduce((s,c) => s+(parseFloat(c.dataset.area)||0),0);
      const countEl = document.getElementById('pad-count');
      const areaEl = document.getElementById('pad-area');
      if (countEl) countEl.innerHTML = `(${checked.length} selected · <span id="pad-area">${formatNumber(area,1)}</span> ha)`;
      // Update product totals
      updateProductTotals();
    }

    // Render existing products
    renderProducts();

    document.getElementById('add-product-btn')?.addEventListener('click', () => {
      recProducts.push({});
      renderProducts();
    });

    function renderProducts() {
      const list = document.getElementById('products-list');
      if (!list) return;
      list.innerHTML = recProducts.map((p, i) => `
        <div class="product-row" style="border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <select class="form-select prod-select" style="flex:1;margin-right:8px">
              <option value="">— select product —</option>
              ${_products.map(prod => `<option value="${prod.id}" ${prod.id===p.product_id?'selected':''}>${prod.name} ${prod.category?'('+prod.category+')':''}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-ghost btn-sm remove-prod-btn" data-idx="${i}" style="color:var(--red)">✕</button>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px">
            <div><label style="font-size:10px;color:var(--hint)">Rate</label>
              <input type="number" class="form-input prod-rate num" step="0.01" value="${p.rate||''}" placeholder="0"></div>
            <div><label style="font-size:10px;color:var(--hint)">Unit</label>
              <select class="form-select prod-unit">
                ${['L/ha','mL/ha','kg/ha','g/ha','t/ha','units/ha'].map(u => `<option ${(p.unit||'L/ha')===u?'selected':''}>${u}</option>`).join('')}
              </select></div>
            <div><label style="font-size:10px;color:var(--hint)">Cost/unit ($)</label>
              <input type="number" class="form-input prod-cost num" step="0.01" value="${p.cost_per_unit||''}" placeholder="0"></div>
            <div><label style="font-size:10px;color:var(--hint)">Total qty</label>
              <p class="prod-total-qty" style="font-size:13px;font-weight:600;color:var(--blue);padding:8px 0;font-variant-numeric:tabular-nums">${p.total_qty ? formatNumber(p.total_qty,2) : '—'}</p></div>
          </div>
          <div style="margin-top:6px;text-align:right">
            <span style="font-size:11px;color:var(--hint)">Total cost: </span>
            <span class="prod-total-cost" style="font-size:13px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums">${p.total_cost ? formatCurrency(p.total_cost,2) : '—'}</span>
          </div>
        </div>
      `).join('');

      // Wire remove buttons
      list.querySelectorAll('.remove-prod-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          recProducts.splice(parseInt(btn.dataset.idx), 1);
          renderProducts();
        });
      });

      // Wire rate/cost changes to update totals
      list.querySelectorAll('.prod-rate, .prod-cost').forEach(inp => {
        inp.addEventListener('input', updateProductTotals);
      });
    }

    function updateProductTotals() {
      const checked = [...document.querySelectorAll('.pad-check:checked')];
      const totalArea = checked.reduce((s,c) => s+(parseFloat(c.dataset.area)||0),0);
      document.querySelectorAll('.product-row').forEach(row => {
        const rate = parseFloat(row.querySelector('.prod-rate')?.value)||0;
        const cost = parseFloat(row.querySelector('.prod-cost')?.value)||0;
        const totalQty = rate * totalArea;
        const totalCost = cost * totalQty;
        const qtyEl = row.querySelector('.prod-total-qty');
        const costEl = row.querySelector('.prod-total-cost');
        if (qtyEl) qtyEl.textContent = totalQty ? formatNumber(totalQty,2) : '—';
        if (costEl) costEl.textContent = totalCost ? formatCurrency(totalCost,2) : '—';
      });
    }
  }, 200);
}


// ── Planting records ──────────────────────────────────────────
function _renderPlanting(content, farm) {
  const season = getActiveSeason() || currentSeason();
  const STATUSES = ['planted', 'harvested', 'failed', 'fallow'];
  const STATUS_COLOURS = {
    planted:   { bg: '#d1fae5', color: '#065f46' },
    harvested: { bg: '#dbeafe', color: '#1e40af' },
    failed:    { bg: '#fee2e2', color: '#991b1b' },
    fallow:    { bg: '#f3f4f6', color: '#6b7280' },
  };

  // Current crops summary (latest planted per paddock)
  const currentCrops = {};
  _plantings.forEach(p => {
    if (!currentCrops[p.paddock_id] || p.plant_date > currentCrops[p.paddock_id].plant_date) {
      currentCrops[p.paddock_id] = p;
    }
  });
  const planted = Object.values(currentCrops).filter(p => p.status === 'planted');
  const cropTypes = [...new Set(planted.map(p => p.crop_type).filter(Boolean))];

  let filtered = _plantFilter
    ? _plantings.filter(p => p.season === _plantFilter)
    : _plantings;

  content.innerHTML = `
    <!-- Summary -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
      <div class="card" style="padding:12px 16px">
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Paddocks planted</p>
        <p style="font-size:22px;font-weight:600;color:var(--green)">${planted.length}</p>
      </div>
      ${cropTypes.map(ct => {
        const count = planted.filter(p => p.crop_type === ct).length;
        const area = planted.filter(p => p.crop_type === ct).reduce((s,p) => s+(parseFloat(p.area_ha)||0),0);
        return '<div class="card" style="padding:12px 16px"><p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">'+ct+'</p><p style="font-size:18px;font-weight:600">'+count+' <span style="font-size:12px;color:var(--hint)">paddocks</span></p><p style="font-size:11px;color:var(--hint)">'+formatNumber(area,1)+' ha</p></div>';
      }).join('')}
    </div>

    <!-- Controls -->
    <div class="flex gap-2" style="margin-bottom:12px">
      <select class="form-select" id="plant-season-filter" style="width:130px">
        <option value="">All seasons</option>
        ${[...new Set(_plantings.map(p=>p.season).filter(Boolean))].sort().reverse().map(s=>`<option value="${s}" ${_plantFilter===s?'selected':''}>${s}</option>`).join('')}
      </select>
      ${canWrite() ? '<button class="btn btn-secondary" id="btn-add-planting">＋ New planting record</button>' : ''}
      ${canWrite() ? '<button class="btn btn-ghost btn-sm" id="btn-bulk-harvest">✓ Mark harvested</button>' : ''}
    </div>

    <div class="card" style="overflow:hidden">
      ${filtered.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Paddock</th>
          <th>Season</th>
          <th>Crop type</th>
          <th>Variety</th>
          <th>Planted</th>
          <th class="num">Area (ha)</th>
          <th class="num">Seed (kg)</th>
          <th class="num">Rate (kg/ha)</th>
          <th>Status</th>
          <th>Harvested</th>
          ${canWrite()?'<th></th>':''}
        </tr></thead>
        <tbody>
          ${filtered.map(p => {
            const sc = STATUS_COLOURS[p.status] || STATUS_COLOURS.planted;
            return '<tr>' +
              '<td><strong>'+p.paddock_name+'</strong></td>' +
              '<td class="muted">'+p.season+'</td>' +
              '<td>'+p.crop_type+'</td>' +
              '<td class="muted">'+(p.variety||'—')+'</td>' +
              '<td>'+(p.plant_date?formatDate(p.plant_date):'—')+'</td>' +
              '<td class="num">'+(p.area_ha?formatNumber(p.area_ha,1):'—')+'</td>' +
              '<td class="num">'+(p.total_seed_kg?formatNumber(p.total_seed_kg,1):'—')+'</td>' +
              '<td class="num">'+(p.seed_rate_kg_ha?formatNumber(p.seed_rate_kg_ha,2):'—')+'</td>' +
              '<td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:'+sc.bg+';color:'+sc.color+';font-weight:500">'+p.status+'</span></td>' +
              '<td class="muted">'+(p.harvest_date?formatDate(p.harvest_date):'—')+'</td>' +
              (canWrite()?'<td><div class="flex gap-1">'+
                (p.status==='planted'?'<button class="btn btn-ghost btn-sm harvest-btn" data-id="'+p.id+'">Harvest</button>':'')+
                '<button class="btn btn-ghost btn-sm edit-planting-btn" data-id="'+p.id+'">Edit</button>'+
                '<button class="btn btn-ghost btn-sm delete-planting-btn" data-id="'+p.id+'" style="color:var(--red)">✕</button>'+
              '</div></td>':'') +
            '</tr>';
          }).join('')}
        </tbody>
      </table>` : `<div class="empty-state" style="padding:40px"><p>No planting records${_plantFilter?' for '+_plantFilter:''}.</p></div>`}
    </div>
  `;

  qs('#plant-season-filter', content)?.addEventListener('change', e => {
    _plantFilter = e.target.value;
    _renderPlanting(content, farm);
  });

  qs('#btn-add-planting', content)?.addEventListener('click', () => _plantingModal(content, farm));

  content.querySelectorAll('.edit-planting-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _plantings.find(p => p.id === btn.dataset.id);
      if (p) _plantingModal(content, farm, p);
    });
  });

  content.querySelectorAll('.harvest-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _plantings.find(p => p.id === btn.dataset.id);
      if (p) _harvestModal(p, content, farm);
    });
  });

  content.querySelectorAll('.delete-planting-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this planting record?')) return;
      await dbDelete('planting_records', btn.dataset.id);
      _plantings = _plantings.filter(p => p.id !== btn.dataset.id);
      _renderPlanting(content, farm);
      toast('Planting record deleted', 'success');
    });
  });
}

function _plantingModal(container, farm, existing = null) {
  const season = getActiveSeason() || currentSeason();
  const CROP_TYPES = [...new Set([
    'Cotton Flood', 'Cotton Lateral', 'Cotton Seed',
    'Wheat', 'Barley', 'Canola', 'Fababean', 'Chickpea', 'Sorghum',
    ...(_plantings.map(p => p.crop_type).filter(Boolean))
  ])].sort();

  openModal({
    title: existing ? 'Edit planting record' : 'New planting record',
    confirmLabel: existing ? 'Save changes' : 'Save record',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Paddock</label>
          <select class="form-select" id="pl-paddock">
            <option value="">— select paddock —</option>
            ${_paddocks.map(p => `<option value="${p.id}" data-name="${p.name}" data-area="${p.area_ha||0}" ${existing?.paddock_id===p.id?'selected':''}>${p.name} ${p.area_ha?'('+formatNumber(p.area_ha,1)+' ha)':''}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Season</label>
          <input class="form-input" id="pl-season" value="${existing?.season||season}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Crop type</label>
          <input class="form-input" id="pl-crop" list="crop-types-list" value="${existing?.crop_type||''}" placeholder="e.g. Cotton Flood">
          <datalist id="crop-types-list">${CROP_TYPES.map(c=>'<option value="'+c+'">').join('')}</datalist>
        </div>
        <div class="form-group">
          <label class="form-label">Variety</label>
          <input class="form-input" id="pl-variety" value="${existing?.variety||''}" placeholder="e.g. Sicot 748B3F">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Plant date</label>
          <input class="form-input" id="pl-date" type="date" value="${existing?.plant_date||''}">
        </div>
        <div class="form-group">
          <label class="form-label">Area planted (ha)</label>
          <input class="form-input num" id="pl-area" type="number" step="0.1" value="${existing?.area_ha||''}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Total seed used (kg)</label>
          <input class="form-input num" id="pl-seed-total" type="number" step="0.1" value="${existing?.total_seed_kg||''}">
        </div>
        <div class="form-group">
          <label class="form-label">Seed rate (kg/ha) <span style="color:var(--hint)">auto-calculated</span></label>
          <input class="form-input num" id="pl-seed-rate" type="number" step="0.001" value="${existing?.seed_rate_kg_ha||''}" placeholder="Auto from total ÷ area">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="pl-notes" rows="2">${existing?.notes||''}</textarea>
      </div>
    `,
    onConfirm: async (modal) => {
      const paddockSel = qs('#pl-paddock', modal);
      const paddockOpt = paddockSel?.options[paddockSel?.selectedIndex];
      const area = parseFloat(qs('#pl-area', modal)?.value)||null;
      const totalSeed = parseFloat(qs('#pl-seed-total', modal)?.value)||null;
      const seedRate = parseFloat(qs('#pl-seed-rate', modal)?.value) || (totalSeed && area ? totalSeed/area : null);

      const row = {
        farm_id: farm.id,
        paddock_id: paddockSel?.value || null,
        paddock_name: paddockOpt?.dataset?.name || existing?.paddock_name || '',
        season: qs('#pl-season', modal)?.value?.trim() || season,
        crop_type: qs('#pl-crop', modal)?.value?.trim() || null,
        variety: qs('#pl-variety', modal)?.value?.trim() || null,
        plant_date: qs('#pl-date', modal)?.value || null,
        area_ha: area,
        total_seed_kg: totalSeed,
        seed_rate_kg_ha: seedRate,
        status: existing?.status || 'planted',
        notes: qs('#pl-notes', modal)?.value?.trim() || null,
      };

      if (!row.paddock_id) throw new Error('Please select a paddock');
      if (!row.crop_type) throw new Error('Please enter a crop type');
      if (!row.plant_date) throw new Error('Please enter a plant date');

      if (existing) {
        await dbUpdate('planting_records', existing.id, row);
        Object.assign(_plantings.find(p => p.id === existing.id), row);
        toast('Planting record updated', 'success');
      } else {
        const saved = await dbInsert('planting_records', row);
        _plantings.unshift(saved);
        toast('Planting record saved', 'success');
      }
      _renderPlanting(container, farm);
    },
  });

  // Auto-calculate seed rate
  setTimeout(() => {
    const areaInp = document.getElementById('pl-area');
    const totalInp = document.getElementById('pl-seed-total');
    const rateInp = document.getElementById('pl-seed-rate');

    // Auto-fill area from paddock selection
    document.getElementById('pl-paddock')?.addEventListener('change', e => {
      const opt = e.target.options[e.target.selectedIndex];
      if (opt?.dataset?.area && !areaInp?.value) {
        if (areaInp) areaInp.value = opt.dataset.area;
      }
    });

    const calcRate = () => {
      const area = parseFloat(areaInp?.value)||0;
      const total = parseFloat(totalInp?.value)||0;
      if (area && total && rateInp) rateInp.value = (total/area).toFixed(3);
    };
    areaInp?.addEventListener('input', calcRate);
    totalInp?.addEventListener('input', calcRate);
  }, 200);
}

function _harvestModal(planting, content, farm) {
  openModal({
    title: 'Mark as harvested',
    confirmLabel: 'Mark harvested',
    confirmClass: 'btn-primary',
    bodyHTML: `
      <p style="font-size:13px;color:var(--hint);margin-bottom:16px"><strong>${planting.paddock_name}</strong> — ${planting.crop_type} planted ${planting.plant_date ? formatDate(planting.plant_date) : ''}</p>
      <div class="form-group">
        <label class="form-label">Harvest date</label>
        <input class="form-input" id="harv-date" type="date" value="${new Date().toISOString().slice(0,10)}">
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="harv-notes" rows="2" placeholder="Harvest notes…"></textarea>
      </div>
    `,
    onConfirm: async (modal) => {
      const update = {
        status: 'harvested',
        harvest_date: qs('#harv-date', modal)?.value || null,
        notes: qs('#harv-notes', modal)?.value?.trim() || planting.notes || null,
      };
      await dbUpdate('planting_records', planting.id, update);
      Object.assign(_plantings.find(p => p.id === planting.id), update);
      toast('Marked as harvested', 'success');
      _renderPlanting(content, farm);
    },
  });
}

// ── Product library ───────────────────────────────────────────
function _renderProducts(content, farm) {
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <p style="font-size:13px;color:var(--hint)">${_products.length} products in library</p>
      ${canWrite() ? '<button class="btn btn-secondary btn-sm" id="btn-add-product">＋ Add product</button>' : ''}
    </div>
    <div class="card" style="overflow:hidden">
      ${_products.length ? `
      <table class="data-table">
        <thead><tr><th>Name</th><th>Category</th><th>Default unit</th><th>Notes</th><th>Status</th>${canWrite()?'<th></th>':''}</tr></thead>
        <tbody>
          ${_products.map(p => `<tr>
            <td><strong>${p.name}</strong></td>
            <td class="muted">${p.category||'—'}</td>
            <td class="muted">${p.unit||'—'}</td>
            <td class="muted" style="font-size:11px">${p.notes||''}</td>
            <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${p.is_active!==false?'#d1fae5':'#f3f4f6'};color:${p.is_active!==false?'#065f46':'#6b7280'}">${p.is_active!==false?'Active':'Inactive'}</span></td>
            ${canWrite()?`<td><div class="flex gap-1">
              <button class="btn btn-ghost btn-sm edit-product-btn" data-id="${p.id}">Edit</button>
              <button class="btn btn-ghost btn-sm delete-product-btn" data-id="${p.id}" style="color:var(--red)">✕</button>
            </div></td>`:''}
          </tr>`).join('')}
        </tbody>
      </table>` : `<div class="empty-state" style="padding:40px"><p>No products yet. Add your first product.</p></div>`}
    </div>
  `;

  qs('#btn-add-product', content)?.addEventListener('click', () => _productModal(content));
  content.querySelectorAll('.edit-product-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _products.find(p => p.id === btn.dataset.id);
      if (p) _productModal(content, p);
    });
  });
  content.querySelectorAll('.delete-product-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this product?')) return;
      await dbDelete('products', btn.dataset.id);
      _products = _products.filter(p => p.id !== btn.dataset.id);
      _renderProducts(content, farm);
      toast('Product deleted', 'success');
    });
  });
}

function _productModal(content, existing = null) {
  const CATEGORIES = ['Herbicide', 'Fungicide', 'Insecticide', 'Fertiliser', 'Plant growth regulator', 'Adjuvant', 'Seed treatment', 'Other'];
  const UNITS = ['L/ha', 'mL/ha', 'kg/ha', 'g/ha', 't/ha', 'units/ha'];

  openModal({
    title: existing ? 'Edit product' : 'Add product',
    confirmLabel: existing ? 'Save changes' : 'Add product',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Product name</label>
          <input class="form-input" id="prod-name" value="${existing?.name||''}" placeholder="e.g. Roundup PowerMAX">
        </div>
        <div class="form-group">
          <label class="form-label">Category</label>
          <select class="form-select" id="prod-cat">
            <option value="">— select —</option>
            ${CATEGORIES.map(c => `<option value="${c}" ${existing?.category===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Default unit</label>
          <select class="form-select" id="prod-unit">
            ${UNITS.map(u => `<option value="${u}" ${existing?.unit===u?'selected':''}>${u}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="prod-status">
            <option value="true" ${existing?.is_active!==false?'selected':''}>Active</option>
            <option value="false" ${existing?.is_active===false?'selected':''}>Inactive</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <textarea class="form-textarea" id="prod-notes" rows="2">${existing?.notes||''}</textarea>
      </div>
    `,
    onConfirm: async (modal) => {
      const row = {
        name: qs('#prod-name', modal)?.value?.trim(),
        category: qs('#prod-cat', modal)?.value || null,
        unit: qs('#prod-unit', modal)?.value || null,
        is_active: qs('#prod-status', modal)?.value === 'true',
        notes: qs('#prod-notes', modal)?.value?.trim() || null,
      };
      if (!row.name) throw new Error('Product name is required');
      if (existing) {
        await dbUpdate('products', existing.id, row);
        Object.assign(_products.find(p => p.id === existing.id), row);
        toast('Product updated', 'success');
      } else {
        const saved = await dbInsert('products', row);
        _products.push(saved);
        toast('Product added', 'success');
      }
      _renderProducts(content, null);
    },
  });
}