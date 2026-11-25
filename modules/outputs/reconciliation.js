// modules/outputs/reconciliation.js
// Income Reconciliation — point-in-time position report for accounting

import { dbSelect } from '../../js/supabase-client.js?v=1794969436166';
import { getActiveFarm, getActiveSeason } from '../../js/app-state.js?v=1794969436166';
import { formatCurrency, formatNumber, formatDate, qs, currentSeason, toast } from '../../js/ui.js?v=1794969436166';
import { getCommodities } from '../../js/commodities.js?v=1794969436166';

// Per-commodity on-hand prices entered by user (session-only, not persisted)
const _onHandPrices = {};

export async function mountReconciliation(container) {
  const farm = getActiveFarm();
  if (!farm) return;

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:6px">
        <label style="font-size:var(--text-sm);color:var(--muted);font-weight:600">As at</label>
        <input id="rec-date" class="form-input" type="date" value="${new Date().toISOString().slice(0,10)}" style="width:150px">
      </div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-secondary" id="btn-rec-refresh">↻ Refresh</button>
        <button class="btn btn-primary" id="btn-rec-print">🖨 Print</button>
      </div>
    </div>
    <div id="rec-output">
      <div class="empty-state"><span class="loading-spinner"></span></div>
    </div>
  `;

  await _renderReconciliation(container, farm);

  qs('#btn-rec-refresh', container)?.addEventListener('click', () => _renderReconciliation(container, farm));
  qs('#btn-rec-print',   container)?.addEventListener('click', () => _print(container, farm));
  qs('#rec-date',        container)?.addEventListener('change', () => _renderReconciliation(container, farm));
  document.addEventListener('cfm:seasonchange', () => _renderReconciliation(container, farm));
}

async function _renderReconciliation(container, farm) {
  const output = qs('#rec-output', container);
  if (!output) return;
  output.innerHTML = '<div class="empty-state"><span class="loading-spinner"></span></div>';

  const season = getActiveSeason() || currentSeason();
  const asAt   = qs('#rec-date', container)?.value || new Date().toISOString().slice(0, 10);

  // Season date range
  const ym = parseInt(farm?.settings?.yearStartMonth || 7);
  const [sy] = season.split('-').map(Number);
  const mm = String(ym).padStart(2, '0');
  const seasonStart = `${sy}-${mm}-01`;
  const seasonEnd   = `${sy + 1}-${mm}-01`;

  try {
    const [invoices, contracts, mgmtIncome, mgmtCropTypes, harvestRecords] = await Promise.all([
      dbSelect('invoices',         'farm_id=eq.' + farm.id + '&select=*&order=invoice_date.asc'),
      dbSelect('forward_contracts','farm_id=eq.' + farm.id + '&crop_year=eq.' + season + '&select=*&order=sale_date.asc'),
      dbSelect('mgmt_income',      'farm_id=eq.' + farm.id + '&season=eq.' + season + '&section=eq.farming&select=*&order=sort_order.asc,created_at.asc').catch(() => []),
      dbSelect('mgmt_crop_types',  'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*&order=sort_order.asc,created_at.asc').catch(() => []),
      dbSelect('harvest_records',  'farm_id=eq.' + farm.id + '&season=eq.' + season + '&select=*').catch(() => []),
    ]);

    // ── Filter invoices to this season ──────────────────────────────────────
    const seasonInvoices = invoices.filter(i => {
      if (i.invoice_date > asAt) return false;
      const d = i.invoice_date?.slice(0, 10) || '';
      const dateInSeason = d >= seasonStart && d < seasonEnd;
      if (dateInSeason) return true;
      if (i.batches && i.batches.length) {
        const b = typeof i.batches === 'string' ? JSON.parse(i.batches) : i.batches;
        if (b.some(batch => batch.crop_year === season)) return true;
      }
      return (i.line_items || []).some(l => l.season === season);
    });

    const completeInvoices = seasonInvoices.filter(i => i.status === 'complete');
    const contractInvoices = completeInvoices.filter(i => i.sale_type === 'against_contract');
    const cashInvoices     = completeInvoices.filter(i => i.sale_type === 'cash');
    const seedInvoices     = completeInvoices.filter(i => i.sale_type === 'seed_transfer');

    // ── Build commodity list from mgmt_income (farming section) ─────────────
    // Fall back to contracts if mgmt_income is empty
    const commNames = new Set();
    mgmtIncome.forEach(r => commNames.add(r.name));
    contracts.forEach(c => commNames.add(c.commodity));

    if (!commNames.size) {
      output.innerHTML = '<div class="empty-state"><p>No commodities found for this season. Set up farming income rows in the Management Report first.</p></div>';
      return;
    }

    // ── Helper: extract batch lines from an invoice for a given commodity ───
    function batchLinesForComm(inv, commName) {
      const results = [];
      if (inv.batches && inv.batches.length) {
        const batches = typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches;
        batches.forEach(b => {
          const bCropYear = b.crop_year || '';
          if (bCropYear && bCropYear !== season) return;
          const saleLines = (b.lines || []).filter(l => l.type === 'income' && l.line_type !== 'qa');
          if (!saleLines.length) return;
          const lineCommodity = saleLines[0]?.description || inv.commodity_type || '';
          if (commName && lineCommodity.trim().toLowerCase() !== commName.trim().toLowerCase()) return;
          const qty   = parseFloat(b.qty) || 0;
          const gross = saleLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
          // Also capture QA lines
          const qaLines = (b.lines || []).filter(l => l.type === 'income' && l.line_type === 'qa');
          const qa = qaLines.reduce((s, l) => s + (parseFloat(l.amount) || 0), 0);
          results.push({ qty, gross, qa, total: gross + qa, docket: b.income_docket || '', inv });
        });
      } else {
        // Legacy line_items
        (inv.line_items || []).forEach(l => {
          if (l.type === 'expense') return;
          if (!l.season || l.season !== season) return;
          if (commName && (l.commodity||'').trim().toLowerCase() !== commName.trim().toLowerCase()) return;
          const qty   = parseFloat(l.qty)   || 0;
          const gross = l.line_type === 'qa' ? 0 : (parseFloat(l.total) || 0);
          const qa    = l.line_type === 'qa' ? (parseFloat(l.total) || 0) : 0;
          results.push({ qty, gross, qa, total: gross + qa, docket: l.docket || '', inv });
        });
      }
      return results;
    }

    // ── Render all commodity sections ────────────────────────────────────────
    const sections = [...commNames].map(commName => {
      const incomeRow  = mgmtIncome.find(r => r.name.trim().toLowerCase() === commName.trim().toLowerCase());
      const cropTypes  = incomeRow ? mgmtCropTypes.filter(ct => ct.income_id === incomeRow.id) : [];
      const harvests   = harvestRecords.filter(h => h.commodity.trim().toLowerCase() === commName.trim().toLowerCase());
      const unit       = incomeRow?.unit || contracts.find(c => c.commodity === commName)?.unit || 't';
      const commContracts = contracts.filter(c => c.commodity.trim().toLowerCase() === commName.trim().toLowerCase());

      // Contract invoices for this commodity
      const commContractInvs = contractInvoices.filter(inv =>
        batchLinesForComm(inv, commName).length > 0
      );
      // Cash invoices for this commodity
      const commCashInvs = cashInvoices.filter(inv =>
        batchLinesForComm(inv, commName).length > 0
      );
      // Seed transfer invoices for this commodity
      const commSeedInvs = seedInvoices.filter(inv =>
        batchLinesForComm(inv, commName).length > 0
      );

      return _buildCommSection({
        commName, unit, incomeRow, cropTypes, harvests,
        contracts: commContracts,
        contractInvs: commContractInvs,
        cashInvs: commCashInvs,
        seedInvs: commSeedInvs,
        season, asAt,
        batchLinesForComm,
      });
    });

    const asAtFmt = new Date(asAt + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    output.innerHTML = `
      <div style="margin-bottom:20px;padding:12px 16px;background:var(--page-bg);border-radius:var(--radius-md);border:1px solid var(--border)">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);margin-bottom:4px">Reconciliation date</div>
        <div style="font-size:17px;font-weight:700;color:var(--ink)">${farm.name} · ${season} · As at ${asAtFmt}</div>
        <div style="font-size:11px;color:var(--hint);margin-top:4px">All figures are as at this date — invoices dated after this date are excluded. Only completed invoices are included.</div>
      </div>
      ${sections.join('')}
    `;

    // Wire up on-hand price inputs after render
    output.querySelectorAll('.rec-onhand-price').forEach(input => {
      input.addEventListener('change', () => {
        const comm = input.dataset.comm;
        _onHandPrices[comm] = parseFloat(input.value) || 0;
        _updateOnHandRow(output, comm);
      });
    });

  } catch (err) {
    output.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
    console.error('[Rec]', err);
  }
}

function _buildCommSection({ commName, unit, incomeRow, cropTypes, harvests, contracts, contractInvs, cashInvs, seedInvs, season, asAt, batchLinesForComm }) {
  const fC  = (v, d=0) => v != null && !isNaN(v) ? formatCurrency(v, d) : '—';
  const fN  = (v, d=2) => v != null && !isNaN(v) ? formatNumber(v, d) : '—';
  const fN0 = (v)      => fN(v, 0);
  const fN1 = (v)      => fN(v, 1);
  const fNd = (v, d)   => fN(v, d);

  // ── PRODUCTION ──────────────────────────────────────────────────────────
  // Budget: from mgmt_crop_types (area_ha × budget_yield or budget_production)
  // Harvested: from harvest_records
  const prodRows = cropTypes.map(ct => {
    const budgetQty = ct.budget_production || (ct.area_ha && ct.budget_yield ? ct.area_ha * ct.budget_yield : null);
    const hr = harvests.find(h => h.crop_type?.trim().toLowerCase() === ct.crop_type?.trim().toLowerCase());
    const harvestedQty = hr ? parseFloat(hr.harvested_qty) : null;
    const yieldPerHa = (harvestedQty != null && ct.area_ha) ? harvestedQty / ct.area_ha : null;
    return { cropType: ct.crop_type, areaHa: ct.area_ha, budgetQty, harvestedQty, yieldPerHa };
  });

  // If no crop types in mgmt but we have harvest records, build rows from harvests
  if (!prodRows.length && harvests.length) {
    harvests.forEach(h => {
      prodRows.push({
        cropType: h.crop_type,
        areaHa: null,
        budgetQty: null,
        harvestedQty: parseFloat(h.harvested_qty),
        yieldPerHa: null,
      });
    });
  }

  const totalAreaHa     = prodRows.reduce((s, r) => s + (r.areaHa || 0), 0);
  const totalBudgetQty  = prodRows.reduce((s, r) => s + (r.budgetQty || 0), 0);
  const totalHarvestedQty = prodRows.reduce((s, r) => s + (r.harvestedQty || 0), 0);
  const totalYieldPerHa = totalAreaHa ? totalHarvestedQty / totalAreaHa : null;
  const hasProduction   = prodRows.length > 0;

  const productionHtml = hasProduction ? `
    <div class="rec-sub-header">Production</div>
    <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">
      <thead>
        <tr style="background:var(--page-bg)">
          <th style="${thL()}">Crop Type</th>
          <th style="${thR()}">Area (ha)</th>
          <th style="${thR()}">Budget (${unit})</th>
          <th style="${thR()}">Harvested (${unit})</th>
          <th style="${thR()}">${unit}/ha</th>
        </tr>
      </thead>
      <tbody>
        ${prodRows.map(r => `
          <tr>
            <td style="${tdL()}">${r.cropType || '—'}</td>
            <td style="${tdR()}">${r.areaHa != null ? fN1(r.areaHa) : '—'}</td>
            <td style="${tdR()}">${r.budgetQty != null ? fN1(r.budgetQty) : '—'}</td>
            <td style="${tdR()}" class="${r.harvestedQty != null ? 'rec-val-strong' : 'rec-val-empty'}">${r.harvestedQty != null ? fN1(r.harvestedQty) : '—'}</td>
            <td style="${tdR()}">${r.yieldPerHa != null ? fNd(r.yieldPerHa, 2) : '—'}</td>
          </tr>`).join('')}
        ${prodRows.length > 1 ? `
          <tr class="rec-total-row">
            <td style="${tdL()}"><strong>Total</strong></td>
            <td style="${tdR()}"><strong>${totalAreaHa ? fN1(totalAreaHa) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totalBudgetQty ? fN1(totalBudgetQty) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totalHarvestedQty ? fN1(totalHarvestedQty) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totalYieldPerHa != null ? fNd(totalYieldPerHa, 2) : '—'}</strong></td>
          </tr>` : ''}
      </tbody>
    </table>
  ` : '';

  // ── SOLD AGAINST CONTRACT ───────────────────────────────────────────────
  // Per-contract rows: contracted tonnes, delivered tonnes (from invoices),
  // paid amount (from complete invoices), implied avg $/unit
  // Still to go: only shown if contract not marked complete
  const contractRows = contracts.map(c => {
    const contractedQty = parseFloat(c.quantity) || 0;
    const price         = parseFloat(c.price_per_unit) || 0;
    const contractValue = contractedQty * price;

    // Find complete invoices against this contract
    const againstThis = contractInvs.filter(inv => inv.forward_contract_id === c.id);
    const deliveredLines = againstThis.flatMap(inv => batchLinesForComm(inv, commName));
    const deliveredQty   = deliveredLines.reduce((s, l) => s + l.qty, 0);
    const paidTotal      = deliveredLines.reduce((s, l) => s + l.total, 0); // gross + qa
    const impliedAvg     = deliveredQty ? paidTotal / deliveredQty : null;

    // Still to go
    const isComplete     = c.is_complete && (!c.completed_at || c.completed_at.slice(0,10) <= asAt);
    const stillToGoQty   = isComplete ? 0 : Math.max(0, contractedQty - deliveredQty);
    const stillToGoValue = stillToGoQty * price;

    return { c, contractedQty, price, contractValue, deliveredQty, paidTotal, impliedAvg, isComplete, stillToGoQty, stillToGoValue };
  });

  const totContractedQty  = contractRows.reduce((s, r) => s + r.contractedQty, 0);
  const totContractValue  = contractRows.reduce((s, r) => s + r.contractValue, 0);
  const totDeliveredQty   = contractRows.reduce((s, r) => s + r.deliveredQty, 0);
  const totPaidTotal      = contractRows.reduce((s, r) => s + r.paidTotal, 0);
  const totStillToGoQty   = contractRows.reduce((s, r) => s + r.stillToGoQty, 0);
  const totStillToGoValue = contractRows.reduce((s, r) => s + r.stillToGoValue, 0);
  const totImpliedAvg     = totDeliveredQty ? totPaidTotal / totDeliveredQty : null;

  const contractHtml = `
    <div class="rec-sub-header">Sold Against Contract</div>
    <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">
      <thead>
        <tr style="background:var(--page-bg)">
          <th style="${thL()}">Contract #</th>
          <th style="${thL()}">Buyer</th>
          <th style="${thR()}">Contracted (${unit})</th>
          <th style="${thR()}">Delivered (${unit})</th>
          <th style="${thR()}">Paid ($)</th>
          <th style="${thR()}">Avg $/unit</th>
          <th style="${thR()}">Still to go (${unit})</th>
          <th style="${thR()}">Still to go ($)</th>
        </tr>
      </thead>
      <tbody>
        ${contracts.length === 0 ? `
          <tr><td colspan="8" style="${emptyCell()}">No forward contracts for this season</td></tr>
        ` : contractRows.map(r => `
          <tr>
            <td style="${tdL()}"><strong>${r.c.contract_number || '—'}</strong></td>
            <td style="${tdL()}">${r.c.counterparty || r.c.buyer || '—'}</td>
            <td style="${tdR()}">${fN1(r.contractedQty)}</td>
            <td style="${tdR()}">${r.deliveredQty ? fN1(r.deliveredQty) : '—'}</td>
            <td style="${tdR()}">${r.paidTotal ? fC(r.paidTotal, 0) : '—'}</td>
            <td style="${tdR()}">${r.impliedAvg != null ? fC(r.impliedAvg, 1) : '—'}</td>
            <td style="${tdR()}" class="${!r.isComplete && r.stillToGoQty > 0 ? 'rec-amber' : ''}">
              ${r.isComplete ? '<span class="rec-complete-badge">✓ Complete</span>' : r.stillToGoQty > 0 ? fN1(r.stillToGoQty) : '—'}
            </td>
            <td style="${tdR()}">${r.isComplete ? '—' : r.stillToGoValue > 0 ? fC(r.stillToGoValue, 0) : '—'}</td>
          </tr>`).join('')}
        ${contracts.length > 0 ? `
          <tr class="rec-subtotal-row">
            <td style="${tdL()}" colspan="2"><strong>Subtotal — Contracts</strong></td>
            <td style="${tdR()}"><strong>${fN1(totContractedQty)}</strong></td>
            <td style="${tdR()}"><strong>${totDeliveredQty ? fN1(totDeliveredQty) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totPaidTotal ? fC(totPaidTotal, 0) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totImpliedAvg != null ? fC(totImpliedAvg, 1) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totStillToGoQty > 0 ? fN1(totStillToGoQty) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totStillToGoValue > 0 ? fC(totStillToGoValue, 0) : '—'}</strong></td>
          </tr>` : ''}
      </tbody>
    </table>
  `;

  // ── CASH SALES ──────────────────────────────────────────────────────────
  // Each invoice = one row; show invoice date, buyer, qty, gross, qa, total, avg price
  const cashRows = cashInvs.map(inv => {
    const lines   = batchLinesForComm(inv, commName);
    const qty     = lines.reduce((s, l) => s + l.qty,   0);
    const gross   = lines.reduce((s, l) => s + l.gross, 0);
    const qa      = lines.reduce((s, l) => s + l.qa,    0);
    const total   = gross + qa;
    const avgUnit = qty ? total / qty : null;
    return { inv, qty, gross, qa, total, avgUnit };
  }).filter(r => r.qty > 0 || r.total !== 0);

  const totCashQty   = cashRows.reduce((s, r) => s + r.qty,   0);
  const totCashGross = cashRows.reduce((s, r) => s + r.gross, 0);
  const totCashQa    = cashRows.reduce((s, r) => s + r.qa,    0);
  const totCashTotal = cashRows.reduce((s, r) => s + r.total, 0);
  const totCashAvg   = totCashQty ? totCashTotal / totCashQty : null;

  const cashHtml = `
    <div class="rec-sub-header">Cash Sales</div>
    <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">
      <thead>
        <tr style="background:var(--page-bg)">
          <th style="${thL()}">Date</th>
          <th style="${thL()}">Invoice #</th>
          <th style="${thL()}">Buyer</th>
          <th style="${thR()}">Qty (${unit})</th>
          <th style="${thR()}">Gross ($)</th>
          <th style="${thR()}">Adj ($)</th>
          <th style="${thR()}">Total ($)</th>
          <th style="${thR()}">Avg $/unit</th>
        </tr>
      </thead>
      <tbody>
        ${cashRows.length === 0 ? `
          <tr><td colspan="8" style="${emptyCell()}">No cash sales for this season</td></tr>
        ` : cashRows.map(r => `
          <tr>
            <td style="${tdL()}">${r.inv.invoice_date ? new Date(r.inv.invoice_date + 'T00:00:00').toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' }) : '—'}</td>
            <td style="${tdL()}">${r.inv.invoice_number || r.inv.id?.slice(0,8) || '—'}</td>
            <td style="${tdL()}">${r.inv.buyer || '—'}</td>
            <td style="${tdR()}">${fN1(r.qty)}</td>
            <td style="${tdR()}">${r.gross ? fC(r.gross, 0) : '—'}</td>
            <td style="${tdR()}" class="${r.qa < 0 ? 'rec-amber' : ''}">${r.qa ? fC(r.qa, 0) : '—'}</td>
            <td style="${tdR()}">${r.total ? fC(r.total, 0) : '—'}</td>
            <td style="${tdR()}">${r.avgUnit != null ? fC(r.avgUnit, 1) : '—'}</td>
          </tr>`).join('')}
        ${cashRows.length > 0 ? `
          <tr class="rec-subtotal-row">
            <td style="${tdL()}" colspan="3"><strong>Subtotal — Cash sales</strong></td>
            <td style="${tdR()}"><strong>${fN1(totCashQty)}</strong></td>
            <td style="${tdR()}"><strong>${totCashGross ? fC(totCashGross, 0) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totCashQa ? fC(totCashQa, 0) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totCashTotal ? fC(totCashTotal, 0) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totCashAvg != null ? fC(totCashAvg, 1) : '—'}</strong></td>
          </tr>` : ''}
      </tbody>
    </table>
  `;

  // ── SEED SALES / TRANSFERS ──────────────────────────────────────────────
  const seedRows = seedInvs.map(inv => {
    const lines  = batchLinesForComm(inv, commName);
    const qty    = lines.reduce((s, l) => s + l.qty,   0);
    const total  = lines.reduce((s, l) => s + l.total, 0);
    const avgUnit = qty ? total / qty : null;
    return { inv, qty, total, avgUnit };
  }).filter(r => r.qty > 0 || r.total !== 0);

  const totSeedQty   = seedRows.reduce((s, r) => s + r.qty,   0);
  const totSeedTotal = seedRows.reduce((s, r) => s + r.total, 0);
  const totSeedAvg   = totSeedQty ? totSeedTotal / totSeedQty : null;

  const seedHtml = `
    <div class="rec-sub-header">Seed Sales / Transfers</div>
    <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">
      <thead>
        <tr style="background:var(--page-bg)">
          <th style="${thL()}">Date</th>
          <th style="${thL()}">Reference</th>
          <th style="${thR()}">Qty (${unit})</th>
          <th style="${thR()}">Value ($)</th>
          <th style="${thR()}">Avg $/unit</th>
        </tr>
      </thead>
      <tbody>
        ${seedRows.length === 0 ? `
          <tr><td colspan="5" style="${emptyCell()}">No seed sales or transfers</td></tr>
        ` : seedRows.map(r => `
          <tr>
            <td style="${tdL()}">${r.inv.invoice_date ? new Date(r.inv.invoice_date + 'T00:00:00').toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' }) : '—'}</td>
            <td style="${tdL()}">${r.inv.invoice_number || r.inv.buyer || r.inv.id?.slice(0,8) || '—'}</td>
            <td style="${tdR()}">${fN1(r.qty)}</td>
            <td style="${tdR()}">${r.total ? fC(r.total, 0) : '—'}</td>
            <td style="${tdR()}">${r.avgUnit != null ? fC(r.avgUnit, 1) : '—'}</td>
          </tr>`).join('')}
        ${seedRows.length > 0 ? `
          <tr class="rec-subtotal-row">
            <td style="${tdL()}" colspan="2"><strong>Subtotal — Seed</strong></td>
            <td style="${tdR()}"><strong>${fN1(totSeedQty)}</strong></td>
            <td style="${tdR()}"><strong>${totSeedTotal ? fC(totSeedTotal, 0) : '—'}</strong></td>
            <td style="${tdR()}"><strong>${totSeedAvg != null ? fC(totSeedAvg, 1) : '—'}</strong></td>
          </tr>` : ''}
      </tbody>
    </table>
  `;

  // ── ON HAND ─────────────────────────────────────────────────────────────
  // Harvested − contract delivered − cash sold − seed transferred
  const totalSoldQty   = totDeliveredQty + totCashQty + totSeedQty;
  const onHandQty      = totalHarvestedQty > 0 ? Math.max(0, totalHarvestedQty - totalSoldQty) : null;
  const onHandPrice    = _onHandPrices[commName] || 0;
  const onHandValue    = (onHandQty != null && onHandPrice) ? onHandQty * onHandPrice : null;

  const onHandHtml = `
    <div class="rec-sub-header" style="background:#1a3a2a">On Hand / Carryover</div>
    <table style="width:100%;border-collapse:collapse;font-size:var(--text-sm)">
      <thead>
        <tr style="background:var(--page-bg)">
          <th style="${thL()}">Item</th>
          <th style="${thR()}">Qty (${unit})</th>
          <th style="${thR()}">Price ($/unit)</th>
          <th style="${thR()}">Indicative Value ($)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style="${tdL()}">
            <strong>${commName} — On hand after reconciliation date</strong>
            ${totalHarvestedQty > 0 ? `<br><span style="font-size:11px;color:var(--hint)">${fN1(totalHarvestedQty)} harvested − ${fN1(totDeliveredQty)} contract − ${fN1(totCashQty)} cash − ${fN1(totSeedQty)} seed</span>` : '<br><span style="font-size:11px;color:var(--hint)">No harvest data — enter harvested tonnes in Management Report</span>'}
          </td>
          <td style="${tdR()}"><strong>${onHandQty != null ? fN1(onHandQty) : '—'}</strong></td>
          <td style="${tdR()}">
            <input type="number" class="rec-onhand-price form-input num" data-comm="${commName}"
              value="${onHandPrice || ''}" placeholder="Enter $/unit"
              style="width:110px;font-size:12px;text-align:right;padding:3px 6px">
          </td>
          <td style="${tdR()}">
            <strong class="rec-onhand-value-${_slugify(commName)}">${onHandValue != null ? fC(onHandValue, 0) : '—'}</strong>
          </td>
        </tr>
      </tbody>
    </table>
  `;

  // ── TOTAL SEASON POSITION ───────────────────────────────────────────────
  const totalRealised  = totPaidTotal + totCashTotal + totSeedTotal;
  const totalQtyMoved  = totDeliveredQty + totCashQty + totSeedQty;

  const totalHtml = `
    <div style="padding:12px 16px;background:var(--ink);color:white;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="font-weight:700;font-size:var(--text-sm)">${commName} — Total Season Position to ${new Date(asAt + 'T00:00:00').toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' })}</div>
      <div style="display:flex;gap:24px;flex-wrap:wrap">
        <div style="text-align:right">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8899aa">Qty moved</div>
          <div style="font-size:16px;font-weight:700">${fN1(totalQtyMoved)} ${unit}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8899aa">Total realised</div>
          <div style="font-size:16px;font-weight:700">${totalRealised ? fC(totalRealised, 0) : '—'}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:#8899aa">Still to go (contracts)</div>
          <div style="font-size:16px;font-weight:700">${totStillToGoValue ? fC(totStillToGoValue, 0) : '—'}</div>
        </div>
      </div>
    </div>
  `;

  return `
    <div class="card rec-section" style="margin-bottom:28px;overflow:hidden" data-commodity="${commName}">
      <div style="padding:10px 16px;background:var(--page-bg);border-bottom:2px solid var(--ink);display:flex;align-items:baseline;gap:12px">
        <span style="font-size:var(--text-md);font-weight:700;color:var(--ink)">${commName}</span>
        ${totalHarvestedQty ? `<span style="font-size:var(--text-sm);color:var(--hint)">${fN1(totalHarvestedQty)} ${unit} harvested</span>` : ''}
        ${totContractedQty ? `<span style="font-size:var(--text-sm);color:var(--hint)">${fN1(totContractedQty)} ${unit} contracted</span>` : ''}
      </div>
      <div style="overflow-x:auto">
        ${productionHtml}
        ${contractHtml}
        ${cashHtml}
        ${seedHtml}
        ${onHandHtml}
      </div>
      ${totalHtml}
    </div>
  `;
}

function _updateOnHandRow(output, commName) {
  const inputs = output.querySelectorAll(`.rec-onhand-price[data-comm="${commName}"]`);
  inputs.forEach(input => {
    const price = parseFloat(input.value) || 0;
    _onHandPrices[commName] = price;
    // Find the qty from the row's strong element next to the price input
    const row = input.closest('tr');
    if (!row) return;
    const qtyCell = row.querySelectorAll('td')[1];
    const qtyText = qtyCell?.querySelector('strong')?.textContent?.replace(/,/g, '') || '';
    const qty = parseFloat(qtyText) || 0;
    const val = qty && price ? qty * price : null;
    const valEl = output.querySelector(`.rec-onhand-value-${_slugify(commName)}`);
    if (valEl) valEl.textContent = val != null ? formatCurrency(val, 0) : '—';
  });
}

function _slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-');
}

// ── Style helpers ──────────────────────────────────────────────────────────

function thL() {
  return 'padding:7px 12px;font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--hint);font-weight:600;text-align:left;border-bottom:1px solid var(--border);white-space:nowrap;background:var(--page-bg)';
}
function thR() {
  return thL().replace('text-align:left', 'text-align:right');
}
function tdL() {
  return 'padding:7px 12px;border-bottom:0.5px solid var(--border-light);vertical-align:middle;text-align:left;font-size:var(--text-sm)';
}
function tdR() {
  return tdL().replace('text-align:left', 'text-align:right');
}
function emptyCell() {
  return 'padding:10px 12px;color:var(--hint);font-style:italic;font-size:var(--text-sm)';
}

// ── Print ──────────────────────────────────────────────────────────────────

function _print(container, farm) {
  const season  = getActiveSeason() || currentSeason();
  const asAt    = qs('#rec-date', container)?.value || new Date().toISOString().slice(0, 10);
  const content = qs('#rec-output', container)?.innerHTML || '';
  const asAtFmt = new Date(asAt + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  const win = window.open('', '_blank');
  win.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Income Reconciliation — ${farm.name} — ${season}</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; font-size: 10px; color: #1a1a1a; padding: 16px 20px; }
        h1 { font-size: 16px; font-weight: 700; margin-bottom: 2px; }
        .meta { font-size: 10px; color: #555; margin-bottom: 16px; }
        .rec-section { margin-bottom: 20px; border: 1px solid #bbb; border-radius: 3px; overflow: hidden; page-break-inside: avoid; }
        table { width: 100%; border-collapse: collapse; font-size: 10px; }
        th { padding: 4px 8px; font-size: 8px; text-transform: uppercase; letter-spacing: .06em; color: #555; border-bottom: 1px solid #ccc; background: #f5f5f5; }
        th:not(:first-child):not(:nth-child(2)) { text-align: right; }
        td { padding: 4px 8px; border-bottom: 0.5px solid #eee; vertical-align: middle; }
        td:not(:first-child):not(:nth-child(2)) { text-align: right; }
        .rec-sub-header { padding: 5px 12px; background: #2a3a50; color: white; font-size: 10px; font-weight: 600; }
        .rec-total-row td, .rec-subtotal-row td { background: #f0f0f0; font-weight: 600; border-top: 1px solid #ccc; }
        .rec-complete-badge { color: #2a7a2a; font-size: 9px; }
        .rec-amber { color: #c65; }
        .rec-val-strong { font-weight: 700; }
        .rec-val-empty { color: #999; }
        .btn, .form-input.rec-onhand-price { display: none !important; }
        [style*="background:var(--page-bg)"] { background: #f8f8f8 !important; }
        [style*="background:var(--ink)"] { background: #1a2535 !important; color: white !important; }
        [style*="color:white"] { color: white !important; }
        .logo { font-size: 11px; font-weight: 600; color: #1a2535; margin-bottom: 10px; }
        @media print { body { padding: 8px 10px; } .rec-section { page-break-inside: avoid; } }
      </style>
    </head>
    <body>
      <div class="logo">Customised Farm Management Pty Ltd</div>
      <h1>Income Reconciliation — ${farm.name}</h1>
      <p class="meta">${season} · As at ${asAtFmt} · Completed invoices only</p>
      ${content}
      <script>window.onload = () => { window.print(); }<\/script>
    </body>
    </html>
  `);
  win.document.close();
}

export function unmountReconciliation() {}
