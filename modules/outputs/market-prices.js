// modules/outputs/market-prices.js
// Manual market price entry + Excel import (col A: date, col B: price)
// Price history chart per commodity

import { dbSelect, dbInsert, dbDelete, dbUpsert } from '../../js/supabase-client.js';
import { getActiveFarm } from '../../js/app-state.js';
import { getSession, canWrite } from '../../js/app-state.js';
import { loadCommodities, getCommodities, commodityOptions } from '../../js/commodities.js';
import { toast, openModal, formatCurrency, formatDate, qs, setContent, currentSeason } from '../../js/ui.js';

let _prices = [];
let _contracts = [];
let _selectedCommodityId = null;
let _chartRange = 12; // months

export function unmountMarketPrices() {
  _prices = [];
  _contracts = [];
  _selectedCommodityId = null;
  _budgetPrice = null;
  if (window.__cfmPriceChart) {
    window.__cfmPriceChart.destroy();
    window.__cfmPriceChart = null;
  }
}

export async function mountMarketPrices(container) {
  await loadCommodities();
  const allCommodities = getCommodities().filter(c => !c.is_livestock);

  // Filter to only commodities that have price data or a budget
  const farm = getActiveFarm();
  const season = currentSeason();

  const farmSettings = farm?.settings || {};
  const grainSites = farmSettings.grainSites || {};
  const grainGrades = { Wheat: 'APW1', Barley: 'BAR1', Canola: 'CAN1', 'Faba Beans': 'FAB2', Lentils: 'NIPT1' };

  const commodityChecks = await Promise.all(allCommodities.map(async c => {
    try {
      // Grain commodity with no delivery site = farm doesn't grow it, hide completely
      if (grainGrades[c.name] && !grainSites[c.name]) {
        return { commodity: c, hasData: false };
      }

      const [prices, budgets] = await Promise.all([
        dbSelect('market_prices', 'commodity_id=eq.' + c.id + '&select=id&limit=1'),
        farm ? dbSelect('budgets', 'farm_id=eq.' + farm.id + '&commodity_id=eq.' + c.id + '&season=eq.' + season + '&select=id&limit=1').catch(() => []) : Promise.resolve([]),
      ]);
      return { commodity: c, hasData: prices.length > 0 || budgets.length > 0 };
    } catch { return { commodity: c, hasData: false }; }
  }));

  const commodities = commodityChecks.filter(x => x.hasData).map(x => x.commodity);

  if (!commodities.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📈</div><p>No market price data yet.</p><p>Import prices via Excel or set up the Power Automate flow.</p></div>';
    return;
  }

  if (commodities.length) _selectedCommodityId = commodities[0].id;

  const activeCommodity = commodities.find(c => c.id === _selectedCommodityId);

  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Market prices</h1>
        <p class="page-subtitle">Manual price history — import from Excel or add individual entries</p>
      </div>
      <div class="flex gap-2">
        ${canWrite() ? `
          <button class="btn btn-secondary" id="btn-import-excel">⬆ Import Excel</button>
          <button class="btn btn-primary" id="btn-add-price">＋ Add price</button>
        ` : ''}
      </div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
      ${commodities.map(c => `
        <button class="commodity-pill ${c.id === _selectedCommodityId ? 'active' : ''}" data-id="${c.id}"
          style="padding:7px 16px;border-radius:20px;font-size:var(--text-sm);font-weight:500;cursor:pointer;border:1px solid ${c.id === _selectedCommodityId ? 'var(--blue)' : 'var(--border)'};background:${c.id === _selectedCommodityId ? 'var(--blue)' : 'var(--white)'};color:${c.id === _selectedCommodityId ? 'white' : 'var(--muted)'};transition:all 120ms ease">
          ${c.name}
        </button>
      `).join('')}
    </div>

    <div id="mp-commodity-heading" style="margin-bottom:16px">
      <div style="display:flex;align-items:baseline;gap:12px">
        <h2 style="font-size:var(--text-lg);font-weight:600;color:var(--ink)">${activeCommodity?.name || ''}</h2>
        <span id="mp-site-label" class="text-sm text-muted"></span>
      </div>
      <p class="page-subtitle" id="mp-grade-label">Price history</p>
    </div>

    <div style="display:grid;grid-template-columns:1fr 320px;gap:20px">
      <div class="card">
        <div class="card-header">
          <h2>Price history</h2>
          <div class="flex items-center gap-2">
            <span id="mp-count" class="text-muted text-sm"></span>
            <div style="display:flex;gap:4px">
              <button class="chart-range-btn active" data-months="6" style="padding:3px 10px;font-size:11px;border-radius:4px;border:1px solid var(--border);background:var(--blue);color:white;cursor:pointer">6m</button>
              <button class="chart-range-btn" data-months="12" style="padding:3px 10px;font-size:11px;border-radius:4px;border:1px solid var(--border);background:var(--white);color:var(--muted);cursor:pointer">12m</button>
              <button class="chart-range-btn" data-months="24" style="padding:3px 10px;font-size:11px;border-radius:4px;border:1px solid var(--border);background:var(--white);color:var(--muted);cursor:pointer">24m</button>
              <button class="chart-range-btn" data-months="999" style="padding:3px 10px;font-size:11px;border-radius:4px;border:1px solid var(--border);background:var(--white);color:var(--muted);cursor:pointer">All</button>
            </div>
          </div>
        </div>
        <div style="padding:8px 16px 4px;display:flex;gap:14px;align-items:center">
          <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)">
            <div style="width:20px;height:2px;background:var(--blue)"></div> Market price
          </div>
          <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)">
            <div style="width:8px;height:8px;border-radius:50%;background:#1a7a4a;border:2px solid #1a7a4a"></div> Forward sale
          </div>
          <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)">
            <div style="width:20px;height:0;border-top:2px dashed #b86e00"></div> Avg fwd price
          </div>
          <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)">
            <div style="width:20px;height:0;border-top:2px dashed #0f766e"></div> Budget
          </div>
        </div>
        <div style="padding:8px 16px 16px">
          <canvas id="price-chart" height="260"></canvas>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><h2>Recent prices</h2></div>
        <div id="mp-table-wrap">
          <div class="empty-state"><span class="loading-spinner"></span></div>
        </div>
      </div>
    </div>

    <!-- Hidden file input for Excel import -->
    <input type="file" id="excel-file-input" accept=".xlsx,.xls,.csv" style="display:none">
  `;

  container.querySelectorAll('.commodity-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      _selectedCommodityId = btn.dataset.id;
      // Update pill styles
      container.querySelectorAll('.commodity-pill').forEach(b => {
        const active = b.dataset.id === _selectedCommodityId;
        b.style.background = active ? 'var(--blue)' : 'var(--white)';
        b.style.color = active ? 'white' : 'var(--muted)';
        b.style.borderColor = active ? 'var(--blue)' : 'var(--border)';
      });
      // Update heading
      const commodities = getCommodities().filter(c => !c.is_livestock);
      const active = commodities.find(c => c.id === _selectedCommodityId);
      const heading = qs('#mp-commodity-heading', container);
      if (heading) heading.querySelector('h2').textContent = active?.name || '';
      await _loadData();
      _renderTable();
      _renderChart();
    });
  });

  if (canWrite()) {
    qs('#btn-add-price', container)?.addEventListener('click', () => _addPriceModal());
    qs('#btn-import-excel', container)?.addEventListener('click', () => {
      qs('#excel-file-input', container)?.click();
    });
    qs('#excel-file-input', container)?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) _importExcel(file);
      e.target.value = '';
    });
  }

  // Chart range buttons
  container.querySelectorAll('.chart-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _chartRange = parseInt(btn.dataset.months);
      container.querySelectorAll('.chart-range-btn').forEach(b => {
        const active = b.dataset.months === btn.dataset.months;
        b.style.background = active ? 'var(--blue)' : 'var(--white)';
        b.style.color = active ? 'white' : 'var(--muted)';
      });
      _renderChart();
    });
  });

  await _loadData();
  _renderTable();
  _renderChart();
}

let _budgetPrice = null;

async function _loadData() {
  if (!_selectedCommodityId) return;
  const farm = getActiveFarm();

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 3);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const season = currentSeason();

  // Get commodity name to find farm's grain site
  const commodities = getCommodities();
  const commodity = commodities.find(c => c.id === _selectedCommodityId);
  const grainSite = farm?.settings?.grainSites?.[commodity?.name] || null;

  // Update site/grade labels in UI
  const siteLabel = document.getElementById('mp-site-label');
  const gradeLabel = document.getElementById('mp-grade-label');
  const gradeMap = { Wheat: 'APW1', Barley: 'BAR1', Canola: 'CAN1', 'Faba Beans': 'FAB2', Lentils: 'NIPT1' };
  const grade = gradeMap[commodity?.name] || null;

  if (siteLabel) siteLabel.textContent = grainSite ? '· ' + grainSite : '';
  if (gradeLabel) gradeLabel.textContent = grade ? 'Grade: ' + grade + ' · Price history' : 'Price history';

  // Build query — filter by farm's grain site if available, otherwise show all
  let priceQuery = 'commodity_id=eq.' + _selectedCommodityId + '&price_date=gte.' + cutoffStr + '&select=*&order=price_date.asc';
  if (grainSite) priceQuery += '&region=eq.' + encodeURIComponent(grainSite);

  const queries = [
    dbSelect('market_prices', priceQuery),
  ];

  if (farm) {
    queries.push(
      dbSelect('forward_contracts',
        'farm_id=eq.' + farm.id + '&commodity_id=eq.' + _selectedCommodityId + '&select=*'
      ).catch(() => [])
    );
    queries.push(
      dbSelect('budgets',
        'farm_id=eq.' + farm.id + '&commodity_id=eq.' + _selectedCommodityId + '&season=eq.' + season + '&select=price'
      ).catch(() => [])
    );
  }

  const results = await Promise.all(queries);
  _prices = results[0] || [];
  _contracts = results[1] || [];
  const budgets = results[2] || [];
  const budgetsWithPrice = budgets.filter(b => b.price);
  _budgetPrice = budgetsWithPrice.length
    ? budgetsWithPrice.reduce((s, b) => s + parseFloat(b.price), 0) / budgetsWithPrice.length
    : null;
}

function _renderTable() {
  const wrap = qs('#mp-table-wrap');
  if (!wrap) return;

  setContent('#mp-count', `${_prices.length} entries`);

  if (!_prices.length) {
    wrap.innerHTML = `<div class="empty-state"><p>No prices yet.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div style="max-height:400px;overflow-y:auto">
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th class="num">Price</th>
            ${canWrite() ? '<th></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${[..._prices].reverse().slice(0, 50).map(p => `
            <tr>
              <td class="muted">${formatDate(p.price_date)}</td>
              <td class="num"><strong>${formatCurrency(p.price_per_unit, 2)}</strong></td>
              ${canWrite() ? `<td><button class="btn btn-ghost btn-sm" style="color:#DC2626" onclick="window.__cfmDeletePrice('${p.id}')">✕</button></td>` : ''}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function _renderChart() {
  const canvas = qs('#price-chart');
  if (!canvas) return;

  if (window.__cfmPriceChart) {
    window.__cfmPriceChart.destroy();
    window.__cfmPriceChart = null;
  }

  if (!_prices.length) return;

  // Filter by selected range
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - _chartRange);
  const sorted = _prices
    .filter(p => _chartRange >= 999 || new Date(p.price_date) >= cutoff)
    .sort((a, b) => new Date(a.price_date) - new Date(b.price_date));

  if (!sorted.length) return;

  const labels = sorted.map(p => p.price_date);
  const data = sorted.map(p => parseFloat(p.price_per_unit));

  // Build forward sale scatter points — match contract sale_date to nearest price date
  const saleDates = new Set(sorted.map(p => p.price_date));
  const salePoints = _contracts
    .filter(c => c.sale_date && c.price_per_unit)
    .map(c => {
      // Find closest price date to sale date
      const saleDate = c.sale_date.slice(0, 10);
      // Find index in labels
      let idx = labels.indexOf(saleDate);
      if (idx === -1) {
        // Find nearest date
        const target = new Date(saleDate).getTime();
        let minDiff = Infinity;
        labels.forEach((l, i) => {
          const diff = Math.abs(new Date(l).getTime() - target);
          if (diff < minDiff) { minDiff = diff; idx = i; }
        });
      }
      if (idx === -1) return null;
      return { x: labels[idx], y: parseFloat(c.price_per_unit), label: c.contract_number || 'Contract', qty: c.quantity, unit: c.unit };
    })
    .filter(Boolean);

  if (!window.Chart) {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
    script.onload = () => _drawChart(canvas, labels, data, salePoints);
    document.head.appendChild(script);
  } else {
    _drawChart(canvas, labels, data, salePoints);
  }
}

function _drawChart(canvas, labels, data, salePoints = []) {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const textColor = isDark ? '#9A9894' : '#6b7280';
  const gridColor = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';

  const datasets = [
    {
      label: 'Market price',
      data,
      borderColor: '#1e6fa8',
      backgroundColor: 'rgba(30,111,168,0.06)',
      borderWidth: 1.5,
      pointRadius: data.length > 120 ? 0 : 2,
      pointHoverRadius: 4,
      fill: true,
      tension: 0.2,
      order: 2,
    },
  ];

  // Average price line — avg of all forward contracts for this commodity
  if (salePoints.length) {
    const avgPrice = salePoints.reduce((s, p) => s + p.y, 0) / salePoints.length;
    const avgData = labels.map(() => parseFloat(avgPrice.toFixed(2)));

    datasets.push({
      label: 'Avg fwd price',
      data: avgData,
      borderColor: '#b86e00',
      borderWidth: 1.5,
      borderDash: [6, 4],
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: false,
      tension: 0,
      order: 3,
    });

    datasets.push({
      label: 'Forward sale',
      data: salePoints.map(s => ({ x: s.x, y: s.y })),
      type: 'scatter',
      backgroundColor: '#1a7a4a',
      borderColor: '#ffffff',
      borderWidth: 2,
      pointRadius: 7,
      pointHoverRadius: 9,
      pointStyle: 'circle',
      order: 1,
    });
  }

  // Inline plugin to draw avg price label at right edge of chart
  const avgLabelPlugin = {
    id: 'avgLabel',
    afterDatasetsDraw(chart) {
      const avgDs = chart.data.datasets.find(d => d.label === 'Avg fwd price');
      if (!avgDs || !avgDs.data.length) return;
      const avgVal = avgDs.data[0];
      const { ctx, chartArea, scales } = chart;
      const y = scales.y.getPixelForValue(avgVal);
      const x = chartArea.right + 4;
      ctx.save();
      ctx.fillStyle = '#b86e00';
      ctx.font = '500 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('$' + Math.round(avgVal), x, y);
      ctx.restore();
    }
  };

  // Budget price line
  if (_budgetPrice) {
    datasets.push({
      label: 'Budget',
      data: labels.map(() => _budgetPrice),
      borderColor: '#0f766e',
      borderWidth: 1.5,
      borderDash: [3, 3],
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: false,
      order: 4,
    });
  }

  // Combined end-label plugin for avg fwd AND budget
  const endLabelPlugin = {
    id: 'endLabels',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      [
        { label: 'Avg fwd price', color: '#b86e00' },
        { label: 'Budget', color: '#0f766e' },
      ].forEach(({ label, color }) => {
        const ds = chart.data.datasets.find(d => d.label === label);
        if (!ds || !ds.data.length) return;
        const y = scales.y.getPixelForValue(ds.data[0]);
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = '500 11px Inter, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('$' + Math.round(ds.data[0]), chartArea.right + 4, y);
        ctx.restore();
      });
    }
  };

  window.__cfmPriceChart = new window.Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    plugins: [endLabelPlugin],
    options: {
      layout: { padding: { right: 48 } },
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === 'Forward sale') {
                const pt = salePoints[ctx.dataIndex];
                return pt
                  ? pt.label + ': $' + ctx.parsed.y.toFixed(2) + (pt.qty ? ' — ' + pt.qty + ' ' + (pt.unit || '') : '')
                  : '$' + ctx.parsed.y.toFixed(2);
              }
              if (ctx.dataset.label === 'Avg fwd price') return 'Avg fwd: $' + ctx.parsed.y.toFixed(2);
              if (ctx.dataset.label === 'Budget') return 'Budget: $' + ctx.parsed.y.toFixed(2);
              return '$' + ctx.parsed.y.toFixed(2);
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: textColor,
            maxTicksLimit: 8,
            font: { size: 11 },
            callback: function(val, idx) {
              const label = this.getLabelForValue(val);
              if (!label) return '';
              const [yr, mo] = label.split('-');
              const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              return months[parseInt(mo) - 1] + ' ' + yr.slice(2);
            }
          },
          grid: { color: gridColor }
        },
        y: {
          ticks: {
            color: textColor,
            callback: v => `$${v.toFixed(0)}`,
            font: { size: 11 }
          },
          grid: { color: gridColor }
        }
      }
    }
  });
}

// ── Add price modal ───────────────────────────────────────────
function _addPriceModal() {
  openModal({
    title: 'Add market price',
    confirmLabel: 'Save',
    bodyHTML: `
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Date</label>
          <input class="form-input" id="mp-date" type="date" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="form-group">
          <label class="form-label">Price</label>
          <input class="form-input num" id="mp-price" type="number" step="0.01" placeholder="0.00">
        </div>
      </div>
    `,
    onConfirm: async (modal) => {
      const date = qs('#mp-date', modal)?.value;
      const price = parseFloat(qs('#mp-price', modal)?.value || 0);
      if (!date || !price) throw new Error('Please enter a date and price');

      await dbInsert('market_prices', {
        commodity_id: _selectedCommodityId,
        price_date: date,
        price_per_unit: price,
        created_by: getSession()?.user?.id,
      });
      toast('Price saved', 'success');
      await _loadData();
      _renderTable();
      _renderChart();
    },
  });
}

// ── Excel import ──────────────────────────────────────────────
async function _importExcel(file) {
  toast('Reading file…');

  try {
    // Load SheetJS
    if (!window.XLSX) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    const buffer = await file.arrayBuffer();
    // Read with raw numbers (dates come as Excel serial numbers)
    const workbook = window.XLSX.read(buffer, { type: 'array', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    // Get raw values
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });

    // Parse rows — col A: date, col B: price
    const entries = [];
    for (const row of rows) {
      if (row[0] === undefined || row[0] === null || row[0] === '') continue;
      if (row[1] === undefined || row[1] === null || row[1] === '') continue;

      // Parse date — handles Excel serial, DD/MM/YYYY, YYYY-MM-DD, D/M/YY
      let dateStr = null;
      const rawDate = row[0];

      if (typeof rawDate === 'number') {
        // Excel date serial number
        const excelEpoch = new Date(1899, 11, 30);
        const d = new Date(excelEpoch.getTime() + rawDate * 86400000);
        if (!isNaN(d)) dateStr = d.toISOString().slice(0, 10);
      } else if (typeof rawDate === 'string') {
        const s = rawDate.trim();
        // DD/MM/YYYY or D/M/YY or DD/MM/YY
        if (s.includes('/')) {
          const parts = s.split('/');
          if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const mon = parts[1].padStart(2, '0');
            let yr = parts[2];
            if (yr.length === 2) yr = parseInt(yr) > 50 ? '19' + yr : '20' + yr;
            const d = new Date(yr + '-' + mon + '-' + day);
            if (!isNaN(d)) dateStr = yr + '-' + mon + '-' + day;
          }
        } else if (s.includes('-')) {
          // YYYY-MM-DD or DD-MM-YYYY
          const parts = s.split('-');
          if (parts[0].length === 4) {
            dateStr = s; // already YYYY-MM-DD
          } else if (parts.length === 3) {
            const day = parts[0].padStart(2, '0');
            const mon = parts[1].padStart(2, '0');
            const yr = parts[2].length === 2 ? '20' + parts[2] : parts[2];
            dateStr = yr + '-' + mon + '-' + day;
          }
        } else if (s.length === 8 && !isNaN(s)) {
          // YYYYMMDD
          dateStr = s.slice(0,4) + '-' + s.slice(4,6) + '-' + s.slice(6,8);
        }
      }

      // Validate date
      if (dateStr) {
        const check = new Date(dateStr);
        if (isNaN(check) || check.getFullYear() < 2000 || check.getFullYear() > 2100) {
          dateStr = null;
        }
      }

      // Parse price — strip currency symbols, commas etc
      const priceRaw = typeof row[1] === 'number' ? row[1] : parseFloat(String(row[1]).replace(/[^0-9.]/g, ''));
      const price = parseFloat(priceRaw);

      if (dateStr && !isNaN(price) && price > 0) {
        entries.push({ date: dateStr, price });
      }
    }

    if (!entries.length) {
      toast('No valid rows found. Check column A = date, column B = price.', 'error');
      return;
    }

    // Show preview modal
    openModal({
      title: `Import ${entries.length} price entries`,
      confirmLabel: `Import ${entries.length} entries`,
      bodyHTML: `
        <p class="text-sm" style="margin-bottom:12px">Found <strong>${entries.length}</strong> entries from <strong>${formatDate(entries[0].date)}</strong> to <strong>${formatDate(entries[entries.length-1].date)}</strong>. Existing prices for the same dates will be skipped.</p>
        <div style="max-height:200px;overflow-y:auto">
          <table class="data-table">
            <thead><tr><th>Date</th><th class="num">Price</th></tr></thead>
            <tbody>
              ${entries.slice(0, 10).map(e => `
                <tr><td>${formatDate(e.date)}</td><td class="num">${formatCurrency(e.price, 2)}</td></tr>
              `).join('')}
              ${entries.length > 10 ? `<tr><td colspan="2" class="muted text-xs">…and ${entries.length - 10} more</td></tr>` : ''}
            </tbody>
          </table>
        </div>
      `,
      onConfirm: async () => {
        if (!_selectedCommodityId) throw new Error('No commodity selected — please select a commodity from the dropdown first');

        // Bulk upsert all rows at once
        const rows = entries.map(e => ({
          commodity_id: _selectedCommodityId,
          price_date: e.date,
          price_per_unit: e.price,
          created_by: getSession()?.user?.id,
        }));

        try {
          await dbUpsert('market_prices', rows);
          toast('Imported ' + rows.length + ' prices', 'success');
        } catch (err) {
          // Fall back to individual inserts if bulk fails
          let imported = 0;
          let skipped = 0;
          let lastError = null;
          for (const row of rows) {
            try {
              await dbInsert('market_prices', row);
              imported++;
            } catch (e) {
              lastError = e.message;
              skipped++;
            }
          }
          if (imported === 0) throw new Error('All inserts failed. Last error: ' + lastError);
          toast('Imported ' + imported + ' prices' + (skipped ? ', ' + skipped + ' skipped' : ''), 'success');
        }

        await _loadData();
        _renderTable();
        _renderChart();
      },
    });

  } catch (err) {
    console.error('Excel import error:', err);
    toast(`Import failed: ${err.message}`, 'error');
  }
}

// ── Delete ────────────────────────────────────────────────────
window.__cfmDeletePrice = async (id) => {
  await dbDelete('market_prices', id);
  toast('Price removed');
  await _loadData();
  _renderTable();
  _renderChart();
};