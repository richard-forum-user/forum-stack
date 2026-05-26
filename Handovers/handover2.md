# Project Handover Document (Session 2)

**Date:** 2026-05-18  
**Prior handover:** [handover1.md](handover1.md)  
**Machine user:** `forum-user1`  
**Desktop root:** `/home/forum-user1/Desktop`

---

## 1. Core Architecture

ForumAI remains a **local-first personal civic data pod** with an **Android packaging path** and an **always-on cooperative Linux server** behind Cloudflare.

### Three layers

| Layer | Role | Location |
|-------|------|----------|
| **Personal Pod** | Vite + React app in browser or Capacitor WebView | `/home/forum-user1/Desktop/forum-pod` |
| **Cooperative server** | Ingest, encrypt, analyze, publish reports | `forum-airlock`, `forum-ai`, `forum-egress` |
| **Cloudflare edge** | Public Worker (PWA/pod UI), tunnel (listener + APK), egress report | Workers + `cloudflared` |

### Data flow (civic submit)

```
Android / PWA
  → POST <Worker URL>/api/civic/submit
  → secure-worker (Cloudflare Worker)
  → POST https://listener.yourcommunity.forum/submit  (with AIRLOCK_SECRET)
  → forum-backend.service (Node listener on :3000)
  → forum-ai/vault.py
  → forum_inbound.db (encrypted)
  → forum-analysis.timer (every 15 min)
  → report.json + push to forum-egress Worker
  → https://forum-egress.yourcommunity.forum (public HTML report)
```

### Local pod data (device only)

The app **does not** read server SQL. It only uses:

- **IndexedDB:** `forum-personal-pod` → store `civic_submissions` (durable on device)
- **DuckDB-WASM:** in-memory tables hydrated from IndexedDB on startup
  - `civic_categories`
  - `civic_submissions`
  - user-imported tables (CSV/JSON/Parquet)

**Invariant:** Local first, sync second.

---

## 2. Current Exact Project State

### What works (verified this session)

- **Civic ingress:** Phone/Android submissions reach `forum_inbound.db` when Worker secret and tunnel are correct.
- **systemd backend:** `forum-backend.service` runs `listener.js` on port 3000 (after disabling old user service that held the port).
- **Cloudflare Worker:** `secure-worker.forum-community.workers.dev` — empty POST to `/api/civic/submit` returns `400 Missing payload` (good).
- **Analysis pipeline:** Classification + aggregation runs; egress push succeeded with `SUCCESS: Report cleared egress.`
- **Public report:** `https://forum-egress.yourcommunity.forum` serves HTML from KV (`latest` key).
- **APK build:** Capacitor 6 + Java 17; debug APK builds via `build-android-apk.sh`.
- **APK download host:** Local release server on `:8090`, tunneled at `apk.yourcommunity.forum`.

### Pod app changes (since handover1)

| Topic | Before | Now |
|-------|--------|-----|
| AI tab | WebLLM / Ollama chat | **Local SQL** — read-only DuckDB only |
| `@mlc-ai/web-llm` | In dependencies | **Removed** from `package.json` |
| Build marker | Duck / generic | **`1.2-sql-only-no-ai`** in header |
| Android default server URL | Empty / placeholder | **`https://secure-worker.forum-community.workers.dev`** |
| Service worker cache | `forum-pod-v1` | **`forum-pod-v2-sql-only`** |
| Report aggregation | LLM-generated prose (hallucinated quotes) | **Deterministic** from `civic_sentiment_v2` summaries |
| UI icon | Duck emoji | **Pillar** (`public/pillar-icon.svg`, Android launcher) |
| Portrait mobile | Side-by-side desktop layout | Stacked layout + civic **Device local ledger** panel |

### Android versioning

```gradle
versionCode 3
versionName "1.2-sql-only"
```

Published APK filename (avoid stale cache):

```text
https://apk.yourcommunity.forum/forum-personal-pod-sql-only-v2.apk
```

Do **not** point the app at `listener.yourcommunity.forum` — that is the private tunnel to the Node listener and requires `X-Airlock-Secret`, which the app does not send.

**Correct Settings URL:**

```text
https://secure-worker.forum-community.workers.dev
```

Submit endpoint becomes:

```text
https://secure-worker.forum-community.workers.dev/api/civic/submit
```

---

## 3. Always-On Server (systemd)

### System services (`/etc/systemd/system/`)

| Unit | Purpose | Notes |
|------|---------|--------|
| `forum-backend.service` | Node `listener.js` on **:3000** | User `forum-user1`; replaces manual terminal + old user unit |
| `ollama.service` | Local LLM for **server analysis** | `OLLAMA_HOST=127.0.0.1:11434` via drop-in |
| `cloudflared.service` | Permanent tunnel | Config: `/etc/cloudflared/config.yml` |
| `forum-analysis.service` | One-shot analysis pipeline | Runs `run_analysis.sh` |
| `forum-analysis.timer` | Every 15 minutes | `OnBootSec=5min`, `OnUnitActiveSec=15min` |
| `forum-apk-download.service` | Serves APKs on **:8090** | Directory: `~/Desktop/forum-releases` |

### Disable conflicting user service

If port 3000 is already taken:

```bash
systemctl --user stop forum-airlock-listener.service
systemctl --user disable forum-airlock-listener.service
```

Then use **only** `forum-backend.service` (system scope).

### Enable on boot

```bash
sudo systemctl enable forum-backend.service ollama.service cloudflared.service forum-analysis.timer forum-apk-download.service
```

### Health checks

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:8090/
curl https://listener.yourcommunity.forum/health
curl -i https://secure-worker.forum-community.workers.dev/api/civic/submit -H "Content-Type: application/json" -d '{}'
curl https://forum-egress.yourcommunity.forum
```

---

## 4. Cloudflare Configuration

### Tunnel (`/etc/cloudflared/config.yml`)

```yaml
tunnel: e0a398d3-e102-4793-af6f-722df8d921a1
credentials-file: /etc/cloudflared/e0a398d3-e102-4793-af6f-722df8d921a1.json

ingress:
  - hostname: listener.yourcommunity.forum
    service: http://127.0.0.1:3000
  - hostname: apk.yourcommunity.forum
    service: http://127.0.0.1:8090
  - service: http_status:404
```

User copy also at: `~/.cloudflared/forum-airlock.yml` (listener only — **do not** run duplicate `forum-cloudflared` user service if system `cloudflared` is active).

### Workers

| Worker | URL / route | Role |
|--------|-------------|------|
| `secure-worker` | `https://secure-worker.forum-community.workers.dev` | Serves pod PWA assets; proxies civic submit to listener |
| `forum-egress` | `https://forum-egress.yourcommunity.forum` | Receives analysis reports (POST + `X-Forum-Secret`); GET shows latest report |

**secure-worker** `wrangler.toml` vars (placeholders until real domains):

```toml
AIRLOCK_URL = "https://pod.yourcommunity.forum"
LISTENER_URL = "https://listener.yourcommunity.forum"
```

Secret: `AIRLOCK_SECRET` must match `/home/forum-user1/Desktop/forum.config.env`.

**forum-egress** KV:

```toml
kv_namespaces = [
  { binding = "FORUM_REPORTS", id = "f120d14428794dc490ade0b03db299b1" }
]
```

Secret: `FORUM_SECRET` must match `forum.config.env` (was regenerated during setup — re-sync if push returns 401).

---

## 5. File Structure And Key Scripts

### Desktop layout (unchanged — consolidation deferred)

```
~/Desktop/
  forum-pod/          # Personal pod + Capacitor Android
  forum-airlock/      # Listener + secure-worker assets
  forum-ai/           # vault.py, classify, aggregate, run_analysis.sh
  forum-egress/       # Egress Worker + report.json
  forum-releases/     # Published APKs + index.html
  forum.config.env    # Shared secrets and URLs
  deploy/             # Build, install, systemd templates, publish scripts
```

### Key pod files

| File | Purpose |
|------|---------|
| `forum-pod/src/pod-ui.jsx` | Main UI: Civic, Import, **Local SQL**, Settings |
| `forum-pod/src/pod-store.js` | IndexedDB persistence |
| `forum-pod/public/pillar-icon.svg` | In-app corner icon |
| `forum-pod/public/service-worker.js` | PWA cache `forum-pod-v2-sql-only` |
| `forum-pod/public/favicon.svg` | Pillar favicon |

### Key server / analysis files

| File | Purpose |
|------|---------|
| `forum-airlock/listener.js` | Express listener; `/submit`, `/api/civic/submit` |
| `forum-ai/run_analysis.sh` | classify → aggregate → push.py |
| `forum-ai/database_syncs/classify.py` | Ollama `smart-analyst`; writes `civic_sentiment_v2` |
| `forum-ai/database_syncs/aggregate.py` | **Deterministic** report text (no LLM prose) |
| `forum-ai/push.py` | POST report to `FORUM_EGRESS_URL` |
| `forum-egress/worker.js` | POST ingest + GET public HTML report |

### Deploy scripts

| Script | Purpose |
|--------|---------|
| `deploy/build-android-apk.sh` | Capacitor 6 APK build |
| `deploy/publish-android-apk.sh` | Copy APK to `forum-releases`, write `index.html` |
| `deploy/install-forum-server.sh` | User-level listener + analysis (legacy; prefer system units) |
| `deploy/install-phone-access.sh` | User cloudflared (legacy; prefer `/etc/cloudflared`) |
| `deploy/forum-apk-download.service` | Template for APK HTTP server |

---

## 6. Shared Config (`forum.config.env`)

```bash
# /home/forum-user1/Desktop/forum.config.env
AIRLOCK_SECRET=...          # Must match Worker secret
FERNET_KEY=...              # Must match vault.py encryption
LISTENER_URL=http://127.0.0.1:3000
FORUM_EGRESS_URL=https://forum-egress.yourcommunity.forum
FORUM_SECRET=...            # Must match forum-egress Worker secret
FORUM_AUTO_ANALYSIS=0       # Set 1 to trigger analysis after each submit (heavy)
```

Re-upload Worker secrets after changing:

```bash
cd ~/Desktop/forum-airlock
awk -F= '/^AIRLOCK_SECRET=/{print $2}' ../forum.config.env | npx wrangler secret put AIRLOCK_SECRET
npm run build:pod && npm run deploy:worker

cd ~/Desktop/forum-egress
# pipe FORUM_SECRET into wrangler secret put FORUM_SECRET
npx wrangler deploy
```

---

## 7. Local SQL Assistant (Pod)

The **Local SQL** tab:

- Preset buttons: Latest, Last 10, Failed Syncs, By ZIP, By Category
- Accepts direct `SELECT` / `WITH` queries
- Pattern-matched questions map to deterministic SQL (no model)
- **Never** uses model prose as truth — only executed DuckDB rows
- Read-only in this tab; use **SQL Editor** for mutating local tables

**Civic tab** shows **Device local ledger: N saved** — if this stays 0 after submit, IndexedDB write failed (debug before blaming SQL chat).

### What the pod cannot access

- Server `forum_inbound.db`
- Cloudflare D1
- Ollama on the server (unless dev proxy was enabled — removed from `vite.config.js`)
- Any path outside device IndexedDB + in-memory DuckDB

---

## 8. Analysis Pipeline Notes

### Ollama (server only)

- Model profile: `smart-analyst` (from `SmartAnalyst.Modelfile` → `mistral-nemo:12b-instruct-2407-q4_K_M`)
- Used in `classify.py` for sentiment/distillation into `civic_sentiment_v2`
- **Not** bundled in the Android app anymore

### Report accuracy

- **Problem:** LLM aggregation invented “Raw Human Emotion” quotes and fake resident statements.
- **Fix:** `aggregate.py` now builds reports from sanitized DB rows and counts only — no LLM narrative for final egress text.

### Verify ingestion / analysis

```bash
sqlite3 ~/Desktop/forum-ai/database_syncs/forum_inbound.db \
  "SELECT id, zip_code, receipt_id, created_at FROM forum_inbound ORDER BY created_at DESC LIMIT 5;"

sudo systemctl start forum-analysis.service
sudo journalctl -u forum-analysis.service -n 80 --no-pager
```

Expect: `SUCCESS: Report cleared egress.`

---

## 9. Build And Release Commands

### Android APK

```bash
cd ~/Desktop/forum-pod
rm -rf node_modules dist android/app/src/main/assets/public android/app/build/outputs/apk
unset JAVA_HOME
export ANDROID_HOME=$HOME/android-sdk
export PATH=$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH

bash ~/Desktop/deploy/build-android-apk.sh
bash ~/Desktop/deploy/publish-android-apk.sh
```

Verify release page timestamp and checksum:

```bash
cat ~/Desktop/forum-releases/SHA256SUMS.txt
grep "sql-only" ~/Desktop/forum-releases/index.html
```

### Confirm correct build on phone

Header must show: **`1.2-sql-only-no-ai`**

Tab must say: **Local SQL** (not AI Agent)

If not, you are on a cached/old APK — uninstall app, download **versioned** APK URL from `SHA256SUMS.txt`, not an old bookmark.

### Deploy PWA to Worker

```bash
cd ~/Desktop/forum-airlock
npm run build:pod
npm run deploy:worker
```

---

## 10. Known Issues / Warnings

### Wrong submit URL in Android Settings

| Wrong | Right |
|-------|-------|
| `https://listener.yourcommunity.forum` | `https://secure-worker.forum-community.workers.dev` |

Symptom: 403 Invalid Airlock Secret or connection errors.

### Port 3000 already in use

Symptom: `forum-backend.service` restart loop, `EADDRINUSE`.

Fix: Stop `forum-airlock-listener.service` (user) and any manual `node listener.js`.

### Worker secret mismatch

Symptom: `403` from Worker, or `401` from egress.

Fix: Re-run `wrangler secret put` from current `forum.config.env`.

### APK / PWA looks “unchanged”

Causes:

- Stable filename cached by browser/Cloudflare (`forum-personal-pod-debug.apk` is obsolete)
- Old service worker (`forum-pod-v1`)
- Same `versionCode` install

Fix: Use `forum-personal-pod-sql-only-v2.apk`, confirm `1.2-sql-only-no-ai` in UI, bump cache name if needed.

### APK size ~9MB is normal

DuckDB-WASM + Capacitor dominate size. Absence of WebLLM does not guarantee a much smaller APK.

### `FORUM_SECRET` placeholder

If `forum.config.env` still has `FORUM_SECRET=match-cloudflare-dashboard-FORUM_SECRET`, egress push will fail until aligned with Worker secret.

### Analysis logs: `civic_sentiment_v2` missing (historical)

`cron.log` showed missing table errors before schema/init; timer runs `init_schema.sql` in `run_analysis.sh`. Re-run analysis after new submissions.

### apk.yourcommunity.forum 404 / 502

- **502:** `forum-apk-download.service` not running or tunnel not restarted
- **404:** DNS not routed to tunnel — run `cloudflared tunnel route dns ... apk.yourcommunity.forum`

---

## 11. Immediate Next Steps

1. **Confirm phone runs build `1.2-sql-only-no-ai`** after installing from `forum-personal-pod-sql-only-v2.apk`.
2. **Test Local SQL → Latest** after a civic submit; compare with **Device local ledger** count on Civic tab.
3. **Replace placeholder domains** in `wrangler.toml` (`pod.yourcommunity.forum`, `listener.yourcommunity.forum`) with production hostnames if not already done in Cloudflare dashboard.
4. **Align `FORUM_SECRET`** in `forum.config.env` with Cloudflare and re-deploy `forum-egress`.
5. **Decide** whether to re-enable LLM-assisted *SQL generation* (optional, server-side Ollama only) — currently disabled in pod for anti-hallucination.
6. **Add signed release APK** workflow when moving beyond debug installs.
7. **Optional:** Consolidate `forum-*` folders under one repo root (user deferred this in session 2).

---

## 12. Strategic Next Goals

- Harden always-on server monitoring (`systemctl status`, log rotation on `cron.log`).
- QR code or baked-in cooperative URL for Android fleet deploy.
- Export/import backup for local pod IndexedDB data.
- Tighten classify/aggregate idempotency (avoid re-processing all rows every 15 min).
- Public pod domain separate from `secure-worker.forum-community.workers.dev` if branding requires it.
- Review whether server analysis should run on submit (`FORUM_AUTO_ANALYSIS=1`) vs timer-only.

---

## 13. Current Mental Model

1. **Android app** = downloadable personal pod; data lives on device first.
2. **Cooperative server** = always-on ingest + batch analysis + public report; not queried by the app for civic history.
3. **Cloudflare Worker** = public front door for submit and (optionally) hosted PWA.
4. **Tunnel** = exposes private listener and APK download server only.
5. **Local SQL tab** = truth interface for the user’s own data; if it disagrees with memory or an old “AI” answer, trust the query result table.

**Success criterion for next session:** User submits civic feedback on phone → row appears in Device local ledger → Local SQL “Latest” returns exact comment/receipt → row appears in server `forum_inbound` → report updates on `forum-egress.yourcommunity.forum` without fabricated quotes.
