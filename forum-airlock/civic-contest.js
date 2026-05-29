/**
 * POST /api/civic/contest — freeze contested rows during the 7-day window.
 */

import { verifySignedBundle } from './pod-signing-web.js';
import { sessionIdMatchesPubkey } from './session-binding.js';
import { secretsEqual } from './secret-compare.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function handleCivicContestRoute(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const path = url.pathname.replace(/\/$/, '');

  if (path === '/api/forum/feedback/receipt' && request.method === 'GET') {
    const receiptId = url.searchParams.get('receipt_id');
    if (!receiptId || !env.DB) {
      return json({ error: 'receipt_id required' }, 400);
    }
    const row = await env.DB.prepare(
      `SELECT receipt_id, payload_sha256, ingested_at, report_id, wiped_at
       FROM forum_deletion_receipts WHERE receipt_id = ?`
    )
      .bind(receiptId)
      .first();
    if (!row) {
      return json({ error: 'receipt_not_found', receipt_id: receiptId }, 404);
    }
    return json(row);
  }

  if (path === '/api/forum/feedback/status' && request.method === 'GET') {
    const receiptId = url.searchParams.get('receipt_id');
    if (!receiptId || !env.DB) {
      return json({ error: 'receipt_id required' }, 400);
    }
    const row = await env.DB.prepare(
      `SELECT receipt_id, egress_status, contest_window_ends_at, wiped_at
       FROM forum_feedback WHERE receipt_id = ?`
    )
      .bind(receiptId)
      .first();
    if (!row) {
      return json({ status: 'not_in_coop', receipt_id: receiptId });
    }
    if (row.wiped_at) {
      return json({ status: 'wiped_from_coop', receipt_id: receiptId });
    }
    if (
      row.contest_window_ends_at &&
      row.contest_window_ends_at < new Date().toISOString().slice(0, 19).replace('T', ' ')
    ) {
      return json({ status: 'eligible_for_wipe', receipt_id: receiptId });
    }
    if (row.contest_window_ends_at) {
      return json({
        status: 'in_contest_window',
        receipt_id: receiptId,
        contest_window_ends_at: row.contest_window_ends_at,
      });
    }
    return json({ status: 'held', receipt_id: receiptId, egress_status: row.egress_status });
  }

  if (path !== '/api/civic/contest' || request.method !== 'POST') {
    return json({ error: 'not_found' }, 404);
  }

  if (!env.DB) {
    return json({ error: 'D1 not configured' }, 503);
  }

  let outer;
  try {
    outer = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const binding = await sessionIdMatchesPubkey(outer.sessionId, outer.publicKeyHex);
  if (!binding) {
    return json({ error: 'session_binding_failed' }, 401);
  }
  const verdict = await verifySignedBundle(outer, null);
  if (!verdict.valid) {
    return json({ error: 'auth_failed', reason: verdict.reason }, 401);
  }

  const payload = verdict.payload || outer;
  const reportId = payload.report_id;
  const receiptId = payload.receipt_id;
  const claimText = payload.claim_text;
  if (!reportId || !receiptId || !claimText) {
    return json({ error: 'report_id, receipt_id, claim_text required' }, 400);
  }

  const claimId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO forum_contest_claims
       (claim_id, report_id, receipt_id, claim_text, claim_signature)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(claimId, reportId, receiptId, claimText, outer.signature || '')
    .run();

  await env.DB.prepare(
    `UPDATE forum_feedback SET contest_window_ends_at = NULL WHERE receipt_id = ?`
  )
    .bind(receiptId)
    .run();

  return json({ ok: true, claim_id: claimId, status: 'pending' });
}
