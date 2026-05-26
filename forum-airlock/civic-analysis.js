/**
 * Cooperative aggregate analysis at the Cloudflare edge.
 *
 * Faithfulness model (matches legacy forum-ai aggregate.py):
 *   - D1 SQL is the ONLY source of truth.
 *   - The report lists exact query results and the full submission ledger.
 *   - No generative model; nothing is invented or interpreted beyond SQL.
 *   - If a question cannot be answered from the ledger, the report says so.
 *
 * Comments are stored in full up to FORUM_FEEDBACK_MAX_COMMENT_CHARS (set in the Pod).
 */

import {
  FORUM_FEEDBACK_MAX_COMMENT_CHARS,
  clampForumFeedbackComment,
} from './feedback-limits.js';

const ANALYSIS_PREFIX = '/api/civic/analysis';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Airlock-Secret',
};

const SQL_SOURCES = {
  total: `SELECT COUNT(*) AS n FROM forum_feedback WHERE wiped_at IS NULL`,
  distinctParticipants: `SELECT COUNT(DISTINCT email_hash) AS n FROM forum_feedback WHERE wiped_at IS NULL`,
  byCategory: `SELECT category_code, category_label, kind, COUNT(*) AS n
    FROM forum_feedback WHERE wiped_at IS NULL
    GROUP BY category_code, category_label, kind ORDER BY n DESC`,
  byZip: `SELECT zip_code, COUNT(*) AS n FROM forum_feedback
    WHERE wiped_at IS NULL AND zip_code IS NOT NULL AND zip_code != ''
    GROUP BY zip_code ORDER BY n DESC`,
  ledger: `SELECT receipt_id, kind, category_code, category_label, zip_code, comment, consent_at, created_at
    FROM forum_feedback WHERE wiped_at IS NULL ORDER BY created_at ASC`,
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function verifyAirlock(request, env) {
  const secret = request.headers.get('X-Airlock-Secret');
  return secret && env.AIRLOCK_SECRET && secret === env.AIRLOCK_SECRET;
}

/** Redact direct identifiers in published text; do not truncate length. */
export function redactIdentifiers(text) {
  if (!text) return '';
  return String(text)
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[email]')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]')
    .replace(/\s+/g, ' ')
    .trim();
}

function zipPrefix(zip) {
  const digits = String(zip || '').replace(/\D/g, '');
  return digits.length >= 3 ? digits.slice(0, 3) : digits || null;
}

export async function ensureAnalysisSchema(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS civic_analysis_reports (
      report_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      opt_in_count INTEGER NOT NULL DEFAULT 0,
      submission_count INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL,
      report_text TEXT NOT NULL,
      model TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_civic_analysis_created
    ON civic_analysis_reports(created_at)
  `).run();
}

/**
 * Read the cooperative ledger from D1 — full comment text per row.
 */
export async function collectLedgerFromD1(db) {
  const totalRow = await db.prepare(SQL_SOURCES.total).first();
  const total = Number(totalRow?.n || 0);

  const distinctParticipants = Number(
    (await db.prepare(SQL_SOURCES.distinctParticipants).first())?.n || 0
  );

  const byCategory = (await db.prepare(SQL_SOURCES.byCategory).all()).results || [];
  const byZip = (await db.prepare(SQL_SOURCES.byZip).all()).results || [];

  const zipPrefixCounts = {};
  for (const row of byZip) {
    const prefix = zipPrefix(row.zip_code);
    if (!prefix) continue;
    zipPrefixCounts[prefix] = (zipPrefixCounts[prefix] || 0) + Number(row.n || 0);
  }

  const rawLedger = (await db.prepare(SQL_SOURCES.ledger).all()).results || [];
  const ledger = rawLedger.map((row) => ({
    receipt_id: row.receipt_id,
    kind: row.kind,
    category_code: row.category_code,
    category_label: row.category_label,
    zip_code: row.zip_code || null,
    comment: redactIdentifiers(row.comment || ''),
    comment_length: String(row.comment || '').length,
    consent_at: row.consent_at,
    created_at: row.created_at,
  }));

  return {
    total,
    distinctParticipants,
    byCategory: byCategory.map((r) => ({
      category_code: r.category_code,
      category_label: r.category_label,
      kind: r.kind,
      count: Number(r.n || 0),
    })),
    zipPrefixCounts,
    ledger,
    sql: SQL_SOURCES,
    maxCommentChars: FORUM_FEEDBACK_MAX_COMMENT_CHARS,
  };
}

/**
 * Build a human-readable report that only states what SQL returned.
 */
export function buildFaithfulReport(ledger, reportId) {
  const lines = [];
  lines.push('# Cooperative aggregate report (D1 / SQL only)');
  lines.push('');
  lines.push(`Generated: ${reportId}`);
  lines.push(`Source table: forum_feedback (wiped_at IS NULL)`);
  lines.push(`Comment length cap at ingest: ${ledger.maxCommentChars} characters (enforced in Pod)`);
  lines.push('');
  lines.push('## Aggregate counts');
  lines.push('');
  lines.push(`Total submissions: ${ledger.total}`);
  lines.push(`Distinct participant hashes: ${ledger.distinctParticipants}`);
  lines.push('');
  lines.push('### By category');
  if (!ledger.byCategory.length) {
    lines.push('- (none)');
  } else {
    for (const row of ledger.byCategory) {
      lines.push(
        `- ${row.category_label} (\`${row.category_code}\`, ${row.kind}): ${row.count}`
      );
    }
  }
  lines.push('');
  lines.push('### ZIP area prefixes (first 3 digits only)');
  const zipEntries = Object.entries(ledger.zipPrefixCounts).sort((a, b) => b[1] - a[1]);
  if (!zipEntries.length) {
    lines.push('- (none)');
  } else {
    for (const [prefix, n] of zipEntries) {
      lines.push(`- ${prefix}: ${n}`);
    }
  }
  lines.push('');
  lines.push('## Full submission ledger');
  lines.push('');
  if (!ledger.ledger.length) {
    lines.push('_No rows in D1. The cooperative cannot answer questions about submissions._');
  } else {
    for (const row of ledger.ledger) {
      lines.push(`### ${row.receipt_id}`);
      lines.push(`- kind: ${row.kind}`);
      lines.push(`- category: ${row.category_label} (\`${row.category_code}\`)`);
      lines.push(`- zip_code: ${row.zip_code ?? '(not provided)'}`);
      lines.push(`- submitted: ${row.created_at}`);
      lines.push(`- comment (${row.comment_length} chars):`);
      lines.push('');
      lines.push(row.comment || '(empty)');
      lines.push('');
    }
  }
  lines.push('## SQL queries used');
  lines.push('');
  for (const [name, sql] of Object.entries(ledger.sql)) {
    lines.push(`### ${name}`);
    lines.push('```sql');
    lines.push(sql.trim());
    lines.push('```');
    lines.push('');
  }
  lines.push('## Faithfulness boundary');
  lines.push('');
  lines.push(
    'This report does not include sentiment scores, bridging indices, trend forecasts, ' +
      'or narrative synthesis. Those are not in D1 and cannot be stated faithfully here.'
  );
  if (ledger.total < 10) {
    lines.push('');
    lines.push(
      `Only ${ledger.total} submission(s) are in the ledger. Category-level or geographic ` +
        'conclusions beyond the counts and verbatim comments above would not be faithful.'
    );
  }
  lines.push('');
  lines.push(
    '_Every count and comment above is copied from D1. If you need an answer that is not ' +
      'listed here, the cooperative does not have it in the current ledger._'
  );
  return lines.join('\n');
}

async function pushReportToEgress(env, payload) {
  const url = (env.FORUM_EGRESS_URL || '').replace(/\/$/, '');
  const secret = env.FORUM_SECRET || '';
  if (!url || !secret) return { pushed: false, reason: 'egress_not_configured' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forum-Secret': secret,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    return { pushed: res.ok, status: res.status, body: text.slice(0, 200) };
  } catch (e) {
    return { pushed: false, reason: e?.message || 'egress_fetch_failed' };
  }
}

export async function runCivicAnalysis(env, options = {}) {
  if (!env.DB) {
    return { ok: false, error: 'D1 binding DB is not configured' };
  }

  const minSubmissions = Number(env.CIVIC_ANALYSIS_MIN_SUBMISSIONS || '1');
  await ensureAnalysisSchema(env.DB);
  const ledger = await collectLedgerFromD1(env.DB);

  if (ledger.total < minSubmissions) {
    return {
      ok: true,
      skipped: true,
      reason: `fewer than ${minSubmissions} submissions in D1`,
      ledger: { total: ledger.total },
    };
  }

  const reportId = new Date().toISOString();
  const reportText = buildFaithfulReport(ledger, reportId);

  const metadata = {
    project: 'The Forum Initiative',
    timestamp: reportId,
    volume: ledger.total,
    opt_in_count: ledger.total,
    distinct_participant_hashes: ledger.distinctParticipants,
    policy_version: 'coop-data-policy/2026-05-01',
    status: options.publish ? 'published' : 'review',
    formation_pilot: true,
    engine: 'd1-sql-faithful',
    model: null,
    synthesis: 'disabled',
    trigger: options.trigger || 'manual',
    max_comment_chars: FORUM_FEEDBACK_MAX_COMMENT_CHARS,
    disclaimer:
      'This report lists only what is in cooperative D1 forum_feedback. ' +
      'It is not a census. No generative model is used.',
    ledger,
  };

  const payload = { metadata, report: reportText };

  await env.DB.prepare(
    `INSERT INTO civic_analysis_reports
       (report_id, status, opt_in_count, submission_count, metadata_json, report_text, model)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      reportId,
      metadata.status,
      ledger.total,
      ledger.total,
      JSON.stringify(metadata),
      reportText,
      null
    )
    .run();

  let egress = { pushed: false };
  if (options.publish) {
    egress = await pushReportToEgress(env, payload);
  }

  return {
    ok: true,
    report_id: reportId,
    metadata,
    synthesis: 'disabled',
    egress,
    stats: {
      total: ledger.total,
      categories: ledger.byCategory.length,
    },
  };
}

export async function getLatestAnalysisReport(db) {
  await ensureAnalysisSchema(db);
  const row = await db
    .prepare(
      `SELECT report_id, status, opt_in_count, submission_count, metadata_json, report_text, model, created_at
       FROM civic_analysis_reports
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .first();
  if (!row) return null;
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || '{}');
  } catch {
    metadata = {};
  }
  return {
    metadata,
    report: row.report_text,
    report_id: row.report_id,
    model: row.model,
    created_at: row.created_at,
    ledger: metadata.ledger || null,
  };
}

export async function handleCivicAnalysisRoute(request, env, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!env.DB) {
    return jsonResponse({ error: 'D1 binding DB is not configured' }, 503);
  }

  const path = url.pathname.replace(/\/$/, '') || ANALYSIS_PREFIX;

  if (request.method === 'GET' && (path === ANALYSIS_PREFIX || path === `${ANALYSIS_PREFIX}/latest`)) {
    const latest = await getLatestAnalysisReport(env.DB);
    if (!latest) {
      return jsonResponse({ error: 'No analysis report has been generated yet' }, 404);
    }
    return jsonResponse(latest);
  }

  if (request.method === 'GET' && path === `${ANALYSIS_PREFIX}/ledger`) {
    const ledger = await collectLedgerFromD1(env.DB);
    return jsonResponse({
      source: 'forum_feedback',
      faithful: true,
      ...ledger,
    });
  }

  if (request.method === 'POST' && path === `${ANALYSIS_PREFIX}/run`) {
    if (!verifyAirlock(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* empty body ok */
    }
    const result = await runCivicAnalysis(env, {
      trigger: body.trigger || 'api',
      publish: body.publish === true,
    });
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (request.method === 'POST' && path === `${ANALYSIS_PREFIX}/dev-push`) {
    if (env.ALLOW_DEV_CIVIC_PUBLISH !== '1') {
      return jsonResponse({ error: 'dev_push_disabled' }, 403);
    }
    const result = await runCivicAnalysis(env, {
      trigger: 'dev-push',
      publish: true,
    });
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (request.method === 'POST' && path === `${ANALYSIS_PREFIX}/publish`) {
    if (!verifyAirlock(request, env)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    const latest = await getLatestAnalysisReport(env.DB);
    if (!latest) {
      return jsonResponse({ error: 'No report to publish' }, 404);
    }
    latest.metadata.status = 'published';
    const egress = await pushReportToEgress(env, latest);
    await env.DB.prepare(
      `UPDATE civic_analysis_reports SET status = 'published', metadata_json = ? WHERE report_id = ?`
    )
      .bind(JSON.stringify(latest.metadata), latest.report_id)
      .run();
    return jsonResponse({ ok: true, egress, report_id: latest.report_id });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

export { clampForumFeedbackComment, FORUM_FEEDBACK_MAX_COMMENT_CHARS };
