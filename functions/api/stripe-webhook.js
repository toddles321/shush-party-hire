export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body      = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
      return new Response('Missing signature', { status: 400 });
    }

    // Verify Stripe webhook signature using Web Crypto
    const valid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      console.error('Webhook signature verification failed');
      return new Response('Invalid signature', { status: 400 });
    }

    const event = JSON.parse(body);

    if (event.type === 'checkout.session.completed') {
      const session       = event.data.object;
      const recordId      = session.metadata?.airtable_record_id;
      const customerEmail = session.customer_details?.email || '';
      const customerName  = session.customer_details?.name  || '';
      const paymentIntent = session.payment_intent || '';

      // Extract custom fields from Stripe (mobile, suburb, notes)
      const customFields  = session.custom_fields || [];
      let mobile  = '';
      let suburb  = '';
      let notes   = '';
      for (const cf of customFields) {
        if (cf.key === 'mobile') mobile = cf.text?.value || '';
        if (cf.key === 'suburb') suburb = cf.text?.value || '';
        if (cf.key === 'notes')  notes  = cf.text?.value || '';
      }

      // Update Airtable record with confirmed status + customer details
      const updateFields = {
        'Name': customerName,
        'Email': customerEmail,
        'Phone': mobile,
        'Suburb': suburb,
        'Notes': notes,
        'Deposit Paid': true,
        'Status': 'Confirmed',
        'Stripe Session ID': session.id,
        'Stripe Payment ID': paymentIntent,
      };

      if (recordId) {
        const atRes = await fetch(
          `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}/${recordId}`,
          {
            method: 'PATCH',
            headers: {
              'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ fields: updateFields }),
          }
        );

        if (!atRes.ok) {
          console.error('Airtable update failed:', await atRes.text());
        } else {
          console.log(`Booking confirmed — Airtable record: ${recordId}`);
        }
      } else {
        // No record ID — create a new record from webhook data
        const meta = session.metadata || {};
        await fetch(
          `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              fields: {
                ...updateFields,
                'Event Date': meta.event_date || '',
                'Headset Quantity': parseInt(meta.headset_qty) || 0,
                'Package Price': parseInt(meta.total_price) || 0,
                'Deposit Required': 150,
              },
            }),
          }
        );
      }
    }

    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('Webhook error', { status: 500 });
  }
}

// Stripe HMAC-SHA256 signature verification using Web Crypto API
async function verifyStripeSignature(payload, header, secret) {
  try {
    const parts     = header.split(',');
    let timestamp   = '';
    const signatures = [];

    for (const part of parts) {
      const [k, v] = part.split('=');
      if (k === 't') timestamp = v;
      if (k === 'v1') signatures.push(v);
    }

    if (!timestamp || signatures.length === 0) return false;

    // Reject webhooks older than 5 minutes
    if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp)) > 300) return false;

    const encoder     = new TextEncoder();
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

    return signatures.includes(hex);
  } catch {
    return false;
  }
}
