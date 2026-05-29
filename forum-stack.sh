#!/bin/bash
# forum-stack helper — cooperative pipeline + personal Pod in one repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "== forum-stack =="
(cd "$ROOT/forum-airlock" && npm install --silent 2>/dev/null || npm install)
(cd "$ROOT/forum-pod-airlock" && npm install --silent 2>/dev/null || npm install)

echo ""
echo "Cooperative pipeline (coop.yourcommunity.forum):"
echo "  cd $ROOT/forum-airlock && npx wrangler deploy"
echo ""
echo "Airlock Pod PWA (airlock.yourcommunity.forum):"
echo "  cd $ROOT/forum-pod-airlock && npm run build:pod && npx wrangler deploy"
echo ""
echo "Pod UI dev server:"
echo "  cd $ROOT/forum-pod && npm run dev"
echo ""
echo "Desktop Docker self-host:"
echo "  cd $ROOT && docker compose up --build"
echo ""
echo "Flow: Pod opt-in → coop…/api/forum/feedback → D1 → analysis → egress → 7d contest → wipe"
