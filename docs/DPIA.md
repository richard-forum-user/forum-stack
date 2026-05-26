# Data Protection Impact Assessment (Summary)

**Controller:** The Forum Initiative cooperative (formation in progress)  
**Scope:** Personal Pod + cooperative feedback public beta

## Data collected

| Data | Location | Retention |
|------|----------|-----------|
| Passkey credential id | Client + D1 WebAuthn tables | Until account deletion |
| Pod journal, submissions, assistant | PersonalPodDO + encrypted local cache | Until sign-out wipe / member request |
| Opt-in forum feedback | D1 `forum_feedback` | Until cooperative wipe policy |
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
- Erasure: sign-out + cooperative wipe request; D1 row `wiped_at` when implemented.

## Cross-border

- Cloudflare edge (US/EU per account configuration). Document in offering materials.
