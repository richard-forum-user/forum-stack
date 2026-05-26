# Public Beta Go / No-Go Checklist

## Phase 0 — Stop the bleeding

- [ ] `ALLOW_PILOT_BUNDLES = "0"` deployed
- [ ] `ALLOW_DEV_CIVIC_PUBLISH = "0"` deployed
- [ ] `/api/civic/analysis/dev-push` returns 404
- [ ] `AI_UPSTREAM_URL` = Access-protected host; `AI_ACCESS_*` secrets set
- [ ] Android `allowBackup=false`, `webContentsDebuggingEnabled=false`
- [ ] Timing-safe secret compare on egress + airlock operator routes

## Phase 1 — Production posture

- [ ] Observability on (10% sample); no PII in log statements
- [ ] Routes declared in `wrangler.toml`
- [ ] Rate limits exercised in staging
- [ ] DO payload / write budgets return 413/429 under abuse test
- [ ] `CIVIC_PUBLISH_VERBATIM_COMMENTS=0` verified on egress HTML
- [ ] Non-extractable Ed25519; no cleartext `privateJwk` in localStorage
- [ ] Unlock token: 5 min TTL + jti table
- [ ] Session lock + PRF crypto path tested on Android passkey device

## Legal / cooperative

- [ ] Privacy policy + ToS live and match code
- [ ] Counsel sign-off on cooperative vs investment copy
- [ ] Offering memorandum **not** linked until filed (`docs/MEMBER-CAPITAL-OFFERING-MEMO.md`)

## DNS

- [ ] `pod.yourcommunity.forum` → secure-worker
- [ ] `forum-egress.yourcommunity.forum` → forum-egress
- [ ] Staging `noindex` verified

## Sign-off

| Role | Name | Date |
|------|------|------|
| Engineering | | |
| Privacy counsel | | |
| Cooperative counsel | | |
