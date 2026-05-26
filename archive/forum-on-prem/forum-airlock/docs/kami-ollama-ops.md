# Civic AI Kami — Ollama / GPU operator runbook

Operators run the inference host that `secure-worker` reaches via `AI_UPSTREAM_URL`
(see [`wrangler.toml`](../wrangler.toml)). The Worker proxies signed chat to
`POST {AI_UPSTREAM_URL}/api/chat` and does **not** persist prompt or completion text in D1.

This document covers **what the edge guarantees** and **what you must configure on the GPU host**.

## Edge (Cloudflare Worker) — already enforced in code

| Data | Stored? | Where |
|------|---------|--------|
| Chat message text | No | Not written to D1 |
| Token / prompt counts | Yes | `ai_chat_log` (counts + timestamp only) |
| Daily message quota | Yes | `ai_chat_quota` |
| Assistant transcripts | No | Transcripts live in **Personal Pod DO** (`assistant_messages`), not cooperative D1 |

Worker observability is **disabled** in `wrangler.toml` (`[observability] enabled = false`) so
dashboard logs do not capture Forum Feedback or Pod RPC payloads. Re-enable only briefly for deploy debugging.

## On-prem Ollama host — operator responsibilities

The Worker cannot control logging on your GPU machine. Treat the Ollama host and tunnel
(`AI_UPSTREAM_URL`, e.g. Cloudflare Tunnel to `ai-open.yourcommunity.forum`) as **sensitive**.

### Recommended policy

1. **Bind Ollama to localhost** — `OLLAMA_HOST=127.0.0.1:11434` (see `Handovers/handover2.md`). Expose only via tunnel or reverse proxy with Access, not the public internet.
2. **Disable or rotate Ollama request logging** — By default Ollama may log requests to stdout/journald. For production:
   - Run Ollama under `systemd` with `StandardOutput=null` / `StandardError=journal` only if you accept journal retention, **or**
   - Ship logs to a retention-limited sink and document TTL (e.g. 7 days).
3. **No persistent chat history on the GPU** — Do not add middleware that writes `/api/chat` bodies to disk unless you have a published retention policy and user disclosure.
4. **Tunnel / proxy logs** — Cloudflare Tunnel and nginx access logs may record connection metadata (timestamps, client IP). They should **not** log request bodies if avoidable.
5. **Backups** — Exclude Ollama model cache from backups that are shared broadly; model weights are not user data, but any accidental prompt capture in backup tools must be avoided.

### Checklist after deploy

```bash
# Ollama listening locally only
ss -lntp | grep 11434

# Confirm model name matches wrangler (404 = wrong tag)
curl -sS http://127.0.0.1:11434/api/tags | jq '.models[].name'

# Smoke test (from host; not the full signed Worker path)
curl -sS http://127.0.0.1:11434/api/chat -d '{"model":"qwen2.5:14b-instruct-q4_K_M","stream":false,"messages":[{"role":"user","content":"ping"}]}'
```

### Model freshness (operator note)

`AI_UPSTREAM_MODEL` points at a **fixed weights snapshot** (training cutoff per model card).
Kami has **no web search or news API**. Users are told in the Pod UI that current-events
answers may be stale. Upgrading the model is an operator change: pull a newer Ollama tag,
update `AI_UPSTREAM_MODEL`, redeploy Worker vars if the tag name changes.

## Related docs

- User flow and Worker auth: [Handovers/12-civic-ai.md](../../Handovers/12-civic-ai.md)
- Pod DO storage for transcripts: [Handovers/13-pod-as-source-of-truth.md](../../Handovers/13-pod-as-source-of-truth.md)
- Deferred web search design: [kami-web-search-deferred.md](kami-web-search-deferred.md)
