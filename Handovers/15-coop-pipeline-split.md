# Handover 15 — Co-op pipeline split + 7-day contest wipe

Splits the monorepo into:

- **`forum-pod-solo`** — user pod (UI + `PersonalPodDO` + WebAuthn). Deploy at `airlock.*` / `pod.*`.
- **`forum-stack`** — cooperative pipeline only. Deploy at `coop.yourcommunity.forum` as Worker `coop-pipeline`.

## Data lifecycle

1. User opts in → `POST coop…/api/forum/feedback` (signed bundle).
2. Report published → `contest_window_ends_at = now + 7 days` on included rows.
3. Contest may freeze a row (`contest_window_ends_at = NULL` + `forum_contest_claims`).
4. After window → cron / `wipe-expired` hard-deletes `forum_feedback` + `forum_payloads`. User pod retains the record.

## Schema mirror

`forum_feedback` columns mirror `civic_submissions` in the Pod DO. Migration: `forum-airlock/migrations/0001_schema_mirror.sql`.

## Membership

- Co-op: `POST /membership/verify-id` (Turnstile + Stripe Identity) → `POST /membership/issue` (ES256 JWT).
- Pod: `POST /api/membership/verify` (JWKS pin + Web Crypto verify).

## Event sourcing (Pod)

Additive tables: `pod_events`, `pod_local_state`. Outbound `syncWithCloud()` gated by `requireUserConsent()` + valid membership JWT.
