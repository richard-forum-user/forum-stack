/**
 * Export all raw data from the browser's IndexedDB Pod store.
 * This is the self-custody guarantee — the user's durable copy lives here
 * and in files they download, not in the cooperative cloud.
 */

import {
  getBehaviors,
  getPsychographics,
  getRawSubmissions,
  getSubmissions,
} from "./pod-store.js";
import { loadMemberProfile, loadSigningMeta } from "./member-store.js";
import { loadRecoveryEnrollment, loadRecoveryReceipts } from "./recovery-phrase.js";

const EXPORT_KIND = "forum-personal-pod-local-export-v1";

function base64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function buildLocalDataExport() {
  const [submissions, rawSubmissions, behaviors, psychographics] = await Promise.all([
    getSubmissions(),
    getRawSubmissions(),
    getBehaviors(),
    getPsychographics(),
  ]);
  return {
    kind: EXPORT_KIND,
    exported_at: new Date().toISOString(),
    member: loadMemberProfile(),
    signing: loadSigningMeta(),
    recovery: loadRecoveryEnrollment(),
    recovery_receipts: loadRecoveryReceipts(),
    data: {
      civic_submissions: submissions,
      raw_submissions: rawSubmissions,
      behavioral_data: behaviors,
      psychographic_data: psychographics,
    },
  };
}

export async function downloadLocalDataExport(filename) {
  const payload = await buildLocalDataExport();
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download =
    filename ||
    `forum-pod-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return payload;
}

export async function importLocalDataExport(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Export file is not valid JSON: ${e.message}`);
  }
  if (parsed?.kind !== EXPORT_KIND) {
    throw new Error(`Unexpected export kind: ${parsed?.kind || "(missing)"}`);
  }
  return parsed;
}

export function exportAsShareableBlob(payload) {
  return base64urlEncode(JSON.stringify(payload));
}
