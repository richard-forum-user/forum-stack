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

import { clearSigningMemory, loadMemberProfile, loadSigningMeta, saveMemberProfile } from "./member-store.js";
import { ensurePodSigningKey, signBundle } from "./pod-signing.js";
import { enrichSignedEnvelope } from "./signing-envelope.js";
import { clearUnlockToken, hasActiveUnlock } from "./unlock-session.js";

const SESSION_KEY = "forum.solidSession";

/**
 * Pod RPC base URL. We always prefer the build-time VITE_SERVER_URL
 * (the Cloudflare Worker that owns the PersonalPodDO binding) because
 * not every host that serves the PWA also routes /api/pod/* to that
 * Worker. For example `airlock.yourcommunity.forum` may have a
 * Cloudflare Worker Route pattern of `airlock.yourcommunity.forum/pod*`
 * that matches the static assets but does not match /api/pod, so
 * same-origin RPCs would 404 before reaching the Worker.
 *
 * `forum.podProviderUrl` in localStorage is only honoured if the
 * value still points at the configured Worker host — anything else is
 * treated as stale (e.g. a leftover https://pod.yourcommunity.forum
 * from the old Solid/CSS build) and ignored.
 */
export function getPodProviderUrl() {
  const fromEnv = (
    import.meta.env.VITE_SERVER_URL ||
    import.meta.env.VITE_POD_PROVIDER_URL ||
    ""
  ).replace(/\/$/, "");
  if (fromEnv) {
    try {
      const envHost = new URL(fromEnv).host;
      const stored = (localStorage.getItem("forum.podProviderUrl") || "").replace(
        /\/$/,
        ""
      );
      if (stored) {
        try {
          if (new URL(stored).host === envHost) return stored;
        } catch {
          /* malformed override — fall through to env */
        }
      }
    } catch {
      /* malformed VITE_SERVER_URL — fall through to literal value */
    }
    return fromEnv;
  }
  return (
    (localStorage.getItem("forum.podProviderUrl") || "").replace(/\/$/, "") ||
    (typeof window !== "undefined" ? window.location.origin : "")
  );
}

export function setPodProviderUrl(url) {
  localStorage.setItem(
    "forum.podProviderUrl",
    (url || "").replace(/\/$/, "")
  );
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
 * Resolve the session id we sign Pod RPCs with. We prefer `webId` so
 * the value is stable once the user has been provisioned, falling back
 * to `credential_id` for pre-provision calls.
 */
function resolveSessionId() {
  const meta = loadSolidSessionMeta();
  if (meta?.sessionId) return meta.sessionId;
  const signing = loadSigningMeta();
  if (signing?.sessionId) return signing.sessionId;
  const profile = loadMemberProfile();
  return profile?.sessionId || null;
}

/**
 * Send a signed Pod RPC to the Worker, which forwards to the user's
 * PersonalPodDO.
 *
 *   verb: "PUT" | "LIST" | "GET" | "PROVISION"
 *   path: "/civic/submissions/abc", "/journal/raw", etc.
 *   data: the JSON body to PUT (or empty for GET/LIST/PROVISION)
 */
export async function podRpc(verb, path, data = null) {
  const sessionId = resolveSessionId();
  if (!sessionId) {
    throw new Error("Sign in to your Pod first.");
  }
  const payload = { verb, path, data };
  const signed = enrichSignedEnvelope(await signBundle(payload, sessionId));
  const base = getPodProviderUrl();
  const url = `${base}/api/pod${path === "/" ? "" : path}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
    });
  } catch (e) {
    throw new Error(`Pod RPC network error for ${url}: ${e.message}`, { cause: e });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* tolerate non-JSON */
  }
  if (!res.ok) {
    const reason = body?.reason || body?.error || res.statusText;
    throw new Error(`Pod RPC ${verb} ${path} failed (${res.status}): ${reason}`);
  }
  return body;
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
