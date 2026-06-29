// netlify/functions/export-backup.js
// Generates Excel backup of all CFM data for a farm
// Returns base64 encoded .xlsx for Power Automate to save to SharePoint
// GET /api/export-backup?farm_id=farm_blackbull&season=2025-26
// Header: x-api-key: cfm-backup-2026

const ExcelJS = require('exceljs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BACKUP_API_KEY = process.env.BACKUP_API_KEY || 'cfm-backup-2026';

const sb = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    }
  });
  if (!res.ok) throw new Error(`Supabase error: ${await res.text()}`);
  return res.json();
};

const NAV = '1A2535'; // dark navy
const WHITE = 'FFFFFF';
const BLUE = '1E6FA8';
const LIGHT = 'E4F0FA';
const GREY = 'F0F2F5';
const GREEN = '1A7A4A';
const AMBER = 'B86E00';

function headerStyle(color = NAV) {
  return {
    font: { bold: true, color: { argb: WHITE }, size: 11 },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: color } },
    alignment: { vertical: 'middle', horizontal: 'left' },
    border: { bottom: { style: 'thin', color: { argb: 'CCCCCC' } } },
  };
}

function titleStyle() {
  return {
    font: { bold: true, size: 13, color: { argb: NAV } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } },
  };
}

function addSheet(wb, name, titleText, columns, rows, totalsRow = null) {
  const ws = wb.addWorksheet(name);

  // Title row
  ws.addRow([titleText]);
  const titleCell = ws.getCell('A1');
  Object.assign(titleCell, titleStyle());
  ws.mergeCells(1, 1, 1, columns.length);
  ws.getRow(1).height = 24;

  // Header row
  const headerRow = ws.addRow(columns.map(c => c.header));
  headerRow.eachCell((cell, colNo) => {
    Object.assign(cell, headerStyle());
    cell.alignment = { vertical: 'middle', horizontal: columns[colNo-1].num ? 'right' : 'left' };
  });
  ws.getRow(2).height = 20;

  // Set column widths and number formats
  columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width || 16;
    if (col.num) ws.getColumn(i + 1).numFmt = col.fmt || '#,##0.00';
    if (col.date) ws.getColumn(i + 1).numFmt = 'dd/mm/yyyy';
  });

  // Data rows
  rows.forEach((rowData, ri) => {
    const row = ws.addRow(rowData);
    row.eachCell((cell, colNo) => {
      const col = columns[colNo - 1];
      if (col?.num) cell.alignment = { horizontal: 'right' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ri % 2 === 0 ? WHITE : 'F8F9FA' } };
      cell.border = { bottom: { style: 'hair', color: { argb: 'E0E4E8' } } };
    });
  });

  // Totals row
  if (totalsRow) {
    const tRow = ws.addRow(totalsRow);
    tRow.eachCell((cell, colNo) => {
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      if (columns[colNo-1]?.num) cell.alignment = { horizontal: 'right' };
    });
  }

  // Freeze header rows
  ws.views = [{ state: 'frozen', ySplit: 2 }];

  return ws;
}

function currentSeason() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  return m >= 5 ? `${y}-${String(y+1).slice(2)}` : `${y-1}-${String(y).slice(2)}`;
}

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };

  const apiKey = event.headers['x-api-key'] || event.headers['authorization'];
  if (apiKey !== BACKUP_API_KEY) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };

  const farmId = event.queryStringParameters?.farm_id; // optional — if omitted, backs up all farms

  try {
    // Load all farms (or just the requested one)
    const farmsQuery = farmId ? `farms?id=eq.${farmId}&select=*` : `farms?select=*&order=name.asc`;
    const farms = await sb(farmsQuery);

    if (!farms.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No farms found' }) };

    const results = [];

    for (const farm of farms) {
      const farmName = farm.name || farm.id;
      const fid = farm.id;

      // Get all seasons that have data for this farm
      const [budgetSeasons, harvestSeasons] = await Promise.all([
        sb(`budgets?farm_id=eq.${fid}&select=season&order=season.desc`),
        sb(`harvest_entries?farm_id=eq.${fid}&select=season&order=season.desc`),
      ]);
      const allSeasons = [...new Set([
        ...budgetSeasons.map(b => b.season),
        ...harvestSeasons.map(h => h.season),
        currentSeason(),
      ].filter(Boolean))].sort().reverse();

      // Load all data without season filter, prices once
      const [invoices, contracts, prices] = await Promise.all([
        sb(`invoices?farm_id=eq.${fid}&select=*&order=invoice_date.desc`),
        sb(`forward_contracts?farm_id=eq.${fid}&select=*&order=sale_date.desc`),
        sb(`market_prices?select=commodity,price_date,price_per_unit,grade,region,source&order=price_date.desc&limit=500`),
      ]);

      // Load season-specific data for ALL seasons
      let budgets = [], forecasts = [], harvests = [];
      for (const season of allSeasons) {
        const [b, f, h] = await Promise.all([
          sb(`budgets?farm_id=eq.${fid}&season=eq.${season}&select=*&order=commodity.asc`),
          sb(`forecasts?farm_id=eq.${fid}&season=eq.${season}&select=*&order=forecast_date.asc`),
          sb(`harvest_entries?farm_id=eq.${fid}&season=eq.${season}&select=*&order=harvest_date.asc`),
        ]);
        budgets = [...budgets, ...b];
        forecasts = [...forecasts, ...f];
        harvests = [...harvests, ...h];
      }

      const season = allSeasons[0] || currentSeason(); // most recent for title
      const exportDate = new Date().toLocaleDateString('en-AU') + ', ' + new Date().toLocaleTimeString('en-AU');
      const wb = new ExcelJS.Workbook();
    wb.creator = 'CFM Farm Management';
    wb.created = new Date();

    // ── Summary sheet ──────────────────────────────────────────
    const summary = wb.addWorksheet('Summary');
    summary.getColumn(1).width = 22;
    summary.getColumn(2).width = 28;
    summary.getColumn(3).width = 30;

    const t = summary.addRow([`CFM — ${farmName}  |  Data Backup`]);
    t.getCell(1).font = { bold: true, size: 14, color: { argb: NAV } };
    summary.mergeCells('A1:C1');
    summary.getRow(1).height = 28;

    summary.addRow([`Exported: ${exportDate}`]).getCell(1).font = { italic: true, color: { argb: '6B7280' } };
    summary.addRow([]);

    [['Category', 'Value', 'Notes']].forEach(r => {
      const hr = summary.addRow(r);
      hr.eachCell(c => Object.assign(c, headerStyle()));
    });

    [
      ['Farm', farmName, farm?.location || ''],
      ['Season', season, ''],
      ['Total invoices', invoices.length, ''],
      ['Forward contracts', contracts.length, ''],
      ['Budget entries', budgets.length, `Season ${season}`],
      ['Harvest entries', harvests.length, `Season ${season}`],
    ].forEach((r, i) => {
      const row = summary.addRow(r);
      row.getCell(1).font = { bold: true };
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? WHITE : 'F8F9FA' } }; });
    });

    summary.views = [{ state: 'frozen', ySplit: 4 }];

    // ── Crop Sales sheet ───────────────────────────────────────
    const saleRows = [];
    invoices.forEach(inv => {
      const lines = inv.line_items || [];
      if (lines.length) {
        lines.forEach(l => {
          saleRows.push([
            inv.xero_invoice_number || '',
            inv.invoice_date || '',
            inv.buyer || '',
            l.commodity || '',
            l.docket || '',
            parseFloat(l.qty) || null,
            l.unit || '',
            l.season || '',
            parseFloat(l.price) || null,
            parseFloat(l.quality_adj) || null,
            parseFloat(l.total) || null,
            inv.total_deductions ? -parseFloat(inv.total_deductions) : null,
            parseFloat(inv.net_amount) || null,
            inv.status || '',
            inv.notes || '',
          ]);
        });
      } else {
        saleRows.push([
          inv.xero_invoice_number || '',
          inv.invoice_date || '',
          inv.buyer || '',
          inv.commodity_type || '',
          '', null, '', inv.season || '',
          null, null,
          parseFloat(inv.gross_amount) || null,
          inv.total_deductions ? -parseFloat(inv.total_deductions) : null,
          parseFloat(inv.net_amount) || null,
          inv.status || '',
          inv.notes || '',
        ]);
      }
    });

    const totalNet = saleRows.reduce((s, r) => s + (r[12] || 0), 0);

    addSheet(wb, 'Crop Sales', `Crop Sales — RCTIs  |  All seasons`, [
      { header: 'Xero Ref', width: 12 },
      { header: 'Date', width: 13, date: true },
      { header: 'Buyer', width: 22 },
      { header: 'Commodity', width: 16 },
      { header: 'Docket / ID', width: 12 },
      { header: 'Qty', width: 10, num: true, fmt: '#,##0.000' },
      { header: 'Unit', width: 8 },
      { header: 'Season', width: 10 },
      { header: '$/unit', width: 10, num: true, fmt: '#,##0.00' },
      { header: 'Quality adj', width: 12, num: true, fmt: '#,##0.00' },
      { header: 'Gross', width: 14, num: true, fmt: '$#,##0.00' },
      { header: 'Deductions', width: 13, num: true, fmt: '$#,##0.00' },
      { header: 'Net amount', width: 14, num: true, fmt: '$#,##0.00' },
      { header: 'Status', width: 11 },
      { header: 'Notes', width: 28 },
    ], saleRows, ['', '', '', '', '', '', '', '', '', 'TOTAL', '', '', totalNet, '', '']);

    // ── Forward Contracts sheet ────────────────────────────────
    addSheet(wb, 'Forward Contracts', `Forward Contracts  |  All seasons`, [
      { header: 'Contract #', width: 14 },
      { header: 'Sale Date', width: 13 },
      { header: 'Counterparty', width: 20 },
      { header: 'Commodity', width: 16 },
      { header: 'Grade', width: 10 },
      { header: 'Qty', width: 10, num: true, fmt: '#,##0.000' },
      { header: 'Unit', width: 8 },
      { header: '$/unit', width: 10, num: true, fmt: '#,##0.00' },
      { header: 'Crop year', width: 10 },
      { header: 'Notes', width: 28 },
    ], contracts.map(c => [
      c.contract_number || '',
      c.sale_date || '',
      c.counterparty || c.buyer || '',
      c.commodity || '',
      c.grade_spec || '',
      parseFloat(c.quantity) || null,
      c.unit || '',
      parseFloat(c.price_per_unit) || null,
      c.crop_year || '',
      c.notes || '',
    ]));

    // ── Budget & Forecast sheet ────────────────────────────────
    addSheet(wb, 'Budget & Forecast', `Budget & Forecast  |  All seasons`, [
      { header: 'Season', width: 10 },
      { header: 'Commodity', width: 16 },
      { header: 'Crop Type', width: 14 },
      { header: 'Unit', width: 8 },
      { header: 'Bud Area', width: 11, num: true, fmt: '#,##0.0' },
      { header: 'Bud Yield', width: 11, num: true, fmt: '#,##0.000' },
      { header: 'Bud Prod', width: 11, num: true, fmt: '#,##0' },
      { header: 'Bud Price', width: 11, num: true, fmt: '$#,##0.00' },
      { header: 'Fcast Area', width: 12, num: true, fmt: '#,##0.0' },
      { header: 'Fcast Yield', width: 12, num: true, fmt: '#,##0.000' },
      { header: 'Fcast Prod', width: 12, num: true, fmt: '#,##0' },
    ], budgets.map(b => {
      const lf = forecasts.filter(f => f.budget_id === b.id).slice(-1)[0];
      const budProd = (parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0);
      const fProd = lf ? (parseFloat(lf.forecast_production) || (parseFloat(lf.area_ha)||0) * (parseFloat(lf.yield_per_ha)||0)) : null;
      return [
        b.season || season,
        b.commodity || '',
        b.crop_type || '',
        b.unit || '',
        parseFloat(b.area_ha) || null,
        parseFloat(b.yield_per_ha) || null,
        budProd || null,
        parseFloat(b.price) || null,
        parseFloat(lf?.area_ha) || null,
        parseFloat(lf?.yield_per_ha) || null,
        fProd || null,
      ];
    }));

    // ── Harvest Records sheet ──────────────────────────────────
    addSheet(wb, 'Harvest Records', `Harvest Records  |  All seasons`, [
      { header: 'Date', width: 13 },
      { header: 'Commodity', width: 16 },
      { header: 'Paddock', width: 20 },
      { header: 'Qty', width: 10, num: true, fmt: '#,##0.000' },
      { header: 'Unit', width: 8 },
      { header: 'Area (ha)', width: 11, num: true, fmt: '#,##0.0' },
      { header: 'Yield/ha', width: 11, num: true, fmt: '#,##0.000' },
      { header: 'Notes', width: 28 },
    ], harvests.map(h => [
      h.harvest_date || '',
      h.commodity || '',
      h.paddock_name || '',
      parseFloat(h.actual_production) || null,
      h.unit || '',
      parseFloat(h.area_ha) || null,
      h.area_ha && h.actual_production ? parseFloat((parseFloat(h.actual_production)/parseFloat(h.area_ha)).toFixed(3)) : null,
      h.notes || '',
    ]));

    // ── Market Prices sheet ────────────────────────────────────
    addSheet(wb, 'Market Prices', `Market Price History`, [
      { header: 'Commodity', width: 16 },
      { header: 'Date', width: 13 },
      { header: 'Price', width: 12, num: true, fmt: '$#,##0.00' },
      { header: 'Grade', width: 10 },
      { header: 'Site / Region', width: 22 },
      { header: 'Source', width: 14 },
    ], prices.map(p => [
      p.commodity || '',
      p.price_date || '',
      parseFloat(p.price_per_unit) || null,
      p.grade || '',
      p.region || '',
      p.source || '',
    ]));

      // Generate buffer for this farm
      const buffer = await wb.xlsx.writeBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      const filename = `CFM_${farmName.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0,10)}.xlsx`;

      results.push({ filename, content: base64, farm: farmName });
    } // end farm loop

    return {
      statusCode: 200,
      headers: { ...headers },
      body: JSON.stringify({
        success: true,
        season,
        files: results, // array of { filename, content, farm }
      }),
    };

  } catch (err) {
    console.error('export-backup error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};