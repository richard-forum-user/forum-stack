/**
 * Short-lived HMAC unlock tokens (Phase 3). Issued after WebAuthn auth verify.
 * Bound to credentialId, expiry, jti, and per-RPC bundle signature hash.
 */

const UNLOCK_TTL_MS = 5 * 60 * 1000;

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function importHmacKey(secret) {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function sha256Hex(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(new Uint8Array(hash));
}

export async function ensureUnlockTokenSchema(db) {
  if (!db) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS unlock_token_jti (
        jti TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        signature_hash TEXT NOT NULL,
        used_at_ms INTEGER NOT NULL
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_unlock_token_jti_used
       ON unlock_token_jti(used_at_ms)`
    )
    .run();
}

export async function issueUnlockToken(env, credentialId) {
  const secret = env.UNLOCK_TOKEN_KEY;
  if (!secret || !credentialId) {
    return null;
  }
  const expiresAtMs = Date.now() + UNLOCK_TTL_MS;
  const jti = crypto.randomUUID();
  const payload = `${credentialId}:${expiresAtMs}:${jti}`;
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return {
    credentialId,
    expiresAtMs,
    jti,
    mac: bytesToHex(new Uint8Array(sig)),
  };
}

/**
 * @param {object} env
 * @param {object|null} token
 * @param {string|null|undefined} bundleSignature
 * @param {D1Database|null|undefined} db
 */
export async function verifyUnlockToken(env, token, bundleSignature, db) {
  if (!token || typeof token !== 'object') {
    return { ok: false, reason: 'missing_unlock_token' };
  }
  const secret = env.UNLOCK_TOKEN_KEY;
  if (!secret) {
    return { ok: false, reason: 'unlock_not_configured' };
  }
  const { credentialId, expiresAtMs, jti, mac } = token;
  if (!credentialId || !expiresAtMs || !jti || !mac) {
    return { ok: false, reason: 'invalid_unlock_token_shape' };
  }
  if (!bundleSignature || typeof bundleSignature !== 'string') {
    return { ok: false, reason: 'missing_bundle_signature' };
  }
  if (Date.now() > Number(expiresAtMs)) {
    return { ok: false, reason: 'unlock_token_expired' };
  }

  const signatureHash = await sha256Hex(bundleSignature);
  const sessionPayload = `${credentialId}:${expiresAtMs}:${jti}`;
  const key = await importHmacKey(secret);
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(mac),
      new TextEncoder().encode(sessionPayload)
    );
    if (!valid) return { ok: false, reason: 'unlock_token_invalid' };
  } catch {
    return { ok: false, reason: 'unlock_token_invalid' };
  }

  if (db) {
    await ensureUnlockTokenSchema(db);
    const cutoff = Date.now() - UNLOCK_TTL_MS * 2;
    await db.prepare(`DELETE FROM unlock_token_jti WHERE used_at_ms < ?`).bind(cutoff).run();
    const existing = await db
      .prepare(`SELECT signature_hash FROM unlock_token_jti WHERE jti = ?`)
      .bind(jti)
      .first();
    if (existing) {
      if (existing.signature_hash !== signatureHash) {
        return { ok: false, reason: 'unlock_token_reused' };
      }
      return { ok: false, reason: 'unlock_token_reused' };
    }
    await db
      .prepare(
        `INSERT INTO unlock_token_jti (jti, credential_id, signature_hash, used_at_ms)
         VALUES (?, ?, ?, ?)`
      )
      .bind(jti, credentialId, signatureHash, Date.now())
      .run();
  }

  return { ok: true, credentialId };
}

export function isPilotCredentialId(credentialId) {
  return typeof credentialId === 'string' && credentialId.startsWith('pilot-');
}

export function isLocalDeviceCredentialId(credentialId) {
  return (
    typeof credentialId === 'string' &&
    (credentialId.startsWith('local-') || credentialId.startsWith('recovered-'))
  );
}
