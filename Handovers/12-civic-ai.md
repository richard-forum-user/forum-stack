# Handover 12 - Civic AI Kami on-prem assistant

Build target: `secure-pod-v1.9-civic-ai`.
Prior: [handover11-security-hardening.md](handover11-security-hardening.md).

This handover documents the Civic AI / 6-Pack of Care integration. The
goal is a local-first assistant that uses Audrey Tang and Caroline Green's
CC0 `audreyt/civic.ai` content as its values layer while running inference
on the cooperative GPU through Ollama.

## 1. Provenance

- Upstream repo: `https://github.com/audreyt/civic.ai`
- Upstream site: `https://civic.ai/`
- OpenClaw skill source: `https://kami.civic.ai/.well-known/openclaw/SKILL.md`
- License: `CC0-1.0`
- Vendored commit: `272e45c7fcd5588c055097a81b7d41862f25ac65`
- Local provenance file: `src/civic-ai/VERSION.json`

Vendored content lives in:

- `public/civic-ai/*.md` - offline 6-Pack reader content.
- `src/civic-ai/skill.md` - Civic AI OpenClaw bootstrap guide.
- `src/civic-ai/system-prompt.txt` - local system prompt source.
- `../forum-airlock/civic-ai-system-prompt.js` - Worker-bundled copy.

## 2. New user flow

The Pod Settings screen has a new `Enable Civic AI Kami assistant` toggle.
The first enable shows a Pack 4 disclosure:

- The assistant runs through the cooperative GPU (Ollama via `AI_UPSTREAM_URL`).
- Only typed chat messages are sent — not Pod submissions, journal, behaviors, or traits.
- Conversation history is stored in the **Personal Pod Durable Object** (`assistant_messages` in `pod-do.js`) and mirrored in IndexedDB (`assistant-store.js`) for offline speed. See [13-pod-as-source-of-truth.md](13-pod-as-source-of-truth.md).
- **Stop and forget** deletes the Pod copy and the local cache for that conversation.
- **Sign-out** deletes all assistant conversations from the Pod and clears IndexedDB (per user choice in H13).
- The Worker logs message counts and token counts only — not prompt or completion text.
- The model has no live news or web search; answers about current events may be stale (disclosed in UI).
- The Assistant tab includes `Stop and forget`.

When enabled, a new `Assistant` tab appears. It includes:

- Chat mode, streaming from `/api/ai/chat`.
- `6-Pack Reader`, loading the vendored Markdown from `public/civic-ai/`.

## 3. Worker route

New route in `forum-airlock/secure-worker.js`:

```text
POST /api/ai/chat
```

Implemented in `forum-airlock/ai-chat.js`.

Auth and integrity checks:

1. `sessionId` must match `pubkey:sha256(publicKeyHex)`.
2. Unlock token must validate, unless `UNLOCK_TOKEN_KEY` is unset in dev.
3. Pilot credentials are rejected unless `ALLOW_PILOT_BUNDLES = "1"`.
4. Ed25519 signed bundle is verified.
5. D1 signing-key registry is checked or TOFU-registered.
6. Replay cache rejects repeated signatures.

Privacy behavior:

- Client `system` messages are dropped.
- Worker injects `civic-ai-system-prompt.js` server-side.
- No prompt or completion text is written to D1.
- `ai_chat_log` stores counts, finish reason, and timestamp only.

## 4. D1 additions

Created lazily by `ensureAiD1Schema`:

```sql
CREATE TABLE IF NOT EXISTS ai_chat_quota (
  credential_id TEXT NOT NULL,
  day TEXT NOT NULL,
  msg_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (credential_id, day)
);

CREATE TABLE IF NOT EXISTS ai_chat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  finish_reason TEXT
);
```

Default quota is `100` messages per credential per UTC day.

## 5. On-prem runtime

Installer:

```text
forum-airlock/deploy/install-on-prem-ollama.sh
```

Default runtime:

- Ollama bound to `127.0.0.1:11434`.
- Model: `qwen2.5:14b-instruct-q4_K_M`.
- `OLLAMA_KEEP_ALIVE=30m`.
- `OLLAMA_NUM_PARALLEL=2`.
- Cloudflare Tunnel hostname: `ai.yourcommunity.forum`.

The tunnel hostname should be protected by a Cloudflare Access self-hosted
application that accepts only a service token used by the Worker.

## 6. Worker configuration

Non-secret vars in `forum-airlock/wrangler.toml`. Current POC build points
at the unprotected hostname (see Section 10.2); flip back to the Access
hostname when promoting:

```toml
# POC (deployed)
AI_UPSTREAM_URL = "https://ai-open.yourcommunity.forum"
# Production (revert to this once Access is wired)
# AI_UPSTREAM_URL = "https://ai.yourcommunity.forum"
AI_UPSTREAM_MODEL = "qwen2.5:14b-instruct"
AI_DAILY_QUOTA = "100"
```

Secrets to set (only required once you move back to the Access-protected
hostname):

```bash
npx wrangler secret put AI_ACCESS_CLIENT_ID
npx wrangler secret put AI_ACCESS_CLIENT_SECRET
```

## 7. Model roll procedure

1. Pull the new model on the GPU host, for example:
   `ollama pull qwen2.5:32b-instruct-q4_K_M`
2. Update `AI_UPSTREAM_MODEL` in `forum-airlock/wrangler.toml`.
3. Deploy the Worker: `npm run deploy:worker --prefix forum-airlock`.
4. Restart Ollama if changing runtime parameters: `sudo systemctl restart ollama`.
5. Send one Assistant message from the Pod and confirm streaming works.

## 8. System prompt red-lines

The local header in `src/civic-ai/system-prompt.txt` sets these hard
red-lines:

- Do not ask for or reveal secrets, passkeys, private keys, unlock tokens,
  or Cloudflare credentials.
- Do not encourage surveillance, coercion, doxxing, impersonation, or
  targeted political manipulation.
- Do not pretend to be a civic authority, government service, lawyer,
  doctor, or emergency responder.
- Do not claim that outputs are verified facts when they are interpretations
  or suggestions.
- Invite correction, contestation, and a human stop/forget path when
  uncertainty or harm appears.

## 9. Still out of scope

- Tool use and function calling.
- Embeddings or RAG over Pod data.
- Vision models.
- Multi-user throughput beyond `OLLAMA_NUM_PARALLEL=2`.

## 10. Live deployment notes (POC, 2026-05-25)

The first end-to-end deploy uncovered three operator-side gotchas that the
code path did not catch. Document them here for whoever ships the v1.10
version.

### 10.1 Cloudflare Access could not be created via Wrangler OAuth

The local Wrangler OAuth token (`account read`, `workers write`, etc.) does
not include Zero Trust Access scopes, so `POST /accounts/.../access/apps`
returned `403 Authentication error`. Two options for v1.10:

- Issue a dedicated API token in the Cloudflare dashboard with
  `Account -> Access: Apps and Policies -> Edit` and
  `Account -> Access: Service Tokens -> Edit` and pass it as
  `CF_API_TOKEN` to `install-on-prem-ollama.sh`. The script will then
  auto-create the app, the policy, and the service token.
- Or finish the dashboard click-path: Zero Trust -> Access -> Service Auth
  -> create token -> Applications -> add self-hosted app for
  `ai.yourcommunity.forum` -> add a policy with action `Allow` and an
  `Include: Service Token` rule -> turn on `Accept Service Tokens` in the
  app settings. Once done, set the secrets:

  ```bash
  printf '%s' '<id>'     | npx wrangler secret put AI_ACCESS_CLIENT_ID
  printf '%s' '<secret>' | npx wrangler secret put AI_ACCESS_CLIENT_SECRET
  npx wrangler deploy
  ```

Bad secret values are the most common 5xx cause. Symptoms:

- Worker returns `502 ai_upstream_failed` in the Assistant.
- Curl against `https://ai.yourcommunity.forum/api/version` with the
  exact header values returns `HTTP/2 302` to
  `cloudflareaccess.com/cdn-cgi/access/login/...` with
  `service_token_status:false` inside the meta JWT. That string in the
  redirect URL is the explicit "this token did not match the policy" tell.
- `printf '%s' 'CF-Access-Client-Id: <id>' | wrangler secret put ...`
  uploads the header name with the value. The secret value must be
  bare, with no `CF-Access-Client-Id:` prefix.

### 10.2 POC bypass: unprotected tunnel hostname

For the POC pass we added a second tunnel hostname that is not behind
Access:

- DNS route created: `cloudflared tunnel route dns <tunnel-id> ai-open.yourcommunity.forum`.
- `wrangler.toml` now ships with `AI_UPSTREAM_URL = "https://ai-open.yourcommunity.forum"`.
- Worker bundles the open hostname; no Access secrets are required for the
  POC code path. The `AI_ACCESS_CLIENT_ID` / `AI_ACCESS_CLIENT_SECRET`
  secrets are still honored at runtime if you set them, but the Worker
  does not require them.

Before promoting beyond POC: revert `AI_UPSTREAM_URL` to
`https://ai.yourcommunity.forum`, finish 10.1, and re-deploy. The open
hostname can stay in `cloudflared` for testing or be removed by deleting
its ingress block and the CNAME.

Operator step that still requires sudo on the GPU box:

```bash
sudo python3 - <<'PY'
from pathlib import Path
p = Path('/etc/cloudflared/config.yml')
text = p.read_text()
rule = '  - hostname: ai-open.yourcommunity.forum\n    service: http://127.0.0.1:11434\n    originRequest:\n      httpHostHeader: 127.0.0.1:11434\n'
if 'hostname: ai-open.yourcommunity.forum' not in text:
    text = text.replace('  - service: http_status:404', rule + '  - service: http_status:404', 1)
    p.write_text(text)
PY

sudo systemctl restart cloudflared
```

The `originRequest.httpHostHeader` line is the important bit, see 10.3.

### 10.3 Ollama 403: Host header validation

Recent Ollama (0.24.0 in this deploy) ships a built-in `Host` validator.
If the request's `Host` header is not `127.0.0.1:11434` (the bind), the
server returns `403 Forbidden` with empty body, before any handler runs.
`OLLAMA_ORIGINS` only controls CORS for browser requests, **not** this
host check, so widening it does not fix the 403.

Reproduce locally on the GPU box:

```bash
curl http://127.0.0.1:11434/api/version
# 200 OK

curl http://127.0.0.1:11434/api/version -H 'Host: ai-open.yourcommunity.forum'
# 403 Forbidden
```

Two fixes; pick one.

**Fix A (recommended for POC):** rewrite the Host header in cloudflared so
Ollama sees `127.0.0.1:11434`.

```yaml
- hostname: ai-open.yourcommunity.forum
  service: http://127.0.0.1:11434
  originRequest:
    httpHostHeader: 127.0.0.1:11434
```

After editing the config: `sudo systemctl restart cloudflared`. This is
also documented inside the Section 10.2 snippet.

**Fix B (if Fix A is not acceptable):** let Ollama listen on a wildcard
host. Drop a systemd override:

```ini
# /etc/systemd/system/ollama.service.d/forum-civic-ai.conf
[Service]
Environment=OLLAMA_HOST=0.0.0.0:11434
Environment=OLLAMA_KEEP_ALIVE=30m
Environment=OLLAMA_NUM_PARALLEL=2
```

Then `sudo systemctl daemon-reload && sudo systemctl restart ollama`.

`OLLAMA_HOST=0.0.0.0:11434` means the local box accepts any host header,
so anyone with a route to that port can hit it. Keep this fix only if the
box is firewalled and not reachable from outside the tunnel.

### 10.4 End-to-end smoke test after Fix A

```bash
curl -fsS https://ai-open.yourcommunity.forum/api/version
# {"version":"0.24.0"}
```

Then from the Pod:

1. Sign in with passkey.
2. Settings -> Enable Civic AI Kami -> accept Pack 4 disclosure.
3. Assistant tab -> send a short message.
4. Expect streaming tokens within ~3 seconds.
5. `npx wrangler tail | grep ai_chat` should log nothing useful by design
   (we do not log prompts), but `ai_chat_quota` and `ai_chat_log` in D1
   should accumulate rows. Spot-check with
   `npx wrangler d1 execute forum-db --remote --command "SELECT * FROM ai_chat_log ORDER BY id DESC LIMIT 5"`.

### 10.5 Path back to Access for v1.10

- Restore `AI_UPSTREAM_URL = "https://ai.yourcommunity.forum"` in
  `forum-airlock/wrangler.toml`.
- Finish 10.1 to create the service token and policy.
- Upload `AI_ACCESS_CLIENT_ID` and `AI_ACCESS_CLIENT_SECRET` with raw
  values (no header prefix).
- Apply Fix A (`originRequest.httpHostHeader`) on the
  `ai.yourcommunity.forum` ingress as well, so the protected hostname
  also clears Ollama's host check.
- `npx wrangler deploy`.
- Optional: remove the `ai-open.yourcommunity.forum` DNS record and
  ingress rule to retire the POC backdoor.
