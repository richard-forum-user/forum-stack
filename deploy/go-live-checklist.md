# Go-live checklist — Personal Pod (v1.7, WebAuthn-only)

**Goal:** ship `secure-pod-v1.7-webauthn-only` to a test phone using the
`yourcommunity.forum` Worker as the Pod backend. After Handover 9 there
is no zkEmail proving in the critical path; identity is the
WebAuthn-bound Ed25519 device key. The Community Solid Server, the
provision bridge, and the `pod.*` / `pod-provision.*` DNS routes are
not required either.

The agent prepared every file edit; the items below are what you run
in order. Each block is copy-paste safe. **Run them in order — the
next block usually depends on the previous block finishing cleanly.**

If a step fails, fix the failing step before moving on. Most common
failure modes are at the bottom under **Troubleshooting**.

---

## 0. Sanity check

```bash
java -version
node --version
ls -d ~/android-sdk
npx wrangler --version
```

If any are missing, install them before continuing.

---

## 1. Stop the now-unneeded services

After H8 the local CSS Pod and provision bridge are dead weight; after
H9 the cooperative no longer needs zkEmail at the listener. Stop and
disable the obsolete units so no port conflicts and no journal noise.

```bash
sudo systemctl disable --now forum-solid.service          2>/dev/null || true
sudo systemctl disable --now forum-provision-bridge.service 2>/dev/null || true
systemctl status forum-solid.service forum-provision-bridge.service --no-pager 2>&1 | head -20
```

You can leave the service files in `/etc/systemd/system/` for now;
remove them once you're confident the DO + WebAuthn path works.

---

## 2. Trim the Cloudflare Tunnel ingress

```bash
sudo bash ~/Desktop/deploy/install-cloudflared-config.sh
```

That copies `~/Desktop/deploy/cloudflared-config.yml` into
`/etc/cloudflared/config.yml` (after backing up the H8 file to
`config.yml.h8.bak`) and restarts `cloudflared`. Only
`listener.yourcommunity.forum` and `apk.yourcommunity.forum` are kept.

If you also want to delete the dangling DNS records, do that in the
Cloudflare dashboard — the tunnel will not answer for them either way.

---

## 3. Deploy the Worker with the Durable Object binding

```bash
cd ~/Desktop/forum-airlock

# Push secrets to Cloudflare (read from forum.config.env).
awk -F= '/^AIRLOCK_SECRET=/{print $2}' ~/Desktop/forum.config.env \
  | npx wrangler secret put AIRLOCK_SECRET

# Build the bundled Vite assets the Worker serves at /pod/.
npm run build:pod

# Deploy. Wrangler will run the v1 migration that creates the
# PersonalPodDO SQLite class on first deploy. If the class already
# exists the migration is a no-op.
npm run deploy:worker
```

Sanity-check the Pod RPC surface. With H9 the DO carries a replay
cache; a malformed bundle still 401s on `invalid_structure`.

```bash
curl -s -X POST https://secure-worker.forum-community.workers.dev/api/pod/ping \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"smoke-test"}' | head -c 400; echo
# Expect: {"error":"auth_failed","reason":"invalid_structure"} or similar.
# A 500 with "pod_do_not_bound" means the DO binding didn't deploy —
# check wrangler.toml + redeploy.
```

The forum-feedback proxy still hits the local listener, but the
listener no longer rejects on `email proof required`:

```bash
curl -s -X POST https://secure-worker.forum-community.workers.dev/api/forum/feedback \
  -H "Content-Type: application/json" -d '{}'
# Expect: {"message":"Payload authentication failed: invalid_structure"}
```

zkEmail routes are still mounted (dormant) so older Pods do not break,
but no new Pod sends to them.

---

## 4. Build and publish the v1.7 APK

For a **pilot debug APK** (debug-signed, unsigned for distribution):

```bash
cd ~/Desktop/forum-pod
npm install            # picks up snarkjs + @zk-email/helpers removal
npm run lint
APP_BUILD=secure-pod-v1.7-webauthn-only bash ~/Desktop/deploy/build-android-apk.sh
APP_BUILD=secure-pod-v1.7-webauthn-only bash ~/Desktop/deploy/publish-android-apk.sh
```

For a **distributable release APK** (release-signed):

```bash
# One-time keystore creation — store outside the repo, back it up:
keytool -genkey -v \
  -keystore ~/keystores/forum-release.keystore \
  -alias forum-personal-pod \
  -keyalg RSA -keysize 2048 -validity 10000
chmod 600 ~/keystores/forum-release.keystore

# One-time gradle property setup (do NOT commit gradle.properties):
cat >> ~/.gradle/gradle.properties <<'EOF'
FORUM_RELEASE_STORE_FILE=/home/forum-user1/keystores/forum-release.keystore
FORUM_RELEASE_STORE_PASSWORD=<password>
FORUM_RELEASE_KEY_ALIAS=forum-personal-pod
FORUM_RELEASE_KEY_PASSWORD=<password>
EOF
chmod 600 ~/.gradle/gradle.properties

# Build + publish a release-signed APK:
APP_BUILD=secure-pod-v1.7-webauthn-only bash ~/Desktop/deploy/build-android-release-apk.sh
cp ~/Desktop/forum-pod/android/app/build/outputs/apk/release/app-release.apk \
   ~/Desktop/forum-releases/forum-personal-pod-secure-pod-v1.7-webauthn-only.apk
APP_BUILD=secure-pod-v1.7-webauthn-only bash ~/Desktop/deploy/publish-android-apk.sh
```

Confirm the release page is fresh:

```bash
curl -sI https://apk.yourcommunity.forum/forum-personal-pod-secure-pod-v1.7-webauthn-only.apk | head -5
curl -s  https://apk.yourcommunity.forum/SHA256SUMS.txt
ls -lh   ~/Desktop/forum-releases/forum-personal-pod-secure-pod-v1.7-webauthn-only.apk
sha256sum ~/Desktop/forum-releases/forum-personal-pod-secure-pod-v1.7-webauthn-only.apk
```

Write down the sha256. Verifying it on the phone is the easiest way to
prove you have the patched build.

---

## 5. Install and exercise on the phone

1. **Uninstall** any previous "Forum Personal Pod" app (Settings →
   Apps → uninstall). This clears stale localStorage holding the old
   `forum.solidSession` / member profile / email proof.
2. Open `https://apk.yourcommunity.forum/` in Chrome on the phone.
3. Tap **Download latest APK** and install. Allow "install from this
   source" if prompted.
4. Open **Forum Personal Pod**.
5. The sign-in overlay appears. Tap **Create a new Pod**.
   - Status text updates under the button:
     `Starting Pod creation...` → `Creating device credential...` →
     `Signed in. Loading your Pod...` — then the overlay closes.
   - If WebAuthn fails (likely on Capacitor WebView with a public RP
     id), the Capacitor shell uses the pilot device-local fallback
     automatically. A public web build with
     `VITE_ALLOW_PILOT_FALLBACK=1` does the same; production web
     builds surface the WebAuthn error instead.
6. Once signed in, the sidebar shows `civic_submissions`,
   `raw_submissions`, `behavioral_data`, `psychographic_data` — all
   empty. There is no email-verify panel in Settings any more.
7. **Journal** → write a short entry → save. Confirm a row appears
   under **Journal data** in the sidebar. Watch `wrangler tail` for a
   `POST /api/pod/journal/raw/...` → 200.
8. **Forum Feedback** → pick a category → submit → confirm a row in
   **Forum Submissions**, and on the server:

   ```bash
   sqlite3 ~/Desktop/forum-ai/database_syncs/forum_inbound.db \
     "SELECT receipt_id, kind, category_code, email_hash, created_at
      FROM forum_feedback ORDER BY created_at DESC LIMIT 5;"
   ```

   The just-submitted row should be there. The `email_hash` column now
   holds a `sha256(public_key_hex)` device-derived identifier (NOT an
   email hash); the listener auto-inserts a synthetic row in
   `members_email_proof` to satisfy the FK.

9. **Settings → Device key → Export device key**. Copy the blob, paste
   it into a second device's **Import device key** field, then **Sign
   in to existing Pod**. The second device should see the same Pod
   data.

10. **Sign out** clears the session cache. Sign back in: data should
    rehydrate from the DO.

11. **Replay-protection smoke test** (optional, run on desktop):

    ```bash
    # Capture a real signed bundle from wrangler tail, then POST it
    # back to the same /api/pod URL twice within 5 minutes. The first
    # should succeed; the second must return
    # {"error":"auth_failed","reason":"replay_detected"}.
    ```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Create button does nothing | Old APK is still installed (cached). | Uninstall app, re-download, confirm sha256 matches the one from step 4. |
| Red error `Passkey registration failed: ...` | Real WebAuthn error, fallback is gated off. | Either fix the WebAuthn config (RP id matches origin, platform authenticator available) or set `VITE_ALLOW_PILOT_FALLBACK=1` and rebuild for a pilot. |
| Red error `Pod provider unreachable: ...` | Worker not redeployed, or DO binding missing. | Re-run step 3. Test `curl https://secure-worker.../api/pod/ping`. |
| Red error `Pod RPC PROVISION / failed (401): key_mismatch` | Two devices share a credential id (uninstall + reinstall without clearing localStorage). | Uninstall, then re-create the Pod; the DO will see the new key for that sessionId. |
| Red error `Pod RPC ... failed (500): pod_do_not_bound` | wrangler deploy ran but the migration didn't enable SQLite for the class. | `cat ~/Desktop/forum-airlock/wrangler.toml` — confirm `[[migrations]] new_sqlite_classes = ["PersonalPodDO"]`, then `npm run deploy:worker` again. |
| `auth_failed: replay_detected` on second request | Expected. The DO refuses to accept the same signed bundle twice within 5 minutes. | Sign a fresh bundle (each `signBundle` call generates a new timestamp + signature). |
| Tabs render but Pod write 401 | Worker drift (old build deployed, new client). | Redeploy Worker. |
| `401 Payload authentication failed: key_not_registered` on Forum Feedback | Listener was restarted and the in-memory key cache is empty; the DB lookup also failed. | Confirm `/api/register-signing-key` succeeded during Create Pod. If `~/Desktop/forum-airlock/forum_inbound.db pod_signing_keys` is empty, re-create the Pod. |
| APK install blocked by phone | "Install from unknown sources" off. | Enable for the browser app downloading the APK, retry. |
| Listener 502 from Worker | `LISTENER_URL` in `wrangler.toml` not reachable. | Confirm `https://listener.yourcommunity.forum/health` returns OK. |

---

## What this checklist deliberately does NOT do

- **Re-enable zkEmail.** The infrastructure (`/api/zkemail/*` routes,
  `members_email_proof` table, `email_proof` table in the DO,
  `zkemail-verifier.js`, `public/zk-email/`) is left in place but
  dormant. If you want it back, re-add the `emailHashIsRegistered`
  call in `handleForumFeedback` and re-introduce the email proof UI
  in Settings — they were the only gates.
- **Migrate any existing Pod data from CSS.** No production CSS Pods
  exist; if you have local dev data you care about, dump it from CSS
  before disabling `forum-solid.service`.
- **Set `FORUM_AUTO_ANALYSIS=1`.** Analysis timer is on a 15-min
  cycle; the per-submit trigger remains opt-in.
