/**
 * Bind Personal Pod sessionId to the device's Ed25519 public key fingerprint.
 */

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function expectedSessionIdFromPubkey(publicKeyHex) {
  if (!publicKeyHex || typeof publicKeyHex !== 'string') {
    return null;
  }
  const bytes = new TextEncoder().encode(publicKeyHex);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `pubkey:${bytesToHex(digest)}`;
}

export async function sessionIdMatchesPubkey(sessionId, publicKeyHex) {
  const expected = await expectedSessionIdFromPubkey(publicKeyHex);
  return !!expected && sessionId === expected;
}
