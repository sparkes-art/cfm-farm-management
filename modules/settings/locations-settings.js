// modules/settings/locations-settings.js
// Farm locations — central list used by Stocktake (grain, seed) and other modules

import { dbSelect, dbInsert, dbUpdate } from '../../js/supabase-client.js?v=1794790509004';
import { getActiveFarm, canWrite } from '../../js/app-state.js?v=1794790509004';
import { toast, openModal, qs } from '../../js/ui.js?v=1794790509004';

const LOCATION_KINDS = ['Shed', 'Silo', 'Cool room', 'Paddock', 'Yard', 'Other'];

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

export async function mountLocationsSettings(container) {
  const farm = getActiveFarm();
  if (!farm) { container.innerHTML = '<p class="empty-state">No farm selected.</p>'; return; }

  await _render(container, farm);
}

async function _render(container, farm) {
  const locations = await dbSelect('stock_locations',
    `farm_id=eq.${farm.id}&order=route_order,name`);

  const active   = locations.filter(l => l.active !== false);
  const inactive = locations.filter(l => l.active === false);

  const rowHtml = locs => locs.map(l => `
    <tr data-loc-id="${l.id}">
      <td style="padding:10px 16px;font-size:14px;color:var(--ink);font-weight:500">${esc(l.name)}</td>
      <td style="padding:10px 16px;font-size:13px;color:var(--hint)">${esc(l.kind || '—')}</td>
      <td style="padding:10px 16px">
        ${l.active !== false
          ? `<span style="font-size:11px;font-weight:600;color:var(--green);background:var(--green-tint);padding:2px 8px;border-radius:10px">Active</span>`
          : `<span style="font-size:11px;font-weight:600;color:var(--hint);background:var(--border-light);padding:2px 8px;border-radius:10px">Inactive</span>`}
      </td>
      <td style="padding:10px 16px;text-align:right">
        ${canWrite() ? `
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm loc-edit" data-id="${l.id}" style="font-size:11px">✎ Edit</button>
            ${l.active !== false
              ? `<button class="btn btn-ghost btn-sm loc-deactivate" data-id="${l.id}" style="font-size:11px;color:var(--red-muted)">Deactivate</button>`
              : `<button class="btn btn-ghost btn-sm loc-activate" data-id="${l.id}" style="font-size:11px;color:var(--green)">Reactivate</button>`}
          </div>` : ''}
      </td>
    </tr>`).join('');

  container.innerHTML = `
    <div style="padding:24px 0 0">

      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <div>
          <h2 style="margin:0;font-size:17px">Storage locations</h2>
          <p style="margin:4px 0 0;font-size:13px;color:var(--hint)">
            Shared across all stocktake modules for this farm. Locations are never deleted — deactivate to hide from dropdowns.
          </p>
        </div>
        ${canWrite() ? `<button class="btn btn-primary btn-sm" id="loc-add">+ Add location</button>` : ''}
      </div>

      ${active.length === 0 && inactive.length === 0 ? `
        <div style="text-align:center;padding:48px 24px;color:var(--hint)">
          <div style="font-size:32px;margin-bottom:12px">📍</div>
          <div style="font-size:15px;font-weight:500;margin-bottom:6px">No locations yet</div>
          <div style="font-size:13px">Add sheds, silos or storage areas — they'll appear in delivery and movement forms across Stocktake.</div>
        </div>` : `

        <div class="card" style="overflow:hidden;padding:0">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:var(--page-bg);border-bottom:2px solid var(--border)">
                <th style="padding:10px 16px;text-align:left;font-size:12px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.04em">Name</th>
                <th style="padding:10px 16px;text-align:left;font-size:12px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.04em">Type</th>
                <th style="padding:10px 16px;text-align:left;font-size:12px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.04em">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody id="loc-table-body">
              ${rowHtml(active)}
              ${inactive.length ? `
                <tr><td colspan="4" style="padding:8px 16px;font-size:11px;font-weight:600;color:var(--hint);text-transform:uppercase;letter-spacing:.06em;background:var(--page-bg);border-top:2px solid var(--border)">Inactive</td></tr>
                ${rowHtml(inactive)}` : ''}
            </tbody>
          </table>
        </div>`}
    </div>`;

  // Wire buttons
  qs('#loc-add', container)?.addEventListener('click', () => _showAddForm(container, farm));

  container.querySelectorAll('.loc-edit').forEach(btn => {
    const loc = locations.find(l => l.id === btn.dataset.id);
    if (loc) btn.addEventListener('click', () => _showEditForm(container, farm, loc));
  });

  container.querySelectorAll('.loc-deactivate').forEach(btn => {
    btn.addEventListener('click', async () => {
      await dbUpdate('stock_locations', btn.dataset.id, { active: false });
      toast('Location deactivated', 'success');
      await _render(container, farm);
    });
  });

  container.querySelectorAll('.loc-activate').forEach(btn => {
    btn.addEventListener('click', async () => {
      await dbUpdate('stock_locations', btn.dataset.id, { active: true });
      toast('Location reactivated', 'success');
      await _render(container, farm);
    });
  });
}

function _locationFormBody(loc = {}) {
  const kindOpts = LOCATION_KINDS.map(k =>
    `<option value="${k}"${k === (loc.kind || '') ? ' selected' : ''}>${k}</option>`).join('');
  return `
    <div style="display:flex;flex-direction:column;gap:14px">
      <div class="form-group">
        <label class="form-label">Name <span style="color:var(--red)">*</span></label>
        <input class="form-input" id="lf-name" type="text" value="${esc(loc.name || '')}" placeholder="e.g. Shed A, North Silo, Cool Room 1">
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <select class="form-select" id="lf-kind">
          <option value="">— unspecified</option>
          ${kindOpts}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Display order <span style="font-size:11px;color:var(--hint)">(optional — lower numbers appear first)</span></label>
        <input class="form-input" id="lf-order" type="number" min="0" step="1" value="${loc.route_order ?? ''}" placeholder="e.g. 1, 2, 3…">
      </div>
    </div>`;
}

function _showAddForm(container, farm) {
  openModal({
    title: 'Add location',
    bodyHTML: _locationFormBody(),
    confirmLabel: 'Add location',
    onConfirm: async (modal) => {
      const name  = modal.querySelector('#lf-name')?.value?.trim();
      const kind  = modal.querySelector('#lf-kind')?.value || null;
      const order = parseInt(modal.querySelector('#lf-order')?.value) || null;

      if (!name) { toast('Name is required', 'error'); return false; }

      await dbInsert('stock_locations', {
        farm_id:     farm.id,
        name,
        kind,
        route_order: order,
        active:      true,
      });
      toast('Location added', 'success');
      await _render(container, farm);
    }
  });
}

function _showEditForm(container, farm, loc) {
  openModal({
    title: 'Edit location',
    bodyHTML: _locationFormBody(loc),
    confirmLabel: 'Save changes',
    onConfirm: async (modal) => {
      const name  = modal.querySelector('#lf-name')?.value?.trim();
      const kind  = modal.querySelector('#lf-kind')?.value || null;
      const order = parseInt(modal.querySelector('#lf-order')?.value) || null;

      if (!name) { toast('Name is required', 'error'); return false; }

      await dbUpdate('stock_locations', loc.id, { name, kind, route_order: order });
      toast('Location updated', 'success');
      await _render(container, farm);
    }
  });
}
