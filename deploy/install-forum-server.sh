#!/bin/bash
set -euo pipefail

DESKTOP="${FORUM_DESKTOP:-$HOME/Desktop}"
CONFIG="$DESKTOP/forum.config.env"
USER_SYSTEMD="$HOME/.config/systemd/user"

if [ ! -f "$CONFIG" ]; then
  echo "Missing $CONFIG"
  echo "Create it from $DESKTOP/forum.config.env.example and fill AIRLOCK_SECRET + FERNET_KEY."
  exit 1
fi

echo "Installing Forum server dependencies..."
(cd "$DESKTOP/forum-airlock" && npm install)
(cd "$DESKTOP/forum-pod" && npm install)

echo "Building installable PWA into forum-airlock/dist..."
(cd "$DESKTOP/forum-airlock" && npm run build:pod)

echo "Installing user systemd units..."
mkdir -p "$USER_SYSTEMD"
cp "$DESKTOP/deploy/forum-airlock-listener.service" "$USER_SYSTEMD/"
cp "$DESKTOP/deploy/forum-analysis.service" "$USER_SYSTEMD/"
cp "$DESKTOP/deploy/forum-analysis.timer" "$USER_SYSTEMD/"
if [ -f "$DESKTOP/deploy/forum-cloudflared.service" ]; then
  cp "$DESKTOP/deploy/forum-cloudflared.service" "$USER_SYSTEMD/"
fi

systemctl --user daemon-reload
systemctl --user enable --now forum-airlock-listener.service
# Legacy forum-ai timer disabled — edge secure-worker cron publishes every 6h.
# systemctl --user enable --now forum-analysis.timer
systemctl --user disable --now forum-analysis.timer 2>/dev/null || true

echo ""
echo "Forum server installed."
echo "Listener status: systemctl --user status forum-airlock-listener.service"
echo "Analysis timer:  systemctl --user list-timers forum-analysis.timer"
echo "Logs:            journalctl --user -u forum-airlock-listener.service -f"
echo "Phone access:    $DESKTOP/deploy/install-phone-access.sh"
echo ""
echo "If services should run after logout, enable lingering once:"
echo "  sudo loginctl enable-linger $USER"
