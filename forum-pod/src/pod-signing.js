import { loadSigningMeta, saveMemberProfile, saveSigningMeta, loadMemberProfile } from "./member-store.js";
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

export async function ensurePodSigningKey(_legacySessionHint) {
  await migrateLegacySigningKey();
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
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    false,
    ["sign", "verify"]
  );
  volatileSigningPrivateKey = keyPair.privateKey;
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
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
  const profile = loadMemberProfile();
  if (profile) {
    saveMemberProfile({ ...profile, sessionId });
  }
  return meta;
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
