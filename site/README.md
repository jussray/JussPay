# JussPay public site — isolated from payment backend

This directory contains the user-approved emerald-and-gold immersive HTML design. Its founder dashboard and all amounts are **sample preview data**. The public Worker does not access Stripe, initiate purchases, store user sessions, authenticate a customer, or proxy private APIs.

## Deployment contract

- Public frontend Worker: `jusspay-public`, `site/wrangler.jsonc`, `site/public/index.html`.
- Payment backend Worker: `jusspay`, independently deployed from root `wrangler.jsonc`.
- Cloudflare hostname route `jusspay.jussco.company/*` points to `jusspay-public`.
- More-specific routes for `/version*`, `/health*`, `/catalog*`, `/checkout*`, `/portal*`, `/entitlements*`, `/webhook*`, `/subscriptions/*`, `/orders/*`, `/jbh/*`, and `/truthweaver/*` point to `jusspay` and retain Cloudflare Access controls.
- Unknown URLs fail closed with 404, and the public Worker rejects non-GET/HEAD methods.

To deploy the public frontend separately: `npx wrangler deploy --config site/wrangler.jsonc`. **Do not** run a root backend deploy in place of the public frontend or change existing payment/secrets settings. Confirm the Cloudflare route table after deployment. The frontend has no live JussPay auth/checkout integration; a future authenticated product dashboard must use a reviewed identity and tenant isolation contract. No public payment controls should be represented as operational until an end-to-end paid-order receipt is verified.

Run the isolated public Worker tests with `node --test site/test/worker.test.mjs`.
