-- Assurance tiers: paid pod keys + per-submission tier.
-- The worker also creates these on first use; this file makes it explicit.
--   npx wrangler d1 execute forum-db --remote --file migrations/0003_assurance_tiers.sql
-- If assurance_tier already exists, the ALTER fails harmlessly; run the
-- CREATE statements on their own.
CREATE TABLE IF NOT EXISTS coop_paid_keys (
  key_hash TEXT PRIMARY KEY,
  checkout_session TEXT UNIQUE,
  payment_intent TEXT,
  card_fingerprint_hash TEXT,
  billing_zip TEXT,
  postal_check TEXT,
  over_card_limit INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_paid_keys_card ON coop_paid_keys(card_fingerprint_hash);
CREATE INDEX IF NOT EXISTS idx_paid_keys_pi ON coop_paid_keys(payment_intent);
ALTER TABLE forum_feedback ADD COLUMN assurance_tier TEXT NOT NULL DEFAULT 'unverified';
