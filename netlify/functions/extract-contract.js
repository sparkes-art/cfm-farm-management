// netlify/functions/extract-contract.js
// Receives a base64 PDF, sends to Claude API, returns extracted contract fields

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { pdf_base64 } = body;
  if (!pdf_base64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No PDF data provided' }) };
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 }
            },
            {
              type: 'text',
              text: `Extract the following fields from this agricultural forward contract PDF and return ONLY a JSON object with no other text or markdown:
{
  "contract_number": "the contract or reference number",
  "counterparty": "the buyer or trading company name",
  "grade_spec": "the grade, specification or variety",
  "sale_date": "YYYY-MM-DD format, the date the contract was signed or executed",
  "quantity": numeric value only,
  "unit": "tonne, bale, kg, or head",
  "price_per_unit": numeric value only,
  "delivery_start": "YYYY-MM-DD format or null",
  "delivery_end": "YYYY-MM-DD format or null",
  "commodity": "cotton, grain, pulse, or other",
  "notes": "any important terms, conditions or notes worth capturing"
}
If a field cannot be found, use null. Return only the JSON object.`
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return { statusCode: response.status, headers, body: JSON.stringify({ error: `Claude API error: ${err}` }) };
    }

    const data = await response.json();
    const text = data.content?.map(b => b.text || '').join('') || '';

    let extracted;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      extracted = JSON.parse(clean);
    } catch {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not parse AI response' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(extracted) };

  } catch (err) {
    console.error('Extract contract error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Server error' }) };
  }
};
