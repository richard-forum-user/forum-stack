import { POLICY_VERSION } from "./civic-vocab.js";
import { postCooperativeExport } from "./cooperative-export.js";
import { clearMemberProfile, loadMemberProfile } from "./member-store.js";
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
  provisionPodPaths,
  registerDevice,
  registerWithCooperative,
  unlockWithWebAuthn,
  webAuthnSupported,
} from "./webauthn-member.js";
import { ensurePodSigningKey, signBundle } from "./pod-signing.js";
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

export async function createPodFlow({ podProviderUrl: _podProviderUrl, cooperativeUrl }) {
  const podBase = getPodProviderUrl();
  setPodProviderUrl(podBase);
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
  const usingPilotFallback = String(profile?.auth_mode || "").startsWith("pilot");
  if (!usingPilotFallback) {
    try {
      await unlockWithWebAuthn(cooperativeUrl);
    } catch (e) {
      if (!String(profile?.credential_id || "").startsWith("pilot")) throw e;
    }
  }
  await solidLogin(profile?.webId);
  return profile;
}
