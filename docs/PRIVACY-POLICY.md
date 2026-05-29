# Privacy Policy (Draft — Public Beta)

**Effective:** Upon public beta launch  
**Entity:** The Forum Initiative (cooperative, formation pending)

## What we collect

- **Passkey authentication** — we store credential identifiers, not passwords.
- **Personal Pod content** — journal, submissions, and assistant messages you choose to save; stored in your Cloudflare Durable Object.
- **Cooperative feedback** — only when you opt in at submit; may include category, ZIP, and comment text in cooperative D1 **temporarily** (see retention below).
- **Membership verification** — government-ID check via Stripe Identity (when enabled); only a salted `member_hash` is stored on the cooperative side.

## What we publish

Public cooperative reports include **aggregate statistics** (counts, category breakdowns, ZIP area prefixes). **Verbatim comments are not published** in public beta unless explicitly enabled under counsel-approved policy.

## Cooperative retention (7-day contest window)

After an aggregate report is published, opted-in rows remain in cooperative D1 for **seven (7) days** so members may contest the report under the articles of incorporation. When that window ends (and no contest is pending), those rows are **hard-deleted** from cooperative storage. Your Personal Pod remains the long-term record.

## What stays private

- We do not publish `email_hash`, device session ids, or Pod contents in public reports.
- Kami chat prompts are not stored as text on the edge; only daily usage counters.

## Your device

While signed in, the app may cache **encrypted** data locally. Sign-out or app background clears signing keys from memory. Android backups are disabled for the release APK.

## Contact

- Privacy: privacy@yourcommunity.forum  
- Security: security@yourcommunity.forum (see `/.well-known/security.txt`)

*This draft must be reviewed by counsel before public beta DNS cutover.*
