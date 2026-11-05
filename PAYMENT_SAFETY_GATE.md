# JussPay payment safety and migration contract

Status: **CODE ON MAIN, NOT ACTIVATED / DEPLOYMENT NOT VERIFIED / NO LIVE CHARGES** (checked at `e14909d`, 2026-11-05).

This document is a review and implementation gate, not evidence that JussPay processes payments.

## Current evidence (2026-11-05, `e14909d`)
- `npm run check` is clean and `npm test` passes 76/76 locally (Node 22.23.4).
- Checkout, portal, entitlement, webhook, and gated order and subscription routes are present in `src/`.
- Not verified: a Stripe sandbox run, a deployed Worker, a configured `AUTH` binding, or any live charge.
- Activation gates remain as listed in `README.md`: approved plans, `APPROVED_REFUND_POLICY=account_hold`, AUTH, Stripe secrets, sandbox config, the webhook endpoint, and the host route.

## Authority and separation
- Authoritative source: `jussray/JussPay`. Keep the parent `jussray/jussray` website independent.
- Keep existing Shopify storefronts and their checkout, merchant accounts, and product catalogs unchanged.
- Do not infer that a central reporting dashboard authorizes fund pooling, payout routing, or a shared merchant of record.
- Founder Control Room may receive minimized, redacted verification receipts, not payment secrets or raw customer information.
- Marketplace/Stripe Connect, subscriptions, and Cloudflare x402/Pay Per Crawl are future, separately gated integrations.

## Source recovery before implementation
- Recover the **original** `jussco-dual-monetization-starter.zip` from the other conversation.
- Verify its SHA-256 equals `1429d87671b31f13e1e57d50a92fe10bab875561c6196752203325a063ccfc91`.
- Verify `src/worker.mjs` SHA-256 equals `81996033938d752325a219a92fd9ded252aba5e1ecd9b208ea0f679e5457c68c`.
- Verify `test/worker.test.mjs` SHA-256 equals `2e51a38876b050f7c0cbf3fca61f9de85e94f5ba2ab8bd1475c9513a5f821f59`.
- The original 7/7 report came from another conversation. On 2026-11-05 this repo's own suite passed 76/76 at `e14909d`, but the source-recovery hashes above were **not** re-verified in that run.
- Do not fabricate a replacement Worker, test suite, credentials, or passing receipts if source recovery fails.

## Required payment invariants
1. Checkout creation must use a server-owned product/price catalog. Never trust client-supplied amount, currency, price, account, or merchant.
2. Verify Stripe webhook signatures using the exact raw request body and a secret stored outside the repository.
3. Fulfill only a paid, verified session, including asynchronous payment success. Never fulfill from the redirect/success page.
4. Reconcile Stripe session ID, account, customer, purchase ID, expected price/product, currency, and total paid before granting access. Mismatches must fail closed and generate a non-sensitive receipt.
5. Make webhook processing idempotent and transaction-safe; duplicate and reordered events must not grant duplicate entitlements.
6. Do not expose a usable API credential before verified payment. Implement authenticated credential recovery, rotation, and revocation.
7. Support refunds, disputes, payment failures, and cancellations with auditable entitlement policies before launch.
8. The paid endpoint must return a genuine authorized product, not placeholder content.
9. Isolate each merchant, customer, and product; enforce authorization and rate limits.
10. Default all checkout/fulfillment switches to OFF. No live Stripe API keys, live charges, DNS changes, migrations, or deployments without separate release approval.

## Verification matrix
- Static/syntax checks and focused unit tests: valid purchase, wrong amount, wrong currency, wrong product, wrong merchant, unsigned/invalid signature, unpaid session, async success/failure, duplicate and out-of-order events, recovery and revocation.
- Stripe isolated sandbox: actual Checkout Session, signed webhook delivery, payment status reconciliation, refund and dispute simulation, no live charges.
- Cloudflare preview: actual Worker + D1 migration, concurrent webhook replay and idempotency.
- Browser: checkout initiation, redirect, return without fulfillment, paid entitlement readback, failure and recovery paths.
- Release: exact-head CI, independent security review, merchant-account selection, secrets review, owner approval, production rollback plan.

## Evidence and rollback
Use `REALITY / FIX / PROOF / RISK / ROLLBACK / NEXT GATE`. Record exact repository SHA, test command and output, source hashes, provider mode, and whether runtime was actually observed. A green mocked test is not a paid transaction. Rollback this documentation-only branch by deleting it or reverting its commit; it has no runtime effects.
