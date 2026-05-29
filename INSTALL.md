# Install Forum Pod

Forum Pod is your personal data Pod for the Forum cooperative. Once
installed, every civic submission, journal entry, behavior, trait, and
Civic AI Kami conversation lives on **your** device, in an encrypted
SQLite vault. Nothing leaves your machine unless you explicitly opt in
to share it with the cooperative.

> **No terminal, no Docker, no Cloudflare account.** Pick your platform
> below, double-click, and you're done.

## Pick your platform

| Platform | Download | What you get |
| --- | --- | --- |
| **Windows 10/11** | `Forum-Pod_<version>_x64-setup.exe` | One-click installer. App lives in *Start menu → Forum Pod*. |
| **macOS (Apple silicon)** | `Forum-Pod_<version>_aarch64.dmg` | Drag-and-drop into Applications. |
| **macOS (Intel)** | `Forum-Pod_<version>_x64.dmg` | Drag-and-drop into Applications. |
| **Linux (Ubuntu / Debian)** | `forum-pod_<version>_amd64.deb` | Double-click, *Software* opens; click **Install**. |
| **Linux (other)** | `Forum-Pod_<version>_amd64.AppImage` | Double-click. No install required. |
| **Android 10+** | `forum-pod-release.apk` | Open the APK, tap **Install**. |
| **iPhone / iPad (sideload)** | `forum-pod-ios-unsigned.ipa` | Install via [AltStore](https://altstore.io) or [Sideloadly](https://sideloadly.io). |

All downloads live at:
[github.com/richard-forum-user/forum-stack/releases/latest](https://github.com/richard-forum-user/forum-stack/releases/latest)

## What happens on first launch

1. The app starts a tiny local server on `127.0.0.1` (desktop) or
   spins up an on-device SQLite database (Android / iOS). Nothing is
   exposed to the network.
2. The Pod UI opens and asks you to **register a passkey** with your
   fingerprint, Face ID, Windows Hello, or a hardware security key.
3. You're in. Civic submissions, the journal, the Kami assistant — all
   working offline.

## Where your data lives

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Forum Pod\pod-data\` |
| macOS | `~/Library/Application Support/Forum Pod/pod-data/` |
| Linux | `~/.local/share/Forum Pod/pod-data/` |
| Android | App-private storage (not visible to other apps) |
| iOS | `Library/CapacitorDatabase/` inside the app sandbox |

Back this folder up like you would family photos. To migrate to a new
device, copy the folder over before launching the app there.

## Try without installing (cooperative trial pod)

Not ready to install? You can poke at a Pod at
**[airlock.yourcommunity.forum](https://airlock.yourcommunity.forum/pod)**.
It runs on cooperative servers and:

* shows a yellow banner after 7 days asking you to install,
* **auto-wipes everything after 30 days** if you have not graduated to
  a local install,
* never shares your data with the cooperative unless you opt in.

When you're ready, install the app for your platform from this page;
the welcome flow walks you through exporting the trial pod's data and
importing it into your local Pod (`/import-state` endpoint).

## Verifying downloads

Each release ships with an `installer.sig` (Ed25519). The desktop app
is signed with the Forum Cooperative release key; verify with:

```bash
# Ed25519 public key is published at
#   https://yourcommunity.forum/.well-known/forum-pod-release.pub
openssl dgst -sha256 -verify forum-pod-release.pub \
  -signature Forum-Pod_<version>.dmg.sig \
  Forum-Pod_<version>.dmg
```

Android APKs are signed with the standard Android signing chain;
inspect with `apksigner verify --print-certs`.

## Self-hosting on your own Cloudflare account (advanced)

Prefer to run the Pod Worker on your own infrastructure? See
[docs/SELF-HOSTING-DOCKER.md](docs/SELF-HOSTING-DOCKER.md) for the
Docker path and [forum-airlock/wrangler.toml](forum-airlock/wrangler.toml)
for the Cloudflare deploy.

## Building from source

See [desktop/README.md](desktop/README.md) for the Tauri build,
[forum-pod/README.md](forum-pod/README.md) for the PWA build, and the
`.github/workflows/release-installers.yml` workflow for the exact CI
recipe used by official releases.
