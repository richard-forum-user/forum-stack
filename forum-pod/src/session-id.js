/**
 * sessionId = pubkey:sha256(publicKeyHex) — binds DO + cooperative ingest to the signing key.
 */

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveBoundSessionId(publicKeyHex) {
  if (!publicKeyHex) return null;
  const bytes = new TextEncoder().encode(publicKeyHex);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `pubkey:${bytesToHex(digest)}`;
}

export function isBoundSessionId(sessionId) {
  return typeof sessionId === "string" && sessionId.startsWith("pubkey:");
}
