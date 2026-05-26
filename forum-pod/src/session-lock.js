/**
 * Idle lock and background panic-wipe for signing keys and session crypto.
 */

import { clearSigningMemory } from "./member-store.js";
import { clearVolatileSigningKey } from "./pod-signing.js";
import { clearSessionCryptoKey } from "./session-crypto.js";
import { clearUnlockToken } from "./unlock-session.js";

const IDLE_MS = 10 * 60 * 1000;
let idleTimer = null;
let installed = false;

export function lockSession() {
  clearVolatileSigningKey();
  clearSigningMemory();
  clearSessionCryptoKey();
  clearUnlockToken();
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    lockSession();
  }, IDLE_MS);
}

export function installSessionLock() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const activityEvents = ["pointerdown", "keydown", "touchstart", "scroll"];
  for (const ev of activityEvents) {
    window.addEventListener(ev, resetIdleTimer, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      lockSession();
    }
  });
  resetIdleTimer();
}
