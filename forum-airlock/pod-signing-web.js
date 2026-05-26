/**
 * Ed25519 signed-bundle verifier for the Cloudflare Worker / DO runtime.
 *
 * Mirrors `forum-airlock/pod-signing.js` (Node `crypto`) but uses
 * Web Crypto so it can run inside a Worker / Durable Object. The
 * Pod app on the device produces these bundles via `pod-signing.js`
 * (`signBundle`); the Worker calls `verifySignedBundle` before
 * forwarding to the Personal Pod DO.
 */

const SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function canonicalise(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) {
    throw new Error("hex string expected");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

async function importEd25519PublicKey(publicKeyHex) {
  const raw = hexToBytes(publicKeyHex);
  if (raw.length !== 32) {
    throw new Error(`expected 32-byte Ed25519 key, got ${raw.length}`);
  }
  const der = new Uint8Array(SPKI_PREFIX.length + raw.length);
  der.set(SPKI_PREFIX, 0);
  der.set(raw, SPKI_PREFIX.length);
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "Ed25519" },
    false,
    ["verify"]
  );
}

/**
 * Verify a signed bundle. If `expectedPublicKeyHex` is provided, the
 * bundle's key must match (used by the DO once it has TOFU-registered
 * a credential's public key on first request).
 *
 * `maxAgeMs` is the replay window. 5 minutes is plenty for a phone
 * round-trip; reject anything older (or more than 30s into the future,
 * which would indicate a forged clock).
 */
export async function verifySignedBundle(
  bundle,
  expectedPublicKeyHex = null,
  maxAgeMs = 5 * 60 * 1000
) {
  if (!bundle || typeof bundle !== "object") {
    return { valid: false, reason: "missing_bundle" };
  }
  const { payload, sessionId, timestamp, signature, publicKeyHex } = bundle;
  if (
    payload === undefined ||
    !sessionId ||
    !timestamp ||
    !signature ||
    !publicKeyHex
  ) {
    return { valid: false, reason: "invalid_structure" };
  }
  const tsMs = Date.parse(timestamp);
  if (Number.isNaN(tsMs)) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  const age = Date.now() - tsMs;
  if (age > maxAgeMs || age < -30000) {
    return { valid: false, reason: "timestamp_expired" };
  }
  if (expectedPublicKeyHex && expectedPublicKeyHex !== publicKeyHex) {
    return { valid: false, reason: "key_mismatch" };
  }
  let cryptoKey;
  try {
    cryptoKey = await importEd25519PublicKey(publicKeyHex);
  } catch (e) {
    return { valid: false, reason: `key_import_failed:${e.message}` };
  }
  const canonical = canonicalise({ payload, sessionId, timestamp });
  let sigBytes;
  try {
    sigBytes = hexToBytes(signature);
  } catch (e) {
    return { valid: false, reason: `signature_hex:${e.message}` };
  }
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    cryptoKey,
    sigBytes,
    new TextEncoder().encode(canonical)
  );
  if (!ok) return { valid: false, reason: "signature_invalid" };
  return { valid: true, sessionId, publicKeyHex, payload, timestamp };
}
