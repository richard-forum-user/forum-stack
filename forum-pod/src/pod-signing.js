import {
  loadSigningMeta,
  saveMemberProfile,
  saveSigningMeta,
  loadMemberProfile,
  loadSigningPrivateJwk,
  saveSigningPrivateJwk,
  clearSigningKeyStorage,
} from "./member-store.js";
import { deriveBoundSessionId } from "./session-id.js";

function canonicalise(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export { deriveBoundSessionId };

/** Non-extractable Ed25519 private key — lives in memory for the session only. */
let volatileSigningPrivateKey = null;

export function clearVolatileSigningKey() {
  volatileSigningPrivateKey = null;
}

export function setVolatileSigningPrivateKey(privateKey) {
  volatileSigningPrivateKey = privateKey;
}

export async function migrateLegacySigningKey() {
  const raw = localStorage.getItem("forum.podSigning");
  if (!raw || volatileSigningPrivateKey) return false;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed?.privateJwk) return false;
  volatileSigningPrivateKey = await crypto.subtle.importKey(
    "jwk",
    parsed.privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const { privateJwk: _removed, ...rest } = parsed;
  const { saveSigningMeta } = await import("./member-store.js");
  saveSigningMeta(rest);
  return true;
}

/**
 * Re-arm the in-memory signing key from the locally-persisted private JWK.
 * Returns true if the volatile key is now available. This is what makes
 * "sign back in" work after a reload / session-lock for device-owned Pods.
 */
async function restoreVolatileSigningKey() {
  if (volatileSigningPrivateKey) return true;
  const jwk = loadSigningPrivateJwk();
  if (!jwk) return false;
  try {
    volatileSigningPrivateKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    return true;
  } catch {
    return false;
  }
}

async function generateAndPersistSigningKey() {
  // Extractable so the private JWK can be persisted locally (device-owned key).
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  );
  volatileSigningPrivateKey = keyPair.privateKey;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const rawPub = Uint8Array.from(atob(publicJwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  );
  const publicKeyHex = bytesToHex(rawPub);
  const sessionId = await deriveBoundSessionId(publicKeyHex);
  const meta = {
    sessionId,
    publicKeyHex,
    publicJwk,
    createdAt: Date.now(),
  };
  saveSigningMeta(meta);
  saveSigningPrivateJwk(privateJwk);
  const profile = loadMemberProfile();
  if (profile) {
    saveMemberProfile({ ...profile, sessionId });
  }
  return meta;
}

export async function ensurePodSigningKey(_legacySessionHint) {
  await migrateLegacySigningKey();
  if (!volatileSigningPrivateKey) {
    await restoreVolatileSigningKey();
  }
  const existing = loadSigningMeta();
  if (existing?.publicKeyHex && volatileSigningPrivateKey) {
    const sessionId = await deriveBoundSessionId(existing.publicKeyHex);
    const meta = { ...existing, sessionId };
    if (existing.sessionId !== sessionId) {
      saveSigningMeta(meta);
    }
    const profile = loadMemberProfile();
    if (profile && profile.sessionId !== sessionId) {
      saveMemberProfile({ ...profile, sessionId });
    }
    return meta;
  }
  if (existing?.publicKeyHex && !volatileSigningPrivateKey) {
    throw new Error(
      "Signing key is locked. Unlock with your passkey to sign requests."
    );
  }
  return generateAndPersistSigningKey();
}

/**
 * Forcibly mint a fresh signing key, discarding any stale meta. Used to
 * recover a device-owned Pod whose private key was never persisted (e.g. a
 * Pod created by an older build before local key persistence existed). The
 * new key yields a new sessionId, so the on-device / trial Pod starts clean.
 */
export async function regenerateSigningKey() {
  clearSigningKeyStorage();
  return generateAndPersistSigningKey();
}

export async function signBundle(payload, _sessionHint) {
  const meta = await ensurePodSigningKey();
  const sessionId = meta.sessionId;
  const timestamp = new Date().toISOString();
  const message = canonicalise({ payload, sessionId, timestamp });
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    volatileSigningPrivateKey,
    new TextEncoder().encode(message)
  );
  return {
    payload,
    sessionId,
    timestamp,
    signature: bytesToHex(sig),
    publicKeyHex: meta.publicKeyHex,
  };
}
