import React, { useState, useEffect, useMemo, useCallback } from "react";
import * as duckdb from '@duckdb/duckdb-wasm';
import {
  clearAllPodData,
  getBehaviors,
  getPsychographics,
  getRawSubmissions,
  getSubmissions,
  patchSubmission,
  saveBehavior,
  savePsychographic,
  saveRawSubmission,
  saveSubmission,
} from "./pod-store.js";
import { CIVIC_CATEGORIES } from "./civic-categories.js";
import { INSIGHT_CATEGORIES, findInsightCategory } from "./insight-categories.js";
import {
  extractInsights,
  extractUserTags,
  LEXICON_VERSION,
} from "./insight-extractor.js";
import { recordCivicLocally } from "./pod-ui-sync.js";
import { POLICY_VERSION } from "./civic-vocab.js";
import SignInOverlay from "./sign-in-overlay.jsx";
import Assistant from "./assistant.jsx";
import Explore from "./explore.jsx";
import { clearAllAssistantConversations } from "./assistant-store.js";
import {
  clearMemberProfile,
  deleteAllAssistantConversationsFromPod,
  getSolidSession,
  handleSolidRedirect,
  listPodRows,
  loadMemberProfile,
  postCooperativeExport,
  solidLogout,
  writeBehaviorToPod,
  writeCivicSubmissionToPod,
  writeJournalEntryToPod,
  writeTraitToPod,
} from "./pod-solid-integration.js";
import { clearSolidSessionMeta } from "./solid-session.js";
import {
  exportDeviceKeyBlob,
  importDeviceKeyBlob,
  loadSigningMeta,
  saveMemberProfile,
  saveSigningMeta,
} from "./member-store.js";
import { deriveBoundSessionId, isBoundSessionId } from "./session-id.js";

const DEFAULT_FORUM_FEEDBACK_API =
  import.meta.env.VITE_FORUM_FEEDBACK_API ||
  import.meta.env.VITE_CIVIC_API || // legacy env var, still honoured
  "/api/forum/feedback";
const isNativeShell = window.location.protocol === "capacitor:";
const DEFAULT_SERVER_URL = import.meta.env.VITE_SERVER_URL || (isNativeShell ? "https://secure-worker.forum-community.workers.dev" : "");
const DEFAULT_POD_PROVIDER =
  import.meta.env.VITE_POD_PROVIDER_URL ||
  import.meta.env.VITE_SERVER_URL ||
  "http://localhost:3000";
const APP_BUILD = "secure-pod-v1.9-civic-ai";

const POD_USER = { id: "local", name: "Sovereign Member" };

function sqlEscape(v) {
  return String(v ?? "").replace(/'/g, "''");
}

async function setupCivicTables(connection) {
  // Legacy 4-tier civic taxonomy table. Retained for joining old rows.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS civic_categories (
      id INTEGER PRIMARY KEY,
      code VARCHAR NOT NULL,
      label VARCHAR NOT NULL,
      maslow_tier INTEGER NOT NULL
    );
  `);
  // Forum Feedback submissions. Table is still called `civic_submissions`
  // (data continuity) but now carries the broader v1.5 columns: `kind`
  // (behavioral/psychographic/civic) and `category_code` (the granular
  // INSIGHT_CATEGORIES id, e.g. 'purchasing', 'value'). The legacy
  // `category_id` INTEGER stays nullable so pre-v1.5 rows still hydrate.
  await connection.query(`
    CREATE TABLE IF NOT EXISTS civic_submissions (
      receipt_id VARCHAR PRIMARY KEY,
      zip_code VARCHAR,
      kind VARCHAR,
      category_code VARCHAR,
      category_id INTEGER,
      category_label VARCHAR NOT NULL,
      comment VARCHAR NOT NULL,
      egress_status VARCHAR NOT NULL,
      vault_status VARCHAR,
      sync_attempts INTEGER NOT NULL DEFAULT 0,
      last_error VARCHAR,
      submitted_at VARCHAR NOT NULL
    );
  `);
  for (const statement of [
    "ALTER TABLE civic_submissions ADD COLUMN IF NOT EXISTS sync_attempts INTEGER DEFAULT 0",
    "ALTER TABLE civic_submissions ADD COLUMN IF NOT EXISTS last_error VARCHAR",
    "ALTER TABLE civic_submissions ADD COLUMN IF NOT EXISTS kind VARCHAR",
    "ALTER TABLE civic_submissions ADD COLUMN IF NOT EXISTS category_code VARCHAR",
  ]) {
    try { await connection.query(statement); } catch { /* older in-memory tables can be recreated on reload */ }
  }
  // Friendly alias for v1.5+ queries; the table-of-record stays
  // civic_submissions but `forum_submissions` is what the UX names it.
  try {
    await connection.query(`CREATE OR REPLACE VIEW forum_submissions AS SELECT * FROM civic_submissions;`);
  } catch { /* DuckDB-WASM in older builds may not support CREATE OR REPLACE VIEW yet */ }

  for (const c of CIVIC_CATEGORIES) {
    await connection.query(`
      INSERT OR REPLACE INTO civic_categories (id, code, label, maslow_tier)
      VALUES (${c.id}, '${sqlEscape(c.code)}', '${sqlEscape(c.label)}', ${c.tier});
    `);
  }
}

/** Load all user data from the Pod DO into session cache (IndexedDB + DuckDB). */
async function hydrateFromPod(connection) {
  const [civicRows, journalRows, behaviorRows, traitRows] = await Promise.all([
    listPodRows("/civic/submissions"),
    listPodRows("/journal/raw"),
    listPodRows("/journal/behaviors"),
    listPodRows("/journal/traits"),
  ]);

  await clearAllPodData();

  for (const row of civicRows) {
    const localRow = {
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
    };
    await saveSubmission(localRow);
    await recordCivicLocally(connection, localRow);
  }
  for (const row of journalRows) {
    await saveRawSubmission(row);
    await recordRawSubmissionLocally(connection, row);
  }
  for (const row of behaviorRows) {
    await saveBehavior(row);
    await recordBehaviorLocally(connection, row);
  }
  for (const row of traitRows) {
    await savePsychographic(row);
    await recordPsychographicLocally(connection, row);
  }
}

async function setupInsightTables(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS raw_submissions (
      submission_id VARCHAR PRIMARY KEY,
      submitted_at VARCHAR NOT NULL,
      raw_text VARCHAR NOT NULL,
      source_context VARCHAR NOT NULL,
      user_category_id VARCHAR,
      user_category_label VARCHAR,
      processing_status VARCHAR NOT NULL,
      lexicon_version VARCHAR
    );
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS behavioral_data (
      behavior_id VARCHAR PRIMARY KEY,
      submission_id VARCHAR NOT NULL,
      category VARCHAR NOT NULL,
      action VARCHAR,
      entity VARCHAR,
      metadata_json VARCHAR,
      source VARCHAR NOT NULL,
      confidence DOUBLE NOT NULL,
      reviewed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at VARCHAR NOT NULL
    );
  `);
  await connection.query(`
    CREATE TABLE IF NOT EXISTS psychographic_data (
      psycho_id VARCHAR PRIMARY KEY,
      submission_id VARCHAR NOT NULL,
      category VARCHAR NOT NULL,
      attribute VARCHAR NOT NULL,
      sentiment DOUBLE,
      source VARCHAR NOT NULL,
      confidence DOUBLE NOT NULL,
      reviewed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at VARCHAR NOT NULL
    );
  `);
}

async function recordRawSubmissionLocally(connection, row) {
  await connection.query(`
    INSERT OR REPLACE INTO raw_submissions
      (submission_id, submitted_at, raw_text, source_context, user_category_id, user_category_label, processing_status, lexicon_version)
    VALUES (
      '${sqlEscape(row.submission_id)}',
      '${sqlEscape(row.submitted_at)}',
      '${sqlEscape(row.raw_text)}',
      '${sqlEscape(row.source_context)}',
      ${row.user_category_id ? `'${sqlEscape(row.user_category_id)}'` : "NULL"},
      ${row.user_category_label ? `'${sqlEscape(row.user_category_label)}'` : "NULL"},
      '${sqlEscape(row.processing_status || "unprocessed")}',
      ${row.lexicon_version ? `'${sqlEscape(row.lexicon_version)}'` : "NULL"}
    );
  `);
}

async function recordBehaviorLocally(connection, row) {
  await connection.query(`
    INSERT OR REPLACE INTO behavioral_data
      (behavior_id, submission_id, category, action, entity, metadata_json, source, confidence, reviewed, created_at)
    VALUES (
      '${sqlEscape(row.behavior_id)}',
      '${sqlEscape(row.submission_id)}',
      '${sqlEscape(row.category)}',
      ${row.action ? `'${sqlEscape(row.action)}'` : "NULL"},
      ${row.entity ? `'${sqlEscape(row.entity)}'` : "NULL"},
      ${row.metadata_json ? `'${sqlEscape(row.metadata_json)}'` : "NULL"},
      '${sqlEscape(row.source)}',
      ${Number(row.confidence) || 0},
      ${row.reviewed ? "TRUE" : "FALSE"},
      '${sqlEscape(row.created_at)}'
    );
  `);
}

async function recordPsychographicLocally(connection, row) {
  await connection.query(`
    INSERT OR REPLACE INTO psychographic_data
      (psycho_id, submission_id, category, attribute, sentiment, source, confidence, reviewed, created_at)
    VALUES (
      '${sqlEscape(row.psycho_id)}',
      '${sqlEscape(row.submission_id)}',
      '${sqlEscape(row.category)}',
      '${sqlEscape(row.attribute)}',
      ${row.sentiment !== undefined && row.sentiment !== null ? Number(row.sentiment) : "NULL"},
      '${sqlEscape(row.source)}',
      ${Number(row.confidence) || 0},
      ${row.reviewed ? "TRUE" : "FALSE"},
      '${sqlEscape(row.created_at)}'
    );
  `);
}


const fmt = (v) => {
  if (v === null || v === undefined) return <span style={{ color: "#4a5568" }}>NULL</span>;
  if (typeof v === "boolean") return <span style={{ color: "#f6ad55" }}>{String(v)}</span>;
  if (typeof v === "number") return <span style={{ color: "#68d391" }}>{v}</span>;
  if (typeof v === "bigint") return <span style={{ color: "#68d391" }}>{v.toString()}</span>;
  return String(v);
};

const S = {
  root: { 
      display: "flex", height: "100vh", background: "#090b0f", color: "#c9d1d9", 
      fontFamily: "'IBM Plex Mono', 'Fira Code', monospace", fontSize: 13, overflow: "hidden", 
      backgroundImage: "radial-gradient(ellipse at 20% 50%, rgba(22,40,60,0.4) 0%, transparent 60%)" 
  },
  sidebar: { 
      width: 220, flexShrink: 0, background: "rgba(13,17,23,0.95)", 
      borderRight: "1px solid #161b22", display: "flex", flexDirection: "column" 
  },
  podHeader: { padding: "16px 14px 12px", borderBottom: "1px solid #161b22" },
  podTitle: { display: "flex", alignItems: "center", gap: 8, marginBottom: 6 },
  podIcon: {
      width: 28, height: 28, background: "#05070a",
      border: "1px solid #1e4976", borderRadius: 6, display: "flex", 
      alignItems: "center", justifyContent: "center", overflow: "hidden"
  },
  podName: { fontWeight: 700, color: "#e6edf3", fontSize: 13, letterSpacing: "0.02em" },
  statusRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 2 },
  statusDot: (s) => ({ 
      width: 6, height: 6, borderRadius: "50%", flexShrink: 0, 
      background: s === "connected" ? "#3fb950" : s === "connecting" ? "#d29922" : "#f85149", 
      boxShadow: s === "connected" ? "0 0 6px #3fb950" : "none" 
  }),
  statusLabel: { fontSize: 11, color: "#8b949e" },
  schemaPane: { flex: 1, overflowY: "auto", padding: "10px 10px" },
  sectionLabel: { 
      fontSize: 10, color: "#484f58", textTransform: "uppercase", 
      letterSpacing: "0.1em", marginBottom: 6, paddingLeft: 4 
  },
  tableRow: { 
      display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", 
      borderRadius: 4, cursor: "pointer", color: "#8b949e", userSelect: "none" 
  },
  colRow: { 
      display: "flex", alignItems: "center", gap: 5, padding: "2px 6px 2px 20px", 
      fontSize: 11, color: "#484f58" 
  },
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  tabBar: {
      display: "flex", background: "#0d1117", borderBottom: "1px solid #161b22",
      overflowX: "auto", whiteSpace: "nowrap",
  },
  tab: (active) => ({
      padding: "10px 16px", cursor: "pointer", fontSize: 12, fontWeight: 600,
      color: active ? "#e6edf3" : "#8b949e",
      borderBottom: active ? "2px solid #1f6feb" : "2px solid transparent",
      background: active ? "#161b22" : "transparent",
  }),
  chatArea: { flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 },
  bubble: (role) => ({ 
      maxWidth: "75%", alignSelf: role === "user" ? "flex-end" : "flex-start", 
      background: role === "user" ? "linear-gradient(135deg, #1a3a5c, #0d2137)" : "#161b22", 
      border: role === "user" ? "1px solid #1e4976" : "1px solid #21262d", 
      borderRadius: role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px", padding: "10px 14px" 
  }),
  sqlBlock: { marginTop: 8, background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, overflow: "hidden" },
  sqlBlockHeader: { 
      display: "flex", alignItems: "center", justifyContent: "space-between", 
      padding: "5px 10px", background: "#161b22", borderBottom: "1px solid #21262d", fontSize: 11 
  },
  pre: { margin: 0, padding: "10px 12px", color: "#79c0ff", fontSize: 12, overflowX: "auto", lineHeight: 1.5 },
  resultsTable: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { 
      padding: "5px 10px", textAlign: "left", color: "#8b949e", fontWeight: 600, 
      fontSize: 11, borderBottom: "1px solid #21262d", background: "#161b22" 
  },
  td: { padding: "4px 10px", borderBottom: "1px solid #161b2250" },
  chatInputRow: { 
      padding: "14px 20px", borderTop: "1px solid #161b22", background: "#0d1117", 
      display: "flex", gap: 8, alignItems: "flex-end" 
  },
  chatInput: { 
      flex: 1, background: "#161b22", border: "1px solid #30363d", borderRadius: 8, 
      padding: "10px 14px", color: "#c9d1d9", fontSize: 13, fontFamily: "inherit", 
      outline: "none", resize: "none", lineHeight: 1.5 
  },
  sendBtn: (disabled) => ({ 
      padding: "10px 16px", background: disabled ? "#21262d" : "#1f6feb", border: "none", 
      borderRadius: 8, color: disabled ? "#484f58" : "#fff", cursor: disabled ? "not-allowed" : "pointer", 
      fontSize: 12, fontFamily: "inherit", transition: "background 0.15s", whiteSpace: "nowrap" 
  }),
  sqlEditor: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  sqlEditorTop: { padding: "14px 20px", borderBottom: "1px solid #161b22", background: "#0d1117" },
  sqlTextarea: { 
      width: "100%", background: "#0d1117", border: "1px solid #30363d", borderRadius: 8, 
      padding: "12px 16px", color: "#79c0ff", fontSize: 13, fontFamily: "inherit", 
      outline: "none", resize: "none", lineHeight: 1.6, boxSizing: "border-box" 
  },
  runBtn: (disabled) => ({ 
      padding: "8px 18px", background: disabled ? "#21262d" : "#238636", 
      border: disabled ? "1px solid #30363d" : "1px solid #2ea043", borderRadius: 6, 
      color: disabled ? "#484f58" : "#fff", cursor: disabled ? "not-allowed" : "pointer", 
      fontSize: 12, fontFamily: "inherit", marginTop: 8, transition: "background 0.15s" 
  }),
  resultsPane: { flex: 1, overflow: "auto", padding: "16px 20px" },
  uploadZone: { 
      border: "2px dashed #30363d", borderRadius: 12, padding: "48px 32px", 
      textAlign: "center", cursor: "pointer", transition: "border-color 0.2s" 
  },
  tag: (color) => ({ 
      display: "inline-flex", alignItems: "center", padding: "2px 7px", borderRadius: 99, 
      fontSize: 10, letterSpacing: "0.05em", background: `${color}22`, border: `1px solid ${color}66`, color: color 
  }),
  metaRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 },
  typePill: (t) => {
    const map = { 
        VARCHAR: "#79c0ff", INTEGER: "#68d391", BIGINT: "#68d391", 
        DOUBLE: "#f2cc60", BOOLEAN: "#f6ad55", TIMESTAMP: "#d2a8ff", DATE: "#d2a8ff" 
    };
    const c = map[t] || "#8b949e";
    return { 
        fontSize: 9, padding: "1px 5px", borderRadius: 3, 
        background: `${c}18`, color: c, border: `1px solid ${c}44`, 
        marginLeft: "auto", whiteSpace: "nowrap" 
    };
  },
};

function statusPill(status) {
  const map = {
    transmitted: { bg: "#122119", border: "#2ea04330", color: "#3fb950", label: "Synced" },
    private: { bg: "#1a1f29", border: "#30363d", color: "#8b949e", label: "Private" },
    pending: { bg: "#1f1a0a", border: "#9e6a0330", color: "#d29922", label: "Pending" },
    syncing: { bg: "#0a1a29", border: "#1f6feb30", color: "#58a6ff", label: "Syncing" },
    failed: { bg: "#3d1c1c", border: "#6e3030", color: "#f85149", label: "Failed" },
  };
  const s = map[status] || { bg: "#1a1f29", border: "#30363d", color: "#8b949e", label: status || "—" };
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 999,
      fontSize: 10,
      background: s.bg,
      border: `1px solid ${s.border}`,
      color: s.color,
      whiteSpace: "nowrap",
    }}>{s.label}</span>
  );
}

function shortDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return String(iso);
  }
}

function SpreadsheetView({ rows, sortBy, sortDir, onSort, expandedRowId, onToggleRow, onRefineCategory, onRefineStatus, onRefineZip }) {
  const columns = [
    { id: "submitted_at", label: "When", width: 130 },
    { id: "zip_code", label: "ZIP", width: 70 },
    { id: "category_label", label: "Category", width: 150 },
    { id: "comment", label: "Comment", width: null },
    { id: "egress_status", label: "Status", width: 110 },
  ];
  const sortIndicator = (col) => sortBy === col ? (sortDir === "ASC" ? " ↑" : " ↓") : "";

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#c9d1d9" }}>
      <thead style={{ position: "sticky", top: 0, background: "#0d1117", zIndex: 1 }}>
        <tr>
          {columns.map((c) => (
            <th
              key={c.id}
              onClick={c.id === "comment" ? undefined : () => onSort(c.id)}
              style={{
                textAlign: "left",
                fontSize: 10,
                color: "#8b949e",
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                padding: "10px 14px",
                borderBottom: "1px solid #161b22",
                cursor: c.id === "comment" ? "default" : "pointer",
                width: c.width || undefined,
                whiteSpace: "nowrap",
              }}
            >
              {c.label}{sortIndicator(c.id)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => {
          const id = row.receipt_id || i;
          const isOpen = expandedRowId === id;
          return (
            <React.Fragment key={id}>
              <tr
                onClick={() => onToggleRow(id)}
                style={{
                  background: i % 2 ? "rgba(255,255,255,0.015)" : "transparent",
                  cursor: "pointer",
                  borderBottom: "1px solid #161b22",
                }}
              >
                <td style={{ padding: "9px 14px", whiteSpace: "nowrap", color: "#8b949e" }}>{shortDate(row.submitted_at)}</td>
                <td
                  style={{ padding: "9px 14px", whiteSpace: "nowrap", color: "#79c0ff" }}
                  onClick={(e) => { e.stopPropagation(); onRefineZip(row.zip_code); }}
                  title={`Filter by ZIP ${row.zip_code}`}
                >
                  {row.zip_code || "—"}
                </td>
                <td
                  style={{ padding: "9px 14px", color: "#79c0ff" }}
                  onClick={(e) => { e.stopPropagation(); onRefineCategory(row.category_label); }}
                  title={`Filter by ${row.category_label}`}
                >
                  {row.category_label || "—"}
                </td>
                <td style={{ padding: "9px 14px", color: "#c9d1d9", maxWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: isOpen ? "normal" : "nowrap" }}>
                    {row.comment || ""}
                  </div>
                </td>
                <td
                  style={{ padding: "9px 14px", whiteSpace: "nowrap" }}
                  onClick={(e) => { e.stopPropagation(); onRefineStatus(row.egress_status); }}
                  title={`Filter by ${row.egress_status}`}
                >
                  {statusPill(row.egress_status)}
                </td>
              </tr>
              {isOpen && (
                <tr style={{ background: "#0b0e13" }}>
                  <td colSpan={columns.length} style={{ padding: "10px 18px 14px", borderBottom: "1px solid #161b22", fontSize: 11, color: "#8b949e", lineHeight: 1.6 }}>
                    <div><span style={{ color: "#484f58" }}>Receipt:</span> <code style={{ color: "#c9d1d9" }}>{row.receipt_id}</code></div>
                    <div><span style={{ color: "#484f58" }}>Submitted:</span> {row.submitted_at}</div>
                    {row.vault_status && <div><span style={{ color: "#484f58" }}>Vault:</span> {row.vault_status}</div>}
                    {row.last_error && <div><span style={{ color: "#484f58" }}>Last error:</span> <span style={{ color: "#f85149" }}>{row.last_error}</span></div>}
                    {row.comment && row.comment.length > 200 && (
                      <div style={{ marginTop: 8, color: "#c9d1d9" }}>{row.comment}</div>
                    )}
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function ResultsGrid({ columns, rows, onCellClick }) {
  if (!rows?.length) return <div style={{ color: "#484f58", fontSize: 12 }}>No rows returned.</div>;
  const clickable = typeof onCellClick === "function";
  const refineable = new Set(["zip_code", "category_label", "egress_status", "submitted_at", "day"]);
  return (
    <div style={{ overflowX: "auto", maxHeight: 360 }}>
      <table style={S.resultsTable}>
        <thead><tr>{columns.map((c) => <th key={c} style={S.th}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? "rgba(255,255,255,0.02)" : "transparent" }}>
              {columns.map((c) => {
                const canClick = clickable && refineable.has(c) && row[c] != null && row[c] !== "";
                return (
                  <td
                    key={c}
                    style={{
                      ...S.td,
                      cursor: canClick ? "pointer" : "default",
                      color: canClick ? "#79c0ff" : undefined,
                      textDecoration: canClick ? "underline dotted" : undefined,
                    }}
                    onClick={canClick ? () => onCellClick(c, row[c]) : undefined}
                    title={canClick ? `Refine by ${c} = ${row[c]}` : undefined}
                  >
                    {fmt(row[c])}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildQbeSql({ source, shape, zipPrefix, categoryId, status, since, limit, commentLike, sortBy, sortDir }) {
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 25, 500));
  const dir = String(sortDir).toUpperCase() === "ASC" ? "ASC" : "DESC";

  if (source === "journal") {
    const w = [];
    if (since) w.push(`submitted_at >= '${sqlEscape(since)}'`);
    if (commentLike && commentLike.trim()) w.push(`raw_text ILIKE '%${sqlEscape(commentLike.trim())}%'`);
    const whereSql = w.length ? `\nWHERE ${w.join("\n  AND ")}` : "";
    const sortCol = ({ submitted_at: "submitted_at", user_category_label: "user_category_label" })[sortBy] || "submitted_at";
    return `SELECT submission_id, submitted_at, user_category_label, raw_text, lexicon_version
FROM raw_submissions${whereSql}
ORDER BY ${sortCol} ${dir}
LIMIT ${cappedLimit};`;
  }

  if (source === "behaviors") {
    const w = [];
    if (since) w.push(`created_at >= '${sqlEscape(since)}'`);
    if (commentLike && commentLike.trim()) w.push(`(entity ILIKE '%${sqlEscape(commentLike.trim())}%' OR action ILIKE '%${sqlEscape(commentLike.trim())}%')`);
    const whereSql = w.length ? `\nWHERE ${w.join("\n  AND ")}` : "";
    const sortCol = ({ created_at: "created_at", category: "category", confidence: "confidence" })[sortBy] || "created_at";
    return `SELECT created_at, category, action, entity, confidence, source, reviewed, submission_id
FROM behavioral_data${whereSql}
ORDER BY ${sortCol} ${dir}
LIMIT ${cappedLimit};`;
  }

  if (source === "traits") {
    const w = [];
    if (since) w.push(`created_at >= '${sqlEscape(since)}'`);
    if (commentLike && commentLike.trim()) w.push(`attribute ILIKE '%${sqlEscape(commentLike.trim())}%'`);
    const whereSql = w.length ? `\nWHERE ${w.join("\n  AND ")}` : "";
    const sortCol = ({ created_at: "created_at", category: "category", attribute: "attribute", confidence: "confidence" })[sortBy] || "created_at";
    return `SELECT created_at, category, attribute, sentiment, confidence, source, reviewed, submission_id
FROM psychographic_data${whereSql}
ORDER BY ${sortCol} ${dir}
LIMIT ${cappedLimit};`;
  }

  // civic (default)
  const where = [];
  if (zipPrefix && zipPrefix.trim()) {
    where.push(`zip_code LIKE '${sqlEscape(zipPrefix.trim())}%'`);
  }
  if (categoryId) {
    // Numeric -> legacy civic tier; string -> v1.5 category_code slug.
    const asNum = Number(categoryId);
    if (Number.isFinite(asNum) && String(categoryId).match(/^\d+$/)) {
      where.push(`category_id = ${asNum}`);
    } else {
      where.push(`category_code = '${sqlEscape(String(categoryId))}'`);
    }
  }
  if (status) {
    where.push(`egress_status = '${sqlEscape(status)}'`);
  }
  if (since) {
    where.push(`submitted_at >= '${sqlEscape(since)}'`);
  }
  if (commentLike && commentLike.trim()) {
    where.push(`comment ILIKE '%${sqlEscape(commentLike.trim())}%'`);
  }
  const whereSql = where.length ? `\nWHERE ${where.join("\n  AND ")}` : "";

  switch (shape) {
    case "count_by_zip":
      return `SELECT zip_code, count(*) AS submissions
FROM civic_submissions${whereSql}
GROUP BY zip_code
ORDER BY submissions DESC, zip_code
LIMIT ${cappedLimit};`;
    case "count_by_category":
      return `SELECT category_label, count(*) AS submissions
FROM civic_submissions${whereSql}
GROUP BY category_label
ORDER BY submissions DESC, category_label
LIMIT ${cappedLimit};`;
    case "timeline":
      return `SELECT date_trunc('day', CAST(submitted_at AS TIMESTAMP)) AS day,
       count(*) AS submissions
FROM civic_submissions${whereSql}
GROUP BY 1
ORDER BY 1 DESC
LIMIT ${cappedLimit};`;
    case "failures":
      return `SELECT receipt_id, zip_code, category_label, egress_status, last_error, submitted_at
FROM civic_submissions${
        where.length
          ? `\nWHERE ${where.join("\n  AND ")}\n  AND egress_status IN ('pending','failed','syncing')`
          : `\nWHERE egress_status IN ('pending','failed','syncing')`
      }
ORDER BY submitted_at DESC
LIMIT ${cappedLimit};`;
    case "rows":
    default: {
      const sortCol = ({
        submitted_at: "submitted_at",
        zip_code: "zip_code",
        category_label: "category_label",
        egress_status: "egress_status",
      })[sortBy] || "submitted_at";
      const dir = String(sortDir).toUpperCase() === "ASC" ? "ASC" : "DESC";
      return `SELECT receipt_id, zip_code, category_label, comment, egress_status, vault_status, last_error, submitted_at
FROM civic_submissions${whereSql}
ORDER BY ${sortCol} ${dir}
LIMIT ${cappedLimit};`;
    }
  }
}

const QBE_STATUSES = [
  { id: "", label: "Any status" },
  { id: "transmitted", label: "Transmitted" },
  { id: "private", label: "Private (not shared)" },
  { id: "pending", label: "Pending" },
  { id: "syncing", label: "Syncing" },
  { id: "failed", label: "Failed" },
];

export default function PersonalPod() {
  const [viewport, setViewport] = useState(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
  }));
  const [authState, setAuthState] = useState("checking");
  const [rebindingNotice, setRebindingNotice] = useState(null);
  const [tab, setTab] = useState("journal");
  const [showAdvanced, setShowAdvanced] = useState(
    () => localStorage.getItem("forum.showAdvanced") === "1"
  );
  const [civicAiEnabled, setCivicAiEnabled] = useState(
    () => localStorage.getItem("forum.civicAiEnabled") === "1"
  );
  const [showCivicAiDisclosure, setShowCivicAiDisclosure] = useState(false);
  const [expandedRowId, setExpandedRowId] = useState(null);

  const [journalText, setJournalText] = useState("");
  const [journalCategoryId, setJournalCategoryId] = useState(INSIGHT_CATEGORIES[0]?.id || "");
  const [journalSending, setJournalSending] = useState(false);
  const [journalStatus, setJournalStatus] = useState(null);
  const [journalTotals, setJournalTotals] = useState({ raw: 0, behaviors: 0, psychographics: 0 });
  const [civicComment, setCivicComment] = useState("");
  const [civicZip, setCivicZip] = useState("");
  // Forum Feedback now spans all 9 insight categories. The state holds
  // the granular category_code (e.g. "purchasing", "value"). ZIP is
  // optional except for the "civic" category.
  const [forumFeedbackCategoryId, setForumFeedbackCategoryId] = useState(
    INSIGHT_CATEGORIES[0]?.id || "purchase"
  );
  const [civicSending, setCivicSending] = useState(false);
  const [civicStatus, setCivicStatus] = useState(null);
  const [localSubmissions, setLocalSubmissions] = useState([]);
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem("forum.serverUrl") || DEFAULT_SERVER_URL);
  const [memberProfile, setMemberProfile] = useState(() => loadMemberProfile());
  const [shareWithCooperative, setShareWithCooperative] = useState(
    () => localStorage.getItem("forum.shareWithCooperative") === "1"
  );
  const [settingsStatus, setSettingsStatus] = useState(null);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signingMeta, setSigningMeta] = useState(() => loadSigningMeta());
  const [deviceKeyExport, setDeviceKeyExport] = useState("");
  const [deviceKeyImport, setDeviceKeyImport] = useState("");
  const [deviceKeyStatus, setDeviceKeyStatus] = useState(null);
  const [showDeviceKeyImport, setShowDeviceKeyImport] = useState(false);
  const [podStatus, setPodStatus] = useState("connecting");
  const [schema, setSchema] = useState([]);
  const [expanded, setExpanded] = useState({});
  
  const [db, setDb] = useState(null);
  const [conn, setConn] = useState(null);

  // Query-by-Example state. Filters compose into a deterministic SELECT.
  const [qbeSource, setQbeSource] = useState("civic");
  const [qbeShape, setQbeShape] = useState("rows");
  const [qbeZipPrefix, setQbeZipPrefix] = useState("");
  const [qbeCategoryId, setQbeCategoryId] = useState("");
  const [qbeStatus, setQbeStatus] = useState("");
  const [qbeSince, setQbeSince] = useState("");
  const [qbeLimit, setQbeLimit] = useState(50);
  const [qbeCommentLike, setQbeCommentLike] = useState("");
  const [qbeSortBy, setQbeSortBy] = useState("submitted_at");
  const [qbeSortDir, setQbeSortDir] = useState("DESC");
  const [qbeSql, setQbeSql] = useState("");
  const [qbeResults, setQbeResults] = useState(null);
  const [qbeError, setQbeError] = useState(null);
  const [qbeMeta, setQbeMeta] = useState(null);
  const [showSql, setShowSql] = useState(false);

  const [sqlInput, setSqlInput] = useState("SELECT 42 AS answer, 'Sovereign Pod' AS system;");
  const [sqlResults, setSqlResults] = useState(null);
  const [sqlError, setSqlError] = useState(null);
  const [sqlLoading, setSqlLoading] = useState(false);
  const [queryMeta, setQueryMeta] = useState(null);

  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const refreshLocalSubmissions = useCallback(async () => {
    const rows = await getSubmissions();
    setLocalSubmissions(rows);
    return rows;
  }, []);

  const refreshJournalTotals = useCallback(async () => {
    const [raw, beh, psy] = await Promise.all([
      getRawSubmissions(),
      getBehaviors(),
      getPsychographics(),
    ]);
    setJournalTotals({
      raw: raw.length,
      behaviors: beh.length,
      psychographics: psy.length,
    });
  }, []);

  // Mount-time refresh of the journal counters from IndexedDB. This is an
  // intentional "sync with an external store" pattern, not derived state,
  // so the react-hooks/set-state-in-effect rule does not apply.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshJournalTotals().catch(() => { /* noop */ });
  }, [refreshJournalTotals]);

  // Live preview as the user types in the journal box. Derived from
  // journalText, so we compute in render via useMemo rather than mirror
  // it into useState through an effect.
  const journalPreview = useMemo(() => {
    if (!journalText.trim()) return { behaviors: [], psychographics: [] };
    const insights = extractInsights(journalText);
    return { behaviors: insights.behaviors, psychographics: insights.psychographics };
  }, [journalText]);

  const submitJournalEntry = useCallback(async () => {
    if (!journalText.trim() || journalSending || !conn) return;
    const cat = findInsightCategory(journalCategoryId);
    if (!cat) {
      setJournalStatus({ ok: false, text: "Pick a category for this entry." });
      return;
    }
    setJournalSending(true);
    setJournalStatus(null);

    const submissionId = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    const rawText = journalText.trim();

    const rawRow = {
      submission_id: submissionId,
      submitted_at: submittedAt,
      raw_text: rawText,
      source_context: "journal",
      user_category_id: cat.id,
      user_category_label: cat.label,
      processing_status: `rule:${LEXICON_VERSION}`,
      lexicon_version: LEXICON_VERSION,
    };

    try {
      const insights = extractInsights(rawText);
      const podRows = { raw: rawRow, behaviors: [], traits: [] };

      await writeJournalEntryToPod(rawRow);

      const userDeclared = {
        submission_id: submissionId,
        category: cat.category,
        source: "user",
        confidence: 1.0,
        reviewed: true,
        created_at: submittedAt,
      };
      if (cat.kind === "behavioral") {
        const row = { behavior_id: crypto.randomUUID(), ...userDeclared };
        await writeBehaviorToPod(row);
        podRows.behaviors.push(row);
      } else {
        const row = { psycho_id: crypto.randomUUID(), ...userDeclared, attribute: "(declared)", sentiment: 0 };
        await writeTraitToPod(row);
        podRows.traits.push(row);
      }

      for (const tag of extractUserTags(rawText)) {
        const row = {
          psycho_id: crypto.randomUUID(),
          submission_id: submissionId,
          ...tag,
          reviewed: true,
          created_at: submittedAt,
        };
        await writeTraitToPod(row);
        podRows.traits.push(row);
      }

      for (const b of insights.behaviors) {
        const row = {
          behavior_id: crypto.randomUUID(),
          submission_id: submissionId,
          ...b,
          metadata_json: b.why ? JSON.stringify(b.why) : null,
          reviewed: false,
          created_at: submittedAt,
        };
        await writeBehaviorToPod(row);
        podRows.behaviors.push(row);
      }
      for (const p of insights.psychographics) {
        const row = {
          psycho_id: crypto.randomUUID(),
          submission_id: submissionId,
          ...p,
          reviewed: false,
          created_at: submittedAt,
        };
        await writeTraitToPod(row);
        podRows.traits.push(row);
      }

      await saveRawSubmission(rawRow);
      await recordRawSubmissionLocally(conn, rawRow);
      for (const row of podRows.behaviors) {
        await saveBehavior(row);
        await recordBehaviorLocally(conn, row);
      }
      for (const row of podRows.traits) {
        await savePsychographic(row);
        await recordPsychographicLocally(conn, row);
      }

      await refreshJournalTotals();
      setJournalText("");
      setJournalStatus({
        ok: true,
        text: `Saved. ${insights.behaviors.length} behavioral and ${insights.psychographics.length} psychographic signals inferred (yellow until you review).`,
      });
    } catch (e) {
      console.error("Journal save failed:", e);
      setJournalStatus({ ok: false, text: e.message });
    } finally {
      setJournalSending(false);
    }
  }, [journalText, journalCategoryId, journalSending, conn, refreshJournalTotals]);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAuthState("checking");
      await handleSolidRedirect();
      if (cancelled) return;
      const signing = loadSigningMeta();
      const profile = loadMemberProfile();
      if (signing?.publicKeyHex && profile?.credential_id) {
        const expectedSid = await deriveBoundSessionId(signing.publicKeyHex);
        const currentSid = profile.sessionId || signing.sessionId;
        if (!isBoundSessionId(currentSid) || currentSid !== expectedSid) {
          await clearAllPodData();
          clearSolidSessionMeta();
          await solidLogout();
          saveSigningMeta({ ...signing, sessionId: expectedSid });
          saveMemberProfile({ ...profile, sessionId: expectedSid });
          setRebindingNotice(
            "Your Pod was re-bound to your signing key. Sign in again to recreate your Personal Pod at the edge (existing cooperative rows are unchanged)."
          );
          setMemberProfile(loadMemberProfile());
          setAuthState("signed_out");
          return;
        }
      }
      setMemberProfile(profile || loadMemberProfile());
      const { isLoggedIn } = getSolidSession();
      setAuthState(isLoggedIn ? "signed_in" : "signed_out");
      if (isLoggedIn) {
        setSigningMeta(loadSigningMeta());
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleSignedIn = useCallback(() => {
    setMemberProfile(loadMemberProfile());
    setAuthState("signed_in");
  }, []);

  // Soft sign-out ("Lock"): wipes the session-scoped cache and forces
  // a re-auth on next sign-in, but KEEPS the device credential + Ed25519
  // signing key on disk so the user can unlock again on this device.
  // Use handleForgetDevice for the destructive variant.
  const handleSignOut = useCallback(async () => {
    setSignOutBusy(true);
    try {
      if (conn) {
        try { await conn.close(); } catch { /* ignore */ }
      }
      if (db) {
        try { await db.terminate(); } catch { /* ignore */ }
      }
      // Pod is the source of truth for assistant conversations
      // (Handover 13). Wipe the Pod-side rows BEFORE we tear down the
      // local cache; if this fails we still proceed with sign-out, but
      // we surface the error so the user knows a cooperative copy may
      // linger until the next sign-in (when the boot hydration will
      // overwrite the cache from the surviving Pod rows).
      try {
        await deleteAllAssistantConversationsFromPod();
      } catch (e) {
        console.warn("[sign-out] Pod assistant wipe failed:", e);
        setSettingsStatus({
          ok: false,
          text: `Signed out, but Pod assistant wipe failed: ${e.message}`,
        });
      }
      await clearAllPodData();
      await clearAllAssistantConversations();
      clearSolidSessionMeta();
      await solidLogout();
      setConn(null);
      setDb(null);
      setSchema([]);
      setLocalSubmissions([]);
      setJournalTotals({ raw: 0, behaviors: 0, psychographics: 0 });
      setQbeResults(null);
      setDeviceKeyExport("");
      setDeviceKeyImport("");
      setDeviceKeyStatus(null);
      setShowDeviceKeyImport(false);
      setAuthState("signed_out");
    } catch (e) {
      console.error("Sign out failed:", e);
      setSettingsStatus({ ok: false, text: e.message });
    } finally {
      setSignOutBusy(false);
    }
  }, [conn, db]);

  // Destructive variant: also clears the device credential + signing
  // key, so the next visit will require Create a new Pod (and the
  // existing PersonalPodDO can no longer be addressed from this device
  // unless the user re-imports the key blob).
  const handleForgetDevice = useCallback(async () => {
    if (!window.confirm(
      "Forget this device?\n\n" +
      "This deletes the device credential and Ed25519 signing key on " +
      "this device only. Your Personal Pod (Cloudflare DO) keeps your " +
      "data, but you will need to either Create a new Pod or Import a " +
      "device key blob from another device to access it again.\n\n" +
      "If this is your only device and you have not exported the key, " +
      "your Pod data becomes unreachable. Continue?"
    )) return;
    try {
      await handleSignOut();
    } finally {
      clearMemberProfile();
      setMemberProfile(null);
      setSigningMeta(null);
    }
  }, [handleSignOut]);

  // fetchSchema must be declared BEFORE the boot effect so React's
  // immutability rule doesn't flag the boot effect for closing over an
  // identifier that is still in its temporal dead zone at the time the
  // effect's setup function is captured.
  const fetchSchema = useCallback(async (activeConn = conn) => {
    if (!activeConn) return;
    try {
        const arrowResult = await activeConn.query(`
            SELECT table_name, column_name, data_type 
            FROM information_schema.columns 
            WHERE table_schema = 'main'
            ORDER BY table_name, ordinal_position;
        `);
        const rows = arrowResult.toArray().map(r => Object.fromEntries(r));
        const tablesMap = {};
        rows.forEach(row => {
            if (!tablesMap[row.table_name]) {
                tablesMap[row.table_name] = { name: row.table_name, columns: [], rowCount: 0 };
            }
            tablesMap[row.table_name].columns.push({ name: row.column_name, type: row.data_type });
        });
        const schemaOut = Object.values(tablesMap);
        for (let t of schemaOut) {
            const cnt = await activeConn.query(`SELECT count(*) as c FROM "${t.name}"`);
            t.rowCount = Number(cnt.toArray()[0].c);
        }
        setSchema(schemaOut);
    } catch (e) {
        console.error("Schema fetch failed", e);
    }
  }, [conn]);

  useEffect(() => {
    if (authState !== "signed_in") return;
    let cancelled = false;

    async function initDuckDb() {
      // Cloudflare Workers Assets reject DuckDB's local WASM files (>25 MiB),
      // so the installable PWA loads DuckDB runtime bundles from jsDelivr.
      const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
      const workerUrl = URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], { type: "text/javascript" })
      );
      const worker = new Worker(workerUrl);
      const logger = new duckdb.ConsoleLogger();
      const database = new duckdb.AsyncDuckDB(logger, worker);
      await database.instantiate(bundle.mainModule, bundle.pthreadWorker);
      URL.revokeObjectURL(workerUrl);
      const connection = await database.connect();
      try {
        await connection.query(
          `CREATE TABLE _pod_init AS SELECT 'Initialization Complete' as status, current_date as date`
        );
      } catch {
        /* already initialized */
      }
      await setupCivicTables(connection);
      await setupInsightTables(connection);
      return { database, connection };
    }

    async function boot() {
      setPodStatus("connecting");

      try {
        const { database, connection } = await initDuckDb();
        if (cancelled) return;
        await hydrateFromPod(connection);
        if (cancelled) return;
        setDb(database);
        setConn(connection);
        setPodStatus("connected");
        fetchSchema(connection);
        refreshLocalSubmissions();
        refreshJournalTotals();
        setSigningMeta(loadSigningMeta());
      } catch (e) {
        console.error("DuckDB init failed:", e);
        setPodStatus("error");
      }
    }

    boot();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState]);

  const normalizedServerUrl = serverUrl.trim().replace(/\/$/, "");
  const cooperativeExportUrl = normalizedServerUrl
    ? `${normalizedServerUrl}/api/forum/feedback`
    : DEFAULT_FORUM_FEEDBACK_API;

  const syncSubmission = useCallback(async (row, activeConn = conn) => {
    if (!row.share_with_cooperative && !shareWithCooperative) {
      return { ok: true, row: { ...row, egress_status: "private" }, skipped: true };
    }
    const attempts = Number(row.sync_attempts || 0) + 1;
    await patchSubmission(row.receipt_id, {
      egress_status: "syncing",
      sync_attempts: attempts,
      last_error: null,
    });

    if (activeConn) {
      await recordCivicLocally(activeConn, {
        ...row,
        egress_status: "syncing",
        sync_attempts: attempts,
        last_error: null,
      });
      fetchSchema(activeConn);
    }

    try {
      const data = await postCooperativeExport(row, normalizedServerUrl);

      const next = {
        ...row,
        egress_status: "transmitted",
        vault_status: data.vault === "ok" ? "synced" : "vault_error",
        sync_attempts: attempts,
        last_error: null,
      };
      await patchSubmission(row.receipt_id, next);
      if (activeConn) {
        await recordCivicLocally(activeConn, next);
        fetchSchema(activeConn);
      }
      return { ok: true, row: next };
    } catch (err) {
      const next = {
        ...row,
        egress_status: "failed",
        sync_attempts: attempts,
        last_error: err.message,
      };
      await patchSubmission(row.receipt_id, next);
      if (activeConn) {
        await recordCivicLocally(activeConn, next);
        fetchSchema(activeConn);
      }
      return { ok: false, row: next, error: err };
    } finally {
      refreshLocalSubmissions();
    }
  }, [conn, fetchSchema, normalizedServerUrl, refreshLocalSubmissions, shareWithCooperative]);

  const transmitForumFeedback = async (comment, zipCode, insightCategoryId) => {
    const receiptId = crypto.randomUUID().split("-")[0].toUpperCase();
    const cat = findInsightCategory(insightCategoryId) || INSIGHT_CATEGORIES[0];
    const safePayload = {
      type: "FORUM_FEEDBACK_V1",
      receipt_id: receiptId,
      kind: cat.kind,
      category_code: cat.category,
      category_label: cat.label,
      zip_code: zipCode || null,
      comment,
    };
    const encryptedData = btoa(JSON.stringify(safePayload));
    const localRow = {
      receipt_id: receiptId,
      zip_code: zipCode || null,
      kind: cat.kind,
      category_code: cat.category,
      category_id: null, // v1.5+ rows do not use the legacy 4-tier integer id
      category_label: cat.label,
      comment,
      encrypted_data: encryptedData,
      egress_status: "pending",
      vault_status: null,
      sync_attempts: 0,
      last_error: null,
      submitted_at: new Date().toISOString(),
      share_status: shareWithCooperative ? "shared" : "private",
      share_with_cooperative: shareWithCooperative,
      policy_version: POLICY_VERSION,
      consent_at: shareWithCooperative ? new Date().toISOString() : null,
    };

    setCivicSending(true);
    setCivicStatus(null);

    try {
      await writeCivicSubmissionToPod(localRow);
      await saveSubmission(localRow);
      await refreshLocalSubmissions();
      if (conn) {
        await recordCivicLocally(conn, localRow);
        fetchSchema(conn);
      }
    } catch (e) {
      setCivicSending(false);
      setCivicStatus({ ok: false, text: `Pod save failed: ${e.message}` });
      return;
    }

    const result = await syncSubmission(localRow, conn);
    if (result.skipped || result.ok) {
      setCivicStatus({
        ok: true,
        text: result.skipped
          ? `Saved locally and to your Pod. Receipt: ${receiptId}. Cooperative share is off until you opt in.`
          : `Saved to your Pod and synced. Receipt: ${receiptId}.`,
      });
      setCivicComment("");
    } else {
      setCivicStatus({
        ok: false,
        text: `Saved locally, but sync needs retry: ${result.error?.message || "unknown error"}`,
      });
    }
    setCivicSending(false);
  };

  const runQbe = useCallback(async (overrides = {}) => {
    if (!conn) return;
    const cfg = {
      source: qbeSource,
      shape: qbeShape,
      zipPrefix: qbeZipPrefix,
      categoryId: qbeCategoryId,
      status: qbeStatus,
      since: qbeSince,
      limit: qbeLimit,
      commentLike: qbeCommentLike,
      sortBy: qbeSortBy,
      sortDir: qbeSortDir,
      ...overrides,
    };
    if (overrides.shape !== undefined) setQbeShape(overrides.shape);
    if (overrides.zipPrefix !== undefined) setQbeZipPrefix(overrides.zipPrefix);
    if (overrides.categoryId !== undefined) setQbeCategoryId(overrides.categoryId);
    if (overrides.status !== undefined) setQbeStatus(overrides.status);
    if (overrides.since !== undefined) setQbeSince(overrides.since);
    if (overrides.limit !== undefined) setQbeLimit(overrides.limit);
    if (overrides.commentLike !== undefined) setQbeCommentLike(overrides.commentLike);
    if (overrides.sortBy !== undefined) setQbeSortBy(overrides.sortBy);
    if (overrides.sortDir !== undefined) setQbeSortDir(overrides.sortDir);

    const sql = buildQbeSql(cfg);
    setQbeSql(sql);
    setQbeError(null);
    const t0 = Date.now();
    try {
      const arrow = await conn.query(sql);
      const columns = arrow.schema.fields.map((f) => f.name);
      const rows = arrow.toArray().map((r) => Object.fromEntries(r));
      setQbeResults({ columns, rows });
      setQbeMeta({ rows: rows.length, ms: Date.now() - t0 });
    } catch (e) {
      setQbeResults(null);
      setQbeError(e.message);
    }
  }, [
    conn,
    qbeSource,
    qbeShape,
    qbeZipPrefix,
    qbeCategoryId,
    qbeStatus,
    qbeSince,
    qbeLimit,
    qbeCommentLike,
    qbeSortBy,
    qbeSortDir,
  ]);

  const resetQbeFilters = useCallback(() => {
    setQbeShape("rows");
    setQbeZipPrefix("");
    setQbeCategoryId("");
    setQbeStatus("");
    setQbeSince("");
    setQbeCommentLike("");
    setQbeSortBy("submitted_at");
    setQbeSortDir("DESC");
    setQbeResults(null);
    setQbeMeta(null);
    setQbeError(null);
  }, []);

  const selectQbeSource = useCallback((source) => {
    setQbeSource(source);
    resetQbeFilters();
  }, [resetQbeFilters]);

  // Forum Submissions and Journal data views: re-run query whenever filters
  // change. The `chat` branch keeps the legacy tab id mapped to civic rows.
  useEffect(() => {
    if (!conn || (tab !== "chat" && tab !== "journal")) return;
    if (tab === "chat" && qbeSource !== "civic") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      selectQbeSource("civic");
      return;
    }
    if (tab === "journal" && qbeSource === "civic") {
      selectQbeSource("journal");
      return;
    }
    runQbe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, tab, qbeSource, qbeShape, qbeZipPrefix, qbeCategoryId, qbeStatus, qbeSince, qbeLimit, qbeCommentLike, qbeSortBy, qbeSortDir]);

  const runSql = async () => {
    if (!sqlInput.trim() || sqlLoading || !conn) return;
    setSqlLoading(true); setSqlError(null); setSqlResults(null); setQueryMeta(null);
    const t0 = Date.now();
    try {
        const arrowResult = await conn.query(sqlInput);
        const columns = arrowResult.schema.fields.map(f => f.name);
        const rows = arrowResult.toArray().map(r => Object.fromEntries(r));
        setSqlResults({ columns, rows });
        setQueryMeta({ ms: Date.now() - t0, rows: rows.length });
        if (/CREATE|DROP|ALTER|INSERT|UPDATE|DELETE/i.test(sqlInput)) fetchSchema();
    } catch (e) { 
        setSqlError(e.message); 
    }
    setSqlLoading(false);
  };

  const doUpload = async (f) => {
    if (!f || !db || !conn) return;
    setUploading(true); setUploadMsg(null);
    try {
        const safeTableName = f.name.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_/, 'table_');
        const buffer = new Uint8Array(await f.arrayBuffer());
        await db.registerFileBuffer(f.name, buffer);
        
        let query = '';
        if (f.name.endsWith('.csv')) query = `CREATE TABLE "${safeTableName}" AS SELECT * FROM read_csv_auto('${f.name}')`;
        else if (f.name.endsWith('.json')) query = `CREATE TABLE "${safeTableName}" AS SELECT * FROM read_json_auto('${f.name}')`;
        else if (f.name.endsWith('.parquet')) query = `CREATE TABLE "${safeTableName}" AS SELECT * FROM read_parquet('${f.name}')`;
        else query = `CREATE TABLE "${safeTableName}" AS SELECT * FROM '${f.name}'`;

        await conn.query(query);
        setUploadMsg({ ok: true, text: `✓ Imported successfully into "${safeTableName}"` });
        fetchSchema();
    } catch (e) { 
        setUploadMsg({ ok: false, text: `Import failed: ${e.message}` }); 
    }
    setUploading(false);
  };

  const isPortraitPhone = viewport.w <= 720 && viewport.h >= viewport.w;
  const rootStyle = isPortraitPhone
    ? { ...S.root, flexDirection: "column", height: "100dvh", fontSize: 12 }
    : S.root;
  const sidebarStyle = isPortraitPhone
    ? { ...S.sidebar, width: "100%", maxHeight: 132, borderRight: "none", borderBottom: "1px solid #161b22" }
    : S.sidebar;
  const schemaPaneStyle = isPortraitPhone
    ? { ...S.schemaPane, display: "none" }
    : S.schemaPane;
  const tabBarStyle = isPortraitPhone
    ? { ...S.tabBar, flexShrink: 0 }
    : S.tabBar;
  const formPanelStyle = {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: isPortraitPhone ? "flex-start" : "center",
    padding: isPortraitPhone ? "18px 14px 96px" : 32,
    overflowY: "auto",
  };

  const signedIn = authState === "signed_in";

  return (
    <div style={rootStyle}>
      {authState === "signed_out" && rebindingNotice && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 1001,
          padding: "10px 16px", background: "#3d2e00", borderBottom: "1px solid #6e4e00",
          color: "#f0c040", fontSize: 12, lineHeight: 1.5,
        }}>
          {rebindingNotice}
        </div>
      )}
      {authState === "signed_out" && (
        <SignInOverlay
          defaultPodProvider={DEFAULT_POD_PROVIDER}
          cooperativeUrl={serverUrl}
          onSignedIn={handleSignedIn}
          runBtnStyle={S.runBtn}
        />
      )}
      {authState === "checking" && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 999,
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "rgba(9, 11, 15, 0.85)", color: "#8b949e", fontSize: 13,
        }}>
          Checking Pod session…
        </div>
      )}
      {showCivicAiDisclosure && (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 1002,
          background: "rgba(9, 11, 15, 0.88)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
        }}>
          <div style={{
            width: "100%",
            maxWidth: 520,
            background: "#0d1117",
            border: "1px solid #30363d",
            borderRadius: 12,
            padding: 20,
            boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
          }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "#e6edf3", marginBottom: 8 }}>
              Enable Civic AI Kami
            </div>
            <div style={{ fontSize: 12, color: "#8b949e", lineHeight: 1.6, marginBottom: 14 }}>
              This assistant runs through the cooperative GPU and receives only what you type into chat. Your conversation is kept in this device's IndexedDB and is cleared when you sign out. The server stores message counts and token counts, not prompt text.
            </div>
            <div style={{ fontSize: 12, color: "#c9d1d9", lineHeight: 1.6, marginBottom: 14 }}>
              Pack 4 says affected people must be able to correct or stop the system. You can use "Stop and forget" inside the Assistant tab at any time.
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setShowCivicAiDisclosure(false)}
                style={{ background: "transparent", border: "1px solid #30363d", color: "#8b949e", borderRadius: 6, padding: "9px 12px", fontFamily: "inherit", cursor: "pointer" }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  localStorage.setItem("forum.civicAiDisclosureAccepted", "1");
                  localStorage.setItem("forum.civicAiEnabled", "1");
                  setCivicAiEnabled(true);
                  setShowCivicAiDisclosure(false);
                  setTab("assistant");
                }}
                style={{ ...S.runBtn(false), marginTop: 0, padding: "9px 12px" }}
              >
                Enable assistant
              </button>
            </div>
          </div>
        </div>
      )}
      {signedIn && <div style={sidebarStyle}>
        <div style={S.podHeader}>
          <div style={S.podTitle}>
            <div style={S.podIcon}>
              <img src={`${import.meta.env.BASE_URL}pillar-icon.svg`} alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />
            </div>
            <div>
              <div style={S.podName}>Personal POD</div>
              <div style={{ fontSize: 10, color: "#484f58", marginTop: 1 }}>{POD_USER.name} · {APP_BUILD}</div>
            </div>
          </div>
          <div style={S.statusRow}>
            <div style={S.statusDot(podStatus)} />
            <span style={S.statusLabel}>
              {podStatus === "connected"
                ? "Pod session cache online"
                : podStatus === "connecting"
                  ? "Loading from Pod…"
                  : "Session cache error"}
            </span>
          </div>
        </div>

        <div style={schemaPaneStyle}>
          <div style={S.sectionLabel}>Local Tables</div>
          {schema.length === 0 ? (
            <div style={{ fontSize: 11, color: "#484f58", fontStyle: "italic", paddingLeft: 4 }}>
              No tables yet.<br />Upload a file or run SQL.
            </div>
          ) : schema.map((t) => (
            <div key={t.name}>
              <div style={{ ...S.tableRow, color: expanded[t.name] ? "#79c0ff" : "#8b949e" }} onClick={() => setExpanded((e) => ({ ...e, [t.name]: !e[t.name] }))}>
                <span style={{ fontSize: 9, width: 8 }}>{expanded[t.name] ? "▾" : "▸"}</span>
                <span style={{ fontSize: 11 }}>⊞</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</span>
                <span style={{ fontSize: 10, color: "#484f58" }}>{t.rowCount?.toLocaleString()}</span>
              </div>
              {expanded[t.name] && t.columns?.map((c) => (
                <div key={c.name} style={S.colRow}>
                  <span style={{ color: "#484f58" }}>◈</span>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                  <span style={S.typePill(c.type)}>{c.type}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ padding: "10px", borderTop: "1px solid #161b22" }}>
          <div onClick={() => fetchSchema()} style={{ fontSize: 11, color: "#484f58", cursor: "pointer", padding: "4px 6px", borderRadius: 4 }}>↺ Refresh schema</div>
        </div>
      </div>}

      {signedIn && <div style={S.main}>
        <div style={tabBarStyle}>
          {[
            { id: "journal", label: "Journal" },
            { id: "chat", label: "Forum Submissions" },
            { id: "civic", label: "Forum Feedback" },
            { id: "explore", label: "Explore" },
            { id: "data", label: "Import" },
            ...(civicAiEnabled ? [{ id: "assistant", label: "Assistant" }] : []),
            ...(showAdvanced ? [{ id: "sql", label: "SQL Editor" }] : []),
            { id: "settings", label: "Settings" },
          ].map(({ id, label }) => (
            <div key={id} style={S.tab(tab === id)} onClick={() => setTab(id)}>{label}</div>
          ))}
          <div style={{ marginLeft: "auto", display: isPortraitPhone ? "none" : "flex", alignItems: "center", padding: "0 16px", gap: 8 }}>
            <span style={S.tag("#58a6ff")}>{APP_BUILD}</span>
            <span style={S.tag("#3fb950")}>duckdb</span>
          </div>
        </div>

        {tab === "sql" && (
          <div style={S.sqlEditor}>
            <div style={S.sqlEditorTop}>
              <textarea
                value={sqlInput}
                onChange={(e) => setSqlInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runSql(); }}
                style={S.sqlTextarea}
                rows={7}
                spellCheck={false}
              />
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "#484f58" }}>⌃↵ / ⌘↵ to run locally</span>
                <button onClick={runSql} disabled={sqlLoading || podStatus !== "connected"} style={S.runBtn(sqlLoading || podStatus !== "connected")}>
                  {sqlLoading ? "Processing…" : "▶ Run Locally"}
                </button>
              </div>
            </div>
            <div style={S.resultsPane}>
              {sqlError && <div style={{ padding: "10px 14px", background: "#3d1c1c", border: "1px solid #6e3030", borderRadius: 6, fontSize: 12, color: "#f85149" }}>{sqlError}</div>}
              {queryMeta && <div style={{ fontSize: 11, color: "#484f58", marginBottom: 10 }}>{queryMeta.rows} row{queryMeta.rows !== 1 ? "s" : ""} · {queryMeta.ms}ms</div>}
              {sqlResults?.rows !== undefined && <ResultsGrid columns={sqlResults.columns} rows={sqlResults.rows} />}
              {!sqlResults && !sqlError && <div style={{ color: "#484f58", fontSize: 12 }}>Results appear here after you run a query.</div>}
            </div>
          </div>
        )}

        {tab === "civic" && (
          <div style={formPanelStyle}>
            <div style={{ width: "100%", maxWidth: 520 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#e6edf3", marginBottom: 4 }}>Forum Feedback</div>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 20, lineHeight: 1.5 }}>
                Share feedback from any category — civic, what you bought, what you value. Saved to your Pod and locally, then synced to the cooperative if you opt in.
              </div>
              <div style={{ marginBottom: 14, padding: "10px 12px", border: "1px solid #21262d", borderRadius: 8, background: "#0d1117" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: "#8b949e" }}>Device local ledger: {localSubmissions.length} saved</div>
                  <button
                    onClick={refreshLocalSubmissions}
                    style={{ background: "transparent", border: "1px solid #30363d", color: "#79c0ff", borderRadius: 5, padding: "4px 7px", fontSize: 10, fontFamily: "inherit" }}
                  >
                    Refresh
                  </button>
                </div>
                {localSubmissions.length ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 180, overflowY: "auto" }}>
                    {localSubmissions.slice(0, 3).map((row) => (
                      <div key={row.receipt_id} style={{ fontSize: 11, color: "#c9d1d9", lineHeight: 1.45, borderTop: "1px solid #161b22", paddingTop: 8 }}>
                        <div style={{ color: "#79c0ff" }}>{row.receipt_id}{row.zip_code ? ` · ${row.zip_code}` : ""} · {row.category_label}</div>
                        <div>{row.comment}</div>
                        <div style={{ color: "#8b949e" }}>{row.egress_status} · {row.submitted_at}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 11, color: "#484f58", lineHeight: 1.45 }}>
                    No saved submissions are visible in this app sandbox yet. Submit once from this screen, then this count should increment before any network sync happens.
                  </div>
                )}
              </div>
              <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 6 }}>Category</label>
              <select
                value={forumFeedbackCategoryId}
                onChange={(e) => setForumFeedbackCategoryId(e.target.value)}
                style={{ ...S.chatInput, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
              >
                <optgroup label="What I did">
                  {INSIGHT_CATEGORIES.filter((c) => c.kind === "behavioral").map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </optgroup>
                <optgroup label="How I think / what I value">
                  {INSIGHT_CATEGORIES.filter((c) => c.kind === "psychographic").map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </optgroup>
              </select>
              <textarea
                value={civicComment}
                onChange={(e) => setCivicComment(e.target.value)}
                placeholder={
                  findInsightCategory(forumFeedbackCategoryId)?.category === "civic"
                    ? "Describe a municipal issue (no names or addresses)…"
                    : "Share your feedback — no names or addresses…"
                }
                style={{ ...S.chatInput, width: "100%", minHeight: 120, marginBottom: 12, boxSizing: "border-box" }}
              />
              <input
                value={civicZip}
                onChange={(e) => setCivicZip(e.target.value)}
                placeholder={
                  findInsightCategory(forumFeedbackCategoryId)?.category === "civic"
                    ? "ZIP code (required)"
                    : "ZIP code (optional)"
                }
                style={{ ...S.chatInput, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
              />
              <button
                onClick={() => {
                  const cat = findInsightCategory(forumFeedbackCategoryId);
                  if (!civicComment.trim()) {
                    setCivicStatus({ ok: false, text: "Comment is required." });
                    return;
                  }
                  if (cat?.category === "civic" && !civicZip.trim()) {
                    setCivicStatus({ ok: false, text: "ZIP code is required for civic feedback." });
                    return;
                  }
                  transmitForumFeedback(civicComment.trim(), civicZip.trim(), forumFeedbackCategoryId);
                }}
                disabled={civicSending}
                style={{ ...S.runBtn(civicSending), width: "100%", padding: "11px", textAlign: "center" }}
              >
                {civicSending ? "Transmitting…" : "Submit to cooperative"}
              </button>
              {civicStatus && (
                <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, fontSize: 12, background: civicStatus.ok ? "#122119" : "#3d1c1c", border: `1px solid ${civicStatus.ok ? "#2ea04330" : "#6e3030"}`, color: civicStatus.ok ? "#3fb950" : "#f85149" }}>
                  {civicStatus.text}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "journal" && (
          <div style={formPanelStyle}>
            <div style={{ width: "100%", maxWidth: 900 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#e6edf3", marginBottom: 4 }}>Journal</div>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 16, lineHeight: 1.5, maxWidth: 640 }}>
                Anything you want your Pod to remember. The category tells your Pod how to file it. Hashtags like <code>#sustainability</code> become traits at full confidence. Everything stays on this device.
              </div>

              <div style={{ display: "flex", gap: 12, marginBottom: 14, fontSize: 11, color: "#8b949e" }}>
                <div style={{ padding: "6px 10px", border: "1px solid #21262d", borderRadius: 6, background: "#0d1117" }}>
                  Entries <span style={{ color: "#79c0ff", marginLeft: 4 }}>{journalTotals.raw}</span>
                </div>
                <div style={{ padding: "6px 10px", border: "1px solid #21262d", borderRadius: 6, background: "#0d1117" }}>
                  Behaviors <span style={{ color: "#79c0ff", marginLeft: 4 }}>{journalTotals.behaviors}</span>
                </div>
                <div style={{ padding: "6px 10px", border: "1px solid #21262d", borderRadius: 6, background: "#0d1117" }}>
                  Traits <span style={{ color: "#79c0ff", marginLeft: 4 }}>{journalTotals.psychographics}</span>
                </div>
              </div>

              <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 6 }}>What kind of entry is this?</label>
              <select
                value={journalCategoryId}
                onChange={(e) => setJournalCategoryId(e.target.value)}
                style={{ ...S.chatInput, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
              >
                <optgroup label="What I did">
                  {INSIGHT_CATEGORIES.filter((c) => c.kind === "behavioral").map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </optgroup>
                <optgroup label="How I think / what I value">
                  {INSIGHT_CATEGORIES.filter((c) => c.kind === "psychographic").map((c) => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </optgroup>
              </select>

              <textarea
                value={journalText}
                onChange={(e) => setJournalText(e.target.value)}
                placeholder={"What happened, or what's on your mind?  e.g. 'Bought a new Patagonia jacket for my hiking trip. Expensive but I love that they use recycled materials.'  Add #tags for traits you want to remember."}
                style={{ ...S.chatInput, width: "100%", minHeight: 140, marginBottom: 12, boxSizing: "border-box", lineHeight: 1.5 }}
              />

              {(journalPreview.behaviors.length > 0 || journalPreview.psychographics.length > 0) && (
                <div style={{ marginBottom: 12, padding: "10px 12px", border: "1px solid #21262d", borderRadius: 8, background: "#0d1117" }}>
                  <div style={{ fontSize: 10, color: "#8b949e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Preview — what your Pod would file</div>
                  {journalPreview.behaviors.map((b, i) => (
                    <div key={`b${i}`} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "#c9d1d9", padding: "3px 0" }}>
                      <span style={S.tag("#58a6ff")}>do</span>
                      <span style={{ color: "#8b949e" }}>{b.category} / {b.action}</span>
                      {b.entity && <span style={{ color: "#79c0ff" }}>{b.entity}</span>}
                      <span style={{ marginLeft: "auto", color: "#484f58" }}>{Math.round(b.confidence * 100)}%</span>
                    </div>
                  ))}
                  {journalPreview.psychographics.map((p, i) => (
                    <div key={`p${i}`} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 11, color: "#c9d1d9", padding: "3px 0" }}>
                      <span style={S.tag("#d29922")}>be</span>
                      <span style={{ color: "#8b949e" }}>{p.category}</span>
                      <span style={{ color: "#79c0ff" }}>{p.attribute}</span>
                      <span style={{ marginLeft: "auto", color: "#484f58" }}>{Math.round(p.confidence * 100)}%</span>
                    </div>
                  ))}
                  <div style={{ marginTop: 8, fontSize: 10, color: "#484f58", lineHeight: 1.5 }}>
                    Inferred rows save with a yellow "review me" flag. Review them below in Journal Data.
                  </div>
                </div>
              )}

              <button
                onClick={submitJournalEntry}
                disabled={journalSending || !journalText.trim() || !conn}
                style={{ ...S.runBtn(journalSending || !journalText.trim() || !conn), width: "100%", padding: "11px", textAlign: "center" }}
              >
                {journalSending ? "Saving…" : "Save to my Pod"}
              </button>

              {journalStatus && (
                <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, fontSize: 12, background: journalStatus.ok ? "#122119" : "#3d1c1c", border: `1px solid ${journalStatus.ok ? "#2ea04330" : "#6e3030"}`, color: journalStatus.ok ? "#3fb950" : "#f85149" }}>
                  {journalStatus.text}
                </div>
              )}

              <div style={{ marginTop: 24, borderTop: "1px solid #21262d", paddingTop: 16 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#e6edf3" }}>Journal Data</div>
                  <div style={{ fontSize: 11, color: "#8b949e" }}>
                    {qbeMeta ? `${qbeMeta.rows} row${qbeMeta.rows === 1 ? "" : "s"}` : "loading…"}
                  </div>
                  <input
                    value={qbeCommentLike}
                    onChange={(e) => setQbeCommentLike(e.target.value)}
                    placeholder="Search journal data..."
                    style={{ ...S.chatInput, marginLeft: "auto", width: 220, padding: "6px 10px", fontSize: 12 }}
                  />
                </div>

                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                  <span style={{ fontSize: 10, color: "#484f58", alignSelf: "center", marginRight: 4 }}>SOURCE</span>
                  {[
                    { id: "journal", label: "Journal entries" },
                    { id: "behaviors", label: "Behaviors" },
                    { id: "traits", label: "Traits" },
                  ].map((s) => (
                    <button
                      key={s.id}
                      onClick={() => selectQbeSource(s.id)}
                      style={{
                        background: qbeSource === s.id ? "#1f6feb" : "#161b22",
                        border: `1px solid ${qbeSource === s.id ? "#1f6feb" : "#30363d"}`,
                        color: qbeSource === s.id ? "#fff" : "#8b949e",
                        borderRadius: 999,
                        padding: "4px 10px",
                        fontSize: 11,
                        fontFamily: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>

                {qbeError && (
                  <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, fontSize: 12, background: "#3d1c1c", border: "1px solid #6e3030", color: "#f85149" }}>
                    {qbeError}
                  </div>
                )}
                {qbeResults && qbeResults.rows.length === 0 && !qbeError && (
                  <div style={{ padding: 24, textAlign: "center", color: "#484f58", fontSize: 13 }}>
                    No journal data matches these filters.
                  </div>
                )}
                {qbeResults && qbeResults.rows.length > 0 && qbeSource !== "civic" && (
                  <>
                    <ResultsGrid
                      columns={qbeResults.columns}
                      rows={qbeResults.rows}
                      onCellClick={(col, val) => {
                        if (col === "category" || col === "attribute") {
                          setQbeCommentLike(String(val));
                        }
                      }}
                    />
                    <div style={{ marginTop: 8, fontSize: 10, color: "#484f58", lineHeight: 1.5 }}>
                      Rows with <code>source = "user"</code> are choices you made. Rows with <code>source = "rule:{LEXICON_VERSION}"</code> are inferred from your text by the deterministic extractor (no AI).
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "data" && (
          <div style={formPanelStyle}>
            <div style={{ width: "100%", maxWidth: 520 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#e6edf3", marginBottom: 4 }}>Private Data Import</div>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 20 }}>
                Files are loaded securely into your device's memory. No data is sent to any server.
              </div>

              <label
                style={{ ...S.uploadZone, borderColor: dragOver ? "#58a6ff" : "#30363d" }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}
              >
                <input type="file" accept=".csv,.json,.parquet" style={{ display: "none" }} onChange={(e) => setFile(e.target.files[0])} />
                <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
                <div style={{ color: file ? "#79c0ff" : "#8b949e", fontSize: 13 }}>{file ? file.name : "Drop a file here or click to browse"}</div>
                <div style={{ fontSize: 11, color: "#484f58", marginTop: 4 }}>.csv · .json · .parquet</div>
              </label>

              {file && (
                <button onClick={() => doUpload(file)} disabled={uploading || podStatus !== "connected"} style={{ ...S.runBtn(!uploading), width: "100%", marginTop: 12, padding: "11px", textAlign: "center" }}>
                  {uploading ? "Mounting securely…" : `Mount ${file.name}`}
                </button>
              )}

              {uploadMsg && (
                <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, fontSize: 12, background: uploadMsg.ok ? "#122119" : "#3d1c1c", border: `1px solid ${uploadMsg.ok ? "#2ea04330" : "#6e3030"}`, color: uploadMsg.ok ? "#3fb950" : "#f85149" }}>
                  {uploadMsg.text}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "explore" && <Explore conn={conn} />}

        {tab === "assistant" && civicAiEnabled && (
          <Assistant webId={memberProfile?.webId || getSolidSession().webId || "local"} />
        )}
        
        {tab === "chat" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "16px 20px 10px", borderBottom: "1px solid #161b22", background: "#0d1117" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#e6edf3" }}>Forum Submissions</div>
                <div style={{ fontSize: 11, color: "#8b949e" }}>
                  {qbeMeta ? `${qbeMeta.rows} row${qbeMeta.rows === 1 ? "" : "s"}` : "loading…"}
                </div>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    value={qbeCommentLike}
                    onChange={(e) => setQbeCommentLike(e.target.value)}
                    placeholder="Search comments..."
                    style={{ ...S.chatInput, width: 220, padding: "6px 10px", fontSize: 12 }}
                  />
                  <input
                    value={qbeZipPrefix}
                    onChange={(e) => setQbeZipPrefix(e.target.value)}
                    placeholder="ZIP"
                    style={{ ...S.chatInput, width: 80, padding: "6px 10px", fontSize: 12 }}
                  />
                </div>
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                <span style={{ fontSize: 10, color: "#484f58", alignSelf: "center", marginRight: 4 }}>STATUS</span>
                {QBE_STATUSES.map((s) => (
                  <button
                    key={s.id || "any"}
                    onClick={() => setQbeStatus(s.id)}
                    style={{
                      background: qbeStatus === s.id ? "#1f6feb" : "#161b22",
                      border: `1px solid ${qbeStatus === s.id ? "#1f6feb" : "#30363d"}`,
                      color: qbeStatus === s.id ? "#fff" : "#8b949e",
                      borderRadius: 999,
                      padding: "4px 10px",
                      fontSize: 11,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span style={{ fontSize: 10, color: "#484f58", alignSelf: "center", marginRight: 4 }}>CATEGORY</span>
                <button
                  onClick={() => setQbeCategoryId("")}
                  style={{
                    background: qbeCategoryId === "" ? "#1f6feb" : "#161b22",
                    border: `1px solid ${qbeCategoryId === "" ? "#1f6feb" : "#30363d"}`,
                    color: qbeCategoryId === "" ? "#fff" : "#8b949e",
                    borderRadius: 999,
                    padding: "4px 10px",
                    fontSize: 11,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  All
                </button>
                {INSIGHT_CATEGORIES.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setQbeCategoryId(c.category)}
                    title={c.kind === "behavioral" ? "Behavioral" : "Psychographic"}
                    style={{
                      background: qbeCategoryId === c.category ? "#1f6feb" : "#161b22",
                      border: `1px solid ${qbeCategoryId === c.category ? "#1f6feb" : "#30363d"}`,
                      color: qbeCategoryId === c.category ? "#fff" : "#8b949e",
                      borderRadius: 999,
                      padding: "4px 10px",
                      fontSize: 11,
                      fontFamily: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              {(qbeStatus || qbeCategoryId || qbeZipPrefix || qbeCommentLike || qbeSince) && (
                <div style={{ marginTop: 8 }}>
                  <button
                    onClick={resetQbeFilters}
                    style={{ background: "transparent", border: "none", color: "#58a6ff", fontSize: 11, fontFamily: "inherit", cursor: "pointer", padding: 0 }}
                  >
                    Clear filters
                  </button>
                </div>
              )}
            </div>

            <div style={{ flex: 1, overflow: "auto" }}>
              {qbeError && (
                <div style={{ margin: 14, padding: "10px 14px", borderRadius: 6, fontSize: 12, background: "#3d1c1c", border: "1px solid #6e3030", color: "#f85149" }}>
                  {qbeError}
                </div>
              )}
              {qbeResults && qbeResults.rows.length === 0 && !qbeError && (
                <div style={{ padding: 32, textAlign: "center", color: "#484f58", fontSize: 13 }}>
                  No submissions match these filters.
                </div>
              )}
              {qbeResults && qbeResults.rows.length > 0 && (
                <SpreadsheetView
                  rows={qbeResults.rows}
                  sortBy={qbeSortBy}
                  sortDir={qbeSortDir}
                  onSort={(col) => {
                    if (col === qbeSortBy) setQbeSortDir(qbeSortDir === "ASC" ? "DESC" : "ASC");
                    else { setQbeSortBy(col); setQbeSortDir("DESC"); }
                  }}
                  expandedRowId={expandedRowId}
                  onToggleRow={(id) => setExpandedRowId(expandedRowId === id ? null : id)}
                  onRefineCategory={(label) => {
                    // Resolve back from the human label to either a v1.5 category_code
                    // slug or a legacy civic integer id, in that order.
                    const insight = INSIGHT_CATEGORIES.find((c) => c.label === label);
                    if (insight) { setQbeCategoryId(insight.category); return; }
                    const legacy = CIVIC_CATEGORIES.find((c) => c.label === label);
                    if (legacy) setQbeCategoryId(String(legacy.id));
                  }}
                  onRefineStatus={(s) => setQbeStatus(s)}
                  onRefineZip={(z) => setQbeZipPrefix(String(z))}
                />
              )}
            </div>

            <div style={{ padding: "8px 20px", borderTop: "1px solid #161b22", display: "flex", gap: 12, alignItems: "center", fontSize: 11, color: "#484f58" }}>
              <span>Showing up to {qbeLimit} rows</span>
              <button onClick={() => setQbeLimit((l) => Math.min(500, (l || 50) + 50))} style={{ background: "transparent", border: "1px solid #30363d", color: "#79c0ff", borderRadius: 5, padding: "4px 9px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>
                Load more
              </button>
              <span style={{ marginLeft: "auto" }}>
                <button onClick={() => setShowSql((v) => !v)} style={{ background: "transparent", border: "none", color: "#8b949e", fontSize: 11, fontFamily: "inherit", cursor: "pointer", padding: 0 }}>
                  {showSql ? "hide query" : "show query"}
                </button>
              </span>
              {showAdvanced && qbeSql && (
                <button onClick={() => { setSqlInput(qbeSql); setTab("sql"); }} style={{ background: "transparent", border: "1px solid #30363d", color: "#58a6ff", borderRadius: 5, padding: "4px 9px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" }}>
                  Open in SQL Editor
                </button>
              )}
            </div>
            {showSql && qbeSql && (
              <div style={{ padding: "0 20px 12px" }}>
                <pre style={{ ...S.pre, fontSize: 11, color: "#8b949e", whiteSpace: "pre-wrap" }}>{qbeSql}</pre>
              </div>
            )}
          </div>
        )}

        {tab === "settings" && (
          <div style={formPanelStyle}>
            <div style={{ width: "100%", maxWidth: 560 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#e6edf3", marginBottom: 4 }}>Pod &amp; Connection</div>
              <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 12, lineHeight: 1.5 }}>
                Signed in as <span style={{ color: "#79c0ff" }}>{memberProfile?.webId || getSolidSession().webId || "Pod user"}</span>.
                Data is stored in your Personal Pod (Cloudflare Durable Object); this browser keeps a temporary cache only.
              </div>
              <button
                type="button"
                disabled={signOutBusy}
                onClick={handleSignOut}
                style={{ ...S.runBtn(signOutBusy), width: "100%", padding: "10px", marginBottom: 8, textAlign: "center" }}
              >
                {signOutBusy ? "Signing out…" : "Sign out (lock — keeps device key)"}
              </button>
              <button
                type="button"
                disabled={signOutBusy}
                onClick={handleForgetDevice}
                style={{ ...S.runBtn(signOutBusy), width: "100%", padding: "10px", marginBottom: 16, textAlign: "center", borderColor: "#6e3030", background: "transparent", color: "#f85149" }}
              >
                Forget this device (delete key)
              </button>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, marginBottom: 12 }}><input type="checkbox" checked={shareWithCooperative} onChange={(e) => { setShareWithCooperative(e.target.checked); localStorage.setItem("forum.shareWithCooperative", e.target.checked ? "1" : "0"); }} />Opt-in cooperative share</label>

              <div style={{ marginTop: 8, marginBottom: 16, padding: "12px 14px", border: "1px solid #21262d", borderRadius: 8, background: "#0d1117" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#e6edf3" }}>Device key</div>
                  {signingMeta?.publicKeyHex ? (
                    <span style={S.tag("#3fb950")}>active</span>
                  ) : (
                    <span style={S.tag("#d29922")}>missing</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.55, marginBottom: 10 }}>
                  Your Pod and cooperative submissions are signed by an Ed25519 key generated on this device. Export is PIN-wrapped (v2). <strong style={{ color: "#d29922" }}>Anyone with the blob and PIN can read or write your Pod.</strong>
                </div>
                {signingMeta?.publicKeyHex && (
                  <div style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.5, marginBottom: 10 }}>
                    Public key: <code style={{ color: "#79c0ff" }}>{signingMeta.publicKeyHex.slice(0, 18)}…</code><br />
                    Created: <code>{signingMeta.createdAt ? new Date(signingMeta.createdAt).toISOString() : "(unknown)"}</code>
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const pin = window.prompt("Choose a PIN (4+ characters) to encrypt this export:");
                        if (!pin) return;
                        const confirm = window.prompt("Confirm PIN:");
                        if (pin !== confirm) {
                          setDeviceKeyStatus({ ok: false, text: "PINs did not match." });
                          return;
                        }
                        const blob = await exportDeviceKeyBlob(pin);
                        if (!blob) {
                          setDeviceKeyStatus({ ok: false, text: "No device key to export. Create a Pod first." });
                          return;
                        }
                        setDeviceKeyExport(blob);
                        setDeviceKeyStatus({ ok: true, text: "PIN-protected blob ready. Copy it to your other device." });
                      } catch (e) {
                        setDeviceKeyStatus({ ok: false, text: e.message });
                      }
                    }}
                    style={{ ...S.runBtn(false), padding: "8px 12px", fontSize: 11 }}
                  >
                    Export device key
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowDeviceKeyImport((v) => !v);
                      setDeviceKeyStatus(null);
                    }}
                    style={{ background: "transparent", border: "1px solid #30363d", color: "#e6edf3", borderRadius: 6, padding: "8px 12px", fontFamily: "inherit", fontSize: 11, cursor: "pointer" }}
                  >
                    {showDeviceKeyImport ? "Cancel import" : "Import device key"}
                  </button>
                  {deviceKeyExport && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard?.writeText(deviceKeyExport);
                          setDeviceKeyStatus({ ok: true, text: "Copied to clipboard." });
                        } catch {
                          setDeviceKeyStatus({ ok: false, text: "Clipboard unavailable; copy manually below." });
                        }
                      }}
                      style={{ background: "transparent", border: "1px solid #30363d", color: "#79c0ff", borderRadius: 6, padding: "8px 12px", fontFamily: "inherit", fontSize: 11, cursor: "pointer" }}
                    >
                      Copy blob
                    </button>
                  )}
                </div>
                {deviceKeyExport && (
                  <textarea
                    readOnly
                    value={deviceKeyExport}
                    onFocus={(e) => e.target.select()}
                    style={{ ...S.chatInput, width: "100%", minHeight: 80, marginBottom: 8, boxSizing: "border-box", fontSize: 10, fontFamily: "monospace" }}
                  />
                )}
                {showDeviceKeyImport && (
                  <>
                    <textarea
                      value={deviceKeyImport}
                      onChange={(e) => setDeviceKeyImport(e.target.value)}
                      placeholder="Paste the device key blob from your other device..."
                      style={{ ...S.chatInput, width: "100%", minHeight: 80, marginBottom: 8, boxSizing: "border-box", fontSize: 10, fontFamily: "monospace" }}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const pin = window.prompt("Enter the PIN for this export (leave empty only for legacy unprotected v1 blobs):");
                          const result = await importDeviceKeyBlob(deviceKeyImport.trim(), pin || undefined);
                          setSigningMeta(loadSigningMeta());
                          setMemberProfile(loadMemberProfile());
                          setDeviceKeyImport("");
                          setShowDeviceKeyImport(false);
                          const legacyNote = result.legacyUnprotected
                            ? " Warning: legacy unprotected blob — re-export with a PIN."
                            : "";
                          setDeviceKeyStatus({
                            ok: true,
                            text: `Imported.${legacyNote} Tap "Sign in to existing Pod" to unlock (webId: ${result.webId || "(none)"}).`,
                          });
                        } catch (e) {
                          setDeviceKeyStatus({ ok: false, text: e.message });
                        }
                      }}
                      disabled={!deviceKeyImport.trim()}
                      style={{ ...S.runBtn(!deviceKeyImport.trim()), padding: "8px 12px", fontSize: 11 }}
                    >
                      Apply imported key
                    </button>
                  </>
                )}
                {deviceKeyStatus && (
                  <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 6, fontSize: 11, background: deviceKeyStatus.ok ? "#122119" : "#3d1c1c", border: `1px solid ${deviceKeyStatus.ok ? "#2ea04330" : "#6e3030"}`, color: deviceKeyStatus.ok ? "#3fb950" : "#f85149" }}>
                    {deviceKeyStatus.text}
                  </div>
                )}
              </div>

              <label style={{ fontSize: 11, color: "#8b949e", display: "block", marginBottom: 6 }}>Cooperative bridge URL</label>
              <input
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://pod.yourcommunity.forum"
                style={{ ...S.chatInput, width: "100%", marginBottom: 12, boxSizing: "border-box" }}
              />
              <button
                onClick={() => {
                  const next = serverUrl.trim().replace(/\/$/, "");
                  if (isNativeShell && !next) {
                    setSettingsStatus({ ok: false, text: "Android app builds need a public HTTPS server URL." });
                    return;
                  }
                  localStorage.setItem("forum.serverUrl", next);
                  setServerUrl(next);
                  setSettingsStatus({ ok: true, text: next ? `Saved. Opt-in export: ${next}/api/forum/feedback` : "Saved." });
                }}
                style={{ ...S.runBtn(false), width: "100%", padding: "11px", textAlign: "center" }}
              >
                Save cooperative URL
              </button>
              {settingsStatus && (
                <div style={{ marginTop: 12, padding: "10px 14px", borderRadius: 6, fontSize: 12, background: settingsStatus.ok ? "#122119" : "#3d1c1c", border: `1px solid ${settingsStatus.ok ? "#2ea04330" : "#6e3030"}`, color: settingsStatus.ok ? "#3fb950" : "#f85149" }}>
                  {settingsStatus.text}
                </div>
              )}
              <div style={{ marginTop: 16, fontSize: 11, color: "#484f58", lineHeight: 1.6 }}>
                Export endpoint: {cooperativeExportUrl}
              </div>

              <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid #21262d" }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#8b949e", marginBottom: 12 }}>
                  <input
                    type="checkbox"
                    checked={civicAiEnabled}
                    onChange={(e) => {
                      if (e.target.checked) {
                        if (localStorage.getItem("forum.civicAiDisclosureAccepted") === "1") {
                          localStorage.setItem("forum.civicAiEnabled", "1");
                          setCivicAiEnabled(true);
                          setTab("assistant");
                        } else {
                          setShowCivicAiDisclosure(true);
                        }
                      } else {
                        localStorage.setItem("forum.civicAiEnabled", "0");
                        setCivicAiEnabled(false);
                        if (tab === "assistant") setTab("settings");
                      }
                    }}
                  />
                  Enable Civic AI Kami assistant
                </label>
                <div style={{ fontSize: 10, color: "#484f58", marginTop: -6, marginBottom: 12, lineHeight: 1.5 }}>
                  Uses the community GPU through the signed Worker proxy. Conversations are stored on this device and forgotten on sign-out.
                </div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#8b949e" }}>
                  <input
                    type="checkbox"
                    checked={showAdvanced}
                    onChange={(e) => {
                      setShowAdvanced(e.target.checked);
                      localStorage.setItem("forum.showAdvanced", e.target.checked ? "1" : "0");
                      if (!e.target.checked && tab === "sql") setTab("chat");
                    }}
                  />
                  Show SQL Editor (advanced)
                </label>
                <div style={{ fontSize: 10, color: "#484f58", marginTop: 4, lineHeight: 1.5 }}>
                  My Data already runs deterministic SQL under the hood. Turn this on only if you want to write your own SELECT queries against local DuckDB.
                </div>
              </div>
            </div>
          </div>
        )}
      </div>}
    </div>
  );
}
