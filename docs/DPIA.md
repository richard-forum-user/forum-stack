# Data Protection Impact Assessment (Summary)

**Controller:** The Forum Initiative cooperative (formation in progress)  
**Scope:** Personal Pod + cooperative feedback public beta

## Data collected

| Data | Location | Retention |
|------|----------|-----------|
| Passkey credential id | Client + D1 WebAuthn tables | Until account deletion |
| Pod journal, submissions, assistant | PersonalPodDO + encrypted local cache | Until sign-out wipe / member request |
| Opt-in forum feedback | D1 `forum_feedback` | Max **7 days** after report publish (`contest_window_ends_at`), then hard-deleted |
| Contest claims | D1 `forum_contest_claims` | Until resolved + row wipe |
| Membership JWT audit | D1 `coop_memberships` | JWT TTL (default 24h) + revocation |
| Salted member pseudonym | D1 `email_hash` column | Per cycle salt rotation |
| AI usage counters | D1 `ai_chat_quota` | Daily buckets |

## Public exposure

- Published reports: aggregate counts and ZIP prefixes only (`CIVIC_PUBLISH_VERBATIM_COMMENTS=0`).
- No `email_hash`, `session_id`, or Pod contents in egress JSON.

## Legal basis (draft — counsel review)

- Cooperative membership / legitimate interest for aggregate civic reporting.
- Explicit consent at feedback submit for cooperative export.

## Data subject rights

- Export: Pod UI device settings (public metadata only; keys non-exportable).
- Erasure: sign-out wipes Pod DO; cooperative rows auto-delete after contest window unless frozen by contest.

## Cross-border

- Cloudflare edge (US/EU per account configuration). Document in offering materials.
