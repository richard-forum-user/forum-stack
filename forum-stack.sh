#!/bin/bash
# Local Forum stack: airlock listener + optional analysis + instructions for worker/pod.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DESKTOP/forum.config.env"

if [ ! -f "$CONFIG" ]; then
  echo "Create config first:"
  echo "  cp $DESKTOP/forum.config.env.example $CONFIG"
  echo "  # edit FERNET_KEY and AIRLOCK_SECRET"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$CONFIG"
set +a

echo "== Forum stack =="
echo "1) Installing airlock listener deps (if needed)..."
(cd "$DESKTOP/forum-airlock" && npm install --silent 2>/dev/null || npm install)

echo "2) Starting sovereign listener on port ${LISTENER_PORT:-3000}..."
node "$DESKTOP/forum-airlock/listener.js" &
LISTENER_PID=$!

cleanup() {
  kill "$LISTENER_PID" 2>/dev/null || true
}
trap cleanup EXIT

sleep 1
curl -sf "http://127.0.0.1:${LISTENER_PORT:-3000}/health" >/dev/null \
  && echo "   Listener OK" \
  || echo "   Listener may still be starting..."

echo ""
echo "Next steps (separate terminals):"
echo "  Pod UI dev:     cd $DESKTOP/forum-pod && npm run dev   # reads ../forum.config.env for proxy secret"
echo "                  (restart vite after changing AIRLOCK_SECRET)"
echo "  Edge + assets:  cd $DESKTOP/forum-airlock && npm run build:pod && npm run dev:worker"
echo "  Analysis:       $DESKTOP/forum-ai/run_analysis.sh"
echo ""
echo "Civic flow: forum-pod → /api/civic/submit → worker → listener → vault → forum-ai DB"
echo "Report flow: classify → aggregate → forum-egress/report.json → push.py → worker.js"
echo ""
echo "Press Ctrl+C to stop the listener."
wait "$LISTENER_PID"
