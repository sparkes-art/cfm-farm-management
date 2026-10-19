// modules/budget/budget-import.js
//
// Upload a CFM annual budget Excel workbook and import it into Supabase.
//
// Writes to two tables:
//   budgets        — revenue by enterprise/commodity (existing table)
//   budget_costs   — all cost lines: variable (per enterprise) + fixed (overheads)
//
// budget_costs schema:
//   farm_id, financial_year, category, subcategory, enterprise,
//   budget_code, description, cost_per_ha, area_ha, budget_amount, notes
//
//   category values:
//     'variable'   — crop/livestock cost from GM sheets (enterprise is set)
//     'overhead'   — OT/PT overheads
//     'rm'         — OT/PT repairs & maintenance
//     'labour'     — farm management / staffing
//     'fund_mgmt'  — fund management overheads
//     'finance'    — finance costs
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
// the per-ha detail.  The parser reads these for:
//   1. Revenue summary metrics (area, price, yield, income/ha)
//   2. Variable cost detail — every budget code line, including $0 rows
//
// Cost rows (0-indexed cols):
//   Col A (0) — budget code (e.g. "CHEMICALS HERBICIDES", "FUEL CROPPING")
//               Section header rows have no code and are used as subcategory labels
//   Col B (1) — operation / product description
//   Col H (7) — cost per ha (may be 0 — include these, manager may incur costs)
//
// A row is a cost line when:
//   - col A is ALL CAPS text (the budget code)
//   - col H is a number (including 0)
//
// Section grouping rows (e.g. "Field Preparations", "Harvest") appear in col G
// as "Subtotal:" markers — we capture the section name from col A on those rows.
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
    const totalRaw = row[5];       // col F — full-year total
    const total = num(totalRaw);
    const descL = low(desc);

    // ── Detect transition into overhead section ──
    // Row 378: col D = 'OVERHEAD EXPENSES', col B = None
    if (!inOverheads && descL.includes(OVERHEAD_SECTION_START)) {
      inOverheads = true;
      currentSection = null;
      continue;
    }

    // ── Overhead section ──
    if (inOverheads) {
      // Stop at CAPITAL EXPENDITURE
      if (descL.includes('capital expenditure')) break;

      // Detect sub-section headers — they appear as 'E' tagged rows OR untagged rows
      // e.g. row 379: B='E', D='OVERHEADS'
      //      row 409: B='None', D='REPAIRS & MAINTENANCE'
      //      row 410: B='E',    D='R & M'
      //      row 427: B='None', D='FARM MANAGEMENT'
      //      row 428: B='E',    D='FARM MANAGEMENT'
      if (tag === 'E' || !tag) {
        for (const [key, cat] of Object.entries(SECTION_MAP)) {
          if (descL.includes(key)) {
            currentSection = cat;
            break;
          }
        }
        if (descL.includes('finance costs')) {
          currentSection = 'finance'; // separate finance costs category
        }
        if (tag !== 'EXP') continue;
      }

      // Skip headings and subtotals
      if (tag === 'H' || descL === 'subtotal' || descL.startsWith('total')) continue;

      // Cost line — must have EXP tag, a section, and a positive value
      if (tag === 'EXP' && currentSection && total && total > 0) {
        costItems.push({ description: desc, budget_amount: total, category: currentSection });
      }

      continue;
    }

    // ── Revenue / Income section ──

    // Skip headings, subtotals, and section dividers
    if (tag === 'H') continue;
    if (descL === 'subtotal' || descL.startsWith('total') || descL === 'farm income') continue;

    // 'E' rows in the income section just mark group headers (no area on these)
    if (tag === 'E') continue;

    // Income rows: tagged 'I' OR untagged with a non-zero value in col F and a description
    // (Some rows like RHODES HAY IRR, CORN IRR have no tag but are genuine income lines)
    const isTaggedIncome   = tag === 'I';
    const isUntaggedIncome = !tag && desc && total && total > 0 &&
                             !descL.includes('subtotal') && !descL.includes('income') &&
                             !descL.includes('expense') && !descL.includes('farming');

    if ((isTaggedIncome || isUntaggedIncome) && desc && total && total > 0) {
      revenueItems.push({ commodity: desc, area_ha: null, total });
    }
  }

  if (!revenueItems.length) warnings.push(`[${sheetName}] No revenue rows found`);
  if (!costItems.length)    warnings.push(`[${sheetName}] No overhead cost rows found`);

  return { revenueItems, costItems, warnings };
}

// ── Gross Margin sheet parser ──────────────────────────────────────────────
//
// All cropping GM sheets follow this layout (0-indexed rows):
//   Row 3  col 7 (H) — area in ha
//   Row 5  col 1 (B) — income/ha
//   Row 10 col 0 (A) — product label (e.g. "Lint:", "Grain:", "Lint:" for hay)
//          col 2 (C) — price ($/tonne or $/unit)
//   Row 11 col 1 (B) — "Expected Yield"; col 2 (C) — yield per ha
//   Row 12 col 1 (B) — "Total Tonnes" or "Total Bales"; col 2 (C) — total units
//          (RHODES HAY IRR has bales on row 12, tonnes on row 13)
//
// Cotton is a two-product enterprise:
//   Row 10 — Lint price; Row 11 — Lint yield/ha
//   Row 12 — Seed price; Row 13 — Seed yield/ha
//   We report lint as the primary product (price/yield) since it drives value.
//
// Cattle GM is a different layout (no area row) — returns { name, totalRevenue } only.
//
// Returns null if the sheet doesn't look like a recognisable GM sheet.
//
function _parseGmSheet(rows, sheetName) {
  try {
    // Enterprise name from row 2 (0-indexed) col A
    const nameRow  = rows[2] || [];
    const name     = str(nameRow[0]) || sheetName;

    // ── Cattle GM — different layout ──
    if (low(name).includes('cattle') || low(sheetName).includes('cattle gm')) {
      // Row 4 (0-indexed) col 2 = total income; row 10 col 7 = total income
      const totalRevenue = num((rows[4] || [])[2]) || num((rows[10] || [])[7]);
      return { name: 'CATTLE SALES', area_ha: null, price: null, yieldPerHa: null, totalRevenue, unit: 'head' };
    }

    // ── Cropping GM ──
    // Row 3 col 7 = area ha
    const area_ha = num((rows[3] || [])[7]);
    if (!area_ha || area_ha <= 0) return null;

    // Row 5 col 1 = income/ha
    const incomePerHa = num((rows[5] || [])[1]);

    // Detect cotton (two products) vs single product
    // Row 10 col 0: "Lint:", "Grain:", or other label
    const productLabel = low(str((rows[10] || [])[0]));
    const isCotton = productLabel.includes('lint') && str((rows[12] || [])[0]).toLowerCase().includes('seed');

    let price, yieldPerHa, totalTonnes, unit;

    if (isCotton) {
      // Lint (primary): row 10 col 2 = price, row 11 col 2 = yield/ha
      // Seed:           row 12 col 2 = price, row 13 col 2 = yield/ha
      const lintPrice    = num((rows[10] || [])[2]);
      const lintYield    = num((rows[11] || [])[2]);  // bales/ha
      const seedPrice    = num((rows[12] || [])[2]);
      const seedYield    = num((rows[13] || [])[2]);  // bales/ha

      // Blended income/ha = lint price * lint yield + seed price * seed yield
      // (use incomePerHa from summary row as the authoritative figure)
      price      = lintPrice;   // report lint price as primary
      yieldPerHa = lintYield;
      totalTonnes = lintYield && area_ha ? lintYield * area_ha : null;
      unit = 'bales/ha (lint)';
    } else {
      // Single product: row 10 col 2 = price, row 11 col 2 = yield/ha
      price      = num((rows[10] || [])[2]);
      yieldPerHa = num((rows[11] || [])[2]);

      // Total tonnes — row 12 col 2 for most, search rows 12-14 for first non-null numeric
      totalTonnes = num((rows[12] || [])[2]);
      if (!totalTonnes) totalTonnes = num((rows[13] || [])[2]);

      // Determine unit from sheet name
      unit = sheetName.toLowerCase().includes('hay') ? 't/ha' :
             sheetName.toLowerCase().includes('corn') ? 't/ha' :
             sheetName.toLowerCase().includes('sorghum') ? 't/ha' : 't/ha';
    }

    const totalRevenue = (area_ha && incomePerHa) ? area_ha * incomePerHa : null;

    // ── Variable cost lines ──
    // Walk all rows from row 16 (0-indexed) onward.
    // Section header rows: col G (6) = 'Subtotal:' → col A = section name
    // Cost rows:           col A = ALL CAPS budget code, col H (7) = cost/ha (number, may be 0)
    const costLines = [];
    let currentSection = null;
    const BUDGET_CODE_RE = /^[A-Z][A-Z\s&,\/\-]+$/;  // all-caps with spaces/symbols

    for (let ri = 15; ri < rows.length; ri++) {
      const row = rows[ri] || [];
      const colA = str(row[0]);
      const colG = str(row[6]);
      const colH = row[7];

      // Section header — "Subtotal:" in col G
      if (colG === 'Subtotal:') {
        // Section name is in col A if it looks like a label (Title Case or mixed)
        // e.g. "Field Preparations", "Harvest", "Fertiliser"
        if (colA && !BUDGET_CODE_RE.test(colA)) {
          currentSection = colA.trim();
        }
        continue;
      }

      // Cost row — col A is a budget code (ALL CAPS), col H is a number
      if (colA && BUDGET_CODE_RE.test(colA) && colH !== null && colH !== undefined) {
        const costPerHa = num(colH);
        if (costPerHa === null) continue;  // non-numeric, skip
        const desc = str(row[1]);          // col B = operation/product description
        costLines.push({
          budget_code:  colA.trim(),
          description:  desc || colA.trim(),
          subcategory:  currentSection,
          cost_per_ha:  costPerHa,
          // total budget cost = cost_per_ha × area_ha (calculated at consolidation time)
        });
      }
    }

    return { name, area_ha, price, yieldPerHa, totalTonnes, totalRevenue, unit, costLines };
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
      // Known GM sheet patterns — enterprise cropping + livestock
      n.includes('hay') || n.includes('cotton') || n.includes('corn') ||
      n.includes('sorghum') || n.includes('millet') || n.includes('rhodes') ||
      n === 'cattle gm' || n.includes('farm mgmt') ||
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
// Merges OT+PT cashflow income items and enriches with GM sheet metrics.
// GM sheet name is matched against cashflow commodity name (case-insensitive).
//
function _consolidateRevenue(items, financialYear, farmId, gmData) {
  // Merge by commodity key — sum totals across OT+PT entities
  const byKey = new Map();
  for (const item of items) {
    const key = item.commodity.toUpperCase().replace(/\s+/g,' ').trim();
    if (byKey.has(key)) {
      byKey.get(key).total += (item.total || 0);
    } else {
      byKey.set(key, { ...item });
    }
  }

  // Build GM lookup: try exact key match, then partial (commodity name contains GM name or vice versa)
  const gmLookup = (commodityKey) => {
    if (gmData.has(commodityKey)) return gmData.get(commodityKey);
    // Partial match — e.g. cashflow has "COTTON DL", GM sheet is "COTTON DL"
    for (const [gmKey, gm] of gmData) {
      if (commodityKey.includes(gmKey) || gmKey.includes(commodityKey)) return gm;
    }
    return null;
  };

  const rows = [];
  for (const [key, item] of byKey) {
    const gm = gmLookup(key);

    rows.push({
      farm_id:               farmId,
      season:                financialYear,
      commodity:             item.commodity,
      area_ha:               gm?.area_ha ?? null,
      budgeted_yield_per_ha: gm?.yieldPerHa ?? null,
      budgeted_price:        gm?.price ?? null,
      budgeted_gross_revenue: item.total,
      notes:                 gm?.unit ? `Yield unit: ${gm.unit}` : null,
    });
  }

  // Sort: new-season income first (all-caps names), then other/carry-over
  rows.sort((a, b) => {
    const aIsNew = a.commodity === a.commodity.toUpperCase();
    const bIsNew = b.commodity === b.commodity.toUpperCase();
    if (aIsNew !== bIsNew) return aIsNew ? -1 : 1;
    return (b.budgeted_gross_revenue || 0) - (a.budgeted_gross_revenue || 0);
  });
  return rows;
}

// ── Variable cost consolidation (from GM sheets) ───────────────────────────
//
// For each GM sheet that has costLines, emit one budget_costs row per
// unique (enterprise, budget_code, description, subcategory) combination.
// Rows with cost_per_ha = 0 are included — they may incur actual costs
// during the year and are important for reconciliation.
//
// budget_amount = cost_per_ha × area_ha  (null when area_ha is unknown)
//
function _consolidateVariableCosts(gmData, financialYear, farmId) {
  const rows = [];

  for (const [, gm] of gmData) {
    // Skip cattle and any GM without cost lines or area
    if (!gm.costLines || !gm.costLines.length) continue;

    const enterprise = gm.name;
    const area_ha    = gm.area_ha;

    // Deduplicate within the enterprise: same code + description can appear
    // multiple times in different application passes — sum the cost/ha
    const byKey = new Map();
    for (const line of gm.costLines) {
      const key = `${line.budget_code}||${line.description}||${line.subcategory || ''}`;
      if (byKey.has(key)) {
        byKey.get(key).cost_per_ha += (line.cost_per_ha || 0);
      } else {
        byKey.set(key, { ...line });
      }
    }

    for (const line of byKey.values()) {
      const budget_amount = (area_ha != null) ? line.cost_per_ha * area_ha : null;
      rows.push({
        farm_id:        farmId,
        financial_year: financialYear,
        category:       'variable',
        subcategory:    line.subcategory || null,
        enterprise:     enterprise,
        budget_code:    line.budget_code,
        description:    line.description,
        cost_per_ha:    line.cost_per_ha,
        area_ha:        area_ha,
        budget_amount:  budget_amount,
        notes:          null,
      });
    }
  }

  // Sort: by enterprise name, then subcategory, then budget_code
  rows.sort((a, b) => {
    const ea = a.enterprise || '', eb = b.enterprise || '';
    if (ea !== eb) return ea.localeCompare(eb);
    const sa = a.subcategory || '', sb = b.subcategory || '';
    if (sa !== sb) return sa.localeCompare(sb);
    return (a.budget_code || '').localeCompare(b.budget_code || '');
  });

  return rows;
}

// ── Fixed cost consolidation ───────────────────────────────────────────────
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
    enterprise:     null,
    budget_code:    null,
    description:    item.description,
    cost_per_ha:    null,
    area_ha:        null,
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
  // Key by both the parsed name AND the sheet name (uppercased) for maximum matching
  const gmData = new Map();
  for (const sheetName of gmSheets) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const gm = _parseGmSheet(rows, sheetName);
    if (gm) {
      const keyBySheet = sheetName.toUpperCase().replace(/\s+/g,' ').trim();
      const keyByName  = gm.name.toUpperCase().replace(/\s+/g,' ').trim();
      gmData.set(keyBySheet, gm);
      if (keyByName !== keyBySheet) gmData.set(keyByName, gm);
    }
  }

  // ── Consolidate (merge OT+PT, dedup) ──
  const revenueRows      = _consolidateRevenue(allRevenueItems, financialYear || 'UNKNOWN', farm.id, gmData);
  const fixedCostRows    = _consolidateCosts(allCostItems, financialYear || 'UNKNOWN', farm.id);
  const variableCostRows = _consolidateVariableCosts(gmData, financialYear || 'UNKNOWN', farm.id);

  // Combined cost rows: variable first (enterprise detail), then fixed
  const costRows = [...variableCostRows, ...fixedCostRows];

  if (!revenueRows.length && !costRows.length) {
    allWarnings.push('No data could be extracted — check that the file matches the expected CFM budget format');
  }

  // Summary counts for preview
  const enterprisesWithCosts = new Set(variableCostRows.map(r => r.enterprise)).size;
  if (variableCostRows.length) {
    allWarnings.push(
      `ℹ ${variableCostRows.length} variable cost lines extracted across ${enterprisesWithCosts} enterprises ` +
      `(including $0 budget rows)`
    );
  }

  return {
    farm,
    financialYear,
    revenueRows,
    costRows,
    variableCostRows,
    fixedCostRows,
    warnings: allWarnings,
    fileName: file.name,
    sheetNames,
  };
}

// ── Preview UI ─────────────────────────────────────────────────────────────
const fC = n => n != null ? '$' + Math.round(n).toLocaleString() : '—';
const fN = (n, dp = 0) => n != null ? parseFloat(n).toFixed(dp) : '—';

export function showBudgetImportPreview(container, parsed) {
  const { farm, financialYear, revenueRows, costRows, variableCostRows, fixedCostRows, warnings, fileName } = parsed;

  const catLabels = {
    variable:  'Variable (crop/livestock)',
    labour:    'Labour & Farm Mgmt',
    overhead:  'Overheads',
    rm:        'Repairs & Maintenance',
    fund_mgmt: 'Fund Management',
    finance:   'Finance Costs',
  };
  const totalRev       = revenueRows.reduce((s, r) => s + (r.budgeted_gross_revenue || 0), 0);
  const totalVarCost   = (variableCostRows || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalFixedCost = (fixedCostRows   || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalCost      = totalVarCost + totalFixedCost;

  // Group variable costs by enterprise for display
  const varByEnterprise = {};
  for (const r of (variableCostRows || [])) {
    const e = r.enterprise || 'Unknown';
    if (!varByEnterprise[e]) varByEnterprise[e] = { rows: [], total: 0 };
    varByEnterprise[e].rows.push(r);
    varByEnterprise[e].total += (r.budget_amount || 0);
  }

  const fixedByCat = (fixedCostRows || []).reduce((acc, r) => {
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
          <span style="color:#64748b">Variable cost rows</span><span style="color:#1e293b;font-weight:600">${(variableCostRows||[]).length}</span><span></span>
          <span style="color:#64748b">Fixed cost rows</span><span style="color:#1e293b;font-weight:600">${(fixedCostRows||[]).length}</span><span></span>
          <span style="color:#64748b">Total budget revenue</span><span style="color:#16a34a;font-weight:700">${fC(totalRev)}</span><span></span>
          <span style="color:#64748b">Total variable costs</span><span style="color:#dc2626;font-weight:700">${fC(totalVarCost)}</span><span></span>
          <span style="color:#64748b">Total fixed costs</span><span style="color:#dc2626;font-weight:700">${fC(totalFixedCost)}</span><span></span>
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
                  <th style="${thR}">Price ($/t)</th>
                  <th style="${thR}">Yield/ha</th>
                  <th style="${thR}">Total tonnes</th>
                  <th style="${thR}">Income/ha</th>
                  <th style="${thR}">Budget revenue</th>
                </tr>
              </thead>
              <tbody>
                ${revenueRows.map(r => {
                  const totalT = (r.area_ha && r.budgeted_yield_per_ha) ? r.area_ha * r.budgeted_yield_per_ha : null;
                  const incomeHa = (r.area_ha && r.budgeted_gross_revenue) ? r.budgeted_gross_revenue / r.area_ha : null;
                  const isCarryOver = r.commodity !== r.commodity.toUpperCase();
                  return `
                  <tr style="${isCarryOver ? 'background:#fafaf9;' : ''}">
                    <td style="${td};${isCarryOver ? 'color:#9ca3af;font-style:italic;' : ''}">${r.commodity}${isCarryOver ? ' <span style="font-size:10px">(carry-over)</span>' : ''}</td>
                    <td style="${tdR}">${fN(r.area_ha, 1)}</td>
                    <td style="${tdR}">${r.budgeted_price ? '$' + fN(r.budgeted_price, 0) : '—'}</td>
                    <td style="${tdR}">${r.budgeted_yield_per_ha ? fN(r.budgeted_yield_per_ha, 1) : '—'}</td>
                    <td style="${tdR}">${totalT ? fN(totalT, 0) + 't' : '—'}</td>
                    <td style="${tdR}">${incomeHa ? '$' + fN(incomeHa, 0) : '—'}</td>
                    <td style="${tdR};color:#16a34a;font-weight:600">${fC(r.budgeted_gross_revenue)}</td>
                  </tr>`;
                }).join('')}
                <tr style="background:#f0fdf4;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="6">Total budget revenue</td>
                  <td style="${tdR};color:#16a34a;font-weight:700">${fC(totalRev)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ` : '<div style="color:#6b7280;font-size:12px;margin-bottom:12px">⚠ No revenue rows parsed</div>'}

      ${(variableCostRows||[]).length ? `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
            <span>Variable costs by enterprise — ${(variableCostRows||[]).length} cost code lines</span>
            <span style="color:#dc2626;font-weight:700">${fC(totalVarCost)}</span>
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="${th};text-align:left">Enterprise</th>
                  <th style="${th};text-align:left">Section</th>
                  <th style="${th};text-align:left">Budget Code</th>
                  <th style="${th};text-align:left">Description</th>
                  <th style="${thR}">Cost/ha</th>
                  <th style="${thR}">Budget total</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(varByEnterprise).map(([enterprise, { rows: erows, total: etotal }]) => `
                  ${erows.map((r, i) => `
                    <tr style="${i % 2 === 0 ? '' : 'background:#fafafa'}${r.budget_amount === 0 ? ';opacity:0.6' : ''}">
                      <td style="${td};font-size:11px;color:#6b7280">${i === 0 ? enterprise : ''}</td>
                      <td style="${td};font-size:11px;color:#9ca3af;font-style:italic">${r.subcategory || ''}</td>
                      <td style="${td};font-size:11px;font-family:monospace;color:#374151">${r.budget_code}</td>
                      <td style="${td};font-size:11px">${r.description}</td>
                      <td style="${tdR};font-size:11px">${r.cost_per_ha != null ? '$' + fN(r.cost_per_ha, 2) : '—'}</td>
                      <td style="${tdR};font-size:11px;color:${r.budget_amount ? '#dc2626' : '#9ca3af'}">${r.budget_amount != null ? (r.budget_amount === 0 ? '$0' : '-' + fC(r.budget_amount)) : '—'}</td>
                    </tr>
                  `).join('')}
                  <tr style="background:#fff5f5">
                    <td style="${td};font-weight:600;font-size:11px" colspan="5">${enterprise} total</td>
                    <td style="${tdR};font-weight:600;color:#dc2626;font-size:11px">-${fC(etotal)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#fff5f5;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="5">Total variable costs</td>
                  <td style="${tdR};color:#dc2626;font-weight:700">-${fC(totalVarCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ` : '<div style="color:#6b7280;font-size:12px;margin-bottom:12px">No variable cost rows parsed from GM sheets</div>'}

      ${(fixedCostRows||[]).length ? `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
            <span>Fixed costs — ${(fixedCostRows||[]).length} line items</span>
            <span style="color:#dc2626;font-weight:700">${fC(totalFixedCost)}</span>
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
                ${(fixedCostRows||[]).map(r => `
                  <tr>
                    <td style="${td};color:#6b7280;font-size:11px">${catLabels[r.category] || r.category}</td>
                    <td style="${td}">${r.description}</td>
                    <td style="${tdR};color:#dc2626">-${fC(r.budget_amount)}</td>
                  </tr>
                `).join('')}
                ${Object.entries(fixedByCat).map(([cat, tot]) => `
                  <tr style="background:#fafafa">
                    <td style="${td};font-weight:600;color:#374151" colspan="2">${catLabels[cat] || cat} subtotal</td>
                    <td style="${tdR};font-weight:600;color:#dc2626">-${fC(tot)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#fff5f5;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="2">Total fixed costs</td>
                  <td style="${tdR};color:#dc2626;font-weight:700">-${fC(totalFixedCost)}</td>
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
