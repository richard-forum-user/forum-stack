/**
 * Pre-Durable-Object ingress guards: payload size and write frequency.
 */

export const MAX_POD_BODY_BYTES = 256 * 1024;
export const MAX_POD_WRITES_PER_MINUTE = 60;

export function podBodyTooLarge(bodyText) {
  if (!bodyText) return false;
  return new TextEncoder().encode(bodyText).length > MAX_POD_BODY_BYTES;
}

export async function ensurePodUsageSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS pod_usage_windows (
        session_id TEXT NOT NULL,
        window_start_ms INTEGER NOT NULL,
        write_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, window_start_ms)
      )`
    )
    .run();
}

/**
 * @returns {{ ok: boolean, reason?: string }}
 */
export async function checkPodWriteBudget(db, sessionId) {
  if (!db || !sessionId) return { ok: true };
  await ensurePodUsageSchema(db);
  const windowMs = 60_000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `SELECT write_count FROM pod_usage_windows
       WHERE session_id = ? AND window_start_ms = ?`
    )
    .bind(sessionId, windowStart)
    .first();
  const count = Number(row?.write_count || 0);
  if (count >= MAX_POD_WRITES_PER_MINUTE) {
    return { ok: false, reason: 'pod_write_rate_exceeded' };
  }
  await db
    .prepare(
      `INSERT INTO pod_usage_windows (session_id, window_start_ms, write_count)
       VALUES (?, ?, 1)
       ON CONFLICT(session_id, window_start_ms) DO UPDATE SET write_count = write_count + 1`
    )
    .bind(sessionId, windowStart)
    .run();
  return { ok: true };
}
