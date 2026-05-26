/**
 * Attach unlock token + device credential id to signed API envelopes.
 */

import { loadMemberProfile } from "./member-store.js";
import { getUnlockToken } from "./unlock-session.js";

export function enrichSignedEnvelope(signed) {
  const profile = loadMemberProfile();
  const unlock = getUnlockToken();
  return {
    ...signed,
    deviceCredentialId: profile?.credential_id || null,
    ...(unlock ? { unlockToken: unlock } : {}),
  };
}
