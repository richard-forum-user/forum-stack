import { POLICY_VERSION } from "./civic-vocab.js";
import { postCooperativeExport, cooperativeBaseUrl } from "./cooperative-export.js";
import { clearMemberProfile, loadMemberProfile, saveMemberProfile } from "./member-store.js";
import { getPodPlatform, isNativePodPlatform, isAirlockWebApp } from "./pod-adapter.js";
import {
  deleteAllAssistantConversationsFromPod,
  deleteAssistantConversationFromPod,
  writeAssistantMessageToPod,
  writeBehaviorToPod,
  writeCivicSubmissionToPod,
  writeJournalEntryToPod,
  writeTraitToPod,
} from "./solid-pod-write.js";
import {
  listPodRows,
  syncAssistantConversationFromPod,
  syncBehaviorsFromPod,
  syncJournalEntriesFromPod,
  syncPodToDuckDB,
  syncTraitsFromPod,
} from "./solid-sync.js";
import {
  authenticateDevice,
  buildLocalDeviceProfile,
  provisionPodPaths,
  registerDevice,
  registerWithCooperative,
  unlockWithWebAuthn,
  webAuthnSupported,
} from "./webauthn-member.js";
import { setPilotUnlock } from "./unlock-session.js";
import { ensurePodSigningKey, regenerateSigningKey, signBundle } from "./pod-signing.js";
import {
  getPodProviderUrl,
  getSolidSession,
  handleSolidRedirect,
  podRpc,
  setPodProviderUrl,
  solidLogin,
  solidLogout,
} from "./solid-session.js";

export {
  POLICY_VERSION,
  authenticateDevice,
  clearMemberProfile,
  deleteAllAssistantConversationsFromPod,
  deleteAssistantConversationFromPod,
  getPodProviderUrl,
  getSolidSession,
  handleSolidRedirect,
  loadMemberProfile,
  listPodRows,
  postCooperativeExport,
  provisionPodPaths,
  registerDevice,
  registerWithCooperative,
  setPodProviderUrl,
  signBundle,
  solidLogin,
  solidLogout,
  syncAssistantConversationFromPod,
  syncBehaviorsFromPod,
  syncJournalEntriesFromPod,
  syncPodToDuckDB,
  syncTraitsFromPod,
  unlockWithWebAuthn,
  webAuthnSupported,
  writeAssistantMessageToPod,
  writeBehaviorToPod,
  writeCivicSubmissionToPod,
  writeJournalEntryToPod,
  writeTraitToPod,
};

function isNativePlatform() {
  if (isNativePodPlatform()) return true;
  // Defensive fallback — bundle context heuristics. See pod-adapter.js for
  // why we don't trust `getPodPlatform()` alone here.
  if (typeof window !== "undefined" && window.location) {
    const { protocol, hostname } = window.location;
    if (protocol === "capacitor:" || protocol === "file:") return true;
    if (
      (protocol === "http:" || protocol === "https:") &&
      (hostname === "localhost" || hostname === "127.0.0.1")
    ) {
      const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
      if (/\bwv\b|Capacitor|Tauri/i.test(ua)) return true;
    }
  }
  const p = getPodPlatform();
  return p === "android" || p === "ios" || p === "capacitor" || p === "tauri";
}

/**
 * Local-only Pod creation for native (Capacitor) installs. H16 architecture:
 * the Pod lives in on-device SQLite, the cooperative airlock is not in the
 * loop, and there is no platform-issued passkey to verify against. We
 * generate a local device credential, derive an in-process Ed25519 signing
 * key, and provision a synthetic webId so the rest of the app (which keys
 * everything by sessionId, not webId) keeps working.
 */
async function createLocalPodFlow() {
  const { credentialId } = buildLocalDeviceProfile();
  const meta = await ensurePodSigningKey();
  const sessionId = meta.sessionId;
  const slug = (credentialId.replace(/[^a-zA-Z0-9]/g, "x") || `m${Date.now()}`).slice(0, 24);
  const podRoot = `local://forum-personal-pod/forum-members/${slug}/`;
  const webId = `${podRoot}profile/card#me`;
  const profile = {
    ...loadMemberProfile(),
    credential_id: credentialId,
    webId,
    podRoot,
    civicContainer: `${podRoot}civic/`,
    sessionId,
    slug,
  };
  saveMemberProfile(profile);
  setPilotUnlock(credentialId); // marks hasActiveUnlock() true on the device
  await solidLogin(webId);
  if (!isAirlockWebApp()) {
    try {
      await podRpc("PROVISION", "/", { webId, podRoot });
    } catch (e) {
      throw new Error(`On-device Pod could not be provisioned: ${e.message}`, { cause: e });
    }
  }
  const coop = cooperativeBaseUrl();
  if (coop) {
    try {
      await fetch(`${coop}/api/register-signing-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          web_id: webId,
          public_key_hex: meta.publicKeyHex,
        }),
      });
    } catch (e) {
      console.warn("[createLocalPodFlow] cooperative key registration failed:", e);
    }
  }
  return loadMemberProfile();
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

/**
 * A "standalone" pod provider hosts its own Durable Object and has no separate
 * cooperative to register against (the airlock trial pod is the canonical
 * example). In that topology the provider host equals the cooperative host, or
 * no cooperative is configured at all. Posting to /api/register-member on such
 * a worker returns `route_not_found`, so we must skip the cooperative-managed
 * registration entirely and provision directly against the provider.
 */
function isStandalonePodProvider(podBase, coop) {
  if (!coop) return true;
  return sameHost(podBase, coop);
}

/**
 * Standalone / trial pod creation (browser). WebAuthn-registers the device
 * against the provider itself, derives the signing key, provisions pod paths,
 * and PROVISIONs the DO — no cooperative `register-member` /
 * `register-signing-key` calls (those routes don't exist on a standalone
 * worker and were the source of the browser `route_not_found`).
 */
async function createStandalonePodFlow(podBase) {
  const { credentialId } = await registerDevice(podBase, podBase);
  await provisionPodPaths(null, credentialId, podBase);
  await ensurePodSigningKey();
  const profile = loadMemberProfile();
  await solidLogin(profile.webId);
  try {
    await podRpc("PROVISION", "/", {
      webId: profile.webId,
      podRoot: profile.podRoot,
    });
  } catch (e) {
    throw new Error(`Pod provider unreachable: ${e.message}`, { cause: e });
  }
  return loadMemberProfile();
}

export async function createPodFlow({ podProviderUrl: _podProviderUrl, cooperativeUrl }) {
  if (isNativePlatform() || isAirlockWebApp()) {
    // Mobile install and the airlock web app both use a local-first Pod:
    // data lives on-device (SQLite or IndexedDB). Cloud sync is opt-in only.
    return createLocalPodFlow();
  }
  const podBase = getPodProviderUrl();
  setPodProviderUrl(podBase);
  const coop = (cooperativeUrl || "").trim().replace(/\/$/, "");
  if (isStandalonePodProvider(podBase, coop)) {
    return createStandalonePodFlow(podBase);
  }
  const { credentialId } = await registerDevice(podBase, cooperativeUrl);
  const reg = await registerWithCooperative(credentialId, cooperativeUrl);
  await provisionPodPaths(reg.member_id, credentialId, podBase);
  const profile = loadMemberProfile();
  const meta = await ensurePodSigningKey();
  const sessionId = meta.sessionId;
  if (cooperativeUrl) {
    try {
      await fetch(`${cooperativeUrl.replace(/\/$/, "")}/api/register-signing-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          web_id: profile.webId,
          public_key_hex: meta.publicKeyHex,
        }),
      });
    } catch (e) {
      console.warn("[createPodFlow] cooperative key registration failed:", e);
    }
  }
  await solidLogin(profile.webId);
  try {
    await podRpc("PROVISION", "/", {
      webId: profile.webId,
      podRoot: profile.podRoot,
    });
  } catch (e) {
    throw new Error(`Pod provider unreachable: ${e.message}`, { cause: e });
  }
  return loadMemberProfile();
}

export async function unlockPodFlow(cooperativeUrl) {
  const profile = loadMemberProfile();
  if (!profile?.credential_id) {
    throw new Error("No device credential. Create your Pod first.");
  }
  const podBase = getPodProviderUrl();
  const coop = (cooperativeUrl || "").trim().replace(/\/$/, "");
  // A device-owned Pod (native, local-credential, or a standalone/trial
  // browser Pod) is unlocked by re-arming the locally-persisted signing key —
  // there is no remote passkey wrap to authenticate against.
  const isLocalCredential =
    isNativePlatform() ||
    isAirlockWebApp() ||
    String(profile.auth_mode || "").startsWith("local-") ||
    String(profile.credential_id || "").startsWith("local-");
  const isStandaloneBrowser = !isLocalCredential && isStandalonePodProvider(podBase, coop);
  const usingPilotFallback = String(profile.auth_mode || "").startsWith("pilot");
  if (isLocalCredential || isStandaloneBrowser) {
    setPilotUnlock(profile.credential_id);
    let meta;
    try {
      // Restores the signing key from local persistence if present.
      meta = await ensurePodSigningKey();
    } catch {
      // Key was never persisted (older build) and is unrecoverable. For a
      // device-owned Pod, regenerate so the member isn't dead-ended; the
      // sessionId rotates and the Pod re-provisions on next write.
      meta = await regenerateSigningKey();
      const refreshed = loadMemberProfile() || profile;
      saveMemberProfile({ ...refreshed, sessionId: meta.sessionId });
    }
    const coopBase = (coop || cooperativeBaseUrl()).replace(/\/$/, "");
    if (coopBase && meta?.publicKeyHex) {
      try {
        await fetch(`${coopBase}/api/register-signing-key`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: meta.sessionId,
            web_id: profile.webId,
            public_key_hex: meta.publicKeyHex,
          }),
        });
      } catch (e) {
        console.warn("[unlockPodFlow] cooperative key registration failed:", e);
      }
    }
  } else if (!usingPilotFallback) {
    try {
      await unlockWithWebAuthn(cooperativeUrl);
    } catch (e) {
      if (!String(profile?.credential_id || "").startsWith("pilot")) throw e;
    }
  }
  await solidLogin(profile?.webId);
  return loadMemberProfile() || profile;
}
