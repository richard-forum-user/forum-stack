/**
 * PersonalPodDO — one Durable Object per device credential. Holds the
 * user's private Pod data (civic submissions, journal entries, behaviors,
 * traits, email proof) in SQLite. The Worker authenticates each request
 * against the Ed25519 device key registered on first use (TOFU).
 *
 * Wire model: every request is a signed bundle (see pod-signing-web.js).
 * The payload is `{ verb, path, data }`. The DO dispatches on verb+path
 * and returns JSON.
 */

import { verifySignedBundle } from "./pod-signing-web.js";
import { clampForumFeedbackComment } from "./feedback-limits.js";

const META_KEY_PUBKEY = "registered_public_key";
const META_KEY_SESSION = "session_id";
const META_KEY_CREATED = "created_at";
const META_KEY_WEBID = "web_id";

// Replay window enforced by verifySignedBundle. Matches the value passed
// to that function (5 min) plus a small grace so the cleanup query never
// races a still-valid request.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REPLAY_CLEANUP_GRACE_MS = 60 * 1000;

export class PersonalPodDO {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this._ready = state.blockConcurrencyWhile(() => this.initSchema());
  }

  initSchema() {
    this.sql.exec(`
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

      -- Civic AI Kami assistant conversations. The Pod is the source of
      -- truth; the device-side IndexedDB cache (forum-civic-ai-assistant)
      -- is rehydrated from these rows on sign-in and wiped on sign-out.
      -- Conversation prompt text never leaves the device-and-DO boundary;
      -- the Worker forwards each user message to Ollama but never logs
      -- the content.
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

      -- Replay-protection cache keyed on the signature hex. The DO
      -- accepts a signed bundle at most once within the timestamp
      -- window; older entries are pruned on every write.
      CREATE TABLE IF NOT EXISTS replay_cache (
        signature TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seen_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_replay_seen_at
        ON replay_cache(seen_at_ms);
    `);
  }

  /**
   * Returns true when this signature has been seen within the replay
   * window, false otherwise. Uses `INSERT OR IGNORE` so the PRIMARY KEY
   * constraint is the source of truth — concurrent requests cannot both
   * insert the same signature. Also opportunistically prunes entries
   * older than the window on every call.
   */
  checkAndRecordReplay(signature, sessionId) {
    if (!signature) return false;
    const nowMs = Date.now();
    const cutoff = nowMs - (REPLAY_WINDOW_MS + REPLAY_CLEANUP_GRACE_MS);
    this.sql.exec(`DELETE FROM replay_cache WHERE seen_at_ms < ?`, cutoff);
    const cursor = this.sql.exec(
      `INSERT OR IGNORE INTO replay_cache (signature, session_id, seen_at_ms)
       VALUES (?, ?, ?)`,
      signature,
      sessionId || "",
      nowMs
    );
    // rowsWritten === 1: inserted (fresh signature, not a replay)
    // rowsWritten === 0: PRIMARY KEY conflict (signature already seen)
    const written = typeof cursor?.rowsWritten === "number" ? cursor.rowsWritten : 1;
    return written === 0;
  }

  getMeta(key) {
    const rows = this.sql
      .exec(`SELECT value FROM pod_meta WHERE key = ?`, key)
      .toArray();
    return rows.length > 0 ? rows[0].value : null;
  }

  setMeta(key, value) {
    this.sql.exec(
      `INSERT OR REPLACE INTO pod_meta (key, value) VALUES (?, ?)`,
      key,
      value == null ? "" : String(value)
    );
  }

  async fetch(request) {
    await this._ready;
    if (request.method !== "POST") {
      return jsonResp(405, { error: "use_post" });
    }

    let bundle;
    try {
      bundle = await request.json();
    } catch {
      return jsonResp(400, { error: "invalid_json" });
    }

    const registeredKey = this.getMeta(META_KEY_PUBKEY);
    const verdict = await verifySignedBundle(bundle, registeredKey || null);
    if (!verdict.valid) {
      return jsonResp(401, { error: "auth_failed", reason: verdict.reason });
    }

    const { payload, sessionId, publicKeyHex } = verdict;

    // Replay defense. The timestamp window is necessary but not
    // sufficient: an attacker who captures a single valid bundle can
    // replay it inside the 5-min window. Reject the second use.
    if (this.checkAndRecordReplay(bundle.signature, sessionId)) {
      return jsonResp(401, { error: "auth_failed", reason: "replay_detected" });
    }

    if (!registeredKey) {
      this.setMeta(META_KEY_PUBKEY, publicKeyHex);
      this.setMeta(META_KEY_SESSION, sessionId);
      this.setMeta(META_KEY_CREATED, new Date().toISOString());
    }

    if (!payload || typeof payload !== "object") {
      return jsonResp(400, { error: "invalid_payload" });
    }
    const verb = String(payload.verb || "").toUpperCase();
    const path = String(payload.path || "");
    const data = payload.data || {};
    if (!verb || !path) {
      return jsonResp(400, { error: "missing_verb_or_path" });
    }

    try {
      const result = this.dispatch(verb, path, data);
      return jsonResp(result.status || 200, result.body ?? {});
    } catch (e) {
      return jsonResp(500, {
        error: "handler_failed",
        reason: e?.message || String(e),
      });
    }
  }

  dispatch(verb, path, data) {
    const now = new Date().toISOString();

    if (verb === "PROVISION") {
      if (data.webId) this.setMeta(META_KEY_WEBID, data.webId);
      return {
        status: 200,
        body: {
          ok: true,
          webId: data.webId || this.getMeta(META_KEY_WEBID) || null,
          podRoot: data.podRoot || null,
          createdAt: this.getMeta(META_KEY_CREATED),
        },
      };
    }

    // civic_submissions
    if (verb === "PUT" && path.startsWith("/civic/submissions/")) {
      const id = path.slice("/civic/submissions/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO civic_submissions
         (receipt_id, zip_code, kind, category_code, category_id, category_label,
          comment, egress_status, vault_status, sync_attempts, last_error,
          submitted_at, share_status, consent_at, policy_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.zip_code || null,
        data.kind || null,
        data.category_code || null,
        data.category_id != null ? Number(data.category_id) : null,
        data.category_label || "",
        clampForumFeedbackComment(data.comment || ""),
        data.egress_status || "pending",
        data.vault_status || null,
        Number(data.sync_attempts || 0),
        data.last_error || null,
        data.submitted_at || now,
        data.share_status || "private",
        data.consent_at || null,
        data.policy_version || null,
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/civic/submissions") {
      const rows = this.sql
        .exec(
          `SELECT * FROM civic_submissions ORDER BY COALESCE(submitted_at, '') DESC`
        )
        .toArray();
      return { status: 200, body: { rows } };
    }

    // journal_entries
    if (verb === "PUT" && path.startsWith("/journal/raw/")) {
      const id = path.slice("/journal/raw/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO journal_entries
         (submission_id, submitted_at, raw_text, source_context, user_category_id,
          user_category_label, processing_status, lexicon_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.submitted_at || now,
        data.raw_text || "",
        data.source_context || "journal",
        data.user_category_id || null,
        data.user_category_label || null,
        data.processing_status || "unprocessed",
        data.lexicon_version || null,
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/journal/raw") {
      const rows = this.sql
        .exec(
          `SELECT * FROM journal_entries ORDER BY COALESCE(submitted_at, '') DESC`
        )
        .toArray();
      return { status: 200, body: { rows } };
    }

    // behaviors
    if (verb === "PUT" && path.startsWith("/journal/behaviors/")) {
      const id = path.slice("/journal/behaviors/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO behaviors
         (behavior_id, submission_id, category, action, entity, metadata_json,
          source, confidence, reviewed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/journal/behaviors") {
      const rows = this.sql
        .exec(
          `SELECT * FROM behaviors ORDER BY COALESCE(created_at, '') DESC`
        )
        .toArray()
        .map((r) => ({ ...r, reviewed: !!r.reviewed }));
      return { status: 200, body: { rows } };
    }

    // traits
    if (verb === "PUT" && path.startsWith("/journal/traits/")) {
      const id = path.slice("/journal/traits/".length);
      if (!id) return { status: 400, body: { error: "missing_id" } };
      this.sql.exec(
        `INSERT OR REPLACE INTO traits
         (psycho_id, submission_id, category, attribute, sentiment, source,
          confidence, reviewed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        data.submission_id || null,
        data.category || "",
        data.attribute || "",
        data.sentiment != null ? Number(data.sentiment) : null,
        data.source || "rule:v1",
        Number(data.confidence ?? 0),
        data.reviewed ? 1 : 0,
        data.created_at || now,
        now
      );
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/journal/traits") {
      const rows = this.sql
        .exec(`SELECT * FROM traits ORDER BY COALESCE(created_at, '') DESC`)
        .toArray()
        .map((r) => ({ ...r, reviewed: !!r.reviewed }));
      return { status: 200, body: { rows } };
    }

    // email_proof (single-row table)
    if (verb === "PUT" && path === "/identity/email-proof") {
      this.sql.exec(`DELETE FROM email_proof`);
      this.sql.exec(
        `INSERT INTO email_proof
         (id, kind, email_hash, domain_hash, proof_receipt, claimed_email, claimed_domain, saved_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        data.kind || "zk-email-dkim-v1",
        data.email_hash || "",
        data.domain_hash || null,
        data.proof_receipt || null,
        data.claimed_email || null,
        data.claimed_domain || null,
        data.saved_at || now
      );
      return { status: 200, body: { ok: true } };
    }

    if (verb === "GET" && path === "/identity/email-proof") {
      const rows = this.sql
        .exec(`SELECT * FROM email_proof WHERE id = 1`)
        .toArray();
      return { status: 200, body: rows[0] || null };
    }

    // assistant_messages — Civic AI Kami chat history. Pod is the source
    // of truth; the device IDB is a cache rehydrated from these rows.
    if (verb === "PUT" && path.startsWith("/assistant/conversations/")) {
      const rest = path.slice("/assistant/conversations/".length);
      const marker = "/messages/";
      const sep = rest.indexOf(marker);
      if (sep <= 0 || sep + marker.length >= rest.length) {
        return { status: 400, body: { error: "missing_message_id" } };
      }
      const convId = decodeURIComponent(rest.slice(0, sep));
      const msgId = decodeURIComponent(rest.slice(sep + marker.length));
      if (!convId || !msgId) {
        return { status: 400, body: { error: "missing_conv_or_msg_id" } };
      }
      const role = data.role === "assistant" ? "assistant" : "user";
      this.sql.exec(
        `INSERT OR REPLACE INTO assistant_messages
         (conversation_id, message_id, role, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        convId,
        msgId,
        role,
        String(data.content || ""),
        data.created_at || now,
        now
      );
      return { status: 200, body: { ok: true, conversation_id: convId, message_id: msgId } };
    }

    if (verb === "LIST" && path.startsWith("/assistant/conversations/")) {
      const rest = path.slice("/assistant/conversations/".length);
      // Expect ".../messages" suffix.
      const suffix = "/messages";
      if (!rest.endsWith(suffix)) {
        return { status: 404, body: { error: "route_not_found", verb, path } };
      }
      const convId = decodeURIComponent(rest.slice(0, rest.length - suffix.length));
      if (!convId) return { status: 400, body: { error: "missing_conv_id" } };
      const rows = this.sql
        .exec(
          `SELECT conversation_id, message_id, role, content, created_at, updated_at
           FROM assistant_messages
           WHERE conversation_id = ?
           ORDER BY created_at ASC, message_id ASC`,
          convId
        )
        .toArray();
      return { status: 200, body: { rows } };
    }

    if (verb === "LIST" && path === "/assistant/conversations") {
      const rows = this.sql
        .exec(
          `SELECT conversation_id,
                  COUNT(*) AS message_count,
                  MAX(updated_at) AS last_updated_at
           FROM assistant_messages
           GROUP BY conversation_id
           ORDER BY last_updated_at DESC`
        )
        .toArray();
      return { status: 200, body: { rows } };
    }

    if (verb === "DELETE" && path.startsWith("/assistant/conversations/")) {
      const convId = decodeURIComponent(
        path.slice("/assistant/conversations/".length)
      );
      if (!convId) return { status: 400, body: { error: "missing_conv_id" } };
      const cursor = this.sql.exec(
        `DELETE FROM assistant_messages WHERE conversation_id = ?`,
        convId
      );
      return {
        status: 200,
        body: { ok: true, deleted: cursor?.rowsWritten ?? 0 },
      };
    }

    if (verb === "DELETE" && path === "/assistant/conversations") {
      const cursor = this.sql.exec(`DELETE FROM assistant_messages`);
      return {
        status: 200,
        body: { ok: true, deleted: cursor?.rowsWritten ?? 0 },
      };
    }

    return { status: 404, body: { error: "route_not_found", verb, path } };
  }
}

function jsonResp(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
