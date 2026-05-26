# archive/forum-app

**Status: archived. Not built. Not deployed. Not part of the live stack.**

This directory holds the original TypeScript Worker prototype from
May 12–17, 2026 — before the Handover 8 Durable Object pivot
(2026-05-22). It predates and was effectively replaced by:

- `forum-pod/` (the Vite + React 19 PWA / Capacitor APK)
- `forum-airlock/secure-worker.js` and `forum-airlock/pod-do.js` (the
  deployed Cloudflare Worker + Personal Pod DO)

No script in the live stack imports from or builds anything here. The
files are kept because they document an earlier architectural sketch
(`cf-worker.ts`, `container-manager.ts`, `analysis-queue.ts`,
`nullifier-registry.ts`, `pod-signing.ts`, `sql-sandbox.ts`,
`server-receiver.ts`, `ai-db-manager.ts`, `local-router.ts`).

For the canonical history of the pivot and what replaced these files,
see [`Handovers/handover8-do-pivot.md`](../../Handovers/handover8-do-pivot.md).
