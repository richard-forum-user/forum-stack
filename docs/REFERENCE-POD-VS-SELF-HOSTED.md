# Reference pod vs self-hosted pod

| | Reference pod (`airlock.yourcommunity.forum`) | Self-hosted (Docker / Tauri / own Worker) |
|---|---------------------------------------------|----------------------------------------|
| **Who runs the Worker** | Cooperative Cloudflare account | You |
| **Storage model (airlock default)** | Browser IndexedDB local-first (H19) | SQLite / workerd / PersonalPodDO on your hardware |
| **Onboarding** | Open `/pod/` — no passkey required | Install from [Releases](https://github.com/richard-forum-user/forum-stack/releases) or `docker compose up` |
| **Co-op export** | Opt-in via Settings → share with cooperative | Same |

The cooperative pledges not to read reference-pod raw data; AGPL source + DPIA govern conduct. Members who need stronger guarantees should self-host with `forum-pod-airlock/` on their own Cloudflare account or the Tauri/desktop bundle.
