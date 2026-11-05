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
