# Self-hosting with Docker

The default `docker-compose.yml` publishes **only on the host loopback**:

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

Your pod is not reachable from the LAN or the public internet unless **you** add a reverse proxy (Caddy, nginx, Cloudflare Tunnel).

## Run

```bash
docker compose up --build
open http://127.0.0.1:8787/pod
```

SQLite and DO state persist under `./pod-data` (mounted at `/data` in the container).

## Backup

```bash
tar -czf pod-backup.tgz pod-data/
```

## Cooperative sync

Set `COOP_URL` in `docker-compose.yml` to your cooperative pipeline URL. Complete membership verification in the app before syncing.

The cooperative codebase contains **no** routes that dial your pod — sync is always pod-initiated.
