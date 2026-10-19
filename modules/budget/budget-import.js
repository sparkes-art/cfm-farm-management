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
// ── Expected workbook structure ─────────────────────────────────────────
//
// The parser is built around the CFM Blackbull budget format but is
// designed to be resilient: it finds sheets by keyword rather than exact
// name, and finds header rows by scanning for known column labels rather
// than assuming fixed row numbers.  If a sheet is not recognised it is
// skipped with a warning shown in the preview.
//
// Revenue sheet  (name contains "Revenue", "Sales", "Income", or "Budget")
//   Expected columns (case-insensitive, found by scanning first 15 rows):
//     Enterprise / Commodity / Crop | Area (ha) | Yield | Unit | Price | Total / Revenue / Budget
//
// Fixed-cost sheets — each scanned for category keywords in the sheet name:
//   "Labour" / "Wage" / "Staff"       → category: labour
//   "Overhead" / "Admin" / "General"  → category: overhead
//   "R&M" / "Repair" / "Maintenance"  → category: rm
//   "Fund" / "Mgmt Fee" / "Lease"     → category: fund_mgmt
//
// Fallback — single-sheet budgets:
//   If only one sheet is found the parser looks for a column that looks
//   like a category label ("Category", "Type") and groups rows by that.
//   If no category column is found, all cost rows go into "overhead".
//
// Cost sheet expected columns:
//     Description / Line Item | Amount / Budget / Total
//   Optional: Category | Notes
//
// ── Financial year ───────────────────────────────────────────────────────
//
// The financial year (e.g. "2026-27") is inferred from:
//   1. The workbook file name  (e.g. "Blackbull_2027_Budget.xlsx" → 2026-27)
//   2. A cell in the first sheet that looks like "FY2026-27" or "2026/27"
//   3. A picker shown to the user in the preview if inference fails
//
// ── Usage ────────────────────────────────────────────────────────────────
//
//   import { parseBudgetExcel, showBudgetImportPreview } from './budget-import.js';
//
//   const file = e.target.files[0];
//   const result = await parseBudgetExcel(file);
//   showBudgetImportPreview(container, result);

import { dbInsert, dbDeleteWhere } from '../../js/supabase-client.js';
import { getActiveFarm } from '../../js/app-state.js';
import { toast, qs } from '../../js/ui.js';

// ── SheetJS loader ────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────
const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,]/g,'')); return isNaN(n) ? null : n; };
const str = v => (v == null ? '' : String(v)).trim();
const low = v => str(v).toLowerCase();

function _colIndex(headers, ...keywords) {
  for (const kw of keywords) {
    const idx = headers.findIndex(h => low(h).includes(kw.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

// ── Financial year inference ──────────────────────────────────────────────
function _inferFinancialYear(fileName, rows) {
  // From filename: "2027" → "2026-27", "2026-27" literal
  const fnMatch = fileName.match(/(\d{4})[_-](\d{2,4})/);
  if (fnMatch) {
    const y1 = parseInt(fnMatch[1]);
    const y2 = fnMatch[2].length === 2 ? y1 + 1 : parseInt(fnMatch[2]);
    if (y2 === y1 + 1) return `${y1}-${String(y2).slice(-2)}`;
  }
  const fnYear = fileName.match(/\b(20\d{2})\b/);
  if (fnYear) {
    const y = parseInt(fnYear[1]);
    return `${y-1}-${String(y).slice(-2)}`;
  }
  // From cell content in first few rows
  for (const row of (rows || []).slice(0, 10)) {
    for (const cell of row) {
      const s = str(cell);
      const m = s.match(/(20\d{2})[\/\-](20?\d{2}|\d{2})/);
      if (m) {
        const y1 = parseInt(m[1]);
        const y2raw = m[2].length === 2 ? y1 + 1 : parseInt(m[2]);
        if (y2raw === y1 + 1) return `${y1}-${String(y2raw).slice(-2)}`;
      }
    }
  }
  return null;
}

// ── Sheet classification ──────────────────────────────────────────────────
const REVENUE_KEYWORDS  = ['revenue', 'sales', 'income', 'gross income', 'enterprise'];
const LABOUR_KEYWORDS   = ['labour', 'labor', 'wage', 'staff', 'payroll', 'salary'];
const OVERHEAD_KEYWORDS = ['overhead', 'admin', 'general', 'operating'];
const RM_KEYWORDS       = ['repair', 'r&m', 'maintenance', 'plant'];
const FUND_KEYWORDS     = ['fund', 'mgmt fee', 'management fee', 'lease'];

function _classifySheet(name) {
  const n = name.toLowerCase();
  if (REVENUE_KEYWORDS.some(k => n.includes(k)))  return 'revenue';
  if (LABOUR_KEYWORDS.some(k => n.includes(k)))   return 'labour';
  if (OVERHEAD_KEYWORDS.some(k => n.includes(k))) return 'overhead';
  if (RM_KEYWORDS.some(k => n.includes(k)))       return 'rm';
  if (FUND_KEYWORDS.some(k => n.includes(k)))     return 'fund_mgmt';
  return null;
}

// ── Find header row in a sheet (returns {rowIdx, headers}) ────────────────
const REVENUE_HEADER_SIGNALS  = ['enterprise','commodity','crop','ha','area','yield','price','revenue','budget','total'];
const COST_HEADER_SIGNALS     = ['description','line item','item','amount','budget','total','cost'];

function _findHeaderRow(rows, signals, maxScan = 15) {
  let best = { rowIdx: -1, score: 0, headers: [] };
  for (let i = 0; i < Math.min(maxScan, rows.length); i++) {
    const row = rows[i];
    const score = row.filter(c => signals.some(s => low(c).includes(s))).length;
    if (score > best.score) best = { rowIdx: i, score, headers: row.map(str) };
  }
  return best.rowIdx >= 0 ? best : null;
}

// ── Revenue sheet parser ──────────────────────────────────────────────────
function _parseRevenueSheet(rows, financialYear, farmId) {
  const hdr = _findHeaderRow(rows, REVENUE_HEADER_SIGNALS);
  if (!hdr) return { rows: [], warnings: ['Could not find header row in revenue sheet'] };

  const h = hdr.headers;
  const nameCol  = _colIndex(h, 'enterprise', 'commodity', 'crop', 'item', 'description');
  const areaCol  = _colIndex(h, 'ha', 'area', 'hectare');
  const yieldCol = _colIndex(h, 'yield', 'rate', 'production');
  const unitCol  = _colIndex(h, 'unit');
  const priceCol = _colIndex(h, 'price', '$/');
  const totalCol = _colIndex(h, 'total', 'revenue', 'budget', 'income', 'gross');

  if (nameCol === -1 || totalCol === -1) {
    return { rows: [], warnings: ['Revenue sheet: could not find enterprise name or total column'] };
  }

  const parsed = [];
  const warnings = [];

  for (let i = hdr.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = str(row[nameCol]);
    if (!name || /^total|^sub.?total|^grand/i.test(name)) continue;

    const total = num(row[totalCol]);
    if (!total || total <= 0) continue; // skip zero/blank revenue lines

    const area    = areaCol  !== -1 ? num(row[areaCol])  : null;
    const yieldV  = yieldCol !== -1 ? num(row[yieldCol]) : null;
    const unit    = unitCol  !== -1 ? str(row[unitCol])  : null;
    const price   = priceCol !== -1 ? num(row[priceCol]) : null;

    // Determine category
    const nameLow = name.toLowerCase();
    const category = (nameLow.includes('cattle') || nameLow.includes('livestock') ||
                      nameLow.includes('sheep')  || nameLow.includes('pig'))
                   ? 'livestock' : 'crop';

    parsed.push({
      farm_id: farmId,
      season: financialYear,
      commodity: name,
      area_ha: area,
      budgeted_yield_per_ha: (area && yieldV) ? yieldV : null,
      budgeted_price: price,
      budgeted_gross_revenue: total,
      notes: unit ? `unit: ${unit}` : null,
    });
  }

  if (!parsed.length) warnings.push('Revenue sheet: no data rows found after header');
  return { rows: parsed, warnings };
}

// ── Cost sheet parser ─────────────────────────────────────────────────────
function _parseCostSheet(rows, category, financialYear, farmId) {
  const hdr = _findHeaderRow(rows, COST_HEADER_SIGNALS);
  if (!hdr) return { rows: [], warnings: [`${category} sheet: could not find header row`] };

  const h = hdr.headers;
  const descCol   = _colIndex(h, 'description', 'line item', 'item', 'name', 'expense');
  const amtCol    = _colIndex(h, 'amount', 'budget', 'total', 'cost', '$');
  const subcatCol = _colIndex(h, 'subcategory', 'sub category', 'sub-category', 'type', 'category');
  const notesCol  = _colIndex(h, 'notes', 'note', 'comment');

  if (descCol === -1 || amtCol === -1) {
    return { rows: [], warnings: [`${category} sheet: could not find description or amount column`] };
  }

  const parsed = [];
  const warnings = [];

  for (let i = hdr.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const desc = str(row[descCol]);
    if (!desc || /^total|^sub.?total|^grand/i.test(desc)) continue;

    const amount = num(row[amtCol]);
    if (!amount || amount <= 0) continue;

    parsed.push({
      farm_id: farmId,
      financial_year: financialYear,
      category,
      subcategory: subcatCol !== -1 ? str(row[subcatCol]) || null : null,
      description: desc,
      budget_amount: amount,
      notes: notesCol !== -1 ? str(row[notesCol]) || null : null,
    });
  }

  if (!parsed.length) warnings.push(`${category} sheet: no cost rows found after header`);
  return { rows: parsed, warnings };
}

// ── Single-sheet cost parser (detect category from column or row labels) ──
function _parseSingleSheetCosts(rows, financialYear, farmId) {
  const hdr = _findHeaderRow(rows, [...COST_HEADER_SIGNALS, 'category']);
  if (!hdr) return { rows: [], warnings: [] };

  const h = hdr.headers;
  const descCol   = _colIndex(h, 'description', 'line item', 'item', 'name', 'expense');
  const amtCol    = _colIndex(h, 'amount', 'budget', 'total', 'cost', '$');
  const catCol    = _colIndex(h, 'category', 'type', 'section');
  const subcatCol = _colIndex(h, 'subcategory', 'sub-category');
  const notesCol  = _colIndex(h, 'notes', 'note', 'comment');

  if (descCol === -1 || amtCol === -1) return { rows: [], warnings: [] };

  const parsed = [];
  let currentCategory = 'overhead'; // default

  for (let i = hdr.rowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const desc = str(row[descCol]);
    if (!desc) continue;

    // Check if this looks like a section header (bold-style rows with no amount)
    const amount = num(row[amtCol]);
    if (!amount) {
      // Could be a category divider
      const d = desc.toLowerCase();
      if (LABOUR_KEYWORDS.some(k => d.includes(k)))   currentCategory = 'labour';
      else if (OVERHEAD_KEYWORDS.some(k => d.includes(k))) currentCategory = 'overhead';
      else if (RM_KEYWORDS.some(k => d.includes(k)))   currentCategory = 'rm';
      else if (FUND_KEYWORDS.some(k => d.includes(k))) currentCategory = 'fund_mgmt';
      continue;
    }

    if (/^total|^sub.?total|^grand/i.test(desc)) continue;

    // Determine category from catCol if present
    let cat = currentCategory;
    if (catCol !== -1) {
      const catVal = str(row[catCol]).toLowerCase();
      if (catVal) {
        if (LABOUR_KEYWORDS.some(k => catVal.includes(k)))   cat = 'labour';
        else if (RM_KEYWORDS.some(k => catVal.includes(k)))  cat = 'rm';
        else if (FUND_KEYWORDS.some(k => catVal.includes(k)))cat = 'fund_mgmt';
        else cat = 'overhead';
      }
    }

    parsed.push({
      farm_id: farmId,
      financial_year: financialYear,
      category: cat,
      subcategory: subcatCol !== -1 ? str(row[subcatCol]) || null : null,
      description: desc,
      budget_amount: amount,
      notes: notesCol !== -1 ? str(row[notesCol]) || null : null,
    });
  }

  return { rows: parsed, warnings: [] };
}

// ── Main parse entry point ────────────────────────────────────────────────
export async function parseBudgetExcel(file) {
  await _ensureXLSX();

  const farm = getActiveFarm();
  if (!farm) throw new Error('No active farm selected');

  const buffer = await file.arrayBuffer();
  const wb = window.XLSX.read(buffer, { type: 'array', cellDates: false });

  const sheetNames = wb.SheetNames;
  const allWarnings = [];

  // Get all rows for first sheet to try year inference
  const firstSheet = wb.Sheets[sheetNames[0]];
  const firstRows  = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: true, defval: null });

  const financialYear = _inferFinancialYear(file.name, firstRows);
  if (!financialYear) {
    allWarnings.push('Could not determine financial year from file name or content — you will be asked to confirm it below');
  }

  // Classify all sheets
  const classified = sheetNames.map(name => ({ name, type: _classifySheet(name) }));
  const revenue  = classified.filter(s => s.type === 'revenue');
  const costSets = classified.filter(s => s.type && s.type !== 'revenue');
  const unknown  = classified.filter(s => !s.type);

  if (unknown.length) {
    allWarnings.push(`Skipped sheet${unknown.length > 1 ? 's' : ''}: ${unknown.map(s => `"${s.name}"`).join(', ')} — not recognised as revenue or cost data`);
  }

  const revenueRows = [];
  const costRows = [];

  // Parse revenue
  for (const s of revenue) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[s.name], { header: 1, raw: true, defval: null });
    const result = _parseRevenueSheet(rows, financialYear || 'UNKNOWN', farm.id);
    revenueRows.push(...result.rows);
    allWarnings.push(...result.warnings.map(w => `[${s.name}] ${w}`));
  }

  // Parse named cost sheets
  for (const s of costSets) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[s.name], { header: 1, raw: true, defval: null });
    const result = _parseCostSheet(rows, s.type, financialYear || 'UNKNOWN', farm.id);
    costRows.push(...result.rows);
    allWarnings.push(...result.warnings.map(w => `[${s.name}] ${w}`));
  }

  // If nothing classified at all, try first sheet as combined budget
  if (!revenueRows.length && !costRows.length && sheetNames.length > 0) {
    allWarnings.push('No clearly labelled sheets found — attempting to parse first sheet as a combined budget');
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetNames[0]], { header: 1, raw: true, defval: null });
    const revResult  = _parseRevenueSheet(rows, financialYear || 'UNKNOWN', farm.id);
    const costResult = _parseSingleSheetCosts(rows, financialYear || 'UNKNOWN', farm.id);
    revenueRows.push(...revResult.rows);
    costRows.push(...costResult.rows);
    allWarnings.push(...revResult.warnings, ...costResult.warnings);
  }

  return {
    farm,
    financialYear,      // null if inference failed
    revenueRows,
    costRows,
    warnings: allWarnings,
    fileName: file.name,
    sheetNames,
  };
}

// ── Preview UI ────────────────────────────────────────────────────────────
const fC = n => n != null ? '$' + Math.round(n).toLocaleString() : '—';
const fN = (n, dp = 0) => n != null ? parseFloat(n).toFixed(dp) : '—';

export function showBudgetImportPreview(container, parsed) {
  const { farm, financialYear, revenueRows, costRows, warnings, fileName } = parsed;

  const catLabels = { labour: 'Labour & Farm Mgmt', overhead: 'Overheads', rm: 'Repairs & Maintenance', fund_mgmt: 'Fund Management' };
  const totalRev  = revenueRows.reduce((s, r) => s + (r.budgeted_gross_revenue || 0), 0);
  const totalCost = costRows.reduce((s, r) => s + (r.budget_amount || 0), 0);

  const costByCat = costRows.reduce((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + r.budget_amount;
    return acc;
  }, {});

  const fy = financialYear || '';

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
            : `<span><input id="bud-import-fy" type="text" class="input input-sm" placeholder="e.g. 2026-27" style="width:100px;display:inline-block"> <span style="color:#ef4444;font-size:11px">⚠ could not infer — enter manually</span></span><span></span>`}
          <span style="color:#64748b">Revenue rows</span><span style="color:#1e293b;font-weight:600">${revenueRows.length}</span><span></span>
          <span style="color:#64748b">Cost rows</span><span style="color:#1e293b;font-weight:600">${costRows.length}</span><span></span>
          <span style="color:#64748b">Total revenue</span><span style="color:#16a34a;font-weight:700">${fC(totalRev)}</span><span></span>
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
            Revenue — ${revenueRows.length} enterprises
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="${th};text-align:left">Enterprise</th>
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
                    <td style="${tdR}">${fN(r.budgeted_yield_per_ha, 2)}</td>
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
      ` : '<div style="color:#6b7280;font-size:12px;margin-bottom:12px">⚠ No revenue rows parsed — check sheet names and column labels</div>'}

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

  // Back / cancel both reload the upload tab
  const goBack = () => {
    // Dispatch a custom event so budget.js can handle re-render
    container.dispatchEvent(new CustomEvent('budget-import-cancel', { bubbles: true }));
  };
  qs('#bud-import-back',   container)?.addEventListener('click', goBack);
  qs('#bud-import-cancel', container)?.addEventListener('click', goBack);

  qs('#bud-import-commit', container)?.addEventListener('click', async () => {
    // Resolve financial year (may have been entered manually)
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
    if (!fy) {
      toast('Financial year is required', 'error');
      return;
    }

    // Patch rows with confirmed fy
    const revRows  = revenueRows.map(r => ({ ...r, season: fy }));
    const cstRows  = costRows.map(r => ({ ...r, financial_year: fy }));

    await _commitImport(container, farm, fy, revRows, cstRows, goBack);
  });
}

// ── Commit ────────────────────────────────────────────────────────────────
async function _commitImport(container, farm, financialYear, revenueRows, costRows, onDone) {
  const btn = qs('#bud-import-commit', container);
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

  try {
    // 1. Clear existing budget rows for this farm + year
    // budgets uses 'season' field; budget_costs uses 'financial_year'
    await dbDeleteWhere('budgets',       `farm_id=eq.${farm.id}&season=eq.${financialYear}`);
    await dbDeleteWhere('budget_costs',  `farm_id=eq.${farm.id}&financial_year=eq.${financialYear}`);

    // 2. Insert revenue rows
    if (revenueRows.length) {
      await dbInsert('budgets', revenueRows);
    }

    // 3. Insert cost rows in batches (Supabase PostgREST handles arrays)
    if (costRows.length) {
      await dbInsert('budget_costs', costRows);
    }

    toast(`Budget imported: ${revenueRows.length} revenue + ${costRows.length} cost rows`, 'success');
    onDone();
  } catch (err) {
    console.error('Budget import error', err);
    toast('Import failed: ' + (err.message || 'unknown error'), 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Import rows →'; }
  }
}
