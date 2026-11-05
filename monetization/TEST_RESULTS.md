# Local test results — 2026-10-24

**Result: PASS (7 tests, 0 failures).**

1. Generated API keys are random and hashes have expected form.
2. Stripe HMAC signatures accept valid signatures and reject tampered/stale payloads.
3. Pending key denied; signed paid webhook activates once; credits decremented; refunds revoke.
4. Unsigned webhooks and wrong checkout-session metadata cannot grant access.
5. Health works; unknown/private routes are not exposed.
6. Checkout and paid endpoints are disabled by default.
7. Out-of-order refunds prevent a later webhook from granting credits.

**Test boundaries:** Local fake Stripe response and D1 mocked with in-memory SQLite; does not verify Cloudflare Workers deployment, live payment provider settings, DNS, existing application integration, or end-to-end money movement. Do not claim production readiness from these tests.

## 2026-10-29 local security regression (hardened working copy)

The original prototype passed 7 tests but a newly added negative test exposed a 0-amount signed paid-session credit grant. The regression was reproduced as RED before the fix. An additional checkout Price mismatch regression was also demonstrated as RED before remediation. The hardened local suite now passes **15/15** using `node --test test/*.test.mjs` on Node v22.16.0. These tests mock Stripe and use in-memory SQLite as the D1 substitute; they do not establish payment success with Stripe, D1 behavior, customer identity, deployment, or revenue. See `HARDENING_AUDIT_2026-10-29.md`.