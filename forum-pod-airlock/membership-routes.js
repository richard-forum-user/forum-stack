/**
 * Pod Worker: POST /api/membership/verify
 * Forwards a signed Pod RPC envelope whose payload is
 * { verb: 'PUT', path: '/membership/jwt', data: { jwt, coop_url? } }.
 */

import { verifySignedBundle } from './pod-signing-web.js';
import { sessionIdMatchesPubkey } from './session-binding.js';
import { fetchJwks } from './membership-verify.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function handleMembershipVerifyRoute(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const coopUrl = (env.COOP_URL || 'https://coop.yourcommunity.forum').replace(/\/$/, '');

  if (url.pathname === '/api/membership/refresh-jwks' && request.method === 'POST') {
    try {
      const jwks = await fetchJwks(coopUrl);
      return json({ ok: true, keys: (jwks.keys || []).length, coop_url: coopUrl });
    } catch (e) {
      return json({ error: 'jwks_fetch_failed', message: e?.message }, 502);
    }
  }

  if (url.pathname !== '/api/membership/verify' || request.method !== 'POST') {
    return json({ error: 'not_found' }, 404);
  }

  const bodyText = await request.text();
  let bundle;
  try {
    bundle = JSON.parse(bodyText);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!bundle?.sessionId || !bundle?.publicKeyHex) {
    return json({ error: 'signed_bundle_required' }, 400);
  }
  const binding = await sessionIdMatchesPubkey(bundle.sessionId, bundle.publicKeyHex);
  if (!binding) {
    return json({ error: 'session_binding_failed' }, 401);
  }
  const verdict = await verifySignedBundle(bundle, null);
  if (!verdict.valid) {
    return json({ error: 'auth_failed', reason: verdict.reason }, 401);
  }

  const payload = verdict.payload || {};
  if (payload.verb !== 'PUT' || payload.path !== '/membership/jwt') {
    const jwt =
      bundle.jwt ||
      payload.data?.jwt ||
      request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
    if (!jwt) {
      return json(
        {
          error: 'invalid_envelope',
          hint: 'payload must be { verb: PUT, path: /membership/jwt, data: { jwt } }',
        },
        400
      );
    }
    bundle.payload = {
      verb: 'PUT',
      path: '/membership/jwt',
      data: {
        jwt,
        coop_url: coopUrl,
        expected_iss: coopUrl,
      },
    };
  } else if (payload.data && !payload.data.coop_url) {
    payload.data.coop_url = coopUrl;
    payload.data.expected_iss = coopUrl;
  }

  if (!env.POD) {
    return json({ error: 'pod_do_not_bound' }, 500);
  }

  const id = env.POD.idFromName(bundle.sessionId);
  const stub = env.POD.get(id);
  const upstream = await stub.fetch(
    new Request('https://pod-do/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bundle),
    })
  );
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
