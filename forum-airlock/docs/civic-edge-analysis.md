# Civic aggregate analysis on the Cloudflare edge

Faithful cooperative reporting for **opt-in forum feedback already stored in D1**.
This path replaces the on-prem `forum-ai` Ollama classify/aggregate loop for
public cooperative summaries. Personal Pod data is never read for this path.

## Design (same contract as legacy forum-ai)

| Principle | Implementation |
|-----------|----------------|
| Single source of truth | D1 `forum_feedback` only |
| Full context | Every row’s full `comment` (after identifier redaction) |
| No hallucination | **No Workers AI** — no narrative synthesis, sentiment, or bridging scores |
| Length cap | **Pod** enforces `FORUM_FEEDBACK_MAX_COMMENT_CHARS` (2000); Worker clamps again on ingest |
| Cannot answer faithfully | Report states that explicitly when counts are low or a metric is not in SQL |

## API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/civic/analysis` | Public | Latest report JSON (`report`, `metadata`, `ledger`) |
| `GET` | `/api/civic/analysis/ledger` | Public | Live D1 ledger + SQL sources (no stored report) |
| `POST` | `/api/civic/analysis/run` | `X-Airlock-Secret` | Rebuild report from D1 |
| `POST` | `/api/civic/analysis/publish` | `X-Airlock-Secret` | Push latest stored report to egress |
| `POST` | `/api/civic/analysis/dev-push` | None (pilot) | Generate from D1 and publish — requires `ALLOW_DEV_CIVIC_PUBLISH = "1"` |

### Pilot: DEV push (no secret)

Pod **Forum Feedback** → **DEV: Generate & publish public report**, or:

```bash
curl -sS -X POST "https://secure-worker.forum-community.workers.dev/api/civic/analysis/dev-push"
```

Updates D1 `civic_analysis_reports` and POSTs to `FORUM_EGRESS_URL` when secrets are set.
Set `ALLOW_DEV_CIVIC_PUBLISH = "0"` in `wrangler.toml` before production.

### Run analysis (operator)

```bash
curl -sS -X POST "https://secure-worker.forum-community.workers.dev/api/civic/analysis/run" \
  -H "Content-Type: application/json" \
  -H "X-Airlock-Secret: $AIRLOCK_SECRET" \
  -d '{"trigger":"manual","publish":true}'
```

### Publish latest to forum-egress Worker

Set secrets on `secure-worker`:

```bash
npx wrangler secret put FORUM_EGRESS_URL   # e.g. https://forum-egress.yourcommunity.forum
npx wrangler secret put FORUM_SECRET       # matches forum-egress Worker FORUM_SECRET
```

Then:

```bash
curl -sS -X POST ".../api/civic/analysis/publish" \
  -H "X-Airlock-Secret: $AIRLOCK_SECRET"
```

Public HTML: `GET https://forum-egress.yourcommunity.forum/` (KV key `latest`).

## Automation

- **Cron**: every **6 hours** UTC (`0 */6 * * *` in `wrangler.toml`). Each run **generates and publishes** (`publish: true`) to forum-egress when secrets are configured.
- **Per feedback**: set `FORUM_AUTO_EDGE_ANALYSIS = "1"` in `wrangler.toml`
  to `waitUntil` an analysis run after each successful `/api/forum/feedback` (D1 only unless you also pass publish in code).

## Legacy on-prem pipeline

The legacy on-prem timer and Python pipeline are archived under
`archive/forum-on-prem/`. Do not re-enable them for the live report path:
they read local `forum_inbound.db`, while the cooperative ledger now lives in
D1 `forum_feedback`.

## What the report contains

1. SQL aggregate counts (total, distinct participant hashes, by category, ZIP prefixes).
2. **Full submission ledger** — one section per `receipt_id` with verbatim comment text.
3. The exact SQL queries used (reproducible).
4. A **faithfulness boundary** section listing what cannot be claimed from D1 alone.

Identifier redaction (emails, phone patterns) is applied for published text only; comments are not truncated for “themes.”

## Privacy

Published reports include opt-in cooperative comments (length-capped at submit). They do not include `email_hash`, `session_id`, `web_id`, or Pod DO contents. ZIPs in the ledger are as submitted; aggregate ZIP section uses first-three-digit prefixes only.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `CIVIC_ANALYSIS_MIN_SUBMISSIONS` | `1` | Skip run if fewer rows (still returns `skipped`) |
| `ALLOW_DEV_CIVIC_PUBLISH` | `1` (pilot) | Enable unauthenticated `dev-push`; set `"0"` before launch |
| `FORUM_FEEDBACK_MAX_COMMENT_CHARS` | `2000` (code) | Documented in `feedback-limits.js` / `civic-vocab.js` |

Workers AI (`[ai]` binding) is **not** used by civic analysis. The binding remains for other features (e.g. Kami chat proxy).
