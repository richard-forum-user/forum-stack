/**
 * Server-verified WebAuthn (Phase 3). Uses @simplewebauthn/server.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

function corsJson(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      ...extra,
    },
  });
}

function bufferToBase64url(buffer) {
  if (typeof buffer === 'string') return buffer;
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(base64url) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const b64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function parseAllowedOrigins(env) {
  const csv = env.WEBAUTHN_ALLOWED_ORIGINS || '';
  return csv
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

/**
 * Pick the RP config for a request. The page that calls this Worker may live
 * on a different origin than the Worker itself (e.g. PWA at
 * https://airlock.yourcommunity.forum, Worker at
 * https://secure-worker.forum-community.workers.dev). WebAuthn requires the
 * `rp.id` returned to the browser to equal-or-be-a-suffix of the page origin,
 * so we accept the page origin from the request body when it is on the
 * `WEBAUTHN_ALLOWED_ORIGINS` list, and use its hostname as the RP ID.
 */
export function pickRpConfig(request, env, body) {
  const url = new URL(request.url);
  const allowed = parseAllowedOrigins(env);
  const candidate =
    body && typeof body.origin === 'string'
      ? body.origin.trim().replace(/\/$/, '')
      : null;
  if (candidate && allowed.includes(candidate)) {
    try {
      const parsed = new URL(candidate);
      return {
        rpId: parsed.hostname,
        origin: `${parsed.protocol}//${parsed.host}`,
        rpName: env.WEBAUTHN_RP_NAME || 'Forum Personal Pod',
      };
    } catch {
      /* fall through to fallback */
    }
  }
  return {
    rpId: env.WEBAUTHN_RP_ID || url.hostname,
    origin: env.WEBAUTHN_ORIGIN || `${url.protocol}//${url.host}`,
    rpName: env.WEBAUTHN_RP_NAME || 'Forum Personal Pod',
  };
}

export function getRpConfig(request, env) {
  return pickRpConfig(request, env, null);
}

async function ensureWebAuthnSchema(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        challenge TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        rp_id TEXT,
        origin TEXT
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        public_key_cose TEXT NOT NULL,
        sign_count INTEGER NOT NULL DEFAULT 0,
        registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `),
  ]);
  for (const stmt of [
    `ALTER TABLE webauthn_challenges ADD COLUMN rp_id TEXT`,
    `ALTER TABLE webauthn_challenges ADD COLUMN origin TEXT`,
  ]) {
    try {
      await db.prepare(stmt).run();
    } catch {
      /* column already exists */
    }
  }
}

async function pruneChallenges(db) {
  const cutoff = Date.now();
  await db.prepare(`DELETE FROM webauthn_challenges WHERE expires_at_ms < ?`).bind(cutoff).run();
}

async function storeChallenge(db, challenge, kind, rpId, origin) {
  await pruneChallenges(db);
  const expires = Date.now() + CHALLENGE_TTL_MS;
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (challenge, kind, expires_at_ms, rp_id, origin)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(challenge, kind, expires, rpId || null, origin || null)
    .run();
}

async function consumeChallenge(db, challenge, kind) {
  const row = await db
    .prepare(
      `SELECT challenge, kind, expires_at_ms, rp_id, origin
         FROM webauthn_challenges WHERE challenge = ? AND kind = ?`
    )
    .bind(challenge, kind)
    .first();
  if (!row) return null;
  await db.prepare(`DELETE FROM webauthn_challenges WHERE challenge = ?`).bind(challenge).run();
  if (Date.now() > row.expires_at_ms) return null;
  return { rpId: row.rp_id || null, origin: row.origin || null };
}

async function loadCredential(db, credentialId) {
  return db
    .prepare(
      `SELECT credential_id, public_key_cose, sign_count FROM webauthn_credentials WHERE credential_id = ?`
    )
    .bind(credentialId)
    .first();
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {URL} url
 * @param {function} issueUnlockToken - (env, credentialId) => Promise<object|null>
 */
export async function handleWebAuthnRoute(request, env, url, issueUnlockToken) {
  if (!env.DB) {
    return corsJson({ error: 'D1 not configured' }, 500);
  }
  await ensureWebAuthnSchema(env.DB);

  const path = url.pathname;

  if (path === '/api/webauthn/register/challenge' && request.method === 'POST') {
    let challengeBody = {};
    try {
      challengeBody = await request.json();
    } catch {
      /* empty body ok */
    }
    const { rpId, origin, rpName } = pickRpConfig(request, env, challengeBody);
    const userID = crypto.getRandomValues(new Uint8Array(16));
    const options = await generateRegistrationOptions({
      rpName,
      rpID: rpId,
      userName: `member-${Date.now()}`,
      userDisplayName: 'Forum Member',
      userID,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    });
    await storeChallenge(env.DB, options.challenge, 'register', rpId, origin);
    return corsJson({
      challenge: options.challenge,
      rpId,
      timeout: options.timeout,
      options,
    });
  }

  if (path === '/api/webauthn/register/verify' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return corsJson({ error: 'invalid_json' }, 400);
    }
    const expectedChallenge = body.expectedChallenge;
    if (!expectedChallenge) {
      return corsJson({ error: 'expectedChallenge required' }, 400);
    }
    const consumed = await consumeChallenge(env.DB, expectedChallenge, 'register');
    if (!consumed) {
      return corsJson({ error: 'challenge_expired' }, 401);
    }
    const fallback = pickRpConfig(request, env, body);
    const expectedRPID = consumed.rpId || fallback.rpId;
    const expectedOrigin = consumed.origin || fallback.origin;
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin,
        expectedRPID,
      });
    } catch (e) {
      return corsJson({ error: 'verification_failed', reason: e.message }, 401);
    }
    if (!verification.verified || !verification.registrationInfo) {
      return corsJson({ error: 'not_verified' }, 401);
    }
    const { credential, credentialDeviceType } = verification.registrationInfo;
    const credentialId = bufferToBase64url(credential.id);
    const publicKeyCose = bufferToBase64url(credential.publicKey);
    await env.DB
      .prepare(
        `INSERT INTO webauthn_credentials (credential_id, public_key_cose, sign_count)
         VALUES (?, ?, ?)
         ON CONFLICT(credential_id) DO UPDATE SET
           public_key_cose = excluded.public_key_cose`
      )
      .bind(credentialId, publicKeyCose, credential.counter || 0)
      .run();
    const unlockToken = await issueUnlockToken(env, credentialId);
    return corsJson({
      success: true,
      credentialId,
      credentialDeviceType,
      unlockToken,
    });
  }

  if (path === '/api/webauthn/auth/challenge' && request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* empty body ok */
    }
    const { rpId, origin } = pickRpConfig(request, env, body);
    const credentialId = body.credentialId;
    let allowCredentials;
    if (credentialId) {
      const row = await loadCredential(env.DB, credentialId);
      if (!row) {
        return corsJson({ error: 'unknown_credential' }, 404);
      }
      allowCredentials = [
        {
          id: credentialId,
          type: 'public-key',
        },
      ];
    }
    const options = await generateAuthenticationOptions({
      rpID: rpId,
      userVerification: 'required',
      allowCredentials,
    });
    await storeChallenge(env.DB, options.challenge, 'auth', rpId, origin);
    return corsJson({
      challenge: options.challenge,
      rpId,
      timeout: options.timeout,
      options,
    });
  }

  if (path === '/api/webauthn/auth/verify' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return corsJson({ error: 'invalid_json' }, 400);
    }
    const expectedChallenge = body.expectedChallenge;
    if (!expectedChallenge) {
      return corsJson({ error: 'expectedChallenge required' }, 400);
    }
    const consumed = await consumeChallenge(env.DB, expectedChallenge, 'auth');
    if (!consumed) {
      return corsJson({ error: 'challenge_expired' }, 401);
    }
    const fallback = pickRpConfig(request, env, body);
    const expectedRPID = consumed.rpId || fallback.rpId;
    const expectedOrigin = consumed.origin || fallback.origin;
    const credentialId =
      body.id || body.rawId || (body.response && body.id);
    const stored = await loadCredential(env.DB, credentialId);
    if (!stored) {
      return corsJson({ error: 'unknown_credential' }, 401);
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body,
        expectedChallenge,
        expectedOrigin,
        expectedRPID,
        credential: {
          id: stored.credential_id,
          publicKey: base64urlToBuffer(stored.public_key_cose),
          counter: stored.sign_count || 0,
        },
      });
    } catch (e) {
      return corsJson({ error: 'verification_failed', reason: e.message }, 401);
    }
    if (!verification.verified) {
      return corsJson({ error: 'not_verified' }, 401);
    }
    const newCount = verification.authenticationInfo?.newCounter ?? stored.sign_count;
    await env.DB
      .prepare(`UPDATE webauthn_credentials SET sign_count = ? WHERE credential_id = ?`)
      .bind(newCount, stored.credential_id)
      .run();
    const unlockToken = await issueUnlockToken(env, stored.credential_id);
    return corsJson({ success: true, credentialId: stored.credential_id, unlockToken });
  }

  return null;
}

export async function credentialExists(db, credentialId) {
  if (!db || !credentialId) return false;
  await ensureWebAuthnSchema(db);
  const row = await loadCredential(db, credentialId);
  return !!row;
}
