# Capacity & Cost Envelope (Estimates)

*Update with production metrics after staging load test.*

## Assumptions

- 1,000 MAU public beta
- 5 cooperative submissions / user / month
- 20 Kami messages / user / day (capped by `AI_DAILY_QUOTA=100`)

## Cloudflare Workers

| Path | Est. req/mo | Notes |
|------|-------------|-------|
| Pod RPC | 500k | ~17 writes/user/mo |
| Forum feedback | 5k | opt-in only |
| Civic GET | 50k | public readers |
| AI chat | 600k | quota-bound |

## D1

- `forum_feedback`: ~5k rows/mo at 1k MAU
- `edge_replay_cache` / rate limits: prune via TTL queries
- `unlock_token_jti`: 5 min retention

## AI

- Upstream: Ollama on cooperative GPU; Worker adds Access headers only
- Cost driver: GPU host + electricity, not Workers AI binding

## Durable Objects

- 1 DO per active `sessionId`
- Storage: journal + assistant; target < 1 MB / user for beta

## Action items

- [ ] Run `wrangler dev` + scripted load against rate limits
- [ ] Record p95 latency for `/api/pod/*` and `/api/ai/chat`
- [ ] Fill actual Cloudflare invoice line items after 30 days
