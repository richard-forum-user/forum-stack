/**
 * ai-db-manager.ts
 * Uses LLaMA 1B (via node-llama-cpp) to convert natural language queries
 * into SQL, execute them against the local SQLite DB, and return results.
 */

import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import {
  getLlama,
  LlamaContext,
  LlamaChatSession,
  LlamaModel,
  Llama,
} from 'node-llama-cpp'
import { validateAiSql, runInClone, withTimeout, SandboxError } from './sql-sandbox'

interface AiConfig {
  modelPath: string
  contextSize: number
  threads: number
  temperature: number
  topP: number
  systemPrompt: string
}

export interface QueryResult {
  nlQuery: string
  sqlQuery: string
  rows: unknown[]
  rowsAffected?: number
  executionMs: number
}

export class AiDbManager {
  private llama!: Llama
  private model!: LlamaModel
  private ctx!: LlamaContext
  private session!: LlamaChatSession
  private db: Database.Database
  private config: AiConfig
  private ready = false

  constructor(db: Database.Database, aiConfigDir: string) {
    this.db = db
    const configPath = path.join(aiConfigDir, 'config.json')

    if (!fs.existsSync(configPath)) {
      throw new Error(`AI config not found at ${configPath}. Run pod-provisioner first.`)
    }

    this.config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as AiConfig
  }

  /** Load the model into memory. Call once after provisioning. */
  async init(): Promise<void> {
    if (this.ready) return

    console.log(`[ai-db-manager] Loading model: ${this.config.modelPath}`)

    this.llama = await getLlama()
    this.model = await this.llama.loadModel({
      modelPath: this.config.modelPath,
    })

    this.ctx = await this.model.createContext({
      contextSize: this.config.contextSize,
      threads: this.config.threads,
    })

    this.session = new LlamaChatSession({
      contextSequence: this.ctx.getSequence(),
      systemPrompt: this.config.systemPrompt,
    })

    this.ready = true
    console.log('[ai-db-manager] Model ready.')
  }

  /**
   * Accept a natural language query, generate SQL via LLaMA,
   * execute it against SQLite, and return structured results.
   */
  async query(nlQuery: string, params: Record<string, unknown> = {}): Promise<QueryResult> {
    if (!this.ready) await this.init()

    const start = Date.now()

    // ── 1. Generate SQL from natural language ─────────────────────────────
    const prompt = buildPrompt(nlQuery, params)
    const rawSql = await this.session.prompt(prompt, {
      temperature: this.config.temperature,
      topP: this.config.topP,
      maxTokens: 256,
    })

    const sqlQuery = sanitiseSql(rawSql)

    // ── 2. Sandbox validate → execute in ephemeral in-memory clone ────────
    // validateAiSql throws SandboxError on ANY suspicious pattern.
    // runInClone serialises the live DB → opens in-memory copy → queries it
    // → discards it. The primary DB file is NEVER touched by AI SQL.
    let rows: unknown[] = []
    let rowsAffected: number | undefined

    try {
      validateAiSql(sqlQuery)
      rows = withTimeout(
        () => runInClone(this.db, sqlQuery, 200),
        4000,
        nlQuery.slice(0, 40),
      )
    } catch (err) {
      if (err instanceof SandboxError) {
        console.warn(`[ai-db-manager] Sandbox blocked: ${(err as SandboxError).message}`)
        rows = []
      } else {
        throw err
      }
    }

    const executionMs = Date.now() - start

    // ── 3. Log the query for audit ────────────────────────────────────────
    this.db.prepare(`
      INSERT INTO ai_queries (nl_query, sql_query, result, executed_at)
      VALUES (?, ?, ?, unixepoch())
    `).run(nlQuery, sqlQuery, JSON.stringify({ rows, rowsAffected }))

    return { nlQuery, sqlQuery, rows, rowsAffected, executionMs }
  }

  /**
   * Convenience: insert a data record using natural language description.
   * e.g. "Add a health record with category 'vitals' and payload { heartRate: 72 }"
   */
  async insert(category: string, payload: Record<string, unknown>): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO data_records (category, payload)
      VALUES (?, ?)
    `)
    const result = stmt.run(category, JSON.stringify(payload))
    return result.lastInsertRowid as number
  }

  /**
   * Get all unexported records (for the secure export pipeline).
   */
  getPendingExportRecords(): Array<{ id: number; category: string; payload: string; created_at: number }> {
    return this.db.prepare(`
      SELECT id, category, payload, created_at
      FROM data_records
      WHERE exported_at IS NULL
      ORDER BY created_at ASC
    `).all() as Array<{ id: number; category: string; payload: string; created_at: number }>
  }

  /**
   * Mark records as exported after successful send.
   */
  markExported(ids: number[]): void {
    const placeholders = ids.map(() => '?').join(',')
    this.db.prepare(`
      UPDATE data_records
      SET exported_at = unixepoch()
      WHERE id IN (${placeholders})
    `).run(...ids)
  }

  async dispose(): Promise<void> {
    if (this.model) await this.model.dispose()
    if (this.llama) await this.llama.dispose()
    this.ready = false
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPrompt(nlQuery: string, params: Record<string, unknown>): string {
  let prompt = `Convert this request to a single SQLite query:\n"${nlQuery}"`
  if (Object.keys(params).length > 0) {
    prompt += `\n\nAvailable parameter values (use $key syntax):\n${JSON.stringify(params, null, 2)}`
  }
  prompt += '\n\nSQL:'
  return prompt
}

/**
 * Strip markdown fences and extract the first statement only.
 * Deep validation is delegated to validateAiSql() in sql-sandbox.ts —
 * this function only does surface-level cleanup of LLM output formatting.
 */
function sanitiseSql(raw: string): string {
  const stripped = raw
    .replace(/```sql\s*/gi, '')
    .replace(/```/g, '')
    .trim()

  // Take only the first statement to prevent basic multi-statement injection;
  // sql-sandbox does the comprehensive AST-level check after this.
  return stripped.split(';')[0].trim() + ';'
}
