const MEMBER_KEY = "forum.member";
const SIGNING_KEY = "forum.podSigning";
const WRAPPED_SIGNING_KEY = "forum.podSigning.wrapped";

const EXPORT_KIND = "forum-personal-pod-device-key-v1";
const EXPORT_KIND_V2 = "forum-personal-pod-device-key-v2";

const PBKDF2_ITERATIONS = 600_000;
let volatilePrivateJwk = null;

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
  volatilePrivateJwk = null;
}

export function clearSigningMemory() {
  volatilePrivateJwk = null;
}

export function loadSigningMeta() {
  try {
    const raw = localStorage.getItem(SIGNING_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && !parsed.privateJwk && volatilePrivateJwk) {
      return { ...parsed, privateJwk: volatilePrivateJwk };
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSigningMeta(meta) {
  if (meta?.privateJwk) {
    volatilePrivateJwk = meta.privateJwk;
  }
  localStorage.setItem(SIGNING_KEY, JSON.stringify(meta));
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

function buildV1Payload() {
  const member = loadMemberProfile();
  const signing = loadSigningMeta();
  if (!member?.credential_id || !signing?.privateJwk || !signing?.publicKeyHex) {
    return null;
  }
  return {
    kind: EXPORT_KIND,
    version: 1,
    exported_at: new Date().toISOString(),
    member,
    signing,
  };
}

async function derivePinKey(pin, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
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
}

/**
 * PIN-wrapped device key export (v2). Requires a non-empty PIN.
 */
export async function exportDeviceKeyBlob(pin) {
  const inner = buildV1Payload();
  if (!inner) return null;
  if (!pin || String(pin).length < 4) {
    throw new Error("Choose a PIN of at least 4 characters to protect the export.");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await derivePinKey(String(pin), salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(inner));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const envelope = {
    kind: EXPORT_KIND_V2,
    version: 2,
    exported_at: new Date().toISOString(),
    kdf: { name: "PBKDF2-SHA-256", salt: base64urlEncode(salt), iterations: PBKDF2_ITERATIONS },
    cipher: { name: "AES-GCM", iv: base64urlEncode(iv), ciphertext: base64urlEncode(new Uint8Array(ciphertext)) },
  };
  return base64urlEncode(new TextEncoder().encode(JSON.stringify(envelope)));
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
    const aesKey = await derivePinKey(String(pin), salt);
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
  if (!inner.signing?.privateJwk || !inner.signing?.publicKeyHex) {
    throw new Error("Imported blob is missing signing key material.");
  }
  saveMemberProfile(inner.member);
  saveSigningMeta(inner.signing);
  return {
    credentialId: inner.member.credential_id,
    webId: inner.member.webId || null,
    publicKeyHex: inner.signing.publicKeyHex,
    legacyUnprotected,
  };
}

/**
 * Optional PRF wrap of signing key at rest (Phase 3d).
 */
export async function wrapSigningKeyAtRest(prfOutput) {
  const signing = loadSigningMeta();
  if (!signing?.privateJwk || !prfOutput) return false;
  const wrapKey = await crypto.subtle.importKey(
    "raw",
    prfOutput.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(signing.privateJwk));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, plaintext);
  localStorage.setItem(
    WRAPPED_SIGNING_KEY,
    JSON.stringify({
      iv: base64urlEncode(iv),
      ciphertext: base64urlEncode(new Uint8Array(ciphertext)),
    })
  );
  const { privateJwk: _removed, ...rest } = signing;
  volatilePrivateJwk = signing.privateJwk;
  saveSigningMeta(rest);
  return true;
}

export async function unwrapSigningKeyAtRest(prfOutput) {
  const wrappedRaw = localStorage.getItem(WRAPPED_SIGNING_KEY);
  if (!wrappedRaw || !prfOutput) return loadSigningMeta();
  const wrapped = JSON.parse(wrappedRaw);
  const wrapKey = await crypto.subtle.importKey(
    "raw",
    prfOutput.slice(0, 32),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  const iv = base64urlDecode(wrapped.iv);
  const ciphertext = base64urlDecode(wrapped.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, wrapKey, ciphertext);
  const privateJwk = JSON.parse(new TextDecoder().decode(plaintext));
  volatilePrivateJwk = privateJwk;
  const meta = { ...loadSigningMeta(), privateJwk };
  return meta;
}
