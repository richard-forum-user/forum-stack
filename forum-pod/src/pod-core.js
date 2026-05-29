/**
 * Pod core dispatch — async, transport-agnostic.
 *
 * Used by:
 *   - The Capacitor (Android / iOS) Pod adapter on-device. The SQLite
 *     plugin gives us an async `db` handle; pod-core implements the same
 *     verb/path contract the Cloudflare Durable Object exposes, so the UI
 *     does not care which backend is in use.
 *   - Future browser-only PWA fallback (sql.js / OPFS) if we ever ship one.
 *
 * The Cloudflare DO (`forum-airlock/pod-do.js`) keeps its own synchronous
 * implementation. The schema string here is the canonical source of truth
 * and is kept in lock-step with the DO migration.
 */

export const POD_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pod_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS civic_submissions (
    receipt_id TEXT PRIMARY KEY,
    zip_code TEXT,
    kind TEXT,
    category_code TEXT,
    category_id INTEGER,
    category_label TEXT,
    comment TEXT,
    egress_status TEXT DEFAULT 'pending',
    vault_status TEXT,
    sync_attempts INTEGER DEFAULT 0,
    last_error TEXT,
    submitted_at TEXT,
    share_status TEXT,
    consent_at TEXT,
    policy_version TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS journal_entries (
    submission_id TEXT PRIMARY KEY,
    submitted_at TEXT,
    raw_text TEXT,
    source_context TEXT,
    user_category_id TEXT,
    user_category_label TEXT,
    processing_status TEXT,
    lexicon_version TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS behaviors (
    behavior_id TEXT PRIMARY KEY,
    submission_id TEXT,
    category TEXT,
    action TEXT,
    entity TEXT,
    metadata_json TEXT,
    source TEXT,
    confidence REAL,
    reviewed INTEGER,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS traits (
    psycho_id TEXT PRIMARY KEY,
    submission_id TEXT,
    category TEXT,
    attribute TEXT,
    sentiment REAL,
    source TEXT,
    confidence REAL,
    reviewed INTEGER,
    created_at TEXT,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS email_proof (
    id INTEGER PRIMARY KEY,
    kind TEXT,
    email_hash TEXT,
    domain_hash TEXT,
    proof_receipt TEXT,
    claimed_email TEXT,
    claimed_domain TEXT,
    saved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS assistant_messages (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, message_id)
  );
  CREATE INDEX IF NOT EXISTS idx_assistant_msgs_conv_time
    ON assistant_messages(conversation_id, created_at);
  CREATE TABLE IF NOT EXISTS pod_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    sig TEXT NOT NULL,
    sync_status INTEGER NOT NULL DEFAULT 0,
    lamport_clock INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pod_events_sync ON pod_events(sync_status, id);
  CREATE INDEX IF NOT EXISTS idx_pod_events_type ON pod_events(event_type);
  CREATE TABLE IF NOT EXISTS pod_local_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    lamport_clock INTEGER NOT NULL
  );
`;

export async function initPodSchemaSqlite(db) {
  const statements = POD_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await db.exec(stmt + ";");
  }
}

async function getMeta(db, key) {
  const row = await db.get(`SELECT value FROM pod_meta WHERE key = ?`, [key]);
  return row ? row.value : null;
}

async function setMeta(db, key, value) {
  await db.run(
    `INSERT OR REPLACE INTO pod_meta (key, value) VALUES (?, ?)`,
    [key, value == null ? "" : String(value)]
  );
}

async function bumpClock(db) {
  const cur = Number((await getMeta(db, "lamport_clock")) || 0) + 1;
  await setMeta(db, "lamport_clock", String(cur));
  return cur;
}

const META_CREATED = "created_at";
const META_WEBID = "web_id";
const META_SESSION = "session_id";

/**
 * Async dispatch. Same verb/path/data contract as the Durable Object.
 * The caller has already authenticated the request (on-device adapters
 * trust the local OS user; the DO does signature verification).
 */
export async function runPodDispatch(db, { sessionId, verb, path, data }) {
  const now = new Date().toISOString();
  data = data || {};
  verb = String(verb || "").toUpperCase();
  path = String(path || "");

  if (!(await getMeta(db, META_CREATED))) {
    await setMeta(db, META_CREATED, now);
    if (sessionId) await setMeta(db, META_SESSION, sessionId);
  }

  if (verb === "PROVISION") {
    if (data.webId) await setMeta(db, META_WEBID, data.webId);
    return {
      status: 200,
      body: {
        ok: true,
        webId: data.webId || (await getMeta(db, META_WEBID)),
        podRoot: data.podRoot || null,
        createdAt: await getMeta(db, META_CREATED),
      },
    };
  }

  if (verb === "PUT" && path.startsWith("/civic/submissions/")) {
    const id = path.slice("/civic/submissions/".length);
    if (!id) return { status: 400, body: { error: "missing_id" } };
    await db.run(
      `INSERT OR REPLACE INTO civic_submissions
       (receipt_id, zip_code, kind, category_code, category_id, category_label,
        comment, egress_status, vault_status, sync_attempts, last_error,
        submitted_at, share_status, consent_at, policy_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.zip_code || null,
        data.kind || null,
        data.category_code || null,
        data.category_id != null ? Number(data.category_id) : null,
        data.category_label || "",
        String(data.comment || "").slice(0, 4000),
        data.egress_status || "pending",
        data.vault_status || null,
        Number(data.sync_attempts || 0),
        data.last_error || null,
        data.submitted_at || now,
        data.share_status || "private",
        data.consent_at || null,
        data.policy_version || null,
        now,
      ]
    );
    return { status: 200, body: { ok: true, id } };
  }

  if (verb === "LIST" && path === "/civic/submissions") {
    const rows = await db.all(
      `SELECT * FROM civic_submissions ORDER BY COALESCE(submitted_at, '') DESC`
    );
    return { status: 200, body: { rows } };
  }

  if (verb === "PUT" && path.startsWith("/journal/raw/")) {
    const id = path.slice("/journal/raw/".length);
    if (!id) return { status: 400, body: { error: "missing_id" } };
    await db.run(
      `INSERT OR REPLACE INTO journal_entries
       (submission_id, submitted_at, raw_text, source_context, user_category_id,
        user_category_label, processing_status, lexicon_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.submitted_at || now,
        data.raw_text || "",
        data.source_context || "journal",
        data.user_category_id || null,
        data.user_category_label || null,
        data.processing_status || "unprocessed",
        data.lexicon_version || null,
        now,
      ]
    );
    return { status: 200, body: { ok: true, id } };
  }

  if (verb === "LIST" && path === "/journal/raw") {
    const rows = await db.all(
      `SELECT * FROM journal_entries ORDER BY COALESCE(submitted_at, '') DESC`
    );
    return { status: 200, body: { rows } };
  }

  if (verb === "PUT" && path.startsWith("/journal/behaviors/")) {
    const id = path.slice("/journal/behaviors/".length);
    if (!id) return { status: 400, body: { error: "missing_id" } };
    await db.run(
      `INSERT OR REPLACE INTO behaviors
       (behavior_id, submission_id, category, action, entity, metadata_json,
        source, confidence, reviewed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.submission_id || null,
        data.category || "",
        data.action || null,
        data.entity || null,
        data.metadata_json || null,
        data.source || "rule:v1",
        Number(data.confidence ?? 0),
        data.reviewed ? 1 : 0,
        data.created_at || now,
        now,
      ]
    );
    return { status: 200, body: { ok: true, id } };
  }

  if (verb === "LIST" && path === "/journal/behaviors") {
    const rows = (
      await db.all(`SELECT * FROM behaviors ORDER BY COALESCE(created_at, '') DESC`)
    ).map((r) => ({ ...r, reviewed: !!r.reviewed }));
    return { status: 200, body: { rows } };
  }

  if (verb === "PUT" && path.startsWith("/journal/traits/")) {
    const id = path.slice("/journal/traits/".length);
    if (!id) return { status: 400, body: { error: "missing_id" } };
    await db.run(
      `INSERT OR REPLACE INTO traits
       (psycho_id, submission_id, category, attribute, sentiment, source,
        confidence, reviewed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.submission_id || null,
        data.category || "",
        data.attribute || "",
        data.sentiment != null ? Number(data.sentiment) : null,
        data.source || "rule:v1",
        Number(data.confidence ?? 0),
        data.reviewed ? 1 : 0,
        data.created_at || now,
        now,
      ]
    );
    return { status: 200, body: { ok: true, id } };
  }

  if (verb === "LIST" && path === "/journal/traits") {
    const rows = (
      await db.all(`SELECT * FROM traits ORDER BY COALESCE(created_at, '') DESC`)
    ).map((r) => ({ ...r, reviewed: !!r.reviewed }));
    return { status: 200, body: { rows } };
  }

  if (verb === "PUT" && path === "/identity/email-proof") {
    await db.run(`DELETE FROM email_proof`);
    await db.run(
      `INSERT INTO email_proof
       (id, kind, email_hash, domain_hash, proof_receipt, claimed_email, claimed_domain, saved_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.kind || "zk-email-dkim-v1",
        data.email_hash || "",
        data.domain_hash || null,
        data.proof_receipt || null,
        data.claimed_email || null,
        data.claimed_domain || null,
        data.saved_at || now,
      ]
    );
    return { status: 200, body: { ok: true } };
  }

  if (verb === "GET" && path === "/identity/email-proof") {
    const row = await db.get(`SELECT * FROM email_proof WHERE id = 1`);
    return { status: 200, body: row || null };
  }

  if (verb === "PUT" && path.startsWith("/assistant/conversations/")) {
    const rest = path.slice("/assistant/conversations/".length);
    const marker = "/messages/";
    const sep = rest.indexOf(marker);
    if (sep <= 0 || sep + marker.length >= rest.length) {
      return { status: 400, body: { error: "missing_message_id" } };
    }
    const convId = decodeURIComponent(rest.slice(0, sep));
    const msgId = decodeURIComponent(rest.slice(sep + marker.length));
    const role = data.role === "assistant" ? "assistant" : "user";
    await db.run(
      `INSERT OR REPLACE INTO assistant_messages
       (conversation_id, message_id, role, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [convId, msgId, role, String(data.content || ""), data.created_at || now, now]
    );
    return { status: 200, body: { ok: true, conversation_id: convId, message_id: msgId } };
  }

  if (verb === "LIST" && path.startsWith("/assistant/conversations/")) {
    const rest = path.slice("/assistant/conversations/".length);
    const suffix = "/messages";
    if (!rest.endsWith(suffix)) {
      return { status: 404, body: { error: "route_not_found", verb, path } };
    }
    const convId = decodeURIComponent(rest.slice(0, rest.length - suffix.length));
    const rows = await db.all(
      `SELECT conversation_id, message_id, role, content, created_at, updated_at
       FROM assistant_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, message_id ASC`,
      [convId]
    );
    return { status: 200, body: { rows } };
  }

  if (verb === "LIST" && path === "/assistant/conversations") {
    const rows = await db.all(
      `SELECT conversation_id,
              COUNT(*) AS message_count,
              MAX(updated_at) AS last_updated_at
       FROM assistant_messages
       GROUP BY conversation_id
       ORDER BY last_updated_at DESC`
    );
    return { status: 200, body: { rows } };
  }

  if (verb === "PUT" && path === "/events/append") {
    const eventType = String(data.event_type || "");
    const payloadStr =
      typeof data.payload === "string"
        ? data.payload
        : JSON.stringify(data.payload || {});
    const sig = String(data.sig || "");
    if (!eventType || !sig) {
      return { status: 400, body: { error: "missing_event_type_or_sig" } };
    }
    const clock = await bumpClock(db);
    await db.run(
      `INSERT INTO pod_events (event_type, payload, sig, sync_status, lamport_clock, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
      [eventType, payloadStr, sig, clock, now]
    );
    const row = await db.get(
      `SELECT id FROM pod_events ORDER BY id DESC LIMIT 1`
    );
    if (
      ["consent_to_sync", "civic_export", "membership_verified"].includes(eventType) &&
      data.projection_key
    ) {
      await db.run(
        `INSERT OR REPLACE INTO pod_local_state (key, value, updated_at, lamport_clock)
         VALUES (?, ?, ?, ?)`,
        [String(data.projection_key), payloadStr, now, clock]
      );
    }
    return { status: 200, body: { ok: true, id: row?.id, lamport_clock: clock } };
  }

  if (verb === "LIST" && path === "/events") {
    const statusFilter = data.status || "all";
    let q = `SELECT id, event_type, payload, sig, sync_status, lamport_clock, created_at
             FROM pod_events`;
    if (statusFilter === "pending") q += ` WHERE sync_status = 0`;
    else if (statusFilter === "synced") q += ` WHERE sync_status = 1`;
    q += ` ORDER BY id ASC LIMIT 200`;
    const rows = await db.all(q);
    return { status: 200, body: { rows } };
  }

  if (verb === "LIST" && path === "/local-state") {
    const rows = await db.all(`SELECT * FROM pod_local_state ORDER BY key`);
    return { status: 200, body: { rows } };
  }

  return { status: 404, body: { error: "route_not_found", verb, path } };
}
