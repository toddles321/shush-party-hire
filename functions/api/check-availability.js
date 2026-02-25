export async function onRequestGet(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://shushpartyhire.com.au',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  try {
    const url = new URL(request.url);
    const date = url.searchParams.get('date');

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return new Response(JSON.stringify({ available: 400, booked: 0 }), {
        status: 200, headers: corsHeaders,
      });
    }

    // Query Airtable for confirmed bookings on this date
    const filterFormula = encodeURIComponent(
      `AND({Event Date}="${date}", OR({Status}="Confirmed", {Status}="Deposit Pending"))`
    );

    const atRes = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(env.AIRTABLE_TABLE_NAME)}?filterByFormula=${filterFormula}&fields[]=Headset Quantity&fields[]=Status`,
      {
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!atRes.ok) {
      // If Airtable fails, return full availability — don't block the customer
      return new Response(JSON.stringify({ available: 400, booked: 0, error: 'lookup_failed' }), {
        status: 200, headers: corsHeaders,
      });
    }

    const atData = await atRes.json();
    const records = atData.records || [];

    // Sum headsets already committed on this date
    let booked = 0;
    for (const record of records) {
      const qty = parseInt(record.fields['Headset Quantity']) || 0;
      booked += qty;
    }

    const available = Math.max(0, 400 - booked);

    return new Response(JSON.stringify({
      available,
      booked,
      date,
    }), {
      status: 200, headers: corsHeaders,
    });

  } catch (err) {
    console.error('check-availability error:', err);
    // Fail open — do not block customer from booking
    return new Response(JSON.stringify({ available: 400, booked: 0 }), {
      status: 200, headers: corsHeaders,
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': 'https://shushpartyhire.com.au',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
