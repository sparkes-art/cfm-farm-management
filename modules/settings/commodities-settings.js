// modules/settings/commodities-settings.js
// Manage commodities and crop types — add, delete, view

import {
  loadCommodities, getCommodities, getCropTypes,
  addCommodity, addCropType, deleteCommodity, deleteCropType,
  invalidateCache
} from '../../js/commodities.js';
import { toast, openModal, qs, setContent } from '../../js/ui.js';
import { canWrite } from '../../js/app-state.js';

export async function mountCommoditySettings(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Commodities & Crop Types</h1>
        <p class="page-subtitle">Manage the commodity and crop type lists used across the system</p>
      </div>
      ${canWrite() ? '<button class="btn btn-primary" id="btn-add-commodity">＋ Add commodity</button>' : ''}
    </div>

    <div id="commodities-list">
      <div class="empty-state"><div class="loading-spinner"></div></div>
    </div>
  `;

  await loadCommodities();
  _render(container);

  if (canWrite()) {
    qs('#btn-add-commodity', container)?.addEventListener('click', () => _addCommodityModal(container));
  }
}

function _render(container) {
  const commodities = getCommodities();
  const list = qs('#commodities-list', container);
  if (!list) return;

  if (!commodities.length) {
    list.innerHTML = `<div class="empty-state"><p>No commodities defined yet.</p></div>`;
    return;
  }

  list.innerHTML = commodities.map(c => {
    const cropTypes = getCropTypes(c.id);
    return `
      <div class="card" style="margin-bottom:12px">
        <div class="card-header">
          <div class="flex items-center gap-2">
            <span style="font-size:var(--text-md);font-weight:600">${c.name}</span>
            ${c.is_livestock
              ? '<span class="badge badge-livestock">Livestock</span>'
              : '<span class="badge badge-grain">Crop</span>'
            }
          </div>
          ${canWrite() ? `
            <div class="flex gap-2">
              ${!c.is_livestock ? `<button class="btn btn-secondary btn-sm" data-id="${c.id}" data-name="${c.name}" onclick="window.__cfmAddCropType('${c.id}', '${c.name}')">＋ Crop type</button>` : ''}
              <button class="btn btn-ghost btn-sm" style="color:#DC2626" onclick="window.__cfmDeleteCommodity('${c.id}', '${c.name}')">Delete</button>
            </div>
          ` : ''}
        </div>
        ${!c.is_livestock ? `
          <div class="card-body" style="padding:12px 18px">
            ${cropTypes.length ? `
              <div style="display:flex;flex-wrap:wrap;gap:8px">
                ${cropTypes.map(ct => `
                  <div style="display:flex;align-items:center;gap:6px;background:var(--off-white);border:1px solid var(--rule);border-radius:var(--radius-sm);padding:4px 10px">
                    <span style="font-size:var(--text-sm)">${ct.name}</span>
                    ${canWrite() ? `<button onclick="window.__cfmDeleteCropType('${ct.id}', '${ct.name}')" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:14px;line-height:1;padding:0 2px" title="Remove">✕</button>` : ''}
                  </div>
                `).join('')}
              </div>
            ` : `<p class="text-sm text-muted">No crop types defined — click "+ Crop type" to add one.</p>`}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

// ── Add commodity modal ───────────────────────────────────────
function _addCommodityModal(container) {
  openModal({
    title: 'Add commodity',
    confirmLabel: 'Add commodity',
    bodyHTML: `
      <div class="form-group">
        <label class="form-label">Commodity name <span class="required">*</span></label>
        <input class="form-input" id="new-commodity-name" type="text" placeholder="e.g. Mungbeans, Sunflower, Goats" autofocus>
      </div>
      <div class="form-group">
        <label class="form-label">Type</label>
        <div style="display:flex;gap:16px;margin-top:4px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:var(--text-sm)">
            <input type="radio" name="com-type" value="crop" checked> Crop / grain
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:var(--text-sm)">
            <input type="radio" name="com-type" value="livestock"> Livestock
          </label>
        </div>
        <p class="form-helper">Livestock commodities don't have crop types.</p>
      </div>
    `,
    onConfirm: async () => {
      const name = qs('#new-commodity-name')?.value?.trim();
      if (!name) throw new Error('Please enter a commodity name');
      const isLivestock = document.querySelector('input[name="com-type"]:checked')?.value === 'livestock';
      await addCommodity(name, isLivestock);
      toast(`${name} added`, 'success');
      _render(container);
    },
  });
}

// ── Global handlers for inline buttons ───────────────────────
window.__cfmAddCropType = (commodityId, commodityName) => {
  openModal({
    title: `Add crop type — ${commodityName}`,
    confirmLabel: 'Add crop type',
    bodyHTML: `
      <div class="form-group">
        <label class="form-label">Crop type name <span class="required">*</span></label>
        <input class="form-input" id="new-croptype-name" type="text" placeholder="e.g. ${commodityName} Irrigated">
        <p class="form-helper">Typically includes the production method: Irrigated, Dryland, Winter, Summer, etc.</p>
      </div>
    `,
    onConfirm: async () => {
      const name = qs('#new-croptype-name')?.value?.trim();
      if (!name) throw new Error('Please enter a crop type name');
      await addCropType(commodityId, name);
      toast(`${name} added`, 'success');
      // Re-render the settings page
      const container = document.getElementById('main');
      if (container) _render(container);
    },
  });
};

window.__cfmDeleteCommodity = (id, name) => {
  const cropTypes = getCropTypes(id);
  openModal({
    title: 'Delete commodity',
    confirmLabel: 'Delete',
    confirmClass: 'btn-danger',
    bodyHTML: `
      <p>Are you sure you want to delete <strong>${name}</strong>?</p>
      ${cropTypes.length ? `<p class="text-sm text-muted mt-2">This will also delete ${cropTypes.length} crop type${cropTypes.length !== 1 ? 's' : ''} associated with it.</p>` : ''}
      <p class="text-sm text-muted mt-2">Existing contracts and invoices will not be affected.</p>
    `,
    onConfirm: async () => {
      await deleteCommodity(id);
      toast(`${name} deleted`);
      const container = document.getElementById('main');
      if (container) _render(container);
    },
  });
};

window.__cfmDeleteCropType = (id, name) => {
  openModal({
    title: 'Remove crop type',
    confirmLabel: 'Remove',
    confirmClass: 'btn-danger',
    bodyHTML: `<p>Remove <strong>${name}</strong> from the crop type list?</p>`,
    onConfirm: async () => {
      await deleteCropType(id);
      toast(`${name} removed`);
      const container = document.getElementById('main');
      if (container) _render(container);
    },
  });
};
