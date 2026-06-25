// modules/settings/users-settings.js
// User management — list, add, edit, deactivate

import { dbSelect, dbInsert, dbUpdate } from '../../js/supabase-client.js';
import { getActiveFarm, getFarms } from '../../js/app-state.js';
import { toast, openModal, qs, formatDate } from '../../js/ui.js';

const ROLES = [
  { value: 'admin', label: 'Admin / Accounting', desc: 'Full access to all data and settings' },
  { value: 'operational', label: 'Operational', desc: 'Full data entry, no user management' },
  { value: 'investor', label: 'Investor / Board', desc: 'Read-only access' },
];

export async function mountUsersSettings(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Users</h1>
        <p class="page-subtitle">Manage who has access to CFM</p>
      </div>
      <button class="btn btn-primary" id="btn-add-user">＋ Add user</button>
    </div>
    <div class="card" id="users-wrap">
      <div class="empty-state"><span class="loading-spinner"></span></div>
    </div>
  `;

  qs('#btn-add-user', container)?.addEventListener('click', () => _addUserModal(container));

  await _renderUsers(container);
}

async function _renderUsers(container) {
  const wrap = qs('#users-wrap', container);
  if (!wrap) return;

  try {
    const users = await dbSelect('user_profiles', 'select=*&order=full_name.asc');

    if (!users.length) {
      wrap.innerHTML = '<div class="empty-state"><p>No users yet.</p></div>';
      return;
    }

    wrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Farm access</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => {
            const role = ROLES.find(r => r.value === u.role);
            const farms = getFarms();
            const farmAccess = !u.farm_access?.length
              ? 'All farms'
              : u.farm_access.map(id => farms.find(f => f.id === id)?.name || id).join(', ');
            const isActive = u.is_active !== false;
            return `
              <tr style="${!isActive ? 'opacity:0.5' : ''}">
                <td>
                  <strong>${u.full_name || '—'}</strong>
                  <div class="text-xs text-muted">${u.id}</div>
                </td>
                <td>
                  <span class="badge ${u.role === 'admin' ? 'badge-issued' : u.role === 'operational' ? 'badge-paid' : 'badge-draft'}">
                    ${role?.label || u.role}
                  </span>
                </td>
                <td class="muted text-sm">${farmAccess}</td>
                <td>
                  <span class="badge ${isActive ? 'badge-paid' : 'badge-void'}">
                    ${isActive ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td>
                  <div class="flex gap-2">
                    <button class="btn btn-ghost btn-sm edit-user-btn" data-id="${u.id}">Edit</button>
                    <button class="btn btn-ghost btn-sm toggle-user-btn" data-id="${u.id}" data-active="${isActive}"
                      style="color:${isActive ? 'var(--red)' : 'var(--green)'}">
                      ${isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    // Edit buttons
    wrap.querySelectorAll('.edit-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const user = users.find(u => u.id === btn.dataset.id);
        if (user) await _editUserModal(user, container);
      });
    });

    // Toggle active
    wrap.querySelectorAll('.toggle-user-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const isActive = btn.dataset.active === 'true';
        const user = users.find(u => u.id === btn.dataset.id);
        const action = isActive ? 'Deactivate' : 'Reactivate';

        openModal({
          title: `${action} user`,
          confirmLabel: action,
          confirmClass: isActive ? 'btn-danger' : 'btn-primary',
          bodyHTML: `<p>${action} <strong>${user?.full_name || 'this user'}</strong>?${isActive ? ' They will no longer be able to log in.' : ' They will regain access to CFM.'}</p>`,
          onConfirm: async () => {
            await dbUpdate('user_profiles', btn.dataset.id, { is_active: !isActive });
            toast(`User ${action.toLowerCase()}d`, 'success');
            await _renderUsers(container);
          },
        });
      });
    });

  } catch (err) {
    wrap.innerHTML = `<div class="empty-state"><p>Failed to load users: ${err.message}</p></div>`;
  }
}

function _farmAccessOptions(selectedIds = []) {
  const farms = getFarms();
  return farms.map(f => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;font-size:var(--text-sm)">
      <input type="checkbox" class="farm-access-check" value="${f.id}" ${selectedIds.includes(f.id) ? 'checked' : ''}>
      ${f.name}${f.state ? ` (${f.state})` : ''}
    </label>
  `).join('');
}

function _gatherFarmAccess(modal) {
  const checked = [...modal.querySelectorAll('.farm-access-check:checked')].map(c => c.value);
  const total = modal.querySelectorAll('.farm-access-check').length;
  // If all farms checked or none checked, use empty array (= all farms)
  return checked.length === total ? [] : checked;
}

// ── Add user ──────────────────────────────────────────────────
function _addUserModal(container) {
  const tempPassword = _generatePassword();

  openModal({
    title: 'Add user',
    confirmLabel: 'Create user',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Full name</label>
          <input class="form-input" id="u-name" type="text" placeholder="First Last">
        </div>
        <div class="form-group">
          <label class="form-label">Email address</label>
          <input class="form-input" id="u-email" type="email" placeholder="user@example.com">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Role</label>
        ${ROLES.map(r => `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:6px;cursor:pointer">
            <input type="radio" name="u-role" value="${r.value}" style="margin-top:2px" ${r.value === 'operational' ? 'checked' : ''}>
            <div>
              <div style="font-size:var(--text-sm);font-weight:500">${r.label}</div>
              <div style="font-size:var(--text-xs);color:var(--muted)">${r.desc}</div>
            </div>
          </label>
        `).join('')}
      </div>

      <div class="form-group">
        <label class="form-label">Farm access</label>
        <p class="form-helper" style="margin-bottom:8px">Leave all checked to grant access to all farms including future ones.</p>
        <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px">
          ${_farmAccessOptions([])}
        </div>
      </div>

      <div class="form-group" style="background:var(--blue-light);border:1px solid var(--blue);border-radius:var(--radius-sm);padding:12px">
        <label class="form-label">Temporary password</label>
        <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
          <code style="font-size:var(--text-base);font-weight:600;color:var(--blue);letter-spacing:0.05em">${tempPassword}</code>
          <button type="button" class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${tempPassword}').then(()=>this.textContent='Copied!').catch(()=>{})">Copy</button>
        </div>
        <p class="form-helper" style="margin-top:6px">Share this with the user — they can change it after logging in. Save it now as it won't be shown again.</p>
      </div>
    `,
    onConfirm: async (modal) => {
      const name = qs('#u-name', modal)?.value?.trim();
      const email = qs('#u-email', modal)?.value?.trim();
      const role = modal.querySelector('input[name="u-role"]:checked')?.value || 'operational';
      const farmAccess = _gatherFarmAccess(modal);

      if (!name || !email) throw new Error('Please enter a name and email address');

      // Create user via auth function
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signup', email, password: tempPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');

      // Create profile
      await dbInsert('user_profiles', {
        id: data.user?.id || data.id,
        full_name: name,
        role,
        farm_access: farmAccess,
        is_active: true,
      });

      toast(`${name} added successfully`, 'success');
      await _renderUsers(container);
    },
  });
}

// ── Edit user ─────────────────────────────────────────────────
async function _editUserModal(user, container) {
  openModal({
    title: `Edit — ${user.full_name || 'User'}`,
    confirmLabel: 'Save changes',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Full name</label>
          <input class="form-input" id="eu-name" type="text" value="${user.full_name || ''}">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Role</label>
        ${ROLES.map(r => `
          <label style="display:flex;align-items:flex-start;gap:10px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:6px;cursor:pointer">
            <input type="radio" name="eu-role" value="${r.value}" style="margin-top:2px" ${user.role === r.value ? 'checked' : ''}>
            <div>
              <div style="font-size:var(--text-sm);font-weight:500">${r.label}</div>
              <div style="font-size:var(--text-xs);color:var(--muted)">${r.desc}</div>
            </div>
          </label>
        `).join('')}
      </div>

      <div class="form-group">
        <label class="form-label">Farm access</label>
        <p class="form-helper" style="margin-bottom:8px">Leave all checked to grant access to all farms.</p>
        <div style="border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px">
          ${_farmAccessOptions(user.farm_access || [])}
        </div>
      </div>

      <hr class="divider">

      <div class="form-group">
        <label class="form-label">Reset password</label>
        <p class="form-helper" style="margin-bottom:8px">Generate a new temporary password for this user.</p>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-reset-pw">Generate new password</button>
        <div id="new-pw-display" style="margin-top:8px"></div>
      </div>
    `,
    onConfirm: async (modal) => {
      const name = qs('#eu-name', modal)?.value?.trim();
      const role = modal.querySelector('input[name="eu-role"]:checked')?.value;
      const farmAccess = _gatherFarmAccess(modal);

      await dbUpdate('user_profiles', user.id, {
        full_name: name,
        role,
        farm_access: farmAccess,
      });

      toast('User updated', 'success');
      await _renderUsers(container);
    },
  });

  // Wire reset password button
  setTimeout(() => {
    qs('#btn-reset-pw')?.addEventListener('click', async () => {
      const newPw = _generatePassword();
      const display = qs('#new-pw-display');

      try {
        const res = await fetch('/api/auth-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'reset_password', user_id: user.id, password: newPw }),
        });
        if (!res.ok) throw new Error('Failed to reset password');

        if (display) display.innerHTML = `
          <div style="background:var(--blue-light);border:1px solid var(--blue);border-radius:var(--radius-sm);padding:10px 12px">
            <div style="display:flex;align-items:center;gap:8px">
              <code style="font-size:var(--text-base);font-weight:600;color:var(--blue)">${newPw}</code>
              <button type="button" class="btn btn-ghost btn-sm" onclick="navigator.clipboard.writeText('${newPw}').then(()=>this.textContent='Copied!').catch(()=>{})">Copy</button>
            </div>
            <p style="font-size:var(--text-xs);color:var(--muted);margin-top:6px">Share this with the user. Save it now.</p>
          </div>`;
      } catch (err) {
        if (display) display.innerHTML = `<p style="color:var(--red);font-size:var(--text-sm)">${err.message}</p>`;
      }
    });
  }, 100);
}

function _generatePassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
