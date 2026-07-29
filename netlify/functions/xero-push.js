// netlify/functions/xero-push.js
// Pushes a CFM invoice to Xero as a draft ACCREC invoice

const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID;
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    }
  });
  return res.json();
};

const sbUpdate = async (path, body) => {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
};

async function getAccessToken(farmId) {
  const rows = await sb(`xero_tokens?farm_id=eq.${farmId}&select=*`);
  const token = rows[0];
  if (!token) throw new Error('Xero not connected for this farm. Please connect in Farm Settings.');

  // Check if token is expired (refresh if within 5 minutes of expiry)
  const expiresAt = new Date(token.expires_at);
  if (expiresAt - Date.now() < 5 * 60 * 1000) {
    // Refresh
    const tokenRes = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token }).toString(),
    });
    if (!tokenRes.ok) throw new Error('Xero token expired. Please reconnect in Farm Settings.');
    const refreshed = await tokenRes.json();
    await fetch(`${SUPABASE_URL}/rest/v1/xero_tokens?farm_id=eq.${farmId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }),
    });
    return { accessToken: refreshed.access_token, tenantId: token.tenant_id };
  }

  return { accessToken: token.access_token, tenantId: token.tenant_id };
}

async function findOrCreateContact(accessToken, tenantId, buyerName) {
  // Search for existing contact
  const searchRes = await fetch(
    `https://api.xero.com/api.xro/2.0/Contacts?where=Name%3D%3D%22${encodeURIComponent(buyerName)}%22`,
    { headers: { 'Authorization': `Bearer ${accessToken}`, 'Xero-Tenant-Id': tenantId, 'Accept': 'application/json' } }
  );
  const searchData = await searchRes.json();
  if (searchData.Contacts?.length > 0) return searchData.Contacts[0].ContactID;

  // Create new contact
  const createRes = await fetch('https://api.xero.com/api.xro/2.0/Contacts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ Contacts: [{ Name: buyerName }] }),
  });
  const createData = await createRes.json();
  return createData.Contacts?.[0]?.ContactID;
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { invoice_id, farm_id } = body;
  if (!invoice_id || !farm_id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing invoice_id or farm_id' }) };

  try {
    // Load invoice from Supabase
    const invoices = await sb(`invoices?id=eq.${invoice_id}&select=*`);
    const inv = invoices[0];
    if (!inv) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Invoice not found' }) };

    // Get Xero access token
    const { accessToken, tenantId } = await getAccessToken(farm_id);

    // Find or create contact
    const contactId = await findOrCreateContact(accessToken, tenantId, inv.buyer || 'Unknown Buyer');

    // Build line items
    const isGst = inv.gst_type === 'inc';
    const taxType = isGst ? 'OUTPUT2' : 'BASEXCLUDED';
    // Look up contract number for each line item
    const contractMap = {};
    if (inv.forward_contract_id) {
      try {
        const cRes = await fetch(`${SUPABASE_URL}/rest/v1/forward_contracts?id=eq.${inv.forward_contract_id}&select=id,contract_number`, {
          headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
        });
        const contracts = cRes.ok ? await cRes.json() : [];
        contracts.forEach(c => { contractMap[c.id] = c.contract_number; });
      } catch(e) { console.error('Contract lookup failed:', e.message); }
    }
    const contractNumber = contractMap[inv.forward_contract_id] || '';

    const lineItems = [];
    const commodity = inv.commodity_type || (inv.line_items||[])[0]?.commodity || 'Cotton Lint';
    const masterUnit = inv.master_unit || 'bale';

    // Use batches (new format) if available
    const batches = inv.batches
      ? (typeof inv.batches === 'string' ? JSON.parse(inv.batches) : inv.batches)
      : null;

    if (batches && batches.length) {
      batches.forEach(batch => {
        const batchQty = parseFloat(batch.qty) || 0;
        const cropYear = batch.crop_year || '';
        const incomeDocket = batch.income_docket || '';
        const expenseDocket = batch.expense_docket || '';

        (batch.lines || []).forEach(line => {
          const amount = parseFloat(line.amount) || 0;
          if (!amount) return;

          if (line.type === 'income' && line.line_type !== 'qa') {
            // Sale income line
            // Description: [Commodity], [Crop Year], Contract [Contract Number], [Qty] [unit] @ $[eff $/unit]
            const effPrice = batchQty ? amount / batchQty : 0;
            const desc = [
              commodity,
              cropYear,
              contractNumber ? `Contract ${contractNumber}` : '',
              `${batchQty} ${masterUnit}`,
              `@ $${effPrice.toFixed(2)}`,
              incomeDocket ? `Docket ${incomeDocket}` : '',
            ].filter(Boolean).join(', ');
            // Use Qty:1 + full LineAmount to avoid Xero rounding on recalc
            lineItems.push({
              Description: desc,
              Quantity: 1,
              UnitAmount: Math.round(amount * 100) / 100,
              LineAmount: Math.round(amount * 100) / 100,
              TaxType: taxType,
            });

          } else if (line.type === 'income' && line.line_type === 'qa') {
            // Quality adjustment line
            const desc = [
              'QUALITY ADJUSTMENT:',
              commodity,
              cropYear,
              contractNumber ? `Contract ${contractNumber}` : '',
              `${batchQty} ${masterUnit}`,
              incomeDocket ? `Docket ${incomeDocket}` : '',
            ].filter(Boolean).join(' ');
            lineItems.push({
              Description: desc,
              Quantity: 1,
              UnitAmount: Math.round(amount * 100) / 100,
              LineAmount: Math.round(amount * 100) / 100,
              TaxType: taxType,
            });

          } else if (line.type === 'expense') {
            // Expense line — Qty:1 prevents rounding on tax recalc
            const desc = [line.description || 'Expense', expenseDocket || line.docket].filter(Boolean).join(', ');
            const expAmount = -Math.abs(amount);
            lineItems.push({
              Description: desc,
              Quantity: 1,
              UnitAmount: Math.round(expAmount * 100) / 100,
              LineAmount: Math.round(expAmount * 100) / 100,
              TaxType: taxType,
            });
          }
        });
      });

    } else {
      // Legacy line_items/deductions format
      (inv.line_items || []).forEach(l => {
        const qty = parseFloat(l.qty) || 1;
        const price = parseFloat(l.price) || 0;
        const desc = [
          l.commodity || commodity,
          l.season,
          contractNumber ? `Contract ${contractNumber}` : '',
          `${qty} ${l.unit||masterUnit}`,
          `@ $${price.toFixed(2)}`,
          l.docket ? `Docket ${l.docket}` : '',
        ].filter(Boolean).join(', ');
        lineItems.push({
          Description: desc,
          Quantity: qty,
          UnitAmount: Math.round(price * 10000) / 10000,
          LineAmount: Math.round(qty * price * 100) / 100,
          TaxType: taxType,
        });
      });
      (inv.deductions || []).forEach(d => {
        if (!d.value) return;
        const dedQty = parseFloat(d.qty) || 1;
        const dedTotal = -Math.abs(parseFloat(d.value));
        const dedDesc = [d.description || 'Deduction', d.docket].filter(Boolean).join(', ');
        lineItems.push({
          Description: dedDesc,
          Quantity: dedQty,
          UnitAmount: Math.round((dedTotal / dedQty) * 10000) / 10000,
          LineAmount: Math.round(dedTotal * 100) / 100,
          TaxType: taxType,
        });
      });
    }

    if (!lineItems.length) lineItems.push({
      Description: inv.notes || 'Sale',
      Quantity: parseFloat(inv.total_qty) || 1,
      UnitAmount: parseFloat(inv.net_amount) || 0,
      TaxType: taxType,
    });

    // Build Xero invoice
    const xeroInvoice = {
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      Date: inv.invoice_date || new Date().toISOString().slice(0, 10),
      DueDate: inv.invoice_date || new Date().toISOString().slice(0, 10),
      Status: 'DRAFT',
      Reference: inv.xero_invoice_number || '',
      LineItems: lineItems,
    };

    // Push to Xero
    const xeroRes = await fetch('https://api.xero.com/api.xro/2.0/Invoices', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Xero-Tenant-Id': tenantId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ Invoices: [xeroInvoice] }),
    });

    if (!xeroRes.ok) {
      const err = await xeroRes.text();
      throw new Error('Xero API error: ' + err);
    }

    const xeroData = await xeroRes.json();
    const xeroInv = xeroData.Invoices?.[0];
    const xeroInvoiceNumber = xeroInv?.InvoiceNumber;
    const xeroInvoiceId = xeroInv?.InvoiceID;

    // Update CFM invoice with Xero reference and mark complete
    await sbUpdate(`invoices?id=eq.${invoice_id}`, {
      xero_invoice_number: xeroInvoiceNumber || xeroInvoiceId,
      xero_invoice_id: xeroInvoiceId,
      status: 'complete',
    });

    console.log('Pushed invoice to Xero:', xeroInvoiceNumber);

    // Upload attachments to Xero
    if (xeroInvoiceId) {
      // Collect all attachments from batches (new format) + legacy fields
      const batchFiles = batches ? batches.flatMap(b => [
        ...(b.income_files || []),
        ...(b.expense_files || []),
      ]) : [];
      const allFiles = [
        ...batchFiles,
        ...(batchFiles.length ? [] : (inv.rcti_files || (inv.rcti_url ? [{ url: inv.rcti_url, filename: inv.rcti_filename || 'RCTI.pdf' }] : []))),
        ...(batchFiles.length ? [] : (inv.gin_files || (inv.gin_url ? [{ url: inv.gin_url, filename: inv.gin_filename || 'GinAdvice.pdf' }] : []))),
        ...(inv.other_files || []),
      ];

      console.log('Attaching files to Xero invoice ID:', xeroInvoiceId);
      // Refresh token before attachments to ensure it's still valid
      const { accessToken: attachToken, tenantId: attachTenantId } = await getAccessToken(farm_id);
      console.log('allFiles to attach:', allFiles.length, allFiles.map(f => f.filename));
      for (const file of allFiles) {
        try {
          if (!file.url || !file.filename) { console.log('Skipping file - missing url or filename:', file); continue; }
          console.log('Attaching to Xero:', file.filename, file.url);

          // Fetch file from Supabase Storage
          const fileRes = await fetch(file.url);
          if (!fileRes.ok) {
            console.error('Could not fetch file:', file.url, fileRes.status, await fileRes.text());
            continue;
          }
          const fileBuffer = await fileRes.arrayBuffer();
          console.log('File fetched, size:', fileBuffer.byteLength);

          const filename = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
          const ext = filename.split('.').pop().toLowerCase();
          const mimeType = ext === 'pdf' ? 'application/pdf'
            : ext === 'png' ? 'image/png'
            : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
            : 'application/octet-stream';

          // Upload to Xero using IncludeOnline=false to avoid email attachment issues
          const attachUrl = `https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}/Attachments/${encodeURIComponent(filename)}`;
          const attachRes = await fetch(attachUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${attachToken}`,
              'Xero-Tenant-Id': attachTenantId,
              'Content-Type': mimeType,
            },
            body: fileBuffer,
          });

          if (attachRes.ok) {
            console.log('Attached to Xero:', filename);
          } else {
            const errText = await attachRes.text();
            console.error('Xero attachment failed:', filename, attachRes.status, errText);
          }
        } catch (attachErr) {
          console.error('Attachment error:', file.filename, attachErr.message);
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        xero_invoice_number: xeroInvoiceNumber,
        xero_invoice_id: xeroInvoiceId,
        attachments_uploaded: (inv.rcti_files||[]).length + (inv.gin_files||[]).length + (inv.other_files||[]).length,
      }),
    };

  } catch (err) {
    console.error('xero-push error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};