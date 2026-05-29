/**
 * D1-backed sliding-window rate limits at the Worker edge.
 */

export async function ensureRateLimitSchema(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS edge_rate_limits (
        bucket TEXT NOT NULL,
        window_start_ms INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, window_start_ms)
      )`
    )
    .run();
}

/**
 * @returns {{ ok: boolean, retryAfterSec?: number }}
 */
export async function checkRateLimit(db, bucket, limit, windowMs) {
  if (!db || !bucket) return { ok: true };
  await ensureRateLimitSchema(db);
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await db
    .prepare(
      `SELECT count FROM edge_rate_limits WHERE bucket = ? AND window_start_ms = ?`
    )
    .bind(bucket, windowStart)
    .first();
  const count = Number(row?.count || 0);
  if (count >= limit) {
    const retryAfterSec = Math.ceil((windowStart + windowMs - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  await db
    .prepare(
      `INSERT INTO edge_rate_limits (bucket, window_start_ms, count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start_ms) DO UPDATE SET count = count + 1`
    )
    .bind(bucket, windowStart)
    .run();
  const cutoff = now - windowMs * 4;
  await db
    .prepare(`DELETE FROM edge_rate_limits WHERE window_start_ms < ?`)
    .bind(cutoff)
    .run();
  return { ok: true };
}

export function clientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}
