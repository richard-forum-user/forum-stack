#!/bin/bash
# Install the cleaned-up Handover 9 cloudflared config, restart the
# tunnel, and verify the two surviving hostnames respond. Requires
# sudo (writes /etc/cloudflared/config.yml and restarts the service).

set -euo pipefail

SRC="${FORUM_DEPLOY_DIR:-$HOME/Desktop/deploy}/cloudflared-config.yml"
DST="/etc/cloudflared/config.yml"
BACKUP="/etc/cloudflared/config.yml.h8.bak"

if [ ! -f "$SRC" ]; then
  echo "Missing $SRC — run from the forum-pod repo root." >&2
  exit 1
fi

if [ -f "$DST" ] && [ ! -f "$BACKUP" ]; then
  echo "Backing up current config -> $BACKUP"
  sudo cp "$DST" "$BACKUP"
fi

echo "Installing $SRC -> $DST"
sudo install -m 0644 "$SRC" "$DST"

echo "Restarting cloudflared..."
sudo systemctl restart cloudflared
sleep 2
sudo systemctl --no-pager --lines=15 status cloudflared || true

for host in listener.yourcommunity.forum apk.yourcommunity.forum; do
  echo "--- HEAD $host"
  curl -sIL "https://$host/" | head -5 || true
done

echo
echo "Done. If pod.yourcommunity.forum / pod-provision.yourcommunity.forum"
echo "DNS records still exist in the Cloudflare dashboard, delete them"
echo "manually — the tunnel no longer answers for those hostnames."
