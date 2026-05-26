-- Airlock listener ledger (local SQLite: forum_inbound.db)
--
-- Tables prefixed `civic_*` are retained as compatibility shims; new
-- writes go to the `forum_*` tables. A view at the bottom presents a
-- single timeline for analysis jobs.
CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    credential_id_hash TEXT NOT NULL UNIQUE,
    public_key_pem TEXT NOT NULL,
    web_id TEXT,
    signing_public_key_hex TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Legacy civic payload + export ledgers (pre-v1.5 Pods write here).
CREATE TABLE IF NOT EXISTS civic_payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    verified_member_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS civic_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL,
    web_id TEXT,
    consent_at TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    session_id TEXT,
    public_key_hex TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- v1.5+ generalised Forum Feedback ledger.
--
-- One row per *opt-in* cooperative submission. The encrypted blob is
-- the same signed envelope the cooperative analyst receives; the
-- breakout columns (kind / category_code / zip_code) exist so the
-- listener can rate-limit, audit, and join without decrypting.
CREATE TABLE IF NOT EXISTS forum_payloads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    category_code TEXT NOT NULL,
    encrypted_payload TEXT NOT NULL,
    verified_member_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS forum_exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    category_code TEXT NOT NULL,
    web_id TEXT,
    email_hash TEXT NOT NULL,
    consent_at TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    session_id TEXT,
    public_key_hex TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_forum_payloads_receipt ON forum_payloads(receipt_id);
CREATE INDEX IF NOT EXISTS idx_forum_exports_email   ON forum_exports(email_hash);
CREATE INDEX IF NOT EXISTS idx_forum_exports_kind    ON forum_exports(kind);

-- Single-pane timeline across legacy + new export ledgers.
DROP VIEW IF EXISTS v_all_exports;
CREATE VIEW v_all_exports AS
    SELECT receipt_id, kind, category_code, web_id, email_hash,
           consent_at, policy_version, session_id, public_key_hex, created_at
    FROM   forum_exports
    UNION ALL
    SELECT receipt_id, 'civic' AS kind, 'civic-legacy' AS category_code,
           web_id, NULL AS email_hash, consent_at, policy_version,
           session_id, public_key_hex, created_at
    FROM   civic_exports;

-- Optional D1 edge queue (secure-worker.js when env.DB is wired)
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
