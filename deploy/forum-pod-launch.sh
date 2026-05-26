#!/bin/bash
# Single-script launcher for the Personal Pod (post Handover 9).
#
# Starts:
#   - Airlock listener at http://localhost:3000
#   - Vite dev server for forum-pod (default http://localhost:5173)
#
# Community Solid Server + provision bridge are gone after the H8
# Durable Object pivot. Pod data is in a Cloudflare Worker DO, so the
# Pod app talks to:
#   - <VITE_SERVER_URL>/api/pod/*    (signed Pod RPC, prod only)
#   - http://localhost:3000          (listener, local dev)
#
# Optional:
#   FORUM_POD_TUNNEL=1   -> open a Cloudflare Quick Tunnel pointing at
#                           the Vite dev server (random
#                           https://*.trycloudflare.com URL, ephemeral)
#
# Ctrl+C cleans up every child process.

set -euo pipefail

DESKTOP="${FORUM_DESKTOP:-$HOME/Desktop}"
POD_DIR="${FORUM_POD_DIR:-$DESKTOP/forum-pod}"
AIRLOCK_DIR="${FORUM_AIRLOCK_DIR:-$DESKTOP/forum-airlock}"

LISTENER_PORT="${LISTENER_PORT:-3000}"
VITE_PORT="${VITE_PORT:-5173}"

LOG_DIR="${FORUM_POD_LOG_DIR:-$DESKTOP/forum-logs}"
mkdir -p "$LOG_DIR"

LISTENER_LOG="$LOG_DIR/listener.log"
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
require_dir "$AIRLOCK_DIR"

http_ok() {
  curl -sf -m 1 "$1" >/dev/null 2>&1
}

# The Pod (Vite on :5173) POSTs JSON to the listener. Browsers send a CORS
# preflight first. An older listener process may answer /health but lack
# Access-Control-Allow-Origin — recycle it before starting a fresh one.
listener_has_cors() {
  local headers
  headers="$(curl -sf -m 2 -D - -o /dev/null -X OPTIONS \
    "http://127.0.0.1:$LISTENER_PORT/health" \
    -H 'Origin: http://localhost:5173' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: Content-Type' 2>/dev/null || true)"
  echo "$headers" | grep -qi 'access-control-allow-origin'
}

stop_listener_on_port() {
  local pid
  pid="$(lsof -iTCP:"$LISTENER_PORT" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true)"
  if [ -n "$pid" ]; then
    echo "      Stopping stale listener on :$LISTENER_PORT (pid $pid) ..."
    kill "$pid" 2>/dev/null || true
    sleep 1
  fi
}

remember_pid() {
  pids+=("$1")
  owned_labels+=("$2")
}

# 1. Airlock listener — Forum Feedback ingest, civic receipt, signing-
#    key registration. zkEmail routes are still mounted but dormant.
if http_ok "http://127.0.0.1:$LISTENER_PORT/health" && listener_has_cors; then
  echo "[1/2] Airlock listener already up at http://localhost:$LISTENER_PORT"
elif http_ok "http://127.0.0.1:$LISTENER_PORT/health"; then
  echo "[1/2] Recycling stale Airlock listener on :$LISTENER_PORT (missing CORS) ..."
  stop_listener_on_port
  ( cd "$AIRLOCK_DIR" && LISTENER_PORT="$LISTENER_PORT" npm run listener ) \
    >>"$LISTENER_LOG" 2>&1 &
  remember_pid "$!" "Airlock listener"
else
  echo "[1/2] Starting Airlock listener on :$LISTENER_PORT ..."
  ( cd "$AIRLOCK_DIR" && LISTENER_PORT="$LISTENER_PORT" npm run listener ) \
    >>"$LISTENER_LOG" 2>&1 &
  remember_pid "$!" "Airlock listener"
fi

# Wait for the listener to accept connections.
for i in $(seq 1 30); do
  if http_ok "http://127.0.0.1:$LISTENER_PORT/health"; then
    echo "      Listener up at http://localhost:$LISTENER_PORT"
    break
  fi
  sleep 1
  if [ "$i" = 30 ]; then
    echo "      Listener did not come up in 30s. See $LISTENER_LOG"
  fi
done

# 2. Optional Cloudflare Quick Tunnel pointed at Vite.
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

# 3. Vite dev server. Talks directly to the listener in dev. In prod,
#    VITE_SERVER_URL points at the secure-worker.
export VITE_SERVER_URL="${VITE_SERVER_URL:-http://localhost:$LISTENER_PORT}"
export VITE_POD_PROVIDER_URL="${VITE_POD_PROVIDER_URL:-$VITE_SERVER_URL}"
if http_ok "http://127.0.0.1:$VITE_PORT/"; then
  echo "[2/2] Vite dev server already up at http://localhost:$VITE_PORT"
else
  echo "[2/2] Starting Vite dev server on :$VITE_PORT ..."
  ( cd "$POD_DIR" && npm run dev -- --port "$VITE_PORT" ) >>"$VITE_LOG" 2>&1 &
  remember_pid "$!" "Vite dev server"
fi

echo
echo "Forum Personal Pod is up:"
echo "  Pod app           http://localhost:$VITE_PORT"
echo "  Airlock listener  http://localhost:$LISTENER_PORT  (Cooperative URL)"
echo "  Pod RPC base      $VITE_SERVER_URL/api/pod"
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
