// modules/meter-readings/meter-readings.js
// Water meter readings — extraction sites and cumulative meter logs

import { dbSelect, dbInsert, dbUpdate, dbDelete } from '../../js/supabase-client.js';
import { getActiveFarm, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatNumber, formatDate, qs } from '../../js/ui.js';

let _activeTab = 'sites';
let _sites = [];
let _reads = [];
let _entitlements = [];

// ── Mount / Unmount ───────────────────────────────────────────
export async function mountMeterReadings(container) {
  const farm = getActiveFarm();
  if (!farm) {
    container.innerHTML = '<div class="empty-state"><p>No farm selected.</p></div>';
    return;
  }

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Meter Readings</h1>
        <p class="page-subtitle" style="font-size:var(--text-base);font-weight:600;color:var(--ink-mid)">${farm.name}</p>
      </div>
    </div>

    <div class="tab-strip" style="margin-bottom:16px">
      <button class="tab-btn ${_activeTab==='sites'?'active':''}" data-tab="sites">Extraction Sites</button>
      <button class="tab-btn ${_activeTab==='reads'?'active':''}" data-tab="reads">Meter Reads</button>
      <button class="tab-btn ${_activeTab==='summary'?'active':''}" data-tab="summary">Summary</button>
    </div>

    <div id="mr-tab-content"></div>
  `;

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _renderTab(container, farm);
    });
  });

  await _loadData(farm);
  _renderTab(container, farm);
}

export function unmountMeterReadings() {
  _sites = []; _reads = []; _entitlements = [];
}

// ── Data loading ──────────────────────────────────────────────
async function _loadData(farm) {
  try {
    [_sites, _reads, _entitlements] = await Promise.all([
      dbSelect('extraction_sites', 'farm_id=eq.' + farm.id + '&select=*&order=name.asc'),
      dbSelect('meter_reads', 'farm_id=eq.' + farm.id + '&select=*&order=read_date.desc'),
      dbSelect('water_entitlements', 'farm_id=eq.' + farm.id + '&select=wal_number,water_source_name,licence_category'),
    ]);
  } catch (err) {
    console.error('Meter readings load error:', err);
  }
}

function _renderTab(container, farm) {
  const content = qs('#mr-tab-content', container);
  if (!content) return;
  switch (_activeTab) {
    case 'sites':   _renderSites(content, farm); break;
    case 'reads':   _renderReads(content, farm); break;
    case 'summary': _renderSummary(content, farm); break;
  }
}

// ── Extraction Sites ──────────────────────────────────────────
function _renderSites(content, farm) {
  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <p style="font-weight:600;font-size:var(--text-sm)">Extraction Sites</p>
      ${canWrite() ? '<button class="btn btn-secondary btn-sm" id="btn-add-site">＋ Add site</button>' : ''}
    </div>
    <div class="card" style="overflow:hidden">
      ${_sites.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Site name</th>
          <th>ESID</th>
          <th>Work approval</th>
          <th>WAL</th>
          <th>Type</th>
          <th class="num">Year limit (ML)</th>
          <th class="num">Last reading</th>
          <th>Last read date</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${_sites.map(s => {
            const siteReads = _reads.filter(r => r.site_id === s.id);
            const lastRead = siteReads[0];
            return `<tr class="${s.active ? '' : 'muted'}">
              <td><strong>${s.name}</strong>${s.active ? '' : ' <span style="font-size:10px;color:var(--muted)">(inactive)</span>'}</td>
              <td class="muted">${s.esid || '—'}</td>
              <td class="muted">${s.work_approval || '—'}</td>
              <td class="muted">${s.wal_number || '—'}</td>
              <td class="muted">${_siteTypeLabel(s.site_type)}</td>
              <td class="num">${s.extraction_limit_ml_year ? formatNumber(s.extraction_limit_ml_year, 0) : 'N/A'}</td>
              <td class="num">${lastRead ? formatNumber(lastRead.reading, 3) : '—'}</td>
              <td class="muted">${lastRead ? formatDate(lastRead.read_date) : '—'}</td>
              ${canWrite() ? `<td><button class="btn btn-ghost btn-sm edit-site-btn" data-id="${s.id}">Edit</button></td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state" style="padding:30px">
        <p>No extraction sites added yet.</p>
        ${canWrite() ? '<p>Add your first bore or river pump to start recording meter readings.</p>' : ''}
      </div>`}
    </div>
  `;

  qs('#btn-add-site', content)?.addEventListener('click', () => _siteModal(content, farm));
  content.querySelectorAll('.edit-site-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const site = _sites.find(s => s.id === btn.dataset.id);
      if (site) _siteModal(content, farm, site);
    });
  });
}

function _siteTypeLabel(type) {
  const labels = { bore: 'Bore', river_pump: 'River pump', channel: 'Channel', other: 'Other' };
  return labels[type] || type || '—';
}

function _siteModal(content, farm, existing = null) {
  const walOpts = _entitlements
    .filter(e => e.wal_number)
    .map(e => `<option value="${e.wal_number}" ${e.wal_number === existing?.wal_number ? 'selected' : ''}>${e.wal_number} — ${e.water_source_name || 'Unknown'}</option>`)
    .join('');

  openModal({
    title: existing ? 'Edit extraction site' : 'Add extraction site',
    confirmLabel: existing ? 'Save changes' : 'Add site',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Site name</label>
          <input class="form-input" id="ms-name" placeholder="e.g. Merrowie D3" value="${existing?.name || ''}"></div>
        <div class="form-group"><label class="form-label">Type</label>
          <select class="form-select" id="ms-type">
            <option value="bore" ${!existing || existing?.site_type === 'bore' ? 'selected' : ''}>Bore</option>
            <option value="river_pump" ${existing?.site_type === 'river_pump' ? 'selected' : ''}>River pump</option>
            <option value="channel" ${existing?.site_type === 'channel' ? 'selected' : ''}>Channel</option>
            <option value="other" ${existing?.site_type === 'other' ? 'selected' : ''}>Other</option>
          </select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">ESID <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="ms-esid" placeholder="e.g. ESID 19105" value="${existing?.esid || ''}"></div>
        <div class="form-group"><label class="form-label">Work approval number <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="ms-work-approval" placeholder="e.g. 70CA603554" value="${existing?.work_approval || ''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Meter number <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="ms-meter-number" placeholder="e.g. M12345" value="${existing?.meter_number || ''}"></div>
        <div class="form-group"><label class="form-label">Meter units</label>
          <select class="form-select" id="ms-units">
            <option value="ML" ${!existing || existing?.meter_units === 'ML' ? 'selected' : ''}>ML (megalitres)</option>
            <option value="m3" ${existing?.meter_units === 'm3' ? 'selected' : ''}>m³ (cubic metres)</option>
          </select></div>
      </div>
      <div class="form-group"><label class="form-label">WAL</label>
        <select class="form-select" id="ms-wal">
          <option value="">— not linked —</option>${walOpts}
        </select></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Annual extraction limit (ML) <span class="text-muted">(optional — leave blank if N/A)</span></label>
          <input class="form-input num" id="ms-year-limit" type="number" step="1" value="${existing?.extraction_limit_ml_year || ''}"></div>
        <div class="form-group"><label class="form-label">Daily extraction limit (ML) <span class="text-muted">(optional)</span></label>
          <input class="form-input num" id="ms-day-limit" type="number" step="0.1" value="${existing?.extraction_limit_ml_day || ''}"></div>
      </div>
      ${existing ? `
      <div class="form-group"><label class="form-label">Status</label>
        <select class="form-select" id="ms-active">
          <option value="true" ${existing?.active !== false ? 'selected' : ''}>Active</option>
          <option value="false" ${existing?.active === false ? 'selected' : ''}>Inactive</option>
        </select></div>` : ''}
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea class="form-textarea" id="ms-notes" rows="2">${existing?.notes || ''}</textarea></div>
    `,
    onConfirm: async (modal) => {
      const row = {
        farm_id: farm.id,
        name: qs('#ms-name', modal)?.value?.trim(),
        site_type: qs('#ms-type', modal)?.value || 'bore',
        esid: qs('#ms-esid', modal)?.value?.trim() || null,
        work_approval: qs('#ms-work-approval', modal)?.value?.trim() || null,
        meter_number: qs('#ms-meter-number', modal)?.value?.trim() || null,
        wal_number: qs('#ms-wal', modal)?.value || null,
        extraction_limit_ml_day: parseFloat(qs('#ms-day-limit', modal)?.value) || null,
        extraction_limit_ml_year: parseFloat(qs('#ms-year-limit', modal)?.value) || null,
        meter_units: qs('#ms-units', modal)?.value || 'ML',
        active: existing ? qs('#ms-active', modal)?.value !== 'false' : true,
        notes: qs('#ms-notes', modal)?.value?.trim() || null,
      };
      if (!row.name) throw new Error('Site name is required');
      if (existing) {
        await dbUpdate('extraction_sites', existing.id, row);
        Object.assign(_sites.find(s => s.id === existing.id), row);
      } else {
        const saved = await dbInsert('extraction_sites', row);
        _sites.push(saved);
        _sites.sort((a, b) => a.name.localeCompare(b.name));
      }
      toast(existing ? 'Site updated' : 'Site added', 'success');
      _renderSites(content, farm);
    },
  });
}

// ── Meter Reads ───────────────────────────────────────────────
function _renderReads(content, farm) {
  const activeSites = _sites.filter(s => s.active !== false);

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <p style="font-weight:600;font-size:var(--text-sm)">Meter Reads</p>
      ${canWrite() && activeSites.length ? '<button class="btn btn-secondary btn-sm" id="btn-add-read">＋ Enter reading</button>' : ''}
    </div>
    ${!activeSites.length ? `<div class="empty-state"><p>No extraction sites yet. Add sites first.</p></div>` : `
    <div class="card" style="overflow:hidden">
      ${_reads.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Date</th>
          <th>Site</th>
          <th>WAL</th>
          <th class="num">Reading</th>
          <th class="num">Volume since last (ML)</th>
          <th>Read by</th>
          <th>Notes</th>
          ${canWrite() ? '<th></th>' : ''}
        </tr></thead>
        <tbody>
          ${_reads.map(r => {
            const site = _sites.find(s => s.id === r.site_id);
            const vol = r.volume_since_last;
            // Check if over daily limit
            const dayLimit = site?.extraction_limit_ml_day;
            const overLimit = dayLimit && vol && vol > dayLimit;
            return `<tr>
              <td>${formatDate(r.read_date)}</td>
              <td><strong>${site?.name || '—'}</strong></td>
              <td class="muted">${site?.wal_number || '—'}</td>
              <td class="num">${formatNumber(r.reading, 3)} ${site?.meter_units || 'ML'}</td>
              <td class="num" ${overLimit ? 'style="color:var(--red);font-weight:600"' : ''}>
                ${vol !== null && vol !== undefined ? formatNumber(vol, 3) + (overLimit ? ' ⚠' : '') : '—'}
              </td>
              <td class="muted">${r.read_by || '—'}</td>
              <td class="muted">${r.notes || ''}</td>
              ${canWrite() ? `<td><button class="btn btn-ghost btn-sm edit-read-btn" data-id="${r.id}">Edit</button></td>` : ''}
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : `
      <div class="empty-state" style="padding:30px">
        <p>No readings recorded yet.</p>
        ${canWrite() ? '<p>Enter your first meter reading above.</p>' : ''}
      </div>`}
    </div>`}
  `;

  qs('#btn-add-read', content)?.addEventListener('click', () => _readModal(content, farm));
  content.querySelectorAll('.edit-read-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const read = _reads.find(r => r.id === btn.dataset.id);
      if (read) _readModal(content, farm, read);
    });
  });
}

function _readModal(content, farm, existing = null) {
  const activeSites = _sites.filter(s => s.active !== false);
  const siteOpts = activeSites
    .map(s => `<option value="${s.id}" ${s.id === existing?.site_id ? 'selected' : ''}>${s.name}${s.wal_number ? ' (' + s.wal_number + ')' : ''}</option>`)
    .join('');

  // Find previous reading for selected site to show as reference
  const getPrevRead = (siteId) => {
    const siteReads = _reads
      .filter(r => r.site_id === siteId && (!existing || r.id !== existing.id))
      .sort((a, b) => new Date(b.read_date) - new Date(a.read_date));
    return siteReads[0] || null;
  };

  const existingSite = existing ? _sites.find(s => s.id === existing.site_id) : null;
  const prevRead = existing ? getPrevRead(existing.site_id) : null;

  openModal({
    title: existing ? 'Edit meter reading' : 'Enter meter reading',
    confirmLabel: existing ? 'Save changes' : 'Save reading',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group"><label class="form-label">Site</label>
          <select class="form-select" id="mr-site"><option value="">— select site —</option>${siteOpts}</select></div>
        <div class="form-group"><label class="form-label">Read date</label>
          <input class="form-input" id="mr-date" type="date" value="${existing?.read_date || new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div id="mr-prev-info" style="margin-bottom:12px;padding:10px 12px;background:var(--surface-alt,#f9fafb);border-radius:6px;font-size:var(--text-sm);color:var(--muted)">
        ${prevRead ? `Previous reading: <strong>${formatNumber(prevRead.reading, 3)} ${existingSite?.meter_units || 'ML'}</strong> on ${formatDate(prevRead.read_date)}` : 'No previous reading for this site.'}
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Meter reading</label>
          <input class="form-input num" id="mr-reading" type="number" step="0.001" value="${existing?.reading || ''}" placeholder="Cumulative reading"></div>
        <div class="form-group"><label class="form-label">Read by <span class="text-muted">(optional)</span></label>
          <input class="form-input" id="mr-read-by" value="${existing?.read_by || ''}"></div>
      </div>
      <div class="form-group"><label class="form-label">Notes</label>
        <textarea class="form-textarea" id="mr-notes" rows="2">${existing?.notes || ''}</textarea></div>
    `,
    onMounted: (modal) => {
      const siteSelect = qs('#mr-site', modal);
      const prevInfo = qs('#mr-prev-info', modal);

      siteSelect?.addEventListener('change', () => {
        const siteId = siteSelect.value;
        const site = _sites.find(s => s.id === siteId);
        const prev = getPrevRead(siteId);
        prevInfo.innerHTML = prev
          ? `Previous reading: <strong>${formatNumber(prev.reading, 3)} ${site?.meter_units || 'ML'}</strong> on ${formatDate(prev.read_date)}`
          : 'No previous reading for this site.';
      });
    },
    onConfirm: async (modal) => {
      const siteId = qs('#mr-site', modal)?.value;
      const reading = parseFloat(qs('#mr-reading', modal)?.value);
      if (!siteId) throw new Error('Please select a site');
      if (isNaN(reading)) throw new Error('Please enter a meter reading');

      // Calculate volume since last read
      const prev = getPrevRead(siteId);
      const site = _sites.find(s => s.id === siteId);
      let volumeSinceLast = null;
      if (prev) {
        let diff = reading - prev.reading;
        // Convert m3 to ML if needed
        if (site?.meter_units === 'm3') diff = diff / 1000;
        volumeSinceLast = parseFloat(diff.toFixed(3));
      }

      const row = {
        farm_id: farm.id,
        site_id: siteId,
        read_date: qs('#mr-date', modal)?.value,
        reading,
        volume_since_last: volumeSinceLast,
        read_by: qs('#mr-read-by', modal)?.value?.trim() || null,
        notes: qs('#mr-notes', modal)?.value?.trim() || null,
      };

      if (!row.read_date) throw new Error('Please enter a date');

      // Warn if volume looks wrong (negative or very large)
      if (volumeSinceLast !== null && volumeSinceLast < 0) {
        throw new Error('Reading is less than the previous reading. Check the value.');
      }

      if (existing) {
        await dbUpdate('meter_reads', existing.id, row);
        Object.assign(_reads.find(r => r.id === existing.id), row);
      } else {
        const saved = await dbInsert('meter_reads', row);
        _reads.unshift(saved);
      }
      toast(existing ? 'Reading updated' : 'Reading saved', 'success');
      _renderReads(content, farm);
    },
  });
}

// ── Summary ───────────────────────────────────────────────────
function _renderSummary(content, farm) {
  if (!_sites.length) {
    content.innerHTML = '<div class="empty-state"><p>No extraction sites yet.</p></div>';
    return;
  }

  // Current water year
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const wyStart = m >= 7 ? `${y}-07-01` : `${y - 1}-07-01`;
  const wyLabel = m >= 7 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;

  // Build water year list from reads (last 6 years)
  const allYears = [];
  for (let i = 0; i < 6; i++) {
    const sy = (m >= 7 ? y : y - 1) - i;
    allYears.push({ label: `${sy}-${String(sy+1).slice(2)}`, start: `${sy}-07-01`, end: `${sy+1}-06-30` });
  }
  const recentYears = allYears.slice(0, 6).reverse(); // oldest first for table columns

  // Per-site summary
  const siteSummaries = _sites.map(site => {
    const lastRead = _reads.filter(r => r.site_id === site.id)
      .sort((a, b) => new Date(b.read_date) - new Date(a.read_date))[0];
    const ent = _entitlements.find(e => e.wal_number === site.wal_number);

    // Volume per water year
    const yearVols = recentYears.map(yr => {
      const vol = _reads
        .filter(r => r.site_id === site.id && r.read_date >= yr.start && r.read_date <= yr.end)
        .reduce((s, r) => s + (parseFloat(r.volume_since_last) || 0), 0);
      return vol;
    });

    const currentVol = yearVols[yearVols.length - 1];
    const yearLimit = site.extraction_limit_ml_year;
    const pct = yearLimit && currentVol ? Math.min(100, Math.round((currentVol / yearLimit) * 100)) : null;

    return { site, ent, lastRead, yearVols, currentVol, yearLimit, pct };
  });

  // Group by WAL for totals
  const walGroups = {};
  for (const s of siteSummaries) {
    const wal = s.site.wal_number || 'unlinked';
    if (!walGroups[wal]) walGroups[wal] = { wal, ent: s.ent, sites: [], yearVols: recentYears.map(() => 0) };
    walGroups[wal].sites.push(s);
    s.yearVols.forEach((v, i) => { walGroups[wal].yearVols[i] += v; });
  }

  content.innerHTML = `
    <p style="font-weight:600;font-size:var(--text-sm);margin-bottom:12px">Extraction Summary — ${wyLabel}</p>

    <!-- Summary table like the spreadsheet -->
    <div class="card" style="overflow:hidden;margin-bottom:20px">
      <table class="data-table">
        <thead>
          <tr>
            <th>Site name</th>
            <th>ESID</th>
            <th>WAL</th>
            <th class="num">Limit (ML)</th>
            ${recentYears.map(yr => `<th class="num">${yr.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${siteSummaries.map(({ site, ent, yearVols, yearLimit, pct }) => `
            <tr class="${site.active ? '' : 'muted'}">
              <td><strong>${site.name}</strong>${site.active ? '' : ' <span style="font-size:10px">(inactive)</span>'}</td>
              <td class="muted">${site.esid || '—'}</td>
              <td class="muted">${site.wal_number || '—'}</td>
              <td class="num">${yearLimit ? formatNumber(yearLimit, 0) : 'N/A'}</td>
              ${yearVols.map((v, i) => {
                const isCurrent = i === yearVols.length - 1;
                const over = yearLimit && v > yearLimit;
                return `<td class="num" style="${over ? 'color:var(--red);font-weight:600' : isCurrent && v > 0 ? 'color:var(--blue);font-weight:600' : ''}">${v > 0 ? formatNumber(v, 2) : '—'}</td>`;
              }).join('')}
            </tr>
          `).join('')}
          <!-- Totals row -->
          <tr style="font-weight:600;border-top:2px solid var(--border)">
            <td colspan="4">Total</td>
            ${recentYears.map((yr, i) => {
              const total = siteSummaries.reduce((s, x) => s + x.yearVols[i], 0);
              const isCurrent = i === recentYears.length - 1;
              return `<td class="num" style="${isCurrent ? 'color:var(--blue)' : ''}">${total > 0 ? formatNumber(total, 2) : '—'}</td>`;
            }).join('')}
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Per-site limit progress for current year (only sites with limits) -->
    ${siteSummaries.some(s => s.yearLimit) ? `
    <p style="font-weight:600;font-size:var(--text-sm);margin-bottom:12px">Site Limits — ${wyLabel}</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px">
      ${siteSummaries.filter(s => s.yearLimit).map(({ site, currentVol, yearLimit, pct }) => `
        <div class="card" style="padding:14px">
          <div style="display:flex;justify-content:space-between;margin-bottom:8px">
            <p style="font-weight:600;font-size:var(--text-sm)">${site.name}</p>
            <p style="font-size:11px;color:var(--muted)">${site.esid || ''}</p>
          </div>
          <p style="font-size:20px;font-weight:600;color:${pct > 90 ? 'var(--red)' : 'var(--blue)'};margin-bottom:4px">
            ${formatNumber(currentVol, 1)} <span style="font-size:13px;font-weight:400;color:var(--muted)">/ ${formatNumber(yearLimit, 0)} ML</span>
          </p>
          <div style="height:6px;background:var(--border-light);border-radius:3px;overflow:hidden;margin-bottom:4px">
            <div style="height:100%;width:${pct || 0}%;background:${pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--amber)' : 'var(--blue)'};border-radius:3px"></div>
          </div>
          <p style="font-size:11px;color:var(--muted)">${pct || 0}% of annual limit used</p>
        </div>
      `).join('')}
    </div>` : ''}
  `;
}
