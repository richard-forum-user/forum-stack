/**
 * Short-lived HMAC unlock tokens (Phase 3). Issued after WebAuthn auth verify.
 */

const UNLOCK_TTL_MS = 15 * 60 * 1000;

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

export async function issueUnlockToken(env, credentialId) {
  const secret = env.UNLOCK_TOKEN_KEY;
  if (!secret || !credentialId) {
    return null;
  }
  const expiresAtMs = Date.now() + UNLOCK_TTL_MS;
  const payload = `${credentialId}:${expiresAtMs}`;
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(payload)
  );
  return {
    credentialId,
    expiresAtMs,
    mac: bytesToHex(new Uint8Array(sig)),
  };
}

export async function verifyUnlockToken(env, token) {
  if (!token || typeof token !== 'object') {
    return { ok: false, reason: 'missing_unlock_token' };
  }
  const secret = env.UNLOCK_TOKEN_KEY;
  if (!secret) {
    return { ok: false, reason: 'unlock_not_configured' };
  }
  const { credentialId, expiresAtMs, mac } = token;
  if (!credentialId || !expiresAtMs || !mac) {
    return { ok: false, reason: 'invalid_unlock_token_shape' };
  }
  if (Date.now() > Number(expiresAtMs)) {
    return { ok: false, reason: 'unlock_token_expired' };
  }
  const payload = `${credentialId}:${expiresAtMs}`;
  const key = await importHmacKey(secret);
  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      hexToBytes(mac),
      new TextEncoder().encode(payload)
    );
    if (!valid) return { ok: false, reason: 'unlock_token_invalid' };
    return { ok: true, credentialId };
  } catch {
    return { ok: false, reason: 'unlock_token_invalid' };
  }
}

export function isPilotCredentialId(credentialId) {
  return typeof credentialId === 'string' && credentialId.startsWith('pilot-');
}
