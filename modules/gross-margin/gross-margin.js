// modules/gross-margin/gross-margin.js
// Gross Margin & Budgeting module

import { dbSelect } from '../../js/supabase-client.js';
import { getActiveFarm } from '../../js/app-state.js';
import { formatCurrency, formatNumber, currentSeason } from '../../js/ui.js';

export async function mountGrossMargin(container) {
  const farm = getActiveFarm();

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Gross Margin</h1>
        <p class="page-subtitle">Budgeting and actual gross margin by season and commodity</p>
      </div>
    </div>
    <div class="card">
      <div class="card-body">
        <div class="empty-state">
          <div class="empty-icon">📊</div>
          <p>Gross Margin module — in development.</p>
          <p class="mt-2">Will calculate actual vs budgeted gross margin pulling from Outputs and Inputs modules automatically.</p>
        </div>
      </div>
    </div>
  `;
}
