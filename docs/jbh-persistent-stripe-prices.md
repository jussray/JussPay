# JBH persistent Stripe prices: staged catalog migration

This migration does **not** activate payments, authorize a supplier, change any price, or create Stripe resources. The existing inline Checkout behavior is preserved unless `JBH_PERSISTENT_PRICES_ENABLED=true` is explicitly configured.

## 1. Recover the actual approved catalog

Use the owner-authenticated GET `/jbh/catalog-export` on the intended JussPay API environment after the reviewed release is deployed. Send the existing owner credential in the `x-jbh-owner-key` header through an authorized private client; do not put credentials into a URL, repository, chat, or log. This endpoint returns only the configured catalog fields, mode, and per-SKU supplier configuration checks. It cannot attest to a supplier's stock or order handoff. It performs no Stripe requests. The response is non-cacheable.

Save the response's `catalog` object as a local private JSON file. Do not commit the export. Compare its SKU count and variant mapping with the actual storefront configuration; a historical catalog is not a substitute.

## 2. Reconcile Stripe

Retrieve the complete price list for the exact JBH Stripe account and corresponding live or sandbox mode. Compare product identity, variant, currency and integer minor-unit amount against the catalog. Resolve mismatches with the catalog owner before making any changes. Do not infer a SKU solely from a matching price or product name.

The existing read-only tool can check the mapping:
```sh
node scripts/jbh-stripe-catalog.mjs live catalog.json prices.json reviewed.json
```

Use `sandbox` in the sandbox. Supply the complete Stripe price export and, where needed, the explicitly reviewed SKU-to-price/product binding file. A binding file is not an approval to sell a product.

## 3. Apply only reviewed SKU tags

Use existing matching Stripe Prices where possible. For each reviewed exact price, set its `lookup_key` and `metadata.jbh_sku` to the canonical SKU. Do not transfer a lookup key that belongs to another price, archive existing prices, or create a replacement for a mismatch without approval. If a new price is actually required, confirm the correct product, tax treatment, mode, and amount first. Re-read the complete list and run reconciliation again.

## 4. Stage checkout in sandbox

Configure `JBH_STRIPE_PRICE_MAP` as a private JSON object mapping **every** configured SKU to a unique Price ID and its Product ID:
```json
{
  "EXAMPLE-SKU": {
    "priceId": "price_example",
    "productId": "prod_example"
  }
}
```
The values above are synthetic examples, not provider IDs.

Set `JBH_PERSISTENT_PRICES_ENABLED=true` only in the intended sandbox after populating the complete mapping. JussPay checks the configured IDs, merchant account, live/test mode, active one-time per-unit price, currency, amount, lookup key and SKU metadata before requesting Checkout. A mismatch fails closed; no inline-price fallback occurs for a mapped order. The selected IDs also participate in the idempotency fingerprint. Existing in-flight requests cannot silently switch price modes.

Run the repository's `npm run check` and `npm test`, then verify sandbox checkout, signed payment webhooks, order reconciliation, retry handling and supplier receipt routing before a separately authorized production cutover. Do not switch existing production orders to different price IDs.

## 5. Verify suppliers independently

The export reports whether each SKU passes the existing supplier-authority configuration check, not whether the provider actually works. Require evidence of the exact supplier SKU mapping, current stock, order acceptance, dispatch, and tracking appropriate to that route. Shopify/Dropship Beauty is not the only intended route. Do not fabricate evidence, assign all SKUs to a single supplier, or bypass JussPay's existing live authority checks.

Keep the live switch and existing provider credentials unchanged until catalog, payment, supplier and release readiness are independently established.
