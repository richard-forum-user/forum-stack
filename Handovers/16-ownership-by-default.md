# Handover 16 — Ownership by default

## Why

Handover 15 (`15-coop-pipeline-split.md`) split the monorepo into
`forum-stack` (cooperative pipeline) and `forum-pod-solo` (personal
Pod). It left the cooperative-managed Worker at
`airlock.yourcommunity.forum` as the practical default Pod, with
Docker as the "advanced" self-hosting path. That kept us in a
soft-cloud-lock-in posture: the path of least resistance was still
"use the cooperative's Pod".

Handover 16 makes **self-hosted** the default. A non-technical user
downloads an installer for their device, double-clicks it, and gets a
permanent, locally-owned Pod. The cooperative Worker is repositioned
as a 30-day trial that nudges users into a real install.

## What changed in `forum-pod-solo`

### New top-level pieces

* `INSTALL.md` — one-page per-platform download + first-launch guide.
* `desktop/` — Tauri scaffold that bundles a `workerd` sidecar.
  * `desktop/src-tauri/src/main.rs` finds a free localhost port,
    renders `workerd-config.capnp` with that port + the user's
    app-data dir, and supervises the `workerd` child process.
  * `desktop/scripts/fetch-workerd.sh` downloads the right workerd
    binary per Rust target triple during build.
* `.github/workflows/release-installers.yml` — builds Windows / macOS
  (x64 + arm64) / Linux desktop installers, an Android APK, and an
  unsigned iOS IPA on every `v*` tag and attaches them to the
  GitHub Release.

### Pluggable Pod adapter

* `forum-pod/src/pod-adapter.js` picks a transport based on platform:
  HTTP (Tauri / browser / self-hosted Cloudflare) or in-process
  `@capacitor-community/sqlite` (Android / iOS).
* `forum-pod/src/pod-adapter-http.js` is the existing HTTP transport
  cleanly extracted out of `solid-session.js`.
* `forum-pod/src/pod-adapter-capacitor.js` is the new mobile transport;
  it loads `@capacitor-community/sqlite` only when running natively
  and delegates to `pod-core.js`.
* `forum-pod/src/pod-core.js` is an async, db-agnostic copy of the
  Durable Object dispatch logic. The Cloudflare DO
  (`forum-airlock/pod-do.js`) still has its own synchronous impl,
  which stays the canonical schema source until we migrate the DO to
  use `pod-core`.

### Defaults flipped to local

* `forum-pod/.env.example` no longer points `VITE_SERVER_URL` at the
  cooperative pod. Empty → adapter picks the right local backend.
* `forum-pod/capacitor.config.json` enables iOS scheme + the SQLite
  plugin and adds `coop.yourcommunity.forum` to allowed nav.

### Trial pod

* `forum-airlock/pod-do.js` adds:
  * `META_KEY_LAST_TOUCH` and `META_KEY_GRADUATED` meta.
  * `trialHeaders()` emitting
    `X-Pod-Trial-Status: age=<d>;banner=<0|1>;wipe_in_days=<n>`.
  * `alarm()` that DELETEs every table after 30 days unless the user
    has graduated.
  * `POST /membership/graduated` (sets the meta flag).
  * `GET /membership/trial-status` (used by the PWA banner).
* `forum-airlock/secure-worker.js` forwards `X-Pod-Trial-Status`
  upstream when `env.IS_TRIAL_POD === '1'`.
* `forum-airlock/wrangler.toml` gains an `[env.trial]` block that sets
  `IS_TRIAL_POD = "1"`. Cooperative deploys with
  `wrangler deploy --env trial`; everyone else gets the default
  (permanent) deploy.

### Trial banner

* `forum-pod/src/trial-pod-banner.jsx` is a small standalone component
  mounted in `main.jsx` above `PersonalPod`. It listens to the
  `pod:trial-status` window event the HTTP adapter dispatches plus
  polls `/membership/trial-status` and renders a yellow → red banner
  with a one-click "Install Forum Pod" link.

## What changed in `forum-stack`

Nothing structural. This handover is recorded here so the
`forum-stack` repo's Handovers index continues to be the canonical
project history.

## Operational notes

* `wrangler deploy` (no `--env`) deploys the **self-host-friendly**
  variant of the Pod Worker. This is what users would deploy to their
  own Cloudflare account.
* `wrangler deploy --env trial` deploys the trial variant to
  `airlock.yourcommunity.forum`. **Run this once after merging.**
* The cooperative D1 (`forum-db`) is unchanged.
* The `PersonalPodDO` migration tag (`v1`) is unchanged; the schema
  change adds rows to `pod_meta`, no DDL migration needed.

## What still needs human attention

1. **Brand assets.** `desktop/src-tauri/icons/` needs real icons before
   the first signed installer release.
2. **Tauri signing key.** Generate via
   `npx tauri signer generate` and add the keypair to GitHub Actions
   secrets (`TAURI_SIGNING_PRIVATE_KEY` +
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
3. **iOS signing.** The CI builds an unsigned IPA today. For App Store
   distribution we need Apple Developer credentials and a notarisation
   step; for AltStore sideload the unsigned IPA is sufficient.
4. **GitHub repo settings.** Tag protection + Releases write
   permission for the workflow.
5. **Cooperative trial-pod migration.** Once the trial banner is live
   for ~30 days, audit how many users actually graduate vs. let their
   data wipe. If wipe-rate is too high, the banner copy / install UX
   needs another pass.
