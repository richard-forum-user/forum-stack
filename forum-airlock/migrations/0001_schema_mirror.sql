-- Apply once on forum-db (additive; safe on live DBs).
ALTER TABLE forum_feedback ADD COLUMN category_id INTEGER;
ALTER TABLE forum_feedback ADD COLUMN egress_status TEXT DEFAULT 'pending';
ALTER TABLE forum_feedback ADD COLUMN vault_status TEXT;
ALTER TABLE forum_feedback ADD COLUMN sync_attempts INTEGER DEFAULT 0;
ALTER TABLE forum_feedback ADD COLUMN last_error TEXT;
ALTER TABLE forum_feedback ADD COLUMN submitted_at TEXT;
ALTER TABLE forum_feedback ADD COLUMN share_status TEXT;
ALTER TABLE forum_feedback ADD COLUMN updated_at TEXT;
ALTER TABLE forum_feedback ADD COLUMN contest_window_ends_at TEXT;

CREATE TABLE IF NOT EXISTS forum_contest_claims (
  claim_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  claim_text TEXT NOT NULL,
  claim_signature TEXT NOT NULL,
  filed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_notes TEXT
);

CREATE TABLE IF NOT EXISTS coop_memberships (
  jti TEXT PRIMARY KEY,
  member_hash TEXT NOT NULL,
  class TEXT NOT NULL,
  stripe_session TEXT,
  issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_coop_memberships_member ON coop_memberships(member_hash);
