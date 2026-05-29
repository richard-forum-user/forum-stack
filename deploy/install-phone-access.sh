#!/bin/bash
set -euo pipefail

DESKTOP="${FORUM_DESKTOP:-$(cd "$(dirname "$0")/.." && pwd)}"
CONFIG="$DESKTOP/forum.config.env"
USER_SYSTEMD="$HOME/.config/systemd/user"
CLOUDFLARED_CONFIG="$HOME/.cloudflared/forum-airlock.yml"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed."
  echo "Install it first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

if [ ! -f "$CLOUDFLARED_CONFIG" ]; then
  mkdir -p "$HOME/.cloudflared"
  cp "$DESKTOP/deploy/cloudflared-forum.yml.example" "$CLOUDFLARED_CONFIG"
  echo "Created $CLOUDFLARED_CONFIG"
  echo "Edit it with your tunnel id, credentials path, and APK hostname, then rerun this script."
  exit 1
fi

if grep -q "YOUR_TUNNEL_ID" "$CLOUDFLARED_CONFIG"; then
  tunnel_json="$(ls "$HOME"/.cloudflared/*.json 2>/dev/null | head -n 1 || true)"
  if [ -n "$tunnel_json" ]; then
    tunnel_id="$(basename "$tunnel_json" .json)"
    sed -i "s/YOUR_TUNNEL_ID/$tunnel_id/g" "$CLOUDFLARED_CONFIG"
    echo "Filled tunnel id from $tunnel_json"
  else
    echo "$CLOUDFLARED_CONFIG still contains YOUR_TUNNEL_ID and no tunnel JSON was found."
    exit 1
  fi
fi

if [ ! -f "$CONFIG" ]; then
  echo "Missing $CONFIG"
  exit 1
fi

echo "Installing Cloudflare tunnel user service..."
mkdir -p "$USER_SYSTEMD"
cp "$DESKTOP/deploy/forum-cloudflared.service" "$USER_SYSTEMD/"
systemctl --user daemon-reload
systemctl --user enable --now forum-cloudflared.service

echo ""
echo "Tunnel service installed."
echo "Status: systemctl --user status forum-cloudflared.service"
echo "Logs:   journalctl --user -u forum-cloudflared.service -f"
echo ""
echo "Next:"
echo "  1. Run: cd $DESKTOP/forum-pod-airlock && npx wrangler secret put UNLOCK_TOKEN_KEY"
echo "  2. Run: cd $DESKTOP/forum-pod-airlock && npm run build:pod && npm run deploy:worker"
echo "  3. Keep only non-retired tunnel hostnames (for example apk.yourcommunity.forum)."
echo ""
echo "If this script is not executable, run it with:"
echo "  bash $DESKTOP/deploy/install-phone-access.sh"
