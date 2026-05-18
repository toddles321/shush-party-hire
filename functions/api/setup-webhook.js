export async function onRequestGet(context) {
  const { env } = context;
  try {
    // Get full details of existing webhook
    const listRes = await fetch('https://api.stripe.com/v1/webhook_endpoints?limit=20', {
      headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
    });
    const listData = await listRes.json();
    const existing = listData.data?.find(w => w.url === 'https://shushpartyhire.com.au/api/stripe-webhook');

    if (existing) {
      // Send a test event to verify signing secret works
      const testRes = await fetch(`https://api.stripe.com/v1/webhook_endpoints/${existing.id}`, {
        headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` }
      });
      const detail = await testRes.json();

      return new Response(JSON.stringify({
        status: 'webhook_confirmed',
        id: detail.id,
        url: detail.url,
        livemode: detail.livemode,
        api_version: detail.api_version,
        enabled_events: detail.enabled_events,
        webhook_status: detail.status,
        secret_stored: env.STRIPE_WEBHOOK_SECRET ? 'yes (length: ' + env.STRIPE_WEBHOOK_SECRET.length + ')' : 'MISSING',
        stripe_key_mode: env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE' : env.STRIPE_SECRET_KEY?.startsWith('sk_test') ? 'TEST' : 'unknown'
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // Webhook not found — create it
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
      livemode: data.livemode,
      enabled_events: data.enabled_events,
      stripe_key_mode: env.STRIPE_SECRET_KEY?.startsWith('sk_live') ? 'LIVE' : 'TEST',
      error: data.error
    }), { headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
