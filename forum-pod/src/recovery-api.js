/**
 * Cooperative recovery API client (phrase-based identity recovery).
 */

import { cooperativeBaseUrl } from "./cooperative-export.js";
import { ensurePodSigningKey, signBundle } from "./pod-signing.js";
import { enrichSignedEnvelope } from "./signing-envelope.js";
import {
  deriveRecoveryKeyPair,
  saveRecoveryEnrollment,
  saveRecoveryReceipts,
} from "./recovery-phrase.js";

async function parseJsonResponse(res) {
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Recovery request failed (${res.status}): non-JSON response`);
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || `Recovery request failed (${res.status})`);
  }
  return data;
}

/**
 * Enroll a recovery phrase public key, linking it to the current device signing key.
 */
export async function enrollRecoveryPhrase(recoveryKeyPair) {
  const meta = await ensurePodSigningKey();
  const { signature, timestamp } = await recoveryKeyPair.signMessage({
    action: "enroll",
    recovery_pub_hex: recoveryKeyPair.publicKeyHex,
    device_pubkey_hex: meta.publicKeyHex,
  });

  const payload = {
    verb: "POST",
    path: "/api/recovery/enroll",
    data: {
      recovery_pub_hex: recoveryKeyPair.publicKeyHex,
      recovery_signature: signature,
      recovery_timestamp: timestamp,
    },
  };
  const signed = enrichSignedEnvelope(await signBundle(payload));
  const base = cooperativeBaseUrl();
  const res = await fetch(`${base}/api/recovery/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  const data = await parseJsonResponse(res);
  saveRecoveryEnrollment(recoveryKeyPair.publicKeyHex);
  return data;
}

/**
 * Recover identity using a recovery phrase. Returns receipts + rebind token.
 */
export async function recoverWithPhrase(mnemonic) {
  const recovery = deriveRecoveryKeyPair(mnemonic);
  const base = cooperativeBaseUrl();

  const challengeRes = await fetch(`${base}/api/recovery/challenge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recovery_pub_hex: recovery.publicKeyHex }),
  });
  const challenge = await parseJsonResponse(challengeRes);

  const { signature, timestamp } = await recovery.signMessage({
    action: "recover",
    recovery_pub_hex: recovery.publicKeyHex,
    nonce: challenge.nonce,
  });

  const recoverRes = await fetch(`${base}/api/recovery/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recovery_pub_hex: recovery.publicKeyHex,
      nonce: challenge.nonce,
      recovery_signature: signature,
      recovery_timestamp: timestamp,
    }),
  });
  const data = await parseJsonResponse(recoverRes);
  saveRecoveryEnrollment(recovery.publicKeyHex);
  if (Array.isArray(data.receipts)) {
    saveRecoveryReceipts(data.receipts);
  }
  return { ...data, recoveryPublicKeyHex: recovery.publicKeyHex };
}

/**
 * Re-bind a freshly generated device signing key after recovery.
 */
export async function rebindAfterRecovery({
  recoveryPublicKeyHex,
  rebindToken,
  newPublicKeyHex,
  newSessionId,
}) {
  const base = cooperativeBaseUrl();
  const res = await fetch(`${base}/api/recovery/rebind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recovery_pub_hex: recoveryPublicKeyHex,
      rebind_token: rebindToken,
      new_device_pubkey_hex: newPublicKeyHex,
      new_session_id: newSessionId,
    }),
  });
  return parseJsonResponse(res);
}

export async function fetchDeletionReceipt(receiptId) {
  const base = cooperativeBaseUrl();
  if (!base || !receiptId) return null;
  const res = await fetch(
    `${base}/api/forum/feedback/receipt?receipt_id=${encodeURIComponent(receiptId)}`
  );
  if (!res.ok) return null;
  return res.json();
}

export async function fetchRecoveryStatus(recoveryPubHex) {
  const base = cooperativeBaseUrl();
  if (!base || !recoveryPubHex) return null;
  const res = await fetch(
    `${base}/api/recovery/status?recovery_pub_hex=${encodeURIComponent(recoveryPubHex)}`
  );
  if (!res.ok) return null;
  return res.json();
}
