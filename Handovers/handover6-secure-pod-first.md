# Handover 6 — Secure Pod-first, sign-in gate

**Date:** 2026-05-21
**Build target:** `1.5-secure-pod`
**Prior:** [handover5-zkemail-qbe.md](handover5-zkemail-qbe.md)

This handover documents the architecture flip from "local-first with
optional Pod sync" to **Pod-first, sign-in-required**. The app no
longer boots into a usable state without a live Solid Pod session.
IndexedDB and DuckDB are now session-scoped caches that hydrate from
the Pod on sign-in and are wiped on sign-out.

> The bug from H5 ("journal saves don't appear in My Data") was a stale
> `runQbe` callback (missing `qbeSource` dep) and is fixed by the same
> commit that introduces this architecture. The tab structure was also
> split: **Journal**, **Forum Submissions**, **Forum Feedback**,
> **Import**, **Settings**. Journal data and forum submissions are
> now distinct surfaces, not a shared spreadsheet.

---

## 1. Mental model

```
Boot → resolve OIDC redirect → check session
  └─ not signed in  → full-screen <SignInOverlay/>   (tabs/sidebar hidden)
  └─ signed in      → init DuckDB session cache
                    → hydrate civic + journal + behaviors + traits + email proof
                      from the Pod into IndexedDB and DuckDB
                    → main app

Every save:
  1. Write to the Pod (JSON-LD over fetchWithAuth). On failure, abort.
     Nothing is mirrored locally if the Pod write does not succeed.
  2. Mirror to IndexedDB.
  3. Mirror to DuckDB.

Sign out:
  1. Close DuckDB connection + terminate worker.
  2. clearAllPodData() drops every IndexedDB object store.
  3. Clear local proof, member profile, and Solid session metadata.
  4. solidLogout() (OIDC logout).
  5. authState → "signed_out", overlay returns.
```

The Pod is the source of truth. **No Pod, no app.** This is intentional.

---

## 2. New / changed files

### Pod app — auth and overlay

- `forum-pod/src/sign-in-overlay.jsx` (**new**)
  - Full-screen modal. Two buttons:
    - **Create a new Pod** → `createPodFlow({ podProviderUrl, cooperativeUrl })`
      (WebAuthn register → provision → OIDC).
    - **Sign in to existing Pod** → if `loadMemberProfile()?.credential_id`
      exists, `authenticateDevice()` then `unlockPodFlow()`; otherwise
      `solidLogin(webId)` with a hint to use Create Pod on a new device.
  - Pod provider URL hidden behind an **Advanced** disclosure. Default
    is `DEFAULT_POD_PROVIDER` (`http://localhost:3456`); persists to
    `localStorage["forum.podProviderUrl"]`.
- `forum-pod/src/pod-ui.jsx`
  - `authState`: `checking | signed_out | signed_in`.
  - Boot effect always runs `handleSolidRedirect()` first, then reads
    `getSolidSession().isLoggedIn`.
  - DuckDB init, civic/insight table setup, schema fetch, and Pod
    hydration are gated behind `authState === "signed_in"`.
  - Renders `<SignInOverlay/>` when signed out. Main tab bar, schema
    sidebar, and forms are not mounted until signed in.
  - **Sign out** button in Settings (replaces inline "Create Pod / Sign
    in" controls).
  - Email-verify flow now writes the proof to the Pod (`writeEmailProofToPod`)
    after the cooperative accepts it.

### Pod data layer

- `forum-pod/src/civic-vocab.js`
  - Added JSON-LD mappers and resource URL builders for journal entries,
    behaviors, traits, and email proof. Vocabulary uses the existing
    `forum:` prefix and `dct:` for identifiers and timestamps.
  - URL layout:
    ```
    {podRoot}/civic/submissions/{receipt_id}.jsonld     (civic feedback)
    {podRoot}/journal/raw/{submission_id}.jsonld        (journal entries)
    {podRoot}/journal/behaviors/{behavior_id}.jsonld    (behavior rows)
    {podRoot}/journal/traits/{psycho_id}.jsonld         (trait rows)
    {podRoot}/identity/email-proof.jsonld               (zkEmail proof record)
    ```
- `forum-pod/src/solid-pod-write.js`
  - `writeCivicSubmissionToPod(row)` — existing path. Now **throws** on
    failure (no silent queueing).
  - `writeJournalEntryToPod(row)` — ensures `journal/` and `journal/raw/`,
    PUTs JSON-LD.
  - `writeBehaviorToPod(row)` — ensures `journal/behaviors/`.
  - `writeTraitToPod(row)` — ensures `journal/traits/`.
  - `writeEmailProofToPod(record)` — ensures `identity/`.
  - All four use `fetchWithAuth()`, require an active Solid session
    plus a `podRoot` in the member profile, and return `{ ok: true, url }`.
- `forum-pod/src/solid-sync.js`
  - `listPodResourceUrls(containerUrl)` — generalized container listing.
  - `syncJournalEntriesFromPod(connection, recordFn)`,
    `syncBehaviorsFromPod(...)`, `syncTraitsFromPod(...)`,
    `syncEmailProofFromPod()` — hydrate session cache after sign-in.
- `forum-pod/src/pod-store.js`
  - `clearAllPodData()` drops every IndexedDB object store
    (`civic_submissions`, `raw_submissions`, `behavioral_data`,
    `psychographic_data`) and resets the cached connection.
  - `pending_pod_sync` removed from the retry status filter — Pod
    writes are now blocking, not deferred.
- `forum-pod/src/pod-solid-integration.js`
  - Re-exports the new write/sync helpers so `pod-ui.jsx` has a single
    import surface.

### Legacy removal

- `forum-pod/src/solid-session.js` — `isSolidEnabled()` always returns
  `true`. The `VITE_SOLID_ENABLED` env override is gone.
- `forum-pod/.env` — `VITE_SOLID_ENABLED` line removed.
- `forum-pod/.env.example` — documents that Solid is required;
  `VITE_POD_PROVIDER_URL` is the only Pod-related variable.
- `forum-pod/src/pod-ui.jsx` — removed the `!SOLID_ON` branch
  (legacy `/api/civic/submit` POST), the online retry hook, the
  retry button, and the inline `syncNotice` panel. `pending_pod_sync`
  is no longer in `QBE_STATUSES`.

### Cooperative listener / launcher (carried over from earlier in-day work)

- `forum-airlock/listener.js` — CORS middleware for `localhost:5173`,
  graceful EADDRINUSE exit.
- `deploy/forum-pod-launch.sh` — probes the running listener for CORS
  and recycles it if missing. `[1/4]` label corrected.
- `forum-pod/src/email-proof.js` — clearer error when the Cooperative
  URL points at the wrong server (HTML 404 instead of JSON).

---

## 3. Data flow

```
App boot
  └─ handleSolidRedirect()           (consumes ?code/?state from OIDC)
  └─ getSolidSession().isLoggedIn
       ├─ false → <SignInOverlay/>
       │           ├─ Create new Pod  → WebAuthn register
       │           │                  → provision-bridge (:3457)
       │           │                  → CSS OIDC login
       │           └─ Sign in existing → WebAuthn assert
       │                                → CSS OIDC login
       └─ true  → initDuckDb()
                → setupCivicTables() + setupInsightTables()
                → hydrateFromPod(connection):
                    clearAllPodData()
                    syncPodToDuckDB        (civic submissions)
                    syncJournalEntriesFromPod
                    syncBehaviorsFromPod
                    syncTraitsFromPod
                    syncEmailProofFromPod  (rehydrates localStorage proof)
                → main app mounts

Journal save (submitJournalEntry)
  → writeJournalEntryToPod(rawRow)
  → for each user-declared / hashtag / inferred row:
       writeBehaviorToPod(...) or writeTraitToPod(...)
  → saveRawSubmission + recordRawSubmissionLocally
  → saveBehavior + recordBehaviorLocally
  → savePsychographic + recordPsychographicLocally
  → refreshJournalTotals
  (any Pod write throws → status flips red, nothing mirrored)

Forum Feedback save (transmitForumFeedback)
  → writeCivicSubmissionToPod(localRow)
  → saveSubmission + recordCivicLocally
  → syncSubmission(localRow, conn)        (cooperative export, if opt-in)

Email proof (Settings → Verify a personal email)
  → buildEmailProofFromEml(emlInput)
  → submitProofToCooperative(bundle, serverUrl)
  → writeEmailProofToPod(record)
  → saveLocalProof(bundle)                (localStorage cache)

Sign out (Settings → Sign out)
  → conn.close() + db.terminate()
  → clearAllPodData()
  → clearLocalProof() + clearMemberProfile() + clearSolidSessionMeta()
  → solidLogout()
  → setAuthState("signed_out")
```

---

## 4. URLs and ports (unchanged from H5, restated for clarity)

| Service | URL | Used for |
|---------|-----|----------|
| Vite (Pod app) | `http://localhost:5173` | Browser entry point |
| Community Solid Server | `http://localhost:3456` | **Pod provider URL** — Solid OIDC + RDF host |
| Provision bridge | `http://127.0.0.1:3457` | WebAuthn → Pod path map (Create Pod only) |
| Airlock listener | `http://localhost:3000` | **Cooperative URL** — `/api/zkemail/verify`, forum feedback export |

The two URLs in Settings are **not interchangeable**:

- **Cooperative URL** = `http://localhost:3000`. Used by zkEmail verify
  and forum feedback export. Has nothing to do with Solid.
- **Pod provider URL** = `http://localhost:3456`. Used only when
  creating or unlocking a Pod.

---

## 5. Verifying the stack

```bash
# Launch everything
bash ~/Desktop/deploy/forum-pod-launch.sh

# In a separate terminal (if not already running)
cd ~/Desktop/forum-airlock && node listener.js
```

Browser at `http://localhost:5173`:

1. Open with a clean profile (or clear `localStorage` + IndexedDB).
   The sign-in overlay should appear; tabs and sidebar are not
   rendered.
2. Click **Create a new Pod**. Complete WebAuthn. CSS OIDC redirect
   returns signed-in.
3. After return, confirm:
   - Schema sidebar shows `civic_submissions`, `raw_submissions`,
     `behavioral_data`, `psychographic_data` (and views).
   - All tables have **0 rows** on a fresh Pod.
4. Submit a journal entry. Confirm:
   - DevTools → Network → `PUT` to
     `http://localhost:3456/<webid>/journal/raw/{id}.jsonld` (201).
   - Behaviors/traits also PUT under `journal/behaviors/` and
     `journal/traits/`.
   - Journal tab → **Journal Data** section shows the new row.
5. Submit a Forum Feedback row. Confirm:
   - `PUT` to `…/civic/submissions/{receipt}.jsonld`.
   - Row appears in **Forum Submissions** tab.
6. Click **Sign out** in Settings. Verify:
   - IndexedDB stores empty (DevTools → Application → IndexedDB →
     `forum-personal-pod`).
   - Schema sidebar gone.
   - Sign-in overlay returns.
7. Sign back in. Previously written rows hydrate back from the Pod
   into DuckDB and IndexedDB.

Negative tests:

- Stop CSS (`Ctrl+C` on `forum-pod-launch.sh`) and try to submit a
  journal entry. Save should fail with a clear error; no IndexedDB
  rows should be created. Restart CSS and the same payload succeeds.

---

## 6. Risks and known gaps

- **Offline use is gone.** If CSS is unreachable, the user cannot
  read or write. This is explicit per the design choice.
- **Pod latency is in the critical path** of every save. Fine on
  localhost; remote Pod hosts will feel slower.
- **No migration of pre-existing IndexedDB rows.** If you had data
  from `1.4-spreadsheet`, it will not appear after the upgrade — the
  new boot path always hydrates from the Pod, then wipes the local
  cache on sign-out. If a one-time uploader is wanted, see Phase 10
  note below.
- **WebAuthn credential is per-device.** Signing in on a second device
  currently requires another **Create Pod** flow with a new credential
  pointing at the same WebID. `provisionPodPaths` does not yet support
  this; out of scope for 1.5.
- **zkEmail prover is still a stub** (carried from H5). The
  cooperative side accepts it by shape until `zkemail-verifier.js`
  is wired in.

---

## 7. Suggested follow-ups (not in 1.5)

1. **Phase 10 migration** — on first sign-in detect existing IndexedDB
   rows and upload them to the Pod before `clearAllPodData()` runs.
2. **Multi-device WebAuthn** — extend the provision bridge to register
   additional credentials against an existing WebID.
3. **Sync indicator** — small badge in the header showing
   "Pod connected / Pod disconnected" so users know when a save will
   fail before they try it.
4. **Selective hydration** — current `hydrateFromPod` fetches every
   resource on every sign-in. Add an `If-None-Match`/ETag cache once
   row counts grow.
5. **Real zkEmail proving** — finish the swap from `runProver()` stub
   to `@zk-email/sdk` (steps in H5 §4 are still accurate).

---

## 8. File pointers (quick reference)

| Concern | File |
|---------|------|
| Sign-in overlay | `forum-pod/src/sign-in-overlay.jsx` |
| Auth gate + boot effect | `forum-pod/src/pod-ui.jsx` (`authState`, top-level `useEffect`s) |
| Pod write helpers | `forum-pod/src/solid-pod-write.js` |
| Pod read / hydration | `forum-pod/src/solid-sync.js` |
| JSON-LD vocab + URL builders | `forum-pod/src/civic-vocab.js` |
| Session cache wipe | `forum-pod/src/pod-store.js` (`clearAllPodData`) |
| Re-export surface | `forum-pod/src/pod-solid-integration.js` |
| Env example | `forum-pod/.env.example` |
| Launcher (CORS recycle) | `deploy/forum-pod-launch.sh` |
| Listener (CORS, EADDRINUSE) | `forum-airlock/listener.js` |
