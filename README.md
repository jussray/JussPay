# JussPay

Standalone Juss & Co payment coordination service. **Sandbox prototype only. Not deployed.**

## Safety
Payments are OFF unless `PAYMENTS_ENABLED=true`. No credentials are committed. Do not enable this Worker in production. Existing Shopify checkout remains separate. Read [PAYMENT_SAFETY_GATE.md](PAYMENT_SAFETY_GATE.md).

## Local verification
`npm test && npm run check` (Node 22+).

## Prototype configuration
- `STRIPE_SECRET_KEY`: sandbox-only, stored as Worker secret, never source.
- `STRIPE_WEBHOOK_SECRET`: sandbox-only signing secret.
- `APP_ORIGIN`: approved HTTPS application origin.
- `CATALOG`: private JSON map from product ID to `{name,amount,currency,merchant_id}`.
- `ORDERS`: Cloudflare D1 binding with `schema.sql`.
- `PAYMENTS_ENABLED`: omitted or `false` by default.

**Precondition:** An independent authenticated service must create an order in D1 after authorizing the customer, merchant and product. This repo does not implement that service. `/checkout` only accepts previously authorized pending order IDs; never trust client prices.

## Known incomplete release gates
- No authentication/authorization service for creating orders.
- No Stripe account binding per merchant, Connect, subscriptions, tax registration, or fulfillment delivery.
- Webhook records paid state only; no API credits or credential issuance. No refund/dispute event handling yet.
- No live Stripe sandbox checkout, webhook, D1 concurrency, or browser E2E proof.
- Original starter ZIP still missing; this is new isolated prototype code, **not** a migration or recreation of that starter.
- No deployment configuration or live-payment enablement is included.
