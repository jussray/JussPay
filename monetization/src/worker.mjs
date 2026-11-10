/**
 * Juss & Co — isolated paid-API starter for Cloudflare Workers + D1 + Stripe.
 * Stripe prepaid credits work independently of Cloudflare Monetization Gateway.
 * This is deliberately NOT a proxy for existing apps, site routes or checkout.
 */

const encoder = new TextEncoder();
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const MAX_BODY_BYTES = 128_000;

function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS }); }
function html(body, status = 200) { return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "x-content-type-options": "nosniff" } }); }
function hex(bytes) { return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(str) { return hex(await crypto.subtle.digest('SHA-256', encoder.encode(str))); }
function generateApiKey() { const random = new Uint8Array(32); crypto.getRandomValues(random); return 'jco_' + btoa(String.fromCharCode(...random)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function validKey(v) { return typeof v === 'string' && /^jco_[A-Za-z0-9_-]{43}$/.test(v); }
function getApiKey(request) { const h = request.headers.get('Authorization') || ''; return h.startsWith('Bearer ') ? h.substring(7) : null; }
function getBase(env) {
  const url = new URL(env.PUBLIC_BASE_URL);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('PUBLIC_BASE_URL must use HTTPS');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_BASE_URL must be a site origin');
  return url.origin;
}
function creditsPerPurchase(env) {
  const n = Number(env.CREDITS_PER_PURCHASE || 100);
  if (!Number.isSafeInteger(n) || n < 1 || n > 100000) throw new Error('Invalid CREDITS_PER_PURCHASE');
  return n;
}

// Fails closed when an expected one-time amount or currency has not been approved.
// Amounts are Stripe minor units: 1000 = $10.00 for USD; do not assume all currencies have 2 decimals.
function approvedPurchase(env) {
  const amount = Number(env.STRIPE_EXPECTED_AMOUNT_MINOR);
  const currency = env.STRIPE_EXPECTED_CURRENCY;
  if (!Number.isSafeInteger(amount) || amount <= 0 ||
      typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency) ||
      typeof env.STRIPE_PRICE_ID !== 'string' || !/^price_[A-Za-z0-9_]+$/.test(env.STRIPE_PRICE_ID)) {
    throw new Error('Approved price, minor-unit amount and currency are required');
  }
  return { priceId: env.STRIPE_PRICE_ID, amount, currency };
}

// Validate Stripe's actual catalog Price BEFORE opening Checkout to avoid charging a
// customer at a mismatched amount and later withholding the paid credits.
async function checkStripePrice(env, purchase) {
  const response = await fetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(purchase.priceId)}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!response.ok) throw new Error('Stripe Price validation unavailable');
  const price = await response.json();
  return price?.id === purchase.priceId && price.active === true &&
    price.livemode === env.STRIPE_SECRET_KEY.startsWith('sk_live_') &&
    price.type === 'one_time' && price.recurring == null &&
    price.unit_amount === purchase.amount && price.currency === purchase.currency;
}

// A webhook's signature proves Stripe sent it; it does not prove it purchased OUR price.
// Read the session's actual line item from Stripe before granting entitlements.
async function checkStripeLineItem(sessionId, env, purchase) {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Missing Stripe verification credential');
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=10`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
  if (!response.ok) throw new Error('Stripe line-item verification unavailable');
  const items = await response.json();
  if (items?.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1) return false;
  const item = items.data[0];
  return item?.price?.id === purchase.priceId &&
    item?.price?.type === 'one_time' &&
    item.quantity === 1 && item.amount_total === purchase.amount &&
    item.currency === purchase.currency;
}

async function stripeCheckout(request, env) {
  if (env.CHECKOUT_ENABLED !== 'true') return json({ error: 'Checkout is not enabled' }, 503);
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) return json({ error: 'Checkout not configured' }, 503);
  // Refuse to offer checkout until the approved amount matches the actual Stripe catalog.
  let purchase;
  try { purchase = approvedPurchase(env); }
  catch { return json({ error: 'Approved price is not configured' }, 503); }
  // Public endpoint: fail closed without a keyed limiter, and limit BEFORE any Stripe call or D1 write.
  const limiter = env.CHECKOUT_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return json({ error: 'Checkout rate limiter not configured' }, 503);
  const { success: withinLimit } = await limiter.limit({ key: request.headers.get('cf-connecting-ip') || 'unknown' });
  if (!withinLimit) return json({ error: 'Too many checkout attempts. Please retry later.' }, 429);
  try {
    if (!(await checkStripePrice(env, purchase))) return json({ error: 'Approved Stripe Price mismatch' }, 503);
  } catch { return json({ error: 'Stripe Price verification unavailable' }, 503); }
  // WAF rules are still a separate release item; the keyed limiter above is the in-Worker guard.
  if (request.headers.get('content-length') && Number(request.headers.get('content-length')) > 64) return json({ error: 'Unexpected request body' }, 413);
  const apiKey = generateApiKey();
  const tokenHash = await sha256(apiKey);
  const now = Math.floor(Date.now() / 1000);
  const origin = getBase(env);
  const purchaseCredits = creditsPerPurchase(env);
  await env.DB.prepare('INSERT INTO access_tokens(token_hash, status, remaining, created_at, updated_at) VALUES(?, ?, 0, ?, ?)')
    .bind(tokenHash, 'pending', now, now).run();

  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': env.STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    'metadata[token_hash]': tokenHash,
    'metadata[purpose]': 'jussco_api_credits',
    success_url: origin + '/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: origin + '/',
  });
  let checkout;
  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded', 'Idempotency-Key': tokenHash },
      body: form.toString(),
    });
    checkout = await res.json();
    if (!res.ok || !checkout.id || !checkout.url || !checkout.url.startsWith('https://checkout.stripe.com/')) throw new Error('Checkout session failed');
    await env.DB.prepare('UPDATE access_tokens SET checkout_session_id = ?, updated_at = ? WHERE token_hash = ? AND status = ?')
      .bind(checkout.id, now, tokenHash, 'pending').run();
  } catch (_err) {
    await env.DB.prepare('DELETE FROM access_tokens WHERE token_hash = ? AND status = ?')
      .bind(tokenHash, 'pending').run();
    return json({ error: 'Payment provider unavailable. Please retry.' }, 502);
  }
  // API key is never saved as plaintext; it is returned ONCE, before payment.
  return json({ checkout_url: checkout.url, api_key: apiKey, credits_after_payment: purchaseCredits, message: 'Save your API key before paying. It cannot be recovered.' });
}

async function verifyStripeSignature(raw, signatureHeader, secret, now = Math.floor(Date.now() / 1000)) {
  if (!secret || !signatureHeader) return false;
  const parts = signatureHeader.split(',').map(p => p.trim());
  const ts = parts.find(p => /^t=\d+$/.test(p))?.substring(2);
  const sigs = parts.filter(p => /^v1=[0-9a-f]{64}$/i.test(p)).map(p => p.substring(3).toLowerCase());
  if (!ts || !sigs.length || Math.abs(now - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${ts}.${raw}`)));
  const actual = new Uint8Array(digest.match(/../g).map(h => parseInt(h, 16)));
  return sigs.some(sig => {
    const candidate = new Uint8Array(sig.match(/../g).map(h => parseInt(h, 16)));
    let diff = 0; for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ candidate[i]; return diff === 0;
  });
}

// Invariant 4: a mismatched paid event fails closed and leaves a non-sensitive receipt.
// Stores only the Stripe event id with applied = 0: no amounts, tokens, or payment data.
async function recordMismatchReceipt(env, eventId, now) {
  await env.DB.prepare('INSERT OR IGNORE INTO webhook_events(event_id, applied, created_at) VALUES(?, 0, ?)')
    .bind(eventId, now).run();
}

async function stripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Webhook not configured' }, 503);
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Payload too large' }, 413);
  if (!(await verifyStripeSignature(raw, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'Invalid signature' }, 400);
  }
  let event;
  try { event = JSON.parse(raw); } catch { return json({ error: 'Invalid payload' }, 400); }
  if (!event || typeof event.id !== 'string' || !event.id.startsWith('evt_')) return json({ error: 'Invalid event' }, 400);
  // Prevent mixing live and test events/credentials across environments.
  if (typeof event.livemode !== 'boolean' || event.livemode !== env.STRIPE_SECRET_KEY?.startsWith('sk_live_')) {
    return json({ error: 'Stripe mode mismatch' }, 400);
  }
  const obj = event.data?.object || {};
  const now = Math.floor(Date.now() / 1000);
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    if (obj.mode !== 'payment' || obj.payment_status !== 'paid' || obj.metadata?.purpose !== 'jussco_api_credits') return json({ received: true });
    const tokenHash = obj.metadata?.token_hash;
    if (!/^[a-f0-9]{64}$/.test(tokenHash || '') || !String(obj.id || '').startsWith('cs_') || !String(obj.payment_intent || '').startsWith('pi_')) return json({ error: 'Invalid checkout metadata' }, 400);
    let purchase;
    try { purchase = approvedPurchase(env); } catch { return json({ error: 'Approved price configuration missing' }, 503); }
    // Reject zero-dollar, alternate-currency, or modified-amount purchases before reading Stripe.
    if (obj.amount_total !== purchase.amount || obj.currency !== purchase.currency) {
      await recordMismatchReceipt(env, event.id, now);
      return json({ received: true });
    }
    // Unknown, already redeemed, and revoked sessions may not trigger external verification calls.
    const pending = await env.DB.prepare(`SELECT status FROM access_tokens WHERE token_hash = ? AND checkout_session_id = ?`)
      .bind(tokenHash, obj.id).first();
    if (!pending || pending.status !== 'pending') return json({ received: true });
    const revoked = await env.DB.prepare('SELECT payment_intent FROM payment_intent_revocations WHERE payment_intent = ?')
      .bind(obj.payment_intent).first();
    if (revoked) return json({ received: true });
    let matched;
    try { matched = await checkStripeLineItem(obj.id, env, purchase); }
    catch { return json({ error: 'Payment verification temporarily unavailable' }, 503); }
    if (!matched) {
      await recordMismatchReceipt(env, event.id, now);
      return json({ received: true });
    }
    // Batch guarantees atomicity. Only pending tokens become active; replay does not double-grant.
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO webhook_events(event_id, applied, created_at) VALUES(?, 0, ?)').bind(event.id, now),
      env.DB.prepare(`UPDATE access_tokens SET status = 'active', remaining = ?, payment_intent = ?, updated_at = ?
        WHERE token_hash = ? AND checkout_session_id = ? AND status = 'pending'
          AND NOT EXISTS(SELECT 1 FROM payment_intent_revocations WHERE payment_intent = ?)
          AND EXISTS(SELECT 1 FROM webhook_events WHERE event_id = ? AND applied = 0)`)
        .bind(creditsPerPurchase(env), obj.payment_intent, now, tokenHash, obj.id, obj.payment_intent, event.id),
      env.DB.prepare('UPDATE webhook_events SET applied = 1 WHERE event_id = ?').bind(event.id),
    ]);
  } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
    const paymentIntent = obj.payment_intent;
    if (typeof paymentIntent === 'string' && paymentIntent.startsWith('pi_')) {
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO webhook_events(event_id, applied, created_at) VALUES(?, 0, ?)').bind(event.id, now),
        env.DB.prepare('INSERT OR IGNORE INTO payment_intent_revocations(payment_intent, created_at) VALUES(?, ?)').bind(paymentIntent, now),
        env.DB.prepare(`UPDATE access_tokens SET status = 'revoked', remaining = 0, updated_at = ?
          WHERE payment_intent = ? AND status = 'active'
            AND EXISTS(SELECT 1 FROM webhook_events WHERE event_id = ? AND applied = 0)`).bind(now, paymentIntent, event.id),
        env.DB.prepare('UPDATE webhook_events SET applied = 1 WHERE event_id = ?').bind(event.id),
      ]);
    }
  }
  return json({ received: true });
}

async function balance(request, env) {
  const apiKey = getApiKey(request);
  if (!validKey(apiKey)) return json({ error: 'API key required' }, 401);
  const h = await sha256(apiKey);
  const result = await env.DB.prepare('SELECT status, remaining FROM access_tokens WHERE token_hash = ?').bind(h).first();
  if (!result) return json({ error: 'Invalid API key' }, 401);
  return json({ status: result.status, remaining: result.remaining });
}

async function premium(request, env) {
  if (env.PREMIUM_ENABLED !== 'true') return json({ error: 'Paid resource is disabled' }, 503);
  const apiKey = getApiKey(request);
  if (!validKey(apiKey)) return json({ error: 'API key required' }, 401);
  const h = await sha256(apiKey);
  // Atomic decrement on D1: no access with pending, revoked, or exhausted keys.
  const result = await env.DB.prepare(`UPDATE access_tokens SET remaining = remaining - 1, updated_at = ?
    WHERE token_hash = ? AND status = 'active' AND remaining > 0 RETURNING remaining`)
    .bind(Math.floor(Date.now() / 1000), h).first();
  if (!result) return json({ error: 'No paid credits available' }, 402);
  // Intentionally placeholder payload; replace ONLY with approved non-sensitive content.
  return json({ product: 'Juss & Co paid API', type: 'example', remaining: result.remaining,
    note: 'This is a test endpoint. Do not sell or claim access to proprietary data until a product handler is integrated.' });
}

const HOME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Juss & Co — Paid API Access (Demo)</title><style>
body{background:#11121b;color:#f1efff;font:16px system-ui;margin:0;padding:3rem 1.2rem}main{max-width:680px;margin:auto}h1{font-size:clamp(2rem,6vw,3.1rem)}p{line-height:1.6}button,a.action{display:inline-block;background:#d4b8ff;color:#171020;border:0;border-radius:12px;padding:14px 20px;font-weight:700;text-decoration:none;cursor:pointer}pre{background:#262036;border-radius:10px;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere}small{color:#c8bfd8}</style></head>
<body><main><p>JUSS & CO / API ACCESS</p><h1>Turn thoughts into living works.</h1><p>Prepaid API credits can be purchased independently of Cloudflare Monetization Gateway. This page is a developer demonstration, not a finished customer storefront.</p><button id="buy">Create checkout</button><p id="status" role="status"></p><div id="keybox" hidden><p><strong>Copy your API key BEFORE paying.</strong> It is shown once; losing it means contacting support for manual recovery.</p><pre id="secret"></pre><a class="action" id="pay" rel="noopener noreferrer">Continue to Stripe checkout</a></div>
<p><small>This starter does not expose or sell private app content. It requires an approved price, test payments, rate limits, support and legal review before production.</small></p></main><script>
document.getElementById('buy').onclick=async()=>{const b=document.getElementById('buy');b.disabled=true;try{const r=await fetch('/api/checkout',{method:'POST'});const d=await r.json();if(!r.ok)throw Error(d.error||'Checkout failed');document.getElementById('secret').textContent=d.api_key;const a=document.getElementById('pay');a.href=d.checkout_url;document.getElementById('keybox').hidden=false;document.getElementById('status').textContent='Checkout ready: '+d.credits_after_payment+' credits after successful payment.';}catch(e){document.getElementById('status').textContent=e.message;}finally{b.disabled=false;}};
</script></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'jussco-paid-api', mode: 'stripe-prepaid' });
      if (request.method === 'GET' && url.pathname === '/') return html(HOME);
      if (request.method === 'GET' && url.pathname === '/success') return html('<!doctype html><html><meta charset="utf-8"><title>Checkout completed</title><main><h1>Checkout submitted</h1><p>Payment may still be processing. Use the API key you saved before payment to check your credit balance.</p><p><a href="/">Back</a></p></main></html>');
      if (request.method === 'POST' && url.pathname === '/api/checkout') return await stripeCheckout(request, env);
      if (request.method === 'POST' && url.pathname === '/api/stripe/webhook') return await stripeWebhook(request, env);
      if (request.method === 'GET' && url.pathname === '/api/credits') return await balance(request, env);
      if (request.method === 'GET' && url.pathname === '/api/premium/example') return await premium(request, env);
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      // Never leak raw provider errors or secrets to clients.
      console.error('Internal API error:', err?.name || 'UnknownError');
      return json({ error: 'Internal error' }, 500);
    }
  },
};
export { verifyStripeSignature, generateApiKey, sha256 };