# Handover 18 — Recovery identity DO (phrase-based)

Prior: [17-installer-release-pipeline-live.md](17-installer-release-pipeline-live.md).

Deployed 2026-05-29 on `coop.yourcommunity.forum` (Worker `coop-pipeline`,
version `a0616132-0a6d-4fd1-b52f-2a22f7d6bc18` at time of writing).

User intent that prompted this iteration:

> Given the current architecture … how can I guarantee ownership of data to a
> user's local control, transmit the data to Cloudflare D1, aggregate the info,
> then wipe the raw text so that only the original users have the data and the
> Forum just has the aggregated report?

> I want a durable record keyed to hashed email + submission IDs so a user who
> loses everything can recover their identity and proof-of-submissions.

This handover adds **identity recovery without raw-content escrow**. A user who
loses every device can re-derive an Ed25519 key from a 12-word BIP39 phrase,
prove identity to the cooperative, and recover their submission receipt IDs and
deletion proofs. Raw comment text is **not** recoverable from the cloud — it
was never meant to persist there and is hard-wiped after the 7-day contest
window.

---

## 1. What this recovers (and what it does not)

| Recovers | Does not recover |
|----------|------------------|
| Identity continuity (re-bind a new device under the same cooperative identity) | Raw comment text |
| List of submission `receipt_id`s linked to the identity | Journal, behaviors, traits, assistant chat |
| Deletion proofs (`payload_sha256`, `wiped_at`) after cloud wipe | Anything not enrolled before device loss |

The durable raw copy remains in the user's **local IndexedDB store** and in their
**JSON export** (`forum-personal-pod-local-export-v1`). Recovery phrase +
export together are the self-custody guarantee.

---

## 2. Cooperative worker changes (`forum-stack/forum-airlock`)

### New files

| File | Purpose |
|------|---------|
| `recovery-do.js` | `RecoveryDO` — per-identity SQLite DO keyed by `sha256(recovery_pub_hex)`. Stores linked device signing keys + receipt ledger. |
| `recovery-crypto.js` | Ed25519 verify, canonical JSON, `recoveryIdFromPubHex`, payload hashing for deletion receipts. |
| `recovery-routes.js` | HTTP handlers for enroll / challenge / recover / rebind / status. |

### New endpoints

| Route | Auth | Purpose |
|-------|------|---------|
| `POST /api/recovery/enroll` | Device Ed25519 bundle | Links `recovery_pub_hex` to current device signing key. |
| `POST /api/recovery/challenge` | None (public) | Returns one-time nonce for recovery key to sign. |
| `POST /api/recovery/recover` | Recovery Ed25519 signature over nonce | Returns receipts + short-lived rebind token. |
| `POST /api/recovery/rebind` | Rebind token + new device bundle | Links new device signing key after recovery. |
| `GET /api/recovery/status?recovery_pub_hex=` | None | Public enrollment metadata (no PII). |
| `GET /api/forum/feedback/receipt?receipt_id=` | None | Deletion proof lookup (also used by Settings "Verify deletion"). |

### Ingest integration

On successful `POST /api/forum/feedback`:

1. Row lands in `forum_feedback` (unchanged).
2. `forum_deletion_receipts` row inserted with `payload_sha256` (hash of normalised payload, no raw comment stored in the receipt table).
3. If the submitting device is enrolled in recovery, `appendRecoveryReceipt()` writes the receipt ID into the user's `RecoveryDO`.

On `wipeExpiredFeedback()` (7-day window expiry):

- `forum_deletion_receipts.wiped_at` is set before `forum_feedback` rows are hard-deleted.

### D1 schema additions

```
forum_deletion_receipts  — receipt_id, payload_sha256, created_at, wiped_at
recovery_device_links  — device session_id ↔ recovery_id mapping (audit)
```

### Wrangler

`wrangler.toml`:

```toml
[[durable_objects.bindings]]
name = "RECOVERY"
class_name = "RecoveryDO"

[[migrations]]
tag = "v1-recovery-do"
new_sqlite_classes = ["RecoveryDO"]
```

Export from `secure-worker.js`: `export { RecoveryDO } from './recovery-do.js';`

---

## 3. Client changes (`forum-pod-solo/forum-pod/src`)

| File | Purpose |
|------|---------|
| `recovery-phrase.js` | BIP39 12-word generation, Ed25519 derivation from mnemonic, local enrollment state. |
| `recovery-api.js` | Cooperative API client: enroll, challenge, recover, rebind, fetch deletion receipt. |
| `pod-ui.jsx` | Settings panel: generate phrase (shown once), confirm, enroll, verify deletion receipts. |
| `sign-in-overlay.jsx` | "Lost your device? Recover with phrase" flow on sign-in. |
| `local-data-export.js` | JSON export includes `recovery` + `recovery_receipts` alongside raw submissions. |

Recovery public key is stored locally after enrollment. The phrase itself is
**never** sent to the server — only the derived public key at enroll time and
signatures at recover time.

---

## 4. Mental model

```
User device                    Cooperative (coop.yourcommunity.forum)
───────────                    ─────────────────────────────────────
IndexedDB raw submissions  ──► POST /api/forum/feedback (signed, opt-in)
JSON export (self-custody)       │
                                 ├► D1 forum_feedback (raw, ≤7 days)
                                 ├► forum_deletion_receipts (hash only)
                                 └► RecoveryDO.receipts[] (if enrolled)

12-word phrase ──► derive recovery key ──► POST /api/recovery/recover
                                              └► receipt IDs + rebind token
                                                 (no raw text)
```

---

## 5. Deploy

```bash
cd ~/Desktop/forum-stack/forum-airlock
npx wrangler deploy
# PWA that includes recovery UI:
cd ~/Desktop/forum-pod-solo/forum-airlock
npm run build:pod && npx wrangler deploy
```

No new secrets required beyond existing `AIRLOCK_SECRET` / signing keys.

---

## 6. Verification

```bash
# Enrollment status (public metadata only):
curl -sS "https://coop.yourcommunity.forum/api/recovery/status?recovery_pub_hex=<hex>"

# Deletion proof after wipe window:
curl -sS "https://coop.yourcommunity.forum/api/forum/feedback/receipt?receipt_id=<id>"
```

In the PWA: Settings → **Account recovery phrase** → generate, confirm, enroll.
Submit to cooperative with share enabled → receipt appears under recovery receipts.
After 7-day wipe, **Verify deletion** should show `wiped_at`.

---

## 7. Known follow-ups

| Item | Notes |
|------|-------|
| Encrypted escrow for raw content | Explicitly out of scope — would change privacy posture. Export is the raw backup path. |
| Email-hash linkage | Current model uses device-derived `memberHash` (sha256 of Ed25519 pub), not email. Legacy column name `email_hash` on D1 rows. |
| Recovery DO migration on existing identities | Users must enroll phrase on a device they still control; no retroactive server-side enrollment. |
| R2 Iceberg aggregate lake | Planned in local-ownership plan; not wired in this handover. See H20. |
