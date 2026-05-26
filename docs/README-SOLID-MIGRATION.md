# Solid Pod Migration — Operations

## Services

| Service | Port | Path |
|---------|------|------|
| Community Solid Server | 3456 | `~/Desktop/forum-solid` |
| Provision bridge | 3457 | `~/Desktop/forum-solid` |
| Forum airlock listener | 3000 | `~/Desktop/forum-airlock` |

## Start (dev)

```bash
cd ~/Desktop/forum-solid && npm install && npm run start
# separate terminal:
cd ~/Desktop/forum-solid && npm run provision-bridge
cd ~/Desktop/forum-pod && npm install && cp -n .env.example .env && npm run dev
```

Package name is **`@solid/community-server`** (not `@solid-community/community-solid-server`). See `forum-pod/Handovers/handover4-solid-ops.md`.

## App env

Copy `forum-pod/.env.example` → `forum-pod/.env` and set `VITE_POD_PROVIDER_URL`.

## Cooperative opt-in

- Default: civic data stays in Pod only.
- Enable **Opt-in cooperative share** in Settings.
- Exports POST to `{cooperativeUrl}/api/civic/export` with Ed25519 signed bundle.

## Articles Art VII

Analysis pipeline registers 7-day review, gates egress push, wipes raw rows after publish.

See `forum-pod/docs/` for governance artifacts.
