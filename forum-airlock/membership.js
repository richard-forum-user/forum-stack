/**
 * Cooperative membership issuance (Turnstile + Stripe Identity + ES256 JWT).
 * Mounted at /membership/* on coop.yourcommunity.forum.
 */

import { secretsEqual } from './secret-compare.js';
import { verifySignedBundle } from './pod-signing-web.js';
import {
  ensureAssuranceSchema,
  paidKeyHash,
  sha256Hex as sha256HexAssurance,
  verifyStripeSignature,
  zip5,
} from './assurance.js';

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
      jwk = JSON.parse(pub);
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
    let body;
    try {
      body = await request.json();
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
      message: 'Turnstile passed. Call POST /membership/issue with member_hash and class.',
    });
  }

  if (path === '/membership/issue' && request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return corsJson({ error: 'invalid_json' }, 400);
    }
    const memberClass = body.class || 'consumer';
    if (!MEMBER_CLASSES.includes(memberClass)) {
      return corsJson({ error: 'invalid_class' }, 400);
    }
    let memberHash = body.member_hash;
    if (!memberHash && body.id_subject) {
      const salt = env.MEMBER_HASH_SALT || 'coop-membership-salt';
      memberHash = await sha256Hex(`${body.id_subject}:${salt}`);
    }
    if (!memberHash) {
      return corsJson({ error: 'member_hash_required' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    const ttl = Number(env.MEMBERSHIP_TTL_SEC || 86400);
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
      return corsJson({ error: 'jwt_signing_failed', message: e?.message }, 500);
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

  if (path === '/membership/checkout' && request.method === 'POST') {
    return handlePaidCheckout(request, env);
  }

  if (path === '/membership/stripe-webhook' && request.method === 'POST') {
    const raw = await request.text();
    // Webhooks change assurance tiers, so an unsigned or unverifiable event
    // is never processed.
    if (!env.STRIPE_WEBHOOK_SECRET) {
      return corsJson({ error: 'webhook_secret_not_configured' }, 503);
    }
    const sigOk = await verifyStripeSignature(
      raw,
      request.headers.get('Stripe-Signature'),
      env.STRIPE_WEBHOOK_SECRET
    );
    if (!sigOk) {
      return corsJson({ error: 'invalid_stripe_signature' }, 400);
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return corsJson({ error: 'invalid_json' }, 400);
    }
    if (event.type === 'checkout.session.completed') {
      return recordPaidMembership(event.data?.object, env);
    }
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const obj = event.data?.object || {};
      const pi = obj.payment_intent || null;
      if (pi) {
        await ensureAssuranceSchema(env.DB);
        await env.DB.prepare(
          `UPDATE coop_paid_keys SET revoked = 1, revoked_reason = ? WHERE payment_intent = ?`
        )
          .bind(event.type, pi)
          .run();
      }
      return corsJson({ ok: true, revoked_for: pi });
    }
    if (event.type === 'identity.verification_session.verified') {
      return corsJson({ ok: true, verified: true, session_id: event.data?.object?.id });
    }
    return corsJson({ ok: true, ignored: event.type });
  }

  return corsJson({ error: 'not_found' }, 404);
}

// ---- paid membership (assurance tier) --------------------------------------

async function stripeApi(env, method, path, params = null) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? params : undefined,
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

/**
 * POST /membership/checkout
 * Body: a signed pod bundle whose payload is
 *   { action: 'paid_membership_checkout', turnstile_token?, success_url?, cancel_url? }
 * The signature proves the caller holds the pod key that will get the paid tier.
 * Returns { url } for Stripe Checkout.
 */
async function handlePaidCheckout(request, env) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_MEMBERSHIP_PRICE_ID) {
    return corsJson({ error: 'paid_membership_not_configured' }, 503);
  }
  let bundle;
  try {
    bundle = await request.json();
  } catch {
    return corsJson({ error: 'invalid_json' }, 400);
  }
  const verdict = await verifySignedBundle(bundle, null);
  if (!verdict.valid) {
    return corsJson({ error: 'bundle_invalid', reason: verdict.reason }, 401);
  }
  const p = verdict.payload || {};
  if (p.action !== 'paid_membership_checkout') {
    return corsJson({ error: 'wrong_action' }, 400);
  }
  if (!(await verifyTurnstile(p.turnstile_token, env))) {
    return corsJson({ error: 'turnstile_failed' }, 403);
  }

  const keyHash = await paidKeyHash(verdict.publicKeyHex);
  const base = (env.MEMBERSHIP_ISSUER || 'https://coop.yourcommunity.forum').replace(/\/$/, '');
  const params = new URLSearchParams();
  params.set('mode', 'payment');
  params.set('line_items[0][price]', env.STRIPE_MEMBERSHIP_PRICE_ID);
  params.set('line_items[0][quantity]', '1');
  params.set('client_reference_id', keyHash);
  params.set('metadata[purpose]', 'paid_membership');
  params.set('metadata[key_hash]', keyHash);
  params.set('payment_intent_data[metadata][purpose]', 'paid_membership');
  params.set('payment_intent_data[metadata][key_hash]', keyHash);
  params.set('success_url', env.MEMBERSHIP_SUCCESS_URL || `${base}/pod/?membership=paid`);
  params.set('cancel_url', env.MEMBERSHIP_CANCEL_URL || `${base}/pod/?membership=cancelled`);

  const r = await stripeApi(env, 'POST', 'checkout/sessions', params);
  if (!r.ok) {
    return corsJson({ error: 'stripe_checkout_failed', status: r.status }, 502);
  }
  return corsJson({ ok: true, url: r.data.url, checkout_session: r.data.id });
}

/**
 * checkout.session.completed → record the paid key.
 * Stores only: key hash, salted card fingerprint hash (for the per-card cap),
 * billing ZIP5 and the issuer's postal-code check. No name, no card digits.
 */
async function recordPaidMembership(session, env) {
  if (!session || session.metadata?.purpose !== 'paid_membership') {
    return corsJson({ ok: true, ignored: 'not_paid_membership' });
  }
  if (session.payment_status !== 'paid' || !session.payment_intent) {
    return corsJson({ ok: true, ignored: 'not_paid' });
  }
  const keyHash = session.metadata?.key_hash || session.client_reference_id;
  if (!keyHash) return corsJson({ error: 'missing_key_hash' }, 400);
  if (!env.STRIPE_SECRET_KEY) return corsJson({ error: 'stripe_not_configured' }, 503);

  const pi = await stripeApi(
    env,
    'GET',
    `payment_intents/${encodeURIComponent(session.payment_intent)}?expand[]=latest_charge`
  );
  if (!pi.ok) return corsJson({ error: 'payment_intent_fetch_failed' }, 502);
  const charge = pi.data.latest_charge || {};
  const card = charge.payment_method_details?.card || {};
  const postalCheck = card.checks?.address_postal_code_check || null;
  const billingZip = zip5(charge.billing_details?.address?.postal_code);
  const salt = env.MEMBER_HASH_SALT || '';
  const cardHash = card.fingerprint ? await sha256HexAssurance(`card:${salt}:${card.fingerprint}`) : null;

  await ensureAssuranceSchema(env.DB);
  const maxPerCard = Number(env.MAX_PAID_KEYS_PER_CARD || 2);
  let overLimit = 0;
  if (cardHash) {
    const used = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM coop_paid_keys
       WHERE card_fingerprint_hash = ? AND key_hash != ? AND revoked = 0
         AND over_card_limit = 0 AND expires_at > datetime('now')`
    )
      .bind(cardHash, keyHash)
      .first();
    if (Number(used?.n || 0) >= maxPerCard) overLimit = 1;
  }
  const days = Number(env.PAID_MEMBERSHIP_DAYS || 365);
  await env.DB.prepare(
    `INSERT INTO coop_paid_keys
       (key_hash, checkout_session, payment_intent, card_fingerprint_hash,
        billing_zip, postal_check, over_card_limit, paid_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', ?), 0)
     ON CONFLICT(key_hash) DO UPDATE SET
       checkout_session = excluded.checkout_session,
       payment_intent = excluded.payment_intent,
       card_fingerprint_hash = excluded.card_fingerprint_hash,
       billing_zip = excluded.billing_zip,
       postal_check = excluded.postal_check,
       over_card_limit = excluded.over_card_limit,
       paid_at = excluded.paid_at,
       expires_at = excluded.expires_at,
       revoked = 0,
       revoked_reason = NULL`
  )
    .bind(
      keyHash,
      session.id,
      session.payment_intent,
      cardHash,
      billingZip,
      postalCheck,
      overLimit,
      `+${days} days`
    )
    .run();
  return corsJson({ ok: true, recorded: true, over_card_limit: !!overLimit });
}

export async function handleCoopWebSocket(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) {
    return new Response('Unauthorized', { status: 401 });
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
      const msg = JSON.parse(String(ev.data || '{}'));
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
