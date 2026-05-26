/**
 * cf-worker.ts  —  Hardening #6: Cloudflare Worker Routing Adapter
 *
 * This Worker runs at the Cloudflare edge and acts as the single entry point
 * for all API traffic. It routes traffic to your local host via Cloudflare Tunnel.
 */

export interface Env {
  SESSION_MAP:    KVNamespace   // sessionId → JSON { containerUrl, podUrl }
  KEY_REGISTRY:   KVNamespace   // sessionId → Ed25519 pubKeyHex
  ZK_BACKEND_URL: string
  GPU_SERVER_URL: string
  ALLOWED_ORIGIN: string
  WORKER_SECRET:  string        // shared secret for worker→backend auth
  TUNNEL_URL:     string        // The URL of your Cloudflare Tunnel
}

// ─── Main fetch handler ───────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url    = new URL(request.url)
    const origin = request.headers.get('Origin') ?? ''

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse(origin, env.ALLOWED_ORIGIN)
    }

    // ── Rate limit check (coarse — fine-grained via CF Rules) ────────────
    const rateCheck = await checkRateLimit(request, ctx)
    if (!rateCheck.ok) {
      return jsonResponse({ error: 'Too many requests' }, 429, origin, env.ALLOWED_ORIGIN)
    }

    const pathname = url.pathname

    try {
      // ── Route: ZK verification ────────────────────────────────────────
      if (pathname.startsWith('/api/zk/')) {
        return await proxyToZkBackend(request, url, env)
      }

      // ── Route: Pod operations (session-specific container) ────────────
      if (pathname.startsWith('/api/pod/')) {
        return await proxyToPodContainer(request, url, env)
      }

      // ── Route: Encrypted export receive ───────────────────────────────
      if (pathname === '/api/export' || pathname === '/api/receive-data') {
        return await proxyToGpuServer(request, url, env, true)
      }

      // ── Route: Job status polling ──────────────────────────────────────
      if (pathname.startsWith('/api/job/')) {
        return await proxyToGpuServer(request, url, env, false)
      }

      // ── Route: Key registration (called by provisioner after pod init) ─
      if (pathname === '/api/register-key' && request.method === 'POST') {
        return await handleKeyRegistration(request, env)
      }

      // ── Route: Session registration (called by provisioner on pod start)
      if (pathname === '/api/register-session' && request.method === 'POST') {
        return await handleSessionRegistration(request, env)
      }

      // ── Fallback: not found ────────────────────────────────────────────
      return jsonResponse({ error: 'Not found' }, 404, origin, env.ALLOWED_ORIGIN)

    } catch (err) {
      console.error('Worker error:', err)
      return jsonResponse({ error: 'Internal error' }, 500, origin, env.ALLOWED_ORIGIN)
    }
  },
}

// ─── ZK Backend proxy ─────────────────────────────────────────────────────────

async function proxyToZkBackend(request: Request, url: URL, env: Env): Promise<Response> {
  const upstream = new URL(url.pathname + url.search, env.ZK_BACKEND_URL)
  return forwardRequest(request, upstream.toString(), env)
}

// ─── Pod container proxy (Updated for Tunnel) ─────────────────────────────────

async function proxyToPodContainer(request: Request, url: URL, env: Env): Promise<Response> {
  // Extract sessionId from header or query param
  const sessionId = request.headers.get('x-session-id')
                  ?? url.searchParams.get('sessionId')

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'x-session-id header required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  // Strip /api/pod prefix and forward the rest
  const podPath = url.pathname.replace('/api/pod', '') || '/'
  
  // Use the Tunnel URL (Fallback to the one you provided if env var is missing)
  const tunnelBase = env.TUNNEL_URL || 'https://ingress.yourcommunity.forum'
  const upstream = tunnelBase + podPath + url.search

  // Create a new request to forward, preserving the method, headers, and body
  const proxyRequest = new Request(upstream, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual'
  })

  // Explicitly inject the x-session-id header so the local-router.ts can catch it
  proxyRequest.headers.set('x-session-id', sessionId)

  return fetch(proxyRequest)
}

// ─── GPU Server proxy ─────────────────────────────────────────────────────────

async function proxyToGpuServer(
  request: Request,
  url: URL,
  env: Env,
  verifySig: boolean,
): Promise<Response> {
  if (verifySig && request.method === 'POST') {
    const sigCheck = await verifyRequestSignature(request.clone(), env)
    if (!sigCheck.valid) {
      return jsonResponse({ error: `Signature verification failed: ${sigCheck.reason}` }, 401)
    }
  }

  const upstream = new URL(url.pathname + url.search, env.GPU_SERVER_URL)
  return forwardRequest(request, upstream.toString(), env)
}

// ─── Signature verification ───────────────────────────────────────────────────

async function verifyRequestSignature(
  request: Request,
  env: Env,
): Promise<{ valid: boolean; reason?: string }> {
  const sessionId  = request.headers.get('x-session-id')
  const signature  = request.headers.get('x-pod-signature')
  const timestamp  = request.headers.get('x-pod-timestamp')
  const pubKeyHex  = request.headers.get('x-pod-pubkey')

  if (!sessionId || !signature || !timestamp || !pubKeyHex) {
    return { valid: false, reason: 'missing_headers' }
  }

  const age = Date.now() - new Date(timestamp).getTime()
  if (Math.abs(age) > 5 * 60 * 1000) {
    return { valid: false, reason: 'timestamp_expired' }
  }

  const registeredKey = await env.KEY_REGISTRY.get(sessionId)
  if (!registeredKey || registeredKey !== pubKeyHex) {
    return { valid: false, reason: 'key_not_registered' }
  }

  const body       = await request.arrayBuffer()
  const canonical  = `${timestamp}:${sessionId}:${arrayBufferToHex(body)}`

  try {
    const keyBytes  = hexToBytes(pubKeyHex)
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'Ed25519' }, false, ['verify']
    )

    const sigBytes   = hexToBytes(signature)
    const msgBytes   = new TextEncoder().encode(canonical)
    const isValid    = await crypto.subtle.verify('Ed25519', cryptoKey, sigBytes, msgBytes)

    return isValid ? { valid: true } : { valid: false, reason: 'signature_invalid' }
  } catch (e) {
    return { valid: false, reason: 'crypto_error' }
  }
}

// ─── Registration handlers ────────────────────────────────────────────────────

async function handleKeyRegistration(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('x-worker-secret')
  if (authHeader !== env.WORKER_SECRET) {
    return jsonResponse({ error: 'Unauthorised' }, 401)
  }

  const body = await request.json() as { sessionId: string; publicKeyHex: string; createdAt: number }
  if (!body.sessionId || !body.publicKeyHex) {
    return jsonResponse({ error: 'Missing sessionId or publicKeyHex' }, 400)
  }

  await env.KEY_REGISTRY.put(body.sessionId, body.publicKeyHex, { expirationTtl: 30 * 24 * 60 * 60 })
  return jsonResponse({ ok: true })
}

async function handleSessionRegistration(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get('x-worker-secret')
  if (authHeader !== env.WORKER_SECRET) {
    return jsonResponse({ error: 'Unauthorised' }, 401)
  }

  const body = await request.json() as { sessionId: string; containerUrl: string; podUrl: string }
  await env.SESSION_MAP.put(body.sessionId, JSON.stringify({
    containerUrl: body.containerUrl, podUrl: body.podUrl, registeredAt: Date.now(),
  }), { expirationTtl: 7 * 24 * 60 * 60 })

  return jsonResponse({ ok: true })
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

const requestCounts = new Map<string, { count: number; windowStart: number }>()
const RATE_LIMIT    = 60
const WINDOW_MS     = 60_000

async function checkRateLimit(request: Request, _ctx: ExecutionContext): Promise<{ ok: boolean }> {
  const ip    = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  const now   = Date.now()
  const entry = requestCounts.get(ip)

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    requestCounts.set(ip, { count: 1, windowStart: now })
    return { ok: true }
  }

  entry.count++
  if (entry.count > RATE_LIMIT) return { ok: false }
  return { ok: true }
}

// ─── Generic request forwarder ────────────────────────────────────────────────

async function forwardRequest(original: Request, upstreamUrl: string, env: Env): Promise<Response> {
  const headers = new Headers(original.headers)
  headers.set('x-forwarded-by', 'cf-worker')
  headers.set('x-worker-secret', env.WORKER_SECRET || '')

  const upstream = new Request(upstreamUrl, {
    method:  original.method,
    headers,
    body:    original.body,
    // @ts-ignore
    duplex:  'half',
  })

  const response = await fetch(upstream)
  const responseHeaders = new Headers(response.headers)
  responseHeaders.delete('access-control-allow-origin')
  responseHeaders.delete('access-control-allow-credentials')

  return new Response(response.body, { status: response.status, headers: responseHeaders })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function corsPreflightResponse(origin: string, allowedOrigin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigin) })
}

function corsHeaders(origin: string, allowedOrigin: string): Headers {
  const h = new Headers()
  const allowed = origin === allowedOrigin ? origin : allowedOrigin || '*'
  h.set('Access-Control-Allow-Origin',  allowed)
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  h.set('Access-Control-Allow-Headers', 'Content-Type, x-session-id, x-pod-signature, x-pod-timestamp, x-pod-pubkey')
  h.set('Access-Control-Max-Age', '86400')
  return h
}

function jsonResponse(body: unknown, status = 200, origin = '', allowedOrigin = '*'): Response {
  const headers = corsHeaders(origin, allowedOrigin)
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers })
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function arrayBufferToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}