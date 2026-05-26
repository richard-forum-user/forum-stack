/**
 * server-receiver.ts
 * Express endpoint that runs on YOUR server.
 * Decrypts incoming ExportBundles and queues them for Mistral 12B analysis.
 *
 * Prerequisites on the server:
 *   npm install express
 *   Your Mistral 12B accessible via local llama.cpp server on MISTRAL_URL
 */

import express, { Request, Response } from 'express'
import fs from 'fs'
import path from 'path'
import https from 'https'
import { decrypt, ExportBundle } from './secure-export'
import { verifyBundle, SignedBundle }  from './pod-signing'
import { enqueueAnalysis, getJobStatus, startWorker } from './analysis-queue'

// ─── Config ───────────────────────────────────────────────────────────────────

const PRIVATE_KEY_PATH  = process.env.PRIVATE_KEY_PATH  ?? './server_private.pem'
const MISTRAL_URL       = process.env.MISTRAL_URL        ?? 'http://localhost:11434'  // Ollama / llama.cpp server
const PORT              = Number(process.env.PORT        ?? 8443)
const TLS_CERT_PATH     = process.env.TLS_CERT_PATH      ?? './server.crt'
const TLS_KEY_PATH      = process.env.TLS_KEY_PATH       ?? './server.key'

// ─── Server setup ─────────────────────────────────────────────────────────────

const app = express()
app.use(express.json({ limit: '50mb' }))

// Load RSA private key once at startup
let privateKeyPem: string
try {
  privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8')
  console.log('[server] RSA private key loaded.')
} catch (err) {
  console.error(`[server] Cannot read private key at ${PRIVATE_KEY_PATH}:`, err)
  process.exit(1)
}

// In-memory replay cache — replace with Redis SET in production
const replayCache = new Set<string>()

// In-memory key registry: sessionId → Ed25519 public key hex
// In production, populate this from your DB when provisioner registers a pod key
const podKeyRegistry = new Map<string, string>()

/** Call this from your provisioner (or the /api/register-key handler) */
export function registerPodKey(sessionId: string, publicKeyHex: string): void {
  podKeyRegistry.set(sessionId, publicKeyHex)
  console.log(`[server] Registered pod key for session ${sessionId.slice(0,8)}…`)
}

// ─── /api/receive-data ────────────────────────────────────────────────────────

app.post('/api/receive-data', async (req: Request, res: Response) => {
  try {
    // ── 0. Parse as signed bundle ───────────────────────────────────────────
    const outer = req.body as SignedBundle<ExportBundle>

    if (!outer.payload || !outer.signature || !outer.sessionId) {
      res.status(400).json({ error: 'Invalid signed bundle structure' })
      return
    }

    // ── 1. Verify Ed25519 signature ─────────────────────────────────────────
    const sigResult = await verifyBundle(
      outer,
      async (sessionId) => {
        // Look up the registered public key — adapt to your DB/KV store
        const row = podKeyRegistry.get(sessionId)
        return row ?? null
      },
      replayCache,
    )

    if (!sigResult.valid) {
      console.warn(`[server] Signature rejected: ${sigResult.reason} for session ${outer.sessionId.slice(0,8)}`)
      res.status(401).json({ error: `Payload authentication failed: ${sigResult.reason}` })
      return
    }

    const bundle = outer.payload
    const { sessionId, recordCount } = bundle.meta
    console.log(`[server] Authenticated bundle: session=${sessionId} records=${recordCount}`)

    // ── 2. Decrypt ──────────────────────────────────────────────────────────
    let plaintext: string
    try {
      plaintext = decrypt(bundle, privateKeyPem)
    } catch (err) {
      console.error('[server] Decryption failed:', err)
      res.status(400).json({ error: 'Decryption failed — invalid key or corrupted bundle' })
      return
    }

    const data = JSON.parse(plaintext) as {
      records: Array<{ id: number; category: string; payload: unknown; createdAt: number }>
      exportedAt: number
    }

    console.log(`[server] Decrypted ${data.records.length} records.`)

    // ── 3. Enqueue for async Mistral analysis (non-blocking) ────────────────
    const jobId = await enqueueAnalysis({
      sessionId,
      records:    data.records,
      exportedAt: data.exportedAt,
      receivedAt: Date.now(),
    })

    // Return 202 Accepted immediately — client polls /api/job/:id
    res.status(202).json({ ok: true, received: data.records.length, jobId })

  } catch (err) {
    console.error('[server] Unexpected error:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ─── Start HTTPS server ───────────────────────────────────────────────────────

// ─── GET /api/job/:jobId ─────────────────────────────────────────────────────
app.get('/api/job/:jobId', async (req: Request, res: Response) => {
  try {
    const status = await getJobStatus(req.params.jobId)
    res.json(status)
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch job status' })
  }
})

// ─── POST /api/register-key (internal — called by provisioner) ───────────────
app.post('/api/register-key', (req: Request, res: Response) => {
  const secret = req.headers['x-worker-secret']
  if (secret !== process.env.WORKER_SECRET) {
    res.status(401).json({ error: 'Unauthorised' }); return
  }
  const { sessionId, publicKeyHex } = req.body as { sessionId: string; publicKeyHex: string }
  if (!sessionId || !publicKeyHex) {
    res.status(400).json({ error: 'Missing fields' }); return
  }
  registerPodKey(sessionId, publicKeyHex)
  res.json({ ok: true })
})

const tlsOptions = {
  key:  fs.existsSync(TLS_KEY_PATH)  ? fs.readFileSync(TLS_KEY_PATH)  : undefined,
  cert: fs.existsSync(TLS_CERT_PATH) ? fs.readFileSync(TLS_CERT_PATH) : undefined,
}

if (tlsOptions.key && tlsOptions.cert) {
  https.createServer(tlsOptions, app).listen(PORT, () => {
    console.log(`[server] HTTPS listening on :${PORT}`)
  })
} else {
  console.warn('[server] No TLS cert found — starting HTTP (dev mode only!)')
  app.listen(PORT, () => {
    console.log(`[server] HTTP listening on :${PORT}`)
  })
}

export { app }
