-- Dedicated D1 DB for monetization ONLY. Do not mix with other application databases.
CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  checkout_session_id TEXT UNIQUE,
  payment_intent TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','revoked')),
  remaining INTEGER NOT NULL DEFAULT 0 CHECK(remaining >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS access_tokens_payment_intent_idx ON access_tokens(payment_intent);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
  created_at INTEGER NOT NULL
);

-- Protect against refund/dispute event arriving before payment completion event.
CREATE TABLE IF NOT EXISTS payment_intent_revocations (
  payment_intent TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);