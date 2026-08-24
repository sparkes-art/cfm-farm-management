// modules/agronomy/agronomy-visits.js
// Agronomy visit list and editor — replaces the Numbers/iPad template

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, getActiveSeason, getSession, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatDate, qs } from '../../js/ui.js';

// ── Crop template definitions ─────────────────────────────────
// Loaded from DB but cached here for performance
let _cropTemplates = [];
let _paddocks = [];
let _visits = [];

const PRIORITY_COLORS = {
  high:   { bg:'#fef2f2', border:'#fca5a5', text:'#991b1b', label:'High priority' },
  medium: { bg:'#fffbeb', border:'#fcd34d', text:'#92400e', label:'Medium priority' },
  low:    { bg:'#f0fdf4', border:'#86efac', text:'#166534', label:'Low priority' },
};

const APP_TYPES = ['Herbicide','Insecticide','Fungicide','PGR','Fungicide/Insecticide','Fertiliser','Other'];

// ── Main mount ────────────────────────────────────────────────
export async function mountAgronomyVisits(container) {
  const farm = getActiveFarm();
  const season = getActiveSeason();
  if (!farm) { container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--hint)">Select a farm to view visits</div>'; return; }

  container.innerHTML = `<div style="padding:20px 24px;max-width:1100px;margin:0 auto" id="av-root"></div>`;
  await _loadData(farm, season);
  _renderList(container);
}

async function _loadData(farm, season) {
  const [visits, paddocks, templates] = await Promise.all([
    dbSelect('agronomy_visits', `farm_id=eq.${farm.id}&order=visit_date.desc`),
    dbSelect('paddocks', `farm_id=eq.${farm.id}&active=eq.true&order=name`),
    dbSelect('agronomy_crop_templates', `active=eq.true&order=display_order`).catch(() => []),
  ]);
  _visits = visits;
  _paddocks = paddocks;
  _cropTemplates = templates;
}

// ── Visit list ────────────────────────────────────────────────
function _renderList(container) {
  const farm = getActiveFarm();
  const season = getActiveSeason();
  const root = qs('#av-root', container);

  const seasonVisits = _visits.filter(v => {
    const y = parseInt(season?.split('-')[0]||0);
    const m = v.visit_date?.slice(0,7);
    return m >= `${y}-07` && m <= `${y+1}-06`;
  });

  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div>
        <div style="font-size:20px;font-weight:700;color:var(--ink)">${farm.name} — Agronomy visits</div>
        <div style="font-size:12px;color:var(--hint);margin-top:3px">Season ${season} · ${seasonVisits.length} visit${seasonVisits.length!==1?'s':''}</div>
      </div>
      ${canWrite() ? `<button class="btn btn-primary" id="av-new-btn">+ New visit</button>` : ''}
    </div>

    ${seasonVisits.length === 0 ? `
      <div style="background:white;border:1px solid var(--border);border-radius:10px;padding:60px;text-align:center">
        <div style="font-size:32px;margin-bottom:12px">🌱</div>
        <div style="font-size:15px;font-weight:600;color:var(--ink);margin-bottom:6px">No visits recorded yet</div>
        <div style="font-size:13px;color:var(--hint);margin-bottom:20px">Create the first visit for ${season}</div>
        ${canWrite() ? `<button class="btn btn-primary" id="av-new-btn-empty">+ New visit</button>` : ''}
      </div>
    ` : `
      <div style="display:flex;flex-direction:column;gap:10px">
        ${seasonVisits.map(v => _visitCard(v)).join('')}
      </div>
    `}
  `;

  qs('#av-new-btn', root)?.addEventListener('click', () => _openEditor(container, null));
  qs('#av-new-btn-empty', root)?.addEventListener('click', () => _openEditor(container, null));
  root.querySelectorAll('.av-card').forEach(card => {
    card.addEventListener('click', () => {
      const v = _visits.find(x => x.id === card.dataset.id);
      if (v) _openEditor(container, v);
    });
  });
}

function _visitCard(v) {
  const status = v.status || 'draft';
  const statusColors = { draft:'var(--hint)', submitted:'var(--amber)', sent:'var(--green)' };
  const statusLabels = { draft:'Draft', submitted:'Submitted', sent:'Sent' };
  return `
    <div class="av-card" data-id="${v.id}" style="background:white;border:1px solid var(--border);border-radius:10px;padding:16px 20px;cursor:pointer;display:flex;align-items:center;gap:16px;transition:box-shadow .15s"
      onmouseenter="this.style.boxShadow='0 2px 8px rgba(0,0,0,.08)'" onmouseleave="this.style.boxShadow=''">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
          <span style="font-size:14px;font-weight:600;color:var(--ink)">${formatDate(v.visit_date)}</span>
          <span style="font-size:11px;font-weight:600;color:${statusColors[status]};background:${statusColors[status]}18;border-radius:20px;padding:2px 8px">${statusLabels[status]}</span>
        </div>
        <div style="font-size:12px;color:var(--hint)">${v.agronomist_name || '—'} · Visit #${v.visit_number || '—'}</div>
        ${v.recommendations ? `<div style="font-size:12px;color:var(--ink-mid);margin-top:4px">${v.recommendations.slice(0,100)}${v.recommendations.length>100?'…':''}</div>` : ''}
      </div>
      <div style="color:var(--hint);font-size:18px">›</div>
    </div>
  `;
}

// ── Visit editor ──────────────────────────────────────────────
async function _openEditor(container, existing) {
  const farm = getActiveFarm();
  const season = getActiveSeason();
  const isNew = !existing;

  // Load paddock entries for this visit
  let entries = [], actions = [], photos = [];
  if (existing?.id) {
    [entries, actions, photos] = await Promise.all([
      dbSelect('agronomy_paddock_entries', `visit_id=eq.${existing.id}&order=display_order`),
      dbSelect('agronomy_actions', `visit_id=eq.${existing.id}&order=display_order`),
      dbSelect('agronomy_photos', `visit_id=eq.${existing.id}&order=display_order`).catch(() => []),
    ]);
    // Load spray apps per entry
    for (const entry of entries) {
      entry._sprays = await dbSelect('agronomy_spray_applications', `paddock_entry_id=eq.${entry.id}&order=applied_date`).catch(() => []);
    }
  }

  const visitId = existing?.id;
  let _entries = [...entries];
  let _actions = [...actions];
  let _photos = [...photos];
  let _visitData = { ...existing };
  let _activeTab = 'overview';

  // Build editor modal
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;overflow-y:auto;padding:20px';
  overlay.innerHTML = `
    <div style="background:white;border-radius:12px;max-width:1000px;margin:0 auto;min-height:80vh;display:flex;flex-direction:column">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px">
        <button id="av-close" style="border:none;background:none;font-size:20px;cursor:pointer;color:var(--hint)">✕</button>
        <div style="flex:1">
          <div style="font-size:16px;font-weight:700;color:var(--ink)">${isNew ? 'New visit' : 'Edit visit — '+formatDate(existing.visit_date)}</div>
          <div style="font-size:12px;color:var(--hint)">${farm.name} · ${season}</div>
        </div>
        <div style="display:flex;gap:8px">
          ${!isNew ? `<button class="btn btn-ghost btn-sm" id="av-report-btn">📄 View report</button>` : ''}
          <button class="btn btn-primary btn-sm" id="av-save-btn">Save</button>
        </div>
      </div>

      <div style="display:flex;border-bottom:1px solid var(--border)">
        ${['overview','fields','actions','photos'].map(t => `
          <button class="av-tab-btn" data-tab="${t}" style="padding:10px 18px;border:none;background:none;font-size:13px;cursor:pointer;border-bottom:2px solid transparent;color:var(--hint);font-weight:500">
            ${{overview:'Overview',fields:'Fields',actions:'Actions',photos:'Photos'}[t]}
          </button>`).join('')}
      </div>

      <div style="flex:1;overflow-y:auto" id="av-editor-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const renderTab = () => {
    const body = qs('#av-editor-body', overlay);
    overlay.querySelectorAll('.av-tab-btn').forEach(btn => {
      btn.style.borderBottomColor = btn.dataset.tab === _activeTab ? 'var(--blue)' : 'transparent';
      btn.style.color = btn.dataset.tab === _activeTab ? 'var(--blue)' : 'var(--hint)';
    });
    if (_activeTab === 'overview') body.innerHTML = _renderOverview(_visitData, _entries);
    if (_activeTab === 'fields') body.innerHTML = _renderFields(_entries);
    if (_activeTab === 'actions') body.innerHTML = _renderActions(_actions);
    if (_activeTab === 'photos') body.innerHTML = _renderPhotos(_photos);
    _bindTabEvents(overlay, _entries, _actions, _photos, visitId, farm, renderTab);
  };

  overlay.querySelectorAll('.av-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { _activeTab = btn.dataset.tab; renderTab(); });
  });

  qs('#av-close', overlay).addEventListener('click', () => { overlay.remove(); _renderList(container); });

  qs('#av-save-btn', overlay).addEventListener('click', async () => {
    try {
      const data = _gatherOverview(overlay, farm, season);
      if (existing?.id) {
        await dbUpdate('agronomy_visits', existing.id, data);
      } else {
        const result = await dbInsert('agronomy_visits', data);
        existing = result;
      }
      await _loadData(farm, season);
      toast('Visit saved', 'success');
      qs('#av-save-btn', overlay).textContent = 'Saved ✓';
      setTimeout(() => { if (qs('#av-save-btn', overlay)) qs('#av-save-btn', overlay).textContent = 'Save'; }, 2000);
    } catch(e) { toast('Error: ' + e.message, 'error'); }
  });

  qs('#av-report-btn', overlay)?.addEventListener('click', () => {
    _generateReport(existing, _entries, _actions, _photos, farm, season);
  });

  renderTab();
}

// ── Overview tab ──────────────────────────────────────────────
function _renderOverview(v, entries) {
  const today = new Date().toISOString().slice(0,10);
  return `
    <div style="padding:20px;display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div>
        <div class="form-group">
          <label class="form-label">Visit date</label>
          <input class="form-input" type="date" id="av-date" value="${v?.visit_date||today}">
        </div>
        <div class="form-group">
          <label class="form-label">Visit number</label>
          <input class="form-input" type="number" id="av-visit-num" value="${v?.visit_number||''}" placeholder="e.g. 4">
        </div>
        <div class="form-group">
          <label class="form-label">Agronomist</label>
          <input class="form-input" type="text" id="av-agronomist" value="${v?.agronomist_name||''}" placeholder="Name">
        </div>
        <div class="form-group">
          <label class="form-label">Company</label>
          <input class="form-input" type="text" id="av-company" value="${v?.agronomist_company||''}" placeholder="e.g. CFM Agronomy">
        </div>
      </div>
      <div>
        <div class="form-group">
          <label class="form-label">General observations</label>
          <textarea class="form-input" id="av-observations" rows="4" style="resize:vertical" placeholder="Overall farm conditions, weather, general notes...">${v?.observations||''}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">General recommendations</label>
          <textarea class="form-input" id="av-recommendations" rows="4" style="resize:vertical" placeholder="Overall recommendations for this visit...">${v?.recommendations||''}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-select" id="av-status">
            <option value="draft" ${(!v?.status||v?.status==='draft')?'selected':''}>Draft</option>
            <option value="submitted" ${v?.status==='submitted'?'selected':''}>Submitted</option>
            <option value="sent" ${v?.status==='sent'?'selected':''}>Sent</option>
          </select>
        </div>
      </div>

      ${entries.length ? `
        <div style="grid-column:1/-1">
          <div style="font-size:13px;font-weight:600;color:var(--ink);margin-bottom:10px">Variety summary</div>
          <div style="background:var(--page-bg);border-radius:8px;padding:12px">
            ${_varietySummary(entries)}
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function _varietySummary(entries) {
  const byVariety = {};
  entries.forEach(e => {
    if (!e.variety) return;
    if (!byVariety[e.variety]) byVariety[e.variety] = { area: 0, crop: e.crop_name };
    byVariety[e.variety].area += parseFloat(e.area_ha)||0;
  });
  const rows = Object.entries(byVariety).sort((a,b) => b[1].area - a[1].area);
  if (!rows.length) return '<span style="color:var(--hint);font-size:12px">No variety data yet — add fields</span>';
  const total = rows.reduce((s,[,d]) => s+d.area, 0);
  return `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr>
      <th style="text-align:left;padding:4px 8px;color:var(--hint);font-weight:500">Variety</th>
      <th style="text-align:left;padding:4px 8px;color:var(--hint);font-weight:500">Crop</th>
      <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">Area (ha)</th>
      <th style="text-align:right;padding:4px 8px;color:var(--hint);font-weight:500">%</th>
    </tr></thead>
    <tbody>
      ${rows.map(([v,d]) => `<tr>
        <td style="padding:4px 8px;font-weight:500">${v}</td>
        <td style="padding:4px 8px;color:var(--hint)">${d.crop||'—'}</td>
        <td style="padding:4px 8px;text-align:right">${d.area.toFixed(1)}</td>
        <td style="padding:4px 8px;text-align:right;color:var(--hint)">${total ? Math.round(d.area/total*100)+'%' : ''}</td>
      </tr>`).join('')}
      <tr style="border-top:1px solid var(--border);font-weight:600">
        <td style="padding:4px 8px" colspan="2">Total</td>
        <td style="padding:4px 8px;text-align:right">${total.toFixed(1)}</td>
        <td style="padding:4px 8px"></td>
      </tr>
    </tbody>
  </table>`;
}

// ── Fields tab ────────────────────────────────────────────────
function _renderFields(entries) {
  return `
    <div style="padding:16px 20px">
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px">
        <button class="btn btn-ghost btn-sm" id="av-add-field">+ Add field</button>
      </div>
      <div id="av-fields-list" style="display:flex;flex-direction:column;gap:8px">
        ${entries.length
          ? entries.map((e,i) => _fieldCard(e, i)).join('')
          : '<div style="padding:40px;text-align:center;color:var(--hint)">No fields added yet</div>'}
      </div>
    </div>
  `;
}

function _fieldCard(entry, idx) {
  const pc = qs('#av-root');
  const priority = entry.priority;
  const pc_style = priority ? `border-left:3px solid ${PRIORITY_COLORS[priority]?.border};` : '';
  const attrs = entry.growth_attributes || {};
  const attrSummary = Object.entries(attrs).filter(([,v])=>v).slice(0,4).map(([k,v])=>`${k}: ${v}`).join(' · ');
  const sprayCount = (entry._sprays||[]).length;
  return `
    <div class="av-field-card" data-idx="${idx}" style="background:white;border:1px solid var(--border);border-radius:8px;${pc_style}cursor:pointer;overflow:hidden"
      onmouseenter="this.style.boxShadow='0 2px 6px rgba(0,0,0,.06)'" onmouseleave="this.style.boxShadow=''">
      <div style="padding:12px 16px;display:flex;align-items:center;gap:12px">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span style="font-size:13px;font-weight:600;color:var(--ink)">${entry.paddock_name||'Unnamed field'}</span>
            ${entry.crop_name ? `<span style="font-size:11px;color:var(--hint);background:var(--page-bg);border-radius:4px;padding:1px 6px">${entry.crop_name}</span>` : ''}
            ${entry.variety ? `<span style="font-size:11px;color:var(--blue-text);background:var(--blue-light);border-radius:4px;padding:1px 6px">${entry.variety}</span>` : ''}
            ${priority ? `<span style="font-size:10px;font-weight:600;color:${PRIORITY_COLORS[priority].text};background:${PRIORITY_COLORS[priority].bg};border-radius:4px;padding:1px 6px">${PRIORITY_COLORS[priority].label}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--hint)">
            ${entry.area_ha ? entry.area_ha+' ha · ' : ''}${attrSummary}
            ${sprayCount ? ` · ${sprayCount} spray${sprayCount!==1?'s':''}` : ''}
          </div>
          ${entry.comments ? `<div style="font-size:12px;color:var(--ink-mid);margin-top:4px">${entry.comments.slice(0,100)}${entry.comments.length>100?'…':''}</div>` : ''}
        </div>
        <div style="color:var(--hint)">›</div>
      </div>
    </div>
  `;
}

// ── Actions tab ───────────────────────────────────────────────
function _renderActions(actions) {
  const high = actions.filter(a => a.priority === 'high');
  const medium = actions.filter(a => a.priority === 'medium');
  const low = actions.filter(a => a.priority === 'low');

  const renderGroup = (label, items, priority) => items.length ? `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:${PRIORITY_COLORS[priority].text};margin-bottom:6px">${label}</div>
      ${items.map((a,i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:${PRIORITY_COLORS[priority].bg};border:1px solid ${PRIORITY_COLORS[priority].border};border-radius:6px;margin-bottom:6px">
          <div style="flex:1;font-size:13px;color:${PRIORITY_COLORS[priority].text}">${a.action_text}</div>
          <button class="av-delete-action" data-idx="${i}" data-priority="${priority}" style="border:none;background:none;color:var(--hint);cursor:pointer;font-size:16px">×</button>
        </div>`).join('')}
    </div>
  ` : '';

  return `
    <div style="padding:16px 20px">
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm av-add-action" data-priority="high" style="color:${PRIORITY_COLORS.high.text}">+ High priority</button>
        <button class="btn btn-ghost btn-sm av-add-action" data-priority="medium" style="color:${PRIORITY_COLORS.medium.text}">+ Medium priority</button>
        <button class="btn btn-ghost btn-sm av-add-action" data-priority="low">+ Low priority</button>
      </div>
      ${!actions.length ? '<div style="padding:40px;text-align:center;color:var(--hint)">No actions yet</div>' : ''}
      ${renderGroup('High priority', high, 'high')}
      ${renderGroup('Medium priority', medium, 'medium')}
      ${renderGroup('Low priority', low, 'low')}
    </div>
  `;
}

// ── Photos tab ────────────────────────────────────────────────
function _renderPhotos(photos) {
  return `
    <div style="padding:16px 20px">
      <div style="margin-bottom:12px">
        <label class="btn btn-ghost btn-sm" style="cursor:pointer">
          + Add photos
          <input type="file" id="av-photo-input" accept="image/*" multiple style="display:none">
        </label>
      </div>
      ${photos.length ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">
          ${photos.map((p,i) => `
            <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
              <img src="${p.url}" style="width:100%;height:150px;object-fit:cover">
              <div style="padding:8px">
                <input type="text" class="av-photo-caption" data-idx="${i}" value="${p.caption||''}" placeholder="Add caption..."
                  style="width:100%;border:none;background:none;font-size:11px;color:var(--ink)">
              </div>
            </div>`).join('')}
        </div>
      ` : '<div style="padding:40px;text-align:center;color:var(--hint)">No photos yet</div>'}
    </div>
  `;
}

// ── Field editor modal ────────────────────────────────────────
function _openFieldEditor(overlay, entries, idx, visitId, farm, renderTab) {
  const isNew = idx === -1;
  const entry = isNew ? {} : entries[idx];
  const template = _cropTemplates.find(t => t.crop_name === entry.crop_name) || null;
  const fields = template?.fields || [];

  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1100;overflow-y:auto;padding:20px';

  const cropOptions = [...new Set([..._cropTemplates.map(t=>t.crop_name),'Cotton','DL Wheat','DL Barley','Durum','Fallow'])];
  const paddockOptions = _paddocks.map(p => `<option value="${p.name}" ${entry.paddock_name===p.name?'selected':''}>${p.name} (${p.area_ha||'?'} ha)</option>`).join('');

  modal.innerHTML = `
    <div style="background:white;border-radius:12px;max-width:700px;margin:0 auto">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:15px;font-weight:700">${isNew ? 'Add field' : 'Edit field — '+(entry.paddock_name||'')}</div>
        <div style="display:flex;gap:8px">
          ${!isNew ? `<button class="btn btn-ghost btn-sm" id="fe-delete" style="color:var(--red)">Delete</button>` : ''}
          <button class="btn btn-ghost btn-sm" id="fe-cancel">Cancel</button>
          <button class="btn btn-primary btn-sm" id="fe-save">Save field</button>
        </div>
      </div>
      <div style="padding:20px;display:flex;flex-direction:column;gap:14px">

        <!-- Identity -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Field / paddock</label>
            <select class="form-select" id="fe-paddock">
              <option value="">— select or type below —</option>
              ${paddockOptions}
            </select>
            <input class="form-input" id="fe-paddock-name" type="text" value="${entry.paddock_name||''}" placeholder="Or type field name" style="margin-top:4px">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Area (ha)</label>
            <input class="form-input" id="fe-area" type="number" step="0.1" value="${entry.area_ha||''}">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Crop</label>
            <select class="form-select" id="fe-crop">
              <option value="">— select —</option>
              ${cropOptions.map(c=>`<option value="${c}" ${entry.crop_name===c?'selected':''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Crop type</label>
            <input class="form-input" id="fe-crop-type" type="text" value="${entry.crop_type||''}" placeholder="e.g. Flood, Lateral">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Variety</label>
            <input class="form-input" id="fe-variety" type="text" value="${entry.variety||''}" placeholder="e.g. 61803XF">
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Planting date</label>
            <input class="form-input" id="fe-planting" type="date" value="${entry.planting_date||''}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Priority</label>
            <select class="form-select" id="fe-priority">
              <option value="">No priority</option>
              <option value="high" ${entry.priority==='high'?'selected':''}>High priority</option>
              <option value="medium" ${entry.priority==='medium'?'selected':''}>Medium priority</option>
              <option value="low" ${entry.priority==='low'?'selected':''}>Low priority</option>
            </select>
          </div>
        </div>

        <!-- Crop-specific measurements -->
        <div id="fe-attrs" style="border:1px solid var(--border);border-radius:8px;padding:14px;background:var(--page-bg)">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:10px">Measurements</div>
          <div id="fe-attr-fields" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px">
            ${_renderAttrFields(fields, entry.growth_attributes||{})}
          </div>
        </div>

        <!-- Spray applications -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div style="font-size:13px;font-weight:600;color:var(--ink)">Spray applications</div>
            <button class="btn btn-ghost btn-sm" id="fe-add-spray">+ Add spray</button>
          </div>
          <div id="fe-sprays-list">
            ${(entry._sprays||[]).map((s,i)=>_sprayRow(s,i)).join('')}
          </div>
        </div>

        <!-- Comments -->
        <div class="form-group" style="margin:0">
          <label class="form-label">Field comments / observations</label>
          <textarea class="form-input" id="fe-comments" rows="3" style="resize:vertical" placeholder="Field-specific notes...">${entry.comments||''}</textarea>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Wire crop change → reload attr fields
  qs('#fe-paddock', modal)?.addEventListener('change', e => {
    const p = _paddocks.find(x=>x.name===e.target.value);
    if (p) { qs('#fe-paddock-name',modal).value=p.name; qs('#fe-area',modal).value=p.area_ha||''; }
  });

  qs('#fe-crop', modal)?.addEventListener('change', e => {
    const tmpl = _cropTemplates.find(t=>t.crop_name===e.target.value);
    qs('#fe-attr-fields',modal).innerHTML = _renderAttrFields(tmpl?.fields||[], {});
  });

  qs('#fe-add-spray', modal)?.addEventListener('click', () => {
    const list = qs('#fe-sprays-list',modal);
    const idx = list.children.length;
    list.insertAdjacentHTML('beforeend', _sprayRow({},idx));
  });

  modal.addEventListener('click', e => {
    if (e.target.classList.contains('fe-remove-spray')) {
      e.target.closest('.fe-spray-row').remove();
    }
  });

  qs('#fe-cancel', modal)?.addEventListener('click', () => modal.remove());

  qs('#fe-delete', modal)?.addEventListener('click', async () => {
    if (!confirm('Delete this field entry?')) return;
    if (entry.id) await dbDelete('agronomy_paddock_entries', entry.id);
    entries.splice(idx, 1);
    modal.remove();
    renderTab();
  });

  qs('#fe-save', modal)?.addEventListener('click', async () => {
    try {
      const paddockName = qs('#fe-paddock-name',modal)?.value?.trim() || qs('#fe-paddock',modal)?.value;
      const crop = qs('#fe-crop',modal)?.value;
      const tmpl = _cropTemplates.find(t=>t.crop_name===crop);
      const attrFields = tmpl?.fields||[];
      const attrs = {};
      attrFields.forEach(f => {
        const val = qs(`#fe-attr-${f.key}`,modal)?.value?.trim();
        if (val) attrs[f.key] = f.type==='number' ? parseFloat(val) : val;
      });

      // Gather sprays
      const sprays = [];
      modal.querySelectorAll('.fe-spray-row').forEach(row => {
        const product = row.querySelector('.fe-spray-product')?.value?.trim();
        if (!product) return;
        sprays.push({
          product_name: product,
          rate_per_ha: parseFloat(row.querySelector('.fe-spray-rate')?.value)||null,
          rate_unit: row.querySelector('.fe-spray-unit')?.value||'L/ha',
          litres_total: parseFloat(row.querySelector('.fe-spray-total')?.value)||null,
          applied_date: row.querySelector('.fe-spray-date')?.value||null,
          application_type: row.querySelector('.fe-spray-type')?.value||null,
          target: row.querySelector('.fe-spray-target')?.value?.trim()||null,
        });
      });

      const data = {
        visit_id: visitId,
        farm_id: farm.id,
        paddock_name: paddockName,
        area_ha: parseFloat(qs('#fe-area',modal)?.value)||null,
        crop_name: crop||null,
        crop_type: qs('#fe-crop-type',modal)?.value?.trim()||null,
        variety: qs('#fe-variety',modal)?.value?.trim()||null,
        planting_date: qs('#fe-planting',modal)?.value||null,
        priority: qs('#fe-priority',modal)?.value||null,
        growth_attributes: attrs,
        comments: qs('#fe-comments',modal)?.value?.trim()||null,
        display_order: isNew ? entries.length : entry.display_order,
      };

      let savedEntry;
      if (entry.id) {
        await dbUpdate('agronomy_paddock_entries', entry.id, data);
        savedEntry = { ...entry, ...data };
      } else {
        savedEntry = await dbInsert('agronomy_paddock_entries', data);
        savedEntry = savedEntry || data;
      }

      // Save sprays
      if (entry.id) {
        // Delete old sprays and reinsert
        for (const s of (entry._sprays||[])) {
          await dbDelete('agronomy_spray_applications', s.id).catch(()=>{});
        }
      }
      for (const s of sprays) {
        await dbInsert('agronomy_spray_applications', {
          ...s, visit_id: visitId, farm_id: farm.id,
          paddock_entry_id: entry.id || savedEntry?.id,
        }).catch(()=>{});
      }
      savedEntry._sprays = sprays;

      if (isNew) entries.push(savedEntry);
      else entries[idx] = savedEntry;

      modal.remove();
      toast('Field saved', 'success');
      renderTab();
    } catch(e) { toast('Error: ' + e.message, 'error'); console.error(e); }
  });
}

function _renderAttrFields(fields, values) {
  if (!fields?.length) return '<div style="font-size:12px;color:var(--hint)">Select a crop to see measurements</div>';
  return fields.map(f => `
    <div class="form-group" style="margin:0">
      <label class="form-label" style="font-size:10px">${f.label}${f.unit?' ('+f.unit+')':''}</label>
      <input class="form-input" id="fe-attr-${f.key}" type="${f.type==='number'?'number':f.type==='date'?'date':'text'}"
        step="${f.type==='number'?'0.01':''}" value="${values[f.key]||''}" placeholder="—">
    </div>`).join('');
}

function _sprayRow(s, i) {
  return `
    <div class="fe-spray-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr 1fr auto;gap:6px;margin-bottom:6px;align-items:center">
      <input class="form-input fe-spray-product" type="text" value="${s.product_name||''}" placeholder="Product" style="font-size:12px">
      <input class="form-input fe-spray-rate" type="number" step="0.001" value="${s.rate_per_ha||''}" placeholder="Rate" style="font-size:12px">
      <select class="form-select fe-spray-unit" style="font-size:12px">
        ${['L/ha','mL/ha','kg/ha','g/ha'].map(u=>`<option ${(s.rate_unit||'L/ha')===u?'selected':''}>${u}</option>`).join('')}
      </select>
      <input class="form-input fe-spray-total" type="number" step="0.1" value="${s.litres_total||''}" placeholder="Total L" style="font-size:12px">
      <input class="form-input fe-spray-date" type="date" value="${s.applied_date||''}" style="font-size:12px">
      <select class="form-select fe-spray-type" style="font-size:12px">
        <option value="">Type</option>
        ${APP_TYPES.map(t=>`<option value="${t.toLowerCase()}" ${s.application_type===t.toLowerCase()?'selected':''}>${t}</option>`).join('')}
      </select>
      <button class="fe-remove-spray" style="border:none;background:none;color:var(--hint);cursor:pointer;font-size:18px;padding:0 4px">×</button>
    </div>
    <div style="margin-bottom:8px">
      <input class="form-input fe-spray-target" type="text" value="${s.target||''}" placeholder="Target / notes" style="font-size:11px">
    </div>
  `;
}

// ── Bind tab events ───────────────────────────────────────────
function _bindTabEvents(overlay, entries, actions, photos, visitId, farm, renderTab) {
  // Fields tab
  qs('#av-add-field', overlay)?.addEventListener('click', () => _openFieldEditor(overlay, entries, -1, visitId, farm, renderTab));
  overlay.querySelectorAll('.av-field-card').forEach(card => {
    card.addEventListener('click', () => _openFieldEditor(overlay, entries, parseInt(card.dataset.idx), visitId, farm, renderTab));
  });

  // Actions tab
  overlay.querySelectorAll('.av-add-action').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = prompt(`Add ${btn.dataset.priority} priority action:`);
      if (!text?.trim()) return;
      const action = {
        visit_id: visitId, farm_id: farm.id,
        priority: btn.dataset.priority,
        action_text: text.trim(),
        display_order: actions.length,
      };
      if (visitId) {
        const saved = await dbInsert('agronomy_actions', action).catch(() => null);
        if (saved) actions.push(saved);
        else actions.push(action);
      } else actions.push(action);
      renderTab();
    });
  });

  overlay.querySelectorAll('.av-delete-action').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const priority = btn.dataset.priority;
      const groupIdx = parseInt(btn.dataset.idx);
      const groupActions = actions.filter(a => a.priority === priority);
      const action = groupActions[groupIdx];
      if (action?.id) await dbDelete('agronomy_actions', action.id).catch(()=>{});
      const globalIdx = actions.indexOf(action);
      if (globalIdx > -1) actions.splice(globalIdx, 1);
      renderTab();
    });
  });

  // Photos tab
  qs('#av-photo-input', overlay)?.addEventListener('change', async e => {
    const files = Array.from(e.target.files);
    const session = getSession();
    for (const file of files) {
      const path = `agronomy/${farm.id}/${visitId||'draft'}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
      const res = await fetch(`https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/cfm-documents/${path}`, {
        method: 'PUT',
        headers: { 'apikey': window.__CFM_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': file.type, 'x-upsert': 'true' },
        body: file,
      });
      if (res.ok) {
        const url = `https://nqvfuqvindsgnogejaei.supabase.co/storage/v1/object/public/cfm-documents/${path}`;
        const photo = { url, filename: file.name, caption: '', farm_id: farm.id, visit_id: visitId };
        if (visitId) {
          const saved = await dbInsert('agronomy_photos', photo).catch(()=>null);
          photos.push(saved||photo);
        } else photos.push(photo);
      }
    }
    renderTab();
  });
}

// ── Gather form data ──────────────────────────────────────────
function _gatherOverview(overlay, farm, season) {
  return {
    farm_id: farm.id,
    visit_date: qs('#av-date', overlay)?.value,
    visit_number: parseInt(qs('#av-visit-num', overlay)?.value)||null,
    agronomist_name: qs('#av-agronomist', overlay)?.value?.trim()||null,
    agronomist_company: qs('#av-company', overlay)?.value?.trim()||null,
    observations: qs('#av-observations', overlay)?.value?.trim()||null,
    recommendations: qs('#av-recommendations', overlay)?.value?.trim()||null,
    status: qs('#av-status', overlay)?.value||'draft',
  };
}

// ── Report generator ──────────────────────────────────────────
function _generateReport(visit, entries, actions, photos, farm, season) {
  const high = actions.filter(a=>a.priority==='high');
  const medium = actions.filter(a=>a.priority==='medium');

  const reportWin = window.open('','_blank');
  reportWin.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${farm.name} — Agronomy Report ${formatDate(visit.visit_date)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, Arial, sans-serif; font-size:11px; color:#222; padding:20px; }
  h1 { font-size:18px; font-weight:700; color:#1a3a5c; }
  h2 { font-size:13px; font-weight:700; color:#1a3a5c; margin:16px 0 6px; padding-bottom:3px; border-bottom:1px solid #ccc; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px; padding-bottom:12px; border-bottom:2px solid #1a3a5c; }
  .header-meta { font-size:11px; color:#666; margin-top:3px; }
  .actions-box { background:#fef2f2; border:1px solid #fca5a5; border-radius:6px; padding:10px 12px; margin-bottom:16px; }
  .actions-box.medium { background:#fffbeb; border-color:#fcd34d; }
  .action-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.07em; color:#991b1b; margin-bottom:5px; }
  .action-label.medium { color:#92400e; }
  .action-item { font-size:12px; color:#7f1d1d; margin-bottom:3px; padding-left:12px; }
  .action-item.medium { color:#78350f; }
  table { width:100%; border-collapse:collapse; margin-bottom:16px; }
  th { background:#1a3a5c; color:white; padding:5px 8px; font-size:10px; text-align:left; font-weight:600; }
  td { padding:5px 8px; border-bottom:1px solid #e5e7eb; vertical-align:top; }
  tr:nth-child(even) { background:#f9fafb; }
  .priority-high { background:#fef2f2; }
  .priority-medium { background:#fffbeb; }
  .photo-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:12px; }
  .photo-item img { width:100%; height:160px; object-fit:cover; border-radius:4px; }
  .photo-caption { font-size:10px; color:#666; text-align:center; margin-top:4px; }
  @media print { body { padding:10px; } }
</style>
</head><body>

<div class="header">
  <div>
    <h1>${farm.name} — Agronomy Inspection Report</h1>
    <div class="header-meta">
      ${formatDate(visit.visit_date)} · Visit #${visit.visit_number||'—'} · Season ${season}<br>
      Agronomist: ${visit.agronomist_name||'—'} · ${visit.agronomist_company||''}
    </div>
  </div>
  <div style="text-align:right;font-size:10px;color:#666">CFM Farm Management<br>${new Date().toLocaleDateString('en-AU')}</div>
</div>

${high.length ? `
<div class="actions-box">
  <div class="action-label">⚠ High priority actions</div>
  ${high.map(a=>`<div class="action-item">• ${a.action_text}</div>`).join('')}
</div>` : ''}

${medium.length ? `
<div class="actions-box medium">
  <div class="action-label medium">Medium priority actions</div>
  ${medium.map(a=>`<div class="action-item medium">• ${a.action_text}</div>`).join('')}
</div>` : ''}

${visit.observations || visit.recommendations ? `
<h2>General notes</h2>
<p style="margin-bottom:6px;font-size:11px">${visit.observations||''}</p>
<p style="font-size:11px">${visit.recommendations||''}</p>
` : ''}

<h2>Field summary</h2>
<table>
  <thead><tr>
    <th>Field</th><th>Crop</th><th>Variety</th><th>Area (ha)</th>
    ${_getAttrHeaders(entries).map(h=>`<th>${h}</th>`).join('')}
    <th>Comments</th>
  </tr></thead>
  <tbody>
    ${entries.map(e => {
      const cls = e.priority==='high' ? 'priority-high' : e.priority==='medium' ? 'priority-medium' : '';
      const attrs = e.growth_attributes||{};
      const headers = _getAttrHeaders(entries);
      return `<tr class="${cls}">
        <td style="font-weight:600">${e.paddock_name||'—'}</td>
        <td>${e.crop_name||'—'}${e.crop_type?' ('+e.crop_type+')':''}</td>
        <td>${e.variety||'—'}</td>
        <td style="text-align:right">${e.area_ha||'—'}</td>
        ${headers.map(h => {
          const key = h.toLowerCase().replace(/ /g,'_').replace(/[^a-z0-9_]/g,'');
          const val = Object.entries(attrs).find(([k])=>k.toLowerCase()===key||k===h)?.[1];
          return `<td style="text-align:center">${val!=null?val:'—'}</td>`;
        }).join('')}
        <td style="font-size:10px;max-width:200px">${e.comments||''}</td>
      </tr>`;
    }).join('')}
  </tbody>
</table>

${entries.some(e=>e._sprays?.length) ? `
<h2>Spray applications</h2>
<table>
  <thead><tr><th>Field</th><th>Product</th><th>Type</th><th>Rate</th><th>Total</th><th>Date applied</th><th>Target</th></tr></thead>
  <tbody>
    ${entries.flatMap(e=>(e._sprays||[]).map(s=>`
      <tr>
        <td>${e.paddock_name||'—'}</td>
        <td style="font-weight:600">${s.product_name||'—'}</td>
        <td>${s.application_type||'—'}</td>
        <td>${s.rate_per_ha||'—'} ${s.rate_unit||''}</td>
        <td>${s.litres_total||'—'} L</td>
        <td>${s.applied_date?formatDate(s.applied_date):'—'}</td>
        <td>${s.target||'—'}</td>
      </tr>`)).join('')}
  </tbody>
</table>` : ''}

${_varietySummaryReport(entries)}

${photos.length ? `
<h2>Photos</h2>
<div class="photo-grid">
  ${photos.map(p=>`<div class="photo-item"><img src="${p.url}"><div class="photo-caption">${p.caption||''}</div></div>`).join('')}
</div>` : ''}

</body></html>`);
  reportWin.document.close();
  setTimeout(() => reportWin.print(), 500);
}

function _getAttrHeaders(entries) {
  const seen = new Set();
  const headers = [];
  entries.forEach(e => {
    const tmpl = _cropTemplates.find(t=>t.crop_name===e.crop_name);
    (tmpl?.fields||[]).forEach(f => { if(!seen.has(f.label)){seen.add(f.label);headers.push(f.label);} });
  });
  return headers;
}

function _varietySummaryReport(entries) {
  const byVariety = {};
  entries.forEach(e => {
    if (!e.variety) return;
    if (!byVariety[e.variety]) byVariety[e.variety] = { area:0, crop:e.crop_name };
    byVariety[e.variety].area += parseFloat(e.area_ha)||0;
  });
  const rows = Object.entries(byVariety).sort((a,b)=>b[1].area-a[1].area);
  if (!rows.length) return '';
  const total = rows.reduce((s,[,d])=>s+d.area,0);
  return `<h2>Variety summary</h2>
  <table style="max-width:400px">
    <thead><tr><th>Variety</th><th>Crop</th><th style="text-align:right">Area (ha)</th><th style="text-align:right">%</th></tr></thead>
    <tbody>
      ${rows.map(([v,d])=>`<tr><td>${v}</td><td>${d.crop||'—'}</td><td style="text-align:right">${d.area.toFixed(1)}</td><td style="text-align:right">${total?Math.round(d.area/total*100)+'%':''}</td></tr>`).join('')}
      <tr style="font-weight:700;border-top:1px solid #ccc"><td colspan="2">Total</td><td style="text-align:right">${total.toFixed(1)}</td><td></td></tr>
    </tbody>
  </table>`;
}

export function unmountAgronomyVisits() {}
