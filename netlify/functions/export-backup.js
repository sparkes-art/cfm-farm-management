// netlify/functions/export-backup.js
// Generates Excel backup of all CFM data
// Uses SheetJS (xlsx) which is already available via CDN approach
// Returns base64 encoded .xlsx for Power Automate to save to SharePoint

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BACKUP_API_KEY = 'cfm-backup-2026';

const sb = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    }
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${await res.text()}`);
  return res.json();
};

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

  const farmId = event.queryStringParameters?.farm_id;

  try {
    const farmsQuery = farmId ? `farms?id=eq.${farmId}&select=*` : `farms?select=*&order=name.asc`;
    const farms = await sb(farmsQuery);
    if (!farms.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'No farms found' }) };

    const results = [];
    const exportDate = new Date().toLocaleDateString('en-AU') + ', ' + new Date().toLocaleTimeString('en-AU');

    for (const farm of farms) {
      const farmName = farm.name || farm.id;
      const fid = farm.id;

        console.log('Loading data for farm:', farmName);
      const t0 = Date.now();

      const [invoices, contracts, prices, allBudgets, allHarvests, allForecasts] = await Promise.all([
        sb(`invoices?farm_id=eq.${fid}&select=*&order=invoice_date.desc`),
        sb(`forward_contracts?farm_id=eq.${fid}&select=*&order=sale_date.desc`),
        sb(`market_prices?select=commodity,price_date,price_per_unit,grade,region,source&order=price_date.desc&limit=200`),
        sb(`budgets?farm_id=eq.${fid}&select=*&order=season.desc,commodity.asc`),
        sb(`harvest_entries?farm_id=eq.${fid}&select=*&order=season.desc,harvest_date.asc`),
        sb(`forecasts?farm_id=eq.${fid}&select=*&order=forecast_date.asc`),
      ]);

      console.log('Data loaded in', Date.now()-t0, 'ms — invoices:', invoices.length, 'budgets:', allBudgets.length);

      // Summary sheet
      const summaryRows = [
        [`CFM — ${farmName}  |  Data Backup`],
        [`Exported: ${exportDate}`],
        [],
        ['Category', 'Value', 'Notes'],
        ['Farm', farmName, farm?.location || ''],
        ['Invoices', invoices.length, 'Total records'],
        ['Contracts', contracts.length, 'Forward contracts'],
        ['Budget entries', allBudgets.length, 'All seasons'],
        ['Harvest entries', allHarvests.length, 'All seasons'],
      ];

      // Crop sales sheet
      const saleRows = [['Xero Ref', 'Date', 'Buyer', 'Commodity', 'Docket', 'Season', 'Qty', 'Unit', '$/unit', 'Quality adj', 'Gross', 'Deductions', 'Net amount', 'Status', 'Notes']];
      invoices.forEach(inv => {
        const lines = inv.line_items || [];
        if (lines.length) {
          lines.forEach(l => saleRows.push([
            inv.xero_invoice_number || '', inv.invoice_date || '', inv.buyer || '',
            l.commodity || '', l.docket || '', l.season || '',
            parseFloat(l.qty) || null, l.unit || '',
            parseFloat(l.price) || null, parseFloat(l.quality_adj) || null,
            parseFloat(l.total) || null,
            inv.total_deductions ? -parseFloat(inv.total_deductions) : null,
            parseFloat(inv.net_amount) || null, inv.status || '', inv.notes || '',
          ]));
        } else {
          saleRows.push([
            inv.xero_invoice_number || '', inv.invoice_date || '', inv.buyer || '',
            inv.commodity_type || '', '', inv.season || '',
            parseFloat(inv.total_qty) || null, '', null, null,
            parseFloat(inv.gross_amount) || null,
            inv.total_deductions ? -parseFloat(inv.total_deductions) : null,
            parseFloat(inv.net_amount) || null, inv.status || '', inv.notes || '',
          ]);
        }
      });
      // Totals row
      const totalNet = invoices.reduce((s,i) => s + (parseFloat(i.net_amount)||0), 0);
      saleRows.push(['', '', '', '', '', '', '', '', '', 'TOTAL', '', '', totalNet, '', '']);

      // Contracts sheet
      const contractRows = [['Contract #', 'Sale Date', 'Counterparty', 'Commodity', 'Grade', 'Qty', 'Unit', '$/unit', 'Crop Year', 'Notes']];
      contracts.forEach(c => contractRows.push([
        c.contract_number || '', c.sale_date || '', c.counterparty || c.buyer || '',
        c.commodity || '', c.grade_spec || '',
        parseFloat(c.quantity) || null, c.unit || '',
        parseFloat(c.price_per_unit) || null, c.crop_year || '', c.notes || '',
      ]));

      // Budget & Forecast sheet
      const budgetRows = [['Season', 'Commodity', 'Crop Type', 'Unit', 'Bud Area', 'Bud Yield', 'Bud Prod', 'Bud Price', 'Fcast Area', 'Fcast Yield', 'Fcast Prod']];
      allBudgets.forEach(b => {
        const lf = allForecasts.filter(f => f.budget_id === b.id).slice(-1)[0];
        const budProd = (parseFloat(b.area_ha)||0) * (parseFloat(b.yield_per_ha)||0);
        const fProd = lf ? (parseFloat(lf.forecast_production) || (parseFloat(lf.area_ha)||0)*(parseFloat(lf.yield_per_ha)||0)) : null;
        budgetRows.push([
          b.season || '', b.commodity || '', b.crop_type || '', b.unit || '',
          parseFloat(b.area_ha)||null, parseFloat(b.yield_per_ha)||null, budProd||null,
          parseFloat(b.price)||null,
          parseFloat(lf?.area_ha)||null, parseFloat(lf?.yield_per_ha)||null, fProd||null,
        ]);
      });

      // Harvest sheet
      const harvestRows = [['Date', 'Commodity', 'Paddock', 'Qty', 'Unit', 'Area (ha)', 'Yield/ha', 'Notes']];
      allHarvests.forEach(h => harvestRows.push([
        h.harvest_date || '', h.commodity || '', h.paddock_name || '',
        parseFloat(h.actual_production)||null, h.unit || '',
        parseFloat(h.area_ha)||null,
        h.area_ha && h.actual_production ? parseFloat((parseFloat(h.actual_production)/parseFloat(h.area_ha)).toFixed(3)) : null,
        h.notes || '',
      ]));

      // Market prices sheet
      const priceRows = [['Commodity', 'Date', 'Price', 'Grade', 'Site / Region', 'Source']];
      prices.forEach(p => priceRows.push([
        p.commodity || '', p.price_date || '',
        parseFloat(p.price_per_unit)||null,
        p.grade || '', p.region || '', p.source || '',
      ]));

      results.push({
        farm: farmName,
        exported: exportDate,
        summary: summaryRows,
        cropSales: saleRows,
        contracts: contractRows,
        budgetForecast: budgetRows,
        harvest: harvestRows,
        marketPrices: priceRows,
      });
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, farms: results }),
    };

  } catch (err) {
    console.error('export-backup error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};