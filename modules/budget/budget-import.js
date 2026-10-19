// modules/budget/budget-import.js
//
// Upload a CFM annual budget Excel workbook and import it into Supabase.
//
// Writes to two tables:
//   budgets        — revenue by enterprise/commodity (existing table)
//   budget_costs   — fixed cost lines by category (new table)
//
// The import is fully previewed before anything is written.  Running it
// again for the same farm + financial_year is safe — it clears existing
// rows for that farm+year before inserting, so re-uploading a revised
// budget replaces the old one cleanly.
//
// ── CFM workbook structure (Blackbull format) ────────────────────────────
//
// One or two "Master Cashflow" sheets (e.g. "OT - Master Cashflow",
// "PT - Master Cashflow").  The parser reads all sheets whose name
// contains "Master Cashflow" and merges the data.
//
// Column layout (0-indexed):
//   Col B (1) — row type tag: 'I' = income, 'E' = enterprise, 'EXP' = expense, 'H' = heading, 'A' = capex
//   Col D (3) — description / name / 'Subtotal'
//   Col E (4) — area (ha) on enterprise 'E' rows; 'Subtotal label' on subtotal rows
//   Col F (5) — total amount (full year)
//
// Income section (before "OVERHEAD EXPENSES"):
//   'I' rows  → revenue items (cropping income, livestock, carry-over)
//   'E' rows  → enterprise section headers (e.g. "COTTON DL 2024 (250.03 HA)") with area in col F
//
// Overhead section (after "OVERHEAD EXPENSES"):
//   Identified by section name in col D (no tag):
//     "OVERHEADS"       → category: overhead
//     "REPAIRS & MAINTENANCE" / "R & M" → category: rm
//     "FARM MANAGEMENT" → category: labour   (labour + farm mgmt fees)
//     "FUND MANAGEMENT" → category: fund_mgmt
//   'EXP' rows under each section → individual cost lines
//
// ── Gross Margin sheets ──────────────────────────────────────────────────
//
// Individual enterprise sheets (e.g. "CAVALCADE HAY", "COTTON DL") hold
// the per-ha detail.  The parser reads these to supplement area/yield/price
// for revenue rows where the cashflow only has totals.
//
//   Row 4 (0-indexed: 3) col H (7) — area in ha
//   Row 6 (5)  col B/C/D — income/ha, cost/ha, return/ha
//   Row 12 (11) col C (2) — budgeted price; col E (4) — total tonnes
//   Row 13 (12) col C (2) — total yield (tonnes, bales, etc.)
//
// ── Financial year ────────────────────────────────────────────────────────
//
// Inferred from file name: "Blackbull_2027_Budget.xlsx" → 2026-27
//
// ── Usage ─────────────────────────────────────────────────────────────────
//
//   import { parseBudgetExcel, showBudgetImportPreview } from './budget-import.js';
//   const result = await parseBudgetExcel(file);
//   showBudgetImportPreview(container, result);

import { dbInsert, dbDeleteWhere } from '../../js/supabase-client.js';
import { getActiveFarm } from '../../js/app-state.js';
import { toast, qs } from '../../js/ui.js';

// ── SheetJS loader ─────────────────────────────────────────────────────────
async function _ensureXLSX() {
  if (window.XLSX) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load SheetJS — check your internet connection'));
    document.head.appendChild(s);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
const num  = v => { const n = parseFloat(String(v ?? '').replace(/[$,\s]/g,'')); return isNaN(n) ? null : n; };
const str  = v => (v == null ? '' : String(v)).trim();
const low  = v => str(v).toLowerCase();

// ── Financial year inference ───────────────────────────────────────────────
function _inferFinancialYear(fileName) {
  // "Blackbull_2027_Budget" → 2026-27
  const fnYear = fileName.match(/\b(20\d{2})\b/);
  if (fnYear) {
    const y = parseInt(fnYear[1]);
    return `${y - 1}-${String(y).slice(-2)}`;
  }
  // "2026-27" literal in filename
  const range = fileName.match(/(20\d{2})[_\-](20?\d{2}|\d{2})/);
  if (range) {
    const y1 = parseInt(range[1]);
    const y2 = range[2].length === 2 ? y1 + 1 : parseInt(range[2]);
    if (y2 === y1 + 1) return `${y1}-${String(y2).slice(-2)}`;
  }
  return null;
}

// ── CFM Cashflow sheet parser ──────────────────────────────────────────────
//
// Scans a "OT/PT - Master Cashflow" sheet row by row.
// Returns { revenueItems, costItems, warnings }
//
// revenueItems: [{ commodity, area_ha, total }]
// costItems:    [{ description, budget_amount, category }]
//
function _parseCashflowSheet(rows, sheetName) {
  const revenueItems = [];
  const costItems    = [];
  const warnings     = [];

  // State machine
  let inOverheads   = false;
  let currentSection = null;  // 'overhead' | 'rm' | 'labour' | 'fund_mgmt'

  // Revenue section enterprise tracking
  // 'E' rows in the INCOME section announce the enterprise with area
  let currentEnterpriseArea = null;

  const OVERHEAD_SECTION_START = 'overhead expenses';

  const SECTION_MAP = {
    'overheads':               'overhead',
    'repairs & maintenance':   'rm',
    'r & m':                   'rm',
    'farm management':         'labour',
    'fund management':         'fund_mgmt',
  };

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    if (!row || !row.some(c => c != null)) continue;

    const tag  = str(row[1]);      // col B
    const desc = str(row[3]);      // col D
    const note = str(row[4]);      // col E
    const totalRaw = row[5];       // col F — full-year total
    const total = num(totalRaw);

    // ── Detect transition into overhead section ──
    if (!inOverheads && low(desc).includes(OVERHEAD_SECTION_START)) {
      inOverheads = true;
      currentSection = null;
      continue;
    }

    // ── Overhead section ──
    if (inOverheads) {
      // Stop at CAPITAL EXPENDITURE / EARNINGS SUMMARY / FINANCE COSTS (we may want finance later)
      if (low(desc).includes('capital expenditure') || low(desc).includes('earnings summary')) {
        break;
      }

      // Detect sub-section headers (rows with no tag and a known section name)
      if (!tag) {
        const descL = low(desc);
        for (const [key, cat] of Object.entries(SECTION_MAP)) {
          if (descL.includes(key)) {
            currentSection = cat;
            break;
          }
        }
        // Finance costs — only include if you want them
        if (descL.includes('finance costs')) {
          currentSection = 'fund_mgmt'; // group finance with fund management
        }
        continue;
      }

      // Skip subtotals and 'E' / 'H' rows
      if (tag === 'H' || tag === 'E' || low(desc) === 'subtotal' || low(desc).startsWith('total')) continue;

      // Cost line
      if (tag === 'EXP' && currentSection && total && total > 0) {
        costItems.push({ description: desc, budget_amount: total, category: currentSection });
      }

      continue;
    }

    // ── Revenue / Income section ──

    // 'E' rows mark enterprise section headers (have area in col F for enterprise E rows)
    // Format: "COTTON DL 2024 (250.03 HA)" with area in col F when it's an 'E' row
    if (tag === 'E') {
      // col F on E rows is area ha (not a dollar total)
      const area = num(totalRaw);
      currentEnterpriseArea = (area && area > 0 && area < 100000) ? area : null;
      continue;
    }

    // Skip headings and subtotals
    if (tag === 'H') continue;
    if (low(desc) === 'subtotal' || low(desc).startsWith('total')) continue;

    // 'I' rows = income items
    if (tag === 'I' && desc && total && total > 0) {
      revenueItems.push({ commodity: desc, area_ha: currentEnterpriseArea, total });
      currentEnterpriseArea = null; // area belongs to the first income line after an E row
    }
  }

  if (!revenueItems.length) warnings.push(`[${sheetName}] No revenue rows found`);
  if (!costItems.length)    warnings.push(`[${sheetName}] No overhead cost rows found`);

  return { revenueItems, costItems, warnings };
}

// ── Gross Margin sheet parser ──────────────────────────────────────────────
//
// Reads one enterprise GM sheet to get area, price, total yield.
// Returns null if the sheet doesn't look like a GM sheet.
//
function _parseGmSheet(rows, sheetName) {
  try {
    // Row 3 (0-indexed) col 7 = area ha
    const areaRow  = rows[3] || [];
    const area_ha  = num(areaRow[7]);
    if (!area_ha || area_ha <= 0) return null;

    // Row 5 (0-indexed) col 1 = income/ha, col 2 = cost/ha
    const summRow  = rows[5] || [];
    const incomePerHa = num(summRow[1]);

    // Row 11 (0-indexed) col 2 = price, col 4 = total tonnes
    const priceRow = rows[11] || [];
    const price    = num(priceRow[2]);
    const totalT   = num(priceRow[4]);

    // Row 12 (0-indexed) col 2 = reported yield (tonnes)
    const yieldRow = rows[12] || [];
    const totalYield = num(yieldRow[2]);

    const yieldPerHa = (area_ha && totalYield) ? totalYield / area_ha : null;
    const grossRev   = (area_ha && incomePerHa) ? area_ha * incomePerHa : null;

    // Enterprise name from row 2 col 0 (sheet name is also fine)
    const nameCell = str((rows[2] || [])[0]) || sheetName;
    const name = nameCell.split('(')[0].trim() || sheetName;

    return { name, area_ha, price, yieldPerHa, grossRev };
  } catch {
    return null;
  }
}

// ── Identify CFM sheet roles ───────────────────────────────────────────────
function _identifySheets(sheetNames) {
  const cashflowSheets = [];
  const gmSheets       = [];
  const skipped        = [];

  // Known non-data sheets to skip
  const SKIP = new Set([
    'formatting','narrative on metrics','key metrics','summary','reconciliation',
    'current assets','crop plan','prices','finance costs','amortisation calculator',
    'op capex','prop capex','cattle program','fallows','ny crops','py crops',
    'pricing - app','pricing - inputs','pricing - livestock','codings',
    'end of sept property','ops summary',
  ]);

  for (const name of sheetNames) {
    const n = name.toLowerCase();
    if (n.includes('master cashflow')) {
      cashflowSheets.push(name);
    } else if (SKIP.has(n) || n.includes('capex') || n.includes('pricing') || n.includes('calendar')) {
      skipped.push(name);
    } else if (
      // Known GM sheet patterns
      n.includes('hay') || n.includes('cotton') || n.includes('corn') ||
      n.includes('sorghum') || n.includes('millet') || n.includes('rhodes') ||
      n.includes('cattle gm') || n.includes('farm mgmt') ||
      n.includes('oh + rnm') || n.includes('oh+rnm')
    ) {
      gmSheets.push(name);
    } else {
      skipped.push(name);
    }
  }

  return { cashflowSheets, gmSheets, skipped };
}

// ── Revenue income consolidation ───────────────────────────────────────────
//
// The cashflow has some income items that are carry-over (prior year crop
// sales) which we group separately from new crop income.  We combine totals
// across entities (OT + PT) where the same commodity appears.
//
function _consolidateRevenue(items, financialYear, farmId, gmData) {
  // Merge by commodity name (case-insensitive) summing totals
  const byName = new Map();
  for (const item of items) {
    const key = item.commodity.toUpperCase().replace(/\s+/g,' ');
    if (byName.has(key)) {
      const existing = byName.get(key);
      existing.total = (existing.total || 0) + (item.total || 0);
      if (!existing.area_ha && item.area_ha) existing.area_ha = item.area_ha;
    } else {
      byName.set(key, { ...item });
    }
  }

  const rows = [];
  for (const [, item] of byName) {
    // Skip carry-over items that are essentially prior-year — these are cashflow
    // items but still budget entries; include them under their commodity name.
    // The commodity name contains clues: "Cavalcade" (lower case) = carry-over
    // We'll include all and let the user review in preview.

    // Look up extra detail from GM sheets
    const gm = gmData.get(item.commodity.toUpperCase().replace(/\s+/g,' '));

    rows.push({
      farm_id:              farmId,
      season:               financialYear,
      commodity:            item.commodity,
      area_ha:              item.area_ha || (gm?.area_ha ?? null),
      budgeted_yield_per_ha: gm?.yieldPerHa ?? null,
      budgeted_price:        gm?.price ?? null,
      budgeted_gross_revenue: item.total,
      notes: null,
    });
  }

  // Sort by revenue descending
  rows.sort((a, b) => (b.budgeted_gross_revenue || 0) - (a.budgeted_gross_revenue || 0));
  return rows;
}

// ── Cost consolidation ─────────────────────────────────────────────────────
function _consolidateCosts(items, financialYear, farmId) {
  // Deduplicate: sum same description+category across OT and PT entities
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.category}::${item.description.toUpperCase()}`;
    if (byKey.has(key)) {
      byKey.get(key).budget_amount += item.budget_amount;
    } else {
      byKey.set(key, { ...item });
    }
  }

  return [...byKey.values()].map(item => ({
    farm_id:        farmId,
    financial_year: financialYear,
    category:       item.category,
    subcategory:    null,
    description:    item.description,
    budget_amount:  item.budget_amount,
    notes:          null,
  }));
}

// ── Main parse entry point ─────────────────────────────────────────────────
export async function parseBudgetExcel(file) {
  await _ensureXLSX();

  const farm = getActiveFarm();
  if (!farm) throw new Error('No active farm selected');

  const buffer = await file.arrayBuffer();
  const wb = window.XLSX.read(buffer, { type: 'array', cellDates: false });

  const sheetNames  = wb.SheetNames;
  const allWarnings = [];

  const financialYear = _inferFinancialYear(file.name);
  if (!financialYear) {
    allWarnings.push('Could not determine financial year from file name — you will be asked to enter it below');
  }

  // Identify sheet roles
  const { cashflowSheets, gmSheets, skipped } = _identifySheets(sheetNames);

  if (skipped.length) {
    allWarnings.push(`Skipped ${skipped.length} non-budget sheets (formatting, pricing, CAPEX, etc.)`);
  }

  if (!cashflowSheets.length) {
    allWarnings.push('No "Master Cashflow" sheet found — expected a sheet with "Master Cashflow" in its name');
    return { farm, financialYear, revenueRows: [], costRows: [], warnings: allWarnings, fileName: file.name, sheetNames };
  }

  // ── Parse all cashflow sheets (OT + PT) ──
  const allRevenueItems = [];
  const allCostItems    = [];

  for (const sheetName of cashflowSheets) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const result = _parseCashflowSheet(rows, sheetName);
    allRevenueItems.push(...result.revenueItems);
    allCostItems.push(...result.costItems);
    allWarnings.push(...result.warnings);
  }

  // ── Parse GM sheets for supplemental detail ──
  const gmData = new Map(); // commodity key → { area_ha, price, yieldPerHa }
  for (const sheetName of gmSheets) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const gm = _parseGmSheet(rows, sheetName);
    if (gm) {
      const key = gm.name.toUpperCase().replace(/\s+/g,' ');
      gmData.set(key, gm);
    }
  }

  // ── Consolidate (merge OT+PT, dedup) ──
  const revenueRows = _consolidateRevenue(allRevenueItems, financialYear || 'UNKNOWN', farm.id, gmData);
  const costRows    = _consolidateCosts(allCostItems, financialYear || 'UNKNOWN', farm.id);

  if (!revenueRows.length && !costRows.length) {
    allWarnings.push('No data could be extracted — check that the file matches the expected CFM budget format');
  }

  return {
    farm,
    financialYear,
    revenueRows,
    costRows,
    warnings: allWarnings,
    fileName: file.name,
    sheetNames,
  };
}

// ── Preview UI ─────────────────────────────────────────────────────────────
const fC = n => n != null ? '$' + Math.round(n).toLocaleString() : '—';
const fN = (n, dp = 0) => n != null ? parseFloat(n).toFixed(dp) : '—';

export function showBudgetImportPreview(container, parsed) {
  const { farm, financialYear, revenueRows, costRows, warnings, fileName } = parsed;

  const catLabels = {
    labour:   'Labour & Farm Mgmt',
    overhead: 'Overheads',
    rm:       'Repairs & Maintenance',
    fund_mgmt:'Fund Management',
  };
  const totalRev  = revenueRows.reduce((s, r) => s + (r.budgeted_gross_revenue || 0), 0);
  const totalCost = costRows.reduce((s, r) => s + (r.budget_amount || 0), 0);

  const costByCat = costRows.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + r.budget_amount;
    return acc;
  }, {});

  const fy  = financialYear || '';
  const td  = 'padding:5px 10px;font-size:12px;border-bottom:1px solid #e5e7eb';
  const tdR = td + ';text-align:right;font-variant-numeric:tabular-nums';
  const th  = 'padding:6px 10px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;border-bottom:2px solid #e5e7eb';
  const thR = th + ';text-align:right';

  container.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:20px 24px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <button class="btn btn-ghost btn-sm" id="bud-import-back">← Back</button>
        <h2 style="font-size:18px;font-weight:700;margin:0">Budget import preview</h2>
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:16px">
        <div style="font-size:12px;color:#64748b;margin-bottom:8px">File: <strong>${fileName}</strong></div>
        <div style="display:grid;grid-template-columns:repeat(3,auto);gap:4px 24px;font-size:12px">
          <span style="color:#64748b">Farm</span><span style="color:#1e293b;font-weight:600">${farm.name}</span><span></span>
          <span style="color:#64748b">Financial year</span>
          ${financialYear
            ? `<span style="color:#1e293b;font-weight:600">${financialYear}</span><span></span>`
            : `<span><input id="bud-import-fy" type="text" class="input input-sm" placeholder="e.g. 2026-27" style="width:100px;display:inline-block"> <span style="color:#ef4444;font-size:11px">⚠ enter manually</span></span><span></span>`}
          <span style="color:#64748b">Cashflow sheets parsed</span><span style="color:#1e293b;font-weight:600">${parsed.sheetNames.filter(n => n.toLowerCase().includes('master cashflow')).length}</span><span></span>
          <span style="color:#64748b">Revenue rows</span><span style="color:#1e293b;font-weight:600">${revenueRows.length}</span><span></span>
          <span style="color:#64748b">Fixed cost rows</span><span style="color:#1e293b;font-weight:600">${costRows.length}</span><span></span>
          <span style="color:#64748b">Total budget revenue</span><span style="color:#16a34a;font-weight:700">${fC(totalRev)}</span><span></span>
          <span style="color:#64748b">Total fixed costs</span><span style="color:#dc2626;font-weight:700">${fC(totalCost)}</span><span></span>
        </div>
      </div>

      ${warnings.length ? `
        <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-bottom:16px">
          <div style="font-size:12px;font-weight:600;color:#92400e;margin-bottom:6px">⚠ Warnings</div>
          ${warnings.map(w => `<div style="font-size:12px;color:#78350f;margin-bottom:2px">· ${w}</div>`).join('')}
        </div>
      ` : ''}

      ${revenueRows.length ? `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600">
            Revenue — ${revenueRows.length} income items
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="${th};text-align:left">Enterprise / Item</th>
                  <th style="${thR}">Area (ha)</th>
                  <th style="${thR}">Yield/ha</th>
                  <th style="${thR}">Price</th>
                  <th style="${thR}">Budget revenue</th>
                </tr>
              </thead>
              <tbody>
                ${revenueRows.map(r => `
                  <tr>
                    <td style="${td}">${r.commodity}</td>
                    <td style="${tdR}">${fN(r.area_ha, 1)}</td>
                    <td style="${tdR}">${r.budgeted_yield_per_ha ? fN(r.budgeted_yield_per_ha, 2) : '—'}</td>
                    <td style="${tdR}">${r.budgeted_price ? fC(r.budgeted_price) : '—'}</td>
                    <td style="${tdR};color:#16a34a;font-weight:600">${fC(r.budgeted_gross_revenue)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#f0fdf4;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="4">Total budget revenue</td>
                  <td style="${tdR};color:#16a34a;font-weight:700">${fC(totalRev)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ` : '<div style="color:#6b7280;font-size:12px;margin-bottom:12px">⚠ No revenue rows parsed</div>'}

      ${costRows.length ? `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600">
            Fixed costs — ${costRows.length} line items
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="${th};text-align:left">Category</th>
                  <th style="${th};text-align:left">Description</th>
                  <th style="${thR}">Budget amount</th>
                </tr>
              </thead>
              <tbody>
                ${costRows.map(r => `
                  <tr>
                    <td style="${td};color:#6b7280;font-size:11px">${catLabels[r.category] || r.category}</td>
                    <td style="${td}">${r.description}</td>
                    <td style="${tdR};color:#dc2626">-${fC(r.budget_amount)}</td>
                  </tr>
                `).join('')}
                ${Object.entries(costByCat).map(([cat, tot]) => `
                  <tr style="background:#fafafa">
                    <td style="${td};font-weight:600;color:#374151" colspan="2">${catLabels[cat] || cat} subtotal</td>
                    <td style="${tdR};font-weight:600;color:#dc2626">-${fC(tot)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#fff5f5;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="2">Total fixed costs</td>
                  <td style="${tdR};color:#dc2626;font-weight:700">-${fC(totalCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ` : '<div style="color:#6b7280;font-size:12px;margin-bottom:12px">No fixed cost rows parsed</div>'}

      ${revenueRows.length || costRows.length ? `
        <div style="display:flex;gap:10px;align-items:center;justify-content:flex-end">
          <span style="font-size:12px;color:#6b7280">
            This will <strong>replace</strong> any existing ${fy} budget for ${farm.name}
          </span>
          <button class="btn btn-ghost" id="bud-import-cancel">Cancel</button>
          <button class="btn btn-primary" id="bud-import-commit">
            Import ${revenueRows.length + costRows.length} rows →
          </button>
        </div>
      ` : ''}
    </div>
  `;

  const goBack = () => {
    container.dispatchEvent(new CustomEvent('budget-import-cancel', { bubbles: true }));
  };
  qs('#bud-import-back',   container)?.addEventListener('click', goBack);
  qs('#bud-import-cancel', container)?.addEventListener('click', goBack);

  qs('#bud-import-commit', container)?.addEventListener('click', async () => {
    let fy = financialYear;
    const fyInput = qs('#bud-import-fy', container);
    if (fyInput) {
      fy = fyInput.value.trim();
      if (!/^\d{4}-\d{2}$/.test(fy)) {
        toast('Enter a valid financial year, e.g. 2026-27', 'error');
        fyInput.focus();
        return;
      }
    }
    if (!fy) { toast('Financial year is required', 'error'); return; }

    const revRows = revenueRows.map(r => ({ ...r, season: fy }));
    const cstRows = costRows.map(r => ({ ...r, financial_year: fy }));
    await _commitImport(container, farm, fy, revRows, cstRows, goBack);
  });
}

// ── Commit ─────────────────────────────────────────────────────────────────
async function _commitImport(container, farm, financialYear, revenueRows, costRows, onDone) {
  const btn = qs('#bud-import-commit', container);
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  try {
    await dbDeleteWhere('budgets',      `farm_id=eq.${farm.id}&season=eq.${encodeURIComponent(financialYear)}`);
    await dbDeleteWhere('budget_costs', `farm_id=eq.${farm.id}&financial_year=eq.${encodeURIComponent(financialYear)}`);

    if (revenueRows.length) await dbInsert('budgets',      revenueRows);
    if (costRows.length)    await dbInsert('budget_costs', costRows);

    toast(`Budget imported: ${revenueRows.length} revenue + ${costRows.length} cost rows`, 'success');
    onDone();
  } catch (err) {
    console.error('Budget import error', err);
    toast('Import failed: ' + (err.message || 'unknown error'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Import rows →'; }
  }
}
