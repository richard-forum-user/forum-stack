#!/bin/bash
# Local Forum stack helper: install deps and print the edge-first dev commands.
set -euo pipefail

DESKTOP="$(cd "$(dirname "$0")" && pwd)"

echo "== Forum stack =="
echo "1) Installing Worker deps (if needed)..."
(cd "$DESKTOP/forum-airlock" && npm install --silent 2>/dev/null || npm install)

echo "2) Installing Pod deps (if needed)..."
(cd "$DESKTOP/forum-pod" && npm install --silent 2>/dev/null || npm install)

echo ""
echo "Next steps (separate terminals):"
echo "  Pod UI dev:     cd $DESKTOP/forum-pod && VITE_SERVER_URL=https://secure-worker.forum-community.workers.dev npm run dev"
echo "  Worker dev:     cd $DESKTOP/forum-airlock && npm run build:pod && npm run dev:worker"
echo "  Worker deploy:  cd $DESKTOP/forum-airlock && npm run build:pod && npm run deploy:worker"
echo ""
echo "Cooperative flow: Pod → /api/forum/feedback → D1 forum_feedback → edge civic analysis cron → forum-egress KV"
echo ""
