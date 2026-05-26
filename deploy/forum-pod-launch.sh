#!/bin/bash
# Single-script launcher for the Personal Pod dev UI (edge-first stack).
#
# Starts:
#   - Vite dev server for forum-pod (default http://localhost:5173)
#
# Community Solid Server, provision bridge, and the Node airlock listener
# are retired. Pod data, cooperative ingest, member registration, and
# analysis all go through the Cloudflare Worker + D1 + PersonalPodDO.
#
# Optional:
#   FORUM_POD_TUNNEL=1   -> open a Cloudflare Quick Tunnel pointing at
#                           the Vite dev server (random
#                           https://*.trycloudflare.com URL, ephemeral)
#
# Ctrl+C cleans up every child process.

set -euo pipefail

DESKTOP="${FORUM_DESKTOP:-$HOME/Desktop}"
POD_DIR="${FORUM_POD_DIR:-$DESKTOP/forum-stack/forum-pod}"

VITE_PORT="${VITE_PORT:-5173}"

LOG_DIR="${FORUM_POD_LOG_DIR:-$DESKTOP/forum-logs}"
mkdir -p "$LOG_DIR"

VITE_LOG="$LOG_DIR/vite.log"
TUNNEL_LOG="$LOG_DIR/cloudflared.log"

pids=()
owned_labels=()

cleanup() {
  echo
  echo "Shutting down Personal Pod stack..."
  for idx in "${!pids[@]}"; do
    pid="${pids[$idx]}"
    label="${owned_labels[$idx]}"
    if kill -0 "$pid" 2>/dev/null; then
      echo "  stopping $label (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

require_dir() {
  if [ ! -d "$1" ]; then
    echo "Missing directory: $1"
    exit 1
  fi
}
require_dir "$POD_DIR"

http_ok() {
  curl -sf -m 1 "$1" >/dev/null 2>&1
}

remember_pid() {
  pids+=("$1")
  owned_labels+=("$2")
}

# 1. Optional Cloudflare Quick Tunnel pointed at Vite.
POD_PUBLIC_URL=""
if [ "${FORUM_POD_TUNNEL:-0}" = "1" ]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "FORUM_POD_TUNNEL=1 set but cloudflared not installed; skipping tunnel."
  else
    echo "      Opening Cloudflare Quick Tunnel (random URL, ephemeral)..."
    cloudflared tunnel --url "http://localhost:$VITE_PORT" --no-autoupdate \
      >"$TUNNEL_LOG" 2>&1 &
    remember_pid "$!" "Cloudflare Quick Tunnel"
    for i in $(seq 1 30); do
      url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -n 1 || true)"
      if [ -n "$url" ]; then
        POD_PUBLIC_URL="$url"
        echo "      Tunnel up: $POD_PUBLIC_URL"
        break
      fi
      sleep 1
    done
    if [ -z "$POD_PUBLIC_URL" ]; then
      echo "      Quick Tunnel did not surface a URL in 30s. See $TUNNEL_LOG"
    fi
  fi
fi

# 2. Vite dev server. By default it talks to the deployed edge Worker.
export VITE_SERVER_URL="${VITE_SERVER_URL:-https://secure-worker.forum-community.workers.dev}"
export VITE_POD_PROVIDER_URL="${VITE_POD_PROVIDER_URL:-$VITE_SERVER_URL}"
if http_ok "http://127.0.0.1:$VITE_PORT/"; then
  echo "[1/1] Vite dev server already up at http://localhost:$VITE_PORT"
else
  echo "[1/1] Starting Vite dev server on :$VITE_PORT ..."
  ( cd "$POD_DIR" && npm run dev -- --port "$VITE_PORT" ) >>"$VITE_LOG" 2>&1 &
  remember_pid "$!" "Vite dev server"
fi

echo
echo "Forum Personal Pod is up:"
echo "  Pod app           http://localhost:$VITE_PORT"
echo "  Pod RPC base      $VITE_SERVER_URL/api/pod"
echo "  Feedback base     $VITE_SERVER_URL/api/forum/feedback"
if [ -n "$POD_PUBLIC_URL" ]; then
  echo "  Public Pod URL    $POD_PUBLIC_URL  (ephemeral, dies on exit)"
fi
echo
echo "Logs in: $LOG_DIR"
if [ "${#pids[@]}" -gt 0 ]; then
  echo "Press Ctrl+C to stop processes launched by this script."
else
  echo "All services were already running; Ctrl+C will not stop them."
fi

wait
