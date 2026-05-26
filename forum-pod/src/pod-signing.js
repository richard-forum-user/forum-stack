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

export async function ensurePodSigningKey(_legacySessionHint) {
  const existing = loadSigningMeta();
  if (existing?.publicKeyHex && existing.privateJwk) {
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
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const rawPub = Uint8Array.from(atob(publicJwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  );
  const publicKeyHex = bytesToHex(rawPub);
  const sessionId = await deriveBoundSessionId(publicKeyHex);
  const meta = {
    sessionId,
    publicKeyHex,
    privateJwk,
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
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    meta.privateJwk,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
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
