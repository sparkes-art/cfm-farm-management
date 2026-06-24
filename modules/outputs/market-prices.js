// modules/outputs/market-prices.js
// Manual market price entry + Excel import (col A: date, col B: price)
// Price history chart per commodity
 
import { dbSelect, dbInsert, dbDelete, dbUpsert } from '../../js/supabase-client.js';
import { getSession, canWrite } from '../../js/app-state.js';
import { loadCommodities, getCommodities, commodityOptions } from '../../js/commodities.js';
import { toast, openModal, formatCurrency, formatDate, qs, setContent, currentSeason } from '../../js/ui.js';
 
let _prices = [];
let _selectedCommodityId = null;
 
export async function mountMarketPrices(container) {
  await loadCommodities();
  const commodities = getCommodities().filter(c => !c.is_livestock);
 
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
      <h2 style="font-size:var(--text-lg);font-weight:600;color:var(--ink)">${activeCommodity?.name || ''}</h2>
      <p class="page-subtitle">Price history</p>
    </div>
 
    <div style="display:grid;grid-template-columns:1fr 320px;gap:20px">
      <div class="card">
        <div class="card-header">
          <h2>Price history</h2>
          <span id="mp-count" class="text-muted text-sm"></span>
        </div>
        <div style="padding:16px">
          <canvas id="price-chart" height="280"></canvas>
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
 
  await _loadData();
  _renderTable();
  _renderChart();
}
 
async function _loadData() {
  if (!_selectedCommodityId) return;
  _prices = await dbSelect('market_prices',
    `commodity_id=eq.${_selectedCommodityId}&select=*&order=price_date.desc&limit=365`
  );
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
          ${_prices.slice(0, 50).map(p => `
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
 
  // Destroy existing chart
  if (window.__cfmPriceChart) {
    window.__cfmPriceChart.destroy();
    window.__cfmPriceChart = null;
  }
 
  if (!_prices.length) return;
 
  const sorted = [..._prices].sort((a, b) => new Date(a.price_date) - new Date(b.price_date));
  const labels = sorted.map(p => formatDate(p.price_date));
  const data = sorted.map(p => parseFloat(p.price_per_unit));
 
  // Load Chart.js if not already loaded
  if (!window.Chart) {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
    script.onload = () => _drawChart(canvas, labels, data);
    document.head.appendChild(script);
  } else {
    _drawChart(canvas, labels, data);
  }
}
 
function _drawChart(canvas, labels, data) {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const textColor = isDark ? '#9A9894' : '#8C8680';
  const gridColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
 
  window.__cfmPriceChart = new window.Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: '#2C5282',
        backgroundColor: 'rgba(44,82,130,0.08)',
        borderWidth: 1.5,
        pointRadius: data.length > 60 ? 0 : 3,
        pointHoverRadius: 5,
        fill: true,
        tension: 0.2,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => '$' + ctx.parsed.y.toFixed(2)
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: textColor,
            maxTicksLimit: 8,
            font: { size: 11 }
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