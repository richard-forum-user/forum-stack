/**
 * Shared Forum Feedback DuckDB helpers (imported by solid-sync without
 * a circular pod-ui import). The local table is still named
 * `civic_submissions` for data continuity; v1.5+ rows additionally
 * carry `kind` and `category_code`.
 */
import { CIVIC_CATEGORIES } from "./civic-categories.js";
import { findInsightCategory } from "./insight-categories.js";

function sqlEscape(v) {
  return String(v ?? "").replace(/'/g, "''");
}

export { CIVIC_CATEGORIES };

export async function recordCivicLocally(connection, row) {
  const insightCat = row.category_code ? findInsightCategory(row.category_code) : null;
  const legacyCat = CIVIC_CATEGORIES.find((c) => c.id === row.category_id);
  const label = row.category_label || insightCat?.label || legacyCat?.label || "Uncategorized";
  const kind = row.kind || insightCat?.kind || (legacyCat ? "civic" : null);
  const categoryCode = row.category_code || insightCat?.category || null;

  await connection.query(`
    INSERT OR REPLACE INTO civic_submissions
      (receipt_id, zip_code, kind, category_code, category_id, category_label,
       comment, egress_status, vault_status, sync_attempts, last_error, submitted_at)
    VALUES (
      '${sqlEscape(row.receipt_id)}',
      ${row.zip_code ? `'${sqlEscape(row.zip_code)}'` : "NULL"},
      ${kind ? `'${sqlEscape(kind)}'` : "NULL"},
      ${categoryCode ? `'${sqlEscape(categoryCode)}'` : "NULL"},
      ${row.category_id != null ? Number(row.category_id) : "NULL"},
      '${sqlEscape(label)}',
      '${sqlEscape(row.comment)}',
      '${sqlEscape(row.egress_status)}',
      ${row.vault_status ? `'${sqlEscape(row.vault_status)}'` : "NULL"},
      ${Number(row.sync_attempts || 0)},
      ${row.last_error ? `'${sqlEscape(row.last_error)}'` : "NULL"},
      '${sqlEscape(row.submitted_at || new Date().toISOString())}'
    );
  `);
}
