// modules/outputs/cotton-prices.js
// Cotton market prices — regional daily prices, futures, farm gate price
// Receives data from Power Automate via /api/push-cotton-prices

import { dbSelect, dbInsert } from '../../js/supabase-client.js';
import { getActiveFarm, getSession, canWrite } from '../../js/app-state.js';
import { toast, openModal, formatCurrency, formatDate, qs, currentSeason } from '../../js/ui.js';

// All regions from LDC report
export const COTTON_REGIONS = [
  'Central QLD',
  'Darling Downs',
  'MacIntyre',
  'Gwydir',
  'LDC Moree',
  'Mungindi/St George',
  'Namoi Valley',
  'Macquarie Valley',
  'Lachlan/Sth NSW',
  'NT / WA',
];

let _prices = [];
let _futures = [];
let _update = null;

export async function mountCottonPrices(container) {
  const farm = getActiveFarm();
  const farmRegion = farm?.settings?.cottonRegion || null;

  container.innerHTML = `
    <div class="page-header" style="margin-top:0">
      <div>
        <h2 style="font-size:var(--text-md);font-weight:600">Cotton market prices</h2>
        <p class="page-subtitle">Daily indicative lint prices — LDC</p>
      </div>
      <div class="flex gap-2">
        <select id="cp-year" class="form-select" style="width:100px">
          <option value="2026">2026</option>
          <option value="2027">2027</option>
        </select>
        ${canWrite() ? '<button class="btn btn-secondary btn-sm" id="btn-manual-price">＋ Manual entry</button>' : ''}
      </div>
    </div>

    <div id="cp-content">
      <div class="empty-state"><span class="loading-spinner"></span></div>
    </div>
  `;

  qs('#cp-year', container)?.addEventListener('change', () => _render(container, farmRegion));
  if (canWrite()) {
    qs('#btn-manual-price', container)?.addEventListener('click', () => _manualEntryModal(container, farmRegion));
  }

  await _loadData();
  _render(container, farmRegion);
}

async function _loadData() {
  // Get latest 30 days of prices
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  [_prices, _futures] = await Promise.all([
    dbSelect('cotton_prices', `price_date=gte.${thirtyDaysAgo}&select=*&order=price_date.desc`),
    dbSelect('cotton_futures', `select=*&order=price_date.desc&limit=8`),
  ]);

  try {
    const updates = await dbSelect('cotton_market_updates', 'select=*&order=price_date.desc&limit=1');
    _update = updates[0] || null;
  } catch { _update = null; }
}

function _render(container, farmRegion) {
  const content = qs('#cp-content', container);
  if (!content) return;

  const cropYear = parseInt(qs('#cp-year', container)?.value || '2026');

  // Get latest date's prices for the selected year
  const latestDate = _prices[0]?.price_date || null;
  const latestPrices = latestDate
    ? _prices.filter(p => p.price_date === latestDate && p.crop_year === cropYear)
    : [];

  // Get previous date for change calculation
  const dates = [...new Set(_prices.map(p => p.price_date))].sort().reverse();
  const prevDate = dates[1] || null;
  const prevPrices = prevDate
    ? _prices.filter(p => p.price_date === prevDate && p.crop_year === cropYear)
    : [];

  if (!latestPrices.length) {
    content.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📈</div>
        <p>No cotton prices loaded yet.</p>
        <p>Prices update automatically via Power Automate daily, or use manual entry above.</p>
      </div>`;
    return;
  }

  // Farm gate price for this farm's region
  const farmPrice = farmRegion
    ? latestPrices.find(p => p.region === farmRegion)
    : null;

  let html = '';

  // Farm gate highlight card
  if (farmRegion) {
    const prev = prevPrices.find(p => p.region === farmRegion);
    const change = farmPrice && prev ? farmPrice.price_aud - prev.price_aud : null;
    html += `
      <div class="card" style="margin-bottom:14px;border-left:4px solid var(--blue)">
        <div class="card-body" style="padding:14px 16px">
          <div class="flex items-center gap-2" style="margin-bottom:6px">
            <span class="text-xs text-hint" style="text-transform:uppercase;letter-spacing:.07em;font-weight:600">Farm gate price — ${farmRegion}</span>
            <span class="badge badge-issued">${getActiveFarm()?.name}</span>
          </div>
          <div class="flex items-center gap-3">
            <span style="font-size:var(--text-2xl);font-weight:600;color:var(--blue);font-variant-numeric:tabular-nums">
              ${farmPrice ? '$' + farmPrice.price_aud.toFixed(0) + '/bale' : 'POA'}
            </span>
            ${change !== null ? `
              <span style="font-size:var(--text-sm);color:${change >= 0 ? 'var(--green)' : 'var(--red)'}">
                ${change >= 0 ? '▲' : '▼'} $${Math.abs(change).toFixed(0)} vs yesterday
              </span>
            ` : ''}
            <span class="text-hint text-xs" style="margin-left:auto">
              ${cropYear} crop · as at ${formatDate(latestDate)}
            </span>
          </div>
        </div>
      </div>`;
  }

  // All regions table
  html += `
    <div class="card" style="margin-bottom:14px">
      <div class="card-header">
        <h2>Indicative lint prices — ${cropYear} crop</h2>
        <span class="text-hint text-sm">Source: LDC · ${formatDate(latestDate)}</span>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>Region</th>
            <th class="num">Price (AUD/bale)</th>
            <th class="num">vs yesterday</th>
            <th class="num">vs prev week</th>
          </tr>
        </thead>
        <tbody>
          ${COTTON_REGIONS.map(region => {
            const curr = latestPrices.find(p => p.region === region);
            const prev = prevPrices.find(p => p.region === region);
            const dayChange = curr && prev ? curr.price_aud - prev.price_aud : null;

            // Week ago
            const weekDate = dates[5] || null;
            const weekPrices = weekDate ? _prices.filter(p => p.price_date === weekDate && p.crop_year === cropYear) : [];
            const weekPrice = weekPrices.find(p => p.region === region);
            const weekChange = curr && weekPrice ? curr.price_aud - weekPrice.price_aud : null;

            const isHighlighted = region === farmRegion;
            return `
              <tr style="${isHighlighted ? 'background:var(--blue-light)' : ''}">
                <td>
                  ${isHighlighted ? '<i class="ti ti-map-pin" style="color:var(--blue);font-size:13px;margin-right:4px" aria-hidden="true"></i>' : ''}
                  <strong style="${isHighlighted ? 'color:var(--blue)' : ''}">${region}</strong>
                  ${isHighlighted ? '<span class="badge badge-issued" style="margin-left:6px">Farm</span>' : ''}
                </td>
                <td class="num" style="font-size:var(--text-sm);font-weight:${isHighlighted ? '600' : '400'}">
                  ${curr ? '$' + curr.price_aud.toFixed(0) : 'POA'}
                </td>
                <td class="num">
                  ${dayChange !== null
                    ? `<span style="color:${dayChange > 0 ? 'var(--green)' : dayChange < 0 ? 'var(--red)' : 'var(--muted)'}">
                        ${dayChange > 0 ? '+' : ''}${dayChange.toFixed(0)}
                      </span>`
                    : '<span class="text-hint">—</span>'}
                </td>
                <td class="num">
                  ${weekChange !== null
                    ? `<span style="color:${weekChange > 0 ? 'var(--green)' : weekChange < 0 ? 'var(--red)' : 'var(--muted)'}">
                        ${weekChange > 0 ? '+' : ''}${weekChange.toFixed(0)}
                      </span>`
                    : '<span class="text-hint">—</span>'}
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  // Futures table
  if (_futures.length) {
    const latestFutureDate = _futures[0]?.price_date;
    const latestFutures = _futures.filter(f => f.price_date === latestFutureDate);
    const audusd = _prices[0]?.audusd;

    html += `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div class="card">
          <div class="card-header"><h2>ICE cotton futures (USc/lb)</h2></div>
          <table class="data-table">
            <thead>
              <tr>
                <th>Contract</th>
                <th class="num">Price</th>
                <th class="num">Change</th>
              </tr>
            </thead>
            <tbody>
              ${latestFutures.map(f => `
                <tr>
                  <td>${f.contract_month}</td>
                  <td class="num">${f.price_usd?.toFixed(2) || '—'}</td>
                  <td class="num">
                    ${f.change !== null
                      ? `<span style="color:${f.change > 0 ? 'var(--green)' : f.change < 0 ? 'var(--red)' : 'var(--muted)'}">
                          ${f.change > 0 ? '+' : ''}${f.change?.toFixed(2)}
                        </span>`
                      : '—'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div class="card">
          <div class="card-header"><h2>Key rates</h2></div>
          <div class="card-body">
            ${audusd ? `
              <div style="margin-bottom:12px">
                <p class="text-xs text-hint" style="text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">AUD/USD spot</p>
                <p style="font-size:var(--text-xl);font-weight:600;font-variant-numeric:tabular-nums">${audusd.toFixed(4)}</p>
              </div>
            ` : ''}
            <p class="text-xs text-hint">Last updated: ${formatDate(latestFutureDate)}</p>
          </div>
        </div>
      </div>`;
  }

  // Market update
  if (_update) {
    html += `
      <div class="card" style="margin-top:14px">
        <div class="card-header">
          <h2>Market update</h2>
          <span class="text-hint text-sm">${formatDate(_update.price_date)} · ${_update.source}</span>
        </div>
        <div class="card-body">
          <p style="font-size:var(--text-sm);line-height:1.7;color:var(--ink-mid)">${_update.update_text}</p>
        </div>
      </div>`;
  }

  content.innerHTML = html;
}

// Manual price entry modal
function _manualEntryModal(container, farmRegion) {
  const today = new Date().toISOString().slice(0, 10);

  openModal({
    title: 'Manual cotton price entry',
    confirmLabel: 'Save prices',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" id="mp-date" type="date" value="${today}">
        </div>
        <div class="form-group">
          <label class="form-label">Crop year</label>
          <select class="form-select" id="mp-year">
            <option value="2026">2026</option>
            <option value="2027">2027</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">AUD/USD</label>
          <input class="form-input num" id="mp-audusd" type="number" step="0.0001" placeholder="0.6916">
        </div>
      </div>
      <p class="form-helper" style="margin-bottom:12px">Enter prices for each region (leave blank to skip)</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${COTTON_REGIONS.map(region => `
          <div class="form-group" style="margin-bottom:8px">
            <label class="form-label" style="display:flex;align-items:center;gap:4px">
              ${region}
              ${region === farmRegion ? '<span class="badge badge-issued" style="font-size:9px">Farm</span>' : ''}
            </label>
            <input class="form-input num" data-region="${region}" type="number" step="0.01" placeholder="e.g. 602">
          </div>
        `).join('')}
      </div>
    `,
    onConfirm: async (modal) => {
      const date = qs('#mp-date', modal)?.value;
      const cropYear = parseInt(qs('#mp-year', modal)?.value || '2026');
      const audusd = parseFloat(qs('#mp-audusd', modal)?.value || 0) || null;

      if (!date) throw new Error('Please enter a date');

      const rows = [];
      modal.querySelectorAll('input[data-region]').forEach(input => {
        const price = parseFloat(input.value);
        if (!isNaN(price) && price > 0) {
          rows.push({
            price_date: date,
            source: 'Manual',
            region: input.dataset.region,
            crop_year: cropYear,
            price_aud: price,
            audusd,
          });
        }
      });

      if (!rows.length) throw new Error('Please enter at least one price');

      // Upsert via individual inserts
      for (const row of rows) {
        try {
          await dbInsert('cotton_prices', row);
        } catch (e) {
          // Duplicate — skip
        }
      }

      toast(`${rows.length} prices saved`, 'success');
      await _loadData();
      _render(container, farmRegion);
    },
  });
}
