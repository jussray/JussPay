# JussPay Design Merge — 2026-11-05

Authorship: JussPay and all three of its variants were originated by **Raylene (Juss & Co)**.
This merge was executed on her explicit ruling of 2026-11-05 ("Design-merge: combine all
three deliberately"), under her standing merge authority.

## Why this document exists

On 2026-11-05 three divergent, independently green implementations of JussPay existed:

- **Variant A — the spine** (landed directly on `main` @ `4de91986`): a root Cloudflare
  Worker (`src/worker.mjs`) for portfolio-product subscriptions (PromptOS, Chief AI,
  Think Tank, SolContinuity, Founder Control Room). Subject authentication via a private
  `AUTH` service binding; per-subject `BillingAccount` Durable Object; Stripe state always
  re-fetched from the provider; refund/dispute triggers an account-wide hold. 25 local tests.
- **Variant B — the contract prototype** (PR #1, `chore/payment-safety-contract-20261029`
  @ `44dd1776`): a standalone sandbox Worker with a D1 `orders` ledger: one-time
  pre-authorized order checkout with provider-readback reconciliation, plus a test-only
  recurring membership lifecycle for Protect Me Model One / Model Two (test plans,
  deep session/order/subscription cross-validation, renewal re-verification). 36 local tests.
- **Variant C — the isolated module** (PR #2, `fix/stripe-price-entitlement-20261029`
  @ `f3c77334`): `monetization/`, a self-contained prepaid API-credits starter (validate the
  Stripe price and the paid line item before granting credits), with its own dedicated D1
  database. 15 local tests.

Ray ruled that none of the three wins by default: they are combined deliberately into one
canonical core, with `main`'s Worker as the single entrypoint.

## The storage decision (one source of truth)

**Decision: the per-subject `BillingAccount` Durable Object is the single source of truth
for subscription and entitlement state. PR #1's D1 `orders` table is not carried forward
as a runtime store.**

Evidence from the code:

1. Variant A's README and config make the DO the deliberate store: there is no D1 binding
   or migration in `wrangler.jsonc`; its activation contract says "There is no D1 migration
   to apply. Preserve Durable Object data on rollback. Never rename `BillingAccount`."
   A's entitlement reads (`GET /entitlements`) are computed from DO subscription rows that
   are re-validated against Stripe on every event.
2. Identity is the same in both variants: an authenticated subject from the same
   `https://auth.internal/verify` service-binding contract (A's `AUTH`, B's `AUTH_SERVICE`).
   B's orders are keyed by that subject (`customer_id`), so B's per-subject facts map
   one-to-one into the subject's own Durable Object.
3. The only cross-subject access B's D1 provided was webhook lookup by `subscription_id`.
   In the combined core that lookup is unnecessary: webhooks route to the owning subject's
   DO via the Stripe customer's `jusspay_subject` metadata (A's mechanism — B's subscription
   checkout now passes the subject's JussPay-managed customer when one exists) with a
   verified session-metadata fallback for checkouts created before a customer existed.
4. B's schema comment shows its D1 assumed "a separate authenticated merchant service"
   writing orders by SQL. That service does not exist; in the combined core, order creation
   is an authenticated route of this Worker, so no shared SQL ledger is needed.
5. B's unique invariant — one live membership per customer and plan (a partial unique
   index) — is enforced in the DO by construction: the object's serialized fetch queue
   makes check-and-insert atomic per subject, which is strictly stronger than the index.
6. What B itself declared durable was its *contract*, not its storage: it is a sandbox
   prototype whose entitlement read returns `service_activation: "not_verified"` — billing
   state only. Its validators and lifecycle state machine are the harvest; its D1 was
   scaffolding.

Preserved for reference: `docs/legacy-orders-schema.sql` (B's D1 schema, superseded; not
applied anywhere). Variant C's D1 is **not** a competing store for this fact domain: it
holds anonymous prepaid API-credit tokens (no subject, no subscription), and C's own
schema mandates a dedicated database that must not be mixed with other application data.
It remains isolated under `monetization/`, unchanged.

## What was kept from each variant

**From A (the spine) — unchanged behavior:** the single Worker entrypoint; `/health`,
`/catalog`, `/checkout`, `/portal`, `/entitlements`, `/webhook`; `BillingAccount` with its
serialized queue, event dedup, checkout-attempt idempotency and offer fingerprints,
refund/dispute account hold; the Supabase auth adapter (`src/auth-supabase.mjs`,
`wrangler.auth.jsonc`); `catalog-receipt.json`; the `APPROVED_PLANS` catalog contract.

**From B — harvested into the spine:**
- `src/subscriptions.mjs`: `TEST_PLANS` (Protect Me Model One $4.99/mo and Model Two
  $19.00/mo sandbox fixtures with their real test product/price IDs), the pure validators
  `priceMatches`, `subscriptionMatches`, `validatePurchase`, and `isSubscriptionEvent` —
  carried over verbatim.
- The order lifecycle over DO storage (`order:<purchase_id>` records mirroring the D1 row
  shape, plus an insertion-order index): create/reuse test-plan orders, subscription
  checkout, status and billing-entitlement reads, and the webhook lifecycle —
  completion reconciled against provider readback (session + line items + subscription
  deep-match), `invoice.payment_failed` → `past_due`, `invoice.paid` reactivates only
  after provider re-verification, `customer.subscription.deleted` → `canceled`, and
  out-of-order events can never reactivate.
- The one-time pre-authorized order checkout (`validatePurchase` contract, catalog-priced,
  sandbox keys only, provider-readback reconciliation before an order is marked paid;
  a persistence failure is never acknowledged).
- `PAYMENT_SAFETY_GATE.md`, carried over unchanged.
- The test scenarios (see the mapping below).

**From C — merged unchanged:** the entire `monetization/` module, its suite, its docs and
its deployment gate. It merges cleanly because it was designed isolated; the root
`npm test` now runs its suite alongside the core suites.

## What was dropped, and why

- **B's standalone Worker entrypoint and its `/stripe/webhook` path** — one entrypoint and
  one webhook endpoint (`/webhook`) in the combined core; B's events are dispatched inside
  the `BillingAccount` event handler after A's signature/mode/account/customer pipeline.
- **B's D1 `orders` store and `ORDERS` binding** — superseded by the storage decision above.
- **B's `AUTH_SERVICE` / `CHECKOUT_AUTH_READY` / `WEBHOOK_RECONCILIATION_READY` flags** —
  the combined core has exactly one identity path (the `AUTH` binding, with audience and
  expiry checks) and reconciliation is always on; feature flags that simulate missing
  infrastructure are meaningless once the infrastructure is the spine itself.
- **B's `/checkout` path for one-time orders** — moved to `POST /orders/checkout`, because
  `/checkout` is the spine's catalog-subscription checkout. B's route shape, gates and
  error contract are otherwise preserved.
- **B's schema as a runtime artifact** — preserved as documentation only (above).

Union choices: `PAYMENTS_ENABLED` remains the master gate for the harvested order family
(fail-closed when unset, as in B). Refund/dispute events for order subscriptions also hit
A's account-wide hold — B had no refund/dispute handling at all, so the union takes the
stricter spine behavior.

## Test mapping (PR #1 → combined)

All 36 PR #1 scenarios survive: 12 in `test/subscriptions.test.mjs`, 24 in
`test/orders.test.mjs`, adapted as follows — scenarios and assertions are B's; plumbing is
the combined core's:

- The D1 fake (real SQLite + `schema.sql`) is replaced by the in-memory Durable Object
  double in `test/harness.mjs`; direct SQL assertions read the stored order record instead.
- The D1 unique-index test becomes a behavioral proof of the same invariant under the DO's
  serialized queue: two concurrent create requests yield exactly one order.
- Webhook fixtures for invoice/subscription events carry the `customer` id the core webhook
  pipeline requires; webhooks are delivered to `/webhook`.
- "Missing auth service" / "reconciliation not ready" scenarios map to the combined
  contracts: a rejecting `AUTH` binding fails closed (401, no order mutation), and an order
  is never marked paid when provider readback disagrees (409, order stays pending).
- Dummy fixture strings in tests (bearer tokens, signing secrets) are intentional local
  fixtures, consistent between signer and verifier.

Combined local proof at merge time: **76/76 tests pass** (A 25 + B 36 + C 15) via
`npm test`, plus `npm run check` clean. GitHub-hosted CI for this private repository is
billing-blocked and has never executed; per the founder's implant doctrine this local
exact-tree proof is the merge standard, and nothing here is claimed as "CI green".

## Resulting canonical API surface

Core (subject-authenticated, Durable Object state):
`GET /health` · `GET /catalog` · `POST /checkout` · `POST /portal` · `GET /entitlements` ·
`POST /webhook`

Order family (additionally gated by `PAYMENTS_ENABLED=true`; state in the same Durable
Object): `POST /orders/checkout` · `POST /subscriptions/orders` ·
`POST /subscriptions/checkout` · `GET /subscriptions/status` ·
`GET /subscriptions/entitlement` (the `/subscriptions/*` four additionally require
`SUBSCRIPTIONS_TEST_ENABLED=true` and a sandbox Stripe key; test-mode only).

Isolated module (separate entrypoint, own D1, own gate): `monetization/` — prepaid
API-credit checkout/fulfillment per `monetization/README.md`.
