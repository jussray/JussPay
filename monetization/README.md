# Juss & Co — independent monetization + native Cloudflare readiness

**Status:** Standalone starter package; NOT installed, connected to live Stripe, deployed, or merged. This is an optional *new* Cloudflare Worker, not a patch to any existing app.

## What works once configured

**Path A, available without Cloudflare beta:** A standalone Worker creates one-time Stripe Checkout sessions for a merchant-configured `STRIPE_PRICE_ID`. It generates a cryptographically random API key, returns it only to the purchaser, stores only its SHA-256 hash in a dedicated D1 database, and grants `CREDITS_PER_PURCHASE` credits only after a **verified Stripe webhook** matches an approved positive amount and currency AND a Stripe API lookup confirms the expected one-time Price/quantity. Checkout also preflights the Stripe Price before creating a session. Subsequent paid API requests consume one credit atomically. Signature timestamp protection, replay-safe activation, and refund/dispute revocation (including out-of-order events) are included.

**Path B, reserved for later:** Cloudflare Monetization Gateway x402 per-request billing can be added **only after approval**. The gateway remains in closed beta, and origin verification of signed `PAYMENT-CONTEXT` is mandatory. This starter intentionally does not trust or accept any `PAYMENT-CONTEXT` header. Never enable a bare 402 header and call it paid access.

### Critical scope protection

- A *new* Worker on its own hostname — **never** wildcard over `jussco.company/*`, `chief`, `foundercontrolroom.org`, storefront checkout, or teen-app endpoints.
- Existing public homepages remain public; all existing private apps stay behind their own existing auth and Cloudflare Access configurations.
- No user, teen, customer, journal, admin, or checkout data copied into this service.
- This example sells only *future non-sensitive API products*, not general public search indexing or crawling rights. Non-paying ordinary crawlers are not billed by Stripe automatically.

## Safe rollout steps

1. Confirm business/payment processor eligibility with the merchant account holder. Do not evade identity, age, or merchant-verification requirements.
2. Create a **separate** Cloudflare D1 database. Apply `schema.sql` via Wrangler D1 console/CLI or the dashboard.
3. Set up a **one-time, fixed-unit** Stripe Price for the intended credit package. Explicitly approve `STRIPE_PRICE_ID`, `STRIPE_EXPECTED_AMOUNT_MINOR`, `STRIPE_EXPECTED_CURRENCY` and the number of credits. The Worker compares these settings against Stripe before allowing Checkout; no production price is presumed here.
4. Copy `wrangler.toml.example` to `wrangler.toml` and fill in a **new** dedicated hostname plus the actual D1 ID and Stripe Price ID. Avoid any route overlapping existing app paths.
5. Configure `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` using encrypted Worker secrets; do not commit keys.
6. Point Stripe's webhook endpoint to `https://YOUR_NEW_HOST/api/stripe/webhook`; listen for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, and `charge.dispute.created`.
7. Apply WAF/rate-limiting to unauthenticated `POST /api/checkout`; enable request logs without logging API keys, raw webhook content, email addresses, or card data.
8. Test with Stripe **test-mode** credentials and test price. Confirm correct signature accepted, tampered signature rejected, wrong price/currency/amount rejected, webhook replay grants only once, unpaid key cannot access, refunded key cannot access, and credits do not go negative. The local tests mock Stripe; real test-mode integration is still required.
9. Keep `CHECKOUT_ENABLED` and `PREMIUM_ENABLED` set to `false` until the actual paid resource and all business/customer gates are ready. Replace `/api/premium/example`'s **placeholder** response with an approved non-sensitive resource. Add terms, support, key recovery/customer identity, refunds, consumer disclosures, inventory/pricing, monitoring, alerting, and tax/accounting review.
10. Only after those gates and an explicit deployment approval should the worker be attached to a public hostname. **This package has not been deployed.**

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness (does not reveal secrets) |
| `GET /` | Demonstration of creating Checkout session |
| `POST /api/checkout` | Returns a Stripe checkout URL and one-time-view API key |
| `POST /api/stripe/webhook` | Stripe signed events; credits granted only on verified paid checkout |
| `GET /api/credits` | Check balance with `Authorization: Bearer jco_...` |
| `GET /api/premium/example` | Deduct one credit, return **demo** content |

**Account recovery note:** The API key is shown once before Checkout and is never stored in plaintext. There is no automated key recovery in this starter. This is a deliberate limitation; customer identities and recovery must be built before selling to the public.

## Cloudflare gateway integration gate (future)

Once beta access is granted, add a **separate, route-specific** x402 gateway rule to an explicitly selected non-sensitive resource (e.g. a new paid API endpoint). Verify `PAYMENT-CONTEXT` JWT issuer/signature, audience, time claims, and payment scope according to Cloudflare's current documentation, not a raw header. Test status 402 without payment and successful access with payment, while checking browser homepage 200, original auth, existing checkout and teen projects. Do not overlay the Stripe API-key and gateway policies on the same path without explicit precedence to avoid double charging.

## Current limitations

- No prebuilt business-specific data product; only example test content.
- Not integrated with the current Juss & Co repo, Stripe products, or existing Cloudflare zone.
- No production abuse controls, customer login/recovery, or automated billing reconciliation. No real Stripe/Cloudflare integration tests have run.
- A changed production Price configuration can cause a previously created session to fail fulfillment. Persist immutable order/Price snapshots and provide reconciliation before live use.
- Checkout currently reveals a one-time API key before payment; safe automated customer recovery and identity verification are missing.
- The merchant must meet Stripe eligibility and identity/age requirements. Do not bypass merchant verification or use another person’s identity.
- Refund/revocation is limited to webhooks with a `payment_intent` reference. Also reconcile chargebacks/Stripe state periodically in production.
- This does NOT circumvent beta admission or zone-age rules. It only runs a separate Stripe payment path.

Official references:
- Cloudflare: https://developers.cloudflare.com/monetization-gateway/
- x402 and validation: https://developers.cloudflare.com/monetization-gateway/x402/
- Stripe Checkout: https://docs.stripe.com/api/checkout/sessions
- Cloudflare D1 batching: https://developers.cloudflare.com/d1/worker-api/d1-database/