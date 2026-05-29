# Handover 17 — Installer + auto-updater pipeline is live

## Why

Handover 16 introduced the ownership-by-default architecture
(`forum-pod-solo` Tauri desktop installer, Capacitor mobile app, trial
pod with 7/30-day rails) but left the *delivery* pipeline as TODO:

- the GitHub repo did not exist yet,
- the Tauri auto-updater plugin was not wired,
- there was no GitHub Actions signing key configured,
- there was no `latest.json` updater manifest generator.

Handover 17 closes all four. After merging this work, tagging
`vX.Y.Z` produces signed installers for five platforms, publishes a
GitHub Release, and pushes auto-updates to every previously installed
desktop user.

## What changed in `forum-pod-solo`

### Auto-updater (Tauri side)

- `desktop/src-tauri/Cargo.toml`
  - Added `tauri-plugin-updater = "2"`, `tauri-plugin-process = "2"`,
    and `tokio = { version = "1", features = ["time"] }`.
- `desktop/src-tauri/src/main.rs`
  - Imports `tauri_plugin_updater::UpdaterExt`.
  - Adds `check_for_updates(app)` — calls `updater.check()`, then on
    a hit downloads + verifies the minisign signature with the
    embedded public key, then calls `app.restart()`.
  - In `tauri::Builder::default()`: registers
    `tauri_plugin_updater::Builder::new().build()` and
    `tauri_plugin_process::init()`, then spawns a background task
    that waits 5 s after launch (so workerd boot is unaffected) and
    calls `check_for_updates`.
- `desktop/src-tauri/tauri.conf.json`
  - New `plugins.updater` block: `active = true`, `dialog = true`,
    Windows install mode `passive`, embedded `pubkey` set to the
    minisign public key generated locally.
  - `endpoints` points at the GitHub Releases URL pattern
    `https://github.com/richard-forum-user/forum-pod-solo/releases/latest/download/latest.json`.
  - Repo `homepage` updated to the real GitHub URL.
- `desktop/src-tauri/capabilities/default.json`
  - Granted `updater:default`, `updater:allow-check`,
    `updater:allow-download-and-install`, `process:default`,
    `process:allow-restart`.
- `desktop/forum-pod.key.pub` — the minisign public key committed for
  audit / manual verification. Matches the `pubkey` inside
  `tauri.conf.json` byte-for-byte.

### `latest.json` manifest generator

- `desktop/scripts/build-latest-json.mjs`
  - Walks the artifacts directory produced by `tauri build`,
    pairs every `.sig` with its bundle, picks the correct
    Tauri-updater platform key (`darwin-aarch64`, `darwin-x86_64`,
    `linux-x86_64`, `linux-aarch64`, `windows-x86_64`,
    `windows-aarch64`),
  - Prefers updater-format bundles (`*.app.tar.gz`,
    `*.AppImage.tar.gz`, `*.msi.zip`, `*.nsis.zip`) when present and
    falls back to the installer artifact otherwise.
  - Writes a `latest.json` in the exact shape the Tauri updater
    expects, with URLs pointing at
    `https://github.com/<repo>/releases/download/v<version>/<filename>`.

### CI rewiring

- `.github/workflows/release-installers.yml`
  - Desktop matrix job now uploads `.sig` files alongside every
    installer/updater bundle (`*.dmg.sig`, `*.app.tar.gz.sig`,
    `*.AppImage.sig`, `*.AppImage.tar.gz.sig`, `*.deb.sig`,
    `*.msi.sig`, `*.msi.zip.sig`, `*-setup.exe.sig`,
    `*.nsis.zip.sig`).
  - New `release` job (gated on tag push) checks out the repo,
    downloads every per-platform artifact, runs
    `desktop/scripts/build-latest-json.mjs --artifacts artifacts
    --version <tag without v> --repo <owner/repo> --out latest.json`,
    and attaches the resulting `latest.json` to the GitHub Release
    alongside the bundles.
  - The release job passes `TAURI_SIGNING_PRIVATE_KEY` and
    `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` from GitHub Actions secrets
    into every desktop build so the minisign signing actually runs.

### URL clean-up

- README, INSTALL.md, `trial-pod-banner.jsx`, and Tauri config now
  reference the real repo (`richard-forum-user/forum-pod-solo`) instead
  of the `your-org/forum-pod-solo` placeholder. Trial banner's "Install
  Forum Pod" CTA links straight to `releases/latest`.

## Operational steps performed in this handover

1. `cd ~/Desktop/forum-pod-solo && git init -b main`
2. Initial commit (`Initial ownership-by-default pod release`, 177
   files, 21 667 insertions).
3. `gh repo create richard-forum-user/forum-pod-solo --public
   --source=. --remote=origin --push`. Repo is now live and `main`
   is pushed.
4. `gh api … actions/permissions/workflow` set
   `default_workflow_permissions=write` so the release workflow can
   publish releases.
5. `gh repo edit … --description … --homepage … --enable-issues=true`.
6. Generated minisign keypair locally with `npx -y
   @tauri-apps/cli@latest signer generate -w ~/.tauri/forum-pod.key`.
7. Embedded the public key into `tauri.conf.json` and committed it as
   `desktop/forum-pod.key.pub`.
8. Pushed both Actions secrets:
   `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/forum-pod.key`
   and `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (password
   piped via stdin so it never appears in process args). Verified
   with `gh secret list`.

## State at end of handover

| Surface | State |
| --- | --- |
| `richard-forum-user/forum-pod-solo` GitHub repo | Created, public, `main` pushed, Actions write-enabled. |
| Tauri minisign keypair | Generated locally at `~/.tauri/forum-pod.key{,.pub}` (passworded). Public half committed to repo. |
| `TAURI_SIGNING_PRIVATE_KEY` Actions secret | Set. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Actions secret | Set. |
| Updater client (desktop) | Plugin registered, capability granted, polls GitHub Releases 5 s after launch, restarts on update. |
| Updater manifest generator | `desktop/scripts/build-latest-json.mjs` ready. |
| Release workflow | `.github/workflows/release-installers.yml` ready. Fires on `v*` tag. |
| First release | **Not yet cut.** Run `git tag v0.1.0 && git push origin v0.1.0` to trigger. |

## What still needs human attention

1. **First tag.** `git tag v0.1.0 && git push origin v0.1.0` from
   `~/Desktop/forum-pod-solo` to cut the inaugural release. Five
   installers + Android APK + unsigned iOS IPA + `latest.json` will
   be attached to `releases/tag/v0.1.0`.
2. **Brand icons.** `desktop/src-tauri/icons/` still contains only the
   placeholder README. The Tauri bundler will refuse to build a
   release without the per-platform icons (`32x32.png`, `128x128.png`,
   `128x128@2x.png`, `icon.icns`, `icon.ico`). Generate from a single
   1024×1024 PNG via:

       npx @tauri-apps/cli icon ../../forum-pod/public/favicon.svg

3. **Android signing.** Workflow currently produces a debug APK
   because the `ANDROID_KEYSTORE_*` secrets are not set. For a Play
   Store / signed release flow add:

       gh secret set ANDROID_KEYSTORE_B64 < <(base64 -w0 release.keystore)
       gh secret set ANDROID_KEYSTORE_PASSWORD --body '…'
       gh secret set ANDROID_KEY_ALIAS         --body '…'
       gh secret set ANDROID_KEY_PASSWORD      --body '…'

4. **iOS signing.** The IPA is built unsigned today (good for
   AltStore / Sideloadly sideloading). App Store distribution needs
   Apple Developer signing credentials and a notarisation step.
5. **Trial pod deploy.** `cd ~/Desktop/forum-pod-solo/forum-airlock &&
   npx wrangler deploy --env trial` once to flip
   `airlock.yourcommunity.forum` into trial mode (`IS_TRIAL_POD=1`).
   The default deploy at `secure-worker.forum-community.workers.dev`
   stays as-is.
6. **Key-rotation plan.** The signing key currently sits only in
   `~/.tauri/forum-pod.key` on the dev box. Before mainstream
   distribution, copy it into a password manager and document a
   rotation policy. If the key is lost or the password is forgotten,
   already-installed clients can no longer receive updates and would
   need a fresh install with a re-keyed binary.

## Cross-repo notes

This handover lives in `forum-stack/Handovers/` because the cooperative
repo is the canonical project history. The implementation lives in
`forum-pod-solo` (created this handover). No code changes are required
in `forum-stack` itself; `coop-pipeline` Worker, D1 schema, and the
civic-contest endpoints remain exactly as Handover 15 left them.
