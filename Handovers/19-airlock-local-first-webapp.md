# Handover 19 — Airlock local-first browser web app

Prior: [18-recovery-identity-do.md](18-recovery-identity-do.md).

Deployed 2026-05-29 on `airlock.yourcommunity.forum` (Worker `secure-worker`,
version `6c9e612e-35c3-429a-96c9-02a407e65c67` at time of writing).

User intent:

> The device local pods are giving us trouble. … use the existing browser-side
> web app with the ability to export all data locally, putting data security
> responsibility on them.

This handover pivots the **airlock PWA** from "cooperative-managed trial Pod
(Durable Object + passkey)" to **browser-local ownership**: raw data in
IndexedDB, optional cooperative share, self-custody JSON export, no passkey
required to create a Pod on `airlock.yourcommunity.forum`.

Native installs (Capacitor APK / Tauri) keep their H16 paths — on-device SQLite
or bundled workerd — and do not use this airlock flow.

---

## 1. What changed at a glance

| Before | After |
|--------|-------|
| Download portal gate before sign-in | Sign-in overlay loads immediately |
| `createPodFlow()` → WebAuthn + DO provision on airlock | `createLocalPodFlow()` → local credential + IndexedDB only |
| Boot hydrates from PersonalPodDO RPC | Boot hydrates from IndexedDB (`hydrateFromLocalStore`) |
| Civic writes mirror to cloud DO | `solid-pod-write.js` skips DO writes for `browser-local` / `local-device` |
| No portable export | Settings → **Download my data (JSON)** |
| Service worker cache `forum-pod-v3-*` | `forum-pod-v4-webapp-local` |

---

## 2. Ownership modes (`pod-adapter.js`)

| Mode | When | Storage |
|------|------|---------|
| `browser-local` | `VITE_WEBAPP_LOCAL_FIRST=1` or host is `airlock.yourcommunity.forum` | IndexedDB via `pod-store.js` |
| `local-device` | Capacitor / Tauri native | SQLite adapter or local workerd |
| `cloud-pod` | Self-hosted / legacy HTTP Pod URL | PersonalPodDO over HTTP |

`ownershipMode()` drives every write/sync path. Airlock build sets
`VITE_WEBAPP_LOCAL_FIRST=1` in `forum-airlock/package.json` → `build:pod`.

---

## 3. Files added / changed (`forum-pod-solo`)

### New

| File | Purpose |
|------|---------|
| `forum-pod/src/local-data-export.js` | `buildLocalDataExport()` / `downloadLocalDataExport()` — full JSON dump of IndexedDB + profile + recovery state. |

### Removed

| File | Reason |
|------|--------|
| `forum-pod/src/download-portal.jsx` | Airlock goes straight to Pod UI; installers live on GitHub Releases (H17). |

### Modified (key paths)

| File | Change |
|------|--------|
| `pod-solid-integration.js` | `createLocalPodFlow()` for airlock + native; registers signing key with coop; skips `podRpc("PROVISION")` on airlock. |
| `webauthn-member.js` | `buildLocalDeviceProfile()` mints `local-*` credential (distinct from `pilot-*`). |
| `solid-pod-write.js` | No cloud DO writes when `ownershipMode()` is `browser-local` or `local-device`. |
| `solid-sync.js` | Same guard for sync-from-cloud paths. |
| `pod-ui.jsx` | `isLocalWebApp` moved above first use (fixes TDZ black screen); `hydrateFromLocalStore()` on boot; journal/submit works without DuckDB `conn`; export button in Settings; cooperative share UX copy. |
| `sign-in-overlay.jsx` | Airlock shows local Pod badge; recovery phrase flow; no passkey gate for create on airlock. |
| `forum-pod/public/service-worker.js` | Cache bump to `forum-pod-v4-webapp-local`. |

---

## 4. Airlock build + deploy

```bash
cd ~/Desktop/forum-pod-solo/forum-airlock
npm run build:pod    # sets VITE_BASE=/pod/, VITE_WEBAPP_LOCAL_FIRST=1, coop URL
npx wrangler deploy  # serves dist/ at airlock.yourcommunity.forum/pod/
```

Build env baked in by `build:pod`:

```
VITE_BASE=/pod/
VITE_WEBAPP_LOCAL_FIRST=1
VITE_SERVER_URL=https://airlock.yourcommunity.forum
VITE_POD_PROVIDER_URL=https://airlock.yourcommunity.forum
VITE_COOP_URL=https://coop.yourcommunity.forum
VITE_ALLOW_PILOT_FALLBACK=0
```

---

## 5. Mobile Chrome fixes included in this handover

### Black screen (TDZ)

`isLocalWebApp` was referenced in `submitJournalEntry` before its `useMemo`
declaration → `ReferenceError` on load. Fixed by moving the `useMemo` to the top
of `PersonalPod`.

### Session cache / DuckDB on mobile

Boot previously called `hydrateFromPod()` → DO RPC → failed on mobile when
airlock DO was not in the loop. Now uses `hydrateFromLocalStore()` for
`browser-local`. DuckDB-WASM falls back to IndexedDB-only when pthread bundle
fails (common on mobile Chrome).

**After deploy:** users on stale service workers should clear site data for
`airlock.yourcommunity.forum` or hard-refresh twice so
`forum-pod-v4-webapp-local` installs.

---

## 6. User-facing flow (airlock)

1. Open `https://airlock.yourcommunity.forum/pod/`
2. **Create a new Pod** — no passkey; local Ed25519 key + IndexedDB profile.
3. Write journal / civic submissions — stored locally immediately.
4. Settings → enable **Share with cooperative** (opt-in).
5. Settings → **Download my data (JSON)** for self-custody backup.
6. Optional: enroll **Account recovery phrase** (H18).
7. Submissions with share enabled sync to `coop.yourcommunity.forum`; raw wiped
   from cloud after 7 days; aggregate report retained (H20).

---

## 7. What still works on native (unchanged from H16)

| Platform | Path |
|----------|------|
| Android / iOS APK | `createLocalPodFlow()` + Capacitor SQLite — no airlock, no WebAuthn |
| Tauri desktop | Bundled workerd sidecar — no airlock |
| Self-hosted DO | `cloud-pod` mode when `VITE_POD_PROVIDER_URL` points at a DO host |

---

## 8. Known follow-ups

| Item | Notes |
|------|-------|
| Bump `APP_BUILD` string | Still shows `secure-pod-v1.9-civic-ai` in UI footer — cosmetic only. |
| Trial pod (`--env trial`) | Separate deploy path for 30-day DO trial; airlock default deploy is now local-first, not trial-DO-first. |
| Import from JSON export | Export exists; round-trip import UI not yet built. |
| Scheduled wipe cron hardening | Contest window + `wipe-expired` exist; scheduled reliability called out in local-ownership plan. |
