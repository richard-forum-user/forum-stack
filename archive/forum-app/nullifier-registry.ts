/**
 * nullifier-registry.ts  —  PoC Fix #2: Civic Nullifier Scoping
 *
 * PROBLEM WITH THE PREVIOUS VERSION:
 *   The old schema used `nullifier TEXT PRIMARY KEY`, making the nullifier a
 *   global unique key. A citizen who verified for issue A was permanently locked
 *   out of issue B, C, and every future interaction — that is not Sybil resistance,
 *   that is exclusion.
 *
 * THE FIX:
 *   The primary key is now the COMPOSITE (nullifier_hash, issue_id).
 *
 *   One citizen  ←→  one verified participation per issue.
 *
 *   - School budget feedback today  → UNIQUE(nullifier, issue:school-budget-2026)
 *   - Road repair vote tomorrow     → UNIQUE(nullifier, issue:road-repair-q3)
 *   - Same citizen, different rows, zero cross-contamination.
 *
 * WHY nullifier_hash AND NOT nullifier?
 *   We never store the raw nullifier. We store SHA-256(nullifier) so that even
 *   if the registry DB is exfiltrated, it cannot be used to link identities
 *   across verificator services that share the same nullifier namespace.
 *
 * COOLING-OFF:
 *   The cooling-off check is now SCOPED to (nullifier_hash, issue_id) — it
 *   prevents a citizen from hammering the same issue repeatedly within a window,
 *   but does not block them from participating in a different issue immediately.
 *
 * WHERE TO RUN THIS:
 *   Your orchestrator/backend server — NOT in the user pod.
 */

import Database from 'better-sqlite3'
import crypto from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NullifierEntry {
  nullifierHash: string   // SHA-256(normalised_nullifier)  — never the raw value
  issueId:       string   // civic issue identifier, e.g. "school-budget-2026"
  sessionId:     string   // the ZK verification session that produced this row
  registeredAt:  number   // unix seconds
  revoked:       boolean
}

export interface RegistrationResult {
  allowed:    boolean
  reason?:    'already_registered' | 'cooloff_active'
  existing?:  NullifierEntry
}

// ─── Registry class ───────────────────────────────────────────────────────────

export class NullifierRegistry {
  private db: Database.Database

  /**
   * @param dbPath    Path to the registry SQLite file (server-side, not pod-side)
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this._initSchema()
  }

  // ── Schema ─────────────────────────────────────────────────────────────────

  private _initSchema(): void {
    this.db.exec(`
      -- Each row represents one citizen's verified participation in one civic issue.
      -- The same citizen CAN appear multiple times — once per distinct issue_id.
      CREATE TABLE IF NOT EXISTS nullifiers (
        nullifier_hash TEXT    NOT NULL,           -- SHA-256(normalised_nullifier)
        issue_id       TEXT    NOT NULL,           -- civic issue scope, e.g. "road-repair-q3"
        session_id     TEXT    NOT NULL,
        registered_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        ip_hash        TEXT,                       -- HMAC(client_ip) for forensics only
        revoked        INTEGER NOT NULL DEFAULT 0,

        -- THE KEY CHANGE: composite uniqueness, not global uniqueness
        PRIMARY KEY (nullifier_hash, issue_id)
      );

      -- Attempt log: scoped to (nullifier_hash, issue_id) for cooloff enforcement.
      CREATE TABLE IF NOT EXISTS nullifier_attempts (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        nullifier_hash TEXT    NOT NULL,
        issue_id       TEXT    NOT NULL,
        session_id     TEXT    NOT NULL,
        attempted_at   INTEGER NOT NULL DEFAULT (unixepoch()),
        outcome        TEXT    NOT NULL      -- 'accepted' | 'rejected_duplicate' | 'rejected_cooloff'
      );

      CREATE INDEX IF NOT EXISTS idx_null_issue    ON nullifiers(issue_id);
      CREATE INDEX IF NOT EXISTS idx_null_session  ON nullifiers(session_id);
      CREATE INDEX IF NOT EXISTS idx_att_pair      ON nullifier_attempts(nullifier_hash, issue_id);
    `)
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Attempt to register a citizen's participation in a specific civic issue.
   *
   * The same citizen may call this for different issueIds without restriction.
   * Duplicate (nullifier, issueId) combinations are rejected.
   *
   * @param nullifier    Raw nullifier from the ZK proof (normalised + hashed internally)
   * @param issueId      Civic issue identifier, e.g. "school-budget-2026". Must be
   *                     a stable, canonical string — derive it from your event registry.
   * @param sessionId    The current ZK verification session ID
   * @param clientIp     Optional client IP — stored only as HMAC
   * @param cooloffSec   Minimum seconds before the same (nullifier, issue) can re-attempt.
   *                     Defaults to 86400 (24 hours) — prevents ballot-stuffing on one issue
   *                     while allowing immediate participation in another.
   */
  register(
    nullifier:  string,
    issueId:    string,
    sessionId:  string,
    clientIp?:  string,
    cooloffSec  = 86400,
  ): RegistrationResult {
    if (!issueId || issueId.trim() === '') {
      throw new Error('[nullifier-registry] issueId must be a non-empty string.')
    }

    const nullifierHash = hashNullifier(nullifier)
    const canonicalIssue = issueId.trim().toLowerCase()
    const ipHash = clientIp ? hmacIp(clientIp) : null

    // ── 1. Exact duplicate check: (nullifier_hash, issue_id) ──────────────
    const existing = this.db.prepare(`
      SELECT nullifier_hash, issue_id, session_id, registered_at, revoked
      FROM nullifiers
      WHERE nullifier_hash = ? AND issue_id = ? AND revoked = 0
    `).get(nullifierHash, canonicalIssue) as {
      nullifier_hash: string; issue_id: string; session_id: string;
      registered_at: number; revoked: number;
    } | undefined

    if (existing) {
      this._logAttempt(nullifierHash, canonicalIssue, sessionId, 'rejected_duplicate')
      return {
        allowed:  false,
        reason:   'already_registered',
        existing: {
          nullifierHash: existing.nullifier_hash,
          issueId:       existing.issue_id,
          sessionId:     existing.session_id,
          registeredAt:  existing.registered_at,
          revoked:       Boolean(existing.revoked),
        },
      }
    }

    // ── 2. Cooling-off check: scoped to THIS (nullifier_hash, issue_id) pair
    //    A rejection here does NOT affect other issues for the same citizen.
    const recentAttempt = this.db.prepare(`
      SELECT attempted_at FROM nullifier_attempts
      WHERE nullifier_hash = ?
        AND issue_id       = ?
        AND attempted_at   > (unixepoch() - ?)
      ORDER BY attempted_at DESC
      LIMIT 1
    `).get(nullifierHash, canonicalIssue, cooloffSec) as { attempted_at: number } | undefined

    if (recentAttempt) {
      const waitSec = cooloffSec - (Math.floor(Date.now() / 1000) - recentAttempt.attempted_at)
      console.warn(
        `[nullifier-registry] Cooloff for (${nullifierHash.slice(0, 12)}…, ${canonicalIssue}) — ${waitSec}s remaining`
      )
      this._logAttempt(nullifierHash, canonicalIssue, sessionId, 'rejected_cooloff')
      return { allowed: false, reason: 'cooloff_active' }
    }

    // ── 3. Register ────────────────────────────────────────────────────────
    this.db.prepare(`
      INSERT INTO nullifiers (nullifier_hash, issue_id, session_id, ip_hash)
      VALUES (?, ?, ?, ?)
    `).run(nullifierHash, canonicalIssue, sessionId, ipHash)

    this._logAttempt(nullifierHash, canonicalIssue, sessionId, 'accepted')

    console.log(
      `[nullifier-registry] Registered ${nullifierHash.slice(0, 12)}… for issue "${canonicalIssue}" (session ${sessionId.slice(0, 8)}…)`
    )
    return { allowed: true }
  }

  /**
   * Check whether a citizen has already participated in a specific issue
   * without attempting to register. Safe for read-only status checks.
   */
  hasParticipated(nullifier: string, issueId: string): boolean {
    const hash = hashNullifier(nullifier)
    const row  = this.db.prepare(`
      SELECT 1 FROM nullifiers
      WHERE nullifier_hash = ? AND issue_id = ? AND revoked = 0
    `).get(hash, issueId.trim().toLowerCase())
    return row !== undefined
  }

  /**
   * List all issues a citizen has participated in.
   * Returns issue IDs only — the nullifier hash is not exposed.
   */
  participatedIssues(nullifier: string): string[] {
    const hash = hashNullifier(nullifier)
    const rows = this.db.prepare(`
      SELECT issue_id FROM nullifiers
      WHERE nullifier_hash = ? AND revoked = 0
      ORDER BY registered_at ASC
    `).all(hash) as Array<{ issue_id: string }>
    return rows.map(r => r.issue_id)
  }

  /**
   * Count unique verified citizens for a given issue.
   */
  countParticipants(issueId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as n FROM nullifiers
      WHERE issue_id = ? AND revoked = 0
    `).get(issueId.trim().toLowerCase()) as { n: number }
    return row.n
  }

  /**
   * Admin: revoke a specific (nullifier, issue) participation row.
   * Does NOT affect other issues for the same citizen.
   */
  revoke(nullifier: string, issueId: string): boolean {
    const info = this.db.prepare(`
      UPDATE nullifiers SET revoked = 1
      WHERE nullifier_hash = ? AND issue_id = ?
    `).run(hashNullifier(nullifier), issueId.trim().toLowerCase())
    return info.changes > 0
  }

  /**
   * Admin: revoke ALL participations for a citizen across every issue.
   * Use only for proven fraudulent passports.
   */
  revokeAll(nullifier: string): number {
    const info = this.db.prepare(`
      UPDATE nullifiers SET revoked = 1 WHERE nullifier_hash = ?
    `).run(hashNullifier(nullifier))
    return info.changes
  }

  close(): void { this.db.close() }

  // ── Private ────────────────────────────────────────────────────────────────

  private _logAttempt(
    nullifierHash: string,
    issueId:       string,
    sessionId:     string,
    outcome:       string,
  ): void {
    this.db.prepare(`
      INSERT INTO nullifier_attempts (nullifier_hash, issue_id, session_id, outcome)
      VALUES (?, ?, ?, ?)
    `).run(nullifierHash, issueId, sessionId, outcome)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise and hash the raw nullifier from the ZK proof.
 * We store the HASH, never the raw value, so that exfiltration of this DB
 * cannot be used to correlate identities across systems.
 */
function hashNullifier(raw: string): string {
  const trimmed = raw.trim()

  // Normalise to hex first (consistent representation regardless of encoding)
  let normalised: string
  if (/^0x[0-9a-fA-F]+$/i.test(trimmed)) {
    normalised = trimmed.toLowerCase()
  } else {
    try {
      normalised = '0x' + BigInt(trimmed).toString(16)
    } catch {
      normalised = trimmed   // non-numeric: use as-is for hashing
    }
  }

  return crypto.createHash('sha256').update(normalised).digest('hex')
}

const IP_HMAC_SECRET = process.env.IP_HMAC_SECRET ?? 'change-me-in-production'

function hmacIp(ip: string): string {
  return crypto.createHmac('sha256', IP_HMAC_SECRET).update(ip).digest('hex')
}

// ─── Integration helper for verify.ts ────────────────────────────────────────

/**
 * Extract the nullifier from a Rarimo ZK proof object.
 * Checks all known field locations across proof types.
 */
export function extractNullifier(proof: Record<string, unknown>): string | null {
  if (typeof proof.nullifier === 'string') return proof.nullifier

  if (Array.isArray(proof.pub_signals) && typeof proof.pub_signals[0] === 'string') {
    return proof.pub_signals[0]
  }

  if (proof.data && typeof (proof.data as Record<string, unknown>).nullifier === 'string') {
    return (proof.data as Record<string, unknown>).nullifier as string
  }

  return null
}
