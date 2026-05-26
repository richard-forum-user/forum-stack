/**
 * analysis-queue.ts  —  Hardening #5: Asynchronous Server Queue
 *
 * Mistral 12B GPU inference is slow (5–60 s per job depending on payload size).
 * Running it synchronously inside the Express request handler will:
 *   - Time out the HTTP connection (clients default to 30 s)
 *   - Block all other incoming requests (Node.js single-threaded I/O)
 *   - Produce duplicate analysis if the client retries
 *
 * Solution: BullMQ (Redis-backed) job queue.
 *   - POST /api/receive-data → immediately enqueues a job → returns 202 Accepted
 *   - A separate worker process dequeues jobs sequentially and calls Mistral
 *   - Retries with exponential backoff on transient GPU errors
 *   - Job status is queryable via GET /api/job/:jobId
 *
 * Run:
 *   # Terminal 1 — Express server
 *   node dist/server-receiver.js
 *
 *   # Terminal 2 — Analysis worker (can be multiple instances)
 *   node dist/analysis-queue.js worker
 *
 * Redis:
 *   docker run -d --name bullmq-redis -p 6379:6379 redis:7-alpine
 */

import { Queue, Worker, Job, QueueEvents } from 'bullmq'
import fs from 'fs'
import path from 'path'

// ─── Redis connection ─────────────────────────────────────────────────────────

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost'
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379)
const REDIS_PASS = process.env.REDIS_PASSWORD   // undefined = no auth

const redisConnection = {
  host:     REDIS_HOST,
  port:     REDIS_PORT,
  password: REDIS_PASS,
}

// ─── Queue definition ─────────────────────────────────────────────────────────

const QUEUE_NAME = 'mistral-analysis'

export interface AnalysisJobData {
  sessionId:   string
  records:     Array<{ id: number; category: string; payload: unknown; createdAt: number }>
  exportedAt:  number
  receivedAt:  number
}

export interface AnalysisJobResult {
  sessionId:   string
  summary:     string
  insights:    string[]
  anomalies:   string[]
  analysedAt:  number
  logPath:     string
}

// ── Producer (used by server-receiver.ts) ────────────────────────────────────

let _queue: Queue | null = null

export function getAnalysisQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts:   3,
        backoff: {
          type:  'exponential',
          delay: 5000,     // 5 s → 10 s → 20 s
        },
        removeOnComplete: { count: 200 },  // keep last 200 completed
        removeOnFail:     { count:  50 },
      },
    })
  }
  return _queue
}

/**
 * Enqueue an analysis job. Returns the BullMQ job ID for status tracking.
 * Call this instead of the direct Mistral call in server-receiver.ts.
 */
export async function enqueueAnalysis(data: AnalysisJobData): Promise<string> {
  const queue = getAnalysisQueue()

  const job = await queue.add(
    'analyse',
    data,
    {
      jobId: `${data.sessionId}-${data.exportedAt}`,  // idempotent: same export → same jobId
      priority: 10,
    }
  )

  console.log(`[analysis-queue] Enqueued job ${job.id} for session ${data.sessionId.slice(0,8)}…`)
  return job.id!
}

/**
 * Get the current status of a job for the polling endpoint.
 */
export async function getJobStatus(jobId: string): Promise<{
  state: string
  result?: AnalysisJobResult
  failReason?: string
}> {
  const queue = getAnalysisQueue()
  const job   = await Job.fromId(queue, jobId)

  if (!job) return { state: 'not_found' }

  const state = await job.getState()

  return {
    state,
    result:     state === 'completed' ? job.returnvalue as AnalysisJobResult : undefined,
    failReason: state === 'failed'    ? job.failedReason                     : undefined,
  }
}

// ── Worker (run as a separate process) ───────────────────────────────────────

const MISTRAL_URL    = process.env.MISTRAL_URL    ?? 'http://localhost:11434'
const LOG_DIR        = process.env.ANALYSIS_LOG_DIR ?? './analysis-logs'
const CONCURRENCY    = Number(process.env.WORKER_CONCURRENCY ?? 1) // 1 = sequential GPU usage

export function startWorker(): Worker {
  const worker = new Worker<AnalysisJobData, AnalysisJobResult>(
    QUEUE_NAME,
    processJob,
    {
      connection:  redisConnection,
      concurrency: CONCURRENCY,
      limiter: {
        max:      1,      // max 1 job per second globally — GPU throttle
        duration: 1000,
      },
    }
  )

  worker.on('completed', (job, result) => {
    console.log(`[worker] ✓ Job ${job.id} complete — summary: ${result.summary.slice(0, 80)}…`)
  })

  worker.on('failed', (job, err) => {
    console.error(`[worker] ✗ Job ${job?.id} failed:`, err.message)
  })

  worker.on('error', err => {
    console.error('[worker] Worker error:', err)
  })

  console.log(`[worker] Started with concurrency=${CONCURRENCY}, redis=${REDIS_HOST}:${REDIS_PORT}`)
  return worker
}

// ─── Job processor ────────────────────────────────────────────────────────────

async function processJob(job: Job<AnalysisJobData, AnalysisJobResult>): Promise<AnalysisJobResult> {
  const { sessionId, records } = job.data

  await job.updateProgress(5)
  console.log(`[worker] Processing job ${job.id} — ${records.length} records, session ${sessionId.slice(0,8)}…`)

  const prompt = buildMistralPrompt(records)

  await job.updateProgress(15)

  // Call Mistral via Ollama REST (streaming disabled for simplicity)
  const response = await fetchWithRetry(`${MISTRAL_URL}/api/generate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:  process.env.MISTRAL_MODEL ?? 'mistral',
      prompt,
      stream: false,
      options: {
        temperature: 0.3,
        top_p:       0.9,
        num_predict: 1024,
        num_ctx:     4096,
      },
    }),
  }, 3)

  await job.updateProgress(80)

  if (!response.ok) {
    throw new Error(`Mistral API error ${response.status}: ${await response.text()}`)
  }

  const ollama = (await response.json()) as { response: string }
  const text   = ollama.response

  const result: AnalysisJobResult = {
    sessionId,
    summary:    extractSection(text, 'SUMMARY'),
    insights:   extractList(text,    'INSIGHTS'),
    anomalies:  extractList(text,    'ANOMALIES'),
    analysedAt: Date.now(),
    logPath:    '',
  }

  // Persist to disk
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const logPath = path.join(LOG_DIR, `${sessionId}-${Date.now()}.json`)
  fs.writeFileSync(logPath, JSON.stringify(result, null, 2))
  result.logPath = logPath

  await job.updateProgress(100)
  return result
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildMistralPrompt(
  records: Array<{ category: string; payload: unknown }>
): string {
  const grouped: Record<string, unknown[]> = {}
  for (const r of records) {
    grouped[r.category] = grouped[r.category] ?? []
    grouped[r.category].push(r.payload)
  }

  return `You are an expert data analyst. Analyse the following structured data.

Respond ONLY in this EXACT format — no preamble, no markdown:

SUMMARY
<one paragraph>

INSIGHTS
- <insight>
- <insight>
- <insight>

ANOMALIES
- <anomaly or "None detected">

Data (${records.length} records):
${JSON.stringify(grouped, null, 2)}`
}

function extractSection(text: string, header: string): string {
  const re = new RegExp(`${header}\\s*\\n([\\s\\S]*?)(?=\\n[A-Z]+\\n|$)`)
  return text.match(re)?.[1]?.trim() ?? ''
}

function extractList(text: string, header: string): string[] {
  return extractSection(text, header)
    .split('\n')
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean)
}

async function fetchWithRetry(url: string, init: RequestInit, attempts: number): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      lastErr = err
      const delay = 2000 * Math.pow(2, i)
      console.warn(`[worker] Mistral fetch attempt ${i + 1} failed; retrying in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw lastErr
}

// ─── CLI entrypoint: node dist/analysis-queue.js worker ─────────────────────

if (require.main === module && process.argv[2] === 'worker') {
  const worker = startWorker()

  process.on('SIGINT',  async () => { await worker.close(); process.exit(0) })
  process.on('SIGTERM', async () => { await worker.close(); process.exit(0) })
}
