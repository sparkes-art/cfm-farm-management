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
// Returns { revenueItems, costItems, priorYearCostItems, warnings }
//
// revenueItems:        [{ commodity, area_ha, total, section }]
//   section: 'farming' | 'other' | 'carry_over'
// costItems:           [{ description, budget_amount, category }]  — overhead / fixed
// priorYearCostItems:  [{ budget_code, description, budget_amount, enterprise }]
//   — EXP rows from the "EXPENSES FROM PRIOR YEAR" section (rows ~43–375)
//     These are variable costs for prior-year crops still on hand / in-field.
//     enterprise is parsed from 'E' rows that have an area value (e.g. "COTTON DL 2024 (250.03 HA)")
//     or set to 'Prior Year' for the general bucket.
//
// Income section structure (OT cashflow):
//   FARMING INCOME    → rows with CROPPING INCOME / LIVESTOCK INCOME sub-headings
//   OTHER INCOME      → agistment, interest, closing stock cattle/hay, etc.
//   CARRY OVER INCOME → prior-season crops on hand: total dollar value only, no area/yield
//   Row ~41: Farm Income total
//   Row ~43: EXPENSES FROM PRIOR YEAR (enterprise bucket, B='E')
//   Row ~44+: EXP rows for prior-year variable costs
//   ...continues until OVERHEAD EXPENSES
//
function _parseCashflowSheet(rows, sheetName) {
  const revenueItems        = [];
  const costItems           = [];
  const priorYearCostItems  = [];
  const capexItems          = [];
  const cattleCostItems     = [];
  const fallowCostItems     = [];
  const warnings            = [];

  // State machine
  let incomeSection  = 'farming';  // 'farming' | 'other' | 'carry_over'
  let inPriorYear    = false;      // between EXPENSES FROM PRIOR YEAR and OVERHEAD EXPENSES
  let inOverheads    = false;
  let inCapex        = false;
  let inCattle       = false;      // inside CATTLE variable cost section
  let inSheep        = false;      // inside SHEEP variable cost section
  let inNyCrops      = false;      // inside NEXT YEAR CROPS variable cost section
  let inFallow       = false;      // inside FALLOW variable cost section
  let fallowEnterprise = null;     // current fallow enterprise name
  let currentSection = null;       // overhead sub-section: 'overhead' | 'rm' | 'labour' | 'fund_mgmt'
  let pyEnterprise   = 'Prior Year'; // current enterprise for prior-year EXP rows

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

    // SheetJS sheet_to_json shifts cols left by 1 vs openpyxl (col A is always
    // empty in this sheet so SheetJS skips it). Effective mapping:
    //   idx 0 = col B = tag (I / E / H / EXP)
    //   idx 2 = col D = description
    //   idx 4 = col F = current-year budget total
    //   idx 29 = col AE = budget area (ha)
    const tag  = str(row[0]);      // col B (SheetJS idx 0)
    const desc = str(row[2]);      // col D (SheetJS idx 2)
    const totalRaw = row[4];       // col F — current-year budget total (SheetJS idx 4)
    const total = num(totalRaw);
    const descL = low(desc);

    // ── Detect transition into capex section ──
    if (inOverheads && !inCapex && descL.includes('capital expenditure')) {
      inCapex = true;
      inOverheads = false;
      continue;
    }

    // ── CAPEX section — tag 'A' rows ──
    // In Excel cashflow: negative value = sale of machinery (cash inflow shown as negative cost)
    //                    positive value = purchase (cash outflow)
    // Store as signed for budget_costs: positive = purchase cost, negative = sale offset
    // So: Excel negative (sale) → store negative; Excel positive (purchase) → store positive
    if (inCapex) {
      // Subtotals between CAPEX sub-sections: keep going (don't break the loop)
      if (descL === 'subtotal' || descL.startsWith('total') || descL.startsWith('earnings')) continue;
      // Exit CAPEX when we reach the FUNDING section or a non-tag row that looks like a summary
      if (tag === 'E' && (descL === 'funding' || descL.includes('overhead'))) {
        inCapex = false;
        // fall through to the normal section handlers below
      } else {
        if (tag === 'H' || tag === 'E') continue;  // CAPEX sub-section headers (incl. "ALMONDS - STAGE N")
        if (tag === 'A' && desc && total != null && total !== 0) {
          capexItems.push({
            budget_code:   desc.toUpperCase().trim(),
            description:   desc,
            budget_amount: total,   // keep sign: negative = sale offset, positive = purchase cost
            is_sale:       total < 0,
          });
        }
        continue;
      }
    }

    // ── Detect transition into overhead section ──
    if (!inOverheads && descL.includes(OVERHEAD_SECTION_START)) {
      inPriorYear = false;
      inCattle    = false;
      inSheep     = false;
      inNyCrops   = false;
      inFallow    = false;
      inOverheads = true;
      currentSection = null;
      continue;
    }

    // ── Overhead section ──
    if (inOverheads) {
      if (tag === 'E' || !tag) {
        for (const [key, cat] of Object.entries(SECTION_MAP)) {
          if (descL.includes(key)) { currentSection = cat; break; }
        }
        if (descL.includes('finance costs')) currentSection = 'finance';
        if (tag !== 'EXP') continue;
      }

      if (tag === 'H' || descL === 'subtotal' || descL.startsWith('total')) continue;

      if (tag === 'EXP' && currentSection && total && total > 0) {
        costItems.push({ description: desc, budget_amount: total, category: currentSection });
      }
      continue;
    }

    // ── Cattle variable costs section ──
    // Triggered by E row "CATTLE 2024" (or similar) in the farming expenses area
    if (!inCattle && tag === 'E' && descL.startsWith('cattle')) {
      inCattle = true;
      continue;
    }
    if (inCattle) {
      if (descL === 'subtotal' || descL.startsWith('total')) { inCattle = false; continue; }
      if (tag === 'H') continue;
      if (tag === 'EXP' && desc && total != null && total > 0) {
        cattleCostItems.push({
          budget_code:   desc.toUpperCase().trim(),
          description:   desc,
          budget_amount: total,
          enterprise:    'CATTLE',
        });
      }
      continue;
    }

    // ── Sheep variable costs section ──
    // Triggered by E row starting with "sheep" in the farming expenses area
    if (!inSheep && tag === 'E' && descL.startsWith('sheep')) {
      inSheep = true;
      continue;
    }
    if (inSheep) {
      if (descL === 'subtotal' || descL.startsWith('total')) { inSheep = false; continue; }
      if (tag === 'H') continue;
      if (tag === 'EXP' && desc && total != null && total > 0) {
        cattleCostItems.push({
          budget_code:   desc.toUpperCase().trim(),
          description:   desc,
          budget_amount: total,
          enterprise:    'SHEEP',
        });
      }
      continue;
    }

    // ── Next Year Crops variable costs section ──
    // These are pre-paid costs for the FOLLOWING season — not current-year expenses.
    // Skip the entire section so they don't inflate current-year crop cost totals.
    if (!inNyCrops && tag === 'E' && descL.includes('next year crops')) {
      inNyCrops = true;
      continue;
    }
    if (inNyCrops) {
      if (descL === 'subtotal' || descL.startsWith('total')) { inNyCrops = false; }
      continue;  // skip all rows in this section
    }

    // ── Fallow variable costs section ──
    // Triggered by E row containing "fallow" in the farming expenses area
    if (!inFallow && tag === 'E' && descL.includes('fallow')) {
      inFallow = true;
      fallowEnterprise = desc.trim().toUpperCase();
      continue;
    }
    if (inFallow) {
      if (descL === 'subtotal' || descL.startsWith('total')) { inFallow = false; continue; }
      if (tag === 'H') continue;
      if (tag === 'EXP' && desc && total != null && total > 0) {
        fallowCostItems.push({
          budget_code:   desc.toUpperCase().trim(),
          description:   desc,
          budget_amount: total,
          enterprise:    fallowEnterprise,
        });
      }
      continue;
    }

    // ── Prior year expenses section ──
    // Triggered by B='E' and D='EXPENSES FROM PRIOR YEAR'
    if (!inPriorYear && tag === 'E' && descL.includes('expenses from prior year')) {
      inPriorYear = true;
      pyEnterprise = 'Prior Year';
      continue;
    }

    if (inPriorYear) {
      // The prior year section has two layers:
      //   Layer 1: general EXP rows (rows 45-66) — the total pool, subtotals ~$140k
      //   Layer 2: per-enterprise breakdown of the same costs (B='E' header e.g. "COTTON DL 2024")
      // We only capture layer 1 and stop at the first Subtotal row to avoid doubling.
      if (descL === 'subtotal') {
        inPriorYear = false;  // stop — layer 2 below is the same costs broken out by crop
        continue;
      }

      // Skip heading rows
      if (tag === 'H') continue;
      if (descL.startsWith('total')) continue;

      // EXP rows = prior-year variable cost lines (layer 1 only)
      if (tag === 'EXP' && desc && total != null && total > 0) {
        priorYearCostItems.push({
          budget_code:    desc.toUpperCase().trim(),
          description:    desc,
          budget_amount:  total,
          enterprise:     'Prior Year',
        });
      }
      continue;
    }

    // ── Revenue / Income section ──

    // Detect income sub-section transitions from heading rows
    if (tag === 'H' || tag === 'E') {
      if (descL.includes('other income'))        incomeSection = 'other';
      else if (descL.includes('carry over') || descL.includes('prior year crop')) incomeSection = 'carry_over';
      else if (descL.includes('cropping income') || descL.includes('livestock income') || descL.includes('farming income')) incomeSection = 'farming';
      continue;
    }

    // Skip subtotals / totals
    if (descL === 'subtotal' || descL.startsWith('total') || descL === 'farm income') continue;

    // Income rows: tagged 'I' OR untagged with a non-zero value in col F and a description
    // (Some rows like RHODES HAY IRR, CORN IRR have no tag but are genuine income lines)
    const isTaggedIncome   = tag === 'I';
    const isUntaggedIncome = !tag && desc && total && total > 0 &&
                             !descL.includes('subtotal') && !descL.includes('income') &&
                             !descL.includes('expense') && !descL.includes('farming');

    if ((isTaggedIncome || isUntaggedIncome) && desc && total && total > 0) {
      // col AE (SheetJS idx 29) = Budget Area (ha) — not meaningful for carry-over
      const area_ha = incomeSection === 'carry_over' ? null : (num(row[29]) || null);
      revenueItems.push({ commodity: desc, area_ha, total, section: incomeSection });
    }
  }

  if (!revenueItems.length) warnings.push(`[${sheetName}] No revenue rows found`);
  if (!costItems.length)    warnings.push(`[${sheetName}] No overhead cost rows found`);

  return { revenueItems, costItems, priorYearCostItems, capexItems, cattleCostItems, fallowCostItems, warnings };
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

    // Skip placeholder / spare sheets — these are formatting placeholders not real enterprises
    if (/^spare$/i.test(name.trim()) || /^spare$/i.test(sheetName.trim())) return null;

    // ── Cattle GM — different layout ──
    // Row 4 col 2 = total income; Row 5 col 2 = total costs (summary)
    // Variable cost rows start at row 14 (0-indexed):
    //   col 0 = budget_code (e.g. "LIVESTOCK CARTAGE")
    //   col 1 = description / operation
    //   col 7 = total cost ($) — NOT cost/ha (cattle is head-based, no area)
    //   col 38 = "Totals" column = annual total
    // Section headers: col 0 = non-all-caps label (e.g. "Animal Health Cows"),
    //                  col 6 = "Subtotal:"
    if (low(name).includes('cattle') || low(sheetName).includes('cattle gm')) {
      const totalRevenue = num((rows[4] || [])[2]) || num((rows[10] || [])[38]);
      const costLines    = [];
      let currentSection = null;
      const BUDGET_CODE_RE_CATTLE = /^[A-Z][A-Z\s&,\/\-]+$/;

      for (let ri = 11; ri < rows.length; ri++) {
        const row  = rows[ri] || [];
        const colA = str(row[0]);
        const colF = str(row[6]);
        const col38 = row[38];  // Totals column

        // Section headers: col G = "Subtotal:" with a non-budget-code in col A
        if (colF === 'Subtotal:' && colA && !BUDGET_CODE_RE_CATTLE.test(colA)) {
          currentSection = colA.trim();
          continue;
        }
        // Skip rows with no code or no total, and skip any summary/total rows
        if (!colA || col38 == null) continue;
        if (/total|subtotal/i.test(colA)) continue;
        // Budget code row
        if (BUDGET_CODE_RE_CATTLE.test(colA)) {
          const costTotal = num(col38);
          if (costTotal === null) continue;
          const desc = str(row[1]);
          costLines.push({
            budget_code:  colA.trim(),
            description:  desc || colA.trim(),
            subcategory:  currentSection,
            cost_per_ha:  null,   // cattle has no area/ha basis
            cost_total:   costTotal,
          });
        }
      }

      return {
        name: 'CATTLE SALES', area_ha: null, price: null, yieldPerHa: null,
        totalRevenue, unit: 'head', costLines,
        isCattle: true,
      };
    }

    // ── Cropping / Fallow GM ──
    const isFallow = low(name).includes('fallow') || low(sheetName).includes('fallow');

    // Row 3 col 7 = area ha (primary); also check col 8 and col 2 as fallbacks
    let area_ha = num((rows[3] || [])[7]);
    if (!area_ha || area_ha <= 0) area_ha = num((rows[3] || [])[8]);
    if (!area_ha || area_ha <= 0) area_ha = num((rows[3] || [])[2]);
    // For fallows, scan row 3 for any plausible area value (10–50000 ha)
    if ((!area_ha || area_ha <= 0) && isFallow) {
      for (let c = 1; c < (rows[3] || []).length; c++) {
        const v = num((rows[3] || [])[c]);
        if (v && v >= 1 && v <= 50000) { area_ha = v; break; }
      }
    }
    if (!area_ha || area_ha <= 0) return null;

    // Row 5 col 1 = income/ha (0 or null for fallows — that's fine)
    const incomePerHa = isFallow ? 0 : num((rows[5] || [])[1]);

    // Detect cotton (two products) vs single product
    // Row 10 col 0: "Lint:", "Grain:", or other label
    const productLabel = low(str((rows[10] || [])[0]));
    const isCotton = productLabel.includes('lint') && str((rows[12] || [])[0]).toLowerCase().includes('seed');

    let price, yieldPerHa, totalTonnes, unit;

    if (isCotton) {
      // Two layout variants for cotton:
      //   Blackbull: row 10 col 2 = lint price, row 11 col 2 = lint yield/ha
      //              row 12 col 2 = seed price, row 13 col 2 = seed yield
      //   Merrowie:  row 10 col 0 = "Lint Yield:",  col 1 = lint yield/ha
      //              row 11 col 0 = "Lint Price:",   col 1 = lint price
      //              row 12 col 0 = "Seed Yield...", col 1 = seed yield/bale
      //              row 13 col 0 = "Seed Price:",   col 1 = seed price
      const row10Label = low(str((rows[10] || [])[0]));
      const isMerrowieLayout = row10Label.includes('lint yield') || row10Label.includes('lint price');

      let lintPrice, lintYield, seedPrice, seedYield;
      if (isMerrowieLayout) {
        lintYield  = num((rows[10] || [])[1]);
        lintPrice  = num((rows[11] || [])[1]);
        seedYield  = num((rows[12] || [])[1]);
        seedPrice  = num((rows[13] || [])[1]);
      } else {
        lintPrice  = num((rows[10] || [])[2]);
        lintYield  = num((rows[11] || [])[2]);
        seedPrice  = num((rows[12] || [])[2]);
        seedYield  = num((rows[13] || [])[2]);
      }

      // Blended income/ha = lint price * lint yield + seed price * seed yield
      // (use incomePerHa from summary row as the authoritative figure)
      price      = lintPrice;   // report lint price as primary
      yieldPerHa = lintYield;
      totalTonnes = lintYield && area_ha ? lintYield * area_ha : null;
      unit = 'bales/ha (lint)';
    } else {
      // Detect layout variant:
      //   Blackbull format: row 10 col 2 = price, row 11 col 2 = yield
      //   Merrowie format:  row 10 col 0 = "Expected Yield:", col 1 = yield value
      //                     row 11 col 0 = "Expected Price:", col 1 = price value
      // SheetJS rows[] is 0-indexed; openpyxl reports 1-indexed row numbers.
      // openpyxl row N  →  SheetJS rows[N-1]
      // Merrowie standard layout (wheat, canola, etc.):
      //   opx row 11 (rows[10]) col 0 = "Expected Yield:", col 1 = yield value
      //   opx row 12 (rows[11]) col 0 = "Expected Price:", col 1 = price value
      // Barley Semi IRR layout:
      //   opx row 11 (rows[10]) col 0 = "Expected Grain Yield:", col 1 = yield
      //   opx row 12 (rows[11]) col 0 = "Expected Grain Price:", col 1 = price
      // Almonds layout (all stages):
      //   opx row 8  (rows[7])  col 0 = "Metrics"
      //   opx row 12 (rows[11]) col 0 = "Expected Yield:", col 7 = yield value
      //   opx row 14 (rows[13]) col 7 = indicative budget price
      const row8L  = low(str((rows[7]  || [])[0]));  // opx row 8
      const row10L = low(str((rows[10] || [])[0]));  // opx row 11 (standard yield label row)
      const row11L = low(str((rows[11] || [])[0]));  // opx row 12 (standard price label row)

      const isMerrowieLayout  = row10L.includes('expected yield') && !row10L.includes('grain');
      const isBarleyIrrLayout = row10L.includes('expected grain yield') || row11L.includes('expected grain price');
      // Almonds: row 8 = "Metrics", then scan rows 11-14 for "Expected Yield:" (offset varies by stage)
      let almondYieldRow = -1;
      if (row8L.includes('metrics') && !row10L.includes('expected yield') && !row10L.includes('grain')) {
        for (let ai = 10; ai <= 14; ai++) {
          if (low(str((rows[ai] || [])[0])).includes('expected yield')) { almondYieldRow = ai; break; }
        }
      }
      const isAlmondLayout    = almondYieldRow >= 0;

      if (isAlmondLayout) {
        // Almonds: yield at almondYieldRow col 7; price 2 rows later col 7 (indicative) or col 4 (cash)
        yieldPerHa  = num((rows[almondYieldRow] || [])[7]);
        const priceRow = almondYieldRow + 2;  // "Contracts to Date:" row with price cols
        price       = num((rows[priceRow] || [])[7]) || num((rows[priceRow] || [])[4]);
        // Skip #DIV/0! formula results (returned as string by SheetJS)
        if (typeof price === 'string') price = null;
        totalTonnes = yieldPerHa && area_ha ? yieldPerHa * area_ha : null;
        unit = 't/ha';
      } else if (isBarleyIrrLayout) {
        // Barley Semi IRR: grain yield at opx row 11 (rows[10]) col 1, price at opx row 12 (rows[11]) col 1
        yieldPerHa  = num((rows[10] || [])[1]);
        price       = num((rows[11] || [])[1]);
        totalTonnes = num((rows[10] || [])[8]) || (yieldPerHa && area_ha ? yieldPerHa * area_ha : null);
        unit = 't/ha';
      } else if (isMerrowieLayout) {
        // Standard Merrowie: Expected Yield at opx row 11 (rows[10]) col 1, price at opx row 12 (rows[11]) col 1
        yieldPerHa  = num((rows[10] || [])[1]);
        price       = num((rows[11] || [])[1]);
        // Production total: col 8 of price row or yield row
        totalTonnes = num((rows[11] || [])[8]) || num((rows[10] || [])[8]);
      } else {
        // Standard (Blackbull) layout: row 10 col 2 = price, row 11 col 2 = yield/ha
        price      = num((rows[10] || [])[2]);
        yieldPerHa = num((rows[11] || [])[2]);
      }

      // Total tonnes fallback — row 12 col 2 for most, search rows 12-14 for first non-null numeric
      if (!totalTonnes) totalTonnes = num((rows[12] || [])[2]);
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
      // Skip any summary/total rows that sneak through (e.g. "SPARE TOTAL", "TOTAL VARIABLE COSTS")
      if (colA && /total|subtotal/i.test(colA)) continue;

      if (colA && BUDGET_CODE_RE.test(colA) && colH !== null && colH !== undefined) {
        const costPerHa = num(colH);
        if (costPerHa === null) continue;  // non-numeric, skip
        const desc       = str(row[1]);    // col B = operation/product description
        const unitPrice  = num(row[5]);    // col F = cost/unit (e.g. $/litre, $/kg)
        const unitLabel  = str(row[6]);    // col G = unit label (e.g. '/Litre', '/kg', '/Pass')
        //   col C (row[2]) = applications, col E (row[4]) = rate/ha
        //   Cost/Ha = Applications × Rate/Ha × Cost/Unit — we store unit price for variance analysis
        costLines.push({
          budget_code:  colA.trim(),
          description:  desc || colA.trim(),
          subcategory:  currentSection,
          cost_per_ha:  costPerHa,
          unit_price:   unitPrice,    // price per unit (e.g. $1.25/kg for urea)
          unit:         unitLabel && unitLabel.startsWith('/') ? unitLabel.slice(1) : unitLabel || null,
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
    'op capex','prop capex','cattle program','ny crops','py crops',
    'pricing - app','pricing - inputs','pricing - livestock','codings',
    'end of sept property','ops summary',
    // Merrowie-specific non-GM sheets
    'budget summary','total crop expenses','accounting','yields','fallows',
    'sheep program','ny crops','gen capex','dev capex','oh + rnm','ops summary',
    'pistachios new planting',
  ]);

  // Sheets that are definitively GM enterprise sheets regardless of format
  const GM_PATTERNS = [
    'hay','cotton','corn','sorghum','millet','rhodes','cattle gm','sheep gm',
    'farm mgmt','fallow','oh + rnm','oh+rnm',
    // Grain / oilseed / legume patterns
    'wheat','barley','canola','chickpea','durum','vetch','oat','maize',
    'almond','pistachio','almond stage',
  ];

  for (const name of sheetNames) {
    const n = name.toLowerCase();

    // Cashflow sheets:
    //   Multi-entity workbooks (Blackbull): "OT - Master Cashflow", "PT - Master Cashflow"
    //   Single-entity workbooks (Merrowie): "Master Cashflow"
    // For multi-entity we only use OT to avoid double-counting interest/lease.
    // For single-entity we use the sheet directly.
    if (n.includes('master cashflow')) {
      if (n.startsWith('ot') || n === 'master cashflow') {
        cashflowSheets.push(name);
      } else {
        // PT or other entity cashflow — skip to avoid double-counting
        skipped.push(name);
      }
    } else if (SKIP.has(n) || n.includes('capex') || n.includes('pricing') || n.includes('calendar') ||
               n === 'finance costs' || n === 'farm mgmt') {
      skipped.push(name);
    } else if (GM_PATTERNS.some(p => n.includes(p))) {
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
  // Keep section from the first occurrence (OT cashflow is authoritative)
  const byKey = new Map();
  for (const item of items) {
    // Include section in key so carry-over and current-year items with the same
    // commodity name (e.g. WHEAT DL) are kept separate, not summed together.
    const section = item.section || 'farming';
    const key = section + '|' + item.commodity.toUpperCase().replace(/\s+/g,' ').trim();
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
      // section is a UI-only field for the preview — not stored in budgets table
      section:               item.section || 'farming',
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
    // Skip any GM without cost lines
    if (!gm.costLines || !gm.costLines.length) continue;

    const enterprise = gm.name;
    const area_ha    = gm.area_ha;   // null for cattle

    // Each line is stored individually to preserve unit_price per product/pass.
    // Same budget_code can appear multiple times (e.g. Diesel across several passes) —
    // these are kept as separate rows so unit price and usage context are retained.
    // budget_amount is cost/ha × area_ha for each line (null when area unknown).
    for (const line of gm.costLines) {
      let cost_per_ha_val, budget_amount;
      if (gm.isCattle) {
        cost_per_ha_val = null;
        budget_amount   = line.cost_total;
      } else {
        cost_per_ha_val = line.cost_per_ha;
        budget_amount   = (area_ha != null && line.cost_per_ha != null)
          ? line.cost_per_ha * area_ha
          : null;
      }

      rows.push({
        farm_id:        farmId,
        financial_year: financialYear,
        category:       'variable',
        subcategory:    line.subcategory || null,
        enterprise:     enterprise,
        budget_code:    line.budget_code,
        description:    line.description,
        cost_per_ha:    cost_per_ha_val,
        unit_price:     line.unit_price  ?? null,
        unit:           line.unit        ?? null,
        area_ha:        area_ha,
        budget_amount:  budget_amount,
        notes:          gm.isCattle ? 'Cattle: total cost (head-based, no $/ha)' :
                        (low(enterprise).includes('fallow') ? 'Fallow: no revenue, costs only' : null),
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

// ── Prior year cost consolidation (from OT cashflow EXP rows ~43-375) ────────
//
// These rows represent variable costs for crops still being processed / sold
// from the prior season (e.g. late ginning, cartage, license fees for
// cotton harvested in the previous year).
// They appear in the OT cashflow as EXP rows between:
// ── Cattle Program sheet parser ────────────────────────────────────────────
// Extracts livestock metrics: total head, total sales $, total kg, avg $/head, avg kg/head
// Scans each row for keyword labels; values are the first numeric found after the label cell.
// Per-class data rows have: description | head count | avg kg/head | $/kg (consecutive numeric cols)
function _parseCattleProgram(rows) {
  const num = v => (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
  const str = v => (v !== null && v !== undefined) ? String(v).trim() : '';

  // Find first numeric value in a row scanning from startCol onward
  const firstNum = (row, startCol = 0) => {
    for (let c = startCol; c < row.length; c++) {
      const n = num(row[c]);
      if (n !== null) return n;
    }
    return null;
  };

  let totalHead  = null;
  let totalSales = null;
  let totalKg    = 0;
  let classRows  = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    // Search all cols for the label (could be col A, B, etc.)
    let labelCol = -1;
    let labelText = '';
    for (let c = 0; c < Math.min(row.length, 6); c++) {
      const s = str(row[c]).toLowerCase();
      if (s) { labelText = s; labelCol = c; break; }
    }
    if (labelCol < 0) continue;

    if (labelText.includes('total head sold') || labelText.includes('total head')) {
      // Value is an integer (head count) — scan from next col
      for (let c = labelCol + 1; c < row.length; c++) {
        const n = num(row[c]);
        if (n !== null && Number.isInteger(n) && n > 0 && n < 100000) {
          totalHead = n; break;
        }
        // Also accept non-integer that looks like a round head count
        if (n !== null && n > 0 && n < 100000 && n === Math.round(n)) {
          totalHead = n; break;
        }
      }
      continue;
    }

    if (labelText.includes('total sales') || (labelText.includes('total') && labelText.includes('sales'))) {
      // Value is a large dollar amount — scan from next col
      for (let c = labelCol + 1; c < row.length; c++) {
        const n = num(row[c]);
        if (n !== null && n > 10000) { totalSales = n; break; }
      }
      continue;
    }

    // Per-class rows: description (non-empty, not a total/subtotal label),
    // followed by head count, then avg kg/head, then $/kg
    // Skip summary/total rows
    if (labelText.startsWith('total') || labelText.startsWith('subtotal') ||
        labelText.startsWith('grand') || labelText === '') continue;

    // Collect up to 5 numeric values after the label
    const nums = [];
    for (let c = labelCol + 1; c < row.length && nums.length < 5; c++) {
      const n = num(row[c]);
      if (n !== null) nums.push(n);
    }
    // Need at least head, kg/head, $/kg — all positive, $/kg < 50 (plausible cattle $/kg)
    if (nums.length >= 3) {
      const [head, wtHead, dolKg] = nums;
      if (head > 0 && head < 10000 && wtHead > 50 && wtHead < 2000 && dolKg > 0 && dolKg < 50) {
        const classKg = head * wtHead;
        totalKg += classKg;
        classRows.push({ description: str(row[labelCol]), head, wtHead, dolKg, classKg });
      }
    }
  }

  if (totalHead === null && !classRows.length) return null;

  // Derive totals from class rows if summary rows weren't found
  if (totalHead === null) totalHead = classRows.reduce((s, r) => s + r.head, 0);
  if (!totalKg)           totalKg   = classRows.reduce((s, r) => s + r.classKg, 0);

  const avgPricePerHead = (totalHead && totalSales) ? totalSales / totalHead : null;
  const avgKgPerHead    = (totalHead && totalKg)    ? totalKg    / totalHead  : null;

  return { totalHead, totalSales, totalKg, avgPricePerHead, avgKgPerHead, classRows };
}

// ── Sheep GM metrics ──────────────────────────────────────────────────────
// Extracts summary metrics from the Sheep GM sheet (single-entity Merrowie layout).
// Row 5:  "Total Income"       col 2 = total income
// Row 6:  "Total Costs"        col 2 = total costs
// Row 11: "Expected Sales:"    col 7 = sheep sale revenue
// Row 12: "Wool Sales:"        col 7 = wool sale revenue
function _parseSheepGm(rows) {
  if (!rows || rows.length < 13) return null;
  const num = v => (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) ? Number(v) : null;
  const str = v => (v !== null && v !== undefined) ? String(v).trim() : '';
  const low = s => s.toLowerCase();

  let totalIncome    = null;
  let totalCosts     = null;
  let sheepSales     = null;
  let woolSales      = null;

  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const row = rows[i] || [];
    const label = low(str(row[0]));
    if (label.includes('total income'))    totalIncome = num(row[2]);
    if (label.includes('total costs'))     totalCosts  = num(row[2]);
    if (label.includes('expected sales'))  sheepSales  = num(row[7]) ?? num(row[2]);
    if (label.includes('wool sales'))      woolSales   = num(row[7]) ?? num(row[2]);
  }

  if (!sheepSales && !woolSales && !totalIncome) return null;

  return { totalIncome, totalCosts, sheepSales, woolSales };
}

// ── Cattle variable costs (from cashflow, not GM) ─────────────────────────
function _consolidateCattleCosts(items, financialYear, farmId) {
  if (!items.length) return [];

  // Deduplicate across OT+PT sheets by budget_code
  const byKey = new Map();
  for (const item of items) {
    const key = item.budget_code;
    if (byKey.has(key)) {
      byKey.get(key).budget_amount += (item.budget_amount || 0);
    } else {
      byKey.set(key, { ...item });
    }
  }

  return [...byKey.values()].map(item => ({
    farm_id:        farmId,
    financial_year: financialYear,
    category:       'variable',
    subcategory:    'Livestock',
    enterprise:     'CATTLE',
    budget_code:    item.budget_code,
    description:    item.description,
    cost_per_ha:    null,
    unit_price:     null,
    unit:           null,
    area_ha:        null,
    budget_amount:  item.budget_amount,
    notes:          'Cattle variable costs from cashflow',
  }));
}

function _consolidateFallowCosts(items, financialYear, farmId) {
  if (!items.length) return [];

  // Deduplicate by enterprise+budget_code
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.enterprise}|${item.budget_code}`;
    if (byKey.has(key)) {
      byKey.get(key).budget_amount += (item.budget_amount || 0);
    } else {
      byKey.set(key, { ...item });
    }
  }

  return [...byKey.values()].map(item => ({
    farm_id:        farmId,
    financial_year: financialYear,
    category:       'variable',
    subcategory:    'Fallow',
    enterprise:     item.enterprise || 'FALLOW',
    budget_code:    item.budget_code,
    description:    item.description,
    cost_per_ha:    null,
    unit_price:     null,
    unit:           null,
    area_ha:        null,
    budget_amount:  item.budget_amount,
    notes:          'Fallow variable costs from cashflow',
  }));
}

// ── CAPEX consolidation ───────────────────────────────────────────────────
function _consolidateCapex(items, financialYear, farmId) {
  if (!items.length) return [];

  // Deduplicate by budget_code across OT+PT
  const byKey = new Map();
  for (const item of items) {
    const key = item.budget_code;
    if (byKey.has(key)) {
      byKey.get(key).budget_amount += (item.budget_amount || 0);
    } else {
      byKey.set(key, { ...item });
    }
  }

  return [...byKey.values()].map(item => ({
    farm_id:        farmId,
    financial_year: financialYear,
    category:       'capex',
    subcategory:    item.is_sale ? 'Machinery Sale' : 'Capital Expenditure',
    enterprise:     null,
    budget_code:    item.budget_code,
    description:    item.description,
    cost_per_ha:    null,
    unit_price:     null,
    unit:           null,
    area_ha:        null,
    budget_amount:  item.budget_amount,  // positive = purchase cost, negative = sale offset
    notes:          item.is_sale ? 'Machinery sale proceeds from cashflow' : 'Capital expenditure from cashflow',
  }));
}

//   "EXPENSES FROM PRIOR YEAR" (row ~43) and "OVERHEAD EXPENSES" (row ~378)
// Enterprise buckets within this section are announced by 'E' rows
// (e.g. "COTTON DL 2024 (250.03 HA)").
//
function _consolidatePriorYearCosts(items, financialYear, farmId) {
  if (!items.length) return [];

  // Deduplicate: same enterprise + budget_code → sum
  const byKey = new Map();
  for (const item of items) {
    const key = `${item.enterprise}||${item.budget_code}`;
    if (byKey.has(key)) {
      byKey.get(key).budget_amount += (item.budget_amount || 0);
    } else {
      byKey.set(key, { ...item });
    }
  }

  return [...byKey.values()].map(item => ({
    farm_id:        farmId,
    financial_year: financialYear,
    category:       'variable',
    subcategory:    'Prior Year Expenses',
    enterprise:     item.enterprise,
    budget_code:    item.budget_code,
    description:    item.description,
    cost_per_ha:    null,    // no ha basis — this is a cashflow total
    unit_price:     null,
    unit:           null,
    area_ha:        null,
    budget_amount:  item.budget_amount,
    notes:          'Prior year crop expenses (from OT cashflow)',
  })).sort((a, b) => {
    const ea = a.enterprise || '', eb = b.enterprise || '';
    if (ea !== eb) return ea.localeCompare(eb);
    return (a.budget_code || '').localeCompare(b.budget_code || '');
  });
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
    unit_price:     null,
    unit:           null,
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
  const allRevenueItems       = [];
  const allCostItems          = [];
  const allPriorYearCostItems = [];
  const allCapexItems         = [];
  const allCattleCostItems    = [];
  const allFallowCostItems    = [];

  for (const sheetName of cashflowSheets) {
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const result = _parseCashflowSheet(rows, sheetName);
    allRevenueItems.push(...result.revenueItems);
    allCostItems.push(...result.costItems);
    allPriorYearCostItems.push(...(result.priorYearCostItems || []));
    allCapexItems.push(...(result.capexItems || []));
    allCattleCostItems.push(...(result.cattleCostItems || []));
    allFallowCostItems.push(...(result.fallowCostItems || []));
    allWarnings.push(...result.warnings);
  }

  // ── Parse Cattle Program sheet for livestock metrics ──
  let cattleMetrics = null;
  if (wb.Sheets['Cattle Program']) {
    const cpRows = window.XLSX.utils.sheet_to_json(wb.Sheets['Cattle Program'], { header: 1, raw: true, defval: null });
    cattleMetrics = _parseCattleProgram(cpRows);
  }

  // ── Parse Sheep GM sheet for livestock metrics (metrics only — costs come from cashflow) ──
  let sheepMetrics = null;
  const sheepGmSheet = Object.keys(wb.Sheets).find(s => low(s) === 'sheep gm' || low(s).includes('sheep gm'));
  if (sheepGmSheet) {
    const sgRows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheepGmSheet], { header: 1, raw: true, defval: null });
    sheepMetrics = _parseSheepGm(sgRows);
  }

  // ── Parse GM sheets for cropping enterprise detail (skip Cattle GM and Sheep GM — costs come from cashflow) ──
  const gmData = new Map();
  for (const sheetName of gmSheets) {
    if (low(sheetName).includes('cattle')) continue;  // cattle costs from cashflow, not GM
    if (low(sheetName).includes('sheep gm') || low(sheetName) === 'sheep gm') continue;  // sheep costs from cashflow, not GM
    const rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });
    const gm = _parseGmSheet(rows, sheetName);
    if (gm) {
      const keyBySheet = sheetName.toUpperCase().replace(/\s+/g,' ').trim();
      const keyByName  = gm.name.toUpperCase().replace(/\s+/g,' ').trim();
      gmData.set(keyBySheet, gm);
      if (keyByName !== keyBySheet) gmData.set(keyByName, gm);
    }
  }

  const fy = financialYear || 'UNKNOWN';

  // ── Consolidate ──
  const revenueRows      = _consolidateRevenue(allRevenueItems, fy, farm.id, gmData);
  const fixedCostRows    = _consolidateCosts(allCostItems, fy, farm.id);
  const variableCostRows = _consolidateVariableCosts(gmData, fy, farm.id);
  const priorYearCostRows = _consolidatePriorYearCosts(allPriorYearCostItems, fy, farm.id);

  // Cattle variable costs from cashflow (deduplicated across OT+PT sheets)
  const cattleCostRows = _consolidateCattleCosts(allCattleCostItems, fy, farm.id);

  // Fallow variable costs from cashflow (deduplicated by enterprise+budget_code)
  const fallowCostRows = _consolidateFallowCosts(allFallowCostItems, fy, farm.id);

  // CAPEX rows (deduplicated by budget_code)
  const capexRows = _consolidateCapex(allCapexItems, fy, farm.id);

  // Combined cost rows: variable (GM crops) → fallow → prior year → cattle → fixed → capex
  const costRows = [...variableCostRows, ...fallowCostRows, ...priorYearCostRows, ...cattleCostRows, ...fixedCostRows, ...capexRows];

  if (!revenueRows.length && !costRows.length) {
    allWarnings.push('No data could be extracted — check that the file matches the expected CFM budget format');
  }

  const enterprisesWithCosts = new Set(variableCostRows.map(r => r.enterprise)).size;
  if (variableCostRows.length) {
    allWarnings.push(`ℹ ${variableCostRows.length} variable cost lines across ${enterprisesWithCosts} enterprises`);
  }
  if (priorYearCostRows.length) {
    allWarnings.push(`ℹ ${priorYearCostRows.length} prior-year expense lines from cashflow`);
  }
  if (fallowCostRows.length) {
    allWarnings.push(`ℹ ${fallowCostRows.length} fallow cost lines from cashflow`);
  }
  if (capexRows.length) {
    const capexSales = capexRows.filter(r => r.is_sale).length;
    allWarnings.push(`ℹ ${capexRows.length} CAPEX lines (${capexSales} machinery sale${capexSales !== 1 ? 's' : ''})`);
  }

  return {
    farm,
    financialYear,
    revenueRows,
    costRows,
    variableCostRows,
    fallowCostRows,
    priorYearCostRows,
    cattleCostRows,
    fixedCostRows,
    capexRows,
    cattleMetrics,
    sheepMetrics,
    warnings: allWarnings,
    fileName: file.name,
    sheetNames,
  };
}

// ── Preview UI ─────────────────────────────────────────────────────────────
const fC = n => n != null ? '$' + Math.round(n).toLocaleString() : '—';
const fN = (n, dp = 0) => n != null ? parseFloat(n).toFixed(dp) : '—';

export function showBudgetImportPreview(container, parsed) {
  const { farm, financialYear, revenueRows, costRows, variableCostRows, fallowCostRows, priorYearCostRows, cattleCostRows, fixedCostRows, capexRows, cattleMetrics, sheepMetrics, warnings, fileName } = parsed;

  const catLabels = {
    variable:  'Variable (crop/livestock)',
    labour:    'Labour & Farm Mgmt',
    overhead:  'Overheads',
    rm:        'Repairs & Maintenance',
    fund_mgmt: 'Fund Management',
    finance:   'Finance Costs',
  };

  // Split revenue into three sections
  const farmingRevRows   = revenueRows.filter(r => r.section === 'farming');
  const otherRevRows     = revenueRows.filter(r => r.section === 'other');
  const carryOverRevRows = revenueRows.filter(r => r.section === 'carry_over');

  const totalFarmingRev  = farmingRevRows.reduce((s, r)   => s + (r.budgeted_gross_revenue || 0), 0);
  const totalOtherRev    = otherRevRows.reduce((s, r)     => s + (r.budgeted_gross_revenue || 0), 0);
  const totalCarryRev    = carryOverRevRows.reduce((s, r) => s + (r.budgeted_gross_revenue || 0), 0);
  const totalRev         = totalFarmingRev + totalOtherRev + totalCarryRev;

  const totalVarCost     = (variableCostRows  || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalFallowCostH = (fallowCostRows    || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalPYCost      = (priorYearCostRows || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalCattleCost  = (cattleCostRows    || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalFixedCost   = (fixedCostRows     || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalCapex       = (capexRows         || []).reduce((s, r) => s + (r.budget_amount || 0), 0);
  const totalCost        = totalVarCost + totalFallowCostH + totalPYCost + totalCattleCost + totalFixedCost + totalCapex;

  // Group variable costs by enterprise for display
  const varByEnterprise = {};
  for (const r of (variableCostRows || [])) {
    const e = r.enterprise || 'Unknown';
    if (!varByEnterprise[e]) varByEnterprise[e] = { rows: [], total: 0 };
    varByEnterprise[e].rows.push(r);
    varByEnterprise[e].total += (r.budget_amount || 0);
  }

  // Group prior year costs by enterprise
  const pyByEnterprise = {};
  for (const r of (priorYearCostRows || [])) {
    const e = r.enterprise || 'Prior Year';
    if (!pyByEnterprise[e]) pyByEnterprise[e] = { rows: [], total: 0 };
    pyByEnterprise[e].rows.push(r);
    pyByEnterprise[e].total += (r.budget_amount || 0);
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

  // Helper to render a revenue section table
  const renderRevSection = (title, rows, sectionTotal, showYield = true, isCarryOver = false) => {
    if (!rows.length) return '';
    return `
      <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:12px">
        <div style="padding:8px 16px;background:#f0fdf4;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between">
          <span>${title}</span>
          <span style="color:#16a34a">${fC(sectionTotal)}</span>
        </div>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr>
                <th style="${th};text-align:left">Enterprise / Item</th>
                ${showYield ? `<th style="${thR}">Area (ha)</th><th style="${thR}">Price</th><th style="${thR}">Yield/ha</th><th style="${thR}">Income/ha</th>` : ''}
                <th style="${thR}">Budget revenue</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(r => {
                const incomeHa = (r.area_ha && r.budgeted_gross_revenue) ? r.budgeted_gross_revenue / r.area_ha : null;
                return `
                <tr>
                  <td style="${td}${isCarryOver ? ';color:#6b7280;font-style:italic' : ''}">${r.commodity}</td>
                  ${showYield ? `
                    <td style="${tdR}">${fN(r.area_ha, 1)}</td>
                    <td style="${tdR}">${r.budgeted_price ? '$' + fN(r.budgeted_price, 0) : '—'}</td>
                    <td style="${tdR}">${r.budgeted_yield_per_ha ? fN(r.budgeted_yield_per_ha, 1) : '—'}</td>
                    <td style="${tdR}">${incomeHa ? '$' + fN(incomeHa, 0) : '—'}</td>
                  ` : ''}
                  <td style="${tdR};color:#16a34a;font-weight:600">${fC(r.budgeted_gross_revenue)}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  };

  container.innerHTML = `
    <div style="max-width:900px;margin:0 auto;padding:20px 24px">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
        <button class="btn btn-ghost btn-sm" id="bud-import-back">← Back</button>
        <h2 style="font-size:18px;font-weight:700;margin:0">Budget import preview</h2>
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 18px;margin-bottom:16px">
        <div style="display:flex;align-items:baseline;gap:16px;margin-bottom:10px;flex-wrap:wrap">
          <div style="font-size:12px;color:#64748b">File: <strong style="color:#1e293b">${fileName}</strong></div>
          <div style="font-size:12px;color:#64748b">Farm: <strong style="color:#1e293b">${farm.name}</strong></div>
          <div style="font-size:12px;color:#64748b">Year:
            ${financialYear
              ? `<strong style="color:#1e293b">${financialYear}</strong>`
              : `<input id="bud-import-fy" type="text" class="input input-sm" placeholder="e.g. 2026-27" style="width:100px;display:inline-block;margin-left:4px"> <span style="color:#ef4444;font-size:11px">⚠ enter manually</span>`}
          </div>
          <div style="font-size:11px;color:#94a3b8">${parsed.sheetNames.filter(n => n.toLowerCase().includes('master cashflow')).length} cashflow sheet(s) · ${revenueRows.length} revenue rows · ${(variableCostRows||[]).length + (fallowCostRows||[]).length + (priorYearCostRows||[]).length + (cattleCostRows||[]).length} crop/livestock cost rows · ${(fixedCostRows||[]).length} fixed cost rows · ${(capexRows||[]).length} CAPEX rows</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">

          <!-- Income block -->
          <div style="background:white;border:1px solid #d1fae5;border-radius:6px;padding:10px 12px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#16a34a;margin-bottom:6px">Income</div>
            <div style="font-size:11px;color:#374151;display:flex;flex-direction:column;gap:3px">
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Cropping / farming incl. livestock</span>
                <span style="font-weight:600">${fC(totalFarmingRev)}</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Other income</span>
                <span style="font-weight:600">${fC(totalOtherRev)}</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Income from prior year</span>
                <span style="font-weight:600">${fC(totalCarryRev)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;border-top:1px solid #e5e7eb;margin-top:4px;padding-top:4px">
                <span style="font-weight:700">Total income</span>
                <span style="font-weight:700;color:#16a34a">${fC(totalRev)}</span>
              </div>
            </div>
          </div>

          <!-- Expenses block -->
          <div style="background:white;border:1px solid #fee2e2;border-radius:6px;padding:10px 12px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#dc2626;margin-bottom:6px">Expenses</div>
            <div style="font-size:11px;color:#374151;display:flex;flex-direction:column;gap:3px">
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Crop variable costs</span>
                <span style="font-weight:600">-${fC(totalVarCost)}</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Fallow costs</span>
                <span style="font-weight:600">-${fC(totalFallowCostH)}</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Prior year crop expenses</span>
                <span style="font-weight:600">-${fC(totalPYCost)}</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Livestock costs</span>
                <span style="font-weight:600">-${fC(totalCattleCost)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;border-top:1px dashed #fecaca;margin-top:2px;padding-top:4px">
                <span style="font-weight:600;color:#374151">All crop expenses</span>
                <span style="font-weight:600;color:#dc2626">-${fC(totalVarCost + totalFallowCostH + totalPYCost + totalCattleCost)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;margin-top:2px">
                <span style="color:#6b7280">Total fixed costs</span>
                <span style="font-weight:600">-${fC(totalFixedCost)}</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">CAPEX (net)</span>
                <span style="font-weight:600;color:${totalCapex < 0 ? '#16a34a' : 'inherit'}">${totalCapex < 0 ? '+' : '-'}${fC(Math.abs(totalCapex))}</span>
              </div>
            </div>
          </div>

          <!-- Summary block -->
          <div style="background:white;border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px">
            <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#475569;margin-bottom:6px">Summary</div>
            <div style="font-size:11px;color:#374151;display:flex;flex-direction:column;gap:3px">
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Total income</span>
                <span style="font-weight:600;color:#16a34a">${fC(totalRev)}</span>
              </div>
              <div style="display:flex;justify-content:space-between">
                <span style="color:#6b7280">Expenses (incl. CAPEX)</span>
                <span style="font-weight:600;color:#dc2626">-${fC(totalCost)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;border-top:2px solid #e2e8f0;margin-top:4px;padding-top:4px">
                <span style="font-weight:700">Surplus / Deficit</span>
                <span style="font-weight:700;font-size:13px;color:${totalRev - totalCost >= 0 ? '#16a34a' : '#dc2626'}">${totalRev - totalCost >= 0 ? '' : '-'}${fC(Math.abs(totalRev - totalCost))}</span>
              </div>
            </div>
          </div>

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
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between">
            <span>Revenue — ${revenueRows.length} income items</span>
            <span style="color:#16a34a;font-weight:700">${fC(totalRev)}</span>
          </div>
          <div style="padding:12px 16px">
            ${(() => {
              // Farming Income: cropping rows table + livestock metrics cards inline
              const isCattle = r => r.commodity.toUpperCase().includes('CATTLE');
              const isSheep  = r => r.commodity.toUpperCase().includes('SHEEP SALES') || r.commodity.toUpperCase().includes('WOOL SALES');
              const cropRows = farmingRevRows.filter(r => !isCattle(r) && !isSheep(r));
              const cattleRevRow  = farmingRevRows.find(r => isCattle(r));
              const sheepSalesRow = farmingRevRows.find(r => r.commodity.toUpperCase().includes('SHEEP SALES'));
              const woolSalesRow  = farmingRevRows.find(r => r.commodity.toUpperCase().includes('WOOL SALES'));
              const totalCropRev  = cropRows.reduce((s, r) => s + (r.budgeted_gross_revenue || 0), 0);
              const totalSheepRev = (sheepSalesRow?.budgeted_gross_revenue || 0) + (woolSalesRow?.budgeted_gross_revenue || 0);
              return `
                ${renderRevSection('Farming Income — Cropping', cropRows, totalCropRev, true, false)}
                ${cattleRevRow || cattleMetrics ? `
                  <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:12px">
                    <div style="padding:8px 16px;background:#fef9f0;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between">
                      <span>🐄 Livestock — Cattle Sales</span>
                      <span style="color:#16a34a">${fC((cattleRevRow?.budgeted_gross_revenue) || (cattleMetrics?.totalSales))}</span>
                    </div>
                    ${cattleMetrics ? `
                      <div style="padding:12px 16px">
                        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:${cattleMetrics.classRows?.length ? '12px' : '0'}">
                          ${[
                            ['Total head sold', cattleMetrics.totalHead != null ? cattleMetrics.totalHead.toLocaleString() + ' hd' : '—'],
                            ['Avg price / head', cattleMetrics.avgPricePerHead != null ? fC(cattleMetrics.avgPricePerHead) : '—'],
                            ['Total kg', cattleMetrics.totalKg ? Math.round(cattleMetrics.totalKg).toLocaleString() + ' kg' : '—'],
                            ['Avg kg / head', cattleMetrics.avgKgPerHead != null ? fN(cattleMetrics.avgKgPerHead, 0) + ' kg' : '—'],
                          ].map(([label, val]) => `
                            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;text-align:center">
                              <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</div>
                              <div style="font-size:15px;font-weight:700;color:#1e293b">${val}</div>
                            </div>
                          `).join('')}
                        </div>
                        ${cattleMetrics.classRows?.length ? `
                          <table style="width:100%;border-collapse:collapse;font-size:11px">
                            <thead><tr>
                              <th style="${th};text-align:left">Class</th>
                              <th style="${thR}">Head</th>
                              <th style="${thR}">Avg kg/hd</th>
                              <th style="${thR}">$/kg</th>
                              <th style="${thR}">Total kg</th>
                              <th style="${thR}">Value</th>
                            </tr></thead>
                            <tbody>
                              ${cattleMetrics.classRows.map((cr, i) => `
                                <tr style="${i % 2 === 0 ? '' : 'background:#fafafa'}">
                                  <td style="${td}">${cr.description}</td>
                                  <td style="${tdR}">${cr.head.toLocaleString()}</td>
                                  <td style="${tdR}">${fN(cr.wtHead, 0)} kg</td>
                                  <td style="${tdR}">$${fN(cr.dolKg, 2)}</td>
                                  <td style="${tdR}">${Math.round(cr.classKg).toLocaleString()} kg</td>
                                  <td style="${tdR};color:#16a34a;font-weight:600">${fC(cr.head * cr.wtHead * cr.dolKg)}</td>
                                </tr>
                              `).join('')}
                            </tbody>
                          </table>
                        ` : ''}
                      </div>
                    ` : `<div style="padding:10px 16px;font-size:12px;color:#6b7280">Total from cashflow only — upload Cattle Program sheet for detailed metrics</div>`}
                  </div>
                ` : ''}
                ${(sheepSalesRow || woolSalesRow || sheepMetrics) ? `
                  <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:12px">
                    <div style="padding:8px 16px;background:#f0f9f0;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between">
                      <span>🐑 Livestock — Sheep &amp; Wool</span>
                      <span style="color:#16a34a">${fC(totalSheepRev || sheepMetrics?.totalIncome)}</span>
                    </div>
                    ${sheepMetrics ? `
                      <div style="padding:12px 16px">
                        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px">
                          ${[
                            ['Sheep sales', fC(sheepSalesRow?.budgeted_gross_revenue ?? sheepMetrics?.sheepSales)],
                            ['Wool sales',  fC(woolSalesRow?.budgeted_gross_revenue  ?? sheepMetrics?.woolSales)],
                          ].map(([label, val]) => `
                            <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;text-align:center">
                              <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</div>
                              <div style="font-size:15px;font-weight:700;color:#1e293b">${val}</div>
                            </div>
                          `).join('')}
                        </div>
                      </div>
                    ` : `<div style="padding:10px 16px;font-size:12px;color:#6b7280">Total from cashflow only</div>`}
                  </div>
                ` : ''}
                <div style="display:flex;justify-content:flex-end;font-size:11px;color:#6b7280;margin-bottom:8px">
                  Farming Income total: <strong style="color:#16a34a;margin-left:6px">${fC(totalFarmingRev)}</strong>
                </div>
              `;
            })()}
            ${renderRevSection('Other Income', otherRevRows, totalOtherRev, false, false)}
            ${carryOverRevRows.length ? `
              <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:12px">
                <div style="padding:8px 16px;background:#f0fdf4;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between">
                  <span>Carry-over Income <span style="font-weight:400;color:#6b7280;font-size:11px">(prior season crops on hand — total value only, no area/yield)</span></span>
                  <span style="color:#16a34a">${fC(totalCarryRev)}</span>
                </div>
                <div style="overflow-x:auto">
                  <table style="width:100%;border-collapse:collapse">
                    <thead><tr>
                      <th style="${th};text-align:left">Crop</th>
                      <th style="${thR}">Total value</th>
                    </tr></thead>
                    <tbody>
                      ${carryOverRevRows.map(r => `
                        <tr>
                          <td style="${td};color:#6b7280;font-style:italic">${r.commodity}</td>
                          <td style="${tdR};color:#16a34a;font-weight:600">${fC(r.budgeted_gross_revenue)}</td>
                        </tr>`).join('')}
                    </tbody>
                  </table>
                </div>
              </div>
            ` : ''}
            <div style="display:flex;justify-content:flex-end;padding:8px 0 0;border-top:2px solid #e5e7eb;font-size:13px;font-weight:700;color:#16a34a">
              Total revenue: ${fC(totalRev)}
            </div>
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
                  <th style="${thR}">Unit Price</th>
                  <th style="${th};text-align:left">Unit</th>
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
                      <td style="${tdR};font-size:11px">${r.unit_price != null ? '$' + fN(r.unit_price, 4) : '—'}</td>
                      <td style="${td};font-size:11px;color:#6b7280">${r.unit || '—'}</td>
                      <td style="${tdR};font-size:11px">${r.cost_per_ha != null ? '$' + fN(r.cost_per_ha, 2) : '—'}</td>
                      <td style="${tdR};font-size:11px;color:${r.budget_amount ? '#dc2626' : '#9ca3af'}">${r.budget_amount != null ? (r.budget_amount === 0 ? '$0' : '-' + fC(r.budget_amount)) : '—'}</td>
                    </tr>
                  `).join('')}
                  <tr style="background:#fff5f5">
                    <td style="${td};font-weight:600;font-size:11px" colspan="7">${enterprise} total</td>
                    <td style="${tdR};font-weight:600;color:#dc2626;font-size:11px">-${fC(etotal)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#fff5f5;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="7">Total variable costs</td>
                  <td style="${tdR};color:#dc2626;font-weight:700">-${fC(totalVarCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ` : '<div style="color:#6b7280;font-size:12px;margin-bottom:12px">No variable cost rows parsed from GM sheets</div>'}

      ${(fallowCostRows||[]).length ? (() => {
        const totalFallowCost = (fallowCostRows||[]).reduce((s, r) => s + (r.budget_amount || 0), 0);
        const fallowByEnterprise = {};
        for (const r of (fallowCostRows||[])) {
          if (!fallowByEnterprise[r.enterprise]) fallowByEnterprise[r.enterprise] = { rows: [], total: 0 };
          fallowByEnterprise[r.enterprise].rows.push(r);
          fallowByEnterprise[r.enterprise].total += (r.budget_amount || 0);
        }
        return `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
            <span>Fallow variable costs — ${(fallowCostRows||[]).length} lines <span style="font-weight:400;color:#6b7280;font-size:11px">(from cashflow)</span></span>
            <span style="color:#dc2626;font-weight:700">-${fC(totalFallowCost)}</span>
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="${th};text-align:left">Enterprise</th>
                  <th style="${th};text-align:left">Budget Code</th>
                  <th style="${th};text-align:left">Description</th>
                  <th style="${thR}">Amount</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(fallowByEnterprise).map(([enterprise, { rows: erows, total: etotal }]) => `
                  ${erows.map((r, i) => `
                    <tr style="${i % 2 === 0 ? '' : 'background:#fafafa'}">
                      <td style="${td};font-size:11px;color:#6b7280">${i === 0 ? enterprise : ''}</td>
                      <td style="${td};font-size:11px;font-family:monospace;color:#374151">${r.budget_code}</td>
                      <td style="${td};font-size:11px">${r.description}</td>
                      <td style="${tdR};font-size:11px;color:#dc2626">-${fC(r.budget_amount)}</td>
                    </tr>
                  `).join('')}
                  <tr style="background:#fff5f5">
                    <td style="${td};font-weight:600;font-size:11px" colspan="3">${enterprise} total</td>
                    <td style="${tdR};font-weight:600;color:#dc2626;font-size:11px">-${fC(etotal)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#fff5f5;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="3">Total fallow costs</td>
                  <td style="${tdR};color:#dc2626;font-weight:700">-${fC(totalFallowCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>`;
      })() : ''}

      ${(priorYearCostRows||[]).length ? `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
            <span>Expenses from prior year — ${(priorYearCostRows||[]).length} lines <span style="font-weight:400;color:#6b7280;font-size:11px">(cashflow only, no $/ha)</span></span>
            <span style="color:#dc2626;font-weight:700">-${fC(totalPYCost)}</span>
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="${th};text-align:left">Enterprise</th>
                  <th style="${th};text-align:left">Budget Code</th>
                  <th style="${thR}">Amount</th>
                </tr>
              </thead>
              <tbody>
                ${Object.entries(pyByEnterprise).map(([enterprise, { rows: erows, total: etotal }]) => `
                  ${erows.map((r, i) => `
                    <tr style="${i % 2 === 0 ? '' : 'background:#fafafa'}">
                      <td style="${td};font-size:11px;color:#6b7280">${i === 0 ? enterprise : ''}</td>
                      <td style="${td};font-size:11px;font-family:monospace;color:#374151">${r.budget_code}</td>
                      <td style="${tdR};font-size:11px;color:#dc2626">-${fC(r.budget_amount)}</td>
                    </tr>
                  `).join('')}
                  <tr style="background:#fff5f5">
                    <td style="${td};font-weight:600;font-size:11px" colspan="2">${enterprise} total</td>
                    <td style="${tdR};font-weight:600;color:#dc2626;font-size:11px">-${fC(etotal)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#fff5f5;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="2">Total prior year expenses</td>
                  <td style="${tdR};color:#dc2626;font-weight:700">-${fC(totalPYCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}


      ${(cattleCostRows||[]).length ? `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
            <span>Cattle variable costs — ${(cattleCostRows||[]).length} lines <span style="font-weight:400;color:#6b7280;font-size:11px">(from cashflow)</span></span>
            <span style="color:#dc2626;font-weight:700">-${fC(totalCattleCost)}</span>
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr>
                <th style="${th};text-align:left">Budget Code</th>
                <th style="${th};text-align:left">Description</th>
                <th style="${thR}">Amount</th>
              </tr></thead>
              <tbody>
                ${(cattleCostRows||[]).map((r, i) => `
                  <tr style="${i % 2 === 0 ? '' : 'background:#fafafa'}">
                    <td style="${td};font-size:11px;font-family:monospace;color:#374151">${r.budget_code}</td>
                    <td style="${td};font-size:11px">${r.description}</td>
                    <td style="${tdR};font-size:11px;color:#dc2626">-${fC(r.budget_amount)}</td>
                  </tr>
                `).join('')}
                <tr style="background:#fff5f5;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="2">Total cattle variable costs</td>
                  <td style="${tdR};color:#dc2626;font-weight:700">-${fC(totalCattleCost)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}

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

      ${(capexRows||[]).length ? (() => {
        const netCapex = (capexRows||[]).reduce((s, r) => s + (r.budget_amount || 0), 0);
        return `
        <div style="background:white;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:16px">
          <div style="padding:10px 16px;background:#f5f3ff;border-bottom:1px solid #e5e7eb;font-size:12px;font-weight:600;display:flex;justify-content:space-between;align-items:center">
            <span>Capital expenditure — ${(capexRows||[]).length} items <span style="font-weight:400;color:#6b7280;font-size:11px">(from cashflow; negative = machinery sale)</span></span>
            <span style="color:${netCapex >= 0 ? '#dc2626' : '#16a34a'};font-weight:700">${netCapex >= 0 ? '-' : '+'}${fC(Math.abs(netCapex))}</span>
          </div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr>
                <th style="${th};text-align:left">Type</th>
                <th style="${th};text-align:left">Budget Code</th>
                <th style="${th};text-align:left">Description</th>
                <th style="${thR}">Amount</th>
              </tr></thead>
              <tbody>
                ${(capexRows||[]).map((r, i) => `
                  <tr style="${i % 2 === 0 ? '' : 'background:#fafafa'}">
                    <td style="${td};font-size:11px;color:${r.is_sale ? '#16a34a' : '#6b7280'}">${r.is_sale ? 'Sale' : 'Purchase'}</td>
                    <td style="${td};font-size:11px;font-family:monospace;color:#374151">${r.budget_code}</td>
                    <td style="${td};font-size:11px">${r.description}</td>
                    <td style="${tdR};font-size:11px;color:${r.budget_amount < 0 ? '#16a34a' : '#dc2626'}">${r.budget_amount < 0 ? '+' : '-'}${fC(Math.abs(r.budget_amount))}</td>
                  </tr>
                `).join('')}
                <tr style="background:#f5f3ff;border-top:2px solid #e5e7eb">
                  <td style="${td};font-weight:700" colspan="3">Net CAPEX</td>
                  <td style="${tdR};font-weight:700;color:${netCapex >= 0 ? '#dc2626' : '#16a34a'}">${netCapex >= 0 ? '-' : '+'}${fC(Math.abs(netCapex))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>`;
      })() : ''}

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

    // Strip preview-only 'section' field before writing to budgets table
    const revRows = revenueRows.map(({ section: _s, ...r }) => ({ ...r, season: fy }));
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
