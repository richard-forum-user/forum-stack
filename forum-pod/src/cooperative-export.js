import { POLICY_VERSION, clampForumFeedbackComment } from "./civic-vocab.js";
import { ensurePodSigningKey, signBundle } from "./pod-signing.js";
import { loadMemberProfile, loadSigningMeta } from "./member-store.js";
import { findInsightCategory } from "./insight-categories.js";
import { enrichSignedEnvelope } from "./signing-envelope.js";

const FORUM_FEEDBACK_PATH = "/api/forum/feedback";

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a non-PII member identifier from the device's Ed25519 public
 * key. Schema columns on the cooperative ledger are still named
 * `email_hash` (legacy), so we hand them this device-derived hash to
 * satisfy NOT NULL constraints. Nothing here maps back to an email.
 */
async function deriveMemberHash(publicKeyHex) {
  if (!publicKeyHex) return null;
  const bytes = new TextEncoder().encode(publicKeyHex);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(digest);
}

/**
 * Build a v1.5 Forum Feedback payload.
 *
 * `row` is a record from the local `civic_submissions` IndexedDB store.
 * It may carry either the v1.5 fields (kind, category_code, category_label)
 * or the legacy v1.4 civic fields (category_id, category_label). This
 * helper normalises both into the canonical wire shape.
 */
export function buildForumFeedbackPayload(row, webId, memberHash) {
  let kind = row.kind;
  let categoryCode = row.category_code;
  let categoryLabel = row.category_label;

  if (!categoryCode) {
    // Legacy civic row: collapse into 'civic-legacy' so the cooperative
    // ledger can tell pre-v1.5 from v1.5+ rows. The granular label is
    // preserved.
    categoryCode = "civic-legacy";
    kind = "civic";
    categoryLabel = categoryLabel || `Civic tier ${row.category_id}`;
  } else if (!kind) {
    const lookup = findInsightCategory(categoryCode) || findInsightCategory(row.category_id);
    kind = lookup?.kind || "behavioral";
  }

  return {
    type: "FORUM_FEEDBACK_V1",
    consent: true,
    consent_at: row.consent_at || new Date().toISOString(),
    policy_version: row.policy_version || POLICY_VERSION,
    webId: webId || null,
    email_hash: memberHash || null,
    domain_hash: null,
    receipt_id: row.receipt_id,
    kind,
    category_code: categoryCode,
    category_label: categoryLabel,
    category_id: row.category_id != null ? Number(row.category_id) : null,
    zip_code: row.zip_code || null,
    comment: clampForumFeedbackComment(row.comment),
    egress_status: row.egress_status || "pending",
    vault_status: row.vault_status || null,
    sync_attempts: Number(row.sync_attempts || 0),
    last_error: row.last_error || null,
    submitted_at: row.submitted_at || new Date().toISOString(),
    share_status: row.share_status || "cooperative",
    updated_at: new Date().toISOString(),
  };
}

export function cooperativeBaseUrl() {
  // The cooperative is a distinct worker from the Personal Pod / airlock.
  // Never fall back to VITE_SERVER_URL (the pod URL) — that worker has no
  // /api/forum/feedback route and returns route_not_found.
  return (
    import.meta.env.VITE_COOP_URL ||
    "https://coop.yourcommunity.forum"
  ).replace(/\/$/, "");
}

export async function fetchCooperativeReceiptStatus(receiptId) {
  const base = cooperativeBaseUrl();
  if (!base || !receiptId) return null;
  const res = await fetch(
    `${base}/api/forum/feedback/status?receipt_id=${encodeURIComponent(receiptId)}`
  );
  if (!res.ok) return null;
  return res.json();
}

/** v1.4 alias. Kept so existing callers keep compiling. */
export const buildCivicExportPayload = buildForumFeedbackPayload;

export async function postForumFeedback(row, coopUrlOverride) {
  const base = (coopUrlOverride || cooperativeBaseUrl()).replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "Cooperative URL is not configured. Set VITE_COOP_URL in Settings or .env."
    );
  }
  const profile = loadMemberProfile();
  if (!profile?.credential_id) {
    throw new Error("Create a Pod before opting in to cooperative share.");
  }
  const meta = await ensurePodSigningKey();
  const sessionId = meta.sessionId;
  const signingMeta = loadSigningMeta() || meta;
  const memberHash = await deriveMemberHash(signingMeta.publicKeyHex);
  if (!memberHash) {
    throw new Error("Pod signing key is missing. Re-create your Pod.");
  }
  const payload = buildForumFeedbackPayload(row, profile.webId, memberHash);
  const signed = enrichSignedEnvelope(await signBundle(payload, sessionId));
  signed.emailHash = memberHash;
  const res = await fetch(`${base}${FORUM_FEEDBACK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signed),
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(
      `Forum Feedback export failed (${res.status}): ${snippet || "non-JSON response"}`
    );
  }
  if (!res.ok) {
    throw new Error(
      data.message || data.error || `Forum Feedback export failed (${res.status})`
    );
  }
  return data;
}

/** v1.4 alias. */
export const postCooperativeExport = postForumFeedback;
