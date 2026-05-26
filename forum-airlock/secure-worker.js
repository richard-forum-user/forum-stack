/**
 * Forum secure Worker — Pod assets, PersonalPodDO RPC, edge D1 ingest.
 *
 * Security hardening (v1.8):
 *   - No decorative /register/* or dev cookie gate
 *   - CSP + security headers on static assets
 *   - sessionId must be pubkey:sha256(publicKeyHex)
 *   - WebAuthn challenges + unlock tokens on writes (when UNLOCK_TOKEN_KEY set)
 *   - zkEmail not proxied at the edge
 */

export { PersonalPodDO } from './pod-do.js';

import { verifySignedBundle } from './pod-signing-web.js';
import { expectedSessionIdFromPubkey, sessionIdMatchesPubkey } from './session-binding.js';
import { issueUnlockToken, isPilotCredentialId, verifyUnlockToken } from './unlock-token.js';
import { handleAiChat } from './ai-chat.js';
import { handleWebAuthnRoute } from './webauthn-server.js';
import { handleCivicAnalysisRoute, runCivicAnalysis } from './civic-analysis.js';
import { clampForumFeedbackComment } from './feedback-limits.js';

const FORUM_FEEDBACK_PATH = '/api/forum/feedback';
const FORUM_RECEIPT_PATH = '/api/forum/receipt';
const AI_CHAT_PATH = '/api/ai/chat';
const POD_API_PREFIX = '/api/pod';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' blob: https://cdn.jsdelivr.net 'wasm-unsafe-eval'; script-src-elem 'self' https://cdn.jsdelivr.net; worker-src 'self' blob:; child-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: blob:; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extraHeaders },
  });
}

async function assertSessionBinding(bundle) {
  if (!bundle?.publicKeyHex || !bundle?.sessionId) {
    return { ok: false, reason: 'missing_session_or_pubkey' };
  }
  const matches = await sessionIdMatchesPubkey(bundle.sessionId, bundle.publicKeyHex);
  if (!matches) {
    return { ok: false, reason: 'session_id_binding_mismatch' };
  }
  return { ok: true };
}

async function assertUnlocked(env, bundle) {
  if (!env.UNLOCK_TOKEN_KEY) {
    return { ok: true, skipped: true };
  }
  const deviceCredentialId = bundle.deviceCredentialId || null;
  if (isPilotCredentialId(deviceCredentialId)) {
    if (env.ALLOW_PILOT_BUNDLES === '1') {
      return { ok: true, pilot: true };
    }
    return { ok: false, reason: 'pilot_bundles_disabled' };
  }
  if (!deviceCredentialId) {
    return { ok: false, reason: 'missing_device_credential_id' };
  }
  const verdict = await verifyUnlockToken(env, bundle.unlockToken);
  if (!verdict.ok) {
    return verdict;
  }
  if (deviceCredentialId && deviceCredentialId !== verdict.credentialId) {
    return { ok: false, reason: 'credential_mismatch' };
  }
  return { ok: true };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const listenerBase = (env.LISTENER_URL || env.AIRLOCK_URL || '').replace(/\/$/, '');

    if (url.pathname === '/' && request.method === 'GET') {
      return Response.redirect(`${url.origin}/pod`, 302);
    }

    if (url.pathname.startsWith('/api/webauthn/')) {
      const webauthnRes = await handleWebAuthnRoute(request, env, url, issueUnlockToken);
      if (webauthnRes) return webauthnRes;
    }

    if (
      (url.pathname === FORUM_RECEIPT_PATH || url.pathname === '/api/civic/submit') &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const upstream = await fetch(`${listenerBase}/submit`, {
        method: 'POST',
        headers: {
          'X-Airlock-Secret': env.AIRLOCK_SECRET,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receiptId: body.receiptId,
          encryptedData: body.encryptedData,
          memberId: body.memberId ?? null,
        }),
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    if (
      (url.pathname === FORUM_FEEDBACK_PATH || url.pathname === '/api/civic/export') &&
      request.method === 'POST'
    ) {
      const responseHeaders = {
        'Content-Type': 'application/json',
        ...CORS,
      };
      if (url.pathname === '/api/civic/export') {
        responseHeaders['Deprecation'] = 'true';
        responseHeaders['Link'] = `<${FORUM_FEEDBACK_PATH}>; rel="successor-version"`;
      }
      const result = await handleForumFeedbackAtEdge(request, env);
      if (
        result.status === 200 &&
        env.FORUM_AUTO_EDGE_ANALYSIS === '1' &&
        ctx?.waitUntil
      ) {
        ctx.waitUntil(
          runCivicAnalysis(env, { trigger: 'feedback' }).catch((err) => {
            console.error('civic edge analysis failed:', err?.message || err);
          })
        );
      }
      return jsonResponse(result.body, result.status, responseHeaders);
    }

    if (url.pathname.startsWith('/api/civic/analysis')) {
      return handleCivicAnalysisRoute(request, env, url);
    }

    if (url.pathname === AI_CHAT_PATH) {
      return handleAiChat(request, env);
    }

    if (url.pathname.startsWith(POD_API_PREFIX + '/') || url.pathname === POD_API_PREFIX) {
      if (request.method !== 'POST') {
        return jsonResponse({ error: 'use_post' }, 405);
      }
      if (!env.POD) {
        return jsonResponse({ error: 'pod_do_not_bound' }, 500);
      }
      let bodyText;
      try {
        bodyText = await request.text();
      } catch {
        return jsonResponse({ error: 'unreadable_body' }, 400);
      }
      let bundle;
      try {
        bundle = JSON.parse(bodyText);
      } catch {
        return jsonResponse({ error: 'invalid_json' }, 400);
      }
      const binding = await assertSessionBinding(bundle);
      if (!binding.ok) {
        return jsonResponse({ error: 'auth_failed', reason: binding.reason }, 401);
      }
      const unlock = await assertUnlocked(env, bundle);
      if (!unlock.ok) {
        return jsonResponse(
          { error: 'auth_failed', reason: unlock.reason || 'unlock_required' },
          401
        );
      }
      const sessionId = bundle.sessionId;
      const id = env.POD.idFromName(sessionId);
      const stub = env.POD.get(id);
      const upstream = await stub.fetch(
        new Request('https://pod-do/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bodyText,
        })
      );
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    if (url.pathname === '/api/register-member' && request.method === 'POST') {
      const body = await request.text();
      const upstream = await fetch(`${listenerBase}/api/register-member`, {
        method: 'POST',
        headers: {
          'X-Airlock-Secret': env.AIRLOCK_SECRET,
          'Content-Type': 'application/json',
        },
        body,
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    if (url.pathname === '/api/register-signing-key' && request.method === 'POST') {
      const body = await request.text();
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        return jsonResponse({ error: 'invalid_json' }, 400);
      }
      const sid = data.session_id || data.web_id;
      if (!data.public_key_hex || !sid) {
        return jsonResponse(
          { error: 'session_id or web_id and public_key_hex required' },
          400
        );
      }
      const expectedSid = await expectedSessionIdFromPubkey(data.public_key_hex);
      if (expectedSid && sid !== expectedSid && data.session_id !== expectedSid) {
        return jsonResponse({ error: 'session_id must match pubkey binding' }, 400);
      }
      const registerSid = expectedSid || sid;
      if (env.DB) {
        await ensureForumD1Schema(env.DB);
        await registerEdgeSigningKey(
          env.DB,
          registerSid,
          data.web_id || null,
          data.public_key_hex
        );
      }
      try {
        await fetch(`${listenerBase}/api/register-signing-key`, {
          method: 'POST',
          headers: {
            'X-Airlock-Secret': env.AIRLOCK_SECRET,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...data, session_id: registerSid }),
        });
      } catch {
        /* listener mirror best-effort */
      }
      return jsonResponse({ success: true, storage: 'd1:forum-db' });
    }

    if (url.pathname.startsWith('/pod') || url.pathname.startsWith('/assets/')) {
      try {
        const assetUrl = new URL(request.url);
        if (assetUrl.pathname === '/pod' || assetUrl.pathname === '/pod/') {
          assetUrl.pathname = '/';
        } else if (assetUrl.pathname.startsWith('/pod/')) {
          assetUrl.pathname = assetUrl.pathname.replace(/^\/pod/, '') || '/index.html';
        }
        const assetRes = await env.ASSETS.fetch(new Request(assetUrl, request));
        return withSecurityHeaders(assetRes);
      } catch {
        return new Response(
          'Pod UI not found. Run: cd forum-airlock && npm run build:pod',
          { status: 404 }
        );
      }
    }

    return jsonResponse(
      { error: 'route_not_found', path: url.pathname, method: request.method },
      404
    );
  },

  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(
      runCivicAnalysis(env, {
        trigger: `cron:${event.cron || 'unknown'}`,
        publish: true,
      }).catch((err) => {
        console.error('scheduled civic analysis failed:', err?.message || err);
      })
    );
  },
};

const FORUM_FEEDBACK_TAXONOMY = {
  purchasing: { kind: 'behavioral', label: 'Bought something' },
  media: { kind: 'behavioral', label: 'Watched / read / listened' },
  civic: { kind: 'behavioral', label: 'Civic action' },
  social: { kind: 'behavioral', label: 'Community / social' },
  health: { kind: 'behavioral', label: 'Health / body' },
  value: { kind: 'psychographic', label: 'Value or belief' },
  interest: { kind: 'psychographic', label: 'Interest / hobby' },
  lifestyle: { kind: 'psychographic', label: 'Lifestyle' },
  attitude: { kind: 'psychographic', label: 'Opinion / attitude' },
  'civic-legacy': { kind: 'civic', label: 'Civic (legacy)' },
};

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(digest);
}

function base64EncodeUtf8(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(i, i + 0x8000));
  }
  return btoa(binary);
}

function normaliseFeedback(payload) {
  let categoryCode = payload.category_code || payload.categoryCode;
  let categoryLabel = payload.category_label || payload.categoryLabel;
  let kind = payload.kind;

  if (!categoryCode && payload.category_id != null) {
    categoryCode = 'civic-legacy';
    kind = 'civic';
    categoryLabel = categoryLabel || `Civic tier ${payload.category_id}`;
  }

  const taxon = FORUM_FEEDBACK_TAXONOMY[categoryCode];
  if (!taxon) {
    return { error: `unknown category_code: ${categoryCode}` };
  }
  return {
    receipt_id: payload.receipt_id,
    kind: kind || taxon.kind,
    category_code: categoryCode,
    category_label: categoryLabel || taxon.label,
    zip_code: payload.zip_code || null,
    comment: clampForumFeedbackComment(payload.comment || ''),
  };
}

async function ensureForumD1Schema(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS forum_feedback (
        receipt_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        category_code TEXT NOT NULL,
        category_label TEXT NOT NULL,
        zip_code TEXT,
        comment TEXT NOT NULL,
        email_hash TEXT NOT NULL,
        domain_hash TEXT,
        web_id TEXT,
        session_id TEXT,
        public_key_hex TEXT,
        signature_hex TEXT,
        consent_at TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        encrypted_blob TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        wiped_at TEXT
      )
    `),
    db.prepare(`
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
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS forum_payloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        category_code TEXT NOT NULL,
        encrypted_payload TEXT NOT NULL,
        verified_member_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS edge_replay_cache (
        signature TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seen_at_ms INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS edge_signing_keys (
        session_id TEXT PRIMARY KEY,
        web_id TEXT,
        public_key_hex TEXT NOT NULL,
        registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_forum_feedback_created
      ON forum_feedback(created_at)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_forum_feedback_category
      ON forum_feedback(category_code)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_forum_exports_email
      ON forum_exports(email_hash)
    `),
  ]);
}

async function registerEdgeSigningKey(db, sessionId, webId, publicKeyHex) {
  if (!sessionId || !publicKeyHex) return;
  await db
    .prepare(`
      INSERT INTO edge_signing_keys (session_id, web_id, public_key_hex, registered_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        web_id = excluded.web_id,
        public_key_hex = excluded.public_key_hex,
        last_used_at = CURRENT_TIMESTAMP
    `)
    .bind(sessionId, webId || null, publicKeyHex)
    .run();
}

async function loadEdgeSigningKey(db, sessionId) {
  if (!sessionId) return null;
  const row = await db
    .prepare(`SELECT public_key_hex FROM edge_signing_keys WHERE session_id = ?`)
    .bind(sessionId)
    .first();
  return row?.public_key_hex || null;
}

async function recordEdgeReplay(db, signature, sessionId) {
  const nowMs = Date.now();
  const cutoffMs = nowMs - 6 * 60 * 1000;
  await db.prepare(`DELETE FROM edge_replay_cache WHERE seen_at_ms < ?`).bind(cutoffMs).run();
  const result = await db
    .prepare(`
      INSERT OR IGNORE INTO edge_replay_cache (signature, session_id, seen_at_ms)
      VALUES (?, ?, ?)
    `)
    .bind(signature, sessionId || '', nowMs)
    .run();
  return result.meta?.changes === 0;
}

async function handleForumFeedbackAtEdge(request, env) {
  if (!env.DB) {
    return { status: 500, body: { message: 'D1 binding DB is not configured' } };
  }

  let outer;
  try {
    outer = await request.json();
  } catch {
    return { status: 400, body: { message: 'invalid_json' } };
  }

  const binding = await assertSessionBinding(outer);
  if (!binding.ok) {
    return {
      status: 401,
      body: { message: `Payload authentication failed: ${binding.reason}` },
    };
  }

  const unlock = await assertUnlocked(env, outer);
  if (!unlock.ok) {
    return {
      status: 401,
      body: { message: `Payload authentication failed: ${unlock.reason || 'unlock_required'}` },
    };
  }

  const verdict = await verifySignedBundle(outer, null);
  if (!verdict.valid) {
    return {
      status: 401,
      body: { message: `Payload authentication failed: ${verdict.reason}` },
    };
  }

  await ensureForumD1Schema(env.DB);
  const registeredKey = await loadEdgeSigningKey(env.DB, verdict.sessionId);
  if (registeredKey && registeredKey !== verdict.publicKeyHex) {
    return {
      status: 401,
      body: { message: 'Payload authentication failed: key_mismatch' },
    };
  }
  if (!registeredKey) {
    await registerEdgeSigningKey(
      env.DB,
      verdict.sessionId,
      verdict.payload?.webId || null,
      verdict.publicKeyHex
    );
  }
  if (await recordEdgeReplay(env.DB, outer.signature, verdict.sessionId)) {
    return {
      status: 401,
      body: { message: 'Payload authentication failed: replay_detected' },
    };
  }

  const payload = verdict.payload;
  if (!payload || !payload.consent) {
    return { status: 400, body: { message: 'consent required for cooperative export' } };
  }

  const norm = normaliseFeedback(payload);
  if (norm.error) {
    return { status: 400, body: { message: norm.error } };
  }
  if (!norm.receipt_id || !norm.comment) {
    return { status: 400, body: { message: 'receipt_id and comment are required' } };
  }

  const webId = payload.webId || verdict.sessionId;
  const memberHash = await sha256Hex(verdict.publicKeyHex);
  const consentAt = payload.consent_at || new Date().toISOString();
  const policyVersion = payload.policy_version || 'coop-data-policy/2026-05-01';
  const encryptedData = base64EncodeUtf8(JSON.stringify(payload));

  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO forum_payloads (receipt_id, kind, category_code, encrypted_payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(receipt_id) DO UPDATE SET
        encrypted_payload = excluded.encrypted_payload
    `).bind(norm.receipt_id, norm.kind, norm.category_code, encryptedData),
    env.DB.prepare(`
      INSERT INTO forum_exports
        (receipt_id, kind, category_code, web_id, email_hash, consent_at,
         policy_version, session_id, public_key_hex)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      norm.receipt_id,
      norm.kind,
      norm.category_code,
      webId,
      memberHash,
      consentAt,
      policyVersion,
      verdict.sessionId,
      verdict.publicKeyHex
    ),
    env.DB.prepare(`
      INSERT INTO forum_feedback
        (receipt_id, kind, category_code, category_label, zip_code, comment,
         email_hash, domain_hash, web_id, session_id, public_key_hex,
         signature_hex, consent_at, policy_version, encrypted_blob)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(receipt_id) DO UPDATE SET
        kind = excluded.kind,
        category_code = excluded.category_code,
        category_label = excluded.category_label,
        zip_code = excluded.zip_code,
        comment = excluded.comment,
        consent_at = excluded.consent_at,
        policy_version = excluded.policy_version,
        encrypted_blob = excluded.encrypted_blob
    `).bind(
      norm.receipt_id,
      norm.kind,
      norm.category_code,
      norm.category_label,
      norm.zip_code,
      norm.comment,
      memberHash,
      null,
      webId,
      verdict.sessionId,
      verdict.publicKeyHex,
      outer.signature || null,
      consentAt,
      policyVersion,
      encryptedData
    ),
  ]);

  return {
    status: 200,
    body: {
      message: 'Forum Feedback accepted',
      receiptId: norm.receipt_id,
      kind: norm.kind,
      category_code: norm.category_code,
      storage: 'd1:forum-db',
      vault: 'skipped_edge_ingest',
    },
  };
}
