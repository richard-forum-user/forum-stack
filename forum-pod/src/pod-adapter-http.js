/**
 * HTTP Pod adapter. Posts signed bundles to a workerd instance:
 *   - Tauri desktop: same-origin http://127.0.0.1:<port>
 *   - Browser self-hosted Cloudflare: user's workers.dev URL
 *   - Trial: airlock.yourcommunity.forum (opt-in only)
 */

import { loadMemberProfile, loadSigningMeta } from "./member-store.js";
import { signBundle } from "./pod-signing.js";
import { enrichSignedEnvelope } from "./signing-envelope.js";

const STORAGE_KEY = "forum.podProviderUrl";
const SESSION_STORAGE_KEY = "forum.solidSession";

function loadSessionMeta() {
  try {
    const raw =
      typeof localStorage !== "undefined" && localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function httpProviderUrl() {
  const envUrl = (
    import.meta.env.VITE_SERVER_URL ||
    import.meta.env.VITE_POD_PROVIDER_URL ||
    ""
  ).replace(/\/$/, "");
  if (envUrl) {
    try {
      const envHost = new URL(envUrl).host;
      const stored = (
        (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) ||
        ""
      ).replace(/\/$/, "");
      if (stored) {
        try {
          if (new URL(stored).host === envHost) return stored;
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return envUrl;
  }
  const stored = (
    (typeof localStorage !== "undefined" && localStorage.getItem(STORAGE_KEY)) ||
    ""
  ).replace(/\/$/, "");
  if (stored) return stored;
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "";
}

export function setHttpProviderUrl(url) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, (url || "").replace(/\/$/, ""));
}

function resolveSessionId() {
  const session = loadSessionMeta();
  if (session?.sessionId) return session.sessionId;
  const signing = loadSigningMeta();
  if (signing?.sessionId) return signing.sessionId;
  const profile = loadMemberProfile();
  return profile?.sessionId || null;
}

export async function httpPodRpc(verb, path, data = null) {
  const sessionId = resolveSessionId();
  if (!sessionId) {
    throw new Error("Sign in to your Pod first.");
  }
  const payload = { verb, path, data };
  const signed = enrichSignedEnvelope(await signBundle(payload, sessionId));
  const base = httpProviderUrl();
  if (!base) {
    throw new Error("No Pod URL configured. Install the Personal Pod app or set one in Settings.");
  }
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
  const trialStatus = res.headers.get("X-Pod-Trial-Status");
  if (trialStatus && typeof window !== "undefined") {
    try {
      window.dispatchEvent(
        new CustomEvent("pod:trial-status", { detail: { status: trialStatus } })
      );
    } catch {
      /* ignore */
    }
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
