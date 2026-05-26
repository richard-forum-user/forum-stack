#!/bin/bash
set -euo pipefail

BASE_DIR="/home/forum-user1/Desktop/forum-ai"
SYNC_DIR="$BASE_DIR/database_syncs"
DESKTOP="/home/forum-user1/Desktop"
CONFIG="$DESKTOP/forum.config.env"

echo "Starting Forum Initiative Analysis Pipeline..."

if [ -f "$CONFIG" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG"
  set +a
else
  echo "NOTE: $CONFIG not found — using existing environment variables."
fi

if [ -z "${FERNET_KEY:-}" ]; then
  echo "ERROR: FERNET_KEY is required (set in forum.config.env)."
  exit 1
fi

if [ -f "$BASE_DIR/venv/bin/activate" ]; then
  source "$BASE_DIR/venv/bin/activate"
else
  echo "ERROR: Virtual environment not found at $BASE_DIR/venv"
  exit 1
fi

sqlite3 "$SYNC_DIR/forum_inbound.db" < "$SYNC_DIR/init_schema.sql" 2>/dev/null || true

echo "Running classification..."
python3 "$SYNC_DIR/classify.py"

echo "Running aggregation..."
python3 "$SYNC_DIR/aggregate.py"

echo "Registering report lifecycle (Art VII review window)..."
python3 "$SYNC_DIR/report_lifecycle.py" register

echo "Publishing reports past review period (if any)..."
python3 "$SYNC_DIR/report_lifecycle.py" publish

echo "Pushing to egress (if FORUM_EGRESS_URL is set)..."
python3 "$BASE_DIR/push.py"

deactivate
echo "Pipeline complete."
