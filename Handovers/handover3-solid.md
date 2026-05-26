# Handover 3 — Solid migration (implemented)

**Build:** `1.3-solid-webauthn`  
**Prior:** [handover2.md](handover2.md)

## What shipped

- `forum-solid/` — Community Solid Server config, provision bridge (:3457), systemd template
- Pod app — WebAuthn, Solid-OIDC modules, RDF civic vocab, opt-in `/api/civic/export`
- Listener — signed export bridge, public `/api/register-member`, signing key registry
- Analysis — Art VII review gate, raw wipe, egress disclaimers
- Docs — `forum-pod/docs/` governance + traceability

## Dev start

See **[handover4-solid-ops.md](handover4-solid-ops.md)** for three-terminal startup, npm package fix (`@solid/community-server`), and troubleshooting.

Set `forum-pod/.env` from `.env.example`.

## User flow

1. Settings → Create Pod (WebAuthn) → provision → OIDC login when CSS is up
2. Civic submit → local ledger + Pod RDF
3. Opt-in checkbox → cooperative signed export only
