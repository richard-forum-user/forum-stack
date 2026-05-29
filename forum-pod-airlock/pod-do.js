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
import {
  META_JWKS,
  META_JWT_RAW,
  META_JWT_CLAIMS,
  verifyJwtEs256,
  fetchJwks,
} from "./membership-verify.js";
import { requireUserConsent, syncWithCloud, appendInternalEvent } from "./pod-sync.js";

const META_KEY_PUBKEY = "registered_public_key";
const META_LAMPORT = "lamport_clock";
const META_KEY_SESSION = "session_id";
const META_KEY_CREATED = "created_at";
const META_KEY_WEBID = "web_id";
const META_KEY_LAST_TOUCH = "last_touch";
const META_KEY_GRADUATED = "graduated_to_local";

// Replay window enforced by verifySignedBundle. Matches the value passed
// to that function (5 min) plus a small grace so the cleanup query never
// races a still-valid request.
const REPLAY_WINDOW_MS = 5 * 60 * 1000;
const REPLAY_CLEANUP_GRACE_MS = 60 * 1000;

// Trial-pod retention. Banner appears after this many days; the DO
// alarm wipes the entire Pod after the grace expires unless the user
// signalled graduation by hitting /membership/graduated.
const TRIAL_BANNER_AFTER_DAYS = 7;
const TRIAL_GRACE_DAYS = 30;
const TRIAL_ALARM_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class PersonalPodDO {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
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
    `);
  }

  bumpClock() {
    const cur = Number(this.getMeta(META_LAMPORT) || 0) + 1;
    this.setMeta(META_LAMPORT, String(cur));
    return cur;
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
      if (this.env.IS_TRIAL_POD === "1") {
        try {
          await this.state.storage.setAlarm(Date.now() + TRIAL_ALARM_INTERVAL_MS);
        } catch (e) {
          /* alarms unavailable in some runtimes; degrade gracefully */
        }
      }
    }
    this.setMeta(META_KEY_LAST_TOUCH, new Date().toISOString());

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
      const result = await this.dispatch(verb, path, data);
      return jsonResp(result.status || 200, result.body ?? {}, this.trialHeaders());
    } catch (e) {
      return jsonResp(500, {
        error: "handler_failed",
        reason: e?.message || String(e),
      }, this.trialHeaders());
    }
  }

  trialHeaders() {
    if (this.env.IS_TRIAL_POD !== "1") return {};
    const createdAt = this.getMeta(META_KEY_CREATED);
    if (!createdAt) return {};
    if (this.getMeta(META_KEY_GRADUATED) === "1") {
      return { "X-Pod-Trial-Status": "graduated" };
    }
    const ageDays = Math.floor(
      (Date.now() - Date.parse(createdAt)) / (24 * 60 * 60 * 1000)
    );
    const remaining = Math.max(0, TRIAL_GRACE_DAYS - ageDays);
    const banner = ageDays >= TRIAL_BANNER_AFTER_DAYS ? "1" : "0";
    return {
      "X-Pod-Trial-Status": `age=${ageDays};banner=${banner};wipe_in_days=${remaining}`,
    };
  }

  async alarm() {
    await this._ready;
    if (this.env.IS_TRIAL_POD !== "1") return;
    if (this.getMeta(META_KEY_GRADUATED) === "1") return;

    const createdAt = this.getMeta(META_KEY_CREATED);
    if (!createdAt) return;
    const ageMs = Date.now() - Date.parse(createdAt);
    const graceMs = TRIAL_GRACE_DAYS * 24 * 60 * 60 * 1000;
    if (ageMs >= graceMs) {
      const tables = [
        "civic_submissions",
        "journal_entries",
        "behaviors",
        "traits",
        "email_proof",
        "assistant_messages",
        "pod_events",
        "pod_local_state",
        "replay_cache",
        "pod_meta",
      ];
      for (const t of tables) {
        this.sql.exec(`DELETE FROM ${t}`);
      }
      return;
    }
    try {
      await this.state.storage.setAlarm(Date.now() + TRIAL_ALARM_INTERVAL_MS);
    } catch {
      /* ignore */
    }
  }

  async dispatch(verb, path, data) {
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

    // pod_events — append-only audit log (device-signed payloads)
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
      const clock = this.bumpClock();
      const inserted = this.sql
        .exec(
          `INSERT INTO pod_events (event_type, payload, sig, sync_status, lamport_clock, created_at)
           VALUES (?, ?, ?, 0, ?, ?) RETURNING id`,
          eventType,
          payloadStr,
          sig,
          clock,
          now
        )
        .one();
      const id = inserted?.id;
      if (
        ["consent_to_sync", "civic_export", "membership_verified"].includes(eventType) &&
        data.projection_key
      ) {
        this.sql.exec(
          `INSERT OR REPLACE INTO pod_local_state (key, value, updated_at, lamport_clock)
           VALUES (?, ?, ?, ?)`,
          String(data.projection_key),
          payloadStr,
          now,
          clock
        );
      }
      return { status: 200, body: { ok: true, id, lamport_clock: clock } };
    }

    if (verb === "LIST" && path.startsWith("/events")) {
      const statusFilter = data.status || "all";
      let q = `SELECT id, event_type, payload, sig, sync_status, lamport_clock, created_at
                 FROM pod_events`;
      if (statusFilter === "pending") q += ` WHERE sync_status = 0`;
      else if (statusFilter === "synced") q += ` WHERE sync_status = 1`;
      q += ` ORDER BY id ASC LIMIT 200`;
      const rows = this.sql.exec(q).toArray();
      return { status: 200, body: { rows } };
    }

    if (verb === "PUT" && path.startsWith("/events/") && path.endsWith("/ack")) {
      const idPart = path.slice("/events/".length, -"/ack".length);
      const id = Number(idPart);
      if (!id) return { status: 400, body: { error: "invalid_id" } };
      this.sql.exec(`UPDATE pod_events SET sync_status = 1 WHERE id = ?`, id);
      return { status: 200, body: { ok: true, id } };
    }

    if (verb === "LIST" && path === "/local-state") {
      const rows = this.sql.exec(`SELECT * FROM pod_local_state ORDER BY key`).toArray();
      return { status: 200, body: { rows } };
    }

    if (verb === "GET" && path.startsWith("/local-state/")) {
      const key = decodeURIComponent(path.slice("/local-state/".length));
      const rows = this.sql
        .exec(`SELECT * FROM pod_local_state WHERE key = ?`, key)
        .toArray();
      return { status: 200, body: rows[0] || null };
    }

    if (verb === "PUT" && path === "/membership/jwt") {
      const jwt = String(data.jwt || "");
      if (!jwt) return { status: 400, body: { error: "missing_jwt" } };
      let jwks;
      const pinned = this.getMeta(META_JWKS);
      if (pinned) {
        try {
          jwks = JSON.parse(pinned);
        } catch {
          jwks = null;
        }
      }
      if (!jwks && data.coop_url) {
        jwks = await fetchJwks(data.coop_url);
        this.setMeta(META_JWKS, JSON.stringify(jwks));
      }
      if (!jwks) {
        return { status: 400, body: { error: "jwks_not_pinned" } };
      }
      const expectedIss =
        data.expected_iss ||
        (data.coop_url ? `${String(data.coop_url).replace(/\/$/, "")}` : null);
      const verdict = await verifyJwtEs256(jwt, jwks, expectedIss);
      if (!verdict.ok) {
        return { status: 401, body: { error: "jwt_invalid", reason: verdict.reason } };
      }
      this.setMeta(META_JWT_RAW, jwt);
      this.setMeta(META_JWT_CLAIMS, JSON.stringify(verdict.payload));
      if (data.coop_url) {
        this.setMeta("coop_url", String(data.coop_url).replace(/\/$/, ""));
      }
      return {
        status: 200,
        body: {
          ok: true,
          member_hash: verdict.payload.member_hash,
          class: verdict.payload.class,
          expires_at: verdict.payload.expires_at,
        },
      };
    }

    if (verb === "POST" && path === "/sync/cloud") {
      const result = await syncWithCloud({
        sql: this.sql,
        getMeta: (k) => this.getMeta(k),
        env: this.env || {},
        bumpClock: () => this.bumpClock(),
      });
      return { status: result.ok ? 200 : 403, body: result };
    }

    // Trial-pod graduation marker. The Pod UI calls this after the user
    // has successfully booted a local install and verified the
    // graduation export. From here the trial pod stops emitting the
    // banner header and skips the 30-day wipe.
    if (verb === "POST" && path === "/membership/graduated") {
      this.setMeta(META_KEY_GRADUATED, "1");
      return {
        status: 200,
        body: { ok: true, graduated_at: new Date().toISOString() },
      };
    }

    if (verb === "GET" && path === "/membership/trial-status") {
      const createdAt = this.getMeta(META_KEY_CREATED);
      if (!createdAt) {
        return { status: 200, body: { kind: "not-trial" } };
      }
      const ageDays = Math.floor(
        (Date.now() - Date.parse(createdAt)) / (24 * 60 * 60 * 1000)
      );
      return {
        status: 200,
        body: {
          kind: this.env.IS_TRIAL_POD === "1" ? "trial" : "self-hosted",
          created_at: createdAt,
          age_days: ageDays,
          banner_after_days: TRIAL_BANNER_AFTER_DAYS,
          grace_days: TRIAL_GRACE_DAYS,
          wipe_in_days: Math.max(0, TRIAL_GRACE_DAYS - ageDays),
          graduated: this.getMeta(META_KEY_GRADUATED) === "1",
        },
      };
    }

    return { status: 404, body: { error: "route_not_found", verb, path } };
  }
}

function jsonResp(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
