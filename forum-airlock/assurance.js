/**
 * Assurance tiers for cooperative submissions.
 *
 * The coop decides the tier at ingest from its own records. Nothing the pod
 * sends can raise it.
 *
 *   unverified      valid signed bundle only (passkey-unlocked pod)
 *   paid            the submitting pod key belongs to a paid, active membership
 *   paid_zip_match  paid, card issuer confirmed the billing ZIP, and it equals
 *                   the ZIP on the submission
 *
 * Reports publish counts per tier so readers can weigh them. ID checks are
 * deliberately not part of these tiers; they belong only where money moves
 * (e.g. Stripe Connect payouts, where Stripe performs them).
 */

export const TIERS = ['unverified', 'paid', 'paid_zip_match'];

export const TIER_LABELS = {
  unverified: 'Unverified (signed pod, no payment)',
  paid: 'Paid member',
  paid_zip_match: 'Paid member, card-confirmed billing ZIP matches submission ZIP',
};

const enc = new TextEncoder();

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(String(text))));
}

/** Stable identifier for a pod signing key in the paid-key table. */
export async function paidKeyHash(publicKeyHex) {
  return sha256Hex(`paid-key:v1:${String(publicKeyHex || '').toLowerCase()}`);
}

export function zip5(zip) {
  const digits = String(zip || '').replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

let schemaReady = false;

/** Idempotent. Adds coop_paid_keys and forum_feedback.assurance_tier. */
export async function ensureAssuranceSchema(db) {
  if (schemaReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS coop_paid_keys (
        key_hash TEXT PRIMARY KEY,
        checkout_session TEXT UNIQUE,
        payment_intent TEXT,
        card_fingerprint_hash TEXT,
        billing_zip TEXT,
        postal_check TEXT,
        over_card_limit INTEGER NOT NULL DEFAULT 0,
        paid_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        revoked_reason TEXT
      )`
    )
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_paid_keys_card ON coop_paid_keys(card_fingerprint_hash)`)
    .run();
  await db
    .prepare(`CREATE INDEX IF NOT EXISTS idx_paid_keys_pi ON coop_paid_keys(payment_intent)`)
    .run();
  try {
    await db
      .prepare(`ALTER TABLE forum_feedback ADD COLUMN assurance_tier TEXT NOT NULL DEFAULT 'unverified'`)
      .run();
  } catch (e) {
    // Column already exists, or forum_feedback not created yet (ingest creates
    // it first, then calls this again).
    const msg = String(e?.message || e);
    if (!/duplicate column/i.test(msg) && !/no such table/i.test(msg)) throw e;
    if (/no such table/i.test(msg)) return;
  }
  schemaReady = true;
}

/** For tests. */
export function _resetAssuranceSchemaFlag() {
  schemaReady = false;
}

/**
 * Decide the tier for a submission from coop records only.
 * @returns {Promise<'unverified'|'paid'|'paid_zip_match'>}
 */
export async function tierForSubmission(db, publicKeyHex, submissionZip) {
  if (!publicKeyHex) return 'unverified';
  const keyHash = await paidKeyHash(publicKeyHex);
  const row = await db
    .prepare(
      `SELECT billing_zip, postal_check FROM coop_paid_keys
       WHERE key_hash = ? AND revoked = 0 AND over_card_limit = 0
         AND expires_at > datetime('now')`
    )
    .bind(keyHash)
    .first();
  if (!row) return 'unverified';
  const sub = zip5(submissionZip);
  if (row.postal_check === 'pass' && sub && row.billing_zip === sub) return 'paid_zip_match';
  return 'paid';
}

/**
 * Verify a Stripe webhook signature (scheme v1, HMAC-SHA256 over "t.payload").
 * https://docs.stripe.com/webhooks#verify-manually
 */
export async function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowSec = null) {
  if (!header || !secret) return false;
  const parts = {};
  const v1 = [];
  for (const piece of String(header).split(',')) {
    const i = piece.indexOf('=');
    if (i < 0) continue;
    const k = piece.slice(0, i).trim();
    const v = piece.slice(i + 1).trim();
    if (k === 'v1') v1.push(v);
    else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !v1.length) return false;
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const expected = toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`)));
  return v1.some((sig) => constantTimeEqualHex(sig, expected));
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
