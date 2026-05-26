# Secrets & Ignored Artifacts

## Git policy

The following patterns are in `.gitignore` and must **not** be committed:

- `*.env`, `forum.config.env`
- `*.pem`, `*.key`
- `members_email_hashes*.csv`
- `cron.log`, `*.log`
- `forum-pod/.env`

## Workspace hygiene

If local copies exist under `archive/forum-on-prem/` (e.g. `private.pem`, `cron.log`), they are ignored but should be **deleted from developer machines** before investor diligence.

## Required Cloudflare secrets

| Worker | Secret |
|--------|--------|
| secure-worker | `UNLOCK_TOKEN_KEY`, `AIRLOCK_SECRET`, `FORUM_SECRET`, `FORUM_EGRESS_URL`, `AI_ACCESS_CLIENT_ID`, `AI_ACCESS_CLIENT_SECRET`, optional `MEMBER_HASH_SALT` |
| forum-egress | `FORUM_SECRET` |

Verify with: `git check-ignore -v <path>` and `git ls-files` (should be empty for secrets).
