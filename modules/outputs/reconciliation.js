// modules/outputs/reconciliation.js
// Income Reconciliation — point-in-time position report for accounting

import { dbSelect } from '../../js/supabase-client.js?v=1783290066771';
import { getActiveFarm, getActiveSeason } from '../../js/app-state.js?v=1783290066771';
import { formatCurrency, formatNumber, formatDate, qs, currentSeason, toast } from '../../js/ui.js?v=1783290066771';
import { getCommodities } from '../../js/commodities.js?v=1783290066771';

export async function mountReconciliation(container) {
  const farm = getActiveFarm();
  if (!farm) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">

      <select id="rec-commodity" class="form-select" style="width:160px">
        <option value="">All commodities</option>
      </select>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="font-size:var(--text-sm);color:var(--muted)">As at</label>
        <input id="rec-date" class="form-input" type="date" value="${new Date().toISOString().slice(0,10)}" style="width:150px">
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="font-size:var(--text-sm);color:var(--muted)">Quality contingency</label>
        <input id="rec-contingency" class="form-input num" type="number" value="-5" step="0.1" style="width:70px">
        <span style="font-size:var(--text-sm);color:var(--muted)">%</span>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-secondary" id="btn-rec-refresh">Refresh</button>
        <button class="btn btn-primary" id="btn-rec-print"><i class="ti ti-printer" style="margin-right:4px" aria-hidden="true"></i>Print</button>
      </div>
    </div>
    <div id="rec-output">
      <div class="empty-state"><span class="loading-spinner"></span></div>
    </div>
  `;

  await _populateCommodities(container, farm.id, getActiveSeason() || currentSeason());
  await _renderReconciliation(container, farm);

  qs('#btn-rec-refresh', container)?.addEventListener('click', () => _renderReconciliation(container, farm));
  qs('#btn-rec-print', container)?.addEventListener('click', () => _print(container, farm));

  qs('#rec-commodity', container)?.addEventListener('change', () => _renderReconciliation(container, farm));
  window.addEventListener('cfm:seasonchange', async () => {
    await _populateCommodities(container, farm.id, getActiveSeason());
    await _renderReconciliation(container, farm);
  });
  qs('#rec-date', container)?.addEventListener('change', () => _renderReconciliation(container, farm));
  qs('#rec-contingency', container)?.addEventListener('change', () => _renderReconciliation(container, farm));
}

function _seasonOptions(selected) {
  const current = getActiveSeason() || currentSeason();
  const [y] = current.split('-').map(Number);
  return Array.from({ length: 5 }, (_, i) => {
    const s = `${y + 1 - i}-${String(y + 2 - i).slice(2)}`;
    return `<option value="${s}" ${s === selected ? 'selected' : ''}>${s}</option>`;
  }).join('');
}

async function _populateCommodities(container, farmId, season) {
  try {
    const budgets = await dbSelect('budgets', 'farm_id=eq.' + farmId + '&season=eq.' + season + '&select=commodity,commodity_id');
    const contracts = await dbSelect('forward_contracts', 'farm_id=eq.' + farmId + '&crop_year=eq.' + season + '&select=commodity,commodity_id');
    const seen = new Set();
    const commodities = [];
    [...budgets, ...contracts].forEach(r => {
      const key = r.commodity_id || r.commodity;
      if (key && !seen.has(key)) { seen.add(key); commodities.push({ id: r.commodity_id, name: r.commodity }); }
    });
    const sel = qs('#rec-commodity', container);
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    commodities.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id || c.name;
      o.textContent = c.name;
      sel.appendChild(o);
    });
  } catch {}
}

async function _renderReconciliation(container, farm) {
  const output = qs('#rec-output', container);
  if (!output) return;
  output.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';

  const season = getActiveSeason() || currentSeason();
  const asAt = qs('#rec-date', container)?.value || new Date().toISOString().slice(0, 10);
  const contingencyPct = parseFloat(qs('#rec-contingency', container)?.value || -5);
  const filterCommodity = qs('#rec-commodity', container)?.value || '';

  try {
    const [invoices, contracts, budgets, forecasts, prices] = await Promise.all([
      dbSelect('invoices', 'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.desc'),
      dbSelect('forward_contracts', 'farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&sale_date=lte.' + asAt + '&select=*'),
      dbSelect('budgets', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*'),
      dbSelect('forecasts', 'farm_id=eq.' + farm.id + '&season=eq.' + season + '&forecast_date=lte.' + asAt + '&select=*&order=forecast_date.desc'),
      dbSelect('market_prices', 'price_date=lte.' + asAt + '&select=commodity_id,price_per_unit,price_date&order=price_date.desc&limit=200'),
    ]);

    // Filter invoices to those on or before asAt date
    const paidInvoices = invoices.filter(i =>
      i.status === 'complete' &&
      i.invoice_date <= asAt &&
      (i.line_items || []).some(l => !l.season || l.season === season)
    );

    // Build commodity list from budgets + contracts
    const masterCommodities = getCommodities();
    const commMap = {};

    const addComm = (id, name) => {
      if (!id && !name) return;
      const key = id || name;
      if (!commMap[key]) {
        const master = masterCommodities.find(c => c.id === id || c.name === name);
        commMap[key] = { id: id || master?.id, name: name || master?.name || key, budgets: [], contracts: [], paidLines: [], forecasts: [] };
      }
    };

    budgets.forEach(b => { addComm(b.commodity_id, b.commodity); commMap[b.commodity_id || b.commodity]?.budgets.push(b); });
    contracts.forEach(c => { addComm(c.commodity_id, c.commodity); commMap[c.commodity_id || c.commodity]?.contracts.push(c); });
    forecasts.forEach(f => { addComm(f.commodity_id, f.commodity); commMap[f.commodity_id || f.commodity]?.forecasts.push(f); });

    // Match paid invoice lines to commodities
    paidInvoices.forEach(inv => {
      const lines = inv.line_items || [];
      lines.filter(l => !l.season || l.season === season).forEach(l => {
        const key = Object.keys(commMap).find(k => commMap[k].name === l.commodity || commMap[k].id === l.commodity_id);
        if (key) commMap[key].paidLines.push({ ...l, invoice: inv });
      });
    });

    // Latest market price per commodity (most recent by price_date)
    const latestPrices = {};
    // Sort by date desc so first occurrence is latest
    const sortedPrices = [...prices].sort((a, b) => b.price_date.localeCompare(a.price_date));
    sortedPrices.forEach(p => {
      if (p.commodity_id && !latestPrices[p.commodity_id]) {
        latestPrices[p.commodity_id] = parseFloat(p.price_per_unit);
      }
    });

    // Filter if specific commodity selected
    const commodities = Object.values(commMap).filter(c => {
      if (!filterCommodity) return true;
      return c.id === filterCommodity || c.name === filterCommodity;
    });

    if (!commodities.length) {
      output.innerHTML = '<div class="empty-state"><p>No data for selected season and commodity.</p></div>';
      return;
    }

    output.innerHTML = commodities.map(com => _buildCommSection(com, season, asAt, contingencyPct, latestPrices, farm)).join('');

  } catch (err) {
    output.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
    console.error(err);
  }
}

function _buildCommSection(com, season, asAt, contingencyPct, latestPrices, farm) {
  const marketPrice = latestPrices[com.id] || null;

  // Paid to date
  const paidLines = com.paidLines || [];
  const paidQty = paidLines.reduce((s, l) => s + (parseFloat(l.qty) || 0), 0);
  // l.total already includes quality adj - don't add it again
  const paidGross = paidLines.reduce((s, l) => s + (parseFloat(l.total)||0), 0);
  const paidAvgUnit = paidQty ? paidGross / paidQty : 0;

  // Contracted (not yet paid)
  const contracts = com.contracts || [];
  const contractedQty = contracts.reduce((s, c) => s + (parseFloat(c.quantity) || 0), 0);

  // How much of contracts already invoiced (paid)
  const alreadyPaidQty = paidQty;
  const contractedUnpaidQty = Math.max(0, contractedQty - alreadyPaidQty);

  // Forecast production
  const latestPerBudget = {};
  (com.forecasts || []).forEach(f => {
    const k = f.budget_id || 'default';
    if (!latestPerBudget[k] || f.forecast_date > latestPerBudget[k].forecast_date) latestPerBudget[k] = f;
  });
  const forecastProd = Object.values(latestPerBudget).reduce((s, f) =>
    s + (parseFloat(f.forecast_production) || (parseFloat(f.area_ha)||0) * (parseFloat(f.yield_per_ha)||0)), 0
  ) || com.budgets.reduce((s, b) => s + ((parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0)), 0);

  // Budget production
  const budgetProd = com.budgets.reduce((s, b) => s + (parseFloat(b.budgeted_production) || ((parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0))), 0);
  const denominator = forecastProd || budgetProd;

  // Unpriced = forecast - total contracted (not just unpaid contracts)
  const unit = com.contracts[0]?.unit || com.budgets[0]?.unit || 't';
  const totalContractedQty = contracts.reduce((s, c) => s + (parseFloat(c.quantity)||0), 0);
  const unpricedQty = Math.max(0, denominator - totalContractedQty);

  // Indicative price = market price × (1 + contingency%)
  const contingencyMultiplier = 1 + (contingencyPct / 100);
  const unpricedPrice = marketPrice ? marketPrice * contingencyMultiplier : null;
  const unpricedGross = (unpricedPrice != null && unpricedQty > 0) ? unpricedPrice * unpricedQty : null;

  // Contract rows — calculate per-contract invoiced qty
  const contractRows = contracts.map(c => {
    const contractedQtyTotal = parseFloat(c.quantity) || 0;
    const price = parseFloat(c.price_per_unit) || 0;
    // Find invoices against this specific contract
    const invoicedAgainstContract = paidLines
      .filter(l => l.invoice?.forward_contract_id === c.id)
      .reduce((s, l) => s + (parseFloat(l.qty) || 0), 0);
    const remainingQty = Math.max(0, contractedQtyTotal - invoicedAgainstContract);
    const gross = remainingQty * price;
    const pct = denominator ? (gross / (denominator * (unpricedPrice || price))) * 100 : 0;
    return { c, qty: remainingQty, contractedQty: contractedQtyTotal, invoicedQty: invoicedAgainstContract, price, gross, pct };
  });

  // Contracted balance = sum of remaining (unpaid) qty per contract
  const contractedRemainingQty = contractRows.reduce((s, r) => s + r.qty, 0);
  const contractedGross = contractRows.reduce((s, r) => s + r.gross, 0);
  const contractedAvgPriceCalc = contractedRemainingQty ? contractedGross / contractedRemainingQty : 0;
  const contractedAvgPrice = contractedQty ? contractedGross / contractedQty : 0;

  // Totals
  const totalGross = paidGross + contractedGross + (unpricedGross || 0);
  const totalQty = denominator || (paidQty + contractedQty);
  const avgPrice = totalQty ? totalGross / totalQty : 0;

  const pctOf = v => totalGross ? ((v / totalGross) * 100).toFixed(1) + '%' : '—';
  const fmtC = (v, dec=0) => v != null ? formatCurrency(v, dec) : '—';
  const fmtN = (v, dec=0) => v != null && !isNaN(v) ? formatNumber(v, dec) : '—';

  const budgetPrice = com.budgets[0]?.price ? parseFloat(com.budgets[0].price) : null;
  const budgetPriceStr = budgetPrice ? formatCurrency(budgetPrice, 0) + '/' + unit : '';

  return `
    <div class="card rec-section" style="margin-bottom:24px;overflow:hidden" data-commodity="${com.name}">

      <!-- Commodity header -->
      <div style="padding:10px 16px;background:var(--page-bg);border-bottom:2px solid var(--ink)">
        <div style="display:flex;align-items:baseline;gap:16px;flex-wrap:wrap">
          <span style="font-size:var(--text-md);font-weight:700;color:var(--ink)">${com.name}</span>
          ${forecastProd ? `<span style="font-size:var(--text-sm);color:var(--muted)">Forecast: <strong>${fmtN(forecastProd, 2)} ${unit}</strong></span>` : ''}
          ${contractedQty ? `<span style="font-size:var(--text-sm);color:var(--muted)">Contracted: <strong>${fmtN(contractedQty, 0)} ${unit}</strong></span>` : ''}
          ${marketPrice ? `<span style="font-size:var(--text-sm);color:var(--muted)">Market: <strong>${fmtC(marketPrice, 2)}/${unit}</strong></span>` : ''}
          ${budgetPriceStr ? `<span style="font-size:var(--text-sm);color:var(--muted)">Budget: <strong>${budgetPriceStr}</strong></span>` : ''}
        </div>
      </div>

      <!-- Table -->
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">
          <thead>
            <tr style="background:var(--page-bg)">
              <th style="${thStyle()}">Section</th>
              <th style="${thStyle()}">Detail</th>
              <th style="${thStyle('r')}">Units</th>
              <th style="${thStyle('r')}">$/unit</th>
              <th style="${thStyle('r')}">Gross $</th>
              <th style="${thStyle('r')}">Deductions</th>
              <th style="${thStyle('r')}">Net $</th>
              <th style="${thStyle('r')}">% Total</th>
            </tr>
          </thead>
          <tbody>

            <!-- PAID TO DATE -->
            <tr>
              <td colspan="8" style="${sectionHeaderStyle('#1a2535')}">
                <strong>Paid to date</strong>
                <span style="font-size:11px;font-weight:400;color:#9aacbf;margin-left:8px">(RCTIs &amp; cash sales on or before ${formatDate(asAt)})</span>
              </td>
            </tr>
            ${paidLines.length === 0 ? `
              <tr>
                <td colspan="8" style="padding:10px 16px;font-style:italic;color:var(--muted);border-bottom:1px solid var(--border-light)">
                  No payments recorded to ${formatDate(asAt)}
                </td>
              </tr>
            ` : paidLines.map(l => `
              <tr>
                <td style="${tdStyle()}"></td>
                <td style="${tdStyle()}">${l.invoice?.xero_invoice_number || l.invoice?.buyer || 'Invoice'} — ${l.docket || ''}</td>
                <td style="${tdStyle('r')}">${fmtN(l.qty, 0)} ${unit}</td>
                <td style="${tdStyle('r')}">${fmtC(l.price, 2)}</td>
                <td style="${tdStyle('r')}">${fmtC(l.total, 0)}</td>
                <td style="${tdStyle('r')}">—</td>
                <td style="${tdStyle('r')}">${fmtC(l.total, 0)}</td>
                <td style="${tdStyle('r')}">${pctOf(parseFloat(l.total)||0)}</td>
              </tr>
            `).join('')}
            ${paidLines.length > 0 ? `
              <tr style="background:var(--blue-light)">
                <td style="${tdStyle()}"></td>
                <td style="${tdStyle()}"><strong>Paid to date subtotal</strong></td>
                <td style="${tdStyle('r')}"><strong>${fmtN(paidQty, 2)} ${unit}</strong></td>
                <td style="${tdStyle('r')}"><strong>${fmtC(paidAvgUnit, 2)}</strong></td>
                <td style="${tdStyle('r')}"><strong>${fmtC(paidGross, 0)}</strong></td>
                <td style="${tdStyle('r')}">—</td>
                <td style="${tdStyle('r')}"><strong>${fmtC(paidGross, 0)}</strong></td>
                <td style="${tdStyle('r')}"><strong>${pctOf(paidGross)}</strong></td>
              </tr>
            ` : ''}

            <!-- CONTRACTED BALANCE -->
            <tr>
              <td colspan="8" style="${sectionHeaderStyle('#1a4a7a')}">
                <strong>Contracted balance</strong>
                <span style="font-size:11px;font-weight:400;color:#9aacbf;margin-left:8px">(committed, not yet paid)</span>
              </td>
            </tr>
            ${contracts.length === 0 ? `
              <tr><td colspan="8" style="padding:10px 16px;font-style:italic;color:var(--muted);border-bottom:1px solid var(--border-light)">No forward contracts</td></tr>
            ` : contractRows.map((row, i) => `
              <tr>
                <td style="${tdStyle()}">${String(i+1).padStart(2,'0')} · ${row.c.counterparty || row.c.buyer || 'Contract'}</td>
                <td style="${tdStyle()}">${row.c.contract_number || ''} — ${fmtN(row.contractedQty, 0)} ${unit} total${row.invoicedQty > 0 ? ' · ' + fmtN(row.invoicedQty, 0) + ' invoiced' : ''}</td>
                <td style="${tdStyle('r')}">${fmtN(row.qty, 0)} ${unit}</td>
                <td style="${tdStyle('r')}">${fmtC(row.price, 2)}</td>
                <td style="${tdStyle('r')}">${fmtC(row.gross, 0)}</td>
                <td style="${tdStyle('r')}">est.</td>
                <td style="${tdStyle('r')}">${fmtC(row.gross, 0)}</td>
                <td style="${tdStyle('r')}">${pctOf(row.gross)}</td>
              </tr>
            `).join('')}
            ${contracts.length > 0 ? `
              <tr style="background:var(--blue-light)">
                <td style="${tdStyle()}"></td>
                <td style="${tdStyle()}"><strong>Contracted balance subtotal</strong></td>
                <td style="${tdStyle('r')}"><strong>${fmtN(contractedRemainingQty, 2)} ${unit}</strong></td>
                <td style="${tdStyle('r')}"><strong>${fmtC(contractedAvgPriceCalc, 2)}</strong></td>
                <td style="${tdStyle('r')}"><strong>${fmtC(contractedGross, 0)}</strong></td>
                <td style="${tdStyle('r')}">est.</td>
                <td style="${tdStyle('r')}"><strong>${fmtC(contractedGross, 0)}</strong></td>
                <td style="${tdStyle('r')}"><strong>${pctOf(contractedGross)}</strong></td>
              </tr>
            ` : ''}

            <!-- UNPRICED -->
            <tr>
              <td colspan="8" style="${sectionHeaderStyle('#4a1a7a')}">
                <strong>Unpriced / Uncontracted</strong>
                <span style="font-size:11px;font-weight:400;color:#c9aaf0;margin-left:8px">(forecast balance × market price)</span>
              </td>
            </tr>
            ${unpricedQty <= 0 ? `
              <tr><td colspan="8" style="padding:10px 16px;font-style:italic;color:var(--muted);border-bottom:1px solid var(--border-light)">No unpriced balance</td></tr>
            ` : `
              <tr>
                <td style="${tdStyle()}"></td>
                <td style="${tdStyle()}">
                  Forecast balance ${fmtN(denominator, 2)} ${unit} forecast
                  ${contractedQty ? ` − ${fmtN(contractedQty, 0)} contracted` : ''}
                  <br><span style="font-size:11px;color:var(--muted)">
                    ${marketPrice ? `${fmtC(marketPrice,2)} mkt × ${contingencyPct}% contingency = ${fmtC(unpricedPrice||0,2)}` : 'No market price available'}
                  </span>
                </td>
                <td style="${tdStyle('r')}">${fmtN(unpricedQty, 2)} ${unit}</td>
                <td style="${tdStyle('r')}">${unpricedPrice ? fmtC(unpricedPrice, 2) : '—'}</td>
                <td style="${tdStyle('r')}">${unpricedGross ? fmtC(unpricedGross, 0) : '—'}</td>
                <td style="${tdStyle('r')}">indicative</td>
                <td style="${tdStyle('r')}">${unpricedGross ? fmtC(unpricedGross, 0) : '—'}</td>
                <td style="${tdStyle('r')}">${unpricedGross ? pctOf(unpricedGross) : '—'}</td>
              </tr>
              <tr style="background:var(--page-bg)">
                <td style="${tdStyle()}"></td>
                <td style="${tdStyle()}"><strong>Unpriced subtotal (incl. contingency)</strong></td>
                <td style="${tdStyle('r')}"><strong>${fmtN(unpricedQty, 2)} ${unit}</strong></td>
                <td style="${tdStyle('r')}"><strong>${unpricedPrice ? fmtC(unpricedPrice, 2) : '—'}</strong></td>
                <td style="${tdStyle('r')}"><strong>${unpricedGross ? fmtC(unpricedGross, 0) : '—'}</strong></td>
                <td style="${tdStyle('r')}">indicative</td>
                <td style="${tdStyle('r')}"><strong>${unpricedGross ? fmtC(unpricedGross, 0) : '—'}</strong></td>
                <td style="${tdStyle('r')}"><strong>${unpricedGross ? pctOf(unpricedGross) : '—'}</strong></td>
              </tr>
            `}

            <!-- TOTAL -->
            <tr style="background:var(--ink);color:white">
              <td style="padding:10px 16px;font-weight:700;font-size:var(--text-sm)" colspan="2">
                ${com.name} — Total Season Position
              </td>
              <td style="padding:10px 16px;text-align:right;font-weight:700;font-family:inherit">${fmtN(totalQty, 2)} ${unit}</td>
              <td style="padding:10px 16px;text-align:right;font-size:11px;color:#aab;font-family:inherit">avg ${fmtC(avgPrice, 2)}</td>
              <td style="padding:10px 16px;text-align:right;font-weight:700;font-family:inherit">${fmtC(totalGross, 0)}</td>
              <td style="padding:10px 16px;text-align:right;color:#aab"></td>
              <td style="padding:10px 16px;text-align:right;font-weight:700;font-family:inherit">${fmtC(totalGross, 0)}</td>
              <td style="padding:10px 16px;text-align:right;font-weight:700">100%</td>
            </tr>

          </tbody>
        </table>
      </div>

      <!-- Footer notes -->
      <div style="padding:10px 16px;border-top:1px solid var(--border-light);background:var(--page-bg)">
        <p style="font-size:11px;color:var(--hint);line-height:1.5">
          Deductions from RCTI records only. Contracted balance deductions estimated.
          Unpriced crop is indicative at ${formatDate(asAt)} market price.
          ${contingencyPct !== 0 ? `Quality contingency of ${contingencyPct}% applied to unpriced value only.` : ''}
        </p>
      </div>
    </div>
  `;
}

function thStyle(align = 'l') {
  return `padding:7px 12px;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:400;text-align:${align === 'r' ? 'right' : 'left'};border-bottom:1px solid var(--border);white-space:nowrap`;
}

function tdStyle(align = 'l') {
  return `padding:7px 12px;border-bottom:0.5px solid var(--border-light);vertical-align:top;text-align:${align === 'r' ? 'right' : 'left'};font-family:inherit;font-size:var(--text-sm)`;
}

function sectionHeaderStyle(bg) {
  return `padding:8px 16px;background:${bg};color:white;font-size:var(--text-sm)`;
}

function _print(container, farm) {
  const season = getActiveSeason() || currentSeason();
  const asAt = qs('#rec-date', container)?.value || new Date().toISOString().slice(0, 10);
  const contingency = qs('#rec-contingency', container)?.value || '-5';
  const content = qs('#rec-output', container)?.innerHTML || '';

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Income Reconciliation — ${farm.name}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; font-size: 11px; color: #1a1a1a; padding: 20px; }
        h1 { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
        .meta { font-size: 11px; color: #666; margin-bottom: 20px; }
        .rec-section { margin-bottom: 24px; border: 1px solid #ccc; border-radius: 4px; overflow: hidden; page-break-inside: avoid; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th { padding: 5px 8px; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; color: #666; border-bottom: 1px solid #ccc; text-align: left; background: #f5f5f5; }
        th:not(:first-child):not(:nth-child(2)) { text-align: right; }
        td { padding: 5px 8px; border-bottom: 0.5px solid #eee; vertical-align: top; }
        td:not(:first-child):not(:nth-child(2)) { text-align: right;  }
        .card { display: block; }
        .form-select, .form-input, .btn, #btn-rec-refresh, #btn-rec-print, .loading-spinner { display: none !important; }
        [style*="background:var(--page-bg)"] { background: #f8f8f8 !important; }
        [style*="background:var(--blue-light)"] { background: #eaf2fb !important; }
        [style*="background:var(--ink)"] { background: #1a2535 !important; color: white !important; }
        .empty-state { display: none; }
        @media print {
          body { padding: 10px; }
          .rec-section { page-break-inside: avoid; }
        }
        .logo { font-size: 13px; font-weight: 600; color: #1a2535; margin-bottom: 12px; }
      </style>
    </head>
    <body>
      <div class="logo">Customised Farm Management Pty Ltd</div>
      <h1>Income Reconciliation — ${farm.name}</h1>
      <p class="meta">${farm.name} · ${season} · As at ${new Date(asAt).toLocaleDateString('en-AU', {day:'numeric',month:'long',year:'numeric'})} · ${contingency}% quality contingency on unpriced crop</p>
      ${content}
      <script>window.onload = () => { window.print(); }<\/script>
    </body>
    </html>
  `);
  win.document.close();
}

export function unmountReconciliation() {}