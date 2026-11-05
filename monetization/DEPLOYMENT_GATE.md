# Deployment and non-disruption gate

## Verified locally (2026-10-24)

- Node.js 22 built-in test runner: **7/7 tests passed**.
- Tests use an in-memory SQLite-based D1 mock and fake Stripe Checkout session. **No actual Stripe/Cloudflare payment was performed.**
- No existing repo, GitHub branch, Cloudflare zone, DNS, Stripe account, payment, personal files, or secrets were accessed or changed.

## Required before public release

- [ ] Authorized merchant confirms eligibility and Stripe price details.
- [ ] Business owner selects a specific, non-sensitive paid API resource. Demo placeholder must be replaced.
- [ ] Dedicated hostname/Worker and isolated D1 created; no existing routes replaced.
- [ ] Secret keys configured securely outside the code.
- [ ] Customer sign-in or secure recovery flow designed and reviewed.
- [ ] Test mode checkout and actual signed Stripe webhook end-to-end verification performed.
- [ ] Anti-abuse controls/WAF/rate-limiting and monitoring enabled.
- [ ] Refunds, disputes, billing reconciliation, receipts and support policy reviewed.
- [ ] Public entrance paths tested as HTTP 200; private paths retain access checks.
- [ ] Existing JBH checkout and health endpoints tested unaffected.
- [ ] Founder explicitly approves deployment and activation. The example flags default to OFF.

## Native Cloudflare Gateway (future only)

- [ ] Cloudflare confirms gateway beta access and correct eligible zone.
- [ ] Paid paths scoped to approved non-sensitive products and specific traffic.
- [ ] Signed origin PAYMENT-CONTEXT JWT validated (not blindly trusted).
- [ ] Both independent and gateway paths cannot double-charge the same request.
- [ ] Logged-out browsers still receive public entrances; existing private paths remain protected.
- [ ] Cross-product regression tests pass.

## Non-destructive rollback

1. Set `CHECKOUT_ENABLED=false` and `PREMIUM_ENABLED=false`; do not delete any user data or existing Worker configuration without explicit authorization.
2. Remove the **dedicated paid-API** route only after confirming no other service uses it. Leave all existing website/checkout routes untouched.
3. Maintain access, billing, refund and audit records in accordance with applicable obligations and authorized retention policy. Do not silently discard purchased credits.

## Hardening checkpoint — 2026-10-29

Local mock-backed tests: 15 passed, 0 failed (Node v22.16.0). This does not certify production readiness.

- Checkout now requires an expected positive Stripe amount in minor units, expected currency and one-time Price ID, and uses the Stripe Price API to compare before creating a session.
- Webhook fulfillment requires signature/timestamp, environment mode, paid status, matching amount/currency, locally pending session, no revocation, and a Stripe line-item API check for price, quantity, amount, currency, and one-time type.
- Stripe API lookup failures return 503 so the webhook can retry without granting credits.
- Checkout still generates a one-time API key before successful payment; no authenticated recovery, customer service mechanism or business-ready endpoint exists.
- No actual Stripe test-mode charge, D1 binding, deployed Worker, DNS change, or Cloudflare x402 integration is verified.

**Launch decision: HOLD.** Keep CHECKOUT_ENABLED=false and PREMIUM_ENABLED=false. Do not merge/deploy or configure production secrets until customer identity/recovery, real API deliverable, rate limiting, merchant eligibility, live/staging integration testing and explicit approval are complete.