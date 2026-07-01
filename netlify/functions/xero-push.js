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
    const lineItems = (inv.line_items || []).map(l => ({
      Description: [l.commodity, l.docket, l.season].filter(Boolean).join(' · '),
      Quantity: parseFloat(l.qty) || 1,
      UnitAmount: parseFloat(l.price) || 0,
      TaxType: isGst ? 'GST' : 'NONE',
      LineAmount: parseFloat(l.total) || 0,
    }));
    (inv.deductions || []).forEach(d => {
      if (!d.value) return;
      lineItems.push({
        Description: d.description || 'Deduction',
        Quantity: 1,
        UnitAmount: -Math.abs(parseFloat(d.value)),
        TaxType: 'NONE',
        LineAmount: -Math.abs(parseFloat(d.value)),
      });
    });
    if (!lineItems.length) lineItems.push({
      Description: inv.notes || 'Sale',
      Quantity: parseFloat(inv.total_qty) || 1,
      UnitAmount: parseFloat(inv.net_amount) || 0,
      TaxType: isGst ? 'GST' : 'NONE',
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
      status: 'complete',
    });

    console.log('Pushed invoice to Xero:', xeroInvoiceNumber);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        xero_invoice_number: xeroInvoiceNumber,
        xero_invoice_id: xeroInvoiceId,
      }),
    };

  } catch (err) {
    console.error('xero-push error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
