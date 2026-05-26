const crypto = require("crypto");

function canonicalise(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

function derivePublicKeyObject(publicKeyHex) {
  const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
  const rawKey = Buffer.from(publicKeyHex, "hex");
  const der = Buffer.concat([SPKI_PREFIX, rawKey]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

async function verifyBundle(bundle, lookupPublicKey, replayStore, maxAgeMs = 5 * 60 * 1000) {
  const { payload, sessionId, timestamp, signature, publicKeyHex } = bundle;
  if (!payload || !sessionId || !timestamp || !signature || !publicKeyHex) {
    return { valid: false, reason: "invalid_structure" };
  }
  const age = Date.now() - new Date(timestamp).getTime();
  if (age > maxAgeMs || age < -30000) {
    return { valid: false, reason: "timestamp_expired" };
  }
  if (replayStore && signature) {
    const replayed = await replayStore.checkAndRecord(signature, sessionId);
    if (replayed) {
      return { valid: false, reason: "replay_detected" };
    }
  }
  const registered = await lookupPublicKey(sessionId);
  if (!registered || registered !== publicKeyHex) {
    return { valid: false, reason: "key_not_registered" };
  }
  const canonical = canonicalise({ payload, sessionId, timestamp });
  const pubKeyObj = derivePublicKeyObject(publicKeyHex);
  const valid = crypto.verify(
    null,
    Buffer.from(canonical, "utf8"),
    pubKeyObj,
    Buffer.from(signature, "hex")
  );
  if (!valid) return { valid: false, reason: "signature_invalid" };
  return { valid: true };
}

function registerPodKey(registry, sessionId, publicKeyHex) {
  registry.set(sessionId, publicKeyHex);
}

module.exports = { verifyBundle, registerPodKey, canonicalise };
