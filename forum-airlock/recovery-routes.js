/**
 * Recovery phrase identity endpoints on the cooperative worker.
 *
 * POST /api/recovery/enroll   — device-key-signed; links recovery_pub to device key
 * POST /api/recovery/challenge — returns nonce for recovery key to sign
 * POST /api/recovery/recover  — recovery-key-signed nonce; returns receipts + rebind token
 * POST /api/recovery/rebind   — consume rebind token; link new device signing key
 * GET  /api/recovery/status   — enrollment status for a recovery_pub_hex (public metadata)
 */

import { verifySignedBundle } from './pod-signing-web.js';
import { sessionIdMatchesPubkey } from './session-binding.js';
import {
  canonicalise,
  recoveryIdFromPubHex,
  verifyRecoverySignature,
} from './recovery-crypto.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function recoveryStub(env, recoveryPubHex) {
  if (!env.RECOVERY) {
    throw new Error('RECOVERY DO binding is not configured');
  }
  const recoveryId = await recoveryIdFromPubHex(recoveryPubHex);
  return env.RECOVERY.get(env.RECOVERY.idFromName(recoveryId));
}

async function callRecoveryDo(env, recoveryPubHex, path, body) {
  const stub = await recoveryStub(env, recoveryPubHex);
  const res = await stub.fetch(
    new Request(`https://recovery-do${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: 'invalid_json_from_do', raw: text.slice(0, 200) };
  }
  return { status: res.status, body: data };
}

async function ensureRecoverySchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS recovery_device_links (
        device_pubkey_hex TEXT PRIMARY KEY,
        recovery_id TEXT NOT NULL,
        recovery_pub_hex TEXT NOT NULL,
        enrolled_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_recovery_device_links_recovery
       ON recovery_device_links(recovery_id)`
    )
    .run();
}

async function enrichReceiptsWithWipeStatus(db, receipts) {
  if (!db || !Array.isArray(receipts) || !receipts.length) return receipts || [];
  const out = [];
  for (const row of receipts) {
    let wipedAt = null;
    let reportId = row.report_id || null;
    try {
      const dr = await db
        .prepare(
          `SELECT payload_sha256, wiped_at, report_id, ingested_at
           FROM forum_deletion_receipts WHERE receipt_id = ?`
        )
        .bind(row.receipt_id)
        .first();
      if (dr) {
        wipedAt = dr.wiped_at || null;
        reportId = dr.report_id || reportId;
      }
    } catch {
      /* table may not exist yet during rollout */
    }
    out.push({
      ...row,
      report_id: reportId,
      wiped_at: wipedAt,
    });
  }
  return out;
}

export async function handleRecoveryRoute(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const path = url.pathname.replace(/\/$/, '');

  if (path === '/api/recovery/status' && request.method === 'GET') {
    const recoveryPubHex = url.searchParams.get('recovery_pub_hex');
    if (!recoveryPubHex || !env.RECOVERY) {
      return json({ error: 'recovery_pub_hex required' }, 400);
    }
    const stub = await recoveryStub(env, recoveryPubHex);
    const res = await stub.fetch(new Request('https://recovery-do/status'));
    const data = await res.json();
    return json(data, res.status);
  }

  if (path === '/api/recovery/challenge' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const { recovery_pub_hex } = body || {};
    if (!recovery_pub_hex) {
      return json({ error: 'recovery_pub_hex required' }, 400);
    }
    const { status, body: data } = await callRecoveryDo(env, recovery_pub_hex, '/challenge', {
      recovery_pub_hex,
    });
    return json(data, status);
  }

  if (path === '/api/recovery/recover' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const {
      recovery_pub_hex,
      nonce,
      recovery_signature,
      recovery_timestamp,
    } = body || {};
    if (!recovery_pub_hex || !nonce || !recovery_signature || !recovery_timestamp) {
      return json(
        { error: 'recovery_pub_hex, nonce, recovery_signature, recovery_timestamp required' },
        400
      );
    }

    const message = {
      action: 'recover',
      recovery_pub_hex,
      nonce,
      timestamp: recovery_timestamp,
    };
    const verdict = await verifyRecoverySignature(
      recovery_pub_hex,
      message,
      recovery_signature,
      recovery_timestamp
    );
    if (!verdict.ok) {
      return json({ error: 'recovery_auth_failed', reason: verdict.reason }, 401);
    }

    const { status, body: data } = await callRecoveryDo(env, recovery_pub_hex, '/recover', {
      recovery_pub_hex,
      nonce,
    });
    if (status !== 200 || !data.ok) {
      return json(data, status);
    }

    if (env.DB) {
      data.receipts = await enrichReceiptsWithWipeStatus(env.DB, data.receipts);
    }
    return json(data, status);
  }

  if (path === '/api/recovery/rebind' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const {
      recovery_pub_hex,
      rebind_token,
      new_device_pubkey_hex,
      new_session_id,
    } = body || {};
    if (!recovery_pub_hex || !rebind_token || !new_device_pubkey_hex) {
      return json(
        { error: 'recovery_pub_hex, rebind_token, new_device_pubkey_hex required' },
        400
      );
    }

    const { status, body: data } = await callRecoveryDo(env, recovery_pub_hex, '/consume-rebind', {
      rebind_token,
      new_device_pubkey_hex,
    });
    if (status !== 200 || !data.ok) {
      return json(data, status);
    }

    if (env.DB) {
      await ensureRecoverySchema(env.DB);
      const recoveryId = await recoveryIdFromPubHex(recovery_pub_hex);
      await env.DB
        .prepare(
          `INSERT INTO recovery_device_links
             (device_pubkey_hex, recovery_id, recovery_pub_hex, enrolled_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(device_pubkey_hex) DO UPDATE SET
             recovery_id = excluded.recovery_id,
             recovery_pub_hex = excluded.recovery_pub_hex,
             enrolled_at = excluded.enrolled_at`
        )
        .bind(new_device_pubkey_hex, recoveryId, recovery_pub_hex)
        .run();

      if (new_session_id) {
        await env.DB
          .prepare(
            `INSERT INTO edge_signing_keys (session_id, web_id, public_key_hex, registered_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(session_id) DO UPDATE SET
               public_key_hex = excluded.public_key_hex,
               last_used_at = CURRENT_TIMESTAMP`
          )
          .bind(new_session_id, null, new_device_pubkey_hex)
          .run();
      }
    }

    return json(data, status);
  }

  if (path === '/api/recovery/enroll' && request.method === 'POST') {
    let outer;
    try {
      outer = await request.json();
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const binding = await sessionIdMatchesPubkey(outer.sessionId, outer.publicKeyHex);
    if (!binding) {
      return json({ error: 'session_binding_failed' }, 401);
    }
    const deviceVerdict = await verifySignedBundle(outer, null);
    if (!deviceVerdict.valid) {
      return json({ error: 'device_auth_failed', reason: deviceVerdict.reason }, 401);
    }

    const payload = deviceVerdict.payload || {};
    const recoveryPubHex = payload.recovery_pub_hex || outer.recovery_pub_hex;
    const recoverySignature =
      payload.recovery_signature || outer.recovery_signature;
    const recoveryTimestamp =
      payload.recovery_timestamp || outer.recovery_timestamp;

    if (!recoveryPubHex || !recoverySignature || !recoveryTimestamp) {
      return json(
        {
          error: 'recovery_pub_hex, recovery_signature, recovery_timestamp required',
        },
        400
      );
    }

    const linkMessage = {
      action: 'enroll',
      recovery_pub_hex: recoveryPubHex,
      device_pubkey_hex: deviceVerdict.publicKeyHex,
      timestamp: recoveryTimestamp,
    };
    const recoveryVerdict = await verifyRecoverySignature(
      recoveryPubHex,
      linkMessage,
      recoverySignature,
      recoveryTimestamp
    );
    if (!recoveryVerdict.ok) {
      return json({ error: 'recovery_auth_failed', reason: recoveryVerdict.reason }, 401);
    }

    const { status, body: data } = await callRecoveryDo(env, recoveryPubHex, '/enroll', {
      recovery_pub_hex: recoveryPubHex,
      device_pubkey_hex: deviceVerdict.publicKeyHex,
    });
    if (status !== 200 || !data.ok) {
      return json(data, status);
    }

    if (env.DB) {
      await ensureRecoverySchema(env.DB);
      const recoveryId = await recoveryIdFromPubHex(recoveryPubHex);
      await env.DB
        .prepare(
          `INSERT INTO recovery_device_links
             (device_pubkey_hex, recovery_id, recovery_pub_hex, enrolled_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(device_pubkey_hex) DO UPDATE SET
             recovery_id = excluded.recovery_id,
             recovery_pub_hex = excluded.recovery_pub_hex,
             enrolled_at = excluded.enrolled_at`
        )
        .bind(deviceVerdict.publicKeyHex, recoveryId, recoveryPubHex)
        .run();
    }

    return json({
      ok: true,
      recovery_pub_hex: recoveryPubHex,
      linked_device_keys: data.linked_device_keys,
      created_at: data.created_at,
    });
  }

  return json({ error: 'not_found' }, 404);
}

/**
 * Append a receipt to the enrolled RecoveryDO for this device key (if any).
 * Called from forum feedback ingest.
 */
export async function appendRecoveryReceipt(env, devicePubkeyHex, receipt) {
  if (!env.RECOVERY || !env.DB || !devicePubkeyHex || !receipt?.receipt_id) return null;
  const link = await env.DB.prepare(
    `SELECT recovery_id, recovery_pub_hex FROM recovery_device_links WHERE device_pubkey_hex = ?`
  )
    .bind(devicePubkeyHex)
    .first();
  if (!link?.recovery_pub_hex) return null;

  const stub = env.RECOVERY.get(env.RECOVERY.idFromName(link.recovery_id));
  const res = await stub.fetch(
    new Request('https://recovery-do/append-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        receipt_id: receipt.receipt_id,
        payload_sha256: receipt.payload_sha256,
        ingested_at: receipt.ingested_at,
        report_id: receipt.report_id || null,
      }),
    })
  );
  return res.json();
}

export { canonicalise };
