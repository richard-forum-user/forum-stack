/**
 * Pod writes — every helper signs a `PUT` RPC and forwards it to the
 * Personal Pod DO via the Worker. File name kept ("solid-pod-write.js")
 * so importers don't change; the JSON-LD shapes in civic-vocab.js are
 * no longer used as a wire format and live on only as a documented
 * vocabulary.
 */

import { POLICY_VERSION } from "./civic-vocab.js";
import { loadMemberProfile } from "./member-store.js";
import { podRpc } from "./solid-session.js";

function requirePodSession() {
  const profile = loadMemberProfile();
  if (!profile?.credential_id) {
    throw new Error("Sign in to your Pod before saving data.");
  }
  return profile;
}

export async function writeCivicSubmissionToPod(row) {
  requirePodSession();
  const id = row.receipt_id;
  if (!id) throw new Error("civic submission missing receipt_id");
  await podRpc("PUT", `/civic/submissions/${encodeURIComponent(id)}`, {
    zip_code: row.zip_code || null,
    kind: row.kind || null,
    category_code: row.category_code || null,
    category_id: row.category_id != null ? Number(row.category_id) : null,
    category_label: row.category_label || "",
    comment: row.comment || "",
    egress_status: row.egress_status || "pending",
    vault_status: row.vault_status || null,
    sync_attempts: row.sync_attempts || 0,
    last_error: row.last_error || null,
    submitted_at: row.submitted_at || new Date().toISOString(),
    share_status: row.share_status || "private",
    consent_at: row.consent_at || null,
    policy_version: row.policy_version || POLICY_VERSION,
    withdrawn_at: row.withdrawn_at || null,
  });
  return { ok: true, id };
}

export async function writeJournalEntryToPod(row) {
  requirePodSession();
  const id = row.submission_id;
  if (!id) throw new Error("journal entry missing submission_id");
  await podRpc("PUT", `/journal/raw/${encodeURIComponent(id)}`, {
    submitted_at: row.submitted_at || new Date().toISOString(),
    raw_text: row.raw_text || "",
    source_context: row.source_context || "journal",
    user_category_id: row.user_category_id || null,
    user_category_label: row.user_category_label || null,
    processing_status: row.processing_status || "unprocessed",
    lexicon_version: row.lexicon_version || null,
  });
  return { ok: true, id };
}

export async function writeBehaviorToPod(row) {
  requirePodSession();
  const id = row.behavior_id;
  if (!id) throw new Error("behavior missing behavior_id");
  await podRpc("PUT", `/journal/behaviors/${encodeURIComponent(id)}`, {
    submission_id: row.submission_id || null,
    category: row.category || "",
    action: row.action || null,
    entity: row.entity || null,
    metadata_json: row.metadata_json || null,
    source: row.source || "rule:v1",
    confidence: Number(row.confidence ?? 0),
    reviewed: !!row.reviewed,
    created_at: row.created_at || new Date().toISOString(),
  });
  return { ok: true, id };
}

export async function writeTraitToPod(row) {
  requirePodSession();
  const id = row.psycho_id;
  if (!id) throw new Error("trait missing psycho_id");
  await podRpc("PUT", `/journal/traits/${encodeURIComponent(id)}`, {
    submission_id: row.submission_id || null,
    category: row.category || "",
    attribute: row.attribute || "",
    sentiment: row.sentiment != null ? Number(row.sentiment) : null,
    source: row.source || "rule:v1",
    confidence: Number(row.confidence ?? 0),
    reviewed: !!row.reviewed,
    created_at: row.created_at || new Date().toISOString(),
  });
  return { ok: true, id };
}

/**
 * Persist one Civic AI Kami chat message into the Pod DO. The Pod is the
 * source of truth for the conversation; the device IDB is a cache. We
 * write user messages before the model is invoked (so the request is
 * durably attributed even if generation fails) and write assistant
 * messages after streaming completes.
 */
export async function writeAssistantMessageToPod(conversationId, message) {
  requirePodSession();
  const convId = conversationId || "default";
  const msgId = message?.id;
  if (!msgId) throw new Error("assistant message missing id");
  const role = message.role === "assistant" ? "assistant" : "user";
  await podRpc(
    "PUT",
    `/assistant/conversations/${encodeURIComponent(convId)}/messages/${encodeURIComponent(msgId)}`,
    {
      role,
      content: String(message.content || ""),
      created_at: message.created_at || new Date().toISOString(),
    }
  );
  return { ok: true, conversation_id: convId, message_id: msgId };
}

/** Wipe a single assistant conversation from the Pod DO. */
export async function deleteAssistantConversationFromPod(conversationId) {
  requirePodSession();
  const convId = conversationId || "default";
  await podRpc(
    "DELETE",
    `/assistant/conversations/${encodeURIComponent(convId)}`
  );
  return { ok: true, conversation_id: convId };
}

/**
 * Wipe every assistant conversation in the Pod DO. Used on sign-out so
 * the chat history doesn't survive the session, matching the user's
 * chosen behaviour for the Civic AI Kami (see Handover 13).
 */
export async function deleteAllAssistantConversationsFromPod() {
  requirePodSession();
  await podRpc("DELETE", "/assistant/conversations");
  return { ok: true };
}

