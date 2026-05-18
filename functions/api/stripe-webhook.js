export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.text();
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
      const session = event.data.object;
      const recordId = session.metadata?.airtable_record_id;
      const customerEmail = session.customer_details?.email || '';
      const customerName = session.customer_details?.name || '';
      const paymentIntent = session.payment_intent || '';
      const amountPaid = session.amount_total ? (session.amount_total / 100).toFixed(2) : '0.00';

      // Extract custom fields from Stripe (mobile, suburb, notes)
      const customFields = session.custom_fields || [];
      let mobile = '';
      let suburb = '';
      let notes = '';
      for (const cf of customFields) {
        if (cf.key === 'mobile') mobile = cf.text?.value || '';
        if (cf.key === 'suburb') suburb = cf.text?.value || '';
        if (cf.key === 'notes') notes = cf.text?.value || '';
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

      const meta = session.metadata || {};
      const eventDate = meta.event_date || '';
      const headsetQty = meta.headset_qty || '';
      const packagePrice = meta.total_price || amountPaid;

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
                'Event Date': eventDate,
                'Headset Quantity': parseInt(headsetQty) || 0,
                'Package Price': parseFloat(packagePrice) || 0,
              },
            }),
          }
        );
      }

      // Send confirmation emails via Resend API
      // Requires RESEND_API_KEY env var — sign up free at resend.com
      if (env.RESEND_API_KEY && customerEmail) {
        await sendConfirmationEmails({
          resendApiKey: env.RESEND_API_KEY,
          customerEmail,
          customerName: customerName || 'there',
          eventDate,
          headsetQty,
          suburb,
          mobile,
          amountPaid,
          sessionId: session.id,
        });
      }
    }

    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('Webhook error', { status: 500 });
  }
}

async function sendConfirmationEmails({ resendApiKey, customerEmail, customerName, eventDate, headsetQty, suburb, mobile, amountPaid, sessionId }) {
  const fromEmail = 'booking@shushpartyhire.com.au';
  const toddEmail = 'Todd.vberkel@gmail.com';

  const formattedDate = eventDate
    ? new Date(eventDate).toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'TBC';

  // Customer confirmation email
  const customerHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:40px 20px">
  <div style="background:#0d0d0d;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px">
    <h1 style="margin:0;font-size:28px;font-weight:800;color:#fff">Shush<span style="background:linear-gradient(135deg,#a78bfa,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent">.</span></h1>
    <p style="margin:8px 0 0;color:#9ca3af;font-size:14px">Silent Disco Hire · Geelong &amp; Bellarine</p>
  </div>
  <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Booking Confirmed! 🎉</h2>
    <p style="margin:0 0 24px;color:#6b7280">Hey ${customerName}, your silent disco deposit is locked in. Get ready for an amazing event!</p>
    <div style="background:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:6px 0;color:#6b7280;font-size:14px">Event Date</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#111827">${formattedDate}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;font-size:14px">Headsets</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#111827">${headsetQty || 'As quoted'}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;font-size:14px">Location</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#111827">${suburb || 'As discussed'}</td></tr>
        <tr style="border-top:1px solid #e5e7eb"><td style="padding:12px 0 6px;color:#6b7280;font-size:14px;font-weight:600">Deposit Paid</td><td style="padding:12px 0 6px;text-align:right;font-weight:700;color:#059669;font-size:16px">$${amountPaid} AUD</td></tr>
      </table>
    </div>
    <p style="margin:0 0 16px;color:#374151;font-size:15px">Todd will be in touch shortly to confirm delivery times and any final details.</p>
    <p style="margin:0;color:#6b7280;font-size:14px">Questions? Reply to this email or call <a href="tel:0400050176" style="color:#7c3aed">0400 050 176</a></p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:24px">
    Shush Party Hire · Geelong &amp; Bellarine Peninsula, VIC<br>
    <a href="https://shushpartyhire.com.au/privacy.html" style="color:#9ca3af">Privacy Policy</a> · <a href="https://shushpartyhire.com.au/terms.html" style="color:#9ca3af">Terms &amp; Conditions</a>
  </p>
</div>
</body>
</html>`;

  // Todd notification email
  const toddHtml = `<div style="font-family:sans-serif;max-width:500px">
<h2>New Booking Deposit Received</h2>
<table>
  <tr><td><b>Name:</b></td><td>${customerName}</td></tr>
  <tr><td><b>Email:</b></td><td>${customerEmail}</td></tr>
  <tr><td><b>Mobile:</b></td><td>${mobile || 'Not provided'}</td></tr>
  <tr><td><b>Event Date:</b></td><td>${formattedDate}</td></tr>
  <tr><td><b>Headsets:</b></td><td>${headsetQty}</td></tr>
  <tr><td><b>Suburb:</b></td><td>${suburb}</td></tr>
  <tr><td><b>Deposit Paid:</b></td><td>$${amountPaid} AUD</td></tr>
  <tr><td><b>Stripe Session:</b></td><td>${sessionId}</td></tr>
</table>
</div>`;

  try {
    // Send customer email
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Shush Party Hire <booking@shushpartyhire.com.au>',
        to: [customerEmail],
        subject: `Booking Confirmed — ${formattedDate} | Shush Party Hire`,
        html: customerHtml,
      })
    });

    // Send Todd notification
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Shush Bookings <booking@shushpartyhire.com.au>',
        to: [toddEmail],
        subject: `New Booking: ${customerName} — ${formattedDate}`,
        html: toddHtml,
      })
    });

    console.log('Confirmation emails sent to', customerEmail, 'and', toddEmail);
  } catch (emailErr) {
    console.error('Email send failed (non-fatal):', emailErr.message);
  }
}

// Stripe HMAC-SHA256 signature verification using Web Crypto API
async function verifyStripeSignature(payload, header, secret) {
  try {
    const parts = header.split(',');
    let timestamp = '';
    const signatures = [];

    for (const part of parts) {
      const [k, v] = part.split('=');
      if (k === 't') timestamp = v;
      if (k === 'v1') signatures.push(v);
    }

    if (!timestamp || signatures.length === 0) return false;

    // Reject webhooks older than 5 minutes
    if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp)) > 300) return false;

    const encoder = new TextEncoder();
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
