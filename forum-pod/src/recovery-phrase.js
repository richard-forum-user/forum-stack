/**
 * BIP39 recovery phrase -> deterministic Ed25519 recovery key.
 * The phrase never leaves the device; only the public key and signatures
 * are sent to the cooperative RecoveryDO.
 */

import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const RECOVERY_KDF_INFO = "forum-recovery-v1";
const RECOVERY_PUB_KEY = "forum.recoveryPubHex";
const RECOVERY_ENROLLED_KEY = "forum.recoveryEnrolled";

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function canonicalise(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

export function generateRecoveryPhrase() {
  return generateMnemonic(wordlist, 128);
}

export function validateRecoveryPhrase(phrase) {
  if (!phrase || typeof phrase !== "string") return false;
  return validateMnemonic(phrase.trim().toLowerCase(), wordlist);
}

function derivePrivateKeyBytes(mnemonic) {
  const seed = mnemonicToSeedSync(mnemonic.trim().toLowerCase());
  return hkdf(sha256, seed.slice(0, 32), undefined, RECOVERY_KDF_INFO, 32);
}

/**
 * Derive the recovery Ed25519 key pair from a BIP39 phrase.
 */
export function deriveRecoveryKeyPair(mnemonic) {
  if (!validateRecoveryPhrase(mnemonic)) {
    throw new Error("Invalid recovery phrase. Check the words and try again.");
  }
  const privateKey = derivePrivateKeyBytes(mnemonic);
  const publicKey = ed25519.getPublicKey(privateKey);
  const publicKeyHex = bytesToHex(publicKey);

  return {
    publicKeyHex,
    async signMessage(messageObj) {
      const timestamp = new Date().toISOString();
      const canonical = canonicalise({ ...messageObj, timestamp });
      const sig = ed25519.sign(new TextEncoder().encode(canonical), privateKey);
      return {
        signature: bytesToHex(sig),
        timestamp,
      };
    },
  };
}

export function saveRecoveryEnrollment(publicKeyHex) {
  if (!publicKeyHex) return;
  localStorage.setItem(RECOVERY_PUB_KEY, publicKeyHex);
  localStorage.setItem(RECOVERY_ENROLLED_KEY, "1");
}

export function loadRecoveryEnrollment() {
  const enrolled = localStorage.getItem(RECOVERY_ENROLLED_KEY) === "1";
  const publicKeyHex = localStorage.getItem(RECOVERY_PUB_KEY) || null;
  return { enrolled, publicKeyHex };
}

export function clearRecoveryEnrollment() {
  localStorage.removeItem(RECOVERY_PUB_KEY);
  localStorage.removeItem(RECOVERY_ENROLLED_KEY);
}

export const RECOVERY_RECEIPTS_KEY = "forum.recoveryReceipts";

export function saveRecoveryReceipts(receipts) {
  try {
    localStorage.setItem(RECOVERY_RECEIPTS_KEY, JSON.stringify(receipts || []));
  } catch {
    /* storage full */
  }
}

export function loadRecoveryReceipts() {
  try {
    const raw = localStorage.getItem(RECOVERY_RECEIPTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
