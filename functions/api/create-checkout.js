export async function onRequestPost(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://shushpartyhire.com.au',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const body = await request.json();

    // ── Validate inputs ─────────────────────────────────────────────────────────
    const qty      = parseInt(body.headsetQty) || 0;
    const duration = body.duration || '1';
    const delivery = parseInt(body.delivery) || 0;
    const ipod     = parseInt(body.iPodOption) || 0;
    const date     = body.eventDate || '';

    if (!qty || qty < 10 || qty > 400) {
      return new Response(JSON.stringify({ error: 'Invalid headset quantity.' }), {
        status: 400, headers: corsHeaders,
      });
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ error: 'Please select your event date.' }), {
        status: 400, headers: corsHeaders,
      });
    }

    // ── Re-verify availability server-side ──────────────────────────────────────
    // (client check is UX only — server is the source of truth)
    const filterFormula = encodeURIComponent(
      `AND({Event Date}="${date}", OR({Status}="Confirmed", {Status}="Deposit Pending"))`
    );
    const atCheck = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}?filterByFormula=${filterFormula}&fields[]=Headset Quantity`,
      { headers: { 'Authorization': `Bearer ${env.AIRTABLE_API_KEY}` } }
    );

    if (atCheck.ok) {
      const atCheckData = await atCheck.json();
      let booked = 0;
      for (const r of (atCheckData.records || [])) {
        booked += parseInt(r.fields['Headset Quantity']) || 0;
      }
      const available = 400 - booked;
      if (qty > available) {
        return new Response(JSON.stringify({
          error: `Sorry — only ${available} headsets are available on ${date}. Please adjust your quantity or choose a different date.`
        }), { status: 409, headers: corsHeaders });
      }
    }

    // ── Calculate price ─────────────────────────────────────────────────────────
    const prices = {10:99,20:179,30:229,40:269,50:319,75:439,100:549,150:769,200:999,300:1449,400:1899};
    const mults  = {'1':1,'2':1.5,'7':2};
    const base   = Math.round((prices[qty] || 319) * (mults[duration] || 1));
    const validIpod = [0,19,35,49].includes(ipod) ? ipod : 0;
    const total  = base + (delivery === 40 ? 40 : 0) + validIpod;
    const deposit = 150;

    // ── Save pending booking to Airtable ────────────────────────────────────────
    const durLabels = {'1':'1 Night','2':'2–3 Nights','7':'1 Week'};
    const ipodLabels = {0:'None',19:'1 iPod',35:'2 iPods',49:'3 iPods'};

    const atCreate = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            'Event Date': date,
            'Headset Quantity': qty,
            'Duration': durLabels[duration] || duration,
            'Delivery': delivery === 40 ? 'Delivery $40' : 'Free Pickup',
            'iPod Option': ipodLabels[ipod] || 'None',
            'Package Price': total,
            'Deposit Required': deposit,
            'Deposit Paid': false,
            'Status': 'Deposit Pending',
          },
        }),
      }
    );

    let airtableRecordId = '';
    if (atCreate.ok) {
      const atCreateData = await atCreate.json();
      airtableRecordId = atCreateData.id || '';
    } else {
      console.error('Airtable create failed:', await atCreate.text());
    }

    // ── Build duration label for Stripe ────────────────────────────────────────
    const durLabel = durLabels[duration] || '1 Night';
    const delLabel = delivery === 40 ? ' · Delivery $40' : ' · Free Pickup';
    const ipodLabel = ipod > 0 ? ` · ${ipodLabels[ipod] || ''} (+$${ipod})` : '';
    const description = `${qty} headsets · ${durLabel}${delLabel}${ipodLabel} — Balance of $${total - deposit} due before event`;

    // ── Create Stripe Checkout session ──────────────────────────────────────────
    const stripeParams = new URLSearchParams({
      'mode': 'payment',
      'payment_method_types[]': 'card',
      'line_items[0][price_data][currency]': 'aud',
      'line_items[0][price_data][product_data][name]': 'Silent Disco Deposit — Shush Party Hire',
      'line_items[0][price_data][product_data][description]': description,
      'line_items[0][price_data][unit_amount]': String(deposit * 100),
      'line_items[0][quantity]': '1',
      'success_url': 'https://shushpartyhire.com.au/booking-confirmed?session_id={CHECKOUT_SESSION_ID}',
      'cancel_url': 'https://shushpartyhire.com.au/#pricing',
      // Stripe custom fields — collect name, phone, suburb, notes
      'custom_fields[0][key]': 'mobile',
      'custom_fields[0][label][type]': 'custom',
      'custom_fields[0][label][custom]': 'Mobile Number',
      'custom_fields[0][type]': 'text',
      'custom_fields[1][key]': 'suburb',
      'custom_fields[1][label][type]': 'custom',
      'custom_fields[1][label][custom]': 'Event Suburb',
      'custom_fields[1][type]': 'text',
      'custom_fields[2][key]': 'notes',
      'custom_fields[2][label][type]': 'custom',
      'custom_fields[2][label][custom]': 'Any notes for Todd',
      'custom_fields[2][type]': 'text',
      'custom_fields[2][optional]': 'true',
      'phone_number_collection[enabled]': 'false',
      'metadata[airtable_record_id]': airtableRecordId,
      'metadata[event_date]': date,
      'metadata[headset_qty]': String(qty),
      'metadata[duration]': duration,
      'metadata[delivery]': String(delivery),
      'metadata[ipod]': String(ipod),
      'metadata[total_price]': String(total),
    });

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: stripeParams.toString(),
    });

    const stripeData = await stripeRes.json();

    if (!stripeRes.ok || !stripeData.url) {
      console.error('Stripe error:', JSON.stringify(stripeData));
      return new Response(JSON.stringify({ error: 'Payment setup failed. Please call Todd on 0400 050 176.' }), {
        status: 500, headers: corsHeaders,
      });
    }

    return new Response(JSON.stringify({ url: stripeData.url }), {
      status: 200, headers: corsHeaders,
    });

  } catch (err) {
    console.error('create-checkout error:', err);
    return new Response(JSON.stringify({ error: 'Something went wrong. Please call Todd on 0400 050 176.' }), {
      status: 500, headers: corsHeaders,
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://shushpartyhire.com.au',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
