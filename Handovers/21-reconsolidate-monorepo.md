# Handover 21 — Re-consolidate monorepo into forum-stack

Prior: [20-cooperative-sync-aggregate-refresh.md](20-cooperative-sync-aggregate-refresh.md).

User intent:

> I've deleted the old [forum-pod-solo] repo. Use forum-stack again.

Handover 15 split the stack into two GitHub repos. With `forum-pod-solo` removed,
all live code returns to **one public repo**: `richard-forum-user/forum-stack`.

---

## 1. Layout after re-consolidation

```
forum-stack/
  forum-pod/              PWA + Capacitor source (from forum-pod-solo)
  forum-pod-airlock/      secure-worker @ airlock.* / pod.*  (NEW name)
  forum-airlock/          coop-pipeline @ coop.*           (unchanged role)
  forum-egress/
  desktop/                Tauri + workerd sidecar
  .github/workflows/      release-installers.yml
  deploy/
  docs/
  Handovers/
  INSTALL.md
  Dockerfile / docker-compose.yml
```

**Naming rule (option 1):** the cooperative worker keeps the historical folder
name `forum-airlock/`. The personal Pod Worker moves to `forum-pod-airlock/` so
two different `wrangler.toml` files never fight in one directory.

---

## 2. What was copied from local `forum-pod-solo`

| Source | Destination |
|--------|-------------|
| `forum-pod/` | `forum-stack/forum-pod/` (latest H16–H20 client) |
| `forum-airlock/` | `forum-stack/forum-pod-airlock/` |
| `desktop/` | `forum-stack/desktop/` |
| `.github/workflows/release-installers.yml` | same path |
| `INSTALL.md`, `Dockerfile`, `docker-compose.yml` | repo root |

Cooperative-side H18–H20 work (`recovery-do.js`, civic auto-refresh, local-credential ingest) **stays** in `forum-airlock/` and was not overwritten.

---

## 3. Pod worker fixes bundled with the merge

| File | Change |
|------|--------|
| `forum-pod-airlock/ai-chat.js` | Restored from git `main` (removed during production-poc hardening) |
| `forum-pod-airlock/secure-worker.js` | Wired `POST /api/ai/chat`; local-credential unlock bypass |
| `forum-pod-airlock/unlock-token.js` | Added `isLocalDeviceCredentialId()` |
| `forum-pod-airlock/ai-chat.js` | Same local-credential bypass for browser-local Kami |

---

## 4. URL / path updates

All references to `forum-pod-solo` or `richard-forum-user/forum-pod-solo` retargeted to `forum-stack`:

- `README.md`, `INSTALL.md`, `forum-stack.sh`
- `desktop/src-tauri/tauri.conf.json` (updater endpoint + homepage)
- `forum-pod/src/trial-pod-banner.jsx`
- `.github/workflows/release-installers.yml` (stages worker from `forum-pod-airlock/`)
- `Dockerfile` (self-host image uses `forum-pod-airlock/`)

Historical handovers 15–20 still mention `forum-pod-solo` in past tense — left unchanged for audit trail.

---

## 5. Deploy commands (post-merge)

```bash
# Cooperative pipeline
cd ~/Desktop/forum-stack/forum-airlock
npx wrangler deploy

# Airlock PWA + Pod worker
cd ~/Desktop/forum-stack/forum-pod-airlock
npm run build:pod && npx wrangler deploy

# Pod UI dev
cd ~/Desktop/forum-stack/forum-pod && npm run dev

# Installers (after icons + secrets)
git tag v0.1.0 && git push origin v0.1.0
```

---

## 6. Still outstanding (unchanged from H17–H20)

| Item | Notes |
|------|-------|
| Tauri brand icons | `desktop/src-tauri/icons/` — generate before first release |
| GitHub Release `v0.1.0` | Workflow ready; tag when icons exist |
| Android keystore secrets | CI still builds debug APK without them |
| JSON import UI | Export exists; round-trip import not built |
| R2 Iceberg aggregate lake | Future |
| `APP_BUILD` footer bump | Cosmetic |

---

## 7. Mental model

Two Workers, one repo:

```
forum-pod (UI) ──build:pod──► forum-pod-airlock/dist
                                    │
                                    ▼
                         secure-worker @ airlock.*
                         (Pod RPC, WebAuthn, Kami, assets)

forum-pod ──opt-in share──► forum-airlock (coop-pipeline)
                                    │
                                    ▼
                         D1 + analysis + recovery + egress
```

If a path in an old handover says `forum-pod-solo/forum-airlock`, read it as
`forum-stack/forum-pod-airlock`. If it says `forum-stack/forum-airlock` for
cooperative routes, that is still correct.
