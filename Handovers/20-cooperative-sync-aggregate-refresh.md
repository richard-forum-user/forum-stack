# Handover 20 — Cooperative sync + aggregate report refresh

Prior: [19-airlock-local-first-webapp.md](19-airlock-local-first-webapp.md).

Deployed 2026-05-29.

**Field confirmation:** three backlogged submissions that had been stuck at
"synced locally" finally transmitted to the cooperative after these fixes.
Aggregate report now reflects all nine ledger rows (was six in the stale
snapshot).

User report that triggered this handover:

> I'm showing synced and submitted but nothing added when I view aggregated report

---

## 1. Two separate bugs

### Bug A — Sync rejected at cooperative (`401 auth_failed`)

**Symptom:** PWA showed submissions as saved locally; retry/sync appeared to
succeed in UI but rows never landed in D1 (or landed only before a regression).

**Cause:** H11 `assertUnlocked()` required a WebAuthn unlock token for every
signed bundle. Browser-local Pods use `local-*` credentials with Ed25519 signing
only — no passkey, no unlock token.

**Fix:** `isLocalDeviceCredentialId()` in `unlock-token.js`; `assertUnlocked()`
accepts `local-*` and `recovered-*` credentials when `UNLOCK_TOKEN_KEY` is set.

Client side: `createLocalPodFlow()` registers the device signing key with
`POST /api/register-signing-key` on the cooperative; sync uses
`resolveCoopUrl() || cooperativeBaseUrl()` so the coop URL is never dropped when
Settings stores the airlock host.

### Bug B — Aggregate report stale after successful ingest

**Symptom:** Ledger (`GET /api/civic/analysis/ledger`) showed **9** rows; cached
report (`GET /api/civic/analysis`) still reflected **6** submissions from an
older cron snapshot (`2026-05-29T18:00:41Z`).

**Cause:** `FORUM_AUTO_EDGE_ANALYSIS` was unset/`0`. Ingest wrote to
`forum_feedback` but did not re-run `runCivicAnalysis()`. The UI only fetched
the last published snapshot in `civic_analysis_reports`.

**Fix (cooperative worker):**

1. `wrangler.toml`: `FORUM_AUTO_EDGE_ANALYSIS = "1"`.
2. `secure-worker.js`: after successful feedback ingest, `ctx.waitUntil(
   runCivicAnalysis(env, { trigger: 'feedback', publish: true }) )`.
3. `civic-analysis.js`: on `GET /api/civic/analysis`, if
   `ledger.total > snapshotCount`, auto-regenerate with
   `trigger: 'get_refresh'` before returning.

**Fix (airlock PWA):**

- `loadCooperativeReport()` uses `resolveCoopUrl() || cooperativeBaseUrl()`.
- After successful cooperative sync, auto-calls `loadCooperativeReport()`.

---

## 2. Files changed

### `forum-stack/forum-airlock`

| File | Change |
|------|--------|
| `unlock-token.js` | `isLocalDeviceCredentialId()` for `local-*` / `recovered-*`. |
| `secure-worker.js` | `assertUnlocked` bypass for local credentials; post-ingest analysis via `waitUntil`. |
| `civic-analysis.js` | GET analysis stale-check → `get_refresh` regeneration. |
| `wrangler.toml` | `FORUM_AUTO_EDGE_ANALYSIS = "1"`. |

### `forum-pod-solo/forum-pod`

| File | Change |
|------|--------|
| `pod-ui.jsx` | `resolveCoopUrl()`; post-sync report refresh; aggregate section copy. |
| `pod-solid-integration.js` | Cooperative signing-key registration in `createLocalPodFlow()`. |
| `cooperative-export.js` | Uses bound `sessionId` from signing meta (unchanged wire shape). |

---

## 3. Verification (recorded 2026-05-29)

```bash
# Live ledger count:
curl -sS "https://coop.yourcommunity.forum/api/civic/analysis/ledger" \
  | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).total))"

# Cached report (auto-refreshes if ledger ahead):
curl -sS "https://coop.yourcommunity.forum/api/civic/analysis" \
  | node -e "let b='';process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>{const j=JSON.parse(b);console.log(j.metadata);});"
```

Expected after fix:

```json
{ "volume": 9, "opt_in": 9, "trigger": "get_refresh", "status": "published" }
```

Ledger total and report `volume` / `opt_in_count` must match.

---

## 4. Aggregate refresh triggers (after this handover)

| Trigger | When |
|---------|------|
| `feedback` | Each successful `POST /api/forum/feedback` (when `FORUM_AUTO_EDGE_ANALYSIS=1`) |
| `get_refresh` | `GET /api/civic/analysis` when ledger count > snapshot count |
| `scheduled` | Cron `0 */6 * * *` on coop worker (unchanged) |
| `api` | Manual `POST /api/civic/analysis/run` with `X-Airlock-Secret` |

Public egress copy still pushed to `forum-egress` on publish (unchanged from H15).

---

## 5. Deploy

```bash
# Cooperative (required for both sync auth + aggregate refresh):
cd ~/Desktop/forum-stack/forum-airlock
npx wrangler deploy

# Airlock PWA (post-sync report refresh + coop URL resolution):
cd ~/Desktop/forum-pod-solo/forum-airlock
npm run build:pod && npx wrangler deploy
```

Worker versions at deploy time:

| Worker | Host | Version ID |
|--------|------|------------|
| `coop-pipeline` | `coop.yourcommunity.forum` | `a0616132-0a6d-4fd1-b52f-2a22f7d6bc18` |
| `secure-worker` | `airlock.yourcommunity.forum` | `6c9e612e-35c3-429a-96c9-02a407e65c67` |

---

## 6. Operator checklist when "synced but report empty"

1. **Ledger first:** `GET /api/civic/analysis/ledger` — are rows present?
   - If **no**: sync/auth problem (check browser network tab for
     `401` on `/api/forum/feedback`; confirm cooperative share enabled in
     Settings; confirm `local-*` credential accepted — redeploy coop if not).
   - If **yes**: report staleness (should self-heal on next GET after H20;
     or wait for ingest-triggered refresh on next submission).

2. **Compare counts:** `ledger.total` vs `metadata.volume` on
   `/api/civic/analysis`.

3. **Force refresh:** open aggregate report in PWA (triggers GET →
   `get_refresh`) or `POST /api/civic/analysis/run` with secret.

4. **Client cache:** hard refresh airlock; clear site data if service worker
   still on pre-v4 bundle.

---

## 7. Mental model (post-fix)

```
IndexedDB submission (share=on)
    │
    ▼
POST coop…/api/forum/feedback  (local-* cred, Ed25519 signed)
    │
    ├► assertUnlocked → OK for local-*
    ├► D1 forum_feedback += 1
    ├► forum_deletion_receipts += 1
    ├► RecoveryDO append (if enrolled)
    └► waitUntil runCivicAnalysis(trigger: feedback)
              │
              ▼
        civic_analysis_reports (published)
              │
              ▼
        forum-egress KV (public aggregate)

GET /api/civic/analysis
    └► if ledger.total > snapshot → get_refresh → return fresh report
```

---

## 8. Known follow-ups

| Item | Notes |
|------|-------|
| Backlog drain UX | Three queued rows flushed after auth fix; no explicit "retry all pending" button yet — user can re-open app or submit again. |
| R2 Iceberg aggregate lake | From local-ownership plan — aggregates still D1 + egress KV only. |
| `APP_BUILD` bump | Tag a release once airlock + coop paths are stable in the field. |
| Contest / wipe visibility | Settings shows deletion receipts; broader "cloud is ephemeral" banner called out in H19 follow-ups. |
