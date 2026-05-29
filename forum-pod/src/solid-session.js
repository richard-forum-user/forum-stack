/**
 * Pod session + signed RPC transport.
 *
 * After the DO pivot (Handover 8) there is no Solid-OIDC redirect and
 * no Community Solid Server. Each device:
 *
 *   1. Holds a credential (WebAuthn passkey or pilot-device-id fallback).
 *   2. Generates a per-session Ed25519 key (`pod-signing.js`).
 *   3. Signs every Pod RPC and POSTs it to `/api/pod/*` on the Worker.
 *   4. The Worker forwards the bundle to the user's PersonalPodDO,
 *      which TOFU-registers the public key on first request and
 *      verifies it on every subsequent one.
 *
 * The file name is kept ("solid-session.js") so importers don't need
 * to change — the surface is identical except that `solidLogin` is now
 * synchronous (no redirect) and `fetchWithAuth` returns a signed-RPC
 * Response.
 */

import { clearSigningMemory, loadMemberProfile, saveMemberProfile } from "./member-store.js";
import { ensurePodSigningKey } from "./pod-signing.js";
import { clearUnlockToken, hasActiveUnlock } from "./unlock-session.js";
import { podRpc as adapterPodRpc, getPodPlatform, ownershipMode } from "./pod-adapter.js";
import { httpProviderUrl, setHttpProviderUrl } from "./pod-adapter-http.js";

const SESSION_KEY = "forum.solidSession";

/**
 * Pod URL for HTTP transports. On Capacitor (mobile) the Pod runs
 * in-process so this returns "local://forum_personal_pod" purely for
 * display; the RPC layer (`pod-adapter.js`) never calls it then.
 */
export function getPodProviderUrl() {
  const platform = getPodPlatform();
  if (platform === "android" || platform === "ios" || platform === "capacitor") {
    return "local://forum_personal_pod";
  }
  return httpProviderUrl();
}

export function setPodProviderUrl(url) {
  setHttpProviderUrl(url);
}

export function getPodOwnershipMode() {
  return ownershipMode();
}

export function getPodRuntimePlatform() {
  return getPodPlatform();
}

export function loadSolidSessionMeta() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveSolidSessionMeta(meta) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(meta));
}

export function clearSolidSessionMeta() {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * OIDC redirect handling is gone. Kept as a no-op so boot code that
 * still calls `handleSolidRedirect()` does not crash.
 */
export async function handleSolidRedirect() {
  /* no-op after DO pivot */
}

/**
 * Stamp the session as logged-in. Requires a device credential to
 * already exist (from `registerDevice`). Generates / loads the signing
 * key for this session id.
 */
export async function solidLogin(webId) {
  const profile = loadMemberProfile();
  if (!profile?.credential_id) {
    throw new Error("No device credential. Create your Pod first.");
  }
  const meta = await ensurePodSigningKey();
  const sessionId = meta.sessionId;
  if (webId && profile.webId !== webId) {
    saveMemberProfile({ ...profile, webId, sessionId });
  } else if (profile.sessionId !== sessionId) {
    saveMemberProfile({ ...profile, sessionId });
  }
  saveSolidSessionMeta({
    webId: webId || profile.webId || null,
    sessionId,
    loggedInAt: new Date().toISOString(),
  });
}

export async function solidLogout() {
  clearSolidSessionMeta();
  clearUnlockToken();
  clearSigningMemory();
}

export function getSolidSession() {
  const meta = loadSolidSessionMeta();
  const profile = loadMemberProfile();
  return {
    isLoggedIn: !!(meta && profile?.credential_id && hasActiveUnlock()),
    webId: meta?.webId || profile?.webId || null,
  };
}

/**
 * Send a Pod RPC. Routed through `pod-adapter.js` so the same UI works
 * on desktop (HTTP to workerd), mobile (in-process Capacitor SQLite),
 * and the trial pod (HTTP to airlock.yourcommunity.forum).
 *
 *   verb: "PUT" | "LIST" | "GET" | "PROVISION"
 *   path: "/civic/submissions/abc", "/journal/raw", etc.
 *   data: the JSON body to PUT (or empty for GET/LIST/PROVISION)
 */
export async function podRpc(verb, path, data = null) {
  return adapterPodRpc(verb, path, data);
}

/**
 * Backwards-compatible HTTP-ish wrapper. Solid-era callers passed
 * `(url, init)`; we translate that to `podRpc` so any straggler code
 * that imports `fetchWithAuth` continues to function.
 */
export async function fetchWithAuth(url, init = {}) {
  const u = typeof url === "string" ? url : String(url || "");
  const verb = (init.method || "GET").toUpperCase();
  const apiMatch = u.match(/\/api\/pod(\/.*)$/);
  const memberMatch = u.match(/\/forum-members\/[^/]+(\/.*)$/);
  const path = apiMatch
    ? apiMatch[1]
    : memberMatch
    ? memberMatch[1]
    : "/";
  let data = null;
  if (init.body) {
    try {
      data =
        typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch {
      data = init.body;
    }
  }
  const mappedVerb = verb === "GET" ? "LIST" : verb;
  const body = await podRpc(mappedVerb, path, data);
  return new Response(JSON.stringify(body ?? {}), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function provisionPodIfNeeded() {
  return loadMemberProfile();
}

export function isSolidEnabled() {
  return true;
}
