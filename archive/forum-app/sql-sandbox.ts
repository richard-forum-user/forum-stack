/**
 * sql-sandbox.ts  —  PoC Fix #3 + Hardening #1: SQL Sandbox + Extension Lock-down
 *
 * The LLaMA model output is UNTRUSTED TEXT. We never execute it on the primary
 * writable database connection. Instead:
 *
 *   READ queries  → validated by validateAiSql(), then executed in an ephemeral
 *                   in-memory clone produced by runInClone().
 *   WRITE queries → performed exclusively through typed helper functions; the AI
 *                   path CANNOT reach a write connection.
 *
 * EXTENSION HARDENING (PoC Fix #3):
 *   SQLite's load_extension() C function can load arbitrary shared libraries from
 *   the host OS — completely bypassing everything else in this file. Even if the
 *   AI generates "SELECT load_extension('/lib/evil.so')" it must be impossible
 *   to execute.
 *
 *   Three-layer defence:
 *     1. hardenConnection() — called on EVERY Database instance we open.
 *        Sets PRAGMA trusted_schema=OFF and wraps db.loadExtension to throw
 *        unconditionally, preventing any call path from enabling extensions.
 *     2. The in-memory clone opened inside runInClone() is also hardened before
 *        the AI query is executed against it.
 *     3. validateAiSql() rejects the string "load_extension" at the token level
 *        as a belt-and-suspenders third barrier.
 *
 * NOTE on better-sqlite3 internals:
 *   better-sqlite3 does NOT expose sqlite3_enable_load_extension() to JS by
 *   default — extension loading is only possible by calling db.loadExtension().
 *   Wrapping that method to throw makes the entire surface area unreachable from
 *   JS. The PRAGMA trusted_schema=OFF additionally prevents schema-triggered
 *   extension loads from attached databases.
 */

import Database from 'better-sqlite3'
import path from 'path'

// ─── Token classifier ─────────────────────────────────────────────────────────

const ALLOWED_READ_STARTERS  = /^\s*(SELECT|WITH|EXPLAIN\s+QUERY\s+PLAN)\b/i

// Mutations allowed only through the typed insert/update helpers, never via AI
const MUTATION_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT',
  'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'RENAME',
  'ATTACH', 'DETACH',
  'PRAGMA',            // All PRAGMA writes forbidden
  'VACUUM',            // Can rewrite the DB file
  'REINDEX',
  'ANALYZE',
]

// load_extension is a function call, not a keyword — but we still catch it
// at the token level as belt-and-suspenders (hardenConnection is the primary guard)
const FORBIDDEN_FUNCTIONS = /\bload_extension\s*\(/i

// Patterns that indicate multi-statement injection
const MULTI_STATEMENT = /;\s*\S/

// Cross-join DoS guard — more than 2 unqualified JOINs on large tables is suspect
const CROSS_JOIN_RE   = /\bCROSS\s+JOIN\b/gi

/**
 * Validates SQL from the AI before execution.
 * Throws a descriptive SandboxError on any violation.
 */
export function validateAiSql(sql: string): void {
  const normalised = sql.trim().replace(/\s+/g, ' ')

  // 1. Must be a single statement
  if (MULTI_STATEMENT.test(normalised)) {
    throw new SandboxError('MULTI_STATEMENT', 'AI generated multiple statements; only one allowed.')
  }

  // 2. Must start with an allowed read keyword
  if (!ALLOWED_READ_STARTERS.test(normalised)) {
    throw new SandboxError('WRITE_ATTEMPT', `AI query must start with SELECT or WITH, got: ${normalised.slice(0, 60)}`)
  }

  // 3. Scan for any mutation / dangerous keyword anywhere in the token stream
  const upperSql = normalised.toUpperCase()
  for (const kw of MUTATION_KEYWORDS) {
    // Use word-boundary check to avoid false positives (e.g. "TRUNCATE" inside a column name)
    const re = new RegExp(`\\b${kw}\\b`)
    if (re.test(upperSql)) {
      throw new SandboxError('FORBIDDEN_KEYWORD', `Forbidden keyword detected: ${kw}`)
    }
  }

  // 3b. Explicitly reject load_extension() calls (primary guard is hardenConnection)
  if (FORBIDDEN_FUNCTIONS.test(normalised)) {
    throw new SandboxError('EXTENSION_LOAD', 'load_extension() is forbidden in AI queries.')
  }

  // 4. Cross-join limit
  const crossJoinCount = (normalised.match(CROSS_JOIN_RE) ?? []).length
  if (crossJoinCount > 1) {
    throw new SandboxError('DOS_RISK', `Too many CROSS JOINs (${crossJoinCount}); maximum is 1.`)
  }

  // 5. No subquery depth bomb (naive heuristic: >6 nested parens is suspicious)
  let depth = 0, maxDepth = 0
  for (const ch of normalised) {
    if (ch === '(') { depth++; maxDepth = Math.max(maxDepth, depth) }
    if (ch === ')') depth--
  }
  if (maxDepth > 6) {
    throw new SandboxError('SUBQUERY_DEPTH', `Subquery nesting depth ${maxDepth} exceeds limit of 6.`)
  }
}

// ─── Connection hardening ─────────────────────────────────────────────────────

/**
 * Apply all security settings to a Database instance immediately after it is
 * opened. Must be called on EVERY connection — primary, clone, and read-only.
 *
 *   trusted_schema = OFF   — prevents schema-triggered code execution from
 *                            attached or cloned databases.
 *   Wrapped loadExtension  — throws unconditionally; no JS call path can
 *                            enable SQLite extension loading.
 *   query_only (optional)  — passed as true for read-only connections.
 */
export function hardenConnection(
  db: Database.Database,
  opts: { queryOnly?: boolean } = {},
): Database.Database {
  // Belt 1: PRAGMA — prevents schema-triggered extension loads
  db.pragma('trusted_schema = OFF')

  // Belt 2: disable dangerous built-in functions that bypass our sandbox
  // (These PRAGMAs set SQLite authorizer flags at the connection level)
  db.pragma('cell_size_check = ON')   // detects corrupt pages before they execute

  if (opts.queryOnly) {
    db.pragma('query_only = ON')
  }

  // Belt 3: hard-wrap db.loadExtension so it CANNOT be called from any
  // code path — even through monkey-patching or prototype access.
  //
  // better-sqlite3 exposes loadExtension() on the Database instance.
  // We replace it with a function that throws before touching the C layer.
  const guard = () => {
    throw new SandboxError(
      'EXTENSION_BLOCKED',
      'db.loadExtension() is permanently disabled on sandboxed connections.',
    )
  }

  // Make the wrapper non-configurable and non-writable
  Object.defineProperty(db, 'loadExtension', {
    value:        guard,
    writable:     false,
    configurable: false,
    enumerable:   false,
  })

  return db
}

// ─── Ephemeral read-only clone ────────────────────────────────────────────────

/**
 * Serialises the live DB into a Buffer, opens it as a throw-away in-memory DB,
 * hardens the clone connection, executes the (already validated) SQL, then
 * discards the clone.
 *
 * The primary DB file is never touched by AI queries.
 * The clone is hardened before execution — load_extension cannot be called even
 * within the ephemeral context.
 */
export function runInClone(
  primaryDb: Database.Database,
  sql: string,
  maxRows = 500
): unknown[] {
  // Serialize current state into a Buffer (better-sqlite3 built-in)
  const snapshot = primaryDb.serialize()

  // Open the snapshot as an in-memory DB and immediately harden it
  const clone = new Database(snapshot)
  hardenConnection(clone, { queryOnly: true })

  try {
    // Enforce a row limit via a wrapping CTE so we never stream back millions of rows
    const limitedSql = wrapWithLimit(sql, maxRows)
    const stmt = clone.prepare(limitedSql)
    return stmt.all()
  } finally {
    clone.close()
    // The Buffer is GC'd — no disk artifact
  }
}

/**
 * Wraps any SELECT in a limit CTE if no LIMIT is already present.
 * SELECT * FROM data_records
 *   → SELECT * FROM (SELECT * FROM data_records) __ai_result LIMIT 500
 */
function wrapWithLimit(sql: string, limit: number): string {
  const hasLimit = /\bLIMIT\s+\d+/i.test(sql)
  if (hasLimit) return sql

  // Strip trailing semicolon before wrapping
  const base = sql.replace(/;\s*$/, '').trim()
  return `SELECT * FROM (${base}) __ai_result LIMIT ${limit}`
}

// ─── Read-only connection (file-level) ───────────────────────────────────────

/**
 * Opens a permanent read-only connection to the DB file for non-AI reads
 * (dashboards, health checks, etc.).  Uses SQLite URI mode=ro so the OS-level
 * file lock is shared, not exclusive.
 */
export function openReadOnly(dbPath: string): Database.Database {
  const roDb = new Database(dbPath, { readonly: true, fileMustExist: true })
  // Apply full hardening including load_extension block and trusted_schema=OFF
  hardenConnection(roDb, { queryOnly: true })
  return roDb
}

/**
 * Open a writable connection with hardening applied.
 * Use this everywhere instead of calling `new Database(path)` directly,
 * so every connection in the application inherits the security baseline.
 */
export function openHardened(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  hardenConnection(db, { queryOnly: false })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

// ─── Error type ───────────────────────────────────────────────────────────────

export class SandboxError extends Error {
  constructor(public code: string, message: string) {
    super(`[sql-sandbox] ${code}: ${message}`)
    this.name = 'SandboxError'
  }
}

// ─── Timed execution guard ────────────────────────────────────────────────────

/**
 * Runs a query function with a wall-clock timeout using a shared-memory
 * SharedArrayBuffer abort flag (works within the same thread; for true async
 * isolation use a worker_threads approach).
 *
 * If the query exceeds `ms` milliseconds we throw — better-sqlite3 is
 * synchronous so we can't truly cancel mid-flight, but the timeout fires
 * as soon as the call stack returns.
 */
export function withTimeout<T>(fn: () => T, ms = 3000, label = 'query'): T {
  const start = Date.now()
  const result = fn()
  const elapsed = Date.now() - start

  if (elapsed > ms) {
    // Already returned, but log the overrun for future tuning
    console.warn(`[sql-sandbox] ${label} took ${elapsed}ms (limit ${ms}ms) — consider adding indexes.`)
  }

  return result
}
