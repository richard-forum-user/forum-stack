/**
 * Cooperative membership issuance (Turnstile + Stripe Identity + ES256 JWT).
 * Mounted at /membership/* on coop.yourcommunity.forum.
 */

import { secretsEqual } from './secret-compare.js';

const MEMBER_CLASSES = ['worker', 'consumer', 'community'];

function corsJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJsonPart(obj) {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(value))
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const MAX_JSON_BODY = 16_384;
const PRIVATE_JWK_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];

function base64UrlToBytes(b64url) {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function decodeJsonPart(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));
}

async function readBoundedText(request, maxChars = MAX_JSON_BODY) {
  const text = await request.text();
  if (text.length > maxChars) {
    return { error: corsJson({ error: 'payload_too_large' }, 413) };
  }
  return { text };
}

function publicJwk(jwk) {
  const copy = { ...jwk };
  for (const field of [...PRIVATE_JWK_FIELDS, 'key_ops', 'ext', 'use']) delete copy[field];
  return copy;
}

async function verifyMembershipJwt(token, env) {
  const jwkStr = env.MEMBERSHIP_PUBLIC_KEY_JWK;
  if (!jwkStr) return { ok: false, reason: 'membership_not_configured' };
  const compact = String(token || '');
  const parts = compact.split('.');
  if (parts.length !== 3 || compact.length > 4096) {
    return { ok: false, reason: 'malformed_jwt' };
  }
  let header;
  let payload;
  let jwk;
  try {
    header = decodeJsonPart(parts[0]);
    payload = decodeJsonPart(parts[1]);
    jwk = publicJwk(JSON.parse(jwkStr));
  } catch {
    return { ok: false, reason: 'invalid_jwt' };
  }
  if (header.alg !== 'ES256') return { ok: false, reason: 'unsupported_alg' };
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = payload.exp ?? payload.expires_at;
  const iss = (env.MEMBERSHIP_ISSUER || 'https://coop.yourcommunity.forum').replace(/\/$/, '');
  if (payload.iss !== iss) return { ok: false, reason: 'iss_mismatch' };
  if (exp == null || now >= Number(exp)) return { ok: false, reason: 'expired' };
  if (!['worker', 'consumer', 'community'].includes(payload.class)) {
    return { ok: false, reason: 'invalid_class' };
  }
  return { ok: true, payload };
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function stripeSignatureValid(raw, header, secret) {
  if (!secret || !header) return false;
  let timestamp = '';
  const signatures = [];
  for (const part of String(header).split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't' && !timestamp) timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  if (!signatures.length) return false;
  const expected = await hmacSha256Hex(secret, `${timestamp}.${raw}`);
  for (const candidate of signatures) {
    if (await secretsEqual(candidate.toLowerCase(), expected)) return true;
  }
  return false;
}

async function stripeIdentityVerified(sessionId, env) {
  if (!env.STRIPE_SECRET_KEY) return false;
  if (typeof sessionId !== 'string' || !/^vs_[A-Za-z0-9]{8,120}$/.test(sessionId)) {
    return false;
  }
  const res = await fetch(
    `https://api.stripe.com/v1/identity/verification_sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!res.ok) return false;
  const session = await res.json();
  return session?.status === 'verified';
}

async function verifyTurnstile(token, env) {
  if (!env.TURNSTILE_SECRET) {
    return env.ALLOW_DEV_MEMBERSHIP === '1';
  }
  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const data = await res.json();
  return !!data.success;
}

async function importPrivateKey(jwkStr) {
  const jwk = JSON.parse(jwkStr);
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function signJwtEs256(payload, env) {
  const jwkStr = env.MEMBERSHIP_PRIVATE_KEY_JWK;
  if (!jwkStr) {
    throw new Error('MEMBERSHIP_PRIVATE_KEY_JWK not configured');
  }
  const key = await importPrivateKey(jwkStr);
  const header = { alg: 'ES256', typ: 'JWT', kid: 'membership-v1' };
  const headerB64 = encodeJsonPart(header);
  const payloadB64 = encodeJsonPart(payload);
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, data);
  const sigB64 = base64UrlEncode(new Uint8Array(sig));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

export async function ensureCoopMembershipSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS coop_memberships (
      jti TEXT PRIMARY KEY,
      member_hash TEXT NOT NULL,
      class TEXT NOT NULL,
      stripe_session TEXT,
      issued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_coop_memberships_member ON coop_memberships(member_hash)
  `).run();
}

export async function handleMembershipRoute(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  const path = url.pathname.replace(/\/$/, '');

  if (path === '/membership/jwks.json' && request.method === 'GET') {
    const pub = env.MEMBERSHIP_PUBLIC_KEY_JWK;
    if (!pub) {
      return corsJson({ error: 'jwks_not_configured' }, 503);
    }
    let jwk;
    try {
      jwk = publicJwk(JSON.parse(pub));
    } catch {
      return corsJson({ error: 'invalid_public_jwk' }, 500);
    }
    if (!jwk.kid) jwk.kid = 'membership-v1';
    return corsJson({ keys: [jwk] });
  }

  if (!env.DB) {
    return corsJson({ error: 'D1 not configured' }, 503);
  }

  if (path === '/membership/verify-id' && request.method === 'POST') {
    const read = await readBoundedText(request);
    if (read.error) return read.error;
    let body;
    try {
      body = JSON.parse(read.text);
    } catch {
      return corsJson({ error: 'invalid_json' }, 400);
    }
    const ok = await verifyTurnstile(body.turnstile_token, env);
    if (!ok) {
      return corsJson({ error: 'turnstile_failed' }, 403);
    }
    if (env.STRIPE_SECRET_KEY && body.start_identity !== false) {
      const params = new URLSearchParams();
      params.set('type', 'document');
      const stripeRes = await fetch('https://api.stripe.com/v1/identity/verification_sessions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });
      const session = await stripeRes.json();
      if (!stripeRes.ok) {
        return corsJson({ error: 'stripe_session_failed', detail: session }, 502);
      }
      return corsJson({
        ok: true,
        stripe_client_secret: session.client_secret,
        stripe_session_id: session.id,
        next: 'POST /membership/issue after verification',
      });
    }
    return corsJson({
      ok: true,
      dev: true,
      message:
        'Turnstile passed. POST /membership/issue with its own turnstile_token, member_hash, and class. When Stripe is configured, include a verified stripe_session_id.',
    });
  }

  if (path === '/membership/issue' && request.method === 'POST') {
    const read = await readBoundedText(request);
    if (read.error) return read.error;
    let body;
    try {
      body = JSON.parse(read.text);
    } catch {
      return corsJson({ error: 'invalid_json' }, 400);
    }
    const turnstileOk = await verifyTurnstile(body.turnstile_token, env);
    if (!turnstileOk) {
      return corsJson({ error: 'turnstile_failed' }, 403);
    }
    if (env.STRIPE_SECRET_KEY) {
      const verified = await stripeIdentityVerified(body.stripe_session_id, env);
      if (!verified) {
        return corsJson({ error: 'identity_not_verified' }, 403);
      }
    }
    const memberClass = body.class || 'consumer';
    if (!MEMBER_CLASSES.includes(memberClass)) {
      return corsJson({ error: 'invalid_class' }, 400);
    }
    let memberHash = '';
    if (env.STRIPE_SECRET_KEY) {
      if (!env.MEMBER_HASH_SALT) {
        return corsJson({ error: 'member_hash_salt_not_configured' }, 503);
      }
      memberHash = await sha256Hex(`stripe:${body.stripe_session_id}:${env.MEMBER_HASH_SALT}`);
    } else if (body.member_hash) {
      memberHash = String(body.member_hash);
    } else if (body.id_subject) {
      const salt = env.MEMBER_HASH_SALT;
      if (!salt) {
        return corsJson({ error: 'member_hash_salt_not_configured' }, 503);
      }
      if (String(body.id_subject).length > 256) {
        return corsJson({ error: 'field_too_long' }, 400);
      }
      memberHash = await sha256Hex(`${body.id_subject}:${salt}`);
    }
    if (!memberHash) {
      return corsJson({ error: 'member_hash_required' }, 400);
    }
    if (memberHash.length > 128) {
      return corsJson({ error: 'field_too_long' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const configuredTtl = Number(env.MEMBERSHIP_TTL_SEC || 86400);
    const ttl = Number.isFinite(configuredTtl)
      ? Math.min(Math.max(configuredTtl, 60), 30 * 24 * 3600)
      : 86400;
    const exp = now + ttl;
    const jti = crypto.randomUUID();
    const iss = (env.MEMBERSHIP_ISSUER || 'https://coop.yourcommunity.forum').replace(/\/$/, '');
    const payload = {
      iss,
      sub: memberHash,
      member_hash: memberHash,
      class: memberClass,
      iat: now,
      issued_at: now,
      nbf: now,
      exp,
      expires_at: exp,
      jti,
    };
    let token;
    try {
      token = await signJwtEs256(payload, env);
    } catch (e) {
      if (env.ALLOW_DEV_MEMBERSHIP === '1') {
        return corsJson({
          error: 'jwt_signing_not_configured',
          dev_payload: payload,
          message: e?.message,
        }, 503);
      }
      return corsJson({ error: 'jwt_signing_failed' }, 500);
    }
    await ensureCoopMembershipSchema(env.DB);
    await env.DB.prepare(
      `INSERT INTO coop_memberships (jti, member_hash, class, stripe_session, expires_at)
       VALUES (?, ?, ?, ?, datetime(?, 'unixepoch'))`
    )
      .bind(jti, memberHash, memberClass, body.stripe_session_id || null, exp)
      .run();
    return corsJson({
      ok: true,
      token,
      member_hash: memberHash,
      class: memberClass,
      expires_at: exp,
    });
  }

  if (path === '/membership/stripe-webhook' && request.method === 'POST') {
    const read = await readBoundedText(request);
    if (read.error) return read.error;
    const raw = read.text;
    if (!env.STRIPE_WEBHOOK_SECRET) {
      return corsJson({ error: 'webhook_not_configured' }, 401);
    }
    const sig = request.headers.get('Stripe-Signature');
    if (!(await stripeSignatureValid(raw, sig, env.STRIPE_WEBHOOK_SECRET))) {
      return corsJson({ error: 'invalid_stripe_signature' }, 401);
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return corsJson({ error: 'invalid_json' }, 400);
    }
    if (event.type === 'identity.verification_session.verified') {
      return corsJson({ ok: true, verified: true, session_id: event.data?.object?.id });
    }
    return corsJson({ ok: true, ignored: event.type });
  }

  return corsJson({ error: 'not_found' }, 404);
}

export async function handleCoopWebSocket(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  if (env.ALLOW_DEV_MEMBERSHIP !== '1') {
    const verdict = await verifyMembershipJwt(token, env);
    if (!verdict.ok) {
      return new Response('Unauthorized', { status: 401 });
    }
  }
  const upgrade = request.headers.get('Upgrade');
  if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket', { status: 426 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  const ackIds = [];
  server.addEventListener('message', async (ev) => {
    try {
      const text = String(ev.data || '');
      if (text.length > 65_536) return;
      const msg = JSON.parse(text);
      if (msg.kind === 'event' && msg.id != null) {
        ackIds.push(msg.id);
        server.send(JSON.stringify({ kind: 'ack', ids: [msg.id] }));
      }
    } catch {
      /* ignore */
    }
  });
  return new Response(null, { status: 101, webSocket: client });
}
