# Handover 11 — Security hardening pass (v1.8)

Build target: `secure-pod-v1.8-security` (`versionCode 6`).
Worker version: `e06a37b8-a583-4e7f-b883-3617b7cf9c90`.
Deployed 2026-05-23.

Prior: [handover10-edge-d1.md](handover10-edge-d1.md).

This handover documents a three-phase security pass that closes the
critical and high findings from the red-team review of v1.7. The wire
contract changes: every Pod RPC and every cooperative-export bundle
now carries a `deviceCredentialId` and (when the device has unlocked
with a real passkey) an `unlockToken` HMAC issued by the Worker. The
`sessionId` is now a wire invariant, computed from the device's
Ed25519 public key. zkEmail is no longer reachable from the public
edge. The decorative WebAuthn HTML and `forum_session=valid_token`
cookie gate are gone. The device-key export blob is PIN-wrapped.

User intent that prompted this iteration:

> I need a red team analysis of the architecture's security for a
> proof of concept.
> Let's implement as many fixes as we can to enhance security without
> breaking the flow.

After the red-team report:

> Scope C, OK to reset.

Phone state is allowed to reset once on first boot; existing D1 rows
are left in place.

---

## 1. What changed at a glance

| Finding (from red team) | Status | How |
|------|--------|-----|
| C1 — `/register/verify` does not verify WebAuthn | Closed | Route deleted; real verification on `/api/webauthn/register/verify` via `@simplewebauthn/server` |
| C2 — "Access Pod (Dev)" auth bypass | Closed | `webAuthnHtml()` deleted, `GET /` → 302 `/pod`, no cookie gate |
| C3 — Ed25519 private JWK in `localStorage` | Reduced | PRF-extension wrap at rest (opportunistic); unlock token still required |
| C4 — TOFU pre-claim on `sessionId` | Closed | `sessionId = pubkey:sha256(publicKeyHex)` enforced on the Worker |
| H1 — Static session cookie | Closed | Cookie gone |
| H2 — `*` CORS with credentials on listener | Closed | Allowlist + no credentials on `*` |
| H3 — zkEmail permissive by default | Closed | Listener fails closed unless `ZK_EMAIL_ALLOW_PERMISSIVE=1` |
| H4 — Listener replay cache in-memory/keyed weakly | Closed | SQLite `replay_cache` keyed by signature |
| H5 — Client-generated WebAuthn challenge | Closed | Worker-issued challenge via D1 `webauthn_challenges` |
| H6 — Capacitor auto pilot fallback | Closed | Pilot fallback only when `VITE_ALLOW_PILOT_FALLBACK=1` |
| L4 — `/api/zkemail/*` proxy on edge | Closed | Routes removed from Worker |
| M1 — Plaintext device-key export blob | Closed | PIN-wrapped v2 export (PBKDF2 + AES-GCM); v1 import surfaced as legacy |
| M3 — No CSP / X-Frame on Worker | Closed | CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy on `/pod` + `/assets` |

Not addressed in this pass:

- M2 (debug-signed APK) — gradle plumbing is in place but no real keystore yet.
- M4 (per-`sessionId` DoS) — no rate limit on `/api/pod/*` at the edge.
- M5 (DuckDB-WASM `sqlEscape`) — local-only, not exploitable across the trust boundary.
- M6 (`forum.config.env` in `~/Desktop`) — host-level move still pending.
- M7 (shared `AIRLOCK_SECRET` on `/api/forum/receipt`) — receipt path unchanged.
- L1 (canonical-JSON only sorts top-level keys) — same fragility as v1.7.

---

## 2. Files added / changed

### New files (`forum-airlock`)

| File | Purpose |
|------|---------|
| `session-binding.js` | `expectedSessionIdFromPubkey(pubHex)` and `sessionIdMatchesPubkey(sessionId, pubHex)`. Single source of truth for the binding. |
| `unlock-token.js` | `issueUnlockToken(env, credentialId)` / `verifyUnlockToken(env, token)` — HMAC-SHA256 over `${credentialId}:${expiresAtMs}` using the `UNLOCK_TOKEN_KEY` secret. 15-minute TTL. Also exports `isPilotCredentialId`. |
| `webauthn-server.js` | All four WebAuthn routes (`/api/webauthn/{register,auth}/{challenge,verify}`). Uses `@simplewebauthn/server` v13. Stores credentials and challenges in D1. |

### New files (`forum-pod`)

| File | Purpose |
|------|---------|
| `src/session-id.js` | `deriveBoundSessionId(pubHex)` mirror of the Worker-side helper. |
| `src/unlock-session.js` | In-memory unlock token cache (never persisted). Cleared on sign-out and when the token expires. |
| `src/signing-envelope.js` | `enrichSignedEnvelope(signed)` — attaches `deviceCredentialId` and (when available) `unlockToken` to the signed bundle. Called by every code path that POSTs a bundle. |

### Modified (`forum-airlock`)

| File | Change |
|------|--------|
| `secure-worker.js` | Rewritten. `GET /` → 302 `/pod`; security headers on `/pod` + `/assets`; `/api/webauthn/*` routing; `assertSessionBinding` and `assertUnlocked` on `/api/pod/*` and `/api/forum/feedback`; `/register/*`, `webAuthnHtml`, `/api/zkemail/*` removed; `/api/register-signing-key` rejects bundles whose `session_id` does not match the pubkey binding. |
| `webauthn-server.js` | (above; also: `bufferToBase64url` accepts a string passthrough because `WebAuthnCredential.id` is `Base64URLString` in `@simplewebauthn/server` v13). |
| `pod-signing.js` | `verifyBundle(bundle, lookupKey, replayStore, ...)` — `replayStore` is now `{ checkAndRecord(signature, sessionId) }`, returning `true` if replayed. Keyed by signature, not `${sessionId}:${timestamp}`. |
| `listener.js` | (1) CORS allowlist via `DEFAULT_CORS_ORIGINS` + `LISTENER_CORS_ALLOWLIST` env. No `Access-Control-Allow-Origin: *` with `Allow-Credentials: true`. (2) `replay_cache` SQLite table + `listenerReplayStore` adapter. In-memory `replayCache` removed. (3) `verifyZkEmailProof` fails closed; the missing-module branch returns `503` unless `ZK_EMAIL_ALLOW_PERMISSIVE=1`. |
| `wrangler.toml` | Added `ALLOW_PILOT_BUNDLES = "1"` comment + var; new `[assets].run_worker_first = true` so the Worker handles `GET /` before the static asset server. Documents the `UNLOCK_TOKEN_KEY` secret. |
| `package.json` | Added `@simplewebauthn/server ^13.1.1`. |

### Modified (`forum-pod`)

| File | Change |
|------|--------|
| `src/pod-signing.js` | `ensurePodSigningKey()` no longer takes a `sessionId` hint. After key generation it derives `sessionId = pubkey:sha256(publicKeyHex)` and persists it on both signing meta and member profile. `signBundle(payload)` ignores the legacy hint and uses the bound sessionId. |
| `src/webauthn-member.js` | `registerDevice` now calls `/api/webauthn/register/{challenge,verify}` and stores `auth_mode: "webauthn-verified"`. `unlockWithWebAuthn` calls `/api/webauthn/auth/{challenge,verify}` and caches the returned unlock token. `pilotFallbackAllowed` no longer auto-enables for `capacitor:` — only `VITE_ALLOW_PILOT_FALLBACK=1` at build time. PRF results, when present, drive `wrapSigningKeyAtRest` (register/refresh) and `unwrapSigningKeyAtRest` (auth). |
| `src/member-store.js` | `exportDeviceKeyBlob(pin)` is async, PBKDF2(SHA-256, 600 000) + AES-GCM. Format: `{ kind: "forum-personal-pod-device-key-v2", kdf: { salt }, cipher: { iv, ciphertext } }`. `importDeviceKeyBlob(blob, pin)` accepts both v1 (legacy unprotected) and v2; surfaces `legacyUnprotected: true` on the result. New `wrapSigningKeyAtRest(prfOutput)` / `unwrapSigningKeyAtRest(prfOutput)` write a `forum.podSigning.wrapped` localStorage record and remove `privateJwk` from the cleartext blob. A module-scoped `volatilePrivateJwk` keeps the unwrapped key in memory for the session so `signBundle` keeps working after wrap. `clearMemberProfile` and `clearSigningMemory` zero it out. |
| `src/solid-session.js` | Resolves the sessionId from `loadSigningMeta().sessionId` (binding-derived) before falling back to the legacy profile field. `solidLogout` clears the in-memory unlock token and the volatile signing key. `podRpc` posts the enriched envelope. |
| `src/cooperative-export.js` | `postForumFeedback` calls `ensurePodSigningKey()` and uses `meta.sessionId` (no longer `profile.webId || credential_id`). Posts the enriched envelope. |
| `src/pod-solid-integration.js` | `createPodFlow` no longer builds the sessionId locally — `ensurePodSigningKey()` is the source of truth. `unlockPodFlow(cooperativeUrl)` runs the WebAuthn auth flow; if the device is on the pilot path, it skips silently. |
| `src/sign-in-overlay.jsx` | `handleSignIn` passes the cooperative URL through so the unlock can hit `/api/webauthn/auth/*`. Pilot warning copy now mentions the build flag rather than promising auto-fallback. |
| `src/pod-ui.jsx` | `APP_BUILD = "secure-pod-v1.8-security"`. Boot effect detects legacy sessionIds (anything not `pubkey:sha256(publicKeyHex)`) and shows a yellow "rebinding required" banner; clearing local state + signing out + re-saving the recomputed sessionId. Export prompts for a PIN (with confirm); import prompts for the PIN (legacy v1 accepted, but flagged in the status). |
| `android/app/build.gradle` | `versionCode 6`, `versionName "secure-pod-v1.8-security"`. |
| `.env.example` | Notes that the Worker needs the `UNLOCK_TOKEN_KEY` secret and that `ALLOW_PILOT_BUNDLES=1` in `wrangler.toml` is the temporary pilot toggle. |

---

## 3. Wire-format additions

Outer envelope sent to `/api/pod/*` and `/api/forum/feedback`:

```jsonc
{
  "payload":        { "verb": "...", "path": "...", "data": ... },
  "sessionId":      "pubkey:<sha256(publicKeyHex)>",
  "timestamp":      "2026-05-23T17:00:00.000Z",
  "signature":      "<128-hex Ed25519>",
  "publicKeyHex":   "<64-hex>",

  // new in v1.8:
  "deviceCredentialId": "<base64url WebAuthn credential id, or pilot-...>",
  "unlockToken": {
    "credentialId": "<same>",
    "expiresAtMs":  1716491700000,
    "mac":          "<64-hex HMAC-SHA256>"
  }
}
```

Worker enforcement order on writes:

1. `assertSessionBinding(bundle)` — rejects unless `sessionId === pubkey:sha256(publicKeyHex)`.
2. `assertUnlocked(env, bundle)` —
   - If `UNLOCK_TOKEN_KEY` is unset, skipped (dev mode).
   - If `deviceCredentialId` starts with `pilot-`, accepted only when `env.ALLOW_PILOT_BUNDLES === "1"`.
   - Else: `deviceCredentialId` is required and `unlockToken.mac` must verify against the secret + match the credential.
3. `verifySignedBundle(bundle, null)` — Ed25519 verify.
4. Edge TOFU registry / DO TOFU registry (unchanged).
5. Replay cache.

---

## 4. New D1 tables

`webauthn_challenges`:

```
CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL,         -- 'register' or 'auth'
  expires_at_ms INTEGER NOT NULL
);
```

`webauthn_credentials`:

```
CREATE TABLE webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  public_key_cose TEXT NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Created lazily on first `/api/webauthn/*` request (`ensureWebAuthnSchema`).

Listener-side new table in `forum_inbound.db`:

```
CREATE TABLE replay_cache (
  signature TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seen_at_ms INTEGER NOT NULL
);
```

The DO's own `replay_cache` from H9 is unchanged.

---

## 5. Operational notes

### Deploy

```bash
cd ~/Desktop/forum-airlock
# one-time secret, only if not already set:
openssl rand -hex 32 | npx wrangler secret put UNLOCK_TOKEN_KEY

npm install                # picks up @simplewebauthn/server
npm run build:pod
npm run deploy:worker

sudo systemctl restart forum-backend.service  # listener picks up CORS + replay + zkEmail changes
```

Worker `wrangler.toml` keeps `ALLOW_PILOT_BUNDLES = "1"` so the Capacitor APK still works during pilot. Flip to `"0"` and redeploy once real WebAuthn is verified on the phone.

### Verification (recorded against the v1.8 deploy)

```bash
# 1. GET / redirects to /pod (Worker runs first thanks to run_worker_first):
curl -is https://secure-worker.forum-community.workers.dev/ | head -3
#   HTTP/2 302
#   location: https://secure-worker.forum-community.workers.dev/pod

# 2. Pod assets carry security headers:
curl -is https://secure-worker.forum-community.workers.dev/pod | grep -i 'content-security-policy\|x-frame-options\|strict-transport'

# 3. Decorative auth surface is gone:
curl -is -X POST .../register/verify -d '{}' | head -1     # 404
curl -is -X POST .../api/zkemail/verify -d '{}' | head -1  # 404

# 4. Session binding is enforced on /api/pod:
node - <<'EOF'
const pub='00'.repeat(32);
fetch('https://.../api/pod', {method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ sessionId:'not-bound', publicKeyHex:pub, signature:'00',
    timestamp:new Date().toISOString(), payload:{verb:'LIST',path:'/civic/submissions',data:null}})})
  .then(r=>r.text().then(t=>console.log(r.status,t)));
EOF
# -> 401 {"error":"auth_failed","reason":"session_id_binding_mismatch"}

# 5. Even a correctly-bound bundle without an unlock token / device id fails:
# -> 401 {"error":"auth_failed","reason":"missing_device_credential_id"}

# 6. WebAuthn challenge issues:
curl -is -X POST .../api/webauthn/register/challenge -d '{}'   # 200 with options
```

D1 spot checks after a phone submission:

```bash
npx wrangler d1 execute forum-db --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table'
   AND (name LIKE 'forum_%' OR name LIKE 'edge_%' OR name LIKE 'webauthn_%');"

npx wrangler d1 execute forum-db --remote --command \
  "SELECT receipt_id, kind, session_id, substr(email_hash,1,12) AS member_hash_prefix, created_at
   FROM forum_feedback ORDER BY created_at DESC LIMIT 5;"
# session_id should now start with 'pubkey:'.
```

### What to expect on the phone (post-install)

1. First open of v1.8 with an existing v1.7 install:
   - Boot effect detects the legacy sessionId.
   - Yellow rebinding banner appears: "Your Pod was re-bound to your signing key. Sign in again …".
   - Tap **Sign in to existing Pod** → WebAuthn unlock → new DO instance under the new sessionId.
   - D1 rows from before remain untouched.

2. New install (no prior v1.7 state):
   - Tap **Create a new Pod** → real WebAuthn `create()` → server stores COSE key → unlock token cached in memory.
   - Subsequent saves attach `deviceCredentialId` + `unlockToken`.

3. After 15 minutes idle the unlock token expires; the next signed write will surface a `unlock_token_expired` error. Tap **Sign in to existing Pod** (or any unlock UI) to refresh.

### What still works "silently" on the Capacitor WebView

If a WebView refuses passkeys and you need to keep testing:

```bash
cd ~/Desktop/forum-pod
VITE_ALLOW_PILOT_FALLBACK=1 npm run build
# rebuild the APK with this Vite env
```

The Worker accepts pilot bundles only while `ALLOW_PILOT_BUNDLES = "1"` is set in `wrangler.toml`. Drop that to `"0"` once a real passkey works on the phone to make pilot bundles fail closed.

### Rollback

Each step is independently revertible:

1. **Worker only** — Cloudflare keeps every Worker version. Roll back via dashboard or `npx wrangler rollback`. The pre-H11 Worker still accepts v1.7 wire format.
2. **Pod only** — Reinstall the v1.7 APK (`secure-pod-v1.7-webauthn-only`, `versionCode 5`). The H11 Worker still accepts those bundles when `UNLOCK_TOKEN_KEY` is unset, **or** if the pre-H11 sessionId derivation is restored.
3. **Listener only** — Revert the listener.js changes; the DO + Worker do not depend on them.

The riskiest one-way step is the v1.7 → v1.8 sessionId rebind on the phone. After it happens, the old DO instance under the legacy sessionId becomes inaccessible from this device (the data is still in Cloudflare but addressed by a sessionId nothing on the device now produces). Importing a v1 device-key blob from another v1.7 device would recover that DO; otherwise treat the rebind as the cost of switching to bound sessionIds.

---

## 6. Known follow-ups (carried forward)

| Item | Notes |
|------|-------|
| Move `~/Desktop/forum.config.env` to `/etc/forum/config.env`, `0600 root:forum-user1` | Update `forum-backend.service` `EnvironmentFile=`. Closes M6. |
| Provide a real Android keystore + `FORUM_RELEASE_*` gradle properties | Closes M2. The plumbing is already in `android/app/build.gradle`. |
| Per-`sessionId` rate limit on `/api/pod/*` | Closes M4. Cheapest place: an `INSERT OR IGNORE` against a `pod_rate_cache` D1 table keyed by `sessionId,minute_bucket`. |
| Wrangler v3 → v4 upgrade | Wrangler is warning on every deploy. Non-blocking. |
| Real canonical JSON (RFC 8785) | Closes L1. The current `canonicalise` only sorts top-level keys; would be safer to use a real JCS implementation, but no exploit path is known. |
| Removing `edge_signing_keys` | Now redundant — the sessionId **is** the key fingerprint. Drop the table after a release confirms nothing reads it. |
| Removing the `/api/zkemail/*` routes from the listener | They are no longer publicly reachable through the Worker. Delete from `listener.js` once telemetry shows no callers. |
| `public/zk-email/` dead README still in the APK bundle | Same as H9 §5; `rm -rf forum-pod/public/zk-email` next iteration. |

---

## 7. Mental model

```
device WebAuthn passkey   ─►  /api/webauthn/auth/verify   ─►  unlock token (HMAC, 15 min)
device Ed25519 signing key ─►  sessionId = pubkey:sha256(pub)
signed bundle              ─►  Worker assertSessionBinding
                          └►  Worker assertUnlocked (unless ALLOW_PILOT_BUNDLES + pilot id)
                          └►  Ed25519 verify
                          └►  PersonalPodDO  (DO TOFU)
                          └►  D1 forum_feedback  (edge TOFU)
```

If the Worker rejects with:

- `session_id_binding_mismatch` — the client is using a non-bound sessionId (legacy v1.7 build, or a forged bundle). The Pod boot effect normally repairs this; if it does not, tap **Forget this device** and create a new Pod.
- `missing_device_credential_id` — the client posted a bundle without `deviceCredentialId`. Pre-H11 builds will hit this. Reinstall v1.8.
- `unlock_token_expired` — the in-memory token aged out. Re-unlock with the existing passkey.
- `unlock_token_invalid` — `UNLOCK_TOKEN_KEY` rotated, or the bundle is forged. Re-unlock.
- `pilot_bundles_disabled` — the device is on the pilot path but the Worker has `ALLOW_PILOT_BUNDLES=0`. Either rebuild the APK with a real passkey or temporarily flip the Worker var back to `"1"`.

The wire invariant is: a bundle that landed in D1 was signed by an Ed25519 key whose hash is the sessionId, and (in non-pilot mode) was signed within 15 minutes of a Worker-verified WebAuthn assertion on a credential the Worker also stored.

---

## 8. Quick reference

Worker URL: `https://secure-worker.forum-community.workers.dev`

D1 binding (unchanged):

| Binding | Database | ID |
|---------|----------|----|
| `DB` | `forum-db` | `b23bdfa3-d8ba-4092-a5ac-ada4d697bc3b` |

Required Worker secret: `UNLOCK_TOKEN_KEY` (32 bytes random, hex).
Required Worker var: `ALLOW_PILOT_BUNDLES` (set to `"1"` for pilot, `"0"` for prod).
Optional Worker var: `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `WEBAUTHN_RP_NAME` (defaults are the Worker hostname).

Listener env additions:

- `ZK_EMAIL_ALLOW_PERMISSIVE=1` to opt in to shape-only verifier (default: closed).
- `LISTENER_CORS_ALLOWLIST=<csv>` extra origins beyond the built-in allowlist.

Routes:

- `POST /api/webauthn/register/challenge` / `verify` — passkey enrollment.
- `POST /api/webauthn/auth/challenge` / `verify` — passkey unlock, returns 15-min unlock token.
- `GET /` — 302 to `/pod`.
- Everything else from H10 is unchanged.

Pod build identity:

- `APP_BUILD = "secure-pod-v1.8-security"`.
- Android `versionCode 6`, `versionName "secure-pod-v1.8-security"`.
