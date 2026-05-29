/**
 * Outbound-only cooperative sync from PersonalPodDO.
 * No inbound WebSocket listeners — only fetch() upgrade client sockets.
 */

const CONSENT_WINDOW_MS = 15 * 60 * 1000;
const META_JWT_RAW = 'membership_jwt_raw';
const META_JWT_CLAIMS = 'membership_jwt_claims';

export function requireUserConsent(sql, getMeta) {
  const claimsRaw = getMeta(META_JWT_CLAIMS);
  if (!claimsRaw) {
    return { ok: false, reason: 'no_membership_token' };
  }
  let claims;
  try {
    claims = JSON.parse(claimsRaw);
  } catch {
    return { ok: false, reason: 'invalid_membership_claims' };
  }
  const exp = claims.expires_at ?? claims.exp;
  if (exp != null && Number(exp) < Date.now() / 1000) {
    return { ok: false, reason: 'membership_token_expired' };
  }

  const rows = sql
    .exec(
      `SELECT id, event_type, created_at FROM pod_events
       WHERE event_type IN ('consent_to_sync', 'sync_initiated')
       ORDER BY id DESC LIMIT 8`
    )
    .toArray();

  const now = Date.now();
  let lastConsentId = null;
  let lastConsentAt = null;
  for (const row of rows) {
    if (row.event_type === 'consent_to_sync') {
      lastConsentId = row.id;
      lastConsentAt = Date.parse(row.created_at);
      break;
    }
  }
  if (!lastConsentId || !lastConsentAt) {
    return { ok: false, reason: 'no_consent_event' };
  }
  if (now - lastConsentAt > CONSENT_WINDOW_MS) {
    return { ok: false, reason: 'consent_expired' };
  }
  const syncAfterConsent = rows.some(
    (r) => r.event_type === 'sync_initiated' && r.id > lastConsentId
  );
  if (syncAfterConsent) {
    return { ok: false, reason: 'consent_already_consumed' };
  }
  return { ok: true, claims };
}

export function appendInternalEvent(sql, bumpClock, eventType, payloadObj) {
  const clock = bumpClock();
  const now = new Date().toISOString();
  const payload = JSON.stringify(payloadObj || {});
  sql.exec(
    `INSERT INTO pod_events (event_type, payload, sig, sync_status, lamport_clock, created_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
    eventType,
    payload,
    'internal',
    clock,
    now
  );
}

export async function syncWithCloud(ctx) {
  const { sql, getMeta, env, bumpClock } = ctx;
  const gate = requireUserConsent(sql, getMeta);
  if (!gate.ok) {
    appendInternalEvent(sql, bumpClock, 'sync_blocked', { reason: gate.reason });
    return { ok: false, blocked: true, reason: gate.reason };
  }

  const coopBase =
    getMeta('coop_url') || env.COOP_URL || env.VITE_COOP_URL || null;
  const coopWs =
    env.COOP_WS_URL ||
    (coopBase ? `${String(coopBase).replace(/\/$/, '')}/api/coop/ws` : null);
  if (!coopWs) {
    appendInternalEvent(sql, bumpClock, 'sync_blocked', { reason: 'coop_ws_not_configured' });
    return { ok: false, reason: 'coop_ws_not_configured' };
  }

  appendInternalEvent(sql, bumpClock, 'sync_initiated', {});

  const pending = sql
    .exec(
      `SELECT id, event_type, payload, lamport_clock FROM pod_events
       WHERE sync_status = 0 ORDER BY id ASC LIMIT 200`
    )
    .toArray();

  if (!pending.length) {
    return { ok: true, synced: 0 };
  }

  const jwt = getMeta(META_JWT_RAW);
  let wsRes;
  try {
    wsRes = await fetch(coopWs, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        Authorization: `Bearer ${jwt}`,
      },
    });
  } catch (e) {
    appendInternalEvent(sql, bumpClock, 'sync_blocked', {
      reason: 'fetch_failed',
      message: e?.message || String(e),
    });
    return { ok: false, transient: true, reason: 'fetch_failed' };
  }

  if (wsRes.status !== 101 || !wsRes.webSocket) {
    appendInternalEvent(sql, bumpClock, 'sync_blocked', {
      reason: 'ws_upgrade_failed',
      status: wsRes.status,
    });
    return { ok: false, transient: true, reason: 'ws_upgrade_failed' };
  }

  const ws = wsRes.webSocket;
  ws.accept();

  let acked = 0;
  try {
    for (const row of pending) {
      ws.send(
        JSON.stringify({
          kind: 'event',
          id: row.id,
          event_type: row.event_type,
          lamport_clock: row.lamport_clock,
          payload: row.payload,
        })
      );
    }
    const ackPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ ids: [] }), 30_000);
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data || '{}'));
          if (msg.kind === 'ack' && Array.isArray(msg.ids)) {
            clearTimeout(timeout);
            resolve(msg);
          }
        } catch {
          /* ignore */
        }
      });
    });
    const ack = await ackPromise;
    for (const id of ack.ids || []) {
      sql.exec(`UPDATE pod_events SET sync_status = 1 WHERE id = ?`, id);
      acked++;
    }
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }

  appendInternalEvent(sql, bumpClock, 'sync_completed', { acked, pending: pending.length });
  return { ok: true, synced: acked, pending: pending.length };
}
