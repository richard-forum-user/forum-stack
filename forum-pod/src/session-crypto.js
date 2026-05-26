/**
 * AES-GCM encryption for localStorage values using a session key from WebAuthn PRF.
 */

const SESSION_KEY_STORAGE = "forum.sessionCryptoKey";

let sessionAesKey = null;

function b64Encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64Decode(b64url) {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function clearSessionCryptoKey() {
  sessionAesKey = null;
  try {
    sessionStorage.removeItem(SESSION_KEY_STORAGE);
  } catch {
    /* ignore */
  }
}

export async function setSessionCryptoKeyFromPrf(prfOutput) {
  if (!prfOutput) return false;
  sessionAesKey = await crypto.subtle.importKey(
    "raw",
    prfOutput.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  try {
    sessionStorage.setItem(SESSION_KEY_STORAGE, "1");
  } catch {
    /* ignore */
  }
  return true;
}

export function hasSessionCryptoKey() {
  return !!sessionAesKey;
}

export async function encryptLocalValue(plaintext) {
  if (!sessionAesKey) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    sessionAesKey,
    new TextEncoder().encode(plaintext)
  );
  return JSON.stringify({
    enc: "forum-session-v1",
    iv: b64Encode(iv),
    ciphertext: b64Encode(new Uint8Array(ct)),
  });
}

export async function decryptLocalValue(stored) {
  if (!stored || typeof stored !== "string") return stored;
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored;
  }
  if (!parsed?.enc || parsed.enc !== "forum-session-v1" || !sessionAesKey) {
    return stored;
  }
  const iv = b64Decode(parsed.iv);
  const ciphertext = b64Decode(parsed.ciphertext);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, sessionAesKey, ciphertext);
  return new TextDecoder().decode(pt);
}

export async function secureSetItem(key, value) {
  const payload = await encryptLocalValue(value);
  localStorage.setItem(key, typeof payload === "string" ? payload : JSON.stringify(payload));
}

export async function secureGetItem(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  return decryptLocalValue(raw);
}
