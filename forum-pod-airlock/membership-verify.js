/**
 * ES256 JWT verification for cooperative membership tokens (Web Crypto API).
 * JWKS is fetched once from the co-op and pinned in pod_meta via the DO.
 */

const META_JWKS = 'coop_membership_jwks';
const META_JWT_RAW = 'membership_jwt_raw';
const META_JWT_CLAIMS = 'membership_jwt_claims';

export { META_JWKS, META_JWT_RAW, META_JWT_CLAIMS };

function base64UrlToBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function decodeJsonPart(b64url) {
  const bytes = base64UrlToBytes(b64url);
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text);
}

export function pickJwkByKid(jwks, kid) {
  const keys = jwks?.keys || [];
  return keys.find((k) => k.kid === kid) || keys[0] || null;
}

export async function verifyJwtEs256(compactJwt, jwks, expectedIss) {
  const parts = String(compactJwt || '').split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed_jwt' };
  }
  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  let payload;
  try {
    header = decodeJsonPart(headerB64);
    payload = decodeJsonPart(payloadB64);
  } catch {
    return { ok: false, reason: 'invalid_jwt_encoding' };
  }
  if (header.alg !== 'ES256') {
    return { ok: false, reason: 'unsupported_alg' };
  }
  const jwk = pickJwkByKid(jwks, header.kid);
  if (!jwk) {
    return { ok: false, reason: 'jwks_key_not_found' };
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = base64UrlToBytes(sigB64);
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    sig,
    data
  );
  if (!valid) {
    return { ok: false, reason: 'bad_signature' };
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = payload.exp ?? payload.expires_at;
  const nbf = payload.nbf ?? payload.issued_at ?? payload.iat;
  if (expectedIss && payload.iss !== expectedIss) {
    return { ok: false, reason: 'iss_mismatch' };
  }
  if (exp != null && now >= Number(exp)) {
    return { ok: false, reason: 'expired' };
  }
  if (nbf != null && now < Number(nbf)) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  const memberClass = payload.class;
  if (!['worker', 'consumer', 'community'].includes(memberClass)) {
    return { ok: false, reason: 'invalid_class' };
  }
  const memberHash = payload.member_hash || payload.sub;
  if (!memberHash) {
    return { ok: false, reason: 'missing_member_hash' };
  }
  return {
    ok: true,
    header,
    payload: {
      ...payload,
      member_hash: memberHash,
      class: memberClass,
      expires_at: exp,
      issued_at: payload.issued_at ?? payload.iat,
    },
  };
}

export async function fetchJwks(coopBaseUrl) {
  const base = String(coopBaseUrl || '').replace(/\/$/, '');
  const res = await fetch(`${base}/membership/jwks.json`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`jwks_fetch_failed:${res.status}`);
  }
  return res.json();
}
