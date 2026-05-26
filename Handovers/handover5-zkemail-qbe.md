# Handover 5 — Local-only Pod, zkEmail, Spreadsheet UI

**Date:** 2026-05-21
**Build target:** `1.4-spreadsheet`
**Prior:** [handover4-solid-ops.md](handover4-solid-ops.md)

## Late-day amendments (post-first-bring-up)

After the first real launch, three things changed from the doc below:

1. **CSS startup** — `forum-solid/config/config.json` had an invalid
   top-level `global` object that CSS 7 rejected (`Invalid predicate
   IRI: global`). The fix is to leave the config minimal (just
   `@context`, `import`, and an `@graph` comment) and pass `baseUrl`
   via the CSS CLI flag in `package.json` scripts: `-b
   http://localhost:3456`.

2. **provision-bridge GET /** — the bridge previously returned
   "cannot GET /" at its root. It now serves a small HTML landing
   page that lists endpoints. The bridge is still API-only; humans
   are pointed at `http://localhost:5173`.

3. **Spreadsheet UX** — the separate "SQL Editor" and
   "Query by Example" tabs were collapsed into a single **My Data**
   spreadsheet view. SQL Editor is now hidden behind a Settings
   toggle ("Show SQL Editor (advanced)"). The tab bar default is
   now **My Data**, then Civic Feedback, Import, Settings.

   The spreadsheet view:
   - Status and Category filter chips at the top.
   - Free-text search across `comment` (uses DuckDB `ILIKE`).
   - ZIP prefix filter.
   - Sortable column headers (`When`, `ZIP`, `Category`, `Status`).
   - Click any row to expand and see receipt id, vault status, and
     the full comment.
   - Click a ZIP, category, or status cell to add it as a filter.
   - "Load more" raises the row limit in steps of 50 (max 500).
   - "show query" exposes the deterministic SQL for transparency.

   All filters re-run automatically through `runQbe` — no Run
   button. The underlying `buildQbeSql()` engine is unchanged from
   the QBE design below; only the presentation differs.

The rest of this handover (zkEmail, listener routes, schema, launcher,
gating) is still accurate.

---


This handover documents the shift away from a hosted Pod URL toward a
**fully local user stack** that you can launch with one script, with
identity provided by **zkEmail** instead of a permanent WebID, and a UI
that ditches the LLM "Local SQL" chat for a **deterministic
Query-by-Example** form.

The previous "AI Agent" → "Local SQL" path is gone. There is no model in
the browser anymore.

---

## 1. Mental model

| Layer | Where it runs now | What it stores |
|-------|-------------------|----------------|
| Personal Pod UI (Vite + React) | User's browser | IndexedDB + DuckDB-WASM |
| Solid Pod (CSS) | User's machine, `localhost:3456` | RDF civic data + email-proof, ACL `self` |
| Provision bridge | User's machine, `localhost:3457` | WebAuthn → Pod path map |
| Forum airlock listener | Always-on Linux server, `:3000` | Encrypted civic ledger + hashed email roster |
| `secure-worker` (Cloudflare) | Cloudflare edge, HTTPS | Public ingress only — never sees secrets, raw emails, or PII |

`pod.yourcommunity.forum` is **no longer in the critical path**. It only
matters if you want federated access from another machine or device.

**Identity:** the user is `email_hash` + WebAuthn passkey. The WebID is
local UX only and can churn between sessions.

**Why this works:** the server never reads from the Pod. The Pod is a
private datastore. The only thing the server needs to confirm is that
this submitter holds a verified email — that's the hash check.

---

## 2. New / changed files

### Schema

- `forum-ai/database_syncs/init_schema.sql` — added `members_email_proof`
  table and an index on `domain_hash`. Existing `forum_inbound` columns
  already supported `hashed_email`.

### Cooperative server

- `forum-airlock/listener.js`
  - New: `POST /api/zkemail/verify` — accepts a proof bundle, validates
    public signals shape, optionally loads `./zkemail-verifier.js`,
    writes to `members_email_proof` and appends to
    `forum-ai/database_syncs/members_email_hashes.csv`.
  - New: `GET /api/zkemail/status/:email_hash` — registration check.
  - Changed: `POST /api/civic/export` now rejects with 403 unless
    `payload.email_hash` matches a row in `members_email_proof`
    (and `revoked_at IS NULL`).
- `forum-airlock/secure-worker.js`
  - New routes proxy `/api/zkemail/verify` and
    `/api/zkemail/status/:hash` to the listener over the tunnel.

### Pod app

- `forum-pod/src/email-proof.js` (new)
  - Parses raw `.eml` text the user pastes.
  - `runProver()` is the **single seam** for swapping in real zkEmail
    proving (see Section 4).
  - Posts the proof bundle to `<cooperative>/api/zkemail/verify`.
  - Persists a compact record in `localStorage["forum.emailProof.v1"]`.
- `forum-pod/src/cooperative-export.js`
  - Refuses to export when no local proof exists.
  - Attaches `email_hash` to the signed bundle and the outer envelope.
- `forum-pod/src/pod-ui.jsx`
  - **Removed** the chat-style "Local SQL" tab.
  - **Added** "Query by Example" tab with slot-fill form
    (`buildQbeSql`), result grid, click-to-refine cells.
  - **Added** Email Proof panel in Settings (paste `.eml`, prove,
    verify, view status, clear).
  - `syncSubmission` returns `egress_status="needs_email_proof"` if
    `hasVerifiedEmail()` is false.

### Launcher

- `deploy/forum-pod-launch.sh` (new) — single script that starts CSS,
  provision bridge, and Vite. Tunnel is **opt-in**:
  ```bash
  bash ~/Desktop/deploy/forum-pod-launch.sh           # localhost only
  FORUM_POD_TUNNEL=1 bash ~/Desktop/deploy/forum-pod-launch.sh  # quick tunnel
  ```
  Ctrl+C kills the whole stack. Logs land in `~/Desktop/forum-logs/`.

  After cloning fresh, mark executable:
  ```bash
  chmod +x ~/Desktop/deploy/forum-pod-launch.sh
  ```

---

## 3. Data flow (current state)

```
User opens app  → forum-pod-launch.sh
   ├─ CSS up at http://localhost:3456
   ├─ Provision bridge at :3457
   ├─ Vite at :5173 (default)
   └─ optional Quick Tunnel → ephemeral https://<random>.trycloudflare.com

User signs up via email
   browser parses .eml → email-proof.js → runProver()
   → POST /api/zkemail/verify (via secure-worker)
   → listener inserts members_email_proof + appends members_email_hashes.csv
   → local proof saved to localStorage

User submits civic feedback
   → IndexedDB + DuckDB (always)
   → if opt-in cooperative share AND email proof exists:
        cooperative-export → /api/civic/export (worker → listener)
        listener checks members_email_proof.email_hash → accepts or 403

User explores data
   → Query by Example tab
   → slot-fill → buildQbeSql() → DuckDB
   → click cell → runQbe({ next filter })
```

---

## 4. zkEmail — what is real and what is a stub

The architecture is real and end-to-end. The cryptographic prover is
**stubbed** in `runProver()` to keep the install painless. The stub
generates the same public-signal shape (`email_hash`, `domain_hash`,
`dkim_receipt_hash`, `body_hash`) but doesn't bind them to a ZK proof.
The listener will accept it because no `zkemail-verifier` module is
loaded.

To enable real verification:

1. **Install on the listener side:**
   ```bash
   cd ~/Desktop/forum-airlock
   npm install snarkjs @zk-email/helpers
   ```
2. **Create** `forum-airlock/zkemail-verifier.js` exporting:
   ```js
   exports.verify = async function (bundle) {
     // load verification_key.json
     // call snarkjs.groth16.verify
     // return { ok: true } or { ok: false, reason: "..." }
   };
   ```
3. **Fail closed:** in `forum.config.env` set
   `ZK_EMAIL_REQUIRE_VERIFIER=1` so the listener refuses every proof
   until the verifier module is in place.

4. **Install on the pod side:**
   ```bash
   cd ~/Desktop/forum-pod
   npm install @zk-email/sdk @zk-email/helpers
   ```
5. **Replace** the body of `runProver()` in
   `forum-pod/src/email-proof.js` (the docblock there has the exact
   five-line replacement).
6. Place circuit artifacts in
   `forum-pod/public/zk-email/{email_verifier.wasm,email_verifier_final.zkey,verification_key.json}`.

Until you do step 3, the system is "verified-by-shape" not
"verified-by-circuit." Treat it as integration scaffolding, not
production crypto.

---

## 5. Query-by-Example

Replaces the chat tab. No LLM, no prompt parsing.

| Slot | Source |
|------|--------|
| What | `QBE_SHAPES` array (rows / count_by_zip / count_by_category / timeline / failures) |
| Category | `CIVIC_CATEGORIES` |
| Status | `QBE_STATUSES` including new `needs_email_proof` value |
| ZIP starts with | free text, `LIKE 'NNN%'` |
| Since | YYYY-MM-DD (`submitted_at >= ...`) |
| Limit | 1–500 |

`buildQbeSql()` is the only function that emits SQL. All escaping goes
through `sqlEscape()`. The generated SQL is shown above the result
grid; clicking a result cell calls `refineByCell()` which adds the
matching filter and re-runs. Cells that are not in the refinable set
(`zip_code`, `category_label`, `egress_status`, `submitted_at`, `day`)
stay unclickable.

---

## 6. Verifying the stack locally

```bash
# 1. CSS, bridge, Vite (no tunnel)
bash ~/Desktop/deploy/forum-pod-launch.sh

# 2. Listener (separate terminal)
cd ~/Desktop/forum-airlock
node listener.js

# 3. (optional) confirm endpoints
curl -s http://127.0.0.1:3000/health
curl -s -X POST http://127.0.0.1:3000/api/zkemail/verify \
  -H 'Content-Type: application/json' \
  -d '{"kind":"zk-email-dkim-v1","publicSignals":{"email_hash":"'"$(printf %064d 0)"'"}}'
# expect: { ok:true, ... } if stub mode, or proper rejection if ZK_EMAIL_REQUIRE_VERIFIER=1

# 4. inspect the audit CSV
cat ~/Desktop/forum-ai/database_syncs/members_email_hashes.csv
```

In the browser at `http://localhost:5173`:

1. Settings → paste an `.eml` → "Generate proof and verify" → status
   turns green with `verified` tag.
2. Settings → toggle "Opt-in cooperative share."
3. Civic Feedback tab → submit a row → row appears in IndexedDB; sync
   succeeds because email proof is present.
4. Query by Example tab → leave defaults → Run → row appears. Click
   the ZIP cell → re-runs filtered.

Negative test:

1. Settings → "Clear local proof" → row submitted with opt-in stays
   `needs_email_proof` and the cooperative POST is blocked.

---

## 7. Known gaps to close next

- **No real ZK proof yet.** See Section 4.
- **No Pod-side write of the email proof JSON-LD.** `email-proof.js`
  exports `emailProofJsonLd()` and `emailProofPodResource()` but the UI
  does not yet PUT it. Wire this through `pod-solid-integration.js`
  after the first OIDC login completes — same pattern as
  `writeCivicSubmissionToPod`.
- **Revocation.** `members_email_proof.revoked_at` exists but no
  listener route writes to it.
- **Quick Tunnel + OIDC.** Random hostnames break Solid-OIDC issuer
  binding. Keep tunnel use to "share viewer URL" only; do not run
  OIDC login from a tunnel session unless you accept that every
  reopen creates a new WebID.
- **Worker `wrangler.toml`.** Re-deploy `secure-worker` so the new
  `/api/zkemail/*` proxy routes are live publicly:
  ```bash
  cd ~/Desktop/forum-airlock
  npm run deploy:worker
  ```
- **APK rebuild.** `APP_BUILD` constant in `pod-ui.jsx` still reads
  `1.3-solid-webauthn`. Bump to `1.4-zkemail-qbe` before publishing a
  new APK; the previous `forum-personal-pod-sql-only-v2.apk` filename
  is now misleading and should rotate.

---

## 8. What did not change

- IndexedDB + DuckDB local-first behavior.
- Capacitor 6 / Java 17 Android build path.
- Existing systemd units on the cooperative server.
- The cooperative server's encryption / analysis pipeline.
- `forum-egress` Worker.

If you read handover 2 or 4 for those topics, they are still correct.

---

## 9. File index for next session

| Concern | File |
|---------|------|
| Launch the whole local stack | `deploy/forum-pod-launch.sh` |
| Email proof client | `forum-pod/src/email-proof.js` |
| Email proof server | `forum-airlock/listener.js` (`verifyZkEmailProof`) |
| Audit CSV | `forum-ai/database_syncs/members_email_hashes.csv` (auto-created) |
| Email proof schema | `forum-ai/database_syncs/init_schema.sql` (`members_email_proof`) |
| Worker proxy | `forum-airlock/secure-worker.js` |
| Query-by-Example | `forum-pod/src/pod-ui.jsx` (`buildQbeSql`, QBE tab) |
| Cooperative gating | `forum-pod/src/cooperative-export.js` + `syncSubmission` in `pod-ui.jsx` |
| Insight categories (user-picked) | `forum-pod/src/insight-categories.js` |
| Deterministic extractor (no AI) | `forum-pod/src/insight-extractor.js` |
| Journal / behaviors / traits store | `forum-pod/src/pod-store.js` (`saveRawSubmission`, `saveBehavior`, `savePsychographic`) |
| Journal UI + spreadsheet sources | `forum-pod/src/pod-ui.jsx` (`tab === "journal"`, `qbeSource`) |

---

## 10. Late-day amendment: no-AI behavioral + psychographic pipeline

This iteration replaces the "let the local AI infer everything" idea with
a deterministic, user-led pipeline. **No model runs in the Pod.**

### How a Journal entry is processed

1. User picks a top-level category from `INSIGHT_CATEGORIES`
   (e.g. `Bought something`, `Value or belief`). This is the high-confidence
   classification: written as `source = "user"`, `confidence = 1.0`.
2. The raw text is saved verbatim into `raw_submissions` (the immutable
   staging table). `lexicon_version` is stamped so a future smarter
   extractor can re-run over old entries.
3. The deterministic `extractInsights()` runs the text through curated
   lexicons + regex and emits zero-or-more rows into `behavioral_data`
   and `psychographic_data` with `source = "rule:v1"` and confidence
   bounded by how many lexicon hits fired. Negation-aware sentiment is
   included for psychographic rows.
4. Hashtags the user typed (e.g. `#sustainability`) become extra
   psychographic rows at `source = "user"`, `confidence = 1.0`.
5. Rule-derived rows ship with `reviewed = false` so they show up under
   `My Data → Traits / Behaviors` with a "needs review" indication. The
   user keeps or deletes them. Nothing is ever exported from these tables
   automatically.

### Where to see the data

`My Data` (spreadsheet tab) now has a `SOURCE` chip row at the top:

- `Civic feedback` — existing behavior, unchanged.
- `Journal entries` — `raw_submissions` rows.
- `Behaviors` — `behavioral_data` rows.
- `Traits` — `psychographic_data` rows.

Filter chips for `STATUS` and `CATEGORY` are hidden for non-civic
sources because they don't apply. The free-text search input keeps
working — it searches `raw_text` / `entity+action` / `attribute`
depending on source.

### How to grow the lexicons

Open `forum-pod/src/insight-extractor.js`. Each top-level bucket
(`BEHAVIORAL_VERBS.purchasing.purchased`, `PSYCHOGRAPHIC.value.sustainability`,
etc.) is an array of surface phrases. Add a phrase, bump
`LEXICON_VERSION` (e.g. `"v1"` → `"v2"`), and ship. Old rows with
`lexicon_version < current` are the candidates for a future
**Reprocess all** button (not yet implemented, schema already supports it).

### What is intentionally *not* here yet

- No "Reprocess all raw_submissions" button. Schema supports it; UI
  hook still needs a Settings entry.
- No per-row cooperative opt-in for behaviors / traits. These tables
  are explicitly **local-only**; if you later want to share aggregates,
  build a separate aggregator instead of egressing rows.
- No editing UI for inferred rows. The MVP path is delete-and-resubmit.

### File touch-list this iteration

- `forum-pod/src/insight-categories.js` — **new**, top-level dropdown.
- `forum-pod/src/insight-extractor.js` — **new**, deterministic rules.
- `forum-pod/src/pod-store.js` — bumped to `DB_VERSION = 3`; added
  `raw_submissions`, `behavioral_data`, `psychographic_data` object
  stores with `submission_id` / `category` / `attribute` indexes.
- `forum-pod/src/pod-ui.jsx` — `setupInsightTables`, hydrators,
  Journal tab, `qbeSource` toggle and SQL routing for journal /
  behaviors / traits sources, live preview while typing.

A returning agent should read this section first, then the lexicon file.

---

## 11. Late-day amendment: "Civic Feedback" → "Forum Feedback"

The cooperative-export feature is no longer civic-only. The user wanted
one feedback channel that accepts submissions from any of the nine
INSIGHT_CATEGORIES (purchase, media, civic, social, health, value,
interest, lifestyle, attitude). All four chains — cooperative DB,
airlock listener, edge Worker, and Pod — were rewritten in lockstep.

### Naming map (old → new)

| Layer                | Old                       | New                                                  |
|----------------------|---------------------------|------------------------------------------------------|
| Pod tab              | `Civic Feedback`          | `Forum Feedback`                                     |
| Pod state            | `civicCategory` (INTEGER) | `forumFeedbackCategoryId` (insight category id slug) |
| Pod helper           | `transmitCivicPayload`    | `transmitForumFeedback`                              |
| Wire payload `type`  | `CIVIC_FEEDBACK_V1`       | `FORUM_FEEDBACK_V1`                                  |
| Edge route           | `/api/civic/export`       | `/api/forum/feedback` (old route kept as deprecated alias) |
| Edge receipt route   | `/api/civic/submit`       | `/api/forum/receipt`     (old route kept as deprecated alias) |
| Listener handler     | inline in `/api/civic/export` | `handleForumFeedback` mounted at both routes     |
| Local airlock ledger | `civic_exports`, `civic_payloads` | `forum_exports`, `forum_payloads` (legacy tables retained) |
| Cooperative DB       | `forum_inbound` (only)    | `forum_feedback` for v1.5+ rows; `v_forum_feedback_all` view UNIONs old + new |

The legacy paths still work (deprecation header is set in the Worker
response). Remove the aliases once telemetry confirms no callers.

### Schema diff

`forum-ai/database_syncs/init_schema.sql` adds `forum_feedback` with:

- `kind`         — `behavioral` | `psychographic` | `civic`
- `category_code`— granular slug matching INSIGHT_CATEGORIES (`purchasing`,
                   `value`, …), or `civic-legacy` for pre-v1.5 rows
- `email_hash` REQUIRED with FK to `members_email_proof.email_hash`
- `signature_hex`, `public_key_hex`, `encrypted_blob` for end-to-end audit
- `v_forum_feedback_all` view UNIONs `forum_feedback` with legacy
  `forum_inbound` rows where `consent_opt_in = 1`

`forum-airlock/schema.sql` adds `forum_payloads` and `forum_exports`,
plus `v_all_exports` view UNIONing legacy `civic_exports`.

`forum-pod/src/pod-ui.jsx` keeps the IndexedDB store named
`civic_submissions` for data continuity but extends the DuckDB CREATE
TABLE with `kind VARCHAR` and `category_code VARCHAR` (both nullable).
`zip_code` is now nullable as well — only civic-act submissions
require a ZIP. A `forum_submissions` view is created as a friendly
alias for v1.5+ queries.

### How a submission flows now

1. User opens **Forum Feedback** tab and picks one of nine categories
   (grouped behavioral vs psychographic in the `<optgroup>`).
2. ZIP is required only when category is `civic`; otherwise optional.
3. Submit builds a `FORUM_FEEDBACK_V1` payload with `kind`,
   `category_code`, `category_label`, optional `zip_code`, and the
   verified `email_hash` from the local zkEmail proof.
4. `postForumFeedback` (alias `postCooperativeExport`) signs the bundle
   and `POST`s to `/api/forum/feedback`.
5. Worker proxies to listener `/api/forum/feedback`. Listener:
   - verifies the WebAuthn signature
   - re-verifies the `email_hash` is registered in `members_email_proof`
   - rate-limits per WebID
   - writes to `forum_payloads` + `forum_exports`
   - upserts the cooperative row into `forum_feedback`
   - runs the vault encryption + optional analysis trigger

### File touch-list this iteration

- `forum-ai/database_syncs/init_schema.sql` — new `forum_feedback`
  table + `v_forum_feedback_all` view.
- `forum-airlock/schema.sql` — new `forum_payloads`, `forum_exports`,
  and `v_all_exports`.
- `forum-airlock/listener.js` — `FORUM_FEEDBACK_TAXONOMY`,
  `normaliseFeedback`, `handleForumFeedback`; routes `/api/forum/feedback`
  (canonical) and `/api/civic/export` (deprecated alias). Also added
  `/api/forum/receipt`.
- `forum-airlock/secure-worker.js` — proxies `/api/forum/feedback` and
  `/api/forum/receipt`; keeps legacy `/api/civic/*` proxies with
  `Deprecation: true` headers.
- `forum-airlock/wrangler.toml` — routing comments updated.
- `forum-pod/src/cooperative-export.js` — `buildForumFeedbackPayload`,
  `postForumFeedback`; old names re-exported as aliases.
- `forum-pod/src/pod-ui.jsx` — tab rename, `INSIGHT_CATEGORIES`
  dropdown grouped by kind, optional ZIP, `category_code` filtering
  in `buildQbeSql`, CATEGORY chip strip uses the nine insight buckets.
- `forum-pod/src/pod-ui-sync.js` — `recordCivicLocally` writes `kind`
  and `category_code` columns.

### File index addendum

| Concern | File |
|---------|------|
| Forum Feedback wire format | `forum-pod/src/cooperative-export.js` (`FORUM_FEEDBACK_V1`) |
| Forum Feedback route (edge) | `forum-airlock/secure-worker.js` (`/api/forum/feedback`) |
| Forum Feedback route (listener) | `forum-airlock/listener.js` (`handleForumFeedback`) |
| Cooperative DB ledger | `forum-ai/database_syncs/init_schema.sql` (`forum_feedback`) |
| Local airlock ledger | `forum-airlock/schema.sql` (`forum_payloads`, `forum_exports`) |
