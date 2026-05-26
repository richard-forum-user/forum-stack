export const FORUM = "https://forum.yourcommunity.forum/vocab#";
export const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
export const DCTERMS = "http://purl.org/dc/terms/";
export const SCHEMA = "https://schema.org/";

export const POLICY_VERSION = "coop-data-policy/2026-05-01";

function podBase(podRoot) {
  return (podRoot || "").replace(/\/$/, "") + "/";
}

export function journalContainerUrl(podRoot) {
  return `${podBase(podRoot)}journal/`;
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

export function journalEntryToJsonLd(row) {
  return {
    "@context": { forum: FORUM, dct: DCTERMS },
    "@type": "forum:JournalEntry",
    "dct:identifier": row.submission_id,
    "dct:created": row.submitted_at,
    "forum:rawText": row.raw_text,
    "forum:sourceContext": row.source_context || "journal",
    "forum:userCategoryId": row.user_category_id,
    "forum:userCategoryLabel": row.user_category_label,
    "forum:processingStatus": row.processing_status,
    "forum:lexiconVersion": row.lexicon_version || null,
  };
}

export function jsonLdToJournalEntry(doc) {
  if (!doc) return null;
  const id = doc["dct:identifier"] || doc[`${DCTERMS}identifier`];
  if (!id) return null;
  return {
    submission_id: id,
    submitted_at: doc["dct:created"] || doc[`${DCTERMS}created`] || new Date().toISOString(),
    raw_text: doc["forum:rawText"] || doc[`${FORUM}rawText`] || "",
    source_context: doc["forum:sourceContext"] || doc[`${FORUM}sourceContext`] || "journal",
    user_category_id: doc["forum:userCategoryId"] || doc[`${FORUM}userCategoryId`] || null,
    user_category_label: doc["forum:userCategoryLabel"] || doc[`${FORUM}userCategoryLabel`] || null,
    processing_status: doc["forum:processingStatus"] || doc[`${FORUM}processingStatus`] || "unprocessed",
    lexicon_version: doc["forum:lexiconVersion"] || doc[`${FORUM}lexiconVersion`] || null,
  };
}

export function journalEntryResourceUrl(podRoot, submissionId) {
  return `${podBase(podRoot)}journal/raw/${submissionId}.jsonld`;
}

export function behaviorToJsonLd(row) {
  return {
    "@context": { forum: FORUM, dct: DCTERMS },
    "@type": "forum:Behavior",
    "dct:identifier": row.behavior_id,
    "forum:submissionId": row.submission_id,
    "forum:category": row.category,
    "forum:action": row.action || null,
    "forum:entity": row.entity || null,
    "forum:metadataJson": row.metadata_json || null,
    "forum:source": row.source,
    "forum:confidence": row.confidence,
    "forum:reviewed": !!row.reviewed,
    "dct:created": row.created_at,
  };
}

export function jsonLdToBehavior(doc) {
  if (!doc) return null;
  const id = doc["dct:identifier"] || doc[`${DCTERMS}identifier`];
  if (!id) return null;
  return {
    behavior_id: id,
    submission_id: doc["forum:submissionId"] || doc[`${FORUM}submissionId`],
    category: doc["forum:category"] || doc[`${FORUM}category`],
    action: doc["forum:action"] || doc[`${FORUM}action`] || null,
    entity: doc["forum:entity"] || doc[`${FORUM}entity`] || null,
    metadata_json: doc["forum:metadataJson"] || doc[`${FORUM}metadataJson`] || null,
    source: doc["forum:source"] || doc[`${FORUM}source`] || "rule:v1",
    confidence: Number(doc["forum:confidence"] ?? doc[`${FORUM}confidence`] ?? 0),
    reviewed: !!(doc["forum:reviewed"] ?? doc[`${FORUM}reviewed`]),
    created_at: doc["dct:created"] || doc[`${DCTERMS}created`] || new Date().toISOString(),
  };
}

export function behaviorResourceUrl(podRoot, behaviorId) {
  return `${podBase(podRoot)}journal/behaviors/${behaviorId}.jsonld`;
}

export function traitToJsonLd(row) {
  return {
    "@context": { forum: FORUM, dct: DCTERMS },
    "@type": "forum:Trait",
    "dct:identifier": row.psycho_id,
    "forum:submissionId": row.submission_id,
    "forum:category": row.category,
    "forum:attribute": row.attribute,
    "forum:sentiment": row.sentiment ?? null,
    "forum:source": row.source,
    "forum:confidence": row.confidence,
    "forum:reviewed": !!row.reviewed,
    "dct:created": row.created_at,
  };
}

export function jsonLdToTrait(doc) {
  if (!doc) return null;
  const id = doc["dct:identifier"] || doc[`${DCTERMS}identifier`];
  if (!id) return null;
  return {
    psycho_id: id,
    submission_id: doc["forum:submissionId"] || doc[`${FORUM}submissionId`],
    category: doc["forum:category"] || doc[`${FORUM}category`],
    attribute: doc["forum:attribute"] || doc[`${FORUM}attribute`],
    sentiment: doc["forum:sentiment"] != null ? Number(doc["forum:sentiment"]) : null,
    source: doc["forum:source"] || doc[`${FORUM}source`] || "rule:v1",
    confidence: Number(doc["forum:confidence"] ?? doc[`${FORUM}confidence`] ?? 0),
    reviewed: !!(doc["forum:reviewed"] ?? doc[`${FORUM}reviewed`]),
    created_at: doc["dct:created"] || doc[`${DCTERMS}created`] || new Date().toISOString(),
  };
}

export function traitResourceUrl(podRoot, psychoId) {
  return `${podBase(podRoot)}journal/traits/${psychoId}.jsonld`;
}

