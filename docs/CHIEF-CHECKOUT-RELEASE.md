# JussPay: Chief Personal implementation and release

**Not activated.** Do not change the offer's sales flags until provider eligibility and sandbox acceptance are evidenced. Do not modify Chief Business or the separate hands-on pilot. Do not change JBH, Shopify, or a different merchant's catalog.

## What this change does

- Uses the canonical JussPay Worker and its authenticated server-owned catalog. The Chief Personal offer is $1.00 on the first invoice and $29.00/month thereafter, both inclusive of applicable tax. Checkout requires explicit renewal/terms consent and a product-scoped Stripe coupon.
- Sets automatic tax and requires the billing address on the Chief intro session. Signed webhook and provider readback, rather than a browser redirect, establish paid status. Verified initial and renewal invoices are recorded once per invoice in the buyer's billing object. This is not payout settlement or a general ledger.
- Keeps Stripe key modes separate before any provider access. The Juss & Co. and Beauty Co. accounts remain distinct.
- Supplies the reusable server SDK, same-origin app bridge, immersive design adapter and isolated Chief sandbox configs. The current design's labeled sample dashboard remains a preview; it is not promoted to an owner console or financial source of truth.

## Project integration

1. Use `createJussPayClient({origin})` from `sdk/index.mjs` on the server only. The origin must be deployment-owned and exactly match the approved billing Worker origin. Resolve the visitor's short-lived JussPay-compatible access token from the app's verified server-side session. Do not use the customer's submitted ID, an API key in frontend code, or local-storage paid status.
2. Mount `billingBridge({client,appOrigin,getAccessToken,products:['chief'],billingMode:'test'})` under `/api/billing/*` on the signed-in app origin. The bridge checks same-origin requests on writes, enforces the app product allowlist, checks fresh catalog terms, and verifies the hosted Stripe link and expected mode. Implement `getAccessToken(request)` with the app's actual session provider. It must not simply forward a caller-supplied header. Use separate sandbox and production deployment settings.
3. Generate the design without overwriting the original: `node scripts/assemble-immersive.mjs path/to/approved-original.html output-dir`. Serve the resulting files on the same origin as the bridge. Without a third argument the entrance is labeled Preview Dashboard, not Sign In. In a real deployment, pass the existing same-origin sign-in path as the third argument and verify it reaches the app's real identity provider; both Sign In controls then go there instead of opening demo data. The Pricing interaction is disabled unless the catalog offers the exact product and amount. The project still owns its real sign-in route and private account page; provider credentials and asset publication are not part of this build.
4. On return to `/account?checkout=processing`, the app requests `GET /api/billing/entitlements` and displays processing until Stripe payment is reconciled. Protect paid APIs server-side using `hasEntitlement` with Chief's real capability key; never grant based on a returned Checkout URL. Chief must supply its actual entitlement key and approve its real terms URL before catalog setup.
5. Other Juss & Co. apps can use the same SDK against their own explicitly approved catalog entries. The included browser bridge enables intro offers only; recurring, one-time, and marketplace products should get their own reviewed flow rather than being silently routed through Chief.

## Reproducible sandbox and production gates

1. Dry-run both isolated configs using Wrangler 4.50.0: `wrangler deploy --dry-run -c wrangler.auth-sandbox.jsonc` and `wrangler deploy --dry-run -c wrangler.chief-sandbox.jsonc`. These are separate from the existing Beauty Co. sandbox. Keep all flags off on first deployment; provider secrets go only in deployment secret storage.
2. On the selected **Juss & Co. test** account confirm charges and tax eligibility. Configure the private AUTH sandbox, real sandbox product/price/coupon, app origin, approved refund policy, and verified scope in `TEST_STRIPE_CONFIG`. Set actual Stripe credentials and version privately. Keep live flags off. Do not substitute the Beauty Co. account or an unapproved sandbox.
3. Complete a recorded test payment in hosted Checkout with automatic tax complete. Confirm $1 first invoice, $29 renewal using an approved test method, matching authenticated subject, webhook delivery, durable receipt, and entitlement enforcement in Chief itself. Test cancel, refund, revoke, retry, duplicate and reordered webhooks. Test other project entitlements cannot be obtained. Preserve exact SHA, sanitized receipt, and test-vs-live mode.
4. Before enabling the live plan: verify Juss & Co. live account, establish tax head office and applicable registration(s) in Stripe, then verify an active inclusive catalog price, product tax code, and one-time scoped coupon. Configure the real application identity and exact Cloudflare routes. Run `node scripts/smoke-release.mjs https://HOST RELEASE_SHA --expect-closed`; this proves only the exact Worker, not payment. A plaintext “Hello world” fails the check. Confirm independent review, exact-head CI, authorization and rollback before enabling the dedicated Chief live-intro flag. Do not generate a generic $29 Payment Link as a stand-in.
5. Roll back by stopping new checkout, retaining provider webhook processing and the original plan for existing subscribers. Do not delete Durable Object state, webhooks, paid records or customer mappings. An approved deployment must specify whether a real live test purchase is permitted; none was made here.

## JussMarket stays separate

Marketplace seller onboarding, fee division, tax responsibility, seller receivables, refunds, disputes, and settlement must be validated in Stripe Connect test mode with approved operating terms. The Chief direct-merchant checkout cannot onboard a seller, pool funds, or initiate payouts. Do not claim JussMarket or any cross-project lane is live based on this implementation.

References: [Stripe Tax setup](https://docs.stripe.com/tax/set-up) and [Stripe Connect charge types](https://docs.stripe.com/connect/charges).
