# Handover 8 — Personal Pod on Cloudflare Durable Objects

**Date:** 2026-05-22
**Build target:** `secure-pod-v1.6-do`
**Prior:** [handover7-lint-build-clean.md](handover7-lint-build-clean.md)
**Architecture status:** **breaking change** — Solid/CSS Pod replaced by a
per-device Cloudflare Durable Object addressed by the device key. Public
contract for callers of `solid-pod-write.js` / `solid-sync.js` is
unchanged; everything under those file names was rewritten.

---

## 1. Why the pivot happened

Phone testing against the H6/H7 stack failed three different ways during
a single afternoon, all rooted in the same problem: the Pod required
four cooperating services (`forum-solid` CSS, `forum-provision-bridge`,
`secure-worker`, `forum-backend` listener) plus an OIDC redirect that
behaves differently on every WebView. Concretely:

- The Capacitor APK origin is `https://localhost`. The Solid-OIDC issuer
  is `https://pod.yourcommunity.forum`. The redirect handoff from one to
  the other never round-tripped reliably in the Android WebView and
  showed up as a "Create a new Pod button does nothing" hang.
- WebAuthn `rp.id` had to match the Pod hostname even though the user
  was on a different origin, producing the well-known "relying party ID
  is not a registrable domain suffix" error.
- The provision bridge and CSS issuer each had to be reachable via
  Cloudflare Tunnel at distinct subdomains. Any of them being down
  silently broke pod creation with no UI status.

The Cloudflare Worker that already serves the PWA + cooperative routes
runs on the same network the user has full control over. Per-user state
fits cleanly into a Durable Object instance keyed by the device's
WebAuthn / Ed25519 credential. So the Pod was collapsed onto the
existing Worker, and CSS + provision bridge are gone.

---

## 2. Current architecture

```text
device (browser or Capacitor APK)
  │  signBundle({verb, path, data}, sessionId) — Ed25519
  ▼
Cloudflare Worker  secure-worker.forum-community.workers.dev
  │  /api/pod/*   -> env.POD.idFromName(sessionId).fetch(bundle)
  │  /api/forum/* -> listener.yourcommunity.forum (unchanged)
  │  /api/zkemail/* -> listener (unchanged)
  ▼
Durable Object  PersonalPodDO  (SQLite-backed, one per sessionId)
  │  pod_meta, civic_submissions, journal_entries, behaviors, traits, email_proof
  ▼
TOFU-registered Ed25519 public key validates every subsequent request.
```

What runs on the box now:

| Service | Status | Purpose |
|---|---|---|
| `forum-backend.service` (listener) | **keep** | `/api/register-member`, `/api/register-signing-key`, `/api/forum/feedback`, `/api/zkemail/verify`, analysis pipeline, vault. |
| `forum-apk-download.service` | **keep** | Hosts the public APK at `apk.yourcommunity.forum`. |
| `cloudflared` | **keep** | Tunnels `listener.yourcommunity.forum`, `apk.yourcommunity.forum`, and `airlock.yourcommunity.forum/pod*`. |
| `forum-solid.service` (Community Solid Server) | **disable** | Replaced by `PersonalPodDO`. |
| `forum-provision-bridge.service` | **disable** | Slug/webId derivation is now local in `webauthn-member.js`. |

The `pod.yourcommunity.forum` and `pod-provision.yourcommunity.forum`
DNS routes in `/etc/cloudflared/config.yml` can be deleted or left in
place (harmless once nothing on the device hits them).

---

## 3. Files added / rewritten / removed

### Added

- `forum-airlock/pod-do.js` — `PersonalPodDO` class. SQLite tables for
  `civic_submissions`, `journal_entries`, `behaviors`, `traits`,
  `email_proof`, plus a `pod_meta` table that holds the TOFU public
  key. Dispatch is on `payload.verb` + `payload.path`. The DO never
  trusts the network: every request goes through
  `verifySignedBundle` from `pod-signing-web.js` before any storage
  mutation.
- `forum-airlock/pod-signing-web.js` — Web Crypto port of
  `pod-signing.js`. Imports SPKI-wrapped Ed25519 keys and verifies
  Groth-canonical signed bundles inside the Worker/DO runtime.

### Rewritten (file names kept so consumers don't churn)

- `forum-pod/src/solid-session.js` — `@inrupt/solid-client-authn-browser`
  removed entirely. Exposes:
  - `getPodProviderUrl()` — **always prefers `VITE_SERVER_URL`** and
    refuses `localStorage` overrides that don't share a host with it.
    This is why stale `forum.podProviderUrl=https://pod.yourcommunity.forum`
    from older builds can't poison new installs.
  - `solidLogin(webId)` — synchronous, just stamps session meta. No
    redirect, no browser handoff.
  - `handleSolidRedirect()` — no-op, kept so `pod-ui.jsx` boot does not
    crash.
  - `podRpc(verb, path, data)` — the new transport. Signs the payload
    with `signBundle`, POSTs to `${getPodProviderUrl()}/api/pod${path}`,
    wraps fetch errors with the exact URL it tried (so future "Failed
    to fetch" surfaces immediately tell you which host failed).
  - `fetchWithAuth(url, init)` — shim that translates Solid-style HTTP
    calls into `podRpc`. Used only by any remaining straggler imports.
- `forum-pod/src/solid-pod-write.js` — every `writeXToPod(row)` is now
  `podRpc("PUT", "/<table>/<id>", row)`.
- `forum-pod/src/solid-sync.js` — every `syncXFromPod` is now
  `podRpc("LIST", "/<table>")`. `listPodResourceUrls` is a back-compat
  empty stub.

### Modified

- `forum-pod/src/webauthn-member.js`
  - `rpFromPodProvider()` now uses `window.location.hostname`. Deriving
    the RP ID from the Pod URL was wrong: the Pod and the page can sit
    on different Cloudflare hosts, which trips the "registrable suffix"
    SecurityError.
  - The pilot fallback (`pilot-${randomCredentialId()}`) now fires on
    **any** WebAuthn failure, not just Capacitor / localhost. For a
    pilot we never want a stuck "Create Pod" button. Production should
    re-introduce the `isNativePilotShell()` gate before requiring real
    passkeys.
  - `provisionPodPaths` no longer makes a network call. It computes
    `slug`, `webId`, `podRoot` locally from `credential_id` — these are
    cosmetic strings for the UI; the DO is addressed by `sessionId`.
- `forum-pod/src/pod-solid-integration.js` — `createPodFlow`:
  1. `registerDevice` (or pilot fallback)
  2. `registerWithCooperative` → `POST /api/register-member`
  3. `provisionPodPaths` (local)
  4. `ensurePodSigningKey(sessionId)` — Web Crypto Ed25519 keypair,
     cached in localStorage under `forum.podSigning`.
  5. `POST /api/register-signing-key` (best-effort, swallowed on error)
  6. `solidLogin(webId)` — sets `forum.solidSession`.
  7. `podRpc("PROVISION", "/", { webId, podRoot })` — TOFU-registers
     the public key in the DO. **This is the first network call that
     proves the Pod is reachable**, so its error wrapper says
     `Pod provider unreachable: ...` to make diagnosis obvious.
- `forum-pod/src/sign-in-overlay.jsx`
  - Drops the "Complete sign-in in the Pod provider window" UX.
  - Status text: `Starting Pod creation...` → `Creating device
    credential...` → `Signed in. Loading your Pod...`.
  - Advanced section now shows `Next request will hit: <URL>/api/pod`
    so the URL the next attempt will hit is visible without DevTools.
  - **Clear local Pod state** button calls `clearMemberProfile()`
    (which drops `forum.member` + `forum.podSigning`) and removes
    `forum.solidSession` + `forum.podProviderUrl`. Use this whenever a
    test phone shows mysterious key-mismatch behavior — it scrubs
    stale localStorage without forcing a Chrome "Clear site data".
- `forum-airlock/wrangler.toml` — adds
  ```toml
  [[durable_objects.bindings]]
  name = "POD"
  class_name = "PersonalPodDO"

  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["PersonalPodDO"]
  ```
  Requires the **paid Workers plan**. Free-tier accounts will see the
  binding silently fail on deploy and every `/api/pod/*` call will
  return `{"error":"pod_do_not_bound"}`.
- `forum-airlock/secure-worker.js`
  - `export { PersonalPodDO } from './pod-do.js'` so wrangler can find
    the class.
  - `/api/pod/*` route: validates the bundle has a `sessionId`, then
    forwards the raw body to `env.POD.idFromName(sessionId).fetch(...)`.
  - `/api/register-member` and `/api/register-signing-key` now proxy
    to the listener (same shape as `/api/forum/feedback`). Before this
    fix the Pod app POSTed to these paths, the Worker had no handler,
    the catch-all returned 404 with no CORS, the browser surfaced the
    response as `TypeError: Failed to fetch`, and `wrangler tail`
    showed "Ok" because the Worker handler didn't throw. That was the
    cause of "Failed to fetch" with no `/api/pod` line in tail.
  - The fallback 404 now returns
    `{"error":"route_not_found","path":"...","method":"..."}` with
    CORS headers. Future routing typos surface as real 404s, not
    network errors.
- `forum-pod/.env` and `.env.example` — dropped `VITE_OIDC_*` and
  `VITE_PROVISION_BRIDGE_URL`. `VITE_SERVER_URL` and
  `VITE_POD_PROVIDER_URL` both point at the Worker base.
- `forum-pod/package.json` — `@inrupt/solid-client-authn-browser`
  removed.
- `deploy/go-live-checklist.md` — rewritten end-to-end for the DO
  path. Section numbers no longer match H6/H7 — the old `Install CSS`,
  `Run provision bridge`, `Configure pod.* / pod-provision.* tunnel
  ingress` steps are gone.

---

## 4. Wire format

Every Pod RPC from device to Worker:

```json
{
  "payload": { "verb": "PUT", "path": "/civic/submissions/abc", "data": { ... } },
  "sessionId": "https://secure-worker.../forum-members/<slug>/profile/card#me",
  "timestamp": "2026-05-22T20:09:42.123Z",
  "signature": "<hex Ed25519 sig over canonicalise({payload,sessionId,timestamp})>",
  "publicKeyHex": "<32-byte hex>"
}
```

Recognised verbs: `PUT`, `LIST`, `GET`, `PROVISION`.

Recognised paths:

| verb | path | semantics |
|---|---|---|
| `PROVISION` | `/` | TOFU-register pub key, optionally accept cosmetic `{webId,podRoot}`. |
| `PUT` | `/civic/submissions/{id}` | upsert civic submission row. |
| `LIST` | `/civic/submissions` | return `{rows:[...]}`. |
| `PUT` | `/journal/raw/{id}` | upsert journal entry. |
| `LIST` | `/journal/raw` | list journal entries. |
| `PUT` | `/journal/behaviors/{id}` | upsert behavior. |
| `LIST` | `/journal/behaviors` | list behaviors. |
| `PUT` | `/journal/traits/{id}` | upsert trait. |
| `LIST` | `/journal/traits` | list traits. |
| `PUT` | `/identity/email-proof` | single-row upsert. |
| `GET` | `/identity/email-proof` | return the single row or `null`. |

Replay window: 5 minutes (`maxAgeMs`), enforced by
`verifySignedBundle`. Future skew tolerance: 30 s. There is currently
**no replay cache in the DO** — the timestamp window is the only
defense. Per-`(sessionId,timestamp)` dedupe in `pod_meta` is a known
gap (see §7).

---

## 5. Operational state at end of session

### Deployed to Cloudflare

- Worker `secure-worker` at version `2018c1a1-23f6-4e00-81e0-574b264db070`,
  with `POD: PersonalPodDO` binding confirmed and SQLite migration `v1`
  applied. Smoke test:

  ```bash
  curl -s -X POST https://secure-worker.forum-community.workers.dev/api/pod/ping \
    -H "Content-Type: application/json" \
    -d '{"sessionId":"smoke","payload":{},"timestamp":"2026-05-22T20:00:00Z","signature":"00","publicKeyHex":"00"}'
  # -> {"error":"auth_failed","reason":"timestamp_expired"}
  ```

  That response proves the bundle reached the DO and was rejected on
  timestamp (the bundle was intentionally stale). Anything other than
  this response means the binding or the migration didn't deploy.

### Disabled on the box

- `forum-solid.service` and `forum-provision-bridge.service` should be
  disabled. They are no longer in the boot path.

### Phone test status

Phone testing reached **WebAuthn-registers + `/api/register-member`
succeeds** with the final Worker code in place. The user has not yet
re-tested after the
`/api/register-member` + `/api/register-signing-key` proxy fix
shipped, so the last open question on the phone is the full PROVISION
round-trip. Expected wrangler tail on the next attempt:

```text
OPTIONS .../api/register-member        - Ok
POST    .../api/register-member        - Ok
OPTIONS .../api/register-signing-key   - Ok
POST    .../api/register-signing-key   - Ok
OPTIONS .../api/pod                    - Ok
POST    .../api/pod                    - Ok
POST    https://pod-do/                - Ok
```

---

## 6. What to verify next on the phone

In `https://airlock.yourcommunity.forum/pod/` in mobile Chrome:

1. Sign-in overlay appears.
2. Open **Advanced** — the URL line reads
   `https://secure-worker.forum-community.workers.dev/api/pod`.
   (If it reads anything else, `forum.podProviderUrl` is set in
   localStorage from an older build. Tap **Clear local Pod state**.)
3. Tap **Create a new Pod**. WebAuthn / Face ID prompt fires. Approve.
4. Overlay closes. The Journal, Forum Submissions, Behaviors, and
   Traits tabs render empty.
5. **Settings → Verify a personal email**: paste an `.eml`, submit.
   Status turns green. Permissive mode stores `email_hash` +
   `domain_hash` only.
6. **Journal**: write an entry, save. Tail logs a
   `POST /api/pod` with `path: /journal/raw/<id>` returning 200.
7. **Forum Feedback**: pick a category, write a comment, submit.
   - Verify a row in `forum_inbound.db`:

     ```bash
     sqlite3 ~/Desktop/forum-ai/database_syncs/forum_inbound.db \
       "SELECT receipt_id, kind, category_code, email_hash, created_at
        FROM forum_feedback ORDER BY created_at DESC LIMIT 5;"
     ```

8. Sign out → sign back in → confirm Journal / Forum data rehydrates
   from the DO (`syncJournalEntriesFromPod`, `syncPodToDuckDB`).

Negative test the H6 invariant still holds: take the DO offline by
deploying a Worker without the DO binding. Every Pod save should fail
clearly (`Pod RPC ... failed (500): pod_do_not_bound`) and **no
local-only row** should appear.

---

## 7. Known remaining gaps

- **Replay protection.** `verifySignedBundle` enforces a 5-min window
  but no `(sessionId,timestamp)` dedupe cache. Two identical signed
  bundles within the window are both accepted. To fix: add a
  `replay_cache` table in `pod_meta` keyed on `signature` with a
  cleanup pass on insert.
- **Pilot fallback opens a security hole in production.** Any WebAuthn
  failure currently falls back to a device-local credential. That's
  acceptable for a pilot but production must require a real passkey or
  at minimum a strong device PIN binding. Re-introduce
  `isNativePilotShell()` (or an explicit user toggle) in
  `webauthn-member.js`.
- **Cross-device sync.** Each device gets its own DO instance keyed
  on `sessionId`. A user with two phones has two Pods. Multi-device
  flow needs a key-export → key-import path. The simplest version is
  QR-code key export of `forum.podSigning` + `forum.member`, scanned
  on the second device, which then issues a signed bundle the DO
  recognises.
- **No data migration from CSS.** If any local dev CSS Pod still
  holds rows, dump them out of CSS before disabling
  `forum-solid.service`. Production CSS Pods do not exist so there's
  no migration to write at the cooperative scale.
- **APK build is still debug-signed.** `build-android-apk.sh` produces
  `app-debug.apk`. Add a release keystore + `signingConfigs` before
  giving the APK to anyone but yourself.
- **DO requires Workers Paid ($5/mo).** Free-tier accounts cannot
  bind Durable Objects. If a future deploy starts returning
  `pod_do_not_bound`, the account billing tier is the first place to
  check.
- **Real zkEmail still deferred.** `VITE_ZKEMAIL_REQUIRE_PROVER=0` and
  `ZK_EMAIL_REQUIRE_VERIFIER=0` in `forum.config.env` ship the
  permissive (shape-only) verifier. Flip both to `1` only after a
  blueprint's `email_verifier.wasm`, `email_verifier_final.zkey`, and
  `verification_key.json` are placed at the paths in the go-live
  checklist.
- **`pod.yourcommunity.forum` and `pod-provision.yourcommunity.forum`
  DNS routes** still exist in `/etc/cloudflared/config.yml`. Cosmetic
  but worth removing before more people see the box.

---

## 8. Diagnosis cheat sheet for the next failing phone test

| Symptom | Where to look | Likely cause |
|---|---|---|
| `Failed to fetch` with no `/api/pod` line in tail | Worker route table | A 404 with no CORS. Either a routing typo on the Worker or the Pod's URL is wrong. The Advanced section shows the URL the next call will use. |
| `Pod provider unreachable: Pod RPC network error for <url>: Failed to fetch` | The URL in the message | Wrong host (probably stale `localStorage.forum.podProviderUrl`) or a Cloudflare route that doesn't catch `/api/*`. |
| `Pod RPC PROVISION / failed (500): pod_do_not_bound` | `wrangler.toml` + deploy output | DO migration didn't apply, or account is on Workers Free. |
| `Pod RPC ... failed (401): key_mismatch` | `forum.podSigning` in localStorage | A previous Create-Pod attempt TOFU-registered a different key under the same `sessionId`. Tap **Clear local Pod state** and try again. |
| `Pod RPC ... failed (401): timestamp_expired` | Device clock | Phone clock skewed > 5 min. Fix system time. |
| `The relying party ID is not a registrable domain suffix` | `webauthn-member.js rpFromPodProvider` | Page origin and `rp.id` don't share a registrable domain. Confirm the PWA is loaded from a public hostname and `rpFromPodProvider` is still using `window.location.hostname`. |
| Overlay closes but tabs are empty | DO has no data yet | Expected. Write a Journal entry, watch for a `POST /api/pod` line. |
| Cooperative export 403 `email proof required` | Listener `forum_inbound.db members_email_proof` | Email hash not registered. Re-verify email in Settings. |

---

## 9. Mental model for the next agent

```text
device has a credential       -> can sign bundles
signed bundle reaches DO      -> can read/write its own Pod
no signed bundle              -> no usable app
sessionId is stable           -> same DO instance every time
sessionId changes             -> new DO instance, new TOFU key
```

The Worker is a pure router: it never reads or writes Pod data. The
DO is a pure data store: it never reaches out to the network. The
device is the only place that holds the private signing key. The
listener does **not** see Pod RPCs at all; it only handles the
cooperative-export and zkEmail-verify paths it always handled.

If a Pod write is unexpectedly visible to the listener, something is
routed wrong. If the DO has data the user doesn't, the device's
`forum.podSigning` key got out. If `wrangler tail` shows traffic to a
Worker route that doesn't exist, the catch-all should now make that
obvious — the response is JSON with the missing path, not a phantom
network error.

Treat the device as the source of truth, the DO as a remote
extension of device storage, and the listener as a separate aggregate
that holds only what the user explicitly opts to share.
