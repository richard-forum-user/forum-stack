import CIVIC_AI_SYSTEM_PROMPT from './civic-ai-system-prompt.js';
import { verifySignedBundle } from './pod-signing-web.js';
import { sessionIdMatchesPubkey } from './session-binding.js';
import { isPilotCredentialId, verifyUnlockToken } from './unlock-token.js';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'Access-Control-Allow-Origin': '*',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
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

async function ensureAiD1Schema(db) {
  await db.batch([
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
      CREATE TABLE IF NOT EXISTS ai_chat_quota (
        credential_id TEXT NOT NULL,
        day TEXT NOT NULL,
        msg_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (credential_id, day)
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ai_chat_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credential_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        finish_reason TEXT
      )
    `),
  ]);
}

async function loadEdgeSigningKey(db, sessionId) {
  const row = await db
    .prepare(`SELECT public_key_hex FROM edge_signing_keys WHERE session_id = ?`)
    .bind(sessionId)
    .first();
  return row?.public_key_hex || null;
}

async function registerEdgeSigningKey(db, sessionId, webId, publicKeyHex) {
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

async function recordReplay(db, signature, sessionId) {
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

async function incrementQuota(db, credentialId, dailyQuota) {
  const day = new Date().toISOString().slice(0, 10);
  await db
    .prepare(`
      INSERT INTO ai_chat_quota (credential_id, day, msg_count)
      VALUES (?, ?, 0)
      ON CONFLICT(credential_id, day) DO NOTHING
    `)
    .bind(credentialId, day)
    .run();
  const row = await db
    .prepare(`SELECT msg_count FROM ai_chat_quota WHERE credential_id = ? AND day = ?`)
    .bind(credentialId, day)
    .first();
  const current = Number(row?.msg_count || 0);
  if (current >= dailyQuota) {
    return { ok: false, remaining: 0 };
  }
  await db
    .prepare(`UPDATE ai_chat_quota SET msg_count = msg_count + 1 WHERE credential_id = ? AND day = ?`)
    .bind(credentialId, day)
    .run();
  return { ok: true, remaining: Math.max(0, dailyQuota - current - 1) };
}

function normalizeMessages(input) {
  const messages = Array.isArray(input) ? input : [];
  return messages
    .filter((msg) => msg && typeof msg === 'object')
    .map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: String(msg.content || '').slice(0, 8000),
    }))
    .filter((msg) => msg.content.trim());
}

// v1.9 attempted to inject a per-turn POD DATA CONTEXT system message
// so the model could answer questions about the user's data. With a
// 14B-q4 model on a small context, every wrap-text variant we tried
// either hallucinated rows or asked the user for the context block.
// In v2.0 the chat path no longer receives Pod data at all; data
// questions go through the deterministic Explore tab (src/explore.jsx).
// Any `payload.podContext` from older Pod builds is silently ignored.

function buildOllamaMessages(payload) {
  return [
    { role: 'system', content: CIVIC_AI_SYSTEM_PROMPT },
    ...normalizeMessages(payload?.messages),
  ];
}

async function writeAiLog(db, credentialId, data) {
  await db
    .prepare(`
      INSERT INTO ai_chat_log (credential_id, ts, prompt_tokens, completion_tokens, finish_reason)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(
      credentialId,
      Date.now(),
      data?.prompt_eval_count || null,
      data?.eval_count || null,
      data?.done_reason || (data?.done ? 'done' : null)
    )
    .run();
}

function streamOllamaAsSse(upstream, db, credentialId) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.body.getReader();
  let buffer = '';
  let finalStats = null;

  const stream = new ReadableStream({
    async pull(controller) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim()) {
            emitLine(controller, buffer.trim());
          }
          controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
          if (db && finalStats) {
            await writeAiLog(db, credentialId, finalStats);
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          emitLine(controller, line.trim());
        }
        return;
      }
    },
    cancel() {
      return reader.cancel();
    },
  });

  function emitLine(controller, line) {
    if (!line) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: 'bad_upstream_chunk' })}\n\n`));
      return;
    }
    if (parsed.done) {
      finalStats = parsed;
    }
    const content = parsed.message?.content || '';
    if (content) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content })}\n\n`));
    }
  }

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

export async function handleAiChat(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'use_post' }, 405);
  }
  if (!env.DB) {
    return jsonResponse({ error: 'd1_not_configured' }, 500);
  }
  const upstreamUrl = (env.AI_UPSTREAM_URL || '').replace(/\/$/, '');
  if (!upstreamUrl) {
    return jsonResponse({ error: 'ai_upstream_not_configured' }, 503);
  }

  let bundle;
  try {
    bundle = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const binding = await assertSessionBinding(bundle);
  if (!binding.ok) {
    return jsonResponse({ error: 'auth_failed', reason: binding.reason }, 401);
  }
  const unlock = await assertUnlocked(env, bundle);
  if (!unlock.ok) {
    return jsonResponse({ error: 'auth_failed', reason: unlock.reason || 'unlock_required' }, 401);
  }
  const verdict = await verifySignedBundle(bundle, null);
  if (!verdict.valid) {
    return jsonResponse({ error: 'auth_failed', reason: verdict.reason }, 401);
  }

  await ensureAiD1Schema(env.DB);
  const registeredKey = await loadEdgeSigningKey(env.DB, verdict.sessionId);
  if (registeredKey && registeredKey !== verdict.publicKeyHex) {
    return jsonResponse({ error: 'auth_failed', reason: 'key_mismatch' }, 401);
  }
  if (!registeredKey) {
    await registerEdgeSigningKey(
      env.DB,
      verdict.sessionId,
      verdict.payload?.webId || null,
      verdict.publicKeyHex
    );
  }
  if (await recordReplay(env.DB, bundle.signature, verdict.sessionId)) {
    return jsonResponse({ error: 'auth_failed', reason: 'replay_detected' }, 401);
  }

  const credentialId = bundle.deviceCredentialId || verdict.sessionId;
  const quota = await incrementQuota(env.DB, credentialId, Number(env.AI_DAILY_QUOTA || 100));
  if (!quota.ok) {
    return jsonResponse({ error: 'quota_exceeded', message: 'Kami is resting for today.' }, 429);
  }

  const messages = buildOllamaMessages(verdict.payload);
  if (messages.length <= 1) {
    return jsonResponse({ error: 'empty_messages' }, 400);
  }

  const headers = { 'Content-Type': 'application/json' };
  if (env.AI_ACCESS_CLIENT_ID && env.AI_ACCESS_CLIENT_SECRET) {
    headers['CF-Access-Client-Id'] = env.AI_ACCESS_CLIENT_ID;
    headers['CF-Access-Client-Secret'] = env.AI_ACCESS_CLIENT_SECRET;
  }

  let upstream;
  try {
    upstream = await fetch(`${upstreamUrl}/api/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: env.AI_UPSTREAM_MODEL || 'qwen2.5:14b-instruct',
        stream: true,
        messages,
      }),
    });
  } catch (e) {
    return jsonResponse({ error: 'ai_upstream_unreachable', message: e.message }, 503);
  }

  if (!upstream.ok || !upstream.body) {
    return jsonResponse(
      { error: 'ai_upstream_failed', status: upstream.status },
      upstream.status === 429 ? 429 : 502
    );
  }

  return streamOllamaAsSse(upstream, env.DB, credentialId);
}
