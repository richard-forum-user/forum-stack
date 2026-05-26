import {
  loadMemberProfile,
  saveMemberProfile,
  unwrapSigningKeyAtRest,
  wrapSigningKeyAtRest,
} from "./member-store.js";
import { setUnlockToken, setPilotUnlock } from "./unlock-session.js";

/**
 * Pilot fallback only when explicitly enabled at build time.
 * Capacitor no longer auto-enables pilot mode (security hardening).
 */
export function pilotFallbackAllowed() {
  const flag = String(import.meta.env.VITE_ALLOW_PILOT_FALLBACK || "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

function _rpFromPodProvider(_podProviderUrl) {
  const host =
    (typeof window !== "undefined" && window.location.hostname) || "localhost";
  return { name: "Forum Personal Pod", id: host };
}

function randomCredentialId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bufferToBase64url(bytes.buffer);
}

function buildPilotProfile(reason) {
  const credentialId = `pilot-${randomCredentialId()}`;
  const profile = {
    credential_id: credentialId,
    registered_at: new Date().toISOString(),
    auth_mode: reason ? `pilot-device-id:${reason}` : "pilot-device-id",
  };
  saveMemberProfile(profile);
  setPilotUnlock(credentialId);
  return { credential: null, credentialId, profile, fallback: true };
}

function workerBase(cooperativeBaseUrl) {
  return (cooperativeBaseUrl || import.meta.env.VITE_SERVER_URL || "").replace(/\/$/, "");
}

export function webAuthnSupported() {
  return typeof window !== "undefined" && !!window.PublicKeyCredential;
}

function decodeCreationOptions(serverOptions) {
  const opts = { ...serverOptions };
  if (typeof opts.challenge === "string") {
    opts.challenge = base64urlToBuffer(opts.challenge);
  }
  if (opts.user?.id && typeof opts.user.id === "string") {
    opts.user = { ...opts.user, id: base64urlToBuffer(opts.user.id) };
  }
  if (Array.isArray(opts.excludeCredentials)) {
    opts.excludeCredentials = opts.excludeCredentials.map((c) => ({
      ...c,
      id: typeof c.id === "string" ? base64urlToBuffer(c.id) : c.id,
    }));
  }
  return opts;
}

function decodeRequestOptions(serverOptions) {
  const opts = { ...serverOptions };
  if (typeof opts.challenge === "string") {
    opts.challenge = base64urlToBuffer(opts.challenge);
  }
  if (Array.isArray(opts.allowCredentials)) {
    opts.allowCredentials = opts.allowCredentials.map((c) => ({
      ...c,
      id: typeof c.id === "string" ? base64urlToBuffer(c.id) : c.id,
    }));
  }
  return opts;
}

function credentialToJson(credential) {
  const response = credential.response;
  const out = {
    id: credential.id,
    rawId: bufferToBase64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64url(response.clientDataJSON),
    },
  };
  if (response.attestationObject) {
    out.response.attestationObject = bufferToBase64url(response.attestationObject);
  }
  if (response.authenticatorData) {
    out.response.authenticatorData = bufferToBase64url(response.authenticatorData);
  }
  if (response.signature) {
    out.response.signature = bufferToBase64url(response.signature);
  }
  if (response.userHandle) {
    out.response.userHandle = bufferToBase64url(response.userHandle);
  }
  return out;
}

async function tryPrfWrap(credential) {
  const ext = credential?.getClientExtensionResults?.();
  const prf = ext?.prf?.results?.first;
  if (prf) {
    await wrapSigningKeyAtRest(new Uint8Array(prf));
  }
}

export async function registerDevice(podProviderUrl, cooperativeUrl) {
  const base = workerBase(cooperativeUrl || podProviderUrl);

  if (!webAuthnSupported()) {
    if (pilotFallbackAllowed()) return buildPilotProfile("no-webauthn-api");
    throw new Error(
      "This browser does not expose the WebAuthn API. Use a Chromium or Safari build that supports platform passkeys."
    );
  }

  try {
    const chRes = await fetch(`${base}/api/webauthn/register/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: window.location.origin }),
    });
    const chData = await chRes.json().catch(() => ({}));
    if (!chRes.ok) {
      throw new Error(chData.error || chData.reason || "Failed to fetch registration challenge.");
    }
    const creationOptions = decodeCreationOptions(chData.options || chData);
    const credential = await navigator.credentials.create({
      publicKey: creationOptions,
    });
    if (!credential?.rawId) {
      throw new Error("Passkey registration returned no credential.");
    }
    const payload = credentialToJson(credential);
    payload.expectedChallenge = chData.options?.challenge || chData.challenge;

    const verifyRes = await fetch(`${base}/api/webauthn/register/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const verifyData = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) {
      throw new Error(verifyData.error || verifyData.reason || "Server rejected passkey registration.");
    }

    const credentialId = verifyData.credentialId || payload.id;
    const profile = {
      credential_id: credentialId,
      registered_at: new Date().toISOString(),
      auth_mode: "webauthn-verified",
    };
    saveMemberProfile(profile);
    if (verifyData.unlockToken) {
      setUnlockToken(verifyData.unlockToken, credentialId);
    }
    await tryPrfWrap(credential);
    return { credential, credentialId, profile };
  } catch (e) {
    if (pilotFallbackAllowed()) {
      console.warn("[webauthn-member] WebAuthn unavailable, using pilot fallback:", e);
      return buildPilotProfile(e?.name || "webauthn-error");
    }
    const reason = e?.message || e?.name || "WebAuthn registration failed";
    throw new Error(`Passkey registration failed: ${reason}`, { cause: e });
  }
}

export async function unlockWithWebAuthn(cooperativeUrl) {
  const profile = loadMemberProfile();
  if (!profile?.credential_id) {
    throw new Error("No device credential. Create your Pod first.");
  }
  if (String(profile.auth_mode || "").startsWith("pilot")) {
    if (!pilotFallbackAllowed()) {
      throw new Error(
        "This Pod was created with the pilot fallback credential. Clear local Pod state and create a new Pod with a passkey."
      );
    }
    setPilotUnlock(profile.credential_id);
    return profile;
  }

  const base = workerBase(cooperativeUrl);
  const chRes = await fetch(`${base}/api/webauthn/auth/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      credentialId: profile.credential_id,
      origin: window.location.origin,
    }),
  });
  const chData = await chRes.json().catch(() => ({}));
  if (!chRes.ok) {
    throw new Error(chData.error || chData.reason || "Failed to fetch authentication challenge.");
  }
  const requestOptions = decodeRequestOptions(chData.options || chData);
  const assertion = await navigator.credentials.get({ publicKey: requestOptions });
  if (!assertion) throw new Error("WebAuthn authentication failed.");

  const payload = credentialToJson(assertion);
  payload.expectedChallenge = chData.options?.challenge || chData.challenge;

  const verifyRes = await fetch(`${base}/api/webauthn/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const verifyData = await verifyRes.json().catch(() => ({}));
  if (!verifyRes.ok) {
    throw new Error(verifyData.error || verifyData.reason || "Server rejected passkey unlock.");
  }
  if (verifyData.unlockToken) {
    setUnlockToken(verifyData.unlockToken, verifyData.credentialId || profile.credential_id);
  }
  await tryPrfWrap(assertion);
  const prf = assertion?.getClientExtensionResults?.()?.prf?.results?.first;
  if (prf) {
    await unwrapSigningKeyAtRest(new Uint8Array(prf));
  }
  return profile;
}

export async function authenticateDevice(cooperativeUrl) {
  return unlockWithWebAuthn(cooperativeUrl);
}

export async function registerWithCooperative(credentialId, cooperativeBaseUrl) {
  const base = (cooperativeBaseUrl || "").replace(/\/$/, "");
  const res = await fetch(`${base}/api/register-member`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      credential_id: credentialId,
      public_key: "WEBAUTHN-VERIFIED",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.message || "Cooperative registration failed.");
  }
  const profile = {
    ...loadMemberProfile(),
    member_id: data.member_id,
    credential_id: credentialId,
  };
  saveMemberProfile(profile);
  return data;
}

export async function provisionPodPaths(memberId, credentialId, podProviderUrl) {
  const base = (podProviderUrl || "").replace(/\/$/, "");
  const cleanCredential = String(credentialId || "");
  const slugSource = cleanCredential.replace(/[^a-zA-Z0-9]/g, "x").slice(0, 16);
  const slug = slugSource || `m${Date.now()}`;
  const webId = `${base}/forum-members/${slug}/profile/card#me`;
  const podRoot = `${base}/forum-members/${slug}/`;
  const profile = {
    ...loadMemberProfile(),
    webId,
    podRoot,
    civicContainer: `${podRoot}civic/`,
    slug,
    member_id: memberId,
  };
  saveMemberProfile(profile);
  return { webId, podRoot, civicContainer: profile.civicContainer, slug };
}
