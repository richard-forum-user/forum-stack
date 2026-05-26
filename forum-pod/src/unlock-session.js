/**
 * In-memory unlock token from server-verified WebAuthn (never persisted).
 */

let cachedUnlockToken = null;
let cachedCredentialId = null;
let cachedPilotUnlock = false;

export function getUnlockToken() {
  if (!cachedUnlockToken) return null;
  if (Date.now() > cachedUnlockToken.expiresAtMs) {
    clearUnlockToken();
    return null;
  }
  return cachedUnlockToken;
}

export function setUnlockToken(token, credentialId) {
  cachedUnlockToken = token;
  cachedCredentialId = credentialId || token?.credentialId || null;
  cachedPilotUnlock = false;
}

export function setPilotUnlock(credentialId) {
  cachedUnlockToken = null;
  cachedCredentialId = credentialId || null;
  cachedPilotUnlock = true;
}

export function clearUnlockToken() {
  cachedUnlockToken = null;
  cachedCredentialId = null;
  cachedPilotUnlock = false;
}

export function getUnlockCredentialId() {
  return cachedCredentialId;
}

export function hasActiveUnlock() {
  return !!getUnlockToken() || cachedPilotUnlock;
}
