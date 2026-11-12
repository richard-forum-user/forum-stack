export const FORUM = "https://forum.yourcommunity.forum/vocab#";
export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export const DCTERMS = "http://purl.org/dc/terms/";
export const SCHEMA = "https://schema.org/";

export const POLICY_VERSION = "coop-data-policy/2026-05-01";

/** Max comment length for Forum Feedback (Pod + cooperative D1). Keep in sync with forum-airlock/feedback-limits.js */
export const FORUM_FEEDBACK_MAX_COMMENT_CHARS = 2000;

export function clampForumFeedbackComment(text, maxChars = FORUM_FEEDBACK_MAX_COMMENT_CHARS) {
  const s = String(text ?? "").trim();
  const max = Number(maxChars) || FORUM_FEEDBACK_MAX_COMMENT_CHARS;
  if (s.length <= max) return s;
  return s.slice(0, max);
}

export function civicSubmissionToJsonLd(row) {
  const receipt = row.receipt_id;
  const subject = `${FORUM}submission/${receipt}`;
  return {
    "@context": {
      forum: FORUM,
      dct: DCTERMS,
      schema: SCHEMA,
    },
    "@id": subject,
    "@type": "forum:CivicSubmission",
    "dct:identifier": receipt,
    "schema:postalCode": row.zip_code,
    "schema:category": row.category_label,
    "forum:categoryId": row.category_id,
    "forum:categoryCode": row.category_code || null,
    "forum:kind": row.kind || null,
    "schema:text": row.comment,
    "dct:created": row.submitted_at,
    "forum:egressStatus": row.egress_status || "pending",
    "forum:shareStatus": row.share_status || "private",
    "forum:consentAt": row.consent_at || null,
    "forum:policyVersion": row.policy_version || POLICY_VERSION,
    "forum:withdrawnAt": row.withdrawn_at || null,
  };
}

export function jsonLdToCivicRow(doc, civicContainer) {
  if (!doc) return null;
  const id = doc["dct:identifier"] || doc[`${DCTERMS}identifier`];
  if (!id) return null;
  return {
    receipt_id: id,
    zip_code: doc["schema:postalCode"] || doc[`${SCHEMA}postalCode`] || "",
    kind: doc["forum:kind"] || doc[`${FORUM}kind`] || null,
    category_code: doc["forum:categoryCode"] || doc[`${FORUM}categoryCode`] || null,
    category_id: Number(doc["forum:categoryId"] || doc[`${FORUM}categoryId`] || 1),
    category_label: doc["schema:category"] || doc[`${SCHEMA}category`] || "",
    comment: doc["schema:text"] || doc[`${SCHEMA}text`] || "",
    submitted_at: doc["dct:created"] || doc[`${DCTERMS}created`] || new Date().toISOString(),
    egress_status: doc["forum:egressStatus"] || doc[`${FORUM}egressStatus`] || "pending",
    share_status: doc["forum:shareStatus"] || doc[`${FORUM}shareStatus`] || "private",
    consent_at: doc["forum:consentAt"] || doc[`${FORUM}consentAt`] || null,
    policy_version: doc["forum:policyVersion"] || doc[`${FORUM}policyVersion`] || null,
    pod_url: doc["@id"] || null,
    civic_container: civicContainer,
    sync_attempts: 0,
    last_error: null,
    vault_status: null,
  };
}

export function submissionResourceUrl(civicContainer, receiptId) {
  const base = civicContainer.endsWith("/") ? civicContainer : `${civicContainer}/`;
  return `${base}submissions/${receiptId}.jsonld`;
}
