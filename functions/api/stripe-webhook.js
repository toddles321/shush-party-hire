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

      // Send emails via Resend (RESEND_API_KEY). Owner alert always goes to info@.
      if (env.RESEND_API_KEY) {
        await sendConfirmationEmails({
          resendApiKey: env.RESEND_API_KEY,
          customerEmail,
          customerName: customerName || 'there',
          eventDate,
          headsetQty,
          suburb,
          mobile,
          notes,
          amountPaid,
          sessionId: session.id,
          packagePrice,
          duration: meta.duration || '',
          delivery: meta.delivery || '0',
          recordId,
          baseId: env.AIRTABLE_BASE_ID,
        });
      } else {
        console.error('RESEND_API_KEY missing - no booking emails sent');
      }
    }

    return new Response('OK', { status: 200 });

  } catch (err) {
    console.error('Webhook error:', err);
    return new Response('Webhook error', { status: 500 });
  }
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function sendResend(apiKey, payload, label) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`Resend ${label} FAILED (${res.status}):`, await res.text());
      return false;
    }
    console.log(`Resend ${label} sent`);
    return true;
  } catch (e) {
    console.error(`Resend ${label} error:`, e.message);
    return false;
  }
}

async function sendConfirmationEmails({ resendApiKey, customerEmail, customerName, eventDate, headsetQty, suburb, mobile, notes, amountPaid, sessionId, packagePrice, duration, delivery, recordId, baseId }) {
  const balanceDue = Math.max(0, (parseFloat(packagePrice) || 0) - parseFloat(amountPaid)).toFixed(2);
  const fromEmail = 'info@shushpartyhire.com.au';
  const ownerEmail = 'info@shushpartyhire.com.au';   // every new booking lands in the shared inbox

  const d = eventDate ? new Date(eventDate + 'T12:00:00Z') : null;
  const formattedDate = d && !isNaN(d)
    ? d.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    : 'TBC';
  const shortDate = d && !isNaN(d)
    ? d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    : 'date TBC';
  const durLabel = ({ '1': '1 night', '2': '2-3 nights', '7': '1 week' })[duration] || duration || '';
  const delLabel = String(delivery) === '40' ? 'Delivery ($40)' : 'Free pickup (Point Lonsdale)';

  // One-click "Add to Google Calendar" for the owner
  const ymd = eventDate ? eventDate.replace(/-/g, '') : '';
  const calLink = ymd
    ? 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' +
      encodeURIComponent(`SHUSH: ${headsetQty} headsets - ${customerName}`) +
      `&dates=${ymd}/${ymd}&details=` +
      encodeURIComponent(`${customerName}\n${mobile}\n${customerEmail}\n${suburb}\n${delLabel}\nBalance due: $${balanceDue}`) +
      '&location=' + encodeURIComponent(suburb || '')
    : '';
  const airtableLink = (baseId && recordId) ? `https://airtable.com/${baseId}` : '';
  const stripeLink = `https://dashboard.stripe.com/payments?query=${encodeURIComponent(sessionId)}`;

  const row = (k, v) => `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600;color:#111827">${v}</td></tr>`;

  const customerHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:560px;margin:0 auto;padding:40px 20px">
  <div style="background:#0d0d0d;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px">
    <h1 style="margin:0;font-size:28px;font-weight:800;color:#fff">Shush.</h1>
    <p style="margin:8px 0 0;color:#9ca3af;font-size:14px">Silent Disco Hire &middot; Geelong &amp; Bellarine</p>
  </div>
  <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
    <h2 style="margin:0 0 8px;font-size:22px;color:#111827">Booking Confirmed &#127881;</h2>
    <p style="margin:0 0 24px;color:#6b7280">Hey ${esc(customerName)}, your silent disco deposit is locked in. Get ready for an amazing event!</p>
    <div style="background:#f9fafb;border-radius:8px;padding:20px;margin-bottom:24px">
      <table style="width:100%;border-collapse:collapse">
        ${row('Event Date', esc(formattedDate))}
        ${row('Headsets', esc(headsetQty || 'As quoted'))}
        ${durLabel ? row('Hire length', esc(durLabel)) : ''}
        ${row('Pickup / delivery', esc(delLabel))}
        ${row('Location', esc(suburb || 'As discussed'))}
        <tr style="border-top:1px solid #e5e7eb"><td style="padding:12px 0 6px;color:#6b7280;font-size:14px;font-weight:600">Deposit Paid</td><td style="padding:12px 0 6px;text-align:right;font-weight:700;color:#059669;font-size:16px">$${esc(amountPaid)} AUD</td></tr>
        ${row('Balance due before event', '$' + esc(balanceDue) + ' AUD')}
      </table>
    </div>
    <p style="margin:0 0 16px;color:#374151;font-size:15px">Pickup or delivery timing will be confirmed by email before your event. Your setup guide (video + written) is sent ahead of the night.</p>
    <p style="margin:0;color:#6b7280;font-size:14px">Questions? Just reply to this email &mdash; <a href="mailto:info@shushpartyhire.com.au" style="color:#7c3aed">info@shushpartyhire.com.au</a></p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:24px">
    Shush Party Hire &middot; Geelong &amp; Bellarine Peninsula, VIC<br>
    <a href="https://shushpartyhire.com.au/privacy.html" style="color:#9ca3af">Privacy Policy</a> &middot; <a href="https://shushpartyhire.com.au/terms.html" style="color:#9ca3af">Terms &amp; Conditions</a>
  </p>
</div>
</body>
</html>`;

  const btn = (href, label, bg) => href ? `<a href="${href}" style="display:inline-block;margin:4px 6px 4px 0;padding:10px 16px;background:${bg};color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:14px">${label}</a>` : '';
  const ownerHtml = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:16px;color:#111827">
<h2 style="margin:0 0 4px">&#128176; New booking &mdash; ${esc(headsetQty)} headsets</h2>
<p style="margin:0 0 16px;color:#6b7280">${esc(formattedDate)} &middot; $${esc(amountPaid)} deposit paid &middot; <b>$${esc(balanceDue)} still to collect</b></p>
<table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;padding:12px">
  ${row('Name', esc(customerName))}
  ${row('Mobile', mobile ? `<a href="tel:${esc(mobile.replace(/\s/g, ''))}">${esc(mobile)}</a>` : 'Not provided')}
  ${row('Email', `<a href="mailto:${esc(customerEmail)}">${esc(customerEmail)}</a>`)}
  ${row('Event suburb', esc(suburb || '-'))}
  ${row('Hire length', esc(durLabel || '-'))}
  ${row('Pickup / delivery', esc(delLabel))}
  ${row('Notes from customer', esc(notes || '-'))}
</table>
<p style="margin:16px 0 8px">${btn(calLink, 'Add to Google Calendar', '#7c3aed')}${btn(airtableLink, 'Open bookings (Airtable)', '#0e7490')}${btn(stripeLink, 'View payment (Stripe)', '#374151')}</p>
<p style="margin:8px 0 0;color:#9ca3af;font-size:12px">Hit reply to email the customer directly. Stripe session: ${esc(sessionId)}</p>
</div>`;

  // Owner alert FIRST so a customer-email problem can never hide a booking
  await sendResend(resendApiKey, {
    from: `Shush Bookings <${fromEmail}>`,
    reply_to: customerEmail || ownerEmail,
    to: [ownerEmail],
    subject: `New booking: ${headsetQty} headsets, ${shortDate} - ${customerName} ($${balanceDue} due)`,
    html: ownerHtml,
  }, 'owner alert');

  // No automatic customer email: follow-up is done personally from info@ (reply to the alert above).
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
