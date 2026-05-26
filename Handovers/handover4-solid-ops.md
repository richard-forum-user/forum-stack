# Handover 4 — Solid ops, npm fix, and local bring-up

**Date:** 2026-05-19  
**Build:** `1.3-solid-webauthn`  
**Prior:** [handover3-solid.md](handover3-solid.md) → [handover2.md](handover2.md)

This handover is for the next operator or agent session: what was built, how to start it, and how to recover from the first real install failure (CSS npm 404).

---

## 1. What you are running

| Piece | Repo path | Port | Role |
|-------|-----------|------|------|
| Community Solid Server (CSS) | `~/Desktop/forum-solid` | **3456** | Pod host, Solid-OIDC issuer |
| Provision bridge | `~/Desktop/forum-solid` | **3457** | Maps WebAuthn `credentialId` → WebID / container paths after registration |
| Personal Pod (Vite) | `~/Desktop/forum-pod` | **5173** (dev) | Local-first UI + Solid client |
| Airlock listener | `~/Desktop/forum-airlock` | **3000** | Signed opt-in export, member registry |
| Secure worker | Cloudflare | HTTPS | Proxies `/api/civic/export` (no `AIRLOCK_SECRET` in APK) |

**Data flow (happy path):**

```
WebAuthn (device) → POST /api/register-member → provision-bridge → Pod paths
Solid-OIDC login → PUT civic JSON-LD to Pod (civic/ container)
Opt-in checkbox ON → POST /api/civic/export (Ed25519 SignedBundle) → vault → forum-ai → egress (after 7-day review)
```

Local IndexedDB + DuckDB always win for offline; Pod and cooperative paths are additive.

---

## 2. npm 404 — root cause and fix

### Symptom

```text
npm ERR! 404 Not Found - GET https://registry.npmjs.org/@solid-community%2fcommunity-solid-server
'@solid-community/community-solid-server@^7.0.0' is not in this registry.
```

### Cause

The migration plan and an older `forum-app` dependency used a **non-existent** scoped name. The published package is:

- **Correct:** `@solid/community-server` ([npm](https://www.npmjs.com/package/@solid/community-server))
- **Wrong:** `@solid-community/community-solid-server`

### Fix (already applied in `forum-solid/package.json`)

```json
"dependencies": {
  "@solid/community-server": "^7.1.0",
  "express": "^4.21.0"
}
```

Scripts still invoke the `community-solid-server` CLI from that package’s `node_modules/.bin`.

### After fix — reinstall CSS

```bash
cd ~/Desktop/forum-solid
rm -rf node_modules package-lock.json   # only if a failed install left junk
npm install
npm run start
```

You should see CSS listening on **http://127.0.0.1:3456** (not just the provision bridge on 3457).

### Note on `forum-app`

`~/Desktop/forum-app/package.json` may still list the wrong package if you run CSS from there. Prefer **`forum-solid`** for Pod hosting; do not duplicate CSS installs unless you align that `package.json` too.

---

## 3. Three-terminal dev startup (correct order)

### Terminal A — Solid Server (must be first)

```bash
cd ~/Desktop/forum-solid
npm install
npm run start
```

- First boot: open **http://localhost:3456/.setup** (or `/setup` per CSS version) and complete CSS instance setup if prompted.
- `config/config.json` already imports OIDC + password account handlers; `global.baseUrl` is `http://localhost:3456` for dev.
- Data dirs: `./data` (created on first run).

### Terminal B — Provision bridge

```bash
cd ~/Desktop/forum-solid
npm run provision-bridge
```

Expected log:

```text
[provision-bridge] listening on :3457 (POD_BASE=http://localhost:3456)
```

If CSS is **not** running, bridge may still listen but **provision calls will fail** until 3456 is up.

### Terminal C — Personal Pod app

```bash
cd ~/Desktop/forum-pod
npm install
cp -n .env.example .env    # do not overwrite an existing .env
npm run dev
```

Open the Vite URL (usually `http://localhost:5173`).

### Optional Terminal D — Cooperative listener (opt-in export testing)

```bash
cd ~/Desktop/forum-airlock
npm install
# set DATABASE_URL / secrets per forum-airlock README
node listener.js
```

Point Settings **cooperative URL** at your listener or secure-worker origin.

---

## 4. App configuration (`forum-pod/.env`)

From `.env.example`:

| Variable | Dev value | Purpose |
|----------|-----------|---------|
| `VITE_SOLID_ENABLED` | `true` | Disables legacy `btoa` `/api/civic/submit` auto-sync |
| `VITE_POD_PROVIDER_URL` | `http://localhost:3456` | CSS base; OIDC issuer |
| `VITE_PROVISION_BRIDGE_URL` | `http://127.0.0.1:3457` | Post–WebAuthn provisioning |
| `VITE_SERVER_URL` | worker URL | Edge proxy for cooperative APIs |
| `VITE_OIDC_CLIENT_ID` | `forum-personal-pod` | Must match CSS OIDC client registration |

**Production:** set `VITE_POD_PROVIDER_URL` / `VITE_OIDC_ISSUER` to `https://pod.yourcommunity.forum` and register redirect URIs:

- `http://localhost:5173/` (dev)
- `forumpod://callback` (Capacitor)
- Worker `/pod` URL if using hosted PWA

---

## 5. Operator checklist (first session)

1. [ ] `forum-solid`: `npm install` succeeds (no 404).
2. [ ] `npm run start` — CSS responds at `http://localhost:3456`.
3. [ ] `npm run provision-bridge` — port 3457.
4. [ ] `forum-pod`: `npm install` + `npm run build` (catches missing `@inrupt/*`).
5. [ ] Settings → **Create Pod** (WebAuthn) → confirm provision bridge logs a mapping.
6. [ ] **Log in to Pod** (Solid-OIDC) when CSS accounts/OIDC client exist.
7. [ ] Submit civic item → row in IndexedDB; after login, Pod write or `pending_pod_sync` queue.
8. [ ] Opt-in cooperative share **off** by default → no export POST.
9. [ ] Opt-in **on** → signed `POST /api/civic/export` (via worker or direct listener).

---

## 6. Code map (where to debug)

| Concern | Files |
|---------|--------|
| WebAuthn + member record | `forum-pod/src/webauthn-member.js`, `member-store.js` |
| OIDC session | `forum-pod/src/solid-session.js` |
| RDF write / queue | `forum-pod/src/civic-vocab.js`, `solid-pod-write.js`, `pod-store.js` |
| Pod → DuckDB hydrate | `forum-pod/src/solid-sync.js`, `pod-ui-sync.js` |
| Opt-in export | `forum-pod/src/cooperative-export.js`, `pod-signing.js` |
| UI wiring | `forum-pod/src/pod-ui.jsx`, `pod-solid-integration.js` |
| Provision API | `forum-solid/provision-bridge.js` |
| CSS config | `forum-solid/config/config.json` |
| Listener / vault | `forum-airlock/listener.js`, `schema.sql` |
| Edge proxy | `forum-airlock/secure-worker.js` (`/api/civic/export`) |
| Art VII lifecycle | `forum-ai/database_syncs/report_lifecycle.py`, `push.py` |
| Governance docs | `forum-pod/docs/` |

---

## 7. Production deploy pointers

- **systemd:** `~/Desktop/deploy/forum-solid.service` — `WorkingDirectory` = `forum-solid`; run `npm install` once as deploy user.
- **Tunnel:** `~/Desktop/deploy/cloudflared-pod-ingress.example.yml` — hostname `pod.yourcommunity.forum`.
- **CSS `baseUrl`:** edit `forum-solid/config/config.json` → `global.baseUrl` to public HTTPS URL before go-live.
- **Counsel / entity:** cooperative articles and counsel gate are documented in `forum-pod/docs/`; not blocking local dev.

---

## 8. Known gaps (post-v1 / not blocking local dev)

- **ZK contestation (Art VII):** deferred; hooks in lifecycle schema only.
- **Campaign Buyer / marketplace:** out of scope for this migration.
- **CSS on device:** not bundled in APK; app assumes reachable `VITE_POD_PROVIDER_URL`.
- **Automated E2E:** no CI job yet for WebAuthn + OIDC + Pod PUT; manual checklist above.

---

## 9. If something still fails

| Problem | Check |
|---------|--------|
| `npm install` 404 on CSS | Confirm `package.json` has `@solid/community-server`, not `@solid-community/...` |
| Bridge up, CSS down | Start `npm run start` in `forum-solid` |
| OIDC redirect error | CSS client ID + redirect URI list; Capacitor `forumpod://callback` |
| Pod write skipped | Not logged in → expected; queue `pending_pod_sync` |
| Export 401/403 | Register signing key; `consent: true` in bundle; rate limits on listener |
| Inrupt import error | `cd forum-pod && npm install` |
| Legacy sync still firing | `VITE_SOLID_ENABLED=false` re-enables old path — keep `true` for Solid mode |

---

## 10. Related docs

- `~/Desktop/README-SOLID-MIGRATION.md` — short ops index  
- `~/Desktop/README-PERSONAL-POD.md` — full stack “what runs where”  
- `forum-pod/docs/governance-operating-model.md`  
- `forum-pod/docs/requirements-traceability.md`  
- Plan (read-only): `~/.cursor/plans/solid_pod_migration_403b1384.plan.md`

**Do not edit the plan file** when implementing follow-ups; update this handover chain instead.
