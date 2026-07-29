// netlify/functions/xero-webhook.js
// Receives Xero webhook events, fetches PDF for approved invoices,
// uploads to Supabase Storage and attaches to CFM invoice record

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const XERO_WEBHOOK_KEY = process.env.XERO_WEBHOOK_KEY; // Set in Netlify env
const XERO_CLIENT_ID = process.env.XERO_CLIENT_ID || 'E4E1BDEA8DFF417C88007214BD95EA61';
const XERO_CLIENT_SECRET = process.env.XERO_CLIENT_SECRET;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// Supabase helpers
const sbFetch = (path, opts = {}) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
  ...opts,
  headers: {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...opts.headers,
  },
});

// Get fresh Xero access token from stored tokens
async function getXeroToken() {
  const res = await sbFetch('xero_tokens?select=access_token,refresh_token,tenant_id&order=id.desc&limit=1');
  if (!res.ok) throw new Error('Could not fetch Xero token');
  const [token] = await res.json();
  if (!token) throw new Error('No Xero token found');

  // Only refresh if expired or missing expiry
  const expiresAt = token.expires_at ? new Date(token.expires_at) : new Date(0);
  if (expiresAt - Date.now() > 5 * 60 * 1000) {
    return { accessToken: token.access_token, tenantId: token.tenant_id };
  }

  const refreshRes = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${XERO_CLIENT_ID}:${XERO_CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    }),
  });
  if (!refreshRes.ok) throw new Error('Token refresh failed');
  const refreshed = await refreshRes.json();

  // Save refreshed token
  await sbFetch('xero_tokens?order=id.desc&limit=1', {
    method: 'PATCH',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({ access_token: refreshed.access_token, refresh_token: refreshed.refresh_token, expires_at: new Date(Date.now() + (refreshed.expires_in||1800) * 1000).toISOString() }),
  });

  return { accessToken: refreshed.access_token, tenantId: token.tenant_id };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Xero intent-to-receive validation
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  // Verify Xero webhook signature
  if (XERO_WEBHOOK_KEY) {
    const signature = event.headers['x-xero-signature'];
    const hmac = crypto.createHmac('sha256', XERO_WEBHOOK_KEY)
      .update(event.body || '')
      .digest('base64');
    if (hmac !== signature) {
      console.error('Invalid webhook signature');
      return { statusCode: 401, headers, body: 'Unauthorized' };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: 'Invalid JSON' };
  }

  const events = payload.events || [];
  console.log(`Received ${events.length} Xero webhook event(s)`);

  for (const evt of events) {
    try {
      // Only handle INVOICE events that are VOIDED, PAID or have status updates
      if (evt.eventCategory !== 'INVOICE') continue;
      const xeroInvoiceId = evt.resourceId;
      if (!xeroInvoiceId) continue;

      console.log(`Processing invoice event: ${evt.eventType} for ${xeroInvoiceId}`);

      // Find matching CFM invoice
      const invRes = await sbFetch(`invoices?xero_invoice_id=eq.${xeroInvoiceId}&select=id,farm_id,xero_invoice_number`);
      if (!invRes.ok) continue;
      const [cfmInvoice] = await invRes.json();
      if (!cfmInvoice) {
        console.log(`No CFM invoice found for Xero ID: ${xeroInvoiceId}`);
        continue;
      }

      // Get Xero invoice details and PDF
      const { accessToken, tenantId } = await getXeroToken();

      // Fetch invoice details to get number
      const xeroInvRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Xero-Tenant-Id': tenantId,
          'Accept': 'application/json',
        },
      });

      if (!xeroInvRes.ok) {
        console.error('Failed to fetch Xero invoice:', await xeroInvRes.text());
        continue;
      }

      const xeroData = await xeroInvRes.json();
      const xeroInv = xeroData.Invoices?.[0];
      if (!xeroInv) continue;

      const invoiceNumber = xeroInv.InvoiceNumber;
      const invoiceStatus = xeroInv.Status;

      console.log(`Xero invoice ${invoiceNumber} status: ${invoiceStatus}`);

      // Fetch PDF from Xero
      const pdfRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${xeroInvoiceId}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Xero-Tenant-Id': tenantId,
          'Accept': 'application/pdf',
        },
      });

      let xeroInvUrl = null;
      if (pdfRes.ok) {
        const pdfBuffer = await pdfRes.arrayBuffer();
        const filename = `${invoiceNumber || xeroInvoiceId}.pdf`;
        const storagePath = `invoices/${cfmInvoice.farm_id}/xero/${Date.now()}_${filename}`;

        // Upload to Supabase Storage
        const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/cfm-documents/${storagePath}`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/pdf',
            'x-upsert': 'true',
          },
          body: pdfBuffer,
        });

        if (uploadRes.ok) {
          xeroInvUrl = `${SUPABASE_URL}/storage/v1/object/public/cfm-documents/${storagePath}`;
          console.log(`PDF uploaded: ${storagePath}`);
        } else {
          console.error('PDF upload failed:', await uploadRes.text());
        }
      }

      // Update CFM invoice
      const updateData = {
        xero_invoice_number: invoiceNumber || cfmInvoice.xero_invoice_number,
        status: ['AUTHORISED', 'PAID', 'SUBMITTED'].includes(invoiceStatus) ? 'complete' : undefined,
      };
      if (xeroInvUrl) updateData.xero_invoice_url = xeroInvUrl;

      // Remove undefined fields
      Object.keys(updateData).forEach(k => updateData[k] === undefined && delete updateData[k]);

      await sbFetch(`invoices?id=eq.${cfmInvoice.id}`, {
        method: 'PATCH',
        headers: { 'Prefer': 'return=minimal' },
        body: JSON.stringify(updateData),
      });

      console.log(`Updated CFM invoice ${cfmInvoice.id}: ${invoiceNumber}`);

    } catch (err) {
      console.error('Error processing webhook event:', err.message);
    }
  }

  // Xero requires 200 response
  return { statusCode: 200, headers, body: JSON.stringify({ received: events.length }) };
};