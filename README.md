# forum-stack

Monorepo for the Forum cooperative: **personal Pod** (PWA, mobile, desktop)
plus **cooperative pipeline** (D1 ingest, aggregate analysis, egress, membership).

Public repo: **https://github.com/richard-forum-user/forum-stack**

## Components

| Path | Worker / role | Deploy target |
|------|---------------|---------------|
| `forum-pod/` | PWA + Capacitor shell (shared UI) | Built into `forum-pod-airlock/dist` |
| `forum-pod-airlock/` | `secure-worker` — Pod UI, WebAuthn, PersonalPodDO, Civic AI | `airlock.yourcommunity.forum`, `pod.yourcommunity.forum` |
| `forum-airlock/` | `coop-pipeline` — feedback ingest, analysis, recovery, membership | `coop.yourcommunity.forum` |
| `forum-egress/` | Public aggregate reports (KV) | `forum-egress` worker |
| `desktop/` | Tauri installer + bundled workerd sidecar | GitHub Releases on `v*` tags |
| `deploy/` | systemd, cloudflared, APK host helpers | On-prem ops |

## Deploy

### Cooperative pipeline

```bash
cd forum-airlock
npm install
npx wrangler deploy
npx wrangler d1 execute forum-db --remote --file migrations/0001_schema_mirror.sql
```

### Airlock Pod (browser PWA)

```bash
cd forum-pod-airlock
npm install
npm run build:pod
npx wrangler deploy
```

### Local development (Pod UI only)

```bash
cd forum-pod
npm install
npm run dev    # http://localhost:5173
```

### Desktop / mobile installers

Tag `vX.Y.Z` to run `.github/workflows/release-installers.yml`. See [INSTALL.md](INSTALL.md).

## Data flow

1. User writes data locally (IndexedDB on airlock, SQLite on native, or PersonalPodDO when self-hosting).
2. Opt-in share → `POST coop…/api/forum/feedback` (signed bundle).
3. Cooperative publishes aggregate report; raw rows get a 7-day contest window then hard-delete from D1.
4. User Pod / export retains the sole copy of raw content.

## Handovers

Read [Handovers/21-reconsolidate-monorepo.md](Handovers/21-reconsolidate-monorepo.md) for the current layout, then
[Handovers/15-coop-pipeline-split.md](Handovers/15-coop-pipeline-split.md) for cooperative vs Pod worker boundaries.

## License

AGPL-3.0
