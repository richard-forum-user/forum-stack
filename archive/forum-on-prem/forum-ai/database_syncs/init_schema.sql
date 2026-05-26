-- ============================================================
-- Forum Cooperative ledger
-- ============================================================
--
-- The cooperative receives one and only one kind of opt-in row from each
-- Pod: a *Forum Feedback* row. The Pod is the source of truth; the
-- cooperative only sees what the user explicitly chose to share, gated
-- by a verified zk-email proof.
--
-- `forum_inbound` (below) is retained as the legacy table — pre-v1.5
-- civic submissions land there. New rows from v1.5+ Pods land in
-- `forum_feedback`. Analysis jobs should UNION them via the view at
-- the bottom of this file.

CREATE TABLE IF NOT EXISTS forum_inbound (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hashed_email TEXT,
    message TEXT NOT NULL,
    zip_code TEXT,
    receipt_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE forum_inbound ADD COLUMN web_id TEXT;
ALTER TABLE forum_inbound ADD COLUMN consent_at TEXT;
ALTER TABLE forum_inbound ADD COLUMN policy_version TEXT;
ALTER TABLE forum_inbound ADD COLUMN consent_opt_in INTEGER DEFAULT 0;
ALTER TABLE forum_inbound ADD COLUMN wiped_at TEXT;

-- v1.5+ unified Forum Feedback table.
--
-- `kind` is one of:
--   'behavioral'    - what the member did (purchase, media, civic, social, health)
--   'psychographic' - what the member values / believes
--   'civic'         - legacy 4-tier civic submissions kept for one migration window
--
-- `category_code` is the granular slug. For v1.5 Pods it matches the
-- INSIGHT_CATEGORIES `category` field exactly: purchasing | media |
-- civic | social | health | value | interest | lifestyle | attitude.
--
-- email_hash is REQUIRED. The cooperative refuses to accept any feedback
-- row that does not present a verified zkEmail proof's email_hash.
CREATE TABLE IF NOT EXISTS forum_feedback (
    receipt_id      TEXT PRIMARY KEY,
    kind            TEXT NOT NULL CHECK (kind IN ('behavioral','psychographic','civic')),
    category_code   TEXT NOT NULL,
    category_label  TEXT NOT NULL,
    zip_code        TEXT,
    comment         TEXT NOT NULL,
    email_hash      TEXT NOT NULL,
    domain_hash     TEXT,
    web_id          TEXT,
    session_id      TEXT,
    public_key_hex  TEXT,
    signature_hex   TEXT,
    consent_at      TEXT NOT NULL,
    policy_version  TEXT NOT NULL,
    encrypted_blob  TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    wiped_at        TEXT,
    FOREIGN KEY (email_hash) REFERENCES members_email_proof(email_hash)
);

CREATE INDEX IF NOT EXISTS idx_forum_feedback_kind
    ON forum_feedback(kind);
CREATE INDEX IF NOT EXISTS idx_forum_feedback_category
    ON forum_feedback(category_code);
CREATE INDEX IF NOT EXISTS idx_forum_feedback_zip
    ON forum_feedback(zip_code);
CREATE INDEX IF NOT EXISTS idx_forum_feedback_email_hash
    ON forum_feedback(email_hash);
CREATE INDEX IF NOT EXISTS idx_forum_feedback_created
    ON forum_feedback(created_at);

-- Unified analysis view across legacy + new rows.
DROP VIEW IF EXISTS v_forum_feedback_all;
CREATE VIEW v_forum_feedback_all AS
    SELECT
        receipt_id,
        kind,
        category_code,
        category_label,
        zip_code,
        comment,
        email_hash,
        web_id,
        consent_at,
        policy_version,
        created_at,
        wiped_at
    FROM forum_feedback
    UNION ALL
    SELECT
        receipt_id,
        'civic'                 AS kind,
        'civic-legacy'          AS category_code,
        'Civic (legacy)'        AS category_label,
        zip_code,
        message                 AS comment,
        hashed_email            AS email_hash,
        web_id,
        consent_at,
        policy_version,
        created_at,
        wiped_at
    FROM forum_inbound
    WHERE consent_opt_in = 1;

CREATE TABLE IF NOT EXISTS report_participants (
    report_id TEXT NOT NULL,
    receipt_id TEXT NOT NULL,
    web_id TEXT,
    hashed_participant TEXT,
    PRIMARY KEY (report_id, receipt_id)
);

CREATE TABLE IF NOT EXISTS report_lifecycle (
    report_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'review',
    review_ends_at TEXT NOT NULL,
    published_at TEXT,
    opt_in_count INTEGER DEFAULT 0,
    policy_version TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Email proof ledger: stores only hashed emails from zkEmail proofs.
-- Forum server never sees the raw email; the proof is verified, the
-- public signals (email_hash, domain_hash) are recorded, and the proof
-- artifact is kept for audit.
CREATE TABLE IF NOT EXISTS members_email_proof (
    email_hash TEXT PRIMARY KEY,
    domain_hash TEXT,
    proof_kind TEXT NOT NULL DEFAULT 'zk-email-dkim-v1',
    proof_receipt TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME,
    revoked_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_members_email_proof_domain
    ON members_email_proof(domain_hash);
