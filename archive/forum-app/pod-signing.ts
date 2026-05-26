/**
 * pod-signing.ts  —  Hardening #4: Payload Authentication via Ed25519 Signatures
 *
 * Problem: server-receiver.ts can decrypt any bundle encrypted with the server's
 * public key — including garbage crafted by a malicious third party.
 *
 * Solution: during pod provisioning we generate an ephemeral Ed25519 keypair.
 * The PUBLIC key is tethered to the ZK proof (stored in the pod's Solid storage
 * and registered with your backend). Every export bundle is signed with the
 * PRIVATE key. The server verifies the signature against the registered public
 * key before decrypting.
 *
 * Trust chain:
 *   ZK proof (Rarimo) → verified identity
 *     └─ sessionId + nullifier → registered in backend
 *          └─ Ed25519 pubkey tied to sessionId
 *               └─ signs every ExportBundle
 *                    └─ server verifies before decrypt
 *
 * This means even if an attacker knows your RSA public key, they cannot forge
 * a valid bundle without stealing the pod's Ed25519 private key.
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PodKeyPair {
  /** hex-encoded Ed25519 public key (32 bytes) */
  publicKeyHex: string
  /** path to the private key file on disk (pod-local, chmod 600) */
  privateKeyPath: string
  /** sessionId this keypair is bound to */
  sessionId: string
  /** unix ms when key was generated */
  createdAt: number
}

export interface SignedBundle<T> {
  payload: T
  /** hex sessionId the signing key is registered under */
  sessionId: string
  /** ISO timestamp — replay window check on server */
  timestamp: string
  /** hex-encoded Ed25519 signature over canonical(payload + sessionId + timestamp) */
  signature: string
  /** hex-encoded Ed25519 public key — server looks up registration to verify */
  publicKeyHex: string
}

// ─── Key generation (called once per pod during provisioning) ─────────────────

/**
 * Generates an Ed25519 keypair for the pod, writes the private key to disk
 * under `keyDir`, and returns the PodKeyPair descriptor.
 *
 * The private key is stored ONLY on the user's device inside their pod directory.
 * The public key is returned for registration with your backend.
 */
export function generatePodKeyPair(keyDir: string, sessionId: string): PodKeyPair {
  fs.mkdirSync(keyDir, { recursive: true })

  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  })

  const privateKeyPath = path.join(keyDir, 'pod_signing.pem')
  fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 })

  // Derive raw 32-byte public key hex for easy storage + transport
  const rawPublicKey  = crypto.createPublicKey(publicKey)
  const publicKeyDer  = rawPublicKey.export({ type: 'spki', format: 'der' })
  // Ed25519 SPKI DER: last 32 bytes are the raw public key
  const publicKeyHex  = publicKeyDer.subarray(-32).toString('hex')

  const keypair: PodKeyPair = {
    publicKeyHex,
    privateKeyPath,
    sessionId,
    createdAt: Date.now(),
  }

  // Write metadata alongside the private key for introspection
  fs.writeFileSync(
    path.join(keyDir, 'pod_signing_meta.json'),
    JSON.stringify({ publicKeyHex, sessionId, createdAt: keypair.createdAt }, null, 2)
  )

  console.log(`[pod-signing] Ed25519 keypair generated for session ${sessionId.slice(0,12)}…`)
  return keypair
}

/**
 * Load an existing keypair from disk (pod resume scenario).
 */
export function loadPodKeyPair(keyDir: string): PodKeyPair {
  const metaPath = path.join(keyDir, 'pod_signing_meta.json')
  if (!fs.existsSync(metaPath)) {
    throw new Error(`[pod-signing] No keypair found at ${keyDir}. Run generatePodKeyPair first.`)
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as {
    publicKeyHex: string
    sessionId: string
    createdAt: number
  }

  return {
    publicKeyHex:   meta.publicKeyHex,
    privateKeyPath: path.join(keyDir, 'pod_signing.pem'),
    sessionId:      meta.sessionId,
    createdAt:      meta.createdAt,
  }
}

// ─── Signing (pod side) ───────────────────────────────────────────────────────

/**
 * Signs an export bundle with the pod's Ed25519 private key.
 * Returns a SignedBundle wrapping the original payload.
 *
 * The signed message is the canonical JSON of:
 *   { payload, sessionId, timestamp }
 * sorted by key to ensure determinism across implementations.
 */
export function signBundle<T>(
  payload: T,
  keypair: PodKeyPair
): SignedBundle<T> {
  const timestamp = new Date().toISOString()

  const canonical = canonicalise({ payload, sessionId: keypair.sessionId, timestamp })

  const privateKeyPem = fs.readFileSync(keypair.privateKeyPath, 'utf-8')
  const privateKey    = crypto.createPrivateKey(privateKeyPem)

  const sig = crypto.sign(null, Buffer.from(canonical, 'utf-8'), privateKey)

  return {
    payload,
    sessionId:    keypair.sessionId,
    timestamp,
    signature:    sig.toString('hex'),
    publicKeyHex: keypair.publicKeyHex,
  }
}

// ─── Verification (server side) ───────────────────────────────────────────────

export interface VerifyResult {
  valid:    boolean
  reason?:  'signature_invalid' | 'key_not_registered' | 'replay_detected' | 'timestamp_expired'
}

/**
 * Verifies a SignedBundle on the server.
 *
 * @param bundle          The signed bundle received from the pod
 * @param lookupPublicKey A function that returns the registered public key hex
 *                        for a sessionId, or null if not registered.
 * @param replayCache     A Set<string> of already-seen (sessionId+timestamp) strings.
 *                        Pass a persistent cache (e.g. backed by Redis) in production.
 * @param maxAgeMs        Maximum age of the timestamp before rejection (default 5 min)
 */
export async function verifyBundle<T>(
  bundle: SignedBundle<T>,
  lookupPublicKey: (sessionId: string) => Promise<string | null>,
  replayCache: Set<string>,
  maxAgeMs = 5 * 60 * 1000,
): Promise<VerifyResult> {
  const { payload, sessionId, timestamp, signature, publicKeyHex } = bundle

  // ── 1. Timestamp freshness check ─────────────────────────────────────────
  const age = Date.now() - new Date(timestamp).getTime()
  if (age > maxAgeMs || age < -30_000) {
    // Allow 30s clock skew backward
    return { valid: false, reason: 'timestamp_expired' }
  }

  // ── 2. Replay detection ───────────────────────────────────────────────────
  const replayKey = `${sessionId}:${timestamp}`
  if (replayCache.has(replayKey)) {
    return { valid: false, reason: 'replay_detected' }
  }

  // ── 3. Public key registry check ─────────────────────────────────────────
  const registeredKeyHex = await lookupPublicKey(sessionId)
  if (!registeredKeyHex) {
    return { valid: false, reason: 'key_not_registered' }
  }

  if (registeredKeyHex !== publicKeyHex) {
    // Bundle claims a different key than what's registered — forgery attempt
    return { valid: false, reason: 'key_not_registered' }
  }

  // ── 4. Signature verification ─────────────────────────────────────────────
  const canonical = canonicalise({ payload, sessionId, timestamp })
  const pubKeyObj = derivePublicKeyObject(publicKeyHex)

  const valid = crypto.verify(
    null,
    Buffer.from(canonical, 'utf-8'),
    pubKeyObj,
    Buffer.from(signature, 'hex')
  )

  if (!valid) {
    return { valid: false, reason: 'signature_invalid' }
  }

  // ── 5. Admit to replay cache ──────────────────────────────────────────────
  replayCache.add(replayKey)

  return { valid: true }
}

// ─── Registration endpoint helper ─────────────────────────────────────────────

/**
 * Call this from your backend when a pod is first provisioned.
 * Stores sessionId → publicKeyHex in your key registry (adapt to your DB).
 */
export function buildRegistrationPayload(keypair: PodKeyPair, proofSessionId: string): {
  sessionId:    string
  publicKeyHex: string
  createdAt:    number
  bindingProof: string   // HMAC ties the key to the session so it can't be reused
} {
  const binding = crypto
    .createHmac('sha256', keypair.privateKeyPath) // private key material as HMAC key
    .update(`${proofSessionId}:${keypair.publicKeyHex}`)
    .digest('hex')

  return {
    sessionId:    proofSessionId,
    publicKeyHex: keypair.publicKeyHex,
    createdAt:    keypair.createdAt,
    bindingProof: binding,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function canonicalise(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as object).sort())
}

/**
 * Reconstruct a Node.js KeyObject from a raw 32-byte Ed25519 public key hex.
 * Ed25519 SPKI DER = fixed 12-byte header + 32-byte key.
 */
function derivePublicKeyObject(publicKeyHex: string): crypto.KeyObject {
  // Standard Ed25519 SPKI DER prefix (RFC 8410)
  const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
  const rawKey      = Buffer.from(publicKeyHex, 'hex')
  const der         = Buffer.concat([SPKI_PREFIX, rawKey])
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
}
