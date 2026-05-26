# forum-stack

A local-first personal civic data pod and the cooperative infrastructure
behind it. The device (PWA or Capacitor APK) is the source of truth for
the user's data; the cooperative only sees what the user explicitly
opts to share, and only ever sees counts plus a device-derived hash —
never raw identifiers.

Current build: **`secure-pod-v1.9-civic-ai`**
Worker version: **`e69b998f-3d17-48d5-bca2-6e413c4fbc8f`** (see [Handovers/13-pod-as-source-of-truth.md](Handovers/13-pod-as-source-of-truth.md) §9)

---

## Components

| Path              | Role                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `forum-pod/`      | Vite + React 19 PWA, also packaged as a Capacitor Android APK. Signs Ed25519 bundles, caches in IndexedDB + DuckDB-WASM. |
| `forum-airlock/`  | Cloudflare Worker (`secure-worker`) + `PersonalPodDO` Durable Object + WebAuthn server + local Node listener.            |
| `forum-ai/`       | Python analysis pipeline (on-prem). Edge path: `forum-airlock/civic-analysis.js` (D1 SQL only). |
| `forum-egress/`   | Cloudflare Worker that serves the public KV-backed report at `forum-egress.yourcommunity.forum`.                       |
| `deploy/`         | Launch scripts, systemd unit templates, Cloudflare Tunnel config, Android build helpers.                                |
| `Handovers/`      | The canonical narrative. Read [13](Handovers/13-pod-as-source-of-truth.md) first, walk back to [1](Handovers/handover1.md) for full context. |
| `archive/`        | Pre-H8 prototypes kept for reference; not built or deployed.                                                            |

---

## Quick start

### Pod app (browser dev)

```bash
cd forum-pod
npm install
npm run dev          # http://localhost:5173
```

### Pod app (build)

```bash
cd forum-pod
npm run build        # vendor:civic-ai then vite build
```

### Worker deploy

```bash
cd forum-airlock
npm install
npx wrangler deploy
```

### Full local launch (Vite + listener)

```bash
bash deploy/forum-pod-launch.sh
```

> Note: deploy scripts currently hardcode `~/Desktop/forum-pod` etc. They
> still need to be updated to the new `~/Desktop/forum-stack/<component>/`
> layout — tracked as a follow-up.

### Cooperative aggregate analysis (edge)

```bash
cd forum-airlock
# D1-only faithful aggregate (no LLM). See forum-airlock/docs/civic-edge-analysis.md
npx wrangler deploy

curl -sS -X POST "$WORKER_URL/api/civic/analysis/run" \
  -H "X-Airlock-Secret: $AIRLOCK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"trigger":"manual"}'
```

See [forum-airlock/docs/civic-edge-analysis.md](forum-airlock/docs/civic-edge-analysis.md).

### Analysis pipeline (on-prem, legacy)

```bash
cd forum-ai
source venv/bin/activate
bash run_analysis.sh
```

---

## Security model (one-paragraph summary)

Identity is a per-device WebAuthn passkey that protects an Ed25519 signing
key. The `sessionId` is bound to the public key as `pubkey:sha256(publicKeyHex)`
and verified on the Worker. Every Pod RPC carries the signed bundle plus a
`deviceCredentialId` and a 15-minute `unlockToken` HMAC issued by the
Worker after a successful passkey assertion. The Pod Durable Object is the
single source of truth for user data; IndexedDB and DuckDB-WASM on the
device are caches hydrated from the Pod and wiped on sign-out. The
cooperative D1 database only stores opt-in `forum_feedback`, AI usage
counts, and the WebAuthn credential registry. See
[Handovers/handover11-security-hardening.md](Handovers/handover11-security-hardening.md) §1 for the
full red-team audit table.

---

## Layout

```
forum-stack/
├── README.md
├── .gitignore
├── forum.config.env.example          # placeholder template; real values live in ~/Desktop/forum.config.env
├── forum-stack.sh                    # top-level launcher
├── Handovers/                        # H1 → H13 narrative; read 13 first
├── deploy/                           # launch scripts, systemd templates
├── docs/                             # legacy READMEs (personal pod, Android, Solid migration)
├── forum-pod/                        # PWA + Capacitor APK
├── forum-airlock/                    # Worker + DO + listener
├── forum-ai/                         # Python analysis pipeline
├── forum-egress/                     # public report Worker
└── archive/
    └── forum-app/                    # pre-H8 TypeScript prototype (not live)
```

---

## Privacy posture (current invariants)

- **Pod-first invariant** (H6 / H13): every user-visible row lives in
  `PersonalPodDO`. No Pod, no app. Sign-out wipes both the cache and the
  Pod-side assistant conversation copy.
- **Counts-only logging** for the Civic AI Kami chat path: the Worker
  proxies chat to Ollama and writes only `prompt_eval_count` / `eval_count` /
  `finish_reason` to D1 — not prompt text. Operators must configure GPU host
  log retention separately ([kami-ollama-ops.md](forum-airlock/docs/kami-ollama-ops.md)).
- **No live retrieval for Kami**: local Ollama weights only; no web search
  (users are disclosed that current-events answers may be stale).
- **Deterministic data answers**: questions about saved data go through
  the `Explore` tab (hand-written SQL templates over the DuckDB cache).
  The LLM never sees Pod data (H13 §9 pivot).
- **No PII in the cooperative ledger**: `forum_feedback.email_hash` is
  the device-derived `sha256(public_key_hex)`. There is no email address
  anywhere on the cooperative side.

---

## Pointers

- Architecture overview: [Handovers/handover8-do-pivot.md](Handovers/handover8-do-pivot.md)
- Wire format and auth: [Handovers/handover11-security-hardening.md](Handovers/handover11-security-hardening.md) §3
- Civic AI Kami integration: [Handovers/12-civic-ai.md](Handovers/12-civic-ai.md)
- Kami GPU / Ollama logging (operators): [forum-airlock/docs/kami-ollama-ops.md](forum-airlock/docs/kami-ollama-ops.md)
- Kami web search (deferred design): [forum-airlock/docs/kami-web-search-deferred.md](forum-airlock/docs/kami-web-search-deferred.md)
- Current head-state notes: [Handovers/13-pod-as-source-of-truth.md](Handovers/13-pod-as-source-of-truth.md)
