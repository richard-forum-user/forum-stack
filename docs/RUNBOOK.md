# Forum-Stack Operations Runbook

## Deploy

```bash
cd forum-airlock
npm run build:pod
npx wrangler deploy
cd ../forum-egress
npx wrangler deploy
```

Required secrets (`forum-airlock`): `UNLOCK_TOKEN_KEY`, `AIRLOCK_SECRET`, `FORUM_EGRESS_URL`, `FORUM_SECRET`, `AI_ACCESS_CLIENT_ID`, `AI_ACCESS_CLIENT_SECRET`, optional `MEMBER_HASH_SALT`.

## Production vars (`wrangler.toml`)

| Var | Production value |
|-----|------------------|
| `ALLOW_PILOT_BUNDLES` | `"0"` |
| `ALLOW_DEV_CIVIC_PUBLISH` | `"0"` |
| `CIVIC_PUBLISH_VERBATIM_COMMENTS` | `"0"` |
| `AI_UPSTREAM_URL` | `https://ai.yourcommunity.forum` |

## Secret rotation

1. Generate new secret locally.
2. `npx wrangler secret put <NAME>` for `secure-worker` and `forum-egress` as applicable.
3. Update `forum.config.env` on the listener host (`AIRLOCK_SECRET`, `FORUM_SECRET`).
4. For `UNLOCK_TOKEN_KEY`: all clients must re-unlock with WebAuthn after rotation.

## Incident playbook

| Scenario | Action |
|----------|--------|
| Abuse / spam | Raise rate limits in `rate-limit.js` deploy; block IP in Cloudflare WAF |
| Bad published report | `POST /api/civic/analysis/publish` with new run after DB fix; rotate KV `latest` via egress |
| Pilot path abused | Confirm `ALLOW_PILOT_BUNDLES=0` deployed |
| AI tunnel exposed | Verify Access on `ai.yourcommunity.forum`; confirm `AI_ACCESS_*` set |
| Key compromise | Rotate `UNLOCK_TOKEN_KEY`; users clear Pod and re-register passkey |

## Smoke tests (staging)

- Register passkey → unlock → submit feedback → `GET /api/civic/analysis` (no verbatim comments)
- Replay captured bundle signature → `replay_detected`
- `POST /api/civic/analysis/dev-push` → `404`
- `POST /api/ai/chat` without unlock → `401`
- Pod RPC body > 256 KiB → `413`

## Observability

Workers Logs enabled at 10% sample. Do not log comment text, `email_hash`, or signatures.
