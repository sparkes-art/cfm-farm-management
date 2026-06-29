// netlify/functions/export-backup.js
// Generates Excel backup of all CFM data, returns as base64 for Power Automate → SharePoint
// GET /api/export-backup
// Header: x-api-key: cfm-backup-2026

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BACKUP_API_KEY = 'cfm-backup-2026';

const sb = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase ${path}: ${await res.text()}`);
  return res.json();
};

function currentSeason() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth() + 1;
  return m >= 5 ? `${y}-${String(y+1).slice(2)}` : `${y-1}-${String(y).slice(2)}`;
}

const escape = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const colLetter = n => { let s=''; while(n>0){s=String.fromCharCode(64+(n%26||26))+s;n=Math.floor((n-1)/26);} return s; };

const crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[i]=c;}
  return t;
})();
const crc32 = buf => { let c=0xFFFFFFFF; for(let i=0;i<buf.length;i++)c=crc32Table[(c^buf[i])&0xFF]^(c>>>8); return (c^0xFFFFFFFF)>>>0; };

function zipFiles(files) {
  const enc = s => Buffer.from(s, 'utf8');
  const parts = [], centralDir = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const nameBuf = enc(name), dataBuf = enc(data);
    const crc = crc32(dataBuf), size = dataBuf.length;
    const local = Buffer.alloc(30 + nameBuf.length + size);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0,6);
    local.writeUInt16LE(0,8); local.writeUInt16LE(0,10); local.writeUInt16LE(0,12);
    local.writeUInt32LE(crc,14); local.writeUInt32LE(size,18); local.writeUInt32LE(size,22);
    local.writeUInt16LE(nameBuf.length,26); local.writeUInt16LE(0,28);
    nameBuf.copy(local,30); dataBuf.copy(local,30+nameBuf.length);
    parts.push(local);
    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50,0); cd.writeUInt16LE(20,4); cd.writeUInt16LE(20,6);
    cd.writeUInt16LE(0,8); cd.writeUInt16LE(0,10); cd.writeUInt16LE(0,12); cd.writeUInt16LE(0,14);
    cd.writeUInt32LE(crc,16); cd.writeUInt32LE(size,20); cd.writeUInt32LE(size,24);
    cd.writeUInt16LE(nameBuf.length,28); cd.writeUInt16LE(0,30); cd.writeUInt16LE(0,32);
    cd.writeUInt16LE(0,34); cd.writeUInt16LE(0,36); cd.writeUInt32LE(0,38); cd.writeUInt32LE(offset,42);
    nameBuf.copy(cd,46); centralDir.push(cd);
    offset += local.length;
  }
  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50,0); eocd.writeUInt16LE(0,4); eocd.writeUInt16LE(0,6);
  eocd.writeUInt16LE(centralDir.length,8); eocd.writeUInt16LE(centralDir.length,10);
  eocd.writeUInt32LE(cdBuf.length,12); eocd.writeUInt32LE(offset,16); eocd.writeUInt16LE(0,20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

function buildXlsx(sheets) {
  const sharedStrings = [], ssMap = {};
  const getSS = val => { const s=String(val??''); if(ssMap[s]===undefined){ssMap[s]=sharedStrings.length;sharedStrings.push(s);} return ssMap[s]; };

  const wsXmls = sheets.map(sheet => {
    const rows = sheet.rows.map((row,ri) => {
      const cells = row.map((val,ci) => {
        const ref = colLetter(ci+1)+(ri+1);
        if(val===null||val===undefined||val==='') return `<c r="${ref}"/>`;
        if(typeof val==='number') return `<c r="${ref}" t="n"><v>${val}</v></c>`;
        return `<c r="${ref}" t="s"><v>${getSS(val)}</v></c>`;
      }).join('');
      return `<row r="${ri+1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map(s=>`<si><t xml:space="preserve">${escape(s)}</t></si>`).join('')}</sst>`;
  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s,i)=>`<sheet name="${escape(s.name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('')}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((s,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((s,i)=>`<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const files = {
    '[Content_Types].xml': ct,
    '_rels/.rels': rels,
    'xl/workbook.xml': wbXml,
    'xl/_rels/workbook.xml.rels': wbRels,
    'xl/sharedStrings.xml': ssXml,
  };
  sheets.forEach((s,i) => { files[`xl/worksheets/sheet${i+1}.xml`] = wsXmls[i]; });
  return zipFiles(files);
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

    const exportDate = new Date().toLocaleDateString('en-AU') + ', ' + new Date().toLocaleTimeString('en-AU');
    const results = [];

    for (const farm of farms) {
      const farmName = farm.name || farm.id;
      const fid = farm.id;

      console.log('Processing farm:', farmName);

      const [invoices, contracts, prices, allBudgets, allHarvests, allForecasts] = await Promise.all([
        sb(`invoices?farm_id=eq.${fid}&select=*&order=invoice_date.desc`),
        sb(`forward_contracts?farm_id=eq.${fid}&select=*&order=sale_date.desc`),
        sb(`market_prices?select=commodity,price_date,price_per_unit,grade,region,source&order=price_date.desc&limit=200`),
        sb(`budgets?farm_id=eq.${fid}&select=*&order=season.desc,commodity.asc`),
        sb(`harvest_entries?farm_id=eq.${fid}&select=*&order=season.desc,harvest_date.asc`),
        sb(`forecasts?farm_id=eq.${fid}&select=*&order=forecast_date.asc`),
      ]);

      console.log('Data loaded — building Excel for', farmName);

      // Summary
      const summaryRows = [
        [`CFM — ${farmName}  |  Data Backup`],
        [`Exported: ${exportDate}`],
        [],
        ['Category', 'Value'],
        ['Farm', farmName],
        ['Location', farm.location || ''],
        ['Invoices', invoices.length],
        ['Contracts', contracts.length],
        ['Budget entries', allBudgets.length],
        ['Harvest entries', allHarvests.length],
      ];

      // Crop sales
      const saleRows = [['Xero Ref','Date','Buyer','Commodity','Docket','Season','Qty','Unit','$/unit','Quality adj','Gross','Deductions','Net amount','Status','Notes']];
      invoices.forEach(inv => {
        const lines = inv.line_items || [];
        if (lines.length) {
          lines.forEach(l => saleRows.push([
            inv.xero_invoice_number||'', inv.invoice_date||'', inv.buyer||'',
            l.commodity||'', l.docket||'', l.season||'',
            typeof l.qty==='number'?l.qty:(parseFloat(l.qty)||null),
            l.unit||'',
            typeof l.price==='number'?l.price:(parseFloat(l.price)||null),
            typeof l.quality_adj==='number'?l.quality_adj:(parseFloat(l.quality_adj)||null),
            typeof l.total==='number'?l.total:(parseFloat(l.total)||null),
            inv.total_deductions?-parseFloat(inv.total_deductions):null,
            parseFloat(inv.net_amount)||null,
            inv.status||'', inv.notes||'',
          ]));
        } else {
          saleRows.push([inv.xero_invoice_number||'',inv.invoice_date||'',inv.buyer||'',inv.commodity_type||'','',inv.season||'',parseFloat(inv.total_qty)||null,'',null,null,parseFloat(inv.gross_amount)||null,inv.total_deductions?-parseFloat(inv.total_deductions):null,parseFloat(inv.net_amount)||null,inv.status||'',inv.notes||'']);
        }
      });
      saleRows.push(['','','','','','','','','','TOTAL','','',invoices.reduce((s,i)=>s+(parseFloat(i.net_amount)||0),0),'','']);

      // Contracts
      const contractRows = [['Contract #','Sale Date','Counterparty','Commodity','Grade','Qty','Unit','$/unit','Crop Year','Notes']];
      contracts.forEach(c => contractRows.push([c.contract_number||'',c.sale_date||'',c.counterparty||c.buyer||'',c.commodity||'',c.grade_spec||'',parseFloat(c.quantity)||null,c.unit||'',parseFloat(c.price_per_unit)||null,c.crop_year||'',c.notes||'']));

      // Budget & forecast
      const budgetRows = [['Season','Commodity','Crop Type','Unit','Bud Area','Bud Yield','Bud Prod','Bud Price','Fcast Area','Fcast Yield','Fcast Prod']];
      allBudgets.forEach(b => {
        const lf = allForecasts.filter(f=>f.budget_id===b.id).slice(-1)[0];
        const budProd = (parseFloat(b.area_ha)||0)*(parseFloat(b.yield_per_ha)||0);
        const fProd = lf?(parseFloat(lf.forecast_production)||((parseFloat(lf.area_ha)||0)*(parseFloat(lf.yield_per_ha)||0))):null;
        budgetRows.push([b.season||'',b.commodity||'',b.crop_type||'',b.unit||'',parseFloat(b.area_ha)||null,parseFloat(b.yield_per_ha)||null,budProd||null,parseFloat(b.price)||null,parseFloat(lf?.area_ha)||null,parseFloat(lf?.yield_per_ha)||null,fProd||null]);
      });

      // Harvest
      const harvestRows = [['Date','Commodity','Paddock','Qty','Unit','Area (ha)','Yield/ha','Notes']];
      allHarvests.forEach(h => harvestRows.push([h.harvest_date||'',h.commodity||'',h.paddock_name||'',parseFloat(h.actual_production)||null,h.unit||'',parseFloat(h.area_ha)||null,h.area_ha&&h.actual_production?parseFloat((parseFloat(h.actual_production)/parseFloat(h.area_ha)).toFixed(3)):null,h.notes||'']));

      // Market prices
      const priceRows = [['Commodity','Date','Price','Grade','Site / Region','Source']];
      prices.forEach(p => priceRows.push([p.commodity||'',p.price_date||'',parseFloat(p.price_per_unit)||null,p.grade||'',p.region||'',p.source||'']));

      const buffer = buildXlsx([
        { name: 'Summary', rows: summaryRows },
        { name: 'Crop Sales', rows: saleRows },
        { name: 'Forward Contracts', rows: contractRows },
        { name: 'Budget & Forecast', rows: budgetRows },
        { name: 'Harvest Records', rows: harvestRows },
        { name: 'Market Prices', rows: priceRows },
      ]);

      const filename = `CFM_${farmName.replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.xlsx`;
      results.push({ filename, content: buffer.toString('base64'), farm: farmName });
      console.log('Excel built for', farmName, '—', buffer.length, 'bytes');
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, files: results }),
    };

  } catch (err) {
    console.error('export-backup error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};