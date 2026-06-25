// modules/settings/settings.js
// Settings hub — Farm settings + Commodities

import { mountFarmSettings } from './farm-settings.js';
import { mountCommoditySettings } from './commodities-settings.js';
import { mountUsersSettings } from './users-settings.js';
import { qs } from '../../js/ui.js';

let _activeTab = 'farm';

export async function mountSettings(container, initialTab = 'farm') {
  _activeTab = initialTab;

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Settings</h1>
        <p class="page-subtitle">Farm configuration and system settings</p>
      </div>
    </div>

    <div class="tab-strip">
      <button class="tab-btn ${_activeTab === 'farm' ? 'active' : ''}" data-tab="farm">Farm settings</button>
      <button class="tab-btn ${_activeTab === 'commodities' ? 'active' : ''}" data-tab="commodities">Commodities & crop types</button>
      <button class="tab-btn ${_activeTab === 'users' ? 'active' : ''}" data-tab="users">Users</button>
    </div>

    <div id="settings-content"></div>
  `;

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeTab));
      _loadTab(container);
    });
  });

  _loadTab(container);
}

async function _loadTab(container) {
  const content = qs('#settings-content', container);
  if (!content) return;

  if (_activeTab === 'farm') {
    await mountFarmSettings(content);
  } else if (_activeTab === 'users') {
    await mountUsersSettings(content);
  } else {
    await mountCommoditySettings(content);
  }
}
