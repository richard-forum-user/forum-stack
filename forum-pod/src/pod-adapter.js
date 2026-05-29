/**
 * Pod transport adapter. The UI calls `podRpc(verb, path, data)` and the
 * adapter routes it to whichever Pod backend is available on this device:
 *
 *   - native (Android / iOS via Capacitor): in-process SQLite, no network.
 *   - desktop (Tauri / browser): HTTP to local workerd or remote Worker.
 *
 * Ownership-by-default: when no explicit Pod URL is configured and the
 * page is loaded from a remote origin (e.g. the trial pod), the user is
 * still routed there; otherwise we prefer same-origin (which on the
 * desktop installer is `http://127.0.0.1:8787`).
 */

import { httpPodRpc, httpProviderUrl } from "./pod-adapter-http.js";

let _adapter = null;
let _detectedPlatform = null;

function detectPlatform() {
  // Only cache confident detections — `browser` may transition to a real
  // native platform once the Capacitor bridge JS finishes injecting on
  // first paint, so we re-probe until we see a non-`browser` answer.
  if (_detectedPlatform && _detectedPlatform !== "browser") return _detectedPlatform;
  if (typeof window === "undefined") {
    _detectedPlatform = "node";
    return _detectedPlatform;
  }
  const cap = window.Capacitor;
  if (cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) {
    _detectedPlatform = cap.getPlatform ? cap.getPlatform() : "capacitor";
    return _detectedPlatform;
  }
  // Defensive fallbacks. Some Capacitor configurations inject the bridge
  // *after* the main bundle evaluates the first import-time const, so we
  // also sniff:
  //   - capacitor:// custom scheme (older iOS builds)
  //   - the WebView served from https://localhost (Capacitor 5+ default
  //     androidScheme/iosScheme + hostname=localhost in capacitor.config.json)
  //   - the Android WebView UA marker `wv` paired with a mobile UA
  if (typeof window.location !== "undefined") {
    const proto = window.location.protocol;
    const host = window.location.hostname;
    if (proto === "capacitor:") return (_detectedPlatform = "capacitor");
    if ((proto === "https:" || proto === "http:") && host === "localhost") {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      if (/\bwv\b/i.test(ua) || /Capacitor/i.test(ua)) {
        _detectedPlatform = /iPhone|iPad|iPod/i.test(ua) ? "ios" : "android";
        return _detectedPlatform;
      }
    }
  }
  if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
    _detectedPlatform = "tauri";
    return _detectedPlatform;
  }
  _detectedPlatform = "browser";
  return _detectedPlatform;
}

export function isNativePodPlatform() {
  const p = detectPlatform();
  return p === "android" || p === "ios" || p === "capacitor" || p === "tauri";
}

async function loadAdapter() {
  if (_adapter) return _adapter;
  const platform = detectPlatform();
  if (platform === "android" || platform === "ios" || platform === "capacitor") {
    const mod = await import("./pod-adapter-capacitor.js");
    _adapter = await mod.createCapacitorAdapter();
    return _adapter;
  }
  _adapter = {
    kind: platform === "tauri" ? "tauri" : "http",
    rpc: httpPodRpc,
    providerUrl: httpProviderUrl,
  };
  return _adapter;
}

export function getPodPlatform() {
  return detectPlatform();
}

export async function getPodProviderUrl() {
  const adapter = await loadAdapter();
  return adapter.providerUrl ? adapter.providerUrl() : "";
}

export async function podRpc(verb, path, data = null) {
  const adapter = await loadAdapter();
  return adapter.rpc(verb, path, data);
}

export function ownershipMode() {
  const platform = detectPlatform();
  if (platform === "android" || platform === "ios" || platform === "capacitor") {
    return "local-device";
  }
  if (platform === "tauri") return "local-desktop";
  if (platform === "browser" && isAirlockWebApp()) {
    return "browser-local";
  }
  const cfg = (
    (typeof window !== "undefined" && localStorage.getItem("forum.podProviderUrl")) ||
    import.meta.env.VITE_SERVER_URL ||
    ""
  ).trim();
  if (!cfg) return "local-desktop";
  try {
    const host = new URL(cfg).host;
    if (host.startsWith("127.0.0.1") || host.startsWith("localhost")) {
      return "local-desktop";
    }
  } catch {
    /* ignore */
  }
  if (cfg.includes("airlock.yourcommunity.forum")) return "browser-local";
  return "self-hosted-cloud";
}

/** True when the PWA is the airlock web app (local-first, no download portal). */
export function isAirlockWebApp() {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  if (host === "airlock.yourcommunity.forum") return true;
  if (import.meta.env.VITE_WEBAPP_LOCAL_FIRST === "1") return true;
  return false;
}
