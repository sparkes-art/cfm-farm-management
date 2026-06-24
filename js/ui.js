// js/ui.js
// Shared UI helpers: toast, modal, confirm, formatters

// ── Toast ────────────────────────────────────────────────────
let _toastContainer;
function _getToastContainer() {
  if (!_toastContainer) {
    _toastContainer = document.createElement('div');
    _toastContainer.id = 'toast-container';
    document.body.appendChild(_toastContainer);
  }
  return _toastContainer;
}

export function toast(message, type = 'default', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  _getToastContainer().appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 200ms';
    setTimeout(() => el.remove(), 220);
  }, duration);
}

// ── Modal ────────────────────────────────────────────────────
export function openModal({ title, bodyHTML, onConfirm, confirmLabel = 'Save', confirmClass = 'btn-primary', showCancel = true }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-header">
        <h2 id="modal-title">${title}</h2>
        <button class="modal-close" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
      <div class="modal-footer">
        ${showCancel ? '<button class="btn btn-secondary modal-cancel">Cancel</button>' : ''}
        ${onConfirm ? `<button class="btn ${confirmClass} modal-confirm">${confirmLabel}</button>` : ''}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.modal-close')?.addEventListener('click', close);
  overlay.querySelector('.modal-cancel')?.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const confirmBtn = overlay.querySelector('.modal-confirm');
  if (confirmBtn && onConfirm) {
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<span class="loading-spinner"></span>';
      try {
        await onConfirm(overlay);
        close();
      } catch (err) {
        toast(err.message || 'Something went wrong', 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = confirmLabel;
      }
    });
  }

  // Focus first input
  setTimeout(() => overlay.querySelector('input, select, textarea')?.focus(), 50);

  return { overlay, close };
}

// ── Formatters ───────────────────────────────────────────────
export function formatCurrency(value, decimals = 2) {
  if (value == null || isNaN(value)) return '—';
  return new Intl.NumberFormat('en-AU', {
    style: 'currency',
    currency: 'AUD',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatNumber(value, decimals = 3) {
  if (value == null || isNaN(value)) return '—';
  return new Intl.NumberFormat('en-AU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-AU', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

export function commodityBadge(type) {
  const labels = {
    cotton: 'Cotton', grain: 'Grain', pulse: 'Pulse',
    livestock: 'Livestock', other: 'Other'
  };
  return `<span class="badge badge-${type}">${labels[type] || type}</span>`;
}

export function statusBadge(status) {
  const labels = { draft: 'Draft', issued: 'Issued', paid: 'Paid', void: 'Void' };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

// ── DOM helpers ──────────────────────────────────────────────
export function qs(selector, root = document) { return root.querySelector(selector); }
export function qsa(selector, root = document) { return [...root.querySelectorAll(selector)]; }

export function setContent(selector, html, root = document) {
  const el = root.querySelector(selector);
  if (el) el.innerHTML = html;
}

export function show(el) {
  const node = typeof el === 'string' ? document.querySelector(el) : el;
  node?.classList.remove('hidden');
}

export function hide(el) {
  const node = typeof el === 'string' ? document.querySelector(el) : el;
  node?.classList.add('hidden');
}

// ── Season helper ─────────────────────────────────────────────
export function currentSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based
  // Australian ag season: roughly May–April
  return month >= 5
    ? `${year}-${String(year + 1).slice(2)}`
    : `${year - 1}-${String(year).slice(2)}`;
}
