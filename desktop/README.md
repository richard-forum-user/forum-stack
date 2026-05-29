# Forum Pod desktop installer

This directory builds a one-click installer that bundles the Forum
Personal Pod for Windows, macOS, and Linux. End users download a
`.exe` / `.dmg` / `.AppImage` / `.deb`, double-click it, and a
self-contained Pod starts running on their own machine — no terminal,
no Docker, no Cloudflare account.

Under the hood:

* **Tauri** wraps the system webview (WebView2 on Windows, WebKit on
  macOS, WebKitGTK on Linux). No Chromium ships with the app, so the
  installer stays in the ~30–60 MB range.
* A **`workerd` sidecar** runs the same Pod Worker as the Cloudflare
  deploy. It listens on `127.0.0.1:<port>` only — never accepts
  connections from the network.
* All Pod data (encrypted SQLite for civic submissions, journal entries,
  Kami chat history, signing keys) lives in the OS app-data directory:
  * Linux: `~/.local/share/Forum Pod/`
  * macOS: `~/Library/Application Support/Forum Pod/`
  * Windows: `%APPDATA%\Forum Pod\`

## Build locally

```bash
# 1. Install Rust + Tauri prerequisites:
#    https://tauri.app/start/prerequisites/

# 2. Build the PWA bundle once:
cd ../forum-pod && npm install && npm run build
cd ../desktop

# 3. Fetch the workerd binaries for every target you want to build:
./scripts/fetch-workerd.sh

# 4. Build the installer for the current OS:
npm install
npm run tauri:build
```

The installer is written to
`src-tauri/target/release/bundle/<format>/`.

## CI

`.github/workflows/release-installers.yml` builds Windows, macOS
(x64 + arm64), Linux (AppImage + .deb), Android APK, and iOS IPA on
every `v*` tag. See [INSTALL.md](../INSTALL.md) for the user-facing
download links and verification steps.
