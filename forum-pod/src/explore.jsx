/**
 * Explore — deterministic Q&A over the user's Pod data.
 *
 * Every question button maps to one hand-written SQL template against the
 * DuckDB-WASM cache (which is hydrated from the Personal Pod DO on
 * sign-in per Handover 13). No language model is involved at any point.
 * Results are rendered as a row table plus a one-line factual summary
 * computed from the result set itself.
 *
 * Hallucination is structurally impossible here: the user sees the exact
 * SQL that ran, the row count, and the result table. The summary line
 * uses only arithmetic over the returned rows.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

const S = {
  shell: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#0d1117" },
  header: { padding: "14px 18px", borderBottom: "1px solid #161b22" },
  title: { fontSize: 14, fontWeight: 700, color: "#e6edf3", marginBottom: 4 },
  subtitle: { fontSize: 12, color: "#8b949e", lineHeight: 1.5 },
  body: { flex: 1, minHeight: 0, display: "flex", overflow: "hidden" },
  sidebar: {
    width: 280,
    minWidth: 240,
    borderRight: "1px solid #161b22",
    padding: "16px 14px",
    overflowY: "auto",
    background: "#0a0d12",
  },
  sectionLabel: { fontSize: 10, color: "#484f58", textTransform: "uppercase", letterSpacing: 0.5, margin: "14px 0 6px" },
  qBtn: (active) => ({
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 10px",
    fontSize: 12,
    lineHeight: 1.4,
    background: active ? "#1f6feb" : "#161b22",
    border: `1px solid ${active ? "#1f6feb" : "#21262d"}`,
    color: active ? "#fff" : "#c9d1d9",
    borderRadius: 6,
    cursor: "pointer",
    marginBottom: 6,
    fontFamily: "inherit",
  }),
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  summary: {
    padding: "14px 18px",
    borderBottom: "1px solid #161b22",
    fontSize: 13,
    color: "#e6edf3",
    lineHeight: 1.5,
  },
  sqlBlock: {
    padding: "10px 18px",
    background: "#0a0d12",
    borderBottom: "1px solid #161b22",
    fontFamily: "ui-monospace, SFMono-Regular, monospace",
    fontSize: 11,
    color: "#8b949e",
    whiteSpace: "pre-wrap",
    maxHeight: 120,
    overflowY: "auto",
  },
  tableWrap: { flex: 1, minHeight: 0, overflow: "auto", padding: "12px 0" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#c9d1d9" },
  th: {
    padding: "8px 12px",
    textAlign: "left",
    borderBottom: "1px solid #21262d",
    color: "#8b949e",
    fontWeight: 600,
    background: "#0d1117",
    position: "sticky",
    top: 0,
  },
  td: { padding: "8px 12px", borderBottom: "1px solid #161b22", verticalAlign: "top" },
  empty: { padding: "30px 20px", color: "#484f58", fontSize: 13, textAlign: "center" },
  err: {
    margin: "12px 18px",
    padding: "10px 14px",
    borderRadius: 6,
    background: "#3d1c1c",
    border: "1px solid #6e3030",
    color: "#f85149",
    fontSize: 12,
  },
};

// Each preset is { id, label, group, sql, summarise }. `summarise(rows)`
// returns a short factual sentence built from the returned rows.
const PRESETS = [
  // ---- Totals
  {
    id: "totals",
    label: "How many rows do I have, total?",
    group: "Totals",
    sql: `SELECT
  (SELECT COUNT(*) FROM civic_submissions)                       AS forum_submissions,
  (SELECT COUNT(*) FROM raw_submissions)                         AS journal_entries,
  (SELECT COUNT(*) FROM behavioral_data)                         AS behaviors,
  (SELECT COUNT(*) FROM psychographic_data)                      AS traits;`,
    summarise(rows) {
      const r = rows[0] || {};
      const total = (r.forum_submissions || 0) + (r.journal_entries || 0) + (r.behaviors || 0) + (r.traits || 0);
      if (total === 0) return "Your Pod has no rows saved yet.";
      return `Pod totals — Forum Submissions: ${r.forum_submissions || 0}, Journal entries: ${r.journal_entries || 0}, Behaviors: ${r.behaviors || 0}, Traits: ${r.traits || 0}.`;
    },
  },
  {
    id: "anything_24h",
    label: "Anything saved in the last 24 hours?",
    group: "Totals",
    sql: `WITH t AS (
  SELECT 'forum_submission' AS kind, submitted_at AS ts FROM civic_submissions WHERE submitted_at >= now() - INTERVAL 1 DAY
  UNION ALL
  SELECT 'journal_entry', submitted_at FROM raw_submissions WHERE submitted_at >= now() - INTERVAL 1 DAY
  UNION ALL
  SELECT 'behavior', created_at FROM behavioral_data WHERE created_at >= now() - INTERVAL 1 DAY
  UNION ALL
  SELECT 'trait', created_at FROM psychographic_data WHERE created_at >= now() - INTERVAL 1 DAY
)
SELECT kind, COUNT(*) AS rows FROM t GROUP BY kind ORDER BY rows DESC;`,
    summarise(rows) {
      if (rows.length === 0) return "Nothing saved in the last 24 hours.";
      const parts = rows.map((r) => `${r.kind} (${r.rows})`);
      return `Last 24 hours: ${parts.join(", ")}.`;
    },
  },

  // ---- Forum Submissions
  {
    id: "fs_recent",
    label: "Show my 10 most recent Forum Submissions",
    group: "Forum Submissions",
    sql: `SELECT submitted_at, category_label, zip_code, egress_status, comment
FROM civic_submissions
ORDER BY submitted_at DESC
LIMIT 10;`,
    summarise(rows) {
      if (rows.length === 0) return "No Forum Submissions saved yet.";
      const newest = rows[0].submitted_at || "?";
      const cats = new Set(rows.map((r) => r.category_label).filter(Boolean));
      return `Showing ${rows.length} most recent Forum Submission${rows.length === 1 ? "" : "s"}. Newest: ${String(newest).slice(0, 10)}. Categories present: ${cats.size}.`;
    },
  },
  {
    id: "fs_by_category",
    label: "Which categories do I submit most?",
    group: "Forum Submissions",
    sql: `SELECT COALESCE(category_label, '(uncategorized)') AS category, COUNT(*) AS submissions
FROM civic_submissions
GROUP BY category
ORDER BY submissions DESC, category;`,
    summarise(rows) {
      if (rows.length === 0) return "No Forum Submissions to group.";
      const total = rows.reduce((acc, r) => acc + Number(r.submissions || 0), 0);
      const top = rows[0];
      return `${total} submission${total === 1 ? "" : "s"} across ${rows.length} categor${rows.length === 1 ? "y" : "ies"}. Most common: ${top.category} (${top.submissions}).`;
    },
  },
  {
    id: "fs_by_zip",
    label: "Which ZIPs do I submit from?",
    group: "Forum Submissions",
    sql: `SELECT COALESCE(zip_code, '(no ZIP)') AS zip, COUNT(*) AS submissions
FROM civic_submissions
GROUP BY zip
ORDER BY submissions DESC, zip;`,
    summarise(rows) {
      if (rows.length === 0) return "No Forum Submissions to group.";
      const total = rows.reduce((acc, r) => acc + Number(r.submissions || 0), 0);
      const top = rows[0];
      return `${total} submission${total === 1 ? "" : "s"} across ${rows.length} ZIP${rows.length === 1 ? "" : "s"}. Top: ${top.zip} (${top.submissions}).`;
    },
  },
  {
    id: "fs_pending_sync",
    label: "Which submissions are still pending sync?",
    group: "Forum Submissions",
    sql: `SELECT submitted_at, category_label, zip_code, egress_status, last_error
FROM civic_submissions
WHERE egress_status IN ('pending', 'failed', 'syncing')
ORDER BY submitted_at DESC;`,
    summarise(rows) {
      if (rows.length === 0) return "Every Forum Submission is fully synced.";
      const failed = rows.filter((r) => r.egress_status === "failed").length;
      return `${rows.length} submission${rows.length === 1 ? "" : "s"} not fully synced (${failed} failed).`;
    },
  },

  // ---- Journal
  {
    id: "j_recent",
    label: "Show my 10 most recent Journal entries",
    group: "Journal",
    sql: `SELECT submitted_at, user_category_label, raw_text
FROM raw_submissions
ORDER BY submitted_at DESC
LIMIT 10;`,
    summarise(rows) {
      if (rows.length === 0) return "No Journal entries saved yet.";
      const newest = rows[0].submitted_at || "?";
      return `Showing ${rows.length} most recent Journal entr${rows.length === 1 ? "y" : "ies"}. Newest: ${String(newest).slice(0, 10)}.`;
    },
  },
  {
    id: "j_by_category",
    label: "Which Journal categories do I use most?",
    group: "Journal",
    sql: `SELECT COALESCE(user_category_label, '(uncategorized)') AS category, COUNT(*) AS entries
FROM raw_submissions
GROUP BY category
ORDER BY entries DESC, category;`,
    summarise(rows) {
      if (rows.length === 0) return "No Journal entries to group.";
      const total = rows.reduce((acc, r) => acc + Number(r.entries || 0), 0);
      const top = rows[0];
      return `${total} Journal entr${total === 1 ? "y" : "ies"} across ${rows.length} categor${rows.length === 1 ? "y" : "ies"}. Most common: ${top.category} (${top.entries}).`;
    },
  },
  {
    id: "j_this_week",
    label: "What did I journal this week?",
    group: "Journal",
    sql: `SELECT submitted_at, user_category_label, raw_text
FROM raw_submissions
WHERE submitted_at >= now() - INTERVAL 7 DAY
ORDER BY submitted_at DESC;`,
    summarise(rows) {
      if (rows.length === 0) return "No Journal entries in the last 7 days.";
      return `${rows.length} Journal entr${rows.length === 1 ? "y" : "ies"} in the last 7 days.`;
    },
  },

  // ---- Behaviors
  {
    id: "b_by_category",
    label: "Which behaviors am I noting?",
    group: "Behaviors",
    sql: `SELECT COALESCE(category, '(uncategorized)') AS category, COUNT(*) AS rows
FROM behavioral_data
GROUP BY category
ORDER BY rows DESC, category;`,
    summarise(rows) {
      if (rows.length === 0) return "No behavior rows saved yet.";
      const total = rows.reduce((acc, r) => acc + Number(r.rows || 0), 0);
      const top = rows[0];
      return `${total} behavior row${total === 1 ? "" : "s"} across ${rows.length} categor${rows.length === 1 ? "y" : "ies"}. Most frequent: ${top.category} (${top.rows}).`;
    },
  },
  {
    id: "b_recent",
    label: "Show my 10 most recent behaviors",
    group: "Behaviors",
    sql: `SELECT created_at, category, action, entity, confidence, source
FROM behavioral_data
ORDER BY created_at DESC
LIMIT 10;`,
    summarise(rows) {
      if (rows.length === 0) return "No behaviors saved yet.";
      const userRows = rows.filter((r) => r.source === "user").length;
      return `Showing ${rows.length} most recent behavior row${rows.length === 1 ? "" : "s"} (${userRows} you chose, ${rows.length - userRows} rule-derived).`;
    },
  },

  // ---- Traits
  {
    id: "t_by_category",
    label: "Which trait categories appear in my data?",
    group: "Traits",
    sql: `SELECT COALESCE(category, '(uncategorized)') AS category, COUNT(*) AS rows
FROM psychographic_data
GROUP BY category
ORDER BY rows DESC, category;`,
    summarise(rows) {
      if (rows.length === 0) return "No trait rows saved yet.";
      const total = rows.reduce((acc, r) => acc + Number(r.rows || 0), 0);
      const top = rows[0];
      return `${total} trait row${total === 1 ? "" : "s"} across ${rows.length} categor${rows.length === 1 ? "y" : "ies"}. Most frequent: ${top.category} (${top.rows}).`;
    },
  },
  {
    id: "t_recent",
    label: "Show my 10 most recent traits",
    group: "Traits",
    sql: `SELECT created_at, category, attribute, sentiment, confidence, source
FROM psychographic_data
ORDER BY created_at DESC
LIMIT 10;`,
    summarise(rows) {
      if (rows.length === 0) return "No traits saved yet.";
      const userRows = rows.filter((r) => r.source === "user").length;
      return `Showing ${rows.length} most recent trait row${rows.length === 1 ? "" : "s"} (${userRows} you chose, ${rows.length - userRows} rule-derived).`;
    },
  },
];

function formatCell(value) {
  if (value === null || value === undefined) return <span style={{ color: "#484f58" }}>—</span>;
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  if (s.length > 240) return `${s.slice(0, 240)}…`;
  return s;
}

export default function Explore({ conn }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const preset of PRESETS) {
      if (!map.has(preset.group)) map.set(preset.group, []);
      map.get(preset.group).push(preset);
    }
    return Array.from(map.entries());
  }, []);

  const [activePresetId, setActivePresetId] = useState(PRESETS[0].id);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [summary, setSummary] = useState(null);
  const [busy, setBusy] = useState(false);

  const runPreset = useCallback(
    async (presetId) => {
      const preset = PRESETS.find((p) => p.id === presetId);
      if (!preset || !conn) return;
      setActivePresetId(preset.id);
      setBusy(true);
      setError(null);
      const t0 = Date.now();
      try {
        const arrow = await conn.query(preset.sql);
        const columns = arrow.schema.fields.map((f) => f.name);
        const rows = arrow.toArray().map((r) => Object.fromEntries(r));
        setResult({ columns, rows, sql: preset.sql });
        setMeta({ rows: rows.length, ms: Date.now() - t0 });
        setSummary(preset.summarise(rows));
      } catch (e) {
        setResult({ columns: [], rows: [], sql: preset.sql });
        setError(e.message);
        setMeta(null);
        setSummary(null);
      } finally {
        setBusy(false);
      }
    },
    [conn]
  );

  // Auto-run the first preset once the DB connection is ready so the
  // tab opens with a real answer instead of an empty pane.
  useEffect(() => {
    if (!conn || result) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runPreset(activePresetId);
  }, [conn, result, activePresetId, runPreset]);

  return (
    <div style={S.shell}>
      <div style={S.header}>
        <div style={S.title}>Explore your Pod data</div>
        <div style={S.subtitle}>
          Pick a question on the left. Each answer is a deterministic SQL query against your
          device cache (mirrored from your Personal Pod). You can see the exact query that ran
          and the row count. No language model is involved — nothing can be invented here.
        </div>
      </div>
      <div style={S.body}>
        <div style={S.sidebar}>
          {groups.map(([groupLabel, presets]) => (
            <div key={groupLabel}>
              <div style={S.sectionLabel}>{groupLabel}</div>
              {presets.map((preset) => (
                <button
                  key={preset.id}
                  style={S.qBtn(preset.id === activePresetId)}
                  onClick={() => runPreset(preset.id)}
                  disabled={!conn || busy}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div style={S.main}>
          <div style={S.summary}>
            {busy && "Running query…"}
            {!busy && summary}
            {!busy && !summary && !error && "Loading…"}
          </div>
          {result?.sql && (
            <div style={S.sqlBlock}>
              {result.sql}
              {meta && (
                <span style={{ color: "#484f58", display: "block", marginTop: 6 }}>
                  → {meta.rows} row{meta.rows === 1 ? "" : "s"} · {meta.ms}ms
                </span>
              )}
            </div>
          )}
          {error && <div style={S.err}>{error}</div>}
          <div style={S.tableWrap}>
            {result && result.rows.length === 0 && !error && (
              <div style={S.empty}>No rows for this question.</div>
            )}
            {result && result.rows.length > 0 && (
              <table style={S.table}>
                <thead>
                  <tr>
                    {result.columns.map((col) => (
                      <th key={col} style={S.th}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {result.columns.map((col) => (
                        <td key={col} style={S.td}>
                          {formatCell(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
