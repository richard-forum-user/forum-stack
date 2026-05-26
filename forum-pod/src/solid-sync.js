/**
 * Pod reads — every helper signs a `LIST` / `GET` RPC and forwards it
 * to the Personal Pod DO via the Worker. File name kept
 * ("solid-sync.js") so importers don't change.
 */

import { loadMemberProfile } from "./member-store.js";
import { podRpc } from "./solid-session.js";

function podSessionAvailable() {
  return !!loadMemberProfile()?.credential_id;
}

/**
 * Legacy: callers used to pass a Solid container URL and get back the
 * list of child resource URLs. The DO model exposes lists by
 * verb/path instead, so this helper is kept only for compatibility and
 * always returns an empty array. Real sync goes through the helpers
 * below.
 */
export async function listPodResourceUrls() {
  return [];
}

export async function listCivicSubmissionUrls() {
  return [];
}

export async function fetchCivicSubmission() {
  return null;
}

export async function listPodRows(path) {
  const body = await podRpc("LIST", path);
  return Array.isArray(body?.rows) ? body.rows : [];
}

async function safeList(path) {
  try {
    return await listPodRows(path);
  } catch (e) {
    console.warn(`[solid-sync] LIST ${path} failed:`, e.message);
    return null;
  }
}

export async function syncPodToDuckDB(connection, recordFn) {
  if (!podSessionAvailable()) {
    return { synced: 0, skipped: "not logged in" };
  }
  const rows = await safeList("/civic/submissions");
  if (rows === null) return { synced: 0, skipped: "pod_list_failed" };
  let synced = 0;
  for (const row of rows) {
    await recordFn(connection, {
      receipt_id: row.receipt_id,
      zip_code: row.zip_code,
      kind: row.kind,
      category_code: row.category_code,
      category_id: row.category_id,
      category_label: row.category_label,
      comment: row.comment,
      egress_status: row.egress_status,
      vault_status: row.vault_status,
      sync_attempts: row.sync_attempts || 0,
      last_error: row.last_error,
      submitted_at: row.submitted_at,
      share_status: row.share_status,
    });
    synced += 1;
  }
  return { synced };
}

export async function syncJournalEntriesFromPod(connection, recordFn) {
  if (!podSessionAvailable()) {
    return { synced: 0, skipped: "not logged in" };
  }
  const rows = await safeList("/journal/raw");
  if (rows === null) return { synced: 0, skipped: "pod_list_failed" };
  let synced = 0;
  for (const row of rows) {
    await recordFn(connection, row);
    synced += 1;
  }
  return { synced };
}

export async function syncBehaviorsFromPod(connection, recordFn) {
  if (!podSessionAvailable()) {
    return { synced: 0, skipped: "not logged in" };
  }
  const rows = await safeList("/journal/behaviors");
  if (rows === null) return { synced: 0, skipped: "pod_list_failed" };
  let synced = 0;
  for (const row of rows) {
    await recordFn(connection, row);
    synced += 1;
  }
  return { synced };
}

export async function syncTraitsFromPod(connection, recordFn) {
  if (!podSessionAvailable()) {
    return { synced: 0, skipped: "not logged in" };
  }
  const rows = await safeList("/journal/traits");
  if (rows === null) return { synced: 0, skipped: "pod_list_failed" };
  let synced = 0;
  for (const row of rows) {
    await recordFn(connection, row);
    synced += 1;
  }
  return { synced };
}

/**
 * Fetch every Civic AI Kami message for a single conversation from the
 * Pod DO. Used by the Assistant boot effect to rehydrate the local IDB
 * cache after sign-in. Returns rows shaped for the existing
 * assistant-store.js schema ({ id, role, content, created_at }).
 */
export async function syncAssistantConversationFromPod(conversationId = "default") {
  if (!podSessionAvailable()) {
    return { messages: [], skipped: "not logged in" };
  }
  const rows = await safeList(
    `/assistant/conversations/${encodeURIComponent(conversationId)}/messages`
  );
  if (rows === null) return { messages: [], skipped: "pod_list_failed" };
  const messages = rows.map((row) => ({
    id: row.message_id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content || "",
    created_at: row.created_at || new Date().toISOString(),
  }));
  return { messages };
}

