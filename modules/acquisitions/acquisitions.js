// modules/acquisitions/acquisitions.js
import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getSession, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatCurrency, formatDate, qs } from '../../js/ui.js';

const SUPABASE_URL = 'https://nqvfuqvindsgnogejaei.supabase.co';

let _deals = [];
let _agents = [];
let _moduleUsers = [];
let _activeTab = 'pipeline';
let _filterStatus = '';
let _filterMgmt = '';
let _filterServices = '';
let _showArchived = false;
let _searchTerm = '';
let _activeDeal = null;

const STATUSES = ['Reviewing', 'Interested', 'Engaged', 'Sold'];
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
      <button class="tab-btn ${_activeTab==='sold'?'active':''}" data-tab="sold">Passed / Sold</button>
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
  let _users = [];
  [_deals, _agents, _users] = await Promise.all([
    dbSelect('acquisition_deals', 'select=*&order=date_created.desc'),
    dbSelect('acquisition_agents', 'select=*&order=name.asc').catch(() => []),
    dbSelect('user_profiles', 'select=id,full_name,role&is_active=eq.true&order=full_name.asc').catch(() => []),
  ]);
  // Store users at module level for access in modals
  _moduleUsers = _users;
}

function _renderTab(container) {
  const content = qs('#acq-content', container);
  if (_activeTab === 'pipeline') _renderPipeline(content, container);
  else if (_activeTab === 'sold') _renderSold(content, container);
  else _renderList(content, container);
}

// ── Pipeline (kanban-style) ───────────────────────────────────
function _renderPipeline(content, container) {
  const activeStatuses = STATUSES.filter(s => s !== 'Passed' && s !== 'Sold');

  content.innerHTML = `
    <!-- Summary strip -->
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px">
      ${[
        ['Total deals', _deals.length, 'var(--ink)'],
        ['Active', _deals.filter(d=>d.status !== 'Sold').length, 'var(--blue)'],
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
              ${(d.assigned_users||[]).length ? `<div style="display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px">${(d.assigned_users||[]).map(u=>'<span style="font-size:9px;padding:1px 5px;border-radius:8px;background:#ede9fe;color:#5b21b6">'+u+'</span>').join('')}</div>` : ''}
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
                ${d.cfm_management_status ? `<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:${(MGMT_COLOURS[d.cfm_management_status]||{}).bg||'#f3f4f6'};color:${(MGMT_COLOURS[d.cfm_management_status]||{}).color||'#374151'}">${d.cfm_management_status}</span>` : '<span></span>'}
                <div style="position:relative;display:inline-block">
                  <button class="quick-status-btn btn btn-ghost" data-id="${d.id}" style="padding:2px 6px;font-size:14px;line-height:1;color:var(--hint)" title="Change status">⋯</button>
                  <div class="quick-status-menu" data-id="${d.id}" style="display:none;position:absolute;right:0;top:100%;background:white;border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.12);z-index:100;min-width:140px;padding:4px 0">
                    ${STATUSES.map(s => s !== d.status ? `<button class="quick-status-opt" data-id="${d.id}" data-status="${s}" style="display:block;width:100%;text-align:left;padding:6px 12px;border:none;background:none;cursor:pointer;font-size:12px;color:var(--ink)">${s}</button>` : '').join('')}
                  </div>
                </div>
              </div>
            </div>
          `).join('')}
        </div>`;
      }).join('')}
    </div>

    <!-- Passed/Sold moved to own tab -->
    <p style="font-size:11px;color:var(--hint);margin-top:12px;text-align:right">Passed & Sold deals are in the <strong>Passed / Sold</strong> tab</p>
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

// ── Sold / Passed tab ────────────────────────────────────────
function _renderSold(content, container) {
  const archived = _deals.filter(d => ['Passed','Sold'].includes(d.status));

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
      ${['Passed','Sold'].map(status => {
        const deals = archived.filter(d => d.status === status);
        const sc = STATUS_COLOURS[status] || {};
        return `<div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
            <span style="padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600;background:${sc.bg};color:${sc.color}">${status}</span>
            <span style="font-size:12px;color:var(--hint)">${deals.length} deal${deals.length!==1?'s':''}</span>
          </div>
          ${deals.length ? deals.map(d => `
            <div class="deal-card card" data-id="${d.id}" style="padding:12px;margin-bottom:8px;cursor:pointer">
              <p style="font-size:13px;font-weight:600;margin-bottom:4px">${d.property_name}</p>
              ${d.location ? `<p style="font-size:11px;color:var(--hint);margin-bottom:3px">📍 ${d.location}${d.region?' · '+d.region:''}</p>` : ''}
              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px">
                <span style="font-size:12px;font-weight:500;color:var(--blue)">${d.price_min?'$'+Number(d.price_min).toLocaleString()+(d.price_max?' – $'+Number(d.price_max).toLocaleString():''):'—'}</span>
                <span style="font-size:11px;color:var(--hint)">${d.lead_agent||''} ${d.agency?'· '+d.agency:''}</span>
              </div>
              ${d.cfm_management_status ? `<div style="margin-top:6px"><span style="font-size:10px;padding:1px 7px;border-radius:8px;background:${(MGMT_COLOURS[d.cfm_management_status]||{}).bg||'#f3f4f6'};color:${(MGMT_COLOURS[d.cfm_management_status]||{}).color||'#374151'}">${d.cfm_management_status}</span></div>` : ''}
            </div>`).join('') : `<p style="font-size:12px;color:var(--hint);padding:16px 0">No ${status.toLowerCase()} deals.</p>`}
        </div>`;
      }).join('')}
    </div>
  `;

  content.querySelectorAll('.deal-card').forEach(card => {
    card.addEventListener('click', () => {
      const deal = _deals.find(d => d.id === card.dataset.id);
      if (deal) _openDeal(deal, container);
    });
  });
}

// ── List view ─────────────────────────────────────────────────
function _renderList(content, container) {
  let deals = _deals.filter(d => d.status !== 'Sold');
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
const STAMP_DUTY_RATES = { NSW:0.055, VIC:0.055, QLD:0.0575, SA:0.055, WA:0.0515, TAS:0.045, NT:0.00, ACT:0.05 };

async function _openDeal(deal, container) {
  _activeDeal = deal;
  const session = getSession();

  // Log view
  if (session?.user) {
    dbInsert('acquisition_views', {
      deal_id: deal.id,
      user_id: session.user.id,
      user_name: session.profile?.full_name || session.user.email,
      user_email: session.user.email,
    }).catch(() => {});
  }

  // Load all data
  const [docs, activities, views, finRows] = await Promise.all([
    dbSelect('acquisition_documents', 'deal_id=eq.' + deal.id + '&select=*&order=uploaded_at.desc'),
    dbSelect('acquisition_activities', 'deal_id=eq.' + deal.id + '&select=*&order=activity_date.desc,created_at.desc'),
    dbSelect('acquisition_views', 'deal_id=eq.' + deal.id + '&select=*&order=viewed_at.desc&limit=50'),
    dbSelect('acquisition_financials', 'deal_id=eq.' + deal.id + '&select=*').catch(() => []),
  ]);

  let fin = finRows?.[0] || {
    land_components:[], water_assets:[], other_assets:[],
    development_land:[], development_water:[], development_other:[],
    state: deal.location?.match(/\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/)?.[1] || 'NSW',
  };
  fin.stamp_duty_rate = fin.stamp_duty_rate ?? STAMP_DUTY_RATES[fin.state] ?? 0.055;

  const sc = STATUS_COLOURS[deal.status] || STATUS_COLOURS['Reviewing'];
  const mc = MGMT_COLOURS[deal.cfm_management_status] || {};

  openModal({
    title: deal.property_name,
    wide: true,
    confirmLabel: 'Edit deal',
    confirmClass: 'btn-secondary',
    onConfirm: () => _dealModal(container, deal),
    bodyHTML: `
      <!-- Deal tabs -->
      <div style="display:flex;gap:0;border-bottom:2px solid var(--border);margin-bottom:16px">
        <button class="dtab active" data-tab="overview" style="padding:8px 18px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:600;border-bottom:2px solid var(--blue);color:var(--blue);margin-bottom:-2px">Overview</button>
        <button class="dtab" data-tab="financials" style="padding:8px 18px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:400;color:var(--hint);border-bottom:2px solid transparent;margin-bottom:-2px">Financials</button>
        <button class="dtab" data-tab="activity" style="padding:8px 18px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:400;color:var(--hint);border-bottom:2px solid transparent;margin-bottom:-2px">Activity</button>
      </div>

      <!-- Overview tab -->
      <div id="dtab-overview">
        <!-- Status badges -->
        <div class="flex gap-2" style="margin-bottom:14px;flex-wrap:wrap">
          <span style="padding:3px 10px;border-radius:10px;font-size:12px;font-weight:500;background:${sc.bg};color:${sc.color}">${deal.status||'Reviewing'}</span>
          <span style="padding:3px 10px;border-radius:10px;font-size:12px;background:${mc.bg||'#f3f4f6'};color:${mc.color||'#374151'}">${deal.cfm_management_status||'—'}</span>
          ${deal.price_min ? `<span style="padding:3px 10px;border-radius:10px;font-size:12px;font-weight:600;background:#dbeafe;color:#1e40af">$${Number(deal.price_min).toLocaleString()}${deal.price_max?' – $'+Number(deal.price_max).toLocaleString():''}</span>` : ''}
          ${(deal.assigned_users||[]).map(u=>`<span style="font-size:11px;padding:2px 10px;border-radius:10px;background:#ede9fe;color:#5b21b6;font-weight:500">${u}</span>`).join('')}
        </div>

        <!-- Financial summary strip -->
        ${finRows?.[0] ? (() => {
          const f = finRows[0];
          const landT = (f.land_components||[]).reduce((s,c)=>s+(parseFloat(c.area)||0)*(parseFloat(c.rate)||0),0);
          const waterT = (f.water_assets||[]).reduce((s,w)=>s+(parseFloat(w.ml)||0)*(parseFloat(w.rate)||0),0);
          const otherT = (f.other_assets||[]).reduce((s,o)=>s+(parseFloat(o.value)||0),0);
          const assetT = landT+waterT+otherT;
          const stamp = assetT*(parseFloat(f.stamp_duty_rate)||0);
          const totalAcq = assetT+stamp;
          const devT = (f.development_land||[]).reduce((s,d)=>s+(parseFloat(d.area)||0)*(parseFloat(d.cost_per_ha)||0),0)
                     + (f.development_water||[]).reduce((s,d)=>s+(parseFloat(d.ml)||0)*(parseFloat(d.rate)||0),0)
                     + (f.development_other||[]).reduce((s,d)=>s+(parseFloat(d.value)||0),0);
          const totalInv = totalAcq+devT;
          const askingMid = deal.price_min&&deal.price_max?(deal.price_min+deal.price_max)/2:(deal.price_min||0);
          const vsAsking = askingMid&&totalAcq ? ((totalAcq-askingMid)/askingMid*100) : null;
          const fmt = v => v>=1000000?'$'+(v/1000000).toFixed(1)+'m':v>=1000?'$'+(v/1000).toFixed(0)+'k':'$'+Math.round(v).toLocaleString();
          const cell = (label,val,color,bold) => `<div style="display:flex;flex-direction:column;padding:0 12px;border-right:1px solid var(--border-light)"><span style="font-size:10px;color:var(--hint);margin-bottom:3px;white-space:nowrap">${label}</span><span style="font-size:${bold?'15':'13'}px;font-weight:${bold?'700':'500'};color:${color};font-variant-numeric:tabular-nums;white-space:nowrap">${val}</span></div>`;
          return `<div style="display:flex;flex-wrap:wrap;gap:0;margin-bottom:16px;padding:10px 2px;background:#f8fafc;border-radius:8px;border:1px solid var(--border-light);overflow:hidden">
            ${landT ? cell('Land',fmt(landT),'var(--ink)',false) : ''}
            ${waterT ? cell('Water',fmt(waterT),'var(--ink)',false) : ''}
            ${otherT ? cell('Other assets',fmt(otherT),'var(--ink)',false) : ''}
            ${totalAcq ? cell('CFM acq. value',fmt(totalAcq),'var(--blue)',true) : ''}
            ${devT ? cell('+ Dev capex',fmt(devT),'#b45309',false) : ''}
            ${devT ? cell('Total invested',fmt(totalInv),'var(--blue)',true) : ''}
            ${vsAsking!==null ? cell('vs asking',(vsAsking>=0?'+':'')+vsAsking.toFixed(1)+'%',vsAsking>=0?'#065f46':'#991b1b',false) : ''}
          </div>`;
        })() : ''}

        <!-- Two columns: left=key details + documents, right=assessments -->
        <div style="display:grid;grid-template-columns:42% 1fr;gap:24px;margin-bottom:16px">
          <!-- Left -->
          <div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
              ${[['Location',deal.location],['Region',deal.region],['Lead agent',deal.lead_agent],['Agency',deal.agency],['Agent email',deal.agent_email],['Agent phone',deal.agent_phone],['Date created',deal.date_created?formatDate(deal.date_created):null]]
                .filter(([,v])=>v).map(([l,v])=>`<div><p style="font-size:10px;color:var(--hint);margin-bottom:2px">${l}</p><p style="font-size:13px;font-weight:500">${v}</p></div>`).join('')}
            </div>
            <!-- Documents -->
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600">Documents</p>
              <button class="btn btn-ghost btn-sm" id="btn-add-doc">＋ Upload</button>
            </div>
            ${docs.length ? `<div style="display:flex;flex-direction:column;gap:4px">
              ${docs.map(doc=>`<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--page-bg);border-radius:6px;border:1px solid var(--border-light)">
                <span style="font-size:20px">${doc.doc_type==='IM'?'📄':doc.doc_type==='Farm Model'?'📊':'📎'}</span>
                <div style="flex:1;min-width:0"><p style="font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${doc.filename}</p>
                <p style="font-size:10px;color:var(--hint)">${doc.doc_type} · ${doc.uploaded_at?formatDate(doc.uploaded_at):''}</p></div>
                ${doc.file_url?`<a href="${doc.file_url}" target="_blank" class="btn btn-ghost btn-sm">⬇ Open</a>`:''}
              </div>`).join('')}
            </div>` : `<p style="font-size:12px;color:var(--hint)">No documents yet.</p>`}
          </div>

          <!-- Right: assessments -->
          <div style="min-width:0">
            ${deal.land_cropping_assessment||deal.farm_prospects ? `<div style="margin-bottom:12px">
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;margin-bottom:5px">Land / Cropping assessment</p>
              <div style="background:var(--page-bg);border-radius:6px;padding:12px 14px;font-size:12px;line-height:1.6;border-left:3px solid #22c55e;word-wrap:break-word">${deal.land_cropping_assessment||deal.farm_prospects}</div>
            </div>` : ''}
            ${deal.water_assessment||deal.cfm_notes ? `<div style="margin-bottom:12px">
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;margin-bottom:5px">Water assessment</p>
              <div style="background:#eff6ff;border-radius:6px;padding:12px 14px;font-size:12px;line-height:1.6;border-left:3px solid var(--blue);word-wrap:break-word">${deal.water_assessment||deal.cfm_notes}</div>
            </div>` : ''}
            ${deal.development_potential ? `<div style="margin-bottom:12px">
              <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;margin-bottom:5px">Development potential</p>
              <div style="background:#f0fdf4;border-radius:6px;padding:12px 14px;font-size:12px;line-height:1.6;border-left:3px solid #16a34a;word-wrap:break-word">${deal.development_potential}</div>
            </div>` : ''}
          </div>
        </div>

        <!-- Viewed by — full width at bottom -->
        <div style="border-top:1px solid var(--border-light);padding-top:12px">
          <p style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;margin-bottom:8px">Viewed by (${views.length})</p>
          ${views.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">
            ${[...new Map(views.map(v=>[v.user_name||v.user_email,v])).values()].map(v=>`<div style="display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--page-bg);border-radius:20px;font-size:11px">
              <span style="font-weight:500">${v.user_name||v.user_email||'Unknown'}</span>
              <span style="color:var(--hint)">${v.viewed_at?new Date(v.viewed_at).toLocaleDateString('en-AU',{day:'numeric',month:'short'}):''}</span>
            </div>`).join('')}
          </div>` : `<p style="font-size:11px;color:var(--hint)">No views recorded.</p>`}
        </div>
      </div>
      <!-- Financials tab -->
      <div id="dtab-financials" style="display:none">
        ${_buildFinancialsHTML(fin)}
      </div>

      <!-- Activity tab -->
      <div id="dtab-activity" style="display:none">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div>
            <p style="font-size:13px;font-weight:600;margin-bottom:4px">Activity log</p>
            <p style="font-size:11px;color:var(--hint);margin-bottom:10px">Auto-generated on each save</p>
            ${activities.length ? `<div style="display:flex;flex-direction:column;gap:6px;max-height:400px;overflow-y:auto">
              ${activities.map(a=>`<div style="padding:8px 10px;background:var(--page-bg);border-radius:6px;border-left:3px solid var(--blue)">
                <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                  <span style="font-size:11px;font-weight:600;color:var(--blue)">${a.activity_type}</span>
                  <span style="font-size:10px;color:var(--hint)">${a.activity_date?formatDate(a.activity_date):''} · ${a.created_by||''}</span>
                </div>
                <p style="font-size:12px">${a.summary||''}</p>
              </div>`).join('')}
            </div>` : `<p style="font-size:12px;color:var(--hint)">No activity yet.</p>`}
          </div>
          <div>
            <p style="font-size:13px;font-weight:600;margin-bottom:10px">Viewed by (${views.length})</p>
            ${views.length ? `<div style="display:flex;flex-direction:column;gap:3px;max-height:400px;overflow-y:auto">
              ${views.map(v=>`<div style="display:flex;justify-content:space-between;font-size:11px;padding:4px 0;border-bottom:0.5px solid var(--border-light)">
                <span style="font-weight:500">${v.user_name||v.user_email||'Unknown'}</span>
                <span style="color:var(--hint)">${v.viewed_at?new Date(v.viewed_at).toLocaleDateString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):''}</span>
              </div>`).join('')}
            </div>` : `<p style="font-size:11px;color:var(--hint)">No views recorded.</p>`}
          </div>
        </div>
      </div>
    `,
  });

  setTimeout(() => {
    // Tab switching
    document.querySelectorAll('.dtab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.dtab').forEach(b => {
          b.style.borderBottom = b.dataset.tab === btn.dataset.tab ? '2px solid var(--blue)' : '2px solid transparent';
          b.style.color = b.dataset.tab === btn.dataset.tab ? 'var(--blue)' : 'var(--hint)';
          b.style.fontWeight = b.dataset.tab === btn.dataset.tab ? '600' : '400';
          b.classList.toggle('active', b.dataset.tab === btn.dataset.tab);
        });
        ['overview','financials','activity'].forEach(t => {
          const el = document.getElementById('dtab-' + t);
          if (el) el.style.display = t === btn.dataset.tab ? '' : 'none';
        });
        if (btn.dataset.tab === 'financials') _wireFinancials(deal, fin);
      });
    });

    // Overview buttons
    document.getElementById('btn-add-doc')?.addEventListener('click', () => _docModal(deal));

    // Wire financials if already on that tab
    if (document.getElementById('dtab-financials')?.style.display !== 'none') {
      _wireFinancials(deal, fin);
    }
  }, 200);
}



// ── Financials tab ────────────────────────────────────────────
function _buildFinancialsHTML(fin) {
  const fmt = v => v ? '$' + Math.round(v).toLocaleString() : '—';
  const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;font-size:12px;background:white;width:100%';
  const secHead = 'font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;margin:14px 0 6px';
  const rowS = 'display:flex;justify-content:space-between;padding:5px 0;border-bottom:0.5px solid var(--border-light);font-size:13px';

  const landTotal = (fin.land_components||[]).reduce((s,c)=>s+(parseFloat(c.area)||0)*(parseFloat(c.rate)||0),0);
  const waterTotal = (fin.water_assets||[]).reduce((s,w)=>s+(parseFloat(w.ml)||0)*(parseFloat(w.rate)||0),0);
  const otherTotal = (fin.other_assets||[]).reduce((s,o)=>s+(parseFloat(o.value)||0),0);
  const assetTotal = landTotal + waterTotal + otherTotal;
  const stampDuty = assetTotal * (parseFloat(fin.stamp_duty_rate)||0);
  const totalAcq = assetTotal + stampDuty;
  const devLandCost = (fin.development_land||[]).reduce((s,d)=>s+(parseFloat(d.area)||0)*(parseFloat(d.cost_per_ha)||0),0);
  const devWaterCost = (fin.development_water||[]).reduce((s,d)=>s+(parseFloat(d.ml)||0)*(parseFloat(d.rate)||0),0);
  const devOtherCost = (fin.development_other||[]).reduce((s,d)=>s+(parseFloat(d.value)||0),0);
  const totalDev = devLandCost + devWaterCost + devOtherCost;
  const totalInvested = totalAcq + totalDev;

  const mkLandRow = (c={}) => `<div class="fin-land-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 24px;gap:6px;margin-bottom:5px;align-items:center">
    <input class="fin-l-desc" style="${inS}" placeholder="e.g. Flood irrigation" value="${c.description||''}">
    <input class="fin-l-area num" type="number" step="0.1" style="${inS};text-align:right" placeholder="ha" value="${c.area||''}">
    <input class="fin-l-rate num" type="number" step="100" style="${inS};text-align:right" placeholder="$/ha" value="${c.rate||''}">
    <span class="fin-l-total" style="font-size:12px;font-weight:600;color:var(--blue);text-align:right">${c.area&&c.rate?'$'+Math.round(c.area*c.rate).toLocaleString():'—'}</span>
    <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="land">✕</button>
  </div>`;

  const mkWaterRow = (w={}) => `<div class="fin-water-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 24px;gap:6px;margin-bottom:5px;align-items:center">
    <input class="fin-w-desc" style="${inS}" placeholder="e.g. Murrumbidgee Gen Security" value="${w.description||''}">
    <input class="fin-w-ml num" type="number" step="1" style="${inS};text-align:right" placeholder="ML" value="${w.ml||''}">
    <input class="fin-w-rate num" type="number" step="10" style="${inS};text-align:right" placeholder="$/ML" value="${w.rate||''}">
    <span class="fin-w-total" style="font-size:12px;font-weight:600;color:var(--blue);text-align:right">${w.ml&&w.rate?'$'+Math.round(w.ml*w.rate).toLocaleString():'—'}</span>
    <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="water">✕</button>
  </div>`;

  const mkOtherRow = (o={}) => `<div class="fin-other-row" style="display:grid;grid-template-columns:2fr 1fr 24px;gap:6px;margin-bottom:5px;align-items:center">
    <input class="fin-o-desc" style="${inS}" placeholder="e.g. Infrastructure, Machinery" value="${o.description||''}">
    <input class="fin-o-val num" type="number" step="10000" style="${inS};text-align:right" placeholder="$" value="${o.value||''}">
    <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="other">✕</button>
  </div>`;

  const mkDevLandRow = (d={}, comps=[]) => {
    const opts = comps.map(c=>`<option value="${c}" ${d.from_type===c?'selected':''}>${c}</option>`).join('');
    const opts2 = comps.map(c=>`<option value="${c}" ${d.to_type===c?'selected':''}>${c}</option>`).join('') + `<option value="New type" ${d.to_type==='New type'?'selected':''}>New type…</option>`;
    return `<div class="fin-dev-land-row" style="display:grid;grid-template-columns:1.2fr 1.2fr 0.8fr 0.8fr 80px 24px;gap:5px;margin-bottom:5px;align-items:center">
      <select class="fin-dl-from" style="${inS}"><option value="">From…</option>${opts}</select>
      <select class="fin-dl-to" style="${inS}"><option value="">To…</option>${opts2}</select>
      <input class="fin-dl-area num" type="number" step="0.1" style="${inS};text-align:right" placeholder="ha" value="${d.area||''}">
      <input class="fin-dl-cost num" type="number" step="100" style="${inS};text-align:right" placeholder="$/ha" value="${d.cost_per_ha||''}">
      <span class="fin-dl-total" style="font-size:12px;font-weight:600;color:#b45309;text-align:right">${d.area&&d.cost_per_ha?'$'+Math.round(d.area*d.cost_per_ha).toLocaleString():'—'}</span>
      <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="dev-land">✕</button>
    </div>`;
  };

  const mkDevWaterRow = (d={}) => `<div class="fin-dev-water-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 24px;gap:6px;margin-bottom:5px;align-items:center">
    <input class="fin-dw-desc" style="${inS}" placeholder="e.g. Murrumbidgee Gen Security" value="${d.description||''}">
    <input class="fin-dw-ml num" type="number" step="1" style="${inS};text-align:right" placeholder="ML" value="${d.ml||''}">
    <input class="fin-dw-rate num" type="number" step="10" style="${inS};text-align:right" placeholder="$/ML" value="${d.rate||''}">
    <span class="fin-dw-total" style="font-size:12px;font-weight:600;color:#b45309;text-align:right">${d.ml&&d.rate?'$'+Math.round(d.ml*d.rate).toLocaleString():'—'}</span>
    <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="dev-water">✕</button>
  </div>`;

  const mkDevOtherRow = (d={}) => `<div class="fin-dev-other-row" style="display:grid;grid-template-columns:2fr 1fr 24px;gap:6px;margin-bottom:5px;align-items:center">
    <input class="fin-do-desc" style="${inS}" placeholder="e.g. Irrigation infrastructure" value="${d.description||''}">
    <input class="fin-do-val num" type="number" step="10000" style="${inS};text-align:right" placeholder="$" value="${d.value||''}">
    <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="dev-other">✕</button>
  </div>`;

  const comps = (fin.land_components||[]).map(c=>c.description).filter(Boolean);

  return `<div style="display:grid;grid-template-columns:1fr 300px;gap:20px">
    <!-- Left inputs -->
    <div style="overflow-y:auto;max-height:600px;padding-right:8px">
      <!-- State & stamp duty -->
      <div style="display:flex;gap:10px;align-items:flex-end;padding:10px 12px;background:var(--page-bg);border-radius:6px;margin-bottom:4px">
        <div><label style="font-size:11px;color:var(--hint);display:block;margin-bottom:3px">State</label>
          <select class="form-select fin-state" style="width:90px">
            ${['NSW','VIC','QLD','SA','WA','TAS','NT','ACT'].map(s=>`<option value="${s}" ${fin.state===s?'selected':''}>${s}</option>`).join('')}
          </select></div>
        <div><label style="font-size:11px;color:var(--hint);display:block;margin-bottom:3px">Stamp duty %</label>
          <input type="number" class="form-input num fin-stamp-rate" step="0.001" style="width:80px" value="${((fin.stamp_duty_rate||0)*100).toFixed(2)}"></div>
      </div>

      <!-- Column headers for land/water -->
      <div style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 24px;gap:6px;padding:0 0 3px">
        ${['Description','Area/ML','Rate $','Total',''].map(h=>`<span style="font-size:10px;color:var(--hint);text-align:${h==='Total'?'right':''}">${h}</span>`).join('')}
      </div>

      <p style="${secHead}">Land components <button class="btn btn-ghost btn-sm fin-add" data-section="land" style="margin-left:6px;font-size:11px">＋ Add</button></p>
      <div id="fin-land-rows">${(fin.land_components||[]).map(c=>mkLandRow(c)).join('')}</div>

      <p style="${secHead}">Water assets <button class="btn btn-ghost btn-sm fin-add" data-section="water" style="margin-left:6px;font-size:11px">＋ Add</button></p>
      <div id="fin-water-rows">${(fin.water_assets||[]).map(w=>mkWaterRow(w)).join('')}</div>

      <p style="${secHead}">Other assets <button class="btn btn-ghost btn-sm fin-add" data-section="other" style="margin-left:6px;font-size:11px">＋ Add</button></p>
      <div id="fin-other-rows">${(fin.other_assets||[]).map(o=>mkOtherRow(o)).join('')}</div>

      <div style="border-top:2px solid var(--border);margin-top:14px;padding-top:4px">
        <p style="${secHead}">Development / Additional capex</p>
        <p style="font-size:11px;font-weight:600;color:var(--hint);margin-bottom:5px">Land conversions <button class="btn btn-ghost btn-sm fin-add" data-section="dev-land" style="margin-left:6px;font-size:11px">＋ Add</button></p>
        <div style="display:grid;grid-template-columns:1.2fr 1.2fr 0.8fr 0.8fr 80px 24px;gap:5px;padding:0 0 3px">
          ${['From type','To type','Area ha','Cost $/ha','Total',''].map(h=>`<span style="font-size:10px;color:var(--hint)">${h}</span>`).join('')}
        </div>
        <div id="fin-dev-land-rows">${(fin.development_land||[]).map(d=>mkDevLandRow(d,comps)).join('')}</div>

        <p style="font-size:11px;font-weight:600;color:var(--hint);margin:10px 0 5px">Water purchases <button class="btn btn-ghost btn-sm fin-add" data-section="dev-water" style="margin-left:6px;font-size:11px">＋ Add</button></p>
        <div id="fin-dev-water-rows">${(fin.development_water||[]).map(d=>mkDevWaterRow(d)).join('')}</div>

        <p style="font-size:11px;font-weight:600;color:var(--hint);margin:10px 0 5px">Other capex <button class="btn btn-ghost btn-sm fin-add" data-section="dev-other" style="margin-left:6px;font-size:11px">＋ Add</button></p>
        <div id="fin-dev-other-rows">${(fin.development_other||[]).map(d=>mkDevOtherRow(d)).join('')}</div>
      </div>
    </div>

    <!-- Right summary -->
    <div>
      <div style="background:var(--page-bg);border-radius:8px;padding:16px;position:sticky;top:0">
        <p style="font-size:13px;font-weight:700;margin-bottom:12px">Acquisition value</p>
        <div style="${rowS}"><span style="color:var(--hint)">Land</span><span id="fin-s-land">${fmt(landTotal)}</span></div>
        <div style="${rowS}"><span style="color:var(--hint)">Water</span><span id="fin-s-water">${fmt(waterTotal)}</span></div>
        <div style="${rowS}"><span style="color:var(--hint)">Other assets</span><span id="fin-s-other">${fmt(otherTotal)}</span></div>
        <div style="${rowS};font-weight:600"><span>Asset total</span><span id="fin-s-assets">${fmt(assetTotal)}</span></div>
        <div style="${rowS}"><span style="color:var(--hint)">Stamp duty</span><span id="fin-s-stamp">${fmt(stampDuty)}</span></div>
        <div style="${rowS};font-weight:700;font-size:14px"><span>Total acq. cost</span><span id="fin-s-total" style="color:var(--blue)">${fmt(totalAcq)}</span></div>

        <p style="font-size:13px;font-weight:700;margin:14px 0 10px">Development capex</p>
        <div style="${rowS}"><span style="color:var(--hint)">Land conversions</span><span id="fin-s-dev-land">${fmt(devLandCost)}</span></div>
        <div style="${rowS}"><span style="color:var(--hint)">Water purchases</span><span id="fin-s-dev-water">${fmt(devWaterCost)}</span></div>
        <div style="${rowS}"><span style="color:var(--hint)">Other capex</span><span id="fin-s-dev-other">${fmt(devOtherCost)}</span></div>
        <div style="${rowS};font-weight:600"><span>Total capex</span><span id="fin-s-dev-total">${fmt(totalDev)}</span></div>

        <div style="border-top:2px solid var(--border);margin-top:10px;padding-top:10px">
          <div style="${rowS};font-weight:700;font-size:14px;border-bottom:none"><span>Total invested</span><span id="fin-s-invested" style="color:var(--blue)">${fmt(totalInvested)}</span></div>
        </div>

        <button id="fin-save-btn" class="btn btn-primary" style="width:100%;margin-top:14px">Save financials</button>
      </div>
    </div>
  </div>`;
}

function _wireFinancials(deal, fin) {
  const tab = document.getElementById('dtab-financials');
  if (!tab || tab.dataset.wired) return;
  tab.dataset.wired = '1';

  function collectFin() {
    return {
      land_components: [...tab.querySelectorAll('.fin-land-row')].map(r=>({
        description: r.querySelector('.fin-l-desc')?.value||'',
        area: parseFloat(r.querySelector('.fin-l-area')?.value)||0,
        rate: parseFloat(r.querySelector('.fin-l-rate')?.value)||0,
      })).filter(c=>c.description||c.area),
      water_assets: [...tab.querySelectorAll('.fin-water-row')].map(r=>({
        description: r.querySelector('.fin-w-desc')?.value||'',
        ml: parseFloat(r.querySelector('.fin-w-ml')?.value)||0,
        rate: parseFloat(r.querySelector('.fin-w-rate')?.value)||0,
      })).filter(w=>w.description||w.ml),
      other_assets: [...tab.querySelectorAll('.fin-other-row')].map(r=>({
        description: r.querySelector('.fin-o-desc')?.value||'',
        value: parseFloat(r.querySelector('.fin-o-val')?.value)||0,
      })).filter(o=>o.description||o.value),
      development_land: [...tab.querySelectorAll('.fin-dev-land-row')].map(r=>({
        from_type: r.querySelector('.fin-dl-from')?.value||'',
        to_type: r.querySelector('.fin-dl-to')?.value||'',
        area: parseFloat(r.querySelector('.fin-dl-area')?.value)||0,
        cost_per_ha: parseFloat(r.querySelector('.fin-dl-cost')?.value)||0,
      })).filter(d=>d.area),
      development_water: [...tab.querySelectorAll('.fin-dev-water-row')].map(r=>({
        description: r.querySelector('.fin-dw-desc')?.value||'',
        ml: parseFloat(r.querySelector('.fin-dw-ml')?.value)||0,
        rate: parseFloat(r.querySelector('.fin-dw-rate')?.value)||0,
      })).filter(d=>d.ml),
      development_other: [...tab.querySelectorAll('.fin-dev-other-row')].map(r=>({
        description: r.querySelector('.fin-do-desc')?.value||'',
        value: parseFloat(r.querySelector('.fin-do-val')?.value)||0,
      })).filter(d=>d.value),
      state: tab.querySelector('.fin-state')?.value||'NSW',
      stamp_duty_rate: (parseFloat(tab.querySelector('.fin-stamp-rate')?.value)||0)/100,
    };
  }

  function recalc() {
    const f = collectFin();
    const lT = f.land_components.reduce((s,c)=>s+c.area*c.rate,0);
    const wT = f.water_assets.reduce((s,w)=>s+w.ml*w.rate,0);
    const oT = f.other_assets.reduce((s,o)=>s+o.value,0);
    const aT = lT+wT+oT;
    const sd = aT*f.stamp_duty_rate;
    const tA = aT+sd;
    const dL = f.development_land.reduce((s,d)=>s+d.area*d.cost_per_ha,0);
    const dW = f.development_water.reduce((s,d)=>s+d.ml*d.rate,0);
    const dO = f.development_other.reduce((s,d)=>s+d.value,0);
    const tD = dL+dW+dO;
    const tI = tA+tD;
    const fmt = v => v ? '$'+Math.round(v).toLocaleString() : '—';
    const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=fmt(v); };
    set('fin-s-land',lT); set('fin-s-water',wT); set('fin-s-other',oT);
    set('fin-s-assets',aT); set('fin-s-stamp',sd); set('fin-s-total',tA);
    set('fin-s-dev-land',dL); set('fin-s-dev-water',dW); set('fin-s-dev-other',dO);
    set('fin-s-dev-total',tD); set('fin-s-invested',tI);
    // Row totals
    tab.querySelectorAll('.fin-land-row').forEach(r=>{
      const a=parseFloat(r.querySelector('.fin-l-area')?.value)||0, rt=parseFloat(r.querySelector('.fin-l-rate')?.value)||0;
      const el=r.querySelector('.fin-l-total'); if(el) el.textContent=a&&rt?'$'+Math.round(a*rt).toLocaleString():'—';
    });
    tab.querySelectorAll('.fin-water-row').forEach(r=>{
      const m=parseFloat(r.querySelector('.fin-w-ml')?.value)||0, rt=parseFloat(r.querySelector('.fin-w-rate')?.value)||0;
      const el=r.querySelector('.fin-w-total'); if(el) el.textContent=m&&rt?'$'+Math.round(m*rt).toLocaleString():'—';
    });
    tab.querySelectorAll('.fin-dev-land-row').forEach(r=>{
      const a=parseFloat(r.querySelector('.fin-dl-area')?.value)||0, c=parseFloat(r.querySelector('.fin-dl-cost')?.value)||0;
      const el=r.querySelector('.fin-dl-total'); if(el) el.textContent=a&&c?'$'+Math.round(a*c).toLocaleString():'—';
    });
    tab.querySelectorAll('.fin-dev-water-row').forEach(r=>{
      const m=parseFloat(r.querySelector('.fin-dw-ml')?.value)||0, rt=parseFloat(r.querySelector('.fin-dw-rate')?.value)||0;
      const el=r.querySelector('.fin-dw-total'); if(el) el.textContent=m&&rt?'$'+Math.round(m*rt).toLocaleString():'—';
    });
  }

  tab.addEventListener('input', recalc);

  // State → auto stamp duty
  tab.querySelector('.fin-state')?.addEventListener('change', e => {
    const r = STAMP_DUTY_RATES[e.target.value] ?? 0.055;
    const el = tab.querySelector('.fin-stamp-rate');
    if (el) el.value = (r*100).toFixed(2);
    recalc();
  });

  // Add row buttons
  const mkLandRow = () => {
    const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;font-size:12px;background:white;width:100%';
    return `<div class="fin-land-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 24px;gap:6px;margin-bottom:5px;align-items:center">
      <input class="fin-l-desc" style="${inS}" placeholder="e.g. Flood irrigation" value="">
      <input class="fin-l-area num" type="number" step="0.1" style="${inS};text-align:right" placeholder="ha" value="">
      <input class="fin-l-rate num" type="number" step="100" style="${inS};text-align:right" placeholder="$/ha" value="">
      <span class="fin-l-total" style="font-size:12px;font-weight:600;color:var(--blue);text-align:right">—</span>
      <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="land">✕</button>
    </div>`;
  };
  const mkWaterRow = () => {
    const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;font-size:12px;background:white;width:100%';
    return `<div class="fin-water-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 24px;gap:6px;margin-bottom:5px;align-items:center">
      <input class="fin-w-desc" style="${inS}" placeholder="e.g. Murrumbidgee Gen Security">
      <input class="fin-w-ml num" type="number" step="1" style="${inS};text-align:right" placeholder="ML">
      <input class="fin-w-rate num" type="number" step="10" style="${inS};text-align:right" placeholder="$/ML">
      <span class="fin-w-total" style="font-size:12px;font-weight:600;color:var(--blue);text-align:right">—</span>
      <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="water">✕</button>
    </div>`;
  };
  const mkOtherRow = () => {
    const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;font-size:12px;background:white;width:100%';
    return `<div class="fin-other-row" style="display:grid;grid-template-columns:2fr 1fr 24px;gap:6px;margin-bottom:5px;align-items:center">
      <input class="fin-o-desc" style="${inS}" placeholder="e.g. Infrastructure, Machinery">
      <input class="fin-o-val num" type="number" step="10000" style="${inS};text-align:right" placeholder="$">
      <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="other">✕</button>
    </div>`;
  };
  const mkDevLandRow = () => {
    const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;font-size:12px;background:white;width:100%';
    const comps = collectFin().land_components.map(c=>c.description).filter(Boolean);
    const opts = comps.map(c=>`<option value="${c}">${c}</option>`).join('');
    return `<div class="fin-dev-land-row" style="display:grid;grid-template-columns:1.2fr 1.2fr 0.8fr 0.8fr 80px 24px;gap:5px;margin-bottom:5px;align-items:center">
      <select class="fin-dl-from" style="${inS}"><option value="">From…</option>${opts}</select>
      <select class="fin-dl-to" style="${inS}"><option value="">To…</option>${opts}<option value="New type">New type…</option></select>
      <input class="fin-dl-area num" type="number" step="0.1" style="${inS};text-align:right" placeholder="ha">
      <input class="fin-dl-cost num" type="number" step="100" style="${inS};text-align:right" placeholder="$/ha">
      <span class="fin-dl-total" style="font-size:12px;font-weight:600;color:#b45309;text-align:right">—</span>
      <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="dev-land">✕</button>
    </div>`;
  };
  const mkDevWaterRow = () => {
    const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;font-size:12px;background:white;width:100%';
    return `<div class="fin-dev-water-row" style="display:grid;grid-template-columns:2fr 1fr 1fr 80px 24px;gap:6px;margin-bottom:5px;align-items:center">
      <input class="fin-dw-desc" style="${inS}" placeholder="e.g. Murrumbidgee Gen Security">
      <input class="fin-dw-ml num" type="number" step="1" style="${inS};text-align:right" placeholder="ML">
      <input class="fin-dw-rate num" type="number" step="10" style="${inS};text-align:right" placeholder="$/ML">
      <span class="fin-dw-total" style="font-size:12px;font-weight:600;color:#b45309;text-align:right">—</span>
      <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="dev-water">✕</button>
    </div>`;
  };
  const mkDevOtherRow = () => {
    const inS = 'border:1px solid var(--border-light);border-radius:4px;padding:3px 6px;font-size:12px;background:white;width:100%';
    return `<div class="fin-dev-other-row" style="display:grid;grid-template-columns:2fr 1fr 24px;gap:6px;margin-bottom:5px;align-items:center">
      <input class="fin-do-desc" style="${inS}" placeholder="e.g. Irrigation infrastructure">
      <input class="fin-do-val num" type="number" step="10000" style="${inS};text-align:right" placeholder="$">
      <button class="fin-del btn btn-ghost" style="color:var(--red);padding:0 4px;font-size:14px" data-section="dev-other">✕</button>
    </div>`;
  };

  tab.querySelectorAll('.fin-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.dataset.section;
      const containers = { land:'fin-land-rows', water:'fin-water-rows', other:'fin-other-rows', 'dev-land':'fin-dev-land-rows', 'dev-water':'fin-dev-water-rows', 'dev-other':'fin-dev-other-rows' };
      const makers = { land:mkLandRow, water:mkWaterRow, other:mkOtherRow, 'dev-land':mkDevLandRow, 'dev-water':mkDevWaterRow, 'dev-other':mkDevOtherRow };
      const container = document.getElementById(containers[section]);
      if (container && makers[section]) { container.insertAdjacentHTML('beforeend', makers[section]()); recalc(); }
    });
  });

  // Delete rows
  tab.addEventListener('click', e => {
    const btn = e.target.closest('.fin-del');
    if (!btn) return;
    btn.closest('[class*="fin-"][class*="-row"]')?.remove();
    recalc();
  });

  // Save
  document.getElementById('fin-save-btn')?.addEventListener('click', async () => {
    const saveBtn = document.getElementById('fin-save-btn');
    if (saveBtn) { saveBtn.disabled=true; saveBtn.textContent='Saving…'; }
    try {
      const data = { ...collectFin(), deal_id: deal.id, updated_at: new Date().toISOString() };
      if (fin.id) {
        await dbUpdate('acquisition_financials', fin.id, data);
        Object.assign(fin, data);
      } else {
        const saved = await dbInsert('acquisition_financials', data);
        Object.assign(fin, saved);
      }
      toast('Financials saved', 'success');
    } catch(err) {
      toast('Save failed: ' + err.message, 'error');
    }
    if (saveBtn) { saveBtn.disabled=false; saveBtn.textContent='Save financials'; }
  });
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
            <label class="form-label">Land / Cropping assessment</label>
            <textarea class="form-textarea" id="d-prospects" rows="3" placeholder="Soil types, cropping history, yield potential…">${existing?.land_cropping_assessment||existing?.farm_prospects||''}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Water assessment</label>
            <textarea class="form-textarea" id="d-notes" rows="3" placeholder="Water entitlements, access, quality, infrastructure…">${existing?.water_assessment||existing?.cfm_notes||''}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Development potential</label>
            <textarea class="form-textarea" id="d-dev-potential" rows="3" placeholder="Expansion opportunities, conversion potential, capex required…">${existing?.development_potential||''}</textarea>
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
          <div class="form-group">
            <label class="form-label">Assigned to (CFM team)</label>
            <div id="d-assigned-list" style="display:flex;flex-wrap:wrap;gap:6px;padding:8px;border:1px solid var(--border);border-radius:6px;min-height:40px">
              ${_moduleUsers.map(u => {
                const name = u.full_name || u.id;
                const assigned = (existing?.assigned_users||[]).includes(name);
                return `<label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer;padding:2px 8px;border-radius:10px;background:${assigned?'#ede9fe':'#f3f4f6'};color:${assigned?'#5b21b6':'#374151'}">
                  <input type="checkbox" class="assigned-user-check" value="${name}" ${assigned?'checked':''} style="display:none">
                  ${name}
                </label>`;
              }).join('')}
            </div>
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

      const assignedUsers = [...(modal.querySelectorAll('.assigned-user-check:checked') || [])].map(cb => cb.value);

      const row = {
        property_name: qs('#d-name', modal)?.value?.trim(),
        assigned_users: assignedUsers,
        last_modified_by: session?.profile?.full_name || session?.user?.email || null,
        last_modified_at: new Date().toISOString(),
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
        land_cropping_assessment: qs('#d-prospects', modal)?.value?.trim()||null,
        water_assessment: qs('#d-notes', modal)?.value?.trim()||null,
        development_potential: qs('#d-dev-potential', modal)?.value?.trim()||null,
        farm_prospects: null,
        cfm_notes: null,
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

  // Wire assigned user checkboxes
  setTimeout(() => {
    document.querySelectorAll('.assigned-user-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const label = cb.closest('label');
        if (cb.checked) {
          label.style.background = '#ede9fe';
          label.style.color = '#5b21b6';
        } else {
          label.style.background = '#f3f4f6';
          label.style.color = '#374151';
        }
      });
    });
  }, 150);

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
  const headers = ['Property','Location','Region','Lead Agent','Agency','Agent Email','Agent Phone','Price Min','Price Max','Status','CFM Status','Date Created','Land/Cropping Assessment','Water Assessment','Development Potential'];
  const rows = _deals.map(d => [
    d.property_name, d.location, d.region, d.lead_agent, d.agency,
    d.agent_email, d.agent_phone, d.price_min, d.price_max,
    d.status, d.cfm_management_status,
    d.date_created, d.land_cropping_assessment||d.farm_prospects, d.water_assessment||d.cfm_notes, d.development_potential
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