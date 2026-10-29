# JussPay hardening audit — 2026-10-29

Status: AUTHORED + LOCALLY VERIFIED (test suite only); not production tested.

## Evidence scope
- Source originated from the Juss & Co standalone starter archive, preserved unchanged outside this copy.
- Reproduced RED: signed `checkout.session.completed` zero-dollar event granted credits in the unpatched starter.
- Reproduced RED: checkout creation succeeded with an actual Stripe Price amount inconsistent with configured expected amount (mocked provider).
- Applied checks for approved minor-unit amount, currency, one-time Stripe Price, Stripe test/live mode, pending session, revocation, and signed webhook before granting credits.
- GREEN: `npm test` → 15 passing / 0 failing; Node v22.16.0; Stripe HTTP mocked; in-memory SQLite substitutes for Cloudflare D1.
- CI workflow configured for repository PR verification; CI not established as passing until GitHub reports it.

## Remaining blockers
1. Merchant eligibility/identity requirements, including applicable age requirements, must be satisfied by the actual account owner.
2. No real Stripe test-mode Checkout/webhook/refund round trip and no Cloudflare D1 integration evidence.
3. One-time API key is issued before payment; secure customer identity and recovery are absent.
4. Paid endpoint is demo content and cannot be represented as a commercial product.
5. Rate limiting, price-version snapshots, durable reconciliation, customer support/legal review and production security gates are missing.
6. No Cloudflare native monetization beta approval has been established.

**Release verdict:** HOLD. The standalone code must not intercept storefront checkout, authentication, existing public routes, or youth-product data. Leave CHECKOUT_ENABLED=false and PREMIUM_ENABLED=false. No Cloudflare DNS/Worker production write or GitHub merge authorized by this audit.