export async function onRequestGet(context) {
  const { env } = context;
  try {
    // List existing webhooks first to avoid duplicates
    const listRes = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    const listData = await listRes.json();
    const existing = listData.data?.find(w => w.url === 'https://shushpartyhire.com.au/api/stripe-webhook');
    if (existing) {
      return new Response(JSON.stringify({
        status: 'already_exists',
        id: existing.id,
        url: existing.url,
        enabled_events: existing.enabled_events
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    // Create the webhook endpoint
    const body = new URLSearchParams({
      url: 'https://shushpartyhire.com.au/api/stripe-webhook',
      'enabled_events[]': 'checkout.session.completed',
      description: 'Shush Party Hire booking confirmation'
    });
    const res = await fetch('https://api.stripe.com/v1/webhook_endpoints', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    const data = await res.json();
    return new Response(JSON.stringify({
      status: res.ok ? 'created' : 'error',
      id: data.id,
      url: data.url,
      secret: data.secret,
      enabled_events: data.enabled_events,
      error: data.error
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
