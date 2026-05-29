/**
 * Salted member pseudonym for D1 (reduces cross-cycle linkability when salt rotates).
 */

function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function loadMemberHashSalt(db, env) {
  if (env?.CIVIC_CYCLE_SALT) return env.CIVIC_CYCLE_SALT;
  if (env?.MEMBER_HASH_SALT) return env.MEMBER_HASH_SALT;
  if (!db) return '';
  try {
    const row = await db
      .prepare(`SELECT value FROM civic_cycle_config WHERE key = 'member_hash_salt'`)
      .first();
    return row?.value || '';
  } catch {
    return '';
  }
}

export async function memberHashFromPublicKey(publicKeyHex, env, saltOverride) {
  if (!publicKeyHex) return null;
  const salt = saltOverride ?? env?.MEMBER_HASH_SALT ?? env?.CIVIC_CYCLE_SALT ?? '';
  const material = `${salt}:${publicKeyHex}`;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
  return bytesToHex(new Uint8Array(hash));
}
