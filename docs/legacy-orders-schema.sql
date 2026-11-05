-- SUPERSEDED REFERENCE — PR #1's D1 orders schema, preserved by the 2026-11-05 design
-- merge for provenance only. It is NOT applied anywhere: order state now lives in the
-- per-subject BillingAccount Durable Object (see docs/DESIGN-MERGE.md, storage decision).
-- The invariants expressed here (row shape, status enums, one live membership per
-- customer+plan) are enforced by src/subscriptions.mjs over Durable Object storage.
-- Pre-authorized orders are created by a separate authenticated merchant service.
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL,
 merchant_id TEXT NOT NULL,
 customer_id TEXT NOT NULL,
 currency TEXT NOT NULL,
 amount_total INTEGER NOT NULL CHECK(amount_total > 0),
 session_id TEXT UNIQUE,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','refunded','disputed','cancelled')),
 plan TEXT,
 price_id TEXT,
 subscription_id TEXT UNIQUE,
 stripe_customer_id TEXT,
 subscription_state TEXT NOT NULL DEFAULT 'pending' CHECK(subscription_state IN ('pending','active','past_due','canceled'))
);
CREATE INDEX IF NOT EXISTS idx_orders_merchant ON orders(merchant_id,status);

CREATE INDEX IF NOT EXISTS idx_orders_subscription ON orders(subscription_id);
-- One active or pending membership per account and model; one-time orders have plan NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_active_member ON orders(customer_id,plan) WHERE plan IN ('one','two') AND status IN ('pending','paid') AND subscription_state IN ('pending','active','past_due');
