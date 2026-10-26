-- Remove per-row submission data (receipt_id, full ZIP, timestamps, comments)
-- that earlier builds stored inside civic_analysis_reports.metadata_json.
-- Aggregates (counts, categories, ZIP-3 prefixes) are kept.
-- Apply once:
--   npx wrangler d1 execute forum-db --remote --file migrations/0002_strip_row_level_report_metadata.sql
UPDATE civic_analysis_reports
SET metadata_json = json_remove(metadata_json, '$.ledger.ledger')
WHERE json_valid(metadata_json)
  AND json_type(metadata_json, '$.ledger.ledger') IS NOT NULL;
