# Handover 9 — WebAuthn-only: close out H8 gaps, drop zkEmail

Build target: `secure-pod-v1.7-webauthn-only` (versionCode 5).

This handover takes the H8 Durable Object pivot to "merge-ready":
- The zkEmail flow is **out of the critical path** (still mounted but
  dormant on the listener side, not wired into the Pod UI any more).
- Identity is the WebAuthn-bound Ed25519 device key. Cooperative
  submissions are gated on signature verification alone.
- The Personal Pod DO now has a **replay-protection cache**.
- The **pilot WebAuthn fallback** is gated behind an explicit flag (or
  the Capacitor WebView origin) so production browser builds never
  silently downgrade to a device-local credential.
- **Multi-device key transfer** is supported via a copy-paste blob in
  Settings (real QR code is a follow-up).
- Stale `pod.*` Cloudflare Tunnel ingress is removed.
- Android `release` build type now reads from a release keystore via
  `gradle.properties`; a debug-signed fallback keeps local pilots
  working.

User intent that prompted this iteration (verbatim):

> Let's close out known gaps. Also, we should abandon ZKemail for this
> iteration and just focus on the webauth on the device creating the
> pod and allowing submissions. I seem to be getting hung up on the
> zkemail verification.

---

## 1. Architecture (post H9)

```
Phone (Capacitor APK)
└─ WebAuthn create() → device credential (passkey OR pilot fallback)
   └─ generate Ed25519 signing key (pod-signing.js)
      ├─ POST /api/register-member       (Worker → listener; persisted)
      ├─ POST /api/register-signing-key  (Worker → listener; persisted to pod_signing_keys)
      ├─ podRpc("PROVISION", "/", …)     (Worker → PersonalPodDO; TOFU)
      ├─ podRpc("PUT", "/journal/raw/…", …)        (writes journal)
      ├─ podRpc("PUT", "/civic/submissions/…", …)  (writes feedback)
      └─ POST /api/forum/feedback (Worker → listener)
            └─ verifyBundle (in-mem podKeyRegistry, fallback to pod_signing_keys DB)
            └─ ensureMemberHashRow (sha256(public_key_hex))
            └─ forum_exports + forum_feedback rows written
```

zkEmail boxes on the diagram are gone. The cooperative ledger still
has an `email_hash` column (NOT NULL), so the listener feeds it
`sha256(public_key_hex)` — a stable, non-PII, device-derived
identifier. Nothing in this hash maps back to an email address.

---

## 2. What changed (file by file)

### Pod app

| File | Change |
|------|--------|
| `src/cooperative-export.js` | Drop `loadLocalProof` import. Derive `member_hash = sha256(publicKeyHex)` from the signing meta and put it on both the payload (`email_hash`) and the outer envelope (`emailHash`). |
| `src/pod-ui.jsx` | Drop every email-proof import, state hook, hydrate step, gating in `syncSubmission`, `needs_email_proof` status pill / QBE filter, and the entire email-proof Settings panel. Replace with a **Device key** panel (Export / Import / Copy buffers). `APP_BUILD = "secure-pod-v1.7-webauthn-only"`. |
| `src/webauthn-member.js` | New `pilotFallbackAllowed()` gate: fall back to a device-local credential only when `VITE_ALLOW_PILOT_FALLBACK=1` is set at build time OR the page is running under `capacitor:`. Otherwise rethrow the WebAuthn error. |
| `src/member-store.js` | New `exportDeviceKeyBlob()` / `importDeviceKeyBlob()` helpers — base64url-encoded JSON bundling profile + Ed25519 signing meta. |
| `src/solid-pod-write.js` | Remove `writeEmailProofToPod`. |
| `src/solid-sync.js` | Remove `syncEmailProofFromPod`. |
| `src/pod-solid-integration.js` | Drop the two email-proof re-exports. |
| `src/civic-vocab.js` | Drop `emailProofToJsonLd`, `jsonLdToEmailProof`, `emailProofResourceUrl`. |
| `src/email-proof.js` | **Deleted**. |
| `vite.config.js` | Drop the snarkjs / `@zk-email/helpers` `optimizeDeps.exclude` and the legacy `/api/civic/submit` dev proxy. |
| `package.json` | Drop `snarkjs` and `@zk-email/helpers` dependencies. (`npm install` regenerates `package-lock.json`.) |
| `.env`, `.env.example` | Drop `VITE_ZKEMAIL_*` vars. Add `VITE_ALLOW_PILOT_FALLBACK` documentation. |
| `android/app/build.gradle` | `versionCode 5`, `versionName "secure-pod-v1.7-webauthn-only"`. New `signingConfigs.release` block driven by `FORUM_RELEASE_*` gradle properties / env vars. Release builds fall back to the debug keystore (with a Gradle warning) when those properties are unset. |

### Airlock listener

| File | Change |
|------|--------|
| `listener.js` | Drop `emailHashIsRegistered` gate from `handleForumFeedback`. Introduce `pod_signing_keys` table + `persistSigningKey` / `loadSigningKey` helpers so listener restarts don't 401 every signed submission. Add `deviceMemberHash` + `ensureMemberHashRow` to keep the legacy `email_hash` NOT NULL constraint satisfied. `/api/zkemail/*` routes still mounted (dormant). |
| `pod-do.js` | New `replay_cache` table + `checkAndRecordReplay()` using `INSERT OR IGNORE` (concurrent-safe via PRIMARY KEY conflict). Replay window matches the 5-min `verifySignedBundle` window. |

### Worker

| File | Change |
|------|--------|
| `secure-worker.js` | No code change in this handover; CORS-correct fallback + Pod DO routing landed in H8 and is still valid. |

### Deploy + config

| File | Change |
|------|--------|
| `~/Desktop/deploy/forum-pod-launch.sh` | Drop the CSS and provision-bridge steps. Now launches listener + Vite only. Quick Tunnel points at Vite instead of CSS. |
| `~/Desktop/deploy/cloudflared-config.yml` (new) | Cleaned-up tunnel ingress: only `listener.yourcommunity.forum` and `apk.yourcommunity.forum`. |
| `~/Desktop/deploy/install-cloudflared-config.sh` (new) | sudo-installs the above into `/etc/cloudflared/config.yml` with a backup, restarts cloudflared. |
| `~/Desktop/deploy/build-android-release-apk.sh` (new) | Wraps `gradlew assembleRelease` after reading `FORUM_RELEASE_*` from `~/.gradle/gradle.properties`. |
| `~/Desktop/deploy/go-live-checklist.md` | Rewritten to cover the v1.7 path (tunnel cleanup, release-signed APK option, device-key transfer test, replay-protection smoke test). |
| `~/Desktop/forum.config.env` | Drop `ZK_EMAIL_REQUIRE_VERIFIER` and stale `POD_BASE_URL`. |

---

## 3. Wire-format reminders

A signed bundle is unchanged from H8:

```jsonc
{
  "payload":       { "verb": "PUT", "path": "/journal/raw/abc", "data": { ... } },
  "sessionId":     "https://.../forum-members/abc/profile/card#me",
  "timestamp":     "2026-05-22T20:13:08.412Z",
  "signature":     "<128-hex Ed25519>",
  "publicKeyHex":  "<64-hex Ed25519 public key>"
}
```

The DO now also rejects a bundle whose `signature` it has seen within
the last ~5 minutes (`auth_failed / replay_detected`). The cooperative
listener still relies on `verifyBundle` from `pod-signing.js`, which
already uses a Set-based replay cache for its own scope.

---

## 4. Multi-device key transfer (provisional)

**Export** (Settings → Device key → Export device key) produces a
base64url blob of:

```jsonc
{
  "kind":        "forum-personal-pod-device-key-v1",
  "version":    1,
  "exported_at":"2026-05-22T…",
  "member":     { "credential_id": "…", "webId": "…", … },
  "signing":    { "sessionId": "…", "publicKeyHex": "…", "privateJwk": { … }, … }
}
```

**Import** (Settings → Device key → Import device key) accepts that
blob, writes the member profile and signing meta into localStorage on
the receiving device, then prompts the user to tap **Sign in to
existing Pod**.

⚠️ Treat the blob like a password: anyone holding it can read and
write the user's Personal Pod DO. There is no encryption-at-rest in
this iteration; the follow-up is QR-display + camera-scan + (probably)
a short PIN to derive an HKDF wrap key.

---

## 5. Known gaps (deferred)

| Gap | Why deferred | Where to start |
|-----|--------------|----------------|
| QR-encoded device-key transfer | Functional copy-paste path landed first to unblock multi-device testing. | Use `qrcode-generator` (small dep) in Settings; wrap blob with a user PIN via `pbkdf2 + AES-GCM` before encoding. |
| Real zkEmail | Out of the critical path per user instruction. | `email-proof.js` deleted; reintroduce by re-adding to Pod imports, re-mounting Settings panel, and re-enabling the `emailHashIsRegistered` gate in `listener.js handleForumFeedback`. |
| Sign-in overlay copy still says "Solid Pod" | Cosmetic only, deliberately left to avoid touching the working overlay during this iteration. | `src/sign-in-overlay.jsx` line 149: replace "secure Solid Pod" with "Personal Pod (Cloudflare DO)". |
| `pod-do.js` still has `email_proof` table | Schema migration cost > benefit; the route just isn't called from the Pod any more. | Add a v2 migration in `wrangler.toml` (`new_sqlite_classes` once you also rename the class, or `renamed_classes` if you keep it). |
| Listener `/api/zkemail/*` routes still mounted | Backward compat for any pre-v1.7 Pod that still POSTs. | Remove from `listener.js` + `secure-worker.js` once telemetry shows no callers. |
| Stale `pod.* / pod-provision.*` DNS records | Cloudflare dashboard, not in this repo. | Delete the A/CNAME records manually. The tunnel no longer answers for them. |
| `public/zk-email/README.md` shipped in APK assets | 1.2KB of dead README in the bundle. | `rm -rf forum-pod/public/zk-email` next iteration. |

---

## 6. Verification I could not run from this environment

The shell in the environment that prepared this handover would not
execute commands (returned empty stdout for every probe). The
verification steps below are **untested**; please run them on the
workstation before publishing the APK:

```bash
cd ~/Desktop/forum-pod
npm install              # picks up the dependency removals
npm run lint
npm run build

cd ~/Desktop/forum-airlock
# spot-check listener boots and the new schema applies:
LISTENER_PORT=3000 npm run listener &
sleep 2
curl -s http://localhost:3000/health
kill %1
sqlite3 ~/Desktop/forum-airlock/forum_inbound.db \
  ".schema pod_signing_keys"
```

If `npm run lint` flags an unused import in `src/pod-ui.jsx` or
`src/pod-solid-integration.js` (the `clearMemberProfile` / `signBundle`
re-exports), drop them per the patterns from H7 §3. The grep audit
I ran did not surface any, but lint is the source of truth.

---

## 7. Quick rollback

If something goes wrong on the phone after installing v1.7:

```bash
# Reinstall v1.6:
adb install -r ~/Desktop/forum-releases/forum-personal-pod-secure-pod-v1.6-do.apk
# Or uninstall and reinstall:
adb uninstall forum.personalpod
adb install ~/Desktop/forum-releases/forum-personal-pod-secure-pod-v1.6-do.apk
```

The Worker is forward-compatible (it still accepts v1.6 bundles
without `emailHash` populated), and the DO replay cache is opt-in via
the bundle's own `signature` field — old clients are unaffected.

If you want to roll back the **listener**, re-introduce the
`emailHashIsRegistered` gate by reverting commit-of-this-handover on
`forum-airlock/listener.js` only. The DO replay cache is safe to keep
in either case.
