# Forum Pod

Local-first personal civic data pod, served as a React/Vite PWA and signed
against the cooperative Cloudflare Worker.

## Civic AI Kami

This repo vendors Audrey Tang and Caroline Green's Civic AI / 6-Pack of Care
materials from [`audreyt/civic.ai`](https://github.com/audreyt/civic.ai).
The upstream project is published under `CC0-1.0`, and the vendored commit is
recorded in `src/civic-ai/VERSION.json`.

Relevant local paths:

- `scripts/vendor-civic-ai.mjs` refreshes the CC0 content and system prompt.
- `public/civic-ai/*.md` powers the offline 6-Pack reader.
- `src/civic-ai/skill.md` stores the OpenClaw bootstrap guide from `kami.civic.ai`.
- `src/civic-ai/system-prompt.txt` is the local Civic AI Kami system prompt.

Run:

```bash
npm run vendor:civic-ai
npm run build
```

The Assistant tab is gated in Settings. Conversations stay in this device's
IndexedDB and are cleared on sign-out; the Worker logs quota and token counts
only.
