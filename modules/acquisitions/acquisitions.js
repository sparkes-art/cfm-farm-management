// modules/acquisitions/acquisitions.js
import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getSession, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatCurrency, formatDate, qs } from '../../js/ui.js';

const SUPABASE_URL = 'https://nqvfuqvindsgnogejaei.supabase.co';

let _deals = [];
let _agents = [];
let _activeTab = 'pipeline';
let _filterStatus = '';
let _filterMgmt = '';
let _searchTerm = '';
let _activeDeal = null;

const STATUSES = ['New', 'Reviewing', 'Interested', 'Due Diligence', 'Proposal Sent', 'Engaged', 'Passed', 'Sold'];
const MGMT_STATUSES = ['Available', 'No Interest', 'Already Manage'];
const DOC_TYPES = ['IM', 'Farm Model', 'Proposal', 'Report', 'Valuation', 'Other'];
const ACTIVITY_TYPES = ['Note', 'Call', 'Inspection', 'Email', 'Proposal', 'Meeting'];

const STATUS_COLOURS = {
  'New':           { bg: '#f3f4f6', color: '#374151' },
  'Reviewing':     { bg: '#fef3c7', color: '#92400e' },
  'Interested':    { bg: '#dbeafe', color: '#1e40af' },
  'Due Diligence': { bg: '#ede9fe', color: '#5b21b6' },
  'Proposal Sent': { bg: '#fce7f3', color: '#9d174d' },
  'Engaged':       { bg: '#d1fae5', color: '#065f46' },
  'Passed':        { bg: '#f3f4f6', color: '#9ca3af' },
  'Sold':          { bg: '#1a2535', color: '#ffffff' },
};

const MGMT_COLOURS = {
  'Available':     { bg: '#d1fae5', color: '#065f46' },
  'No Interest':   { bg: '#fee2e2', color: '#991b1b' },
  'Already Manage':{ bg: '#dbeafe', color: '#1e40af' },
};

export async function mountAcquisitions(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Deal Pipeline</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid)">Acquisition opportunities</p>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-secondary" id="btn-new-deal">＋ Add deal</button>
        <button class="btn btn-ghost btn-sm" id="btn-export">⬇ Export</button>
      </div>
    </div>

    <div class="tab-strip" style="margin-bottom:16px">
      <button class="tab-btn ${_activeTab==='pipeline'?'active':''}" data-tab="pipeline">Pipeline</button>
      <button class="tab-btn ${_activeTab==='list'?'active':''}" data-tab="list">List view</button>
    </div>

    <div id="acq-content"></div>
  `;

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _renderTab(container);
    });
  });

  qs('#btn-new-deal', container)?.addEventListener('click', () => _dealModal(container));
  qs('#btn-export', container)?.addEventListener('click', () => _exportCSV());

  await _loadData();
  _renderTab(container);
}

export function unmountAcquisitions() {
  _deals = [];
  _agents = [];
  _activeDeal = null;
}

async function _loadData() {
  [_deals, _agents] = await Promise.all([
    dbSelect('acquisition_deals', 'select=*&order=date_created.desc'),
    dbSelect('acquisition_agents', 'select=*&order=name.asc').catch(() => []),
  ]);
}

function _renderTab(container) {
  const content = qs('#acq-content', container);
  if (_activeTab === 'pipeline') _renderPipeline(content, container);
  else _renderList(content, container);
}

// ── Pipeline (kanban-style) ───────────────────────────────────
function _renderPipeline(content, container) {
  const activeStatuses = STATUSES.filter(s => s !== 'Passed' && s !== 'Sold');
  const passed = _deals.filter(d => d.status === 'Passed');
  const sold = _deals.filter(d => d.status === 'Sold');

  content.innerHTML = `
    <!-- Summary strip -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${[
        ['Total deals', _deals.length, 'var(--ink)'],
        ['Active', _deals.filter(d=>!['Passed','Sold'].includes(d.status)).length, 'var(--blue)'],
        ['Engaged', _deals.filter(d=>d.status==='Engaged').length, '#065f46'],
        ['Available to manage', _deals.filter(d=>d.cfm_management_status==='Available').length, '#3B6D11'],
      ].map(([l,v,c]) => `<div class="card" style="padding:10px 14px">
        <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:3px">${l}</p>
        <p style="font-size:22px;font-weight:600;color:${c};font-variant-numeric:tabular-nums">${v}</p>
      </div>`).join('')}
    </div>

    <!-- Pipeline columns -->
    <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;overflow-x:auto;min-width:900px">
      ${activeStatuses.map(status => {
        const deals = _deals.filter(d => d.status === status);
        const sc = STATUS_COLOURS[status] || STATUS_COLOURS['New'];
        return `<div style="background:var(--page-bg);border-radius:8px;padding:10px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${sc.bg};color:${sc.color}">${status}</span>
            <span style="font-size:11px;color:var(--hint)">${deals.length}</span>
          </div>
          ${deals.map(d => `
            <div class="deal-card" data-id="${d.id}" style="background:white;border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;cursor:pointer;transition:box-shadow .15s">
              <p style="font-size:12px;font-weight:600;margin-bottom:4px;line-height:1.3">${d.property_name}</p>
              ${d.location ? `<p style="font-size:10px;color:var(--hint);margin-bottom:4px">📍 ${d.location}</p>` : ''}
              ${d.price_min ? `<p style="font-size:11px;font-weight:500;color:var(--blue);margin-bottom:4px">$${Number(d.price_min).toLocaleString()}${d.price_max ? ' – $'+Number(d.price_max).toLocaleString() : '+'}</p>` : ''}
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
                ${d.cfm_management_status ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:${(MGMT_COLOURS[d.cfm_management_status]||{}).bg||'#f3f4f6'};color:${(MGMT_COLOURS[d.cfm_management_status]||{}).color||'#374151'}">${d.cfm_management_status}</span>` : '<span></span>'}
                <span style="font-size:10px;color:var(--hint)">${d.lead_agent||''}</span>
              </div>
            </div>
          `).join('')}
        </div>`;
      }).join('')}
    </div>

    <!-- Passed & Sold footer -->
    ${passed.length || sold.length ? `
    <div style="margin-top:16px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${['Passed','Sold'].map(status => {
        const deals = _deals.filter(d => d.status === status);
        const sc = STATUS_COLOURS[status];
        return `<div class="card" style="padding:12px">
          <p style="font-size:11px;font-weight:600;color:${sc.color};background:${sc.bg};display:inline-block;padding:2px 8px;border-radius:10px;margin-bottom:8px">${status} (${deals.length})</p>
          ${deals.map(d => `<div class="deal-card" data-id="${d.id}" style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border-light);cursor:pointer;font-size:12px">
            <span>${d.property_name}</span>
            <span style="color:var(--hint)">${d.likely_price_label||''}</span>
          </div>`).join('')}
        </div>`;
      }).join('')}
    </div>` : ''}
  `;

  // Wire deal card clicks
  content.querySelectorAll('.deal-card').forEach(card => {
    card.addEventListener('mouseenter', () => card.style.boxShadow = '0 2px 8px rgba(0,0,0,.1)');
    card.addEventListener('mouseleave', () => card.style.boxShadow = '');
    card.addEventListener('click', () => {
      const deal = _deals.find(d => d.id === card.dataset.id);
      if (deal) _openDeal(deal, container);
    });
  });
}

// ── List view ─────────────────────────────────────────────────
function _renderList(content, container) {
  let deals = _deals;
  if (_filterStatus) deals = deals.filter(d => d.status === _filterStatus);
  if (_filterMgmt) deals = deals.filter(d => d.cfm_management_status === _filterMgmt);
  if (_searchTerm) deals = deals.filter(d =>
    d.property_name?.toLowerCase().includes(_searchTerm) ||
    d.location?.toLowerCase().includes(_searchTerm) ||
    d.lead_agent?.toLowerCase().includes(_searchTerm) ||
    d.agency?.toLowerCase().includes(_searchTerm)
  );

  content.innerHTML = `
    <div class="flex gap-2" style="margin-bottom:12px">
      <input class="form-input" id="acq-search" placeholder="Search properties, agents…" style="width:220px" value="${_searchTerm}">
      <select class="form-select" id="acq-filter-status" style="width:160px">
        <option value="">All statuses</option>
        ${STATUSES.map(s => `<option value="${s}" ${_filterStatus===s?'selected':''}>${s}</option>`).join('')}
      </select>
      <select class="form-select" id="acq-filter-mgmt" style="width:170px">
        <option value="">All CFM statuses</option>
        ${MGMT_STATUSES.map(s => `<option value="${s}" ${_filterMgmt===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>

    <div class="card" style="overflow:hidden">
      <table class="data-table">
        <thead><tr>
          <th>Property</th>
          <th>Location</th>
          <th>Agent</th>
          <th>Agency</th>
          <th>Region</th>
          <th>Est. price</th>
          <th>Status</th>
          <th>CFM status</th>
          <th>Created</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${deals.map(d => {
            const sc = STATUS_COLOURS[d.status] || STATUS_COLOURS['New'];
            const mc = MGMT_COLOURS[d.cfm_management_status] || {};
            return `<tr class="deal-row" data-id="${d.id}" style="cursor:pointer">
              <td><strong>${d.property_name}</strong></td>
              <td class="muted">${d.location||'—'}</td>
              <td class="muted">${d.lead_agent||'—'}</td>
              <td class="muted">${d.agency||'—'}</td>
              <td class="muted">${d.region||'—'}</td>
              <td style="font-size:12px;font-weight:500;color:var(--blue)">${d.price_min ? '$'+Number(d.price_min).toLocaleString() + (d.price_max ? ' – $'+Number(d.price_max).toLocaleString() : '+') : (d.likely_price_label||'—')}</td>
              <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${sc.bg};color:${sc.color};font-weight:500;white-space:nowrap">${d.status||'New'}</span></td>
              <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${mc.bg||'#f3f4f6'};color:${mc.color||'#374151'}">${d.cfm_management_status||'—'}</span></td>
              <td class="muted" style="font-size:11px">${d.date_created?formatDate(d.date_created):'—'}</td>
              <td><button class="btn btn-ghost btn-sm edit-deal-btn" data-id="${d.id}">Edit</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${!deals.length ? '<div class="empty-state" style="padding:40px"><p>No deals match your filters.</p></div>' : ''}
    </div>
  `;

  qs('#acq-search', content)?.addEventListener('input', e => { _searchTerm = e.target.value.toLowerCase(); _renderList(content, container); });
  qs('#acq-filter-status', content)?.addEventListener('change', e => { _filterStatus = e.target.value; _renderList(content, container); });
  qs('#acq-filter-mgmt', content)?.addEventListener('change', e => { _filterMgmt = e.target.value; _renderList(content, container); });

  content.querySelectorAll('.deal-row').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('.edit-deal-btn')) return;
      const deal = _deals.find(d => d.id === row.dataset.id);
      if (deal) _openDeal(deal, container);
    });
  });
  content.querySelectorAll('.edit-deal-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const deal = _deals.find(d => d.id === btn.dataset.id);
      if (deal) _dealModal(container, deal);
    });
  });
}

// ── Deal detail view ──────────────────────────────────────────
async function _openDeal(deal, container) {
  _activeDeal = deal;

  // Load documents and activities
  const [docs, activities] = await Promise.all([
    dbSelect('acquisition_documents', 'deal_id=eq.' + deal.id + '&select=*&order=uploaded_at.desc'),
    dbSelect('acquisition_activities', 'deal_id=eq.' + deal.id + '&select=*&order=activity_date.desc,created_at.desc'),
  ]);

  const sc = STATUS_COLOURS[deal.status] || STATUS_COLOURS['New'];
  const mc = MGMT_COLOURS[deal.cfm_management_status] || {};

  openModal({
    title: deal.property_name,
    wide: true,
    confirmLabel: 'Edit deal',
    confirmClass: 'btn-secondary',
    onConfirm: () => _dealModal(container, deal),
    bodyHTML: `
      <!-- Header badges -->
      <div class="flex gap-2" style="margin-bottom:16px">
        <span style="padding:3px 10px;border-radius:10px;font-size:12px;font-weight:500;background:${sc.bg};color:${sc.color}">${deal.status||'New'}</span>
        <span style="padding:3px 10px;border-radius:10px;font-size:12px;background:${mc.bg||'#f3f4f6'};color:${mc.color||'#374151'}">${deal.cfm_management_status||'—'}</span>
        ${deal.likely_price_label ? `<span style="padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600;background:#dbeafe;color:#1e40af">${deal.likely_price_label}</span>` : ''}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <!-- Left -->
        <div>
          <!-- Key details -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
            ${[
              ['Location', deal.location],
              ['Region', deal.region],
              ['Est. price', deal.price_min ? '$'+Number(deal.price_min).toLocaleString() + (deal.price_max ? ' – $'+Number(deal.price_max).toLocaleString() : '+') : null],
              ['Lead agent', deal.lead_agent],
              ['Agency', deal.agency],
              ['Agent email', deal.agent_email],
              ['Agent phone', deal.agent_phone],
              ['Date created', deal.date_created ? formatDate(deal.date_created) : null],
            ].filter(([,v]) => v).map(([l,v]) => `
              <div><p style="font-size:10px;color:var(--hint);margin-bottom:2px">${l}</p><p style="font-size:13px;font-weight:500">${v}</p></div>
            `).join('')}
          </div>

          <!-- IM and Model links -->
          ${deal.im_url || deal.model_url ? `
          <div style="display:flex;gap:8px;margin-bottom:14px">
            ${deal.im_url ? `<a href="${deal.im_url}" target="_blank" class="btn btn-secondary btn-sm">📄 View IM</a>` : ''}
            ${deal.model_url ? `<a href="${deal.model_url}" target="_blank" class="btn btn-secondary btn-sm">📊 View Farm Model</a>` : ''}
          </div>` : ''}

          <!-- Farm prospects -->
          ${deal.farm_prospects ? `
          <div style="margin-bottom:14px">
            <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;margin-bottom:6px">Farm prospects</p>
            <div style="background:var(--page-bg);border-radius:6px;padding:10px 12px;font-size:12px;line-height:1.5">${deal.farm_prospects}</div>
          </div>` : ''}

          <!-- CFM notes -->
          ${deal.cfm_notes ? `
          <div style="margin-bottom:14px">
            <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;margin-bottom:6px">CFM notes</p>
            <div style="background:#fffbeb;border-radius:6px;padding:10px 12px;font-size:12px;line-height:1.5;border-left:3px solid #f59e0b">${deal.cfm_notes}</div>
          </div>` : ''}
        </div>

        <!-- Right -->
        <div>
          <!-- Documents -->
          <div style="margin-bottom:16px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Documents</p>
              <button class="btn btn-ghost btn-sm" id="btn-add-doc">＋ Upload</button>
            </div>
            ${docs.length ? `
            <div style="display:flex;flex-direction:column;gap:4px">
              ${docs.map(doc => `
                <div style="display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--page-bg);border-radius:6px;border:1px solid var(--border-light)">
                  <span style="font-size:18px">${doc.doc_type==='IM'?'📄':doc.doc_type==='Farm Model'?'📊':doc.doc_type==='Proposal'?'📝':'📎'}</span>
                  <div style="flex:1;min-width:0">
                    <p style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${doc.filename}</p>
                    <p style="font-size:10px;color:var(--hint)">${doc.doc_type} · ${doc.uploaded_at?formatDate(doc.uploaded_at):''}</p>
                  </div>
                  ${doc.file_url ? `<a href="${doc.file_url}" target="_blank" class="btn btn-ghost btn-sm">View</a>` : ''}
                </div>
              `).join('')}
            </div>` : `<p style="font-size:12px;color:var(--hint)">No documents yet.</p>`}
          </div>

          <!-- Activity log -->
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Activity log</p>
              <button class="btn btn-ghost btn-sm" id="btn-add-activity">＋ Add</button>
            </div>
            ${activities.length ? `
            <div style="display:flex;flex-direction:column;gap:6px;max-height:250px;overflow-y:auto">
              ${activities.map(a => `
                <div style="padding:8px 10px;background:var(--page-bg);border-radius:6px;border-left:3px solid var(--blue)">
                  <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                    <span style="font-size:11px;font-weight:600;color:var(--blue)">${a.activity_type}</span>
                    <span style="font-size:10px;color:var(--hint)">${a.activity_date?formatDate(a.activity_date):''} · ${a.created_by||''}</span>
                  </div>
                  <p style="font-size:12px;font-weight:500">${a.summary||''}</p>
                  ${a.detail ? `<p style="font-size:11px;color:var(--hint);margin-top:2px">${a.detail}</p>` : ''}
                </div>
              `).join('')}
            </div>` : `<p style="font-size:12px;color:var(--hint)">No activity logged yet.</p>`}
          </div>
        </div>
      </div>
    `,
  });

  // Wire buttons
  setTimeout(() => {
    document.getElementById('btn-add-doc')?.addEventListener('click', () => _docModal(deal));
    document.getElementById('btn-add-activity')?.addEventListener('click', () => _activityModal(deal, container));
  }, 200);
}

// ── Deal modal (add/edit) ─────────────────────────────────────
function _dealModal(container, existing = null) {
  openModal({
    title: existing ? 'Edit deal' : 'New deal',
    confirmLabel: existing ? 'Save changes' : 'Add deal',
    wide: true,
    bodyHTML: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <!-- Left column -->
        <div style="display:flex;flex-direction:column;gap:0">
          <div class="form-group">
            <label class="form-label">Property name *</label>
            <input class="form-input" id="d-name" value="${existing?.property_name||''}" placeholder="e.g. Merrowie Station">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Location</label>
              <input class="form-input" id="d-location" value="${existing?.location||''}" placeholder="e.g. Hillston, NSW">
            </div>
            <div class="form-group">
              <label class="form-label">Region</label>
              <input class="form-input" id="d-region" value="${existing?.region||''}" placeholder="e.g. Riverina, Darling Downs">
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Est. price min ($)</label>
              <input class="form-input num" id="d-price-min" type="number" step="1000000" value="${existing?.price_min||''}" placeholder="50000000">
            </div>
            <div class="form-group">
              <label class="form-label">Est. price max ($)</label>
              <input class="form-input num" id="d-price-max" type="number" step="1000000" value="${existing?.price_max||''}" placeholder="100000000">
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Farm prospects</label>
            <textarea class="form-textarea" id="d-prospects" rows="4" placeholder="CFM's assessment of the property prospects…">${existing?.farm_prospects||''}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">CFM notes</label>
            <textarea class="form-textarea" id="d-notes" rows="4" placeholder="Internal CFM notes…">${existing?.cfm_notes||''}</textarea>
          </div>
        </div>
        <!-- Right column -->
        <div style="display:flex;flex-direction:column;gap:0">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Deal status</label>
              <select class="form-select" id="d-status">
                ${STATUSES.map(s => `<option value="${s}" ${(existing?.status||'New')===s?'selected':''}>${s}</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">CFM management status</label>
              <select class="form-select" id="d-mgmt">
                ${MGMT_STATUSES.map(s => `<option value="${s}" ${(existing?.cfm_management_status||'Available')===s?'selected':''}>${s}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Date created</label>
            <input class="form-input" id="d-created" type="date" value="${existing?.date_created||new Date().toISOString().slice(0,10)}">
          </div>
          <!-- Agent section -->
          <div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
            <p style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:10px">Agent details</p>
            <div class="form-group">
              <label class="form-label">Lead agent</label>
              <input class="form-input" id="d-agent" value="${existing?.lead_agent||''}" list="agents-list" placeholder="Start typing agent name…">
              <datalist id="agents-list">
                ${_agents.map(a => `<option value="${a.name}" data-agency="${a.agency||''}" data-email="${a.email||''}" data-phone="${a.phone||''}">${a.name} — ${a.agency||''}</option>`).join('')}
              </datalist>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">Agency</label>
                <input class="form-input" id="d-agency" value="${existing?.agency||''}" placeholder="e.g. LAWD">
              </div>
              <div class="form-group">
                <label class="form-label">Agent phone</label>
                <input class="form-input" id="d-phone" value="${existing?.agent_phone||''}" placeholder="04xx xxx xxx">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Agent email</label>
              <input class="form-input" id="d-email" type="email" value="${existing?.agent_email||''}" placeholder="agent@agency.com">
            </div>
          </div>
          <!-- Documents -->
          <div style="border:1px solid var(--border);border-radius:8px;padding:12px">
            <p style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--hint);margin-bottom:10px">Documents</p>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label">IM (Information Memorandum)</label>
                <input type="file" id="d-im-file" class="form-input" accept=".pdf">
                ${existing?.im_url ? `<p style="font-size:11px;color:var(--blue);margin-top:4px"><a href="${existing.im_url}" target="_blank">📄 Current IM</a></p>` : ''}
              </div>
              <div class="form-group">
                <label class="form-label">Farm Model</label>
                <input type="file" id="d-model-file" class="form-input" accept=".pdf,.xlsx,.xls">
                ${existing?.model_url ? `<p style="font-size:11px;color:var(--blue);margin-top:4px"><a href="${existing.model_url}" target="_blank">📊 Current model</a></p>` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    `,
    onConfirm: async (modal) => {
      const session = getSession();
      const priceMin = parseFloat(qs('#d-price-min', modal)?.value)||null;
      const priceMax = parseFloat(qs('#d-price-max', modal)?.value)||null;
      const agentName = qs('#d-agent', modal)?.value?.trim()||null;
      const agency = qs('#d-agency', modal)?.value?.trim()||null;
      const agentEmail = qs('#d-email', modal)?.value?.trim()||null;
      const agentPhone = qs('#d-phone', modal)?.value?.trim()||null;

      // Save/update agent for future pre-filling
      if (agentName) {
        const existingAgent = _agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
        if (!existingAgent) {
          const saved = await dbInsert('acquisition_agents', { name: agentName, agency, email: agentEmail, phone: agentPhone }).catch(()=>null);
          if (saved) _agents.push(saved);
        } else if (agency || agentEmail || agentPhone) {
          await dbUpdate('acquisition_agents', existingAgent.id, {
            agency: agency || existingAgent.agency,
            email: agentEmail || existingAgent.email,
            phone: agentPhone || existingAgent.phone,
          }).catch(()=>{});
        }
      }

      // Upload IM if provided
      let imUrl = existing?.im_url || null;
      const imFile = qs('#d-im-file', modal)?.files?.[0];
      if (imFile) {
        const path = `acquisitions/im/${Date.now()}_${imFile.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/cfm-documents/${path}`, {
          method: 'POST',
          headers: { 'apikey': window.__CFM_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': imFile.type, 'x-upsert': 'true' },
          body: imFile,
        });
        if (res.ok) imUrl = `${SUPABASE_URL}/storage/v1/object/public/cfm-documents/${path}`;
      }

      // Upload model if provided
      let modelUrl = existing?.model_url || null;
      const modelFile = qs('#d-model-file', modal)?.files?.[0];
      if (modelFile) {
        const path = `acquisitions/models/${Date.now()}_${modelFile.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/cfm-documents/${path}`, {
          method: 'POST',
          headers: { 'apikey': window.__CFM_ANON_KEY, 'Authorization': `Bearer ${session?.access_token}`, 'Content-Type': modelFile.type, 'x-upsert': 'true' },
          body: modelFile,
        });
        if (res.ok) modelUrl = `${SUPABASE_URL}/storage/v1/object/public/cfm-documents/${path}`;
      }

      const row = {
        property_name: qs('#d-name', modal)?.value?.trim(),
        location: qs('#d-location', modal)?.value?.trim()||null,
        region: qs('#d-region', modal)?.value?.trim()||null,
        price_min: priceMin,
        price_max: priceMax,
        lead_agent: agentName,
        agency,
        agent_email: agentEmail,
        agent_phone: agentPhone,
        status: qs('#d-status', modal)?.value||'New',
        cfm_management_status: qs('#d-mgmt', modal)?.value||'Available',
        date_created: qs('#d-created', modal)?.value||null,
        farm_prospects: qs('#d-prospects', modal)?.value?.trim()||null,
        cfm_notes: qs('#d-notes', modal)?.value?.trim()||null,
        im_url: imUrl,
        model_url: modelUrl,
      };
      if (!row.property_name) throw new Error('Property name is required');
      if (existing) {
        await dbUpdate('acquisition_deals', existing.id, row);
        Object.assign(_deals.find(d => d.id === existing.id), row);
        toast('Deal updated', 'success');
      } else {
        const saved = await dbInsert('acquisition_deals', row);
        _deals.unshift(saved);
        toast('Deal added', 'success');
      }
      _renderTab(container);
    },
  });

  // Wire agent autofill
  setTimeout(() => {
    const agentInput = document.getElementById('d-agent');
    agentInput?.addEventListener('change', () => {
      const agent = _agents.find(a => a.name.toLowerCase() === agentInput.value.toLowerCase());
      if (agent) {
        const agencyEl = document.getElementById('d-agency');
        const emailEl = document.getElementById('d-email');
        const phoneEl = document.getElementById('d-phone');
        if (agencyEl && !agencyEl.value) agencyEl.value = agent.agency||'';
        if (emailEl && !emailEl.value) emailEl.value = agent.email||'';
        if (phoneEl && !phoneEl.value) phoneEl.value = agent.phone||'';
      }
    });
  }, 200);
}

// ── Document upload modal ─────────────────────────────────────
function _docModal(deal) {
  const session = getSession();
  openModal({
    title: 'Upload document',
    confirmLabel: 'Upload',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Document type</label>
          <select class="form-select" id="doc-type">
            ${DOC_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">File</label>
        <input type="file" id="doc-file" class="form-input" accept=".pdf,.xlsx,.docx,.xls,.doc">
      </div>
      <div class="form-group">
        <label class="form-label">Notes</label>
        <input class="form-input" id="doc-notes" placeholder="Optional notes about this document">
      </div>
    `,
    onConfirm: async (modal) => {
      const file = qs('#doc-file', modal)?.files?.[0];
      if (!file) throw new Error('Please select a file');
      const docType = qs('#doc-type', modal)?.value;
      const notes = qs('#doc-notes', modal)?.value?.trim()||null;

      // Upload to Supabase storage
      const path = `acquisitions/${deal.id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/cfm-documents/${path}`, {
        method: 'POST',
        headers: {
          'apikey': window.__CFM_ANON_KEY,
          'Authorization': `Bearer ${session?.access_token}`,
          'Content-Type': file.type,
          'x-upsert': 'true',
        },
        body: file,
      });
      if (!uploadRes.ok) throw new Error('Upload failed: ' + await uploadRes.text());

      const fileUrl = `${SUPABASE_URL}/storage/v1/object/public/cfm-documents/${path}`;
      await dbInsert('acquisition_documents', {
        deal_id: deal.id,
        doc_type: docType,
        filename: file.name,
        file_url: fileUrl,
        notes,
        uploaded_by: session?.user?.email||null,
      });
      toast('Document uploaded', 'success');
    },
  });
}

// ── Activity modal ────────────────────────────────────────────
function _activityModal(deal, container) {
  const session = getSession();
  openModal({
    title: 'Log activity',
    confirmLabel: 'Save',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Type</label>
          <select class="form-select" id="act-type">
            ${ACTIVITY_TYPES.map(t => `<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" id="act-date" type="date" value="${new Date().toISOString().slice(0,10)}">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Summary</label>
        <input class="form-input" id="act-summary" placeholder="Brief summary…">
      </div>
      <div class="form-group">
        <label class="form-label">Detail</label>
        <textarea class="form-textarea" id="act-detail" rows="3" placeholder="Full notes…"></textarea>
      </div>
    `,
    onConfirm: async (modal) => {
      const row = {
        deal_id: deal.id,
        activity_type: qs('#act-type', modal)?.value,
        activity_date: qs('#act-date', modal)?.value||null,
        summary: qs('#act-summary', modal)?.value?.trim()||null,
        detail: qs('#act-detail', modal)?.value?.trim()||null,
        created_by: session?.user?.email||null,
      };
      if (!row.summary) throw new Error('Please enter a summary');
      await dbInsert('acquisition_activities', row);
      toast('Activity logged', 'success');
      // Refresh deal view
      _openDeal(deal, container);
    },
  });
}

// ── Export CSV ────────────────────────────────────────────────
function _exportCSV() {
  const headers = ['Property','Location','Region','Lead Agent','Agency','Agent Email','Agent Phone','Price Min','Price Max','Status','CFM Status','Date Created','Farm Prospects','CFM Notes'];
  const rows = _deals.map(d => [
    d.property_name, d.location, d.region, d.lead_agent, d.agency,
    d.agent_email, d.agent_phone, d.price_min, d.price_max,
    d.status, d.cfm_management_status,
    d.date_created, d.farm_prospects, d.cfm_notes
  ].map(v => v ? '"'+String(v).replace(/"/g,'""')+'"' : '""'));

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `CFM_Acquisitions_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Exported to CSV', 'success');
}