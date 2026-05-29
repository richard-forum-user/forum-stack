/**
 * Recovery phrase signature verification (Ed25519 via Web Crypto).
 */

const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export function canonicalise(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('hex string expected');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(digest);
}

export async function recoveryIdFromPubHex(recoveryPubHex) {
  return sha256Hex(recoveryPubHex);
}

async function importEd25519PublicKey(publicKeyHex) {
  const raw = hexToBytes(publicKeyHex);
  if (raw.length !== 32) {
    throw new Error(`expected 32-byte Ed25519 key, got ${raw.length}`);
  }
  const der = new Uint8Array(SPKI_PREFIX.length + raw.length);
  der.set(SPKI_PREFIX, 0);
  der.set(raw, SPKI_PREFIX.length);
  return crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
}

/**
 * Verify a recovery-key signature over a canonical message object.
 */
export async function verifyRecoverySignature(
  recoveryPubHex,
  messageObj,
  signatureHex,
  timestamp,
  maxAgeMs = 5 * 60 * 1000
) {
  if (!recoveryPubHex || !signatureHex || !timestamp) {
    return { ok: false, reason: 'missing_fields' };
  }
  const tsMs = Date.parse(timestamp);
  if (Number.isNaN(tsMs)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const age = Date.now() - tsMs;
  if (age > maxAgeMs || age < -30000) {
    return { ok: false, reason: 'timestamp_expired' };
  }
  let cryptoKey;
  try {
    cryptoKey = await importEd25519PublicKey(recoveryPubHex);
  } catch (e) {
    return { ok: false, reason: `key_import_failed:${e.message}` };
  }
  const canonical = canonicalise(messageObj);
  let sigBytes;
  try {
    sigBytes = hexToBytes(signatureHex);
  } catch (e) {
    return { ok: false, reason: `signature_hex:${e.message}` };
  }
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    cryptoKey,
    sigBytes,
    new TextEncoder().encode(canonical)
  );
  if (!ok) return { ok: false, reason: 'signature_invalid' };
  return { ok: true };
}

export async function hashFeedbackPayload(norm, consentAt, policyVersion, publicKeyHex) {
  const material = canonicalise({
    receipt_id: norm.receipt_id,
    kind: norm.kind,
    category_code: norm.category_code,
    category_label: norm.category_label,
    comment: norm.comment,
    consent_at: consentAt,
    policy_version: policyVersion,
    public_key_hex: publicKeyHex,
  });
  return sha256Hex(material);
}
