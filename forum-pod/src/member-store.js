import { clearVolatileSigningKey } from "./pod-signing.js";

const MEMBER_KEY = "forum.member";
const SIGNING_KEY = "forum.podSigning";
const WRAPPED_SIGNING_KEY = "forum.podSigning.wrapped";
// Local-first signing key persistence. The Personal Pod is device-owned
// (on-device SQLite on mobile, a standalone trial/airlock DO in the browser),
// so the Ed25519 signing key lives on the device. Persisting the private JWK
// here lets the key survive a reload / session-lock so the member can sign
// back in without dead-ending on "Signing key is locked".
const SIGNING_PRIV_KEY = "forum.podSigning.priv";

const EXPORT_KIND = "forum-personal-pod-device-key-v1";
const EXPORT_KIND_V2 = "forum-personal-pod-device-key-v2";

const PBKDF2_ITERATIONS = 600_000;

export function loadMemberProfile() {
  try {
    const raw = localStorage.getItem(MEMBER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveMemberProfile(profile) {
  localStorage.setItem(MEMBER_KEY, JSON.stringify(profile));
}

export function clearMemberProfile() {
  localStorage.removeItem(MEMBER_KEY);
  localStorage.removeItem(SIGNING_KEY);
  localStorage.removeItem(WRAPPED_SIGNING_KEY);
  localStorage.removeItem(SIGNING_PRIV_KEY);
  clearVolatileSigningKey();
}

export function saveSigningPrivateJwk(jwk) {
  if (!jwk) return;
  try {
    localStorage.setItem(SIGNING_PRIV_KEY, JSON.stringify(jwk));
  } catch {
    /* storage full / unavailable — key stays in-memory only this session */
  }
}

export function loadSigningPrivateJwk() {
  try {
    const raw = localStorage.getItem(SIGNING_PRIV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Drop the persisted signing key material (meta + private JWK). */
export function clearSigningKeyStorage() {
  localStorage.removeItem(SIGNING_KEY);
  localStorage.removeItem(SIGNING_PRIV_KEY);
  clearVolatileSigningKey();
}

export function clearSigningMemory() {
  clearVolatileSigningKey();
}

export function loadSigningMeta() {
  try {
    const raw = localStorage.getItem(SIGNING_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSigningMeta(meta) {
  if (!meta) return;
  const { privateJwk: _drop, ...rest } = meta;
  localStorage.setItem(SIGNING_KEY, JSON.stringify(rest));
}

function base64urlEncode(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function exportDeviceKeyBlob(_pin) {
  const member = loadMemberProfile();
  const signing = loadSigningMeta();
  if (!member?.credential_id || !signing?.publicKeyHex) {
    return null;
  }
  throw new Error(
    "Device key export is disabled for production builds. Enroll a recovery passkey on the cooperative Worker instead."
  );
}

export async function importDeviceKeyBlob(blob, pin) {
  if (!blob || typeof blob !== "string") {
    throw new Error("Paste a non-empty device key blob.");
  }
  let parsed;
  try {
    const json = new TextDecoder().decode(base64urlDecode(blob.trim()));
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Device key blob is malformed: ${e.message}`, { cause: e });
  }

  let inner;
  let legacyUnprotected = false;

  if (parsed.kind === EXPORT_KIND_V2) {
    if (!pin) {
      throw new Error("Enter the PIN used when this blob was exported.");
    }
    const salt = base64urlDecode(parsed.kdf.salt);
    const iv = base64urlDecode(parsed.cipher.iv);
    const ciphertext = base64urlDecode(parsed.cipher.ciphertext);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pin),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const aesKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext);
    } catch {
      throw new Error("Wrong PIN or corrupted blob.");
    }
    inner = JSON.parse(new TextDecoder().decode(plaintext));
  } else if (parsed.kind === EXPORT_KIND) {
    inner = parsed;
    legacyUnprotected = true;
  } else {
    throw new Error(`Unexpected key blob kind: ${parsed.kind || "(missing)"}`);
  }

  if (!inner.member?.credential_id) {
    throw new Error("Imported blob is missing credential_id.");
  }
  if (!inner.signing?.publicKeyHex) {
    throw new Error("Imported blob is missing signing key material.");
  }
  if (inner.signing?.privateJwk) {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      inner.signing.privateJwk,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    const mod = await import("./pod-signing.js");
    mod.setVolatileSigningPrivateKey?.(privateKey);
    const { privateJwk: _r, ...signingRest } = inner.signing;
    saveMemberProfile(inner.member);
    saveSigningMeta(signingRest);
  } else {
    saveMemberProfile(inner.member);
    saveSigningMeta(inner.signing);
  }
  return {
    credentialId: inner.member.credential_id,
    webId: inner.member.webId || null,
    publicKeyHex: inner.signing.publicKeyHex,
    legacyUnprotected,
  };
}

export async function wrapSigningKeyAtRest(_prfOutput) {
  return false;
}

export async function unwrapSigningKeyAtRest(_prfOutput) {
  return loadSigningMeta();
}
