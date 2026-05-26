# Retired on-prem listener and analysis path

This directory preserves the pre-edge cooperative server path for archaeology.
It is not built, deployed, or required by the current stack.

Retired live path:

```text
Pod / Worker
  -> listener.yourcommunity.forum
  -> forum-airlock/listener.js
  -> forum-ai/vault.py + forum_inbound.db
  -> forum-ai/run_analysis.sh
  -> forum-egress/report.json + push.py
```

Current live path:

```text
Pod
  -> secure-worker /api/forum/feedback
  -> D1 forum-db forum_feedback
  -> forum-airlock/civic-analysis.js
  -> secure-worker cron /api/civic/analysis
  -> forum-egress KV latest
```

The current Worker also handles `/api/register-member` and
`/api/register-signing-key` directly in D1, so `forum-backend.service`
and `listener.yourcommunity.forum` are no longer in the required runtime.

The old Civic AI Kami tunnel path (`ai-open.yourcommunity.forum` to
on-prem Ollama) is archived here too. The live Pod build hides Kami by
default so the deployed app has no dependency on the user's PC or GPU host.

If this path is restored later, audit it first:

- `listener.js` was moved after the monorepo consolidation and its old config
  path assumptions are stale.
- `forum-ai/*` uses absolute `~/Desktop/forum-ai` paths in several files.
- The Python pipeline reads `forum_inbound.db`, while the live cooperative
  ledger is D1 `forum_feedback`.
- The old receipt/vault path uses Fernet and local SQLite; it should not be
  reintroduced unless there is a clear product reason.
